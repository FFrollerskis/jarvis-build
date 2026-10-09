import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancelToken } from "../../lib/errors.mjs";
import { runProcess } from "../../lib/process.mjs";

/**
 * Testdobler for `docker` (injisert som `DockerExec`). Etterligner NØYAKTIG de kallene runneren gjør
 * (`version`, `network inspect`, `create`, `start`, `exec`, `rm -f -v`, `ps -a`) og husker alt som ble gjort:
 *   - `calls`: hvert kall med argv OG env (verdiene, slik at tester kan bevise at hemmeligheter ligger i env og aldri i argv),
 *   - `containers`: «containere» med parsede flagg, merkelapper, mounts og env.
 * `exec` KJØRER kommandoen på verten (ekte `git`/`node`/`sh`) med cwd = bind-mount-kilden for /work - dette er en TESTDOBLER for
 * containeren, ikke noe produksjonskode noensinne gjør. Verktøyet er bevisst enkelt; ekte Docker-oppførsel er `NOT VERIFIED`
 * og dekkes av `ops/job-runner/acceptance.sh` på verten.
 */

const BOOLEAN_FLAGS = new Set(["--init", "--read-only", "--privileged"]);

/** @param {string[]} args */
export function parseCreateArgs(args) {
  const rest = args.slice(1);
  /** @type {Record<string, string[]>} */ const flags = {};
  const booleans = new Set();
  let i = 0;
  for (; i < rest.length; i += 1) {
    const token = /** @type {string} */ (rest[i]);
    if (BOOLEAN_FLAGS.has(token)) { booleans.add(token); continue; }
    if (token.startsWith("-")) {
      const value = rest[i + 1] ?? "";
      (flags[token] ??= []).push(value);
      i += 1;
      continue;
    }
    break;
  }
  return { flags, booleans, image: rest[i], command: rest.slice(i + 1) };
}

/**
 * @param {{ networkName?: string }} [options]
 */
