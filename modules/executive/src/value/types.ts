/**
 * WP-C4 (D-450-mandatet, Value Track kap. 9 i masterplan v4.0; UA0-RUNRATE «Value-loop-bruksmetrikk»): Value Center - ÉN ærlig rapport over hvor mye Jarvis faktisk BLIR BRUKT og HJELPER, per verdiløkke
 * (V1-V5) og for kjernebruk (jobber, samtaler, bekreftelser, kost). Rapporten er RENT lesende og bærer KUN tall, tellinger, tidsstempler og faste norske etiketter: aldri meldingstekst, tittel, mål, årsak
 * eller annen persondata. En måling som ikke kan gjøres er `not_measurable` med årsak - aldri et påstått 0 (samme disiplin som SLO `UNKNOWN` og `unknownSection` i evolusjonsrapporten).
 */
import type { JsonValue } from "@jarvis/contracts";

/** Verdiløkkene i Value Track (masterplan v4.0 kap. 9). */
export type ValueLoopId = "V1" | "V2" | "V3" | "V4" | "V5";

/** Hvor en metrikk hører hjemme i rapporten (V1/V2 = verdiløkkene med bruksmetrikk; resten er kjernebruk). */
export type ValueGroup = "V1" | "V2" | "tasks" | "chat" | "approvals" | "cost" | "ops";

export type ValueUnit = "count" | "days" | "ratio" | "seconds" | "ore";

/** `window` = telling i siste 7/30 døgn; `snapshot` = tilstanden akkurat nå. */
export type ValueShape = "window" | "snapshot";

export interface ValueMetricDef {
  /** Stabil nøkkel (`v1.briefs_generated`). Aldri gjenbrukt for et annet tall. */
  id: string;
  group: ValueGroup;
  label_no: string;
  unit: ValueUnit;
  shape: ValueShape;
  /** Tabellen/kilden tallet leses fra (vises i rapporten). Alltid en fast streng, aldri data. */
  source: string;
  /** Definisjon/forbehold i klartekst (hva tallet faktisk teller). */
  note_no?: string;
  /** Kilden finnes ikke (bevisst ikke bygget): ALLTID `not_measurable` med denne årsaken - aldri 0. */
  never_measurable_reason_no?: string;
  /** Avledet metrikk: sum(num) / sum(den) per vindu (null når nevneren er 0 eller en inngang mangler). Ingen egen kilde. */
  derive?: { num: string; den: readonly string[] };
}

/** Ett måleresultat fra en kilde for én metrikk-id. */
export type ValueMeasurement =
  | { id: string; state: "measured"; now?: number | null; last_7d?: number | null; last_30d?: number | null }
  | { id: string; state: "not_measurable"; reason_no: string };

export interface ValueWindows {
  /** Siste 7 lokale døgn (Europe/Oslo), inkludert i dag. */
  d7: { from: string; to: string };
  /** Siste 30 lokale døgn (Europe/Oslo), inkludert i dag. */
  d30: { from: string; to: string };
}

export interface ValueMeasurementSet {
  windows: ValueWindows;
  measurements: ValueMeasurement[];
}

/** Kilde-port: DB-implementasjonen bor i `apps/api` (lesing som app-rolle under RLS). Kaster aldri for en enkeltmåling - en feilet måling returneres som `not_measurable`. */
export interface ValueMeasurementSource {
  measure(tenantId: string): Promise<ValueMeasurementSet>;
}

export interface ValueMetric {
  id: string;
  group: ValueGroup;
  label_no: string;
  unit: ValueUnit;
  shape: ValueShape;
  state: "measured" | "not_measurable";
  /** Verdi akkurat nå (kun `snapshot`). null = ikke aktuelt for formen, eller ingen grunnlag. */
  now: number | null;
  /** Verdi siste 7 døgn (kun `window`). null = ikke aktuelt, eller ingen grunnlag (aldri et påstått 0). */
  last_7d: number | null;
  last_30d: number | null;
  source: string;
  note_no?: string;
  /** Hvorfor metrikken ikke er målbar (kun `not_measurable`). */
  reason_no?: string;
}

/** Statusord fra lukkingsmatrisen (CLOSURE_MATRIX_HF1_HF2): hva løkken faktisk er i denne kjøringen. `unknown` = kjøretidsfakta er ikke tilgjengelige (aldri gjettet til «i drift»). */
export type LoopState = "wired" | "dormant" | "built_unwired" | "not_built" | "unknown";

export interface ValueLoopStatus {
  id: ValueLoopId;
  title_no: string;
  state: LoopState;
  detail_no: string;
}

