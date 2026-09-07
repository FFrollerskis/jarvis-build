/**
 * Requirement A acceptance tests: legacy scratch recovery must be safe.
 *
 * The headline case is the exact file that stalled the loop:
 * `.claude-ack-d125-merge.md`, left untracked in the repo after the D125 merge
 * session, which made every subsequent run block on the dirty guard.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  recoverScratch,
  classifyName,
  parseStatusLine,
  verifyProvenance,
  assessCandidate,
  uniqueDestination,
  MAX_SCRATCH_BYTES
} from "../lib/quarantine.mjs";

const D125_ACK_NAME = ".claude-ack-d125-merge.md";
const D125_TASK_ID = "D125-MERGE-AUTH-20260906T1930Z";
const D125_ACK_BODY = [
  "CLAUDE_ACK",
  `TASK_ID=${D125_TASK_ID}`,
  "TASK_TYPE=MERGE_AUTH",
  "STATUS=IN_PROGRESS",
  "",
  "Draft ACK left behind in the working tree by the merge session."
].join("\n");

const KNOWN_TASK_IDS = [
  "D125-UA7-TELEGRAM-INBOUND-OWNER-20260906T0627Z",
  D125_TASK_ID,
  "D125-POSTMERGE-LOCAL-CLOSEOUT-20260906T1924Z"
];

let repo;
let quarantineRoot;
let manifestFile;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-quarantine-"));
  repo = join(root, "repo");
  quarantineRoot = join(root, "worker", "quarantine");
  manifestFile = join(root, "worker", "logs", "manifest.jsonl");
  mkdirSync(repo, { recursive: true });
  mkdirSync(quarantineRoot, { recursive: true });
});

afterEach(() => {
  try { rmSync(join(repo, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
});

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

describe("anchored filename allowlist", () => {
  it("accepts the exact legacy helper names, including the D125 one", () => {
    expect(classifyName(".claude-ack.md")).toBe("ack");
    expect(classifyName(".claude-report.md")).toBe("report");
    expect(classifyName(D125_ACK_NAME)).toBe("ack");
    expect(classifyName(".claude-report-d124-recovery.md")).toBe("report");
    expect(classifyName(".commitmsg-d125.txt")).toBe("commitmsg");
  });

  it("rejects anything that is not an exact, root-level match", () => {
    // Not anchored / not root / traversal / lookalikes.
    expect(classifyName("src/.claude-ack.md")).toBeNull();
    expect(classifyName("../.claude-ack.md")).toBeNull();
    expect(classifyName("..\\.claude-ack.md")).toBeNull();
    expect(classifyName("my.claude-ack.md")).toBeNull();
    expect(classifyName(".claude-ack.md.bak")).toBeNull();
    expect(classifyName(".claude-ack-with spaces.md")).toBeNull();
    expect(classifyName("README.md")).toBeNull();
    expect(classifyName("")).toBeNull();
    expect(classifyName(null)).toBeNull();
  });
});

describe("git status parsing", () => {
  it("treats only ?? entries as untracked candidates", () => {
    expect(parseStatusLine("?? .claude-ack.md")).toMatchObject({ untracked: true, path: ".claude-ack.md" });
    expect(parseStatusLine(" M src/app.ts")).toMatchObject({ untracked: false, path: "src/app.ts" });
    expect(parseStatusLine("M  src/app.ts")).toMatchObject({ untracked: false });
    expect(parseStatusLine("A  new.ts")).toMatchObject({ untracked: false });
    expect(parseStatusLine("UU conflict.ts")).toMatchObject({ untracked: false });
  });
});

describe("provenance verification (filename alone is never enough)", () => {
  it("accepts a real ACK whose TASK_ID is known to the worker", () => {
    const r = verifyProvenance({
      kind: "ack", name: D125_ACK_NAME, content: D125_ACK_BODY, knownTaskIds: KNOWN_TASK_IDS
    });
    expect(r).toMatchObject({ ok: true, taskId: D125_TASK_ID });
  });

  it("rejects a correctly named file whose content is not a protocol document", () => {
    const r = verifyProvenance({
      kind: "ack", name: D125_ACK_NAME, content: "# my private notes\nnothing to do with claude", knownTaskIds: KNOWN_TASK_IDS
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/content_header_mismatch/);
  });

  it("rejects an ACK whose TASK_ID the worker has never seen", () => {
    const body = D125_ACK_BODY.replace(D125_TASK_ID, "SOMEONE-ELSES-TASK-9999");
    const r = verifyProvenance({ kind: "ack", name: D125_ACK_NAME, content: body, knownTaskIds: KNOWN_TASK_IDS });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/task_id_not_known_to_worker/);
  });

  it("rejects a commitmsg whose slug maps to no known task", () => {
    const r = verifyProvenance({
      kind: "commitmsg", name: ".commitmsg-unrelated.txt", content: "feat: something", knownTaskIds: KNOWN_TASK_IDS
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not_associated/);
  });
});

describe("acceptance: the exact D125 ACK is recovered with its bytes intact", () => {
  it("moves the file out of the repo, preserves the hash, and leaves the tree clean", () => {
    const source = join(repo, D125_ACK_NAME);
    writeFileSync(source, D125_ACK_BODY, "utf8");
    const originalHash = sha256(readFileSync(source));

    const result = recoverScratch({
      repoPath: repo,
      statusLines: [`?? ${D125_ACK_NAME}`],
      quarantineRoot,
      knownTaskIds: KNOWN_TASK_IDS,
      manifestFile
    });

    expect(result.clean).toBe(true);
    expect(result.left).toEqual([]);
    expect(result.recovered).toHaveLength(1);

    const rec = result.recovered[0];
    expect(rec.source_rel).toBe(D125_ACK_NAME);
    expect(rec.task_id).toBe(D125_TASK_ID);
    expect(rec.sha256).toBe(originalHash);

    // Gone from the repo (so the dirty guard now passes and dispatch proceeds)...
    expect(existsSync(source)).toBe(false);
    // ...and byte-identical outside it.
    expect(existsSync(rec.dest)).toBe(true);
    expect(sha256(readFileSync(rec.dest))).toBe(originalHash);
    expect(readFileSync(rec.dest, "utf8")).toBe(D125_ACK_BODY);
    // Quarantine is outside the repository by construction.
    expect(rec.dest.startsWith(repo)).toBe(false);
  });

  it("writes a bounded manifest with paths and hashes but never file content", () => {
    writeFileSync(join(repo, D125_ACK_NAME), D125_ACK_BODY, "utf8");
    recoverScratch({
      repoPath: repo,
      statusLines: [`?? ${D125_ACK_NAME}`],
      quarantineRoot,
      knownTaskIds: KNOWN_TASK_IDS,
      manifestFile
    });

    const manifest = readFileSync(manifestFile, "utf8").trim();
    const record = JSON.parse(manifest);
    expect(record).toHaveProperty("sha256");
    expect(record).toHaveProperty("source_rel", D125_ACK_NAME);
    expect(record).toHaveProperty("size_bytes");
    // No body, no secrets.
    expect(manifest).not.toContain("Draft ACK left behind");
    expect(record).not.toHaveProperty("content");
  });
});

describe("acceptance: unsafe or unknown inputs are always left alone", () => {
  it("never touches an unknown untracked file", () => {
    const unknown = join(repo, "notes.md");
    writeFileSync(unknown, "important user work", "utf8");

    const result = recoverScratch({
      repoPath: repo, statusLines: ["?? notes.md"], quarantineRoot, knownTaskIds: KNOWN_TASK_IDS, manifestFile
    });

    expect(result.recovered).toEqual([]);
    expect(result.clean).toBe(false);
    expect(result.left[0]).toMatchObject({ name: "notes.md", reason: expect.stringContaining("not_on_anchored_allowlist") });
    expect(readFileSync(unknown, "utf8")).toBe("important user work");
  });

  it("never touches a TRACKED modification, even with a scratch-shaped name", () => {
    const tracked = join(repo, ".claude-ack.md");
    writeFileSync(tracked, "CLAUDE_ACK\nTASK_ID=" + D125_TASK_ID, "utf8");

    const result = recoverScratch({
      repoPath: repo,
      statusLines: [` M ${".claude-ack.md"}`], // tracked modification, not "??"
      quarantineRoot, knownTaskIds: KNOWN_TASK_IDS, manifestFile
    });

    expect(result.recovered).toEqual([]);
    expect(result.left[0].reason).toBe("tracked_change_never_touched");
    expect(existsSync(tracked)).toBe(true);
  });

  it("refuses a symlink and never follows it", () => {
    const secret = join(repo, "..", "outside-secret.txt");
    writeFileSync(secret, "SENSITIVE", "utf8");
    const link = join(repo, ".claude-ack.md");
    try {
      symlinkSync(secret, link);
    } catch {
      return; // Windows without symlink privilege: covered by the unit test below.
    }

    const result = recoverScratch({
      repoPath: repo, statusLines: ["?? .claude-ack.md"], quarantineRoot, knownTaskIds: KNOWN_TASK_IDS, manifestFile
    });

    expect(result.recovered).toEqual([]);
    expect(result.left[0].reason).toBe("symlink_refused");
    // The link and its target both survive untouched.
    expect(existsSync(link)).toBe(true);
    expect(readFileSync(secret, "utf8")).toBe("SENSITIVE");
  });

  it("refuses symlinks and reparse points at the decision layer (platform independent)", () => {
    const asSymlink = assessCandidate({
      entry: { untracked: true, path: ".claude-ack.md" },
      repoPath: repo, knownTaskIds: KNOWN_TASK_IDS,
      lstat: () => ({ isSymbolicLink: () => true, isFile: () => true, size: 10 }),
      readFile: () => D125_ACK_BODY
    });
    expect(asSymlink).toMatchObject({ action: "leave", reason: "symlink_refused" });

    const asReparse = assessCandidate({
      entry: { untracked: true, path: ".claude-ack.md" },
      repoPath: repo, knownTaskIds: KNOWN_TASK_IDS,
      lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, size: 10, attributes: 0x400 }),
      readFile: () => D125_ACK_BODY
    });
    expect(asReparse).toMatchObject({ action: "leave", reason: "reparse_point_refused" });

    const asDirectory = assessCandidate({
      entry: { untracked: true, path: ".claude-ack.md" },
      repoPath: repo, knownTaskIds: KNOWN_TASK_IDS,
      lstat: () => ({ isSymbolicLink: () => false, isFile: () => false, size: 10 }),
      readFile: () => D125_ACK_BODY
    });
    expect(asDirectory).toMatchObject({ action: "leave", reason: "not_a_regular_file" });

    const tooBig = assessCandidate({
      entry: { untracked: true, path: ".claude-ack.md" },
      repoPath: repo, knownTaskIds: KNOWN_TASK_IDS,
      lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, size: MAX_SCRATCH_BYTES + 1 }),
      readFile: () => D125_ACK_BODY
    });
    expect(tooBig).toMatchObject({ action: "leave", reason: "too_large_to_be_scratch" });
  });

  it("never overwrites a colliding destination", () => {
    const taken = new Set(["/q/20260907-0115-a.md", "/q/20260907-0115-001-a.md"]);
    const dest = uniqueDestination("/q", "a.md", "20260907-0115", (p) => taken.has(p.replace(/\\/g, "/")));
    expect(dest.replace(/\\/g, "/")).toBe("/q/20260907-0115-002-a.md");
  });

  it("keeps both files when two runs quarantine the same name", () => {
    writeFileSync(join(repo, D125_ACK_NAME), D125_ACK_BODY, "utf8");
    const first = recoverScratch({
      repoPath: repo, statusLines: [`?? ${D125_ACK_NAME}`], quarantineRoot, knownTaskIds: KNOWN_TASK_IDS, manifestFile
    });

    const secondBody = D125_ACK_BODY + "\nsecond attempt";
    writeFileSync(join(repo, D125_ACK_NAME), secondBody, "utf8");
    const second = recoverScratch({
      repoPath: repo, statusLines: [`?? ${D125_ACK_NAME}`], quarantineRoot, knownTaskIds: KNOWN_TASK_IDS, manifestFile
    });

    expect(first.recovered).toHaveLength(1);
    expect(second.recovered).toHaveLength(1);
    expect(second.recovered[0].dest).not.toBe(first.recovered[0].dest);
    // Neither copy was clobbered.
    expect(readFileSync(first.recovered[0].dest, "utf8")).toBe(D125_ACK_BODY);
    expect(readFileSync(second.recovered[0].dest, "utf8")).toBe(secondBody);
    expect(readdirSync(join(quarantineRoot, D125_TASK_ID))).toHaveLength(2);
  });

  it("processes a mixed worktree without touching anything it should not", () => {
    writeFileSync(join(repo, D125_ACK_NAME), D125_ACK_BODY, "utf8");
    writeFileSync(join(repo, "user-notes.md"), "keep me", "utf8");
    writeFileSync(join(repo, "tracked.ts"), "export const a = 1;", "utf8");

    const result = recoverScratch({
      repoPath: repo,
      statusLines: [`?? ${D125_ACK_NAME}`, "?? user-notes.md", " M tracked.ts"],
      quarantineRoot, knownTaskIds: KNOWN_TASK_IDS, manifestFile
    });

    expect(result.recovered.map((r) => r.source_rel)).toEqual([D125_ACK_NAME]);
    expect(result.clean).toBe(false); // correctly still blocked by the unknown file
    expect(readFileSync(join(repo, "user-notes.md"), "utf8")).toBe("keep me");
    expect(readFileSync(join(repo, "tracked.ts"), "utf8")).toBe("export const a = 1;");
  });
});
