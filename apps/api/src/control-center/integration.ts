// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import {
  controlAction, controlItem, controlSection, unknownControlSection, worstStatus,
  type ControlAction, type ControlCenterDefinition, type ControlCenterBuildContext, type ControlCenterParts, type ControlItem, type ControlSection, type ControlStatus
} from "@jarvis/executive";
import type { MeshStatus } from "@jarvis/model-gateway";
import type { OwnerControls } from "@jarvis/policy";
import { CONNECTOR_REGISTRY, type ConnectorDefinition, type ToolDefinition, type ToolGateway } from "@jarvis/tool-gateway";
import { modelFreezeTarget } from "../provider-pause.ts";
import { actionRequiresStepUp } from "../step-up.ts";
import { PresenceReader } from "./presence.ts";
import { HOUR_MS, ageMs, bySeverityThenLabel, countsNo, globalRows, joinFact, relativeNo, riskOf, settle, tenantRead, toIso, type ControlCenterPool } from "./shared.ts";

/**
 * WP-H0 (UA-11 Admin Control Center) - INTEGRATION CENTER.
 *
 * Per connector i `CONNECTOR_REGISTRY` (57 oppføringer): er den konfigurert (credential-PRESENCE som TRI-STATE: finnes / målt fraværende / kunne ikke måles - aldri verdier), auth-helse, scopes (der kjent), siste vellykkede kall og synk-forsinkelse, API-versjon/utfasing (kun der koden vet
 * det - ellers ukjent), vedlikeholdstid og -eier (connector maintenance ledger, D-421), siste feil (KATEGORI - aldri innhold) og om eieren har pauset (frosset) eller tilbakekalt den. Alt er LESING av eksisterende kilder:
 *  - `ToolGateway.health` (BO-03, i minnet) og `audit_events` (`tool.executed`/`tool.failed`, tenant-RLS) - siste måling vinner; en gammel «i orden» er ikke «i orden nå»;
 *  - `scheduler_state` (daglige jobber: helsesveip og synk) og `connector_maintenance_log` (migrasjon 077);
 *  - `owner_control_state` via `OwnerControls` (frosne connectorer / tilbakekalte credentials);
 *  - modellmeshen (`meshStatus`) og `cost_events` for modellleverandørene, som ikke har en ToolGateway-live-test.
 *
 * HANDLINGER peker på EKSISTERENDE ruter (ingen ny skrivevei): test (`test_connector`, klasse A), pause/gjenoppta (`freeze_connector`/`unfreeze_connector`) og tilbakekall/gjenopprett (`revoke_credential`/`restore_credential`).
 * Å lime inn en NY nøkkel (`set_connector_credential`) er bevisst IKKE en kontrollsenter-handling: senteret håndterer aldri hemmeligheter (det skjer i dashbordet; DEFERRED her, ikke stille utelatt).
 *
 * PAUSE-REGELEN: en connector fryses på sitt `tool_id` (det er det `ToolGateway`/`PolicyGateway` sjekker). Inneholder det verktøyet også interne (`BUSINESS_INTERNAL`) handlinger - som `finance`, der finans-nødbryteren bor -
 * tilbys IKKE frys (det ville også stanset nødbryteren og interne lesinger); da tilbys tilbakekall av leverandør-credentialen i stedet, som kun stanser leverandørhandlingene.
 */

/** Eldre enn dette er en «i orden»-måling ikke lenger bevis (helsesveipen kjører daglig). */
export const HEALTH_STALE_MS = 36 * HOUR_MS;
/** En daglig jobb som ikke er fullført på så lang tid er forsinket. */
export const JOB_STALE_MS = 36 * HOUR_MS;
/** Over dette (minutter siste 30 døgn) regnes en connector som kostbar å vedlikeholde. */
export const MAINTENANCE_WARN_MINUTES_30D = 180;
const AUDIT_WINDOW_MS = 7 * 24 * HOUR_MS;
const JOB_WINDOW_DAYS = 14;

/** Daglig helsesveip (`runConnectorHealthSweep`, `main.ts`): kjører live-testen mot hver konfigurert connector. */
export const CONNECTOR_HEALTH_SWEEP_JOB = "connector-health-sweep";

/**
 * Hvilke daglige synk-jobber (`DailyScheduler`, `main.ts`) som leser fra hvilken connector. Drift-testen låser at hvert jobbnavn faktisk finnes i `main.ts`.
 * `business-events-sync` leser BÅDE Gmail og Kalender; `conversation-graph-sync` og `support-inbox-sync` leser Gmail.
 */
export const CONNECTOR_SYNC_JOBS: Readonly<Record<string, readonly string[]>> = {
  gmail: ["business-events-sync", "conversation-graph-sync", "support-inbox-sync"],
  google_calendar: ["business-events-sync"],
  stripe: ["stripe-payment-sync"],
  vipps: ["vipps-payment-sync"],
  neonomics: ["neonomics-sweep"],
  wallester: ["wallester-sweep"]
};

export interface ConnectorApiFact {
  /** Versjonen KODEN faktisk kaller (ikke leverandørens nyeste). */
  api_version: string;
  /** Utfasing KUN der repoet selv dokumenterer det. Utelatt = koden vet ikke - vises som ukjent, aldri som «ingen utfasing». */
  deprecation_no?: string;
  /** Beviset: filen (fra repo-roten) og teksten som må stå i den. Drift-testen leser filen, så en påstand aldri overlever koden. */
  evidence: { file: string; needle: string };
}

const LT = "modules/tool-gateway/src/live-transports.ts";

