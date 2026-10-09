/**
 * Del 3 (JARVIS-016/035): deterministisk innholdsbasert sensitivitet. Erstatter det hardkodede «PUBLIC_OR_LOW_SENSITIVITY» for alt innhold.
 * Regelen er FAIL-CLOSED og streng: det strengeste signalet vinner, og helse/finans/hemmeligheter krever LOKAL behandler
 * (`SECRET_RESTRICTED` ⇒ `isSensitivityEligible` slipper kun `locality === "local"`). Privat/forretningsminne og verktøyresultater fra
 * private kilder ekskluderer gratis-/delt sky (`hosted_free_tier`). Kun innhold uten noen slike signaler er `PUBLIC_OR_LOW_SENSITIVITY`.
 *
 * Dette er mønster-/metadatabasert og IKKE en garanti for at ingen sensitiv tekst noen gang når en delt tjeneste: ukjente formater og
 * indirekte omtaler kan slippe gjennom. Det som er garantert er at KJENTE kategorier (se testene) aldri rutes til gratis/delt sky.
 */
import type { DataSensitivity } from "@jarvis/contracts";
import { containsSecret } from "@jarvis/core";

const RANK: Readonly<Record<DataSensitivity, number>> = {
  PUBLIC_OR_LOW_SENSITIVITY: 0,
  PRIVATE: 1,
  BUSINESS_CONFIDENTIAL: 2,
  SECRET_RESTRICTED: 3
};

export function maxSensitivity(...values: Array<DataSensitivity | undefined>): DataSensitivity {
  let best: DataSensitivity = "PUBLIC_OR_LOW_SENSITIVITY";
  for (const v of values) if (v !== undefined && RANK[v] > RANK[best]) best = v;
  return best;
}

/**
 * Q-52 A (D-450, Tobias 2026-10-09: «Ja til alle Q»): utvidet med bestemte former av ord som allerede fanges i ubestemt form («legen», «fastlegen», «legetimen», «kreften», «blodtrykket», «angsten», «diabetesen») og med
 * entydige helseord som tidligere slapp gjennom (helse, ADHD, tannlege, psykiater, terapi/terapeut, migrene, kolesterol, insulin, kjemoterapi, antidepressiva, covid, sykmelding/sykmeldt, gravid, svangerskap, kolonoskopi, HIV).
 * BEVISST IKKE med (tvetydige i Jarvis' egen hverdag, jf. «gjelder» i D-448): `behandling` (saks-/databehandling), `operasjon`, `abort` (programvare: abort/AbortController), `helsesjekk`/`helsestatus`
 * (systemets egen helse - se `TECHNICAL_HEALTH`), og skatt/konto/penger/økonomi (se AMBIGUOUS_TERMS). «hiv» med små bokstaver er også verbet «å hive» (se `HIV_UPPER`). Alle mønstre er mot ASCII-startende ord:
 * JS `\b` kjenner ikke æøå som ordtegn.
 */
