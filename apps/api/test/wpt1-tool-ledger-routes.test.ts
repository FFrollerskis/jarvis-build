import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { shortFingerprint, sweepLedgerTenant } from "@jarvis/tool-gateway";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-T1 K5 (JARVIS-103): `/tool-ledger/queue` og `/tool-ledger/resolve` over HTTP mot en ekte Postgres (app-rolle, RLS): dormant (404 uten `deps.toolLedger`), grant/eier/step-up-rekkefølgen, klasse-bevisst step-up,
 * tenant fra grantet (aldri kroppen), validering av kroppen, faste statuskoder og at svarene aldri bærer leverandørtekst eller merknaden. Selve tilstandsmaskinen er dekket i modules/tool-gateway/test/wpt1-ledger-reconcile-db.test.ts.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let url = "";
let urlDormant = "";
const closers: Array<() => Promise<void>> = [];
const T = "tenant-t1rt";
const T2 = "tenant-t1rt-b";
const OWNER = "person-owner-rt";
const SECOND = "person-second-rt";

type Grant = { person_id: string; tenant_id: string; channel: string; auth_strength: string; session_id: string; memory_space: string; device_id: string };
const grants = new Map<string, Grant>();
const grant = (over: Partial<Grant> = {}): Grant => ({ person_id: OWNER, tenant_id: T, channel: "web", auth_strength: "signed", session_id: "s-owner", memory_space: "personal", device_id: "web-owner", ...over });
/** Samme form som kontrollsentrenes predikat: den suverene eieren i en av sine tenants, aldri en delegat. */
const OWNER_GATE = (identity: IdentityContext): boolean => identity.person_id === OWNER && [T, T2].includes(identity.tenant_id) && identity.delegation_id === undefined;

/** Registeret (kun oppslag): en klasse C-handling med kjent recovery og en klasse B-handling. Alt annet er ukjent. */
const registry = {
  get: (toolId: string, action: string) =>
    toolId === "rt_c" && action === "mutate" ? ({ capability_class: "C", rollback_procedure: "sjekk hos leverandøren (klasse C)" } as never)
      : toolId === "rt_b" && action === "mutate" ? ({ capability_class: "B", rollback_procedure: "sjekk hos leverandøren (klasse B)" } as never)
        : undefined
};

function makeDeps(withFeature: boolean): ApiDeps {
  return {
    grants: { verify: async (token: string) => (grants.has(token) ? { ok: true, grant: grants.get(token) } : { ok: false, reason: "grant_invalid" }) },
    identity: { resolveIdentity: async (i: Record<string, string>) => ({ ok: true, identity: { ...i, memory_space_id: i["memory_space"] } }) },
    owner: { tenant_id: T, person_id: OWNER },
    ownerGate: OWNER_GATE,
    incidents: { pool: app },
    ...(withFeature ? { toolLedger: { pool: app, gateway: registry, ownerGate: OWNER_GATE } } : {})
  } as unknown as ApiDeps;
}

