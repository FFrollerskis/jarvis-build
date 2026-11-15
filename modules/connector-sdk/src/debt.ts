import type { HealthState } from "./health-state.ts";

/**
 * WP-I (D-472): CONNECTOR-GJELD som ren LESEMODELL (masterplan kap. 10: «Connector debt is measured: auth failures, API changes, maintenance hours, incident count, sync lag and deprecation risk»,
 * og vedlikeholdsregelen kap. 20: «a connector that repeatedly costs more maintenance than the value loop it supports should be simplified, replaced or retired»).
 *
 * KUN en ren funksjon over data som FINNES i dag - ingen ny tabell, ingen skriving, ingen kjøretidskobling:
 *  - vedlikeholdsjournalen `connector_maintenance_log` (migrasjon 077; `event_kind` incident/credential_rotation/api_change/manual_fix/upgrade/outage/other, `minutes`, `occurred_at`),
 *  - auth-feil og helsetilstand (`tool.failed`-revisjon klassifisert av `classifyFailureReason`, `ToolGateway.health`) slik Integrasjonssenteret allerede leser dem,
 *  - synk-forsinkelse (`jobState().lag_hours`, daglig `DailyScheduler`) og API-versjon/utfasing (`CONNECTOR_API_FACTS`).
 *
 * ÆRLIGHET: en faktor som ikke er MÅLT er `unknown` og teller aldri som null gjeld (en connector uten data er ukjent, ikke «ren»). Utfasingsrisiko kan bare være kjent-høy eller ukjent: repoet kjenner ingen
 * «ingen utfasing»-tilstand (Integrasjonssenteret viser det samme). Scoren er et grovt sorteringsverktøy for eierens vedlikeholdsbudsjett - ikke en dom, og `review_for_retirement` er en oppfordring til å se på
 * connectoren, aldri en beslutning om å avvikle den.
 *
 * WIRING MOT INTEGRASJONSSENTERET: DEFERRED. Senteret leser i dag vedlikeholdsjournalen aggregert per connector (ikke per `event_kind`), og `wph0-integration-center.test.ts` låser seksjonslisten; å eksponere gjelden
 * krever en ny gruppert spørring (`GROUP BY connector_id, event_kind`), en ny seksjon og en avhengighet fra apps/api til denne pakken. Se `docs/runbooks/WPI_CONNECTOR_SDK.md`.
 */

export const DEBT_EVENT_KINDS = ["incident", "credential_rotation", "api_change", "manual_fix", "upgrade", "outage", "other"] as const;
export type DebtEventKind = (typeof DEBT_EVENT_KINDS)[number];

/** Aggregert vedlikeholdsjournal (en `GROUP BY connector_id, event_kind`-spørring over `connector_maintenance_log` i vinduet). */
export interface DebtLedgerGroup {
  event_kind: DebtEventKind;
  events: number;
  minutes: number;
}

export interface DebtInput {
  connector_id: string;
  /** Bygd connector (registerkategori ikke backlog). Backlog har ingen gjeld å måle. */
  built: boolean;
  /** Vinduet gjelden regnes over (standard 30 døgn, samme som Integrasjonssenterets vedlikeholdsseksjon). */
  window_days?: number;
  /** `null` = journalen kunne ikke leses (ukjent, aldri null). En tom liste = lest, ingen hendelser. */
  ledger: readonly DebtLedgerGroup[] | null;
  /** `null` = auth-helse er ikke målt (ingen kall/ingen helsesveip). */
  auth: { failures_in_window: number; current_health: HealthState | null } | null;
  /** `null` = connectoren har ingen daglig synk-jobb. `lag_hours: null` = jobben finnes, men forsinkelsen er ikke målt. */
  sync: { lag_hours: number | null; expected_interval_hours: number } | null;
  /** `null` = API-fakta er ikke oppgitt. `deprecation_documented` = repoet dokumenterer en kjent utfasing (CONNECTOR_API_FACTS.deprecation_no). */
  api: { version_known: boolean; deprecation_documented: boolean } | null;
  /** Hvem som vedlikeholder (siste `recorded_by` i journalen), hvis kjent. */
  maintenance_owner?: string | null;
}

