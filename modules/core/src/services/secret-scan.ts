import { SCAN_OVERLAP_CHARS, SCAN_WINDOW_CHARS, buildView, isWordChar, origEnd, origStart, squeezeView, windowStarts, type ScanView, type Squeezed } from "./secret-scan-view.ts";
import { classifyKey, isAuthCredential, isAuthPlaceholder, isBenignSecretValue } from "./secret-scan-keys.ts";

/**
 * Del 3 (JARVIS-013/005) + WP-SEC2 (JARVIS-013/069, D-487): deterministisk hemmelighetsdeteksjon + redigering FØR tekst lagres (messages, minne, audit) eller sendes til en modell/leverandør. Mønsterbasert (ingen LLM) og
 * bevisst høy-presisjon: kjente token-formater, private nøkler, `NAVN=verdi` og `"navn":"verdi"` der navnet ser ut som en hemmelighet, `Authorization:`-/`Cookie:`-headere, «passord er …»-fraser og kortnumre (Luhn).
 * Kun VERDIEN fjernes; typen rapporteres (aldri innholdet). Dette er ikke en garanti mot alle hemmeligheter - uregistrerte formater og hex/base64 UTEN kontekst slipper gjennom (se docs/runbooks/WPSEC2_SECRET_SCAN.md).
 *
 * WP-SEC2 (K1-K6): mønstrene kjøres mot en normalisert VISNING (`secret-scan-view.ts`: NFKC per kodepunkt, usynlige tegn/kombinerende merker borte, fullbredde -> ASCII, liten homoglyf-tabell) og treffene brukes på
 * ORIGINALTEKSTEN via et indekskart: hele det opprinnelige spennet (også skjulte tegn midt i en nøkkel) erstattes av `[REDACTED:<type>]`. Tekst UTEN funn er BYTE-IDENTISK uendret. De prefiks-forankrede reglene (ghp_, sk-,
 * AKIA, xox, eyJ, -----BEGIN ...) kjøres i tillegg mot en KLEMT visning (blanke mellom to token-tegn fjernet) så en hemmelighet delt over mellomrom/linjeskift fanges. Inndata over `SCAN_WINDOW_CHARS` skannes i overlappende
 * vinduer (overlapp `SCAN_OVERLAP_CHARS`, minst 8 KiB). Alt er lineært; ingen regel har uavgrenset tilbakesporing.
 *
 * Eksisterende API (`scanForSecrets`, `containsSecret`, `describeSecretFindings`) er uendret for kallere. Nye, additive: `scanSecretSpans`/`applySecretSpans` (spenn i originalkoordinater), `redactForLog`, og
 * `scanStructuredForSecrets` (secret-scan-structured.ts).
 */
export { SCAN_OVERLAP_CHARS, SCAN_WINDOW_CHARS };

export interface SecretFinding {
  kind: string;
  count: number;
}

export interface SecretScanResult {
  /** Teksten med hver funnet hemmelighet erstattet av `[REDACTED:<type>]`. */
  text: string;
  findings: SecretFinding[];
}

/** Et funn i ORIGINALtekstens koordinater (`[start, end)`, UTF-16). `order` = mønsterets prioritet (lavest vinner når to typer overlapper). */
export interface SecretSpan {
  start: number;
  end: number;
  kind: string;
  order: number;
}

export interface SecretScanOptions {
  /** Brukes av strukturert skanning (flere søsken limt sammen): en privat nøkkel uten avslutning gir INGEN spenn her (hver del skannes for seg), kun BEGIN..END på tvers av deler. */
  noUnterminatedKey?: boolean;
}

interface PatternDef {
  readonly kind: string;
  readonly re?: RegExp;
  /** Gruppen som redigeres (ellers hele treffet). Mønstre med gruppe MÅ ha `d`-flagget. */
  readonly group?: number;
  /** Gruppen som «eies» av dette mønsteret (vinner over senere mønstre). Standard: redigeringsgruppen. */
  readonly claim?: number;
  readonly skip?: (m: RegExpExecArray) => boolean;
  /** Et forkastet treff (`skip`) eier likevel området, så senere mønstre ikke redigerer deler av det (f.eks. «Bearer» i `Authorization: Bearer <token>`). */
  readonly claimOnSkip?: boolean;
  /** Etter et forkastet treff (`skip`) søkes det videre fra denne indeksen i stedet for treffets slutt: et forkastet treff skal ikke skjule et ekte treff som ligger inne i det forbrukte området (fiks-runde 1, A-L1). Må være større enn treffets start. */
  readonly resumeAfterSkip?: (m: RegExpExecArray) => number;
  readonly special?: "private_key";
}

// Leverandørfakta (token-formater) er `unverified` til offisiell dokumentasjon er lest (D-41). WP-SEC2: docs-vertene var utilgjengelige (nettverket blokkerte dem), så ALLE nye formater under er `unverified`.
const AUTH_SCHEME_WORDS = "Basic|Bearer|Digest|Negotiate|NTLM|Token|ApiKey|Api-Key|Bot|SSWS|OAuth|Splunk|GenieKey|Hawk|JWT|Key";
const SCHEME_ONLY = new RegExp(`^(?:${AUTH_SCHEME_WORDS}|AWS4-HMAC-SHA256)$`, "i");
const PLACEHOLDER = /^(?:true|false|null|none|undefined|n\/a|\*+|x+|\.{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[A-Za-z_]+%)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const startsWithMarker = (text: string): boolean => text.startsWith("[REDACTED");
/** `auth.js:41:11` i en stakksporing er en kildeplassering, ikke `NAVN: verdi` (WP-SEC2 K5: stakksporinger i en auth-modul ble tidligere redigert). */
const FILE_LOCATION = /\.(?:[cm]?[jt]sx?|py|java|go|rs|cs|rb|php|kt|swift|cc?|cpp|hh?|hpp|scala|sh)\s*:\s*\d+(?::\d+)*\)?[,;]?$/i;

