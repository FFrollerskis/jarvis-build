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
  /** WP-C4: «hva har du hjulpet meg med»/«verdi»/«bruk» - Value Center (bruk per verdiløkke, kun tall) via Policy Gateway (aldri LLM). */
  | { kind: "value_report" }
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
  [
    // WP-C4: hele meldingen må være spørsmålet (ankret) - setninger som bare nevner «verdi»/«bruk» («verdi av bilen min», «bruk av tid») går til den intelligente banen.
    /^(?:hva har du (?:hjulpet meg med|gjort for meg|levert)(?: (?:hittil|så langt|i det siste|denne uken|siste uke|i uka|i måneden|siste måned))?|hvor mye bruker (?:jeg )?deg|hvor nyttig er du|verdi(?:-?rapport|-?senter)?|value ?center|bruk(?:s(?:statistikk|metrikk))?|min bruk)\s*[?!.]*\s*$/i,
    () => ({ kind: "value_report" })
  ],
  [/^jobbstatus\s+(\S+)\s*$/i, (m) => ({ kind: "task_status", task_id: m[1] as string })],
  [/^opprett\s+jobb:?\s+(.+)$/i, (m) => ({ kind: "create_task", goal: (m[1] as string).trim() })],
  [/^avbryt\s+jobb\s+(\S+)\s*$/i, (m) => ({ kind: "cancel_task", task_id: m[1] as string })],
  [/^(hjelp|help)\s*$/i, () => ({ kind: "help" })],
  [/^(?:skru|slå) (på|av) lyset(?: her)?\s*$/i, (m) => ({ kind: "home_light", on: (m[1] as string).toLowerCase() === "på" })]
];

export const FAST_ROUTE_PATTERNS: readonly RegExp[] = PATTERNS.map(([pattern]) => pattern);

/**
 * L4 (gjennomgang av PR #312): hurtigbanen kjører SYNKRONT på hendelsesløkken for hver innkommende melding. Mønstre som ender i `\s*[?!.]*\s*$` (to tilstøtende kvantorer over mellomrom) og `\s+(.+)$` bruker O(n²) tid når
 * meldingen har et langt mellomromsløp og så et tegn som ikke passer: «verdi» + 32 000 mellomrom + «x» blokkerte hendelsesløkken i 2,5 s (også de eldre mønstrene: `kostnad` 1,9 s). Forsvaret er todelt og gjelder HELE klassen (også
 * mønstre som legges til senere), ikke bare det ene mønsteret:
 *   1. en melding på over 2 000 tegn er aldri en hurtigkommando (ingen kjent kommando er så lang) og går til den intelligente banen uten at noe regulært uttrykk kjøres,
 *   2. før matching kollapses hvert mellomromsløp til ÉN tegn (`" "`, eller `"\n"` når løpet inneholder et linjeskift, slik at ankrene `.`/`$` oppfører seg som før) - ingen kvantor kan da få mer enn ett mellomrom å jobbe med.
 * Normale meldinger oppfører seg som før; eneste forskjell er at flere mellomrom/tabulatorer mellom ordene i en kommando nå også gjenkjennes («hva  er galt med deg»).
 */
export const FAST_ROUTE_MAX_CHARS = 2_000;

/** Hvert mellomromsløp (inkl. tabulator, NBSP og Unicode-mellomrom) blir ETT tegn: `"\n"` hvis løpet inneholder et linjeskift, ellers `" "`. Lineær tid. */
function collapseWhitespaceRuns(text: string): string {
  return text.replace(/\s+/g, (run) => (/[\n\r\u2028\u2029]/.test(run) ? "\n" : " "));
}

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
  // L4: lengdetak og mellomrom-normalisering FØR noe regulært uttrykk kjøres (se `FAST_ROUTE_MAX_CHARS`). Delegeringen leser den opprinnelige teksten (D-449: eierens egne ord, ordrett).
  if (typeof input !== "string" || input.length > FAST_ROUTE_MAX_CHARS) return null;
  const text = input.trim();
  const flat = collapseWhitespaceRuns(text);
  for (const [pattern, build] of PATTERNS) {
    const match = flat.match(pattern);
    if (match) {
      return build(match);
    }
  }
  return delegateIntent(text);
}
