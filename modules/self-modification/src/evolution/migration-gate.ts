import { z } from "zod";
import type { ChangeLedgerRow } from "../change-ledger.ts";

/**
 * WP-EV0 (Evolution Masterplan v1.2 kap. 7, H2-0.9): MIGRASJONSGATE - en deterministisk tilstandsmaskin for databaseendringer. Enhver skjemaendring er ALLTID E2
 * (eier signerer hvert trinn), og går i denne rekkefølgen, hvert trinn som sin egen endring:
 *   expand -> compatible_code -> backfill -> verify -> switch -> contract
 *   1. expand: legg til kompatible felter/tabeller/indekser uten destruktiv fjerning;
 *   2. compatible_code: kode som virker mot både gammel og ny skjemaform;
 *   3. backfill: i avgrensede jobber med observerbarhet og pause-/tilbakerullingsplan;
 *   4. verify: datakvalitet, ytelse, RLS/tenant-isolasjon og backup;
 *   5. switch: kontrollert bytte av lesing/skriving (gammel vei beholdes);
 *   6. contract: destruktiv fjerning, SEPARAT E2-endring, i en ANNEN deploy enn kodebyttet, tidligst etter observasjonsvinduet (fra switch), med ferskt backup.
 * Kode-tilbakerulling er ikke data-tilbakerulling: derfor er destruktive trinn kun lov i contract, og aldri i samme deploy som et tidligere trinn.
 *
 * REN logikk: ingenting utføres, ingen I/O. Porten avgjør kun om et trinn FÅR gå videre til eier. Tilstanden utledes av det append-only endringsregisteret
 * (`migrationStateFromLedger`), ALDRI av forslaget. Faktaene (`MigrationFacts`) må komme fra deterministisk måling (SQL-skanning, testkjøring, metrikker) - ikke fra
 * en modells påstand; et faktum som ikke er nøyaktig `true` (null, manglende, annen type) er IKKE oppfylt. DEFERRED: selve SQL-skanneren (krever diff-innhold, EV-6/EV-8).
 */
export const MIGRATION_PHASES = ["expand", "compatible_code", "backfill", "verify", "switch", "contract"] as const;
export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

/** Kortest tillatte observasjonsvindu mellom «switch» og «contract» (7 døgn: dekker en full ukentlig syklus). Kode-konstant: endres kun ved en eier-gjennomgått kodeendring. */
export const MIGRATION_CONTRACT_MIN_OBSERVATION_HOURS = 168;
const HOUR_MS = 3_600_000;

/** Målte fakta om et trinn. Alle er «ukjent» (null/manglende) som standard - ukjent er aldri «oppfylt». */
export const MigrationFactsSchema = z
  .object({
    /** Fjerner/omdøper/endrer trinnet data eller skjema destruktivt? Må være `false` før contract; contract kan være `true`. Ukjent avvises i alle faser. */
    destructive: z.boolean().nullable(),
    /** expand/compatible_code: gammel kode virker fortsatt / ny kode virker mot begge skjemaformer. */
    compatible_with_both_shapes: z.boolean().nullable(),
    /** backfill: avgrenset jobb (batcher, rate, tak). */
    bounded: z.boolean().nullable(),
    /** backfill: observerbar (fremdrift, feil, varsel). */
    observability: z.boolean().nullable(),
    /** backfill: eksakt plan for pause og tilbakerulling (ikke-tom tekst). */
    pause_and_rollback_plan: z.string().max(1000).nullable(),
    /** verify: målt datakvalitet, ytelse og RLS/tenant-isolasjon. */
    data_quality_ok: z.boolean().nullable(),
    performance_ok: z.boolean().nullable(),
    rls_tenant_isolation_ok: z.boolean().nullable(),
    /** verify og contract: ferskt, verifisert backup. */
    backup_ok: z.boolean().nullable(),
    /** switch: kontrollert bytte (ikke «alt på en gang»), og gammel vei beholdt for tilbakeføring. */
    controlled: z.boolean().nullable(),
    old_path_retained: z.boolean().nullable(),
    /** contract: målt at ingen leser/skriver den gamle formen lenger. */
    old_shape_unused: z.boolean().nullable()
  })
  .partial()
  .strict();
export type MigrationFacts = z.infer<typeof MigrationFactsSchema>;

/** Et FULLFØRT trinn (fra endringsregisteret). */
export interface MigrationStepRecord {
  phase: MigrationPhase;
  /** Hvert trinn er sin egen endring: id-en kan ikke gjenbrukes av et annet trinn. */
  change_id: string;
  deploy_id: string | null;
  /** ISO-8601 UTC. */
  completed_at: string;
}

export interface MigrationGateState {
  migration_id: string;
  steps: readonly MigrationStepRecord[];
}

export interface MigrationStepRequest {
  migration_id: string;
  phase: MigrationPhase;
  /** Den NYE endringen som skal utføre trinnet (ikke en tidligere trinns id). */
  change_id: string;
  /** Deployen trinnet går inn i. contract krever en egen, ny deploy. */
  deploy_id: string | null;
  /** Nå, ISO-8601 UTC. */
  now: string;
  facts: MigrationFacts;
}

