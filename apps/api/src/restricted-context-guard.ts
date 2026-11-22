import type { IdentityContext } from "@jarvis/contracts";
import type { FastIntent, MessageStore } from "@jarvis/core";

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
 * Hurtigbane-intensjonene (`fastRoute`) hvis SVAR bærer finansavledet innhold, og som derfor merkes begrenset når flagget er på (K3: «rask bane som svarer fra finans-/helseverktøy»). Objektet er `Record` over ALLE
 * intensjonene, så en NY intensjon i `FastIntent` ikke kompilerer før noen har tatt stilling til den (og en test låser at tabellen og runbooken er like).
 *  - `cost_report` (`run_rate.get_cost_overview`) og `value_report` (`executive.get_value_report`): AI-kostnad i øre. Q-64 pkt 1 er ikke avgjort, og STRENGESTE regel gjelder til eieren svarer (Verdi-senteret holdes tilbake fra sky,
 *    H2): svaret merkes derfor begrenset. Svarer eieren «nei» (driftsdata, ikke privat økonomi), settes begge til `false`.
 *  - `delegate_background`: ikke avgjort av intensjonen, men av ruteavgjørelsen (`delegationCloudDecision` sier om turen er låst til SECRET_RESTRICTED) - se `ConversationEngine.handleFastIntent`.
 *  - øvrige (status, selvdiagnose, SLO, evolusjon, jobbstyring, hjelp, lys): ingen finans-/helsedata i svaret (verifisert: ingen `finance`-referanse i selvdiagnosen/SLO/evolusjon).
 */
export const FAST_INTENT_RESTRICTED: Readonly<Record<FastIntent["kind"], boolean>> = {
  system_status: false,
  self_diagnosis: false,
  slo_report: false,
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

  constructor(
    private readonly store: Pick<MessageStore, "markRestricted">,
    private readonly identity: IdentityContext,
    private readonly userMessageId: unknown
  ) {}

  get locked(): boolean {
    return this.isLocked;
  }

  async lock(): Promise<void> {
    this.isLocked = true;
    if (this.userMarked) return;
    if (typeof this.userMessageId !== "string" || this.userMessageId === "") throw new Error("restricted_marking_no_message_id");
    const marked = await this.store.markRestricted(this.identity, this.userMessageId);
    if (marked !== true) throw new Error("restricted_marking_failed");
    this.userMarked = true;
  }
}
