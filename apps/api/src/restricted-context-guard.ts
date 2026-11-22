import type { IdentityContext } from "@jarvis/contracts";
import type { FastIntent, MessageStore } from "@jarvis/core";
import type { FinanceExecutionLock } from "@jarvis/tool-gateway";
import { servedByCloudModel } from "./cloud-tool-screen.ts";

/**
 * WP-N1 (Q-66/JARVIS-101 + Q-64 pkt 3): «begrenset»-merking av samtalehistorikken og utførelseslås for `finance`/`finance_*` mot skymodeller.
 *
 * ÉN flaggparser (som `parseCommsConfig`): INGEN annen kode leser `JARVIS_RESTRICTED_CONTEXT_GUARD` direkte fra miljøet (låst av `wpn1-guard-env.test.ts`). Kun den EKSAKTE verdien `on` slår det på (true/1/ON/mellomrom er AV).
 * Flagget styrer tre ting, alle uendret fra main når det er AV: (1) samtalemotoren merker låste turer (`messages.restricted`), (2) klassifiseringen leser merket, (3) ToolGateway nekter `finance`/`finance_*` når turen
 * betjenes av en skymodell. Flagget står KUN i `SERVICE_ENV.api` (worker/voice/browser/migrate leser det aldri).
 */
export const RESTRICTED_CONTEXT_GUARD_FLAG = "JARVIS_RESTRICTED_CONTEXT_GUARD";

export interface RestrictedContextGuardConfig {
  enabled: boolean;
}

export function parseRestrictedContextGuard(env: Readonly<Record<string, string | undefined>> = process.env): RestrictedContextGuardConfig {
  return { enabled: env[RESTRICTED_CONTEXT_GUARD_FLAG] === "on" };
}

/**
 * WP-N1 (fiks-runde 1, F-A1/F-B2): lokalitetsprediktatet til utførelseslåsen for `finance`/`finance_*` (`ToolGateway`, K6) - flyttet hit fra `main.ts` så det kan KJØRES av en test mot det ekte leverandørregisteret
 * (`wpn1-lock-predicate.test.ts`: en invertert/alltid-lokal/alltid-sky versjon overlevde alle N1-tester da det sto inline). `true` KUN for leverandører som står i modellregisteret med `locality: "local"`
 * (`servedByCloudModel`, SAMME kilde som chattens verktøyskjerm og Finans-senteret); alt annet - sky, hostet gratis-tier, tom/blank/feilstavet/STORE-BOKSTAVER-leverandør - er sky og får aldri finansdata (fail-closed).
 */
export function financeLockServedLocally(model: { provider: string; model: string }): boolean {
  return !servedByCloudModel({ provider: model.provider });
}

/** Valget `main.ts` gir `ToolGateway` (`financeExecutionLock`) - KUN når flagget er på. */
export const FINANCE_EXECUTION_LOCK: FinanceExecutionLock = { servedLocally: financeLockServedLocally };

/**
 * WP-N1 (fiks-runde 2, F2-B1): skal resultatet/tittelen/feilen til en bakgrunnsjobb som ble startet fra en LÅST tur (`restricted_origin`) holdes tilbake fra modellen som betjener DETTE kallet? Samme regel og samme fail-closed lokalitet som
 * utførelseslåsen og `withholdFinanceFromCloud`: `false` KUN uten modell i løkka (eierens egne ruter) og for en leverandør som står i modellregisteret som LOKAL; `true` for sky og alt ukjent (tom/blank/feilstavet/STORE BOKSTAVER leverandør,
 * ikke et objekt). Satt av `main.ts` på `TasksDelegateTransport` KUN med flagget på.
 */
export function withholdsRestrictedJobFromCloud(model: { provider: string; model: string } | undefined): boolean {
  if (model === undefined) return false;
  if (typeof model !== "object" || model === null || typeof model.provider !== "string" || model.provider.trim() === "") return true;
  return !financeLockServedLocally(model);
}

/**
 * WP-N1 (fiks-runde 1, F-A2): lagringen av en bakgrunnsjobbs LEVERING i samtalen (`ChatJobs.sweepDeliveries` -> `saveMessage`). Flyttet ut av `main.ts` så den kan kjøres av en test. Leveringen lagres begrenset KUN når begrenset-vakten er på
 * OG jobben ble startet fra en LÅST tur (`opts.restricted`, fra `restricted_origin` i kontrakten); ellers er kallet NØYAKTIG det opprinnelige TRE-argumentskallet (flagg AV: kolonnen settes aldri).
 */
export function createDeliverySaver(
  store: Pick<MessageStore, "save">,
  guardEnabled: boolean
): (identity: IdentityContext, role: "assistant", content: string, opts?: { restricted: true }) => Promise<unknown> {
  return (identity, role, content, opts) =>
    guardEnabled && opts?.restricted === true ? store.save(identity, role, content, { restricted: true }) : store.save(identity, role, content);
}

