import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SweepFailureCollector, type IdentityContext, type JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  LEDGER_RESERVED_FLOOR_MINUTES, ToolGateway, listLedgerQueue, parseLedgerReconcileConfig, resolveLedgerEntry, runLedgerReconcileForAllTenants, sanitizeLedgerNote, shortFingerprint, sweepLedgerTenant,
  type RequestDigestMode, type ResolveLedgerInput, type ToolDefinition, type ToolTransport
} from "../src/index.ts";

/**
 * WP-T1 K5 (JARVIS-103, Q-63 pkt 7): avstemming og utløp av `reserved`/`unverified` i ToolGateway-ledgeren, eierens kø og eierens avgjørelse - mot EKTE embedded Postgres (migrasjon 154) og en EKTE `ToolGateway`.
 * Beviser: sveipet flytter kun rader eldre enn TTL, aldri en retry/leverandørkall, er idempotent og tenant-skopet; en avstemt rad blokkerer fortsatt samme nøkkel (ingen ny mutasjon); eieren kan avgjøre (klasse-bevisst step-up),
 * og `executed` gir en lagret suksess mens `not_executed` frigir nøkkelen; hver overgang er revisjonsført uten nøkkelen i klartekst.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let policy: PolicyGateway;
const TENANT = "tenant-t1r";
const OTHER = "tenant-t1r-other";
const OWNER = "person-owner";
const identity: IdentityContext = { person_id: OWNER, tenant_id: TENANT, memory_space_id: "personal", session_id: "sess-t1r", device_id: "dev-t1r", channel: "api", auth_strength: "active" };
const stepped: IdentityContext = { ...identity, channel: "web", auth_strength: "signed" };
const otherOwner: IdentityContext = { ...identity, tenant_id: OTHER };
const otherOwnerStepped: IdentityContext = { ...otherOwner, channel: "web", auth_strength: "signed" };
const ownerGate = (who: IdentityContext): boolean => who.person_id === OWNER;
const secrets = { name: "t", get: async () => "cred" };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-t1r-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_t1r LOGIN PASSWORD 'pw2'");
  await admin.query("GRANT jarvis_app TO jarvis_t1r");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','T1R','person'), ('${OTHER}','T1R2','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}'), ('${OWNER}','${OTHER}');
  `);
  app = createPool({ ...base, user: "jarvis_t1r", password: "pw2" });
  policy = new PolicyGateway({ devices: { approverFor: async () => undefined }, nonces: { consume: async () => true }, killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [TENANT, OTHER] } });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

class Counter implements ToolTransport {
  mutations = 0;
  hang = false;
  async invoke(): Promise<{ external_id?: string; data?: JsonValue }> {
    this.mutations += 1;
    if (this.hang) return new Promise(() => undefined);
    return { external_id: `ext-${this.mutations}` };
  }
}
type Overrides = { [K in keyof ToolDefinition]?: ToolDefinition[K] | undefined };
function def(overrides: Overrides, transport: ToolTransport): ToolDefinition {
  const base: ToolDefinition = {
    tool_id: "t1c", action: "mutate", description: "test", input_schema: { safeParse: (v: unknown) => ({ success: true, data: v as Record<string, JsonValue> }) } as ToolDefinition["input_schema"],
    capability_class: "C", scopes: [], reversible: true, rollback_procedure: "sjekk hos leverandøren og rull tilbake manuelt", idempotent_external: false, timeout_ms: 5_000, rate_limit_per_minute: 10_000,
    credential_ref: "T1_TOKEN", output_trust: "internal", transport
  };
  const merged: Record<string, unknown> = { ...base, ...overrides };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as ToolDefinition;
}
const gateway = (defs: ToolDefinition[], mode?: RequestDigestMode): ToolGateway => {
  const g = new ToolGateway(app, policy, secrets, undefined, undefined, mode !== undefined ? { requestDigestMode: mode } : undefined);
  for (const d of defs) g.register(d);
  return g;
};
const newKey = (): string => `k-${randomUUID()}`;
/** Setter inn en rad direkte med en gitt alder (som en rad etterlatt av en krasj eller et uverifisert utfall for en stund siden). */
async function seed(key: string, status: string, ageMinutes: number, over: { tenant?: string; tool?: string; action?: string; reason?: string | null; external?: string | null; digest?: string | null } = {}): Promise<void> {
  await admin.query(
    `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, executed_at, postcondition_reason, external_id, request_digest, before_state)
     VALUES ($1, $2, $3, $4, $5, now() - make_interval(mins => $6::int), $7, $8, $9, '{"seed":true}'::jsonb)`,
    [over.tenant ?? TENANT, key, over.tool ?? "t1c", over.action ?? "mutate", status, ageMinutes, over.reason ?? null, over.external ?? null, over.digest ?? null]
  );
}
const rowOf = async (key: string, tenant = TENANT) =>
  (await admin.query("SELECT status, status_before_reconcile, reconcile_basis, reconciled_at, resolved_at, resolved_by, resolution, postcondition_reason, external_id FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2", [tenant, key])).rows[0] as
    { status: string; status_before_reconcile: string | null; reconcile_basis: string | null; reconciled_at: Date | null; resolved_at: Date | null; resolved_by: string | null; resolution: string | null; postcondition_reason: string | null; external_id: string | null } | undefined;
