/**
 * WP-C2: miljø-parsing for backup-verktøyene (samme semantikk som `envInt` i packages/contracts: tom/usatt = dokumentert default, satt men
 * ugyldig = tydelig feil - aldri en stille 0/NaN). Egen kopi fordi ops/ er ren .mjs uten byggesteg og ikke kan importere TypeScript.
 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.code = "config_invalid";
  }
}

export function envString(env, name) {
  const value = env[name];
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Heltall i [min, max]. Feilmeldingen siterer ALDRI den rå verdien (kan være en hemmelighet som er limt inn på feil variabel). */
export function envInt(env, name, fallback, { min, max }) {
  const raw = envString(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new ConfigError(`ugyldig miljøvariabel ${name}: forventet heltall ${min}..${max} (tom/usatt = default)`);
  return parsed;
}

export function envBool(env, name, fallback = false) {
  const raw = envString(env, name);
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new ConfigError(`ugyldig miljøvariabel ${name}: forventet true/false (tom/usatt = ${fallback})`);
}