export interface MigrationStepVerdict {
  /** Trinnet kan gå videre til eier. ALDRI «utfør»: porten utfører ingenting. */
  allowed: boolean;
  /** Alltid E2: ingen fase er E0/E1, og eier signerer hvert trinn (også et avvist forslag er en E2-sak). */
  change_class: "E2";
  needs_owner: true;
  phase: MigrationPhase | null;
  /** Fasen etter dette trinnet hvis det gjennomføres (null etter contract og når trinnet er avvist). */
  next_phase: MigrationPhase | null;
  reasons: string[];
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
/** Streng ISO-parser: kun `YYYY-MM-DDTHH:MM:SS(.fff)Z`. Alt annet er NaN (ugyldig). */
function parseIso(text: unknown): number {
  if (typeof text !== "string" || !ISO_UTC.test(text)) return Number.NaN;
  return Date.parse(text.replace(/(\.\d{3})\d+Z$/, "$1Z"));
}

/** Funn i selve tilstanden (tom liste = konsistent). Rekkefølge: id, antall, så pr. trinn (fase, id, tid), så contract. */
export function validateMigrationState(state: MigrationGateState): string[] {
  const issues: string[] = [];
  if (typeof state.migration_id !== "string" || state.migration_id.trim() === "") issues.push("state_inconsistent:migration_id_empty");
  if (state.steps.length > MIGRATION_PHASES.length) issues.push("state_inconsistent:too_many_steps");
  const seen = new Set<string>();
  let prevMs = Number.NEGATIVE_INFINITY;
  state.steps.forEach((s, i) => {
    if (s.phase !== MIGRATION_PHASES[i]) issues.push(`state_inconsistent:phase_order:${i}:${String(s.phase)}`);
    if (typeof s.change_id !== "string" || s.change_id.trim() === "") issues.push(`state_inconsistent:change_id_empty:${i}`);
    else if (seen.has(s.change_id)) issues.push(`state_inconsistent:change_id_reused:${s.change_id}`);
    else seen.add(s.change_id);
    const ms = parseIso(s.completed_at);
    if (Number.isNaN(ms)) issues.push(`state_inconsistent:time_invalid:${i}`);
    else {
      if (ms < prevMs) issues.push(`state_inconsistent:time_order:${i}`);
      prevMs = ms;
    }
  });
  const contract = state.steps[5];
  if (contract !== undefined) {
    if (contract.deploy_id === null || contract.deploy_id.trim() === "") issues.push("state_inconsistent:contract_deploy_missing");
    else if (state.steps.slice(0, 5).some((s) => s.deploy_id === contract.deploy_id)) issues.push("state_inconsistent:contract_shares_deploy");
  }
  return issues;
}

/** Neste lovlige fase for en KONSISTENT tilstand (null = migrasjonen er ferdig). */
export function nextMigrationPhase(state: MigrationGateState): MigrationPhase | null {
  return MIGRATION_PHASES[state.steps.length] ?? null;
}

const isTrue = (v: unknown): boolean => v === true;

export function evaluateMigrationStep(state: MigrationGateState, request: MigrationStepRequest): MigrationStepVerdict {
  const base = { change_class: "E2", needs_owner: true } as const;
  const phaseIndex = (MIGRATION_PHASES as readonly string[]).indexOf(request.phase);
  if (phaseIndex === -1) return { ...base, allowed: false, phase: null, next_phase: null, reasons: ["phase_unknown"] };

  const reasons: string[] = [];
  if (state.migration_id.trim() === "" || state.migration_id !== request.migration_id) reasons.push("migration_id_mismatch");

  const stateIssues = validateMigrationState(state);
  reasons.push(...stateIssues);
  if (stateIssues.length === 0) {
    const expected = MIGRATION_PHASES[state.steps.length];
    if (expected === undefined) reasons.push("migration_already_complete");
    else if (request.phase !== expected) {
      reasons.push(state.steps.some((s) => s.phase === request.phase) ? `phase_already_completed:${request.phase}` : `phase_out_of_order:expected_${expected}`);
    }
  }

  if (typeof request.change_id !== "string" || request.change_id.trim() === "") reasons.push("change_id_missing");
  else if (state.steps.some((s) => s.change_id === request.change_id)) reasons.push("change_id_reused");

  const nowMs = parseIso(request.now);
  if (Number.isNaN(nowMs)) reasons.push("time_invalid");
  else {
    const last = state.steps[state.steps.length - 1];
    if (last !== undefined && nowMs < parseIso(last.completed_at)) reasons.push("clock_before_last_step");
  }

  const facts = request.facts ?? {};
  if (facts.destructive === undefined || facts.destructive === null) reasons.push("destructive_unknown");
  else if (facts.destructive === true && request.phase !== "contract") reasons.push("destructive_before_contract");

  switch (request.phase) {
    case "expand":
      if (!isTrue(facts.compatible_with_both_shapes)) reasons.push("expand_not_compatible_with_old_code");
      break;
    case "compatible_code":
      if (!isTrue(facts.compatible_with_both_shapes)) reasons.push("compatible_code_not_compatible_with_both_shapes");
      break;
    case "backfill":
      if (!isTrue(facts.bounded)) reasons.push("backfill_not_bounded");
      if (!isTrue(facts.observability)) reasons.push("backfill_observability_missing");
      if (typeof facts.pause_and_rollback_plan !== "string" || facts.pause_and_rollback_plan.trim() === "") reasons.push("backfill_pause_rollback_plan_missing");
      break;
    case "verify":
      if (!isTrue(facts.data_quality_ok)) reasons.push("verify_data_quality_not_ok");
      if (!isTrue(facts.performance_ok)) reasons.push("verify_performance_not_ok");
      if (!isTrue(facts.rls_tenant_isolation_ok)) reasons.push("verify_rls_tenant_isolation_not_ok");
      if (!isTrue(facts.backup_ok)) reasons.push("verify_backup_not_ok");
      break;
    case "switch":
      if (!isTrue(facts.controlled)) reasons.push("switch_not_controlled");
      if (!isTrue(facts.old_path_retained)) reasons.push("switch_old_path_not_retained");
      break;
    case "contract": {
      if (!isTrue(facts.backup_ok)) reasons.push("contract_backup_not_fresh");
      if (!isTrue(facts.old_shape_unused)) reasons.push("contract_old_shape_still_in_use");
      // Egen deploy: contract kan aldri gå ut sammen med kodebyttet (eller noe annet tidligere trinn).
      if (request.deploy_id === null || typeof request.deploy_id !== "string" || request.deploy_id.trim() === "") reasons.push("contract_deploy_missing");
      else if (state.steps.some((s) => s.deploy_id === request.deploy_id)) reasons.push("contract_same_deploy_as_earlier_step");
      // Observasjonsvinduet måles fra SWITCH (trinn 5), ikke fra et annet trinn.
      const sw = state.steps[4];
      if (sw !== undefined && !Number.isNaN(nowMs)) {
        const switchMs = parseIso(sw.completed_at);
        if (!Number.isNaN(switchMs)) {
          const hours = Math.max(0, (nowMs - switchMs) / HOUR_MS);
          if (hours < MIGRATION_CONTRACT_MIN_OBSERVATION_HOURS) reasons.push(`contract_observation_window_open:${Math.floor(hours)}/${MIGRATION_CONTRACT_MIN_OBSERVATION_HOURS}`);
        }
      }
      break;
    }
  }

  const allowed = reasons.length === 0;
  return { ...base, allowed, phase: request.phase, next_phase: allowed ? (MIGRATION_PHASES[phaseIndex + 1] ?? null) : null, reasons };
}

/** Trinnet slik det er skrevet i endringsregisterets evidens (`evidence.migration`). */
const LedgerMigrationEvidenceSchema = z
  .object({
    migration: z.object({ migration_id: z.string().min(1), phase: z.enum(MIGRATION_PHASES), deploy_id: z.string().min(1).nullable().optional() })
  })
  .passthrough();

/**
 * Bygger migrasjonens tilstand fra endringsregisteret (aldri fra et forslag): en `deployed`-rad med `evidence.migration` for denne id-en er et fullført trinn;
 * en `rolled_back`-rad fjerner trinnet med samme `change_id`. Rader sorteres tallmessig på `seq`. Alt annet (andre id-er, andre beslutninger, ugyldig evidens)
 * ignoreres. En historikk som ikke henger sammen avsløres av `validateMigrationState` (og blokkerer da alle videre trinn).
 */
export function migrationStateFromLedger(
  rows: readonly Pick<ChangeLedgerRow, "seq" | "change_id" | "decision" | "evidence" | "at_text">[],
  migrationId: string
): MigrationGateState {
  const sorted = [...rows].sort((a, b) => {
    const x = BigInt(a.seq);
    const y = BigInt(b.seq);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  let steps: MigrationStepRecord[] = [];
  for (const row of sorted) {
    if (row.decision === "rolled_back") {
      steps = steps.filter((s) => s.change_id !== row.change_id);
      continue;
    }
    if (row.decision !== "deployed") continue;
    let parsed: z.SafeParseReturnType<unknown, z.infer<typeof LedgerMigrationEvidenceSchema>>;
    try {
      parsed = LedgerMigrationEvidenceSchema.safeParse(JSON.parse(row.evidence));
    } catch {
      continue;
    }
    if (!parsed.success || parsed.data.migration.migration_id !== migrationId) continue;
    const ms = parseIso(row.at_text);
    steps.push({
      phase: parsed.data.migration.phase,
      change_id: row.change_id,
      deploy_id: parsed.data.migration.deploy_id ?? null,
      completed_at: Number.isNaN(ms) ? row.at_text : new Date(ms).toISOString()
    });
  }
  return { migration_id: migrationId, steps };
}
