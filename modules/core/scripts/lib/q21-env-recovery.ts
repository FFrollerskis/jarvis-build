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

/**
 * Enkel KEY=VALUE-parsing - identisk semantikk uansett hvor mange ganger den
 * kalles. D-243 (2026-09-23, funnet LIVE av Tobias på Windows): en `.env`
 * med CRLF-linjeskift (Windows-standard, og det PowerShell sin `Set-Content`/
 * `[System.IO.File]::WriteAllLines` skriver som default) gjorde at HVER
 * linje fikk en usett trailing `\r` igjen etter `raw.split("\n")`. Den
 * gamle regexen `/^([A-Z0-9_]+)=(.*)$/` har INGEN `/m`-flagg, så `.` (som i
 * JS ALDRI matcher linjeskift-tegn, `\r` inkludert) kunne ikke nå fram til
 * `$` gjennom den gjenværende `\r`-en - HELE linjen feilet å matche, og
 * `parseEnvValues` DROPPET verdien fullstendig og stille (ingen feil, bare
 * fraværende nøkkel) i stedet for å beholde en `\r`-forurenset verdi. Dette
 * rammet BEGGE brukerne av denne funksjonen identisk (`fiken-reauth.ts` og
 * `fix-q21-runtime-role.ts`), samt strukturelt `google-drive-reauth.ts`/
 * `google-email-reauth.ts` (samme delte lib). Fikset ved å gjøre
 * trailing-`\r` eksplisitt valgfri FØR linjeslutt, i stedet for å kreve at
 * brukeren selv normaliserer filen til LF (se også `buildUpdatedEnvLines`
 * under, som nå normaliserer HELE filen til LF ved enhver skriving - ingen
 * ny CRLF skal noensinne introduseres av denne koden selv).
 */
export function parseEnvValues(raw: string): EnvValues {
  const values: EnvValues = {};
  for (const line of raw.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*?)\r?$/.exec(line);
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

/**
 * §4: sett/legg til KEY=VALUE-linjer uten å røre andre linjer/kommentarer.
 * D-243: hver linje normaliseres til å fjerne en ev. trailing `\r` FØR den
 * skrives tilbake - uendrede linjer fra en CRLF-fil ville ellers beholde sin
 * `\r`, mens NYE/erstattede linjer aldri fikk en (siden `updates[key]`
 * kommer fra et rent JS-objekt) - resultatet var en fil med BLANDEDE
 * linjeskift, som selv er en kjent kilde til fremtidige samme-klasse bugs
 * (se `parseEnvValues` sin D-243-kommentar over). Enhver skriving via denne
 * funksjonen normaliserer nå HELE filen til rene LF-linjeskift - trygt,
 * siden `.env`-filer kun konsumeres av Node/Docker Compose sine EGNE
 * parsere (ikke denne håndrullede regexen), som begge er CRLF/LF-agnostiske.
 */
export function buildUpdatedEnvLines(lines: string[], updates: EnvValues): string[] {
  const remainingKeys = new Set(Object.keys(updates));
  const next = lines.map((rawLine) => {
    const line = rawLine.replace(/\r$/, "");
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
 * Q-21 HOST RECOVERY #3 (2026-08-15): host-runde #2 sin `-e VARNAME`-fiks
 * (bar form, leser fra kallende prosess sitt miljø) løste IKKE problemet -
 * `migrate` autentiserte fortsatt som `jarvis_runtime`. Sterkeste gjenværende
 * forklaring: `docker compose run --rm migrate` gjenbrukte et EKSISTERENDE,
 * UTDATERT lokalt image (Docker Compose bygger ALDRI automatisk på nytt bare
 * fordi kildekoden på disk har endret seg - kun `--build`/`build`-kommandoen
 * gjør det) - containeren kjørte dermed en ELDRE `migrate-main.ts` som aldri
 * hadde `adminConfigFromEnv()`-splitten i det hele tatt. Dette forklarer alt:
 * scriptets EGEN direkte pg-tilkobling (kjører rett fra Node, alltid fersk
 * kildekode) beviste `admin_connection=PASS`, mens SELVE CONTAINEREN kjørte
 * helt annen, utdatert logikk.
 *
 * Fiksen fjerner `-e VARNAME`-ambiguiteten (§3 i BO-en - unødvendig når
 * imaget garantert er ferskt) og garanterer i stedet et FERSKT bygg av
 * migrate/api/worker fra AKTUELL checkout FØR noen av dem kjøres, hver eneste
 * gang scriptet kjører - "always rebuild" er den minste robuste løsningen
 * (BO-ens eget ord), ingen SHA-labels/overengineering.
 */
export function buildImageBuildArgs(composeArgs: string[]): string[] {
  return [...composeArgs, "build", "migrate", "api", "worker"];
}

/** Ingen `-e`-overstyring lenger - service+`--env-file` er tilstrekkelig når imaget garantert er ferskt bygget. */
export function buildMigrateRunArgs(composeArgs: string[]): string[] {
  return [...composeArgs, "run", "--rm", "migrate"];
}
