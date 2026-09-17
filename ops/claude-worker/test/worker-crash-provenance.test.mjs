/**
 * D-136 process-level tests: THE CRASH WINDOW, through the ACTUAL worker
 * entrypoint, against a REAL git repository.
 *
 * ------------------------------------------------------------------------
 * THE WINDOW
 * ------------------------------------------------------------------------
 *
 * The worker's own ordering creates it, and it is not a legacy shape - it is
 * what the CURRENT version does on every dispatch:
 *
 *     persist IN_PROGRESS + child identity + durable claim   (before the spawn)
 *       -> the child runs, commits, and posts a TRUSTED STATUS=COMPLETE
 *         -> **THE PARENT DIES HERE**
 *           -> the post-dispatch provenance checkpoint         (never reached)
 *
 * The state row left behind therefore has a durable claim, a real isolated
 * worktree, a genuine trusted success report - and NO `commit_provenance` at
 * all, because the only place that field is ever written is the checkpoint the
 * parent never reached.
 *
 * D-135's gate read `task.commit_provenance` and passed on `null`, arguing that
 * a missing record meant "no attempt of this worker version produced one". On
 * the next run the crash-recovery path therefore marked the task COMPLETED and
 * SUCCESSFUL, emitted COMPLETION_CONFIRMED, released the worktree and let the
 * record retire strictly older tasks - regardless of what was actually in that
 * worktree. Every one of D-135's own assertions still passed, because all of
 * them exercised the POST-DISPATCH path, where a verdict always exists.
 *
 * ------------------------------------------------------------------------
 * WHY THIS TEST IS SHAPED THE WAY IT IS
 * ------------------------------------------------------------------------
 *
 * The parent is killed with SIGKILL at the real point, by the test, while a real
 * child has really posted a real report. The intruder is a real second git
 * identity committing into the real claimed worktree. Nothing about either half
 * is simulated, and no state row is hand-written: a hand-written row would only
 * prove that the assertion matches itself.
 *
 * The positive controls are not optional decoration. Without them every
 * assertion here would be satisfied by a worker that simply never completes
 * anything after a crash, which would be a different and equally serious bug.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadState, saveStateAtomic, TASK_STATUS } from "../lib/state.mjs";
import { isProcessAlive } from "../lib/procid.mjs";
import { readClaim, claimFilePath, taskWorktreePath, CLAIM_STATE } from "../lib/worktree.mjs";
import { COMMIT_PROVENANCE, COMPLETION_GATE, RECONCILE_PROVENANCE } from "../lib/provenance.mjs";
import { createRepo, statusLines, head, log, logBodies, git, foreignCommit } from "./fixtures/real-git-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "worker.mjs");
const FAKE_GH = join(HERE, "fixtures", "fake-gh.mjs");
const FAKE_CLAUDE = join(HERE, "fixtures", "fake-claude.mjs");

const TRUSTED = "tsworkflow";
const TASK_A = "D136-CRASH-WINDOW-20260912-A";
const TASK_OLDER = "D136-OLDER-TASK-20260912-B";

let dir;
let workerRoot;
let repoPath;
let ghDir;
let claudeDir;
let configPath;
let worktreeRoot;
let baseline;
let stray;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-d136-"));
  workerRoot = join(dir, "worker");
  repoPath = join(dir, "repo");
  ghDir = join(dir, "gh");
  claudeDir = join(dir, "claude");
  worktreeRoot = join(workerRoot, "worktrees");
  for (const d of [workerRoot, ghDir, claudeDir, join(workerRoot, "logs"), worktreeRoot]) {
    mkdirSync(d, { recursive: true });
  }
  stray = [];

  ({ baseline } = createRepo(repoPath));

  configPath = join(workerRoot, "config.json");
  writeFileSync(configPath, JSON.stringify({
    repoOwner: "tsworkflow",
    repoName: "jarvisbuild",
    controlIssue: 68,
    trustedAuthor: TRUSTED,
    repoPath,
    claudeCommand: process.execPath,
    claudeArgs: [FAKE_CLAUDE],
    promptDelivery: "stdin",
    claudeTimeoutMinutes: 5,
    heartbeatSeconds: 5,
    heartbeatTimeoutMinutes: 15,
    logDir: join(workerRoot, "logs"),
    healthFile: join(workerRoot, "logs", "health.jsonl"),
    stateFile: join(workerRoot, "state.json"),
    stateBackupFile: join(workerRoot, "state.json.bak"),
    lockFile: join(workerRoot, ".worker.lock"),
    disabledFlagFile: join(workerRoot, "disabled.flag"),
    postedStatusFile: join(workerRoot, "logs", "posted-status.jsonl"),
    scratchRoot: join(workerRoot, "tmp"),
    quarantineRoot: join(workerRoot, "tmp", "quarantine"),
    manifestFile: join(workerRoot, "logs", "quarantine-manifest.jsonl"),
    worktreeRoot,
    // D-166: an ISOLATED admission ledger. The default root is derived from
    // repoOwner/repoName/controlIssue - which this fixture sets to the REAL
    // tsworkflow/jarvisbuild issue 68 - so without this every test would share
    // one host-global ledger with each other AND with the live worker, and the
    // first terminalised task id would refuse every later test that reuses it.
    admissionRoot: join(workerRoot, "admission"),
    maxAttempts: 6,
    backoffBaseMinutes: 1,
    backoffMaxHours: 1,
    statusRepeatHours: 6,
    malformedLockGraceSeconds: 5
  }, null, 2), "utf8");

  writeFileSync(join(ghDir, "branches.json"), JSON.stringify(["main"]), "utf8");
  writeFileSync(join(ghDir, "pulls.json"), JSON.stringify([]), "utf8");
  setComments([]);
});

afterEach(() => {
  for (const pid of stray) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

/** ---------------- helpers ---------------- */

