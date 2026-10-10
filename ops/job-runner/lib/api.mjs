import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { CancelToken, RunnerError } from "./errors.mjs";
import { UUID_V4, parseCreateJob, parseExec, parsePublish } from "./schemas.mjs";

/**
 * WP-C1: HTTP-API over Unix-domene-socket. API-et er SMALT med vilje:
 *
 *   GET    /v1/health
 *   POST   /v1/jobs                {repo, base_branch?, env?, task_id?, tenant_id?, git_token?}
 *   POST   /v1/jobs/:id/exec       {argv, timeout_ms?, env?}
 *   POST   /v1/jobs/:id/publish    {branch, git_token?}
 *   DELETE /v1/jobs/:id
 *
 * Det tar ALDRI imot docker-flagg, mounts, image, nettverk eller stier. Eneste credential som kan komme i en forespørsel er `git_token` (kortlevd, repo-scopet,
 * kun klone/publish, kun for repoer vertsadmin har satt til `source: request`; se schemas.mjs/jobs.mjs). Autentisering (bearer, konstant-tid) skjer FØR ruting og
 * kroppslesing, så en uautentisert klient ikke kan skille ukjente ruter fra kjente. Ukjente felt avvises, body har hard grense,
 * og feil returnerer en stabil kode - aldri interne feilmeldinger.
 */

export const API_VERSION = "1";

/** Konstant-tid-sammenligning av bearer-token: begge sider hashes (lik lengde) før `timingSafeEqual`. */
export class BearerToken {
  /** @param {string} token */
  constructor(token) {
    this.setToken(token);
  }

  /** @param {string} token */
  setToken(token) {
    if (typeof token !== "string" || token.length < 32 || token.length > 256 || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
      throw new Error("bearer_token_format_invalid");
    }
    this.expected = createHash("sha256").update(token).digest();
  }

  /** A-F5: ugyldiggjør tokenet - ALT gir 401 til et nytt, gyldig token er satt. Brukes når en rotasjon (SIGHUP) feiler: det GAMLE tokenet skal ikke fortsette å virke «som om ingenting skjedde». */
  invalidate() {
    this.expected = undefined;
  }

  /** @param {string} presented */
  verify(presented) {
    const actual = createHash("sha256").update(presented).digest();
    return this.expected !== undefined && timingSafeEqual(actual, this.expected);
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   manager: import("./jobs.mjs").JobManager,
 *   bearer: BearerToken,
 *   logger: ReturnType<typeof import("./log.mjs").createLogger>,
 *   limits: { maxBodyBytes: number, defaultExecTimeoutMs: number, maxExecTimeoutMs: number, allowedRepos: readonly string[], branchPrefix: string, envAllow: readonly string[] },
 *   maxConnections?: number,
 *   authFailureDelayMs?: number
 * }} options
 */
