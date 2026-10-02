/**
 * D-369: DETERMINISTISK avgjørelse (ingen LLM) av om et modellforslag til minne (`memory.propose`) er noe EIEREN selv uttrykkelig
 * ba om i DENNE samtaleturen. Er det det, kan forslaget godkjennes automatisk (eieren har allerede gitt «godkjenningen» i selve
 * meldingen - ingen kunstig ekstra sperre for eier, D-41). Er det IKKE det (modellen har selv funnet på det, eller innholdet stammer
 * fra et verktøyresultat/e-post/web), forblir det i karantene og krever manuell godkjenning i dashbordet (regel 7).
 *
 * Alle tre må holde (fail closed ved tvil):
 *   1. eierens melding inneholder en eksplisitt «husk»-intensjon,
 *   2. meldingen er kort (en innlimt e-post/dokument kan ikke «bære» et forslag gjennom automatikken),
 *   3. forslagets innhold er dekket av eierens egne ord (de fleste betydningsbærende ord finnes i meldingen) og er kort.
 * Innhold som modellen har hentet fra en ubetrodd kilde finnes per definisjon ikke i eierens melding og feiler dermed (3).
 */
const MAX_USER_MESSAGE_CHARS = 600;
const MAX_CONTENT_CHARS = 400;
const MIN_SUPPORT_RATIO = 0.6;
const MIN_SUPPORTED_TOKENS = 2;

const INTENT = /(^|[^\p{L}])(husk|husk\s+at|husk\s+dette|ikke\s+glem|ikke\s+glemme|lagre|ta\s+vare\s+på|noter(\s+deg)?|remember|don'?t\s+forget|keep\s+in\s+mind|note\s+that)([^\p{L}]|$)/iu;

const STOPWORDS = new Set([
  "og", "som", "har", "det", "den", "det", "til", "med", "for", "ikke", "men", "eller", "han", "hun", "jeg", "meg", "min", "mitt", "mine",
  "the", "and", "that", "with", "has", "have", "for", "his", "her", "are", "was", "this", "tobias", "bruker", "eieren"
]);

function tokens(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Enkel prefiks-«stamme» så bøyning (barn/barna, liker/likte) ikke gir falske avslag. */
const stem = (t: string): string => t.slice(0, Math.min(t.length, 5));

export function ownerStatesMemory(userMessage: string | undefined, subject: string, content: string): boolean {
  if (typeof userMessage !== "string" || userMessage.trim().length === 0 || userMessage.length > MAX_USER_MESSAGE_CHARS) return false;
  if (typeof content !== "string" || content.trim().length === 0 || content.length > MAX_CONTENT_CHARS) return false;
  if (typeof subject !== "string" || subject.trim().length === 0) return false;
  if (!INTENT.test(userMessage)) return false;
  const contentTokens = tokens(content);
  if (contentTokens.length === 0) return false;
  const messageStems = new Set(tokens(userMessage).map(stem));
  const supported = contentTokens.filter((t) => messageStems.has(stem(t))).length;
  return supported >= MIN_SUPPORTED_TOKENS && supported / contentTokens.length >= MIN_SUPPORT_RATIO;
}
