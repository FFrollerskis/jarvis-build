/**
 * WP-SEC2 (JARVIS-013/069, K3): NØKKELNAVN-bevisst redaksjon. Når NØKKELEN i en struktur eller en JSON-tekst ligner en hemmelighet (`password`, `passord`, `api_key`, `client_secret`, `Authorization` ...),
 * er VERDIEN en hemmelighet uansett hvordan den ser ut - også uten kjent format og uten at noe `NAVN=verdi`-mønster treffer (anførselstegn mellom navn og kolon gjør at tekstmønsteret ikke ser det).
 *
 * Navnet normaliseres først: camelCase deles (`apiKey` -> `api_key`), store/små bokstaver og understrek/bindestrek/punktum/mellomrom likestilles, og navnet deles i ORD. En nøkkel er hemmelig når et
 * ord er et hemmelighetsord i ENTALL (`password`, `secret`, `token`, ...), når to nabo-ord danner et sammensatt nøkkelnavn (`api` + `key`, `private` + `key`, ...) eller når ett sammenskrevet ord ender på
 * `secret`/`token`/`password` (`accesstoken`). MEN: en nøkkel som ender på et teller-/metadataord (`token_count`, `passwords_checked`, `token_type`, `expires_at`, `secret_name`, `*_hash` ...) er IKKE en
 * hemmelighet - verdien er et tall, en type, et tidspunkt eller en referanse. Flertallsformer (`tokens`, `passwords`) er aldri hemmelighetsord alene: `input_tokens`/`max_tokens` er tellere.
 *
 * Fiks-runde 1 (review A, L6/L9): bekreftelses-/gjentakelsesord (`password_confirmation`, `passwordConfirm`), sifferendelser (`password1`), `secret_key_base`, `recovery_code`, `ssh_key`/`deploy_key`, `cvv`/`cvc`, hemmelige URL-er
 * (`webhook_url`, `signed_url`), norsk `nøkkel`, og `authorization_header`/`auth_header` (verdien `Basic …` er en hemmelighet; selve headernavnet «X-Api-Key» er det ikke). Paginerings-tokens (`nextPageToken`, `page_token`) er IKKE hemmeligheter.
 * BEVISST utelatt: `session_id`/`user_id`/`request_id` og andre id-er UTEN hemmelighetsord. Id-ene står overalt i Jarvis' egne audit-/ledger-nyttelaster (kobling og sporbarhet), og en sesjons-id er en referanse, ikke
 * legitimasjonen (sesjonshemmeligheten heter `session_token`/`session_secret`/`session_key`, som er dekket). `primary_key`/`sort_key`/`cache_key`/`idempotency_key` er heller ikke hemmelige.
 *
 * Alt her er håndvalgt og `unverified` mot leverandørenes egne feltnavn (ingen offisiell navneliste finnes); kjente gap står i docs/runbooks/WPSEC2_SECRET_SCAN.md.
 */

export interface KeyClass {
  /** Verdien under denne nøkkelen er en hemmelighet (og nøkkelen er ikke et teller-/metadatanavn). */
  readonly secret: boolean;
  /** Sterk hemmelighet: også et TALL under nøkkelen redigeres (passord/PIN/privat nøkkel/API-nøkkel; ikke `token`, som ofte er en teller). */
  readonly strong: boolean;
  /** Nøkkelen inneholder et hemmelighetsord, men er et trygt teller-/metadatanavn (`token_count`, `expires_at`, `secret_name`). */
  readonly safe: boolean;
  /** Nøkkelens SISTE ord er et teller-/metadataord (`type`, `name`, `id`, `count`, `at` ...) - uavhengig av om den inneholder et hemmelighetsord. Brukes under en hemmelig forelder: `{"credentials":{"type":"oauth","access_token":"…"}}` beholder `type`. */
  readonly metadata: boolean;
  /** Siste ord er `token`: verdien kan være tekst med blanke (en LLM-token i en strøm: `{"token":" world"}`), ikke legitimasjon. Gjelder IKKE `cookie`/`authorization`/`auth` (`sid=x; Path=/` og `Bearer x` har blanke). */
  readonly proseOk: boolean;
  /** `authorization_header`/`auth_header`: verdien er en hemmelighet BARE når den er en credential med skjema (`Basic …`, `Bearer …`); `X-Api-Key` (et headernavn) og plassholdere er det ikke. */
  readonly authHeader: boolean;
}