export function createApiServer(options) {
  const { manager, bearer, logger, limits } = options;
  const authFailureDelayMs = options.authFailureDelayMs ?? 200;

  /** @param {http.ServerResponse} res @param {number} status @param {unknown} body @param {Record<string, string>} [extra] */
  function sendJson(res, status, body, extra = {}) {
    if (res.headersSent || res.writableEnded) return;
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      connection: "close",
      ...extra
    });
    res.end(text);
  }

  /** @param {http.IncomingMessage} req */
  function authenticate(req) {
    // Node forkaster duplikate Authorization-headere (beholder første). Vi krever NØYAKTIG én: tvetydig autentisering = avvist.
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) if ((req.rawHeaders[i] ?? "").toLowerCase() === "authorization") count += 1;
    if (count !== 1) throw new RunnerError("unauthorized", 401);
    const header = req.headers["authorization"];
    const m = typeof header === "string" ? /^Bearer ([A-Za-z0-9._~+/=-]{32,256})$/.exec(header) : null;
    if (!m || !bearer.verify(/** @type {string} */ (m[1]))) throw new RunnerError("unauthorized", 401);
  }

  /** @param {http.IncomingMessage} req */
  function parsePath(req) {
    const raw = req.url ?? "";
    // eslint-disable-next-line no-control-regex
    if (raw.length === 0 || raw.length > 200 || !raw.startsWith("/") || /[?#%\\\u0000-\u001f\u007f]/.test(raw) || raw.includes("..") || raw.includes("//")) {
      throw new RunnerError("invalid_path", 400);
    }
    return raw.endsWith("/") && raw.length > 1 ? raw.slice(0, -1) : raw;
  }

  /** @param {http.IncomingMessage} req */
  async function readJsonBody(req) {
    const type = req.headers["content-type"];
    if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type.trim())) {
      throw new RunnerError("unsupported_media_type", 415);
    }
    const declared = req.headers["content-length"];
    if (declared !== undefined && (!/^\d{1,9}$/.test(declared) || Number(declared) > limits.maxBodyBytes)) {
      throw new RunnerError("body_too_large", 413);
    }
    /** @type {Buffer[]} */ const chunks = [];
    let size = 0;
    // `destroyOnReturn:false`: avbryter vi tidlig (for stor body), skal IKKE socketen rives før 413-svaret er sendt.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > limits.maxBodyBytes) throw new RunnerError("body_too_large", 413);
      chunks.push(chunk);
    }
    if (size === 0) throw new RunnerError("invalid_request", 400, "empty_body");
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RunnerError("invalid_json", 400);
    }
  }

  /** @param {http.IncomingMessage} req */
  function assertNoBody(req) {
    const length = req.headers["content-length"];
    if ((length !== undefined && length !== "0") || req.headers["transfer-encoding"] !== undefined) throw new RunnerError("body_not_allowed", 400);
  }

  /** @param {string} id */
  function jobId(id) {
    if (!UUID_V4.test(id)) throw new RunnerError("invalid_job_id", 400);
    return id;
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handle(req, res) {
    const reqId = randomUUID().slice(0, 8);
    /** Avbrytes hvis klienten kobler fra før svaret er ferdig sendt. */
    const gone = new CancelToken();
    res.on("close", () => {
      if (!res.writableFinished) gone.cancel();
    });
    // Forbindelsen kan allerede være borte når behandleren kjører (f.eks. en rørlinjet forespørsel bak en som svarte med `Connection: close`): da har `close`-hendelsen
    // allerede gått, og en mutasjon ville blitt utført uten at noen kunne motta svaret. Aldri behandle en forespørsel uten levende forbindelse.
    if (res.destroyed || req.destroyed || req.socket === null || req.socket === undefined || req.socket.destroyed) return;
    try {
      try {
        authenticate(req);
      } catch (error) {
        await sleep(authFailureDelayMs);
        throw error;
      }
      const path = parsePath(req);
      const method = req.method ?? "";
      const seg = path.split("/").slice(1); // ["v1","jobs",id?,action?]
      if (seg[0] !== "v1") throw new RunnerError("not_found", 404);

      if (seg.length === 2 && seg[1] === "health") {
        if (method !== "GET") throw new RunnerError("method_not_allowed", 405);
        assertNoBody(req);
        return sendJson(res, 200, { status: "ok", api_version: API_VERSION, active_jobs: manager.activeJobs, max_jobs: manager.config.maxConcurrentJobs });
      }
      if (seg[1] !== "jobs") throw new RunnerError("not_found", 404);

      if (seg.length === 2) {
        if (method !== "POST") throw new RunnerError("method_not_allowed", 405);
        const body = parseCreateJob(await readJsonBody(req), limits);
        const created = await manager.create(body, gone);
        return sendJson(res, 201, created);
      }
      const id = jobId(/** @type {string} */ (seg[2]));
      if (seg.length === 3) {
        if (method !== "DELETE") throw new RunnerError("method_not_allowed", 405);
        assertNoBody(req);
        const outcome = await manager.delete(id);
        return sendJson(res, outcome.state === "cleanup_pending" ? 202 : 200, outcome);
      }
      if (seg.length === 4 && seg[3] === "exec") {
        if (method !== "POST") throw new RunnerError("method_not_allowed", 405);
        const body = parseExec(await readJsonBody(req), limits);
        return sendJson(res, 200, await manager.exec(id, body, gone));
      }
      if (seg.length === 4 && seg[3] === "publish") {
        if (method !== "POST") throw new RunnerError("method_not_allowed", 405);
        const body = parsePublish(await readJsonBody(req), limits);
        return sendJson(res, 200, await manager.publish(id, body, gone));
      }
      throw new RunnerError("not_found", 404);
    } catch (error) {
      if (error instanceof RunnerError) {
        if (error.status >= 500 || error.status === 401) logger.warn("request_rejected", { req: reqId, code: error.code, status: error.status });
        // Ikke-lest, for stor body: riv forbindelsen når svaret er sendt (ellers kan klienten fortsette å pumpe data).
        if (error.status === 413) res.once("finish", () => req.socket?.destroy());
        return sendJson(res, error.status, { error: error.code, ...(error.detail !== undefined ? { detail: error.detail } : {}) },
          error.status === 401 ? { "www-authenticate": "Bearer" } : {});
      }
      logger.error("internal_error", { req: reqId, reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      return sendJson(res, 500, { error: "internal_error" });
    }
  }

  /** Én forespørsel per forbindelse: ALLE svar har `Connection: close`, så en ekstra (rørlinjet) forespørsel på samme forbindelse kan aldri besvares og skal ikke utføres. */
  const served = new WeakSet();
  const server = http.createServer(
    { maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 1_000 },
    (req, res) => {
      if (served.has(req.socket)) {
        req.socket.destroy();
        return;
      }
      served.add(req.socket);
      void handle(req, res);
    }
  );
  server.maxConnections = options.maxConnections ?? 32;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    else socket.destroy();
  });
  return server;
}
