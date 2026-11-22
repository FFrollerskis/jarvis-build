/**
 * WP-K (D-471, JARVIS-054): korrelasjon for planlagte (scheduler-drevne) kjøringer.
 *
 * Bakgrunn: bedrifts-/support-/samtalegraf-synkene kaller `ToolGateway.execute()` som `person_id: "system"` (en systemprinsipal - ALDRI en oppdiktet person). Uten en oppgave-/spor-ID
 * ble revisjonsradene deres (`audit_events`) og policy-avgjørelsene (`policy_decisions`) stående uten sammenheng med jobben som utløste dem: «hva skjedde kl. 03:17?» kunne ikke besvares.
 * Nå bærer HVER planlagte kjøring en `RunCorrelation` som sendes videre til `execute({ task_id, trace_id })`, slik at alle rader fra samme kjøring deler ID-ene.
 *
 *  - `task_id` er STABIL per jobb og dag (`sched:<jobb>:<dato>`): alle forsøk samme dag (retry etter feil, overtatt claim) hører til samme logiske oppgave.
 *  - `trace_id` er UNIK per forsøk (`sched-<jobb>-<dato>-a<forsøk>`): to forsøk samme dag kan skilles, og en rad kan knyttes til nøyaktig den kjøringen som skrev den.
 *
 * ID-ene er rene identifikatorer (a-z, 0-9, `.`, `_`, `-`, `:`) - aldri brukerinnhold, aldri hemmeligheter.
 */
export interface RunCorrelation {
  task_id: string;
  trace_id: string;
}

const SAFE = /[^A-Za-z0-9._-]+/g;

function part(value: string, max: number): string {
  const cleaned = value.replace(SAFE, "-").replace(/^-+|-+$/g, "").slice(0, max);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** Korrelasjon for ett forsøk av en planlagt jobb. `attempt` klemmes til minst 1. */
export function scheduledRunCorrelation(jobName: string, runDate: string, attempt: number): RunCorrelation {
  const job = part(jobName, 60);
  const date = part(runDate, 10);
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.trunc(attempt) : 1;
  return { task_id: `sched:${job}:${date}`, trace_id: `sched-${job}-${date}-a${n}` };
}

/** Plukker kun de to korrelasjons-ID-ene (et `ScheduledRun` har flere felt) og dropper alt annet - brukes når en korrelasjon sendes videre til `execute()`. Tom/manglende ID utelates. */
export function correlationFields(correlation: { task_id?: string | undefined; trace_id?: string | undefined } | undefined): { task_id?: string; trace_id?: string } {
  if (correlation === undefined) return {};
  return {
    ...(typeof correlation.task_id === "string" && correlation.task_id.length > 0 ? { task_id: correlation.task_id } : {}),
    ...(typeof correlation.trace_id === "string" && correlation.trace_id.length > 0 ? { trace_id: correlation.trace_id } : {})
  };
}
