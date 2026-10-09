import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { CONTROL_ACTION_ALLOWED, CONTROL_ACTION_ENDPOINTS, ControlCenterRegistry, explainControlCenterNo, type ControlCenterReport, type ControlSection } from "@jarvis/executive";
import { DEFAULT_PROFILES, isSensitivityEligible, type ProviderHealthDetail, type ProviderOverviewRow } from "@jarvis/model-gateway";
import type { ToolDefinition } from "@jarvis/tool-gateway";
import {
  DEFAULT_MAX_ACTIVE_JOBS, FAIL_SHARE_MIN_CALLS, GEMMA_FIRST_CHAIN, createAiCenter, localitySplit, pauseInfoFor, providerStatus, usableLocalProviders, usageByProvider,
  type AiCenterDeps, type RoutingUsageRow
} from "../src/control-center/ai.ts";
import { LONG_RUNNING_MS, QUEUED_STALE_MS } from "../src/control-center/agents.ts";
import { registerControlCenters } from "../src/control-center/register.ts";
import { MAX_ACTIVE_JOBS } from "../src/chat-jobs.ts";
import { actionRequiresStepUp, stepUpDenial } from "../src/step-up.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { ScriptedPool, type ScriptedRule } from "./support/scripted-pool.ts";

/**
 * WP-H0 AI Center - ENHETSTESTER (ekte SQL/RLS bevises i wph0-ai-center-db.test.ts):
 *  1. leverandører: status fra helse/krets/pause/bruk, ukjent ≠ i orden, ubrukt konfigurert leverandør støyer ikke, kategori (aldri melding);
 *  2. pause/tilbakekall av leverandør: handlingene peker på eksisterende ruter med målet `model:<id>`; konsekvensen for sensitive turer sies FØR trykk;
 *  3. ruting (Gemma først, sensitive turer, D-431/D-449-rutene med dagstak), kost, evals (golden-suite = UKJENT), delegering, og kjørende agenter med avbryt (aldri tittel/innhold);
 *  4. kun lesing, identitetsbundet, fail-soft, ingen hemmeligheter; drift: konstantene speiler koden.
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const NOW = new Date("2026-10-09T12:00:00.000Z");
const H = 3_600_000;
const MIN = 60_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const identity: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const defs: ToolDefinition[] = productionToolDefinitions();

const health = (over: Partial<ProviderHealthDetail> = {}): ProviderHealthDetail => ({ state: "LIVE", success: 10, failures: 0, consecutive_failures: 0, circuit: "closed", last_success_at: ago(5 * MIN), ...over });
const row = (provider: string, over: Partial<Omit<ProviderOverviewRow, "health">> & { health?: Partial<ProviderHealthDetail> } = {}): ProviderOverviewRow => {
  const { health: h, ...rest } = over;
  const local = provider === "gemma_local" || provider === "local_llm" || provider === "ollama";
  return { provider, model: `${provider}-m`, locality: local ? "local" : "cloud", hosted_free_tier: provider === "gemma_hosted", configured: true, health: health(h), ...rest };
};
const CLOUD_PROFILE = DEFAULT_PROFILES.find((p) => p.provider === "anthropic") as (typeof DEFAULT_PROFILES)[number];
const LOCAL_PROFILE = DEFAULT_PROFILES.find((p) => p.provider === "gemma_local") as (typeof DEFAULT_PROFILES)[number];
const DEFAULT_ROWS = (): ProviderOverviewRow[] => [row("anthropic"), row("openai"), row("gemini", { configured: false, health: { state: "NOT_CONFIGURED" } }), row("gemma_hosted"), row("gemma_local")];

const taskRow = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  task_id: id, status: "running", attempts: 1, created_at: ago(30 * MIN), claimed_at: ago(20 * MIN), lease_expires_at: ahead(40_000), worker_id: "worker-1", cancel_requested: false, has_error: false,
  agent_profile: "executive", max_attempts: 3, delegated: true, network_targets: 0, ...over
});

interface Scenario {
  rows?: ProviderOverviewRow[] | Error;
  frozen?: string[];
  revoked?: string[];
  controlsFail?: Error;
  usage?: Array<Record<string, unknown>> | Error;
  lastRoutes?: Array<Record<string, unknown>> | Error;
  delegation?: Record<string, unknown> | Error;
  daily?: number | Error;
  monthly?: number | Error;
  tasks?: Array<Record<string, unknown>> | Error;
  counts?: Array<Record<string, unknown>> | Error;
  env?: Record<string, string | undefined>;
  runRate?: "absent" | "error" | Partial<Record<string, unknown>>;
  limiter?: "absent" | "error" | { used: number; max: number };
  evolution?: "absent" | "error" | "none" | { status: "OK" | "ATTENTION" | "UNKNOWN" | "DORMANT" };
  advisor?: "off" | "shadow" | "active";
  maxActiveJobs?: number;
}

const usageRow = (provider: string, purpose: string, ok: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider, purpose, ok_calls: ok, failed_calls: 0, fallback_calls: 0, critic_calls: 0, ore: 0, last_ok_at: ago(H), last_fallback_at: null, ...over
});

function runRateReport(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    as_of: NOW.toISOString(), totals: { today_ore: 1200, last_7d_ore: 8000, last_30d_ore: 30000, projected_month_ore: 34000 }, cloud_share_30d: 0.4,
    by_provider: [
      { provider: "anthropic", model: "claude-x", local: false, calls: 40, failed_calls: 1, ore: 25000, tokens_in: 100000, tokens_out: 20000 },
      { provider: "gemma_local", model: "gemma3", local: true, calls: 200, failed_calls: 0, ore: 0, tokens_in: 400000, tokens_out: 90000 }
    ],
    by_purpose: [], daily: [], maintenance: { minutes_30d: 0, by_connector: [], recent: [] }, value_loop: { brief_days_30d: 3 },
    not_measured: ["STT/TTS-kostnad (stemme) er ikke registrert i cost_events", "Connector-/API-kostnader (søk, kart, SMS m.fl.) er ikke registrert i cost_events"], summary_no: "x", ...over
  };
}

function build(scn: Scenario = {}): { pool: ScriptedPool; run: () => Promise<ControlCenterReport>; deps: AiCenterDeps } {
  const rules: ScriptedRule[] = [
    { match: /date_trunc\('day', now\(\) AT TIME ZONE/, rows: scn.daily instanceof Error ? scn.daily : [{ spent: scn.daily ?? 1200 }] },
    { match: /date_trunc\('month'/, rows: scn.monthly instanceof Error ? scn.monthly : [{ spent: scn.monthly ?? 40_000 }] },
    { match: /GROUP BY provider, purpose/, rows: scn.usage ?? [usageRow("gemma_local", "CHAT", 80), usageRow("anthropic", "CHAT", 20, { ore: 900, last_fallback_at: ago(3 * H), fallback_calls: 2 })] },
    { match: /DISTINCT ON \(purpose\)/, rows: scn.lastRoutes ?? [{ purpose: "CHAT", provider: "gemma_local", model: "gemma3", fallback: false, at: ago(10 * MIN) }, { purpose: "BACKGROUND", provider: "anthropic", model: "claude-x", fallback: true, at: ago(2 * H) }] },
    { match: /AS task_calls/, rows: scn.delegation instanceof Error ? scn.delegation : [{ all_calls: 100, all_ore: 5000, task_calls: 30, task_ore: 2000, task_failed: 1, ...(scn.delegation ?? {}) }] },
    { match: /FROM tasks[\s\S]*GROUP BY status/, rows: scn.counts ?? [{ status: "running", n: 1 }, { status: "created", n: 0 }, { status: "completed", n: 7 }, { status: "failed", n: 1 }, { status: "cancelled", n: 2 }] },
    { match: /FROM tasks/, rows: scn.tasks ?? [taskRow("task-aaaa1111-0000")] }
  ];
  const pool = new ScriptedPool(rules);
  const rows = scn.rows ?? DEFAULT_ROWS();
  const rr = scn.runRate;
  const deps: AiCenterDeps = {
    pool: pool.asPool(),
    env: scn.env ?? { JARVIS_GITHUB_REPO: "x/y" },
    gateway: {
      providerOverview: () => { if (rows instanceof Error) throw rows; return rows; },
      meshStatus: () => ({ router: "HEALTHY", fallback: "READY" }),
      routingAdvisorMode: scn.advisor ?? "shadow"
    },
    ownerControls: {
      listFrozenConnectorsDurable: async () => { if (scn.controlsFail) throw scn.controlsFail; return (scn.frozen ?? []).map((connector_id) => ({ connector_id, reason: "privat grunn", actor_person_id: "person-owner", changed_at: ago(H) })); },
      listRevokedCredentialsDurable: async () => (scn.revoked ?? []).map((credential_ref) => ({ credential_ref, reason: "privat grunn", actor_person_id: "person-owner", changed_at: ago(H) }))
    },
    toolGateway: { get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a) },
    ...(rr === "absent" ? {} : { runRate: { report: async () => { if (rr === "error") throw new Error("boom sk-ant-api03-ABCDEFGHIJKLMNOP"); return runRateReport(rr ?? {}) as never; } } }),
    ...(scn.limiter === "absent" ? {} : {
      councilLimiter: {
        usage: () => {
          if (scn.limiter === "error") throw new Error("x");
          const l = typeof scn.limiter === "object" ? scn.limiter : { used: 1, max: 3 };
          return { max_per_window: l.max, window_ms: 3_600_000, used_in_window: l.used, acquired_total: 5, denied_total: 2 };
        }
      }
    }),
    ...(scn.evolution === "absent" ? {} : {
      evolutionReport: async () => {
        if (scn.evolution === "error") throw new Error("x");
        if (scn.evolution === "none") return { sections: [] };
        const status = typeof scn.evolution === "object" ? scn.evolution.status : "OK";
        return { sections: [{ ev: "EV-12", title_no: "Modellrute i skygge", mode: "observe" as const, status, summary_no: "Kritiske arbeidsflyter har ≥2 leverandører.", findings: ["Mesh-ruteren: HEALTHY."], source: "modellmeshen", observed_at: NOW.toISOString() }] };
      }
    }),
    ...(scn.maxActiveJobs !== undefined ? { maxActiveJobs: scn.maxActiveJobs } : {})
  };
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(createAiCenter(deps));
  return { pool, deps, run: async () => (await registry.report("ai", identity)) as ControlCenterReport };
}

const section = (r: ControlCenterReport, id: string): ControlSection => {
  const s = r.sections.find((x) => x.id === id);
  if (!s) throw new Error(`mangler seksjon ${id}`);
  return s;
};
const item = (r: ControlCenterReport, sectionId: string, id: string) => {
  const i = section(r, sectionId).items.find((x) => x.id === id);
  if (!i) throw new Error(`mangler element ${sectionId}/${id}`);
  return i;
};
const actionIds = (r: ControlCenterReport): string[] => r.actions.map((a) => a.id);
const actionOf = (r: ControlCenterReport, id: string) => {
  const a = r.actions.find((x) => x.id === id);
  if (!a) throw new Error(`mangler handling ${id}`);
  return a;
};

describe("ren logikk", () => {
  const noPause = { paused: false, frozen: false, revoked_refs: [] as string[] };

  it("providerStatus: LIVE OK, degradert/rate-begrenset WARN, utilgjengelig/åpen krets FAIL, halv-åpen WARN, ikke konfigurert OK, pauset WARN", () => {
    expect(providerStatus(row("anthropic"), noPause, true, undefined)).toBe("OK");
    expect(providerStatus(row("anthropic", { health: { state: "DEGRADED" } }), noPause, true, undefined)).toBe("WARN");
    expect(providerStatus(row("anthropic", { health: { state: "RATE_LIMITED" } }), noPause, true, undefined)).toBe("WARN");
    expect(providerStatus(row("anthropic", { health: { state: "UNAVAILABLE", circuit: "open", consecutive_failures: 3 } }), noPause, true, undefined)).toBe("FAIL");
    expect(providerStatus(row("anthropic", { health: { state: "DEGRADED", circuit: "half_open", consecutive_failures: 3 } }), noPause, true, undefined)).toBe("WARN");
    expect(providerStatus(row("anthropic", { configured: false, health: { state: "NOT_CONFIGURED" } }), noPause, false, undefined)).toBe("OK");
    expect(providerStatus(row("anthropic"), { paused: true, frozen: true, revoked_refs: [] }, true, undefined)).toBe("WARN");
  });

  it("konfigurert men aldri bevist er UKJENT kun når leverandøren er i bruk; ellers OK (ubrukte nøkler holder ikke senteret på «ikke målt» for alltid)", () => {
    const unproven = row("openai", { health: { state: "CONFIGURED", success: 0 } });
    expect(providerStatus(unproven, noPause, true, undefined)).toBe("UNKNOWN");
    expect(providerStatus(unproven, noPause, false, undefined)).toBe("OK");
  });

  it("mange feilede kall (>= 30 % av minst 5) løfter til WARN, men ikke for få kall", () => {
    const usage = { ok_calls: 6, failed_calls: 4, ore: 0, last_ok_at: null, last_fallback_at: null };
    expect(providerStatus(row("anthropic"), noPause, true, usage)).toBe("WARN");
    expect(providerStatus(row("anthropic"), noPause, true, { ...usage, ok_calls: 1, failed_calls: 2 })).toBe("OK");
    expect(FAIL_SHARE_MIN_CALLS).toBe(5);
  });

  it("pauseInfoFor: frosset model:<id> og tilbakekalt nøkkel pauser; verktøyfrys og andre nøkler gjør det ikke", () => {
    const refs = new Map([["anthropic", ["ANTHROPIC_API_KEY"]]]);
    expect(pauseInfoFor("anthropic", ["model:anthropic"], new Set(), refs)).toEqual({ paused: true, frozen: true, revoked_refs: [] });
    expect(pauseInfoFor("anthropic", [], new Set(["ANTHROPIC_API_KEY"]), refs)).toEqual({ paused: true, frozen: false, revoked_refs: ["ANTHROPIC_API_KEY"] });
    expect(pauseInfoFor("anthropic", ["github", "model:openai"], new Set(["GITHUB_TOKEN"]), refs)).toEqual({ paused: false, frozen: false, revoked_refs: [] });
  });

  it("usableLocalProviders: konfigurert, ikke pauset og ikke utilgjengelig; ikke-lokale og scripted telles aldri", () => {
    const rows = [row("gemma_local"), row("local_llm", { configured: false, health: { state: "NOT_CONFIGURED" } }), row("ollama", { health: { state: "UNAVAILABLE" } }), row("anthropic"), row("scripted", { locality: "local" })];
    expect(usableLocalProviders(rows, new Set())).toEqual(["gemma_local"]);
    expect(usableLocalProviders(rows, new Set(["gemma_local"]))).toEqual([]);
  });

  it("usageByProvider og localitySplit: summerer per leverandør; ukjent leverandør regnes som sky; null uten kall", () => {
    const rows: RoutingUsageRow[] = [
      { provider: "gemma_local", purpose: "CHAT", ok_calls: 60, failed_calls: 0, fallback_calls: 0, critic_calls: 0, ore: 0, last_ok_at: ago(H), last_fallback_at: null },
      { provider: "gemma_local", purpose: "BACKGROUND", ok_calls: 20, failed_calls: 2, fallback_calls: 0, critic_calls: 0, ore: 0, last_ok_at: ago(2 * H), last_fallback_at: null },
      { provider: "ukjent", purpose: "CHAT", ok_calls: 20, failed_calls: 0, fallback_calls: 0, critic_calls: 0, ore: 500, last_ok_at: ago(H), last_fallback_at: null }
    ];
    const by = usageByProvider(rows);
    expect(by.get("gemma_local")).toMatchObject({ ok_calls: 80, failed_calls: 2, last_ok_at: ago(H) });
    const loc = (p: string): "local" | "cloud" => (p === "gemma_local" ? "local" : "cloud");
    expect(localitySplit(rows, loc)).toMatchObject({ local_ok: 80, cloud_ok: 20, total_ok: 100, local_share: 0.8, cloud_share: 0.2 });
    expect(localitySplit(rows, loc, "CHAT")).toMatchObject({ local_ok: 60, cloud_ok: 20 });
    expect(localitySplit([], loc)).toEqual({ local_ok: 0, cloud_ok: 0, total_ok: 0, local_share: null, cloud_share: null });
  });
});

describe("rapporten: seksjoner og kildeforankring", () => {
  it("seks seksjoner i fast rekkefølge, målt, kildeforankret og tidsstemplet; sensitivitet privat", async () => {
    const r = await build().run();
    expect(r.center).toBe("ai");
    expect(r.sections.map((s) => s.id)).toEqual(["providers", "routing", "cost", "evals", "delegation", "agents"]);
    for (const s of r.sections) {
      expect(s.source.length, s.id).toBeGreaterThan(8);
      expect(s.measured, s.id).toBe(true);
      expect(s.observed_at, s.id).toBe(NOW.toISOString());
    }
    expect(r.sensitivity).toBe("PRIVATE");
  });

  it("golden-suiten er DEFERRED og står som UKJENT (aldri «i orden»): evals-seksjonen og dermed senteret er UKJENT når alt annet er i orden", async () => {
    const r = await build({ env: { JARVIS_GITHUB_REPO: "x/y" } }).run();
    expect(item(r, "evals", "golden_suite")).toMatchObject({ status: "UNKNOWN", facts: { status: "DEFERRED", results_stored: false } });
    expect(section(r, "evals").status).toBe("UNKNOWN");
    expect(section(r, "evals").summary_no).toContain("ikke «i orden»");
  });

  it("«hvorfor?»-forklaringen nevner en pauset leverandør, og aldri begrunnelsestekst eller nøkler", async () => {
    const r = await build({ frozen: ["model:anthropic"], revoked: ["OPENAI_API_KEY"] }).run();
    const text = explainControlCenterNo(r);
    expect(text).toContain("anthropic");
    expect(text).not.toContain("privat grunn");
    expect(text).not.toContain("sk-ant");
  });
});

describe("leverandører", () => {
  it("hver registrert leverandør (unntatt scripted) er en rad med lokalitet, helse og 7-dagers kost; ikke konfigurert er OK og sies", async () => {
    const r = await build({ rows: [...DEFAULT_ROWS(), row("scripted", { locality: "local" })] }).run();
    expect(section(r, "providers").items.map((i) => i.id).sort()).toEqual(["anthropic", "gemini", "gemma_hosted", "gemma_local", "openai"]);
    expect(item(r, "providers", "gemma_local").facts).toMatchObject({ locality: "local", configured: true, health_state: "LIVE", circuit: "closed", calls_ok_7d: 80, paused: false });
    expect(item(r, "providers", "anthropic").facts).toMatchObject({ locality: "cloud", cost_7d_ore: 900, last_fallback_at: ago(3 * H) });
    expect(item(r, "providers", "gemini")).toMatchObject({ status: "OK" });
    expect(item(r, "providers", "gemini").detail_no).toContain("ikke konfigurert");
    expect(item(r, "providers", "gemma_hosted").detail_no).toContain("gratis-tier");
  });

  it("åpen krets: FAIL med nedtelling og feilKATEGORI (aldri meldingen); halv-åpen sies", async () => {
    const r = await build({
      rows: [row("anthropic", { health: { state: "UNAVAILABLE", circuit: "open", consecutive_failures: 3, last_error_kind: "server", last_failure_at: ago(MIN), retry_after_ms: 29_000 } }), row("openai", { health: { state: "DEGRADED", circuit: "half_open", consecutive_failures: 3, last_error_kind: "timeout", last_failure_at: ago(5 * MIN) } })]
    }).run();
    const a = item(r, "providers", "anthropic");
    expect(a.status).toBe("FAIL");
    expect(a.detail_no).toContain("kretsen er åpen");
    expect(a.detail_no).toContain("29 s");
    expect(a.detail_no).toContain("leverandørfeil");
    expect(item(r, "providers", "openai").detail_no).toContain("halv-åpen");
    expect(section(r, "providers").status).toBe("FAIL");
    expect(r.status).toBe("FAIL");
  });

  it("pause-tilstand som ikke kan leses: konfigurerte leverandører er UKJENT (kan ikke bekrefte at de ikke er pauset) og seksjonen sier det", async () => {
    const r = await build({ controlsFail: new Error("db nede") }).run();
    expect(item(r, "providers", "anthropic").status).toBe("UNKNOWN");
    expect(section(r, "providers").status).toBe("UNKNOWN");
    expect(section(r, "providers").summary_no).toContain("pause-tilstanden");
    expect(item(r, "providers", "gemini").status).toBe("OK"); // ikke konfigurert: ingenting å pause
  });

  it("pause-tilstand som ikke kan leses gjør også RUTINGEN ukjent: «brukbar lokal modell» og «verktøyturer går til Sonnet» kan ikke påstås uten å vite om leverandøren er pauset", async () => {
    const r = await build({ controlsFail: new Error("db nede") }).run();
    for (const id of ["gemma_first", "sensitive_local", "tool_turn_route", "job_route"]) expect(item(r, "routing", id).status, id).toBe("UNKNOWN");
    expect(section(r, "routing").status).toBe("UNKNOWN");
    expect(section(r, "routing").summary_no).toContain("Pause-tilstanden kunne ikke leses");
    // Samme scenario med lesbar pause-tilstand: rutingen er målt og i orden (kontrollen over er ikke en generell UKJENT-påvirkning).
    const ok = await build().run();
    for (const id of ["gemma_first", "sensitive_local", "tool_turn_route", "job_route"]) expect(item(ok, "routing", id).status, id).toBe("OK");
    expect(section(ok, "routing").status).toBe("OK");
  });

  it("leverandørvisningen som ikke kan hentes er en UKJENT-seksjon (measured:false) og routing sier det", async () => {
    const r = await build({ rows: new Error("boom") }).run();
    expect(section(r, "providers")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(item(r, "routing", "gemma_first").status).toBe("UNKNOWN");
  });
});

describe("pause og tilbakekall av leverandør: handlinger", () => {
  it("konfigurert leverandør: «Pause» = freeze_connector på model:<id> (klasse C, uten step-up, kan angres); ikke konfigurert: ingen pause", async () => {
    const r = await build().run();
    const a = actionOf(r, "ai.pause:anthropic");
    expect(a).toMatchObject({
      endpoint: "/executive/mutate", body: { action: "freeze_connector", parameters: { connector_id: "model:anthropic" } }, risk_class: "C", requires_step_up: false, reversible: true,
      section_id: "providers", item_id: "anthropic"
    });
    expect(a.description_no).toContain("uten omstart");
    expect(actionIds(r)).not.toContain("ai.pause:gemini");
  });

  it("konsekvensen sies FØR trykk: en LOKAL leverandør forklarer at sensitive turer ikke får svar (og aldri går til sky); en sky-leverandør at turer faller til lokal modell", async () => {
    const r = await build().run();
    expect(actionOf(r, "ai.pause:gemma_local").description_no).toContain("ALDRI til sky");
    expect(actionOf(r, "ai.pause:anthropic").description_no).toContain("faller til lokal modell");
    expect(actionOf(r, "ai.pause:anthropic").description_no).not.toContain("ALDRI til sky");
  });

  it("L-8: teksten for en LOKAL leverandør skiller SECRET_RESTRICTED (aldri sky, ingen svar) fra PRIVATE/BUSINESS_CONFIDENTIAL (faller til betalt sky, D-23) - og påstår ikke at «helse, økonomi og hemmeligheter» er alt som er sensitivt", async () => {
    const pause = actionOf(await build().run(), "ai.pause:gemma_local").description_no;
    expect(pause).toContain("SECRET_RESTRICTED");
    expect(pause).toContain("ALDRI til sky");
    expect(pause).toContain("PRIVATE/BUSINESS_CONFIDENTIAL faller til betalt sky");
    expect(pause).toContain("D-23");
    // beskrivelsen ble ikke avkortet av kontraktens tak (400 tegn) - hele presiseringen står der
    expect(pause.endsWith("…")).toBe(false);
    expect(pause.length).toBeLessThanOrEqual(400);
    // leverandørraden (når den er pauset) sier det samme
    const row = item(await build({ frozen: ["model:gemma_local"] }).run(), "providers", "gemma_local").detail_no ?? "";
    expect(row).toContain("SECRET_RESTRICTED");
    expect(row).toContain("aldri sky");
    expect(row).toContain("private og forretningsfortrolige turer faller til betalt sky (D-23)");
    // rutingpunktet sier det samme, både når en lokal modell er brukbar og når ingen er det
    for (const scn of [{}, { frozen: ["model:gemma_local"] }]) {
      const text = item(await build(scn).run(), "routing", "sensitive_local").detail_no ?? "";
      expect(text).toContain("SECRET_RESTRICTED");
      expect(text).toContain("D-23");
      expect(text).toContain("betalt sky");
    }
    // en sky-leverandør sier at SECRET_RESTRICTED ikke berøres
    expect(actionOf(await build().run(), "ai.pause:anthropic").description_no).toContain("SECRET_RESTRICTED");
    // regelen er uendret: sensitivitetsreglene i ruteren (ikke teksten) avgjør - SECRET_RESTRICTED kun lokal, PRIVATE/BUSINESS_CONFIDENTIAL tillater betalt sky
    expect(isSensitivityEligible(CLOUD_PROFILE, "SECRET_RESTRICTED")).toBe(false);
    expect(isSensitivityEligible(CLOUD_PROFILE, "PRIVATE")).toBe(true);
    expect(isSensitivityEligible(CLOUD_PROFILE, "BUSINESS_CONFIDENTIAL")).toBe(true);
    expect(isSensitivityEligible(LOCAL_PROFILE, "SECRET_RESTRICTED")).toBe(true);
  });

  it("pauset leverandør: «Gjenoppta» = unfreeze_connector (krever step-up) i stedet for pause; raden er WARN og sier PAUSET", async () => {
    const r = await build({ frozen: ["model:anthropic"] }).run();
    expect(actionIds(r)).toContain("ai.resume:anthropic");
    expect(actionIds(r)).not.toContain("ai.pause:anthropic");
    expect(actionOf(r, "ai.resume:anthropic")).toMatchObject({ body: { action: "unfreeze_connector", parameters: { connector_id: "model:anthropic" } }, requires_step_up: true, risk_class: "C" });
    expect(item(r, "providers", "anthropic")).toMatchObject({ status: "WARN", facts: { paused: true, paused_by_freeze: true } });
    expect(item(r, "providers", "anthropic").detail_no).toContain("PAUSET av eier");
  });

  it("pauset LOKAL leverandør: raden sier at sensitive turer ikke har noen lokal modell, og «sensitive turer»-punktet blir WARN (fail-closed, aldri sky)", async () => {
    const r = await build({ frozen: ["model:gemma_local"] }).run();
    expect(item(r, "providers", "gemma_local").detail_no).toContain("aldri sky");
    const sensitive = item(r, "routing", "sensitive_local");
    expect(sensitive.status).toBe("WARN");
    expect(sensitive.detail_no).toContain("feiler lukket");
    expect(sensitive.facts).toMatchObject({ usable_local: null, paused_local: "gemma_local" });
    const ok = item(await build().run(), "routing", "sensitive_local");
    expect(ok.status).toBe("OK");
  });

  it("registrerte leverandører (anthropic/openai/gemini): «Tilbakekall nøkkel» = revoke_credential på leverandørens ref (klasse C, step-up); øvrige (gemma_*) har kun pause", async () => {
    const r = await build().run();
    expect(actionOf(r, "ai.revoke:anthropic:ANTHROPIC_API_KEY")).toMatchObject({
      endpoint: "/executive/mutate", body: { action: "revoke_credential", parameters: { credential_ref: "ANTHROPIC_API_KEY" } }, risk_class: "C", requires_step_up: true, reversible: true
    });
    expect(actionIds(r).filter((x) => x.startsWith("ai.revoke:"))).toEqual(["ai.revoke:anthropic:ANTHROPIC_API_KEY", "ai.revoke:openai:OPENAI_API_KEY"]); // gemini er ikke konfigurert
    expect(actionIds(r).some((x) => x.startsWith("ai.revoke:gemma"))).toBe(false);
  });

  it("tilbakekalt nøkkel: raden er WARN med «TILBAKEKALT», «Gjenopprett» tilbys i stedet for tilbakekall, og leverandørene som deler nøkkelen vises som pauset", async () => {
    const r = await build({ revoked: ["GEMINI_API_KEY"], rows: [...DEFAULT_ROWS().filter((x) => x.provider !== "gemini"), row("gemini")] }).run();
    expect(item(r, "providers", "gemini")).toMatchObject({ status: "WARN", facts: { paused: true, revoked_credentials: "GEMINI_API_KEY" } });
    expect(item(r, "providers", "gemini").detail_no).toContain("TILBAKEKALT");
    expect(actionOf(r, "ai.restore:gemini:GEMINI_API_KEY")).toMatchObject({ body: { action: "restore_credential", parameters: { credential_ref: "GEMINI_API_KEY" } }, requires_step_up: true });
    expect(actionIds(r)).not.toContain("ai.revoke:gemini:GEMINI_API_KEY");
    expect(item(r, "providers", "gemma_hosted").facts).toMatchObject({ paused: true }); // deler GEMINI_API_KEY
  });

  it("tilbakekall beskriver hva nøkkelen deles med (GEMINI_API_KEY: gemma_hosted og andre connectorer) før eieren trykker", async () => {
    const r = await build({ rows: [...DEFAULT_ROWS().filter((x) => x.provider !== "gemini"), row("gemini")] }).run();
    const text = actionOf(r, "ai.revoke:gemini:GEMINI_API_KEY").description_no;
    expect(text).toContain("deles med");
    expect(text).toContain("gemma_hosted");
  });

  it("hver handling: lukket endepunkt, navn på rutens allowlist, step-up = rutens krav, risikoklasse = verktøyets, ingen identitet/hemmelighet i kroppen, unik id, forankret", async () => {
    const r = await build({
      frozen: ["model:openai"], revoked: ["OPENAI_API_KEY"],
      tasks: [taskRow("task-1", { status: "running" }), taskRow("task-2", { status: "created", claimed_at: null, lease_expires_at: null })]
    }).run();
    expect(r.actions.length).toBeGreaterThan(6);
    expect(new Set(actionIds(r)).size).toBe(r.actions.length);
    for (const a of r.actions) {
      expect((CONTROL_ACTION_ENDPOINTS as readonly string[]).includes(a.endpoint), a.id).toBe(true);
      const name = String(a.body["action"]);
      expect(CONTROL_ACTION_ALLOWED[a.endpoint], a.id).toContain(name);
      const params = (a.body["parameters"] ?? {}) as Record<string, unknown>;
      for (const forbidden of ["tenant_id", "person_id", "actor_person_id", "owner_person_id", "session_id", "value", "grant_token", "secret"]) expect(params, `${a.id}:${forbidden}`).not.toHaveProperty(forbidden);
      expect(a.requires_step_up, a.id).toBe(actionRequiresStepUp(name));
      expect(stepUpDenial({ auth_strength: "bearer" as never, channel: "web" }, name) === undefined, a.id).toBe(!a.requires_step_up);
      expect(a.risk_class, a.id).toBe(defs.find((d) => d.tool_id === "executive" && d.action === name)?.capability_class);
      expect(a.section_id, a.id).toBeDefined();
      expect(a.item_id, a.id).toBeDefined();
    }
  });
});

describe("ruting", () => {
  it("Gemma først: kjeden og andelene (lokal/sky) fra vellykkede kall; ingen brukbar leverandør i kjeden gir WARN og sier fallback (D-354)", async () => {
    const r = await build().run();
    const g = item(r, "routing", "gemma_first");
    expect(g.status).toBe("OK");
    expect(g.facts).toMatchObject({ chain: "gemma_local, gemma_hosted", usable: "gemma_local, gemma_hosted", local_share_7d: 0.8, cloud_share_7d: 0.2, ok_calls_7d: 100 });
    expect(g.detail_no).toContain("80 %");
    const none = item(await build({ rows: [row("anthropic"), row("gemma_local", { health: { state: "UNAVAILABLE", circuit: "open" } }), row("gemma_hosted", { configured: false, health: { state: "NOT_CONFIGURED" } })] }).run(), "routing", "gemma_first");
    expect(none.status).toBe("WARN");
    expect(none.detail_no).toContain("D-354");
  });

  it("verktøyturer (D-431): standardrute Sonnet; pauset leverandør eller nådd dagstak gir WARN og sier at turene går lokalt; av = lokalt; ugyldig verdi = av", async () => {
    const def = item(await build({ env: {} }).run(), "routing", "tool_turn_route");
    expect(def.status).toBe("OK");
    expect(def.facts).toMatchObject({ route: "anthropic:claude-sonnet-5-5", daily_cap_ore: 3000, spent_today_ore: 1200, cap_reached: false });
    const paused = item(await build({ env: {}, frozen: ["model:anthropic"] }).run(), "routing", "tool_turn_route");
    expect(paused.status).toBe("WARN");
    expect(paused.detail_no).toContain("pauset av deg");
    expect(paused.detail_no).toContain("lokal modell");
    const capped = item(await build({ env: {}, daily: 3500 }).run(), "routing", "tool_turn_route");
    expect(capped.status).toBe("WARN");
    expect(capped.facts).toMatchObject({ cap_reached: true });
    expect(capped.detail_no).toContain("dagstaket");
    const off = item(await build({ env: { JARVIS_TOOL_TURN_MODEL: "off" } }).run(), "routing", "tool_turn_route");
    expect(off).toMatchObject({ status: "OK", facts: { route: "off" } });
    const invalid = item(await build({ env: { JARVIS_TOOL_TURN_MODEL: "ikke en rute" } }).run(), "routing", "tool_turn_route");
    expect(invalid.facts).toMatchObject({ route: "off" });
  });

  it("jobbrute (D-449): følger chattens rute med mindre JARVIS_JOB_TOOL_TURN_MODEL sier noe annet (off = lokalt)", async () => {
    expect(item(await build({ env: {} }).run(), "routing", "job_route").facts).toMatchObject({ route: "anthropic:claude-sonnet-5-5" });
    expect(item(await build({ env: { JARVIS_JOB_TOOL_TURN_MODEL: "off" } }).run(), "routing", "job_route").facts).toMatchObject({ route: "off" });
    expect(item(await build({ env: { JARVIS_JOB_TOOL_TURN_MODEL: "anthropic:claude-haiku-4-5-20251001" } }).run(), "routing", "job_route").facts).toMatchObject({ route: "anthropic:claude-haiku-4-5-20251001" });
  });

  it("dagstaket 0 = ingen tak (sies); dagens kost som ikke kan leses gjør ruten UKJENT, ikke i orden", async () => {
    const none = item(await build({ env: { JARVIS_TOOL_TURN_DAILY_CAP_ORE: "0" } }).run(), "routing", "tool_turn_route");
    expect(none.detail_no).toContain("ingen dagstak");
    const unreadable = item(await build({ env: {}, daily: new Error("boom") }).run(), "routing", "tool_turn_route");
    expect(unreadable.status).toBe("UNKNOWN");
  });

  it("siste rutevalg per tur-type vises med leverandør, lokalitet og om det var via fallback; kostradene som ikke kan leses gjør seksjonen UKJENT", async () => {
    const r = await build().run();
    expect(item(r, "routing", "last:CHAT")).toMatchObject({ status: "OK", facts: { provider: "gemma_local", locality: "local", fallback: false } });
    expect(item(r, "routing", "last:BACKGROUND").detail_no).toContain("via fallback");
    const bad = await build({ usage: new Error("boom"), lastRoutes: new Error("boom") }).run();
    expect(section(bad, "routing").status).toBe("UNKNOWN");
    expect(section(bad, "routing").summary_no).toContain("Kostradene kunne ikke leses");
    expect(item(bad, "routing", "gemma_first").facts).toMatchObject({ local_share_7d: null });
  });

  it("sensitivitetsrutingen kan ikke endres herfra: ingen handling endrer ruting, kun leverandørstopp og avbryt", async () => {
    const r = await build({ tasks: [taskRow("task-1")] }).run();
    const names = new Set(r.actions.map((a) => String(a.body["action"])));
    for (const n of names) expect(["freeze_connector", "unfreeze_connector", "revoke_credential", "restore_credential", "cancel_task"], n).toContain(n);
  });
});

describe("kost", () => {
  it("månedsbudsjett: under varsel OK, over varsel WARN, over godkjenning/hardgrense FAIL (modellkall stoppes); uleselig er UKJENT", async () => {
    expect(item(await build({ monthly: 50_000 }).run(), "cost", "budget").status).toBe("OK");
    expect(item(await build({ monthly: 120_000 }).run(), "cost", "budget").status).toBe("WARN");
    const approval = item(await build({ monthly: 250_000 }).run(), "cost", "budget");
    expect(approval.status).toBe("FAIL");
    expect(approval.detail_no).toContain("STOPPES");
    expect(item(await build({ monthly: 350_000 }).run(), "cost", "budget").status).toBe("FAIL");
    expect(item(await build({ monthly: new Error("boom") }).run(), "cost", "budget").status).toBe("UNKNOWN");
    expect(item(await build({ env: { JARVIS_COST_WARN_ORE: "500000", JARVIS_COST_APPROVAL_ORE: "200000" } }).run(), "cost", "budget").status).toBe("UNKNOWN");
  });

  it("prognose, dagens kost og kost per leverandør/modell fra run-rate; prognose over hardgrensen gir WARN; for lite data er UKJENT", async () => {
    const r = await build().run();
    expect(item(r, "cost", "run_rate")).toMatchObject({ status: "OK", facts: { today_ore: 1200, projected_month_ore: 34000, hard_limit_ore: 300_000 } });
    expect(item(r, "cost", "cost:anthropic:claude-x").facts).toMatchObject({ calls_30d: 40, ore_30d: 25000 });
    expect(item(r, "cost", "cost:gemma_local:gemma3").detail_no).toContain("lokal");
    expect(item(await build({ runRate: { totals: { today_ore: 0, last_7d_ore: 0, last_30d_ore: 0, projected_month_ore: 400_000 } } }).run(), "cost", "run_rate").status).toBe("WARN");
    expect(item(await build({ runRate: { totals: { today_ore: 0, last_7d_ore: 0, last_30d_ore: 0, projected_month_ore: null } } }).run(), "cost", "run_rate").status).toBe("UNKNOWN");
    expect(section(r, "cost").summary_no).toContain("Ikke målt");
  });

  it("run-rate som mangler eller feiler er UKJENT; feilteksten (med nøkkelform) lekker aldri", async () => {
    expect(item(await build({ runRate: "absent" }).run(), "cost", "run_rate").status).toBe("UNKNOWN");
    const bad = await build({ runRate: "error" }).run();
    expect(item(bad, "cost", "run_rate").status).toBe("UNKNOWN");
    expect(JSON.stringify(bad)).not.toContain("sk-ant");
  });

  it("en leverandør/modell med mange feilede kall får WARN", async () => {
    const r = await build({ runRate: { by_provider: [{ provider: "openai", model: "gpt-x", local: false, calls: 10, failed_calls: 5, ore: 100, tokens_in: 1, tokens_out: 1 }] } }).run();
    expect(item(r, "cost", "cost:openai:gpt-x").status).toBe("WARN");
  });
});

describe("evals og modellrådgiver", () => {
  it("rådgivermodus vises (av/skygge/aktiv); skyggeavvik er ikke målt her og sies", async () => {
    for (const mode of ["off", "shadow", "active"] as const) {
      const a = item(await build({ advisor: mode }).run(), "evals", "advisor");
      expect(a.facts).toMatchObject({ mode });
      expect(a.status).toBe("OK");
    }
    expect(item(await build({ advisor: "shadow" }).run(), "evals", "advisor").detail_no).toContain("ikke målt her");
  });

  it("EV-12 fra evolusjonsrapporten: OK→OK, ATTENTION→WARN, DORMANT/UNKNOWN→UKJENT; mangler/feil/ingen seksjon er UKJENT", async () => {
    expect(item(await build({ evolution: { status: "OK" } }).run(), "evals", "ev12_shadow_route").status).toBe("OK");
    expect(item(await build({ evolution: { status: "ATTENTION" } }).run(), "evals", "ev12_shadow_route").status).toBe("WARN");
    expect(item(await build({ evolution: { status: "DORMANT" } }).run(), "evals", "ev12_shadow_route").status).toBe("UNKNOWN");
    for (const evolution of ["absent", "error", "none"] as const) expect(item(await build({ evolution }).run(), "evals", "ev12_shadow_route").status, evolution).toBe("UNKNOWN");
  });
});

describe("parallell delegering og overhead", () => {
  it("AI-rådets auto-trigger: brukte plasser; taket nådd gir WARN; mangler/feil er UKJENT", async () => {
    expect(item(await build({ limiter: { used: 1, max: 3 } }).run(), "delegation", "council_auto")).toMatchObject({ status: "OK", facts: { used_in_window: 1, max_per_window: 3, acquired_since_start: 5, denied_since_start: 2 } });
    const reached = item(await build({ limiter: { used: 3, max: 3 } }).run(), "delegation", "council_auto");
    expect(reached.status).toBe("WARN");
    expect(reached.detail_no).toContain("taket er nådd");
    expect(item(await build({ limiter: "absent" }).run(), "delegation", "council_auto").status).toBe("UNKNOWN");
    expect(item(await build({ limiter: "error" }).run(), "delegation", "council_auto").status).toBe("UNKNOWN");
  });

  it("samtidige bakgrunnsjobber mot taket: nådd gir WARN (pauset og ikke-delegerte teller ikke)", async () => {
    const many = Array.from({ length: 5 }, (_, i) => taskRow(`task-d${i}`));
    const at = item(await build({ tasks: many, maxActiveJobs: 5 }).run(), "delegation", "background_jobs");
    expect(at).toMatchObject({ status: "WARN", facts: { active_delegated: 5, max_active: 5 } });
    const mixed = [...many.slice(0, 3), taskRow("task-p", { status: "paused" }), taskRow("task-n", { delegated: false })];
    expect(item(await build({ tasks: mixed, maxActiveJobs: 5 }).run(), "delegation", "background_jobs")).toMatchObject({ status: "OK", facts: { active_delegated: 3 } });
  });

  it("kost på jobber (7 d), ekstra kall og spesialist-delegering (ikke koblet inn = ikke en feil)", async () => {
    const r = await build({ usage: [usageRow("anthropic", "CHAT", 20, { critic_calls: 3, fallback_calls: 2, failed_calls: 1 })] }).run();
    expect(item(r, "delegation", "task_cost").facts).toMatchObject({ task_calls_7d: 30, all_calls_7d: 100, task_ore_7d: 2000, all_ore_7d: 5000 });
    expect(item(r, "delegation", "extra_calls").facts).toMatchObject({ critic_calls_7d: 3, fallback_calls_7d: 2, failed_calls_7d: 1 });
    expect(item(r, "delegation", "specialist")).toMatchObject({ status: "OK", facts: { wired: false } });
    expect(item(await build({ delegation: new Error("boom") }).run(), "delegation", "task_cost").status).toBe("UNKNOWN");
  });
});

describe("kjørende agenter og jobber", () => {
  it("én rad per aktiv jobb med profil, status, forsøk og lease - ALDRI tittel, resultat eller feiltekst, selv om raden ved et uhell bar dem", async () => {
    const r = await build({
      tasks: [taskRow("task-secret-1", { goal: "Les e-posten fra banken og send kontonummer til eve@example.com", result: { text: "RESULTATMARKOER" }, last_error: "sk-ant-api03-ABCDEFGHIJKLMNOP FEILMARKOER" })]
    }).run();
    const t = item(r, "agents", "task-secret-1");
    expect(t.label).toContain("Assistentjobb");
    expect(t.label).toContain("(fra chat)");
    expect(t.facts).toMatchObject({ agent_profile: "executive", status: "running", attempts: 1, max_attempts: 3, delegated_from_chat: true, cancel_requested: false });
    const json = JSON.stringify(r);
    for (const forbidden of ["banken", "eve@example.com", "RESULTATMARKOER", "FEILMARKOER", "sk-ant"]) expect(json, forbidden).not.toContain(forbidden);
  });

  it("SQL-en leser aldri goal, result eller last_error-tekst (kun «finnes feil»), og kjører under identitetens tenant", async () => {
    const { pool, run } = build();
    await run();
    const sql = pool.queries.filter((q) => /FROM tasks/.test(q.sql)).map((q) => q.sql).join("\n");
    expect(sql).not.toMatch(/\bgoal\b/);
    expect(sql).not.toMatch(/\bresult\b/);
    expect(sql).toContain("(last_error IS NOT NULL) AS has_error");
    expect(sql).not.toMatch(/last_error\s*[,\n]/);
    for (const q of pool.queries.filter((q2) => /FROM tasks/.test(q2.sql))) expect(q.tenant).toBe("tenant-owner");
  });

  it("avbryt tilbys kun for ikke startet og kjørende jobb som ikke allerede er bedt om å stoppe; pauset og allerede forespurt får ingen knapp", async () => {
    const r = await build({
      tasks: [taskRow("task-run"), taskRow("task-new", { status: "created", claimed_at: null, lease_expires_at: null }), taskRow("task-pause", { status: "paused" }), taskRow("task-stop", { cancel_requested: true })]
    }).run();
    expect(actionIds(r).filter((x) => x.startsWith("agent.cancel:")).sort()).toEqual(["agent.cancel:task-new", "agent.cancel:task-run"]);
    expect(item(r, "agents", "task-stop").detail_no).toContain("avbrudd er forespurt");
    expect(item(r, "agents", "task-stop").status).toBe("WARN");
    expect(item(r, "agents", "task-pause").detail_no).toContain("kan ikke avbrytes herfra");
    expect(actionOf(r, "agent.cancel:task-run")).toMatchObject({
      endpoint: "/executive/mutate", body: { action: "cancel_task", parameters: { task_id: "task-run" } }, risk_class: "B", requires_step_up: false, reversible: false, section_id: "agents", item_id: "task-run"
    });
    expect(actionOf(r, "agent.cancel:task-run").rollback_no).toContain("Kan ikke angres");
    expect(actionOf(r, "agent.cancel:task-new").description_no).toContain("umiddelbart");
    expect(actionOf(r, "agent.cancel:task-run").description_no).toContain("rulles IKKE tilbake");
  });

  it("L-2: avbryt-dialogen viser kun etikett og beskrivelse, så BEGGE identifiserer jobben (profil + kort id) - to jobber av samme profil kan skilles, og en lang id forkortes", async () => {
    const long = "3f2a1b9c-d6e4-4c1a-9a77-0b5f3c2d1e00";
    const r = await build({ tasks: [taskRow("task-run"), taskRow(long, { status: "created", claimed_at: null, lease_expires_at: null, agent_profile: "coding" })] }).run();
    const run = actionOf(r, "agent.cancel:task-run");
    const created = actionOf(r, `agent.cancel:${long}`);
    expect(run.label).toBe("Avbryt assistentjobb task-run");
    expect(run.description_no).toContain("«task-run»");
    expect(created.label).toBe("Avbryt kodejobb 3f2a1b9c-d6e4…");
    expect(created.description_no).toContain("«3f2a1b9c-d6e4…»");
    expect(new Set([run.label, created.label]).size).toBe(2);
    // hele id-en står i kroppen (det som sendes) og på raden, aldri avkortet der
    expect(created.body).toMatchObject({ parameters: { task_id: long } });
  });

  it("tegn på at en jobb ikke er frisk gir WARN: utløpt lease, kjørt lenge, i kø uten å bli tatt, tidligere feil", async () => {
    const r = await build({
      tasks: [
        taskRow("task-lease", { lease_expires_at: ago(5 * MIN) }),
        taskRow("task-long", { claimed_at: ago(LONG_RUNNING_MS + MIN) }),
        taskRow("task-queued", { status: "created", claimed_at: null, lease_expires_at: null, created_at: ago(QUEUED_STALE_MS + MIN) }),
        taskRow("task-err", { has_error: true, attempts: 2 }),
        taskRow("task-fine")
      ]
    }).run();
    expect(item(r, "agents", "task-lease").status).toBe("WARN");
    expect(item(r, "agents", "task-lease").detail_no).toContain("worker borte");
    expect(item(r, "agents", "task-long").status).toBe("WARN");
    expect(item(r, "agents", "task-queued").detail_no).toContain("uten å bli tatt av en worker");
    expect(item(r, "agents", "task-err").detail_no).toContain("forsøk 2 av 3");
    expect(item(r, "agents", "task-fine").status).toBe("OK");
  });

  it("sammendraget teller kjørende/ventende/pauset og utfall siste 24 t; jobber som ikke kan leses er en UKJENT-seksjon", async () => {
    const r = await build().run();
    expect(section(r, "agents").summary_no).toContain("1 kjører");
    expect(section(r, "agents").summary_no).toContain("7 ferdige, 1 feilet, 2 avbrutt");
    const bad = await build({ tasks: new Error("boom") }).run();
    expect(section(bad, "agents")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(item(bad, "delegation", "background_jobs").status).toBe("UNKNOWN");
  });
});

describe("kun lesing, identitetsbundet, fail-soft og uten hemmeligheter", () => {
  it("alle spørringer er SELECT og tenant-skopede; ingen bruker en annen tenant enn identitetens", async () => {
    const { pool, run } = build();
    await run();
    expect(pool.queries.length).toBeGreaterThan(5);
    for (const q of pool.queries) expect(q.sql.trim().toUpperCase().startsWith("SELECT"), q.sql.slice(0, 60)).toBe(true);
    expect([...pool.tenantsUsed()]).toEqual(["tenant-owner"]);
  });

  it("hver kilde kan feile alene: kun de berørte delene blir UKJENT, resten måles, og ingen feiltekst lekker", async () => {
    const r = await build({
      usage: new Error("connect ECONNREFUSED 10.0.0.9:5432 password=PWMARKER123"), lastRoutes: new Error("x"), delegation: new Error("x"), counts: new Error("x"), controlsFail: new Error("sk-ant-api03-ABCDEFGHIJKLMNOP")
    }).run();
    expect(r.sections.map((s) => s.id)).toEqual(["providers", "routing", "cost", "evals", "delegation", "agents"]);
    expect(section(r, "providers").status).toBe("UNKNOWN");
    expect(section(r, "cost").items.length).toBeGreaterThan(1); // kost måles fortsatt
    expect(section(r, "agents").items.length).toBeGreaterThan(0);
    const json = JSON.stringify(r);
    for (const forbidden of ["10.0.0.9", "PWMARKER123", "sk-ant", "ECONNREFUSED"]) expect(json, forbidden).not.toContain(forbidden);
  });

  it("begrunnelsestekst fra eierbryterne (frys/tilbakekall) leses og vises aldri", async () => {
    const r = await build({ frozen: ["model:anthropic"], revoked: ["OPENAI_API_KEY"] }).run();
    expect(JSON.stringify(r)).not.toContain("privat grunn");
  });
});

describe("kobling og drift", () => {
  it("registerControlCenters kobler AI Center kun med ModelGateway, verktøyregister og eier-kontroller", () => {
    const { deps } = build();
    const gw = { list: () => defs, get: () => undefined, hasSecret: async () => false, health: new Map() } as never;
    const full = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(full, { pool: deps.pool, env: {}, toolGateway: gw, ownerControls: deps.ownerControls as never, modelGateway: deps.gateway });
    expect(full.list().map((c) => c.id)).toEqual(["integration", "ai"]);
    const noGateway = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(noGateway, { pool: deps.pool, env: {}, toolGateway: gw, ownerControls: deps.ownerControls as never });
    expect(noGateway.list().map((c) => c.id)).toEqual(["integration"]);
    const nothing = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(nothing, { pool: deps.pool, env: {} });
    expect(nothing.list()).toEqual([]);
  });

  it("taket for samtidige jobber og Gemma-kjeden speiler koden (ingen egen kopi som kan drive)", () => {
    expect(DEFAULT_MAX_ACTIVE_JOBS).toBe(MAX_ACTIVE_JOBS);
    const conversation = readFileSync(resolve(REPO_ROOT, "apps/api/src/conversation.ts"), "utf8");
    expect(conversation).toContain(`["${GEMMA_FIRST_CHAIN.join('", "')}"]`);
  });

  it("main.ts kobler AI Center til de ekte tjenestene og deler begrenseren med chatten", () => {
    expect(existsSync(resolve(REPO_ROOT, "apps/api/src/control-center/ai.ts"))).toBe(true);
    const main = readFileSync(resolve(REPO_ROOT, "apps/api/src/main.ts"), "utf8");
    expect(main).toContain("modelGateway: gateway, runRate: new RunRateService(pool), councilLimiter: councilAutoLimiter, evolutionReport: evolutionReports, maxActiveJobs: MAX_ACTIVE_JOBS");
    expect(main).toMatch(/new ConversationEngine\(\{\s*councilAutoLimiter,/);
    expect(main).toContain("tasks: { cancel: (identity, taskId) => taskService.cancel(identity, taskId) }");
  });
});
