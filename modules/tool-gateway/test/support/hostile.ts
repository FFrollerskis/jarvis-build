/**
 * Gjennomgang av PR #324 (M1): FIENDTLIGE seed-verdier for fake-leverandørene. Testene la tidligere kun inn harmløs tekst («upstream rejected credentials …»), så en leverandørfeil som SITERER en
 * hemmelighet (tilkoblingsstreng med passord, Bearer-token, PEM, JWT) slapp gjennom transporten uten at noen test ble rød. Alle verdier er SYNTETISKE (ikke ekte nøkler) og bygges under kjøring av
 * deler, slik at kildekoden ikke inneholder noe en hemmelighetsskanner (gitleaks) eller `scanForSecrets` kjenner igjen som en nøkkel.
 *
 * `HOSTILE_TEXT` er én streng med ALLE kategoriene; `HOSTILE_FRAGMENTS` er de rå hemmelighetene som ALDRI må finnes i noe verktøysvar, i `tool_executions` eller i `audit_events`.
 */
const password = ["Zq9", "SuperSecretPw", "77"].join("-");
const github = `ghp_${"Q".repeat(36)}`;
const openai = ["sk", "Z".repeat(32)].join("-");
const bearerValue = "b".repeat(30);
const jwtParts = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"] as const;
const pemBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
const pem = ["-----BEGIN", "PRIVATE KEY-----"].join(" ") + `\n${pemBody}\n${pemBody.split("").reverse().join("")}\n` + ["-----END", "PRIVATE KEY-----"].join(" ");
const url = `postgresql://svc_rot:${password}@db.internal:5432/app`;

/**
 * Hele hemmeligheter OG deres første tegn: leverandørfeil kuttes til 60-120 tegn i `reason`/revisjon, så en uredigert hemmelighet kan stå igjen som et prefiks - testene skal ikke bare fange
 * en komplett lekkasje, men også et avkortet token/passord.
 */
export const HOSTILE_FRAGMENTS: readonly string[] = [
  password, "Zq9-Super", "svc_rot:Zq9", "SuperSecretPw", github, github.slice(0, 14), openai, openai.slice(0, 13), bearerValue, bearerValue.slice(0, 10),
  ...jwtParts, jwtParts[2].slice(0, 10), pemBody, pemBody.slice(0, 16), pemBody.split("").reverse().join(""), "BEGIN PRIVATE KEY"
];

/** Alle kategoriene i én fritekst: URL med passord, Bearer, GitHub-token, sk--nøkkel, JWT og en PEM-blokk (med linjeskift). */
export const HOSTILE_TEXT = `rotation failed: could not connect ${url} using Bearer ${bearerValue} and ${github} with ${openai}; jwt=${jwtParts.join(".")}\n${pem}`;

/** Én enkelt kategori per verdi - for felt som er korte (statusmeldinger, navn). */
export const HOSTILE_SHORT = { url, github, openai, bearer: `Bearer ${bearerValue}`, jwt: jwtParts.join("."), pem } as const;

/** `true` når teksten (serialisert) inneholder en rå hemmelighet. */
export function leaksHostile(serialized: string): string[] {
  return HOSTILE_FRAGMENTS.filter((f) => serialized.includes(f));
}