const HEALTH_TERMS: readonly string[] = [
  "diagnose[a-zæøå]*", "sykdom[a-zæøå]*", "sykemelding[a-zæøå]*", "sykmeld[a-zæøå]*", "medisin[a-zæøå]*", "resept[a-zæøå]*", "legetime[a-zæøå]*", "fastlege[a-zæøå]*", "lege(?:n|ne|r|ns)?",
  "sykehus[a-zæøå]*", "blodprøve[a-zæøå]*", "psykolog[a-zæøå]*", "psykisk[a-zæøå]*", "depresjon[a-zæøå]*", "angst(?:en|anfall[a-zæøå]*|lidelse[a-zæøå]*)?", "symptom[a-zæøå]*", "allergi[a-zæøå]*", "graviditet[a-zæøå]*",
  "kreft(?:en)?", "kreft(?:syk|svulst|behandl|celle|diagnos)[a-zæøå]*", "helseopplysning[a-zæøå]*", "diabetes(?:en)?", "blodtrykk[a-zæøå]*",
  "helse(?:n|problem[a-zæøå]*|tilstand[a-zæøå]*)?", "adhd", "psykiater[a-zæøå]*", "tannlege[a-zæøå]*", "terapi(?:en|er|ene)?", "terapeut[a-zæøå]*", "migrene[a-zæøå]*", "kolesterol[a-zæøå]*",
  "insulin[a-zæøå]*", "kjemoterapi[a-zæøå]*", "antidepressiv[a-zæøå]*", "covid(?:-?19)?", "gravid[a-zæøå]*", "svangerskap[a-zæøå]*", "kolonoskopi[a-zæøå]*",
  "medication", "diagnosis", "prescription", "therapy", "therapist", "medical"
];
const HEALTH = new RegExp(`\\b(?:${HEALTH_TERMS.join("|")})\\b`, "i");
/**
 * Gjennomgang av WP-A (D-451): «helse» er også systemets eget ord - Jarvis snakker selv om helsesjekker, tilkoblingshelse og endepunkter («connector-helse», «helse-endepunktet», «helsen til systemet»), og slike svar
 * stod i historikken og låste de neste turene til lokal modell. Teknisk bruk fjernes derfor FØR helseordene sjekkes. Personlig bruk («helsen min», «dårlig helse», «helseproblemer») berøres ikke. Mellomrom tillates
 * bare i «helsen til/for <teknisk objekt>» (med navngitt objekt) - ellers kunne «… på serveren helsen min er dårlig» skjule en ekte helseomtale.
 */
const TECHNICAL_HEALTH: readonly RegExp[] = [
  /(?<![a-zæøå])(?:system|tjeneste|server|connector|provider|leverandør|nett(?:verk)?|api|endepunkt|jarvis|worker|container|database|db|cluster|node|tilkobling|integrasjon)[a-zæøå]*-?helse[a-zæøå]*/gi,
  /(?<![a-zæøå])helse[a-zæøå]*-?(?:endepunkt|sjekk|status|kontroll|api|rute|monitor|overvåk|dashbord|probe|ping|logg)[a-zæøå]*/gi,
  /(?<![a-zæøå])helse(?:n|tilstand(?:en)?)?\s+(?:til|for|i|på|hos)\s+(?:systemet|tjenesten|serveren|nettverket|connectoren|providere?n?|jarvis|api(?:et)?|databasen|workeren|containeren|tilkoblingen|integrasjonen|løsningen)(?![a-zæøå])/gi
];
/**
 * «HIV» skrives med versaler; små bokstaver er også verbet «å hive» («hiv inn en PR») og teller derfor kun i sammensetninger og faste uttrykk («hiv-positiv», «har hiv», «testet positivt på hiv»).
 */
