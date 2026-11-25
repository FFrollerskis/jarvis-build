import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { autonomyBindabilityOf } from "@jarvis/tool-gateway";
import { autonomyActionBlocker } from "./autonomy-guard.ts";
import { NEVER_ACT_DOMAINS, ruleByKey } from "./signal-types.ts";
import type { Situation, SituationAutonomyPolicy } from "./types.ts";

/**
 * WP-G4 (D-466), UA-10 P2d: KONTRAFAKTISK SIMULERING («hva om vi hadde handlet / ikke handlet») for en situasjon. REN funksjon over REGISTRERTE hendelser (situasjonen, dens signallogg og tidligere LIGNENDE situasjoner for samme regel):
 * ingen I/O, ingen klokke (`nowMs` injiseres), ingen modell og INGEN SIDEEFFEKT - den utfører, bestiller og endrer ingenting. Resultatet er SUGGEST-bevis for eieren («slik hadde det gått, med disse antakelsene»), aldri en handling.
 *
 * Hva som beregnes (deterministisk, med eksplisitte antakelser og forbehold):
 *  - Observert utfall: hvor lenge situasjonen varte (åpnet -> løst, eller så langt hvis den fortsatt er åpen) og hva eieren selv mente om lignende varsler (nyttig/støy).
 *  - Scenario «handlet ved forslaget»: ville motoren kunne handlet, og hva ville det kostet i godkjenning? Tid spart anslås KUN fra observerte varigheter (median for lignende LØSTE situasjoner minus tiden til forslaget
 *    minus en fast utførelsestid); finnes ikke nok observasjoner, er anslaget `null` (aldri gjettet). Handlingens risikoklasse og om eieren må godkjenne står eksplisitt (step-up leses fra verktøydefinisjonen - ikke fra klassen - og nektes autonomt, Q-55; fysiske/kritiske handlinger utføres aldri av motoren, `autonomy-guard.ts`).
 *  - Scenario «ikke handlet»: eksponeringstid så langt og forventet varighet fra lignende situasjoner.
 *  - Anbefaling: `keep_inform_only` for domener der ACT er forbudt eller når eieren oftest svarer «støy»; `already_bound` når eieren allerede har en aktiv binding for domenet; `consider_binding` KUN når det ikke finnes en binding,
 *    det finnes nok løste lignende situasjoner (minst tre) og eieren oftest svarer «nyttig»; ellers `insufficient_data`. Anbefalingen er et forslag til eieren - ingenting endres av at den gis.
 */
export const SIMULATION_MIN_SIMILAR_RESOLVED = 3;
/** Fast antakelse: en autonom handling tar ca. ett minutt fra forslaget (utførelse + readback). Står i `assumptions`. */
export const ASSUMED_ACTION_MINUTES = 1;

export interface SimilarSituation {
  situation_id: string;
  opened_at: string | Date;
  resolved_at: string | Date | null;
  status: "open" | "resolved";
  /** Eierens siste vurdering av denne situasjonen, hvis noen. */
  verdict: "useful" | "noise" | null;
}

export interface SimulationBinding {
  /** Finnes en AKTIVERT, ikke-utløpt eier-binding for domenet? */
  bound: boolean;
  tool_id: string | null;
  action: string | null;
  /** Risikoklassen til den bundne handlingen (A-D) hvis kjent (kalleren slår den opp i verktøyregisteret), ellers `null`. */
  risk_class: "A" | "B" | "C" | "D" | null;
  /**
   * Krever verktøydefinisjonen step-up (`step_up_required`)? Leses fra DEFINISJONEN, aldri utledet av klassen (fiks-runde A-HIGH-1: en klasse D uten step-up, som de gamle `lock_set`/`alarm_set`, nektes ikke av step-up).
   * `null` = definisjonen er ikke kjent for kalleren (ingen påstand).
   */
  step_up_required?: boolean | null;
  /**
   * WP-G4b K1 (D-484): erklærer DEFINISJONEN handlingen bindbar til autonom ACT (`autonomy_bindable`, default-deny)? `false` = den gjør det ikke, så motoren utfører den aldri autonomt (en lagret binding feiler lukket).
   * `null`/utelatt = definisjonen er ikke kjent for kalleren (ingen påstand).
   */
  bindable?: boolean | null;
}