function architectTask(taskId, createdAt, id) {
  return {
    id,
    created_at: createdAt,
    updated_at: createdAt,
    author_association: "OWNER",
    user: { login: TRUSTED },
    body: `ARCHITECT_TASK\nTASK_ID=${taskId}\nDo the thing.`
  };
}

function setComments(list) {
  writeFileSync(join(ghDir, "comments.json"), JSON.stringify(list, null, 2), "utf8");
}

function comments() {
  return JSON.parse(readFileSync(join(ghDir, "comments.json"), "utf8"));
}

function appendComment(c) {
  setComments([...comments(), c]);
}

function workerEnv(mode, extraEnv) {
  return {
    ...process.env,
    JARVIS_WORKER_CONFIG: configPath,
    JARVIS_WORKER_GH: FAKE_GH,
    JARVIS_FAKE_GH_DIR: ghDir,
    JARVIS_FAKE_GH_AUTHOR: TRUSTED,
    JARVIS_FAKE_CLAUDE_DIR: claudeDir,
    JARVIS_FAKE_CLAUDE_MODE: mode,
    ...extraEnv
  };
}

/**
 * Drive the real entrypoint. `JARVIS_WORKER_GIT` is deliberately NOT set, so the
 * worker calls the real git binary against the real fixture repository.
 */