const HIV_UPPER = /(?<![A-Za-zæøåÆØÅ])HIV(?![A-Za-zæøåÆØÅ])/;
const HIV_CONTEXT = /(?<![a-zæøå])hiv-?(?:positiv|smitt|test|medisin|behandling)[a-zæøå]*|(?<![a-zæøå])(?:har|fikk|testet\s+positivt\s+på|smittet\s+av|diagnostisert\s+med)\s+hiv(?![a-zæøå])/i;
function healthHit(text: string): boolean {
  if (HIV_UPPER.test(text) || HIV_CONTEXT.test(text)) return true;
  let cleaned = text;
  for (const pattern of TECHNICAL_HEALTH) cleaned = cleaned.replace(pattern, " ");
  return HEALTH.test(cleaned);
}
// Q-49 (NAS-test 2026-10-08): `gjeld` og `bic` er IKKE lenger prefiksmønstre. `gjeld[a-zæøå]*` fanget også verbet «gjelder/gjelde/gjeldende/gjeldt» (svært vanlige ord),
// og `bic[a-zæøå]*` fanget «bicycle». Gjeld fanges fortsatt som gjeld/gjelden/gjeldene/gjeldsbrev/gjeldsgrad/gjeldfri, og BIC kun som eget ord.
// Q-52 A (D-450): + kontoutskrift, pensjon, bankkonto, kredittkort, inkasso (alle former), aksje/aksjer/aksjene (ikke «aksjeselskap»/«aksjon»), aksjefond, aksjekurs.
const FINANCE_STRONG =
  /\b(?:[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}|\d{4}[ .]?\d{2}[ .]?\d{5}|(?:kontonummer|iban|cvv|kortnummer|bankid|saldo|skattemelding|skatteoppgjør|lønnsslipp|lønn|lån|formue|inntekt|fødselsnummer|personnummer|salary|mortgage|tax return|bank account|kontoutskrift|pensjon|bankkonto|kredittkort|inkasso)[a-zæøå]*|bic(?![a-zæøå])|gjeld(?:en|ene|s[a-zæøå]*|fri)?(?![a-zæøå])|aksje(?:r|ne|n)?(?![a-zæøå])|aksjefond[a-zæøå]*|aksjekurs[a-zæøå]*)(?![a-zæøå])/i;
const FINANCE_WEAK = /\b(faktura[a-zæøå]*|regning[a-zæøå]*|betaling[a-zæøå]*|utbetaling|bank\b|budsjett[a-zæøå]*|kredittkort|vipps|stripe|refusjon|invoice|payment)\b/i;
const BUSINESS = /\b(kontrakt[a-zæøå]*|kunde[a-zæøå]*|tilbud[a-zæøå]*|omsetning[a-zæøå]*|avtale[a-zæøå]*|styrereferat|oppkjøp|konkurranse|forretningshemmelighet|nda\b|confidential|konfidensiell)\b/i;
const PRIVATE_HINT = /\b(passord|adresse|telefonnummer|mobilnummer|kjæreste|samboer|ektefelle|barna mine|skilsmisse|private?)\b/i;

// Q-52 A (D-450): bankkoder som ikke er en «hemmelighet» etter formatet (det fanger `containsSecret`), men som er det etter betydningen.
const SECRET_HINT = /\b(?:pin-?kode[a-zæøå]*|bankid-?kode[a-zæøå]*|engangskode[a-zæøå]*)(?![a-zæøå])/i;
/**
 * Q-52 A (D-450): tvetydige ord som BEVISST IKKE låser noe ennå («ta de tvetydige først etter at du har sett hvor ofte de treffer»). De telles kun - ordnøkkelen (aldri teksten) er med i
 * resultatet, og samtalemotoren logger den (`q52_ambiguous_terms`), så eieren kan se hyppigheten før noe av dem gjøres sensitivt. `ø` kan ikke stå bak `\b` (JS-regler), derfor lookbehind.
 */
const AMBIGUOUS_TERMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["skatt", /(?<![a-zæøå])skatt(?:en|er|ene)?(?![a-zæøå])/i],
  ["konto", /(?<![a-zæøå])konto(?:en|er|ene)?(?![a-zæøå])/i],
  ["penger", /(?<![a-zæøå])peng(?:er|ene)(?![a-zæøå])/i],
  ["økonomi", /(?<![a-zæøå])økonomi[a-zæøå]*/i],
  ["operasjon", /(?<![a-zæøå])operasjon[a-zæøå]*/i],
  ["behandling", /(?<![a-zæøå])behandling[a-zæøå]*/i]
];

export interface SensitivityInput {
  /** Fritekst som skal til modellen (brukermelding, historikk, vedlegg, dokumentutdrag). */
  texts?: ReadonlyArray<string>;
  /** Minnerom elementene i konteksten kommer fra (`health`, `personal`, `business` ...). Tomt = ingen minne i konteksten. */
  memory_spaces?: ReadonlyArray<string>;
  /** `sensitivity`-kolonnen på minneelementene (`normal`/`sensitive`/`special`). */
  memory_sensitivities?: ReadonlyArray<string>;
  /** Verktøyoutput fra private kilder (e-post, kalender, filer) inngår i modellkonteksten. */
  private_tool_output?: boolean;
}