/** API-versjon per connector, kun der koden har den eksplisitt. Connectorer som ikke står her vises med ukjent versjon/utfasing. */
export const CONNECTOR_API_FACTS: Readonly<Record<string, ConnectorApiFact>> = {
  github: { api_version: "X-GitHub-Api-Version 2022-11-28", evidence: { file: LT, needle: 'const GITHUB_API_VERSION = "2022-11-28"' } },
  gmail: { api_version: "Gmail API v1", evidence: { file: LT, needle: "gmail.googleapis.com/gmail/v1/users/me/messages" } },
  google_calendar: { api_version: "Calendar API v3", evidence: { file: LT, needle: "www.googleapis.com/calendar/v3/calendars/primary/events" } },
  google_drive: { api_version: "Drive API v3", evidence: { file: LT, needle: "www.googleapis.com/drive/v3/files" } },
  google_sheets: { api_version: "Sheets API v4", evidence: { file: LT, needle: "sheets.googleapis.com/v4/spreadsheets" } },
  telegram: { api_version: "Bot API (uversjonert URL)", evidence: { file: LT, needle: "api.telegram.org/bot${credential}/getMe" } },
  slack: { api_version: "Web API (uversjonert URL)", evidence: { file: LT, needle: "https://slack.com/api/${method}" } },
  discord: { api_version: "API v10", evidence: { file: LT, needle: "discord.com/api/v10${path}" } },
  twilio: { api_version: "REST 2010-04-01", evidence: { file: LT, needle: "api.twilio.com/2010-04-01/Accounts" } },
  sentry: { api_version: "API 0", evidence: { file: LT, needle: "sentry.io/api/0/organizations" } },
  vercel: { api_version: "per endepunkt (v6/v9/v10/v13)", evidence: { file: LT, needle: "GET /v6/deployments" } },
  notion: { api_version: "Notion-Version 2022-06-28", evidence: { file: LT, needle: '"Notion-Version": "2022-06-28"' } },
  microsoft_outlook: { api_version: "Microsoft Graph v1.0", evidence: { file: LT, needle: "graph.microsoft.com/v1.0${path}" } },
  onedrive: { api_version: "Microsoft Graph v1.0", evidence: { file: LT, needle: "graph.microsoft.com/v1.0${path}" } },
  spotify: { api_version: "Web API v1", evidence: { file: LT, needle: "api.spotify.com/v1/me/player/currently-playing" } },
  whatsapp: { api_version: "Graph API v20.0", evidence: { file: LT, needle: "graph.facebook.com/v20.0/" } },
  telnyx: { api_version: "API v2", evidence: { file: LT, needle: "api.telnyx.com/v2${path}" } },
  hubspot: { api_version: "CRM API v3", evidence: { file: LT, needle: "api.hubapi.com/crm/v3${path}" } },
  pipedrive: { api_version: "API v2", evidence: { file: LT, needle: "/api/v2${path}" } },
  make: { api_version: "API v2", evidence: { file: LT, needle: '"/api/v2/users/me"' } },
  todoist: {
    api_version: "API v1",
    deprecation_no: "Den eldre /rest/v2-veien er pensjonert hos Todoist; koden bruker /api/v1 (D-329).",
    evidence: { file: LT, needle: "api.todoist.com/api/v1${path}" }
  },
  trello: { api_version: "REST API 1", evidence: { file: LT, needle: "api.trello.com/1${path}" } },
  linear: { api_version: "GraphQL (uversjonert)", evidence: { file: LT, needle: "api.linear.app/graphql" } },
  brave_search: { api_version: "Search API v1", evidence: { file: LT, needle: "api.search.brave.com/res/v1/" } },
  openai_images: { api_version: "API v1", evidence: { file: LT, needle: "api.openai.com/v1/images/generations" } },
  runway: { api_version: "X-Runway-Version 2024-11-06", evidence: { file: LT, needle: '"X-Runway-Version": "2024-11-06"' } },
  google_veo: { api_version: "Gemini API v1beta (beta)", evidence: { file: LT, needle: 'this.call("/v1beta/models", credential)' } },
  fiken: { api_version: "API v2", evidence: { file: "modules/finance/src/fiken-transport.ts", needle: 'const FIKEN_API_BASE = "https://api.fiken.no/api/v2"' } },
  stripe: { api_version: "API v1 (kontoens standardversjon - koden fester ikke Stripe-Version)", evidence: { file: "modules/finance/src/stripe-transport.ts", needle: 'const STRIPE_API_BASE = "https://api.stripe.com/v1"' } },
  vipps: { api_version: "ePayment API v1", evidence: { file: "modules/finance/src/vipps-transport.ts", needle: "/epayment/v1/payments" } },
  wallester: { api_version: "API v1", evidence: { file: "modules/finance/src/wallester-transport.ts", needle: '"/v1/cards"' } },
  anthropic: { api_version: "anthropic-version 2023-06-01", evidence: { file: "packages/provider-adapters/src/anthropic.ts", needle: '"anthropic-version": "2023-06-01"' } },
  openai: { api_version: "Chat Completions v1", evidence: { file: "packages/provider-adapters/src/openai.ts", needle: "/v1/chat/completions" } },
  gemini: { api_version: "Gemini API v1beta (beta)", evidence: { file: "packages/provider-adapters/src/gemini.ts", needle: "/v1beta/models/" } }
};

// ---------------------------------------------------------------------------------------------------------------------
// Ren logikk (testbar uten database)
// ---------------------------------------------------------------------------------------------------------------------

export type HealthState = "healthy" | "degraded" | "rate_limited" | "auth_failed" | "unavailable";
export type FailureCategory = "auth" | "rate_limit" | "timeout" | "network" | "other";

const FAILURE_LABEL_NO: Readonly<Record<FailureCategory, string>> = {
  auth: "autentisering", rate_limit: "rate-begrensning", timeout: "tidsavbrudd", network: "nettverk/leverandørfeil", other: "annen feil"
};

/**
 * Feilkategori fra audit-årsaken (`tool.failed.reason`, de første 120 tegnene av transportens feil). KUN kategorien forlater denne funksjonen - teksten kan inneholde leverandørdetaljer og vises aldri.
 * Rekkefølgen er bevisst: autentisering før rate-begrensning før tidsavbrudd før nettverk; resten er `other` (f.eks. valideringsfeil og 404), som IKKE regnes som helsebevis.
 */
export function classifyFailureReason(reason: string | null | undefined): FailureCategory {
  const r = (reason ?? "").toLowerCase();
  // `_` er et ordtegn i regex, så `\b` virker ikke mot `github_http_401`: statuskoder avgrenses av «ikke-siffer» i stedet.
  if (/(?<!\d)40[13](?!\d)|unauthor|forbidden|(?<![a-z])auth|invalid[_ -]?(grant|token|credential|api[_ -]?key)|expired|token[_ -]?(revoked|invalid)/.test(r)) return "auth";
  if (/(?<!\d)429(?!\d)|rate[_ -]?limit|too many requests|quota/.test(r)) return "rate_limit";
  if (/timeout|timed[_ -]?out|(?<![a-z])aborted?(?![a-z])/.test(r)) return "timeout";
  if (/(?<!\d)5\d\d(?!\d)|econn|enotfound|eai_again|fetch failed|socket|network|unavailable|bad gateway|(?<![a-z])dns(?![a-z])|certificate/.test(r)) return "network";
  return "other";
}

/** Kategorier som er BEVIS på at tilkoblingen ikke virker (resten er f.eks. ugyldig input og flipper ikke helsen). */
function categoryHealth(category: FailureCategory): HealthState | null {
  if (category === "auth") return "auth_failed";
  if (category === "rate_limit") return "rate_limited";
  if (category === "timeout" || category === "network") return "unavailable";
  return null;
}

export interface HealthEvidence {
  state: HealthState;
  at: string;
  source: "memory" | "audit" | "cost" | "mesh";
  category?: FailureCategory;
}

const HEALTH_SEVERITY: Readonly<Record<HealthState, number>> = { healthy: 0, degraded: 1, rate_limited: 2, unavailable: 3, auth_failed: 4 };

