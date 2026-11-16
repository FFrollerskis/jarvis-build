import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport } from "@jarvis/executive";
import { DailyBrief } from "@jarvis/tool-gateway";
import { MemoryAlertSink, type Alert, type AlertSink } from "@jarvis/watchdog";
import { pacingState, pacingParamsOf, budgetWindow } from "@jarvis/model-gateway";
import { createAiCenter, type AiCenterDeps } from "../src/control-center/ai.ts";
import { fitDetail } from "../src/control-center/ai-claude-budget.ts";
import { claudeBudgetFromEnv, registerControlCenters } from "../src/control-center/register.ts";
import {
  CLAUDE_BUDGET_ALERT_INTERVAL_MS, ClaudeBudgetAlerter, claudeBudgetAlertMessage, claudeBudgetBriefSource, readClaudeDecisionCounts, readClaudeUsage, startClaudeBudgetAlerts
} from "../src/claude-budget-surfaces.ts";
import { BudgetPool, DAY, MID, OWNER_PERSON, OWNER_TENANT, PERIOD_END, PERIOD_START, SPENT, budgetConfig } from "./support/claude-budget-pool.ts";

/**
 * WP-B4 (D-476): flatene for Claude-kreditten UTENFOR gatewayen - varsler (Telegram, én gang per terskel per periode), daglig brief (én linje) og kontrollsenteret (AI/Kost). Enhetstester mot en fake pool;
 * ekte SQL, GRANT-er og RLS bevises i `wpb4-claude-budget-db.test.ts`. Perioden er 15. nov → 15. des 2026 (30 døgn); klokka står midt i den (etter 15 av 30 døgn, dag 16): kurven er 47 250 øre, 1,3 × kurven 61 425, kreditten 105 000.
 */
