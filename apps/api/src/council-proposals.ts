/**
 * WP-D4 (JARVIS-078, rådets bekreftelsesflyt): bryteren for rådets forslagsvei. AI-rådet er en vurderingsrolle og får aldri verktøy (§30); med bryteren PÅ kan syntesen i tillegg foreslå ÉN konkret handling fra en
 * lukket liste (chattens handlingsnivå, kun `web_chat`), og et gyldig forslag legges frem som en PENDING bekreftelse i den eksisterende bekreftelsesveien (D-382) - ingenting utføres før eieren godkjenner kortet.
 *
 *  - `JARVIS_COUNCIL_PROPOSALS`: tom/usatt = AV (standard - rådet gir kun en vurdering, nøyaktig som før). `on` (også `true`/`1`/`yes`) = på. Ugyldig verdi = AV (fail-closed, aldri en stille aktivering ved en skrivefeil).
 */
export function parseCouncilProposals(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  if (flag === "") return false;
  if (/^(on|true|1|yes)$/.test(flag)) return true;
  if (!/^(off|false|0|no)$/.test(flag)) {
    console.error(JSON.stringify({ msg: "council_proposals_invalid", reason: "forventet on eller off", fallback: "off" }));
  }
  return false;
}
