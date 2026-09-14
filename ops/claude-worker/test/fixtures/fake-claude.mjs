/**
 * Stand-in for the Claude CLI child, used by the worker integration test.
 *
 * It records every invocation (so the test can prove a task was never
 * dispatched twice), and it can behave like a child that:
 *   - hangs forever             (mode=hang)         - the live-orphan case
 *   - posts a report then hangs (mode=report-hang)  - the crash-after-report case
 *   - posts a report and exits  (mode=report)       - the happy path
 *   - exits non-zero            (mode=fail)
 *   - posts a report, stays alive for JARVIS_FAKE_CLAUDE_LINGER_MS, then exits 0
 *     (mode=report-slow) - a child that outlives at least one heartbeat interval,
 *     which is the only way to reach the PERIODIC heartbeat callback through the
 *     real entrypoint (D126 review F)
 *   - exits 0 posting NOTHING  (mode=silent)  - D132: the "exit 0 without a
 *     matching report" case, which is how every D-131 attempt actually ended.
 *     `fail` cannot stand in for it: a non-zero exit takes a different path.
 *   - posts NOTHING, stays alive for JARVIS_FAKE_CLAUDE_LINGER_MS, then exits 0
 *     (mode=silent-slow) - D-134: the same "exit 0 without a report" case, but
 *     with a real, observable window in which the attempt is genuinely RUNNING.
 *     That window is what lets a test act as an UNRELATED WRITER and move the
 *     worktree's HEAD mid-attempt, which is the whole point of the adversarial
 *     provenance test. A `running` marker is written as soon as the child has
 *     started working, so the test synchronises on fact rather than on a sleep.
 *
 * D-134 commit evidence: when this child commits, it stamps the task/attempt
 * trailers onto the commit exactly as the real child is instructed to, reading
 * them from the environment the worker set. `JARVIS_FAKE_CLAUDE_NO_TRAILER=1`
 * makes it FORGET them - the "well-behaved child" and the "forgetful child" must
 * both be expressible, because they are supposed to lead to different verdicts.
 *
 * It deliberately keeps running when its parent is killed, which is exactly the
 * situation the worker must survive without starting a second Claude. That means
 * it must tolerate its stdio pipes being torn down mid-flight, so every stream
 * gets an error handler; without them a broken pipe kills the child and the
 * live-orphan case can never be exercised at all.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DIR = process.env.JARVIS_FAKE_CLAUDE_DIR;
const MODE = process.env.JARVIS_FAKE_CLAUDE_MODE ?? "report";
const GH_DIR = process.env.JARVIS_FAKE_GH_DIR;

/**
 * D132: when no TASK_ID is pinned, report for the task we were ACTUALLY given.
 *
 * A fixture that always reports for one env-configured id cannot express a queue
 * with more than one task in it, so it could never have reproduced the D-131
 * selection defect (older task dispatched instead of the newer one). Reading the
 * id out of the delivered prompt is also what the real child does.
 */
function taskIdFrom(prompt) {
  const pinned = process.env.JARVIS_FAKE_CLAUDE_TASK_ID;
  if (pinned) return pinned;
  const m = String(prompt ?? "").match(/^TASK_ID=(.*)$/m);
  return m ? m[1].trim() : "UNKNOWN";
}

process.stdin.on("error", () => {});
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

appendFileSync(join(DIR, "invocations.log"), `${new Date().toISOString()} pid=${process.pid} mode=${MODE}\n`, "utf8");
writeFileSync(join(DIR, "child.pid"), String(process.pid), "utf8");
// D126 addendum item 4: the command line this child was CREATED with, recorded
// before it reads anything. It is the evidence that the task never travels in
// argv - where the child could consume it before the handoff gate has run.
writeFileSync(join(DIR, "argv.json"), JSON.stringify(process.argv), "utf8");

const hangs = MODE === "hang" || MODE === "report-hang";
// A bounded version of "hang": long enough for a periodic heartbeat to fire,
// short enough that the dispatch still settles on its own.
const lingers = MODE === "report-slow" || MODE === "silent-slow";
const reports = MODE === "report" || MODE === "report-hang" || MODE === "report-slow";
const LINGER_MS = Number(process.env.JARVIS_FAKE_CLAUDE_LINGER_MS ?? 8000);
let keepAlive = null;
if (hangs) {
  // Announce liveness immediately so the test can grab the pid and kill the
  // PARENT while this process is genuinely mid-run.
  writeFileSync(join(DIR, "running"), String(process.pid), "utf8");
  keepAlive = setInterval(() => {}, 1000);
}

