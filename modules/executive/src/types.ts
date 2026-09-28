import type { FinanceKillSwitch } from "@jarvis/finance";
import type { FrozenConnectorEntry, OwnerControlState, RevokedCredentialEntry } from "@jarvis/owner-controls";
import type { Situation, SituationAutonomyPolicy, SituationPriority, SituationStage } from "@jarvis/situations";
import type { ConnectorStatus } from "@jarvis/tool-gateway";

/**
 * UA-11 Executive Mode (P0, D-162): JARVIS_CANONICAL attention-ranking-
 * kontrakt. Denne pakken eier IKKE noen egen hendelses-/tilstandskilde -
 * `situations` (UA-10) er den ENE kilden P0 komponerer (D-64: en ekstern/
 * søster-pakke er ALDRI stedet kjernen bor, men her er `situations` selv
 * allerede JARVIS_CANONICAL, så komposisjon - ikke duplisering - er riktig
 * retning). Se `docs/UA11_EXECUTIVE_MODE_DESIGN.md` for full begrunnelse.
 */

/**
 * Klassifiserer HVOR i den kanoniske tilstandsmaskinen
 * (ignore -> remember -> inform -> suggest -> act -> act_notify -> escalate,
 * se `@jarvis/situations`) et attention-item står, oversatt til hva EIEREN
 * faktisk kan/bør gjøre med det NÅ - direkte avledet av `stage`, ingen ny
 * semantikk:
 * - "read": ren FYI (remember/ignore/inform) - ingen handling forventet.
 * - "suggest": motoren ber eksplisitt om en eierbeslutning (suggest).
 * - "act": autonom handling er allerede utført/bekreftet eller eskalert
 *   (act/act_notify/escalate) - eieren kan gjennomgå, men intet nytt venter.
 */
export type ExecutiveActionKind = "read" | "suggest" | "act";

/** Eierens autoritets-/pausetilstand for ETT attention-items domene - lest fra `situations.get_pause_state`/`list_autonomy_policies`, aldri egen tilstand. */
export interface AttentionAuthorityStatus {
  domain_paused: boolean;
  autonomy_bound: boolean;
  autonomy_enabled: boolean;
}

/**
 * ÉN rangert attention-post. RENT avledet av `Situation` (situations-pakken)
 * + pause-/policy-tilstand - INGEN egen persistens, INGEN felt som ikke kan
 * spores tilbake til et eksisterende kildefelt.
 */
export interface AttentionItem {
  situation_id: string;
  tenant_id: string;
  memory_space_id: string;
  domain: string;
  stage: SituationStage;
  action_kind: ExecutiveActionKind;
  priority: SituationPriority;
  confidence: number | null;
  reason: string;
  detection_key: string;
  source_open_loop_id: string | null;
  opened_at: string;
  last_notified_at: string | null;
  authority_status: AttentionAuthorityStatus;
  /** Deterministisk, forklarbar anbefaling - aldri modell-generert i P0 (se ranking.ts). */
  recommended_next_action: string;
  /** Menneskelesbare grunner rangeringen faktisk brukte - "explainable", ikke en skjult vektsum. */
  explanation: string[];
  /** Rå, deterministisk komposittscore (høyere = mer oppmerksomhet nå) - kun for sortering/tie-break-bevis, ALDRI vist som "sannhet" til eieren uten `explanation`. */
  score: number;
  /** 1-basert plassering i DENNE rangerte listen (stabil ved replay for identisk input). */
  rank: number;
}

/** Full kilde-`Situation` pluss det avledede attention-laget - "se underliggende situation" uten et nytt oppslag. */
export interface AttentionItemDetail extends AttentionItem {
  situation: Situation;
}

