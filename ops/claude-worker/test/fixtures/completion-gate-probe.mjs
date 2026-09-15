/**
 * D-147: drive the PRE-DISPATCH RECONCILIATION site's exact gate call.
 *
 * `runTask`'s pre-dispatch reconciliation is a BACKSTOP: `reconcileReportedTasks`
 * runs earlier in the same run, over the same comments, for a superset of the
 * tasks `runTask` can be handed, so whenever both would fire the pre-selection
 * pass has already retired the task. The site therefore cannot be reached by
 * running the process, and a test that claimed to reach it would in fact be
 * exercising the pre-selection path a second time.
 *
 * The site itself has no logic of its own: it calls
 * `completionGateFor(cfg, prior, rec.completion, comments)` and acts on
 * `gate.held`. This probe makes exactly that call, with the real config, the real
 * state row, the real durable claim and the real worktree a preceding run left
 * behind - out of process, because `worker.mjs` carries a shebang that the test
 * runner's transform will not accept as an import.
 *
 *   argv: <configPath> <commentsPath> <taskId> <outPath> [complete]
 *
 * D-149: the site now passes a CONTROL VIEW - the comments plus whether the read
 * that produced them was proven complete - because a decision that turns on the
 * ABSENCE of the bound order must know the difference between "it is not there"
 * and "I could not look". The real site is reached only after a successful
 * `fetchIssueCommentsDetailed`, so `complete` defaults to `true` here; pass
 * `incomplete` to drive the partial-read case.
 *
 * The verdict is written to `outPath` rather than to stdout, because
 * `completionGateFor` logs to stdout by design and a caller must never have to
 * guess which of those lines was the answer.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadWorkerConfig } from "../../lib/config.mjs";
import { loadState } from "../../lib/state.mjs";
import { assessCompletion } from "../../lib/reconcile.mjs";
import { completionGateFor } from "../../worker.mjs";

const [configPath, commentsPath, taskId, outPath, completeArg] = process.argv.slice(2);
const complete = String(completeArg ?? "complete").trim() !== "incomplete";
const HERE = dirname(fileURLToPath(import.meta.url));

const cfg = loadWorkerConfig(configPath, join(HERE, "..", ".."));
const { state } = loadState(cfg.stateFile, cfg.stateBackupFile, { schema: "worker" });
const task = state?.tasks?.[taskId] ?? null;
if (!task) {
  process.stderr.write(`no state row for ${taskId}\n`);
  process.exit(2);
}

const comments = JSON.parse(readFileSync(commentsPath, "utf8"));
const completion = assessCompletion({
  taskId,
  comments,
  trustedAuthor: cfg.trustedAuthor,
  sinceIso: task.first_dispatch_at ?? null
});

const { gate, provenance, mergeTransition } = completionGateFor(cfg, task, completion, { comments, complete });
writeFileSync(outPath, JSON.stringify({
  completion: { complete: completion.complete, successful: completion.successful },
  control_complete: complete,
  gate,
  provenance,
  mergeTransition: mergeTransition ?? null
}, null, 2), "utf8");