function startWorker(mode, extraEnv = {}) {
  const child = spawn(process.execPath, [WORKER, "run"], {
    env: workerEnv(mode, extraEnv),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return {
    child,
    output: () => out,
    exited: new Promise((r) => child.on("close", (code) => r(code)))
  };
}

function runWorker(mode, extraEnv = {}) {
  const handle = startWorker(mode, extraEnv);
  return handle.exited.then((code) => ({ code, output: handle.output() }));
}

function state() {
  return loadState(join(workerRoot, "state.json"), join(workerRoot, "state.json.bak"), { schema: "worker" }).state;
}

function task(id) {
  return state()?.tasks?.[id] ?? null;
}

function claim(taskId) {
  return readClaim(claimFilePath(worktreeRoot, taskId));
}

function wt(taskId) {
  return taskWorktreePath(worktreeRoot, taskId);
}

function dispatched() {
  const path = join(claudeDir, "dispatched.log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function healthEvents() {
  const path = join(workerRoot, "logs", "health.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function statusComments() {
  return comments().filter((c) => String(c.body ?? "").includes("REASON="));
}

async function waitForFile(path, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitUntil(predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for a condition");
}

/**
 * Reproduce the kill window EXACTLY.
 *
 * `report-hang` posts a genuine trusted CLAUDE_REPORT and then stays alive, so
 * there is a real interval in which the report exists and the parent has not yet
 * reached its post-dispatch checkpoint. The parent is SIGKILLed inside it.
 *
 * Returns once the parent is gone AND the child is proven gone, so the recovery
 * path under test is the ordinary one rather than the live-child protection.
 */
async function crashAfterReportBeforeCheckpoint(extraEnv = {}) {
  const handle = startWorker("report-hang", extraEnv);
  await waitForFile(join(claudeDir, "report-posted"));

  handle.child.kill("SIGKILL");
  await handle.exited;

  const childPid = Number(readFileSync(join(claudeDir, "child.pid"), "utf8"));
  stray.push(childPid);
  try { process.kill(childPid, "SIGKILL"); } catch { /* may already be gone */ }
  await waitUntil(() => !isProcessAlive(childPid));
  return { childPid, output: handle.output() };
}

/** ---------------- the window is real ---------------- */

describe("D-136: the crash window leaves a trusted success claim with NO verdict", () => {
  it("is exactly the shape the gate used to pass: claim + worktree + report, no provenance", async () => {
    setComments([architectTask(TASK_A, "2026-09-12T05:00:00Z", 1)]);
    await crashAfterReportBeforeCheckpoint({ JARVIS_FAKE_CLAUDE_MUTATE: "" });

    // The parent died before it could record ANY outcome for the attempt.
    const rec = task(TASK_A);
    expect(rec.status).toBe(TASK_STATUS.IN_PROGRESS);
    expect(rec.commit_provenance).toBeUndefined();
    expect(rec.head_after).toBeUndefined();
    // ...but everything it writes BEFORE the spawn is durably there.
    expect(rec.child_identity).toBeTruthy();
    expect(rec.worktree_path).toBe(resolve(wt(TASK_A)));
    expect(claim(TASK_A).claim.state).toBe(CLAIM_STATE.READY);
    expect(existsSync(wt(TASK_A))).toBe(true);

    // And the success claim is genuine, trusted, and already on the issue.
    const posted = comments().filter((c) => String(c.body ?? "").startsWith("CLAUDE_REPORT"));
    expect(posted).toHaveLength(1);
    expect(posted[0].user.login).toBe(TRUSTED);
    expect(posted[0].body).toContain(`TASK_ID=${TASK_A}`);
    expect(posted[0].body).toContain("STATUS=COMPLETE");
  }, 300_000);
});

/** ---------------- the adversarial regression ---------------- */

describe("D-136: a foreign writer in the crash window is NOT laundered into a success", () => {
  /** Crash in the window, then let an unrelated writer advance the claimed HEAD. */
  async function crashThenForeignCommit() {
    setComments([architectTask(TASK_A, "2026-09-12T05:00:00Z", 1)]);
    await crashAfterReportBeforeCheckpoint({ JARVIS_FAKE_CLAUDE_MUTATE: "" });
    expect(task(TASK_A).commit_provenance).toBeUndefined();

    // The intruder: a different git identity, a file the child never touches,
    // committing into the task's own claimed worktree while nothing is running.
    const foreign = foreignCommit(wt(TASK_A));
    expect(head(wt(TASK_A))).toBe(foreign);
    return foreign;
  }

  it("restarts BLOCKED and successful:false, and never marks the task complete", async () => {
    const foreign = await crashThenForeignCommit();

    const res = await runWorker("silent");

    expect(res.code).toBe(3); // EXIT.BLOCKED - the run does not claim to be healthy
    const rec = task(TASK_A);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.status).not.toBe(TASK_STATUS.COMPLETED);
    // Positively false, not merely absent: the queue's supersession rule demands
    // a positive `true`, so an absent field must never drift into meaning success.
    expect(rec.successful).toBe(false);
    expect(rec.completed_at).toBeUndefined();

    // The gate is recorded durably, with the evidence that produced it - and the
    // verdict was DERIVED here, because no attempt ever recorded one.
    expect(rec.completion_gate.held).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_PROVENANCE_UNVERIFIED);
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(rec.completion_gate.unattributed_commits).toEqual([foreign]);
    expect(rec.completion_gate.report_status).toBe("COMPLETE");
    expect(rec.reconciliation_provenance.derived_for_reconciliation).toBe(true);
    expect(rec.reconciliation_provenance.verified).toBe(false);
    expect(rec.reconciliation_provenance.head_now).toBe(foreign);

    // It was not re-dispatched either: a second child on top of commits nobody
    // has accounted for is exactly what must not happen.
    expect(dispatched().filter((d) => d === TASK_A)).toHaveLength(1);
  }, 300_000);

  it("emits no completion-confirmed event, and makes the refusal visible instead", async () => {
    await crashThenForeignCommit();
    await runWorker("silent");

    const events = healthEvents();
    // The decisive negative: nothing in the health journal says this completed.
    expect(events.filter((e) => e.event === "completion_confirmed" && e.task_id === TASK_A)).toEqual([]);

    const blocked = events.filter((e) => e.event === "blocked" && e.reason === "completion_gate_held");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].task_id).toBe(TASK_A);
    expect(blocked[0].verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    // Not retryable: the work may already have landed.
    expect(blocked[0].retryable).toBe(false);

    const notice = statusComments().find((c) => c.body.includes("completion_gate_held"));
    expect(notice).toBeTruthy();
    expect(notice.body).toContain("claims SUCCESSFUL completion");
    expect(notice.body).toContain("did NOT release or remove");
    expect(notice.body).toContain("did NOT let this record retire (supersede) any older task");
  }, 300_000);

  it("releases, removes and destroys NOTHING: claim, worktree, commit and file all survive", async () => {
    const foreign = await crashThenForeignCommit();
    const filesBefore = statusLines(wt(TASK_A));

    await runWorker("silent");

    // The worktree was NOT released - the concrete difference the gate makes,
    // because a successful completion would have removed this directory.
    expect(existsSync(wt(TASK_A))).toBe(true);
    expect(git(repoPath, ["worktree", "list", "--porcelain"])).toContain(wt(TASK_A).replace(/\\/g, "/"));

    // The claim is intact, still READY, and was never marked released.
    const c = claim(TASK_A);
    expect(c.ok).toBe(true);
    expect(c.claim.state).toBe(CLAIM_STATE.READY);
    expect(c.claim.released_at ?? null).toBeNull();
    expect(c.claim.task_id).toBe(TASK_A);

    // The foreign commit is exactly where the intruder left it, still reachable,
    // and the file it introduced is untouched.
    expect(head(wt(TASK_A))).toBe(foreign);
    expect(git(wt(TASK_A), ["cat-file", "-t", foreign])).toBe("commit");
    expect(log(wt(TASK_A))).toHaveLength(2);
    expect(existsSync(join(wt(TASK_A), "unrelated-writer.txt"))).toBe(true);
    expect(statusLines(wt(TASK_A))).toEqual(filesBefore);

    // And nothing reached the user's checkout at any point.
    expect(statusLines(repoPath)).toEqual([]);
    expect(head(repoPath)).toBe(baseline);
  }, 300_000);

  it("the parked record cannot retire older valid work", async () => {
    await crashThenForeignCommit();
    await runWorker("silent");
    expect(task(TASK_A).completion_gate.held).toBe(true);

    // A strictly OLDER order that has never run. Before D-136 the fresh
    // STATUS=COMPLETE report made TASK_A count as "completed successfully", so
    // this older task was retired as stale - work the architect asked for,
    // discarded on the strength of a commit range nobody could account for.
    appendComment(architectTask(TASK_OLDER, "2026-09-12T04:00:00Z", 2));
    await runWorker("silent");

    expect(dispatched()).toContain(TASK_OLDER);
    const older = task(TASK_OLDER);
    expect(older.status).not.toBe(TASK_STATUS.SUPERSEDED);
    expect(older.superseded_by ?? null).toBeNull();

    // The held task was not touched again, and still never completed.
    expect(dispatched().filter((d) => d === TASK_A)).toHaveLength(1);
    expect(task(TASK_A).status).toBe(TASK_STATUS.BLOCKED);
    expect(task(TASK_A).successful).toBe(false);
    expect(claim(TASK_A).claim.state).toBe(CLAIM_STATE.READY);
    expect(healthEvents().filter((e) => e.event === "completion_confirmed" && e.task_id === TASK_A)).toEqual([]);
  }, 300_000);

  it("a commit with NO evidence trailers is refused in the crash window too", async () => {
    // Not an intruder this time - the worker's OWN child, which really did the
    // work and then failed to stamp it. Fail-closed means this is unknown, not
    // waved through because "it was probably ours". The work is still preserved.
    setComments([architectTask(TASK_A, "2026-09-12T05:00:00Z", 1)]);
    await crashAfterReportBeforeCheckpoint({
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1",
      JARVIS_FAKE_CLAUDE_NO_TRAILER: "1"
    });
    const committed = head(wt(TASK_A));
    expect(committed).not.toBe(baseline);

    const res = await runWorker("silent");

    expect(res.code).toBe(3);
    const rec = task(TASK_A);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.successful).toBe(false);
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    // Preserved regardless: unverified is not unwanted.
    expect(head(wt(TASK_A))).toBe(committed);
    expect(existsSync(wt(TASK_A))).toBe(true);
  }, 300_000);
});

/** ---------------- the positive controls ---------------- */

describe("D-136 CONTROL: a legitimate crash window still reconciles without a re-dispatch", () => {
  it("(a) an UNCHANGED head with a trusted COMPLETE completes normally", async () => {
    // Nobody touched the worktree at all, so there was never an authorship
    // question. Without this control, every assertion above would be satisfied
    // by a worker that simply never completes anything after a crash.
    setComments([architectTask(TASK_A, "2026-09-12T05:00:00Z", 1)]);
    await crashAfterReportBeforeCheckpoint({ JARVIS_FAKE_CLAUDE_MUTATE: "" });
    expect(head(wt(TASK_A))).toBe(baseline);

    const res = await runWorker("silent");

    expect(res.code).toBe(0);
    const rec = task(TASK_A);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.completed_at).toBeTruthy();
    expect(rec.reconciled_without_redispatch).toBe(true);
    expect(rec.recovered_from_crash).toBe(true);
    expect(rec.completion_gate.held).toBe(false);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    expect(rec.reconciliation_provenance.verdict).toBe(COMMIT_PROVENANCE.UNCHANGED);

    // Closed out WITHOUT a second dispatch, and confirmed in the journal.
    expect(dispatched().filter((d) => d === TASK_A)).toHaveLength(1);
    expect(healthEvents().some((e) => e.event === "completion_confirmed" && e.task_id === TASK_A)).toBe(true);
  }, 300_000);

  it("(b) a FULLY trailer-attributed range with a trusted COMPLETE completes normally", async () => {
    // The well-behaved child: it committed real work and stamped the task and
    // attempt trailers the worker issued to it alone. That is what makes the
    // commit provably its own rather than merely concurrent with it.
    setComments([architectTask(TASK_A, "2026-09-12T05:00:00Z", 1)]);
    await crashAfterReportBeforeCheckpoint({
      JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
      JARVIS_FAKE_CLAUDE_COMMIT: "1"
    });

    const committed = head(wt(TASK_A));
    expect(committed).not.toBe(baseline);
    expect(logBodies(wt(TASK_A))[0].message).toContain(`Jarvis-Task-Id: ${TASK_A}`);
    expect(task(TASK_A).commit_provenance).toBeUndefined(); // still no recorded verdict

    const res = await runWorker("silent");

    expect(res.code).toBe(0);
    const rec = task(TASK_A);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.completion_gate.held).toBe(false);
    expect(rec.reconciliation_provenance.verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
    expect(rec.reconciliation_provenance.attributed_commits.map((c) => c.sha)).toEqual([committed]);
    // The attempt id in the evidence is one the claim actually issued.
    expect(claim(TASK_A).claim.attempts.map((a) => a.attempt_id))
      .toContain(rec.reconciliation_provenance.attributed_commits[0].attempt_id);

    expect(dispatched().filter((d) => d === TASK_A)).toHaveLength(1);
    expect(healthEvents().some((e) => e.event === "completion_confirmed" && e.task_id === TASK_A)).toBe(true);
    // A successful terminal reconciliation on a clean worktree releases it, and
    // keeps the claim as evidence of what ran there.
    expect(existsSync(wt(TASK_A))).toBe(false);
    expect(claim(TASK_A).claim.state).toBe(CLAIM_STATE.RELEASED);
  }, 300_000);
});