export interface SensitivityDecision {
  sensitivity: DataSensitivity;
  reasons: string[];
  /** Q-52 A (D-450): ordnøkler (`skatt`, `konto`, `penger`, `økonomi`, `operasjon`, `behandling`) som forekom, men BEVISST ikke påvirker klassifiseringen. Kun for måling. */
  ambiguous_terms?: string[];
}

export function classifyContentSensitivity(input: SensitivityInput): SensitivityDecision {
  const reasons: string[] = [];
  let level: DataSensitivity = "PUBLIC_OR_LOW_SENSITIVITY";
  const raise = (to: DataSensitivity, reason: string): void => {
    level = maxSensitivity(level, to);
    reasons.push(reason);
  };
  for (const space of input.memory_spaces ?? []) {
    if (space === "health") raise("SECRET_RESTRICTED", "memory_space:health");
    else if (space === "business" || space === "project") raise("BUSINESS_CONFIDENTIAL", `memory_space:${space}`);
    else if (space === "personal" || space === "home") raise("PRIVATE", `memory_space:${space}`);
    else raise("PRIVATE", `memory_space:${space}`); // guest/shared/ukjent: fail-closed, aldri «public» fra minne
  }
  for (const s of input.memory_sensitivities ?? []) {
    if (s === "special") raise("SECRET_RESTRICTED", "memory_sensitivity:special");
    else if (s === "sensitive") raise("PRIVATE", "memory_sensitivity:sensitive");
  }
  if (input.private_tool_output) raise("PRIVATE", "private_tool_output");
  const ambiguous = new Set<string>();
  for (const text of input.texts ?? []) {
    for (const [key, pattern] of AMBIGUOUS_TERMS) if (pattern.test(text)) ambiguous.add(key);
    if (containsSecret(text) || SECRET_HINT.test(text)) raise("SECRET_RESTRICTED", "text:secret");
    if (healthHit(text)) raise("SECRET_RESTRICTED", "text:health");
    if (FINANCE_STRONG.test(text)) raise("SECRET_RESTRICTED", "text:finance");
    else if (FINANCE_WEAK.test(text)) raise("PRIVATE", "text:finance_weak");
    if (BUSINESS.test(text)) raise("BUSINESS_CONFIDENTIAL", "text:business");
    if (PRIVATE_HINT.test(text)) raise("PRIVATE", "text:private");
  }
  return { sensitivity: level, reasons: [...new Set(reasons)], ...(ambiguous.size > 0 ? { ambiguous_terms: [...ambiguous] } : {}) };
}

/** D-384: så mange av de SISTE historikkmeldingene regnes som «pågående samtale» (oppfølgingsspørsmål beholder konteksten). */
export const RECENT_HISTORY_WINDOW = 4;

/**
 * D-384: én gammel helse-/finansmelding skal ikke låse HELE resten av samtalen (opptil 20 meldinger) til lokal modell.
 * Meldinger i det nylige vinduet beholdes alltid (og klassifiseres som før - et oppfølgingsspørsmål trenger konteksten). Eldre meldinger som
 * ALENE er strengere enn `ceiling` (nivået turen allerede har fra meldingen og det valgte minnet) holdes UTENFOR konteksten, så de aldri
 * sendes til en modell som ikke har lov til å se dem. Rekkefølgen på de som beholdes er uendret.
 */