export function createFakeDocker(options = {}) {
  const networkName = options.networkName ?? "jarvis-jobs";
  const home = mkdtempSync(join(tmpdir(), "jr-fakehome-"));
  /** @type {Array<{ args: string[], env: Record<string, string> }>} */
  const calls = [];
  /** @type {Map<string, any>} */
  const containers = new Map();
  /** @type {Map<string, Set<CancelToken>>} */
  const running = new Map();
  const state = {
    networkInternal: true,
    daemonDown: false,
    failCreate: false,
    failStart: false,
    /** `docker rm` feiler (daemon henger) */
    failRemove: false,
    /** valgfri avskjæring: (ctx) => ProcessResult-lignende | undefined */
    onExec: /** @type {null | ((ctx: { container: any, argv: string[], env: Record<string, string>, cwd: string, opts: any }) => Promise<any> | any)} */ (null)
  };

  const result = (/** @type {number} */ status, /** @type {string} */ stdout = "", /** @type {string} */ stderr = "") => ({
    status, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), timedOut: false, truncated: false, cancelled: false
  });

  /** @type {import("../../lib/docker.mjs").DockerExec} */
  async function exec(args, opts = {}) {
    calls.push({ args: [...args], env: { ...(opts.env ?? {}) } });
    if (state.daemonDown) return result(1, "", "Cannot connect to the Docker daemon");
    const [command, ...rest] = args;
    switch (command) {
      case "version":
        return result(0, "27.3.1\n");
      case "network": {
        if (rest[0] !== "inspect") return result(1, "", "unsupported");
        const name = rest[rest.length - 1];
        if (name !== networkName) return result(1, "", `Error: No such network: ${name}`);
        return result(0, `${state.networkInternal} bridge\n`);
      }
      case "create": {
        if (state.failCreate) return result(1, "", "Error response from daemon: create failed");
        const parsed = parseCreateArgs(args);
        const name = parsed.flags["--name"]?.[0] ?? "";
        const mount = parsed.flags["--mount"]?.[0] ?? "";
        const source = /(?:^|,)source=([^,]+)/.exec(mount)?.[1] ?? "";
        const target = /(?:^|,)target=([^,]+)/.exec(mount)?.[1] ?? "";
        /** @type {Record<string, string>} */
        const envResolved = {};
        for (const e of parsed.flags["-e"] ?? []) {
          const eq = e.indexOf("=");
          if (eq > 0) envResolved[e.slice(0, eq)] = e.slice(eq + 1);
          else if (opts.env && e in opts.env) envResolved[e] = /** @type {string} */ (opts.env[e]);
        }
        /** @type {Record<string, string>} */
        const labels = {};
        for (const l of parsed.flags["--label"] ?? []) {
          const eq = l.indexOf("=");
          labels[l.slice(0, eq)] = l.slice(eq + 1);
        }
        containers.set(name, { name, parsed, image: parsed.image, source, target, mounts: mount ? [{ source, target }] : [], env: envResolved, labels, started: false, argv: args });
        return result(0, `${name}-id\n`);
      }
      case "start": {
        const c = containers.get(rest[0] ?? "");
        if (!c) return result(1, "", `Error response from daemon: No such container: ${rest[0]}`);
        if (state.failStart) return result(1, "", "Error response from daemon: start failed");
        c.started = true;
        return result(0, `${c.name}\n`);
      }
      case "exec": {
        // exec --workdir /work [-e NAME]... <container> <argv...>
        let i = 0;
        const envNames = [];
        while (i < rest.length) {
          if (rest[i] === "--workdir") { i += 2; continue; }
          if (rest[i] === "-e") { envNames.push(/** @type {string} */ (rest[i + 1])); i += 2; continue; }
          break;
        }
        const name = rest[i] ?? "";
        const argv = rest.slice(i + 1);
        const c = containers.get(name);
        if (!c) return result(1, "", `Error response from daemon: No such container: ${name}`);
        if (!c.started) return result(1, "", `Error response from daemon: container ${name} is not running`);
        /** @type {Record<string, string>} */
        const execEnv = {};
        for (const n of envNames) if (opts.env && n in opts.env) execEnv[n] = /** @type {string} */ (opts.env[n]);
        const cwd = c.source;
        if (state.onExec) {
          const intercepted = await state.onExec({ container: c, argv, env: execEnv, cwd, opts });
          if (intercepted) return { ...result(0), ...intercepted };
        }
        const token = new CancelToken();
        const set = running.get(name) ?? new Set();
        set.add(token);
        running.set(name, set);
        const unsubscribe = opts.cancel ? opts.cancel.onCancel(() => token.cancel()) : () => undefined;
        try {
          // «Containerens» miljø: de konstante/valgte env-verdiene + HOME på en egen tom katalog, og et ellers tomt miljø (ingen arv av testprosessens env).
          const env = {
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            ...c.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...execEnv
          };
          const r = await runProcess(argv[0] ?? "", argv.slice(1), {
            cwd, env, cancel: token,
            ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
            ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {})
          });
          return r;
        } finally {
          unsubscribe();
          set.delete(token);
        }
      }
      case "rm": {
        const name = rest[rest.length - 1] ?? "";
        if (state.failRemove) return result(1, "", "Error response from daemon: cannot remove container: device busy");
        const c = containers.get(name);
        if (!c) return result(1, "", `Error response from daemon: No such container: ${name}`);
        for (const token of running.get(name) ?? []) token.cancel();
        containers.delete(name);
        running.delete(name);
        return result(0, `${name}\n`);
      }
      case "ps": {
        const names = [...containers.values()].filter((c) => c.labels["jarvis.role"] === "job").map((c) => c.name);
        return result(0, names.length > 0 ? `${names.join("\n")}\n` : "");
      }
      default:
        return result(1, "", `fake-docker: unsupported command ${String(command)}`);
    }
  }

  return { exec, calls, containers, state, networkName, home, running };
}
