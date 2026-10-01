import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FREEZE_ENV, FREEZE_UNFREEZE_VALUE, workerFrozen } from "../worker.mjs";

/**
 * Remediering del 1 (JARVIS-052 / STB-07): claude-worker (issue #68-løkken) er FROSSET.
 * Disse testene kjører den EKTE entrypointen uten opphevelsesverdien.
 */
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "worker.mjs");

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, ...args], {
      env: { ...env, PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("claude-worker er frosset inntil del 9", () => {
  it("workerFrozen: kun den eksakte opphevelsesverdien åpner", () => {
    expect(workerFrozen({})).toBe(true);
    expect(workerFrozen({ [FREEZE_ENV]: "1" })).toBe(true);
    expect(workerFrozen({ [FREEZE_ENV]: "true" })).toBe(true);
    expect(workerFrozen({ [FREEZE_ENV]: FREEZE_UNFREEZE_VALUE })).toBe(false);
  });

  it("`run` uten opphevelse avslutter BLOCKED (3) før noe leses fra GitHub/git/config", async () => {
    const res = await run(["run"], { JARVIS_WORKER_CONFIG: "/finnes/ikke.json" });
    expect(res.code).toBe(3);
    expect(res.out).toContain("FROZEN");
    expect(res.out).not.toContain("ENOENT");
  });

  it("`run --dry-run` og standardkommandoen (uten argument) er også frosset", async () => {
    expect((await run(["run", "--dry-run"], {})).code).toBe(3);
    expect((await run([], {})).code).toBe(3);
  });
});
