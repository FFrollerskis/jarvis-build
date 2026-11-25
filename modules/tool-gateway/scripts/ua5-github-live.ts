// UA-5 GITHUB DEVELOPER CONTROL PLANE v1 - LIVE ACCEPTANCE
// Kjøres AV TOBIAS mot et EKTE, konfigurert GitHub-repo (JARVIS_GITHUB_TOKEN).
// I MOTSETNING TIL Google Ads-live-scriptet (D-83/D-84) trenger IKKE dette
// scriptet Postgres/tenant-fixtures - INGEN github.*-handling leser/skriver
// noen Jarvis-DB-tabell (bekreftet under UA-5-reconstruction: ingen ny
// migrasjon i denne sliceen). Scriptet kaller `GithubTransport` DIREKTE (samme
// klasse ToolGateway bruker i produksjon - INGEN alternativ implementasjon).
//
// SIKKER TEST-SANDBOX (D-41: "test-/akseptanseløp SKAL begrenses til
// sandbox/test-ressurser for å begrense blast radius"): scriptet oppretter
// KUN en kjøre-unik test-branch (`jarvis-live-test-<ts>`, fra faktisk HEAD-sha)
// og et kjøre-unikt test-issue - ALDRI mot `main`/`master`/`production`
// (strukturelt umulig, se GITHUB_PROTECTED_BRANCHES i live-transports.ts).
// merge_pr og dispatch_workflow forsøkes BEVISST IKKE her (for høy blast
// radius for en ubetjent live-kjøring - se D-41-matrisen i
// docs/DECISIONS_AND_ASSUMPTIONS.md for begrunnelsen) - kun deres
// LESE-sidestykker (get_pull_request/list_workflow_runs) verifiseres live.
// All test-scaffolding (branch + issue) ryddes opp ved slutten, uansett utfall.
//
// Kjøres: node --env-file=.env --experimental-transform-types modules/tool-gateway/scripts/ua5-github-live.ts <owner/repo>
// repo er PÅKREVD og skal være et eget SANDBOX-/test-repo: skriptet har INGEN standard og NEKTER produksjonsrepoet (D-41, D-479): det kanoniske repoet, forkets tidligere navn, det gamle frosne repoet,
// repoet JARVIS_GITHUB_REPO peker på og JARVIS_GIT_ALLOWED_REPOS, også som `.git`-/`/`-alias og med store bokstaver (se src/github-sandbox-guard.ts). Ingen overstyring finnes med vilje.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { GithubTransport } from "../src/live-transports.ts";
import { isProductionGithubRepo } from "../src/github-sandbox-guard.ts";
import { assertGithubRepoSlug } from "../src/url-safety.ts";

type Verdict = "PASS" | "FAIL" | "BLOCKED_NO_CREDENTIALS" | "NOT_RUN";

const results: Record<string, Verdict> = {
  github_live_env_safe: "NOT_RUN",
  github_live_read_repo_meta: "NOT_RUN",
  github_live_read_branches: "NOT_RUN",
  github_live_read_pull_requests: "NOT_RUN",
  github_live_read_workflow_runs: "NOT_RUN",
  github_live_create_branch: "NOT_RUN",
  github_live_create_issue: "NOT_RUN",
  github_live_comment_and_labels: "NOT_RUN",
  github_live_update_issue_close: "NOT_RUN",
  github_live_delete_branch: "NOT_RUN",
  github_live_cleanup: "NOT_RUN",
  github_live_secret_safety: "NOT_RUN"
};
const diagnostics: Record<string, string> = {};
const logBuffer: string[] = [];

function log(line: string): void {
  logBuffer.push(line);
  console.log(line);
}

export type LiveRepoResolution = { ok: true; repo: string } | { ok: false; reason: string };