const SECRET_WORDS: ReadonlySet<string> = new Set([
  "password", "passwd", "pwd", "passord", "passphrase", "kodeord", "hemmelighet", "secret", "token", "credential", "credentials", "cookie", "authorization", "bearer", "jwt", "otp", "pin", "auth", "cvv", "cvc",
  "apikey", "privatekey", "secretkey", "accesskey", "signingkey", "encryptionkey", "masterkey"
]);
const STRONG_WORDS: ReadonlySet<string> = new Set(["password", "passwd", "pwd", "passord", "passphrase", "kodeord", "hemmelighet", "secret", "pin", "otp", "cvv", "cvc", "apikey", "privatekey", "secretkey", "accesskey", "signingkey", "encryptionkey", "masterkey"]);
/** `<x>_key` er en hemmelig nøkkel når `<x>` er et av disse (`id_key`, `cache_key`, `primary_key`, `sort_key` er det IKKE). Norsk `nøkkel` er også her (`api_nøkkel`, `privat_nøkkel`). */
const KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  "api", "private", "secret", "access", "signing", "encryption", "master", "license", "auth", "service", "session", "hmac", "webhook", "client", "shared", "bearer", "ssh", "deploy", "gpg", "pgp",
  "privat", "hemmelig", "signering", "signerings", "kryptering", "krypterings", "tilgang", "tilgangs", "lisens", "hoved", "klient", "delt", "tjeneste", "sesjon", "sesjons"
]);
/** `<x>_nøkkel` er IKKE hemmelig for disse (databasenøkler, sorterings-/cache-nøkler), selv om bare `nøkkel` er det (norsk `nøkkel` ≈ legitimasjon i denne konteksten). */
const NON_SECRET_NOR_KEY_QUALIFIERS: ReadonlySet<string> = new Set(["primær", "primar", "fremmed", "sorterings", "sortering", "sort", "cache", "partisjons", "partisjon", "unik", "id", "primary", "foreign", "idempotens", "idempotency"]);
const NOR_KEY_WORDS: ReadonlySet<string> = new Set(["nøkkel", "nøkler", "nøkkelen", "nøklene"]);
const NON_SECRET_NOR_COMPOUND = /^(?:primær|primar|fremmed|sorterings?|sort|cache|partisjons?|unik|id)nøkkel$/;
/** `<hemmelighetsord>_<bekreftelse>` (`password_confirmation`, `passwordConfirm`, `password_again`) er en gjentakelse av hemmeligheten. */
const CONFIRM_WORDS: ReadonlySet<string> = new Set(["confirmation", "confirm", "repeat", "again", "verify", "retype"]);
/** Gjenopprettingskoder og -nøkler (de to siste ordene): hver for seg er `recovery`/`backup` vanlige ord, sammen er de legitimasjon. */
const RECOVERY_SECRET_TAILS: ReadonlySet<string> = new Set(["recovery code", "recovery codes", "recovery key", "recovery keys", "recovery phrase", "recovery seed", "backup code", "backup codes"]);
/** `<x>_url` er en hemmelig URL (hemmeligheten står i selve adressen) når `<x>` er et av disse; `callback_url`/`image_url` er det ikke. */
const SECRET_URL_QUALIFIERS: ReadonlySet<string> = new Set(["webhook", "hook", "signed", "presigned", "secret", "private"]);
/** `<x>_token` er en paginerings-/synkroniseringsmarkør, ikke legitimasjon, når `<x>` er et av disse (`nextPageToken`, `page_token`, `next_token`, `continuation_token`). */
const PAGINATION_QUALIFIERS: ReadonlySet<string> = new Set(["page", "next", "prev", "previous", "continuation", "pagination", "cursor", "sync"]);
/** Hemmelighetsord som kan ha en sifferendelse (`password1`, `password2`, `cvv2`, `pin1`): ikke `auth0` (et produktnavn). */
const DIGIT_SUFFIX_WORDS: ReadonlySet<string> = new Set(["password", "passwd", "pwd", "passord", "passphrase", "secret", "token", "kodeord", "cvv", "pin", "otp"]);
const SAFE_LAST_WORDS: ReadonlySet<string> = new Set([
  "count", "counts", "checked", "at", "type", "length", "len", "size", "total", "required", "enabled", "disabled", "set", "present", "ttl", "expires", "expiry", "expiration", "version", "status", "name", "names", "ref",
  "refs", "id", "ids", "kind", "source", "provider", "scope", "scopes", "hint", "last4", "algorithm", "alg", "format", "policy", "mode", "min", "max", "limit", "rate", "hash", "digest", "fingerprint", "url", "uri", "endpoint",
  "path", "file", "header", "placeholder", "label", "description", "created", "updated", "expired", "revoked", "valid", "state", "present", "configured", "exists", "available", "verified", "used", "remaining"
]);