/**
 * MIGRATION. The same refusal must apply to rows written by older workers, and
 * for the same reason: absence of a verdict is absence of evidence, not proof.
 */
describe("D-136 MIGRATION: legacy rows never gain trust from a missing verdict", () => {
  it("a pre-D-133 row with no claim behind it is parked, not completed", async () => {
    setComments([architectTask(TASK_A, "2026-09-12T05:00:00Z", 1)]);
    await crashAfterReportBeforeCheckpoint({ JARVIS_FAKE_CLAUDE_MUTATE: "" });

    // Strip the isolation a pre-D-133 worker never created. What is left is
    // exactly that worker's shape: a dispatched task, a trusted COMPLETE report,
    // and nothing that could attribute a single commit to it.
    git(repoPath, ["worktree", "remove", wt(TASK_A)]);
    rmSync(claimFilePath(worktreeRoot, TASK_A), { force: true });

    const res = await runWorker("silent");

    expect(res.code).toBe(3);
    const rec = task(TASK_A);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.successful).toBe(false);
    expect(rec.completed_at).toBeUndefined();
    expect(rec.completion_gate.held).toBe(true);
    expect(rec.reconciliation_provenance.verdict).toBe(COMMIT_PROVENANCE.UNKNOWN);
    expect(rec.reconciliation_provenance.derivation_state).toBe(RECONCILE_PROVENANCE.CLAIM_MISSING);
    expect(healthEvents().filter((e) => e.event === "completion_confirmed" && e.task_id === TASK_A)).toEqual([]);
  }, 300_000);

  it("a pre-D-134 row with a raw head_after and no verdict is parked, not completed", async () => {
    setComments([architectTask(TASK_A, "2026-09-12T05:00:00Z", 1)]);
    await crashAfterReportBeforeCheckpoint({ JARVIS_FAKE_CLAUDE_MUTATE: "" });

    // A pre-D-134 worker recorded the head pair and never asked the authorship
    // question at all. The ref really did move - by a hand no worker can see.
    const foreign = foreignCommit(wt(TASK_A));
    const s = state();
    s.tasks[TASK_A].head_after = foreign;
    delete s.tasks[TASK_A].commit_provenance;
    saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });

    await runWorker("silent");

    const rec = task(TASK_A);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.successful).toBe(false);
    // The observation is not read as authorship, now or ever.
    expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.UNATTRIBUTED);
    expect(rec.completion_gate.unattributed_commits).toEqual([foreign]);
    expect(existsSync(join(wt(TASK_A), "unrelated-writer.txt"))).toBe(true);
  }, 300_000);
});

