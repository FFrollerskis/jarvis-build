import { scanForSecrets } from "@jarvis/core";

/**
 * Gjennomgang av PR #324 (M1): LEVERANDØRENS FRITEKST ER UBETRODD OG KAN INNEHOLDE HEMMELIGHETER. Infisicals `lastRotationJobError` kunne tidligere gå urørt (kun kuttet til 160 tegn) gjennom
 * verktøysvaret og inn i `tool_executions.before_state` og `audit_events` (en rotasjonsfeil som siterer en tilkoblingsstreng med passord eller et Bearer-token). Feilmeldinger fra Cloudflare/Langfuse/
 * Infisical/Postgres og leverandørtekster som vises til eieren (navn, status, melding) går derfor gjennom den SENTRALE hemmelighetsskanneren (`scanForSecrets`, som også gjør `redactSecrets` i incidents og
 * kontrollsentrene) FØR de forlater transporten. Én felles funksjon, ingen egne mønstre per transport.
 *
 * REKKEFØLGE (viktig): skann FØRST, så kollaps av blanke, og kutt SIST. Kuttes teksten først, kan en hemmelighet som krysser kutt-grensen bli igjen som et halvt token som ikke lenger matcher noe mønster.
 * WP-SEC2 (K7b): det gamle forhåndskuttet på 64 KB er fjernet (en hemmelighet bak 64 KB blanke ble et halvt token); inndata begrenses nå til 1 MiB (kroppen er allerede begrenset til 1 MB), og skanneren er lineær og vindusbasert.
 *
 * BEVISST IKKE redigert: konfigurasjonsdata eieren selv skriver og som er GJENOPPRETTINGSGRUNNLAGET (DNS-innhold, regeluttrykk/-beskrivelse, `extra`-felt). Å erstatte dem med `[REDACTED:…]` ville ødelegge
 * etterbetingelsene (innhold sammenlignes eksakt) og kompensasjonen (recovery gjenoppretter fra before_state) - se docs/runbooks/INFRA_CONTROLLED_TARGETS.md «Leverandørtekst og hemmeligheter».
 */
const MAX_SCAN_CHARS = 1_048_576;

/** Skannet (hemmeligheter -> `[REDACTED:<type>]`), blank-kollapset og kuttet tekst. Aldri lengre enn `max`. */
export function redactVendorText(text: string, max = 160): string {
  return scanForSecrets(text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text).text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Leverandør-fritekst (feilmelding, navn, status, beskrivelse): redigert streng, ellers `null` (ikke en streng = ingen tekst). */
export function vendorText(value: unknown, max = 160): string | null {
  return typeof value === "string" ? redactVendorText(value, max) : null;
}

/** Rent tidsstempel (ISO-8601/RFC 3339-former) eller `null`: et tidsstempelfelt kan aldri bære fritekst fra en fiendtlig/feilkonfigurert leverandør. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;
export function vendorTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.length <= 40 && TIMESTAMP.test(value) ? value : null;
}
