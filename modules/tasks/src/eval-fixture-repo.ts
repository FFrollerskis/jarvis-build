/**
 * D-98 UA-5 Real Coding Agent v1 - Live Quality Evaluation: EKTE, kryssplattform
 * (Linux/Windows) fixture-repo-bootstrap. I motsetning til `coding-agent-eval.ts`
 * gjør denne filen EKTE fs-/prosesskall (mkdir/skriv fil/git init/config/commit/
 * push) - men INGEN DB-/nettverks-/Claude-kall - derfor fortsatt trygt testbar i
 * normal `pnpm -w test` (ekte lokal git, ingen ekstern avhengighet).
 *
 * HARNESS-REPAIR (2026-08-21): en ekte Windows-vertskjøring av
 * `scripts/ua5-coding-agent-live-eval.ts` feilet FØR noe Claude-/provider-kall
 * med `{"fatal_error":"git commit -m seed feilet: "}` (tom stderr).
 *
 * ROTÅRSAK (funnet ved kodeinspeksjon, ikke gjettet): den opprinnelige
 * `seedFixtureRepo()` kjørte det POSIX-eksterne kommandoet `mkdir -p <sti>` via
 * `spawnSync("mkdir", ...)` for å lage `src/`-undermappen ALLE D-98-fixtures
 * bruker (`EVAL_FIXTURES` i `coding-agent-eval.ts` har utelukkende `src/*`-
 * seedFiles). `mkdir` finnes IKKE som en frittstående kjørbar fil på Windows
 * (kun et cmd.exe-innebygd kommando, ingen `mkdir.exe` i System32) - kallet
 * feilet derfor med ENOENT, UKONTROLLERT (returverdien ble aldri sjekket). Den
 * påfølgende `spawnSync("node", ["-e", "writeFileSync(...)"])`-skrivingen
 * feilet DERFOR også (målmappen fantes ikke) - også ukontrollert. Siden ALLE
 * fixtures sine filer ligger under `src/`, endte arbeidstreet opp HELT tomt -
 * `git add -A` staget ingenting, og `git commit -m seed` feilet med "nothing
 * to commit, working tree clean" (git skriver dette til STDOUT, ikke stderr -
 * derfor den tomme `stderr`-strengen i den opprinnelige feilmeldingen).
 * `PROVIDER_CALL_OCCURRED_BEFORE_FAILURE=false` - feilen skjer under
 * repo-oppsett, FØR jobben noensinne enqueues/agenten kalles.
 *
 * FIKS: bruker ALDRI en spawnet ekstern prosess for mappe-/filoppretting -
 * kun `node:fs`s `mkdirSync`/`writeFileSync`, som er identisk
 * kryssplattform-korrekte UTEN noen ekstern kjørbar fil i det hele tatt.
 * I tillegg (§2/§4 i reparasjonsordren): hvert disponibelt repo (bart OG
 * arbeidsrepo) får LOKAL (ALDRI `--global`) `commit.gpgsign=false`/
 * `tag.gpgSign=false` + et tomt `core.hooksPath`, slik at evaluatoren er
 * deterministisk UANSETT vertens globale signerings-/hook-konfigurasjon -
 * Tobias sin ekte, globale git-konfigurasjon røres aldri.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { redactSecrets, type EvalFixture } from "./coding-agent-eval.ts";

export interface GitSpawnResult {
  readonly status: number | null;
  readonly error?: Error;
  readonly stderr: string | null;
  readonly stdout: string | null;
}

/**
 * Bygger en presis, sanert diagnosemelding for en feilet git-kommando - ALDRI
 * kun den (ofte tomme) `stderr`-strengen alene (jf. rotårsaken over: git
 * skriver enkelte feilmeldinger, som "nothing to commit", til STDOUT, ikke
 * stderr). Fjerner ethvert kjent hemmelig-formet argument FØR strengen
 * returneres - kalles ALLTID med ANTHROPIC_API_KEY/JARVIS_CLAUDE_BIN som
 * kandidat-hemmeligheter, uavhengig av om denne ene kommandoen faktisk
 * kunne inneholdt dem.
 */
export function describeGitFailure(
  args: readonly string[],
  result: GitSpawnResult,
  secrets: readonly (string | undefined)[]
): string {
  const detail =
    `command=git ${args.join(" ")} exit_code=${result.status ?? "null"} ` +
    `spawn_error=${result.error ? result.error.message : "none"} ` +
    `stderr=${(result.stderr ?? "").trim()} stdout=${(result.stdout ?? "").trim()}`;
  return redactSecrets(detail, secrets);
}

/**
 * Kjører en ekte git-kommando synkront. Kaster en sanert, informativ feil
 * (kommando + exit-kode + spawn-feil + BÅDE stderr og stdout) ved feil -
 * ALDRI kun rå `stderr`, som historisk viste seg utilstrekkelig.
 * `GIT_TERMINAL_PROMPT=0` hindrer et evt. credential-prompt fra å henge
 * evaluatoren på noen plattform.
 */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git command failed: ${describeGitFailure(args, result, [
      process.env["ANTHROPIC_API_KEY"], process.env["JARVIS_CLAUDE_BIN"]
    ])}`);
  }
  return (result.stdout ?? "").trim();
}

/**
 * Gjør ETT disponibelt git-repo (bart ELLER arbeidsrepo) uavhengig av
 * verts-globale identitet-/signerings-/hooks-konfigurasjon - ALDRI
 * `git config --global`, KUN `--local` på dette ene, disponible repoet.
 */
function hardenDisposableRepo(repoDir: string, hooksDir: string): void {
  git(repoDir, "config", "--local", "commit.gpgsign", "false");
  git(repoDir, "config", "--local", "tag.gpgSign", "false");
  git(repoDir, "config", "--local", "core.hooksPath", hooksDir);
}

/**
 * Setter opp et bart origin-repo + et seed-arbeidsrepo for én fixture, skriver
 * `fixture.seedFiles` (kryssplattform via `node:fs` - ALDRI en spawnet
 * `mkdir`/`node -e`-prosess), committer og pusher til `main`. Returnerer det
 * barte repoets sti (brukes som `repo_url` for den ekte kodejobb-workeren).
 */
export async function seedFixtureRepo(fixture: EvalFixture): Promise<string> {
  const hooksDir = await mkdtemp(join(tmpdir(), `jarvis-eval-hooks-${fixture.id}-`));

  const bareRepo = await mkdtemp(join(tmpdir(), `jarvis-eval-origin-${fixture.id}-`));
  git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
  hardenDisposableRepo(bareRepo, hooksDir);

  const seed = await mkdtemp(join(tmpdir(), `jarvis-eval-seed-${fixture.id}-`));
  git(seed, "init", "--initial-branch=main", ".");
  hardenDisposableRepo(seed, hooksDir);
  git(seed, "config", "--local", "user.email", "eval-seed@jarvis.local");
  git(seed, "config", "--local", "user.name", "jarvis-eval-seed");

  for (const [relativePath, content] of Object.entries(fixture.seedFiles)) {
    const absolutePath = join(seed, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "seed");
  git(seed, "push", bareRepo, "main");
  return bareRepo;
}
