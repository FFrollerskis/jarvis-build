/**
 * WP-D1 (Q-26, gjennomgang av PR #325, funn 8): bryteren for kildeverifiseringens SKRIVE-veier (registrer påstand, legg til/trekk tilbake evidens, foreslå promotering til minnets karantene).
 *
 *  - `JARVIS_KNOWLEDGE_CLAIM_WRITES`: tom/usatt = AV (standard - kun lesingen `knowledge.get_claim_status` finnes). KUN den eksakte verdien `on` slår skriving på (som de øvrige bryterne, jf. `JARVIS_COUNCIL_PROPOSALS`):
 *    `ON`, ` on`, `on\n`, `true`, `1`, `yes` og skrivefeil = AV (fail-closed) og en logglinje, så eieren ser at verdien ikke ble tatt til følge. `off` = av.
 */
export function parseKnowledgeClaimWrites(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false;
  if (raw === "on") return true;
  if (raw !== "off") {
    console.error(JSON.stringify({ msg: "knowledge_claim_writes_invalid", reason: "forventet nøyaktig on eller off", fallback: "off" }));
  }
  return false;
}