/**
 * K1 (Sovereign graduation, D-164): ÉN samlet lesing av HELE eier-
 * kontrolloverflaten - UA-11 sitt bidrag til å tette UA-11-akseptansekriterium
 * 3 ("owner can stop/revoke/reconfigure any connector, provider, agent or
 * autonomy domain from one control surface"). RENT avledet av to nøstede
 * `ToolGateway.execute()`-kall (`owner_controls.get_control_state` +
 * `situations.get_pause_state`, se `service.ts`) - INGEN egen tilstand,
 * INGEN direkte DB-/`KillSwitch`-/`OwnerControls`-tilgang fra denne pakken.
 *
 * `owner_control` er den GLOBALE, systemomfattende autoriteten (kill switch -
 * blokkerer ALT, uansett domene - samt navngitte frosne connectorer/
 * tilbakekalte credentials). `situation_domain_pauses` er den SITUASJONS-
 * SPESIFIKKE, domene-avgrensede pausetilstanden fra UA-10 - et helt annet,
 * SAMTIDIG gyldig lag (se `docs/DECISIONS_AND_ASSUMPTIONS.md` D-164 §5: disse
 * to må forbli distinkte, ALDRI flettes til én boolsk "alt er pauset").
 *
 * MERK (dokumentert, ikke stille utelatt): `situation_domain_pauses` bærer i
 * dag KUN domenenavnene (`situations.get_pause_state` sin eksisterende
 * kontrakt) - ikke reason/actor/changed_at per domene, i motsetning til
 * `owner_control` sine felt som ALLE har det. Dette er en PRE-EKSISTERENDE
 * begrensning i `situations.get_pause_state` (UA-10, uendret av K1) - å
 * utvide DEN kontrakten er utenfor K1 sitt omfang og er IKKE forsøkt løst
 * stille her.
 *
 * D-174 (B2): `finance_kill_switch` lagt til - RENT avledet av ET
 * TREDJE nøstet `ToolGateway.execute()`-kall (`finance.get_kill_switch`,
 * se `service.ts`), SAMME komposisjons-disiplin som de to over. Finans-
 * nødbryteren er en TREDJE, UAVHENGIG autoritetsdimensjon (verken den
 * globale `owner_control.kill_switch` - som likevel blokkerer finans-
 * mutasjoner FØRST via den delte ToolGateway-frys-/kill-switch-gaten,
 * se `gateway.ts` - eller noe `situation_domain_pauses`-domene): den
 * gjelder SPESIFIKT spend-muliggjørende finans-/kort-handlinger
 * (`finance.submit_payment_intent`, `finance_wallester.activate_card`
 * m.fl. - se D-115/D-174). `null` betyr at tenanten aldri har hatt en
 * `finance_kill_switch`-rad (ALDRI tolket som "aktiv" eller "inaktiv" -
 * se `FinanceService.getKillSwitch()`).
 *
 * BEVISST UTELATT (dokumentert, ikke stille): device-/session-grant-
 * tilstand. `SessionGrantService` eksponerer per D-174-fersklesing INGEN
 * kanonisk lister-/tellemetode for "aktive grants for enhet X" - KUN
 * `revokeForDeviceOn()` (en mutasjon). Å late som en slik status finnes
 * her ville vært en FALSK "device revoked: true/false"-visning uten en
 * ekte kanonisk kilde (§H-instruksen: "Do NOT fake status if no canonical
 * query exists"). `owner_controls.revoke_device` sitt returverdi
 * (`revoked_grants`-tall FRA selve tilbakekallingskallet) forblir den
 * ENE sannferdige, tidsstempel-bundne bekreftelsen - IKKE en løpende
 * status her.
 */
export interface ControlSurfaceStatus {
  owner_control: OwnerControlState;
  situation_domain_pauses: { paused: string[] };
  finance_kill_switch: FinanceKillSwitch | null;
}

/**
 * UA-11 "K2" (D-64): "delegation board" - masterplanens femte K2-punkt.
 * BEVISST INGEN egen tabell (se `059_governance.sql` sitt filhode og
 * `modules/governance` sin pakkebeskrivelse) - dette er en RENT avledet
 * visning, SAMME komposisjonsdisiplin som `getControlSurfaceStatus()` over:
 * TRE nøstede `ToolGateway.execute()`-kall (`situations.list_autonomy_policies`,
 * `owner_controls.get_control_state`, `finance.get_kill_switch`), INGEN ny
 * kanonisk kilde. Dekker UA-11 akseptansekriterium 3 sin fulle bredde
 * ("connector, provider, agent or autonomy domain") ved å vise ALLE TRE
 * delegasjonslagene samlet, der `get_control_surface_status` viser to av
 * dem sammen med finans-nødbryteren:
 * - `autonomy_domains`: HVILKE situasjonsdomener Jarvis har fått delegert
 *   autonom handlingsrett for (og om delegeringen faktisk er aktivert) -
 *   "agent or autonomy domain".
 * - `frozen_connectors`/`revoked_credentials`: eierens EKSPLISITTE
 *   tilbaketrekking av leverandør-/connector-tilgang - "connector, provider".
 * - `finance_kill_switch`: SAMME tredje, uavhengige autoritetsdimensjon som
 *   `ControlSurfaceStatus` (se der for full begrunnelse) - spend-
 *   muliggjørende finans-/kort-handlinger er selv en delegert kapabilitet.
 */
export interface DelegationBoard {
  autonomy_domains: SituationAutonomyPolicy[];
  frozen_connectors: FrozenConnectorEntry[];
  revoked_credentials: RevokedCredentialEntry[];
  finance_kill_switch: FinanceKillSwitch | null;
}

