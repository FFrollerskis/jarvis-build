/**
 * D-392 (JARVIS-021): `amount_ore` er `bigint` i Postgres, og `pg` returnerer bigint som STRENG. Et beløp som sendes uendret til en
 * leverandør havner da som `"1500"` (JSON-streng) i stedet for `1500`, og leverandøren avviser eller - verre - tolker feil. Alle beløp
 * til leverandør normaliseres her til et positivt, trygt heltall; alt annet kaster FØR noe nettverkskall gjøres.
 */
export function toOreInteger(value: number | string | bigint): number {
  const n = typeof value === "number" ? value : Number(value);
  if (typeof value === "string" && !/^\d{1,15}$/.test(value.trim())) throw new Error(`invalid_amount_ore:${String(value).slice(0, 20)}`);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`invalid_amount_ore:${String(value).slice(0, 20)}`);
  return n;
}
