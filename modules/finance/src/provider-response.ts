import { parseMinorUnitsStrict } from "./ore.ts";
import { rejectionCode, safeProviderId, safeToken } from "./webhook-guard.ts";

/**
 * WP-FIN2 (D-486, K7; JARVIS-097/020-resten): STRENG validering av 2xx-svar fra finansleverandørene. Før: `String(raw["id"])` ble «undefined» som `provider_ref`, `?? "0"` gjorde et manglende
 * beløp til 0 øre, `?? "NOK"` en stille standardvaluta og `?? "PDNG"` en stille betalingsstatus; Stripe/Vipps/Fiken leste `response.json() as T` uten feltsjekk. Her bor byggeklossene som
 * transportene bruker (gjenbruk av `safeProviderId`, `parseMinorUnitsStrict`, `safeToken` fra webhook-herdingen - ÉN definisjon av «trygg id/beløp/status»):
 *
 *   - POST/PATCH (mutasjon): leverandøren HAR svart 2xx og kan ha utført handlingen. Et svar vi ikke kan stole på er derfor UKJENT utfall:
 *     `outcome_unknown:provider_response_invalid:<kode>` (samme familie som `readCreatedJournalEntry`) - aldri en lagret «undefined», aldri en vanlig retry-bar feil.
 *   - GET (lesing): en typet feil `provider_response_invalid:<operasjon>:<kode>` (ingen bivirkning å være usikker på; sveipene isolerer feilen per objekt).
 * Koden er alltid kort og trygg (`[A-Za-z0-9_:.-]`, maks 80 tegn) - aldri selve innholdet fra leverandøren.
 *
 * Leverandørenes svarformer er `unverified` mot primærkilde (D-41): kontraktene som valideres er de FELTENE Jarvis faktisk bruker (typene i transportene). Avviker en ekte leverandør fra dem,
 * feiler det lukket (ukjent utfall/typet feil) - aldri stille standardverdier.
 */
export interface ResponseContext {
  /** Stabil operasjonsnavn til feilmeldingen, f.eks. `stripe.create_payment_intent`. */
  readonly operation: string;
  /** `true` for POST/PATCH (leverandøren kan ha utført handlingen), `false` for lesing. */
  readonly mutation: boolean;
}

export class ProviderResponseInvalidError extends Error {
  constructor(readonly operation: string, readonly code: string, readonly mutation: boolean) {
    const safe = rejectionCode(code);
    super(mutation ? `outcome_unknown:provider_response_invalid:${safe}` : `provider_response_invalid:${operation}:${safe}`);
    this.name = "ProviderResponseInvalidError";
  }
}

function invalid(ctx: ResponseContext, code: string): never {
  throw new ProviderResponseInvalidError(ctx.operation, code, ctx.mutation);
}

/** Leser en JSON-kropp; en kropp som ikke lar seg parse er et ugyldig svar (aldri en rå `SyntaxError`). */
export async function readJsonBody(response: { json(): Promise<unknown> }, ctx: ResponseContext): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return invalid(ctx, "body_not_json");
  }
}

function missing(value: unknown): boolean {
  return value === undefined || value === null;
}

/** Kroppen (eller et nøstet felt) må være et vanlig JSON-objekt - ikke `null`, liste eller primitiv. */
export function expectRecord(value: unknown, ctx: ResponseContext, field = "body"): Record<string, unknown> {
  if (missing(value)) return invalid(ctx, `${field}_missing`);
  if (typeof value !== "object" || Array.isArray(value)) return invalid(ctx, `${field}_wrong_type`);
  return value as Record<string, unknown>;
}

export function expectArray(value: unknown, ctx: ResponseContext, field = "body"): unknown[] {
  if (missing(value)) return invalid(ctx, `${field}_missing`);
  if (!Array.isArray(value)) return invalid(ctx, `${field}_wrong_type`);
  return value;
}

/** Leverandør-id: streng, 1-255 tegn, trygt tegnsett (`safeProviderId`). Manglende/tom/feil type/ugyldig gir hver sin kode. */
export function expectId(record: Record<string, unknown>, field: string, ctx: ResponseContext): string {
  const value = record[field];
  if (missing(value)) return invalid(ctx, `${field}_missing`);
  if (value === "") return invalid(ctx, `${field}_empty`);
  if (typeof value !== "string") return invalid(ctx, `${field}_wrong_type`);
  return safeProviderId(value) ?? invalid(ctx, `${field}_invalid`);
}

