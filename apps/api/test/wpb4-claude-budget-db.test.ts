import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import {
  ClaudeBudgetBlockedError, ClaudeBudgetEnforcer, MemoryTraceSink, ModelGateway, budgetWindow, claudeBudgetConfigFromEnv, readClaudeBudgetState, type ClaudeBudgetConfig, type CompleteInput
} from "@jarvis/model-gateway";
import type { ModelProviderAdapter, ModelRequest, ModelResult } from "@jarvis/provider-adapters";
import { MemoryAlertSink } from "@jarvis/watchdog";
import { createAiCenter } from "../src/control-center/ai.ts";
import { ClaudeBudgetAlerter, claudeBudgetBriefSource, readClaudeDecisionCounts, readClaudeUsage } from "../src/claude-budget-surfaces.ts";
import { seedTenants, startH0Db, type H0Db } from "./support/h0-db.ts";

/**
 * WP-B4 (D-476): Claude-kreditten mot EKTE Postgres som EKTE app-rolle (`jarvis_app`, RLS gjelder - slik drift kjører). Beviser det fakene ikke kan:
 *  - SQL-en (forbruk i perioden, forbruk per formål, beslutninger, markører) kjører med rollens faktiske GRANT-er og kolonner;
 *  - periodens grenser: starten er INKLUSIV og slutten EKSKLUSIV (en rad på nøyaktig fornyelsestidspunktet hører til neste periode), kun Anthropic-rader, kun egen tenant;
 *  - hele sløyfen: gatewayen bokfører et Anthropic-kall i `cost_events`, og NESTE beslutning ser det (håndhevelsen og flatene leser samme tall);
 *  - nivåene gir riktig utfall mot en ekte database (på tempo, forbeholdt reserve, oppbrukt), og beslutningene revideres under tenant-RLS;
 *  - varsel-markørene overlever «omstart», og en annen tenant ser aldri eierens rader.
 */
let db: H0Db;
const A = "tenant-b4-a";
const B = "tenant-b4-b";
const OWNER_A = "person-b4-a";
const OWNER_B = "person-b4-b";
// egen tenant for forbruk per tier, styrte kall, brief og kontrollsenter (uavhengig av grenseradene i A)
const U = "tenant-b4-use";
const OWNER_U = "person-b4-use";
// tenanter for gateway-nivåene: ett nivå per tenant (forbruket er deterministisk uansett hvor i perioden klokka står)
const TENANT_PACE = "tenant-b4-pace";
const TENANT_RESERVE = "tenant-b4-reserve";
const TENANT_EXHAUSTED = "tenant-b4-exhausted";
const PERSON_PACE = "person-b4-pace";
const PERSON_RESERVE = "person-b4-reserve";
const PERSON_EXHAUSTED = "person-b4-exhausted";

