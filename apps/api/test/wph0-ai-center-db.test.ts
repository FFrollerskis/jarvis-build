import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import type { ProviderOverviewRow } from "@jarvis/model-gateway";
import { KillSwitch, OwnerControls } from "@jarvis/policy";
import {
  createAiCenter, readDelegationCost, readLastRoutePerPurpose, readRoutingUsage
} from "../src/control-center/ai.ts";
import { readActiveTasks, readTaskCounts } from "../src/control-center/agents.ts";
import { RunRateService } from "../src/run-rate.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-H0 AI Center - SQL mot EKTE Postgres som EKTE app-rolle (jarvis_app, RLS gjelder). Beviser at:
 *  - lesespørringene (modellkall per leverandør/formål, siste rutevalg, jobbkost, aktive jobber, utfall siste 24 t) kjører med rollens faktiske GRANT-er og kolonner;
 *  - tenant-isolasjon: A ser kun egne kostrader og jobber, aldri B sine;
 *  - innholdsvern: jobbtittel (goal), resultat og feiltekst når aldri rapporten, selv om raden har dem;
 *  - eierens pause (ekte `OwnerControls` mot `owner_control_state`) vises, og senteret skriver ingenting.
 */
let db: H0Db;
const TENANT_A = "tenant-ai-a";
const TENANT_B = "tenant-ai-b";
const OWNER_A = "person-ai-a";
const OWNER_B = "person-ai-b";
const NOW = new Date();
const H = 3_600_000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const ahead = (ms: number): Date => new Date(NOW.getTime() + ms);
const idA: IdentityContext = { person_id: OWNER_A, tenant_id: TENANT_A, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const idB: IdentityContext = { ...idA, person_id: OWNER_B, tenant_id: TENANT_B };
const defs = productionToolDefinitions();
const GOAL_MARKER = "HEMMELIGMAALMARKOER";
const RESULT_MARKER = "RESULTATMARKOER";
const ERROR_MARKER = "FEILMARKOER";

const health = { state: "LIVE" as const, success: 3, failures: 0, consecutive_failures: 0, circuit: "closed" as const };
const overview = (): ProviderOverviewRow[] => [
  { provider: "anthropic", model: "claude-x", locality: "cloud", hosted_free_tier: false, configured: true, health },
  { provider: "gemma_local", model: "gemma3", locality: "local", hosted_free_tier: false, configured: true, health },
  { provider: "openai", model: "gpt-x", locality: "cloud", hosted_free_tier: false, configured: false, health: { ...health, state: "NOT_CONFIGURED" } }
];

async function cost(tenant: string, provider: string, purpose: string, at: Date, over: Partial<{ ore: number; success: boolean; fallback: boolean; critic: boolean; task: string | null; model: string }> = {}): Promise<void> {
  await db.adminPool.query(
    "INSERT INTO cost_events (tenant_id, kind, amount_ore, provider, model, purpose, success, fallback, critic, task_id, input_tokens, output_tokens, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,100,50,$11)",
    [tenant, `model:${provider}`, over.ore ?? 0, provider, over.model ?? `${provider}-m`, purpose, over.success ?? true, over.fallback ?? false, over.critic ?? false, over.task ?? null, at]
  );
}

async function task(id: string, tenant: string, owner: string, status: string, over: Partial<{ profile: string; delegated: boolean; created: Date; claimed: Date | null; lease: Date | null; cancel: boolean; error: string | null; attempts: number; targets: string[] }> = {}): Promise<void> {
  const contract = {
    agent_profile: over.profile ?? "executive", retry_policy: { max_attempts: 3, backoff_seconds: 0 }, input: { data: { delegated_from_chat: over.delegated ?? true }, trust_level: "internal", provenance: "chat:s" },
    allowed_network_targets: over.targets ?? []
  };
  await db.adminPool.query(
    "INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, status, contract, created_at, claimed_at, lease_expires_at, worker_id, cancel_requested, last_error, attempts, result) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)",
    [id, tenant, owner, `${GOAL_MARKER} ${id}`, status, JSON.stringify(contract), over.created ?? ago(H), over.claimed ?? null, over.lease ?? null, over.claimed ? "worker-1" : null, over.cancel ?? false, over.error ?? null, over.attempts ?? 0, JSON.stringify({ text: RESULT_MARKER })]
  );
}

beforeAll(async () => {
  db = await startH0Db("ai");
  await seedTenants(db.adminPool, [{ tenant_id: TENANT_A, person_id: OWNER_A }, { tenant_id: TENANT_B, person_id: OWNER_B }]);
  // A: lokal Gemma (CHAT, BACKGROUND), Anthropic (CHAT som fallback, BACKGROUND for jobb, ett feilet kall), kritikk, og ett kall utenfor 7-døgnsvinduet
  await cost(TENANT_A, "gemma_local", "CHAT", ago(10 * 60_000));
  await cost(TENANT_A, "gemma_local", "CHAT", ago(2 * H));
  await cost(TENANT_A, "gemma_local", "BACKGROUND", ago(3 * H), { task: "task-run" });
  await cost(TENANT_A, "anthropic", "CHAT", ago(H), { ore: 400, fallback: true });
  await cost(TENANT_A, "anthropic", "BACKGROUND", ago(4 * H), { ore: 600, task: "task-run" });
  await cost(TENANT_A, "anthropic", "CHAT", ago(5 * H), { success: false });
  await cost(TENANT_A, "anthropic", "CRITIQUE", ago(6 * H), { ore: 100, critic: true });
  await cost(TENANT_A, "anthropic", "CHAT", ago(20 * 24 * H), { ore: 9999 });
  // B: egne rader som A aldri skal se
  await cost(TENANT_B, "openai", "CHAT", ago(H), { ore: 7777 });
  // A: jobber (aktive, utfall siste 24 t, og én gammel); B: en aktiv
  await task("task-run", TENANT_A, OWNER_A, "running", { claimed: ago(20 * 60_000), lease: ahead(40_000), attempts: 1, profile: "coding", targets: ["github.com", "api.github.com"] });
  await task("task-new", TENANT_A, OWNER_A, "created", { delegated: false });
  await task("task-paused", TENANT_A, OWNER_A, "paused");
  await task("task-err", TENANT_A, OWNER_A, "running", { claimed: ago(30 * 60_000), lease: ago(5 * 60_000), error: `${ERROR_MARKER} sk-ant-api03-ABCDEFGHIJKLMNOP`, attempts: 2 });
  await task("task-done", TENANT_A, OWNER_A, "completed", { created: ago(2 * H) });
  await task("task-failed", TENANT_A, OWNER_A, "failed", { created: ago(3 * H) });
  await task("task-cancelled", TENANT_A, OWNER_A, "cancelled", { created: ago(4 * H) });
  await task("task-old", TENANT_A, OWNER_A, "completed", { created: ago(5 * 24 * H) });
  await task("task-b", TENANT_B, OWNER_B, "running", { claimed: ago(60_000), lease: ahead(60_000) });
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

function center() {
  const killSwitch = new KillSwitch(db.appPool);
  return createAiCenter({
    pool: db.appPool,
    env: { JARVIS_GITHUB_REPO: "x/y" },
    gateway: { providerOverview: overview, meshStatus: () => ({ router: "HEALTHY", fallback: "READY" }), routingAdvisorMode: "shadow" },
    ownerControls: new OwnerControls(killSwitch, db.appPool),
    toolGateway: { get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a) },
    runRate: new RunRateService(db.appPool),
    councilLimiter: { usage: () => ({ max_per_window: 3, window_ms: 3_600_000, used_in_window: 1, acquired_total: 2, denied_total: 0 }) }
  });
}
async function report(identity: IdentityContext): Promise<ControlCenterReport> {
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center());
  return (await registry.report("ai", identity)) as ControlCenterReport;
}
const item = (r: ControlCenterReport, section: string, id: string) => r.sections.find((s) => s.id === section)!.items.find((i) => i.id === id)!;
const sec = (r: ControlCenterReport, id: string) => r.sections.find((s) => s.id === id)!;

describe("lesespørringene som app-rolle (ekte SQL, ekte GRANT-er, RLS)", () => {
  it("modellkall siste 7 døgn per leverandør og formål: vellykkede, feilede, fallback, kritikk og kost - kun A, og ikke raden utenfor vinduet", async () => {
    const rows = await readRoutingUsage(db.appPool, TENANT_A, NOW.getTime());
    const by = new Map(rows.map((r) => [`${r.provider}/${r.purpose}`, r]));
    expect(by.get("gemma_local/CHAT")).toMatchObject({ ok_calls: 2, failed_calls: 0, ore: 0 });
    expect(by.get("anthropic/CHAT")).toMatchObject({ ok_calls: 1, failed_calls: 1, fallback_calls: 1, ore: 400 });
    expect(by.get("anthropic/CRITIQUE")).toMatchObject({ ok_calls: 0, critic_calls: 1, ore: 100 });
    expect(rows.reduce((a, r) => a + r.ore, 0)).toBe(400 + 600 + 100); // 9999 utenfor vinduet er ikke med
    expect(rows.some((r) => r.provider === "openai")).toBe(false);
    const b = await readRoutingUsage(db.appPool, TENANT_B, NOW.getTime());
    expect(b.map((r) => r.provider)).toEqual(["openai"]);
  });

  it("siste vellykkede, ikke-kritikk kall per formål (siste rutevalg), kun A", async () => {
    const rows = await readLastRoutePerPurpose(db.appPool, TENANT_A, NOW.getTime());
    const by = new Map(rows.map((r) => [r.purpose, r]));
    expect(by.get("CHAT")).toMatchObject({ provider: "gemma_local", fallback: false }); // 10 min siden er nyere enn Anthropic-fallbacken for 1 t siden
    expect(by.get("BACKGROUND")).toMatchObject({ provider: "gemma_local" });
    expect(by.has("CRITIQUE")).toBe(false);
    expect((await readLastRoutePerPurpose(db.appPool, TENANT_B, NOW.getTime())).map((r) => r.provider)).toEqual(["openai"]);
  });

  it("kost bokført på jobber (task_id satt) mot all kost siste 7 døgn", async () => {
    expect(await readDelegationCost(db.appPool, TENANT_A, NOW.getTime())).toEqual({ all_calls: 7, all_ore: 1100, task_calls: 2, task_ore: 600, task_failed: 0 });
  });

  it("aktive jobber: kjørende først, kategorier (profil, delegert, nettverksmål som ANTALL), lease og feil som «finnes»; ferdige og andres jobber er ikke med", async () => {
    const rows = await readActiveTasks(db.appPool, TENANT_A);
    expect(rows.map((r) => r.task_id)).toEqual(["task-err", "task-run", "task-new", "task-paused"].sort((a, b) => rows.findIndex((r) => r.task_id === a) - rows.findIndex((r) => r.task_id === b)));
    const by = new Map(rows.map((r) => [r.task_id, r]));
    expect(by.get("task-run")).toMatchObject({ status: "running", agent_profile: "coding", delegated: true, attempts: 1, max_attempts: 3, network_targets: 2, cancel_requested: false, worker_id: "worker-1" });
    expect(by.get("task-new")).toMatchObject({ status: "created", delegated: false });
    expect(by.get("task-err")).toMatchObject({ has_error: true, attempts: 2 });
    expect(rows.some((r) => ["task-done", "task-b"].includes(r.task_id))).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(GOAL_MARKER);
    expect(JSON.stringify(rows)).not.toContain(RESULT_MARKER);
    expect(JSON.stringify(rows)).not.toContain(ERROR_MARKER);
    expect((await readActiveTasks(db.appPool, TENANT_B)).map((r) => r.task_id)).toEqual(["task-b"]);
  });

  it("utfallstelling: aktive per status + ferdige/feilede/avbrutte siste 24 t (den gamle jobben telles ikke)", async () => {
    expect(await readTaskCounts(db.appPool, TENANT_A, NOW.getTime())).toEqual({ created: 1, running: 2, paused: 1, completed_24h: 1, failed_24h: 1, cancelled_24h: 1 });
    expect(await readTaskCounts(db.appPool, TENANT_B, NOW.getTime())).toMatchObject({ running: 1, completed_24h: 0 });
  });
});

describe("hele senteret mot ekte data", () => {
  it("A: tall fra kun A; ekte run-rate og budsjettvakt; ingen tittel, resultat, feiltekst eller nøkkelform i rapporten", async () => {
    const r = await report(idA);
    expect(r.sections.filter((s) => !s.measured)).toEqual([]);
    expect(item(r, "providers", "anthropic").facts).toMatchObject({ calls_ok_7d: 2, calls_failed_7d: 1, cost_7d_ore: 1100 });
    // vellykkede, ikke-kritikk kall: 3 lokale (gemma_local) + 2 sky (anthropic) - det feilede kallet, kritikken og raden utenfor vinduet telles ikke
    expect(item(r, "routing", "gemma_first").facts).toMatchObject({ ok_calls_7d: 5 });
    expect(Number(item(r, "routing", "gemma_first").facts?.["local_share_7d"])).toBeCloseTo(3 / 5, 5);
    expect(item(r, "cost", "budget")).toMatchObject({ status: "OK" });
    // «i dag» = siden databasens midnatt (run-rate.ts: `at >= date_trunc('day', now())`). Seed-radene er relative til NOW (1/4/6 t siden), så testen kan ikke anta at alle er «i dag»:
    // en kjøring mellom 00:00 og 06:00 (UTC) har rader fra i går. Forventet verdi utledes derfor fra samme døgngrense.
    const dayRows = await db.adminPool.query<{ d: Date }>("SELECT date_trunc('day', now()) AS d");
    const dayStart = (dayRows.rows[0] as { d: Date }).d.getTime();
    const expectedToday = ([[H, 400], [4 * H, 600], [6 * H, 100]] as const).filter(([age]) => NOW.getTime() - age >= dayStart).reduce((sum, [, ore]) => sum + ore, 0);
    expect(item(r, "cost", "run_rate").facts).toMatchObject({ today_ore: expectedToday });
    expect(item(r, "delegation", "task_cost").facts).toMatchObject({ task_calls_7d: 2, all_calls_7d: 7 });
    expect(item(r, "delegation", "background_jobs").facts).toMatchObject({ active_delegated: 2 }); // task-run + task-err (delegated, ikke pauset)
    expect(item(r, "agents", "task-run").facts).toMatchObject({ agent_profile: "coding", network_targets: 2 });
    expect(item(r, "agents", "task-err").status).toBe("WARN"); // lease utløpt
    expect(r.actions.filter((a) => a.id.startsWith("agent.cancel:")).map((a) => a.id).sort()).toEqual(["agent.cancel:task-err", "agent.cancel:task-new", "agent.cancel:task-run"]);
    const json = JSON.stringify(r);
    for (const forbidden of [GOAL_MARKER, RESULT_MARKER, ERROR_MARKER, "sk-ant", "agent.cancel:task-b", "7777", "9999"]) expect(json, forbidden).not.toContain(forbidden);
    expect(sec(r, "agents").items.map((i) => i.id)).not.toContain("task-b");
  });

  it("B ser kun sine egne tall og jobber", async () => {
    const r = await report(idB);
    expect(sec(r, "agents").items.map((i) => i.id)).toEqual(["task-b"]);
    expect(item(r, "providers", "anthropic").facts).toMatchObject({ calls_ok_7d: 0, cost_7d_ore: 0 });
    const json = JSON.stringify(r);
    for (const forbidden of ["task-run", "task-err", "task-new", GOAL_MARKER]) expect(json, forbidden).not.toContain(forbidden);
  });

  it("eierens pause (ekte OwnerControls mot owner_control_state) vises live, og «Gjenoppta» tilbys i stedet for «Pause»", async () => {
    const oc = new OwnerControls(new KillSwitch(db.appPool, { owner_person_id: OWNER_A }), db.appPool, { owner_person_id: OWNER_A });
    await oc.freezeConnectorDurable("model:anthropic", "kostnadskontroll", OWNER_A);
    try {
      const r = await report(idA);
      expect(item(r, "providers", "anthropic")).toMatchObject({ status: "WARN", facts: { paused: true, paused_by_freeze: true } });
      expect(r.actions.map((a) => a.id)).toContain("ai.resume:anthropic");
      expect(r.actions.map((a) => a.id)).not.toContain("ai.pause:anthropic");
      expect(item(r, "routing", "tool_turn_route").detail_no).toContain("pauset av deg");
      expect(JSON.stringify(r)).not.toContain("kostnadskontroll");
    } finally {
      await oc.unfreezeConnectorDurable("model:anthropic", OWNER_A);
    }
    await expect(report(idA).then((r) => r.actions.map((a) => a.id))).resolves.toContain("ai.pause:anthropic");
  });

  it("senteret skriver ingenting: radtallet i alle berørte tabeller er uendret etter bygging", async () => {
    const count = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const t of ["cost_events", "tasks", "audit_events", "owner_control_state", "tool_executions", "artifacts"]) {
        out[t] = Number(((await db.adminPool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0] as { n: number }).n);
      }
      return out;
    };
    const before = await count();
    await report(idA);
    await report(idB);
    expect(await count()).toEqual(before);
  });

  it("en bruker uten tenant-kontekst ser ingenting: RLS gjelder for app-rollen selv uten tenant-filteret", async () => {
    const client: pg.PoolClient = await db.appPool.connect();
    try {
      for (const t of ["tasks", "cost_events"]) {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
        expect((rows[0] as { n: number }).n, t).toBe(0);
      }
    } finally {
      client.release();
    }
  });
});
