import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  FORBIDDEN_MODEL_TOOL_IDS, INFRA_GATED_TOOL_IDS, OWNER_ONLY_NAMESPACES, PostgresOpsTransport, ToolGateway, assertManifestInvariants, assessClassDPipeline,
  buildToolManifest, parsePostgresOpsConfig, postgresOpsToolDefinitions,
  type ClassDNotification, type SecretProvider, type ToolDefinition, type ToolInvocationContext, type ToolTransport
} from "../src/index.ts";

/**
 * WP-E1: Postgres-drift-verktøyene gjennom den EKTE `ToolGateway`-pipelinen (embedded Postgres, ekte policy, ekte klasse D-kjede) mot en minste-privilegium-rolle.
 * Bevist: sovende uten credential, mål-autorisasjon FØR transporten (spion: ingen I/O), hele klasse D-kjeden (preflight av akkurat den økten, snapshot, idempotens,
 * readback, varsling), InfraExecutionGate, kill switch/frys, delegert identitet og at tilkoblingsstrengen aldri havner i revisjon/ledger.
 */
const TENANT = "tenant-e1-pgops";
const OPS_PW = "opsPw-secret-7788";
const owner: IdentityContext = { person_id: "person-e1-pgops", tenant_id: TENANT, memory_space_id: "business", session_id: "sess-e1p", device_id: "dev-e1p", channel: "api", auth_strength: "active" };
const delegate: IdentityContext = { ...owner, person_id: "person-e1-pgops-d", session_id: "sess-e1p-d" };
const TS = (c: string): string => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let appPool: pg.Pool;
let port = 0;
const open: pg.Client[] = [];
let n = 0;
const uniq = (p: string): string => `${p}-${(n += 1)}-${Date.now().toString(36)}`;
const opsDsn = (): string => `postgresql://ops_t:${OPS_PW}@127.0.0.1:${port}/jarvis_test`;

