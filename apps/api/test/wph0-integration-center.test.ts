import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { CONTROL_ACTION_ALLOWED, CONTROL_ACTION_ENDPOINTS, ControlCenterRegistry, explainControlCenterNo, type ControlCenterReport, type ControlSection } from "@jarvis/executive";
import { CONNECTOR_REGISTRY, type ToolDefinition } from "@jarvis/tool-gateway";
import {
  CONNECTOR_API_FACTS, CONNECTOR_HEALTH_SWEEP_JOB, CONNECTOR_SYNC_JOBS, classifyFailureReason, connectorViews, createIntegrationCenter, effectiveHealth, healthStatus, jobState, memoryHealth,
  type HealthEvidence
} from "../src/control-center/integration.ts";
import { registerControlCenters } from "../src/control-center/register.ts";
import { EXECUTIVE_MUTATE_ACTIONS, OWNER_CONTROLS_CONNECTOR_ACTIONS } from "../src/server.ts";
import { actionRequiresStepUp, stepUpDenial } from "../src/step-up.ts";
import { productionToolDefinitions } from "./support/production-tools.ts";
import { ScriptedPool, type ScriptedRule } from "./support/scripted-pool.ts";

/**
 * WP-H0 Integration Center - ENHETSTESTER (ingen database; ekte SQL mot ekte tabeller bevises i wph0-integration-center-db.test.ts):
 *  1. ren logikk: feilkategorier, «siste måling vinner», eldre «i orden» er ikke bevis, jobbforsinkelse;
 *  2. connector-kartleggingen mot de REELLE verktøydefinisjonene (hvilke handlinger/credentials/frys-mål hører til hvilken connector);
 *  3. rapporten: seksjoner, status per connector, ingen secrets/feiltekster, kun lesing, identitetsbundet tenant, ukjent ≠ i orden;
 *  4. handlingene: peker kun på eksisterende ruter, speiler rutenes allowlist, step-up-merket = rutens faktiske krav, ingen hemmelighets-skriving;
 *  5. drift: API-versjon-evidens finnes i koden, synk-jobbene finnes i main.ts, allowlistene i kontrakten = rutenes.
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const NOW = new Date("2026-10-09T12:00:00.000Z");
const H = 3_600_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const identity: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const defs: ToolDefinition[] = productionToolDefinitions();
const refsOf = (id: string): string[] => CONNECTOR_REGISTRY.find((c) => c.id === id)?.credential_refs ?? [];

interface Scenario {
  secrets?: string[];
  secretsThrow?: string[];
  health?: Record<string, { state: string; hoursAgo: number }>;
  frozen?: string[];
  revoked?: string[];
  audit?: Array<Record<string, unknown>>;
  failures?: Array<Record<string, unknown>>;
  providers?: Array<Record<string, unknown>>;
  jobs?: Array<Record<string, unknown>>;
  maintenance?: Array<Record<string, unknown>>;
  mesh?: Array<{ provider: string; model: string; state: string; success: number; failures: number }> | Error;
  failSources?: Partial<Record<"audit" | "providers" | "jobs" | "maintenance" | "controls", Error>>;
}

const BASE_SECRETS = [...refsOf("github"), ...refsOf("gmail"), ...refsOf("google_calendar"), ...refsOf("telegram"), ...refsOf("stripe"), ...refsOf("anthropic"), ...refsOf("higgsfield"), refsOf("vipps")[0] as string];
const job = (name: string, hoursAgo: number | null, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  job_name: name, last_completed_at: hoursAgo === null ? null : ago(hoursAgo * H), last_open: false, last_had_error: false, last_attempts: 1, ...extra
});

function build(scn: Scenario = {}): { gateway: ReturnType<typeof makeGateway>; pool: ScriptedPool; run: () => Promise<ControlCenterReport> } {
  const have = new Set(scn.secrets ?? BASE_SECRETS);
  const gateway = makeGateway(have, scn);
  const rules: ScriptedRule[] = [
    { match: /DISTINCT ON \(tool_id, action\)/, rows: scn.failSources?.audit ?? scn.failures ?? [] },
    { match: /FROM audit_events[\s\S]*GROUP BY tool_id, action/, rows: scn.failSources?.audit ?? scn.audit ?? [] },
    { match: /FROM cost_events/, rows: scn.failSources?.providers ?? scn.providers ?? [] },
    { match: /FROM scheduler_state/, rows: scn.failSources?.jobs ?? scn.jobs ?? [] },
    { match: /FROM connector_maintenance_log/, rows: scn.failSources?.maintenance ?? scn.maintenance ?? [] }
  ];
  const pool = new ScriptedPool(rules);
  const center = createIntegrationCenter({
    pool: pool.asPool(), toolGateway: gateway as never,
    ownerControls: {
      listFrozenConnectorsDurable: async () => { if (scn.failSources?.controls) throw scn.failSources.controls; return (scn.frozen ?? []).map((connector_id) => ({ connector_id, reason: "x", actor_person_id: "person-owner", changed_at: ago(5 * H) })); },
      listRevokedCredentialsDurable: async () => (scn.revoked ?? []).map((credential_ref) => ({ credential_ref, reason: "x", actor_person_id: "person-owner", changed_at: ago(7 * H) }))
    },
    ...(scn.mesh !== undefined ? { meshStatus: () => { if (scn.mesh instanceof Error) throw scn.mesh; return { providers: (scn.mesh ?? []) as never }; } } : {})
  });
  const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
  registry.register(center);
  return { gateway, pool, run: async () => (await registry.report("integration", identity)) as ControlCenterReport };
}

function makeGateway(have: Set<string>, scn: Scenario) {
  return {
    hasSecret: async (ref: string) => { if (scn.secretsThrow?.includes(ref)) throw new Error(`infisical unreachable ${ref}`); return have.has(ref); },
    health: new Map(Object.entries(scn.health ?? {}).map(([tool, v]) => [tool, { state: v.state, at: ago(v.hoursAgo * H) }])),
    list: () => defs,
    get: (tool: string, action: string) => defs.find((d) => d.tool_id === tool && d.action === action)
  };
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

describe("ren logikk: feilkategori, siste måling vinner, jobbforsinkelse", () => {
  it("feilkategori utledes av årsaken - kun kategorien forlater funksjonen", () => {
    const table: Array<[string, string]> = [
      ["github_http_401", "auth"], ["Request failed: 403 Forbidden", "auth"], ["invalid_grant", "auth"], ["token expired", "auth"], ["unauthorized", "auth"],
      ["429 Too Many Requests", "rate_limit"], ["rate_limit_exceeded", "rate_limit"],
      ["tool_timeout", "timeout"], ["request timed out", "timeout"],
      ["fetch failed", "network"], ["gmail_http_503", "network"], ["ECONNRESET", "network"], ["getaddrinfo ENOTFOUND api.example.com", "network"],
      ["missing_parameter:repo", "other"], ["github_http_404", "other"], ["", "other"]
    ];
    for (const [reason, expected] of table) expect(classifyFailureReason(reason), reason).toBe(expected);
    expect(classifyFailureReason(null)).toBe("other");
    expect(classifyFailureReason(undefined)).toBe("other");
  });

  it("siste måling vinner; likt tidspunkt: den verste; uten måling: null", () => {
    const at = (h: number): string => ago(h * H);
    const e = (state: HealthEvidence["state"], h: number): HealthEvidence => ({ state, at: at(h), source: "audit" });
    expect(effectiveHealth([])).toBeNull();
    expect(effectiveHealth([null, undefined])).toBeNull();
    expect(effectiveHealth([e("healthy", 5), e("auth_failed", 2)])?.state).toBe("auth_failed");
    expect(effectiveHealth([e("auth_failed", 5), e("healthy", 1)])?.state).toBe("healthy");
    expect(effectiveHealth([e("healthy", 3), e("unavailable", 3)])?.state).toBe("unavailable");
    expect(effectiveHealth([{ state: "healthy", at: "ikke-en-dato", source: "audit" }])).toBeNull();
  });

  it("status: healthy → OK bare når fersk; gammel «i orden» er UKJENT (ikke OK); feil → FAIL/WARN; ingen måling → UNKNOWN", () => {
    const n = NOW.getTime();
    const hs = (state: HealthEvidence["state"], h: number) => healthStatus({ state, at: ago(h * H), source: "memory" }, n);
    expect(hs("healthy", 1)).toBe("OK");
    expect(hs("healthy", 35)).toBe("OK");
    expect(hs("healthy", 37)).toBe("UNKNOWN");
    expect(hs("degraded", 1)).toBe("WARN");
    expect(hs("rate_limited", 1)).toBe("WARN");
    expect(hs("auth_failed", 100)).toBe("FAIL");
    expect(hs("unavailable", 1)).toBe("FAIL");
    expect(healthStatus(null, n)).toBe("UNKNOWN");
  });

  it("ToolGateway-helse: ukjent tilstand regnes som degradert, aldri som frisk; manglende oppføring er null", () => {
    expect(memoryHealth(undefined)).toBeNull();
    expect(memoryHealth({ state: "healthy", at: ago(H) })?.state).toBe("healthy");
    expect(memoryHealth({ state: "noe-nytt", at: ago(H) })?.state).toBe("degraded");
  });

  it("jobbtilstand: ingen rad er UKJENT (ikke OK), aldri fullført/forsinket/feilet er WARN, fersk er OK", () => {
    const n = NOW.getTime();
    const row = (hours: number | null, extra: Partial<{ last_open: boolean; last_had_error: boolean; last_attempts: number }> = {}) => ({
      job_name: "j", last_completed_at: hours === null ? null : ago(hours * H), last_open: false, last_had_error: false, last_attempts: 1, ...extra
    });
    expect(jobState(undefined, n).status).toBe("UNKNOWN");
    expect(jobState(row(null), n).status).toBe("WARN");
    expect(jobState(row(10), n)).toMatchObject({ status: "OK", lag_hours: 10 });
    expect(jobState(row(40), n).status).toBe("WARN");
    expect(jobState(row(40), n).detail_no).toContain("forsinket");
    expect(jobState(row(5, { last_open: true, last_had_error: true, last_attempts: 3 }), n)).toMatchObject({ status: "WARN" });
    expect(jobState(row(5, { last_open: true, last_had_error: false }), n).status).toBe("OK");
  });
});

describe("connector-kartlegging mot de reelle verktøydefinisjonene", () => {
  const presence = new Map<string, boolean | null>();
  for (const c of CONNECTOR_REGISTRY) for (const r of c.credential_refs) presence.set(r, true);
  const views = connectorViews(CONNECTOR_REGISTRY, defs, presence);
  const view = (id: string) => views.find((v) => v.def.id === id)!;

  it("57 oppføringer, hver med nøyaktig én visning; backlog er ikke bygget", () => {
    expect(views).toHaveLength(CONNECTOR_REGISTRY.length);
    expect(new Set(views.map((v) => v.def.id)).size).toBe(views.length);
    const backlog = views.filter((v) => !v.built).map((v) => v.def.id).sort();
    expect(backlog).toEqual(CONNECTOR_REGISTRY.filter((c) => c.category.startsWith("backlog")).map((c) => c.id).sort());
    for (const v of views.filter((x) => !x.built)) {
      expect(v.configured, v.def.id).toBe("no");
      expect(v.freeze_target, v.def.id).toBeNull();
      expect(v.tool_ids, v.def.id).toEqual([]);
    }
  });

  it("Kalender og Drive deler Google-token men er hver sin connector med hvert sitt verktøy", () => {
    expect(view("google_calendar").tool_ids).toEqual(["calendar"]);
    expect(view("google_drive").tool_ids).toEqual(["drive"]);
    expect(view("google_calendar").effective_refs).toEqual(["JARVIS_GOOGLE_TOKEN"]);
    expect(view("google_drive").effective_refs).toEqual(["JARVIS_GOOGLE_TOKEN"]);
    expect(view("google_calendar").freeze_target).toBe("calendar");
    expect(view("google_drive").freeze_target).toBe("drive");
  });

  it("Gmail eier e-postverktøyet og support.reply (som bruker e-posttokenet), og kan fryses på email", () => {
    const gmail = view("gmail");
    expect(gmail.tool_ids).toEqual(["email", "support"]);
    expect(gmail.action_keys).toContain("support.reply");
    expect(gmail.action_keys).toContain("email.send");
    expect(gmail.action_keys).not.toContain("support.create_ticket");
    expect(gmail.effective_refs).toEqual(["JARVIS_EMAIL_TOKEN"]);
    expect(gmail.freeze_target).toBe("email");
  });

  it("FRYS TILBYS IKKE for verktøy som også har interne handlinger (finans - der nødbryteren bor); tilbakekall av leverandør-credentialen tilbys i stedet", () => {
    for (const id of ["fiken", "stripe", "vipps", "neonomics", "wallester"]) {
      const v = view(id);
      expect(v.freeze_target, id).toBeNull();
      expect(v.effective_refs.length, id).toBeGreaterThan(0);
      expect(v.effective_refs, id).not.toContain("JARVIS_BUSINESS_INTERNAL_TOKEN");
    }
    expect(view("fiken").effective_refs).toEqual(["JARVIS_FIKEN_REFRESH_TOKEN"]);
    expect(view("stripe").effective_refs).toEqual(["JARVIS_STRIPE_SECRET_KEY"]);
  });

  it("rene leverandørverktøy kan fryses på sitt eget tool_id", () => {
    for (const [id, tool] of [["github", "github"], ["telegram", "telegram"], ["slack", "slack"], ["notion", "notion"], ["home_assistant", "home-assistant"], ["playwright", "browser"], ["higgsfield", "higgsfield"], ["kling", "kling"]] as const) {
      expect(view(id).freeze_target, id).toBe(tool);
    }
  });

  it("modellleverandørene har ingen ToolGateway-verktøy - ingen frys/tilbakekall herfra (pause hører til AI-senteret)", () => {
    for (const id of ["anthropic", "openai", "gemini"]) {
      expect(view(id).tool_ids, id).toEqual([]);
      expect(view(id).freeze_target, id).toBeNull();
      expect(view(id).effective_refs, id).toEqual([]);
    }
  });

  it("delvis konfigurert og ukjent presence skilles fra ikke konfigurert", () => {
    const p = new Map<string, boolean | null>([["JARVIS_VIPPS_CLIENT_ID", true]]);
    const v = connectorViews(CONNECTOR_REGISTRY, defs, p).find((x) => x.def.id === "vipps")!;
    expect(v.configured).toBe("unknown");
    p.set("JARVIS_VIPPS_CLIENT_SECRET", false);
    expect(connectorViews(CONNECTOR_REGISTRY, defs, p).find((x) => x.def.id === "vipps")!.configured).toBe("partial");
    const none = new Map<string, boolean | null>();
    for (const r of refsOf("vipps")) none.set(r, false);
    expect(connectorViews(CONNECTOR_REGISTRY, defs, none).find((x) => x.def.id === "vipps")!.configured).toBe("no");
  });

  it("scopes er unionen av handlingenes deklarerte scopes (sortert)", () => {
    const github = view("github").required_scopes;
    expect(github).toContain("repo:read");
    expect([...github].sort()).toEqual(github);
  });
});

describe("rapporten: seksjoner og status per connector", () => {
  it("alle seks seksjoner finnes, og hver oppføring i registeret står i nøyaktig ÉN seksjon (ingenting utelates stille)", async () => {
    const r = await build({}).run();
    expect(r.sections.map((s) => s.id)).toEqual(["live", "configured_other", "not_configured", "maintenance", "jobs", "backlog"]);
    const ids = ["live", "configured_other", "not_configured", "backlog"].flatMap((s) => section(r, s).items.map((i) => i.id));
    expect(ids).toHaveLength(CONNECTOR_REGISTRY.length);
    expect(new Set(ids).size).toBe(CONNECTOR_REGISTRY.length);
    expect(ids.sort()).toEqual(CONNECTOR_REGISTRY.map((c) => c.id).sort());
    expect(section(r, "backlog").items).toHaveLength(CONNECTOR_REGISTRY.filter((c) => c.category.startsWith("backlog")).length);
    for (const i of section(r, "backlog").items) expect(i.facts).toMatchObject({ built: false, configured: false });
    // en bygd connector bærer ALLE kravene som fakta uten at kontraktens tak (24 fakta per element) kutter noe
    expect(Object.keys(item(r, "live", "gmail").facts ?? {}).length).toBeLessThanOrEqual(24);
    expect(item(r, "live", "gmail").facts).toHaveProperty("credential_revoked");
  });

  it("senteret er merket PRIVATE, kilde og målt-tidspunkt står på hver målte seksjon, og rapporten får klokken fra registeret", async () => {
    const r = await build({}).run();
    expect(r.sensitivity).toBe("PRIVATE");
    expect(r.generated_at).toBe(NOW.toISOString());
    for (const s of r.sections) {
      expect(s.source.length, s.id).toBeGreaterThan(5);
      expect(s.measured, s.id).toBe(true);
      expect(s.observed_at, s.id).toBe(NOW.toISOString());
    }
  });

  it("frisk måling i minnet gir OK; autentiseringsfeil gir FAIL; rate-begrensning gir WARN; gammel «i orden» gir UKJENT", async () => {
    const r = await build({
      health: { github: { state: "healthy", hoursAgo: 1 }, calendar: { state: "auth_failed", hoursAgo: 2 }, telegram: { state: "rate_limited", hoursAgo: 3 } }
    }).run();
    expect(item(r, "live", "github").status).toBe("OK");
    expect(item(r, "live", "github").detail_no).toContain("i orden");
    expect(item(r, "live", "google_calendar").status).toBe("FAIL");
    expect(item(r, "live", "google_calendar").detail_no).toContain("autentisering feilet");
    expect(item(r, "live", "telegram").status).toBe("WARN");
    const stale = await build({ health: { github: { state: "healthy", hoursAgo: 40 } } }).run();
    expect(item(stale, "live", "github").status).toBe("UNKNOWN");
    expect(item(stale, "live", "github").detail_no).toContain("ikke bekreftet");
  });

  it("connector uten noen måling er UKJENT (aldri OK) - og senteret kan da ikke være OK", async () => {
    const r = await build({}).run();
    expect(item(r, "live", "github").status).toBe("UNKNOWN");
    expect(item(r, "live", "github").detail_no).toContain("ikke målt");
    expect(r.status).not.toBe("OK");
  });

  it("revisjonssporet er DURABELT bevis: siste vellykkede kall gir OK uten minnehelse, og et senere auth-avslag overstyrer et eldre OK (kun kategorien vises)", async () => {
    const secretLeak = "gmail_http_401 Bearer sk-ant-api03-ABCDEFGHIJKLMNOP token expired";
    const ok = await build({
      audit: [{ tool_id: "email", action: "read_inbox", last_ok_at: ago(2 * H), last_fail_at: ago(30 * H), ok_24h: 5, fail_24h: 1 }],
      failures: [{ tool_id: "email", action: "read_inbox", reason: secretLeak }],
      jobs: [job("business-events-sync", 5), job("conversation-graph-sync", 5), job("support-inbox-sync", 5)]
    }).run();
    const gmail = item(ok, "live", "gmail");
    expect(gmail.status).toBe("OK");
    expect(gmail.detail_no).toContain("siste feil: autentisering");
    expect(gmail.detail_no).toContain("senere vellykket");
    expect(gmail.facts).toMatchObject({ last_failure_category: "auth", calls_ok_24h: 5, calls_failed_24h: 1 });

    const bad = await build({
      audit: [{ tool_id: "email", action: "read_inbox", last_ok_at: ago(30 * H), last_fail_at: ago(2 * H), ok_24h: 1, fail_24h: 3 }],
      failures: [{ tool_id: "email", action: "read_inbox", reason: secretLeak }],
      jobs: [job("business-events-sync", 5), job("conversation-graph-sync", 5), job("support-inbox-sync", 5)]
    }).run();
    expect(item(bad, "live", "gmail").status).toBe("FAIL");
    const json = JSON.stringify(bad);
    for (const leak of ["sk-ant", "Bearer", "ABCDEFGHIJKLMNOP", "gmail_http_401", "token expired"]) expect(json, leak).not.toContain(leak);
  });

  it("feil som ikke er helsebevis (valideringsfeil, 404) flipper ikke status, men vises ærlig", async () => {
    const r = await build({
      audit: [{ tool_id: "github", action: "read_issues", last_ok_at: ago(3 * H), last_fail_at: ago(1 * H), ok_24h: 4, fail_24h: 1 }],
      failures: [{ tool_id: "github", action: "read_issues", reason: "missing_parameter:repo" }]
    }).run();
    const gh = item(r, "live", "github");
    expect(gh.status).toBe("OK");
    expect(gh.detail_no).toContain("annen feil");
    expect(gh.detail_no).toContain("regnes ikke som helsebevis");
  });

  it("synk-forsinkelse: forsinket jobb gir WARN på connectoren, manglende rad gir UKJENT, fersk gir OK - og viser verste forsinkelse", async () => {
    const fresh = [job("business-events-sync", 5), job("conversation-graph-sync", 6), job("support-inbox-sync", 7)];
    const okRun = await build({ health: { email: { state: "healthy", hoursAgo: 1 } }, jobs: fresh }).run();
    expect(item(okRun, "live", "gmail").status).toBe("OK");
    expect(item(okRun, "live", "gmail").facts).toMatchObject({ sync_jobs: "business-events-sync, conversation-graph-sync, support-inbox-sync", sync_lag_hours: 7 });

    const late = await build({ health: { email: { state: "healthy", hoursAgo: 1 } }, jobs: [fresh[0]!, fresh[1]!, job("support-inbox-sync", 60)] }).run();
    expect(item(late, "live", "gmail").status).toBe("WARN");
    expect(item(late, "live", "gmail").detail_no).toContain("support-inbox-sync");
    expect(item(late, "live", "gmail").detail_no).toContain("forsinket");
    expect(item(late, "live", "gmail").facts).toMatchObject({ sync_lag_hours: 60 });

    const missing = await build({ health: { email: { state: "healthy", hoursAgo: 1 } }, jobs: [fresh[0]!] }).run();
    expect(item(missing, "live", "gmail").status).toBe("UNKNOWN");
    expect(item(missing, "live", "gmail").detail_no).toContain("ingen kjøring registrert");
  });

  it("modellleverandører: mesh LIVE → OK, UNAVAILABLE → FAIL, CONFIGURED uten bevis → UKJENT; kostnadsrader gir durabelt bevis", async () => {
    const secrets = [...BASE_SECRETS, ...refsOf("openai"), ...refsOf("gemini")];
    const r = await build({
      secrets,
      mesh: [
        { provider: "anthropic", model: "m", state: "LIVE", success: 4, failures: 0 },
        { provider: "openai", model: "m", state: "UNAVAILABLE", success: 0, failures: 3 },
        { provider: "gemini", model: "m", state: "CONFIGURED", success: 0, failures: 0 }
      ]
    }).run();
    expect(item(r, "configured_other", "anthropic").status).toBe("OK");
    expect(item(r, "configured_other", "openai").status).toBe("FAIL");
    expect(item(r, "configured_other", "gemini").status).toBe("UNKNOWN");
    const proven = await build({ secrets, mesh: [{ provider: "gemini", model: "m", state: "CONFIGURED", success: 0, failures: 0 }], providers: [{ provider: "gemini", last_ok_at: ago(2 * H), last_fail_at: null }] }).run();
    expect(item(proven, "configured_other", "gemini").status).toBe("OK");
    // uten mesh-status oppgitt er leverandørhelse ukjent, ikke frisk
    const noMesh = await build({ secrets: BASE_SECRETS }).run();
    expect(item(noMesh, "configured_other", "anthropic").status).toBe("UNKNOWN");
  });

  it("konfigurert men uten live-test og uten bevis er UKJENT (higgsfield), og sier det", async () => {
    const r = await build({}).run();
    const h = item(r, "configured_other", "higgsfield");
    expect(h.status).toBe("UNKNOWN");
    expect(h.facts).toMatchObject({ test_method: "presence_only", auth_health: "ikke målt" });
  });

  it("delvis konfigurert (vipps) er WARN og nevner hva som mangler (navn, aldri verdier); helt ukonfigurert er OK (bevisst valg)", async () => {
    const r = await build({}).run();
    const vipps = item(r, "not_configured", "vipps");
    expect(vipps.status).toBe("WARN");
    expect(vipps.detail_no).toContain("delvis konfigurert");
    expect(vipps.detail_no).toContain("JARVIS_VIPPS_CLIENT_SECRET");
    expect(vipps.facts).toMatchObject({ configuration: "partial", credentials_present: "1/4" });
    const slack = item(r, "not_configured", "slack");
    expect(slack.status).toBe("OK");
    expect(slack.detail_no).toContain("ikke konfigurert");
  });

  it("credential-kilden som svikter gjør kun den connectoren UKJENT (konfigurasjon kunne ikke leses), ikke hele senteret", async () => {
    const r = await build({ secretsThrow: ["JARVIS_GITHUB_TOKEN"] }).run();
    const gh = item(r, "not_configured", "github");
    expect(gh.status).toBe("UNKNOWN");
    expect(gh.detail_no).toContain("kunne ikke leses");
    expect(item(r, "live", "gmail")).toBeDefined();
  });

  it("en kilde som feiler gjør berørte tall ukjente med feilKATEGORI (aldri meldingen), mens resten av senteret fortsatt leses", async () => {
    const r = await build({
      health: { github: { state: "healthy", hoursAgo: 1 } },
      failSources: { audit: Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:5432 password=hunter22"), { name: "DatabaseError" }) }
    }).run();
    const live = section(r, "live");
    expect(live.status).toBe("UNKNOWN");
    expect(live.summary_no).toContain("Kunne ikke leses");
    expect(live.summary_no).toContain("revisjonssporet");
    expect(live.summary_no).toContain("DatabaseError");
    expect(JSON.stringify(r)).not.toContain("hunter22");
    expect(JSON.stringify(r)).not.toContain("10.1.2.3");
    expect(item(r, "live", "github").status).toBe("OK");
    expect(item(r, "live", "github").facts).toMatchObject({ calls_ok_24h: null, calls_failed_24h: null });
  });

  it("jobber/vedlikehold som ikke kan leses er egne UNKNOWN-seksjoner (measured:false), ikke «OK»", async () => {
    const r = await build({ secrets: refsOf("github"), failSources: { jobs: new Error("boom"), maintenance: new Error("boom") } }).run();
    expect(section(r, "jobs")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(section(r, "maintenance")).toMatchObject({ status: "UNKNOWN", measured: false });
    expect(r.status).toBe("UNKNOWN");
  });

  it("eier-kontrolltilstanden som ikke kan leses gjør seksjonene ukjente (vi vet ikke om noe er pauset)", async () => {
    const r = await build({ failSources: { controls: new Error("down") } }).run();
    expect(section(r, "live").status).toBe("UNKNOWN");
    expect(section(r, "live").summary_no).toContain("eier-kontrolltilstanden");
  });

  it("pauset (frosset) og tilbakekalt vises på connectoren som WARN, også for en ukonfigurert connector", async () => {
    const r = await build({ frozen: ["github", "slack"], revoked: ["JARVIS_EMAIL_TOKEN"] }).run();
    expect(item(r, "live", "github").status).toBe("WARN");
    expect(item(r, "live", "github").detail_no).toContain("PAUSET");
    expect(item(r, "live", "github").facts).toMatchObject({ paused: true });
    expect(item(r, "live", "gmail").detail_no).toContain("TILBAKEKALT: JARVIS_EMAIL_TOKEN");
    expect(item(r, "live", "gmail").facts).toMatchObject({ credential_revoked: true });
    expect(item(r, "not_configured", "slack").status).toBe("WARN");
  });

  it("vedlikehold: minutter, hendelser, siste kategori og vedlikeholdseier; kobler på connector-id ELLER verktøy-id; høy tid gir WARN; ukjente navn telles", async () => {
    const r = await build({
      maintenance: [
        { connector_id: "github", events: 2, minutes: 240, last_at: ago(48 * H), last_kind: "api_change", last_by: "person-owner" },
        { connector_id: "email", events: 1, minutes: 30, last_at: ago(5 * H), last_kind: "credential_rotation", last_by: "person-owner" },
        { connector_id: "skrivefeil-navn", events: 3, minutes: 12, last_at: ago(5 * H), last_kind: "other", last_by: "person-x" }
      ]
    }).run();
    const m = section(r, "maintenance");
    expect(item(r, "maintenance", "github")).toMatchObject({ status: "WARN", facts: { minutes_30d: 240, events_30d: 2, last_event_kind: "api_change", maintenance_owner: "person-owner" } });
    expect(item(r, "maintenance", "gmail")).toMatchObject({ status: "OK", facts: { minutes_30d: 30 } });
    expect(item(r, "maintenance", "_unmatched").facts).toMatchObject({ events_30d: 3, minutes_30d: 12 });
    expect(m.summary_no).toContain("282 min");
    expect(item(r, "live", "github").facts).toMatchObject({ maintenance_minutes_30d: 240, maintenance_owner: "person-owner" });
  });

  it("API-versjon vises der koden vet den, ellers UKJENT - og utfasing er aldri «ingen» uten bevis", async () => {
    const r = await build({ secrets: [...BASE_SECRETS, ...refsOf("todoist"), ...refsOf("jira")] }).run();
    expect(item(r, "live", "github").facts).toMatchObject({ api_version: "X-GitHub-Api-Version 2022-11-28" });
    expect(String(item(r, "live", "github").facts?.["api_deprecation"])).toContain("ukjent");
    expect(String(item(r, "live", "todoist").facts?.["api_deprecation"])).toContain("pensjonert");
    expect(String(item(r, "live", "jira").facts?.["api_version"])).toContain("ukjent");
  });

  it("scopes: deklarerte (krevde) vises per connector; at innvilgede scopes ikke måles sies i seksjonen (aldri påstått som kjent)", async () => {
    const r = await build({}).run();
    const f = item(r, "live", "github").facts!;
    expect(String(f["required_scopes"])).toContain("repo:read");
    expect(f).not.toHaveProperty("granted_scopes");
    expect(section(r, "live").summary_no).toContain("innvilgede scopes måles ikke");
  });

  it("forklaringen («hvorfor?») nevner de ikke-OK raden med kategori, ikke feiltekst", async () => {
    const r = await build({ health: { calendar: { state: "auth_failed", hoursAgo: 2 } } }).run();
    const text = explainControlCenterNo(r);
    expect(text).toContain("Google Calendar");
    expect(text).toContain("autentisering feilet");
  });
});

describe("koblingen og kontraktens grenser", () => {
  const FULL_REFS = [...new Set(CONNECTOR_REGISTRY.flatMap((c) => c.credential_refs))];

  it("ingen fakta mistes stille: hvert bygd element bærer alle nøkler (kontraktens tak er 24 fakta per element), også med alt konfigurert", async () => {
    const r = await build({ secrets: FULL_REFS, health: { github: { state: "healthy", hoursAgo: 1 } }, frozen: ["github"], revoked: ["JARVIS_EMAIL_TOKEN"] }).run();
    const built = ["live", "configured_other", "not_configured"].flatMap((s) => section(r, s).items);
    expect(built.length).toBe(CONNECTOR_REGISTRY.filter((c) => !c.category.startsWith("backlog")).length);
    for (const i of built) {
      const keys = Object.keys(i.facts ?? {});
      expect(keys.length, i.id).toBeLessThanOrEqual(24);
      for (const must of ["category", "configured", "configuration", "test_method", "auth_health", "api_version", "api_deprecation", "paused", "credential_revoked"]) expect(keys, `${i.id}:${must}`).toContain(must);
    }
  });

  it("registerControlCenters kobler Integration Center kun når verktøygatewayen og eier-kontrollene er gitt - ellers står det som «ikke koblet inn» (aldri en tom OK)", () => {
    const wiring = {
      pool: new ScriptedPool([]).asPool(), env: {},
      toolGateway: makeGateway(new Set(), {}) as never,
      ownerControls: { listFrozenConnectorsDurable: async () => [], listRevokedCredentialsDurable: async () => [] }
    };
    const withDeps = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(withDeps, wiring);
    expect(withDeps.list().map((c) => c.id)).toEqual(["integration"]);
    const without = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(without, { pool: new ScriptedPool([]).asPool(), env: {} });
    expect(without.list()).toEqual([]);
    const half = new ControlCenterRegistry({ isOwner: () => true });
    registerControlCenters(half, { pool: new ScriptedPool([]).asPool(), env: {}, toolGateway: wiring.toolGateway });
    expect(half.list()).toEqual([]);
  });

  it("det vanskeligste først: FAIL/WARN/UKJENT står før OK i seksjonen, og lik status sorteres på navn", async () => {
    const r = await build({ health: { github: { state: "healthy", hoursAgo: 1 }, calendar: { state: "auth_failed", hoursAgo: 2 }, telegram: { state: "rate_limited", hoursAgo: 3 } } }).run();
    const live = section(r, "live").items;
    const rank = { FAIL: 0, WARN: 1, UNKNOWN: 2, OK: 3 } as const;
    for (let i = 1; i < live.length; i++) expect(rank[live[i - 1]!.status]).toBeLessThanOrEqual(rank[live[i]!.status]);
    expect(live[0]?.id).toBe("google_calendar");
  });
});

describe("kun lesing, identitetsbundet, og aldri hemmeligheter", () => {
  it("alle spørringer er SELECT, alle tenant-spørringer kjører under identitetens egen tenant, og jobbtabellen leses globalt", async () => {
    const { pool, run } = build({});
    await run();
    expect(pool.queries.length).toBeGreaterThanOrEqual(5);
    for (const q of pool.queries) expect(q.sql.trim().toUpperCase().startsWith("SELECT"), q.sql.slice(0, 60)).toBe(true);
    const tenantQueries = pool.queries.filter((q) => /audit_events|cost_events|connector_maintenance_log/.test(q.sql));
    expect(tenantQueries.length).toBe(4);
    for (const q of tenantQueries) {
      expect(q.tenant).toBe("tenant-owner");
      expect(q.params[0]).toBe("tenant-owner");
    }
    const jobs = pool.queries.filter((q) => /scheduler_state/.test(q.sql));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.tenant).toBeNull();
  });

  it("en annen identitets tenant brukes i stedet (ingenting er fast): samme senter, annen tenant", async () => {
    const { pool } = build({});
    const registry = new ControlCenterRegistry({ isOwner: () => true, now: () => NOW });
    registry.register(createIntegrationCenter({
      pool: pool.asPool(), toolGateway: makeGateway(new Set(), {}) as never,
      ownerControls: { listFrozenConnectorsDurable: async () => [], listRevokedCredentialsDurable: async () => [] }
    }));
    await registry.report("integration", { ...identity, tenant_id: "tenant-andre" });
    const t = pool.queries.filter((q) => /audit_events/.test(q.sql)).map((q) => q.tenant);
    expect(new Set(t)).toEqual(new Set(["tenant-andre"]));
  });

  it("rapporten inneholder aldri verdier av hemmeligheter - bare credential-NAVN", async () => {
    const VALUE = "ghp_SUPERSECRETVALUE1234567890";
    const gateway = makeGateway(new Set(BASE_SECRETS), {}) as Record<string, unknown>;
    // et gateway som (ved en feil) ville lekket verdien via get/hasSecret-svar: verifiser at kun boolske svar brukes
    (gateway as { hasSecret: (ref: string) => Promise<unknown> }).hasSecret = async (ref: string) => (BASE_SECRETS.includes(ref) ? true : false);
    const { run } = build({ health: { github: { state: "healthy", hoursAgo: 1 } } });
    const json = JSON.stringify(await run());
    expect(json).not.toContain(VALUE);
    expect(json).toContain("JARVIS_VIPPS_CLIENT_SECRET");
    expect(json).not.toMatch(/sk-[a-z]+-/);
    expect(json).not.toMatch(/ghp_[A-Za-z0-9]{10,}/);
  });
});

describe("handlinger: peker på eksisterende ruter, speiler rutenes regler", () => {
  const FULL = [...new Set(CONNECTOR_REGISTRY.flatMap((c) => c.credential_refs))];

  it("hver handling: endepunkt i den lukkede listen, navn på rutens allowlist, aldri hemmelighets-skriving, ingen identitetsfelt, step-up-merke = rutens krav, risikoklasse = verktøyets", async () => {
    const { run } = build({ secrets: FULL, frozen: ["telegram"], revoked: ["JARVIS_NOTION_API_KEY"] });
    const r = await run();
    expect(r.actions.length).toBeGreaterThan(60);
    expect(new Set(actionIds(r)).size).toBe(r.actions.length);
    for (const a of r.actions) {
      expect((CONTROL_ACTION_ENDPOINTS as readonly string[]).includes(a.endpoint), a.id).toBe(true);
      const name = String(a.body["action"]);
      expect(CONTROL_ACTION_ALLOWED[a.endpoint], a.id).toContain(name);
      expect(name, a.id).not.toBe("set_connector_credential");
      expect(Object.keys(a.body).sort(), a.id).toEqual(["action", "parameters"]);
      const params = a.body["parameters"] as Record<string, unknown>;
      for (const forbidden of ["tenant_id", "person_id", "actor_person_id", "owner_person_id", "device_id", "session_id", "value", "grant_token"]) expect(params, `${a.id}:${forbidden}`).not.toHaveProperty(forbidden);
      expect(a.requires_step_up, a.id).toBe(actionRequiresStepUp(name));
      expect(stepUpDenial({ auth_strength: "bearer" as never, channel: "web" }, name) === undefined, a.id).toBe(!a.requires_step_up);
      const tool = a.endpoint === "/executive/mutate" ? "executive" : "owner_controls";
      expect(a.risk_class, a.id).toBe(defs.find((d) => d.tool_id === tool && d.action === name)?.capability_class);
      expect(a.section_id, a.id).toBeDefined();
      expect(a.item_id, a.id).toBeDefined();
      expect(a.description_no.length, a.id).toBeGreaterThan(20);
    }
  });

  it("GitHub: test (A, ingen step-up), pause (C, ingen step-up - stopper ting), tilbakekall (C, step-up) - alle reversible med angre-tekst der det trengs", async () => {
    const r = await build({ secrets: FULL, health: { github: { state: "healthy", hoursAgo: 1 } } }).run();
    const byId = (id: string) => r.actions.find((a) => a.id === id)!;
    expect(byId("integration.test:github")).toMatchObject({ endpoint: "/owner-controls/connector-credentials", body: { action: "test_connector", parameters: { connector_id: "github" } }, risk_class: "A", requires_step_up: false, reversible: true });
    expect(byId("integration.freeze:github")).toMatchObject({ endpoint: "/executive/mutate", body: { action: "freeze_connector", parameters: { connector_id: "github" } }, risk_class: "C", requires_step_up: false, reversible: true });
    expect(byId("integration.freeze:github").rollback_no).toBeTruthy();
    expect(byId("integration.revoke:github:JARVIS_GITHUB_TOKEN")).toMatchObject({ endpoint: "/executive/mutate", body: { action: "revoke_credential", parameters: { credential_ref: "JARVIS_GITHUB_TOKEN" } }, risk_class: "C", requires_step_up: true, reversible: true });
    expect(byId("integration.freeze:github")).toMatchObject({ section_id: "live", item_id: "github" });
    expect(actionIds(r)).not.toContain("integration.unfreeze:github");
    expect(actionIds(r)).not.toContain("integration.restore:github:JARVIS_GITHUB_TOKEN");
  });

  it("pauset connector tilbyr GJENOPPTA (step-up) i stedet for pause; tilbakekalt credential tilbyr GJENOPPRETT i stedet for tilbakekall", async () => {
    const r = await build({ secrets: FULL, frozen: ["github"], revoked: ["JARVIS_EMAIL_TOKEN"] }).run();
    const ids = actionIds(r);
    expect(ids).toContain("integration.unfreeze:github");
    expect(ids).not.toContain("integration.freeze:github");
    expect(r.actions.find((a) => a.id === "integration.unfreeze:github")).toMatchObject({ body: { action: "unfreeze_connector", parameters: { connector_id: "github" } }, requires_step_up: true });
    expect(ids).toContain("integration.restore:gmail:JARVIS_EMAIL_TOKEN");
    expect(ids).not.toContain("integration.revoke:gmail:JARVIS_EMAIL_TOKEN");
    expect(r.actions.find((a) => a.id === "integration.restore:gmail:JARVIS_EMAIL_TOKEN")).toMatchObject({ body: { action: "restore_credential", parameters: { credential_ref: "JARVIS_EMAIL_TOKEN" } }, requires_step_up: true });
  });

  it("finansconnectorer får ALDRI frys (nødbryteren bor i samme verktøy), men tilbakekall av leverandør-credentialen", async () => {
    const r = await build({ secrets: FULL }).run();
    const ids = actionIds(r);
    for (const id of ["fiken", "stripe", "vipps", "neonomics", "wallester"]) expect(ids.filter((x) => x.startsWith(`integration.freeze:${id}`)), id).toEqual([]);
    expect(ids).toContain("integration.revoke:fiken:JARVIS_FIKEN_REFRESH_TOKEN");
    expect(ids).toContain("integration.revoke:stripe:JARVIS_STRIPE_SECRET_KEY");
    expect(ids).toContain("integration.test:stripe");
    // og ingen handling noensinne mot finans-verktøyets frys
    for (const a of r.actions) expect(JSON.stringify(a.body), a.id).not.toMatch(/"connector_id":"finance/);
  });

  it("delt credential: tilbakekall av Google-tokenet advarer om at Drive og Kalender deler det", async () => {
    const r = await build({ secrets: FULL }).run();
    const cal = r.actions.find((a) => a.id === "integration.revoke:google_calendar:JARVIS_GOOGLE_TOKEN")!;
    expect(cal.description_no).toContain("deles med");
    expect(cal.description_no).toContain("Google Drive/Docs");
  });

  it("modellleverandører og backlog har ingen handlinger herfra; ukonfigurerte har ingen test/pause/tilbakekall", async () => {
    const r = await build({ secrets: BASE_SECRETS }).run();
    const owners = new Set(r.actions.map((a) => a.item_id));
    for (const id of ["anthropic", "openai", "gemini", "apple_music", "slack", "vipps", "notion"]) expect(owners.has(id), id).toBe(false);
  });

  it("higgsfield (uten live-test) kan pauses men ikke testes", async () => {
    const r = await build({ secrets: BASE_SECRETS }).run();
    expect(actionIds(r)).toContain("integration.freeze:higgsfield");
    expect(actionIds(r)).not.toContain("integration.test:higgsfield");
  });

  it("en frosset, ukonfigurert connector kan fortsatt gjenopptas", async () => {
    const r = await build({ secrets: BASE_SECRETS, frozen: ["slack"] }).run();
    expect(actionIds(r)).toContain("integration.unfreeze:slack");
    expect(r.actions.find((a) => a.id === "integration.unfreeze:slack")).toMatchObject({ section_id: "not_configured", item_id: "slack" });
  });
});

describe("drift: det senteret påstår må stå i koden", () => {
  it("hver API-versjon-påstand har bevis i filen den peker på, og peker på en connector som finnes", () => {
    for (const [id, fact] of Object.entries(CONNECTOR_API_FACTS)) {
      expect(CONNECTOR_REGISTRY.some((c) => c.id === id), `connector ${id}`).toBe(true);
      const path = resolve(REPO_ROOT, fact.evidence.file);
      expect(existsSync(path), `${id}: ${fact.evidence.file}`).toBe(true);
      expect(readFileSync(path, "utf8").includes(fact.evidence.needle), `${id}: «${fact.evidence.needle}» i ${fact.evidence.file}`).toBe(true);
      expect(fact.api_version.length, id).toBeGreaterThan(1);
    }
  });

  it("utfasing påstås kun der repoet selv sier det (Todoist), ellers er den ukjent", () => {
    expect(Object.entries(CONNECTOR_API_FACTS).filter(([, f]) => f.deprecation_no !== undefined).map(([id]) => id)).toEqual(["todoist"]);
  });

  it("synk-jobbene finnes som navngitte DailyScheduler-jobber i main.ts, og connectorene finnes", () => {
    const main = readFileSync(resolve(REPO_ROOT, "apps/api/src/main.ts"), "utf8");
    for (const [connector, jobs] of Object.entries(CONNECTOR_SYNC_JOBS)) {
      expect(CONNECTOR_REGISTRY.some((c) => c.id === connector), connector).toBe(true);
      for (const j of jobs) expect(main.includes(`"${j}"`), `${connector}: ${j}`).toBe(true);
    }
    expect(main.includes(`"${CONNECTOR_HEALTH_SWEEP_JOB}"`)).toBe(true);
  });

  it("kontraktens handlings-allowlister er IDENTISKE med rutenes (en knapp peker aldri på noe ruten ville avvist), unntatt hemmelighets-skriving", () => {
    expect([...(CONTROL_ACTION_ALLOWED["/executive/mutate"] ?? [])].sort()).toEqual([...EXECUTIVE_MUTATE_ACTIONS].sort());
    expect([...(CONTROL_ACTION_ALLOWED["/owner-controls/connector-credentials"] ?? [])].sort()).toEqual(OWNER_CONTROLS_CONNECTOR_ACTIONS.filter((a) => a !== "set_connector_credential").sort());
    for (const list of Object.values(CONTROL_ACTION_ALLOWED)) expect(list ?? []).not.toContain("set_connector_credential");
  });

  it("step-up-merket utledes av samme mengde som ruten bruker (pause/test/aktiver kill switch er unntatt; alt annet krever step-up)", () => {
    for (const exempt of ["pause_domain", "freeze_connector", "test_connector", "activate_kill_switch", "enable_finance_kill_switch", "resolve_situation"]) expect(actionRequiresStepUp(exempt), exempt).toBe(false);
    for (const strict of ["unfreeze_connector", "revoke_credential", "restore_credential", "revoke_device", "resume_domain", "deactivate_kill_switch", "disable_finance_kill_switch"]) expect(actionRequiresStepUp(strict), strict).toBe(true);
  });
});

describe("modellleverandører: pause og tilbakekall vises her (WP-H0/JARVIS-087), knappene bor i AI Center", () => {
  it("et frosset model:<id>-mål gir PAUSET og WARN, og kun den leverandøren; frosne VERKTØY rører ingen modell", async () => {
    const r = await build({ frozen: ["model:anthropic", "github"] }).run();
    const anthropic = item(r, "configured_other", "anthropic");
    expect(anthropic.status).toBe("WARN");
    expect(anthropic.facts).toMatchObject({ paused: true });
    expect(anthropic.detail_no).toContain("PAUSET");
    const clean = await build({ frozen: ["github"] }).run();
    expect(item(clean, "configured_other", "anthropic").facts).toMatchObject({ paused: false });
  });

  it("en tilbakekalt modellnøkkel vises som tilbakekalt på leverandøren (ModelGateway stanser den)", async () => {
    const r = await build({ revoked: refsOf("anthropic") }).run();
    const anthropic = item(r, "configured_other", "anthropic");
    expect(anthropic.facts).toMatchObject({ credential_revoked: true });
    expect(anthropic.status).toBe("WARN");
    expect(anthropic.detail_no).toContain("TILBAKEKALT");
  });

  it("senteret tilbyr ingen pause-/tilbakekallsknapp for modellleverandørene (de bor i AI Center - ingen duplikate knapper for det samme)", async () => {
    const r = await build({}).run();
    for (const id of ["anthropic", "openai", "gemini"]) {
      expect(r.actions.filter((a) => a.item_id === id && (a.body["action"] === "freeze_connector" || a.body["action"] === "revoke_credential")), id).toEqual([]);
    }
  });
});
