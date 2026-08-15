// Q-21 HOST FIX RECOVERY (2026-08-15): rene, testbare funksjoner for
// `fix-q21-runtime-role.ts` sin .env-håndtering. INGEN filsystem-/prosess-
// side-effekter her - alt som faktisk leser/skriver disk eller kjører docker
// bor i selve scriptet, slik at denne filen kan importeres trygt i tester
// uten å utløse noen orkestrering.
//
// Root cause for host-recovery-runden: forrige versjon av scriptet krevde
// at JARVIS_DB_ADMIN_USER/PASSWORD allerede fantes i .env FØR det byttet
// JARVIS_DB_USER/PASSWORD til runtime-verdier. På en host der disse admin-
// variablene av en eller annen grunn IKKE står i .env (fersk .env, eller en
// tidligere delvis kjøring), er det INGEN vei tilbake til de gamle
// credentials - og selve skrivingen skjedde uansett FØR fullstendig
// validering. Denne filen gjør begge deler robuste: gjenoppretter admin-
// credentials fra siste gyldige `.env.bak.*` når de mangler i .env, og
// validerer det KOMPLETTE resultatet FØR noe skrives.

export type EnvValues = Record<string, string>;

/** Enkel KEY=VALUE-parsing - identisk semantikk uansett hvor mange ganger den kalles. */
export function parseEnvValues(raw: string): EnvValues {
  const values: EnvValues = {};
  for (const line of raw.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) values[m[1]!] = m[2]!;
  }
  return values;
}

export interface AdminRecoveryResult {
  adminUser: string;
  adminPassword: string;
  source: "current_env" | "current_runtime_vars_as_admin" | "backup_admin_vars" | "backup_runtime_vars";
}

const ADMIN_CANDIDATE_USER = "postgres";

/**
 * §2/§3 i BO-en: finn admin-credentials, i prioritert rekkefølge:
 * 1. Allerede korrekt satt i nåværende .env (normal/idempotent sti).
 * 2. FRESH CASE (§3): nåværende .env mangler ADMIN-vars, men
 *    `JARVIS_DB_USER` er FORTSATT `postgres` (aldri byttet ennå) - dette ER
 *    admin-credentials, bare feil-navngitt. Ingen backup nødvendig her.
 * 3. PARTIAL-MIGRATION CASE (§2, det faktiske host-funnet): nyeste
 *    `.env.bak.*` som selv har ADMIN-variablene satt.
 * 4. Nyeste `.env.bak.*` der `JARVIS_DB_USER` var `postgres` FØR en
 *    tidligere (ufullstendig) kjøring byttet den levende `.env` sin
 *    `JARVIS_DB_USER` til runtime-verdien - backupen er da eneste
 *    gjenværende spor av den opprinnelige admin-tilkoblingen.
 *
 * `backupsNewestFirst` er allerede parsede snapshots, nyeste FØRST. Kaster
 * (uten å foreslå en gjetning) hvis INGEN kilde gir gjenopprettbare admin-
 * credentials - fail-closed, ingen `.env`-mutasjon skal skje etter dette.
 */
export function resolveAdminCredentials(current: EnvValues, backupsNewestFirst: EnvValues[]): AdminRecoveryResult {
  const currentAdminUser = current["JARVIS_DB_ADMIN_USER"];
  const currentAdminPassword = current["JARVIS_DB_ADMIN_PASSWORD"];
  if (currentAdminUser && currentAdminPassword) {
    return { adminUser: currentAdminUser, adminPassword: currentAdminPassword, source: "current_env" };
  }

  const currentRuntimeUser = current["JARVIS_DB_USER"];
  const currentRuntimePassword = current["JARVIS_DB_PASSWORD"];
  if (currentRuntimeUser && currentRuntimePassword && currentRuntimeUser.toLowerCase() === ADMIN_CANDIDATE_USER) {
    return { adminUser: currentRuntimeUser, adminPassword: currentRuntimePassword, source: "current_runtime_vars_as_admin" };
  }

  for (const backup of backupsNewestFirst) {
    const user = backup["JARVIS_DB_ADMIN_USER"];
    const password = backup["JARVIS_DB_ADMIN_PASSWORD"];
    if (user && password) {
      return { adminUser: user, adminPassword: password, source: "backup_admin_vars" };
    }
  }

  for (const backup of backupsNewestFirst) {
    const user = backup["JARVIS_DB_USER"];
    const password = backup["JARVIS_DB_PASSWORD"];
    if (user && password && user.toLowerCase() === ADMIN_CANDIDATE_USER) {
      return { adminUser: user, adminPassword: password, source: "backup_runtime_vars" };
    }
  }

  throw new Error(
    "q21_admin_credentials_unrecoverable: JARVIS_DB_ADMIN_USER/PASSWORD mangler i .env, JARVIS_DB_USER er ikke " +
      "'postgres' i nåværende .env, og ingen .env.bak.* inneholder gjenopprettbare admin-credentials (verken " +
      "egne ADMIN-variabler eller en tidligere JARVIS_DB_USER=postgres-verdi). .env er IKKE endret. Sett " +
      "JARVIS_DB_ADMIN_PASSWORD manuelt (samme verdi Postgres-containeren allerede bootstrapper med) og prøv igjen."
  );
}

