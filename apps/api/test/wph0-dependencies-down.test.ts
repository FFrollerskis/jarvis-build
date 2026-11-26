import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ControlCenterRegistry, type ControlCenterReport, type ControlSection, type ControlStatus } from "@jarvis/executive";
import type { ProviderHealthDetail, ProviderOverviewRow } from "@jarvis/model-gateway";
import { CONNECTOR_REGISTRY, type ToolDefinition } from "@jarvis/tool-gateway";
import { createAiCenter } from "../src/control-center/ai.ts";
import { createAuthorityCenter } from "../src/control-center/authority.ts";
import { CONNECTOR_HEALTH_SWEEP_JOB, CONNECTOR_SYNC_JOBS, createIntegrationCenter } from "../src/control-center/integration.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { ScriptedPool, type ScriptedRule } from "./support/scripted-pool.ts";

/**
 * WP-H0, gjennomgang av PR #316 (M-1): MATRISEN. For hvert senter (Integration, Authority, AI) og HVER avhengighet byggeren leser:
 *  1. grunnscenarioet har det som avhenger av avhengigheten «i orden» (ellers beviser ikke testen noe),
 *  2. er avhengigheten NEDE (kaster / svarer ikke / kan ikke måles), er ingen seksjon eller element som hviler på den OK - alltid UKJENT eller verre, aldri «i orden»,
 *  3. er ALLE avhengigheter nede samtidig, står kun det som er statisk kode/konfigurasjon igjen som OK, og det er en eksplisitt, lukket liste.
 * Funnet som utløste dette: Infisical nede ga «ikke konfigurert» med status OK for alle 50 tilkoblinger, fordi en feil ble til «mangler» (to-state presence) i stedet for «ukjent».
 */
const NOW = new Date("2026-10-09T12:00:00.000Z");
const H = 3_600_000;
const MIN = 60_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const identity: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "dev-current", channel: "web", auth_strength: "signed" };
const defs: ToolDefinition[] = productionToolDefinitions();
const boom = (): Error => Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:5432 password=hunter22"), { name: "DatabaseError" });

const sectionOf = (r: ControlCenterReport, id: string): ControlSection => {
  const s = r.sections.find((x) => x.id === id);
  if (!s) throw new Error(`mangler seksjon ${id}`);
  return s;
};
// «seksjon» = seksjonens status, «seksjon/element» = elementets, «*/element» = elementet i den seksjonen det står i (et element kan flyttes mellom seksjoner når en måling feiler).
const statusOf = (r: ControlCenterReport, ref: string): ControlStatus => {
  const [sectionId, itemId] = ref.split("/") as [string, string | undefined];
  if (itemId === undefined) return sectionOf(r, sectionId).status;
  const sections = sectionId === "*" ? r.sections : [sectionOf(r, sectionId)];
  const i = sections.flatMap((s) => s.items).find((x) => x.id === itemId);
  if (!i) throw new Error(`mangler element ${ref}`);
  return i.status;
};
/** Alt i rapporten som står som OK: seksjons-id-er og «seksjon/element»-referanser, sortert. */
const okRefs = (r: ControlCenterReport): string[] => r.sections.flatMap((s) => [...(s.status === "OK" ? [s.id] : []), ...s.items.filter((i) => i.status === "OK").map((i) => `${s.id}/${i.id}`)]).sort();

interface Dependency {
  name: string;
  /** Seksjoner og «seksjon/element»-referanser som hviler på avhengigheten og derfor aldri kan være OK når den er nede. */
  affected: string[];
}