/** A-L9: `cond ? "api_key" : "short_lived_token"` er kode, ikke JSON: et JSON-nøkkelnavn følger aldri rett etter «?». */
const TERNARY_BEFORE = /\?\s*$/;
/** `"navn": "verdi"` (JSON-tekst): verdien redigeres når NAVNET er en hemmelighet (K3). Korte verdier under ikke-sterke navn (`"auth":"none"`) røres ikke, og heller ikke status-/plassholderverdier (`"password":"required"`, A-L9). */
function jsonPairSkip(m: RegExpExecArray): boolean {
  const key = m[1] as string;
  const value = m[2] as string;
  if (value.length === 0 || startsWithMarker(value) || PLACEHOLDER.test(value)) return true;
  if (TERNARY_BEFORE.test(m.input.slice(Math.max(0, m.index - 16), m.index))) return true;
  const cls = classifyKey(key);
  if (cls.authHeader) return !isAuthCredential(value); // `"authorization_header":"Basic …"` er en hemmelighet; `"auth_header":"X-Api-Key"` (et headernavn) er det ikke
  if (!cls.secret) return true;
  if (isBenignSecretValue(value, cls)) return true;
  return !cls.strong && value.length < 6;
}
/** Skipper et forkastet JSON-par og fortsetter fra verdiens åpningsanførselstegn (`openLen` tegn før verdien): det kan være NESTE pars nøkkel (`"d":\n"password":"…"`). */
const resumeAtValueQuote = (openLen: number) => (m: RegExpExecArray): number => Math.max(m.index + 1, (m.indices?.[2]?.[0] ?? m.index + 1) - openLen);