const audit = async (type: string, key: string, tenant = TENANT) =>
  (await admin.query("SELECT decision, reason, tool_id, action, capability_class, person_id, payload FROM audit_events WHERE tenant_id = $1 AND type = $2 AND payload->>'key_fp' = $3 ORDER BY audit_id", [tenant, type, shortFingerprint(key)])).rows as
    Array<{ decision: string; reason: string; tool_id: string; action: string; capability_class: string | null; person_id: string; payload: Record<string, unknown> }>;
const CFG = { reservedTtlMinutes: 60, unverifiedTtlHours: 24 };
/** `gate === null` betyr «ingen eierport i det hele tatt» (en parameterstandard ville ellers erstattet `undefined` med den ekte porten). */
const deps = (g: ToolGateway, gate: ((i: IdentityContext) => boolean) | null = ownerGate) => ({ pool: app, gateway: g, ownerGate: gate === null ? undefined : gate });
const input = (key: string, over: Partial<ResolveLedgerInput> = {}): ResolveLedgerInput => ({ idempotency_key: key, resolution: "not_executed", provider_checked: true, ...over });

describe("A: konfigurasjon (flagg AV som standard, streng validering)", () => {
  it("tom/usatt/off = av med standardverdier; kun eksakt `on` slår på", () => {
    for (const env of [{}, { JARVIS_TOOL_LEDGER_RECONCILE: "" }, { JARVIS_TOOL_LEDGER_RECONCILE: "off" }, { JARVIS_TOOL_LEDGER_RECONCILE: " OFF " }]) {
      expect(parseLedgerReconcileConfig(env)).toEqual({ enabled: false, reservedTtlMinutes: 60, unverifiedTtlHours: 24 });
    }
    expect(parseLedgerReconcileConfig({ JARVIS_TOOL_LEDGER_RECONCILE: " On " })).toEqual({ enabled: true, reservedTtlMinutes: 60, unverifiedTtlHours: 24 });
  });

  it("en ukjent verdi (typo) STOPPER oppstarten i stedet for å bli «av»", () => {
    for (const bad of ["true", "1", "enabled", "onn", "yes"]) expect(() => parseLedgerReconcileConfig({ JARVIS_TOOL_LEDGER_RECONCILE: bad }), bad).toThrow(/jarvis_tool_ledger_reconcile_invalid/);
  });

  it("TTL-ene leses og valideres KUN når flagget er på: ikke-heltall og verdier utenfor intervallet stopper oppstarten", () => {
    expect(parseLedgerReconcileConfig({ JARVIS_TOOL_LEDGER_RECONCILE: "on", JARVIS_TOOL_LEDGER_RESERVED_TTL_MINUTES: "30", JARVIS_TOOL_LEDGER_UNVERIFIED_TTL_HOURS: "48" })).toEqual({ enabled: true, reservedTtlMinutes: 30, unverifiedTtlHours: 48 });
    expect(parseLedgerReconcileConfig({ JARVIS_TOOL_LEDGER_RECONCILE: "on", JARVIS_TOOL_LEDGER_RESERVED_TTL_MINUTES: "15", JARVIS_TOOL_LEDGER_UNVERIFIED_TTL_HOURS: "2" })).toMatchObject({ reservedTtlMinutes: 15, unverifiedTtlHours: 2 });
    for (const bad of ["14", "0", "-5", "10081", "abc", "1.5", "60m", "1e3"]) {
      expect(() => parseLedgerReconcileConfig({ JARVIS_TOOL_LEDGER_RECONCILE: "on", JARVIS_TOOL_LEDGER_RESERVED_TTL_MINUTES: bad }), `reserved ${bad}`).toThrow(/jarvis_tool_ledger_reserved_ttl_minutes/);
    }
    for (const bad of ["1", "0", "2161", "x", "2.5"]) {
      expect(() => parseLedgerReconcileConfig({ JARVIS_TOOL_LEDGER_RECONCILE: "on", JARVIS_TOOL_LEDGER_UNVERIFIED_TTL_HOURS: bad }), `unverified ${bad}`).toThrow(/jarvis_tool_ledger_unverified_ttl_hours/);
    }
    expect(parseLedgerReconcileConfig({ JARVIS_TOOL_LEDGER_RECONCILE: "off", JARVIS_TOOL_LEDGER_RESERVED_TTL_MINUTES: "garbage" }).enabled).toBe(false);
  });
});