/** Ordene i et nøkkelnavn (camelCase delt, små bokstaver, alt som ikke er bokstav/tall er skille). */
export function keyWords(rawKey: string): string[] {
  const spaced = rawKey.slice(0, 120).replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2");
  return spaced.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/** Ord som bare sier «dette ER verdien» (`token_value`, `private_key_pem`, `pin_code`, `secret_key_base`): strippes bakfra før nøkkelen vurderes. */
const VALUE_WORDS: ReadonlySet<string> = new Set(["value", "text", "string", "plain", "raw", "data", "content", "pem", "hex", "base64", "b64", "code", "base"]);

/** `password1` -> `password` (kun for ord i `DIGIT_SUFFIX_WORDS`). */
function baseWord(word: string): string {
  const m = /^(\p{L}+?)\d{1,2}$/u.exec(word);
  return m !== null && DIGIT_SUFFIX_WORDS.has(m[1] as string) ? (m[1] as string) : word;
}

const NOT_SECRET: KeyClass = { secret: false, strong: false, safe: false, metadata: false, proseOk: false, authHeader: false };

/**
 * En nøkkel er en hemmelighet når det siste (meningsbærende) ordet SELV er et hemmelighetsord: `db_password`, `client_secret`, `access_token`, `x-api-key`, `Authorization`, `private_key_pem`. En nøkkel der hemmelighetsordet står
 * foran noe annet beskriver noe RELATERT til hemmeligheten, ikke selve verdien (`credential_binding: "owner_bound"`, `secret_manager`, `token_endpoint`, `password_reset_url`) og redigeres ikke - ellers ville enum- og
 * metadatafelt (og connector-manifester) bli ødelagt. Teller-/metadatanøkler (`token_count`, `expires_at`, `secret_name` ...) er trygge uansett.
 */
export function classifyKey(rawKey: string): KeyClass {
  const words = keyWords(rawKey);
  if (words.length === 0) return NOT_SECRET;
  const lastWord = words[words.length - 1] as string;
  const metadata = SAFE_LAST_WORDS.has(lastWord);
  const authHeader = lastWord === "header" && words.slice(0, -1).some((w) => w === "authorization" || w === "auth");
  const hasSecretWord = words.some((w) => SECRET_WORDS.has(baseWord(w)) || (w.length > 5 && /(?:secret|token|password|passwd|credential)$/.test(w)));
  const tail2 = words.length >= 2 ? `${words[words.length - 2] as string} ${lastWord}` : "";
  // gjenopprettingskoder (`recovery_code`: «code» strippes under som verdiord, så dette må sjekkes FØR strippingen)
  if (RECOVERY_SECRET_TAILS.has(tail2)) return { secret: true, strong: true, safe: false, metadata: false, proseOk: false, authHeader: false };
  // hemmelige URL-er (`webhook_url`, `signed_url`): «url» er ellers et metadataord
  if ((lastWord === "url" || lastWord === "uri") && words.length >= 2 && SECRET_URL_QUALIFIERS.has(words[words.length - 2] as string)) return { secret: true, strong: false, safe: false, metadata: false, proseOk: false, authHeader: false };
  let end = words.length;
  while (end > 1 && VALUE_WORDS.has(words[end - 1] as string)) end -= 1;
  const last = baseWord(words[end - 1] as string);
  const prev = end >= 2 ? baseWord(words[end - 2] as string) : "";
  // paginerings-/synkroniseringsmarkører er ikke legitimasjon
  if (last === "token" && PAGINATION_QUALIFIERS.has(prev)) return { secret: false, strong: false, safe: true, metadata, proseOk: false, authHeader: false };
  let secret = false;
  let strong = false;
  if (SECRET_WORDS.has(last)) {
    secret = true;
    strong = STRONG_WORDS.has(last);
  } else if (CONFIRM_WORDS.has(last) && SECRET_WORDS.has(prev)) {
    secret = true;
    strong = STRONG_WORDS.has(prev);
  } else if (last.length > 5 && /(?:secret|token|password|passwd|credential)$/.test(last)) {
    // sammenskrevet: `accesstoken`, `clientsecret`, `mypassword` (men ikke `tokenizer`, `secretary`)
    secret = true;
    strong = !/token$/.test(last);
  } else if (last.length > 6 && /nøkkel$/.test(last) && !NON_SECRET_NOR_COMPOUND.test(last)) {
    // sammenskrevet norsk: `apinøkkel`, `signeringsnøkkel` (men ikke `primærnøkkel`, `fremmednøkkel`)
    secret = true;
    strong = true;
  } else if (last === "key" && KEY_QUALIFIERS.has(prev)) {
    secret = true;
    strong = true;
  } else if (NOR_KEY_WORDS.has(last) && !NON_SECRET_NOR_KEY_QUALIFIERS.has(prev)) {
    // norsk `nøkkel`: `api_nøkkel`/`privat_nøkkel` er sterke; bare `nøkkel` (eller med et ukjent forledd) er en hemmelighet, men ikke sterk (korte verdier og tall røres ikke)
    secret = true;
    strong = KEY_QUALIFIERS.has(prev);
  }
  const proseOk = last === "token";
  if (!secret) return { secret: false, strong: false, safe: hasSecretWord && metadata, metadata, proseOk: false, authHeader };
  return metadata ? { secret: false, strong: false, safe: true, metadata, proseOk: false, authHeader } : { secret: true, strong, safe: false, metadata, proseOk, authHeader: false };
}

/** Tekstformen `"navn": "verdi"`: skal verdien redigeres? */
export function isSecretKeyName(rawKey: string): boolean {
  return classifyKey(rawKey).secret;
}

// ---------------------------------------------------------------------------------------------------------------------
// Verdi-hjelpere (fiks-runde 1, A-L7/A-L9): plassholdere og statusverdier. Listene er med vilje SMÅ og STRENGE: hele verdien må være en av dem.
// ---------------------------------------------------------------------------------------------------------------------

/** Statusord (hele verdien, uavhengig av store/små bokstaver): «passordet er påkrevd», ikke selve passordet. En ekte hemmelighet som bare ligner («required123!») redigeres fortsatt. */
const STATUS_WORDS: ReadonlySet<string> = new Set([
  "required", "optional", "accepted", "rejected", "denied", "granted", "enabled", "disabled", "pending", "missing", "present", "unknown", "none", "invalid", "expired", "revoked", "valid", "empty", "hidden", "masked", "redacted",
  "omitted", "removed", "unset", "n/a"
]);
/** Autentiseringsskjema som VERDI under en SVAK nøkkel (`"auth":"oauth2"`, `"auth":"bearer"`): skjemaets navn, ikke legitimasjonen. Under sterke nøkler (passord/PIN) er dette ordene fortsatt hemmeligheter. */
const SCHEME_WORDS: ReadonlySet<string> = new Set(["oauth", "oauth1", "oauth2", "bearer", "basic", "digest", "apikey", "api-key", "api_key", "jwt", "ntlm", "negotiate", "token"]);
/** Reelle plassholdere: `YOUR_API_KEY`, `your-client-secret-here`, `REPLACE_ME`, `…_HERE`, rene `xxx`/`***`. Hele verdien, og kun ENTEN bare store ELLER bare små bokstaver (en blandet kropp er ikke en plassholder). */
const PLACEHOLDER_VALUE = /^(?:YOUR_[A-Z0-9_]{2,40}|your[_-][a-z0-9_-]{2,40}|[A-Z0-9_]{2,40}_HERE|[a-z0-9_-]{2,40}[_-]here|REPLACE[_-]?ME|replace[_-]?me|[xX]{3,}|\*{3,}|\.{3,})$/;

/** Er `value` en statusverdi/plassholder (ikke en hemmelighet) under en nøkkel av klassen `cls`? Kun hele verdien teller. */
export function isBenignSecretValue(value: string, cls: Pick<KeyClass, "strong" | "proseOk">): boolean {
  const lower = value.toLowerCase();
  if (STATUS_WORDS.has(lower) || PLACEHOLDER_VALUE.test(value)) return true;
  if (cls.strong) return false;
  // svak nøkkel (`token`, `auth`, `cookie`): skjemaord (også `oauth2|bearer`) er ikke legitimasjon; under `token` er tekst med blanke (`{"token":" world"}` fra en LLM-strøm) det heller ikke
  if (cls.proseOk && /\s/.test(value)) return true;
  const parts = lower.split("|");
  return parts.every((p) => SCHEME_WORDS.has(p) || STATUS_WORDS.has(p));
}

/** `Basic <credential>`, `Bearer <credential>` ... (skjema + minst 3 tegn). */
const AUTH_CREDENTIAL = /^(?:Basic|Bearer|Digest|Token|ApiKey|Api-Key|Bot|SSWS|NTLM|Negotiate|OAuth|Hawk|JWT)\s+\S{3,}/i;
export function isAuthCredential(value: string): boolean {
  return AUTH_CREDENTIAL.test(value) && !isAuthPlaceholder(value.replace(/^\S+\s+/, ""));
}

/** Ord i en plassholder: bokstaver med høyst to sifre per ord, skilt med blank/understrek/bindestrek/kolon/punktum/skråstrek (`token`, `your token`, `YOUR_ACCESS_TOKEN`, `base64`, `base64-av-bruker:passord`). En tilfeldig kropp (`Zx3Qk9…`) har sifre midt i ordene og er ingen plassholder. */
const PLACEHOLDER_WORDS = /^\p{L}+\d{0,2}(?:[ _.:/+()-]+\p{L}+\d{0,2}){0,8}[ _.:/+()-]*$/u;
/** Navn på en variabel (`TOKEN`, `access_token`, `accessToken`, `token1`): store ELLER små bokstaver (med sifre/understrek), eller bokstaver med høyst to sifre bakerst. En tilfeldig kropp (`Zx3Qk9…`: blandet, sifre midt i) er det ikke. */
const IDENT_NAME = /^(?:[A-Za-z_]+\d{0,2}|[A-Z][A-Z0-9_]*|[a-z][a-z0-9_]*)$/;
const PLACEHOLDER_FORMS: ReadonlyArray<{ re: RegExp; check: (inner: string) => boolean }> = [
  { re: /^<([^<>\r\n]{1,48})>/, check: (s) => PLACEHOLDER_WORDS.test(s) },
  { re: /^\{\{\s*([^{}\r\n]{1,48}?)\s*\}\}/, check: (s) => PLACEHOLDER_WORDS.test(s) || IDENT_NAME.test(s) },
  { re: /^\$\{([^{}\r\n]{1,60})\}/, check: (s) => IDENT_NAME.test(s) || /[^A-Za-z0-9_]/.test(s) }, // `${TOKEN}`, `${req.bearer}`, `${b.credentialCanary()}` (en malmal-/variabelreferanse); en ren tilfeldig kropp (`${Zx3Qk9…}`) er ikke det
  { re: /^\{([^{}\r\n]{1,48})\}/, check: (s) => PLACEHOLDER_WORDS.test(s) || IDENT_NAME.test(s) },
  { re: /^\[([^[\]\r\n]{1,48})\]/, check: (s) => PLACEHOLDER_WORDS.test(s) },
  { re: /^%([A-Za-z_][A-Za-z0-9_]{0,40})%/, check: (s) => IDENT_NAME.test(s) },
  { re: /^(%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?[sdvqxXfeg])/, check: () => true }, // printf-format (`Authorization: Bearer %s`)
  { re: /^(\{\d{0,3}\})/, check: () => true }, // `{}` / `{0}` (format-streng)
  { re: /^(\$\d{1,2})(?![A-Za-z0-9_])/, check: () => true }, // `$1` (posisjonsargument)
  { re: /^<([^<>\r\n]{1,48})(?=\r?\n|$)/, check: (s) => PLACEHOLDER_WORDS.test(s) }, // `<private app-` (plassholderen brytes over linjeskift i en kommentar)
  { re: /^\$([A-Za-z_][A-Za-z0-9_]{0,40})/, check: (s) => IDENT_NAME.test(s) }
];

/**
 * A-L7: er teksten fra `credential` og utover en REELL plassholder (`<token>`, `<your token>`, `${TOKEN}`, `$TOKEN`, `{{ token }}`, `{token}`, `[token]`, `%TOKEN%`, `...`, `***`)? Kun en HEL, lukket plassholderform telles, og den må avsluttes
 * (ikke fortsette med flere token-tegn). Et ekte token som tilfeldigvis STARTER med `<`, `{`, `$`, `%` eller `[` (`$2a$12$…`, `%7E…`, `<Zx3Qk9…>`) er ingen plassholder.
 */
export function isAuthPlaceholder(credential: string): boolean {
  if (/^(?:\.{3,}|\*{3,})(?![A-Za-z0-9_+/=-])/.test(credential)) return true;
  for (const form of PLACEHOLDER_FORMS) {
    const m = form.re.exec(credential);
    if (m === null) continue;
    const rest = credential.slice(m[0].length);
    if (/^[A-Za-z0-9_+/-]/.test(rest)) return false; // plassholderen fortsetter med token-tegn: et token som bare ligner (`=` er base64-fyll bak en mal: `Basic ${b64}==`)
    if (form.check(m[1] as string)) return true;
  }
  return false;
}