/** Repoet skriptet kjøres mot: PÅKREVD argument (ingen standard), gyldig `eier/repo`, og aldri et produksjonsrepo (D-41 blast radius; D-479). */
export function resolveLiveRepo(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): LiveRepoResolution {
  const raw = (argv[0] ?? "").trim();
  if (raw === "") return { ok: false, reason: "repo mangler: oppgi et eget SANDBOX-/test-repo (<eier>/<repo>). Skriptet oppretter en test-gren og et test-issue og har ingen standard (D-41, D-479)" };
  let repo: string;
  try {
    repo = assertGithubRepoSlug(raw);
  } catch {
    return { ok: false, reason: "repo må være `eier/repo` (kun bokstaver, tall, `-`, `_` og `.`)" };
  }
  const allowlist = (env["JARVIS_GIT_ALLOWED_REPOS"] ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (isProductionGithubRepo(repo, env, allowlist)) {
    return { ok: false, reason: `${repo} er et produksjonsrepo (det kanoniske repoet, et tidligere navn på det, det gamle frosne repoet, JARVIS_GITHUB_REPO eller JARVIS_GIT_ALLOWED_REPOS): bruk et eget SANDBOX-/test-repo. Ingen overstyring finnes (D-41, D-479)` };
  }
  return { ok: true, repo };
}

async function main(): Promise<void> {
  const resolved = resolveLiveRepo(process.argv.slice(2), process.env);
  if (!resolved.ok) {
    log(`FEIL: ${resolved.reason}. Ingenting er kjørt mot GitHub.`);
    console.log("LIVE_PROVIDER_VERIFIED=false");
    process.exitCode = 2;
    return;
  }
  const repo = resolved.repo;
  const token = process.env["JARVIS_GITHUB_TOKEN"];
  if (!token) {
    for (const key of Object.keys(results)) results[key] = "BLOCKED_NO_CREDENTIALS";
    log("BLOCKED_NO_CREDENTIALS: JARVIS_GITHUB_TOKEN er ikke satt - ingen live-kall forsøkt.");
    printSummary(repo);
    return;
  }
  results["github_live_env_safe"] = "PASS";

  const transport = new GithubTransport();
  const ctx = { identity: { person_id: "live", tenant_id: "live", session_id: "live" } } as never;
  const runId = String(Date.now());
  const testBranch = `jarvis-live-test-${runId}`;
  let baseSha: string | undefined;
  let testIssueNumber: string | undefined;

  try {
    const meta = (await transport.invoke("read_repo_meta", { repo }, token, ctx)).data as { default_branch: string };
    log(`read_repo_meta: default_branch=${meta.default_branch}`);
    results["github_live_read_repo_meta"] = "PASS";

    const defaultBranchInfo = (await transport.invoke("get_branch", { repo, branch: meta.default_branch }, token, ctx)).data as { sha: string };
    baseSha = defaultBranchInfo.sha;
    const branches = (await transport.invoke("list_branches", { repo }, token, ctx)).data as { branches: unknown[] };
    log(`list_branches: ${branches.branches.length} branches, base_sha=${baseSha}`);
    results["github_live_read_branches"] = "PASS";
  } catch (err) {
    results["github_live_read_repo_meta"] = "FAIL";
    diagnostics["read_repo_meta"] = sanitize(err);
  }

  try {
    const prs = (await transport.invoke("list_pull_requests", { repo, state: "all" }, token, ctx)).data as { pull_requests: Array<{ number: number }> };
    log(`list_pull_requests: ${prs.pull_requests.length} PR-er funnet`);
    if (prs.pull_requests[0]) {
      await transport.invoke("get_pull_request", { repo, pr_number: String(prs.pull_requests[0].number) }, token, ctx);
      log(`get_pull_request: PR #${prs.pull_requests[0].number} lest OK (merge_pr sitt LESE-sidestykke - selve merge forsøkes IKKE her)`);
    }
    results["github_live_read_pull_requests"] = "PASS";
  } catch (err) {
    results["github_live_read_pull_requests"] = "FAIL";
    diagnostics["pull_requests"] = sanitize(err);
  }

  try {
    const runs = (await transport.invoke("list_workflow_runs", { repo }, token, ctx)).data as { workflow_runs: Array<{ id: string }> };
    log(`list_workflow_runs: ${runs.workflow_runs.length} kjøringer funnet`);
    if (runs.workflow_runs[0]) {
      await transport.invoke("list_workflow_jobs", { repo, run_id: runs.workflow_runs[0].id }, token, ctx);
      log(`list_workflow_jobs: jobber lest for run ${runs.workflow_runs[0].id}`);
    }
    results["github_live_read_workflow_runs"] = "PASS";
  } catch (err) {
    results["github_live_read_workflow_runs"] = "FAIL";
    diagnostics["workflow_runs"] = sanitize(err);
  }

  if (baseSha) {
    try {
      await transport.invoke("create_branch", { repo, branch: testBranch, from_sha: baseSha }, token, ctx);
      // Idempotens-bevis: opprett samme branch igjen - skal IKKE feile.
      await transport.invoke("create_branch", { repo, branch: testBranch, from_sha: baseSha }, token, ctx);
      log(`create_branch: ${testBranch} opprettet, andre kall idempotent OK`);
      results["github_live_create_branch"] = "PASS";
    } catch (err) {
      results["github_live_create_branch"] = "FAIL";
      diagnostics["create_branch"] = sanitize(err);
    }
  } else {
    results["github_live_create_branch"] = "FAIL";
    diagnostics["create_branch"] = "no_base_sha_from_read_phase";
  }

  try {
    const issue = (await transport.invoke("create_issue", { repo, title: `[jarvis-live-test] ${runId}`, body: "UA-5 live acceptance - trygt å slette/lukke." }, token, ctx)).data as { number: string };
    testIssueNumber = issue.number;
    log(`create_issue: #${testIssueNumber}`);
    results["github_live_create_issue"] = "PASS";
  } catch (err) {
    results["github_live_create_issue"] = "FAIL";
    diagnostics["create_issue"] = sanitize(err);
  }

  if (testIssueNumber) {
    try {
      await transport.invoke("comment_on_issue", { repo, issue_number: testIssueNumber, body: "live-acceptance kommentar" }, token, ctx);
      await transport.invoke("set_labels", { repo, issue_number: testIssueNumber, labels: ["jarvis-live-test"] }, token, ctx);
      log(`comment_on_issue + set_labels: OK på #${testIssueNumber}`);
      results["github_live_comment_and_labels"] = "PASS";
    } catch (err) {
      results["github_live_comment_and_labels"] = "FAIL";
      diagnostics["comment_and_labels"] = sanitize(err);
    }
    try {
      await transport.invoke("update_issue", { repo, issue_number: testIssueNumber, state: "closed" }, token, ctx);
      log(`update_issue: #${testIssueNumber} lukket`);
      results["github_live_update_issue_close"] = "PASS";
    } catch (err) {
      results["github_live_update_issue_close"] = "FAIL";
      diagnostics["update_issue_close"] = sanitize(err);
    }
  } else {
    results["github_live_comment_and_labels"] = "FAIL";
    results["github_live_update_issue_close"] = "FAIL";
    diagnostics["issue_dependent_steps"] = "no_test_issue_created";
  }

  try {
    await transport.invoke("delete_branch", { repo, branch: testBranch }, token, ctx);
    log(`delete_branch: ${testBranch} slettet`);
    results["github_live_delete_branch"] = "PASS";
    results["github_live_cleanup"] = "PASS";
  } catch (err) {
    results["github_live_delete_branch"] = "FAIL";
    results["github_live_cleanup"] = "FAIL";
    diagnostics["delete_branch"] = sanitize(err);
  }

  results["github_live_secret_safety"] = logBuffer.some((line) => line.includes(token)) ? "FAIL" : "PASS";

  printSummary(repo);
}

function sanitize(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : "unknown_error";
}

function printSummary(repo: string): void {
  const hardFail = Object.values(results).includes("FAIL");
  console.log("\n=== UA-5 GitHub Developer Control Plane - LIVE ACCEPTANCE RESULTAT ===");
  console.log(`repo=${repo}`);
  for (const [key, value] of Object.entries(results)) {
    console.log(`${key}=${value}${diagnostics[key] ? ` (${diagnostics[key]})` : ""}`);
  }
  console.log(`hard_fail=${hardFail}`);
  console.log(`LIVE_PROVIDER_VERIFIED=${!hardFail && !Object.values(results).includes("BLOCKED_NO_CREDENTIALS")}`);
}

/** Kjøres scriptet direkte? `import.meta.url` er realpath, `process.argv[1]` er det som ble skrevet (kan gå via en symlinket mappe): sammenlign mot realpath, ellers blir `main()` en stille no-op med exit 0 (reviewer A delta N2). */
function isEntryPoint(): boolean {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error("UNEXPECTED_SCRIPT_FAILURE:", sanitize(err));
    process.exitCode = 1;
  });
}