export type DebtLevel = "ok" | "watch" | "high" | "unknown";

export const DEBT_FACTOR_IDS = ["auth_failures", "api_changes", "maintenance_hours", "incident_count", "sync_lag", "deprecation_risk"] as const;
export type DebtFactorId = (typeof DEBT_FACTOR_IDS)[number];

export interface DebtFactor {
  id: DebtFactorId;
  /** `null` = ikke målt. */
  value: number | null;
  unit: string;
  level: DebtLevel;
  detail_no: string;
}

export interface DebtThresholds {
  /** Vedlikeholdstid i timer i vinduet: `watch` fra (180 min = Integrasjonssenterets varselgrense), `high` fra. */
  maintenance_hours_watch: number;
  maintenance_hours_high: number;
  incidents_watch: number;
  incidents_high: number;
  api_changes_watch: number;
  api_changes_high: number;
  auth_failures_watch: number;
  auth_failures_high: number;
  /** Synk-forsinkelse som multiplum av forventet intervall. */
  sync_lag_watch_x: number;
  sync_lag_high_x: number;
}

export const DEFAULT_DEBT_THRESHOLDS: Readonly<DebtThresholds> = {
  maintenance_hours_watch: 3, maintenance_hours_high: 8,
  incidents_watch: 1, incidents_high: 3,
  api_changes_watch: 1, api_changes_high: 2,
  auth_failures_watch: 1, auth_failures_high: 3,
  sync_lag_watch_x: 1.5, sync_lag_high_x: 3
};

export interface ConnectorDebt {
  connector_id: string;
  /** `unknown` når færre enn to faktorer er målt (for lite data til å si noe). */
  level: "low" | "moderate" | "high" | "unknown";
  /** 0-100 over de MÅLTE faktorene (0 = ingen gjeld), `null` når for lite er målt. */
  score: number | null;
  measured_factors: number;
  unmeasured_factors: DebtFactorId[];
  factors: DebtFactor[];
  /** Gjentatt vedlikeholdskostnad (mye tid OG gjentatte hendelser): se på connectoren - forenkle, erstatt eller avvikle (kap. 20). Aldri en beslutning. */
  review_for_retirement: boolean;
  recommendation_no: string;
}

const hours = (minutes: number): number => Math.round((minutes / 60) * 10) / 10;

function bump(value: number, watch: number, high: number): DebtLevel {
  return value >= high ? "high" : value >= watch ? "watch" : "ok";
}

/** En gyldig MÅLING: et endelig, ikke-negativt tall. NaN, Infinity og negative tall er ikke målinger - de er ukjent, aldri «ok» (en sammenligning med NaN er alltid usann og ga før stille nivå `ok`). */
const isMeasure = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