export interface RuntimeResolution {
  runtimeUser: string;
  runtimePassword: string;
  changed: boolean;
}

/**
 * §1/§5 i BO-en: gjenbruk eksisterende runtime-credentials uendret på en
 * idempotent re-kjøring (aldri regenerer passord uten grunn); generer nye
 * KUN når nåværende verdi mangler, er lik admin-brukeren, eller er
 * `jarvis_app` (den NOLOGIN gruppe-rollen - aldri gyldig som runtime-bruker).
 */
export function resolveRuntimeCredentials(
  current: EnvValues,
  adminUser: string,
  generatePassword: () => string
): RuntimeResolution {
  const currentUser = current["JARVIS_DB_USER"] || "";
  const currentPassword = current["JARVIS_DB_PASSWORD"] || "";
  const needsNewUser = !currentUser || currentUser === adminUser || currentUser === "jarvis_app";
  const runtimeUser = needsNewUser ? "jarvis_runtime" : currentUser;
  const needsNewPassword = needsNewUser || !currentPassword;
  const runtimePassword = needsNewPassword ? generatePassword() : currentPassword;
  return { runtimeUser, runtimePassword, changed: needsNewUser || needsNewPassword };
}

/** §4: sett/legg til KEY=VALUE-linjer uten å røre andre linjer/kommentarer. */
export function buildUpdatedEnvLines(lines: string[], updates: EnvValues): string[] {
  const remainingKeys = new Set(Object.keys(updates));
  const next = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (m && remainingKeys.has(m[1]!)) {
      const key = m[1]!;
      remainingKeys.delete(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const key of remainingKeys) {
    next.push(`${key}=${updates[key]}`);
  }
  return next;
}

export const REQUIRED_ENV_KEYS = ["JARVIS_DB_ADMIN_USER", "JARVIS_DB_ADMIN_PASSWORD", "JARVIS_DB_USER", "JARVIS_DB_PASSWORD"] as const;

/** §4: alle fire credential-variablene MÅ finnes og være ikke-tomme FØR noe skrives til disk. */
export function validateRequiredEnv(values: EnvValues): void {
  for (const key of REQUIRED_ENV_KEYS) {
    if (!values[key] || !values[key]!.trim()) {
      throw new Error(`q21_env_validation_failed: ${key} mangler eller er tom - .env er IKKE endret`);
    }
  }
}

/** Sorterer `.env.bak.<epoch-ms>`-filnavn nyest-først (numerisk, ikke leksikografisk-i-tvil). */
export function sortBackupFilenamesNewestFirst(filenames: string[]): string[] {
  return [...filenames].sort((a, b) => {
    const ta = Number(/\.bak\.(\d+)$/.exec(a)?.[1] ?? 0);
    const tb = Number(/\.bak\.(\d+)$/.exec(b)?.[1] ?? 0);
    return tb - ta;
  });
}

/**
 * Q-21 HOST RECOVERY #2 (2026-08-15): migrate autentiserte som `jarvis_runtime`
 * til tross for at `.env` (bekreftet av scriptets egen log) hadde
 * `JARVIS_DB_ADMIN_USER=postgres` korrekt satt - en `docker compose run`-spesifikk
 * miljøvariabel-presedens-tvetydighet mellom `env_file:` og shell-arv kunne ikke
 * bekreftes med sikkerhet uten host-tilgang. Fjerner HELE tvetydighetsklassen:
 * disse to nøklene sendes ALLTID eksplisitt via `-e VARNAME` (BAR form - Compose
 * leser da fra DEN KALLENDE PROSESSENS (docker-CLI-ets) eget miljø, som scriptet
 * selv kontrollerer via `execFileSync` sin `env`-opsjon) - ALDRI via `.env`/
 * `env_file:`-oppløsning for akkurat dette ene kallet. Selve passordVERDIEN
 * finnes ALDRI i denne pure funksjonens returverdi (kun nøkkelNAVN) - trygt å
 * logge hele args-arrayet uten fare for lekkasje.
 */
export const MIGRATE_ADMIN_ENV_KEYS = ["JARVIS_DB_ADMIN_USER", "JARVIS_DB_ADMIN_PASSWORD"] as const;

export function buildMigrateRunArgs(composeArgs: string[]): string[] {
  return [...composeArgs, "run", "--rm", ...MIGRATE_ADMIN_ENV_KEYS.flatMap((key) => ["-e", key]), "migrate"];
}
