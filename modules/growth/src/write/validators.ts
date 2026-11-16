import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";

/**
 * WP-D3 (UA-4 Growth, D-459): deterministiske parameter-validatorer for skrivehandlingene. Alt som interpoleres i en URL-sti, GAQL-setning eller leverandørkropp valideres STRENGT her
 * (aldri en stille «rensing» som endrer hva som sendes). Feilkoder er faste strenger `growth_invalid_<felt>` (aldri verdien).
 *
 * BELØP: Jarvis' kanoniske enhet er øre (minste enhet i kontoens valuta, `*_ore`). Plattformene bruker ulike enheter: Google Ads mikroenheter (1 øre = 10 000 mikro), Meta/TikTok/LinkedIn
 * minste enhet eller desimal - omregningen skjer KUN i transportene, via funksjonene her. Øvre grense er en FORMAT-/overflyt-grense (ingen realistisk verdi er nær; dette er IKKE et beløpstak,
 * D-41/UA-6: Finance Integrity Gateway er revisjon/avstemming, ikke en obligatorisk grense).
 */
export type Params = Record<string, JsonValue>;

/** Format-/overflytgrense for ett beløp i øre (9*10^11 øre = 9*10^9 kr; i mikroenheter 9*10^15 = under 2^53, så heltallsregning forblir eksakt). Langt over enhver realistisk verdi. */
export const MAX_ORE = 900_000_000_000;
export const MICROS_PER_ORE = 10_000;

const CONTROL = /\p{Cc}/u;

/** Zod-byggestener (gjenbrukt av alle skrivedefinisjonene). */
export const zDigits = (min: number, max: number) => z.string().regex(new RegExp(`^\\d{${min},${max}}$`));
export const zOre = z.number().int().min(1).max(MAX_ORE);
export const zText = (min: number, max: number) => z.string().min(min).max(max);
export const zRecord = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Params>;

export function assertDigits(value: unknown, label: string, min = 1, max = 20): string {
  if (typeof value !== "string" || !new RegExp(`^\\d{${min},${max}}$`).test(value)) throw new Error(`growth_invalid_${label}`);
  return value;
}

export function assertOre(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_ORE) throw new Error(`growth_invalid_${label}`);
  return value;
}

export function oreToMicros(ore: number): number {
  return ore * MICROS_PER_ORE;
}

/** Tekst uten kontrolltegn (CR/LF/NUL osv.), trimmet, lengde i KODEPUNKTER. */
export function assertText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string") throw new Error(`growth_invalid_${label}`);
  const text = value.trim();
  const length = Array.from(text).length;
  if (length < min || length > max || CONTROL.test(text)) throw new Error(`growth_invalid_${label}`);
  return text;
}

export function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`growth_invalid_${label}`);
  return value as T;
}

/** Like mengder (rekkefølge/duplikater uten betydning, sammenlignet på eksakt tekst). */
export function sameStringSet(a: readonly unknown[], b: readonly unknown[]): boolean {
  const sa = new Set(a.filter((x): x is string => typeof x === "string"));
  const sb = new Set(b.filter((x): x is string => typeof x === "string"));
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

export const asObj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