export function computeConnectorDebt(input: DebtInput, overrides: Partial<DebtThresholds> = {}): ConnectorDebt {
  const t: DebtThresholds = { ...DEFAULT_DEBT_THRESHOLDS, ...overrides };
  const window = input.window_days ?? 30;
  const unknown = (id: DebtFactorId, unit: string, why: string): DebtFactor => ({ id, value: null, unit, level: "unknown", detail_no: `ikke målt: ${why}` });
  const factors: DebtFactor[] = [];

  if (!input.built) {
    return {
      connector_id: input.connector_id, level: "unknown", score: null, measured_factors: 0, unmeasured_factors: [...DEBT_FACTOR_IDS],
      factors: DEBT_FACTOR_IDS.map((id) => unknown(id, "", "connectoren er ikke bygget (backlog)")),
      review_for_retirement: false, recommendation_no: "Ikke bygget (backlog): ingen gjeld å måle."
    };
  }

  // Vedlikeholdsjournalen -> vedlikeholdstimer, hendelser og API-endringer.
  const ledger = input.ledger;
  const sum = (kinds: readonly DebtEventKind[], pick: "events" | "minutes"): number => (ledger ?? []).filter((g) => kinds.includes(g.event_kind)).reduce((a, g) => a + g[pick], 0);
  const ledgerWhy = ledger === null ? "vedlikeholdsjournalen kunne ikke leses" : ledger.every((g) => isMeasure(g.events) && isMeasure(g.minutes)) ? null : "vedlikeholdsjournalen har ugyldige tall (ikke endelige eller negative)";
  if (ledgerWhy !== null) {
    factors.push(unknown("maintenance_hours", "timer", ledgerWhy), unknown("incident_count", "hendelser", ledgerWhy), unknown("api_changes", "endringer", ledgerWhy));
  } else {
    const h = hours(sum(DEBT_EVENT_KINDS, "minutes"));
    factors.push({ id: "maintenance_hours", value: h, unit: "timer", level: bump(h, t.maintenance_hours_watch, t.maintenance_hours_high), detail_no: `${h} timer vedlikehold siste ${window} døgn` });
    const inc = sum(["incident", "outage"], "events");
    factors.push({ id: "incident_count", value: inc, unit: "hendelser", level: bump(inc, t.incidents_watch, t.incidents_high), detail_no: `${inc} hendelse(r) (incident/outage) siste ${window} døgn` });
    const api = sum(["api_change"], "events");
    factors.push({ id: "api_changes", value: api, unit: "endringer", level: bump(api, t.api_changes_watch, t.api_changes_high), detail_no: `${api} API-endring(er) ført siste ${window} døgn` });
  }

  // Auth: feil i vinduet, og en pågående auth-feil er alltid høy.
  if (input.auth === null) factors.push(unknown("auth_failures", "feil", "ingen auth-helse målt (ingen kall eller helsesveip)"));
  else if (!isMeasure(input.auth.failures_in_window)) factors.push(unknown("auth_failures", "feil", "ugyldig måling av auth-feil (ikke et endelig, ikke-negativt tall)"));
  else {
    const f = input.auth.failures_in_window;
    const now = input.auth.current_health === "auth_failed";
    factors.push({ id: "auth_failures", value: f, unit: "feil", level: now ? "high" : bump(f, t.auth_failures_watch, t.auth_failures_high), detail_no: `${f} auth-feil siste ${window} døgn${now ? "; auth feiler akkurat nå" : ""}` });
  }

  // Synk-forsinkelse.
  if (input.sync === null) factors.push(unknown("sync_lag", "timer", "connectoren har ingen daglig synk-jobb"));
  else if (input.sync.lag_hours === null) factors.push(unknown("sync_lag", "timer", "synk-forsinkelsen er ikke målt (jobben har ikke kjørt)"));
  // Review LOW: NaN/negativ forsinkelse og et intervall som er NaN, 0 eller negativt ga `x` = NaN/Infinity/negativ, og sammenligningene under ga stille «ok» (fail-open). Ugyldig måling er ukjent.
  else if (!isMeasure(input.sync.lag_hours) || !isMeasure(input.sync.expected_interval_hours) || input.sync.expected_interval_hours === 0) factors.push(unknown("sync_lag", "timer", "ugyldig synk-måling (forsinkelse ikke endelig/negativ, eller forventet intervall ikke et positivt tall)"));
  else {
    const x = input.sync.lag_hours / input.sync.expected_interval_hours;
    factors.push({ id: "sync_lag", value: input.sync.lag_hours, unit: "timer", level: x >= t.sync_lag_high_x ? "high" : x >= t.sync_lag_watch_x ? "watch" : "ok", detail_no: `synk ${input.sync.lag_hours} t bak (forventet intervall ${input.sync.expected_interval_hours} t)` });
  }

  // Utfasing: kun kjent-høy eller ukjent - repoet kjenner ingen «ingen utfasing»-tilstand.
  if (input.api === null) factors.push(unknown("deprecation_risk", "", "API-fakta er ikke oppgitt"));
  else if (input.api.deprecation_documented) factors.push({ id: "deprecation_risk", value: 1, unit: "", level: "high", detail_no: "repoet dokumenterer en kjent utfasing hos leverandøren" });
  else factors.push(unknown("deprecation_risk", "", input.api.version_known ? "koden kjenner ingen utfasingsdato (ukjent, ikke «ingen utfasing»)" : "API-versjonen er ikke oppgitt i koden"));

  const order = new Map(DEBT_FACTOR_IDS.map((id, i) => [id, i]));
  factors.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const measured = factors.filter((f) => f.level !== "unknown");
  const points = measured.reduce((a, f) => a + (f.level === "high" ? 2 : f.level === "watch" ? 1 : 0), 0);
  const enough = measured.length >= 2;
  const score = enough ? Math.round((points / (2 * measured.length)) * 100) : null;
  const anyHigh = measured.some((f) => f.level === "high");
  const level: ConnectorDebt["level"] = !enough ? "unknown" : anyHigh || (score ?? 0) >= 60 ? "high" : measured.some((f) => f.level === "watch") || (score ?? 0) >= 25 ? "moderate" : "low";
  const byId = (id: DebtFactorId): DebtFactor | undefined => factors.find((f) => f.id === id);
  const review = (byId("maintenance_hours")?.level === "high") && (byId("incident_count")?.value ?? 0) >= 2;
  const owner = input.maintenance_owner ? ` Vedlikeholdseier: ${input.maintenance_owner}.` : "";
  const unmeasured = factors.filter((f) => f.level === "unknown").map((f) => f.id);
  return {
    connector_id: input.connector_id, level, score, measured_factors: measured.length, unmeasured_factors: unmeasured, factors,
    review_for_retirement: review,
    recommendation_no: (review
      ? "Gjentatt vedlikeholdskostnad: vurder å forenkle, erstatte eller avvikle connectoren hvis verdi-løkken den støtter ikke veier opp (kap. 20)."
      : level === "unknown" ? `For lite målt til å si noe (${unmeasured.length} av ${DEBT_FACTOR_IDS.length} faktorer ikke målt).`
        : level === "high" ? "Høy gjeld: se på de høye faktorene først."
          : level === "moderate" ? "Moderat gjeld: følg med."
            : "Lav gjeld på det som er målt.") + owner
  };
}

