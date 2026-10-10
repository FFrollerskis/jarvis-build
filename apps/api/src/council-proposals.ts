/**
 * WP-D4 (JARVIS-078, rådets bekreftelsesflyt): bryteren for rådets forslagsvei. AI-rådet er en vurderingsrolle og får aldri verktøy (§30); med bryteren PÅ kan syntesen i tillegg foreslå ÉN konkret handling fra en
 * lukket liste (chattens handlingsnivå, kun `web_chat`), og et gyldig forslag legges frem som en PENDING bekreftelse i den eksisterende bekreftelsesveien (D-382) - ingenting utføres før eieren godkjenner kortet.
 *
 *  - `JARVIS_COUNCIL_PROPOSALS`: tom/usatt = AV (standard - rådet gir kun en vurdering, nøyaktig som før). KUN den eksakte verdien `on` slår den på (L13, gjennomgang av PR #315: tidligere også `true`/`1`/`yes` og stor/liten bokstav -
 *    en bryter som kan gi en handling skal aktiveres av én entydig verdi, som de øvrige flaggene). `off` = av. Alt annet (`true`, `1`, `yes`, `ON`, ` on`, skrivefeil) = AV (fail-closed) og en logglinje, så eieren ser at verdien ikke ble tatt til følge.
 */
export function parseCouncilProposals(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false;
  if (raw === "on") return true;
  if (raw !== "off") {
    console.error(JSON.stringify({ msg: "council_proposals_invalid", reason: "forventet nøyaktig on eller off", fallback: "off" }));
  }
  return false;
}
