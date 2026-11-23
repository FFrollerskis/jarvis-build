import { configuredGithubRepoFromEnv, type JsonValue } from "@jarvis/contracts";
import { resolveGithubRepo } from "./live-transports.ts";

/**
 * Q-50 B (D-450, Tobias 2026-10-09: «Ja til alle Q»): GitHub-kall som STYRES AV EN MODELL (chatten og delegerte bakgrunnsjobber, begge via `MeshToolExecutor`) er låst til eierens konfigurerte repo
 * (`JARVIS_GITHUB_REPO`, ellers `CANONICAL_GITHUB_REPO` i `@jarvis/contracts`, D-478/D-479). Begrunnelsen er ikke at andre repo er hemmelige, men at en modell som har lest ubetrodd innhold (e-post, issue-tekst, nettsider) ikke skal kunne
 * styres til å lese - eller, via handlingsnivået, skrive til - et annet repo med eierens token (D-429 lot et eksplisitt `eier/navn` gå uendret gjennom). Låsen gjelder ALLE GitHub-handlinger på modellens flate;
 * eierens egen bruk (dashbordet, bekreftede handlinger, direkte kall mot ToolGateway) er uendret.
 *
 * D-41 (maksimal eier-kapabilitet): dette er en standardinnstilling, ikke en fjerning av kapabilitet. Eieren åpner for andre repo med `JARVIS_GITHUB_ALLOW_OTHER_REPOS=true` (og kan fortsatt bruke dem direkte i dashbordet).
 * Sammenligningen skiller ikke mellom store og små bokstaver (det gjør heller ikke GitHub). Et skrivekall uten repo avvises uansett av transporten (`github_missing_parameter:repo`) og regnes ikke som brudd her.
 */
export interface GithubRepoLockViolation {
  requested: string;
  allowed: string;
}

export function githubReposUnlocked(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env["JARVIS_GITHUB_ALLOW_OTHER_REPOS"] ?? "").trim().toLowerCase() === "true";
}

/** Eierens konfigurerte repo (`JARVIS_GITHUB_REPO`) eller `CANONICAL_GITHUB_REPO`; tom/ugyldig verdi gir standarden. Definisjonen ligger i `@jarvis/contracts` (`configuredGithubRepoFromEnv`) så ALLE kallere er enige. */
export function configuredGithubRepo(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return configuredGithubRepoFromEnv(env);
}

/** `null` = kallet er innenfor låsen (eller låsen er av). Ellers repoet modellen ba om og repoet som er tillatt. */
export function githubRepoLockViolation(
  action: string,
  rawRepo: JsonValue | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env
): GithubRepoLockViolation | null {
  if (githubReposUnlocked(env)) return null;
  const allowed = configuredGithubRepo(env);
  let requested: string;
  try {
    // `?? ""`: manglende nøkkel i `env` skal gi standarden, ALDRI falle til `process.env` via default-parameteren i `resolveGithubRepo` (låsen er hermetisk mot `env`-argumentet).
    requested = resolveGithubRepo(action, rawRepo, env["JARVIS_GITHUB_REPO"] ?? "");
  } catch {
    return null;
  }
  return requested.toLowerCase() === allowed.toLowerCase() ? null : { requested, allowed };
}
