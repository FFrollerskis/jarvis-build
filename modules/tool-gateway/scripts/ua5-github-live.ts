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
// Kjøres: node --env-file=.env --experimental-transform-types modules/tool-gateway/scripts/ua5-github-live.ts [owner/repo]
// (default repo: CANONICAL_GITHUB_REPO i @jarvis/contracts - samme repo koden selv bor i, D-478/D-479)

import { CANONICAL_GITHUB_REPO } from "@jarvis/contracts";
import { GithubTransport } from "../src/live-transports.ts";

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

async function main(): Promise<void> {
  const repo = process.argv[2] ?? CANONICAL_GITHUB_REPO;
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

main().catch((err) => {
  console.error("UNEXPECTED_SCRIPT_FAILURE:", sanitize(err));
  process.exitCode = 1;
});