/* ==========================================================================
 * D-139 B: EN SKITTEN TASK-WORKTREE ER IKKE EN FULLFOERT TASK
 * ==========================================================================
 *
 * D-136 lukket forfatterskaps-spoersmaalet: er disse commitene vaare? Det
 * besvarer ikke det andre spoersmaalet en suksess-paastand hviler paa: ER
 * arbeidet i det hele tatt committet? Et barn kan committe helt korrekt,
 * etterlate ukommittert arbeid i sin egen claimede worktree, og likevel poste
 * en fullstendig ekte, fullstendig betrodd `STATUS=COMPLETE`.
 *
 * Testene under bruker EKTE repo, EKTE worker-entrypoint og et EKTE barn som
 * committer med riktige trailere OG lar noe ligge igjen. Proveniensen er da
 * verifisert - det er nettopp poenget: uten renhetsporten ville disse blitt
 * akseptert som vellykket fullfoering.
 */
describe("D-139 B: fullfoering krever BAADE bevist proveniens OG en ren worktree", () => {
  beforeEach(() => {
    setComments([architectTask(TASK_A, "2026-09-12T10:00:00Z", 9101)]);
  });

  const committing = (dirtyAfter) => ({
    JARVIS_FAKE_CLAUDE_MUTATE: "tracked",
    JARVIS_FAKE_CLAUDE_COMMIT: "1",
    ...(dirtyAfter ? { JARVIS_FAKE_CLAUDE_DIRTY_AFTER_COMMIT: dirtyAfter } : {})
  });

  it("POSITIV KONTROLL: committer rent => akseptert som vellykket fullfoert", async () => {
    await runWorker("report", committing(null));

    const rec = task(TASK_A);
    expect(rec.status).toBe(TASK_STATUS.COMPLETED);
    expect(rec.successful).toBe(true);
    expect(rec.completion_gate.held).toBe(false);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.PASSED_PROVENANCE_VERIFIED);
    // Renheten er positivt registrert, ikke utelatt.
    expect(rec.completion_gate.worktree_verdict).toBe("clean");
    expect(rec.completion_gate.worktree_entry_count).toBe(0);
    expect(healthEvents().some((e) => e.event === "completion_confirmed")).toBe(true);
  }, 300_000);

  for (const [label, dirtyAfter] of [["UTRACKED", "untracked"], ["TRACKED", "tracked"], ["BEGGE", "both"]]) {
    it(`${label} ukommittert arbeid igjen i worktreen => HOLDT, aldri fullfoert`, async () => {
      await runWorker("report", committing(dirtyAfter));

      const rec = task(TASK_A);
      // Proveniensen er FAKTISK verifisert - det er dette som gjoer testen skarp.
      expect(rec.completion_gate.provenance_verdict).toBe(COMMIT_PROVENANCE.ATTRIBUTED);
      // ...og likevel holdes den, paa renhets-halvparten.
      expect(rec.completion_gate.held).toBe(true);
      expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_WORKTREE_DIRTY);
      expect(rec.completion_gate.worktree_verdict).toBe("dirty");
      expect(rec.completion_gate.worktree_entry_count).toBeGreaterThan(0);

      expect(rec.status).toBe(TASK_STATUS.BLOCKED);
      expect(rec.successful).toBe(false);
      expect(rec.completed_at ?? null).toBe(null);
      expect(healthEvents().some((e) => e.event === "completion_confirmed")).toBe(false);

      // Ingenting ble ryddet, frigjort eller kastet.
      expect(existsSync(wt(TASK_A))).toBe(true);
      expect(claim(TASK_A).ok).toBe(true);
      expect(statusLines(wt(TASK_A)).length).toBeGreaterThan(0);
    }, 300_000);
  }

  it("en worktree vi IKKE kan lese er UKJENT - aldri ren", async () => {
    // Kjoer foerst normalt, saa vi har en claim og en ekte worktree.
    await runWorker("report", committing(null));
    expect(task(TASK_A).status).toBe(TASK_STATUS.COMPLETED);

    // Tilbakestill tasken og fjern worktreen under foettene paa den: statusen
    // kan da ikke besvares, og porten maa behandle det som ukjent.
    const s = state();
    s.tasks[TASK_A] = {
      ...s.tasks[TASK_A],
      status: TASK_STATUS.IN_PROGRESS,
      successful: false,
      completed_at: null,
      completion_gate: null
    };
    saveStateAtomic(join(workerRoot, "state.json"), s, join(workerRoot, "state.json.bak"), { schema: "worker" });
    rmSync(wt(TASK_A), { recursive: true, force: true });

    await runWorker("silent");

    const rec = task(TASK_A);
    expect(rec.successful).toBe(false);
    expect(rec.status).not.toBe(TASK_STATUS.COMPLETED);
  }, 300_000);

  it("KRASJVINDUET: barnet committer, lar noe ligge igjen, forelderen doer - restart godtar ALDRI", async () => {
    await crashAfterReportBeforeCheckpoint(committing("untracked"));

    // Ingen provenance-checkpoint ble naadd; rekonsiliasjonsveien maa svare paa
    // BEGGE spoersmaalene paa nytt, og renheten feller den.
    await runWorker("silent");

    const rec = task(TASK_A);
    expect(rec.status).toBe(TASK_STATUS.BLOCKED);
    expect(rec.successful).toBe(false);
    expect(rec.completed_at ?? null).toBe(null);
    expect(rec.completion_gate.held).toBe(true);
    expect(rec.completion_gate.reason).toBe(COMPLETION_GATE.HELD_WORKTREE_DIRTY);
    expect(existsSync(wt(TASK_A))).toBe(true);
    expect(claim(TASK_A).ok).toBe(true);
  }, 300_000);

  it("TRE restarts etter et holdt gate: ingen gjenoppstandelse, ingen ny dispatch", async () => {
    await runWorker("report", committing("untracked"));
    expect(task(TASK_A).status).toBe(TASK_STATUS.BLOCKED);

    const dispatchedBefore = dispatched().length;
    for (let i = 0; i < 3; i++) {
      await runWorker("silent");
      const rec = task(TASK_A);
      expect(rec.status).toBe(TASK_STATUS.BLOCKED);
      expect(rec.successful).toBe(false);
      expect(rec.completed_at ?? null).toBe(null);
    }
    // DUPLICATE_DISPATCH = 0.
    expect(dispatched().length).toBe(dispatchedBefore);
    expect(existsSync(wt(TASK_A))).toBe(true);
    expect(claim(TASK_A).ok).toBe(true);
  }, 600_000);

  it("en holdt task kan ikke pensjonere en eldre task", async () => {
    await runWorker("report", committing("untracked"));
    expect(task(TASK_A).completion_gate.held).toBe(true);
    const older = task(TASK_OLDER);
    if (older) expect(older.status).not.toBe(TASK_STATUS.SUPERSEDED);
  }, 300_000);
});
