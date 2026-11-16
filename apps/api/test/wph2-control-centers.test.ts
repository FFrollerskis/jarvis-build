import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  CONTROL_ACTION_ALLOWED, ControlCenterAccessError, ControlCenterRegistry, ExecutiveService, VALUE_METRIC_CATALOG, composeInfraStatus, type ControlCenterDefinition, type ControlCenterId, type ControlCenterReport,
  type GoldenSuiteControl, type GoldenSuiteRunResult, type InfraMeasurements, type InfraStatusReport, type ValueMeasurement, type ValueReport, type ValueRuntimeFacts
} from "@jarvis/executive";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { BackupStatusRead, BackupStatusSnapshot } from "../src/backup-status.ts";
import { createOperationsCenter, CONNECTIONS_FAIL_RATIO } from "../src/control-center/operations.ts";
import { createPrivacyCenter, parseProcessingInventory } from "../src/control-center/privacy.ts";
import { CONTROL_CENTER_FLAGS, CONTROL_FEATURE_FLAGS, createControlCenterRegistry, registerControlCenters } from "../src/control-center/register.ts";
import { createSecurityCenter } from "../src/control-center/security.ts";
import { createValueCenter } from "../src/control-center/value.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { ScriptedPool, type ScriptedRule } from "./support/scripted-pool.ts";

/**
 * WP-H2 Drift-, Verdi-, Personvern- og Sikkerhet-senteret - ENHETSTESTER uten database (ekte SQL/RLS bevises i wph2-*-center-db.test.ts):
 *  1. FLAGG: AV som standard, kun eksakt «on»; uten flagg står senteret som «ikke koblet inn» (H0-oppførselen er uendret); et senter uten sine avhengigheter registreres ikke;
 *  2. EIER-KUN: kun den suverene eieren fra en signert enhetsøkt får noe (via den ene produksjonsfabrikken), og alt avslås FØR noe bygges;
 *  3. IDENTITETSBUNDET OG KUN LESING: tenant-lesing under identitetens tenant, ingen skrive-SQL, health aldri sammen med andre rom;
 *  4. ÆRLIG UKJENT: kilder som er nede gir UKJENT (aldri OK); det som ikke måles (oppetid-prosent, diskplass, spart tid, korrigeringer) står som ikke målt;
 *  5. INNHOLDSVERN OG REDAKSJON: hendelsestitler, runbook-innhold, kontonavn og hemmelighetsformede strenger når aldri rapporten;
 *  6. GOLDEN-SUITE-KNAPPEN: kun med flagget, riktig risikoklasse/step-up/endepunkt i kontrakten, og resultatet vises med digester.
 */
const authority = { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] };
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const NOW = new Date("2026-11-14T10:00:00.000Z");
const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();
const H = 3_600_000;
const D = 24 * H;
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const defs = productionToolDefinitions({ goldenSuite: true, autonomyRevoke: true });
const toolGateway = { get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a), list: () => defs } as unknown as ToolGateway;
const H2_CENTERS: ReadonlyArray<ControlCenterId> = ["operations", "value", "privacy", "security"];

// ---------------------------------------------------------------------------------------------------------------------
// Fikstures (ekte komponister der de finnes, så formene er produksjonens)
// ---------------------------------------------------------------------------------------------------------------------
const TITLE_SECRET = "Utrulling feilet: hemmelig-org/hemmelig-repo (main)";
const fakeGw = (health: Record<string, string> = {}): ToolGateway => ({
  list: () => ["cloudflare", "vercel", "gce", "docker", "langfuse", "infisical", "postgres_ops"].map((tool_id) => ({ tool_id, action: "x", credential_ref: `REF_${tool_id}`, capability_class: "A" })),
  health: new Map(Object.entries(health).map(([k, state]) => [k, { state, at: NOW.toISOString() }])), hasSecret: async () => true
}) as unknown as ToolGateway;

function incident(over: Partial<{ severity: "low" | "normal" | "high" | "critical"; opened_at: string }> = {}): never {
  return {
    incident_id: "inc-1", title: TITLE_SECRET, severity: over.severity ?? "high", source_kind: "deployment", phase: "open", phase_no: "åpen", opened_at: over.opened_at ?? iso(2 * H), last_seen_at: iso(H),
    occurrence_count: 3, last_change: { at: iso(H), actor_kind: "producer", to_phase_no: "åpen" }, evidence: { verified: 1, observed: 2, claimed: 1 }
  } as never;
}
const PRODUCERS = ["scheduler", "deployment", "sentry", "slo", "provider", "infra_execution", "watchdog"];
function infraReport(over: { incidents?: InfraMeasurements["incidents"]; producers_enabled?: boolean; health?: Record<string, string> } = {}): InfraStatusReport {
  const measurements: InfraMeasurements = {
    incidents: over.incidents === undefined ? { active: [], active_total: 0, by_phase: {}, resolved_last_7d: 3 } : over.incidents,
    last_changes: { cloudflare: { at: iso(D), action: "create_dns_record", outcome: "SUCCESS" } },
    producer_runs: PRODUCERS.map((producer) => ({ producer, last_status: "ok", last_started_at: iso(60_000), consecutive_failures: 0, opened: 0, updated: 0, resolved: 0, suppressed: 0, last_error: "hemmelig feiltekst som aldri skal vises" })),
    errors: []
  };
  const tools = ["cloudflare", "vercel", "gce", "docker", "langfuse", "infisical", "postgres_ops"];
  return composeInfraStatus({
    as_of: NOW, measurements, producers_enabled: over.producers_enabled ?? true, producers_interval_ms: 300_000, producer_names: PRODUCERS, infra_mode: "NORMAL",
    targets: tools.map((tool_id) => ({ tool_id, registered: true, configured: true, health: over.health?.[tool_id] ? { state: over.health[tool_id] as string, at: NOW.toISOString() } : { state: "healthy", at: NOW.toISOString() } }))
  });
}

function snapshot(over: Partial<{ backupAgeH: number; offsite: BackupStatusSnapshot["offsite"]["state"]; verify: BackupStatusSnapshot["restore_verify"]["state"]; verifyAgeD: number; heartbeat: boolean }> = {}): BackupStatusSnapshot {
  return {
    generated_at: iso(60_000), first_seen_at: iso(90 * D), last_tick_at: iso(60_000),
    backup: { state: "ok", last_set: "jarvis-backup-20261114T020000Z", last_set_at: iso((over.backupAgeH ?? 6) * H), size_bytes: 123_000_000, duration_s: 42, sets_on_disk: 7, interval_hours: 24, next_due_at: null, consecutive_failures: 0, last_error_code: null },
    offsite: { state: over.offsite ?? "ok", adapter: "rclone", last_success_at: iso(7 * H), last_verified_at: iso(7 * H), last_set: "jarvis-backup-20261114T020000Z", verification: "sha256", consecutive_failures: 0, last_error_code: null },
    restore_verify: {
      state: over.verify ?? "ok", interval_days: 30, last_attempt_at: iso((over.verifyAgeD ?? 5) * D), last_success_at: (over.verify ?? "ok") === "ok" ? iso((over.verifyAgeD ?? 5) * D) : null,
      last_set: "jarvis-backup-20261110T020000Z", duration_s: 90, fetch_duration_s: 10, tables: 120, rows: 45_000, source: "offsite", reported_by: "local", consecutive_failures: 0, last_error_code: null
    },
    heartbeat: { configured: over.heartbeat ?? true, last_ping_at: iso(7 * H), last_ping_kind: "success", last_ping_ok: true, last_error_code: null }
  };
}
const backupOk = (over: Parameters<typeof snapshot>[0] = {}) => async (): Promise<BackupStatusRead> => ({ kind: "ok", snapshot: snapshot(over) });

const VALUE_FACTS: ValueRuntimeFacts = {
  v1_delivery_configured: true, v2_push: { enabled: false, channel_configured: true, max_per_day: 3, quiet_hours: "22-07" }, v5_proposals_enabled: false,
  ev0: { constitution_verified: true, ledger_ok: true }, kill_switch_active: false, declared_gates: []
};
const WINDOWS = { d7: { from: "2026-11-07T23:00:00.000Z", to: NOW.toISOString() }, d30: { from: "2026-10-15T23:00:00.000Z", to: NOW.toISOString() } };
const win = (id: string, d7: number | null, d30: number | null = d7): ValueMeasurement => ({ id, state: "measured", last_7d: d7, last_30d: d30 });
const snap = (id: string, now: number | null): ValueMeasurement => ({ id, state: "measured", now });
async function valueReport(measurements: ValueMeasurement[] | "down", facts: ValueRuntimeFacts | null = VALUE_FACTS): Promise<ValueReport> {
  const svc = new ExecutiveService(fakeGw(), {
    value: {
      source: { measure: async () => { if (measurements === "down") throw new Error("connect ECONNREFUSED 10.9.9.9:5432 password=hemmelig"); return { windows: WINDOWS, measurements }; } },
      facts: () => { if (facts === null) throw new Error("fakta nede"); return facts; }
    }
  });
  return svc.getValueReport("tenant-owner");
}
/** Alle målbare metrikker i katalogen er målt (vindu: 5/20, øyeblikk: 3); de som aldri kan måles (spart tid, korrigeringer, brief åpnet) og de avledede får ingen måling. */
const ALL_MEASURED: ValueMeasurement[] = VALUE_METRIC_CATALOG
  .filter((m) => m.never_measurable_reason_no === undefined && m.derive === undefined)
  .map((m) => (m.shape === "snapshot" ? snap(m.id, 3) : win(m.id, 5, 20)));
