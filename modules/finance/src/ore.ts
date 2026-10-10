/**
 * Beløp i minste enhet (øre/cent) er ALLTID et trygt heltall - aldri flyttall, aldri en streng som tolkes «raust». Her bor de to beløpsportene i finansmodulen:
 *   - `toOreInteger`: Jarvis' EGNE beløp (DB `bigint` -> `pg` gir STRENG) normaliseres til et positivt tall FØR de sendes til en leverandør.
 *   - `parseMinorUnitsStrict`: beløp fra UBETRODDE kilder (webhook-nyttelast, leverandørsvar) parses strengt - ingen `Number()`-coercion som gjør `"1e3"`, `"0x10"`,
 *     `" 5 "`, `""`, `null`, `true` eller `[7]` til et tall, og ingen NaN/Infinity/negative/brøk/for store verdier slipper inn i domenet.
 */

/**
 * Øvre FORMATGRENSE for ett beløp i minste enhet (10 mrd. i hovedenhet). Ikke en policygrense (eieren har ingen interne beløpstak i Sovereign Mode; budsjetter/caps er
 * valgfri eier-policy som før) - en numerisk sikkerhetsgrense: langt over enhver realistisk transaksjon og langt under 2^53, så summer (refusjoner mot en betaling)
 * forblir eksakte. Speilet i tool-gateway/src/finance-class-d.ts (låst av test).
 */
export const MAX_AMOUNT_MINOR_UNITS = 1_000_000_000_000;

/**
 * D-392 (JARVIS-021): `amount_ore` er `bigint` i Postgres, og `pg` returnerer bigint som STRENG. Et beløp som sendes uendret til en
 * leverandør havner da som `"1500"` (JSON-streng) i stedet for `1500`, og leverandøren avviser eller - verre - tolker feil. Alle beløp
 * til leverandør normaliseres her til et positivt, trygt heltall (og ikke over formatgrensen); alt annet kaster FØR noe nettverkskall gjøres.
 */
export function toOreInteger(value: number | string | bigint): number {
  const n = typeof value === "number" ? value : Number(value);
  if (typeof value === "string" && !/^\d{1,15}$/.test(value.trim())) throw new Error(`invalid_amount_ore:${String(value).slice(0, 20)}`);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_AMOUNT_MINOR_UNITS) throw new Error(`invalid_amount_ore:${String(value).slice(0, 20)}`);
  return n;
}

export type MinorUnitsResult = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: string };

/**
 * WP-F1 (D-462, JARVIS-020/070): STRENG parsing av et beløp i minste enhet fra en ubetrodd kilde. Godtar KUN
 *   - `number` som er et trygt, ikke-negativt heltall (JSON-tall),
 *   - `string` som er 1-15 rene sifre (ingen fortegn, mellomrom, desimal, eksponent, heksadesimal, tusenskille), og
 *   - `bigint` innenfor trygt område.
 * Alt annet (NaN, ±Infinity, negative, brøk, for store, `null`/`undefined`, boolean, objekt, liste) gir `{ ok: false, reason }` - aldri et gjettet tall. Null er
 * gyldig (`allowZero`, standard) fordi enkelte hendelser bærer 0; kalleren avgjør om 0 er meningsfylt. Over `MAX_AMOUNT_MINOR_UNITS` avvises som `amount_too_large`.
 */
export function parseMinorUnitsStrict(value: unknown, options: { allowZero?: boolean } = {}): MinorUnitsResult {
  const allowZero = options.allowZero ?? true;
  let n: number;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { ok: false, reason: "amount_not_a_number" };
    if (!Number.isFinite(value)) return { ok: false, reason: "amount_not_finite" };
    if (value < 0) return { ok: false, reason: "amount_negative" };
    if (!Number.isInteger(value)) return { ok: false, reason: "amount_not_integer" };
    if (!Number.isSafeInteger(value)) return { ok: false, reason: "amount_too_large" };
    n = value === 0 ? 0 : value; // normaliserer -0 til 0
  } else if (typeof value === "string") {
    if (!/^\d+$/.test(value)) return { ok: false, reason: value.trim() === "" ? "amount_empty" : "amount_not_digits" };
    if (value.length > 15) return { ok: false, reason: "amount_too_large" };
    n = Number(value);
  } else if (typeof value === "bigint") {
    if (value < 0n) return { ok: false, reason: "amount_negative" };
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "amount_too_large" };
    n = Number(value);
  } else {
    return { ok: false, reason: value === null || value === undefined ? "amount_missing" : "amount_wrong_type" };
  }
  if (n > MAX_AMOUNT_MINOR_UNITS) return { ok: false, reason: "amount_too_large" };
  if (n === 0 && !allowZero) return { ok: false, reason: "amount_zero" };
  return { ok: true, value: n };
}

/** Samsvarer leverandørens ekko av et beløp med det vi ba om? Et ekko som ikke lar seg parse strengt regnes som IKKE samsvarende (aldri «antatt ok»). */
export function providerAmountEchoMatches(echo: unknown, expectedOre: number): boolean {
  const parsed = parseMinorUnitsStrict(echo);
  return parsed.ok && parsed.value === expectedOre;
}

/** Gyldig ISO 4217-formet valutakode (tre store bokstaver). Leverandørens valutaekko normaliseres IKKE (en liten-bokstav-kode fra Stripe er ikke det samme som en feil kode, men sjekkes eksplisitt av kallerne). */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}
