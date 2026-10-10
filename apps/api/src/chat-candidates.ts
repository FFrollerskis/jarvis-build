/**
 * WP-D4 (JARVIS-033): kandidatkjeden for standardstien (vanlig chat/tale). Tidligere var «Gemma først» (D-354) en preferanseliste som ga ÉN kandidat per plan; feilet den, ble hele kallet
 * kjørt om uten preferanse (D-354/D-404) - uten at eieren fikk vite det. Nå er listen en KJEDE: gatewayen går til neste kvalifiserte medlem ved en klassifisert feil før noe er sendt
 * (`preferenceFailover`), og enhver reservebruk er synlig (merknad bak svaret + logg).
 *
 * Reglene er UENDRET (kjeden er en hard liste; hver port gjelder per medlem - SECRET_RESTRICTED er alltid lokal (D-378), `paid_models_allowed=false` respekteres, `mode: LOCAL` gjelder):
 *  - `JARVIS_CHAT_CANDIDATES` = kommaseparert, ORDNET liste av leverandørnavn. Tom/usatt = nøyaktig det som gjaldt før (`gemma_local,gemma_hosted`). Eieren utvider kjeden bevisst, f.eks.
 *    `gemma_local,local_llm,gemma_hosted` (neste lokale modell) eller `…,anthropic` (eksplisitt, betalt sky-reserve - kun når sensitivitet og betalingspolicy tillater det, ellers hoppes den over).
 *    Ugyldig verdi (tegn utenfor `a-z0-9_`, over 8 medlemmer) → standardkjeden, aldri en halvparset liste.
 *  - `JARVIS_CHAT_AUTO_FALLBACK` styrer den SISTE reserven (D-354/D-404): når hele kjeden er uttømt, kjøres kallet om gjennom vanlig ruting (samme sensitivitets- og betalingsregler) i stedet for å feile.
 *    Tom/usatt = på (som før). `off` = strengt «kun kjeden»: ingen reserve utenfor den. Ugyldig verdi = av (fail-closed, aldri en stille sky-reserve ved en skrivefeil).
 */
export const DEFAULT_CHAT_CHAIN: readonly string[] = ["gemma_local", "gemma_hosted"];
const MAX_CHAIN = 8;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;

export interface ChatCandidates {
  /** Ordnet, hard kandidatliste for vanlig prat (aldri tom). */
  chain: readonly string[];
  /** Tillat den siste reserven (kjør om gjennom vanlig ruting når kjeden er uttømt). */
  autoFallback: boolean;
  /** Hvor kjeden kom fra - til oppstartsloggen. */
  source: "default" | "env";
}

export const DEFAULT_CHAT_CANDIDATES: ChatCandidates = { chain: DEFAULT_CHAT_CHAIN, autoFallback: true, source: "default" };

export function parseChatCandidates(rawChain: string | undefined, rawAutoFallback: string | undefined): ChatCandidates {
  let chain: readonly string[] = DEFAULT_CHAT_CHAIN;
  let source: ChatCandidates["source"] = "default";
  const listed = (rawChain ?? "").trim();
  if (listed !== "") {
    const names = listed.split(",").map((n) => n.trim());
    const unique = [...new Set(names)];
    if (names.some((n) => !NAME.test(n)) || unique.length > MAX_CHAIN) {
      console.error(JSON.stringify({ msg: "chat_candidates_invalid", reason: "forventet kommaseparerte leverandørnavn (a-z, 0-9, _), maks 8", fallback: "default" }));
    } else {
      chain = unique;
      source = "env";
    }
  }
  const flag = (rawAutoFallback ?? "").trim().toLowerCase();
  let autoFallback = true;
  if (flag !== "") {
    if (/^(on|true|1|yes)$/.test(flag)) autoFallback = true;
    else if (/^(off|false|0|no)$/.test(flag)) autoFallback = false;
    else {
      autoFallback = false;
      console.error(JSON.stringify({ msg: "chat_auto_fallback_invalid", reason: "forventet on eller off", fallback: "off" }));
    }
  }
  return { chain, autoFallback, source };
}

/** Navn i kjeden som ikke finnes blant registrerte leverandører (en skrivefeil gir et inert medlem - logges ved oppstart så det ikke gjemmer seg). */
export function unknownChainMembers(chain: readonly string[], known: Iterable<string>): string[] {
  const set = new Set(known);
  return chain.filter((name) => !set.has(name));
}
