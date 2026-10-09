import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WP-C1: en ekte git smart-HTTP-server (over `git http-backend`) for tester av kortlevde tokens i forespørselen (`source: request`). Kjøres som EGEN
 * barneprosess (i dette sandbox-miljøet når ikke en git-underprosess en loopback-socket som vitest-prosessen selv åpnet - se probe-server.mjs).
 *
 * Det den gjør som de eksisterende hjelperne ikke gjør:
 *  - godtar flere credentials, hver valgfritt BUNDET til én repo-sti (`owner/repo.git`) - kan dermed bevise at et token for repo A aldri virker for repo B,
 *  - logger for HVER autentiserte forespørsel `{repo, op: "fetch"|"push", h}` der `h` = de 12 første hex-tegnene av SHA-256(passordet). Hash identifiserer
 *    HVILKET token som ble brukt til HVILKEN operasjon uten at selve tokenet noen gang forlater serverprosessen,
 *  - kan REFLEKTERE passordet (`reflect: "fetch" | "push"`) i en git-protokollfeil (`ERR <passord>`) slik at git skriver hele tokenet på stderr - den verste
 *    tenkelige lekkasjen inn i feildetaljene - for å teste at redigeringen holder.
 *
 * Utelukkende testinfrastruktur.
 */

/** De 12 første hex-tegnene av SHA-256 (samme funksjon brukes i testene). */
export const fingerprint = (secret) => createHash("sha256").update(secret).digest("hex").slice(0, 12);

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "serve") {
  const { reposRoot, accepted, reflect } = JSON.parse(process.argv[3]);
  const log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);
  const pkt = (text) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
  const basic = (header) => {
    if (typeof header !== "string" || !header.startsWith("Basic ")) return null;
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    return idx < 0 ? null : { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const repo = /^\/(.+?\.git)(?:\/|$)/.exec(url.pathname)?.[1] ?? "";
    const op = url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack" ? "push" : "fetch";
    const auth = basic(req.headers["authorization"]);
    const ok = auth !== null && accepted.some((a) => a.user === auth.user && a.pass === auth.pass && (a.repo === undefined || a.repo === repo));
    if (!ok) {
      log({ ev: "denied", repo, op, withAuth: auth !== null, h: auth ? createHash("sha256").update(auth.pass).digest("hex").slice(0, 12) : null });
      res.writeHead(401, { "www-authenticate": 'Basic realm="jarvis-test"' });
      return res.end();
    }
    log({ ev: "auth", repo, op, user: auth.user, h: createHash("sha256").update(auth.pass).digest("hex").slice(0, 12) });
    if (reflect === op && req.method === "GET" && url.searchParams.has("service")) {
      const service = url.searchParams.get("service");
      res.writeHead(200, { "content-type": `application/x-${service}-advertisement`, "cache-control": "no-cache" });
      return res.end(`${pkt(`# service=${service}\n`)}0000${pkt(`ERR ${auth.pass} avvist\n`)}`);
    }
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH, GIT_PROJECT_ROOT: reposRoot, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method ?? "GET", CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: req.headers["content-length"] ?? "0", REMOTE_USER: auth.user, GATEWAY_INTERFACE: "CGI/1.1",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? ""
      }
    });
    req.pipe(child.stdin);
    let buf = Buffer.alloc(0);
    let parsed = false;
    child.stdout.on("data", (chunk) => {
      if (parsed) return void res.write(chunk);
      buf = Buffer.concat([buf, chunk]);
      const crlf = buf.indexOf("\r\n\r\n");
      const lf = buf.indexOf("\n\n");
      const idx = crlf !== -1 ? crlf : lf;
      if (idx === -1) return;
      const sepLen = crlf !== -1 ? 4 : 2;
      const headers = {};
      let status = 200;
      for (const line of buf.subarray(0, idx).toString("utf8").split(/\r?\n/)) {
        const ci = line.indexOf(":");
        if (ci < 0) continue;
        const k = line.slice(0, ci).trim();
        const v = line.slice(ci + 1).trim();
        if (k.toLowerCase() === "status") status = parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      const rest = buf.subarray(idx + sepLen);
      if (rest.length > 0) res.write(rest);
      parsed = true;
    });
    child.stdout.on("end", () => res.end());
    child.on("error", () => res.end());
  });
  server.listen(0, "127.0.0.1", () => log({ listening: server.address().port }));
}

/**
 * @param {{ accepted: Array<{ user?: string, pass: string, repo?: string }>, reflect?: "fetch" | "push" }} options
 * @returns {Promise<{
 *   port: number, host: string, reposRoot: string,
 *   events: Array<{ ev: string, repo: string, op: string, h: string | null, withAuth?: boolean, user?: string }>,
 *   createBareRepo: (name: string) => string, stop: () => void
 * }>}
 */
export function startTokenGitServer(options) {
  const reposRoot = mkdtempSync(join(tmpdir(), "jr-tokgit-"));
  const accepted = options.accepted.map((a) => ({ user: "x-access-token", ...a }));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", JSON.stringify({ reposRoot, accepted, reflect: options.reflect ?? null })], {
      stdio: ["ignore", "pipe", "inherit"]
    });
    const events = [];
    let pending = "";
    child.stdout.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.listening) {
          resolve({
            port: msg.listening, host: `127.0.0.1:${msg.listening}`, reposRoot, events,
            createBareRepo: (name) => {
              const dir = join(reposRoot, name);
              mkdirSync(dir, { recursive: true });
              const git = (cwd, args) => {
                const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env["PATH"], HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "s", GIT_AUTHOR_EMAIL: "s@t", GIT_COMMITTER_NAME: "s", GIT_COMMITTER_EMAIL: "s@t" } });
                if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
                return r.stdout.trim();
              };
              git(dir, ["init", "--bare", "--quiet", "--initial-branch=main", "."]);
              git(dir, ["config", "http.receivepack", "true"]);
              const seed = mkdtempSync(join(tmpdir(), "jr-tokgit-seed-"));
              git(seed, ["init", "--quiet", "--initial-branch=main", "."]);
              writeFileSync(join(seed, "README.md"), "# seed\n");
              git(seed, ["add", "-A"]);
              git(seed, ["commit", "--quiet", "-m", "c1"]);
              git(seed, ["push", "--quiet", dir, "main"]);
              return git(dir, ["rev-parse", "main"]);
            },
            stop: () => child.kill()
          });
        } else {
          events.push(msg);
        }
      }
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("token-git-server startet ikke")), 8_000).unref();
  });
}