const GOOD_VALUE_BASE: ValueMeasurement[] = [
  win("v1.briefs_generated", 7, 28), win("v1.briefs_delivered", 7, 28), win("v1.days_with_brief", 7, 28), win("v1.runner_days_completed", 7, 28), win("v1.runner_days_lost", 0, 0), win("v1.runner_retry_days", 0, 1),
  snap("v2.followups_open_now", 4), snap("v2.followups_overdue_now", 0), win("v2.followups_created", 3, 10), win("v2.followups_closed", 2, 8),
  win("tasks.created", 10, 40), win("tasks.completed", 9, 36), win("tasks.failed", 1, 4), win("tasks.cost_ore", 12_000, 50_000),
  win("chat.user_messages", 50, 200), win("chat.sessions", 12, 40), win("chat.active_days", 6, 22), win("chat.model_calls", 80, 300), win("chat.tool_requesting_calls", 20, 80),
  win("approvals.confirmations_requested", 5, 20), win("approvals.confirmations_approved", 4, 16), win("approvals.confirmations_rejected", 1, 4),
  win("cost.model_total_ore", 30_000, 120_000), snap("ops.incidents_open_now", 0), snap("ops.tasks_waiting_over_15m_now", 0)
];
/** Alt målt, med de konkrete tallene over lagt oppå (en rad per id - siste vinner). */
const GOOD_VALUE: ValueMeasurement[] = [...new Map([...ALL_MEASURED, ...GOOD_VALUE_BASE].map((m) => [m.id, m])).values()];

function goldenResult(over: Partial<GoldenSuiteRunResult> = {}): GoldenSuiteRunResult {
  return {
    ran_at: iso(5 * 60_000), duration_ms: 120, suite_id: "jarvis-golden", suite_version: 1, suite_digest: "a".repeat(64), result_digest: "b".repeat(64), total: 40, ran: 40, passed: 40, failed: [], skipped: [],
    red_team: [{ category: "exfiltration", attempts: 6, breaches: 0 }, { category: "prompt_injection", attempts: 9, breaches: 0 }], hard_stop: false, uncovered: [], surface_available: true, model_calls: 0, ...over
  };
}
const goldenControl = (last: GoldenSuiteRunResult | null): GoldenSuiteControl => ({ run: async () => goldenResult(), last: () => last });

// ---------------------------------------------------------------------------------------------------------------------
// ScriptedPool-regler: «alt friskt» + overstyringer
// ---------------------------------------------------------------------------------------------------------------------
const ERASURE_OK: ScriptedRule[] = [
  { match: /GROUP BY status, scope_type/, rows: [{ status: "completed", scope_type: "person", n: 2, last_started_at: iso(10 * D), last_completed_at: iso(10 * D) }] },
  { match: /FILTER \(WHERE status = 'failed'\)/, rows: [{ failed: 0, pending_stale: 0 }] },
  { match: /FROM erasure_fingerprints/, rows: [{ n: 5 }] }
];
const JOB_ROWS = (names: string[]): Array<Record<string, unknown>> => names.map((job_name) => ({ job_name, last_completed_at: iso(5 * H), last_open: false, last_had_error: false, last_attempts: 1 }));
const RETENTION_JOBS = ["operational-retention-sweep", "memory-retention-sweep", "location-retention-sweep", "health-retention-sweep", "vision-retention-sweep"];

