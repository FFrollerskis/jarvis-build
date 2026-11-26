import type { ToolResult } from "@jarvis/tool-gateway";

/**
 * WP-G4b fiks-runde 1 (FIX-11, review A LOW-1): REN klassifisering av gatewayens svar for morgenoppsummeringens ENE `telegram.notify`-kall. Egen fil fordi `morning-summary.ts` er kildeskannet av en test (tjenesten leser aldri en situasjons
 * begrunnelse/fakta); her er det gatewayens EGEN avslagsgrunn som leses, aldri situasjonsinnhold.
 *
 *  - `sent`: GATEWAYEN utførte kallet nå (ikke en gjentakelse).
 *  - `already_sent`: et SAMTIDIG kall for samme natt vant kappløpet om idempotensnøkkelen. Enten har vinneren allerede bekreftet (`deduplicated`) eller den er midt i sendingen / utfallet er ukjent
 *    (`execution_in_flight_or_outcome_unknown`). Taperen sendte ikke selv og får derfor ALDRI `sent` (ellers over-teller løperens `morning_summaries`: to «sent» for ett transportkall) og sender aldri på nytt.
 *  - `failed`: alt annet (policy, kill switch, frys, transportfeil, tidsavbrudd i EGET kall). Prøves igjen neste tikk (en rad som står som `failed` har ingen bekreftet bivirkning; `unverified`/`reserved` gir `already_sent` da).
 */
export type MorningSummaryDelivery = "sent" | "already_sent" | "failed";

/** Gatewayens faste avslagsgrunn når en annen kaller holder (eller har et ukjent utfall under) samme idempotensnøkkel. */
export const IN_FLIGHT_OR_UNKNOWN_OUTCOME = "execution_in_flight_or_outcome_unknown";

export function classifyDelivery(result: ToolResult): MorningSummaryDelivery {
  if (result.ok) return result.deduplicated === true ? "already_sent" : "sent";
  return result.reason === IN_FLIGHT_OR_UNKNOWN_OUTCOME ? "already_sent" : "failed";
}
