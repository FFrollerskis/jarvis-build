// WP-C3 (Q-45 b / D-35) - GITHUB APP LIVE-AKSEPTANSE
// Kjøres AV TOBIAS mot den EKTE GitHub App-en. Ingenting her er kjørt mot ekte GitHub av Claude: STATUS ER `NOT VERIFIED` TIL DETTE SCRIPTET ER KJØRT
// OG SIER `GITHUB_APP_LIVE_STATUS=VERIFIED` (siste linje; exit-kode 0).
//
// Hva scriptet gjør (standardmodus - kun lesing og token-utstedelse, ingenting skrives i noe repo):
//   1. leser App-konfig (JARVIS_GITHUB_APP_ID / _INSTALLATION_ID / repo-scope) og privatnøkkelen (vault, .env eller --key-file) og validerer nøkkelen
//   2. `GET /app/installations/{id}` med App-JWT: repoutvalg (selected/all), tildelte rettigheter, suspensjon - uten å utstede token
//   3. utsteder ET repo-scopet installasjonstoken (samme kode som Jarvis bruker) og kontrollerer at det er `selected` + NØYAKTIG forespurt repo
//   4. sammenligner tildelte rettigheter med D-41 full kapabilitet (manglende = WARN, ikke feil: eieren kan ha valgt det bevisst)
//   5. `GET /rate_limit` med installasjonstokenet (teller ikke mot kvoten) - beviser at tokenet fungerer
//   6. revokerer tokenet (`DELETE /installation/token`) og bekrefter at det er dødt, og skanner egen utskrift for token/JWT/privatnøkkel
// Med `--sandbox-repo <owner/repo>` (et TEST-repo App-en er installert på - ALDRI produksjonsrepoet ditt hvis du kan unngå det) gjøres i tillegg:
//   lese-sjekker via den ekte `GithubTransport` (repo, grener, PR-er, workflow-kjøringer), opprettelse og sletting av EN kjøre-unik test-gren
//   (`jarvis-app-live-<ts>`, aldri main/master/production) og `git ls-remote` med tokenet i miljøet (aldri i argv). Test-grenen ryddes alltid.
//
// Kjøres:
//   node --env-file=.env --experimental-transform-types modules/tool-gateway/scripts/github-app-live.ts [--key-file ./nokkel.pem] [--sandbox-repo owner/repo]
//   node --env-file=.env --experimental-transform-types modules/tool-gateway/scripts/github-app-live.ts --list-installations --key-file ./nokkel.pem   (finn installasjons-id)
// Hemmeligheter: tokenet og nøkkelen skrives ALDRI ut; scriptet skanner sin egen utskrift og feiler (`secret_safety`) hvis noe lekker.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EnvSecretProvider, FallbackSecretProvider, InfisicalSecretProvider, type SecretProvider } from "../src/gateway.ts";
import {
  GITHUB_APP_ERROR_HINTS, GITHUB_APP_PRIVATE_KEY_REF, GitHubAppAuth, GitHubAppAuthError, asGitHubAppAuthError, maskGitHubSecrets, normalizeGitHubApiBase,
  parseGitHubAppPrivateKey
} from "../src/github-app-auth.ts";
import { GITHUB_FULL_CAPABILITY_PERMISSIONS, createGitHubAuth, type GitHubAuth } from "../src/github-token-provider.ts";
import { GithubTransport } from "../src/live-transports.ts";
import { assertGithubRepoSlug, guardedFetch } from "../src/url-safety.ts";

export type Verdict = "PASS" | "WARN" | "FAIL" | "BLOCKED_NO_CREDENTIALS" | "NOT_RUN";

export interface LiveOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  /** Injeksjon (tester): ferdig bygget auth / vault / nøkkelfil-lesing / git-kjøring / API-base-test-flagg. */
  readonly auth?: GitHubAuth | undefined;
  readonly vault?: SecretProvider | undefined;
  readonly readFile?: ((path: string) => string) | undefined;
  readonly runGit?: ((args: string[], env: Record<string, string>) => { status: number | null; stdout: string }) | undefined;
  readonly allowLoopbackHttpForTests?: boolean | undefined;
}

export interface LiveResult {
  readonly checks: Readonly<Record<string, Verdict>>;
  readonly diagnostics: Readonly<Record<string, string>>;
  readonly status: string;
  readonly verified: boolean;
  readonly exitCode: 0 | 1 | 2;
}

