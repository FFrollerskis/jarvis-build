/**
 * D-30 live-funn (§10): STT-akseptansen må godta semantisk ekvivalente
 * representasjoner - live-Whisper transkriberte "Hva er atten ganger sju?"
 * helt korrekt som "Hva er 18 x 7?", men naiv ord-overlapp kalte det FAIL
 * (falsk negativ). Kanonisering mapper kjente tall-/operator-varianter til én
 * form FØR overlapp måles. Terskelen beholdes - vilkårlig dårlige transkript
 * (og svekket norsk kalender-setning) skal fortsatt feile.
 */
const CANONICAL: Record<string, string> = {
  // Tallord ↔ sifre (kun de akseptansefrasene bruker - utvides ved behov):
  atten: "18",
  sju: "7",
  syv: "7",
  // Multiplikasjon: "ganger" / "x" / "×" er samme utsagn:
  ganger: "x",
  "×": "x"
};

function canonicalWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/×/g, " × ")
    .replace(/[^a-zæøå0-9× ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => CANONICAL[w] ?? w);
}

/**
 * Sant når transkriptet dekker nok av originalfrasen (kanonisert ordoverlapp).
 * Samme minimumsterskel som før (≥3 ord) - robusthet kommer KUN fra
 * kanoniseringen, ikke fra å senke kravet.
 */
export function transcriptMatches(expected: string, actual: string, minOverlap = 3): boolean {
  const actualSet = new Set(canonicalWords(actual));
  const overlap = canonicalWords(expected).filter((w) => actualSet.has(w)).length;
  return overlap >= minOverlap;
}