/** Normaliserer ToolGateway sin in-memory helsetilstand (ukjente verdier regnes som `degraded`, aldri `healthy`). */
export function memoryHealth(entry: { state: string; at: string } | undefined | null): HealthEvidence | null {
  if (!entry) return null;
  const state: HealthState = (entry.state in HEALTH_SEVERITY ? entry.state : "degraded") as HealthState;
  return { state, at: entry.at, source: "memory" };
}

/** Siste måling vinner (likt tidspunkt: den verste). Ingen målinger = null. */
export function effectiveHealth(evidence: ReadonlyArray<HealthEvidence | null | undefined>): HealthEvidence | null {
  let best: HealthEvidence | null = null;
  for (const e of evidence) {
    if (!e || Number.isNaN(Date.parse(e.at))) continue;
    if (best === null) { best = e; continue; }
    const diff = Date.parse(e.at) - Date.parse(best.at);
    if (diff > 0 || (diff === 0 && HEALTH_SEVERITY[e.state] > HEALTH_SEVERITY[best.state])) best = e;
  }
  return best;
}

export function healthStatus(health: HealthEvidence | null, nowMs: number): ControlStatus {
  if (health === null) return "UNKNOWN";
  if (health.state === "healthy") {
    const age = ageMs(health.at, nowMs);
    return age !== null && age <= HEALTH_STALE_MS ? "OK" : "UNKNOWN";
  }
  return health.state === "degraded" || health.state === "rate_limited" ? "WARN" : "FAIL";
}

function healthTextNo(health: HealthEvidence | null, nowMs: number, hasProbe: boolean): string {
  if (health === null) return hasProbe ? "auth-helse: ikke målt (ingen kall siste 7 døgn)" : "auth-helse: ikke målt (connectoren har ingen live-test)";
  const rel = relativeNo(health.at, nowMs);
  const cat = health.category ? `; ${FAILURE_LABEL_NO[health.category]}` : "";
  switch (health.state) {
    case "healthy": return healthStatus(health, nowMs) === "OK" ? `auth-helse: i orden (vellykket ${rel})` : `auth-helse: ikke bekreftet siden ${rel} (eldre enn 36 t)`;
    case "degraded": return `auth-helse: degradert (${rel}${cat})`;
    case "rate_limited": return `auth-helse: rate-begrenset (${rel})`;
    case "auth_failed": return `auth-helse: autentisering feilet (${rel})`;
    case "unavailable": return `auth-helse: utilgjengelig (${rel}${cat})`;
  }
}

export interface JobRow {
  job_name: string;
  last_completed_at: string | null;
  last_open: boolean | null;
  last_had_error: boolean | null;
  last_attempts: number | null;
}

export interface JobState { status: ControlStatus; detail_no: string; last_completed_at: string | null; lag_hours: number | null }

/** Tilstanden til én daglig jobb. Ingen rad = ukjent (jobben er kanskje ikke startet i dette miljøet), aldri «i orden». */
export function jobState(row: JobRow | undefined, nowMs: number): JobState {
  if (!row) return { status: "UNKNOWN", detail_no: `ingen kjøring registrert siste ${JOB_WINDOW_DAYS} døgn`, last_completed_at: null, lag_hours: null };
  const completed = row.last_completed_at;
  if (completed === null) return { status: "WARN", detail_no: `aldri fullført siste ${JOB_WINDOW_DAYS} døgn`, last_completed_at: null, lag_hours: null };
  const age = ageMs(completed, nowMs) ?? 0;
  const lag = Math.round((age / HOUR_MS) * 10) / 10;
  if (age > JOB_STALE_MS) return { status: "WARN", detail_no: `forsinket - sist fullført ${relativeNo(completed, nowMs)}`, last_completed_at: completed, lag_hours: lag };
  if (row.last_open === true && row.last_had_error === true) {
    return { status: "WARN", detail_no: `siste kjøring feilet (forsøk ${row.last_attempts ?? "?"}); sist fullført ${relativeNo(completed, nowMs)}`, last_completed_at: completed, lag_hours: lag };
  }
  return { status: "OK", detail_no: `sist fullført ${relativeNo(completed, nowMs)}`, last_completed_at: completed, lag_hours: lag };
}

// ---------------------------------------------------------------------------------------------------------------------
// Connector-visning: hvilke verktøy/handlinger/credentials hører til hvilken connector
// ---------------------------------------------------------------------------------------------------------------------

export interface ConnectorView {
  def: ConnectorDefinition;
  built: boolean;
  refs: Array<{ ref: string; present: boolean | null }>;
  configured: "yes" | "no" | "partial" | "unknown";
  missing_refs: string[];
  tool_ids: string[];
  action_keys: string[];
  /** Credential-refs ToolGateway sjekker mot tilbakekall for connectorens handlinger (aldri den interne fellesrefen). */
  effective_refs: string[];
  /** Verktøyet som kan fryses uten å ta med interne handlinger, eller null når frys ikke tilbys (se PAUSE-REGELEN i filhodet). */
  freeze_target: string | null;
  required_scopes: string[];
}

function configuredOf(refs: ConnectorView["refs"]): ConnectorView["configured"] {
  if (refs.length === 0) return "no";
  if (refs.every((r) => r.present === true)) return "yes";
  if (refs.every((r) => r.present === false)) return "no";
  if (refs.some((r) => r.present === true) && refs.some((r) => r.present === false)) return "partial";
  return "unknown";
}

/**
 * Kobler registeret til de FAKTISK registrerte verktøyene. En handling tilhører en connector når handlingens `credential_ref` står blant connectorens credential_refs (leverandørhandlinger), og verktøyet
 * ikke er live-test-verktøyet til en ANNEN connector (Kalender og Drive deler Google-token, men er hver sin connector). Live-testhandlingen er alltid med.
 */