function operationsRules(over: ScriptedRule[] = []): ScriptedRule[] {
  return [
    ...over,
    { match: /FROM operations_runbooks/, rows: (p) => (p.length > 0 ? [] : []) },
    { match: /FROM scheduler_state/, rows: JOB_ROWS(["daily-brief", "connector-health-sweep"]) },
    { match: /pg_database_size/, rows: [{ db_bytes: "250000000", connections: 12, max_connections: 100, started_at: iso(3 * D) }] },
    { match: /FILTER \(WHERE status = 'created' AND \(not_before/, rows: [{ ready: 0, running: 1, queued: 0 }] }
  ];
}
// Helse-lesingen (kun antall) kommer FØRST: den ender på `tenant_id = $1`, mens hovedlesingen har GROUP BY.
const runbookRules = (rows: Array<Record<string, unknown>>, health = 0): ScriptedRule[] => [
  { match: /FROM operations_runbooks WHERE tenant_id = \$1$/, rows: [{ n: health }] },
  { match: /FROM operations_runbooks/, rows }
];

function privacyRules(over: ScriptedRule[] = []): ScriptedRule[] {
  return [
    ...over,
    { match: /FROM pg_tables/, rows: [{ tablename: "audit_events" }, { tablename: "tasks" }, { tablename: "messages" }] },
    { match: /FROM scheduler_state/, rows: JOB_ROWS(RETENTION_JOBS) },
    { match: /FROM tool_executions/, rows: [{ tool_executions: 0, session_grants: 0 }] },
    { match: /min\(at\)/, rows: [{ audit_oldest: iso(200 * D), cost_oldest: iso(150 * D) }] },
    ...ERASURE_OK
  ];
}

const baseIdentityDenied = new Error("connect ECONNREFUSED 10.9.9.9:5432 password=hemmelig");
const everythingFails = (): ScriptedPool => new ScriptedPool([{ match: /./, rows: baseIdentityDenied }]);

function securityRules(over: ScriptedRule[] = []): ScriptedRule[] {
  return [
    ...over,
    { match: /FROM pg_trigger/, rows: [{ enabled: "O" }] },
    { match: /count\(\*\)\)::int AS events_7d/, rows: [{ events_7d: 120, events_24h: 20, denied_24h: 2, denied_7d: 9, failed_7d: 1, outcome_unknown_7d: 0, last_event_at: iso(60_000), last_denied_at: iso(H) }] },
    { match: /GROUP BY reason/, rows: [{ reason: "control_center_owner_only", n: 6 }, { reason: "kill_switch_active", n: 3 }] },
    { match: /FROM finance_kill_switch/, rows: [{ enabled: false, enabled_at: null }] }
  ];
}
const okControls = { listFrozenConnectorsDurable: async () => [], listRevokedCredentialsDurable: async () => [] };
const killOff = { currentStateDurable: async () => null };

type Env = Record<string, string | undefined>;
type Factory = (pool: ScriptedPool, env?: Env) => ControlCenterDefinition | Promise<ControlCenterDefinition>;
const FACTORIES: Record<"operations" | "value" | "privacy" | "security", Factory> = {
  operations: (pool) => createOperationsCenter({ pool: pool.asPool(), infraStatus: async () => infraReport(), backupStatus: backupOk(), processStartedAt: () => new Date(NOW.getTime() - 2 * D), maxActiveJobs: 3 }),
  value: async () => { const r = await valueReport(GOOD_VALUE); return createValueCenter({ valueReport: async () => r }); },
  privacy: (pool, env = {}) => createPrivacyCenter({ pool: pool.asPool(), env, repoRoot: REPO_ROOT }),
  security: (pool) => createSecurityCenter({ pool: pool.asPool(), toolGateway, ownerControls: okControls, killSwitch: killOff, goldenSuite: goldenControl(goldenResult()) })
};

async function build(id: keyof typeof FACTORIES, pool: ScriptedPool, identity: IdentityContext = owner, env: Env = {}): Promise<ControlCenterReport> {
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(await FACTORIES[id](pool, env));
  return (await registry.report(id, identity)) as ControlCenterReport;
}
const section = (r: ControlCenterReport, id: string) => r.sections.find((s) => s.id === id)!;
const item = (r: ControlCenterReport, sectionId: string, itemId: string) => section(r, sectionId).items.find((i) => i.id === itemId)!;

// ---------------------------------------------------------------------------------------------------------------------
// 1. Flagg
// ---------------------------------------------------------------------------------------------------------------------
describe("flagg: AV som standard, kun «on» slår et senter på", () => {
  const ownerControls = okControls as never;
  const wiring = (env: Env, extra: Record<string, unknown> = {}) => ({
    pool: new ScriptedPool([]).asPool(), env, toolGateway, ownerControls, killSwitch: killOff as never,
    infraStatus: async () => infraReport(), valueReport: async () => valueReport(GOOD_VALUE), ...extra
  });
  const registered = (env: Env, extra: Record<string, unknown> = {}): string[] => {
    const registry = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(registry, wiring(env, extra));
    return registry.list().map((c) => c.id).filter((id) => (H2_CENTERS as readonly string[]).includes(id));
  };

  it("uten flagg registreres INGEN av de fire (H0/H1-oppførselen er uendret: de står som «ikke koblet inn»)", async () => {
    expect(registered({})).toEqual([]);
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registerControlCenters(registry, wiring({}));
    const overview = await registry.overview(owner);
    expect(overview.unregistered).toEqual(expect.arrayContaining([...H2_CENTERS]));
  });

  it("hvert flagg slår på nøyaktig sitt senter, og alle fire sammen gir alle fire", () => {
    expect(registered({ [CONTROL_CENTER_FLAGS.operations]: "on" })).toEqual(["operations"]);
    expect(registered({ [CONTROL_CENTER_FLAGS.value]: "on" })).toEqual(["value"]);
    expect(registered({ [CONTROL_CENTER_FLAGS.privacy]: "on" })).toEqual(["privacy"]);
    expect(registered({ [CONTROL_CENTER_FLAGS.security]: "on" })).toEqual(["security"]);
    const all = Object.fromEntries([CONTROL_CENTER_FLAGS.operations, CONTROL_CENTER_FLAGS.value, CONTROL_CENTER_FLAGS.privacy, CONTROL_CENTER_FLAGS.security].map((f) => [f, "on"]));
    expect(registered(all)).toEqual(["operations", "value", "privacy", "security"]);
  });

  it("kun den EKSAKTE verdien «on» teller: true, 1, ON, yes, mellomrom, tom streng og off er alle AV (også for de to funksjonsflaggene)", () => {
    for (const value of ["true", "1", "ON", "On", "yes", " on", "on ", "", "off", "false", "enabled"]) {
      const env = Object.fromEntries([...Object.values(CONTROL_CENTER_FLAGS), ...Object.values(CONTROL_FEATURE_FLAGS)].map((f) => [f, value]));
      expect(registered(env), JSON.stringify(value)).toEqual([]);
    }
  });

  it("flaggnavnene er stabile og dokumentert i `.env.example`", () => {
    expect(CONTROL_CENTER_FLAGS).toEqual({
      finance: "JARVIS_CONTROL_CENTER_FINANCE", memory: "JARVIS_CONTROL_CENTER_MEMORY", agent: "JARVIS_CONTROL_CENTER_AGENT",
      operations: "JARVIS_CONTROL_CENTER_OPERATIONS", value: "JARVIS_CONTROL_CENTER_VALUE", privacy: "JARVIS_CONTROL_CENTER_PRIVACY", security: "JARVIS_CONTROL_CENTER_SECURITY",
      // WP-B3 (D-475): tilleggssenteret Evolusjon
      evolution: "JARVIS_CONTROL_CENTER_EVOLUTION"
    });
    expect(CONTROL_FEATURE_FLAGS).toEqual({ goldenSuite: "JARVIS_CONTROL_GOLDEN_SUITE", autonomyRevoke: "JARVIS_CONTROL_AUTONOMY_REVOKE" });
    const envExample = readFileSync(fileURLToPath(new URL("../../../.env.example", import.meta.url)), "utf8");
    for (const name of [...Object.values(CONTROL_CENTER_FLAGS), ...Object.values(CONTROL_FEATURE_FLAGS)]) expect(envExample, name).toContain(name);
  });

  it("et senter uten sine avhengigheter registreres IKKE selv med flagget på: Drift trenger infraStatus, Verdi trenger valueReport, Sikkerhet trenger verktøyregister, eier-kontroller og kill switch - Personvern trenger ingen", () => {
    const bare = { pool: new ScriptedPool([]).asPool() };
    const on = { [CONTROL_CENTER_FLAGS.operations]: "on", [CONTROL_CENTER_FLAGS.value]: "on", [CONTROL_CENTER_FLAGS.privacy]: "on", [CONTROL_CENTER_FLAGS.security]: "on" };
    const registry = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(registry, { ...bare, env: on });
    expect(registry.list().map((c) => c.id)).toEqual(["privacy"]);
  });

  it("golden-suite-knappen finnes KUN når JARVIS_CONTROL_GOLDEN_SUITE=on OG kjøreren er koblet inn", async () => {
    const securityOn = { [CONTROL_CENTER_FLAGS.security]: "on" };
    const actionsFor = async (env: Env, extra: Record<string, unknown>): Promise<string[]> => {
      const registry = createControlCenterRegistry({ authority, now: () => NOW });
      registerControlCenters(registry, wiring(env, extra));
      return ((await registry.report("security", owner)) as ControlCenterReport).actions.map((a) => a.id);
    };
    const runner = goldenControl(null);
    expect(await actionsFor(securityOn, { goldenSuite: runner })).toEqual([]);
    expect(await actionsFor({ ...securityOn, [CONTROL_FEATURE_FLAGS.goldenSuite]: "true" }, { goldenSuite: runner })).toEqual([]);
    expect(await actionsFor({ ...securityOn, [CONTROL_FEATURE_FLAGS.goldenSuite]: "on" }, {})).toEqual([]);
    expect(await actionsFor({ ...securityOn, [CONTROL_FEATURE_FLAGS.goldenSuite]: "on" }, { goldenSuite: runner })).toEqual(["security.golden_suite.run"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Eier-kun
// ---------------------------------------------------------------------------------------------------------------------
describe("eier-kun: kun den suverene eieren fra en signert enhetsøkt (produksjonsfabrikken)", () => {
  const NON_OWNERS: ReadonlyArray<readonly [string, IdentityContext, string]> = [
    ["annen person i eierens tenant", { ...owner, person_id: "person-member" }, "control_center_owner_only"],
    ["delegat", { ...owner, delegation_id: "deleg-1" }, "control_center_owner_only"],
    ["gjest", { ...owner, person_id: "person-guest", memory_space_id: "guest" }, "control_center_owner_only"],
    ["eierens person i annen tenant", { ...owner, tenant_id: "tenant-annen" }, "control_center_owner_only"],
    ["eieren, passiv økt (tale)", { ...owner, channel: "voice", auth_strength: "passive" }, "control_center_requires_signed_device_session"],
    ["eieren, aktiv økt uten enhetssignatur", { ...owner, auth_strength: "active" }, "control_center_requires_signed_device_session"]
  ];
  for (const id of H2_CENTERS as ReadonlyArray<keyof typeof FACTORIES>) {
    it(`${id}: alle ikke-eiere og svak autentisering nektes FØR noe bygges (ingen spørring mot databasen)`, async () => {
      const pool = new ScriptedPool(id === "privacy" ? privacyRules() : id === "security" ? securityRules() : operationsRules());
      const registry = createControlCenterRegistry({ authority, now: () => NOW });
      registry.register(await FACTORIES[id](pool));
      for (const [label, identity, reason] of NON_OWNERS) {
        await expect(registry.report(id, identity), label).rejects.toMatchObject({ name: "ControlCenterAccessError", reason });
        await expect(registry.overview(identity), label).rejects.toBeInstanceOf(ControlCenterAccessError);
      }
      expect(pool.queries).toEqual([]);
      expect(await registry.report(id, owner)).not.toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Identitetsbundet og kun lesing
// ---------------------------------------------------------------------------------------------------------------------
describe("identitetsbundet og kun lesing", () => {
  const other: IdentityContext = { ...owner, tenant_id: "tenant-annen", person_id: "person-annen" };
  const rulesFor = (id: string): ScriptedRule[] => (id === "privacy" ? privacyRules() : id === "security" ? securityRules() : operationsRules());
  const GLOBAL_OK = /scheduler_state|pg_database_size|pg_tables|pg_trigger|situation_domain_pauses/;

  for (const id of ["operations", "privacy", "security"] as const) {
    it(`${id}: ALL tenant-lesing skjer under identitetens egen tenant, og spørringer uten tenant er KUN de globale driftstabellene/systemkatalogen`, async () => {
      for (const identity of [owner, other]) {
        const pool = new ScriptedPool(rulesFor(id));
        await build(id, pool, identity);
        for (const t of pool.tenantsUsed()) expect(t === null || t === identity.tenant_id, `${id}/${identity.tenant_id}: ${t}`).toBe(true);
        for (const q of pool.queries.filter((x) => x.tenant === null)) expect(q.sql, q.sql.slice(0, 90)).toMatch(GLOBAL_OK);
        for (const q of pool.queries.filter((x) => x.tenant !== null && x.params.length > 0 && typeof x.params[0] === "string")) expect(q.params[0]).toBe(identity.tenant_id);
      }
    });

    it(`${id}: ingen skrive-SQL (INSERT/UPDATE/DELETE/DDL), og health leses aldri sammen med andre rom`, async () => {
      const pool = new ScriptedPool(rulesFor(id));
      await build(id, pool);
      expect(pool.queries.length).toBeGreaterThan(3);
      for (const q of pool.queries) {
        expect(q.sql, q.sql.slice(0, 90)).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+|CREATE\s+(TABLE|INDEX)|GRANT\s)/i);
        if (q.spaces !== null && q.spaces.split(",").includes("health")) expect(q.spaces, q.sql.slice(0, 60)).toBe("health");
      }
    });
  }

  it("Verdi gjør ingen databaselesing selv (den komponerer en ferdig rapport) og får tenanten fra den betrodde identiteten", async () => {
    const tenants: string[] = [];
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createValueCenter({ valueReport: async (t) => { tenants.push(t); return valueReport(GOOD_VALUE); } }));
    await registry.report("value", owner);
    await registry.report("value", other);
    expect(tenants).toEqual(["tenant-owner", "tenant-annen"]);
  });

  it("Drift leser runbooks i EN egen health-lesing som ett antall (aldri innhold), og aldri tittel eller innhold", async () => {
    const pool = new ScriptedPool(operationsRules(runbookRules([{ category: "incident_response", active: 1, inactive: 0, last_updated_at: iso(D) }], 2)));
    const r = await build("operations", pool);
    const healthReads = pool.queries.filter((q) => q.spaces === "health");
    expect(healthReads).toHaveLength(1);
    expect(healthReads[0]?.sql).toMatch(/count\(\*\)/i);
    for (const q of pool.queries.filter((x) => /operations_runbooks/.test(x.sql))) expect(q.sql).not.toMatch(/\b(title|content)\b/i);
    expect(item(r, "runbooks", "health_space").facts).toMatchObject({ count: 2 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Ærlig ukjent
// ---------------------------------------------------------------------------------------------------------------------
describe("ærlig ukjent", () => {
  it("Drift: når ALLE kilder er nede er hver seksjon UKJENT og senteret er UKJENT - aldri OK - og feilmeldingen (verten, passordet) lekker ikke", async () => {
    const down = new Error("connect ECONNREFUSED 10.9.9.9:5432 password=hemmelig");
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createOperationsCenter({ pool: everythingFails().asPool(), infraStatus: async () => { throw down; }, backupStatus: async () => { throw down; } }));
    const r = (await registry.report("operations", owner)) as ControlCenterReport;
    // uptime og capacity har sine egne ukjente elementer (aldri OK): ingen seksjon er OK
    for (const s of r.sections) expect(s.status, s.id).not.toBe("OK");
    expect(r.status).toBe("UNKNOWN");
    for (const id of ["incidents", "targets", "producers", "backups", "restore_drills", "runbooks", "jobs"]) expect(section(r, id), id).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(JSON.stringify(r)).not.toContain("10.9.9.9");
    expect(JSON.stringify(r)).not.toContain("hemmelig");
    expect(JSON.stringify(r)).toContain("kunne ikke leses");
  });

  it("Verdi: når kilden og faktaene er nede er hver løkke ukjent og målingene ikke målbare - aldri 0 og aldri OK", async () => {
    const r = await build("value", new ScriptedPool([]));
    expect(r.status).not.toBe("OK");
    const down = (await buildValue("down")) as ControlCenterReport;
    expect(down.status).toBe("UNKNOWN");
    for (const s of down.sections) expect(s.status, s.id).toBe("UNKNOWN");
    expect(JSON.stringify(down)).not.toContain("10.9.9.9");
    expect(JSON.stringify(down)).not.toContain("password");
  });

  it("Verdi: spart tid og eierens korrigeringer er IKKE målt noe sted - de står som ikke målt (aldri 0), og senteret er UKJENT selv om alt annet er målt og i orden", async () => {
    const r = await build("value", new ScriptedPool([]));
    for (const [sec, metric] of [["time_saved", "tasks.time_saved"], ["owner_corrections", "chat.owner_corrections"]] as const) {
      expect(section(r, sec).status).toBe("UNKNOWN");
      const it = section(r, sec).items[0]!;
      expect(it.id).toBe(`metric:${metric}`);
      expect(it.status).toBe("UNKNOWN");
      expect(it.detail_no).toContain("IKKE MÅLT");
      expect(it.facts).toMatchObject({ measured: false, now: null, last_7d: null, last_30d: null });
    }
    for (const id of ["v2", "usage", "tasks_closed"]) expect(section(r, id).status, id).toBe("OK");
    // V1 har også en måling som ALDRI kan gjøres (brief åpnet/besvart: Telegram gir ingen lesekvittering) - også den står som ikke målt, ikke som 0
    expect(item(r, "v1", "metric:v1.opened_or_answered")).toMatchObject({ status: "UNKNOWN", facts: { measured: false, last_7d: null } });
    expect(section(r, "v1").status).toBe("UNKNOWN");
    expect(r.status).toBe("UNKNOWN");
  });

  it("Privacy: uten dokumentet er dokumentdelen UKJENT (ikke OK) med årsaken, men de levende tabellene og slettebevisene måles likevel", async () => {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createPrivacyCenter({ pool: new ScriptedPool(privacyRules()).asPool(), env: {}, repoRoot: "/finnes/ikke/her" }));
    const r = (await registry.report("privacy", owner)) as ControlCenterReport;
    expect(item(r, "inventory", "inventory_doc")).toMatchObject({ status: "UNKNOWN" });
    expect(item(r, "inventory", "inventory_doc").detail_no).toContain("docs/ følger ikke med api-imaget");
    expect(item(r, "inventory", "coverage").status).toBe("UNKNOWN");
    expect(item(r, "inventory", "coverage").facts).toMatchObject({ live_tables: 3 });
    for (const id of ["processors", "dpia"]) expect(section(r, id), id).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(section(r, "retention").measured).toBe(true);
    expect(section(r, "deletion_evidence").measured).toBe(true);
    expect(r.status).not.toBe("OK");
  });

  it("Sikkerhet: alle kilder nede gir UKJENT i hver seksjon utenom Gjenoppretting/Revisjon/Golden-suite (som har egne tilstandselementer) - aldri OK", async () => {
    const reg = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    const dead = async (): Promise<never> => { throw baseIdentityDenied; };
    reg.register(createSecurityCenter({ pool: everythingFails().asPool(), toolGateway, ownerControls: { listFrozenConnectorsDurable: dead, listRevokedCredentialsDurable: dead }, killSwitch: { currentStateDurable: dead } }));
    const r = (await reg.report("security", owner)) as ControlCenterReport;
    for (const s of r.sections) expect(s.status, s.id).not.toBe("OK");
    expect(r.status).toBe("UNKNOWN");
    expect(section(r, "credentials")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(section(r, "suspicious")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(JSON.stringify(r)).not.toContain("10.9.9.9");
    expect(JSON.stringify(r)).not.toContain("hemmelig");
  });

  it("én kilde som svikter gir UKJENT kun for sin seksjon: Drift uten runbook-tabellen, Personvern uten sletting, Sikkerhet uten triggerlesing", async () => {
    const ops = await build("operations", new ScriptedPool(operationsRules([{ match: /FROM operations_runbooks/, rows: new Error("permission denied for table operations_runbooks") }])));
    expect(section(ops, "runbooks")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(section(ops, "incidents").measured).toBe(true);
    const priv = await build("privacy", new ScriptedPool(privacyRules([{ match: /FROM erasure_requests/, rows: new Error("permission denied for table erasure_requests") }])));
    expect(section(priv, "deletion_evidence")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(section(priv, "retention").measured).toBe(true);
    const sec = await build("security", new ScriptedPool(securityRules([{ match: /FROM pg_trigger/, rows: new Error("permission denied for catalog") }])));
    expect(item(sec, "audit", "append_only")).toMatchObject({ status: "UNKNOWN" });
    expect(item(sec, "audit", "activity").status).toBe("OK");
  });
});

async function buildValue(mode: "down"): Promise<ControlCenterReport> {
  const report = await valueReport(mode === "down" ? "down" : GOOD_VALUE, null);
  // en tjeneste uten fakta og uten kilde gir ikke-målbare målinger; for å teste at SENTERET (ikke tjenesten) er ærlig når rapporten ikke kan hentes, kaster vi fra funksjonen
  void report;
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(createValueCenter({ valueReport: async () => { throw new Error("connect ECONNREFUSED 10.9.9.9:5432 password=hemmelig"); } }));
  return (await registry.report("value", owner)) as ControlCenterReport;
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Drift: semantikk
// ---------------------------------------------------------------------------------------------------------------------
describe("Drift: statusene følger det som er målt", () => {
  const withInfra = (infra: InfraStatusReport, opts: Partial<Parameters<typeof createOperationsCenter>[0]> = {}, rules: ScriptedRule[] = []) => {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createOperationsCenter({ pool: new ScriptedPool(operationsRules(rules)).asPool(), infraStatus: async () => infra, backupStatus: backupOk(), processStartedAt: () => new Date(NOW.getTime() - D), ...opts }));
    return registry.report("operations", owner) as Promise<ControlCenterReport>;
  };

  it("en kritisk åpen hendelse er FEIL, en høy er advarsel, og titler/bevistekst/feiltekst vises aldri", async () => {
    const crit = await withInfra(infraReport({ incidents: { active: [incident({ severity: "critical" }), incident({ severity: "high" })], active_total: 2, by_phase: { open: 2 }, resolved_last_7d: 1 } }));
    expect(item(crit, "incidents", "open_total").status).toBe("FAIL");
    expect(item(crit, "incidents", "severity:critical").status).toBe("FAIL");
    expect(item(crit, "incidents", "severity:high").status).toBe("WARN");
    expect(item(crit, "incidents", "evidence").facts).toMatchObject({ verified: 2, observed: 4, claimed: 2 });
    const text = JSON.stringify(crit);
    expect(text).not.toContain("hemmelig-org");
    expect(text).not.toContain("hemmelig feiltekst");
    const high = await withInfra(infraReport({ incidents: { active: [incident()], active_total: 1, by_phase: { open: 1 }, resolved_last_7d: 0 } }));
    expect(item(high, "incidents", "open_total").status).toBe("WARN");
  });

  it("ingen hendelser: OK når automatisk oppdagelse er PÅ - men kun ADVARSEL når den er AV (da betyr «ingen» bare «ingen registrert manuelt»)", async () => {
    expect(item(await withInfra(infraReport()), "incidents", "open_total").status).toBe("OK");
    const off = await withInfra(infraReport({ producers_enabled: false }));
    expect(item(off, "incidents", "open_total")).toMatchObject({ status: "WARN" });
    expect(item(off, "incidents", "open_total").detail_no).toContain("automatisk oppdagelse er AV");
    expect(section(off, "producers").items.filter((i) => i.id.startsWith("producer:")).every((i) => i.status === "UNKNOWN")).toBe(true);
  });

  it("et åpent hendelses-søk som ikke kunne måles (kilden feilet) er UKJENT - aldri «ingen hendelser»", async () => {
    const r = await withInfra(infraReport({ incidents: null }));
    expect(section(r, "incidents")).toMatchObject({ status: "UNKNOWN", measured: false });
  });

  it("skymål: nede = FEIL, degradert = advarsel, sovende = i orden (ikke koblet inn), ikke målt = UKJENT; vakthundens egne sjekker er alltid ikke målt", async () => {
    const r = await withInfra(infraReport({ health: { cloudflare: "auth_failed", vercel: "rate_limited" } }));
    expect(item(r, "targets", "target:cloudflare").status).toBe("FAIL");
    expect(item(r, "targets", "target:vercel").status).toBe("WARN");
    expect(item(r, "producers", "watchdog_direct")).toMatchObject({ status: "UNKNOWN" });
  });

  it("backup: i orden gir OK; utdatert gir advarsel; manglende statusfil og uleselig fil er UKJENT; ikke satt opp er UKJENT med årsaken", async () => {
    expect(section(await withInfra(infraReport()), "backups").status).toBe("OK");
    const old = await withInfra(infraReport(), { backupStatus: backupOk({ backupAgeH: 60 }) });
    expect(item(old, "backups", "overall").status).toBe("WARN");
    for (const read of [{ kind: "missing" }, { kind: "invalid", reason: "bad_schema" }] as BackupStatusRead[]) {
      const r = await withInfra(infraReport(), { backupStatus: async () => read });
      expect(section(r, "backups")).toMatchObject({ status: "UNKNOWN", measured: false });
      expect(section(r, "restore_drills")).toMatchObject({ status: "UNKNOWN", measured: false });
    }
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createOperationsCenter({ pool: new ScriptedPool(operationsRules()).asPool(), infraStatus: async () => infraReport() }));
    const unset = (await registry.report("operations", owner)) as ControlCenterReport;
    expect(section(unset, "backups")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(section(unset, "backups").summary_no).toContain("JARVIS_BACKUP_STATUS_FILE");
  });

  it("restore-øvelser: feilet = advarsel, aldri kjørt = UKJENT, vellykket men over 2 × intervallet = advarsel, ellers OK; off-site mangler = advarsel", async () => {
    expect(item(await withInfra(infraReport(), { backupStatus: backupOk({ verify: "failed" }) }), "restore_drills", "restore_verify").status).toBe("WARN");
    expect(item(await withInfra(infraReport(), { backupStatus: backupOk({ verify: "never_run" }) }), "restore_drills", "restore_verify").status).toBe("UNKNOWN");
    expect(item(await withInfra(infraReport(), { backupStatus: backupOk({ verifyAgeD: 90 }) }), "restore_drills", "restore_verify").status).toBe("WARN");
    expect(item(await withInfra(infraReport(), { backupStatus: backupOk({ verifyAgeD: 3 }) }), "restore_drills", "restore_verify").status).toBe("OK");
    expect(item(await withInfra(infraReport(), { backupStatus: backupOk({ offsite: "not_configured" }) }), "backups", "offsite").status).toBe("WARN");
  });

  it("runbooks: uten en aktiv runbook for hendelseshåndtering er det en advarsel; med en er det i orden - og kun antall vises", async () => {
    const none = await withInfra(infraReport(), {}, runbookRules([{ category: "general", active: 2, inactive: 1, last_updated_at: iso(D) }]));
    expect(item(none, "runbooks", "incident_response_coverage").status).toBe("WARN");
    const some = await withInfra(infraReport(), {}, runbookRules([{ category: "incident_response", active: 1, inactive: 0, last_updated_at: iso(D) }]));
    expect(item(some, "runbooks", "incident_response_coverage").status).toBe("OK");
    expect(item(some, "runbooks", "category:incident_response").facts).toMatchObject({ active: 1, inactive: 0 });
  });

  it("planlagte jobber: forsinket og feilende jobb er advarsel, ingen kjøringer er UKJENT; oppetid-prosent og ledig diskplass er ALLTID ikke målt", async () => {
    const stale = await withInfra(infraReport(), {}, [{ match: /FROM scheduler_state/, rows: [{ job_name: "daily-brief", last_completed_at: iso(5 * D), last_open: false, last_had_error: false, last_attempts: 1 }, { job_name: "connector-health-sweep", last_completed_at: iso(H), last_open: true, last_had_error: true, last_attempts: 2 }] }]);
    expect(item(stale, "jobs", "job:daily-brief").status).toBe("WARN");
    expect(item(stale, "jobs", "job:connector-health-sweep").status).toBe("WARN");
    const empty = await withInfra(infraReport(), {}, [{ match: /FROM scheduler_state/, rows: [] }]);
    expect(section(empty, "jobs")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(item(stale, "uptime", "availability")).toMatchObject({ status: "UNKNOWN" });
    expect(item(stale, "capacity", "disk_free")).toMatchObject({ status: "UNKNOWN" });
    expect(stale.status).not.toBe("OK");
  });

  it("kapasitet: tilkoblinger fra 80 % er advarsel og fra 95 % feil; taket for samtidige jobber nådd er advarsel; manglende starttidspunkt er UKJENT", async () => {
    const conn = (n: number) => [{ match: /pg_database_size/, rows: [{ db_bytes: "1000", connections: n, max_connections: 100, started_at: iso(D) }] }] as ScriptedRule[];
    expect(item(await withInfra(infraReport(), {}, conn(50)), "capacity", "connections").status).toBe("OK");
    expect(item(await withInfra(infraReport(), {}, conn(85)), "capacity", "connections").status).toBe("WARN");
    expect(item(await withInfra(infraReport(), {}, conn(Math.ceil(CONNECTIONS_FAIL_RATIO * 100))), "capacity", "connections").status).toBe("FAIL");
    const capped = await withInfra(infraReport(), { maxActiveJobs: 3 }, [{ match: /FILTER \(WHERE status = 'created' AND \(not_before/, rows: [{ ready: 4, running: 3, queued: 4 }] }]);
    expect(item(capped, "capacity", "job_queue").status).toBe("WARN");
    const { processStartedAt: _unused, ...noStart } = { processStartedAt: () => NOW };
    void _unused; void noStart;
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createOperationsCenter({ pool: new ScriptedPool(operationsRules()).asPool(), infraStatus: async () => infraReport(), backupStatus: backupOk() }));
    expect(item((await registry.report("operations", owner)) as ControlCenterReport, "uptime", "api_process").status).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. Verdi: semantikk
// ---------------------------------------------------------------------------------------------------------------------
describe("Verdi: ti seksjoner fra ett eksisterende rapportobjekt", () => {
  const withReport = async (measurements: ValueMeasurement[] | "down", facts: ValueRuntimeFacts | null = VALUE_FACTS): Promise<ControlCenterReport> => {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    const report = measurements === "down" ? await new ExecutiveService(fakeGw()).getValueReport("t") : await valueReport(measurements, facts);
    registry.register(createValueCenter({ valueReport: async () => report }));
    return (await registry.report("value", owner)) as ControlCenterReport;
  };

  it("én seksjon per verdiløkke V1-V5 pluss bruk, jobber, spart tid og korrigeringer - og ingen handlinger", async () => {
    const r = await withReport(GOOD_VALUE);
    expect(r.sections.map((s) => s.id)).toEqual(["v1", "v2", "v3", "v4", "v5", "usage", "tasks_closed", "time_saved", "owner_corrections"]);
    expect(r.actions).toEqual([]);
    for (const s of r.sections) expect(s.source.length, s.id).toBeGreaterThan(10);
  });

  it("løkkenes tilstandsord vises som fakta (WIRED/DORMANT/NOT_BUILT) og løfter aldri status; V3 kan ikke aktiveres og V4 er ikke bygget", async () => {
    const r = await withReport(GOOD_VALUE);
    expect(item(r, "v1", "loop_state")).toMatchObject({ status: "OK", facts: { loop: "V1", state: "wired" } });
    expect(item(r, "v2", "loop_state").facts).toMatchObject({ state: "dormant" });
    expect(item(r, "v3", "loop_state").facts).toMatchObject({ state: "dormant" });
    expect(item(r, "v3", "readiness").facts).toMatchObject({ activation_decision: false });
    expect(item(r, "v4", "loop_state").facts).toMatchObject({ state: "not_built" });
    expect(item(r, "v5", "proposals").facts).toMatchObject({ executes: false, enabled: false });
    const unknown = await withReport(GOOD_VALUE, null);
    expect(item(unknown, "v1", "loop_state")).toMatchObject({ status: "UNKNOWN", facts: { state: "unknown" } });
  });

  it("advarsler: tapte løper-døgn, forfalte oppfølginger og lav fullføringsandel (kun når nok jobber er avsluttet)", async () => {
    const bad = GOOD_VALUE.map((m) => (m.id === "v1.runner_days_lost" ? win(m.id, 2, 2) : m.id === "v2.followups_overdue_now" ? snap(m.id, 3) : m.id === "tasks.completed" ? win(m.id, 2, 2) : m.id === "tasks.failed" ? win(m.id, 6, 6) : m));
    const r = await withReport(bad);
    expect(item(r, "v1", "metric:v1.runner_days_lost").status).toBe("WARN");
    expect(item(r, "v2", "metric:v2.followups_overdue_now").status).toBe("WARN");
    expect(item(r, "tasks_closed", "metric:tasks.completion_rate").status).toBe("WARN");
    const few = GOOD_VALUE.map((m) => (m.id === "tasks.completed" ? win(m.id, 1, 1) : m.id === "tasks.failed" ? win(m.id, 2, 2) : m));
    expect(item(await withReport(few), "tasks_closed", "metric:tasks.completion_rate").status).toBe("OK");
  });

  it("uten kilde: alle målinger er ikke målbare (UKJENT, aldri 0) og senteret er UKJENT", async () => {
    const r = await withReport("down");
    expect(r.status).toBe("UNKNOWN");
    expect(section(r, "usage").items.every((i) => i.status === "UNKNOWN")).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/"last_7d":0\b/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. Personvern: parser og semantikk
// ---------------------------------------------------------------------------------------------------------------------
describe("Personvern: behandlingsoversikten parses mot det EKTE dokumentet", () => {
  const doc = readFileSync(fileURLToPath(new URL("../../../docs/security/PROCESSING_INVENTORY.md", import.meta.url)), "utf8");
  const parsed = parseProcessingInventory(doc);

  it("status, datakategorier, tabeller, behandlere og DPIA-rader leses ut av det ekte dokumentet (en endret struktur gir rød test, ikke stille «ukjent»)", () => {
    expect(parsed.status).toBe("draft");
    expect(parsed.not_approved_by_owner).toBe(true);
    expect(parsed.categories).toBeGreaterThanOrEqual(10);
    expect(parsed.documented_tables.length).toBeGreaterThan(100);
    expect(parsed.documented_tables).toEqual(expect.arrayContaining(["audit_events", "memory_items", "erasure_requests", "operations_runbooks"]));
    expect(parsed.model_providers.rows).toBeGreaterThanOrEqual(8);
    expect(parsed.model_providers.unverified).toBeGreaterThan(0);
    expect(parsed.connectors.rows).toBeGreaterThan(10);
    expect(parsed.dpia.length).toBeGreaterThanOrEqual(8);
    expect(parsed.dpia.every((d) => !d.approved)).toBe(true);
    expect(parsed.dpia.flatMap((d) => d.docs).length).toBeGreaterThan(5);
    for (const d of parsed.dpia) for (const p of d.docs) expect(p).toMatch(/^docs\/[A-Za-z0-9_./-]+\.md$/);
  });

  it("parseren tåler tom og rar inndata uten å kaste (ukjent status, ingen rader) og godtar kun trygge identifikatorer og dokumentstier", () => {
    expect(parseProcessingInventory("")).toMatchObject({ status: "unknown", categories: 0, documented_tables: [], dpia: [] });
    const evil = "**Status: GODKJENT**\n- **Tabeller:** `ok_tabell`, `DROP TABLE x`, `a-b`, `../../etc/passwd`\n## 3. DPIA\n| Trigger | Eks | Krever | DPIA | Status |\n|---|---|---|---|---|\n| T1 | e | k | `docs/../hemmelig.md`, `docs/ok/fil.md`, `/etc/passwd` | GODKJENT |\n## 4. slutt";
    const p = parseProcessingInventory(evil);
    expect(p.status).toBe("approved");
    expect(p.documented_tables).toEqual(["ok_tabell"]);
    expect(p.dpia).toEqual([{ trigger: "T1", docs: ["docs/ok/fil.md"], approved: true }]);
  });
});

describe("Personvern: statusene følger det som er målt", () => {
  const makeRegistry = (rules: ScriptedRule[], opts: { env?: Env; repoRoot?: string } = {}) => {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createPrivacyCenter({ pool: new ScriptedPool(rules).asPool(), env: opts.env ?? {}, repoRoot: opts.repoRoot ?? REPO_ROOT }));
    return registry;
  };
  const report = async (rules: ScriptedRule[], opts: { env?: Env; repoRoot?: string } = {}): Promise<ControlCenterReport> => (await makeRegistry(rules, opts).report("privacy", owner)) as ControlCenterReport;
  const ALL_DOC_TABLES = parseProcessingInventory(readFileSync(fileURLToPath(new URL("../../../docs/security/PROCESSING_INVENTORY.md", import.meta.url)), "utf8")).documented_tables;

  it("oversikten er et UTKAST: advarsel (aldri OK); alle DPIA-triggere er ikke godkjent: advarsel; uverifiserte behandlere telles", async () => {
    const r = await report(privacyRules([{ match: /FROM pg_tables/, rows: ALL_DOC_TABLES.map((tablename) => ({ tablename })) }]));
    expect(item(r, "inventory", "inventory_doc")).toMatchObject({ status: "WARN", facts: { status: "draft", not_approved_by_owner: true } });
    expect(item(r, "inventory", "coverage")).toMatchObject({ status: "OK", facts: { undocumented: 0 } });
    expect(item(r, "processors", "model_providers").status).toBe("WARN");
    expect(item(r, "processors", "connectors").status).toBe("WARN");
    expect(section(r, "dpia").items.every((i) => i.status === "WARN")).toBe(true);
    expect(section(r, "dpia").summary_no).toContain("0 av ");
    expect(r.status).toBe("WARN");
  });

  it("en levende tabell uten rad i oversikten er en advarsel med navnet (runtime-ekvivalenten til CI-vakten D-420), og navnet passerer safeCategory", async () => {
    const r = await report(privacyRules([{ match: /FROM pg_tables/, rows: [...ALL_DOC_TABLES.map((tablename) => ({ tablename })), { tablename: "ny_tabell_uten_rad" }] }]));
    expect(item(r, "inventory", "coverage")).toMatchObject({ status: "WARN", facts: { undocumented: 1 } });
    expect(item(r, "inventory", "coverage").detail_no).toContain("ny_tabell_uten_rad");
  });

  it("en DPIA-fil som oversikten peker på men som ikke finnes er en advarsel; med docs/ på plass finnes alle", async () => {
    const present = await report(privacyRules());
    expect(section(present, "dpia").items.every((i) => (i.facts as { missing_documents: number }).missing_documents === 0)).toBe(true);
    const absentRoot = await report(privacyRules(), { repoRoot: REPO_ROOT.replace(/\/$/, "") + "-finnes-ikke" });
    expect(section(absentRoot, "dpia")).toMatchObject({ status: "UNKNOWN", measured: false });
  });

  it("oppbevaring: rader som henger etter er en advarsel; revisjon og kostnad har ingen automatisk sletting (alltid advarsel); messages/tasks er ikke målt; sveip uten kjøring er UKJENT", async () => {
    const r = await report(privacyRules([{ match: /FROM tool_executions/, rows: [{ tool_executions: 12, session_grants: 3 }] }, { match: /FROM scheduler_state/, rows: [] }]));
    expect(item(r, "retention", "backlog_tool_executions")).toMatchObject({ status: "WARN", facts: { overdue: 12 } });
    expect(item(r, "retention", "backlog_session_grants")).toMatchObject({ status: "WARN", facts: { overdue: 3 } });
    for (const id of ["no_auto:audit_events", "no_auto:cost_events"]) expect(item(r, "retention", id).status).toBe("WARN");
    expect(item(r, "retention", "no_auto:messages_tasks")).toMatchObject({ status: "UNKNOWN" });
    expect(item(r, "retention", "job:operational-retention-sweep").status).toBe("UNKNOWN");
    const clean = await report(privacyRules());
    expect(item(clean, "retention", "backlog_tool_executions").status).toBe("OK");
    expect(item(clean, "retention", "job:memory-retention-sweep").status).toBe("OK");
  });

  it("miljøverdien JARVIS_MEMORY_RETENTION_DAYS ekkoes aldri hvis den ikke er et lite heltall (ubetrodd tekst)", async () => {
    const evil = await report(privacyRules(), { env: { JARVIS_MEMORY_RETENTION_DAYS: "60; DROP TABLE x -- hemmelig" } });
    expect(JSON.stringify(evil)).not.toContain("DROP TABLE");
    expect(item(evil, "retention", "memory_consolidation_days").facts).toMatchObject({ configured_days: null, default_days: 60 });
    const good = await report(privacyRules(), { env: { JARVIS_MEMORY_RETENTION_DAYS: "90" } });
    expect(item(good, "retention", "memory_consolidation_days").facts).toMatchObject({ configured_days: 90 });
  });

  it("slettebevis: en mislykket sletting er FEIL, en som står fast er advarsel; sletting-inngangen (JARVIS-060) og gjenanvendelse etter restore er aldri «i orden»", async () => {
    const bad = await report(privacyRules([
      { match: /GROUP BY status, scope_type/, rows: [{ status: "failed", scope_type: "person", n: 1, last_started_at: iso(D), last_completed_at: null }, { status: "pending", scope_type: "person", n: 1, last_started_at: iso(5 * H), last_completed_at: null }] },
      { match: /FILTER \(WHERE status = 'failed'\)/, rows: [{ failed: 1, pending_stale: 1 }] }
    ]));
    expect(item(bad, "deletion_evidence", "failed").status).toBe("FAIL");
    expect(item(bad, "deletion_evidence", "pending_stale").status).toBe("WARN");
    expect(item(bad, "deletion_evidence", "restore_reapply").status).toBe("UNKNOWN");
    expect(item(bad, "deletion_evidence", "entry_point").status).toBe("WARN");
    expect(bad.status).toBe("FAIL");
    const good = await report(privacyRules());
    expect(item(good, "deletion_evidence", "completed").facts).toMatchObject({ completed: 2 });
    expect(item(good, "deletion_evidence", "fingerprints").facts).toMatchObject({ fingerprints: 5 });
    expect(item(good, "deletion_evidence", "failed").status).toBe("OK");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. Sikkerhet: semantikk og golden-suite-knappen
// ---------------------------------------------------------------------------------------------------------------------
describe("Sikkerhet: statusene følger det som er målt", () => {
  const registryFor = (rules: ScriptedRule[], deps: Partial<Parameters<typeof createSecurityCenter>[0]> = {}) => {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createSecurityCenter({ pool: new ScriptedPool(rules).asPool(), toolGateway, ownerControls: okControls, killSwitch: killOff, ...deps }));
    return registry;
  };
  const report = async (rules: ScriptedRule[] = securityRules(), deps: Partial<Parameters<typeof createSecurityCenter>[0]> = {}): Promise<ControlCenterReport> => (await registryFor(rules, deps).report("security", owner)) as ControlCenterReport;

  it("revisjon: append-only-triggeren borte eller deaktivert er FEIL; aktiv er OK; ingen revisjonsrader siste 7 døgn er UKJENT (kan ikke skilles fra at skrivingen feiler); ukjent utfall er advarsel", async () => {
    expect(item(await report(), "audit", "append_only").status).toBe("OK");
    expect(item(await report(securityRules([{ match: /FROM pg_trigger/, rows: [{ enabled: "D" }] }])), "audit", "append_only")).toMatchObject({ status: "FAIL", facts: { trigger: "disabled" } });
    expect(item(await report(securityRules([{ match: /FROM pg_trigger/, rows: [] }])), "audit", "append_only")).toMatchObject({ status: "FAIL", facts: { trigger: "missing" } });
    const quiet = await report(securityRules([{ match: /count\(\*\)\)::int AS events_7d/, rows: [{ events_7d: 0, events_24h: 0, denied_24h: 0, denied_7d: 0, failed_7d: 0, outcome_unknown_7d: 0, last_event_at: null, last_denied_at: null }] }]));
    expect(item(quiet, "audit", "activity").status).toBe("UNKNOWN");
    const unsure = await report(securityRules([{ match: /count\(\*\)\)::int AS events_7d/, rows: [{ events_7d: 50, events_24h: 5, denied_24h: 0, denied_7d: 0, failed_7d: 0, outcome_unknown_7d: 3, last_event_at: iso(H), last_denied_at: null }] }]));
    expect(item(unsure, "audit", "outcome_unknown").status).toBe("WARN");
  });

  it("avslagsårsaker vises kun som kategorier (fri tekst og hemmelighetsformede verdier blir «annet»), og avslag alene er ikke et funn", async () => {
    const FAKE = `${["sk", "ant", "api03"].join("-")}-${"FALSKNOKKELFORTEST".concat("0123456789ABCDEF")}`;
    const r = await report(securityRules([{ match: /GROUP BY reason/, rows: [{ reason: "control_center_owner_only", n: 4 }, { reason: "fri tekst med mellomrom og kontonummer 12345678901", n: 2 }, { reason: FAKE, n: 1 }] }]));
    const reasons = section(r, "audit").items.filter((i) => i.id.startsWith("reason:"));
    expect(reasons.map((i) => i.id).sort()).toEqual(["reason:annet", "reason:control_center_owner_only"]);
    expect(reasons.find((i) => i.id === "reason:annet")?.facts).toMatchObject({ count: 3 });
    expect(item(r, "audit", "denied").status).toBe("OK");
    expect(JSON.stringify(r)).not.toContain("FALSKNOKKELFORTEST");
    expect(JSON.stringify(r)).not.toContain("12345678901");
  });

  it("nektede kontrollhandlinger og avviste innlogginger er advarsler; tilbakekalte credentials og frosne connectorer teller med navn (aldri verdier)", async () => {
    const r = await report(securityRules([
      { match: /tool_id IN \('owner_controls', 'executive'\) AND action = ANY\(\$3::text\[\]\) AND NOT \(tool_id = 'owner_controls' AND action = ANY\(\$4::text\[\]\)\) GROUP BY action ORDER BY action$/, rows: [{ action: "revoke_credential", executed: 2, denied: 1, failed: 0, last_at: iso(D) }] },
      { match: /type = ANY\(\$3::text\[\]\) GROUP BY type/, rows: (p) => ((p[2] as string[]).includes("device.enrollment_denied") ? [{ type: "device.enrollment_denied", n: 2, last_at: iso(H) }] : []) }
    ]), { ownerControls: { listFrozenConnectorsDurable: async () => [{ connector_id: "github", reason: "x", actor_person_id: null, changed_at: iso(H) }], listRevokedCredentialsDurable: async () => [{ credential_ref: "ANTHROPIC_API_KEY", reason: "x", actor_person_id: null, changed_at: iso(H) }] } });
    expect(item(r, "credentials", "action:revoke_credential")).toMatchObject({ status: "WARN", facts: { executed: 2, denied: 1 } });
    expect(item(r, "credentials", "access:device.enrollment_denied").status).toBe("WARN");
    expect(item(r, "credentials", "revoked_now").detail_no).toContain("ANTHROPIC_API_KEY");
    expect(item(r, "credentials", "frozen_now").detail_no).toContain("github");
  });

  it("mistenkelig innhold: bekreftelser utløst av ubetrodd innhold telles per tilstand (ventende = advarsel); skanner-, skyskjerm- og radartellere er IKKE målt", async () => {
    const r = await report(securityRules([{ match: /FROM action_confirmations/, rows: [{ status: "pending", n: 1, last_at: iso(H) }, { status: "rejected", n: 4, last_at: iso(D) }] }]));
    expect(item(r, "suspicious", "taint:pending").status).toBe("WARN");
    expect(item(r, "suspicious", "taint:rejected").status).toBe("OK");
    for (const id of ["secret_scan", "cloud_screen", "radar_quarantine"]) expect(item(r, "suspicious", id)).toMatchObject({ status: "UNKNOWN", facts: { measured: false } });
    const none = await report();
    expect(item(none, "suspicious", "taint_none").status).toBe("OK");
    expect(section(none, "suspicious").status).toBe("UNKNOWN");
  });

  it("gjenoppretting: kill switch aktiv er FEIL; finans-nødbryter, frysing og pauser er advarsler; utførte gjenopprettinger telles", async () => {
    const r = await report(securityRules([
      { match: /FROM finance_kill_switch/, rows: [{ enabled: true, enabled_at: iso(H) }] },
      { match: /FROM situation_domain_pauses/, rows: [{ domain: "pipeline", paused_by: "p", paused_at: iso(H) }] },
      { match: /type = 'tool.executed' AND tool_id IN/, rows: [{ action: "restore_credential", n: 2, last_at: iso(D) }] }
    ]), { killSwitch: { currentStateDurable: async () => ({ reason: "x", actor_person_id: "p", changed_at: iso(H) }) } });
    expect(item(r, "recovery", "kill_switch")).toMatchObject({ status: "FAIL", facts: { active: true } });
    expect(item(r, "recovery", "finance_kill_switch").status).toBe("WARN");
    expect(item(r, "recovery", "paused_domains").status).toBe("WARN");
    expect(item(r, "recovery", "recovered:restore_credential").facts).toMatchObject({ count: 2 });
    expect(r.status).toBe("FAIL");
    expect(section(r, "recovery").summary_no).toContain("KILL SWITCH ER AKTIV");
  });

  it("golden-suite AV (ingen kjører): ingen knapp og seksjonen sier at selvtesten ikke kan kjøres herfra (UKJENT, aldri OK)", async () => {
    const r = await report();
    expect(r.actions).toEqual([]);
    expect(item(r, "golden_suite", "golden_state")).toMatchObject({ status: "UNKNOWN", facts: { enabled: false } });
    expect(section(r, "golden_suite").summary_no).toContain("JARVIS_CONTROL_GOLDEN_SUITE");
  });

  it("golden-suite PÅ: knappen peker på den eksisterende ruten med riktig klasse, step-up og kropp - speilet i kontraktens allowlist - og er ikke kjørt ennå = UKJENT", async () => {
    const r = await report(securityRules(), { goldenSuite: goldenControl(null) });
    expect(r.actions).toHaveLength(1);
    const a = r.actions[0]!;
    expect(a).toMatchObject({ id: "security.golden_suite.run", endpoint: "/executive/mutate", body: { action: "run_golden_suite", parameters: {} }, risk_class: "A", requires_step_up: true, reversible: true, section_id: "golden_suite", item_id: "golden_state" });
    expect(CONTROL_ACTION_ALLOWED["/executive/mutate"]).toContain("run_golden_suite");
    expect(item(r, "golden_suite", "golden_state")).toMatchObject({ status: "UNKNOWN", facts: { ran: false } });
  });

  it("resultatet vises med digester: bestått = OK; ikke-bestått eller hard stopp = FEIL; hoppet over = UKJENT (ikke målt); og 0 modellkall", async () => {
    const ok = await report(securityRules(), { goldenSuite: goldenControl(goldenResult()) });
    expect(item(ok, "golden_suite", "golden_state")).toMatchObject({ status: "OK", facts: { passed: 40, ran: 40, failed: 0, model_calls: 0 } });
    expect(item(ok, "golden_suite", "golden_digests").facts).toMatchObject({ suite_digest: "a".repeat(64), result_digest: "b".repeat(64), suite_id: "jarvis-golden", suite_version: 1 });
    expect(item(ok, "golden_suite", "golden_digests").detail_no).toContain("aaaaaaaaaaaa…");
    const failed = await report(securityRules(), { goldenSuite: goldenControl(goldenResult({ passed: 38, failed: ["radar-merge-deploy", "cls-saldo-finance"] })) });
    expect(item(failed, "golden_suite", "golden_state").status).toBe("FAIL");
    expect(item(failed, "golden_suite", "golden_state").detail_no).toContain("radar-merge-deploy");
    const hard = await report(securityRules(), { goldenSuite: goldenControl(goldenResult({ hard_stop: true, red_team: [{ category: "exfiltration", attempts: 6, breaches: 1 }] })) });
    expect(item(hard, "golden_suite", "golden_red_team").status).toBe("FAIL");
    const skipped = await report(securityRules(), { goldenSuite: goldenControl(goldenResult({ ran: 36, passed: 36, skipped: ["tools-github", "tools-smalltalk-none", "tools-finance-locks", "tools-memory-only"], surface_available: false })) });
    expect(item(skipped, "golden_suite", "golden_state").status).toBe("UNKNOWN");
    expect(item(skipped, "golden_suite", "golden_state").detail_no).toContain("IKKE målt");
    expect(section(ok, "golden_suite").summary_no).toContain("Ingen modellkall (0)");
  });

  it("digester (64 hex) overlever registerets redigering uendret - de er ikke hemmeligheter", async () => {
    const registry = createControlCenterRegistry({ authority, now: () => NOW });
    registry.register(createSecurityCenter({ pool: new ScriptedPool(securityRules()).asPool(), toolGateway, ownerControls: okControls, killSwitch: killOff, goldenSuite: goldenControl(goldenResult({ suite_digest: "0123456789abcdef".repeat(4), result_digest: "fedcba9876543210".repeat(4) })) }));
    const r = (await registry.report("security", owner)) as ControlCenterReport;
    expect(item(r, "golden_suite", "golden_digests").facts).toMatchObject({ suite_digest: "0123456789abcdef".repeat(4), result_digest: "fedcba9876543210".repeat(4) });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 9. Redaksjon og kategorier (felles)
// ---------------------------------------------------------------------------------------------------------------------
describe("redaksjon: en hemmelighetsformet streng fra data når aldri rapporten gjennom produksjonsregisteret", () => {
  const FAKE = `${["sk", "ant", "api03"].join("-")}-${"FALSKNOKKELFORTEST".concat("0123456789ABCDEF")}`;
  it("Drift (jobbnavn), Personvern (tabellnavn) og Sikkerhet (avslagsårsak) slipper aldri en nøkkelformet verdi igjennom", async () => {
    const reg = createControlCenterRegistry({ authority, now: () => NOW });
    reg.register(createOperationsCenter({ pool: new ScriptedPool(operationsRules([{ match: /FROM scheduler_state/, rows: JOB_ROWS([FAKE]) }])).asPool(), infraStatus: async () => infraReport() }));
    reg.register(createPrivacyCenter({ pool: new ScriptedPool(privacyRules([{ match: /FROM pg_tables/, rows: [{ tablename: FAKE.toLowerCase().replace(/-/g, "_") }] }])).asPool(), env: {}, repoRoot: REPO_ROOT }));
    reg.register(createSecurityCenter({ pool: new ScriptedPool(securityRules([{ match: /GROUP BY reason/, rows: [{ reason: FAKE, n: 1 }] }])).asPool(), toolGateway, ownerControls: okControls, killSwitch: killOff }));
    for (const id of ["operations", "privacy", "security"] as const) {
      const text = JSON.stringify(await reg.report(id, owner));
      expect(text, id).not.toContain(FAKE);
      expect(text, id).not.toContain("FALSKNOKKELFORTEST");
    }
  });
});