async function listen(deps: ApiDeps): Promise<string> {
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-t1rt-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_t1rt LOGIN PASSWORD 'pw2'");
  await admin.query("GRANT jarvis_app TO jarvis_t1rt");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}','RT','person'), ('${T2}','RT2','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Owner'), ('${SECOND}','Second');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${T}'), ('${OWNER}','${T2}'), ('${SECOND}','${T}');
  `);
  app = createPool({ ...base, user: "jarvis_t1rt", password: "pw2" });
  grants.set("owner-signed", grant());
  grants.set("owner-active", grant({ auth_strength: "active", channel: "api", session_id: "s-active" }));
  grants.set("owner-telegram", grant({ channel: "telegram", session_id: "s-tg" }));
  grants.set("owner-other-tenant", grant({ tenant_id: T2, session_id: "s-t2" }));
  grants.set("second-signed", grant({ person_id: SECOND, session_id: "s-second", device_id: "web-second" }));
  url = await listen(makeDeps(true));
  urlDormant = await listen(makeDeps(false));
}, 240_000);

afterAll(async () => {
  for (const c of closers) await c();
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- testens svar-JSON er bevisst løst typet
type Json = Record<string, any>;
const post = (base: string, path: string, body: unknown): Promise<Response> => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const call = async (path: string, token: string | undefined, body: Record<string, unknown> = {}, base = url): Promise<{ status: number; body: Json }> => {
  const res = await post(base, path, token === undefined ? body : { grant_token: token, ...body });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
};
let seq = 0;
const newKey = (label: string): string => `rt-${label}-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`;
async function seed(k: string, status: string, ageMinutes: number, over: { tenant?: string; tool?: string; reason?: string | null; external?: string | null } = {}): Promise<void> {
  await admin.query(
    `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, executed_at, postcondition_reason, external_id)
     VALUES ($1, $2, $3, 'mutate', $4, now() - make_interval(mins => $5::int), $6, $7)`,
    [over.tenant ?? T, k, over.tool ?? "rt_c", status, ageMinutes, over.reason ?? null, over.external ?? null]
  );
}
const rowOf = async (k: string, tenant = T) => (await admin.query("SELECT status, resolution, resolved_by FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2", [tenant, k])).rows[0] as { status: string; resolution: string | null; resolved_by: string | null } | undefined;
const resolveBody = (k: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ idempotency_key: k, resolution: "not_executed", provider_checked: true, ...over });

describe("dormant: uten deps.toolLedger finnes ingen rute", () => {
  it("begge rutene gir 404 selv med gyldig eier-grant (identisk med main)", async () => {
    for (const path of ["/tool-ledger/queue", "/tool-ledger/resolve"]) {
      const res = await call(path, "owner-signed", path.endsWith("resolve") ? resolveBody("x") : {}, urlDormant);
      expect(res.status, path).toBe(404);
    }
  });

  it("med deps.toolLedger gir feil metode og ukjent sti også 404", async () => {
    expect((await fetch(`${url}/tool-ledger/queue`, { method: "GET" })).status).toBe(404);
    expect((await fetch(`${url}/tool-ledger/resolve`, { method: "PUT" })).status).toBe(404);
    expect((await call("/tool-ledger/unknown", "owner-signed")).status).toBe(404);
    expect((await call("/tool-ledger/", "owner-signed")).status).toBe(404);
    expect((await call("/tool-ledger/__proto__", "owner-signed")).status).toBe(404);
    expect((await call("/tool-ledger/constructor", "owner-signed")).status).toBe(404);
  });
});

describe("grant -> eier -> (step-up) i denne rekkefølgen, og kroppen kan aldri bære identitet", () => {
  it("uten grant 401; ugyldig grant 403; identitetsfelt og ukjente felt 400 FØR grantet løses", async () => {
    expect((await call("/tool-ledger/queue", undefined)).status).toBe(401);
    expect((await call("/tool-ledger/queue", "nope")).status).toBe(403);
    const forged = await call("/tool-ledger/queue", "owner-signed", { tenant_id: T2 });
    expect(forged.status).toBe(400);
    expect(forged.body["error"]).toBe("identity_field_forbidden");
    const unknown = await call("/tool-ledger/queue", "owner-signed", { sort: "desc" });
    expect(unknown).toMatchObject({ status: 400, body: { error: "malformed_request", reason: "unknown_field" } });
    expect((await call("/tool-ledger/resolve", "owner-signed", { ...resolveBody("x"), person_id: OWNER })).body["error"]).toBe("identity_field_forbidden");
    expect((await call("/tool-ledger/resolve", "owner-signed", { ...resolveBody("x"), status: "succeeded" })).body["reason"]).toBe("unknown_field");
  });

  it("en annen person i eierens tenant får 403 owner_required på begge rutene, med en revisjonsrad `tool.denied`, og ingenting endres", async () => {
    const k = newKey("denied");
    await seed(k, "unverified", 100);
    const queue = await call("/tool-ledger/queue", "second-signed");
    expect(queue).toMatchObject({ status: 403, body: { error: "owner_required" } });
    const resolve = await call("/tool-ledger/resolve", "second-signed", resolveBody(k));
    expect(resolve).toMatchObject({ status: 403, body: { error: "owner_required" } });
    expect((await rowOf(k))?.status).toBe("unverified");
    const denied = (await admin.query("SELECT tool_id, action, reason FROM audit_events WHERE tenant_id = $1 AND person_id = $2 AND type = 'tool.denied' AND tool_id = 'tool_ledger' ORDER BY at", [T, SECOND])).rows;
    expect(denied.map((r) => (r as { action: string }).action)).toEqual(["ledger_queue", "ledger_resolve"]);
  });
});

describe("/tool-ledger/queue", () => {
  it("lister uavgjorte rader for grantets tenant (eldst først) med klasse, step-up-krav, fast årsakskode og recovery - aldri en annen tenants rader", async () => {
    const mine = newKey("q-mine"); const classB = newKey("q-b"); const young = newKey("q-young"); const done = newKey("q-done"); const foreign = newKey("q-foreign");
    await seed(mine, "unverified", 5000, { reason: "postcondition_unverified:no_provider_id", external: "ext-q-1" });
    await seed(classB, "unverified", 4000, { tool: "rt_b" });
    await seed(young, "reserved", 2);
    await seed(done, "succeeded", 9000);
    await seed(foreign, "unverified", 6000, { tenant: T2 });
    await sweepLedgerTenant(app, T, { reservedTtlMinutes: 60, unverifiedTtlHours: 24 });
    const res = await call("/tool-ledger/queue", "owner-signed", { limit: 200 });
    expect(res.status).toBe(200);
    const entries = res.body["data"]["entries"] as Array<Record<string, unknown>>;
    const keys = entries.map((e) => e["idempotency_key"]);
    expect(keys).toEqual(expect.arrayContaining([mine, classB]));
    expect(keys).not.toContain(young);
    expect(keys).not.toContain(done);
    expect(keys).not.toContain(foreign);
    expect(res.body["data"]["total"]).toBe(entries.length);
    const ages = entries.map((e) => e["age_minutes"] as number);
    expect([...ages].sort((a, b) => b - a)).toEqual(ages);
    const first = entries.find((e) => e["idempotency_key"] === mine)!;
    expect(first).toMatchObject({
      tool_id: "rt_c", action: "mutate", capability_class: "C", step_up_required: true, status: "needs_resolution", status_before_reconcile: "unverified",
      reason: "postcondition_unverified:no_provider_id", external_id: "ext-q-1", recovery: "sjekk hos leverandøren (klasse C)"
    });
    expect(entries.find((e) => e["idempotency_key"] === classB)).toMatchObject({ capability_class: "B", step_up_required: false });
    // En annen tenants eier ser kun sine egne.
    const other = await call("/tool-ledger/queue", "owner-other-tenant");
    expect((other.body["data"]["entries"] as Array<Record<string, unknown>>).map((e) => e["idempotency_key"])).toEqual([foreign]);
  });

  it("limit valideres (heltall 1-200) og respekteres", async () => {
    for (const bad of [0, 201, 1.5, "10", null, -1, true]) {
      expect((await call("/tool-ledger/queue", "owner-signed", { limit: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    for (let i = 0; i < 3; i += 1) await seed(newKey("q-limit"), "unverified", 100 + i);
    const limited = await call("/tool-ledger/queue", "owner-signed", { limit: 2 });
    expect(limited.status).toBe(200);
    expect(limited.body["data"]["entries"]).toHaveLength(2);
    expect(limited.body["data"]["total"]).toBeGreaterThan(2);
  });

  it("leseruten krever IKKE step-up (eier med en vanlig økt kan se køen)", async () => {
    expect((await call("/tool-ledger/queue", "owner-active")).status).toBe(200);
    expect((await call("/tool-ledger/queue", "owner-telegram")).status).toBe(200);
  });
});

describe("/tool-ledger/resolve", () => {
  it("validerer kroppen (felttyper) med 400 og en fast reason - uten å røre raden", async () => {
    const k = newKey("val");
    await seed(k, "unverified", 100);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...resolveBody(k), idempotency_key: 5 }, "idempotency_key"],
      [{ ...resolveBody(k), idempotency_key: undefined }, "idempotency_key"],
      [{ ...resolveBody(k), resolution: 3 }, "resolution"],
      [{ ...resolveBody(k), provider_checked: "true" }, "provider_checked"],
      [{ ...resolveBody(k), provider_checked: undefined }, "provider_checked"],
      [{ ...resolveBody(k), note: 42 }, "note"],
      [{ ...resolveBody(k), note: "x".repeat(2_001) }, "note"],
      [{ ...resolveBody(k), idempotency_key: "has space" }, "invalid_idempotency_key"],
      [{ ...resolveBody(k), idempotency_key: "" }, "invalid_idempotency_key"],
      [{ ...resolveBody(k), resolution: "retry" }, "invalid_resolution"],
      [{ ...resolveBody(k), provider_checked: false }, "provider_check_not_confirmed"]
    ];
    for (const [body, reason] of cases) {
      const res = await call("/tool-ledger/resolve", "owner-signed", body);
      expect(res, JSON.stringify(body).slice(0, 80)).toMatchObject({ status: 400, body: { error: "malformed_request", reason } });
    }
    expect((await rowOf(k))?.status).toBe("unverified");
  });

  it("KLASSE C: step-up kreves (en vanlig økt og en ikke-eier-kanal avvises med årsakskode); raden er uendret", async () => {
    const k = newKey("c");
    await seed(k, "unverified", 100);
    const active = await call("/tool-ledger/resolve", "owner-active", resolveBody(k));
    expect(active).toMatchObject({ status: 403, body: { error: "step_up_required", reason: "step_up_required:signed_device_session" } });
    const telegram = await call("/tool-ledger/resolve", "owner-telegram", resolveBody(k));
    expect(telegram).toMatchObject({ status: 403, body: { error: "step_up_required", reason: "step_up_required:channel_telegram_not_allowed" } });
    expect((await rowOf(k))?.status).toBe("unverified");
  });

  it("KLASSE C med step-up: `not_executed` gir failed (nøkkelen frigitt) og `executed` gir succeeded; svaret har kun faste felt, og revisjonen bærer merknaden men ikke nøkkelen i klartekst", async () => {
    const kNot = newKey("not"); const kExec = newKey("exec");
    await seed(kNot, "reserved", 700); await seed(kExec, "unverified", 100, { reason: "postcondition_unverified:readback_failed" });
    const note = "Sjekket i leverandørportalen, ingenting sendt";
    const not = await call("/tool-ledger/resolve", "owner-signed", resolveBody(kNot, { note }));
    expect(not).toMatchObject({ status: 200, body: { ok: true, data: { idempotency_key: kNot, tool_id: "rt_c", action: "mutate", from_status: "reserved", to_status: "failed", resolution: "not_executed", capability_class: "C" } } });
    expect(Object.keys(not.body["data"]).sort()).toEqual(["action", "capability_class", "from_status", "idempotency_key", "resolution", "tool_id", "to_status"].sort());
    expect(JSON.stringify(not.body)).not.toContain(note);
    const exec = await call("/tool-ledger/resolve", "owner-signed", resolveBody(kExec, { resolution: "executed" }));
    expect(exec).toMatchObject({ status: 200, body: { data: { from_status: "unverified", to_status: "succeeded", resolution: "executed" } } });
    expect(await rowOf(kNot)).toMatchObject({ status: "failed", resolution: "not_executed", resolved_by: OWNER });
    expect(await rowOf(kExec)).toMatchObject({ status: "succeeded", resolution: "executed", resolved_by: OWNER });
    const audit = (await admin.query("SELECT payload, person_id, capability_class FROM audit_events WHERE tenant_id = $1 AND type = 'tool.ledger_resolved' AND payload->>'key_fp' = $2", [T, shortFingerprint(kNot)])).rows as Array<{ payload: Record<string, unknown>; person_id: string; capability_class: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ person_id: OWNER, capability_class: "C" });
    expect(audit[0]?.payload).toMatchObject({ resolution: "not_executed", provider_checked: true, step_up: true, note });
    expect(JSON.stringify(audit[0])).not.toContain(kNot);
  });

  it("KLASSE B krever IKKE step-up (eierporten holder)", async () => {
    const k = newKey("b");
    await seed(k, "unverified", 100, { tool: "rt_b" });
    const res = await call("/tool-ledger/resolve", "owner-active", resolveBody(k, { resolution: "executed" }));
    expect(res).toMatchObject({ status: 200, body: { data: { capability_class: "B", to_status: "succeeded" } } });
  });

  it("ukjent verktøy behandles som klasse D: step-up kreves, og en avgjørelse med step-up går gjennom", async () => {
    const k = newKey("unknown");
    await seed(k, "unverified", 100, { tool: "removed_tool" });
    expect((await call("/tool-ledger/resolve", "owner-active", resolveBody(k))).status).toBe(403);
    const ok = await call("/tool-ledger/resolve", "owner-signed", resolveBody(k));
    expect(ok).toMatchObject({ status: 200, body: { data: { capability_class: null, to_status: "failed" } } });
  });

  it("faste statuskoder: ukjent nøkkel 404, allerede avgjort/avsluttet 409 (med radens status), for ung reserved 409, annen tenant 404", async () => {
    const decided = newKey("decided"); const done = newKey("done"); const young = newKey("young"); const mineOnly = newKey("mine");
    await seed(decided, "unverified", 100); await seed(done, "succeeded", 100); await seed(young, "reserved", 3); await seed(mineOnly, "unverified", 100);
    expect((await call("/tool-ledger/resolve", "owner-signed", resolveBody(newKey("missing")))).status).toBe(404);
    expect(await call("/tool-ledger/resolve", "owner-signed", resolveBody(decided))).toMatchObject({ status: 200 });
    expect(await call("/tool-ledger/resolve", "owner-signed", resolveBody(decided))).toMatchObject({ status: 409, body: { error: "ledger_not_resolvable", ledger_status: "failed" } });
    expect(await call("/tool-ledger/resolve", "owner-signed", resolveBody(done))).toMatchObject({ status: 409, body: { error: "ledger_not_resolvable", ledger_status: "succeeded" } });
    expect(await call("/tool-ledger/resolve", "owner-signed", resolveBody(young))).toMatchObject({ status: 409, body: { error: "ledger_resolve_too_early", ledger_status: "reserved" } });
    expect((await rowOf(young))?.status).toBe("reserved");
    // Eierens andre tenant finner ikke raden (RLS + tenant fra grantet).
    const crossTenant = await call("/tool-ledger/resolve", "owner-other-tenant", resolveBody(mineOnly));
    expect(crossTenant).toMatchObject({ status: 404, body: { error: "ledger_entry_not_found" } });
    expect((await rowOf(mineOnly))?.status).toBe("unverified");
  });

  it("to samtidige avgjørelser: nøyaktig én lykkes (200), den andre får 409", async () => {
    const k = newKey("race");
    await seed(k, "unverified", 100);
    const [a, b] = await Promise.all([
      call("/tool-ledger/resolve", "owner-signed", resolveBody(k, { resolution: "executed" })),
      call("/tool-ledger/resolve", "owner-signed", resolveBody(k, { resolution: "not_executed" }))
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const final = await rowOf(k);
    expect((final?.status === "succeeded") === (final?.resolution === "executed")).toBe(true);
  });
});