/** Sammenstilling over alle connectorer (sortert høyest gjeld først; ukjent sist). */
export function summarizeConnectorDebt(debts: readonly ConnectorDebt[]): { by_level: Record<ConnectorDebt["level"], number>; ranked: ConnectorDebt[]; review_for_retirement: string[]; unknown_ids: string[] } {
  const by_level: Record<ConnectorDebt["level"], number> = { low: 0, moderate: 0, high: 0, unknown: 0 };
  for (const d of debts) by_level[d.level] += 1;
  const ranked = [...debts].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.connector_id.localeCompare(b.connector_id));
  return { by_level, ranked, review_for_retirement: debts.filter((d) => d.review_for_retirement).map((d) => d.connector_id).sort(), unknown_ids: debts.filter((d) => d.level === "unknown").map((d) => d.connector_id).sort() };
}

/** Bygger en `DebtLedgerGroup[]` fra rå journalrader innenfor vinduet (for kallere som ikke har en GROUP BY-spørring). */
export function groupLedgerRows(rows: ReadonlyArray<{ event_kind: string; minutes: number; occurred_at: string }>, now: Date, windowDays = 30): DebtLedgerGroup[] {
  const since = now.getTime() - windowDays * 86_400_000;
  const groups = new Map<DebtEventKind, DebtLedgerGroup>();
  for (const r of rows) {
    const t = Date.parse(r.occurred_at);
    if (Number.isNaN(t) || t < since || t > now.getTime()) continue;
    const kind = (DEBT_EVENT_KINDS as readonly string[]).includes(r.event_kind) ? (r.event_kind as DebtEventKind) : "other";
    const g = groups.get(kind) ?? { event_kind: kind, events: 0, minutes: 0 };
    g.events += 1;
    g.minutes += Math.max(0, r.minutes);
    groups.set(kind, g);
  }
  return [...groups.values()];
}