export function connectorViews(
  registry: readonly ConnectorDefinition[],
  defs: readonly ToolDefinition[],
  presence: ReadonlyMap<string, boolean | null>
): ConnectorView[] {
  const liveOwner = new Map<string, string>();
  for (const c of registry) if (c.live_test && !liveOwner.has(c.live_test.tool_id)) liveOwner.set(c.live_test.tool_id, c.id);
  return registry.map((def) => {
    const built = def.category !== "backlog" && def.category !== "backlog_d64_gate";
    const refs = def.credential_refs.map((ref) => ({ ref, present: built ? (presence.get(ref) ?? null) : false }));
    const claimed = defs.filter((d) =>
      (def.credential_refs.includes(d.credential_ref) && (liveOwner.get(d.tool_id) ?? def.id) === def.id) ||
      (def.live_test !== undefined && d.tool_id === def.live_test.tool_id && d.action === def.live_test.action)
    );
    const toolIds = [...new Set(claimed.map((d) => d.tool_id))].sort();
    const candidate = def.live_test?.tool_id ?? (toolIds.length === 1 ? (toolIds[0] as string) : null);
    const pure = candidate !== null && defs.filter((d) => d.tool_id === candidate).every((d) => d.credential_ref !== BUSINESS_INTERNAL_CREDENTIAL_REF);
    return {
      def,
      built,
      refs,
      configured: built ? configuredOf(refs) : "no",
      missing_refs: refs.filter((r) => r.present === false).map((r) => r.ref),
      tool_ids: toolIds,
      action_keys: claimed.map((d) => `${d.tool_id}.${d.action}`).sort(),
      effective_refs: [...new Set(claimed.map((d) => d.credential_ref).filter((r) => r !== BUSINESS_INTERNAL_CREDENTIAL_REF && def.credential_refs.includes(r)))].sort(),
      freeze_target: built && pure ? candidate : null,
      required_scopes: [...new Set(claimed.flatMap((d) => d.scopes))].sort()
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Lesere (alle kilder er LESING; en kilde som feiler gjør kun de berørte tallene ukjente)
// ---------------------------------------------------------------------------------------------------------------------

export interface AuditToolRow { tool_id: string; action: string; last_ok_at: string | null; last_fail_at: string | null; ok_24h: number; fail_24h: number; fail_category: FailureCategory | null }

export async function readToolAudit(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<AuditToolRow[]> {
  const since = new Date(nowMs - AUDIT_WINDOW_MS);
  const day = new Date(nowMs - 24 * HOUR_MS);
  return tenantRead(pool, tenantId, async (query) => {
    const counts = await query(
      `SELECT tool_id, action,
              max(at) FILTER (WHERE type = 'tool.executed') AS last_ok_at,
              max(at) FILTER (WHERE type = 'tool.failed')   AS last_fail_at,
              (count(*) FILTER (WHERE type = 'tool.executed' AND at >= $3))::int AS ok_24h,
              (count(*) FILTER (WHERE type = 'tool.failed'   AND at >= $3))::int AS fail_24h
         FROM audit_events
        WHERE tenant_id = $1 AND at >= $2 AND type IN ('tool.executed', 'tool.failed') AND tool_id IS NOT NULL
        GROUP BY tool_id, action`,
      [tenantId, since, day]
    );
    const failures = await query(
      `SELECT DISTINCT ON (tool_id, action) tool_id, action, reason
         FROM audit_events
        WHERE tenant_id = $1 AND at >= $2 AND type = 'tool.failed' AND tool_id IS NOT NULL
        ORDER BY tool_id, action, at DESC, audit_id DESC`,
      [tenantId, since]
    );
    const category = new Map<string, FailureCategory>();
    for (const f of failures) category.set(`${String(f["tool_id"])}.${String(f["action"])}`, classifyFailureReason(f["reason"] as string | null));
    return counts.map((r) => ({
      tool_id: String(r["tool_id"]),
      action: String(r["action"]),
      last_ok_at: toIso(r["last_ok_at"]),
      last_fail_at: toIso(r["last_fail_at"]),
      ok_24h: Number(r["ok_24h"] ?? 0),
      fail_24h: Number(r["fail_24h"] ?? 0),
      fail_category: category.get(`${String(r["tool_id"])}.${String(r["action"])}`) ?? null
    }));
  });
}

export interface ProviderCostRow { provider: string; last_ok_at: string | null; last_fail_at: string | null }

export async function readProviderCalls(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<ProviderCostRow[]> {
  const rows = await tenantRead(pool, tenantId, (query) => query(
    `SELECT provider, max(at) FILTER (WHERE success) AS last_ok_at, max(at) FILTER (WHERE NOT success) AS last_fail_at
       FROM cost_events WHERE tenant_id = $1 AND at >= $2 AND provider IS NOT NULL GROUP BY provider`,
    [tenantId, new Date(nowMs - AUDIT_WINDOW_MS)]
  ));
  return rows.map((r) => ({ provider: String(r["provider"]), last_ok_at: toIso(r["last_ok_at"]), last_fail_at: toIso(r["last_fail_at"]) }));
}

export async function readJobs(pool: ControlCenterPool, jobNames: readonly string[]): Promise<JobRow[]> {
  const rows = await globalRows(pool,
    `SELECT job_name,
            max(completed_at) AS last_completed_at,
            (array_agg(completed_at IS NULL ORDER BY run_date DESC))[1] AS last_open,
            (array_agg(last_error IS NOT NULL ORDER BY run_date DESC))[1] AS last_had_error,
            (array_agg(attempts ORDER BY run_date DESC))[1] AS last_attempts
       FROM scheduler_state
      WHERE job_name = ANY($1::text[]) AND run_date >= current_date - ${JOB_WINDOW_DAYS}
      GROUP BY job_name`,
    [[...jobNames]]
  );
  return rows.map((r) => ({
    job_name: String(r["job_name"]),
    last_completed_at: toIso(r["last_completed_at"]),
    last_open: r["last_open"] === null || r["last_open"] === undefined ? null : Boolean(r["last_open"]),
    last_had_error: r["last_had_error"] === null || r["last_had_error"] === undefined ? null : Boolean(r["last_had_error"]),
    last_attempts: r["last_attempts"] === null || r["last_attempts"] === undefined ? null : Number(r["last_attempts"])
  }));
}

export interface MaintenanceRow { connector_id: string; events: number; minutes: number; last_at: string | null; last_kind: string | null; last_by: string | null }

export async function readMaintenance(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<MaintenanceRow[]> {
  const rows = await tenantRead(pool, tenantId, (query) => query(
    `SELECT connector_id, (count(*))::int AS events, (coalesce(sum(minutes), 0))::int AS minutes, max(occurred_at) AS last_at,
            (array_agg(event_kind  ORDER BY occurred_at DESC, log_id DESC))[1] AS last_kind,
            (array_agg(recorded_by ORDER BY occurred_at DESC, log_id DESC))[1] AS last_by
       FROM connector_maintenance_log WHERE tenant_id = $1 AND occurred_at >= $2 GROUP BY connector_id`,
    [tenantId, new Date(nowMs - 30 * 24 * HOUR_MS)]
  ));
  return rows.map((r) => ({
    connector_id: String(r["connector_id"]), events: Number(r["events"] ?? 0), minutes: Number(r["minutes"] ?? 0),
    last_at: toIso(r["last_at"]), last_kind: r["last_kind"] === null ? null : String(r["last_kind"]), last_by: r["last_by"] === null ? null : String(r["last_by"])
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Senteret
// ---------------------------------------------------------------------------------------------------------------------

export interface IntegrationCenterDeps {
  pool: ControlCenterPool;
  /**
   * `secretPresence` er TRI-STATE (gjennomgang av PR #316, M-1): `true` finnes, `false` kilden svarte og har den ikke, `null` kilden kunne ikke spørres. `hasSecret` (to-state) brukes ikke her: den kunne ikke skille
   * «Infisical nede» fra «ikke konfigurert». `secretsHealth` er valgfri (kun for visning/utfallsvern).
   */
  toolGateway: Pick<ToolGateway, "secretPresence" | "health" | "list" | "get"> & Partial<Pick<ToolGateway, "secretsHealth">>;
  ownerControls: Pick<OwnerControls, "listFrozenConnectorsDurable" | "listRevokedCredentialsDurable">;
  /** Mesh-status for modellleverandørene (anthropic/openai/gemini har ingen ToolGateway-live-test). Utelatt = deres helse er ukjent. */
  meshStatus?: () => Pick<MeshStatus, "providers">;
  /** Standard: `CONNECTOR_REGISTRY`. Injiserbar for tester. */
  registry?: readonly ConnectorDefinition[];
}

const SOURCE_LIVE = "ToolGateway.health (minne) · audit_events (tool.executed/tool.failed, 7 d) · scheduler_state · owner_control_state · connector-registeret (credential-presence, aldri verdier)";

export function createIntegrationCenter(deps: IntegrationCenterDeps): ControlCenterDefinition {
  const registry = deps.registry ?? CONNECTOR_REGISTRY;
  // L-3: ÉN leser per senter (cache 30 s, single-flight per ref, maks 8 samtidige, utfallsvern) - ikke ~87 uavhengige oppslag per bygging.
  const presenceReader = new PresenceReader({
    secretPresence: (ref) => deps.toolGateway.secretPresence(ref),
    ...(deps.toolGateway.secretsHealth ? { secretsHealth: () => deps.toolGateway.secretsHealth!() } : {})
  });
  return {
    id: "integration",
    title_no: "Integrasjoner",
    description_no: "Alle tilkoblinger: konfigurasjon, auth-helse, scopes, synk, API-versjon, vedlikehold og pause/tilbakekall",
    async build(ctx: ControlCenterBuildContext): Promise<ControlCenterParts> {
      const nowMs = ctx.now.getTime();
      const nowIso = ctx.now.toISOString();
      const tenantId = ctx.identity.tenant_id;
      const defs = deps.toolGateway.list();

      // 1. Presence for unike credential-refs til BYGDE connectorer (backlog har ingen mottaker for en verdi). TRI-STATE og fail-soft: en ref kilden ikke kunne svare på er «ukjent» (null), aldri «mangler».
      const builtRefs = [...new Set(registry.filter((c) => c.category !== "backlog" && c.category !== "backlog_d64_gate").flatMap((c) => c.credential_refs))];
      const jobNames = [...new Set([CONNECTOR_HEALTH_SWEEP_JOB, ...Object.values(CONNECTOR_SYNC_JOBS).flat()])];
      const [presenceR, controlsR, auditR, providerR, jobsR, maintR] = await Promise.all([
        settle(() => presenceReader.readAll(builtRefs, nowMs)),
        settle(async () => ({ frozen: await deps.ownerControls.listFrozenConnectorsDurable(), revoked: await deps.ownerControls.listRevokedCredentialsDurable() })),
        settle(() => readToolAudit(deps.pool, tenantId, nowMs)),
        settle(() => readProviderCalls(deps.pool, tenantId, nowMs)),
        settle(() => readJobs(deps.pool, jobNames)),
        settle(() => readMaintenance(deps.pool, tenantId, nowMs))
      ]);

      const presence = new Map<string, boolean | null>();
      for (const ref of builtRefs) presence.set(ref, presenceR.ok ? (presenceR.value.get(ref) ?? null) : null);
      const unknownRefs = [...presence.values()].filter((v) => v === null).length;
      const views = connectorViews(registry, defs, presence);

      const frozen = new Map<string, string>(); // tool_id -> changed_at
      const revoked = new Map<string, string>(); // credential_ref -> changed_at
      if (controlsR.ok) {
        for (const f of controlsR.value.frozen) frozen.set(f.connector_id, toIso(f.changed_at) ?? nowIso);
        for (const r of controlsR.value.revoked) revoked.set(r.credential_ref, toIso(r.changed_at) ?? nowIso);
      }
      const auditByAction = new Map<string, AuditToolRow>();
      if (auditR.ok) for (const r of auditR.value) auditByAction.set(`${r.tool_id}.${r.action}`, r);
      const providerByName = new Map<string, ProviderCostRow>();
      if (providerR.ok) for (const r of providerR.value) providerByName.set(r.provider, r);
      const jobByName = new Map<string, JobRow>();
      if (jobsR.ok) for (const r of jobsR.value) jobByName.set(r.job_name, r);
      const meshR = deps.meshStatus ? await settle(async () => deps.meshStatus!()) : null;
      const meshByName = new Map<string, MeshStatus["providers"][number]>();
      if (meshR?.ok) for (const p of meshR.value.providers) meshByName.set(p.provider, p);

      const maintById = new Map<string, MaintenanceRow>();
      const maintUnmatched: MaintenanceRow[] = [];
      if (maintR.ok) {
        const names = new Map<string, string>();
        for (const v of views) {
          names.set(v.def.id.toLowerCase(), v.def.id);
          for (const t of v.tool_ids) if (!names.has(t.toLowerCase())) names.set(t.toLowerCase(), v.def.id);
        }
        for (const row of maintR.value) {
          const id = names.get(row.connector_id.toLowerCase());
          if (id === undefined) maintUnmatched.push(row);
          else {
            const prev = maintById.get(id);
            maintById.set(id, prev === undefined ? row : {
              connector_id: id, events: prev.events + row.events, minutes: prev.minutes + row.minutes,
              last_at: (prev.last_at ?? "") >= (row.last_at ?? "") ? prev.last_at : row.last_at,
              last_kind: (prev.last_at ?? "") >= (row.last_at ?? "") ? prev.last_kind : row.last_kind,
              last_by: (prev.last_at ?? "") >= (row.last_at ?? "") ? prev.last_by : row.last_by
            });
          }
        }
      }

      const live: ControlItem[] = [];
      const other: ControlItem[] = [];
      const notConfigured: ControlItem[] = [];
      const backlog: ControlItem[] = [];
      const actions: ControlAction[] = [];

      for (const v of views) {
        const def = v.def;
        if (!v.built) {
          backlog.push(controlItem({
            id: def.id, label: def.display_name, status: "OK",
            detail_no: "Ikke bygget (backlog) - ingen tilkobling å måle. Synlig her så den aldri utelates stille.",
            facts: { category: def.category, built: false, configured: false, credential_refs: def.credential_refs.length }
          }));
          continue;
        }

        const apiFact = CONNECTOR_API_FACTS[def.id];
        const probeKey = def.live_test?.tool_id ?? def.id;
        const hasProbe = def.live_test !== undefined;
        const isModelProvider = def.category === "model_provider";
        // WP-H0 (JARVIS-087): en modellleverandør pauses med målet `model:<id>` (ikke et tool_id) og stanses også av et tilbakekall av nøkkelen - ModelGateway leser begge live (se provider-pause.ts).
        // Pause/tilbakekall tilbys fra AI Center; her vises kun tilstanden, så to sentre aldri har hver sin knapp for det samme.
        const frozenAt = isModelProvider
          ? frozen.get(modelFreezeTarget(def.id))
          : v.freeze_target !== null ? frozen.get(v.freeze_target) : v.tool_ids.map((t) => frozen.get(t)).find((x) => x !== undefined);
        const revokedRefs = (isModelProvider ? def.credential_refs : v.effective_refs).filter((r) => revoked.has(r));

        // --- helse: siste måling vinner (minne, revisjon, modellmesh, kostnadsrader)
        const evidence: Array<HealthEvidence | null> = [memoryHealth(deps.toolGateway.health.get(probeKey))];
        let okAt: string | null = null;
        let failAt: string | null = null;
        let failCategory: FailureCategory | null = null;
        let ok24 = 0;
        let fail24 = 0;
        for (const key of v.action_keys) {
          const a = auditByAction.get(key);
          if (!a) continue;
          ok24 += a.ok_24h;
          fail24 += a.fail_24h;
          if (a.last_ok_at !== null && (okAt === null || a.last_ok_at > okAt)) okAt = a.last_ok_at;
          if (a.last_fail_at !== null && (failAt === null || a.last_fail_at > failAt)) { failAt = a.last_fail_at; failCategory = a.fail_category; }
        }
        if (isModelProvider) {
          const cost = providerByName.get(def.id);
          if (cost?.last_ok_at) okAt = cost.last_ok_at;
          if (cost?.last_fail_at) { failAt = cost.last_fail_at; failCategory = null; }
          const m = meshByName.get(def.id);
          if (m) {
            if (m.state === "LIVE") evidence.push({ state: "healthy", at: nowIso, source: "mesh" });
            else if (m.state === "RATE_LIMITED") evidence.push({ state: "rate_limited", at: nowIso, source: "mesh" });
            else if (m.state === "UNAVAILABLE") evidence.push({ state: "unavailable", at: nowIso, source: "mesh" });
            else if (m.state === "DEGRADED") evidence.push({ state: "degraded", at: nowIso, source: "mesh" });
          }
        }
        if (okAt !== null) evidence.push({ state: "healthy", at: okAt, source: isModelProvider ? "cost" : "audit" });
        if (failAt !== null) {
          const state = failCategory === null ? (isModelProvider ? "degraded" : null) : categoryHealth(failCategory);
          if (state !== null) evidence.push({ state, at: failAt, source: isModelProvider ? "cost" : "audit", ...(failCategory !== null ? { category: failCategory } : {}) });
        }
        const health = v.configured === "yes" ? effectiveHealth(evidence) : null;
        let status: ControlStatus = v.configured === "yes" ? healthStatus(health, nowMs) : "OK";

        // --- synk
        const jobs = (CONNECTOR_SYNC_JOBS[def.id] ?? []).map((name) => ({ name, state: jobState(jobByName.get(name), nowMs) }));
        if (v.configured === "yes" && jobs.length > 0) status = worstStatus([status, jobsR.ok ? worstStatus(jobs.map((j) => j.state.status)) : "UNKNOWN"]);

        // --- eierbrytere
        const paused = frozenAt !== undefined;
        if (paused || revokedRefs.length > 0) status = worstStatus([status, "WARN"]);
        // Gjennomgang av PR #316 (M-1): kan frys/tilbakekall ikke leses, VET vi ikke om en tilkobling er stanset (heller ikke en ukonfigurert: pause og tilbakekall er egne tilstander) - da er raden ukjent (aldri «i orden»),
        // og faktaene sier null i stedet for «ikke pauset».
        const controlsUnknown = !controlsR.ok;
        if (controlsUnknown) status = worstStatus([status, "UNKNOWN"]);
        if (v.configured === "partial") status = worstStatus(["WARN", status]);
        if (v.configured === "unknown") status = "UNKNOWN";

        const maint = maintById.get(def.id);
        const lagJob = jobs.map((j) => j.state).filter((s) => s.lag_hours !== null).sort((a, b) => (b.lag_hours ?? 0) - (a.lag_hours ?? 0))[0];
        const parts: string[] = [];
        if (v.configured === "yes") {
          parts.push(healthTextNo(health, nowMs, hasProbe || isModelProvider));
          if (failAt !== null) {
            const label = failCategory !== null ? FAILURE_LABEL_NO[failCategory] : "ukjent kategori";
            const note = failCategory === "other" ? " (regnes ikke som helsebevis)" : okAt !== null && okAt > failAt ? " (senere vellykket)" : "";
            parts.push(`siste feil: ${label} ${relativeNo(failAt, nowMs)}${note}`);
          }
          for (const j of jobs) parts.push(`synk ${j.name}: ${j.state.detail_no}`);
        } else if (v.configured === "partial") {
          parts.push(`delvis konfigurert - mangler: ${v.missing_refs.join(", ")}`);
        } else if (v.configured === "unknown") {
          parts.push(`konfigurasjon kunne ikke leses (credential-kilden svarte ikke${v.refs.filter((r) => r.present === null).length > 0 ? `: ${v.refs.filter((r) => r.present === null).length} av ${v.refs.length} legitimasjoner ukjent` : ""})`);
        } else {
          parts.push(`ikke konfigurert - mangler: ${v.missing_refs.join(", ")}`);
        }
        if (paused) parts.push(`PAUSET (frosset ${relativeNo(frozenAt, nowMs)})`);
        if (revokedRefs.length > 0) parts.push(`legitimasjon TILBAKEKALT: ${revokedRefs.join(", ")}`);
        if (controlsUnknown) parts.push("pause-/tilbakekall-status kunne ikke leses");
        if (v.configured === "yes" && !hasProbe && !isModelProvider && health === null) parts.push("live-test finnes ikke");

        const item = controlItem({
          id: def.id,
          label: def.display_name,
          status,
          detail_no: parts.join(" · "),
          observed_at: health?.at ?? null,
          facts: {
            category: def.category,
            configured: v.configured === "yes" ? true : v.configured === "unknown" ? null : false,
            configuration: v.configured,
            credentials_present: `${v.refs.filter((r) => r.present === true).length}/${v.refs.length}${v.refs.some((r) => r.present === null) ? ` (${v.refs.filter((r) => r.present === null).length} ukjent)` : ""}`,
            missing_credentials: v.missing_refs.length > 0 ? joinFact(v.missing_refs) : null,
            test_method: hasProbe ? "live" : "presence_only",
            auth_health: v.configured === "unknown" ? "ikke målt" : v.configured !== "yes" ? "ikke aktuelt" : health === null ? "ikke målt" : healthStatus(health, nowMs) === "UNKNOWN" ? "gammel måling" : health.state,
            auth_health_at: health?.at ?? null,
            last_success_at: okAt,
            last_failure_at: failAt,
            last_failure_category: failCategory,
            calls_ok_24h: auditR.ok && !isModelProvider ? ok24 : null,
            calls_failed_24h: auditR.ok && !isModelProvider ? fail24 : null,
            sync_jobs: jobs.length > 0 ? jobs.map((j) => j.name).join(", ") : null,
            sync_last_completed_at: lagJob?.last_completed_at ?? null,
            sync_lag_hours: lagJob?.lag_hours ?? null,
            required_scopes: v.required_scopes.length > 0 ? joinFact(v.required_scopes) : null,
            api_version: apiFact?.api_version ?? "ukjent (koden oppgir ikke versjon)",
            api_deprecation: apiFact?.deprecation_no ?? "ukjent (koden kjenner ingen utfasingsdato)",
            maintenance_minutes_30d: maintR.ok ? (maint?.minutes ?? 0) : null,
            maintenance_owner: maint?.last_by ?? null,
            paused: controlsR.ok ? paused : null,
            credential_revoked: controlsR.ok ? revokedRefs.length > 0 : null
          }
        });
        const section = v.configured === "yes" ? (hasProbe ? "live" : "configured_other") : "not_configured";
        (section === "live" ? live : section === "configured_other" ? other : notConfigured).push(item);

        // --- handlinger (pekere til eksisterende ruter; ingen skrivevei her)
        const anchor = { section_id: section, item_id: def.id };
        if (v.configured === "yes" && hasProbe) {
          actions.push(controlAction({
            id: `integration.test:${def.id}`, label: `Test ${def.display_name}`, endpoint: "/owner-controls/connector-credentials",
            body: { action: "test_connector", parameters: { connector_id: def.id } },
            risk_class: riskOf(deps.toolGateway, "owner_controls", "test_connector"), requires_step_up: actionRequiresStepUp("test_connector"), reversible: true,
            description_no: `Kjører ${def.display_name}s trygge lesetest mot leverandøren nå (ingen endring, resultatet oppdaterer helsen).`, ...anchor
          }));
        }
        if (v.freeze_target !== null) {
          const target = v.freeze_target;
          if (frozenAt !== undefined) {
            actions.push(controlAction({
              id: `integration.unfreeze:${def.id}`, label: `Gjenoppta ${def.display_name}`, endpoint: "/executive/mutate",
              body: { action: "unfreeze_connector", parameters: { connector_id: target } },
              risk_class: riskOf(deps.toolGateway, "executive", "unfreeze_connector"), requires_step_up: actionRequiresStepUp("unfreeze_connector"), reversible: true,
              description_no: `Opphever pausen av verktøyet «${target}»: ${def.display_name}-handlinger virker igjen.`, rollback_no: "Pause connectoren på nytt.", ...anchor
            }));
          } else if (v.configured === "yes") {
            actions.push(controlAction({
              id: `integration.freeze:${def.id}`, label: `Pause ${def.display_name}`, endpoint: "/executive/mutate",
              body: { action: "freeze_connector", parameters: { connector_id: target, reason: "Pauset av eier fra kontrollsenteret" } },
              risk_class: riskOf(deps.toolGateway, "executive", "freeze_connector"), requires_step_up: actionRequiresStepUp("freeze_connector"), reversible: true,
              description_no: `Stanser ALLE handlinger mot verktøyet «${target}» (${def.display_name}) umiddelbart - også planlagte jobber og varsler som bruker det.`,
              rollback_no: "Gjenoppta connectoren (opphev pausen).", ...anchor
            }));
          }
        }
        for (const ref of v.effective_refs) {
          if (revoked.has(ref)) {
            actions.push(controlAction({
              id: `integration.restore:${def.id}:${ref}`, label: `Gjenopprett ${ref}`, endpoint: "/executive/mutate",
              body: { action: "restore_credential", parameters: { credential_ref: ref } },
              risk_class: riskOf(deps.toolGateway, "executive", "restore_credential"), requires_step_up: actionRequiresStepUp("restore_credential"), reversible: true,
              description_no: `Gjenoppretter den tilbakekalte legitimasjonen «${ref}» (selve verdien er uendret).`, rollback_no: "Tilbakekall legitimasjonen på nytt.", ...anchor
            }));
          } else if (v.configured === "yes") {
            const shared = registry.filter((c) => c.id !== def.id && c.credential_refs.includes(ref)).map((c) => c.display_name);
            actions.push(controlAction({
              id: `integration.revoke:${def.id}:${ref}`, label: `Tilbakekall ${ref}`, endpoint: "/executive/mutate",
              body: { action: "revoke_credential", parameters: { credential_ref: ref, reason: "Tilbakekalt av eier fra kontrollsenteret" } },
              risk_class: riskOf(deps.toolGateway, "executive", "revoke_credential"), requires_step_up: actionRequiresStepUp("revoke_credential"), reversible: true,
              description_no: `Stanser handlinger som bruker legitimasjonen «${ref}» umiddelbart${shared.length > 0 ? ` (deles med: ${shared.join(", ")})` : ""}. Verdien slettes ikke.`,
              rollback_no: "Gjenopprett legitimasjonen.", ...anchor
            }));
          }
        }
      }

      for (const list of [live, other, notConfigured, backlog]) list.sort(bySeverityThenLabel);

      // --- seksjoner
      const sourceFailures: string[] = [];
      if (!auditR.ok) sourceFailures.push(`revisjonssporet (${auditR.category})`);
      if (!controlsR.ok) sourceFailures.push(`eier-kontrolltilstanden (${controlsR.category})`);
      if (!jobsR.ok) sourceFailures.push(`jobbtilstanden (${jobsR.category})`);
      if (!providerR.ok) sourceFailures.push(`kostradene (${providerR.category})`);
      if (deps.meshStatus && meshR && !meshR.ok) sourceFailures.push(`modellmeshen (${meshR.category})`);
      // Gjennomgang av PR #316 (M-1): kan credential-kilden ikke svare, er det ukjent hvilke tilkoblinger som er konfigurert - og seksjonene over (som kun viser KONFIGURERTE tilkoblinger) er da ufullstendige, ikke «tomme og i orden».
      const credentialSourceNote = presenceR.ok
        ? unknownRefs > 0 ? `credential-kilden (${unknownRefs} av ${builtRefs.length} legitimasjoner kunne ikke måles${deps.toolGateway.secretsHealth?.() === "unavailable" ? "; kilden er utilgjengelig" : ""})` : null
        : `credential-kilden (${presenceR.category})`;
      if (credentialSourceNote !== null) sourceFailures.push(credentialSourceNote);
      const failNote = sourceFailures.length > 0 ? ` Kunne ikke leses: ${sourceFailures.join(", ")} - berørte tall er ukjente.` : "";
      const floor: ControlStatus = sourceFailures.length > 0 ? "UNKNOWN" : "OK";
      // «Ikke (fullt) konfigurert» avhenger kun av credential-kilden (hva som er målt fraværende) og frys/tilbakekall (en ukonfigurert connector kan likevel være pauset).
      const notConfiguredFloor: ControlStatus = credentialSourceNote !== null || !controlsR.ok ? "UNKNOWN" : "OK";
      const unmeasuredCount = notConfigured.filter((i) => i.facts?.["configuration"] === "unknown").length;

      const sections: ControlSection[] = [];
      sections.push(controlSection({
        id: "live", title_no: "Konfigurerte tilkoblinger med live-test", source: SOURCE_LIVE, observed_at: nowIso, status: floor,
        summary_no: `${live.length} tilkoblinger: ${countsNo(live)}. Scopes som vises er kravene handlingene deklarerer - innvilgede scopes måles ikke.${failNote}`, items: live
      }));
      sections.push(controlSection({
        id: "configured_other", title_no: "Konfigurerte uten live-test (inkl. modellleverandører)", source: `${SOURCE_LIVE} · modellmeshen · cost_events`, observed_at: nowIso, status: floor,
        summary_no: `${other.length} tilkoblinger: ${countsNo(other)}. Uten live-test er auth-helse kun kjent fra faktisk bruk.`, items: other
      }));
      sections.push(controlSection({
        id: "not_configured", title_no: "Ikke (fullt) konfigurert eller ikke målt", source: "connector-registeret + credential-presence (ToolGateway.secretPresence, tri-state, cachet 30 s; aldri verdier)", observed_at: nowIso, status: notConfiguredFloor,
        summary_no: notConfigured.length === 0
          ? (notConfiguredFloor === "OK" ? "Alle bygde tilkoblinger er konfigurert." : `Ingen tilkoblinger er målt som ukonfigurerte.${failNote}`)
          : `${[
            notConfigured.length - unmeasuredCount > 0 ? `${notConfigured.length - unmeasuredCount} bygde tilkoblinger mangler hele eller deler av legitimasjonen` : "",
            unmeasuredCount > 0 ? `${unmeasuredCount} kunne ikke måles (credential-kilden svarte ikke - de er IKKE målt som ukonfigurerte)` : ""
          ].filter((p) => p !== "").join("; ")}: ${joinFact(notConfigured.map((i) => i.label), 400)}.`,
        items: notConfigured
      }));

      // vedlikehold
      const maintItems: ControlItem[] = [];
      if (maintR.ok) {
        for (const v of views) {
          const m = maintById.get(v.def.id);
          if (!m) continue;
          maintItems.push(controlItem({
            id: v.def.id, label: v.def.display_name, status: m.minutes >= MAINTENANCE_WARN_MINUTES_30D ? "WARN" : "OK",
            detail_no: `${m.minutes} min over ${m.events} hendelser siste 30 døgn; siste: ${m.last_kind ?? "ukjent"} ${relativeNo(m.last_at, nowMs)}${m.last_by ? `; ført av ${m.last_by}` : ""}`,
            observed_at: m.last_at,
            facts: { minutes_30d: m.minutes, events_30d: m.events, last_event_kind: m.last_kind, last_event_at: m.last_at, maintenance_owner: m.last_by }
          }));
        }
        if (maintUnmatched.length > 0) {
          maintItems.push(controlItem({
            id: "_unmatched", label: "Hendelser på ukjente connector-navn", status: "OK",
            detail_no: `${maintUnmatched.reduce((a, m) => a + m.events, 0)} hendelser (${maintUnmatched.reduce((a, m) => a + m.minutes, 0)} min) er ført på navn som ikke finnes i connector-registeret`,
            facts: { events_30d: maintUnmatched.reduce((a, m) => a + m.events, 0), minutes_30d: maintUnmatched.reduce((a, m) => a + m.minutes, 0) }
          }));
        }
        maintItems.sort((a, b) => Number(b.facts?.["minutes_30d"] ?? 0) - Number(a.facts?.["minutes_30d"] ?? 0) || a.label.localeCompare(b.label, "nb"));
        const total = maintItems.reduce((a, i) => a + Number(i.facts?.["minutes_30d"] ?? 0), 0);
        sections.push(controlSection({
          id: "maintenance", title_no: "Vedlikeholdstid siste 30 døgn", source: "connector_maintenance_log (D-421, tenant-RLS)", observed_at: nowIso,
          summary_no: maintItems.length === 0 ? "Ingen vedlikehold registrert siste 30 døgn." : `${total} min totalt fordelt på ${maintItems.length} connectorer (varsel ved ${MAINTENANCE_WARN_MINUTES_30D} min eller mer per connector).`,
          items: maintItems
        }));
      } else {
        sections.push(unknownControlSection("maintenance", "Vedlikeholdstid siste 30 døgn", "connector_maintenance_log (D-421, tenant-RLS)", `kunne ikke leses (${maintR.category})`));
      }

      // daglige jobber
      if (jobsR.ok) {
        const jobItems: ControlItem[] = jobNames.map((name) => {
          const st = jobState(jobByName.get(name), nowMs);
          const users = Object.entries(CONNECTOR_SYNC_JOBS).filter(([, js]) => js.includes(name)).map(([id]) => id);
          return controlItem({
            id: name, label: name === CONNECTOR_HEALTH_SWEEP_JOB ? "Daglig helsesveip (alle live-testbare connectorer)" : name, status: st.status, detail_no: st.detail_no, observed_at: st.last_completed_at,
            facts: { last_completed_at: st.last_completed_at, lag_hours: st.lag_hours, connectors: name === CONNECTOR_HEALTH_SWEEP_JOB ? "alle med live-test" : users.join(", ") }
          });
        });
        jobItems.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "jobs", title_no: "Daglige jobber: helsesveip og synk", source: "scheduler_state (DailyScheduler, siste 14 døgn)", observed_at: nowIso,
          summary_no: `${jobItems.length} jobber: ${countsNo(jobItems)}. Forsinket = ikke fullført på over 36 timer.`, items: jobItems
        }));
      } else {
        sections.push(unknownControlSection("jobs", "Daglige jobber: helsesveip og synk", "scheduler_state (DailyScheduler, siste 14 døgn)", `kunne ikke leses (${jobsR.category})`));
      }

      sections.push(controlSection({
        id: "backlog", title_no: "Ikke bygget (backlog)", source: "connector-registeret (category backlog; D-232)", observed_at: nowIso,
        summary_no: backlog.length === 0 ? "Ingen backlog-punkter." : `${backlog.length} planlagte tilkoblinger er ikke bygget ennå (ikke en feil): ${joinFact(backlog.map((i) => i.label), 400)}.`,
        items: backlog
      }));

      return { sections, actions };
    }
  };
}
