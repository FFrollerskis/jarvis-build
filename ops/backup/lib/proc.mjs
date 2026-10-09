import { spawn, spawnSync } from "node:child_process";

/**
 * WP-C2 (OPS-RUNTIME): små, avgrensede underprosesser for backup-planleggeren. ALLTID en argv-array (aldri shell), ALLTID tidsavbrudd, og utdata er
 * begrenset slik at en løpsk prosess ikke kan fylle minnet. Ved tidsavbrudd drepes hele prosessgruppen (pg_dump/age/docker-barn blir ellers hengende).
 * Ingen avhengigheter utover node:.
 */
const DEFAULT_MAX_STDOUT = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR = 64 * 1024;
/** SIGTERM → SIGKILL etter dette; deretter gis det OPP etter ABANDON (en prosess i uavbrytelig I/O-ventetid, f.eks. hengt NFS/USB, dør ikke av SIGKILL heller). */
const KILL_GRACE_MS = 5_000;
const ABANDON_GRACE_MS = 10_000;

/** Positivliste: kun det rclone/rsync/ssh/age faktisk trenger. DB-passord og andre JARVIS_*-hemmeligheter følger ALDRI med til disse prosessene. */
const ENV_ALLOW = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SYSTEMROOT", "COMSPEC", "PATHEXT"
];
const ENV_ALLOW_PREFIX = ["RCLONE_"];

export function minimalEnv(extra = {}, base = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ENV_ALLOW.includes(key) || ENV_ALLOW_PREFIX.some((p) => key.startsWith(p))) out[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) out[key] = value;
  return out;
}

function killTree(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal); // prosessgruppen (child er gruppeleder via detached)
  } catch {
    try { child.kill(signal); } catch { /* prosessen er allerede borte */ }
  }
}

/**
 * Kjører `file args...` og samler utdata. Kaster aldri: spawn-feil (f.eks. ENOENT) og tidsavbrudd rapporteres i resultatet, så kallerne kan
 * gi en presis, redigert feilkode.
 * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean, spawnError: string | null }>}
 */
export function runProcess(file, args, options = {}) {
  const {
    env = minimalEnv(), cwd, timeoutMs = 0, input, maxStdout = DEFAULT_MAX_STDOUT, maxStderr = DEFAULT_MAX_STDERR,
    killGraceMs = KILL_GRACE_MS, abandonGraceMs = ABANDON_GRACE_MS, kill = killTree
  } = options;
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let spawnError = null;
    let stdout = "";
    let stderr = "";
    let timer;
    let killTimer;
    let abandonTimer;
    const done = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(abandonTimer);
      resolve({ code, signal, stdout, stderr, timedOut, truncated, spawnError });
    };
    let child;
    try {
      child = spawn(file, args, {
        env, cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      });
    } catch (err) {
      spawnError = err?.code ?? "spawn_failed";
      return done(null, null);
    }
    child.on("error", (err) => {
      spawnError = err?.code ?? "spawn_failed";
      done(null, null);
    });
    child.stdout.on("data", (d) => {
      if (stdout.length + d.length > maxStdout) { truncated = true; return; }
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > maxStderr) { truncated = true; stderr = stderr.slice(-maxStderr); } // behold halen (feilen står til slutt)
    });
    child.on("close", (code, signal) => done(code, signal));
    if (input !== undefined) {
      child.stdin.on("error", () => undefined); // EPIPE hvis prosessen avslutter før alt er lest
      child.stdin.end(input);
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill(child, "SIGTERM");
        killTimer = setTimeout(() => {
          kill(child, "SIGKILL");
          // Review F4: kommer 'close' aldri (prosessen sitter fast i kjernen), gir vi opp og rapporterer tidsavbrudd - ellers henger hele tikket (og dermed låsen) for alltid.
          abandonTimer = setTimeout(() => done(null, "SIGKILL"), abandonGraceMs);
        }, killGraceMs);
      }, timeoutMs);
    }
  });
}
