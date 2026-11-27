import { body } from "./secret-fixtures.ts";

/**
 * WP-SEC2 fiks-runde 1 (A-M4): testfiksturer for connector-leverandørenes token-formater. INGEN ferdige nøkkelformer står i kildekoden: hvert token bygges SAMMENSATT ved kjøring (prefikset deles i to deler som limes
 * sammen, kroppen er en deterministisk blandet base62-streng fra `body`). Formatene er `unverified` (ingen leverandørdokumentasjon kunne leses), og kroppene er ikke ekte nøkler.
 */
const J = (...parts: string[]): string => parts.join("");

/** Deterministisk heksstreng med både sifre og bokstaver (a-f). */
export function hexBody(length: number, seed = 1): string {
  const digits = "0123456789abcdef";
  let out = "";
  for (let i = 0; out.length < length; i += 1) out += digits[(i * 7 + seed * 5 + (i >> 2)) % 16];
  return out;
}

/** Kun store bokstaver og sifre (bech32-alfabetet som age bruker). */
const BECH32 = "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L";
export function bech32Body(length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i += 1) out += BECH32[i % BECH32.length];
  return out;
}

export interface VendorFormat {
  /** Forventet `kind` i funnlisten. */
  readonly kind: string;
  readonly label: string;
  readonly make: () => string;
  /** Nære, men FEIL former (for korte, feil tegnklasse, feil lengde): skal gå uendret gjennom skanneren. */
  readonly nearMisses: () => string[];
}

export const VENDOR_FORMATS: ReadonlyArray<VendorFormat> = [
  { kind: "notion_token", label: "Notion ntn_", make: () => J("nt", "n_") + body(46, 1), nearMisses: () => [J("nt", "n_") + body(20, 1), J("nt", "n_") + body(10, 1) + "-" + body(40, 2)] },
  { kind: "notion_token", label: "Notion secret_", make: () => J("sec", "ret_") + body(43, 2), nearMisses: () => [J("sec", "ret_") + body(20, 2), J("sec", "ret_") + "authenticationconfigurationmanagerimplementation"] },
  { kind: "linear_token", label: "Linear lin_api_", make: () => J("lin", "_api_") + body(40, 3), nearMisses: () => [J("lin", "_api_") + body(20, 3), J("lin", "_apikey_") + body(40, 3)] },
  { kind: "linear_token", label: "Linear lin_oauth_", make: () => J("lin", "_oauth_") + body(40, 3), nearMisses: () => [J("lin", "_oauth_") + body(12, 3)] },
  { kind: "sentry_token", label: "Sentry sntrys_", make: () => J("snt", "rys_") + body(60, 4), nearMisses: () => [J("snt", "rys_") + body(10, 4), J("snt", "ryz_") + body(60, 4)] },
  { kind: "sentry_token", label: "Sentry sntryu_", make: () => J("snt", "ryu_") + hexBody(64, 2), nearMisses: () => [J("snt", "ryu_") + hexBody(12, 2)] },
  { kind: "tavily_key", label: "Tavily tvly-", make: () => J("tv", "ly-") + body(32, 5), nearMisses: () => [J("tv", "ly-") + body(10, 5), J("tv", "lyx-") + body(32, 5)] },
  { kind: "groq_key", label: "Groq gsk_", make: () => J("gs", "k_") + body(52, 13), nearMisses: () => [J("gs", "k_") + body(30, 13), J("gs", "k_") + body(20, 13) + "-" + body(30, 4)] },
  { kind: "atlassian_token", label: "Atlassian ATATT", make: () => J("ATA", "TT3xFfGF0") + body(80, 8), nearMisses: () => [J("ATA", "TT3xFf") + body(10, 8)] },
  { kind: "brave_key", label: "Brave BSA", make: () => J("BS", "A") + body(29, 6), nearMisses: () => [J("BS", "A") + body(10, 6), J("BS", "A") + "ConfigurationManagerFactoryImplementation"] },
  { kind: "twilio_sid", label: "Twilio SK + 32 hex", make: () => J("S", "K") + hexBody(32, 2), nearMisses: () => [J("S", "K") + hexBody(31, 2), J("S", "K") + hexBody(33, 2), J("S", "K") + hexBody(32, 2).toUpperCase()] },
  { kind: "twilio_sid", label: "Twilio AC + 32 hex", make: () => J("A", "C") + hexBody(32, 3), nearMisses: () => [J("A", "C") + hexBody(30, 3), J("A", "C") + "ZZ" + hexBody(30, 3)] },
  { kind: "telnyx_key", label: "Telnyx KEY0", make: () => J("KE", "Y0") + body(30, 7).toUpperCase() + "_" + body(22, 9), nearMisses: () => [J("KE", "Y0") + body(8, 7), J("KE", "Y0") + "_PRIMARY_ENCRYPTION_MATERIAL_ID_FIELD"] },
  { kind: "hubspot_token", label: "HubSpot pat-na1-", make: () => J("pa", "t-na1-") + "12345678-1234-1234-1234-123456789abc", nearMisses: () => [J("pa", "t-na1-") + "abc", J("pa", "t-na1-") + "12345678-1234-1234-1234-123456789xyz"] },
  { kind: "dropbox_token", label: "Dropbox sl.", make: () => J("s", "l.") + body(120, 9), nearMisses: () => [J("s", "l.") + body(40, 9), "https://sl.example.com/" + body(120, 9).slice(0, 30)] },
  { kind: "discord_bot_token", label: "Discord bot-token", make: () => J("MTE", "xMjM0NTY3ODkwMTIzNDU2N") + "." + body(6, 3) + "." + body(27, 4), nearMisses: () => ["Maximumlengthidentifierxx.abcdef.restofthelongclassnamehereabcd", J("MTE", "xMjM0NTY3ODkw") + "." + body(6, 3) + "." + body(27, 4)] },
  { kind: "webhook_url", label: "Slack webhook-URL", make: () => J("https://hooks.", "slack.com/services/T") + "0123ABCD/B0123ABCD/" + body(24, 5), nearMisses: () => [J("https://hooks.", "slack.com/services/T") + "0123ABCD/B0123ABCD/kort", J("https://hooks.", "slack.com/services/") + "docs"] },
  { kind: "webhook_url", label: "Discord webhook-URL", make: () => J("https://discord.com/api/", "webhooks/") + "123456789012345678/" + body(68, 6), nearMisses: () => [J("https://discord.com/api/", "webhooks/") + "123456789012345678/kort", J("https://discord.com/api/", "webhooks/") + "docs"] },
  { kind: "resend_key", label: "Resend re_", make: () => J("r", "e_") + body(32, 14), nearMisses: () => [J("r", "e_") + body(10, 14), "re_compile_pattern_cache_for_all_of_the_things"] },
  { kind: "meta_token", label: "Meta EAA", make: () => J("EA", "A") + body(120, 12), nearMisses: () => [J("EA", "A") + body(40, 12)] },
  { kind: "age_secret_key", label: "age hemmelig nøkkel", make: () => J("AGE-SECRET-", "KEY-1") + bech32Body(58), nearMisses: () => [J("AGE-SECRET-", "KEY-1") + bech32Body(20), "age1" + bech32Body(58).toLowerCase()] }
];