const identity: IdentityContext = { person_id: OWNER_PERSON, tenant_id: OWNER_TENANT, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------------------------------------------------
// Varsler
// ---------------------------------------------------------------------------------------------------------------------

class FlakySink implements AlertSink {
  readonly alerts: Alert[] = [];
  failures = 0;
  async send(alert: Alert): Promise<void> {
    if (this.failures > 0) { this.failures -= 1; throw new Error("levering_feilet_fake_verdi_123"); }
    this.alerts.push(alert);
  }
}

function alerter(pool: BudgetPool, sink: AlertSink, clock: { now: number }, env: Record<string, string> = {}): ClaudeBudgetAlerter {
  return new ClaudeBudgetAlerter({ pool: pool.pg(), config: budgetConfig(env), tenantId: OWNER_TENANT, ownerPersonId: OWNER_PERSON, sink, now: () => clock.now });
}
const markerKeys = (pool: BudgetPool): string[] => pool.audit.filter((a) => a.type === "claude_budget.alert").map((a) => String(a.payload["key"]));

describe("varsler: én gang per terskel per kredittperiode", () => {
  it("under første terskel sendes ingenting; hver nye terskel gir nøyaktig ÉN melding, og et nytt tikk uten ny terskel gir ingenting", async () => {
    const pool = new BudgetPool();
    const sink = new MemoryAlertSink();
    const clock = { now: MID };
    const a = alerter(pool, sink, clock);

    pool.spend.set(OWNER_TENANT, SPENT.on_pace); // 38 %
    expect((await a.tick()).sent).toEqual([]);
    expect(sink.alerts).toHaveLength(0);

    pool.spend.set(OWNER_TENANT, SPENT.over_50); // 52 %, tempo 1,16 (under 1,3)
    expect((await a.tick()).sent).toEqual(["pct:50"]);
    expect((await a.tick()).sent).toEqual([]);
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({ check: "claude_budget", severity: "info" });

    pool.spend.set(OWNER_TENANT, SPENT.tight); // 67 %, tempo 1,48: kun TEMPO er nytt (50 % er varslet)
    expect((await a.tick()).sent).toEqual(["pace"]);
    expect(sink.alerts).toHaveLength(2);
    expect(sink.alerts[1]?.severity).toBe("warning");

    pool.spend.set(OWNER_TENANT, SPENT.over_75); // 76 %
    expect((await a.tick()).sent).toEqual(["pct:75"]);
    pool.spend.set(OWNER_TENANT, SPENT.over_90); // 90,5 %
    expect((await a.tick()).sent).toEqual(["pct:90"]);
    pool.spend.set(OWNER_TENANT, SPENT.exhausted); // 100 %
    expect((await a.tick()).sent).toEqual(["pct:100"]);
    expect((await a.tick()).sent).toEqual([]);
    expect(sink.alerts.map((x) => x.severity)).toEqual(["info", "warning", "warning", "warning", "critical"]);
    expect(markerKeys(pool)).toEqual(["pct:50", "pace", "pct:75", "pct:90", "pct:100"]);
  });

  it("flere terskler passert mellom to runder gir ÉN melding (den høyeste tonen), og ALLE markeres - ingen etterslep av gamle varsler senere", async () => {
    const pool = new BudgetPool();
    const sink = new MemoryAlertSink();
    const a = alerter(pool, sink, { now: MID });
    pool.spend.set(OWNER_TENANT, SPENT.over_90); // 40 % → 90,5 % uten en runde imellom
    expect((await a.tick()).sent).toEqual(["pct:50", "pct:75", "pct:90", "pace"]);
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]?.severity).toBe("warning");
    expect(sink.alerts[0]?.message).toContain("90 %");
    expect(sink.alerts[0]?.message).toContain("ganger kurven"); // tempoet er over 1,3 × kurven samtidig
    expect(markerKeys(pool).sort()).toEqual(["pace", "pct:50", "pct:75", "pct:90"]);
    expect((await a.tick()).sent).toEqual([]);
  });

  it("idempotens overlever omstart: en NY alerter-instans mot samme database varsler ikke igjen", async () => {
    const pool = new BudgetPool();
    const sink = new MemoryAlertSink();
    pool.spend.set(OWNER_TENANT, SPENT.over_75);
    await alerter(pool, sink, { now: MID }).tick();
    const before = sink.alerts.length;
    expect(before).toBe(1);
    await alerter(pool, sink, { now: MID + 60_000 }).tick(); // «omstart»
    await alerter(pool, sink, { now: MID + 2 * 60_000 }).tick();
    expect(sink.alerts).toHaveLength(before);
  });

  it("ny kredittperiode (15.) armerer terskelene på nytt: samme prosent varsles igjen i neste periode, aldri to ganger i samme", async () => {
    const pool = new BudgetPool();
    const sink = new MemoryAlertSink();
    const clock = { now: MID };
    const a = alerter(pool, sink, clock);
    pool.spend.set(OWNER_TENANT, SPENT.over_50);
    await a.tick();
    expect(sink.alerts).toHaveLength(1);
    const first = pool.audit[0];
    expect(first?.payload).toMatchObject({ key: "pct:50", window_start: "2026-11-15", window_end: "2026-12-15" });

    // fornyelsen: forbruket er 0 i den nye perioden, ingenting varsles
    clock.now = PERIOD_END + 60_000;
    pool.spend.set(OWNER_TENANT, 0);
    expect((await a.tick()).sent).toEqual([]);

    // midt i den nye perioden (31 døgn: 15. des → 15. jan) passerer forbruket 50 % igjen
    clock.now = PERIOD_END + 15 * DAY;
    pool.spend.set(OWNER_TENANT, SPENT.over_50);
    expect((await a.tick()).sent).toEqual(["pct:50"]);
    expect(sink.alerts).toHaveLength(2);
    expect(pool.audit[1]?.payload).toMatchObject({ key: "pct:50", window_start: "2026-12-15", window_end: "2027-01-15" });
    expect((await a.tick()).sent).toEqual([]);
  });

  it("tempo-varselet kommer også tidlig i perioden (under 50 %), og kun én gang per periode", async () => {
    const pool = new BudgetPool();
    const sink = new MemoryAlertSink();
    const a = alerter(pool, sink, { now: PERIOD_START + 2 * DAY });
    pool.spend.set(OWNER_TENANT, 20_000); // 19 % av kreditten, men 1,8 × kurven (11 000)
    expect((await a.tick()).sent).toEqual(["pace"]);
    expect(sink.alerts[0]).toMatchObject({ severity: "warning" });
    expect(sink.alerts[0]?.message).toContain("ganger kurven");
    expect(sink.alerts[0]?.message).not.toContain("HARD STOPP");
    expect((await a.tick()).sent).toEqual([]);
  });

  it("100 %: hard stopp PÅ (standard) = kritisk varsel som sier at Anthropic er stengt til fornyelsen; hard stopp AV = kun varsel som sier at driften fortsetter", async () => {
    const on = new BudgetPool();
    const sinkOn = new MemoryAlertSink();
    on.spend.set(OWNER_TENANT, SPENT.exhausted);
    await alerter(on, sinkOn, { now: MID }).tick();
    const critical = sinkOn.alerts.at(-1);
    expect(critical?.severity).toBe("critical");
    expect(critical?.message).toContain("HARD STOPP");
    expect(critical?.message).toContain("15. desember");

    const off = new BudgetPool();
    const sinkOff = new MemoryAlertSink();
    off.spend.set(OWNER_TENANT, SPENT.exhausted);
    await alerter(off, sinkOff, { now: MID }, { JARVIS_CLAUDE_BUDGET_HARD_STOP: "off" }).tick();
    const soft = sinkOff.alerts.at(-1);
    expect(soft?.severity).toBe("critical");
    expect(soft?.message).toContain("Hardstoppen er AV");
    expect(soft?.message).not.toContain("HARD STOPP:");
  });

  it("leveringsfeil: ingen markør skrives, neste runde prøver igjen og leverer (aldri et tapt varsel) - og feilen logges som kategori, aldri som melding", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new BudgetPool();
    const sink = new FlakySink();
    const a = alerter(pool, sink, { now: MID });
    pool.spend.set(OWNER_TENANT, SPENT.over_75);
    sink.failures = 1;
    expect((await a.tick()).sent).toEqual([]);
    expect(pool.audit).toHaveLength(0);
    expect(sink.alerts).toHaveLength(0);
    expect((await a.tick()).sent).toEqual(["pct:50", "pct:75", "pace"]);
    expect(sink.alerts).toHaveLength(1);
    expect(markerKeys(pool)).toHaveLength(3);
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("claude_budget_alert_delivery_failed");
    expect(logged).not.toContain("levering_feilet_fake_verdi_123");
  });

  it("feil i selve markøren: meldingen er levert, og feilen kveler aldri runden. Instansen husker hva den har levert, så en VEDVARENDE markørfeil aldri gir en melding hvert 5. minutt; DOKUMENTERT GRENSE: etter en omstart (ny instans) uten markør kommer ETT duplikat (heller dobbelt enn tapt)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new BudgetPool();
    const sink = new MemoryAlertSink();
    const clock = { now: MID };
    const a = alerter(pool, sink, clock);
    pool.spend.set(OWNER_TENANT, SPENT.over_50);
    pool.failMarkerWrite = new Error("audit_ned");
    await expect(a.tick()).resolves.toEqual({ sent: ["pct:50"] });
    expect(sink.alerts).toHaveLength(1);
    expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("claude_budget_alert_marker_failed");
    // markøren feiler fortsatt, men samme instans sender IKKE på nytt - verken neste runde eller ti runder senere
    for (let n = 1; n <= 10; n += 1) { clock.now += 5 * 60_000; expect((await a.tick()).sent, `runde ${n}`).toEqual([]); }
    expect(sink.alerts).toHaveLength(1);
    // omstart (ny instans) mens markøren fortsatt ikke finnes: ETT duplikat, og nå er markøren på plass
    pool.failMarkerWrite = null;
    const restarted = alerter(pool, sink, clock);
    expect((await restarted.tick()).sent).toEqual(["pct:50"]);
    expect(sink.alerts).toHaveLength(2);
    expect((await restarted.tick()).sent).toEqual([]);
    expect((await alerter(pool, sink, clock).tick()).sent).toEqual([]); // enda en omstart: markøren stopper det
    expect(sink.alerts).toHaveLength(2);
  });

  it("runder går aldri samtidig: en hengende levering (Telegram) gir ikke en andre melding for samme terskel fra en overlappende runde", async () => {
    const pool = new BudgetPool();
    let release: () => void = () => undefined;
    const delivered: Alert[] = [];
    const slow: AlertSink = { send: (alert) => new Promise<void>((resolve) => { release = () => { delivered.push(alert); resolve(); }; }) };
    const a = alerter(pool, slow, { now: MID });
    pool.spend.set(OWNER_TENANT, SPENT.over_50);
    const first = a.tick(); // henger i leveringen
    await vi.waitFor(() => expect(pool.queries.length).toBeGreaterThan(1)); // første runde har lest forbruk og markører
    expect((await a.tick()).sent).toEqual([]); // overlappende runde hoppes over
    release();
    await expect(first).resolves.toEqual({ sent: ["pct:50"] });
    expect(delivered).toHaveLength(1);
    expect(markerKeys(pool)).toEqual(["pct:50"]);
    expect((await a.tick()).sent).toEqual([]); // og rundene fungerer igjen etterpå
  });

  it("kan forbruket ikke leses sendes INGEN melding og ingen markør (ukjent er ikke «i orden», og ikke et falskt alarmnivå); kan markørene ikke leses sendes heller ingenting (aldri en gjentatt melding)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = new BudgetPool();
    const sink = new MemoryAlertSink();
    const a = alerter(pool, sink, { now: MID });
    pool.spend.set(OWNER_TENANT, SPENT.exhausted);

    pool.failSpend = new Error("cost_events_ned");
    await expect(a.tick()).resolves.toEqual({ sent: [] });
    pool.failSpend = null;

    pool.failMarkerRead = new Error("audit_ned");
    await expect(a.tick()).resolves.toEqual({ sent: [] });
    pool.failMarkerRead = null;

    expect(sink.alerts).toHaveLength(0);
    expect(pool.audit).toHaveLength(0);
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("claude_budget_alert_unreadable");
    expect(logged).toContain("claude_budget_alert_markers_unreadable");
    expect(logged).not.toContain("cost_events_ned");
    expect(logged).not.toContain("audit_ned");
    expect((await a.tick()).sent).toContain("pct:100"); // og når kildene er tilbake, varsles det
  });

  it("tenant og innhold: alt kjører under EIERENS tenant, markøren bærer kun nøkkel, periode, prosent og nivå (aldri innhold), og meldingen har ingen hemmeligheter", async () => {
    const pool = new BudgetPool();
    const sink = new MemoryAlertSink();
    pool.spend.set(OWNER_TENANT, SPENT.over_90);
    pool.spend.set("tenant-annen", SPENT.exhausted); // en annen tenants forbruk skal aldri påvirke eierens varsel
    await alerter(pool, sink, { now: MID }).tick();
    expect(new Set(pool.queries.map((q) => q.tenant))).toEqual(new Set([OWNER_TENANT]));
    expect(pool.audit.every((a) => a.tenant_id === OWNER_TENANT && a.person_id === OWNER_PERSON)).toBe(true);
    for (const row of pool.audit) {
      expect(Object.keys(row.payload).sort()).toEqual(["key", "level", "severity", "spent_pct", "window_end", "window_start"]);
      expect(row).toMatchObject({ type: "claude_budget.alert", decision: "sent", tool_id: "claude_budget", action: "alert" });
    }
    const text = sink.alerts.map((a) => `${a.message} ${a.runbook}`).join("\n");
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{8,}|SECRET_|Bearer |password/i);
    expect(sink.alerts[0]?.runbook).toBe("docs/runbooks/WPB4_CLAUDE_BUDGET_PACING.md");
  });

  it("en annen tenants markører teller ikke (RLS): eierens varsel sendes selv om en annen tenant har en markør for samme periode og terskel", async () => {
    const pool = new BudgetPool();
    const sink = new MemoryAlertSink();
    pool.audit.push({ tenant_id: "tenant-annen", person_id: "x", type: "claude_budget.alert", decision: "sent", reason: "pct:50", tool_id: "claude_budget", action: "alert", payload: { key: "pct:50", window_start: "2026-11-15" } });
    pool.spend.set(OWNER_TENANT, SPENT.over_50);
    expect((await alerter(pool, sink, { now: MID }).tick()).sent).toEqual(["pct:50"]);
  });
});