/** Felles sjekk: grunnscenarioet er OK for alt som avhenger av avhengigheten, og nede er det aldri OK. */
async function checkDependency(build: (down: ReadonlySet<string>) => Promise<ControlCenterReport>, dep: Dependency): Promise<void> {
  const base = await build(new Set());
  const down = await build(new Set([dep.name]));
  for (const ref of dep.affected) {
    expect(statusOf(base, ref), `${dep.name}: ${ref} skal være OK i grunnscenarioet (ellers er testen tom)`).toBe("OK");
    expect(statusOf(down, ref), `${dep.name} nede: ${ref} skal ikke være OK`).not.toBe("OK");
  }
  // feilmeldingen (med passord/adresse) lekker aldri til rapporten, bare kategorien
  expect(JSON.stringify(down)).not.toContain("hunter22");
  expect(JSON.stringify(down)).not.toContain("10.0.0.9");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// INTEGRATION
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const INTEGRATION_IDS = ["github", "gmail", "anthropic", "slack", "apple_music"];
const integrationRegistry = INTEGRATION_IDS.map((id) => CONNECTOR_REGISTRY.find((c) => c.id === id)!);
const refsOf = (id: string): string[] => CONNECTOR_REGISTRY.find((c) => c.id === id)!.credential_refs;
const PRESENT = new Set([...refsOf("github"), ...refsOf("gmail"), ...refsOf("anthropic")]);
const JOB_NAMES = [...new Set([CONNECTOR_HEALTH_SWEEP_JOB, ...Object.values(CONNECTOR_SYNC_JOBS).flat()])];

async function buildIntegration(down: ReadonlySet<string>): Promise<ControlCenterReport> {
  const fails = (name: string): Error | null => (down.has(name) ? boom() : null);
  const rules: ScriptedRule[] = [
    { match: /DISTINCT ON \(tool_id, action\)/, rows: fails("audit") ?? [] },
    { match: /FROM audit_events[\s\S]*GROUP BY tool_id, action/, rows: fails("audit") ?? [] },
    { match: /FROM cost_events/, rows: fails("providers") ?? [] },
    { match: /FROM scheduler_state/, rows: fails("jobs") ?? JOB_NAMES.map((job_name) => ({ job_name, last_completed_at: ago(2 * H), last_open: false, last_had_error: false, last_attempts: 1 })) },
    { match: /FROM connector_maintenance_log/, rows: fails("maintenance") ?? [] }
  ];
  const center = createIntegrationCenter({
    pool: new ScriptedPool(rules).asPool(),
    registry: integrationRegistry,
    toolGateway: {
      secretPresence: async (ref: string) => (down.has("credentials") ? null : PRESENT.has(ref)),
      secretsHealth: () => (down.has("credentials") ? "unavailable" : "healthy"),
      health: new Map([["github", { state: "healthy", at: ago(H) }], ["email", { state: "healthy", at: ago(H) }]]),
      list: () => defs,
      get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a)
    } as never,
    ownerControls: {
      listFrozenConnectorsDurable: async () => { if (down.has("controls")) throw boom(); return []; },
      listRevokedCredentialsDurable: async () => []
    },
    meshStatus: () => { if (down.has("mesh")) throw boom(); return { providers: [{ provider: "anthropic", model: "claude-x", state: "LIVE", success: 5, failures: 0 }] as never }; }
  });
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center);
  return (await registry.report("integration", identity)) as ControlCenterReport;
}

const INTEGRATION_ITEMS_BUILT = ["*/github", "*/gmail", "*/anthropic", "*/slack"];
const INTEGRATION_SECTIONS_MEASURED = ["live", "configured_other", "not_configured"];

const integrationDeps: Dependency[] = [
  // credential-kilden (Infisical): hver bygd tilkobling og alle tre tilkoblingsseksjonene
  { name: "credentials", affected: [...INTEGRATION_SECTIONS_MEASURED, ...INTEGRATION_ITEMS_BUILT] },
  // frys/tilbakekall: også en ukonfigurert tilkobling kan være pauset/tilbakekalt
  { name: "controls", affected: [...INTEGRATION_SECTIONS_MEASURED, ...INTEGRATION_ITEMS_BUILT] },
  { name: "audit", affected: ["live", "configured_other"] },
  { name: "providers", affected: ["live", "configured_other"] },
  { name: "jobs", affected: ["jobs", "live", "configured_other", "*/gmail"] },
  { name: "maintenance", affected: ["maintenance"] },
  { name: "mesh", affected: ["live", "configured_other", "*/anthropic"] }
];

