/**
 * Fast Router v1 (CANONICAL_SPEC §4): deterministisk intentmatch i ren kode.
 * Kjente kommandoer skal ALDRI trenge en stor LLM - de rutes hit på
 * millisekunder. Rask bane hopper over LLM-en, aldri over Policy Gateway.
 */
export type FastIntent =
  | { kind: "system_status" }
  /** EV-1 (D-412): «hva er galt med deg» - kildebelagt selvdiagnose via Policy Gateway (aldri LLM). */
  | { kind: "self_diagnosis" }
  /** EV-2 (D-417): «hvor bra yter du» - SLO/forverring/dataskvalitet via Policy Gateway (aldri LLM). */
  | { kind: "slo_report" }
  /** WP-B (D-452): «hvordan utvikler du deg» - evolusjonsportene (EV-0…EV-23) i observasjonsmodus via Policy Gateway (aldri LLM). */
  | { kind: "evolution_report" }
  /** D-424: «hva koster du» - run-rate fra cost_events via Policy Gateway (aldri LLM). */
  | { kind: "cost_report" }
  /** D-424: «… i bakgrunnen» - eierens egen melding legges som bakgrunnsjobb via Policy Gateway; en svak lokal modell skal ikke måtte velge verktøy. */
  | { kind: "delegate_background"; prompt: string }
  | { kind: "task_status"; task_id: string }
  | { kind: "create_task"; goal: string }
  | { kind: "cancel_task"; task_id: string }
  | { kind: "help" }
  /** Stedsbevisst: rommet kommer fra identitetskonteksten (site_id/room_id), aldri fra teksten alene. */
  | { kind: "home_light"; on: boolean };

const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => FastIntent]> = [
  [/^(status|systemstatus)\s*$/i, () => ({ kind: "system_status" })],
  [
    /^(?:hva er galt(?: med deg)?(?: nå| akkurat nå)?|hva feiler(?: det)?(?: på deg)?|er du frisk|selv-?diagnose|diagnos(?:er|ér) deg|what'?s wrong(?: with you)?)\s*[?!.]*\s*$/i,
    () => ({ kind: "self_diagnosis" })
  ],
  [
    /^(?:hvor (?:bra|rask) yter du|er du treg|ytelse|ytelsesstatus|slo|tjenestemål|har noe blitt dårligere|dataskvalitet|datakvalitet)\s*[?!.]*\s*$/i,
    () => ({ kind: "slo_report" })
  ],
  [
    /^(?:hvordan utvikler du deg|hvordan går det med utviklingen din|evolusjon(?:srapport|sstatus|sportene)?|evolusjonsporter|hva kan du forbedre(?: hos deg selv)?|hva har du lært|selvforbedring(?:srapport)?|self-?improvement)\s*[?!.]*\s*$/i,
    () => ({ kind: "evolution_report" })
  ],
  [
    /^(?:hva koster (?:du|det)(?: meg)?(?: nå| i måneden| per måned| å kjøre deg)?|hvor mye (?:har du|har jeg|har det) (?:kostet|brukt)(?: .*)?|run-?rate|kostnad(?:er)?|api-?regning(?:en)?|regningen)\s*[?!.]*\s*$/i,
    () => ({ kind: "cost_report" })
  ],
  [/^jobbstatus\s+(\S+)\s*$/i, (m) => ({ kind: "task_status", task_id: m[1] as string })],
  [/^opprett\s+jobb:?\s+(.+)$/i, (m) => ({ kind: "create_task", goal: (m[1] as string).trim() })],
  [/^avbryt\s+jobb\s+(\S+)\s*$/i, (m) => ({ kind: "cancel_task", task_id: m[1] as string })],
  [/^(hjelp|help)\s*$/i, () => ({ kind: "help" })],
  [/^(?:skru|slå) (på|av) lyset(?: her)?\s*$/i, (m) => ({ kind: "home_light", on: (m[1] as string).toLowerCase() === "på" })]
];

/**
 * D-424: eksplisitt ønske om bakgrunnsjobb. Spørsmål OM bakgrunnen («hvorfor kjører den i bakgrunnen?») er ikke en bestilling.
 * Frasen og prefikset er definert ÉN gang (kildestrenger) og brukes både til å gjenkjenne bestillingen og til å fjerne den (`delegationRequestVariants`), så de to aldri kan komme ut av takt.
 */
const DELEGATE_PHRASE = String.raw`\bi bakgrunnen\b`;
const DELEGATE_PREFIX = String.raw`(?:bakgrunnsjobb|deleger)\s*:`;
const DELEGATE_MARK = new RegExp(`${DELEGATE_PHRASE}|^${DELEGATE_PREFIX}`, "i");
const DELEGATE_PREFIX_STRIP = new RegExp(String.raw`^\s*${DELEGATE_PREFIX}\s*`, "i");
const QUESTION_START = /^(?:hvorfor|hvordan|hvem|når|hva er|er det|er den|er jobben|kjører)\b/i;
function delegateIntent(text: string): FastIntent | null {
  if (text.length < 15 || text.length > 2000) return null;
  if (!DELEGATE_MARK.test(text) || QUESTION_START.test(text)) return null;
  const prompt = text.replace(DELEGATE_PREFIX_STRIP, "").trim();
  return prompt.length >= 10 ? { kind: "delegate_background", prompt } : null;
}

/**
 * D-449 (Q-50, gjennomgang nr. 4): hurtigbanen «… i bakgrunnen» skal vurderes som om eieren hadde skrevet forespørselen som vanlig chat, dvs. UTEN delegeringsfrasen/-prefikset. Hvilken tekst chatten da
 * ville sett avhenger av mellomrommet rundt frasen (et linjeskift kan avgjøre om et verktøymønster med `.*` treffer; frasen midt i «bruk i bakgrunnen bare lokale modeller» deler en ruteinstruksjon),
 * så ALLE rimelige fjerninger returneres og kalleren lar den strengeste vinne: (1) meldingen slik den står, (2) frasen fjernet sammen med mellomrommet FØR den, (3) frasen fjernet sammen med
 * mellomrommet ETTER den, (4) frasen erstattet med ett mellomrom og alt mellomrom slått sammen. Prefikset («bakgrunnsjobb:», «deleger:») fjernes i (2)-(4). Tomme varianter og duplikater utelates.
 */
export function delegationRequestVariants(input: string): string[] {
  const withoutPrefix = input.replace(DELEGATE_PREFIX_STRIP, "");
  const phrase = (before: string, after: string): RegExp => new RegExp(`${before}${DELEGATE_PHRASE}${after}`, "gi");
  const variants = [
    input,
    withoutPrefix.replace(phrase(String.raw`\s*`, ""), "").trim(),
    withoutPrefix.replace(phrase("", String.raw`\s*`), "").trim(),
    withoutPrefix.replace(phrase("", ""), " ").replace(/\s+/g, " ").trim()
  ];
  return [...new Set(variants.filter((variant) => variant.trim().length > 0))];
}

/** null = ingen kjent kommando; gå til intelligent bane (LLM). */
export function fastRoute(input: string): FastIntent | null {
  const text = input.trim();
  for (const [pattern, build] of PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return build(match);
    }
  }
  return delegateIntent(text);
}