/** Beløp i minste enhet fra leverandøren: trygt, ikke-negativt heltall (`parseMinorUnitsStrict`) - aldri `Number()`-coercion, aldri en stille 0. */
export function expectMinorUnits(record: Record<string, unknown>, field: string, ctx: ResponseContext): number {
  const parsed = parseMinorUnitsStrict(record[field]);
  return parsed.ok ? parsed.value : invalid(ctx, `${field}_${parsed.reason.replace(/^amount_/, "")}`);
}

/**
 * Desimalbeløp (streng eller tall) fra leverandøren, eksakt konvertert til minste enhet av `parse` (streng-basert, aldri flyttallsarbeid; kaster på mer enn 2 desimaler). `allowNegative`:
 * kontosaldoer og transaksjonsbeløp er fortegnsbærende hos PSD2-banker; betalingsbeløp er det aldri.
 */
export function expectDecimalMinorUnits(
  record: Record<string, unknown>, field: string, ctx: ResponseContext, parse: (value: string | number) => number, options: { allowNegative: boolean }
): number {
  const value = record[field];
  if (missing(value)) return invalid(ctx, `${field}_missing`);
  if (value === "") return invalid(ctx, `${field}_empty`);
  if (typeof value !== "string" && typeof value !== "number") return invalid(ctx, `${field}_wrong_type`);
  let minor: number;
  try {
    minor = parse(value);
  } catch {
    return invalid(ctx, `${field}_unparseable`);
  }
  if (!Number.isSafeInteger(minor)) return invalid(ctx, `${field}_too_large`);
  if (minor < 0 && !options.allowNegative) return invalid(ctx, `${field}_negative`);
  return minor;
}

/** Valutakode: nøyaktig tre bokstaver. Returneres UENDRET (Stripe sender små bokstaver, Vipps/Neonomics store) - kalleren normaliserer selv der det trengs. Aldri en stille standardvaluta. */
export function expectCurrency(record: Record<string, unknown>, field: string, ctx: ResponseContext): string {
  const value = record[field];
  if (missing(value)) return invalid(ctx, `${field}_missing`);
  if (value === "") return invalid(ctx, `${field}_empty`);
  if (typeof value !== "string") return invalid(ctx, `${field}_wrong_type`);
  return /^[A-Za-z]{3}$/.test(value) ? value : invalid(ctx, `${field}_invalid`);
}

/** Status/tilstandsstreng (`safeToken`: 1-64 tegn av `[A-Za-z0-9_.-]`). Aldri en stille standardstatus. */
export function expectStatus(record: Record<string, unknown>, field: string, ctx: ResponseContext): string {
  const value = record[field];
  if (missing(value)) return invalid(ctx, `${field}_missing`);
  if (value === "") return invalid(ctx, `${field}_empty`);
  if (typeof value !== "string") return invalid(ctx, `${field}_wrong_type`);
  return safeToken(value) ?? invalid(ctx, `${field}_invalid`);
}

/** Valgfri tekst (navn m.m.): fraværende = `null`; tilstedeværende MÅ være en streng (ellers ugyldig svar), avkortet til `max` tegn. */
export function optionalText(record: Record<string, unknown>, field: string, ctx: ResponseContext, max = 200): string | null {
  const value = record[field];
  if (missing(value)) return null;
  if (typeof value !== "string") return invalid(ctx, `${field}_wrong_type`);
  return value.length === 0 ? null : value.slice(0, max);
}

/** Adgangstoken fra en token-utveksling: ikke-tom streng uten mellomrom/kontrolltegn (aldri «undefined» som `Bearer`-verdi). Token-endepunkter er IKKE pengemutasjoner (typet feil, aldri ukjent utfall). */
export function expectAccessToken(record: Record<string, unknown>, field: string, ctx: ResponseContext): string {
  const value = record[field];
  if (missing(value)) return invalid(ctx, `${field}_missing`);
  if (value === "") return invalid(ctx, `${field}_empty`);
  if (typeof value !== "string") return invalid(ctx, `${field}_wrong_type`);
  return value.length <= 8_192 && /^[^\s\x00-\x1f\x7f]+$/.test(value) ? value : invalid(ctx, `${field}_invalid`);
}