/**
 * Hurtigbane-intensjonene (`fastRoute`) hvis SVAR bærer finansavledet innhold, og som derfor merkes begrenset når flagget er på (K3: «rask bane som svarer fra finans-/helseverktøy»). Objektet er `Record` over ALLE
 * intensjonene, så en NY intensjon i `FastIntent` ikke kompilerer før noen har tatt stilling til den (og en test låser at tabellen og runbooken er like).
 *  - `cost_report` (`run_rate.get_cost_overview`) og `value_report` (`executive.get_value_report`): AI-kostnad i øre. Q-64 pkt 1 er ikke avgjort, og STRENGESTE regel gjelder til eieren svarer (Verdi-senteret holdes tilbake fra sky,
 *    H2): svaret merkes derfor begrenset. Svarer eieren «nei» (driftsdata, ikke privat økonomi), settes ALLE fem under til `false` (Q-2).
 *  - `slo_report` (`executive.get_slo_report`) og selvdiagnosen (`self_diagnosis`, og `system_status` som viser de samme funnene i kortform): driftsforverringen kan inneholde «Kostnad per kall økte fra 3 til 6.7 øre (+122 %)»
 *    (`apps/api/src/slo-source.ts`, `detectDrift`/`composeSloReport`) - AI-kost i øre, samme klasse som `cost_report` (fiks-runde 1, F-A4). Konsekvens (smitte, se runbooken): en slik tur holder samtalen lokal så lenge den merkede raden er blant de siste meldingene.
 *  - `delegate_background`: ikke avgjort av intensjonen, men av ruteavgjørelsen (`delegationCloudDecision` sier om turen er låst til SECRET_RESTRICTED) - se `ConversationEngine.handleFastIntent` (turen låses FØR jobben startes).
 *  - øvrige (evolusjonsrapport, jobbstyring, hjelp, lys): ingen finans-/helsedata i svaret (verifisert: ingen `finance`-referanse og ingen øre-beløp i evolusjonsrapporten).
 */
export const FAST_INTENT_RESTRICTED: Readonly<Record<FastIntent["kind"], boolean>> = {
  system_status: true,
  self_diagnosis: true,
  slo_report: true,
  evolution_report: false,
  cost_report: true,
  value_report: true,
  delegate_background: false,
  task_status: false,
  create_task: false,
  cancel_task: false,
  help: false,
  home_light: false
};

/**
 * Merker en turs meldinger som begrensede. Én instans per tur (bare når flagget er på). `lock()` er kallt så snart turen er avgjort SECRET_RESTRICTED (etter at rutingen er kjent) eller faller tilbake til den strenge
 * lokale visningen: brukermeldingen (lagret FØR rutingen var kjent) merkes via `markRestricted`, og ALLE senere lagringer for turen (svar, feil-, avbrudds- og budsjettstopp-svar) lagres begrenset fra første stund.
 * Fail-closed: kan brukermeldingen ikke merkes (ukjent id, ikke funnet i egen tenant/sesjon, databasefeil), kaster `lock()` - turen feiler heller enn å la en begrenset tur stå ubegrenset i historikken.
 */
export class RestrictedTurnMarker {
  private isLocked = false;
  private userMarked = false;
  private turn: { restricted?: true } | undefined;

  constructor(
    private readonly store: Pick<MessageStore, "markRestricted">,
    private readonly identity: IdentityContext,
    private readonly userMessageId: unknown
  ) {}

  get locked(): boolean {
    return this.isLocked;
  }

  /**
   * Fiks-runde 1 (F-A2): turbildet (`TurnContext`) får `restricted: true` når turen låses (og med en gang, hvis den allerede er låst), slik at `MeshToolExecutor` kan sende `restrictedOrigin` videre til verktøykall (en bakgrunnsjobb delegert i en
   * LÅST tur får leveringen sin lagret begrenset). Turbildet er trusted-lag-tilstand eid av samtalemotoren (aldri modellen); uten markør (vakten AV) settes det aldri.
   */
  attachTurn(turn: { restricted?: true }): void {
    this.turn = turn;
    if (this.isLocked) turn.restricted = true;
  }

  /** `reasons` = fast ordforråd fra rutingen (`text:finance`, `tool_selection:SECRET_RESTRICTED`, `history:restricted`, `fast_intent:cost_report` ...) - logges ÉN gang ved låsingen, aldri innhold. */
  async lock(reasons: readonly string[] = []): Promise<void> {
    if (!this.isLocked) console.log(JSON.stringify({ msg: "n1_restricted_turn_locked", reasons }));
    this.isLocked = true;
    if (this.turn) this.turn.restricted = true;
    if (this.userMarked) return;
    if (typeof this.userMessageId !== "string" || this.userMessageId === "") throw new Error("restricted_marking_no_message_id");
    const marked = await this.store.markRestricted(this.identity, this.userMessageId);
    if (marked !== true) throw new Error("restricted_marking_failed");
    this.userMarked = true;
  }
}
