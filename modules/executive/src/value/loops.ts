import type { ValueLoopStatus, ValueRuntimeFacts } from "./types.ts";

/**
 * WP-C4: hva hver verdiløkke (V1-V5, masterplan v4.0 kap. 9) FAKTISK er i denne kjøringen, med lukkingsmatrisens statusord. Utledet av kjøretidsfakta (konfig/flagg) - aldri hardkodet «i drift».
 * Uten fakta er svaret `unknown` for de løkkene som avhenger av dem (aldri gjettet til «i drift»).
 */
export function describeValueLoops(facts: ValueRuntimeFacts | null): ValueLoopStatus[] {
  const v1: ValueLoopStatus = facts === null
    ? { id: "V1", title_no: "Daily Executive Brief", state: "unknown", detail_no: "kjøretidsfakta er ikke tilgjengelige, så jeg kan ikke bekrefte at morgenlevering kjører" }
    : facts.v1_delivery_configured
      ? { id: "V1", title_no: "Daily Executive Brief", state: "wired", detail_no: "genereres og leveres på Telegram hver morgen (DailyScheduler); tallene under viser bruken" }
      : { id: "V1", title_no: "Daily Executive Brief", state: "dormant", detail_no: "Telegram er ikke konfigurert her, så daglig levering kjører ikke (briefen kan fortsatt hentes i chat)" };

  const v2: ValueLoopStatus = facts === null
    ? { id: "V2", title_no: "Unified Follow-up", state: "unknown", detail_no: "kjøretidsfakta er ikke tilgjengelige" }
    : facts.v2_push.enabled && facts.v2_push.channel_configured
      ? { id: "V2", title_no: "Unified Follow-up", state: "wired", detail_no: `push-levering er PÅ: høyst ${facts.v2_push.max_per_day} meldinger per døgn, rolig ${facts.v2_push.quiet_hours} (Europe/Oslo)` }
      : facts.v2_push.enabled
        ? { id: "V2", title_no: "Unified Follow-up", state: "dormant", detail_no: "push er slått på, men ingen leveringskanal (Telegram) er konfigurert - ingenting sendes" }
        : { id: "V2", title_no: "Unified Follow-up", state: "dormant", detail_no: "pull via conversation_graph-verktøyene fungerer; push-levering er bygget men AV (JARVIS_V2_PUSH_ENABLED)" };

  const v3: ValueLoopStatus = {
    id: "V3", title_no: "Jarvis Builder Loop", state: "dormant",
    detail_no: "kun beredskapslogikk finnes; selvmodifikasjon er frosset (D-397) og ingen kodevei kan starte løkken"
  };

  const v4: ValueLoopStatus = {
    id: "V4", title_no: "Business Operating Loop", state: "not_built",
    detail_no: "venter Business-tenant og tenant-topologi (Q-48); ikke en del av denne leveransen"
  };

  const v5: ValueLoopStatus = facts === null
    ? { id: "V5", title_no: "Autonomous Operations", state: "built_unwired", detail_no: "forslagslogikk finnes; ingen kodevei utfører noe (alt går via bekreftelse/step-up)" }
    : {
        id: "V5", title_no: "Autonomous Operations", state: "built_unwired",
        detail_no: `forslagslogikk finnes og er ${facts.v5_proposals_enabled ? "PÅ (viser forslag i rapporten)" : "AV (JARVIS_V5_PROPOSALS_ENABLED)"}; ingen kodevei utfører noe - alt går via bekreftelse/step-up`
      };

  return [v1, v2, v3, v4, v5];
}
