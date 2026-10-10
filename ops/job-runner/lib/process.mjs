import { spawn } from "node:child_process";

/**
 * WP-C1: ENESTE sted ops/job-runner starter underprosesser. `shell: false` (argv-liste, aldri en streng som tolkes av en shell),
 * egen prosessgruppe (kill tar med barnebarn som `git-remote-https` og credential-helperen), SIGKILL ved tidsavbrudd, tak på
 * innsamlet output (en løpsk prosess kan ikke fylle minnet) og kooperativ kansellering.
 */

/**
 * @typedef {{
 *   status: number | null, signal: string | null, stdout: Buffer, stderr: Buffer,
 *   timedOut: boolean, truncated: boolean, cancelled: boolean, spawnError?: string
 * }} ProcessResult
 */

/**
 * @param {string} bin absolutt sti eller kommandonavn (aldri bruker-/klientstyrt)
 * @param {string[]} args
 * @param {{
 *   cwd?: string, env?: Record<string, string>, timeoutMs?: number, maxOutputBytes?: number,
 *   input?: Buffer | string, cancel?: import("./errors.mjs").CancelToken
 * }} [options]
 * @returns {Promise<ProcessResult>}
 */
export function runProcess(bin, args, options = {}) {
  const maxBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve) => {
    /** @type {Buffer[]} */ const out = [];
    /** @type {Buffer[]} */ const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** @type {(() => void) | undefined} */
    let unsubscribe;

    const finish = (/** @type {Partial<ProcessResult>} */ extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (unsubscribe) unsubscribe();
      resolve({
        status: null, signal: null, stdout: Buffer.concat(out), stderr: Buffer.concat(err),
        timedOut, truncated, cancelled, ...extra
      });
    };

    let child;
    try {
      child = spawn(bin, args, {
        shell: false,
        detached: true, // egen prosessgruppe -> hele treet kan drepes
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"]
      });
    } catch (error) {
      finish({ spawnError: error instanceof Error ? error.message : "spawn_failed" });
      return;
    }

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // allerede avsluttet
        }
      }
    };

    child.stdout?.on("data", (/** @type {Buffer} */ chunk) => {
      if (outBytes >= maxBytes) { truncated = true; return; }
      const room = maxBytes - outBytes;
      if (chunk.length > room) { out.push(chunk.subarray(0, room)); outBytes += room; truncated = true; } else { out.push(chunk); outBytes += chunk.length; }
    });
    child.stderr?.on("data", (/** @type {Buffer} */ chunk) => {
      if (errBytes >= maxBytes) { truncated = true; return; }
      const room = maxBytes - errBytes;
      if (chunk.length > room) { err.push(chunk.subarray(0, room)); errBytes += room; truncated = true; } else { err.push(chunk); errBytes += chunk.length; }
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, options.timeoutMs);
    }
    if (options.cancel) {
      unsubscribe = options.cancel.onCancel(() => {
        cancelled = true;
        killTree();
      });
    }

    child.on("error", (error) => finish({ spawnError: error.message }));
    child.on("close", (code, signal) => finish({ status: code, signal }));

    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined); // EPIPE hvis prosessen avslutter før all input er lest
      child.stdin.end(options.input);
    }
  });
}
