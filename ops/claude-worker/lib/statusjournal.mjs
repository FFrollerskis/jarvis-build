/**
 * Append-only dedup journal for CLAUDE_WORKER_STATUS comments.
 *
 * D126 review blocker 2: "State is loaded BEFORE lock and written on no-candidate
 * and lock-denied paths with NO lock." One of those writes existed purely to
 * remember "we already posted this status". That bookkeeping does not need - and
 * must not take - exclusive ownership of the task state.
 *
 * An O_APPEND write of a single short line is atomic on both NTFS and POSIX, so
 * this journal is safe to write from an instance that does NOT hold the worker
 * lock, without ever risking the task history.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** Build `{ key: lastIsoTimestamp }` from the journal. Tolerates truncated lines. */
export function readPostedStatus(journalFile, limit = 2000) {
  if (!existsSync(journalFile)) return {};
  let raw;
  try {
    raw = readFileSync(journalFile, "utf8");
  } catch {
    return {};
  }
  const map = {};
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-limit);
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.key === "string" && typeof rec.ts === "string") map[rec.key] = rec.ts;
    } catch {
      // A crash mid-append can leave one truncated line; skip it rather than
      // discarding the whole journal.
    }
  }
  return map;
}

export function recordPostedStatus(journalFile, key, ts = new Date().toISOString()) {
  try {
    mkdirSync(dirname(journalFile), { recursive: true });
    appendFileSync(journalFile, JSON.stringify({ key, ts }) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}
