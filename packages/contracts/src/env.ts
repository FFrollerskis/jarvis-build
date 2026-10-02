/**
 * Remediering del 1 (JARVIS-027/083/092): `Number(process.env["X"] ?? 4)` har to feller:
 *  - en TOM streng (`KEY=` i `.env`, kopiert fra `.env.example`) er ikke `undefined`, så
 *    `??` faller aldri tilbake - `Number("")` blir `0` (jobben kjører ved midnatt, en port
 *    blir 0 = tilfeldig port);
 *  - et ugyldig tall gir `NaN`, som stille ble midnatt/ingenting.
 *
 * Semantikk her: usatt eller blank = den eksplisitte, dokumenterte defaulten;
 * satt men ugyldig (ikke et heltall, utenfor grensene) = oppstartsfeil (kaster).
 * Kun for ikke-hemmelige tallverdier - feilmeldingen siterer den rå verdien (avkortet).
 */
export class InvalidEnvValueError extends Error {
  constructor(
    readonly variable: string,
    raw: string,
    bounds: { min: number; max: number }
  ) {
    super(`ugyldig miljøvariabel ${variable}="${raw.slice(0, 40)}": forventet heltall ${bounds.min}..${bounds.max} (tom/usatt = default)`);
    this.name = "InvalidEnvValueError";
  }
}

export function envInt(
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new InvalidEnvValueError(name, raw, bounds);
  }
  return parsed;
}

/** Klokketime 0-23 (Europe/Oslo-sveip). */
export function envHour(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
  return envInt(name, fallback, { min: 0, max: 23 }, env);
}

/** TCP-port 1-65535. */
export function envPort(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
  return envInt(name, fallback, { min: 1, max: 65_535 }, env);
}
