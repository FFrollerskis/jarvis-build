/**
 * Scratch quarantine (requirement A).
 *
 * Worker-generated helper files (CLAUDE_ACK / CLAUDE_REPORT drafts, commit-message
 * scratch) used to be written INTO the repo working tree. A leftover file then
 * made the next run's dirty guard block forever - the exact stall observed with
 * `.claude-ack-d125-merge.md`.
 *
 * Two-part fix:
 *   1. New runs write scratch outside the repo by construction (the worker exports
 *      a per-task scratch dir and points TEMP/TMP at it - see run-worker.ps1).
 *   2. LEGACY leftovers are recovered here, before the dirty guard, into a unique
 *      external quarantine directory, preserving bytes exactly.
 *
 * Safety rules, all enforced below and covered by tests:
 *   - Only untracked ("?? ") entries. Tracked modifications are NEVER touched.
 *   - Filename must match a fully ANCHORED allowlist pattern at the repo root.
 *   - Filename alone is never sufficient: content shape and task association are
 *     verified too, so a user file that merely happens to be named like scratch
 *     is left alone.
 *   - Symlinks, junctions/reparse points, directories and oversized files are
 *     refused - a link is never followed.
 *   - Destination collisions never overwrite; a fresh unique name is chosen.
 *   - Bytes are hashed before and after the move and compared.
 *   - No `git clean`, `git reset`, `git stash`, and no .gitignore concealment.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, copyFileSync, unlinkSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

/** Max size we are willing to treat as scratch. Anything larger is user work. */
export const MAX_SCRATCH_BYTES = 1024 * 1024;

/** Windows FILE_ATTRIBUTE_REPARSE_POINT. Node exposes attributes only on Windows. */
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

/**
 * Fully anchored allowlist. `slug` is deliberately narrow: no path separators,
 * no dots-dots, no spaces - so nothing here can escape the repo root.
 */
const SLUG = "[0-9A-Za-z._-]{1,64}";
export const SCRATCH_PATTERNS = Object.freeze([
  { re: new RegExp(`^\\.claude-ack\\.md$`), kind: "ack" },
  { re: new RegExp(`^\\.claude-report\\.md$`), kind: "report" },
  { re: new RegExp(`^\\.claude-ack-${SLUG}\\.md$`), kind: "ack" },
  { re: new RegExp(`^\\.claude-report-${SLUG}\\.md$`), kind: "report" },
  { re: new RegExp(`^\\.commitmsg-${SLUG}\\.txt$`), kind: "commitmsg" }
]);

export function classifyName(name) {
  if (typeof name !== "string" || !name) return null;
  if (name.includes("/") || name.includes("\\")) return null; // repo root only
  for (const p of SCRATCH_PATTERNS) {
    if (p.re.test(name)) return p.kind;
  }
  return null;
}

/**
 * Parse `git status --porcelain=v1` output.
 * Only `?? ` lines are candidates; everything else is tracked and off-limits.
 * Quoted paths (git quotes names with specials) are treated as NOT matching the
 * allowlist, because the allowlist has no characters that would ever be quoted.
 */
export function parseStatusLine(line) {
  if (typeof line !== "string" || line.length < 4) return null;
  const code = line.slice(0, 2);
  const path = line.slice(3);
  return { code, path, untracked: code === "??" };
}

export function firstNonEmptyLine(text) {
  const line = String(text ?? "").split(/\r?\n/).find((l) => l.trim().length > 0);
  return (line ?? "").trim();
}