let prompt = "";
process.stdin.on("data", (d) => { prompt += d; });

/**
 * D-133: make REAL repository changes in whatever directory this child was
 * given as its cwd.
 *
 * The isolation tests need a child that behaves like the real one - it edits
 * tracked files, creates untracked files and sometimes commits - because the
 * whole property under test is "where did those changes land, and who owns
 * them". A child that only ever posts comments cannot exercise it at all.
 *
 *   JARVIS_FAKE_CLAUDE_MUTATE=tracked,untracked   which mutations to make
 *   JARVIS_FAKE_CLAUDE_COMMIT=1                   also commit what it did
 *
 * cwd is used deliberately and not a configured path: if the worker ever
 * dispatched a child into the wrong directory, these writes would land there,
 * and the tests assert on exactly that.
 */
function mutateWorkspace(taskId) {
  const kinds = String(process.env.JARVIS_FAKE_CLAUDE_MUTATE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (kinds.length === 0) return;
  const cwd = process.cwd();
  const made = [];

  if (kinds.includes("tracked")) {
    // `tracked.txt` exists in the baseline commit, so appending to it is a
    // MODIFICATION of a tracked file - the case quarantine may never touch.
    const file = join(cwd, "tracked.txt");
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    writeFileSync(file, `${before}edited by ${taskId} at ${new Date().toISOString()}\n`, "utf8");
    made.push("tracked.txt");
  }
  if (kinds.includes("untracked")) {
    const name = `work-${taskId}.md`;
    writeFileSync(join(cwd, name), `# work in progress for ${taskId}\n`, "utf8");
    made.push(name);
  }

  if (process.env.JARVIS_FAKE_CLAUDE_COMMIT === "1") {
    const run = (args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    run(["add", "-A"]);
    // D-134: the evidence trailers the worker requires, taken from the exact
    // values the worker exported for THIS attempt. A fixture that invented its
    // own values would prove nothing, and one that never stamped them could not
    // express the well-behaved child at all.
    const attemptId = process.env.JARVIS_TASK_ATTEMPT_ID ?? "";
    const stampedTaskId = process.env.JARVIS_TASK_ID ?? taskId;
    const trailers = process.env.JARVIS_FAKE_CLAUDE_NO_TRAILER === "1" || !attemptId
      ? ""
      : `\n\nJarvis-Task-Id: ${stampedTaskId}\nJarvis-Attempt-Id: ${attemptId}\n`;
    run(["-c", "user.email=fake@example.invalid", "-c", "user.name=fake-claude",
      "commit", "-m", `work for ${taskId}${trailers}`]);
    const head = run(["rev-parse", "HEAD"]);
    try {
      appendFileSync(join(DIR, "commits.log"), `${taskId} ${String(head.stdout ?? "").trim()}\n`, "utf8");
    } catch { /* best effort */ }

    /**
     * D-139 B: commit properly, THEN leave work behind uncommitted.
     *
     * This is the state the dirty-completion gate exists for, and it is the one
     * shape the existing fixture could not express: commit provenance verifies
     * perfectly - the commits really are this task's own, correctly trailered -
     * while the worktree still holds work that was never committed at all. A
     * `STATUS=COMPLETE` posted from here is a claim the repository itself
     * contradicts.
     *
     *   JARVIS_FAKE_CLAUDE_DIRTY_AFTER_COMMIT=tracked|untracked|both
     */
    const dirtyAfter = String(process.env.JARVIS_FAKE_CLAUDE_DIRTY_AFTER_COMMIT ?? "").trim();
    if (dirtyAfter) {
      if (dirtyAfter === "tracked" || dirtyAfter === "both") {
        const file = join(cwd, "tracked.txt");
        const before = existsSync(file) ? readFileSync(file, "utf8") : "";
        writeFileSync(file, `${before}uncommitted tail for ${taskId}\n`, "utf8");
      }
      if (dirtyAfter === "untracked" || dirtyAfter === "both") {
        writeFileSync(join(cwd, `leftover-${taskId}.tmp`), "never committed\n", "utf8");
      }
    }
  }

  try {
    appendFileSync(join(DIR, "mutations.log"), `${taskId} ${cwd} ${made.join(",")}\n`, "utf8");
  } catch { /* best effort */ }
}

let acted = false;
function act() {
  if (acted) return;
  acted = true;
  try { writeFileSync(join(DIR, "prompt.txt"), prompt, "utf8"); } catch { /* best effort */ }
  // Every prompt this child has ever been handed, so a test can assert what a
  // RESUMED attempt was told - `prompt.txt` only ever holds the latest one.
  try {
    appendFileSync(join(DIR, "prompts.jsonl"), JSON.stringify({ cwd: process.cwd(), prompt }) + "\n", "utf8");
  } catch { /* best effort */ }
  try { mutateWorkspace(taskIdFrom(prompt)); } catch { /* best effort */ }
  // D132: which TASK_ID this invocation was actually handed. This is the
  // evidence a queue-ordering test needs - "was the old task dispatched again?"
  // cannot be answered from an invocation count alone.
  try {
    appendFileSync(join(DIR, "dispatched.log"), `${taskIdFrom(prompt)}\n`, "utf8");
  } catch { /* best effort */ }

  if (MODE === "fail") {
    process.exit(7);
  }
  if (MODE === "silent") {
    // Exit 0 having posted nothing at all. The worker must NOT read this as
    // success - requirement B - and must park the task as retryable.
    process.exit(0);
  }
  if (reports) {
    postReport();
  }
  // D-134: announce that the attempt is genuinely RUNNING, after this child has
  // done its own work. A test acting as an unrelated writer synchronises on
  // this, so the foreign mutation provably lands INSIDE the attempt window and
  // after the child's own changes - not before, and not in a race.
  if (lingers) {
    try { writeFileSync(join(DIR, "running"), String(process.pid), "utf8"); } catch { /* best effort */ }
  }
  if (lingers) {
    // Stay alive on purpose. The report is already posted and the exit will be
    // a clean 0, so the worker has every reason to call the run healthy - which
    // is exactly what must NOT happen when its own heartbeat broke meanwhile.
    setTimeout(() => process.exit(0), LINGER_MS);
    return;
  }
  if (!hangs) {
    process.exit(0);
  }
}

function postReport() {
  const taskId = taskIdFrom(prompt);
  const path = join(GH_DIR, "comments.json");
  const comments = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const now = new Date().toISOString();
  comments.push({
    id: 800000 + comments.length,
    body: [
      "CLAUDE_REPORT",
      `TASK_ID=${taskId}`,
      // D132: the default is the spelling the REAL child actually posts.
      //
      // This fixture used to hard-code `STATUS=COMPLETED`, a spelling Claude
      // does not use, which is why 428 green tests coexisted with a worker that
      // could not recognise a single real completion report. The host's own
      // state.json recorded the consequence verbatim:
      //   "exit_0_without_matching_report (report_status_not_terminal (COMPLETE))"
      // A fixture that speaks a dialect the production child does not speak
      // proves nothing about production.
      `STATUS=${process.env.JARVIS_FAKE_CLAUDE_STATUS ?? "COMPLETE"}`,
      `BRANCH=${process.env.JARVIS_FAKE_CLAUDE_BRANCH ?? "claude/fake-branch"}`,
      `PR_NUMBER=${process.env.JARVIS_FAKE_CLAUDE_PR ?? "1234"}`
    ].join("\n"),
    created_at: now,
    updated_at: now,
    author_association: "OWNER",
    user: { login: process.env.JARVIS_FAKE_GH_AUTHOR ?? "tsworkflow" }
  });
  writeFileSync(path, JSON.stringify(comments, null, 2), "utf8");
  writeFileSync(join(DIR, "report-posted"), new Date().toISOString(), "utf8");
}

process.stdin.on("end", act);
process.stdin.on("close", act);
process.stdin.resume();

// Fallback: never wait forever for a prompt that is not coming.
const fallback = setTimeout(act, 5000);
if (typeof fallback.unref === "function" && hangs) fallback.unref();
if (keepAlive && typeof keepAlive.ref === "function") keepAlive.ref();