describe("B: utløpssveipet", () => {
  it("flytter KUN rader eldre enn TTL: reserved -> unknown_outcome, unverified -> needs_resolution; unge, avsluttede og andres rader røres ikke", async () => {
    const k = { oldReserved: newKey(), youngReserved: newKey(), oldUnverified: newKey(), youngUnverified: newKey(), oldSucceeded: newKey(), oldFailed: newKey(), otherTenant: newKey() };
    await seed(k.oldReserved, "reserved", 61);
    await seed(k.youngReserved, "reserved", 59);
    await seed(k.oldUnverified, "unverified", 25 * 60, { reason: "postcondition_unverified:no_provider_id", external: "ext-77" });
    await seed(k.youngUnverified, "unverified", 23 * 60);
    await seed(k.oldSucceeded, "succeeded", 40 * 24 * 60);
    await seed(k.oldFailed, "failed", 40 * 24 * 60, { reason: "tool_failed:x" });
    await seed(k.otherTenant, "reserved", 5000, { tenant: OTHER });
    const result = await sweepLedgerTenant(app, TENANT, CFG);
    expect(result.reserved_to_unknown).toBeGreaterThanOrEqual(1);
    expect(result.unverified_to_needs_resolution).toBeGreaterThanOrEqual(1);
    expect(await rowOf(k.oldReserved)).toMatchObject({ status: "unknown_outcome", status_before_reconcile: "reserved", reconcile_basis: "reserved_ttl_exceeded", resolved_at: null, resolution: null });
    expect((await rowOf(k.oldReserved))?.reconciled_at).toBeInstanceOf(Date);
    expect(await rowOf(k.oldUnverified)).toMatchObject({ status: "needs_resolution", status_before_reconcile: "unverified", reconcile_basis: "unverified_ttl_exceeded", postcondition_reason: "postcondition_unverified:no_provider_id", external_id: "ext-77" });
    for (const key of [k.youngReserved, k.youngUnverified, k.oldSucceeded, k.oldFailed]) expect((await rowOf(key))?.reconciled_at, key).toBeNull();
    expect((await rowOf(k.youngReserved))?.status).toBe("reserved");
    expect((await rowOf(k.youngUnverified))?.status).toBe("unverified");
    expect((await rowOf(k.oldSucceeded))?.status).toBe("succeeded");
    expect((await rowOf(k.oldFailed))?.status).toBe("failed");
    expect((await rowOf(k.otherTenant, OTHER))?.status).toBe("reserved"); // en annen tenant er ikke berørt av dette sveipet
  });

  it("er IDEMPOTENT: en ny kjøring finner ingenting, og radene beholder avstemmingstidspunktet fra første kjøring", async () => {
    const key = newKey();
    await seed(key, "reserved", 500);
    await sweepLedgerTenant(app, TENANT, CFG);
    const first = await rowOf(key);
    const again = await sweepLedgerTenant(app, TENANT, CFG);
    expect(again).toEqual({ reserved_to_unknown: 0, unverified_to_needs_resolution: 0 });
    expect((await rowOf(key))?.reconciled_at?.getTime()).toBe(first?.reconciled_at?.getTime());
    expect((await audit("tool.ledger_reconciled", key))).toHaveLength(1);
  });

  it("revisjon: ÉN rad per flyttet rad (system, fast årsakskode, kort avtrykk av nøkkelen, aldri nøkkelen eller leverandørtekst)", async () => {
    const key = `k-markor-${randomUUID()}`;
    await seed(key, "unverified", 3000, { reason: "postcondition_unverified:readback_failed" });
    await sweepLedgerTenant(app, TENANT, CFG);
    const rows = await audit("tool.ledger_reconciled", key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "ALLOW", reason: "unverified_ttl_exceeded", tool_id: "t1c", action: "mutate", person_id: "system" });
    expect(rows[0]?.payload).toMatchObject({ from_status: "unverified", to_status: "needs_resolution" });
    expect(Number((rows[0]?.payload as { age_minutes: number }).age_minutes)).toBeGreaterThanOrEqual(3000);
    expect(JSON.stringify(rows[0])).not.toContain("markor");
    const actor = (await admin.query("SELECT actor_kind FROM audit_events WHERE tenant_id = $1 AND type = 'tool.ledger_reconciled' AND payload->>'key_fp' = $2", [TENANT, shortFingerprint(key)])).rows[0] as { actor_kind: string };
    expect(actor.actor_kind).toBe("system");
  });

  it("grensen er presis: 14 minutter gammel reserved flyttes ikke ved TTL 15, 16 minutter gammel flyttes", async () => {
    const young = newKey(); const old = newKey();
    await seed(young, "reserved", 14);
    await seed(old, "reserved", 16);
    await sweepLedgerTenant(app, TENANT, { reservedTtlMinutes: 15, unverifiedTtlHours: 24 });
    expect((await rowOf(young))?.status).toBe("reserved");
    expect((await rowOf(old))?.status).toBe("unknown_outcome");
  });

  it("batch-taket gjelder per kjøring og per batch: `maxBatches` begrenser én kjøring, og flere batcher tar hele etterslepet; to samtidige sveip flytter hver rad nøyaktig én gang", async () => {
    const keys = Array.from({ length: 5 }, () => newKey());
    const tenant = "tenant-t1r-batch";
    await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenant}','B','person')`);
    for (const key of keys) await seed(key, "reserved", 700, { tenant });
    expect((await sweepLedgerTenant(app, tenant, CFG, 2, 1)).reserved_to_unknown).toBe(2); // én batch à 2
    expect((await sweepLedgerTenant(app, tenant, CFG, 1, 1)).reserved_to_unknown).toBe(1); // én batch à 1
    const [a, b] = await Promise.all([sweepLedgerTenant(app, tenant, CFG, 10), sweepLedgerTenant(app, tenant, CFG, 10)]);
    expect(a.reserved_to_unknown + b.reserved_to_unknown).toBe(2);
    const statuses = (await admin.query("SELECT status, count(*)::int AS n FROM tool_executions WHERE tenant_id = $1 GROUP BY status", [tenant])).rows;
    expect(statuses).toEqual([{ status: "unknown_outcome", n: 5 }]);
    const audits = (await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND type = 'tool.ledger_reconciled'", [tenant])).rows[0] as { n: number };
    expect(audits.n).toBe(5);
    // Flere batcher i samme kjøring (batch à 2 over 5 rader = 3 batcher) tar hele etterslepet.
    const more = Array.from({ length: 5 }, () => newKey());
    for (const key of more) await seed(key, "unverified", 40 * 60, { tenant, reason: "postcondition_unverified:readback_failed" });
    expect((await sweepLedgerTenant(app, tenant, CFG, 2)).unverified_to_needs_resolution).toBe(5);
    // Og `maxBatches` stopper en kjøring før hele etterslepet er tatt (resten tas av neste kjøring, idempotent).
    const rest = Array.from({ length: 5 }, () => newKey());
    for (const key of rest) await seed(key, "reserved", 700, { tenant });
    expect((await sweepLedgerTenant(app, tenant, CFG, 2, 2)).reserved_to_unknown).toBe(4);
    expect((await sweepLedgerTenant(app, tenant, CFG, 2, 2)).reserved_to_unknown).toBe(1);
  });

  it("alle tenants: én tenant sin feil velter ikke de andre og samles i feilsamleren (for `failOnSweepFailures`/nytt forsøk); en logglinje med KUN tall", async () => {
    const mine = newKey();
    await seed(mine, "reserved", 900);
    const failing = {
      connect: async () => {
        const client = await app.connect();
        const original = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = (...a: unknown[]) => {
          if (typeof a[0] === "string" && a[0].includes("set_config('jarvis.tenant_id'") && (a[1] as string[] | undefined)?.[0] === "tenant-boom") return Promise.reject(new Error("boom"));
          return original(...a);
        };
        return client;
      }
    } as unknown as pg.Pool;
    const collector = new SweepFailureCollector();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const summary = await runLedgerReconcileForAllTenants(failing, CFG, collector, async () => ["tenant-boom", TENANT]);
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    log.mockRestore();
    err.mockRestore();
    expect(summary).toMatchObject({ tenants: 2, failed_tenants: 1 });
    expect(summary.reserved_to_unknown).toBeGreaterThanOrEqual(1);
    expect(collector.failures.map((f) => f.tenant_id)).toEqual(["tenant-boom"]);
    expect((await rowOf(mine))?.status).toBe("unknown_outcome");
    expect(logged).toContain("tool_ledger_reconcile_done");
    expect(logged).not.toContain(mine);
  });

  it("uten en feilsamler og uten rader er sveipet et stille no-op (ingen revisjon)", async () => {
    const tenant = "tenant-t1r-empty";
    await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenant}','E','person')`);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runLedgerReconcileForAllTenants(app, CFG, undefined, async () => [tenant])).toEqual({ tenants: 1, failed_tenants: 0, reserved_to_unknown: 0, unverified_to_needs_resolution: 0 });
    log.mockRestore();
    expect(((await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1", [tenant])).rows[0] as { n: number }).n).toBe(0);
  });
});

describe("C: en avstemt rad blokkerer fortsatt samme nøkkel - ALDRI en automatisk retry (ekte ToolGateway)", () => {
  it("unknown_outcome: retry med samme nøkkel gir `execution_in_flight_or_outcome_unknown`, transporten kalles ikke, og raden røres ikke", async () => {
    const t = new Counter();
    const g = gateway([def({}, t)]);
    const key = newKey();
    await seed(key, "reserved", 700);
    await sweepLedgerTenant(app, TENANT, CFG);
    expect(await g.execute({ identity, tool_id: "t1c", action: "mutate", parameters: { a: 1 }, idempotency_key: key })).toEqual({ ok: false, reason: "execution_in_flight_or_outcome_unknown" });
    expect(t.mutations).toBe(0);
    expect((await rowOf(key))?.status).toBe("unknown_outcome");
    const rows = (await admin.query("SELECT payload FROM audit_events WHERE tenant_id = $1 AND type = 'tool.execution_in_flight' AND payload->>'status' = 'unknown_outcome'", [TENANT])).rows;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("needs_resolution: retry gir den LAGREDE årsaken (som unverified), transporten kalles ikke; ekte timeout -> unverified -> needs_resolution -> samme svar", async () => {
    const t = new Counter();
    t.hang = true;
    const g = gateway([def({ timeout_ms: 60 }, t)]);
    const key = newKey();
    const first = await g.execute({ identity, tool_id: "t1c", action: "mutate", parameters: { a: 1 }, idempotency_key: key });
    expect(first).toEqual({ ok: false, reason: "tool_failed:tool_timeout" });
    expect((await rowOf(key))?.status).toBe("unverified");
    await admin.query("UPDATE tool_executions SET executed_at = now() - interval '30 hours' WHERE tenant_id = $1 AND idempotency_key = $2", [TENANT, key]);
    await sweepLedgerTenant(app, TENANT, CFG);
    expect(await rowOf(key)).toMatchObject({ status: "needs_resolution", postcondition_reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
    t.hang = false;
    const retry = await g.execute({ identity, tool_id: "t1c", action: "mutate", parameters: { a: 1 }, idempotency_key: key });
    expect(retry).toEqual({ ok: false, reason: "postcondition_unverified:tool_timeout_outcome_unknown" });
    expect(t.mutations).toBe(1); // kun det første forsøket; ingen retry
  });

  it("`ToolGateway.reconcile()` lister også de avstemte radene (unknown_outcome/needs_resolution), tenant-skopet", async () => {
    const g = gateway([def({}, new Counter())]);
    const a = newKey(); const b = newKey(); const c = newKey();
    await seed(a, "reserved", 800); await seed(b, "unverified", 3000, { reason: "postcondition_unverified:no_provider_id" }); await seed(c, "reserved", 800, { tenant: OTHER });
    await sweepLedgerTenant(app, TENANT, CFG);
    await sweepLedgerTenant(app, OTHER, CFG);
    const listed = await g.reconcile(TENANT, 200);
    const byKey = new Map(listed.map((r) => [r.idempotency_key, r]));
    expect(byKey.get(a)).toMatchObject({ status: "unknown_outcome", recovery: "sjekk hos leverandøren og rull tilbake manuelt" });
    expect(byKey.get(b)).toMatchObject({ status: "needs_resolution", reason: "postcondition_unverified:no_provider_id" });
    expect(byKey.has(c)).toBe(false);
  });
});

describe("D: eierens kø", () => {
  it("lister uavgjorte rader (unverified, unknown_outcome, needs_resolution og reserved eldre enn gulvet) for denne tenanten, eldst først, med klasse, step-up-krav og fast årsakskode", async () => {
    const tenant = "tenant-t1r-queue";
    await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenant}','Q','person')`);
    const g = gateway([def({}, new Counter()), def({ tool_id: "t1b", capability_class: "B" }, new Counter())]);
    const rows = { unknown: newKey(), needs: newKey(), unverified: newKey(), reservedOld: newKey(), reservedYoung: newKey(), done: newKey(), unknownTool: newKey(), classB: newKey() };
    // `unknown_outcome`/`needs_resolution` kan kun settes av sveipet (databasevernet): seed som reserved/unverified og la sveipet flytte de gamle.
    await seed(rows.unknown, "reserved", 5000, { tenant });
    await seed(rows.needs, "unverified", 4000, { tenant, reason: "postcondition_unverified:no_provider_id", external: "ext-queue-1" });
    await seed(rows.unverified, "unverified", 100, { tenant, reason: "postcondition_mismatch" });
    await seed(rows.reservedOld, "reserved", LEDGER_RESERVED_FLOOR_MINUTES + 5, { tenant });
    await seed(rows.reservedYoung, "reserved", LEDGER_RESERVED_FLOOR_MINUTES - 5, { tenant });
    await seed(rows.done, "succeeded", 9000, { tenant });
    await seed(rows.unknownTool, "unverified", 50, { tenant, tool: "removed_tool", action: "gone", reason: "Hei <script>alert(1)</script> med mellomrom" });
    await seed(rows.classB, "unverified", 40, { tenant, tool: "t1b" });
    await sweepLedgerTenant(app, tenant, { reservedTtlMinutes: 600, unverifiedTtlHours: 24 });
    const queue = await listLedgerQueue(app, tenant, g);
    const keys = queue.entries.map((e) => e.idempotency_key);
    expect(keys).toEqual(expect.arrayContaining([rows.unknown, rows.needs, rows.unverified, rows.reservedOld, rows.unknownTool, rows.classB]));
    expect(keys).not.toContain(rows.reservedYoung);
    expect(keys).not.toContain(rows.done);
    expect(queue.total).toBe(queue.entries.length);
    const ages = queue.entries.map((e) => e.age_minutes);
    expect([...ages].sort((x, y) => y - x)).toEqual(ages); // eldst først
    const by = new Map(queue.entries.map((e) => [e.idempotency_key, e]));
    expect(by.get(rows.needs)).toMatchObject({ status: "needs_resolution", status_before_reconcile: "unverified", reason: "postcondition_unverified:no_provider_id", external_id: "ext-queue-1", capability_class: "C", step_up_required: true, recovery: "sjekk hos leverandøren og rull tilbake manuelt" });
    expect(by.get(rows.unverified)).toMatchObject({ status: "unverified", reason: "postcondition_mismatch" });
    expect(by.get(rows.classB)).toMatchObject({ capability_class: "B", step_up_required: false });
    expect(by.get(rows.unknownTool)).toMatchObject({ capability_class: null, step_up_required: true, recovery: "ukjent verktøy - manuell oppfølging" });
    expect(by.get(rows.unknownTool)?.reason).toBe("Hei__script_alert_1___script__med_mellomrom"); // aldri fri tekst til eieren: fast tegnsett
    expect(by.get(rows.reservedOld)).toMatchObject({ status: "reserved", step_up_required: true });
  });

  it("tenant-skopet (en annen tenant ser aldri radene), og limit/total", async () => {
    const g = gateway([def({}, new Counter())]);
    const tenant = "tenant-t1r-queue2";
    await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenant}','Q2','person')`);
    for (let i = 0; i < 5; i += 1) await seed(newKey(), "unverified", 100 + i, { tenant });
    const limited = await listLedgerQueue(app, tenant, g, { limit: 2 });
    expect(limited.entries).toHaveLength(2);
    expect(limited.total).toBe(5);
    expect(await listLedgerQueue(app, "tenant-t1r-empty-q", g)).toEqual({ total: 0, entries: [] });
    const mine = (await listLedgerQueue(app, TENANT, g, { limit: 200 })).entries.map((e) => e.idempotency_key);
    const theirs = (await listLedgerQueue(app, tenant, g, { limit: 200 })).entries.map((e) => e.idempotency_key);
    expect(mine.filter((k) => theirs.includes(k))).toEqual([]);
  });
});

describe("D2: køens `limit` er begrenset i selve funksjonen (uavhengig av ruten)", () => {
  it("1-200 (heltall avkortes), standard 100; `total` er alltid det fulle antallet", async () => {
    const tenant = "tenant-t1r-limit";
    await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenant}','L','person')`);
    await admin.query(
      `INSERT INTO tool_executions (tenant_id, idempotency_key, tool_id, action, status, executed_at)
       SELECT $1, 'lim-' || g, 't1c', 'mutate', 'unverified', now() - make_interval(mins => g) FROM generate_series(1, 205) AS g`, [tenant]
    );
    const g = gateway([def({}, new Counter())]);
    const sizes = async (limit?: number): Promise<[number, number]> => {
      const queue = await listLedgerQueue(app, tenant, g, limit === undefined ? {} : { limit });
      return [queue.entries.length, queue.total];
    };
    expect(await sizes()).toEqual([100, 205]);
    expect(await sizes(10_000)).toEqual([200, 205]);
    expect(await sizes(200)).toEqual([200, 205]);
    expect(await sizes(0)).toEqual([1, 205]);
    expect(await sizes(-5)).toEqual([1, 205]);
    expect(await sizes(2.9)).toEqual([2, 205]);
  });
});

describe("E: eierens avgjørelse (klasse-bevisst)", () => {
  const classC = (): { g: ToolGateway; t: Counter } => { const t = new Counter(); return { g: gateway([def({}, t), def({ tool_id: "t1b", capability_class: "B" }, t)]), t }; };

  it("kun den suverene eieren: ingen port, en port som kaster, eller en annen person gir `owner_required` - og ingenting endres", async () => {
    const { g } = classC();
    const key = newKey();
    await seed(key, "unverified", 100);
    const gates: Array<((i: IdentityContext) => boolean) | null> = [null, () => { throw new Error("x"); }, () => false, (i) => i.person_id === "someone-else", (() => "yes") as unknown as (i: IdentityContext) => boolean];
    for (const gate of gates) {
      expect(await resolveLedgerEntry(deps(g, gate), stepped, input(key))).toEqual({ ok: false, reason: "owner_required" });
    }
    // En person som ikke er eieren (porten sier nei) får heller ikke gjennom med step-up.
    expect(await resolveLedgerEntry(deps(g), { ...stepped, person_id: "person-intruder" }, input(key))).toEqual({ ok: false, reason: "owner_required" });
    expect((await rowOf(key))?.status).toBe("unverified");
    expect(await audit("tool.ledger_resolved", key)).toEqual([]);
  });

  it("validerer inndata FØR noe leses: ugyldig nøkkel, ugyldig avgjørelse og manglende bekreftelse", async () => {
    const { g } = classC();
    const key = newKey();
    await seed(key, "unverified", 100);
    expect(await resolveLedgerEntry(deps(g), stepped, input(""))).toEqual({ ok: false, reason: "invalid_idempotency_key" });
    for (const bad of ["a\nb", "tab\tkey", "x".repeat(301), `lone${String.fromCharCode(0xd800)}surrogate`, String.fromCodePoint(0x2028) + "sep", String.fromCodePoint(0x7f) + "del"]) {
      expect(await resolveLedgerEntry(deps(g), stepped, input(bad)), JSON.stringify(bad).slice(0, 40)).toEqual({ ok: false, reason: "invalid_idempotency_key" });
    }
    // Nøkkelen er valgt av kalleren: mellomrom og ikke-ASCII er lovlig (eksakt, bundet oppslag), og en ukjent nøkkel av den typen er `not_found`.
    expect(await resolveLedgerEntry(deps(g), stepped, input("n\u00f8kkel med mellomrom"))).toEqual({ ok: false, reason: "not_found" });
    expect(await resolveLedgerEntry(deps(g), stepped, { ...input(key), resolution: "retry" as never })).toEqual({ ok: false, reason: "invalid_resolution" });
    expect(await resolveLedgerEntry(deps(g), stepped, { ...input(key), provider_checked: false })).toEqual({ ok: false, reason: "provider_check_not_confirmed" });
    expect(await resolveLedgerEntry(deps(g), stepped, { ...input(key), provider_checked: "true" as never })).toEqual({ ok: false, reason: "provider_check_not_confirmed" });
    expect((await rowOf(key))?.status).toBe("unverified");
  });

  it("en nøkkel med mellomrom og ikke-ASCII (valgt av kalleren) kan avgjøres: oppslaget er eksakt, og revisjonen bærer kun avtrykket", async () => {
    const { g } = classC();
    const key = `n\u00f8kkel med mellomrom ${randomUUID()}`;
    await seed(key, "unverified", 100);
    expect(await resolveLedgerEntry(deps(g), stepped, input(key))).toMatchObject({ ok: true, idempotency_key: key, to_status: "failed" });
    expect((await rowOf(key))?.status).toBe("failed");
    expect(JSON.stringify(await audit("tool.ledger_resolved", key))).not.toContain("mellomrom");
  });

  it("KLASSE C/D og ukjent verktøy krever step-up (enhetssignert eier-økt); klasse B holder med eierporten", async () => {
    const { g } = classC();
    const c = newKey(); const b = newKey(); const unknown = newKey();
    await seed(c, "unverified", 100);
    await seed(b, "unverified", 100, { tool: "t1b" });
    await seed(unknown, "unverified", 100, { tool: "removed_tool", action: "gone" });
    expect(await resolveLedgerEntry(deps(g), identity, input(c))).toEqual({ ok: false, reason: "step_up_required:signed_device_session" });
    expect(await resolveLedgerEntry(deps(g), { ...stepped, channel: "telegram" }, input(c))).toEqual({ ok: false, reason: "step_up_required:channel_telegram_not_allowed" });
    expect(await resolveLedgerEntry(deps(g), { ...stepped, channel: "voice" }, input(unknown))).toEqual({ ok: false, reason: "step_up_required:channel_voice_not_allowed" });
    expect(await resolveLedgerEntry(deps(g), identity, input(unknown))).toEqual({ ok: false, reason: "step_up_required:signed_device_session" });
    expect((await rowOf(c))?.status).toBe("unverified");
    expect(await resolveLedgerEntry(deps(g), identity, input(b))).toMatchObject({ ok: true, to_status: "failed", capability_class: "B" });
    expect(await resolveLedgerEntry(deps(g), stepped, input(c))).toMatchObject({ ok: true, to_status: "failed", capability_class: "C" });
    expect(await resolveLedgerEntry(deps(g), stepped, input(unknown))).toMatchObject({ ok: true, capability_class: null });
  });

  it("`executed`: raden blir `succeeded` med avgjørelsen lagret, og en retry med samme nøkkel gir det lagrede resultatet (`deduplicated`) uten ny utførelse; revisjon uten nøkkelen i klartekst", async () => {
    const { g, t } = classC();
    const key = `k-markor-${randomUUID()}`;
    await seed(key, "unverified", 150, { reason: "postcondition_unverified:no_provider_id", external: "ext-9" });
    await sweepLedgerTenant(app, TENANT, { reservedTtlMinutes: 60, unverifiedTtlHours: 2 });
    expect((await rowOf(key))?.status).toBe("needs_resolution");
    const result = await resolveLedgerEntry(deps(g), stepped, input(key, { resolution: "executed", note: "Sjekket i leverandørens portal:\n  meldingen finnes." }));
    expect(result).toEqual({ ok: true, idempotency_key: key, tool_id: "t1c", action: "mutate", from_status: "needs_resolution", to_status: "succeeded", resolution: "executed", capability_class: "C" });
    expect(await rowOf(key)).toMatchObject({ status: "succeeded", resolution: "executed", resolved_by: OWNER, status_before_reconcile: "unverified", postcondition_reason: "postcondition_unverified:no_provider_id", external_id: "ext-9" });
    expect((await rowOf(key))?.resolved_at).toBeInstanceOf(Date);
    const replay = await g.execute({ identity, tool_id: "t1c", action: "mutate", parameters: { a: 1 }, idempotency_key: key });
    expect(replay).toMatchObject({ ok: true, deduplicated: true, external_id: "ext-9" });
    expect(t.mutations).toBe(0);
    const rows = await audit("tool.ledger_resolved", key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "ALLOW", reason: "executed", tool_id: "t1c", action: "mutate", capability_class: "C", person_id: OWNER });
    expect(rows[0]?.payload).toMatchObject({ from_status: "needs_resolution", to_status: "succeeded", resolution: "executed", provider_checked: true, step_up: true, previous_reason: "postcondition_unverified:no_provider_id", note: "Sjekket i leverandørens portal: meldingen finnes." });
    expect(JSON.stringify(rows[0])).not.toContain("markor");
  });

  it("`not_executed`: raden blir `failed` (nøkkelen er frigitt): samme nøkkel kan nå utføres på nytt, raden re-armeres og avgjørelsesfeltene nullstilles av databasen; en ny utførelse er ikke «avgjort»", async () => {
    const { g, t } = classC();
    const key = newKey();
    await seed(key, "reserved", 700);
    const result = await resolveLedgerEntry(deps(g), stepped, input(key, { resolution: "not_executed" }));
    expect(result).toMatchObject({ ok: true, from_status: "reserved", to_status: "failed", resolution: "not_executed" });
    expect(await rowOf(key)).toMatchObject({ status: "failed", resolution: "not_executed" });
    const retry = await g.execute({ identity, tool_id: "t1c", action: "mutate", parameters: { a: 1 }, idempotency_key: key });
    expect(retry).toMatchObject({ ok: true, deduplicated: false });
    expect(t.mutations).toBe(1);
    expect(await rowOf(key)).toMatchObject({ status: "succeeded", resolution: null, resolved_at: null, resolved_by: null, reconciled_at: null, reconcile_basis: null, status_before_reconcile: null });
    expect(await audit("tool.ledger_resolved", key)).toHaveLength(1); // beviset for avgjørelsen står igjen i den append-only revisjonen
  });

  it("alle ikke-endelige statuser kan avgjøres (også `unverified` FØR utløp og `reserved` eldre enn gulvet); endelige, ukjente og unge rader kan ikke", async () => {
    const { g } = classC();
    const k = { unverified: newKey(), oldReserved: newKey(), youngReserved: newKey(), succeeded: newKey(), failed: newKey(), missing: newKey() };
    await seed(k.unverified, "unverified", 5);
    await seed(k.oldReserved, "reserved", LEDGER_RESERVED_FLOOR_MINUTES + 1);
    await seed(k.youngReserved, "reserved", LEDGER_RESERVED_FLOOR_MINUTES - 2);
    await seed(k.succeeded, "succeeded", 100);
    await seed(k.failed, "failed", 100);
    expect(await resolveLedgerEntry(deps(g), stepped, input(k.unverified, { resolution: "executed" }))).toMatchObject({ ok: true, to_status: "succeeded" });
    expect(await resolveLedgerEntry(deps(g), stepped, input(k.oldReserved))).toMatchObject({ ok: true, to_status: "failed" });
    expect(await resolveLedgerEntry(deps(g), stepped, input(k.youngReserved))).toEqual({ ok: false, reason: "resolve_too_early", status: "reserved" });
    expect(await resolveLedgerEntry(deps(g), stepped, input(k.succeeded))).toEqual({ ok: false, reason: "not_resolvable", status: "succeeded" });
    expect(await resolveLedgerEntry(deps(g), stepped, input(k.failed))).toEqual({ ok: false, reason: "not_resolvable", status: "failed" });
    expect(await resolveLedgerEntry(deps(g), stepped, input(k.missing))).toEqual({ ok: false, reason: "not_found" });
    expect((await rowOf(k.youngReserved))?.status).toBe("reserved");
    expect((await rowOf(k.succeeded))?.resolution).toBeNull();
  });

  it("en avgjort rad kan ikke avgjøres igjen, og to samtidige avgjørelser: nøyaktig én vinner", async () => {
    const { g } = classC();
    const key = newKey();
    await seed(key, "unverified", 100);
    const results = await Promise.all([
      resolveLedgerEntry(deps(g), stepped, input(key, { resolution: "executed" })),
      resolveLedgerEntry(deps(g), stepped, input(key, { resolution: "not_executed" }))
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok) as { reason: string };
    expect(loser.reason).toBe("not_resolvable");
    expect(await audit("tool.ledger_resolved", key)).toHaveLength(1);
    const final = await rowOf(key);
    expect((final?.status === "succeeded") === (final?.resolution === "executed")).toBe(true);
  });

  it("tenant-isolasjon: en annen tenants eier finner ikke raden (`not_found`), og radene i den andre tenanten er urørt", async () => {
    const { g } = classC();
    const key = newKey();
    await seed(key, "unverified", 100);
    expect(await resolveLedgerEntry(deps(g), otherOwnerStepped, input(key))).toEqual({ ok: false, reason: "not_found" });
    expect((await rowOf(key))?.status).toBe("unverified");
  });

  it("merknaden renses (kontrolltegn, usynlige formateringstegn, lengde) og lagres kun i revisjonen; ingen merknad = ingen note-felt", async () => {
    const { g } = classC();
    const key = newKey(); const key2 = newKey();
    await seed(key, "unverified", 100); await seed(key2, "unverified", 100);
    const hidden = String.fromCodePoint(0x202e);
    await resolveLedgerEntry(deps(g), stepped, input(key, { note: `a${hidden}b\u0000c\n${"x".repeat(400)}` }));
    await resolveLedgerEntry(deps(g), stepped, input(key2));
    const note = (await audit("tool.ledger_resolved", key))[0]?.payload["note"] as string;
    expect(Array.from(note).length).toBeLessThanOrEqual(200);
    expect(note.startsWith("ab c xxx")).toBe(true);
    expect(note).not.toContain(hidden);
    expect("note" in ((await audit("tool.ledger_resolved", key2))[0]?.payload ?? {})).toBe(false);
    expect(sanitizeLedgerNote("   ")).toBeNull();
    expect(sanitizeLedgerNote(undefined)).toBeNull();
    // Den sentrale hemmelighetsskanneren kjøres FØRST: en token eieren limer inn lagres aldri i revisjonen.
    const pasted = sanitizeLedgerNote("Sjekket. Bearer abcdefghijklmnopqrstuvwxyz0123456789 var med i feilmeldingen.");
    expect(pasted).toBe("Sjekket. [REDACTED:bearer_token] var med i feilmeldingen.");
    expect(pasted).not.toContain("abcdefghijklmnop");
    expect(sanitizeLedgerNote(`x${String.fromCharCode(0xd800)}y`)).toBe("x?y");
  });

  it("sammen med digest-håndhevelse: etter `not_executed` avvises en retry med ANNEN nyttelast (`idempotency_key_reuse_mismatch`), mens SAMME nyttelast utføres", async () => {
    const t = new Counter();
    const g = gateway([def({}, t)], "enforce");
    const key = newKey();
    await g.execute({ identity, tool_id: "t1c", action: "mutate", parameters: { amount: 1 }, idempotency_key: key });
    await admin.query("UPDATE tool_executions SET status = 'unverified', postcondition_reason = 'postcondition_unverified:no_provider_id' WHERE tenant_id = $1 AND idempotency_key = $2", [TENANT, key]);
    expect(await resolveLedgerEntry(deps(g), stepped, input(key, { resolution: "not_executed" }))).toMatchObject({ ok: true, to_status: "failed" });
    expect(await g.execute({ identity, tool_id: "t1c", action: "mutate", parameters: { amount: 2 }, idempotency_key: key })).toEqual({ ok: false, reason: "idempotency_key_reuse_mismatch" });
    expect(await g.execute({ identity, tool_id: "t1c", action: "mutate", parameters: { amount: 1 }, idempotency_key: key })).toMatchObject({ ok: true, deduplicated: false });
    expect(t.mutations).toBe(2);
  });
});
