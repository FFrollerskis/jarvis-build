/**
 * D126 review round G, blocker 1: "production deploy CLI exposes a quiescence
 * bypass".
 *
 * `ops/claude-worker/deploy.mjs` used to call `activateRelease` with
 * `requireQuiescence: args["force-unquiesced"] !== true`, i.e. the production
 * CLI accepted an undocumented `--force-unquiesced` escape hatch that could
 * structurally disable D-126's central invariant: a deployment never overwrites
 * a live worker or supervisor.
 *
 * These tests sit at the CLI/entrypoint boundary (the exported `main()`, which
 * is exactly what `node deploy.mjs ...` runs) rather than at the library
 * boundary, because the library seam is legitimately still there for the
 * library's own tests. What must be true is that no invocation of the CLI can
 * reach it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

import { main, EXIT, FORBIDDEN_BYPASS_OPTIONS } from "../deploy.mjs";
import { stageRelease, readPendingActivation } from "../lib/deploy.mjs";

const TEST_PAYLOAD = ["worker.mjs", "run-worker.ps1", "lib/state.mjs", "lib/supervise.mjs", "supervisor.mjs"];
const VERSION = "20260908-010000";

let dir;
let source;
let destination;
let tasksFile;
let argvBackup;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-deploy-cli-"));
  source = join(dir, "src");
  destination = join(dir, "dest");
  mkdirSync(join(source, "lib"), { recursive: true });
  mkdirSync(join(destination, "lib"), { recursive: true });
  for (const rel of TEST_PAYLOAD) writeFileSync(join(source, rel), `NEW ${rel}\n`, "utf8");

  // An existing live deployment, so "did anything get switched?" is observable.
  writeFileSync(join(destination, "worker.mjs"), "OLD worker.mjs\n", "utf8");
  writeFileSync(join(destination, "run-worker.ps1"), "OLD run-worker.ps1\n", "utf8");
  writeFileSync(join(destination, "lib", "state.mjs"), "OLD lib/state.mjs\n", "utf8");

  // Never query the real host Task Scheduler from a test.
  tasksFile = join(dir, "tasks.json");
  writeFileSync(tasksFile, "[]", "utf8");

  stageRelease({ sourceDir: source, destination, payload: TEST_PAYLOAD, version: VERSION });
  argvBackup = process.argv;
});

afterEach(() => {
  process.argv = argvBackup;
  rmSync(dir, { recursive: true, force: true });
});

/** A lock held by a process that is provably alive right now: this one. */
function writeLiveLock(name = ".worker.lock") {
  writeFileSync(join(destination, name), JSON.stringify({
    lock_version: 2,
    pid: process.pid,
    host: hostname(),
    start_time: null,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    phase: "dispatch",
    owner_token: "t"
  }, null, 2), "utf8");
}

/** Run the CLI exactly as `node deploy.mjs <args>` would, capturing its output. */
async function runCli(...cliArgs) {
  process.argv = ["node", "deploy.mjs", ...cliArgs];
  const printed = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line) => { printed.push(line); });
  try {
    const code = await main();
    return { code, json: printed.length ? JSON.parse(printed.join("\n")) : null };
  } finally {
    spy.mockRestore();
  }
}

/** Nothing live was switched: the old bytes are still there, new files absent. */
function liveFilesUntouched() {
  return readFileSync(join(destination, "worker.mjs"), "utf8") === "OLD worker.mjs\n"
    && readFileSync(join(destination, "run-worker.ps1"), "utf8") === "OLD run-worker.ps1\n"
    && readFileSync(join(destination, "lib", "state.mjs"), "utf8") === "OLD lib/state.mjs\n"
    && !existsSync(join(destination, "supervisor.mjs"))
    && !existsSync(join(destination, "lib", "supervise.mjs"));
}