describe("meldingsteksten", () => {
  const config = budgetConfig();
  const at = (spent: number) => pacingState({ now: MID, budget_ore: config.budget_ore, spent_ore: spent, params: pacingParamsOf(config), trailing: { spent_ore: spent, days: 7 } });

  it("alvorlighet følger høyeste nye prosentterskel (50 = info, 75 og 90 = warning, 100 = critical); tempo alene = warning", () => {
    expect(claudeBudgetAlertMessage(at(SPENT.over_50), config, ["pct:50"]).severity).toBe("info");
    expect(claudeBudgetAlertMessage(at(SPENT.over_75), config, ["pct:75"]).severity).toBe("warning");
    expect(claudeBudgetAlertMessage(at(SPENT.over_90), config, ["pct:90"]).severity).toBe("warning");
    expect(claudeBudgetAlertMessage(at(SPENT.exhausted), config, ["pct:100"]).severity).toBe("critical");
    expect(claudeBudgetAlertMessage(at(SPENT.tight), config, ["pace"]).severity).toBe("warning");
  });

  it("meldingen sier hvor mye som er brukt (USD og kr), nivået, og når kreditten fornyes (den 15.)", () => {
    const { message } = claudeBudgetAlertMessage(at(SPENT.over_75), config, ["pct:75"]);
    expect(message).toContain("75 %");
    expect(message).toContain("15. desember");
    expect(message).toMatch(/USD/);
    expect(message).toMatch(/kr/);
  });
});