const CHECKS = [
  "app_config", "app_private_key", "installation_inspect", "token_issue", "token_scope_exact", "permissions_full_capability", "rate_limit",
  "sandbox_read", "sandbox_branch_roundtrip", "sandbox_git_ls_remote", "token_revoked", "secret_safety"
] as const;
const OPTIONAL_CHECKS: ReadonlySet<string> = new Set(["sandbox_read", "sandbox_branch_roundtrip", "sandbox_git_ls_remote", "permissions_full_capability"]);

function parseArgs(argv: readonly string[]): { keyFile?: string; sandboxRepo?: string; listInstallations: boolean; help: boolean; unknown: string[] } {
  const out: { keyFile?: string; sandboxRepo?: string; listInstallations: boolean; help: boolean; unknown: string[] } = { listInstallations: false, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--key-file" || arg === "--sandbox-repo") {
      i += 1;
      const value = argv[i];
      if (value === undefined || value.startsWith("--")) out.unknown.push(`${arg} (mangler verdi)`);
      else if (arg === "--key-file") out.keyFile = value;
      else out.sandboxRepo = value;
    } else if (arg === "--list-installations") out.listInstallations = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else out.unknown.push(arg);
  }
  return out;
}

const USAGE = [
  "Bruk: github-app-live.ts [--key-file <pem>] [--sandbox-repo <owner/repo>] [--list-installations]",
  "  --key-file <pem>       PEM-filen du lastet ned fra GitHub (ellers leses JARVIS_GITHUB_APP_PRIVATE_KEY fra Infisical/.env)",
  "  --sandbox-repo <o/r>   TEST-repo App-en er installert på: lese-sjekker + opprett/slett en test-gren + git ls-remote",
  "  --list-installations   skriv ut installasjonene App-en har (finn JARVIS_GITHUB_APP_INSTALLATION_ID) og stopp"
].join("\n");