const DAY = 86_400_000;
/** Fornyelsen 15. des 2026 00:00 Europe/Oslo (CET) = 14. des 23:00 UTC; NOW er ett sekund FØR den. */
const END = Date.UTC(2026, 11, 14, 23, 0, 0);
const NOW = END - 1000;
const WINDOW = budgetWindow(NOW, 15);
const config: ClaudeBudgetConfig = (() => {
  const c = claudeBudgetConfigFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100" });
  if (c === null) throw new Error("test-oppsett");
  return c;
})();
const idA: IdentityContext = { person_id: OWNER_A, tenant_id: A, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const idB: IdentityContext = { ...idA, person_id: OWNER_B, tenant_id: B };
const idU: IdentityContext = { ...idA, person_id: OWNER_U, tenant_id: U };

async function cost(tenant: string, provider: string, at: number, ore: number, over: Partial<{ purpose: string | null; success: boolean; critic: boolean; task: string | null; session: string | null }> = {}): Promise<void> {
  await db.adminPool.query(
    "INSERT INTO cost_events (tenant_id, kind, amount_ore, provider, model, purpose, success, critic, task_id, session_id, input_tokens, output_tokens, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,100,50,$11)",
    [tenant, `model:${provider}`, ore, provider, `${provider}-m`, over.purpose === undefined ? "CHAT" : over.purpose, over.success ?? true, over.critic ?? false, over.task ?? null, over.session ?? null, new Date(at)]
  );
}

async function auditRow(tenant: string, person: string, type: string, at: number, over: { decision?: string; reason?: string; payload?: Record<string, unknown> } = {}): Promise<void> {
  await db.adminPool.query("INSERT INTO audit_events (tenant_id, person_id, type, decision, reason, payload, at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)", [
    tenant, person, type, over.decision ?? null, over.reason ?? null, JSON.stringify(over.payload ?? {}), new Date(at)
  ]);
}

async function auditAs(tenant: string, type: string): Promise<Array<{ decision: string | null; reason: string | null; payload: Record<string, unknown>; person_id: string; task_id: string | null }>> {
  return withTenantTransaction(db.appPool, tenant, async (client) => (await client.query("SELECT decision, reason, payload, person_id, task_id FROM audit_events WHERE type = $1 ORDER BY audit_id", [type])).rows as never);
}

beforeAll(async () => {
  db = await startH0Db("b4");
  await seedTenants(db.adminPool, [
    { tenant_id: A, person_id: OWNER_A }, { tenant_id: B, person_id: OWNER_B }, { tenant_id: U, person_id: OWNER_U },
    { tenant_id: TENANT_PACE, person_id: PERSON_PACE }, { tenant_id: TENANT_RESERVE, person_id: PERSON_RESERVE }, { tenant_id: TENANT_EXHAUSTED, person_id: PERSON_EXHAUSTED }
  ]);
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

describe("forbruket i kredittperioden (ekte SQL, ekte GRANT-er, RLS)", () => {
  beforeAll(async () => {
    // A: grensene rundt perioden (15. nov 00:00 → 15. des 00:00 Oslo)
    await cost(A, "anthropic", WINDOW.start_ms - 1, 5000); // 1 ms FØR starten: forrige periode
    await cost(A, "anthropic", WINDOW.start_ms, 1000); // nøyaktig starten: INKLUDERT
    await cost(A, "anthropic", WINDOW.start_ms + 10 * DAY, 2000);
    await cost(A, "anthropic", WINDOW.end_ms - 1, 3000); // 1 ms før slutten: INKLUDERT
    await cost(A, "anthropic", WINDOW.end_ms, 7000); // nøyaktig fornyelsen: neste periode
    await cost(A, "openai", WINDOW.start_ms + DAY, 9999); // annen leverandør: teller ikke
    await cost(A, "gemma_local", WINDOW.start_ms + DAY, 0);
    await cost(A, "anthropic", WINDOW.start_ms + 2 * DAY, 0, { success: false }); // mislykket forsøk (0 øre)
    await cost(A, "anthropic", WINDOW.start_ms + 3 * DAY, 400, { critic: true, purpose: "CRITIQUE" }); // kritikkkall koster ekte penger og teller
    // B: eget forbruk som A aldri skal se
    await cost(B, "anthropic", WINDOW.start_ms + DAY, 4242);
  });

  it("starten er inklusiv og slutten eksklusiv; kun Anthropic; kritikkkall teller, mislykkede forsøk er 0 øre", async () => {
    const status = await readClaudeBudgetState(db.appPool, A, config, NOW);
    expect(status.window.start_ms).toBe(WINDOW.start_ms);
    expect(status.window.end_ms).toBe(WINDOW.end_ms);
    expect(status.spend.window_ore).toBe(1000 + 2000 + 3000 + 400);
    expect(status.state.spent_ore).toBe(6400);
    expect(status.state.level).toBe("on_pace"); // 6 % av kreditten helt på slutten av perioden
  });

  it("på fornyelsestidspunktet er raden som lå på grensen den FØRSTE i den nye perioden (15. des → 15. jan), og forrige periodes rader er borte", async () => {
    const status = await readClaudeBudgetState(db.appPool, A, config, END);
    expect(status.window.start_ms).toBe(END);
    expect(status.window.start_date).toBe("2026-12-15");
    expect(status.window.end_date).toBe("2027-01-15");
    expect(status.spend.window_ore).toBe(7000);
  });

  it("tenant-isolasjon: B ser kun sine egne 4 242 øre, aldri A sine", async () => {
    expect((await readClaudeBudgetState(db.appPool, B, config, NOW)).spend.window_ore).toBe(4242);
    expect((await readClaudeBudgetState(db.appPool, "tenant-uten-rader", config, NOW)).spend.window_ore).toBe(0);
  });

  it("siste 7 døgn (prognosegrunnlaget): kun rader de siste 7 døgnene, og vinduet starter aldri før periodens start", async () => {
    const late = await readClaudeBudgetState(db.appPool, A, config, NOW);
    expect(late.spend.trailing_days).toBeCloseTo(7, 5);
    expect(late.spend.trailing_ore).toBe(3000); // kun raden 1 ms før slutten ligger innenfor de siste 7 døgnene
    const early = await readClaudeBudgetState(db.appPool, A, config, WINDOW.start_ms + 2 * DAY);
    expect(early.spend.trailing_days).toBeCloseTo(2, 5); // aldri 7: tidligere enn starten finnes ikke i denne perioden
  });
});

describe("forbruk per tier, styrte kall, brief og kontrollsenter (ekte SQL)", () => {
  beforeAll(async () => {
    const T = NOW;
    // forbruk siste 30 døgn (U): chat med økt (ESSENSIELL), chat med jobb-id (BAKGRUNN), minneuttrekk med jobb-id (BAKGRUNN), og rader som ikke skal telle
    await cost(U, "anthropic", T - 1 * DAY, 300, { purpose: "CHAT", session: "s-1" });
    await cost(U, "anthropic", T - 2 * DAY, 120, { purpose: "CHAT", session: "s-1", task: "job-1" });
    await cost(U, "anthropic", T - 20 * DAY, 80, { purpose: "EXTRACT", task: "job-2" });
    await cost(U, "anthropic", T - 40 * DAY, 9000, { purpose: "CHAT", session: "s-1" }); // eldre enn 30 døgn og før perioden
    await cost(U, "openai", T - 1 * DAY, 777, { purpose: "CHAT", session: "s-1" }); // annen leverandør
    await cost(B, "anthropic", T - 1 * DAY, 555, { purpose: "CHAT", session: "s-b" });
    // beslutninger: i perioden og siste 7 døgn (U), en tillat-rad som aldri skal telle, utenfor perioden, og B sine
    await auditRow(U, OWNER_U, "claude_budget.decision", T - 1 * DAY, { decision: "downgrade", reason: "ahead_background_downgrade", payload: { tier: "background" } });
    await auditRow(U, OWNER_U, "claude_budget.decision", T - 2 * DAY, { decision: "defer", reason: "tight_background_deferred", payload: { tier: "background" } });
    await auditRow(U, OWNER_U, "claude_budget.decision", T - 12 * DAY, { decision: "defer", reason: "reserve_kept_for_essential", payload: { tier: "important" } });
    await auditRow(U, OWNER_U, "claude_budget.decision", T - 15 * DAY, { decision: "deny", reason: "exhausted_closed", payload: { tier: "essential" } });
    await auditRow(U, OWNER_U, "claude_budget.decision", T - 3 * DAY, { decision: "allow", reason: "tight_essential_allowed", payload: { tier: "essential" } });
    await auditRow(U, OWNER_U, "claude_budget.decision", WINDOW.start_ms - 3 * DAY, { decision: "deny", reason: "exhausted_closed", payload: { tier: "essential" } }); // forrige periode
    await auditRow(B, OWNER_B, "claude_budget.decision", T - 1 * DAY, { decision: "deny", reason: "exhausted_closed", payload: { tier: "essential" } });
  });

  it("forbruk per formål og tier siste 7/30 døgn: tier utledes av økt/jobb-id, kun Anthropic og kun egen tenant", async () => {
    const rows = await readClaudeUsage(db.appPool, U, config, NOW);
    const by = new Map(rows.map((r) => [`${r.purpose}/${r.tier}`, r]));
    expect(by.get("CHAT/essential")).toMatchObject({ ore_7d: 300, ore_30d: 300, calls_7d: 1, calls_30d: 1 });
    expect(by.get("CHAT/background")).toMatchObject({ ore_7d: 120, ore_30d: 120 }); // jobb-id vinner over økt-id
    expect(by.get("EXTRACT/background")).toMatchObject({ ore_7d: 0, ore_30d: 80 });
    expect(rows.reduce((a, r) => a + r.ore_30d, 0)).toBe(300 + 120 + 80); // ikke raden eldre enn 30 døgn, ikke openai, ikke B
    expect(rows.some((r) => r.ore_30d === 555)).toBe(false);
  });

  it("styrte kall: kun downgrade/defer/deny, per beslutning og tier, i perioden og siste 7 døgn; en annen tenants rader og forrige periode teller ikke", async () => {
    const counts = await readClaudeDecisionCounts(db.appPool, U, WINDOW.start_ms, WINDOW.end_ms, NOW);
    expect(counts.by_decision.downgrade).toEqual({ period: 1, d7: 1 });
    expect(counts.by_decision.defer).toEqual({ period: 2, d7: 1 });
    expect(counts.by_decision.deny).toEqual({ period: 1, d7: 0 });
    expect(counts.by_tier).toEqual({ essential: { period: 1, d7: 0 }, important: { period: 1, d7: 0 }, background: { period: 2, d7: 2 } });
    const b = await readClaudeDecisionCounts(db.appPool, B, WINDOW.start_ms, WINDOW.end_ms, NOW);
    expect(b.by_decision.deny).toEqual({ period: 1, d7: 1 });
    expect(b.by_decision.downgrade).toEqual({ period: 0, d7: 0 });
  });

  it("rett etter fornyelsen teller «siste 7 døgn» også forrige periodes siste dager, men «i perioden» kun den nye", async () => {
    const after = budgetWindow(END + 3_600_000, 15);
    const counts = await readClaudeDecisionCounts(db.appPool, U, after.start_ms, after.end_ms, END + 3_600_000);
    expect(counts.by_decision.downgrade.period).toBe(0);
    expect(counts.by_decision.downgrade.d7).toBe(1);
    expect(counts.by_decision.defer.d7).toBe(1);
  });

  it("daglig brief: én linje fra ekte forbruk under riktig tenant", async () => {
    const source = claudeBudgetBriefSource({ pool: db.appPool, config, now: () => NOW });
    const [item] = await source.collect(idU);
    expect(item).toMatchObject({ source: "claude-budget", ref: "2026-12-14" });
    expect(item?.title).toContain("Claude-kreditten:");
    expect((await source.collect(idB))[0]?.title).not.toBe(item?.title); // B har et annet forbruk
  });

  it("kontrollsenteret (AI/Kost) bygger de tre elementene fra ekte SQL som app-rolle - og ikke for en skymodell", async () => {
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => new Date(NOW) });
    registry.register(createAiCenter({
      pool: db.appPool, env: {}, claudeBudget: config,
      gateway: { providerOverview: () => [], meshStatus: () => ({ router: "HEALTHY", fallback: "READY" }), routingAdvisorMode: "off" },
      ownerControls: { listFrozenConnectorsDurable: async () => [], listRevokedCredentialsDurable: async () => [] },
      toolGateway: { get: () => undefined }
    }));
    const full = (await registry.report("ai", idU)) as ControlCenterReport;
    const costSection = full.sections.find((s) => s.id === "cost");
    const credit = costSection?.items.find((i) => i.id === "claude_budget");
    expect(credit?.status).toBe("OK");
    expect(credit?.facts).toMatchObject({ spent_ore: 300 + 120 + 80, period_start: "2026-11-15", period_end: "2026-12-15", reset_day: 15 });
    expect(costSection?.items.find((i) => i.id === "claude_budget_use")?.status).toBe("OK");
    expect(costSection?.items.find((i) => i.id === "claude_budget_use")?.facts).toMatchObject({ ore_30d: 500, tier_essential_ore_30d: 300, tier_background_ore_30d: 200 });
    expect(costSection?.items.find((i) => i.id === "claude_budget_decisions")?.facts).toMatchObject({ downgraded_period: 1, deferred_period: 2, denied_period: 1 });
    // B ser aldri U sine tall
    const other = (await registry.report("ai", idB)) as ControlCenterReport;
    expect(other.sections.find((s) => s.id === "cost")?.items.find((i) => i.id === "claude_budget")?.facts).toMatchObject({ spent_ore: 4242 + 555 });
    // skymodell: ingenting
    const restricted = (await registry.report("ai", idU, { restrictFinance: true })) as ControlCenterReport;
    expect(JSON.stringify(restricted)).not.toContain("claude_budget");
  });
});

describe("varsler mot ekte database: markører i audit_events overlever «omstart»", () => {
  it("terskler passert → ÉN melding, markørene skrives under eierens person, og en NY alerter-instans (omstart) varsler ikke igjen; en annen tenant er upåvirket", async () => {
    const T = "tenant-b4-alert";
    const P = "person-b4-alert";
    await seedTenants(db.adminPool, [{ tenant_id: T, person_id: P }]);
    await cost(T, "anthropic", WINDOW.start_ms + 5 * DAY, 80_000); // 76 % av 105 000, i perioden
    const sink = new MemoryAlertSink();
    const make = () => new ClaudeBudgetAlerter({ pool: db.appPool, config, tenantId: T, ownerPersonId: P, sink, now: () => NOW });

    const first = await make().tick();
    expect(first.sent).toEqual(["pct:50", "pct:75"]);
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]?.severity).toBe("warning");

    const markers = await auditAs(T, "claude_budget.alert");
    expect(markers.map((m) => m.payload["key"])).toEqual(["pct:50", "pct:75"]);
    expect(markers.every((m) => m.person_id === P && m.decision === "sent")).toBe(true);
    expect(markers[0]?.payload).toMatchObject({ window_start: "2026-11-15", window_end: "2026-12-15", level: "on_pace" });

    expect((await make().tick()).sent).toEqual([]); // «omstart»
    expect((await make().tick()).sent).toEqual([]);
    expect(sink.alerts).toHaveLength(1);

    // ingen markører lekker til andre tenanter
    expect(await auditAs(A, "claude_budget.alert")).toHaveLength(0);

    // ny periode: samme tenant, forbruket er 0 i den nye perioden → ingenting; markørene fra forrige periode blokkerer ikke senere varsler
    const renewed = new ClaudeBudgetAlerter({ pool: db.appPool, config, tenantId: T, ownerPersonId: P, sink, now: () => END + 3_600_000 });
    expect((await renewed.tick()).sent).toEqual([]);
    await cost(T, "anthropic", END + 5 * DAY, 60_000);
    const later = new ClaudeBudgetAlerter({ pool: db.appPool, config, tenantId: T, ownerPersonId: P, sink, now: () => END + 6 * DAY });
    expect((await later.tick()).sent).toContain("pct:50");
    expect((await auditAs(T, "claude_budget.alert")).filter((m) => m.payload["window_start"] === "2026-12-15").map((m) => m.payload["key"])).toContain("pct:50");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Hele sløyfen: ModelGateway + enforcer + ekte database
// ---------------------------------------------------------------------------------------------------------------------

type Spy = ModelProviderAdapter & { calls: ModelRequest[] };
function spyAdapter(name: string, model: string): Spy {
  const calls: ModelRequest[] = [];
  return {
    name, model, calls, available: () => true,
    complete: async (request: ModelRequest): Promise<ModelResult> => {
      calls.push(request);
      return { text: `svar fra ${name}`, usage: { input_tokens: 1000, output_tokens: 500 }, provider: name, model: request.model ?? model, finish_reason: "stop" };
    }
  };
}

const REQ: ModelRequest = { messages: [{ role: "user", content: "hei" }], max_tokens: 200 };
const ownerTurn = (tenant: string, extra: Partial<CompleteInput> = {}): CompleteInput => ({ tenant_id: tenant, session_id: "s1", purpose: "CHAT", mode: "QUALITY", request: REQ, ...extra });
const backgroundJob = (tenant: string, extra: Partial<CompleteInput> = {}): CompleteInput => ({ tenant_id: tenant, task_id: "job-1", purpose: "EXTRACT", mode: "QUALITY", request: REQ, ...extra });

function gatewayFor(person: string, providers: ModelProviderAdapter[]): { gateway: ModelGateway; trace: MemoryTraceSink } {
  const trace = new MemoryTraceSink();
  const enforcer = new ClaudeBudgetEnforcer({ config, pool: db.appPool, trace, actor_person_id: person });
  return { gateway: new ModelGateway({ pool: db.appPool, trace, providers, claudeBudget: enforcer }), trace };
}

/** Forbruk i inneværende periode (ekte klokke), plassert like før nå så raden alltid ligger i perioden. */
async function seedSpend(tenant: string, ore: number): Promise<void> {
  const now = Date.now();
  const window = budgetWindow(now, 15);
  await cost(tenant, "anthropic", Math.max(window.start_ms, now - 1000), ore, { purpose: "CHAT", session: "seed" });
}

describe("hele sløyfen: gateway + enforcer + ekte database (ekte klokke; nivåene er deterministiske uansett hvor i perioden vi står)", () => {
  beforeAll(async () => {
    await seedSpend(TENANT_RESERVE, 95_000); // ≥ tempobudsjettet (89 250) og under kreditten (105 000): forbeholdt reserve
    await seedSpend(TENANT_EXHAUSTED, 105_000); // = kreditten
  });

  it("PÅ TEMPO: et bakgrunnskall går til Anthropic, bokføres i cost_events, og NESTE lesing av forbruket ser det (håndhevelsen og flatene leser samme tall) - og ingen revisjonsrad for en vanlig tillatelse", async () => {
    const anthropic = spyAdapter("anthropic", "claude-sonnet-5-5");
    const local = spyAdapter("gemma_local", "gemma-local");
    const { gateway } = gatewayFor(PERSON_PACE, [anthropic, local]);
    const before = await readClaudeBudgetState(db.appPool, TENANT_PACE, config, Date.now());
    expect(before.state.spent_ore).toBe(0);
    const result = await gateway.complete(backgroundJob(TENANT_PACE));
    expect(result.provider).toBe("anthropic");
    expect(anthropic.calls).toHaveLength(1);
    const after = await readClaudeBudgetState(db.appPool, TENANT_PACE, config, Date.now());
    expect(after.state.spent_ore).toBeGreaterThan(0);
    const booked = await db.adminPool.query("SELECT sum(amount_ore)::int AS ore FROM cost_events WHERE tenant_id = $1 AND provider = 'anthropic'", [TENANT_PACE]);
    expect(after.state.spent_ore).toBe((booked.rows[0] as { ore: number }).ore);
    expect(await auditAs(TENANT_PACE, "claude_budget.decision")).toHaveLength(0);
  });

  it("FORBEHOLDT RESERVE: bakgrunn og bestilte jobber går lokalt (revidert som defer med årsak), egne turer (ESSENSIELL) går fortsatt til Anthropic", async () => {
    const anthropic = spyAdapter("anthropic", "claude-sonnet-5-5");
    const local = spyAdapter("gemma_local", "gemma-local");
    const { gateway, trace } = gatewayFor(PERSON_RESERVE, [anthropic, local]);

    const background = await gateway.complete(backgroundJob(TENANT_RESERVE));
    expect(background.provider).toBe("gemma_local");
    const ordered = await gateway.complete(backgroundJob(TENANT_RESERVE, { task_id: "job-2", purpose: "BACKGROUND", budget_origin: "owner_task" }));
    expect(ordered.provider).toBe("gemma_local");
    expect(anthropic.calls).toHaveLength(0);

    const turn = await gateway.complete(ownerTurn(TENANT_RESERVE));
    expect(turn.provider).toBe("anthropic");
    expect(anthropic.calls).toHaveLength(1);

    const rows = await auditAs(TENANT_RESERVE, "claude_budget.decision");
    expect(rows.map((r) => `${r.decision}:${r.reason}`)).toEqual(["defer:tight_background_deferred", "defer:reserve_kept_for_essential"]);
    expect(rows.every((r) => r.person_id === PERSON_RESERVE)).toBe(true);
    expect(rows.map((r) => r.task_id)).toEqual(["job-1", "job-2"]);
    // sporet har én «budget»-span per vurdert beslutning (også den tillatte turen)
    expect(trace.spans.filter((s) => s.kind === "budget")).toHaveLength(3);
    // revisjonen bærer aldri innhold
    expect(JSON.stringify(rows)).not.toContain("hei");
    // andre tenanter ser ingenting av dette
    expect(await auditAs(TENANT_PACE, "claude_budget.decision")).toHaveLength(0);
  });

  it("OPPBRUKT med hard stopp: alt går lokalt; finnes ingen lokal modell gis den tydelige norske feilen (kind exhausted) - ingen stille omruting", async () => {
    const anthropic = spyAdapter("anthropic", "claude-sonnet-5-5");
    const local = spyAdapter("gemma_local", "gemma-local");
    const withLocal = gatewayFor(PERSON_EXHAUSTED, [anthropic, local]);
    const turn = await withLocal.gateway.complete(ownerTurn(TENANT_EXHAUSTED));
    expect(turn.provider).toBe("gemma_local");
    expect(anthropic.calls).toHaveLength(0);

    const alone = gatewayFor(PERSON_EXHAUSTED, [spyAdapter("anthropic", "claude-sonnet-5-5")]);
    await expect(alone.gateway.complete(ownerTurn(TENANT_EXHAUSTED))).rejects.toMatchObject({ name: "ClaudeBudgetBlockedError", kind: "exhausted" });
    await expect(alone.gateway.complete(ownerTurn(TENANT_EXHAUSTED))).rejects.toBeInstanceOf(ClaudeBudgetBlockedError);

    const rows = await auditAs(TENANT_EXHAUSTED, "claude_budget.decision");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.decision === "deny" && r.reason === "exhausted_closed")).toBe(true);

    // flatene ser det samme: nivået er «oppbrukt»
    const status = await readClaudeBudgetState(db.appPool, TENANT_EXHAUSTED, config, Date.now());
    expect(status.state.level).toBe("exhausted");
    const counts = await readClaudeDecisionCounts(db.appPool, TENANT_EXHAUSTED, status.window.start_ms, status.window.end_ms, Date.now());
    expect(counts.by_decision.deny.period).toBe(rows.length);
  });
});