describe("startClaudeBudgetAlerts", () => {
  it("kjører straks og deretter hvert intervall, holder ikke prosessen i live (unref), og en kastende runde velter ingenting", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let n = 0;
    const fake = { tick: vi.fn(async () => { n += 1; if (n === 2) throw new Error("uventet_fake_123"); return { sent: [] as string[] }; }) } as unknown as ClaudeBudgetAlerter;
    const timer = startClaudeBudgetAlerts(fake, 1000);
    expect((fake as unknown as { tick: ReturnType<typeof vi.fn> }).tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3500);
    expect((fake as unknown as { tick: ReturnType<typeof vi.fn> }).tick).toHaveBeenCalledTimes(4);
    expect(timer.hasRef()).toBe(false);
    expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("claude_budget_alert_tick_error");
    expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("uventet_fake_123");
    clearInterval(timer);
  });

  it("standardintervallet er 5 minutter", () => {
    expect(CLAUDE_BUDGET_ALERT_INTERVAL_MS).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Daglig brief
// ---------------------------------------------------------------------------------------------------------------------

describe("daglig brief: én linje", () => {
  const briefFor = async (spent: number, env: Record<string, string> = {}) => {
    const pool = new BudgetPool();
    pool.spend.set(OWNER_TENANT, spent);
    const source = claudeBudgetBriefSource({ pool: pool.pg(), config: budgetConfig(env), now: () => MID });
    const brief = new DailyBrief([source]);
    const artifact = await brief.generate(identity);
    return { artifact, text: DailyBrief.render(artifact), pool };
  };

  it("på tempo: linjen står under FYI (score under 40) med brukt USD, dag i perioden og prognose - og én linje, ikke flere", async () => {
    const { artifact, text } = await briefFor(SPENT.on_pace);
    expect(artifact.fyi.filter((i) => i.source === "claude-budget")).toHaveLength(1);
    expect(artifact.needs_attention).toHaveLength(0);
    expect(artifact.source_errors).toEqual([]);
    expect(text).toContain("Claude-kreditten:");
    expect(text).toContain("Dag 16 av 30");
    expect(text).toContain("[claude-budget:2026-11-30");
  });

  it("stramt og oppbrukt står under NEEDS ATTENTION med handling («se AI-senteret»); oppbrukt er høyest prioritert", async () => {
    const tight = await briefFor(SPENT.tight);
    expect(tight.artifact.needs_attention.map((i) => i.source)).toContain("claude-budget");
    expect(tight.text).toContain("se AI-senteret (Kost)");
    const exhausted = await briefFor(SPENT.exhausted);
    expect(exhausted.artifact.needs_attention.find((i) => i.source === "claude-budget")?.score).toBe(88);
    expect(exhausted.artifact.top_priorities[0]?.source).toBe("claude-budget");
    expect(exhausted.text).toContain("Anthropic er stengt til fornyelsen");
  });

  it("oppbrukt med hardstoppen AV: briefen påstår IKKE at Anthropic er stengt, men at egne turer og bestilte jobber fortsetter (det kan koste penger)", async () => {
    const { artifact, text } = await briefFor(SPENT.exhausted, { JARVIS_CLAUDE_BUDGET_HARD_STOP: "off" });
    const line = artifact.needs_attention.find((i) => i.source === "claude-budget");
    expect(line?.score).toBe(88);
    expect(line?.why).toContain("hardstoppen er av");
    expect(line?.why).toContain("kan koste penger");
    expect(text).not.toContain("Anthropic er stengt");
  });

  it("foran tempo er fortsatt bare FYI (score 35), og referansen er dagens dato slik at linjen er ny hver dag", async () => {
    const { artifact } = await briefFor(SPENT.over_50);
    expect(artifact.fyi.find((i) => i.source === "claude-budget")).toMatchObject({ score: 35, ref: "2026-11-30" });
  });

  it("kan forbruket ikke leses, degraderer briefen pent: «Connector utilgjengelig: claude-budget» under NEEDS ATTENTION - aldri en påstand om at alt er i orden, og aldri feilmeldingen", async () => {
    const pool = new BudgetPool();
    pool.failSpend = new Error("cost_events_ned_fake_123");
    const artifact = await new DailyBrief([claudeBudgetBriefSource({ pool: pool.pg(), config: budgetConfig(), now: () => MID })]).generate(identity);
    expect(artifact.source_errors.map((e) => e.source)).toEqual(["claude-budget"]);
    expect(artifact.needs_attention.map((i) => i.title)).toContain("Connector utilgjengelig: claude-budget");
    expect(artifact.fyi.filter((i) => i.source === "claude-budget")).toHaveLength(0);
  });

  it("leser kun eierens tenant (RLS) og kun Anthropic-forbruket", async () => {
    const { pool } = await briefFor(SPENT.on_pace);
    expect(new Set(pool.queries.map((q) => q.tenant))).toEqual(new Set([OWNER_TENANT]));
    expect(pool.queries.every((q) => q.sql.includes("provider = $4"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Kontrollsenter (AI / Kost)
// ---------------------------------------------------------------------------------------------------------------------

const claudeIds = ["claude_budget", "claude_budget_use", "claude_budget_decisions"];
const BASE_SOURCE = "cost_events via BudgetGuard og RunRateService (D-421; tenant-RLS) · miljø (JARVIS_COST_*)";

function aiCenter(pool: BudgetPool, over: Partial<AiCenterDeps> = {}): ControlCenterRegistry {
  const deps: AiCenterDeps = {
    pool: pool.pg(),
    env: {},
    gateway: { providerOverview: () => [], meshStatus: () => ({ router: "HEALTHY", fallback: "READY" }), routingAdvisorMode: "off" },
    ownerControls: { listFrozenConnectorsDurable: async () => [], listRevokedCredentialsDurable: async () => [] },
    toolGateway: { get: () => undefined },
    ...over
  };
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => new Date(MID) });
  registry.register(createAiCenter(deps));
  return registry;
}
const costSection = (r: ControlCenterReport) => {
  const s = r.sections.find((x) => x.id === "cost");
  if (!s) throw new Error("mangler kost-seksjonen");
  return s;
};
const reportOf = async (registry: ControlCenterRegistry, options: { restrictFinance?: boolean } = {}): Promise<ControlCenterReport> => (await registry.report("ai", identity, options)) as ControlCenterReport;

describe("AI-senteret (Kost): Claude-kreditten", () => {
  const usageRows = [
    { purpose: "CHAT", has_task: false, has_session: true, calls_7d: 10, ore_7d: 3000, calls_30d: 30, ore_30d: 9000 },
    { purpose: "EXTRACT", has_task: true, has_session: true, calls_7d: 5, ore_7d: 500, calls_30d: 20, ore_30d: 2000 },
    { purpose: "BACKGROUND", has_task: true, has_session: false, calls_7d: 2, ore_7d: 700, calls_30d: 6, ore_30d: 1500 }
  ];
  const decisionRows = [
    { decision: "downgrade", tier: "background", n_period: 12, n_7d: 4 },
    { decision: "defer", tier: "background", n_period: 7, n_7d: 3 },
    { decision: "defer", tier: "important", n_period: 2, n_7d: 1 },
    { decision: "deny", tier: "important", n_period: 1, n_7d: 1 }
  ];

  it("flagg AV: ingen nye elementer, kilden er uendret, og INGEN spørring leser kreditten", async () => {
    const pool = new BudgetPool();
    const report = await reportOf(aiCenter(pool));
    const section = costSection(report);
    expect(section.items.map((i) => i.id).filter((id) => claudeIds.includes(id))).toEqual([]);
    expect(section.source).toBe(BASE_SOURCE);
    expect(pool.claudeQueries()).toHaveLength(0);
  });

  it("flagg PÅ, lokal modell/siden: tre elementer (kreditten, forbruk per tier, styrte kall) med tall fra kildene; kilden nevner kreditten", async () => {
    const pool = new BudgetPool();
    pool.spend.set(OWNER_TENANT, SPENT.on_pace);
    pool.usageRows = usageRows;
    pool.decisionRows = decisionRows;
    const report = await reportOf(aiCenter(pool, { claudeBudget: budgetConfig() }));
    const section = costSection(report);
    const items = new Map(section.items.map((i) => [i.id, i]));
    expect(section.source).toContain("Claude-kreditten");

    const credit = items.get("claude_budget");
    expect(credit?.status).toBe("OK");
    expect(credit?.label).toContain("100 USD");
    expect(credit?.label).toContain("fornyes den 15.");
    expect(credit?.detail_no).toContain("Alt er tillatt på Claude.");
    expect(credit?.facts).toMatchObject({
      level: "on_pace", hard_stop: true, reset_day: 15, budget_ore: 105_000, spent_ore: 40_000, spent_usd: 38.1, spent_kr: 400, curve_ore: 47_250,
      pacing_budget_ore: 89_250, reserve_ore: 15_750, day_of_period: 16, days_in_period: 30, period_start: "2026-11-15", period_end: "2026-12-15"
    });

    const use = items.get("claude_budget_use");
    expect(use?.status).toBe("OK");
    // CHAT med økt = ESSENSIELL; EXTRACT og BACKGROUND med jobb-id = BAKGRUNN
    expect(use?.facts).toMatchObject({ ore_7d: 4200, ore_30d: 12_500, calls_7d: 17, calls_30d: 56, tier_essential_ore_30d: 9000, tier_background_ore_30d: 3500, tier_important_ore_30d: 0 });
    expect(use?.detail_no).toContain("essensiell");
    expect(use?.detail_no).toContain("tier er utledet");
    expect(use?.detail_no).toContain("ikke Anthropics faktura");

    const decisions = items.get("claude_budget_decisions");
    expect(decisions?.facts).toMatchObject({ downgraded_period: 12, deferred_period: 9, denied_period: 1, downgraded_7d: 4, deferred_7d: 4, denied_7d: 1, background_period: 19, important_period: 3, essential_period: 0 });
  });

  it("flagg PÅ men mottakeren er en SKYMODELL (restrictFinance): ingen av elementene, og ingen spørring leser kreditten - utelatelsen skjer FØR elementene bygges", async () => {
    const pool = new BudgetPool();
    pool.spend.set(OWNER_TENANT, SPENT.exhausted);
    const report = await reportOf(aiCenter(pool, { claudeBudget: budgetConfig() }), { restrictFinance: true });
    const section = costSection(report);
    expect(section.items.map((i) => i.id).filter((id) => claudeIds.includes(id))).toEqual([]);
    expect(section.source).toBe(BASE_SOURCE);
    expect(pool.claudeQueries()).toHaveLength(0);
    const text = JSON.stringify(report);
    expect(text).not.toContain("Claude-kreditten");
    expect(text).not.toContain("claude_budget");
  });

  it("nivåene gir riktig status og forklarer hva som skjer: foran = WARN, stramt = WARN, oppbrukt med hard stopp = FAIL, oppbrukt uten hard stopp = WARN", async () => {
    const cases: Array<[number, Record<string, string>, string, string]> = [
      [SPENT.over_50, {}, "WARN", "billigere Claude-modell"],
      [SPENT.tight, {}, "WARN", "Kun dine egne turer og bestilte jobber"],
      [SPENT.exhausted, {}, "FAIL", "HARD STOPP"],
      [SPENT.exhausted, { JARVIS_CLAUDE_BUDGET_HARD_STOP: "off" }, "WARN", "Hardstoppen er AV"]
    ];
    for (const [spent, env, status, text] of cases) {
      const pool = new BudgetPool();
      pool.spend.set(OWNER_TENANT, spent);
      const report = await reportOf(aiCenter(pool, { claudeBudget: budgetConfig(env) }));
      const credit = costSection(report).items.find((i) => i.id === "claude_budget");
      expect(credit?.status, `${spent} ${JSON.stringify(env)}`).toBe(status);
      expect(credit?.detail_no, `${spent}`).toContain(text);
    }
  });

  it("controlItem kutter detaljen ved 400 tegn og beholder 24 fakta: ingen av elementene mister forbeholdet eller periodefaktaene, selv med lange formålsnavn og alle nivåer", async () => {
    const longPurposes = ["SENSITIVITY_CLASSIFICATION_DEEP", "MEMORY_EXTRACTION_BATCH_LONG", "CONVERSATION_SUMMARY_NIGHTLY", "TOOL_TURN_ORCHESTRATION", "COUNCIL_SYNTHESIS_ROUND", "VISION_DESCRIPTION_LONG"].map((purpose, n) => (
      { purpose, has_task: true, has_session: false, calls_7d: 1, ore_7d: 100 + n, calls_30d: 2, ore_30d: 1000 - n }
    ));
    for (const spent of [SPENT.on_pace, SPENT.over_50, SPENT.tight, SPENT.over_90, SPENT.exhausted]) {
      for (const env of [{}, { JARVIS_CLAUDE_BUDGET_HARD_STOP: "off" }]) {
        const pool = new BudgetPool();
        pool.spend.set(OWNER_TENANT, spent);
        pool.usageRows = longPurposes;
        pool.decisionRows = decisionRows;
        const section = costSection(await reportOf(aiCenter(pool, { claudeBudget: budgetConfig(env) })));
        for (const id of claudeIds) {
          const found = section.items.find((i) => i.id === id);
          expect(found, id).toBeDefined();
          expect(found?.detail_no?.length ?? 0, `${id} ${spent}`).toBeLessThanOrEqual(400);
          expect(found?.detail_no ?? "", `${id} ${spent}`).not.toMatch(/…$/);
        }
        const credit = section.items.find((i) => i.id === "claude_budget");
        expect(Object.keys(credit?.facts ?? {}).length).toBeLessThanOrEqual(24);
        for (const key of ["level", "hard_stop", "reset_day", "period_start", "period_end", "spent_ore", "budget_ore", "curve_ore", "pace_ratio", "forecast_pct", "basis_no"]) {
          expect(Object.keys(credit?.facts ?? {}), `${spent} mangler ${key}`).toContain(key);
        }
        expect(String(credit?.facts?.["basis_no"])).toContain("ikke Anthropics faktura");
        const use = section.items.find((i) => i.id === "claude_budget_use");
        expect(use?.detail_no).toContain("ikke Anthropics faktura"); // forbeholdet blir aldri kuttet bort, heller faller et formål ut
      }
    }
  });

  it("oppbrukt med hard stopp sier når kreditten fornyes (15. desember)", async () => {
    const pool = new BudgetPool();
    pool.spend.set(OWNER_TENANT, SPENT.exhausted);
    const credit = costSection(await reportOf(aiCenter(pool, { claudeBudget: budgetConfig() }))).items.find((i) => i.id === "claude_budget");
    expect(credit?.detail_no).toContain("15. desember");
  });

  it("hver kilde som ikke kan leses gir UKJENT for akkurat sitt element (aldri «i orden»), og feilen vises som kategori - aldri meldingen", async () => {
    const failures: Array<[keyof Pick<BudgetPool, "failSpend" | "failUsage" | "failDecisions">, string]> = [["failSpend", "claude_budget"], ["failUsage", "claude_budget_use"], ["failDecisions", "claude_budget_decisions"]];
    for (const [knob, id] of failures) {
      const pool = new BudgetPool();
      pool.spend.set(OWNER_TENANT, SPENT.on_pace);
      pool[knob] = new Error("kilde_ned_fake_verdi_123");
      const report = await reportOf(aiCenter(pool, { claudeBudget: budgetConfig() }));
      const section = costSection(report);
      const broken = section.items.find((i) => i.id === id);
      expect(broken?.status, id).toBe("UNKNOWN");
      expect(JSON.stringify(report), id).not.toContain("kilde_ned_fake_verdi_123");
      // de to andre elementene er fortsatt der og ikke UKJENT
      for (const other of claudeIds.filter((x) => x !== id)) expect(section.items.find((i) => i.id === other)?.status, `${id} → ${other}`).not.toBe("UNKNOWN");
    }
  });

  it("alt kjører under identitetens tenant (RLS), aldri en fast eller parameterstyrt", async () => {
    const pool = new BudgetPool();
    pool.spend.set(OWNER_TENANT, SPENT.on_pace);
    await reportOf(aiCenter(pool, { claudeBudget: budgetConfig() }));
    expect(pool.claudeQueries().length).toBeGreaterThanOrEqual(3);
    expect(new Set(pool.claudeQueries().map((q) => q.tenant))).toEqual(new Set([OWNER_TENANT]));
  });

  it("ingen skriving: senteret leser kun (ingen INSERT/UPDATE/DELETE) og ingen revisjonsrad skrives", async () => {
    const pool = new BudgetPool();
    pool.spend.set(OWNER_TENANT, SPENT.tight);
    await reportOf(aiCenter(pool, { claudeBudget: budgetConfig() }));
    expect(pool.queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q.sql))).toHaveLength(0);
    expect(pool.audit).toHaveLength(0);
  });
});

describe("registerControlCenters: kreditten kobles inn fra miljøet", () => {
  const wiring = (pool: BudgetPool, env: Record<string, string | undefined>) => ({
    pool: pool.pg(),
    env,
    modelGateway: { providerOverview: () => [], meshStatus: () => ({ router: "HEALTHY", fallback: "READY" }), routingAdvisorMode: "off" as const },
    toolGateway: { get: () => undefined },
    ownerControls: { listFrozenConnectorsDurable: async () => [], listRevokedCredentialsDurable: async () => [] }
  });
  const reportWith = async (env: Record<string, string | undefined>): Promise<ControlCenterReport> => {
    const pool = new BudgetPool();
    pool.spend.set(OWNER_TENANT, SPENT.on_pace);
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => new Date(MID) });
    registerControlCenters(registry, wiring(pool, env) as never);
    return (await registry.report("ai", identity)) as ControlCenterReport;
  };

  it("JARVIS_CLAUDE_BUDGET_USD satt → elementene finnes; uten, tom, «off» eller UGYLDIG verdi → ingen elementer og ingen feil (ugyldig verdi stopper oppstarten i main.ts, ikke siden)", async () => {
    expect(costSection(await reportWith({ JARVIS_CLAUDE_BUDGET_USD: "100" })).items.map((i) => i.id)).toEqual(expect.arrayContaining(claudeIds));
    for (const env of [{}, { JARVIS_CLAUDE_BUDGET_USD: "" }, { JARVIS_CLAUDE_BUDGET_USD: "off" }, { JARVIS_CLAUDE_BUDGET_USD: "0" }, { JARVIS_CLAUDE_BUDGET_USD: "abc" }, { JARVIS_CLAUDE_BUDGET_USD: "100", JARVIS_CLAUDE_BUDGET_RESET_DAY: "32" }, { JARVIS_CLAUDE_BUDGET_USD: "100", JARVIS_CLAUDE_BUDGET_HARD_STOP: "kanskje" }]) {
      const ids = costSection(await reportWith(env)).items.map((i) => i.id);
      expect(ids.filter((id) => claudeIds.includes(id)), JSON.stringify(env)).toEqual([]);
    }
  });

  it("claudeBudgetFromEnv: standardene (fornyelse den 15., hard stopp PÅ) kommer fra den ene parseren", () => {
    expect(claudeBudgetFromEnv({})).toBeUndefined();
    expect(claudeBudgetFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "abc" })).toBeUndefined();
    expect(claudeBudgetFromEnv({ JARVIS_CLAUDE_BUDGET_USD: "100" })).toMatchObject({ budget_usd: 100, reset_day: 15, hard_stop: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Lesere
// ---------------------------------------------------------------------------------------------------------------------

describe("lesere", () => {
  it("fitDetail: legger til elementer kun så lenge hele teksten ryker innenfor 400 tegn, og avslutningen er alltid hel", () => {
    const entries = Array.from({ length: 50 }, (_, n) => `FORMAAL_${n} 1,00 USD`);
    const text = fitDetail("Hode: ", entries, ". Slutt.");
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text.endsWith(". Slutt.")).toBe(true);
    expect(text.startsWith("Hode: FORMAAL_0 1,00 USD, FORMAAL_1 1,00 USD")).toBe(true);
    expect(fitDetail("H: ", [], ".")).toBe("H: .");
  });

  it("forbruk: tier utledes fra formål + jobb-id/økt-id (samme regel som håndhevelsen), og rader slås sammen per formål og tier", async () => {
    const pool = new BudgetPool();
    pool.usageRows = [
      { purpose: "CHAT", has_task: false, has_session: true, calls_7d: 1, ore_7d: 10, calls_30d: 2, ore_30d: 20 },
      { purpose: "CHAT", has_task: false, has_session: true, calls_7d: 1, ore_7d: 5, calls_30d: 1, ore_30d: 5 },
      { purpose: "CHAT", has_task: true, has_session: true, calls_7d: 0, ore_7d: 0, calls_30d: 1, ore_30d: 7 },
      { purpose: null, has_task: false, has_session: false, calls_7d: 0, ore_7d: 0, calls_30d: 1, ore_30d: 3 }
    ];
    const rows = await readClaudeUsage(pool.pg(), OWNER_TENANT, budgetConfig(), MID);
    const chat = rows.filter((r) => r.purpose === "CHAT");
    expect(chat.find((r) => r.tier === "essential")).toMatchObject({ ore_7d: 15, ore_30d: 25, calls_30d: 3 });
    expect(chat.find((r) => r.tier === "background")).toMatchObject({ ore_30d: 7 });
    expect(rows.find((r) => r.purpose === "UNSPECIFIED")).toMatchObject({ tier: "background", ore_30d: 3 });
    expect(rows.map((r) => r.ore_30d)).toEqual([...rows.map((r) => r.ore_30d)].sort((a, b) => b - a)); // størst først
  });

  it("styrte kall: kun downgrade/defer/deny telles, per beslutning og tier, i perioden og siste 7 døgn", async () => {
    const pool = new BudgetPool();
    pool.decisionRows = [
      { decision: "downgrade", tier: "background", n_period: 3, n_7d: 2 },
      { decision: "deny", tier: "essential", n_period: 1, n_7d: 1 },
      { decision: "allow", tier: "essential", n_period: 99, n_7d: 99 }, // skal aldri telles
      { decision: "defer", tier: "ukjent_tier", n_period: 4, n_7d: 4 }
    ];
    const window = budgetWindow(MID, 15);
    const counts = await readClaudeDecisionCounts(pool.pg(), OWNER_TENANT, window.start_ms, window.end_ms, MID);
    expect(counts.by_decision).toEqual({ downgrade: { period: 3, d7: 2 }, defer: { period: 4, d7: 4 }, deny: { period: 1, d7: 1 } });
    expect(counts.by_tier).toEqual({ essential: { period: 1, d7: 1 }, important: { period: 0, d7: 0 }, background: { period: 3, d7: 2 } });
  });
});