export function partitionHistoryBySensitivity<T extends { content: string }>(
  history: ReadonlyArray<T>,
  ceiling: DataSensitivity,
  recentWindow: number = RECENT_HISTORY_WINDOW
): { kept: T[]; withheld: number } {
  const cutoff = Math.max(0, history.length - recentWindow);
  const kept: T[] = [];
  let withheld = 0;
  history.forEach((message, index) => {
    const alone = classifyContentSensitivity({ texts: [message.content] }).sensitivity;
    if (index < cutoff && RANK[alone] > RANK[ceiling]) {
      withheld += 1;
      return;
    }
    kept.push(message);
  });
  return { kept, withheld };
}

/**
 * Q-51 D (D-450, Tobias 2026-10-09: «Ja til alle Q»): i stedet for å låse HELE verktøyturen til den lokale modellen fordi én melding i det nylige vinduet berører helse/økonomi/hemmeligheter, kan en
 * SKYBUNDET tur sendes uten de meldingene. Hva som holdes utenfor (gjennomgang av WP-A, D-451: «ikke bare naboen»):
 *  - hver melding som ALENE er strengere enn `ceiling` (standard `BUSINESS_CONFIDENTIAL`, altså kun `SECRET_RESTRICTED`) og PARET deres (svaret rett etter en følsom brukermelding, spørsmålet rett før et følsomt svar) -
 *    gjelder også eldre meldinger utenfor det nylige vinduet, som D-384 ellers fjerner enkeltvis;
 *  - og HELE HALEN fra den første følsomme meldingen i det nylige vinduet (de `recentWindow` siste, som D-384): en oppfølging uten stikkord («Det er kronisk, jeg tar Metformin», «da må jeg vente med bilen til bonusen
 *    kommer») gjengir eller bygger på det følsomme uten at et ord står der, og parregelen alene slapp slike meldinger gjennom til skyen. Det gjør at skyvarianten aldri inneholder noe som kom ETTER at samtalen
 *    berørte det følsomme i det nylige vinduet - prisen er mindre kontekst, ikke svakere personvern.
 * `protect` kan peke ut meldinger som aldri tas med av halen (eierens nåværende melding, som sendes uansett); en melding som likevel parres bort av en følsom nabo vises i `withheld`, så kalleren kan stoppe.
 * Rekkefølgen på de som beholdes er uendret. Det som holdes utenfor går aldri til skyen; den lokale reserveruten får fortsatt hele historikken.
 */
export function withholdSensitiveMessages<T extends { role: string; content: string }>(
  messages: ReadonlyArray<T>,
  options: { ceiling?: DataSensitivity; recentWindow?: number; protect?: (message: T, index: number) => boolean } = {}
): { kept: T[]; withheld: T[] } {
  const ceiling = options.ceiling ?? "BUSINESS_CONFIDENTIAL";
  const recentWindow = options.recentWindow ?? RECENT_HISTORY_WINDOW;
  const direct = messages.map((message) => RANK[classifyContentSensitivity({ texts: [message.content] }).sensitivity] > RANK[ceiling]);
  const drop = [...direct];
  direct.forEach((isDirect, index) => {
    if (!isDirect) return;
    const role = messages[index]!.role;
    if (role === "user" && messages[index + 1]?.role === "assistant") drop[index + 1] = true;
    if (role === "assistant" && messages[index - 1]?.role === "user") drop[index - 1] = true;
  });
  const cutoff = Math.max(0, messages.length - recentWindow);
  const firstRecent = direct.findIndex((isDirect, index) => index >= cutoff && isDirect);
  if (firstRecent >= 0) {
    // Halen er alt ETTER den første følsomme meldingen i det nylige vinduet (selve meldingen og brukerpartneren rett foran er allerede tatt av `direct` og parregelen).
    for (let index = firstRecent + 1; index < messages.length; index += 1) {
      if (!(options.protect?.(messages[index]!, index) ?? false)) drop[index] = true;
    }
  }
  const kept: T[] = [];
  const withheld: T[] = [];
  messages.forEach((message, index) => (drop[index] ? withheld : kept).push(message));
  return { kept, withheld };
}
