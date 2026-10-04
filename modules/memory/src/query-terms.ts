/**
 * D-386: deterministisk spørringsforberedelse for fulltekst. `plainto_tsquery` har OG-semantikk: ett ekstra ord i
 * spørsmålet («hva heter egentlig hunden min?») dreper hele treffet. Her bygges i stedet en ELLER-spørring av
 * innholdsordene (stoppord fjernet), som `to_tsquery('norwegian', ...)` stemmer per ord; rangeringen (`ts_rank_cd`)
 * belønner likevel flere treff. Termene er strengt sanert (kun bokstaver/sifre) - de kan aldri endre tsquery-syntaksen.
 */
const STOPWORDS = new Set([
  "og", "i", "jeg", "det", "at", "en", "et", "den", "til", "er", "som", "på", "de", "med", "han", "av", "ikke", "der", "så",
  "var", "meg", "seg", "men", "ett", "har", "om", "vi", "min", "mitt", "ha", "hadde", "hun", "nå", "over", "da", "ved", "fra",
  "du", "ut", "sin", "dem", "oss", "opp", "man", "kan", "hans", "hvor", "eller", "hva", "skal", "selv", "sjøl", "her", "alle",
  "vil", "bli", "ble", "blitt", "kunne", "inn", "når", "være", "kom", "noen", "noe", "ville", "dere", "som", "deres", "kun",
  "ja", "etter", "ned", "skulle", "denne", "for", "deg", "si", "sine", "sitt", "mot", "å", "meget", "hvorfor", "dette", "disse",
  "uten", "hvordan", "ingen", "din", "ditt", "blir", "samme", "hvilken", "hvilke", "sånn", "inni", "mellom", "vår", "hver",
  "hvem", "vors", "hvis", "både", "bare", "enn", "fordi", "før", "mange", "også", "slik", "vært", "være", "begge", "siden",
  "hei", "takk", "ok", "husker", "husk", "vet", "egentlig", "liksom", "the", "and", "what", "is", "my", "do", "you", "a", "of"
]);

const MAX_TERMS = 12;

export function queryTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const term = raw.replace(/[^a-zæøåäöü0-9]/g, "");
    if (term.length < 2 || STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** `to_tsquery`-streng med ELLER mellom termene; tom streng når ingen innholdsord finnes (kalleren hopper over FTS). */
export function orTsQuery(terms: readonly string[]): string {
  return terms.join(" | ");
}

/** Grov tokentelling for budsjettstyring (norsk ligger rundt 3,5 tegn per token i vanlige tokenizere). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