export interface SimulationInput {
  situation: Pick<Situation, "situation_id" | "domain" | "stage" | "priority" | "status" | "opened_at" | "resolved_at" | "act_result" | "last_notified_at">;
  /** Rule-nøkkel (`kilde:type`) situasjonen tilhører, hvis kjent. */
  rule_key: string | null;
  similar: readonly SimilarSituation[];
  binding: SimulationBinding;
  nowMs: number;
}

export type SimulationBlocker = "domain_never_act" | "physical_action_not_bindable" | "action_not_bindable" | "no_binding" | "step_up_required" | "stage_not_suggest";

export interface SimulationScenario {
  id: "acted_at_suggest" | "not_acted";
  label: string;
  /** Tid spart/forventet varighet i minutter, eller `null` når det ikke finnes nok observasjoner (aldri gjettet). */
  estimated_minutes: number | null;
  /** Hva som hindrer et autonomt utfall i dag (tom = ingenting hindrer det). */
  blocked_by: SimulationBlocker[];
  requires_owner_approval: boolean;
}

export interface SimulationReport {
  situation_id: string;
  rule_key: string | null;
  evidence: { similar_count: number; resolved_count: number; median_minutes_to_resolve: number | null; useful_votes: number; noise_votes: number; observed_minutes: number | null; resolved: boolean };
  scenarios: SimulationScenario[];
  recommendation: "keep_inform_only" | "consider_binding" | "already_bound" | "insufficient_data";
  assumptions: string[];
  caveats: string[];
}

