import { createHash } from "node:crypto";
import { parseMinorUnitsStrict } from "./ore.ts";

/**
 * WP-F1 (D-462, JARVIS-020/070): felles, STRENGE byggeklosser for alle fire webhook-parsere (Stripe, Vipps, Neonomics, Wallester).
 *
 * En autentisert webhook er likevel UBETRODD DATA: leverandøren (eller en som har hemmeligheten) kan sende et beløp som er NaN/Infinity/negativt/brøk/astronomisk,
 * en dato som ikke finnes, en id med kontrolltegn eller en 2 MB lang streng. Slikt skal aldri nå domenelaget som et gjettet tall - og det skal heller aldri gi en evig
 * 5xx-retry (hendelsen forsvinner da sporløst eller hoper seg opp). Permanent ugyldig innhold lagres som dødbrev med status `rejected` + årsak (aldri selve innholdet) og
 * besvares 2xx; tilstanden hentes uansett inn igjen av den planlagte leverandør-oppfriskingen, og avstemmingen flagger avviste hendelser.
 */

export const WEBHOOK_ID_MAX_LENGTH = 255;

/** Leverandør-id-er (`evt_…`, `pi_…`, UUID-er, Vipps-referanser = våre egne id-er, Neonomics-betalings-id-er): trygt tegnsett, ingen mellomrom/kontrolltegn/unicode. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/=+-]*$/;

/** Returnerer id-en hvis den er en trygg leverandør-id (streng, 1..max tegn, trygt tegnsett), ellers `null`. */
export function safeProviderId(value: unknown, max: number = WEBHOOK_ID_MAX_LENGTH): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= max && SAFE_ID.test(value) ? value : null;
}

/** Kort, trygg årsakskode for lagring/visning (kun tegnsettet [A-Za-z0-9_:.-], maks 80 tegn) - aldri innholdet som ble avvist. */
export function rejectionCode(code: string, detail?: string): string {
  const raw = detail === undefined ? code : `${code}:${detail}`;
  return raw.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 80);
}

/** Dødbrev-nøkkel for en autentisert nyttelast som ikke engang lar seg identifisere (ikke JSON / mangler id): `malformed:<sha256-prefiks av de rå bytene>`. Samme bytes = samme nøkkel (dedupe). */
export function malformedWebhookKey(rawBody: Buffer): string {
  return `malformed:${createHash("sha256").update(rawBody).digest("hex").slice(0, 40)}`;
}

export type FieldResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly rejection: string };

/** Beløp i minste enhet: fraværende (`undefined`/`null`) er `ok(null)` (hendelsen bærer ikke beløp); tilstedeværende MÅ være et trygt, ikke-negativt heltall. */
export function strictWebhookAmount(value: unknown): FieldResult<number | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  const parsed = parseMinorUnitsStrict(value);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, rejection: rejectionCode("amount_invalid", parsed.reason) };
}

/** Som over, men beløpet er PÅKREVD (fraværende = avvist, aldri en stille 0). */
export function requiredWebhookAmount(value: unknown): FieldResult<number> {
  const parsed = parseMinorUnitsStrict(value);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, rejection: rejectionCode("amount_invalid", parsed.reason) };
}

/** Valuta: fraværende er `ok(null)`; tilstedeværende MÅ være tre bokstaver (normaliseres til store). */
export function strictWebhookCurrency(value: unknown): FieldResult<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? { ok: true, value: value.toUpperCase() } : { ok: false, rejection: "currency_invalid" };
}

/** Som over, men valutaen er PÅKREVD (aldri en stille standardvaluta som «EUR»). */
export function requiredWebhookCurrency(value: unknown): FieldResult<string> {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? { ok: true, value: value.toUpperCase() } : { ok: false, rejection: "currency_invalid" };
}

const MIN_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);
const MAX_PLAUSIBLE_MS = Date.UTC(2100, 0, 1);

/** ISO 8601-tidsstempel: fraværende er `ok(null)`; tilstedeværende MÅ være en streng som gir en gyldig dato mellom år 2000 og 2100 (en ugyldig dato ville ellers kastet i `toISOString()`). Returnerer ISO-strengen. */
export function strictWebhookTimestamp(value: unknown): FieldResult<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || value.length > 40) return { ok: false, rejection: "timestamp_invalid" };
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < MIN_PLAUSIBLE_MS || ms >= MAX_PLAUSIBLE_MS) return { ok: false, rejection: "timestamp_invalid" };
  return { ok: true, value: new Date(ms).toISOString() };
}

/** Unix-sekunder (Stripe `created`): trygt heltall mellom år 2000 og 2100. */
export function strictUnixSeconds(value: unknown): FieldResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return { ok: false, rejection: "created_invalid" };
  const ms = value * 1000;
  return ms >= MIN_PLAUSIBLE_MS && ms < MAX_PLAUSIBLE_MS ? { ok: true, value } : { ok: false, rejection: "created_invalid" };
}

/** Kort status-/typestreng: 1..max tegn av [A-Za-z0-9_.-]; ellers `null`. */
export function safeToken(value: unknown, max = 64): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= max && /^[A-Za-z0-9_.-]+$/.test(value) ? value : null;
}
