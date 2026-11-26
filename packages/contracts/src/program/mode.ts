/**
 * WP-PGA (HF6 §24, lead-beslutning 2): modus for HF6-capstone-vaktene (programindeks-skanningen, gate-staleness og feilkode-dekningen).
 *
 *  - `report` (standard): vakten skriver en funnrapport og feiler IKKE bygget. Slik er den til eieren navngir adopsjonen av HF6 §24 som styrende (ADR-001 §2.1, Q-43).
 *  - `enforce`: funn utenfor baselinen gir rød test. Bygget og testet ferdig; å slå den på er ÉN verdi (`guard.mode` i `config/program/manifest.json`).
 *
 * Miljøvariabelen `PROGRAM_INDEX_MODE` kan KUN stramme inn: `enforce` vinner alltid. Et miljø som kunne sette `report` over et `enforce`-manifest ville vært en stille svekkelse
 * av vakten som ingen diff viser. En ugyldig verdi (typo, annen casing, blanke) er et høyt brudd - aldri en stille `report`.
 *
 * Ren modul: ingen filsystem, ingen `process.env` (kalleren gir verdiene). Ikke eksportert fra `@jarvis/contracts`-barrelen (BUILT_UNWIRED; ingen kjøretidsimport).
 */

export const GUARD_MODES = ["report", "enforce"] as const;
export type GuardMode = (typeof GUARD_MODES)[number];
export const GUARD_MODE_ENV = "PROGRAM_INDEX_MODE";

export class GuardModeError extends Error {
  constructor(readonly label: string, readonly value: unknown) {
    super(`ugyldig vaktmodus fra ${label}: forventet nøyaktig «report» eller «enforce» (små bokstaver, ingen blanke)`);
    this.name = "GuardModeError";
  }
}

const isMode = (value: unknown): value is GuardMode => typeof value === "string" && (GUARD_MODES as readonly string[]).includes(value);

/** `undefined` og tom streng betyr «ikke satt» (null). Alt annet enn nøyaktig `report`/`enforce` kaster. `label` navngir kilden i feilmeldingen (verdien gjengis aldri: den kan være hva som helst). */
export function parseModeValue(raw: string | undefined, label: string): GuardMode | null {
  if (raw === undefined || raw === "") return null;
  if (!isMode(raw)) throw new GuardModeError(label, raw);
  return raw;
}

export interface ResolvedGuardMode {
  /** Gjeldende modus: `enforce` hvis manifestet ELLER miljøet sier det. */
  mode: GuardMode;
  manifest_mode: GuardMode;
  env_mode: GuardMode | null;
  /** Miljøet hevet modusen over manifestet (report -> enforce). */
  raised_by_env: boolean;
}

/** Manifestverdien MÅ være gyldig (en manglende/ugyldig verdi er et brudd, ikke `report`); miljøverdien er valgfri. */
export function resolveGuardMode(manifestMode: unknown, envValue: string | undefined): ResolvedGuardMode {
  if (!isMode(manifestMode)) throw new GuardModeError("config/program/manifest.json (guard.mode)", manifestMode);
  const env = parseModeValue(envValue, GUARD_MODE_ENV);
  const mode: GuardMode = manifestMode === "enforce" || env === "enforce" ? "enforce" : "report";
  return { mode, manifest_mode: manifestMode, env_mode: env, raised_by_env: manifestMode === "report" && env === "enforce" };
}
