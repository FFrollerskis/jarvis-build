/**
 * WP-G1 (D-463, P1b/P1c/P1d): mottakerens EGEN avmelding (STOP). REN tolkning av en innkommende melding - ingen DB, ingen modell. Reglene følger leverandørenes dokumenterte oppførsel (Twilio: kun ENKELTORDS-svar utløser
 * avmelding; STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, REVOKE, OPTOUT, QUIT; gjenopptak med START eller UNSTOP - verifisert mot Twilios støtteartikkel/feilkode 21610). Norske ord (STOPP, AVMELD) er lagt til: et norsk svar
 * «stopp» er en tydelig avmelding, og feilretningen (blokkere en sending for mye) er den trygge.
 *
 * ASYMMETRI (bevisst): mange stopp-ord, få start-ord. `START`/`UNSTOP` gjenopptar; `YES`/`JA` gjør det IKKE (Twilio godtar YES på langkoder, men et «ja» på et spørsmål skal aldri stille oppheve en avmelding).
 * Gjelder KUN SMS og WhatsApp (kanalene der tekst-STOP er normen); andre kanaler har ingen slik konvensjon.
 */
const STOP_WORDS: ReadonlySet<string> = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "REVOKE", "OPTOUT", "QUIT", "STOPP", "AVMELD", "AVMELDING"]);
const START_WORDS: ReadonlySet<string> = new Set(["START", "UNSTOP"]);

export type OptKeyword = "stop" | "start";

/** Kanalene der en tekst-STOP/START tolkes. */
export const OPT_KEYWORD_CHANNELS: ReadonlySet<string> = new Set(["sms", "whatsapp"]);

export function parseOptKeyword(text: string | null | undefined): OptKeyword | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 64) return null;
  // Ett ord: ingen mellomrom midt i. Avsluttende tegnsetting ignoreres («STOP!», «Stop.»); store/små bokstaver og fullbredde-tegn jevnes ut (NFKC).
  const normalized = text.normalize("NFKC").trim().replace(/[.!?,;:\s]+$/u, "").toUpperCase();
  if (normalized.length === 0 || /\s/u.test(normalized)) return null;
  if (STOP_WORDS.has(normalized)) return "stop";
  if (START_WORDS.has(normalized)) return "start";
  return null;
}