describe("Integration Center: hver avhengighet nede ⇒ ingenting som hviler på den er OK", () => {
  for (const dep of integrationDeps) {
    it(`${dep.name} nede`, async () => { await checkDependency(buildIntegration, dep); });
  }

  it("grunnscenarioet er friskt: alt som måles er OK (så matrisen over ikke er tom)", async () => {
    const base = await buildIntegration(new Set());
    expect(okRefs(base)).toEqual(expect.arrayContaining([...INTEGRATION_SECTIONS_MEASURED, "jobs", "maintenance", "backlog", "live/github", "live/gmail", "configured_other/anthropic", "not_configured/slack"]));
    expect(base.status).toBe("OK");
  });

  it("ALLE avhengigheter nede samtidig: hver bygd tilkobling og hver målt seksjon er UKJENT - kun backlog (statisk registerinnhold, ingenting å måle) står som OK", async () => {
    const all = await buildIntegration(new Set(integrationDeps.map((d) => d.name)));
    expect(all.status).toBe("UNKNOWN");
    const ok = okRefs(all);
    expect(ok.filter((ref) => !ref.startsWith("backlog"))).toEqual([]);
    expect(ok).toContain("backlog");
    for (const s of all.sections.filter((x) => x.id !== "backlog")) expect(s.status, s.id).toBe("UNKNOWN");
    for (const i of INTEGRATION_ITEMS_BUILT) expect(statusOf(all, i), i).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// AUTHORITY
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const AUTHORITY = { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] };
const dev = (device_id: string, person_id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  device_id, person_id, kind: "web", created_at: ago(100 * H), revoked_at: null, role: person_id === "person-owner" ? "owner" : "member", active_grants: 1, last_grant_at: ago(2 * H), ...over
});

async function buildAuthority(down: ReadonlySet<string>): Promise<ControlCenterReport> {
  const fails = (name: string): Error | null => (down.has(name) ? boom() : null);
  const rules: ScriptedRule[] = [
    { match: /FROM devices d/, rows: fails("devices") ?? [dev("dev-current", "person-owner"), dev("dev-delegate", "person-delegate")] },
    { match: /SELECT DISTINCT domain FROM situations/, rows: fails("autonomy") ?? [{ domain: "finance" }] },
    { match: /AS n FROM situation_autonomy_policies/, rows: fails("autonomy") ?? [{ n: 0 }] },
    { match: /FROM situation_autonomy_policies/, rows: fails("autonomy") ?? [{ memory_space_id: "business", domain: "finance", tool_id: "business", action: "create_followup", enabled: true, updated_at: ago(30 * H) }] },
    { match: /FROM situation_domain_pauses/, rows: fails("pauses") ?? [] },
    { match: /FROM finance_kill_switch/, rows: fails("finance") ?? [] },
    { match: /FROM action_confirmations/, rows: fails("confirmations") ?? [] }
  ];
  const flags = down.has("flags") ? undefined : { class_d_pipeline_enforced: true, credential_binding_active: true };
  const center = createAuthorityCenter({
    pool: new ScriptedPool(rules).asPool(),
    env: { JARVIS_GIT_ALLOWED_REPOS: "tsworkflow/jarvisbuild" },
    authority: AUTHORITY,
    toolGateway: {
      list: () => { if (down.has("manifest")) throw boom(); return defs; },
      get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a),
      ...(flags === undefined ? {} : { policyFlags: () => flags })
    },
    ownerControls: {
      listFrozenConnectorsDurable: async () => { if (down.has("controls")) throw boom(); return []; },
      listRevokedCredentialsDurable: async () => []
    },
    killSwitch: { currentStateDurable: async () => { if (down.has("kill")) throw boom(); return null; } },
    infraGate: {
      statusDurable: async () => {
        if (down.has("infra")) throw boom();
        return { state: { mode: "NORMAL" as const, at: ago(H) }, local: { mode: "NORMAL" as const, at: ago(H) }, shared: null, shared_readable: true, in_sync: true };
      }
    }
  });
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center);
  return (await registry.report("authority", identity)) as ControlCenterReport;
}

const authorityDeps: Dependency[] = [
  { name: "kill", affected: ["switches", "switches/kill_switch"] },
  { name: "finance", affected: ["switches", "switches/finance_kill_switch"] },
  { name: "infra", affected: ["switches", "switches/infra_mode"] },
  { name: "controls", affected: ["pauses"] },
  // domene-pausene: pauseseksjonen OG autonomi-bindingene (en aktiv binding i et domene vi ikke vet er pauset er ukjent, ikke «i orden»)
  { name: "pauses", affected: ["pauses", "autonomy/business:finance"] },
  { name: "devices", affected: ["authority", "authority/delegates", "devices"] },
  { name: "autonomy", affected: ["autonomy"] },
  { name: "confirmations", affected: ["confirmations"] },
  { name: "flags", affected: ["policies", "policies/class_d_pipeline", "policies/credential_binding"] },
  { name: "manifest", affected: ["risk_classes"] }
];