const toMs = (v: string | Date | null): number | null => (v === null ? null : v instanceof Date ? v.getTime() : Date.parse(v));
const minutes = (ms: number): number => Math.max(0, Math.round(ms / 60_000));

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** REN. Se klassens filhode. Kaster aldri og skriver ingenting. */
export function simulateCounterfactual(input: SimulationInput): SimulationReport {
  const { situation, similar, binding } = input;
  const openedMs = toMs(situation.opened_at);
  const resolvedMs = toMs(situation.resolved_at);
  const observedMinutes = openedMs === null ? null : minutes((situation.status === "resolved" && resolvedMs !== null ? resolvedMs : input.nowMs) - openedMs);
  const durations = similar
    .filter((s) => s.situation_id !== situation.situation_id && s.status === "resolved")
    .map((s) => ({ o: toMs(s.opened_at), r: toMs(s.resolved_at) }))
    .filter((d): d is { o: number; r: number } => d.o !== null && d.r !== null && d.r >= d.o)
    .map((d) => minutes(d.r - d.o));
  const others = similar.filter((s) => s.situation_id !== situation.situation_id);
  const useful = others.filter((s) => s.verdict === "useful").length;
  const noise = others.filter((s) => s.verdict === "noise").length;
  const medianMinutes = median(durations);

  // Hva hindrer ACT i dag? (Samme regler motoren og kjeden faktisk håndhever.)
  const blockers: SimulationBlocker[] = [];
  if (NEVER_ACT_DOMAINS.has(situation.domain)) blockers.push("domain_never_act");
  else {
    if (!binding.bound) blockers.push("no_binding");
    // Fysisk/kritisk handling (lås, alarm, lys, klima, bil, `critical_*`): situasjonsmotoren utfører den aldri (delt regel i `autonomy-guard.ts`, også for en binding fra før regelen).
    else if (autonomyActionBlocker(binding.tool_id, binding.action) !== null) blockers.push("physical_action_not_bindable");
    // WP-G4b K1 (D-484): definisjonen erklærer ikke handlingen bindbar (default-deny) - motoren utfører den aldri autonomt, uansett binding.
    else if (binding.bindable === false) blockers.push("action_not_bindable");
    // Step-up leses fra verktøydefinisjonen: en klasse D UTEN step-up nektes ikke av step-up og utføres av den autonome identiteten gjennom klasse D-kjeden.
    if (binding.step_up_required === true) blockers.push("step_up_required");
    if (situation.stage !== "suggest" && situation.stage !== "act" && situation.stage !== "act_notify") blockers.push("stage_not_suggest");
  }

  // Tid til forslaget: fra åpning til første kjente nivå på `suggest` kan ikke leses av situasjonen alene; vi antar at forslaget kom rett etter åpning (0 min) - eksplisitt antakelse under.
  const savedIfActed = medianMinutes === null || durations.length < SIMULATION_MIN_SIMILAR_RESOLVED ? null : Math.max(0, medianMinutes - ASSUMED_ACTION_MINUTES);
  const acted: SimulationScenario = {
    id: "acted_at_suggest", label: "Hadde Jarvis handlet ved forslaget (innenfor eierens binding)", estimated_minutes: savedIfActed, blocked_by: blockers,
    requires_owner_approval: blockers.includes("no_binding") || blockers.includes("step_up_required") || blockers.includes("domain_never_act") || blockers.includes("physical_action_not_bindable") || blockers.includes("action_not_bindable")
  };
  const notActed: SimulationScenario = {
    id: "not_acted", label: "Hadde Jarvis kun varslet (som i dag)", estimated_minutes: observedMinutes !== null && situation.status === "resolved" ? observedMinutes : medianMinutes, blocked_by: [], requires_owner_approval: false
  };

  let recommendation: SimulationReport["recommendation"];
  if (blockers.includes("domain_never_act") || noise > useful) recommendation = "keep_inform_only";
  else if (binding.bound) recommendation = "already_bound";
  else if (durations.length >= SIMULATION_MIN_SIMILAR_RESOLVED && useful > noise) recommendation = "consider_binding";
  else recommendation = "insufficient_data";

  const assumptions = [
    `Tid spart anslås fra median varighet for lignende LØSTE situasjoner (minst ${SIMULATION_MIN_SIMILAR_RESOLVED}), minus ${ASSUMED_ACTION_MINUTES} min utførelse; ellers gis ikke noe tall.`,
    "Forslaget antas å ha kommet rett etter at situasjonen ble åpnet (stadiehistorikk lagres ikke per overgang).",
    "Handlingen antas å løse situasjonen; verifisering skjer i den vanlige kjeden (readback), ikke her."
  ];
  const caveats = [
    "Dette er en forenkling over registrerte hendelser, ikke en prediksjon: små utvalg og forskjellige årsaker gir usikre tall.",
    "Simuleringen utfører, bestiller og endrer ingenting. En faktisk handling krever eierens binding og godkjenningskjeden."
  ];
  if (blockers.includes("step_up_required")) caveats.push("Handlingen krever step-up (verktøydefinisjonen): en autonom sveipe-identitet har ikke signert enhetsøkt, så kjeden nekter den (Q-55) - eieren må utføre den selv.");
  if (blockers.includes("physical_action_not_bindable")) caveats.push("Handlingen er fysisk/kritisk (lås, alarm, lys, klima, bil): situasjonsmotoren utfører den aldri autonomt, uansett binding - eieren må bruke den kritiske kjeden selv.");
  if (binding.bound && binding.risk_class === "D" && binding.step_up_required !== true && !blockers.includes("physical_action_not_bindable")) {
    caveats.push("Handlingen er klasse D uten step-up: den kan utføres autonomt gjennom klasse D-kjeden (umiddelbart varsel med gjenopprettingskontekst); vurder bindingen nøye.");
  }
  if (blockers.includes("action_not_bindable")) caveats.push("Handlingens definisjon erklærer ikke `autonomy_bindable` (default-deny): motoren utfører den aldri autonomt, uansett binding. Bindingen er ikke slettet; eieren må fjerne eller erstatte den, eller en eksplisitt, begrunnet erklæring må legges på definisjonen (D-160 er uendret som beslutning).");
  if (blockers.includes("domain_never_act")) caveats.push("Domenet (helse/kamera) kan aldri handle autonomt: Jarvis informerer og foreslår kun.");

  return {
    situation_id: situation.situation_id, rule_key: input.rule_key,
    evidence: { similar_count: others.length, resolved_count: durations.length, median_minutes_to_resolve: medianMinutes, useful_votes: useful, noise_votes: noise, observed_minutes: observedMinutes, resolved: situation.status === "resolved" },
    scenarios: [acted, notActed], recommendation, assumptions, caveats
  };
}

/** Slår opp en bundet handling i verktøyregisteret: risikoklasse og `step_up_required` FRA DEFINISJONEN (aldri utledet av klassen). `null` = ukjent definisjon. */
export type SimulationToolInfo = (toolId: string, action: string) => { risk_class: "A" | "B" | "C" | "D"; step_up_required: boolean; bindable: boolean } | null;