class Spy implements ToolTransport {
  readonly calls: string[] = [];
  constructor(private readonly inner: ToolTransport) {}
  invoke(action: string, parameters: Record<string, JsonValue>, credential: string, context: ToolInvocationContext): ReturnType<ToolTransport["invoke"]> {
    this.calls.push(action);
    return this.inner.invoke(action, parameters, credential, context);
  }
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1-pgops-gw-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  port = leased.port;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port, database: "jarvis_test", user: "postgres", password: "pw", max: 4 });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query(`CREATE ROLE ops_t LOGIN PASSWORD '${OPS_PW}' NOSUPERUSER NOBYPASSRLS; GRANT pg_monitor, pg_signal_backend TO ops_t;`);
  await admin.query("CREATE ROLE victim_t LOGIN PASSWORD 'victimPw-1' NOSUPERUSER");
  await admin.query("CREATE ROLE jarvis_test_e1_pgops LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_test_e1_pgops;");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','E1','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-e1-pgops','Owner'), ('person-e1-pgops-d','Delegate');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-e1-pgops','${TENANT}'), ('person-e1-pgops-d','${TENANT}');
    CREATE TABLE public.gw_owned (id int); ALTER TABLE public.gw_owned OWNER TO ops_t;
    CREATE TABLE public.gw_unowned (id int);
  `);
  appPool = createPool({ host: "127.0.0.1", port, database: "jarvis_test", user: "jarvis_test_e1_pgops", password: "pw2" });
}, 240_000);

afterAll(async () => {
  for (const c of open) await c.end().catch(() => undefined);
  await appPool?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

interface Harness { gateway: ToolGateway; spy: Spy; notifications: ClassDNotification[]; infraGate: InfraExecutionGate; controls: OwnerControls; killSwitch: KillSwitch; defs: ToolDefinition[] }

function harness(opts: { databases?: string; withCredential?: boolean; protectedRoles?: string } = {}): Harness {
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const infraGate = new InfraExecutionGate();
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, infraGate, infraToolIds: new Set(INFRA_GATED_TOOL_IDS),
    authority: { owner_person_id: owner.person_id, owner_tenants: [TENANT] }
  });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === "JARVIS_POSTGRES_OPS_URL" && opts.withCredential !== false ? opsDsn() : null) };
  const notifications: ClassDNotification[] = [];
  const gateway = new ToolGateway(appPool, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (nt) => { notifications.push(nt); } } },
    credentialBinding: { owner_person_id: owner.person_id, owner_tenants: [TENANT], internalRefs: new Set() }
  });
  const config = parsePostgresOpsConfig({ databases: opts.databases ?? "jarvis_test", protectedRoles: opts.protectedRoles });
  const spy = new Spy(new PostgresOpsTransport({ config }));
  const defs = postgresOpsToolDefinitions(spy, { ops: config });
  for (const d of defs) gateway.register(d);
  return { gateway, spy, notifications, infraGate, controls, killSwitch, defs };
}

const run = (h: Harness, action: string, parameters: Record<string, unknown>, key?: string, identity: IdentityContext = owner) =>
  h.gateway.execute({ identity, tool_id: "postgres_ops", action, parameters: parameters as never, ...(key ? { idempotency_key: key } : {}) });

async function idleVictim(user = "victim_t"): Promise<{ client: pg.Client; pid: number; backend_start: string }> {
  const client = new pg.Client({ host: "127.0.0.1", port, database: "jarvis_test", user, password: "victimPw-1" });
  client.on("error", () => undefined);
  await client.connect();
  open.push(client);
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  const row = (await admin.query<{ backend_start: string }>(`SELECT ${TS("backend_start")} AS backend_start FROM pg_stat_activity WHERE pid = $1`, [pid])).rows[0]!;
  return { client, pid, backend_start: row.backend_start };
}

async function sleeper(): Promise<{ client: pg.Client; pid: number; backend_start: string; query_start: string; running: Promise<string> }> {
  const v = await idleVictim();
  const running = v.client.query("SELECT pg_sleep(60)").then(() => "done", (e: Error) => e.message);
  for (let i = 0; i < 100; i += 1) {
    const r = (await admin.query<{ query_start: string }>(`SELECT ${TS("query_start")} AS query_start FROM pg_stat_activity WHERE pid = $1 AND state = 'active' AND query LIKE 'SELECT pg_sleep%'`, [v.pid])).rows[0];
    if (r) return { ...v, query_start: r.query_start, running };
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("sleeper ble aldri aktiv");
}

async function ledger(key: string) {
  return (await admin.query("SELECT status, before_state, after_state, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as
    { status: string; before_state: Record<string, unknown> | null; after_state: unknown; postcondition_reason: string | null } | undefined;
}
const alive = async (pid: number): Promise<boolean> => ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])).rowCount ?? 0) > 0;

describe("A: klasse D-kjeden er komplett for hver skrivehandling (audit som kode)", () => {
  const h = harness();
  const decisions: Record<string, { requires_target: boolean; specific_target_check: boolean; readback: "predicate" | "absent" }> = {
    terminate_backend: { requires_target: true, specific_target_check: false, readback: "absent" },
    cancel_query: { requires_target: false, specific_target_check: true, readback: "predicate" },
    vacuum_analyze: { requires_target: true, specific_target_check: false, readback: "predicate" }
  };

  it("hver klasse D-handling har et eksplisitt, revidert valg (ny D-handling uten oppføring feiler her) og oppfyller assessClassDPipeline", () => {
    const dActions = h.defs.filter((d) => d.capability_class === "D").map((d) => d.action).sort();
    expect(dActions).toEqual(Object.keys(decisions).sort());
    for (const def of h.defs.filter((d) => d.capability_class === "D")) {
      const choice = decisions[def.action]!;
      expect(assessClassDPipeline(def), def.action).toEqual({ complete: true, missing: [] });
      expect(def.preflight_requires_target === true, def.action).toBe(choice.requires_target);
      expect(typeof def.preflight_target_check === "function", def.action).toBe(choice.specific_target_check);
      expect(def.postcondition_target_absent === true, def.action).toBe(choice.readback === "absent");
      expect(def.postcondition_predicate !== undefined, def.action).toBe(choice.readback === "predicate");
      expect(def.rollback_procedure.length, def.action).toBeGreaterThan(30);
      expect(def.parameterAuthorizer, def.action).toBeDefined();
    }
  });

  it("alle lesehandlinger er klasse A/ubetrodd uten parameterAuthorizer; ingen klasse B/C; ukjente felt avvises (strict)", () => {
    for (const d of h.defs.filter((x) => x.capability_class === "A")) {
      expect(d.output_trust, d.action).toBe("untrusted");
      expect(d.parameterAuthorizer, d.action).toBeUndefined();
    }
    expect(h.defs.some((d) => d.capability_class === "B" || d.capability_class === "C")).toBe(false);
    for (const d of h.defs) expect(d.credential_ref).toBe("JARVIS_POSTGRES_OPS_URL");
  });

  it("manifest-invariantene holder, og ingenting står på en modellflate (eier-eksklusivt navnerom, forbudt for modellen, styrt av infra-gaten)", () => {
    const manifest = buildToolManifest(h.defs);
    expect(() => assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true })).not.toThrow();
    for (const e of manifest.values()) expect(e.surfaces, e.key).toEqual([]);
    expect(OWNER_ONLY_NAMESPACES.has("postgres_ops")).toBe(true);
    expect(FORBIDDEN_MODEL_TOOL_IDS).toContain("postgres_ops");
    expect(INFRA_GATED_TOOL_IDS.has("postgres_ops")).toBe(true);
    // Jarvis' EGEN database: kjerneeid, intern datasone, ingen utgående nettverkstrafikk. (Manifestets `postcondition` teller bare predikater; sletting/terminering bruker «borte»-readback.)
    expect(manifest.get("postgres_ops.terminate_backend")).toMatchObject({ risk: "D", owner: "jarvis_core", data_zone: "internal", network: "none", idempotency: "required", preflight: true, postcondition: false });
    expect(manifest.get("postgres_ops.vacuum_analyze")).toMatchObject({ risk: "D", idempotency: "required", preflight: true, postcondition: true });
    expect(manifest.get("postgres_ops.get_connections")).toMatchObject({ risk: "A", effect: "read", idempotency: "none" });
  });
});

describe("B: sovende uten credential, og mål-autorisasjon FØR transporten", () => {
  it("uten JARVIS_POSTGRES_OPS_URL er ALLE handlinger credential_unavailable og databasen får ingen forespørsel", async () => {
    const h = harness({ withCredential: false });
    for (const [action, params] of [["get_connections", {}], ["get_migration_state", {}], ["terminate_backend", { pid: 1, database: "jarvis_test", backend_start: "2026-10-09T12:00:00.000000Z" }]] as const) {
      expect(await run(h, action, params, uniq("k")), action).toEqual({ ok: false, reason: "credential_unavailable" });
    }
    expect(h.spy.calls).toEqual([]);
  });

  it("database utenfor eierens liste nektes av parameterAuthorizer uten I/O; tom liste nekter all skriving, lesing virker", async () => {
    const h = harness({ databases: "" });
    const s = await idleVictim();
    const params = { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start };
    expect(await run(h, "terminate_backend", params, uniq("k"))).toEqual({ ok: false, reason: "postgres_database_not_authorized" });
    expect(await run(h, "vacuum_analyze", { database: "jarvis_test", schema: "public", table: "gw_owned" }, uniq("k"))).toEqual({ ok: false, reason: "postgres_database_not_authorized" });
    expect(h.spy.calls).toEqual([]);
    expect(await alive(s.pid)).toBe(true);
    expect((await run(h, "get_connections", {})).ok).toBe(true);
  });

  it("skjemaet er strengt og skjema utenfor eierens liste nektes", async () => {
    const h = harness();
    expect(await run(h, "terminate_backend", { pid: 1, database: "jarvis_test", backend_start: "2026-10-09T12:00:00.000000Z", ekstra: 1 }, uniq("k"))).toEqual({ ok: false, reason: "invalid_parameters" });
    expect(await run(h, "terminate_backend", { pid: "1", database: "jarvis_test", backend_start: "x" }, uniq("k"))).toEqual({ ok: false, reason: "invalid_parameters" });
    expect(await run(h, "vacuum_analyze", { database: "jarvis_test", schema: "pg_catalog", table: "pg_class" }, uniq("k"))).toEqual({ ok: false, reason: "postgres_schema_not_authorized" });
    expect(await run(h, "vacuum_analyze", { database: "jarvis_test", schema: "public", table: 'x"; DROP TABLE public.gw_owned;--' }, uniq("k"))).toEqual({ ok: false, reason: "missing_or_invalid_table" });
    expect(h.spy.calls).toEqual([]);
  });

  it("delegert identitet får ikke bruke eierens tilkobling (credential-binding)", async () => {
    const h = harness();
    expect(await run(h, "get_connections", {}, undefined, delegate)).toEqual({ ok: false, reason: "credential_not_bound_to_identity" });
    expect(h.spy.calls).toEqual([]);
  });
});

describe("C: terminate / cancel / vacuum gjennom hele klasse D-kjeden", () => {
  it("terminate: preflight leser akkurat den økten, snapshot journalføres uten data, økten termineres, readback bekrefter «borte», eieren varsles - og tilkoblingsstrengen står ingen steder", async () => {
    const h = harness();
    const s = await idleVictim();
    const key = uniq("term");
    const r = await run(h, "terminate_backend", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start }, key);
    expect(r).toMatchObject({ ok: true, external_id: `pid:${s.pid}`, deduplicated: false, notified: true, output_trust: "internal" });
    expect(h.spy.calls).toEqual(["get_backend", "terminate_backend", "get_backend"]);
    const l = await ledger(key);
    expect(l?.status).toBe("succeeded");
    expect(l?.before_state).toMatchObject({ pid: s.pid, role: "victim_t", database: "jarvis_test", backend_start: s.backend_start, eligible_for_mutation: true });
    expect(l?.after_state).toBeNull();
    expect(await alive(s.pid)).toBe(false);
    expect(h.notifications).toEqual([expect.objectContaining({ action: "terminate_backend", outcome: "executed", idempotency_key: key })]);
    expect(h.notifications[0]!.recovery).toMatch(/ingen teknisk reversering/);
    // Hemmelighetshygiene: verken revisjon eller ledger eller varsel inneholder passordet/tilkoblingsstrengen.
    const audit = await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE payload::text LIKE $1 OR reason LIKE $1", [`%${OPS_PW}%`]);
    const ledgerLeak = await admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE before_state::text LIKE $1 OR after_state::text LIKE $1 OR postcondition_reason LIKE $1", [`%${OPS_PW}%`]);
    expect((audit.rows[0] as { n: number }).n).toBe(0);
    expect((ledgerLeak.rows[0] as { n: number }).n).toBe(0);
    expect(JSON.stringify(h.notifications)).not.toContain(OPS_PW);
  });

  it("terminate av en økt som ikke lenger er den inspiserte (backend_start avviker): preflight_target_not_found, ingenting termineres", async () => {
    const h = harness();
    const s = await idleVictim();
    const r = await run(h, "terminate_backend", { pid: s.pid, database: "jarvis_test", backend_start: "2020-01-01T00:00:00.000000Z" }, uniq("k"));
    expect(r).toEqual({ ok: false, reason: "preflight_target_not_found" });
    expect(h.spy.calls).toEqual(["get_backend"]);
    expect(await alive(s.pid)).toBe(true);
  });

  it("terminate av en SUPERBRUKER-økt: transporten nekter (tool_failed), økten lever, og forsøket er journalført som failed", async () => {
    const h = harness();
    const su = new pg.Client({ host: "127.0.0.1", port, database: "jarvis_test", user: "postgres", password: "pw" });
    su.on("error", () => undefined);
    await su.connect();
    open.push(su);
    const pid = (await su.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const bs = (await admin.query<{ b: string }>(`SELECT ${TS("backend_start")} AS b FROM pg_stat_activity WHERE pid = $1`, [pid])).rows[0]!.b;
    const key = uniq("su");
    const r = await run(h, "terminate_backend", { pid, database: "jarvis_test", backend_start: bs }, key);
    expect(r).toEqual({ ok: false, reason: "tool_failed:postgres_backend_superuser_protected" });
    expect((await ledger(key))?.status).toBe("failed");
    expect(await alive(pid)).toBe(true);
    expect(h.notifications).toEqual([]);
  });

  it("idempotens: en gjentatt nøkkel terminerer ikke på nytt, og nøkkel er PÅKREVD for klasse D", async () => {
    const h = harness();
    const s = await idleVictim();
    const params = { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start };
    expect(await run(h, "terminate_backend", params)).toEqual({ ok: false, reason: "class_d_idempotency_key_required" });
    expect(await alive(s.pid)).toBe(true);
    const key = uniq("idem");
    const first = await run(h, "terminate_backend", params, key);
    expect(first.ok).toBe(true);
    // Preflight kjøres FØR ledger-dedupe (gatewayens rekkefølge): økten er borte, så en retry nektes som «finnes ikke» - aldri en ny terminering.
    // (`executeCloudMutation` svarer en retry med den eksisterende journalraden før gatewayen nås.)
    const again = await run(h, "terminate_backend", params, key);
    expect(again).toEqual({ ok: false, reason: "preflight_target_not_found" });
    expect(h.spy.calls.filter((c) => c === "terminate_backend")).toHaveLength(1);
    expect(h.notifications).toHaveLength(1);
  });

  it("cancel: bare den inspiserte spørringen avbrytes; readback bekrefter at den ikke lenger kjører; en ny spørring (query_start avviker) røres ikke", async () => {
    const h = harness();
    const s = await sleeper();
    const stale = await run(h, "cancel_query", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start, query_start: "2020-01-01T00:00:00.000000Z" }, uniq("k"));
    expect(stale).toEqual({ ok: false, reason: "preflight_target_not_found" });
    expect((await admin.query("SELECT state FROM pg_stat_activity WHERE pid = $1", [s.pid])).rows[0]).toEqual({ state: "active" });
    const key = uniq("cancel");
    const ok = await run(h, "cancel_query", { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start, query_start: s.query_start }, key);
    expect(ok).toMatchObject({ ok: true, notified: true });
    expect(await s.running).toMatch(/canceling statement/);
    const l = await ledger(key);
    expect(l?.status).toBe("succeeded");
    expect(l?.before_state).toMatchObject({ present: true, state: "active", query: "SELECT pg_sleep(?)" });
    expect(l?.after_state).toMatchObject({ present: true });
    expect(await alive(s.pid)).toBe(true);
  });

  it("vacuum: tabellen rollen eier vacuumes og readback viser fersk statistikk; en tabell rollen ikke eier gir tool_failed (aldri en påstått suksess)", async () => {
    const h = harness();
    const key = uniq("vac");
    const r = await run(h, "vacuum_analyze", { database: "jarvis_test", schema: "public", table: "gw_owned" }, key);
    expect(r).toMatchObject({ ok: true, external_id: "vacuum:public.gw_owned", notified: true });
    const l = await ledger(key);
    expect(l?.status).toBe("succeeded");
    expect((l?.after_state as { seconds_since_vacuum: number }).seconds_since_vacuum).toBeLessThan(120);
    const bad = await run(h, "vacuum_analyze", { database: "jarvis_test", schema: "public", table: "gw_unowned" }, uniq("vac2"));
    expect(bad).toEqual({ ok: false, reason: "tool_failed:postgres_vacuum_skipped_insufficient_privilege" });
    const missing = await run(h, "vacuum_analyze", { database: "jarvis_test", schema: "public", table: "finnes_ikke" }, uniq("vac3"));
    expect(missing).toEqual({ ok: false, reason: "preflight_target_not_found" });
  });

  it("analyze_only verifiseres mot siste ANALYZE", async () => {
    const h = harness();
    const r = await run(h, "vacuum_analyze", { database: "jarvis_test", schema: "public", table: "gw_owned", analyze_only: true }, uniq("an"));
    expect(r).toMatchObject({ ok: true, external_id: "analyze:public.gw_owned" });
  });
});

describe("D: InfraExecutionGate, kill switch og frys gjelder Postgres-drift uniformt", () => {
  it("PAUSED stanser all skriving men aldri lesing; DEGRADED stanser klasse D men aldri lesing", async () => {
    const h = harness();
    const s = await idleVictim();
    const params = { pid: s.pid, database: "jarvis_test", backend_start: s.backend_start };
    h.infraGate.pause("incident response");
    expect(await run(h, "terminate_backend", params, uniq("k"))).toEqual({ ok: false, reason: "infra_paused" });
    expect(await run(h, "vacuum_analyze", { database: "jarvis_test", schema: "public", table: "gw_owned" }, uniq("k"))).toEqual({ ok: false, reason: "infra_paused" });
    expect((await run(h, "get_connections", {})).ok).toBe(true);
    expect((await run(h, "get_long_running_queries", {})).ok).toBe(true);
    h.infraGate.resume();
    h.infraGate.degrade("nedgradert");
    expect(await run(h, "terminate_backend", params, uniq("k"))).toEqual({ ok: false, reason: "infra_degraded_blocks_class_d" });
    expect((await run(h, "get_locks", {})).ok).toBe(true);
    expect(await alive(s.pid)).toBe(true);
    expect(h.spy.calls.filter((c) => c === "terminate_backend" || c === "vacuum_analyze")).toEqual([]);
  });

  it("frosset connector og kill switch stanser kall", async () => {
    const h = harness();
    h.controls.freezeConnector("postgres_ops");
    expect(await run(h, "get_connections", {})).toEqual({ ok: false, reason: "connector_frozen" });
    h.controls.unfreezeConnector("postgres_ops");
    expect((await run(h, "get_connections", {})).ok).toBe(true);
    h.killSwitch.activate("test");
    expect((await run(h, "get_connections", {})).ok).toBe(false);
  });
});

describe("E: utdata er hvitlistet og uten data", () => {
  it("get_long_running_queries via gateway: normalisert tekst, ingen literaler, utdata merket ubetrodd", async () => {
    const h = harness();
    const s = await sleeper();
    await new Promise((res) => setTimeout(res, 1200));
    const r = await run(h, "get_long_running_queries", { min_seconds: 1 });
    expect(r).toMatchObject({ ok: true, output_trust: "untrusted" });
    if (r.ok) {
      const backends = (r.data as unknown as { backends: Array<{ pid: number; query: string }> }).backends;
      expect(backends.find((b) => b.pid === s.pid)?.query).toBe("SELECT pg_sleep(?)");
      expect(JSON.stringify(r.data)).not.toContain(OPS_PW);
    }
    await admin.query("SELECT pg_terminate_backend($1)", [s.pid]);
    await s.running;
  });
});
