/**
 * WP-SEC2 (JARVIS-013/069, K3): NØKKELNAVN-bevisst redaksjon. Når NØKKELEN i en struktur eller en JSON-tekst ligner en hemmelighet (`password`, `passord`, `api_key`, `client_secret`, `Authorization` ...),
 * er VERDIEN en hemmelighet uansett hvordan den ser ut - også uten kjent format og uten at noe `NAVN=verdi`-mønster treffer (anførselstegn mellom navn og kolon gjør at tekstmønsteret ikke ser det).
 *
 * Navnet normaliseres først: camelCase deles (`apiKey` -> `api_key`), store/små bokstaver og understrek/bindestrek/punktum/mellomrom likestilles, og navnet deles i ORD. En nøkkel er hemmelig når et
 * ord er et hemmelighetsord i ENTALL (`password`, `secret`, `token`, ...), når to nabo-ord danner et sammensatt nøkkelnavn (`api` + `key`, `private` + `key`, ...) eller når ett sammenskrevet ord ender på
 * `secret`/`token`/`password` (`accesstoken`). MEN: en nøkkel som ender på et teller-/metadataord (`token_count`, `passwords_checked`, `token_type`, `expires_at`, `secret_name`, `*_hash` ...) er IKKE en
 * hemmelighet - verdien er et tall, en type, et tidspunkt eller en referanse. Flertallsformer (`tokens`, `passwords`) er aldri hemmelighetsord alene: `input_tokens`/`max_tokens` er tellere.
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
}

const SECRET_WORDS: ReadonlySet<string> = new Set([
  "password", "passwd", "pwd", "passord", "passphrase", "kodeord", "hemmelighet", "secret", "token", "credential", "credentials", "cookie", "authorization", "bearer", "jwt", "otp", "pin", "auth",
  "apikey", "privatekey", "secretkey", "accesskey", "signingkey", "encryptionkey", "masterkey"
]);
const STRONG_WORDS: ReadonlySet<string> = new Set(["password", "passwd", "pwd", "passord", "passphrase", "kodeord", "hemmelighet", "secret", "pin", "otp", "apikey", "privatekey", "secretkey", "accesskey", "signingkey", "encryptionkey", "masterkey"]);
/** `<x>_key` er en hemmelig nøkkel når `<x>` er et av disse (`id_key`, `cache_key`, `primary_key`, `sort_key` er det IKKE). */
const KEY_QUALIFIERS: ReadonlySet<string> = new Set(["api", "private", "secret", "access", "signing", "encryption", "master", "license", "auth", "service", "session", "hmac", "webhook", "client", "shared", "bearer"]);
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

/** Ord som bare sier «dette ER verdien» (`token_value`, `private_key_pem`, `pin_code`): strippes bakfra før nøkkelen vurderes. */
const VALUE_WORDS: ReadonlySet<string> = new Set(["value", "text", "string", "plain", "raw", "data", "content", "pem", "hex", "base64", "b64", "code"]);

/**
 * En nøkkel er en hemmelighet når det siste (meningsbærende) ordet SELV er et hemmelighetsord: `db_password`, `client_secret`, `access_token`, `x-api-key`, `Authorization`, `private_key_pem`. En nøkkel der hemmelighetsordet står
 * foran noe annet beskriver noe RELATERT til hemmeligheten, ikke selve verdien (`credential_binding: "owner_bound"`, `secret_manager`, `token_endpoint`, `password_reset_url`) og redigeres ikke - ellers ville enum- og
 * metadatafelt (og connector-manifester) bli ødelagt. Teller-/metadatanøkler (`token_count`, `expires_at`, `secret_name` ...) er trygge uansett.
 */
export function classifyKey(rawKey: string): KeyClass {
  const words = keyWords(rawKey);
  if (words.length === 0) return { secret: false, strong: false, safe: false, metadata: false };
  const lastWord = words[words.length - 1] as string;
  const metadata = SAFE_LAST_WORDS.has(lastWord);
  const hasSecretWord = words.some((w) => SECRET_WORDS.has(w) || (w.length > 5 && /(?:secret|token|password|passwd|credential)$/.test(w)));
  let end = words.length;
  while (end > 1 && VALUE_WORDS.has(words[end - 1] as string)) end -= 1;
  const last = words[end - 1] as string;
  const prev = end >= 2 ? (words[end - 2] as string) : "";
  let secret = false;
  let strong = false;
  if (SECRET_WORDS.has(last)) {
    secret = true;
    strong = STRONG_WORDS.has(last);
  } else if (last.length > 5 && /(?:secret|token|password|passwd|credential)$/.test(last)) {
    // sammenskrevet: `accesstoken`, `clientsecret`, `mypassword` (men ikke `tokenizer`, `secretary`)
    secret = true;
    strong = !/token$/.test(last);
  } else if (last === "key" && KEY_QUALIFIERS.has(prev)) {
    secret = true;
    strong = true;
  }
  if (!secret) return { secret: false, strong: false, safe: hasSecretWord && metadata, metadata };
  return metadata ? { secret: false, strong: false, safe: true, metadata } : { secret: true, strong, safe: false, metadata };
}

/** Tekstformen `"navn": "verdi"`: skal verdien redigeres? */
export function isSecretKeyName(rawKey: string): boolean {
  return classifyKey(rawKey).secret;
}