describe("Authority Center: hver avhengighet nede ⇒ ingenting som hviler på den er OK", () => {
  for (const dep of authorityDeps) {
    it(`${dep.name} nede`, async () => { await checkDependency(buildAuthority, dep); });
  }

  it("ALLE avhengigheter nede samtidig: kun det som er ren kode/konfigurasjon (eier-konfig, policyer fra miljøet, eksterne grenser) står som OK - en lukket liste", async () => {
    const all = await buildAuthority(new Set(authorityDeps.map((d) => d.name)));
    expect(all.status).toBe("UNKNOWN");
    expect(okRefs(all)).toEqual([
      "authority/owner", "external",
      "external/code_job_repos", "external/destination_hosts", "external/github_repo",
      "policies/budget", "policies/infra_targets", "policies/memory_auto_approve", "policies/step_up", "policies/tool_turn_cap"
    ].sort());
    for (const id of ["authority", "devices", "autonomy", "switches", "pauses", "risk_classes", "policies", "confirmations"]) expect(sectionOf(all, id).status, id).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const health = (over: Partial<ProviderHealthDetail> = {}): ProviderHealthDetail => ({ state: "LIVE", success: 10, failures: 0, consecutive_failures: 0, circuit: "closed", last_success_at: ago(5 * MIN), ...over });
const row = (provider: string, over: Partial<Omit<ProviderOverviewRow, "health">> & { health?: Partial<ProviderHealthDetail> } = {}): ProviderOverviewRow => {
  const { health: h, ...rest } = over;
  const local = provider === "gemma_local";
  return { provider, model: `${provider}-m`, locality: local ? "local" : "cloud", hosted_free_tier: provider === "gemma_hosted", configured: true, health: health(h), ...rest };
};
const AI_ROWS = (): ProviderOverviewRow[] => [
  row("anthropic"), row("gemma_hosted"), row("gemma_local"),
  // konfigurert, men aldri bevist og ikke på noen rute: OK når bruken er kjent (ubrukt), ukjent når vi ikke vet om den er i bruk
  row("openai", { health: { state: "CONFIGURED", success: 0, last_success_at: undefined as never } })
];

async function buildAi(down: ReadonlySet<string>): Promise<ControlCenterReport> {
  const fails = (name: string): Error | null => (down.has(name) ? boom() : null);
  const rules: ScriptedRule[] = [
    { match: /date_trunc\('day', now\(\) AT TIME ZONE/, rows: fails("daily") ?? [{ spent: 1200 }] },
    { match: /date_trunc\('month'/, rows: fails("budget") ?? [{ spent: 40_000 }] },
    { match: /GROUP BY provider, purpose/, rows: fails("usage") ?? [
      { provider: "gemma_local", purpose: "CHAT", ok_calls: 80, failed_calls: 0, fallback_calls: 0, critic_calls: 0, ore: 0, last_ok_at: ago(H), last_fallback_at: null },
      { provider: "anthropic", purpose: "CHAT", ok_calls: 20, failed_calls: 0, fallback_calls: 0, critic_calls: 0, ore: 900, last_ok_at: ago(H), last_fallback_at: null }
    ] },
    { match: /DISTINCT ON \(purpose\)/, rows: fails("lastRoute") ?? [{ purpose: "CHAT", provider: "gemma_local", model: "gemma3", fallback: false, at: ago(10 * MIN) }] },
    { match: /AS task_calls/, rows: fails("delegation") ?? [{ all_calls: 100, all_ore: 5000, task_calls: 30, task_ore: 2000, task_failed: 1 }] },
    { match: /FROM tasks[\s\S]*GROUP BY status/, rows: fails("counts") ?? [{ status: "running", n: 1 }, { status: "completed", n: 7 }] },
    { match: /FROM tasks/, rows: fails("tasks") ?? [{
      task_id: "task-aaaa1111-0000", status: "running", attempts: 1, created_at: ago(30 * MIN), claimed_at: ago(20 * MIN), lease_expires_at: ahead(40_000), worker_id: "worker-1",
      cancel_requested: false, has_error: false, agent_profile: "executive", max_attempts: 3, delegated: true, network_targets: 0
    }] }
  ];
  const center = createAiCenter({
    pool: new ScriptedPool(rules).asPool(),
    env: { JARVIS_GITHUB_REPO: "x/y" },
    gateway: {
      providerOverview: () => { if (down.has("overview")) throw boom(); return AI_ROWS(); },
      meshStatus: () => ({ router: "HEALTHY", fallback: "READY" }),
      routingAdvisorMode: "shadow"
    },
    ownerControls: {
      listFrozenConnectorsDurable: async () => { if (down.has("controls")) throw boom(); return []; },
      listRevokedCredentialsDurable: async () => []
    },
    toolGateway: { get: (t: string, a: string) => defs.find((d) => d.tool_id === t && d.action === a) },
    runRate: {
      report: async () => {
        if (down.has("runRate")) throw boom();
        return {
          as_of: NOW.toISOString(), totals: { today_ore: 1200, last_7d_ore: 8000, last_30d_ore: 30000, projected_month_ore: 34000 }, cloud_share_30d: 0.4,
          by_provider: [{ provider: "anthropic", model: "claude-x", local: false, calls: 40, failed_calls: 1, ore: 25000, tokens_in: 100000, tokens_out: 20000 }],
          by_purpose: [], daily: [], maintenance: { minutes_30d: 0, by_connector: [], recent: [] }, value_loop: { brief_days_30d: 3 }, not_measured: [], summary_no: "x"
        } as never;
      }
    },
    councilLimiter: {
      usage: () => {
        if (down.has("limiter")) throw boom();
        return { max_per_window: 3, window_ms: 3_600_000, used_in_window: 1, acquired_total: 5, denied_total: 2 };
      }
    },
    evolutionReport: async () => {
      if (down.has("evolution")) throw boom();
      return { sections: [{ ev: "EV-12", title_no: "Modellrute i skygge", mode: "observe" as const, status: "OK" as const, summary_no: "Kritiske arbeidsflyter har ≥2 leverandører.", findings: [], source: "modellmeshen", observed_at: NOW.toISOString() }] };
    }
  });
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center);
  return (await registry.report("ai", identity)) as ControlCenterReport;
}

const aiDeps: Dependency[] = [
  // pause/tilbakekall: ukjent hvilke leverandører som er brukbare
  { name: "controls", affected: ["providers", "providers/anthropic", "providers/gemma_local", "routing", "routing/gemma_first", "routing/sensitive_local", "routing/tool_turn_route", "routing/job_route"] },
  // kostradene (7 d): en ubevist leverandør kan ikke sies å være ubrukt når bruken er ukjent; ekstra kall kan ikke utelates stille
  { name: "usage", affected: ["providers", "providers/openai", "routing", "delegation", "delegation/extra_calls"] },
  { name: "lastRoute", affected: ["routing"] },
  { name: "delegation", affected: ["delegation", "delegation/task_cost"] },
  { name: "daily", affected: ["routing/tool_turn_route", "routing/job_route"] },
  { name: "budget", affected: ["cost", "cost/budget"] },
  { name: "runRate", affected: ["cost", "cost/run_rate"] },
  { name: "tasks", affected: ["agents", "delegation", "delegation/background_jobs"] },
  { name: "counts", affected: ["agents"] },
  { name: "limiter", affected: ["delegation", "delegation/council_auto"] },
  { name: "overview", affected: ["providers", "routing/gemma_first", "routing/tool_turn_route", "routing/job_route"] }
];

describe("AI Center: hver avhengighet nede ⇒ ingenting som hviler på den er OK", () => {
  for (const dep of aiDeps) {
    it(`${dep.name} nede`, async () => { await checkDependency(buildAi, dep); });
  }

  it("evolusjonsrapporten nede: EV-12 er UKJENT (evals-seksjonen er alltid UKJENT fordi golden-suiten er DEFERRED)", async () => {
    const base = await buildAi(new Set());
    const down = await buildAi(new Set(["evolution"]));
    expect(statusOf(base, "evals/ev12_shadow_route")).toBe("OK");
    expect(statusOf(down, "evals/ev12_shadow_route")).toBe("UNKNOWN");
    expect(statusOf(base, "evals")).toBe("UNKNOWN");
  });

  it("ALLE avhengigheter nede samtidig: ingen seksjon er OK, og kun det som er statisk kode (rådgivermodus i minnet, spesialist-delegering ikke koblet inn) står igjen som OK-element", async () => {
    const all = await buildAi(new Set([...aiDeps.map((d) => d.name), "evolution"]));
    expect(all.status).toBe("UNKNOWN");
    for (const s of all.sections) expect(s.status, s.id).not.toBe("OK");
    expect(okRefs(all)).toEqual(["delegation/specialist", "evals/advisor"]);
  });
});