/**
 * "Charlie"-selv-bevissthet (D-209, 2026-09-20): Tobias observerte den
 * (daværende namnløse) chat-personaen konfabulere om egne evner ("jeg er
 * flere AI-er i én", "jeg har banktilgang") når den ble spurt introspektive
 * spørsmål - fordi den strukturelt IKKE hadde noe verktøy å faktisk sjekke
 * med. `chat_accessible_tools` er RENT avledet av `ToolGateway.list()`
 * (`@jarvis/tool-gateway`) - siden D-289 den SAMME registeropptellingen
 * `allMeshTools()` selv bruker for å bygge det chat-modellen FAKTISK kan
 * kalle i DENNE samtalen (§P1A/D-289 i `mesh-bridge.ts`) - ALDRI en egen,
 * potensielt avvikende kopi. Å spørre "hva har jeg tilgang til" via DETTE
 * verktøyet er derfor strukturelt umulig å svare feil på - svaret ER
 * kilden selve chat-verktøykjeden bruker.
 * D-237 (funn i faktisk bruk, 2026-09-22): opprinnelig listet
 * `chat_accessible_tools` KUN navn/beskrivelse - et mesh-verktøy sto der
 * selv om det underliggende credential-referansen var helt ukonfigurert,
 * fordi listen kun beviste at verktøyet STRUKTURELT fantes, ALDRI om det
 * faktisk var BRUKBART akkurat nå. `configured` lukker nøyaktig DET gapet -
 * samme `ToolGateway.hasSecret()`-presence-sjekk dashbordets "Integrasjoner"
 * allerede bruker (`@jarvis/tool-gateway` sin `listConnectorStatus()`), nå
 * også tilgjengelig FRA SELVE SAMTALEN per tool_id.
 * D-289 (2026-09-26, "vil ha alt at han har full kontroll"): mesh-flaten
 * gikk fra 5 kuraterte verktøy til ALLE ~28 registrerte `tool_id`-er - én
 * rad PER HANDLING (~150+) ville sprengt `MeshToolExecutor` sin
 * output-trimming OG vært ubrukelig å relayere muntlig, så denne raden er nå
 * GRUPPERT per `tool_id` (handlinger + risikoklasser samlet), ikke per
 * enkelthandling som før D-289.
 * `connector_health` er RENT avledet av `ToolGateway.health` (BO-03,
 * `gateway.ts`) - SAMME kilde som `/infra/status`-ruten allerede eksponerer
 * til eieren via HTTP, nå også tilgjengelig FRA SELVE SAMTALEN. Helsen er
 * REAKTIV (oppdateres etter et faktisk kall via denne gatewayen), ALDRI
 * proaktivt pollet - et tool_id uten oppføring betyr "ikke prøvd ennå i
 * denne prosessens levetid", IKKE "sunt". Proaktiv, tidsplanlagt helse-
 * polling av connectorer som ALDRI har blitt kalt er BEVISST UTENFOR
 * omfanget her (ville krevd en egen "ping"-primitiv per leverandør-adapter)
 * - se D-209/task-sporing for videre arbeid.
 */
export interface CapabilityStatus {
  chat_accessible_tools: Array<{
    tool_id: string;
    actions: string[];
    capability_classes: string[];
    configured: boolean;
  }>;
  connector_health: Array<{ tool_id: string; state: string; at: string; detail?: string }>;
  /**
   * D-317 (Tobias direkte i chat: "bygg modell-selvbevissthet inn i
   * check_my_capabilities"): hvilken leverandør/modell som FAKTISK genererer
   * DENNE samtaleturen - `null` når ukjent, ALDRI gjettet. Se
   * `ExecutiveService.getCapabilityStatus()` sitt filhode for kilden
   * (`ToolInvocationContext.servingModel`, trusted-lag, aldri modell-oppgitt).
   */
  serving_model: { provider: string; model: string } | null;
}

/**
 * Task #119 (integrasjons-dashboard, D-211): eierens "er alt tilkoblet?"-
 * overflate. `connectors` er RENT avledet av `@jarvis/tool-gateway` sin
 * `listConnectorStatus()` - SAMME kanoniske register `search_my_memory`/
 * `check_my_capabilities` sin egen "aldri en egen, avvikende kopi"-disiplin
 * (se `CapabilityStatus` over) følger. Verdien til en credential ER ALDRI
 * med her - kun `configured: boolean` per referanse (se `ConnectorStatus`).
 */
export interface ConnectorStatusReport {
  connectors: ConnectorStatus[];
}