/** K4: hex/base64 KUN med hemmelighetsord rett foran (aldri frittstående: hasher, digester, trace-id-er og UUID-er er overalt). */
/** A-L9: ord rett foran nøkkelordet som gjør en 40-/64-sifret heksverdi til en git-SHA/sjekksum (`commit key: <sha>`, `cache key: <digest>`), ikke en hemmelighet. */
const GIT_CONTEXT = /(?:^|[^A-Za-z])(?:commit|sha|git|cache|object|tree|parent|revision|rev|build|etag|checksum|digest)[ \t_-]{0,3}$/i;
function blobSkip(m: RegExpExecArray): boolean {
  const value = m[1] as string;
  if (startsWithMarker(value) || UUID.test(value)) return true;
  if ((value.length === 40 || value.length === 64) && /^[0-9A-Fa-f]+$/.test(value) && GIT_CONTEXT.test(m.input.slice(Math.max(0, m.index - 16), m.index))) return true;
  if (/^[0-9A-Fa-f]+$/.test(value)) return !(/\d/.test(value) && /[A-Fa-f]/.test(value));
  if (!(/\d/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value))) return true;
  const slashes = (value.match(/\//g) ?? []).length;
  const dashes = (value.match(/[-_]/g) ?? []).length;
  return slashes > value.length / 12 || dashes > value.length / 8 || new Set(value).size < 8;
}

/** Tilfeldig kropp: både sifre, små og store bokstaver (base62). En vanlig identifikator/et ord har det aldri. */
const mixedRandom = (text: string): boolean => /\d/.test(text) && /[a-z]/.test(text) && /[A-Z]/.test(text);

const PATTERNS: ReadonlyArray<PatternDef> = [
  { kind: "private_key", special: "private_key" },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g },
  { kind: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "stripe_key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bwhsec_[A-Za-z0-9]{16,}\b/g },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "telegram_bot_token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { kind: "enrollment_ticket", re: /\benr_[A-Za-z0-9_-]{30,}\b/g },
  { kind: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
  // WP-SEC2 (K4), alle `unverified` (ikke lest i offisiell dokumentasjon; kjent offentlig praksis): SendGrid `SG.<22>.<43>`, npm `npm_<36>`, GitLab `gl<type>-<20+>`, Google OAuth (`ya29.`, `GOCSPX-`, `1//0`), Slack app-token `xapp-`, Hugging Face `hf_`.
  { kind: "sendgrid_key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { kind: "npm_token", re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { kind: "gitlab_token", re: /\bgl(?:pat|dt|rt|ptt|ft|imt|agent|cbt|soat|oas)-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "google_oauth_token", re: /(?<![A-Za-z0-9_])(?:ya29\.[A-Za-z0-9_-]{20,}|GOCSPX-[A-Za-z0-9_-]{20,}|1\/\/0[A-Za-z0-9_-]{30,})/g },
  { kind: "slack_app_token", re: /\bxapp-\d-[A-Za-z0-9-]{20,}\b/g },
  { kind: "huggingface_token", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  // Fiks-runde 1 (review A, M4): connector-leverandørenes formater (docs/INTEGRATIONS.md: Notion, Linear, Sentry, Tavily, Groq, Atlassian, Brave, Twilio, Telnyx, HubSpot, Dropbox, Discord, Slack, Resend, Meta) FRITTSTÅENDE, uten nøkkelord foran
  // (eieren limer en nøkkel i chat uten «TOKEN=»). ALLE `unverified`: leverandørdokumentasjonen kunne ikke leses (ingen nett), formene er kjent offentlig praksis. Hver regel er STRENG (tegnklasse + minstelengde); der prefikset er kort
  // eller vanlig (`secret_`, `re_`, `BSA`, Discord) kreves en tilfeldig kropp (sifre og bokstaver) så en vanlig identifikator ikke treffes.
  { kind: "notion_token", re: /\b(?:ntn_[A-Za-z0-9]{40,}|secret_[A-Za-z0-9]{40,})\b/g, skip: (m) => m[0].startsWith("secret_") && !mixedRandom(m[0].slice(7)) },
  { kind: "linear_token", re: /\blin_(?:api|oauth)_[A-Za-z0-9]{32,}\b/g },
  { kind: "sentry_token", re: /\bsntry[su]_[A-Za-z0-9+/=_-]{40,}/g },
  { kind: "tavily_key", re: /\btvly-[A-Za-z0-9_-]{28,}\b/g },
  { kind: "groq_key", re: /\bgsk_[A-Za-z0-9]{40,}\b/g },
  { kind: "atlassian_token", re: /\bATATT[A-Za-z0-9_=-]{60,}/g },
  { kind: "brave_key", re: /\bBSA[A-Za-z0-9_-]{27,}\b/g, skip: (m) => !(/\d/.test(m[0]) && /[A-Za-z]/.test(m[0].slice(3))) },
  { kind: "twilio_sid", re: /\b(?:SK|AC)[0-9a-f]{32}\b/g },
  { kind: "telnyx_key", re: /\bKEY0[A-Za-z0-9]{28,}(?:_[A-Za-z0-9]{16,})?\b/g },
  { kind: "hubspot_token", re: /\bpat-[a-z]{2}\d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { kind: "dropbox_token", re: /(?<![A-Za-z0-9_.-])sl\.[A-Za-z0-9_-]{100,}/g },
  { kind: "discord_bot_token", re: /\b[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b/g, skip: (m) => !mixedRandom(m[0]) },
  { kind: "webhook_url", re: /\b(?:https?:\/\/)?(?:hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}|discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d{15,22}\/[A-Za-z0-9_-]{50,})/g },
  { kind: "resend_key", re: /\bre_[A-Za-z0-9_]{28,}\b/g, skip: (m) => !mixedRandom(m[0].slice(3)) },
  { kind: "meta_token", re: /\bEAA[A-Za-z0-9]{80,}\b/g },
  // age (prosjektets egen SOPS/age): bech32-alfabetet, `AGE-SECRET-KEY-1` + 58 tegn (50-70 godtatt fordi lengden er `unverified`). Den OFFENTLIGE nøkkelen (`age1…`) er ingen hemmelighet.
  { kind: "age_secret_key", re: /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{50,70}\b/gi },
  // Azure: `AccountKey=…`/`SharedAccessKey=…` i tilkoblingsstrenger og `sig=` i SAS-URL-er (`sv=<dato>&…&sig=…`). `unverified`.
  { kind: "azure_key", re: /\b(?:AccountKey|SharedAccessKey|PrimaryMasterKey|SecondaryMasterKey)\s*=\s*["']?([^\s;"']{16,})/gid, group: 1 },
  { kind: "azure_key", re: /\bsv=\d{4}-\d{2}-\d{2}[^\s"'<>]{0,600}?[?&;]sig=([A-Za-z0-9%+/=_-]{20,})/gd, group: 1 },
  // Gjennomgang av PR #316 (L-1): URL med passord i «bruker:passord@vert» (https://admin:…@…, postgres://u:…@db/…, redis://:pw@…, også tomt brukernavn). Kun PASSORDET fjernes (skjema, bruker og vert beholdes).
  // LINEÆRT: skjemanavnet er begrenset (`{0,31}`), brukernavnet kan ikke inneholde «/», «:» eller «@», og passordet stopper ved «/», «@» eller mellomrom.
  { kind: "url_credentials", re: /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]*:)([^\s/@]+)(?=@)/gid, group: 2 },
  // WP-SEC2 (K3): `Authorization: <skjema> <credential>` for ALLE skjemaer - kun credential redigeres, ikke «Bearer»/«Basic». Skjemaer med flere parametre (Digest, AWS4-HMAC-SHA256, Hawk, OAuth) redigeres til linjeslutt.
  // «Eier» (claim) er hele skjema+credential, så navn=verdi-mønsteret under ikke tar ordet «Bearer» (den gamle feilen: «Authorization: Bearer abc123» ble «[REDACTED] abc123»).
  { kind: "authorization_header", re: /\b(?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*["']?((?:Digest|AWS4-HMAC-SHA256|Hawk|OAuth)[ \t]+([^\r\n]{3,2000}))/gid, group: 2, claim: 1, claimOnSkip: true, skip: (m) => startsWithMarker(m[2] as string) },
  {
    kind: "authorization_header",
    re: new RegExp(`\\b(?:Proxy-)?Authorization["']?[ \\t]*[:=][ \\t]*["']?((?:(?:${AUTH_SCHEME_WORDS})[ \\t]+)?([^\\s"']{3,}))`, "gid"),
    group: 2,
    claim: 1,
    claimOnSkip: true,
    // A-L7: kun en REELL, lukket plassholderform er unntatt (`<token>`, `${TOKEN}`, `{{ token }}`, `...`); et ekte token som tilfeldigvis starter med `<`, `{`, `$`, `%` eller `[` redigeres.
    skip: (m) => {
      const credential = m[2] as string;
      if (startsWithMarker(credential) || SCHEME_ONLY.test(credential)) return true;
      const at = m.indices?.[2]?.[0];
      return at !== undefined && isAuthPlaceholder(m.input.slice(at, at + 140));
    }
  },
  // A-L1: «name=»-kravet står i REGEXEN (lookahead), ikke i skip: et godartet `Cookie: <prosa>` forbruker da ikke resten av linjen og skjuler ikke en ekte cookie senere på linjen (`Cookie: godkjent av styret og Cookie: sid=…`).
  { kind: "cookie_header", re: /\b(?:Set-)?Cookie[ \t]*:[ \t]*(?=[A-Za-z0-9_.~%+-]{1,64}=)([^\r\n]{1,2000})/gid, group: 1, skip: (m) => startsWithMarker(m[1] as string) },
  // WP-SEC2 (K3): JSON-tekstform `"navn": "verdi"` (anførselstegn mellom navn og kolon gjør at NAVN=verdi under ikke ser den), også enkle anførselstegn og dobbelt-escapet JSON (`\"navn\":\"verdi\"`).
  { kind: "named_secret", re: /"([^"\\\r\n]{1,80})"[ \t\r\n]*:[ \t\r\n]*"((?:[^"\\]|\\.)*)"/gd, group: 2, skip: jsonPairSkip, resumeAfterSkip: resumeAtValueQuote(1) },
  { kind: "named_secret", re: /'([^'\\\r\n]{1,80})'[ \t\r\n]*:[ \t\r\n]*'((?:[^'\\]|\\.)*)'/gd, group: 2, skip: jsonPairSkip, resumeAfterSkip: resumeAtValueQuote(1) },
  { kind: "named_secret", re: /\\"([^"\\\r\n]{1,80})\\"[ \t\r\n]*:[ \t\r\n]*\\"((?:[^"\\]|\\(?!"))*)\\"/gd, group: 2, skip: jsonPairSkip, resumeAfterSkip: resumeAtValueQuote(2) },
  // `NAVN=verdi` / `NAVN: verdi` der NAVN ser ut som en hemmelighet - kun verdien fjernes.
  // Gjennomgang av WP-A (D-451): prefikset/suffikset er BEGRENSET (`{0,64}`). Uten tak er `[A-Za-z0-9_.-]*` + `\b` kvadratisk på lange tekster uten nøkkelord: 64 KB «a.b.…» tok 5 s og 500 KB «lege-…» 143 s per klassifisering.
  { kind: "named_secret", re: /\b([A-Za-z0-9_.-]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)[A-Za-z0-9_.-]{0,64}\s*[:=]\s*["']?)([^\s"']{6,})/gid, group: 2, skip: (m) => FILE_LOCATION.test(m[0]) },
  // Miljøvariabel-stil med KEY i navnet (STORE BOKSTAVER, så «monkey=...» ikke treffer): INFISICAL_ENCRYPTION_KEY=..., AWS_KEY_ID=...
  { kind: "named_secret", re: /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?:_KEY|KEY_[A-Z0-9_]+)\s*[:=]\s*["']?)([^\s"']{6,})/gd, group: 2 },
  // Naturlig språk (norsk/engelsk): «passordet mitt er X», «password: X», «kodeord er X». Vanlige statusord etter «er» («passordet er sendt til deg», «password is required») er ikke hemmeligheter (D-451).
  { kind: "spoken_password", re: /\b(?:passord(?:et)?(?:\s+mitt)?|password|kodeord(?:et)?)(?:\s+(?:min|mi|mitt|di|ditt|din|vår))?\s*(?:er|is|[:=])\s*["']?(?!(?:sendt|satt|endret|påkrevd|krevd|riktig|feil|ugyldig|utløpt|glemt|nullstilt|required|invalid|incorrect|wrong|expired|set|sent|changed|reset|missing|empty|tomt|too|not)(?![A-Za-zæøåÆØÅ0-9]))([^\s"',.;]{4,})/gid, group: 1 },
  // Gjennomgang av WP-A (D-451): også bestemte former («PIN-koden er …») og BankID-/engangskoder. En kode har SIFFER; «engangskoden er sendt til deg» og «Pin er satt til høy» er ikke koder.
  { kind: "spoken_code", re: /\b(?:pin(?:-?kode[a-zæøå]*)?|bankid-?kode[a-zæøå]*|engangskode[a-zæøå]*)(?:\s+(?:min|mi|mitt|di|ditt|din|vår))?(?:\s+(?:fra|på|til|for)\s+[A-Za-zæøåÆØÅ-]{2,20}){0,2}\s*(?:er|is|[:=])\s*["']?((?=[^\s"',.;]*\d)[^\s"',.;]{4,})/gid, group: 1 },
  // WP-SEC2 (K4): hex (≥ 32) og base64 (≥ 32, blandet bruk av store/små bokstaver og sifre) KUN rett etter et hemmelighetsord («the signing secret is …», «key: …», «nøkkel …»). Frittstående hex/base64 røres ikke (hasher/digester/trace-id-er).
  // Fiks-runde 1 (A-M3): også norske BESTEMTE/SAMMENSATTE former («nøkkelen min er …», «tokenet er …», «hemmeligheten: …», «API-nøkkelen: …», «signeringsnøkkelen er …», «nøkler: …») - derfor uten venstre `\b` (sammensetninger) og med
  // valgfritt suffiks. UTEN lat venstre-prefiks: en variant med `{0,20}?` felte K6-ytelsestesten (3,6 s).
  { kind: "secret_blob", re: /(?:secret|key|token|password|passwd|passord|credential|hmac|salt|pepper|signature|seed|nøkkel|nøkl(?:er|ene)|hemmelighet)(?:s|en|et|er|ene)?\b(?:[ \t]{1,3}(?:min|mi|mitt|di|ditt|din|vår|my|our))?[ \t]{0,8}(?:(?:is|er|=>|[:=-])[ \t]{0,8})?["'`]?([0-9A-Fa-f]{32,}|[A-Za-z0-9+/_-]{32,}={0,2})(?![A-Za-z0-9+/_=-])/gid, group: 1, skip: blobSkip }
];

/** Dedikert kortnummerpass (Luhn) - kjøres sist. Regelen er IKKE utvidet i WP-SEC2 (kun innsnevret: en UUID er aldri et kortnummer, se `insideUuid`). */
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const isHexOrHyphen = (c: number): boolean => c === 0x2d || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

/**
 * Et siffertreff som ligger inne i en UUID (`fin-pi-47015187-4988-4107-9302-…`) er ingen kortnummer: de første gruppene i en UUID kan bestå bare av sifre og (10 % av gangene) bestå Luhn. WP-SEC2 skanner mer tekst enn før
 * (feilårsaker i ledger/audit), og en UUID-id i en `tool_failed:possible_duplicate_of:<id>`-grunn ble tilfeldig til `[REDACTED:card_number]` (oppdaget av `modules/finance/test/wpf1-review-fixes.test.ts`).
 * Fiks-runde 1 (review B, M2): UUID-treffet må OVERLAPPE siffer-kandidaten. En UUID et sted i nabolaget (`kort 4111 1111 1111 1111 <uuid>`, `4111111111111111-<uuid>`, `<uuid>-4111111111111111`) gjør ikke kortet til en del av UUID-en.
 */
function insideUuid(text: string, start: number, end: number): boolean {
  let a = start;
  while (a > 0 && start - a < 40 && isHexOrHyphen(text.charCodeAt(a - 1))) a -= 1;
  let b = end;
  while (b < text.length && b - end < 40 && isHexOrHyphen(text.charCodeAt(b))) b += 1;
  for (const m of text.slice(a, b).matchAll(UUID_SHAPE)) {
    const us = a + (m.index ?? 0);
    if (us < end && us + m[0].length > start) return true;
  }
  return false;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const KIND_IDS: ReadonlyMap<string, number> = (() => {
  const ids = new Map<string, number>();
  for (const p of PATTERNS) if (!ids.has(p.kind)) ids.set(p.kind, ids.size + 1);
  ids.set("card_number", ids.size + 1);
  return ids;
})();
const KIND_ORDER: ReadonlyMap<string, number> = (() => {
  const order = new Map<string, number>();
  PATTERNS.forEach((p, i) => { if (!order.has(p.kind)) order.set(p.kind, i); });
  order.set("card_number", PATTERNS.length);
  return order;
})();

// ---------------------------------------------------------------------------------------------------------------------
// Klemt visning (K2a): prefiks-forankrede regler som «vandrer» over blanke mellom token-tegn
// ---------------------------------------------------------------------------------------------------------------------

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isUpper = (c: number): boolean => c >= 0x41 && c <= 0x5a;
const isAlnum = (c: number): boolean => isDigit(c) || isUpper(c) || (c >= 0x61 && c <= 0x7a);
const isAlnumUnderscore = (c: number): boolean => isAlnum(c) || c === 0x5f;
const isAlnumDash = (c: number): boolean => isAlnum(c) || c === 0x2d;
const isAlnumDashUnderscore = (c: number): boolean => isAlnum(c) || c === 0x2d || c === 0x5f;
const isAlnumDashUnderscoreDot = (c: number): boolean => isAlnumDashUnderscore(c) || c === 0x2e;
const isUpperDigit = (c: number): boolean => isDigit(c) || isUpper(c);

interface SqueezeRule {
  readonly kind: string;
  readonly prefix: RegExp;
  readonly body: (c: number) => boolean;
  /** Minste kropp (tegn etter prefikset) for å godta et treff. */
  readonly min: number;
  readonly max: number;
  /**
   * FAST kroppslengde (`unverified`: ghp_ = 36, github_pat_ = 82, AKIA/ASIA = 16, npm_ = 36). Et delt token godtas KUN når den sammenslåtte kroppen er EKSAKT `fixed` tegn (aldri over): prosa etter et token som er ferdig, eller et
   * prefiks nevnt i en setning, gir da (nesten) aldri et treff. Et delt token av ikke-standard lengde fanges derfor ikke av klemt visning (det som står sammenhengende fanges fortsatt av det ordinære mønsteret): kjent gap.
   * Uten `fixed` (variable formater) krysses en blank-rekke kun mens kroppen er kortere enn `min` og neste fragment er langt (minst 8 tegn) eller ser ut som en token-hale (siffer/store bokstaver midt i), eller når kroppen allerede
   * er `min` eller lengre og fragmentet ser ut som en token-hale.
   */
  readonly fixed?: number;
  /** JWT: tre deler adskilt av punktum; en blank-rekke krysses også mens strukturen er ufullstendig (færre enn to punktum, eller en signatur under 8 tegn). */
  readonly jwt?: boolean;
  /** Treffet skal ikke ende midt i et fragment (AKIA har eksakt lengde). */
  readonly strictEnd?: boolean;
  /** JWT: sluttsjekk av strukturen mot dette mønsteret. */
  readonly validate?: RegExp;
}

/** Høyst så mange blank-rekker krysses i ett treff. */
const SQUEEZE_MAX_GAPS = 8;

const tokenTail = (fragment: string): boolean => /\d/.test(fragment) || /[A-Z]/.test(fragment.slice(1));

const SQUEEZE_RULES: ReadonlyArray<SqueezeRule> = [
  { kind: "jwt", prefix: /eyJ/g, body: isAlnumDashUnderscoreDot, min: 29, max: 4096, jwt: true, validate: /^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: "github_token", prefix: /gh[pousr]_/g, body: isAlnum, min: 20, max: 36, fixed: 36 },
  { kind: "github_token", prefix: /github_pat_/g, body: isAlnumUnderscore, min: 20, max: 82, fixed: 82 },
  { kind: "anthropic_key", prefix: /sk-ant-/g, body: isAlnumDashUnderscore, min: 10, max: 400 },
  { kind: "openai_key", prefix: /sk-(?:proj-)?/g, body: isAlnumDashUnderscore, min: 20, max: 400 },
  { kind: "slack_token", prefix: /xox[abprs]-/g, body: isAlnumDash, min: 10, max: 160 },
  { kind: "aws_access_key", prefix: /AKIA|ASIA/g, body: isUpperDigit, min: 16, max: 16, fixed: 16, strictEnd: true },
  { kind: "sendgrid_key", prefix: /SG\./g, body: isAlnumDashUnderscoreDot, min: 33, max: 120 },
  { kind: "npm_token", prefix: /npm_/g, body: isAlnum, min: 30, max: 36, fixed: 36 },
  { kind: "gitlab_token", prefix: /gl(?:pat|dt|rt|ptt|ft|imt|agent|cbt|soat|oas)-/g, body: isAlnumDashUnderscore, min: 20, max: 120 },
  { kind: "huggingface_token", prefix: /hf_/g, body: isAlnum, min: 30, max: 80 },
  // Fiks-runde 1 (A-L5): resten av token-familiene med et fast prefiks. `unverified` (lengdene: sk_live_ ≥ 16, whsec_ ≥ 16, xapp-<n>- ≥ 20, AIza = 35, telegram <8-10 siffer>:<35>, enr_ ≥ 30, ya29. ≥ 20).
  { kind: "stripe_key", prefix: /(?:sk|rk|pk)_(?:live|test)_/g, body: isAlnum, min: 16, max: 100 },
  { kind: "stripe_key", prefix: /whsec_/g, body: isAlnum, min: 16, max: 100 },
  { kind: "slack_app_token", prefix: /xapp-\d-/g, body: isAlnumDash, min: 20, max: 200 },
  { kind: "google_api_key", prefix: /AIza/g, body: isAlnumDashUnderscore, min: 35, max: 35, fixed: 35, strictEnd: true },
  { kind: "telegram_bot_token", prefix: /\d{8,10}:/g, body: isAlnumDashUnderscore, min: 35, max: 35, fixed: 35, strictEnd: true },
  { kind: "enrollment_ticket", prefix: /enr_/g, body: isAlnumDashUnderscore, min: 30, max: 200 },
  { kind: "google_oauth_token", prefix: /ya29\./g, body: isAlnumDashUnderscore, min: 20, max: 400 }
];
const SQUEEZE_LOOSE_PREFIX = /g\s*h\s*[pousr]\s*_|g\s*i\s*t\s*h\s*u\s*b\s*_\s*p\s*a\s*t|s\s*k\s*-|x\s*o\s*x|A\s*K\s*I\s*A|A\s*S\s*I\s*A|e\s*y\s*J|-----\s*B\s*E\s*G\s*I\s*N|S\s*G\s*\.|n\s*p\s*m\s*_|g\s*l\s*[a-z]{2,5}\s*-|h\s*f\s*_|[spr]\s*k\s*_\s*(?:l\s*i\s*v\s*e|t\s*e\s*s\s*t)\s*_|w\s*h\s*s\s*e\s*c\s*_|x\s*a\s*p\s*p\s*-|A\s*I\s*z\s*a|(?:\d\s*){8}:|e\s*n\s*r\s*_|y\s*a\s*2\s*9\s*\./;
const PEM_SQUEEZED_HEADER = /-----BEGIN[A-Z0-9]*PRIVATEKEY(?:BLOCK)?-----/g;
const BEGIN_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
const END_RE = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;

/** Kortere tekst kan aldri gi treff (korteste regel er ca. 7 tegn). */
const MIN_MATCH_CHARS = 7;

interface WindowState {
  /** Forrige vindu endte inne i en privat nøkkel uten avslutning. */
  openKey: boolean;
  /** Original-indeks der den åpne nøkkelen begynte (BEGIN): ligger den i NESTE vindu også, tar vanlig BEGIN-skanning den, og vinduet starter ikke med en falsk «åpen nøkkel» (A-L2). */
  openAt: number;
}

/**
 * `raw` = identitetsvisning (A-M1): mønstrene kjøres mot RÅ vindustekst, med de ordgrensene den gamle skanneren så. Den normaliserte visningen fjerner skjulte tegn og folder fullbredde/homoglyfer, og da flytter `\b` seg
 * for et token som står inntil slike tegn (`abc<ZWSP>ghp_…`, `AKIA…<ZWSP>abc`, `ｘghp_…`). Er teksten ikke ren ASCII, kjøres derfor mønstrene også mot råteksten, og unionen av spennene brukes.
 */
function scanWindow(source: string, ws: number, we: number, isLast: boolean, state: WindowState, options: SecretScanOptions, out: SecretSpan[], raw = false): void {
  const view: ScanView = raw ? { text: source.slice(ws, we), map: null, base: ws, source } : buildView(source, ws, we);
  const text = view.text;
  const n = text.length;
  if (n < MIN_MATCH_CHARS) return;
  const claimed = new Uint8Array(n);
  let squeezed: Squeezed | null | undefined;
  const getSqueezed = (): Squeezed | null => {
    if (squeezed === undefined) squeezed = SQUEEZE_LOOSE_PREFIX.test(text) ? squeezeView(view) : null;
    return squeezed;
  };

  /**
   * Plasserer et treff og avgjør konflikter mellom typer (samme oppførsel som da mønstrene kjørte etter hverandre på en stadig mer redigert tekst):
   *  - et treff på HELE teksten (ingen gruppe: token-formater) forkastes hvis NOEN av tegnene allerede eies av en ANNEN type (et redigeringsmerke midt i teksten ville ødelagt treffet);
   *  - et treff med gruppe (`NAVN=verdi`, URL-passord ...) forkastes hvis VERDIEN BEGYNNER i et område en annen type eier («allerede redigert»), ellers redigeres hele verdien.
   * Samme type på samme sted (klemt visning, vinduoverlapp) slås sammen til ett spenn av `mergeSecretSpans`.
   */
  const place = (kind: string, redactStart: number, redactEnd: number, wholeMatch: boolean, claimStart: number = redactStart, claimEnd: number = redactEnd): void => {
    const kid = KIND_IDS.get(kind) as number;
    const order = KIND_ORDER.get(kind) as number;
    if (wholeMatch) {
      for (let i = claimStart; i < claimEnd; i += 1) {
        const c = claimed[i] as number;
        if (c !== 0 && c !== kid) return;
      }
    } else {
      const c = claimed[claimStart] as number;
      const r = claimed[redactStart] as number;
      if ((c !== 0 && c !== kid) || (r !== 0 && r !== kid)) return;
    }
    out.push({ start: origStart(view, redactStart), end: origEnd(view, redactEnd - 1), kind, order });
    for (let i = claimStart; i < claimEnd; i += 1) if (claimed[i] === 0) claimed[i] = kid;
  };

  // --- private nøkkelblokk (BEGIN ... END, eller til slutten av vinduet/teksten hvis den ikke avsluttes: fail-closed) ---
  const scanPrivateKeys = (): void => {
    let pos = 0;
    if (state.openKey && state.openAt >= ws) state.openKey = false; // A-L2: BEGIN ligger i DETTE vinduet også; den vanlige BEGIN-skanningen under tar den
    if (state.openKey) {
      state.openKey = false;
      END_RE.lastIndex = 0;
      const e = END_RE.exec(text);
      if (e !== null) {
        place("private_key", 0, e.index + e[0].length, true);
        pos = e.index + e[0].length;
      } else {
        place("private_key", 0, n, true);
        if (!isLast) state.openKey = true;
        return;
      }
    }
    while (pos < n) {
      BEGIN_RE.lastIndex = pos;
      const b = BEGIN_RE.exec(text);
      if (b === null) break;
      const header = b.index + b[0].length;
      END_RE.lastIndex = header;
      const e = END_RE.exec(text);
      if (e !== null) {
        place("private_key", b.index, e.index + e[0].length, true);
        pos = e.index + e[0].length;
        continue;
      }
      if (options.noUnterminatedKey === true) {
        pos = header;
        continue;
      }
      place("private_key", b.index, n, true);
      if (!isLast) {
        state.openKey = true;
        state.openAt = origStart(view, b.index);
      }
      return;
    }
  };

  // --- klemt visning: PEM-header delt over blanke, og de prefiks-forankrede reglene ---
  const squeezePrivateKey = (): void => {
    const sq = getSqueezed();
    if (sq === null) return;
    let doneUntil = 0; // visningsindeks: overskrifter før dette ligger allerede i en plassert blokk (hindrer kvadratisk arbeid på gjentatte BEGIN uten END)
    PEM_SQUEEZED_HEADER.lastIndex = 0;
    for (let m = PEM_SQUEEZED_HEADER.exec(sq.text); m !== null; m = PEM_SQUEEZED_HEADER.exec(sq.text)) {
      const ps = m.index;
      const pe = ps + m[0].length;
      const vs = sq.map[ps] as number;
      if (vs < doneUntil) continue;
      let gaps = 0;
      for (let k = ps + 1; k < pe; k += 1) gaps += sq.gap[k] as number;
      if (gaps === 0 || (vs > 0 && isWordChar(text.charCodeAt(vs - 1)))) continue;
      const header = (sq.map[pe - 1] as number) + 1;
      END_RE.lastIndex = header;
      const e = END_RE.exec(text);
      if (e !== null) {
        place("private_key", vs, e.index + e[0].length, true);
        doneUntil = e.index + e[0].length;
        continue;
      }
      if (options.noUnterminatedKey === true) {
        doneUntil = header;
        continue;
      }
      place("private_key", vs, n, true);
      if (!isLast) {
        state.openKey = true;
        state.openAt = origStart(view, vs);
      }
      return;
    }
  };
  const squeezeKind = (kind: string): void => {
    const sq = getSqueezed();
    if (sq === null) return;
    for (const rule of SQUEEZE_RULES) {
      if (rule.kind !== kind) continue;
      const t = sq.text;
      rule.prefix.lastIndex = 0;
      for (let m = rule.prefix.exec(t); m !== null; m = rule.prefix.exec(t)) {
        const ps = m.index;
        const pe = ps + m[0].length;
        const vs = sq.map[ps] as number;
        if (vs > 0 && isWordChar(text.charCodeAt(vs - 1))) continue; // prefikset henger sammen med et ord foran det
        let gaps = 0;
        for (let k = ps + 1; k < pe; k += 1) gaps += sq.gap[k] as number;
        // Et token skrevet med mellomrom mellom HVERT tegn («g h p _ x x x»): etter to enkelttegn-fragmenter i rad krysses enkelttegn-fragmenter så lenge kroppen får plass.
        let tinyRun = gaps >= 2 ? gaps : 0;
        let bigGaps = 0;
        let j = pe;
        let body = 0;
        let dots = 0;
        let sig = 0;
        while (j < t.length && body < rule.max) {
          const code = t.charCodeAt(j);
          if (!rule.body(code)) break;
          if (sq.gap[j] === 1) {
            if (bigGaps >= SQUEEZE_MAX_GAPS) break;
            let k = j;
            while (k < t.length && k - j < rule.max && rule.body(t.charCodeAt(k)) && (k === j || sq.gap[k] === 0)) k += 1;
            const fragLen = k - j;
            let cross: boolean;
            if (rule.fixed !== undefined) cross = body + fragLen <= rule.fixed;
            else if (fragLen === 1 && tinyRun >= 2) cross = body + 1 <= rule.max;
            else if (rule.jwt === true) cross = body + fragLen <= rule.max && (dots < 2 || sig < 8 || tokenTail(t.slice(j, k)));
            else cross = body + fragLen <= rule.max && (body < rule.min ? fragLen >= 8 || tokenTail(t.slice(j, k)) : tokenTail(t.slice(j, k)));
            if (!cross) break;
            gaps += 1;
            if (fragLen === 1) tinyRun += 1;
            else {
              tinyRun = 0;
              bigGaps += 1;
            }
          }
          if (code === 0x2e) {
            dots += 1;
            sig = 0;
          } else if (dots >= 2) sig += 1;
          j += 1;
          body += 1;
        }
        if (gaps === 0 || body < rule.min) continue;
        if (rule.fixed !== undefined && body !== rule.fixed) continue;
        if (rule.strictEnd === true && j < t.length && rule.body(t.charCodeAt(j)) && sq.gap[j] === 0) continue;
        let end = j;
        if (rule.validate !== undefined) {
          const v = rule.validate.exec(t.slice(ps, j));
          if (v === null) continue;
          end = ps + v[0].length;
        }
        place(kind, vs, (sq.map[end - 1] as number) + 1, true);
        rule.prefix.lastIndex = Math.max(end, ps + 1);
      }
    }
  };

  const squeezedKinds = new Set(SQUEEZE_RULES.map((r) => r.kind));
  if (!raw) {
    scanPrivateKeys();
    squeezePrivateKey();
  }

  for (let p = 0; p < PATTERNS.length; p += 1) {
    const def = PATTERNS[p] as PatternDef;
    if (def.special !== undefined) continue;
    // De prefiks-forankrede reglene for en type kjøres rett ETTER siste ordinære mønster av den typen (prioritet).
    const next = PATTERNS[p + 1];
    const re = def.re as RegExp;
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (def.skip !== undefined && def.skip(m)) {
        if (def.resumeAfterSkip !== undefined) re.lastIndex = Math.max(m.index + 1, Math.min(re.lastIndex, def.resumeAfterSkip(m)));
        if (def.claimOnSkip === true && def.claim !== undefined) {
          const c = m.indices?.[def.claim];
          if (c !== undefined) {
            const kid = KIND_IDS.get(def.kind) as number;
            for (let i = c[0]; i < c[1]; i += 1) if (claimed[i] === 0) claimed[i] = kid;
          }
        }
        continue;
      }
      if (def.group === undefined) {
        place(def.kind, m.index, m.index + m[0].length, true);
        continue;
      }
      const g = m.indices?.[def.group];
      if (g === undefined) continue;
      if (text.startsWith("[REDACTED", g[0])) continue; // allerede redigert (idempotent)
      const c = def.claim === undefined ? undefined : m.indices?.[def.claim];
      place(def.kind, g[0], g[1], false, c === undefined ? g[0] : c[0], c === undefined ? g[1] : c[1]);
    }
    if (squeezedKinds.has(def.kind) && (next === undefined || next.kind !== def.kind)) squeezeKind(def.kind);
  }

  // Kortnumre: 13-19 sifre (med mellomrom/bindestrek) som består Luhn.
  CARD_RE.lastIndex = 0;
  for (let m = CARD_RE.exec(text); m !== null; m = CARD_RE.exec(text)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) continue;
    if (insideUuid(text, m.index, m.index + m[0].length)) continue;
    place("card_number", m.index, m.index + m[0].length, true);
  }
  // A-M1: ikke-ASCII tekst får ett pass til mot råteksten (se `scanWindow`-kommentaren); spennene er i originalkoordinater i begge passene.
  if (!raw && view.map !== null) scanWindow(source, ws, we, isLast, { openKey: false, openAt: 0 }, options, out, true);
}

/** Alle funn i `input`, i originalens koordinater (ikke slått sammen). Vinduer og overlapp: se `SCAN_WINDOW_CHARS`/`SCAN_OVERLAP_CHARS`. */
export function scanSecretSpans(input: string, options: SecretScanOptions = {}): SecretSpan[] {
  const out: SecretSpan[] = [];
  const length = input.length;
  if (length < MIN_MATCH_CHARS) return out;
  const state: WindowState = { openKey: false, openAt: 0 };
  if (length <= SCAN_WINDOW_CHARS) {
    scanWindow(input, 0, length, true, state, options, out);
    return out;
  }
  const starts = windowStarts(input, length);
  for (let w = 0; w < starts.length; w += 1) {
    const ws = starts[w] as number;
    const we = Math.min(length, ws + SCAN_WINDOW_CHARS);
    scanWindow(input, ws, we, we >= length, state, options, out);
  }
  return out;
}

/** Slår sammen overlappende spenn (samme type også når de bare tangerer) og beholder typen med høyest prioritet. */
export function mergeSecretSpans(spans: readonly SecretSpan[]): SecretSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);
  const merged: SecretSpan[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && (s.start < last.end || (s.start === last.end && s.kind === last.kind))) {
      if (s.end > last.end) last.end = s.end;
      if (s.order < last.order) {
        last.kind = s.kind;
        last.order = s.order;
      }
    } else merged.push({ ...s });
  }
  return merged;
}

/** Bytter hvert (sammenslått) spenn i `input` med `[REDACTED:<type>]` og teller funn per type (i prioritetsrekkefølge). */
export function applySecretSpans(input: string, spans: readonly SecretSpan[]): SecretScanResult {
  const merged = mergeSecretSpans(spans);
  if (merged.length === 0) return { text: input, findings: [] };
  const parts: string[] = [];
  const counts = new Map<string, { count: number; order: number }>();
  let last = 0;
  for (const s of merged) {
    parts.push(input.slice(last, s.start), `[REDACTED:${s.kind}]`);
    last = s.end;
    const entry = counts.get(s.kind);
    if (entry === undefined) counts.set(s.kind, { count: 1, order: s.order });
    else entry.count += 1;
  }
  parts.push(input.slice(last));
  const findings = [...counts.entries()].sort((a, b) => a[1].order - b[1].order).map(([kind, v]) => ({ kind, count: v.count }));
  return { text: parts.join(""), findings };
}

export function scanForSecrets(input: string): SecretScanResult {
  const spans = scanSecretSpans(input);
  return spans.length === 0 ? { text: input, findings: [] } : applySecretSpans(input, spans);
}

export function containsSecret(input: string): boolean {
  return scanForSecrets(input).findings.length > 0;
}

/** Kort, menneskelig beskrivelse av funnene (kun typer - aldri verdier). */
export function describeSecretFindings(findings: SecretFinding[]): string {
  return findings.map((f) => (f.count > 1 ? `${f.kind} ×${f.count}` : f.kind)).join(", ");
}

/**
 * WP-SEC2 (K7b): «skann FØRST, kutt etterpå». Kuttes en tekst før skanning, kan en hemmelighet som krysser kuttgrensen bli igjen som et halvt token som ikke lenger matcher noe mønster. Alle steder som lagrer eller viser en
 * tekst kuttet til en grense bruker denne (eller skanner hele teksten selv).
 */
export function clipRedacted(text: string, max: number): string {
  return scanForSecrets(text).text.slice(0, Math.max(0, max));
}

/**
 * WP-SEC2 (K7d): ÉN felles loggredaksjon for driftstekst (`incidents/redact.ts` og `tool-gateway/docker-transport.ts` hadde hver sin kopi av disse mønstrene). De lokale formene (`Bearer <hva som helst>`, hele
 * `Authorization:`-linjen, `NAVN=verdi` der navnet har TOKEN/KEY/SECRET/PASSWORD/PASSWD/CREDENTIAL) er bevart, og resultatet går alltid gjennom sentralen til slutt - så redaksjonen er aldri svakere enn `scanForSecrets`.
 * Navneprefikset/-suffikset er BEGRENSET (`{0,64}`, som i sentralen): uten tak er `[A-Z0-9_]*` + nøkkelord kvadratisk på lange løper.
 */
const LOG_LOCAL_PATTERNS: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  { re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: "Bearer [REDACTED]" },
  { re: /Authorization:\s*.*/gi, replacement: "Authorization: [REDACTED]" },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { re: /sk-ant-[A-Za-z0-9\-_]{10,}/g, replacement: "[REDACTED_ANTHROPIC_KEY]" },
  { re: /((?:[A-Z0-9_]{0,64}(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]{0,64})\s*[:=]\s*)(\S+)/gi, replacement: "$1[REDACTED]" }
];

export function redactLogText(text: string): string {
  let result = text;
  for (const { re, replacement } of LOG_LOCAL_PATTERNS) result = result.replace(re, replacement);
  return scanForSecrets(result).text;
}

// eslint-disable-next-line no-control-regex -- kontrolltegn i en loggmelding er nettopp det som skal bort
const LOG_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
/**
 * Øvre grense for hvor mye av en loggverdi som skannes. Fiks-runde 1 (review B, L3): 64 KB var for lavt - et token bak en stor skjult blokk (`[REDACTED:private_key] ghp_…`) ble kuttet midt i, og et halvt token sto igjen i utdata. 8 MiB er det
 * største en transport leverer (docker-logger: 8 MB per linje), så i praksis skannes ALT FØR kuttet; skanningen er lineær (vinduer), så arbeidet er likevel begrenset. Over taket gjelder kutt-før-skann fortsatt (kjent, dokumentert grense).
 */
const LOG_SCAN_MAX_CHARS = 8 * 1024 * 1024;

/**
 * WP-SEC2 (K7c): felles redaksjon for FEILTEKST/loggmeldinger som kan komme fra en leverandør/HTTP/underprosess (`console.error(...)` med `err.message`). Tar en `Error`, en streng eller en hvilken som helst verdi;
 * skanner for hemmeligheter FØRST (på inntil `LOG_SCAN_MAX_CHARS`), fjerner kontrolltegn (én linje, ingen logginjeksjon) og kutter SIST til `max` tegn. Aldri en kastet feil.
 */
export function redactForLog(value: unknown, max = 300): string {
  let text: string;
  try {
    if (value instanceof Error) text = `${value.name}: ${value.message}`;
    else if (typeof value === "string") text = value;
    else text = JSON.stringify(value) ?? String(value);
  } catch {
    text = "[uleselig verdi]";
  }
  const scanned = scanForSecrets(text.length > LOG_SCAN_MAX_CHARS ? text.slice(0, LOG_SCAN_MAX_CHARS) : text).text;
  return scanned.replace(LOG_CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, Math.max(0, max));
}
