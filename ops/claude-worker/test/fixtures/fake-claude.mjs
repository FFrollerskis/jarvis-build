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
 *
 * It deliberately keeps running when its parent is killed, which is exactly the
 * situation the worker must survive without starting a second Claude. That means
 * it must tolerate its stdio pipes being torn down mid-flight, so every stream
 * gets an error handler; without them a broken pipe kills the child and the
 * live-orphan case can never be exercised at all.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.JARVIS_FAKE_CLAUDE_DIR;
const MODE = process.env.JARVIS_FAKE_CLAUDE_MODE ?? "report";
const TASK_ID = process.env.JARVIS_FAKE_CLAUDE_TASK_ID ?? "UNKNOWN";
const GH_DIR = process.env.JARVIS_FAKE_GH_DIR;

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
const lingers = MODE === "report-slow";
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

let acted = false;
function act() {
  if (acted) return;
  acted = true;
  try { writeFileSync(join(DIR, "prompt.txt"), prompt, "utf8"); } catch { /* best effort */ }

  if (MODE === "fail") {
    process.exit(7);
  }
  if (MODE === "report" || MODE === "report-hang" || MODE === "report-slow") {
    postReport();
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
  const path = join(GH_DIR, "comments.json");
  const comments = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const now = new Date().toISOString();
  comments.push({
    id: 800000 + comments.length,
    body: [
      "CLAUDE_REPORT",
      `TASK_ID=${TASK_ID}`,
      "STATUS=COMPLETED",
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
