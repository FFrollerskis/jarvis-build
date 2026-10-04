import { spawn } from "node:child_process";

export interface AsyncExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Øvre grense for innsamlet stdout/stderr (hver) - aldri ubegrenset minne fra en løpsk prosess. */
  maxOutputBytes?: number;
}

export interface AsyncExecResult {
  /** `null` = drept av signal (tidsavbrudd) eller aldri startet. */
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Satt når prosessen ikke kunne startes (ENOENT m.m.). */
  spawnError?: string;
}

/**
 * D-394 (JARVIS-023): asynkron prosesskjøring for sandbox-/container-runnere. `spawnSync` blokkerte HELE Node-event-loopen
 * (worker-heartbeat, lease-fornyelse, drain-intervall, HTTP) i opptil `timeoutMs` - en 5-minutters Claude Code-kjøring frøs hele prosessen.
 * Samme kontrakt som før (shell:false, SIGKILL ved tidsavbrudd), men event-loopen lever mens barneprosessen kjører.
 */
export function execProcess(command: string, args: string[], options: AsyncExecOptions = {}): Promise<AsyncExecResult> {
  const maxBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const finish = (result: AsyncExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, args, {
      shell: false,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxBytes) { truncated = true; return current; }
      return current + chunk.toString("utf8").slice(0, maxBytes - current.length);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = options.timeoutMs !== undefined
      ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs)
      : undefined;
    child.on("error", (err) => finish({ status: null, stdout, stderr: stderr || err.message, timedOut, spawnError: err.message }));
    child.on("close", (code) => finish({ status: code, stdout, stderr: truncated ? `${stderr}\n[output_truncated]` : stderr, timedOut }));
  });
}