export function extractTaskId(text) {
  const m = String(text ?? "").match(/^TASK_ID=(.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * Provenance check. Filename is necessary but NOT sufficient.
 *
 * ack/report: must actually open with the protocol header AND carry a TASK_ID
 *             that this worker has already seen (present in state.tasks).
 * commitmsg:  has no protocol header, so association is proven by requiring the
 *             filename slug to reference a task id this worker has seen.
 *
 * `knownTaskIds` is the authoritative set from worker state.
 */
export function verifyProvenance({ kind, name, content, knownTaskIds }) {
  const known = Array.from(knownTaskIds ?? []);
  if (kind === "ack" || kind === "report") {
    const header = firstNonEmptyLine(content);
    const expected = kind === "ack" ? "CLAUDE_ACK" : "CLAUDE_REPORT";
    if (header !== expected) {
      return { ok: false, reason: `content_header_mismatch (expected ${expected})` };
    }
    const taskId = extractTaskId(content);
    if (!taskId) return { ok: false, reason: "no_task_id_in_content" };
    if (!known.includes(taskId)) {
      return { ok: false, reason: `task_id_not_known_to_worker (${taskId})` };
    }
    return { ok: true, taskId };
  }

  if (kind === "commitmsg") {
    if (!String(content ?? "").trim()) return { ok: false, reason: "empty_commitmsg" };
    const slug = name.replace(/^\.commitmsg-/, "").replace(/\.txt$/, "").toLowerCase();
    const match = known.find((id) => {
      const lower = id.toLowerCase();
      return lower.startsWith(slug) || slug.startsWith(lower.split("-")[0]);
    });
    if (!match) return { ok: false, reason: `commitmsg_slug_not_associated_with_known_task (${slug})` };
    return { ok: true, taskId: match };
  }

  return { ok: false, reason: "unknown_kind" };
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Choose a destination that never collides with, and never overwrites, an existing file. */
export function uniqueDestination(dir, baseName, stamp, exists = existsSync) {
  let candidate = join(dir, `${stamp}-${baseName}`);
  let n = 1;
  while (exists(candidate)) {
    candidate = join(dir, `${stamp}-${String(n).padStart(3, "0")}-${baseName}`);
    n += 1;
    if (n > 9999) throw new Error("could not find a free quarantine destination");
  }
  return candidate;
}

/** Bounded, content-free manifest. Records paths and hashes only - never file bodies. */
export function appendManifest(manifestFile, record, maxBytes = 512 * 1024) {
  try {
    mkdirSync(dirname(manifestFile), { recursive: true });
    appendFileSync(manifestFile, JSON.stringify(record) + "\n", "utf8");
    // Bound the manifest: if it has grown past the cap, keep the newest half.
    const stat = lstatSync(manifestFile);
    if (stat.size > maxBytes) {
      const lines = readFileSync(manifestFile, "utf8").split(/\r?\n/).filter(Boolean);
      const keep = lines.slice(Math.floor(lines.length / 2));
      renameSync(manifestFile, `${manifestFile}.old`);
      appendFileSync(manifestFile, keep.join("\n") + "\n", "utf8");
      try { unlinkSync(`${manifestFile}.old`); } catch { /* best effort */ }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide - without touching disk - whether one status entry may be quarantined.
 * Pure and fully unit-testable; `readFile`/`lstat` are injected.
 */
export function assessCandidate({ entry, repoPath, knownTaskIds, lstat, readFile }) {
  if (!entry) return { action: "skip", reason: "unparseable_status_line" };
  if (!entry.untracked) {
    return { action: "leave", name: entry.path, reason: "tracked_change_never_touched" };
  }
  const kind = classifyName(entry.path);
  if (!kind) return { action: "leave", name: entry.path, reason: "not_on_anchored_allowlist" };

  const full = join(repoPath, entry.path);
  let st;
  try {
    st = lstat(full); // lstat, never stat: a link is inspected, never followed
  } catch (err) {
    return { action: "leave", name: entry.path, reason: `lstat_failed (${err.code ?? "ERR"})` };
  }
  if (st.isSymbolicLink && st.isSymbolicLink()) {
    return { action: "leave", name: entry.path, reason: "symlink_refused" };
  }
  if (typeof st.attributes === "number" && (st.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
    return { action: "leave", name: entry.path, reason: "reparse_point_refused" };
  }
  if (!st.isFile || !st.isFile()) {
    return { action: "leave", name: entry.path, reason: "not_a_regular_file" };
  }
  if (st.size > MAX_SCRATCH_BYTES) {
    return { action: "leave", name: entry.path, reason: "too_large_to_be_scratch" };
  }

  let content;
  try {
    content = readFile(full);
  } catch (err) {
    return { action: "leave", name: entry.path, reason: `read_failed (${err.code ?? "ERR"})` };
  }

  const prov = verifyProvenance({ kind, name: entry.path, content, knownTaskIds });
  if (!prov.ok) {
    return { action: "leave", name: entry.path, reason: `provenance_rejected: ${prov.reason}` };
  }
  return { action: "quarantine", name: entry.path, kind, taskId: prov.taskId, size: st.size };
}

/**
 * Recover legacy scratch. Returns a report; performs no git mutation of any kind.
 *
 * `statusLines` are raw `git status --porcelain=v1` lines.
 */
export function recoverScratch({
  repoPath,
  statusLines,
  quarantineRoot,
  knownTaskIds,
  manifestFile,
  now = () => new Date(),
  fs: fsImpl = {}
}) {
  const lstat = fsImpl.lstat ?? ((p) => lstatSync(p));
  const readFile = fsImpl.readFile ?? ((p) => readFileSync(p, "utf8"));
  const exists = fsImpl.exists ?? existsSync;
  const move = fsImpl.move ?? defaultMove;
  const hash = fsImpl.hash ?? sha256File;
  const ensureDir = fsImpl.ensureDir ?? ((p) => mkdirSync(p, { recursive: true }));

  const recovered = [];
  const left = [];

  for (const line of statusLines) {
    const entry = parseStatusLine(line);
    const verdict = assessCandidate({ entry, repoPath, knownTaskIds, lstat, readFile });

    if (verdict.action !== "quarantine") {
      if (verdict.action === "leave") left.push({ name: verdict.name, reason: verdict.reason });
      continue;
    }

    const source = join(repoPath, verdict.name);
    const stamp = now().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
    const destDir = join(quarantineRoot, verdict.taskId || "unassociated");

    try {
      ensureDir(destDir);
      const before = hash(source);
      const dest = uniqueDestination(destDir, verdict.name, stamp, exists);
      move(source, dest);
      const after = hash(dest);
      if (before !== after) {
        // Bytes must be preserved exactly. This should be impossible for a
        // rename, but a copy fallback across volumes deserves the assertion.
        throw new Error("hash_mismatch_after_move");
      }
      const record = {
        ts: now().toISOString(),
        source_rel: verdict.name,
        dest,
        sha256: after,
        size_bytes: verdict.size,
        kind: verdict.kind,
        task_id: verdict.taskId
      };
      if (manifestFile) appendManifest(manifestFile, record);
      recovered.push(record);
    } catch (err) {
      left.push({ name: verdict.name, reason: `quarantine_failed: ${err.message}` });
    }
  }

  return { recovered, left, clean: left.length === 0 };
}

function defaultMove(source, dest) {
  try {
    renameSync(source, dest);
  } catch (err) {
    // Cross-volume rename (EXDEV) or a Windows lock: fall back to copy+unlink so
    // the bytes still land intact.
    if (err.code !== "EXDEV" && err.code !== "EPERM") throw err;
    copyFileSync(source, dest);
    unlinkSync(source);
  }
}