export function simulationToolInfoFrom(gateway: { get(toolId: string, action: string): { capability_class: string; step_up_required?: boolean; autonomy_bindable?: unknown } | undefined }): SimulationToolInfo {
  return (toolId, action) => {
    const def = gateway.get(toolId, action);
    if (def === undefined || !["A", "B", "C", "D"].includes(def.capability_class)) return null;
    return { risk_class: def.capability_class as "A" | "B" | "C" | "D", step_up_required: def.step_up_required === true, bindable: autonomyBindabilityOf(def) !== null };
  };
}

export class SimulationNotFoundError extends Error {
  constructor(public readonly situationId: string) {
    super(`simulation_situation_not_found:${situationId}`);
    this.name = "SimulationNotFoundError";
  }
}

/** Leser grunnlaget (RLS, kun lesing) og kaller den rene funksjonen. Ingen skriving, ingen verktøykall. */
export class SimulationService {
  constructor(
    private readonly pool: pg.Pool,
    /** Slår opp risikoklassen OG `step_up_required` til en bundet handling (`tool_id`, `action`) i verktøyregisteret (`ToolGateway.get`). `null` = ukjent definisjon (ingen påstand om klasse eller step-up). */
    private readonly toolInfoOf: SimulationToolInfo = () => null,
    private readonly now: () => number = Date.now
  ) {}

  async simulate(tenantId: string, memorySpace: MemorySpace, situationId: string): Promise<SimulationReport> {
    const gathered = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows: sitRows } = await client.query(`SELECT * FROM situations WHERE tenant_id = $1 AND memory_space_id = $2 AND situation_id = $3`, [tenantId, memorySpace, situationId]);
      const situation = sitRows[0] as Situation | undefined;
      if (situation === undefined) throw new SimulationNotFoundError(situationId);
      const { rows: logRows } = await client.query(
        `SELECT source, event_type FROM situation_signal_log WHERE tenant_id = $1 AND memory_space_id = $2 AND situation_id = $3 ORDER BY occurred_at DESC LIMIT 1`,
        [tenantId, memorySpace, situationId]
      );
      const log = logRows[0] as { source: string; event_type: string } | undefined;
      const ruleKey = log === undefined ? null : `${log.source}:${log.event_type}`;
      let similar: SimilarSituation[] = [];
      if (ruleKey !== null && ruleByKey(ruleKey) !== undefined) {
        const { rows } = await client.query(
          `SELECT s.situation_id, s.opened_at, s.resolved_at, s.status,
                  (SELECT f.verdict FROM situation_feedback f WHERE f.tenant_id = s.tenant_id AND f.memory_space_id = s.memory_space_id AND f.situation_id = s.situation_id ORDER BY f.created_at DESC LIMIT 1) AS verdict
           FROM situations s
           WHERE s.tenant_id = $1 AND s.memory_space_id = $2 AND s.situation_id <> $3 AND s.opened_at >= now() - interval '90 days'
             AND EXISTS (SELECT 1 FROM situation_signal_log l WHERE l.tenant_id = s.tenant_id AND l.memory_space_id = s.memory_space_id AND l.situation_id = s.situation_id AND l.source = $4 AND l.event_type = $5)
           ORDER BY s.opened_at DESC LIMIT 200`,
          [tenantId, memorySpace, situationId, log?.source, log?.event_type]
        );
        similar = rows as SimilarSituation[];
      }
      const { rows: polRows } = await client.query(
        `SELECT tool_id, action FROM situation_autonomy_policies WHERE tenant_id = $1 AND memory_space_id = $2 AND domain = $3 AND enabled = true AND (expires_at IS NULL OR expires_at > now())`,
        [tenantId, memorySpace, situation.domain]
      );
      const pol = polRows[0] as Pick<SituationAutonomyPolicy, "tool_id" | "action"> | undefined;
      return { situation, ruleKey, similar, pol };
    });
    let binding: SimulationBinding;
    if (gathered.pol === undefined) binding = { bound: false, tool_id: null, action: null, risk_class: null, step_up_required: null };
    else {
      const info = this.toolInfoOf(gathered.pol.tool_id, gathered.pol.action);
      binding = { bound: true, tool_id: gathered.pol.tool_id, action: gathered.pol.action, risk_class: info?.risk_class ?? null, step_up_required: info === null ? null : info.step_up_required, bindable: info === null ? null : info.bindable };
    }
    return simulateCounterfactual({ situation: gathered.situation, rule_key: gathered.ruleKey, similar: gathered.similar, binding, nowMs: this.now() });
  }
}