describe("blocker 1: the production CLI has no quiescence bypass", () => {
  it("`activate --force-unquiesced` cannot switch live files over a live lock", async () => {
    writeLiveLock();
    const { code, json } = await runCli(
      "activate", "--destination", destination, "--version", VERSION, "--tasks", tasksFile,
      "--force-unquiesced"
    );

    expect(code).toBe(EXIT.BLOCKED);
    expect(json.error).toMatch(/force-unquiesced/);
    expect(json.error).toMatch(/quiescence is always enforced/);
    expect(json.activated).toBe(false);
    expect(liveFilesUntouched()).toBe(true);
  });

  it("`apply-pending --force-unquiesced` cannot switch live files over a live lock", async () => {
    writeLiveLock();
    // A real deferred handoff first, so there IS a pending activation to abuse.
    const deferred = await runCli("activate", "--destination", destination, "--version", VERSION, "--tasks", tasksFile);
    expect(deferred.code).toBe(EXIT.DEFERRED);
    expect(readPendingActivation(destination).version).toBe(VERSION);

    const { code, json } = await runCli(
      "apply-pending", "--destination", destination, "--tasks", tasksFile, "--force-unquiesced"
    );

    expect(code).toBe(EXIT.BLOCKED);
    expect(json.activated).toBe(false);
    expect(liveFilesUntouched()).toBe(true);
    // The deferred handoff is still intact; the rejected call consumed nothing.
    expect(readPendingActivation(destination).version).toBe(VERSION);
  });

  it("no spelling of the bypass gets through, on either subcommand", async () => {
    for (const option of FORBIDDEN_BYPASS_OPTIONS) {
      for (const sub of ["activate", "apply-pending"]) {
        writeLiveLock();
        const { code, json } = await runCli(
          sub, "--destination", destination, "--version", VERSION, "--tasks", tasksFile,
          `--${option}`, "true"
        );
        expect(code, `${sub} --${option}`).toBe(EXIT.BLOCKED);
        expect(json.quiescence_enforced, `${sub} --${option}`).toBe(true);
        expect(liveFilesUntouched(), `${sub} --${option}`).toBe(true);
      }
    }
  });

  it("the CLI source contains no requireQuiescence override at all", () => {
    const src = readFileSync(new URL("../deploy.mjs", import.meta.url), "utf8");
    // A comment may mention it; an actual `requireQuiescence: <value>` argument
    // must not exist in the production entrypoint.
    const assignments = src.match(/^\s*requireQuiescence\s*:/gm) ?? [];
    expect(assignments).toEqual([]);
  });
});

describe("blocker 1 control cases: enforcement is real, not a blanket refusal", () => {
  it("a plain `activate` over a live lock DEFERS and leaves everything untouched", async () => {
    writeLiveLock();
    const { code, json } = await runCli("activate", "--destination", destination, "--version", VERSION, "--tasks", tasksFile);

    expect(code).toBe(EXIT.DEFERRED);
    expect(json.deferred).toBe(true);
    expect(json.reason).toMatch(/\.worker\.lock/);
    expect(liveFilesUntouched()).toBe(true);
  });

  it("a live SUPERVISOR lock defers the CLI too, and its bypass is equally rejected", async () => {
    writeLiveLock(".supervisor.lock");
    const plain = await runCli("activate", "--destination", destination, "--version", VERSION, "--tasks", tasksFile);
    expect(plain.code).toBe(EXIT.DEFERRED);

    const forced = await runCli(
      "activate", "--destination", destination, "--version", VERSION, "--tasks", tasksFile, "--force-unquiesced"
    );
    expect(forced.code).toBe(EXIT.BLOCKED);
    expect(liveFilesUntouched()).toBe(true);
  });

  it("the same staged release activates normally once nothing holds a lock", async () => {
    const { code, json } = await runCli("activate", "--destination", destination, "--version", VERSION, "--tasks", tasksFile);

    expect(code).toBe(EXIT.OK);
    expect(json.ok).toBe(true);
    expect(readFileSync(join(destination, "worker.mjs"), "utf8")).toBe("NEW worker.mjs\n");
    expect(existsSync(join(destination, "lib", "supervise.mjs"))).toBe(true);
  });
});