export async function runGitHubAppLive(options: LiveOptions): Promise<LiveResult> {
  const lines: string[] = [];
  const log = (line: string): void => { lines.push(line); options.log(line); };
  const results: Record<string, Verdict> = Object.fromEntries(CHECKS.map((id) => [id, "NOT_RUN" as Verdict]));
  const diagnostics: Record<string, string> = {};
  const sanitize = (err: unknown): string => {
    const error = asGitHubAppAuthError(err);
    const hint = GITHUB_APP_ERROR_HINTS[error.code];
    return `${error.message} - ${hint}`;
  };
  const fail = (id: string, err: unknown): void => { results[id] = "FAIL"; diagnostics[id] = err instanceof GitHubAppAuthError ? sanitize(err) : maskGitHubSecrets(err instanceof Error ? err.message : "ukjent feil").slice(0, 300); };

  log("==== GitHub App live-akseptanse (WP-C3) ====");
  log("STATUS ER `NOT VERIFIED` TIL ALLE KRAVENE UNDER ER KJØRT MOT DEN EKTE APP-EN OG SLUTTLINJEN SIER GITHUB_APP_LIVE_STATUS=VERIFIED.");

  const args = parseArgs(options.argv);
  if (args.help || args.unknown.length > 0) {
    log(USAGE);
    return finish(args.help ? 0 : 1, args.help ? "NOT VERIFIED (kun hjelp vist)" : `NOT VERIFIED (ukjente argumenter: ${args.unknown.join(" ")})`);
  }
  let sandboxRepo: string | undefined;
  if (args.sandboxRepo !== undefined) {
    try {
      sandboxRepo = assertGithubRepoSlug(args.sandboxRepo);
    } catch {
      log("--sandbox-repo må være `owner/repo`.");
      return finish(1, "NOT VERIFIED (ugyldig --sandbox-repo)");
    }
  }

  // ---- nøkkelkilde: --key-file > vault (Infisical) > .env -------------------------------------------------------------------------
  const vault = options.vault ?? new FallbackSecretProvider(new InfisicalSecretProvider(), new EnvSecretProvider());
  let keyFromFile: string | undefined;
  if (args.keyFile !== undefined) {
    try {
      keyFromFile = (options.readFile ?? ((p: string) => readFileSync(p, "utf8")))(args.keyFile);
    } catch {
      results["app_private_key"] = "FAIL";
      diagnostics["app_private_key"] = "kunne ikke lese --key-file";
      log("FEIL: kunne ikke lese --key-file.");
      return finish(1, "NOT VERIFIED (nøkkelfil ikke lesbar)");
    }
  }
  const secrets: SecretProvider = keyFromFile !== undefined
    ? { name: "key-file+vault", get: async (ref: string) => (ref === GITHUB_APP_PRIVATE_KEY_REF ? keyFromFile ?? null : vault.get(ref)) }
    : vault;

  if (args.listInstallations) return listInstallations(secrets);

  const captured: string[] = [];
  const auth = options.auth ?? createGitHubAuth({
    secrets, env: options.env, allowLoopbackHttpForTests: options.allowLoopbackHttpForTests === true,
    log: (event) => { const line = JSON.stringify(event); captured.push(line); log(`[auth-logg] ${line}`); }
  });
  const issuedTokens: string[] = [];

  // ---- 1. konfig -------------------------------------------------------------------------------------------------------------------
  const settings = auth.settings;
  if (settings.kind === "pat") {
    results["app_config"] = "BLOCKED_NO_CREDENTIALS";
    diagnostics["app_config"] = "JARVIS_GITHUB_APP_ID / JARVIS_GITHUB_APP_INSTALLATION_ID er ikke satt (PAT-modus) - ingenting å verifisere";
    log("BLOCKED_NO_CREDENTIALS: GitHub App er ikke konfigurert i dette miljøet (se docs/runbooks/GITHUB_APP.md).");
    return finish(2, "NOT VERIFIED (ikke konfigurert)");
  }
  if (settings.kind === "invalid") {
    fail("app_config", settings.error);
    log(`FEIL: ugyldig App-konfig: ${settings.error.message}`);
    return finish(1, "NOT VERIFIED (ugyldig konfig)");
  }
  results["app_config"] = "PASS";
  log(`app_config: app_id=${settings.appId} installation_id=${settings.installationId} repoer=${settings.repositories.join(",")} api_base=${settings.apiBase}`);
  const app = auth.app;
  if (!app) {
    fail("app_config", new Error("App-klienten kunne ikke opprettes"));
    return finish(1, "NOT VERIFIED (ingen App-klient)");
  }

  // ---- 2. privatnøkkel -------------------------------------------------------------------------------------------------------------
  try {
    const rawKey = await secrets.get(GITHUB_APP_PRIVATE_KEY_REF);
    if (!rawKey) {
      results["app_private_key"] = "BLOCKED_NO_CREDENTIALS";
      diagnostics["app_private_key"] = GITHUB_APP_ERROR_HINTS.GITHUB_APP_KEY_MISSING;
      log("BLOCKED_NO_CREDENTIALS: privatnøkkelen finnes verken som --key-file, i vaulten eller i .env.");
      return finish(2, "NOT VERIFIED (mangler privatnøkkel)");
    }
    const key = parseGitHubAppPrivateKey(rawKey);
    results["app_private_key"] = "PASS";
    log(`app_private_key: RSA ${key.asymmetricKeyDetails?.modulusLength ?? "?"} bit - gyldig`);
  } catch (err) {
    fail("app_private_key", err);
    log(`FEIL: privatnøkkelen er ugyldig: ${diagnostics["app_private_key"]}`);
    return finish(1, "NOT VERIFIED (ugyldig privatnøkkel)");
  }

  // ---- 3. installasjonen (kun JWT) ---------------------------------------------------------------------------------------------------
  try {
    const info = await app.inspectInstallation();
    log(`installation_inspect: konto=${info.account ?? "?"} (${info.account_type ?? "?"}) repoutvalg=${info.repository_selection} suspendert=${info.suspended}`);
    log(`installation_inspect: tildelte rettigheter: ${Object.entries(info.permissions).map(([k, v]) => `${k}:${v}`).join(", ") || "(ingen)"}`);
    if (info.suspended) {
      results["installation_inspect"] = "FAIL";
      diagnostics["installation_inspect"] = GITHUB_APP_ERROR_HINTS.GITHUB_APP_INSTALLATION_SUSPENDED;
    } else if (info.repository_selection === "all") {
      results["installation_inspect"] = "WARN";
      diagnostics["installation_inspect"] = "installasjonen har tilgang til ALLE repoer (anbefalt: «Only select repositories» med ETT repo). Jarvis ber likevel kun om de konfigurerte repoene, men lekker nøkkelen kan App-en brukes mot alt.";
    } else {
      results["installation_inspect"] = "PASS";
    }
  } catch (err) {
    fail("installation_inspect", err);
  }

  // ---- 4. token-utstedelse ------------------------------------------------------------------------------------------------------------
  let token: string | undefined;
  try {
    // Review F14: produksjonsklienten (`app`) kan KUN utstede for repoene i sin allowlist (JARVIS_GIT_ALLOWED_REPOS / JARVIS_GITHUB_REPO). Test-repoet står bevisst ikke der, så
    // sandbox-tokenet utstedes av en EGEN klient hvis allowlist er KUN test-repoet - den kan aldri utstede for produksjonsrepoet, og produksjonsklienten aldri for test-repoet.
    const issuer = sandboxRepo
      ? new GitHubAppAuth({
        appId: settings.appId, installationId: settings.installationId, apiBase: settings.apiBase, repositories: [sandboxRepo],
        privateKey: () => secrets.get(GITHUB_APP_PRIVATE_KEY_REF), allowLoopbackHttpForTests: options.allowLoopbackHttpForTests === true, log: () => undefined
      })
      : app;
    const issued = await issuer.issue();
    token = issued.token;
    issuedTokens.push(issued.token);
    results["token_issue"] = "PASS";
    log(`token_issue: utstedt, utløper ${issued.info.expires_at}, repoutvalg=${issued.info.repository_selection}`);
    const expected = (sandboxRepo ? [sandboxRepo] : [...settings.repositories]).map((r) => r.toLowerCase()).sort();
    const actual = [...issued.info.repositories].map((r) => r.toLowerCase()).sort();
    if (issued.info.repository_selection === "selected" && JSON.stringify(expected) === JSON.stringify(actual)) {
      results["token_scope_exact"] = "PASS";
      log(`token_scope_exact: tokenet dekker nøyaktig ${actual.join(", ")}`);
    } else {
      results["token_scope_exact"] = "FAIL";
      diagnostics["token_scope_exact"] = `forventet ${expected.join(",")} men tokenet dekker ${actual.join(",")} (${issued.info.repository_selection})`;
    }
    const missing = Object.entries(GITHUB_FULL_CAPABILITY_PERMISSIONS).filter(([name, level]) => {
      const granted = issued.info.permissions[name];
      return !(granted === level || (level === "read" && granted !== undefined));
    }).map(([name, level]) => `${name}:${level}`);
    log(`token_issue: tildelte rettigheter på tokenet: ${Object.entries(issued.info.permissions).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    if (missing.length === 0) {
      results["permissions_full_capability"] = "PASS";
    } else {
      results["permissions_full_capability"] = "WARN";
      diagnostics["permissions_full_capability"] = `mangler for FULL kapabilitet (D-41): ${missing.join(", ")} - tilsvarende github.*-handlinger vil feile med 403 («Resource not accessible by integration») inntil rettigheten er gitt og godkjent i installasjonen`;
    }
  } catch (err) {
    fail("token_issue", err);
  }

  const apiBase = app.apiBase;
  const bearer = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "jarvis" });

  // ---- 5. rate_limit ---------------------------------------------------------------------------------------------------------------------
  if (token) {
    try {
      const response = await guardedFetch(`${apiBase}/rate_limit`, { headers: bearer(token) });
      if (!response.ok) throw new Error(`GET /rate_limit ga HTTP ${response.status}`);
      const body = (await response.json()) as { resources?: { core?: { limit?: number; remaining?: number } } };
      results["rate_limit"] = "PASS";
      log(`rate_limit: tokenet fungerer (core limit=${body.resources?.core?.limit ?? "?"} remaining=${body.resources?.core?.remaining ?? "?"})`);
    } catch (err) {
      fail("rate_limit", err);
    }
  } else {
    results["rate_limit"] = "FAIL";
    diagnostics["rate_limit"] = "ingen token å teste (utstedelsen feilet)";
  }

  // ---- 6. sandbox (valgfritt) ----------------------------------------------------------------------------------------------------------
  if (sandboxRepo && token) {
    const transport = new GithubTransport();
    const ctx = { identity: { person_id: "live", tenant_id: "live", session_id: "live" } } as never;
    const runId = String(Date.now());
    const testBranch = `jarvis-app-live-${runId}`;
    let baseSha: string | undefined;
    try {
      const meta = (await transport.invoke("read_repo_meta", { repo: sandboxRepo }, token, ctx)).data as { default_branch: string };
      const branch = (await transport.invoke("get_branch", { repo: sandboxRepo, branch: meta.default_branch }, token, ctx)).data as { sha: string };
      baseSha = branch.sha;
      const prs = (await transport.invoke("list_pull_requests", { repo: sandboxRepo, state: "all" }, token, ctx)).data as { pull_requests: unknown[] };
      const runs = (await transport.invoke("list_workflow_runs", { repo: sandboxRepo }, token, ctx)).data as { workflow_runs: unknown[] };
      results["sandbox_read"] = "PASS";
      log(`sandbox_read: standardgren=${meta.default_branch} PR-er=${prs.pull_requests.length} workflow-kjøringer=${runs.workflow_runs.length}`);
    } catch (err) {
      fail("sandbox_read", err);
    }
    if (baseSha) {
      let created = false;
      try {
        await transport.invoke("create_branch", { repo: sandboxRepo, branch: testBranch, from_sha: baseSha }, token, ctx);
        created = true;
        await transport.invoke("create_branch", { repo: sandboxRepo, branch: testBranch, from_sha: baseSha }, token, ctx); // idempotens
        results["sandbox_branch_roundtrip"] = "PASS";
        log(`sandbox_branch_roundtrip: ${testBranch} opprettet (andre kall idempotent)`);
      } catch (err) {
        fail("sandbox_branch_roundtrip", err);
      } finally {
        if (created) {
          try {
            await transport.invoke("delete_branch", { repo: sandboxRepo, branch: testBranch }, token, ctx);
            log(`sandbox_branch_roundtrip: ${testBranch} slettet`);
          } catch (err) {
            fail("sandbox_branch_roundtrip", err);
            log(`ADVARSEL: test-grenen ${testBranch} kunne ikke slettes - slett den manuelt.`);
          }
        }
      }
    } else if (results["sandbox_branch_roundtrip"] === "NOT_RUN") {
      results["sandbox_branch_roundtrip"] = "FAIL";
      diagnostics["sandbox_branch_roundtrip"] = "ingen basis-sha fra lese-fasen";
    }
    try {
      const home = mkdtempSync(join(tmpdir(), "jarvis-app-live-git-"));
      try {
        // Tokenet går KUN via miljøet til git-underprosessen (aldri argv): GIT_CONFIG_* setter Authorization-headeren for github.com.
        const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
        const env: Record<string, string> = {
          PATH: process.env["PATH"] ?? "", HOME: home, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`
        };
        const argsGit = ["ls-remote", "--heads", `https://github.com/${sandboxRepo}.git`];
        const run = options.runGit ?? ((a: string[], e: Record<string, string>) => {
          const r = spawnSync("git", a, { env: e, encoding: "utf8", timeout: 60_000 });
          return { status: r.status, stdout: r.stdout ?? "" };
        });
        const result = run(argsGit, env);
        if (result.status === 0) {
          results["sandbox_git_ls_remote"] = "PASS";
          log(`sandbox_git_ls_remote: git over https med installasjonstokenet fungerte (${result.stdout.split("\n").filter((l) => l.trim()).length} grener)`);
        } else {
          results["sandbox_git_ls_remote"] = "FAIL";
          diagnostics["sandbox_git_ls_remote"] = `git ls-remote avsluttet med ${String(result.status)} (trenger Contents: read)`;
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } catch (err) {
      fail("sandbox_git_ls_remote", err);
    }
  }

  // ---- 7. revokering -------------------------------------------------------------------------------------------------------------------
  if (token) {
    try {
      await app.revoke(token);
      const after = await guardedFetch(`${apiBase}/rate_limit`, { headers: bearer(token) });
      if (after.status === 401) {
        results["token_revoked"] = "PASS";
        log("token_revoked: tokenet er revokert hos GitHub (neste kall gir 401)");
      } else {
        results["token_revoked"] = "FAIL";
        diagnostics["token_revoked"] = `tokenet virket fortsatt etter revokering (HTTP ${after.status})`;
      }
    } catch (err) {
      fail("token_revoked", err);
    }
  }

  // ---- 8. hemmelighetshygiene i EGEN utskrift --------------------------------------------------------------------------------------------
  const known = [...issuedTokens, ...auth.knownTokens(), ...(keyFromFile ? [keyFromFile.trim().split("\n")[1] ?? ""] : [])].filter((v) => v.length >= 8);
  const printed = [...lines, ...captured, ...Object.values(diagnostics)].join("\n");
  const leaked = known.some((secret) => printed.includes(secret)) || /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(printed) || /-----BEGIN [A-Z ]*PRIVATE KEY/.test(printed) || /gh[pousr]_[A-Za-z0-9_]{16,}/.test(printed);
  results["secret_safety"] = leaked ? "FAIL" : "PASS";
  if (leaked) diagnostics["secret_safety"] = "scriptets egen utskrift inneholder token/JWT/privatnøkkel - IKKE lim den inn noe sted, og meld fra";

  // ---- resultat ------------------------------------------------------------------------------------------------------------------------
  const hardFail = Object.entries(results).some(([, v]) => v === "FAIL");
  const requiredMissing = CHECKS.some((id) => !OPTIONAL_CHECKS.has(id) && results[id] !== "PASS" && results[id] !== "WARN");
  const sandboxRan = sandboxRepo !== undefined;
  const warnings = Object.entries(results).filter(([, v]) => v === "WARN").map(([k]) => k);
  if (hardFail) return finish(1, "NOT VERIFIED (minst én sjekk feilet)");
  if (requiredMissing) return finish(2, "NOT VERIFIED (ikke alle påkrevde sjekker er kjørt)");
  const suffix = [
    sandboxRan ? "" : "kun autentisering - skrive-/git-kapabilitet er IKKE verifisert (kjør med --sandbox-repo)",
    warnings.length > 0 ? `advarsler: ${warnings.join(", ")}` : ""
  ].filter((s) => s !== "");
  return finish(0, suffix.length > 0 ? `VERIFIED (${suffix.join("; ")})` : "VERIFIED");

  function finish(exitCode: 0 | 1 | 2, status: string): LiveResult {
    log("\n=== RESULTAT ===");
    for (const id of CHECKS) log(`${id}=${results[id]}${diagnostics[id] ? ` (${diagnostics[id]})` : ""}`);
    log(`GITHUB_APP_LIVE_STATUS=${status}`);
    return { checks: { ...results }, diagnostics: { ...diagnostics }, status, verified: status.startsWith("VERIFIED"), exitCode };
  }

  async function listInstallations(keySecrets: SecretProvider): Promise<LiveResult> {
    const appId = options.env["JARVIS_GITHUB_APP_ID"]?.trim();
    if (!appId) {
      log("BLOCKED_NO_CREDENTIALS: JARVIS_GITHUB_APP_ID er ikke satt.");
      return finish(2, "NOT VERIFIED (mangler JARVIS_GITHUB_APP_ID)");
    }
    try {
      const apiBase = normalizeGitHubApiBase(options.env["JARVIS_GITHUB_API_BASE"], options.allowLoopbackHttpForTests === true);
      const client = new GitHubAppAuth({
        appId, installationId: "1", apiBase, privateKey: () => keySecrets.get(GITHUB_APP_PRIVATE_KEY_REF),
        allowLoopbackHttpForTests: options.allowLoopbackHttpForTests === true, log: () => undefined
      });
      const installations = await client.listInstallations();
      if (installations.length === 0) log("Ingen installasjoner: installer App-en på kontoen din (Install App) og kjør igjen.");
      for (const i of installations) log(`installasjon id=${i.id} konto=${i.account ?? "?"} repoutvalg=${i.repository_selection} suspendert=${i.suspended}  ->  JARVIS_GITHUB_APP_INSTALLATION_ID=${i.id}`);
      return finish(0, "NOT VERIFIED (kun installasjonsliste vist - kjør uten --list-installations for selve akseptansen)");
    } catch (err) {
      fail("app_private_key", err);
      log(`FEIL: ${diagnostics["app_private_key"]}`);
      return finish(1, "NOT VERIFIED (kunne ikke liste installasjoner)");
    }
  }
}

async function main(): Promise<void> {
  const result = await runGitHubAppLive({ argv: process.argv.slice(2), env: process.env, log: (line) => console.log(line) });
  process.exitCode = result.exitCode;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("UNEXPECTED_SCRIPT_FAILURE:", maskGitHubSecrets(err instanceof Error ? err.message : "unknown").slice(0, 300));
    console.log("GITHUB_APP_LIVE_STATUS=NOT VERIFIED (uventet scriptfeil)");
    process.exitCode = 1;
  });
}