/** Fakta om kjøringen som styrer løkke-statusene. Alt er flagg/tall fra konfig og oppstartssjekker - aldri innhold. */
export interface ValueRuntimeFacts {
  /** V1: er daglig levering (Telegram + DailyScheduler) konfigurert i denne kjøringen? */
  v1_delivery_configured: boolean;
  v2_push: { enabled: boolean; channel_configured: boolean; max_per_day: number; quiet_hours: string };
  v5_proposals_enabled: boolean;
  /** EV-0 oppstartssjekk. null = sjekken har ikke kjørt (ukjent). */
  ev0: { constitution_verified: boolean | null; ledger_ok: boolean | null };
  /** null = kunne ikke leses (behandles fail-closed som PÅ). */
  kill_switch_active: boolean | null;
  /** Porter eieren har erklært verifisert (`JARVIS_VALUE_VERIFIED_GATES`). Aldri utledet av kode. */
  declared_gates: readonly string[];
}

export type OpsRisk = "A" | "B" | "C" | "D";
export type OpsActionId = "rerun_connector_test" | "run_backup" | "cleanup_artifacts" | "restart_service";

/** Et ToolGateway-kall en GODKJENT handling ville kjørt. V5 utfører det aldri; det er en beskrivelse av den eksisterende veien. */
export interface OpsProposedCall {
  tool_id: string;
  action: string;
  parameters: Record<string, JsonValue>;
}

export interface OpsProposal {
  /** `<handling>:<mål>` - stabil, brukes til deduplisering når et forslag senere skal leveres. */
  id: string;
  action_id: OpsActionId;
  title_no: string;
  /** Kort begrunnelse som KUN bruker tall/kategorier fra målingene - aldri fritekst fra kilder. */
  rationale_no: string;
  trigger: { area: string; status: string };
  risk_class: OpsRisk;
  /** A-C: eierens bekreftelse. D: signert godkjenning (step-up). Aldri direkte utførelse. */
  requires: "owner_confirmation" | "step_up";
  /** Hvilken eksisterende vei en godkjent handling går. */
  execution_path: "tool_gateway" | "host_runbook";
  proposed_calls: OpsProposedCall[];
  /** Klartekst: hva eieren/verten gjør (kommando eller dashbord-steg). */
  how_no: string;
  rollback_no: string;
  /** ALLTID false: dette laget utfører ingenting. */
  executes: false;
}

export interface OpsProposalReport {
  /** `JARVIS_V5_PROPOSALS_ENABLED`. Av som standard. */
  enabled: boolean;
  proposals: OpsProposal[];
  /** Regler som ikke kunne vurderes (manglende måling) eller ikke ga forslag - aldri stille utelatt. */
  skipped_no: string[];
}

export type BuilderRequirementKind = "technical" | "owner_decision";

export interface BuilderRequirement {
  id: string;
  label_no: string;
  kind: BuilderRequirementKind;
  /** Oppfylt ut fra målt/erklært fakta. Et `owner_decision`-krav er ALDRI oppfylt av kode. */
  met: boolean;
  /** Fakta kunne ikke fastslås (ikke det samme som «ikke oppfylt»). */
  unknown: boolean;
}

/** V3 Builder Loop: beredskapsvurdering for en SOVENDE løkke. Svarer kun på «hva mangler før eieren kan ta en D-beslutning?» - aktiverer aldri noe. */
export interface BuilderLoopVerdict {
  loop: "V3";
  title_no: string;
  why_dormant_no: string;
  /** ALLTID false i kode: ingen kodevei kan aktivere løkken eller starte selvmodifikasjon (D-397). */
  activation_decision: false;
  /** Alle TEKNISKE krav er oppfylt. Det er et sjekklistesvar, ikke en bryter - eierens navngitte D-beslutning kommer i tillegg. */
  ready_for_owner_decision: boolean;
  requirements: BuilderRequirement[];
  met: string[];
  missing: Array<{ id: string; label_no: string; unknown: boolean }>;
}

export interface ValueReport {
  as_of: string;
  time_zone: "Europe/Oslo";
  /** null når kilden ikke kunne levere vinduene. */
  windows: ValueWindows | null;
  metrics: ValueMetric[];
  loops: ValueLoopStatus[];
  builder_loop: BuilderLoopVerdict;
  ops_proposals: OpsProposalReport;
  /** Hva som ikke er målt (faste punkter + kilder som sviktet nå). Aldri stille utelatt. */
  not_measured: string[];
  /** Deterministisk norsk oppsummering (ingen LLM). */
  summary_no: string;
}
