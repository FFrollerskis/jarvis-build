/**
 * D-353 (Tobias direkte i chat, live bruk: "den leser opp tegn ... den sier
 * bla bla bla så stjerne stjerne punktum" - TTS-en leste Markdown-syntaks
 * (`**fet**`, lister, kodeblokker) bokstavelig i stedet for naturlig tale).
 * Root cause (kildekode-lest, ikke gjettet): `session.ts` sin `enqueueTts()`
 * sendte hver chunk fra `SentenceChunker` RÅTT til `ttsAdapter.synthesize()`
 * - INGEN sanering fantes noe sted i kjeden (samme `/chat`-tekst deles
 * ordrett mellom tekst-UI og tale, `conversation.ts`, så modellen skriver
 * normal Markdown uten å vite at DENNE mottakeren skal HØRE teksten, ikke
 * lese den). Denne funksjonen er det ENE, sentrale sanerings-punktet - kalt
 * FØR hver chunk når TTS-køen (`enqueueTts()`), beskytter derfor ALLE
 * TTS-adaptere (OpenAI/ElevenLabs/lokal Piper) automatisk, uansett fremtidig
 * valg. Ren, deterministisk streng-transformasjon - ingen nettverksavhengighet,
 * ingen modellkall.
 */
export function sanitizeForSpeech(text: string): string {
  let out = text;

  // Kodeblokk-gjerder (```lang / ```) - fjernes helt, beholder innholdet.
  out = out.replace(/```[a-zA-Z0-9]*\n?/g, "");
  // Inline kode (`kode`) -> kun innholdet.
  out = out.replace(/`([^`]+)`/g, "$1");

  // Markdown-lenker [tekst](url) -> kun teksten.
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Fet skrift (**tekst**/__tekst__) -> kun teksten. FØR kursiv, ellers
  // ville en enkelt `*` fra kursiv-regexen spist halve **-paret.
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  // Kursiv med stjerne (*tekst*) -> kun teksten. Enkelt understrek (_tekst_)
  // saneres BEVISST IKKE - for høy risiko for å ødelegge ekte innhold med
  // understrek (snake_case, filnavn, variabelnavn nevnt i svaret).
  out = out.replace(/\*([^*]+)\*/g, "$1");

  // Linjestart-markører: overskrifter (#/##/...), punktlister (-/*/+ ),
  // nummererte lister (1. 2. ...) - fjernes, innholdet beholdes.
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  out = out.replace(/^[ \t]*\d+\.[ \t]+/gm, "");

  // Siste sikkerhetsnett: enhver gjenværende stjerne/backtick (f.eks. et
  // upar t **-tegn som overlevde chunk-grensen) fjernes helt - disse skal
  // ALDRI uttales, uansett hvilket mønster som eventuelt ikke ble fanget over.
  out = out.replace(/[*`]/g, "");

  // Slå sammen whitespace som tegnfjerningen kan ha etterlatt.
  out = out.replace(/[ \t]{2,}/g, " ").trim();

  return out;
}
