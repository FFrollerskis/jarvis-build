import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createPublicKey, generateKeyPairSync, randomBytes, verify, type KeyObject } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";

/**
 * WP-C3: lokal FAKE GitHub-server for GitHub App-autentisering (127.0.0.1, ingen eksterne kall). Den gjør det en ekte GitHub gjør med en
 * App-JWT: verifiserer RS256-signaturen mot App-ens OFFENTLIGE nøkkel og kontrollerer claims (`iss`, heltalls-`iat`/`exp`, `iat` ikke i
 * fremtiden, `exp` frem i tid og maks 10 min, levetid maks 10 min) mot SIN EGEN klokke (`serverNow`, kan avvike fra klientens). Svarene
 * følger GitHubs dokumenterte former (201 + token/expires_at/permissions/repository_selection/repositories; 401/403/404/422) og alltid en
 * `Date`-header fra serverklokken.
 */

export interface TestKeys {
  /** GitHubs nedlastingsformat (PKCS#1 `RSA PRIVATE KEY`). */
  readonly pkcs1: string;
  readonly pkcs8: string;
  readonly publicKey: KeyObject;
}

let cachedKeys: TestKeys | undefined;
/** Genereres én gang per testprosess (RSA 2048). Aldri en ekte nøkkel. */
export function testKeys(): TestKeys {
  if (cachedKeys) return cachedKeys;
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  cachedKeys = {
    pkcs1: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    pkcs8: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: createPublicKey(pair.privateKey)
  };
  return cachedKeys;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
  readonly bearer: string | null;
  readonly jwtProblems: readonly string[];
  readonly jwt: { readonly header: Record<string, unknown>; readonly payload: Record<string, unknown> } | null;
  readonly serverNowMs: number;
}

export interface ScriptedResponse {
  readonly status?: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly headers?: Record<string, string>;
  readonly delayMs?: number;
  /** Svar aldri (klienten skal time ut). */
  readonly hang?: boolean;
  /** Kutt forbindelsen midt i forespørselen. */
  readonly closeSocket?: boolean;
  /** Bygg svaret fra selve forespørselen (f.eks. et ondsinnet svar som ekkoer Authorization-headeren tilbake). */
  readonly build?: (request: RecordedRequest) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
}

export interface FakeGitHubOptions {
  readonly publicKey: KeyObject;
  readonly appId: string;
  readonly installationId: string;
  /** Serverens klokke (ms). Standard: ekte klokke. */
  readonly serverNow?: () => number;
  readonly owner?: string;
  /** Repo-NAVN installasjonen har tilgang til. */
  readonly installationRepos?: readonly string[];
  readonly installationPermissions?: Readonly<Record<string, string>>;
  readonly repositorySelection?: "selected" | "all";
}

interface IssuedToken { readonly expiresAtMs: number; readonly repos: readonly string[]; readonly permissions: Record<string, string>; revoked: boolean }

const b64urlDecode = (value: string): Buffer => Buffer.from(value, "base64url");

export class FakeGitHubApp {
  readonly requests: RecordedRequest[] = [];
  /** Brukes i rekkefølge for neste `POST .../access_tokens` (etter at JWT-en er godkjent). Tom = vanlig 201. */
  script: ScriptedResponse[] = [];
  /** Overstyrer svaret på `GET /app/installations/{id}` (og -/ listen) etter JWT-godkjenning. */
  installationOverride: ScriptedResponse | undefined;
  /** Forsinkelse (ms) på vanlige 201-svar - brukes til å bevise single-flight. */
  mintDelayMs = 0;
  readonly issued = new Map<string, IssuedToken>();
  baseUrl = "";
  readonly #options: FakeGitHubOptions;
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;

  private constructor(options: FakeGitHubOptions) {
    this.#options = options;
  }

  static async start(options: FakeGitHubOptions): Promise<FakeGitHubApp> {
    const fake = new FakeGitHubApp(options);
    const server = createServer((req, res) => { void fake.#handle(req, res); });
    fake.#server = server;
    server.on("connection", (socket) => {
      fake.#sockets.add(socket);
      socket.on("close", () => fake.#sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return fake;
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    const server = this.#server;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  serverNow(): number {
    return (this.#options.serverNow ?? Date.now)();
  }

  mintRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === "POST" && /\/access_tokens$/.test(r.path));
  }

  /** Standard 201-kropp for en forespørsel - testene kan endre den for å simulere en leverandør som gir noe annet enn forespurt. */
  buildTokenBody(request: { repositories?: string[]; permissions?: Record<string, string> }): Record<string, unknown> {
    const owner = this.#options.owner ?? "tsworkflow";
    const token = `ghs_${randomBytes(27).toString("base64url").replace(/[^A-Za-z0-9]/g, "x").slice(0, 36)}`;
    const expiresMs = Math.floor((this.serverNow() + 3_600_000) / 1000) * 1000;
    const permissions = request.permissions ?? { ...(this.#options.installationPermissions ?? { contents: "write", metadata: "read", pull_requests: "write", issues: "write", actions: "write" }) };
    const repos = request.repositories ?? [];
    this.issued.set(token, { expiresAtMs: expiresMs, repos, permissions, revoked: false });
    return {
      token,
      expires_at: new Date(expiresMs).toISOString().replace(".000Z", "Z"),
      permissions,
      repository_selection: "selected",
      repositories: repos.map((name, i) => ({ id: 1000 + i, node_id: `R_${i}`, name, full_name: `${owner}/${name}`, private: true }))
    };
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const bearer = /^Bearer (.+)$/.exec(authorization)?.[1] ?? null;
    const nowMs = this.serverNow();
    res.setHeader("Date", new Date(nowMs).toUTCString());

    const isTokenRoute = method === "DELETE" && path === "/installation/token";
    const isRateLimit = method === "GET" && path === "/rate_limit";
    const usesInstallationToken = isTokenRoute || isRateLimit;
    let jwtProblems: string[] = [];
    let jwt: RecordedRequest["jwt"] = null;
    if (!usesInstallationToken && bearer !== null) {
      const checked = this.#checkJwt(bearer, nowMs);
      jwtProblems = checked.problems;
      jwt = checked.parsed;
    } else if (!usesInstallationToken) {
      jwtProblems = ["missing_bearer"];
    }
    const recorded: RecordedRequest = { method, path, headers: req.headers, body, bearer, jwtProblems, jwt, serverNowMs: nowMs };
    this.requests.push(recorded);

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(text);
    };

    if (usesInstallationToken) {
      const entry = bearer ? this.issued.get(bearer) : undefined;
      if (!entry || entry.revoked || entry.expiresAtMs <= nowMs) return send(401, { message: "Bad credentials" });
      if (isTokenRoute) {
        entry.revoked = true;
        res.writeHead(204);
        res.end();
        return;
      }
      return send(200, { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(nowMs / 1000) + 3600, used: 1 } }, rate: { limit: 5000, remaining: 4999 } });
    }

    if (jwtProblems.length > 0) {
      const timeProblem = jwtProblems.find((p) => p.startsWith("exp_") || p.startsWith("iat_") || p === "lifetime_too_long");
      const message = timeProblem?.startsWith("exp_")
        ? "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires"
        : timeProblem?.startsWith("iat_")
          ? "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued"
          : "A JSON web token could not be decoded";
      return send(401, { message, documentation_url: "https://docs.github.com/rest" });
    }

    const installationId = this.#options.installationId;
    const mint = method === "POST" ? new RegExp(`^/app/installations/(\\d+)/access_tokens$`).exec(path) : null;
    if (mint) {
      if (mint[1] !== installationId) return send(404, { message: "Not Found" });
      const scripted = this.script.shift();
      if (scripted) return this.#sendScripted(res, scripted, send, recorded);
      let parsed: { repositories?: string[]; permissions?: Record<string, string> } = {};
      try {
        parsed = body === "" ? {} : (JSON.parse(body) as typeof parsed);
      } catch {
        return send(400, { message: "Problems parsing JSON" });
      }
      const available = new Set((this.#options.installationRepos ?? ["jarvisbuild", "other-repo"]).map((n) => n.toLowerCase()));
      if ((parsed.repositories ?? []).some((name) => !available.has(String(name).toLowerCase()))) {
        return send(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation.", documentation_url: "https://docs.github.com/rest" });
      }
      const granted = this.#options.installationPermissions ?? { contents: "write", metadata: "read", pull_requests: "write", issues: "write", actions: "write" };
      const rank: Record<string, number> = { read: 1, write: 2, admin: 3 };
      for (const [name, level] of Object.entries(parsed.permissions ?? {})) {
        if ((rank[granted[name] ?? ""] ?? 0) < (rank[level] ?? 99)) {
          return send(422, { message: "The permissions requested are not granted to this installation.", documentation_url: "https://docs.github.com/rest" });
        }
      }
      const created = this.buildTokenBody(parsed);
      if (this.mintDelayMs > 0) {
        setTimeout(() => send(201, created), this.mintDelayMs);
        return;
      }
      return send(201, created);
    }

    const info = method === "GET" ? new RegExp(`^/app/installations/(\\d+)$`).exec(path) : null;
    if (info) {
      if (info[1] !== installationId) return send(404, { message: "Not Found" });
      if (this.installationOverride) return this.#sendScripted(res, this.installationOverride, send, recorded);
      return send(200, {
        id: Number(installationId), app_id: Number(this.#options.appId), target_type: "User",
        account: { login: this.#options.owner ?? "tsworkflow", type: "User" },
        repository_selection: this.#options.repositorySelection ?? "selected",
        permissions: this.#options.installationPermissions ?? { contents: "write", metadata: "read", pull_requests: "write", issues: "write", actions: "write" },
        suspended_at: null
      });
    }
    if (method === "GET" && path === "/app/installations") {
      if (this.installationOverride) return this.#sendScripted(res, this.installationOverride, send, recorded);
      return send(200, [{ id: Number(installationId), account: { login: this.#options.owner ?? "tsworkflow", type: "User" }, repository_selection: this.#options.repositorySelection ?? "selected", suspended_at: null }]);
    }
    return send(404, { message: "Not Found" });
  }

  #sendScripted(res: ServerResponse, scripted: ScriptedResponse, send: (status: number, payload: unknown, headers?: Record<string, string>) => void, request: RecordedRequest): void {
    const respond = (): void => {
      if (scripted.closeSocket) {
        res.socket?.destroy();
        return;
      }
      if (scripted.hang) return;
      const built = scripted.build ? scripted.build(request) : scripted;
      send(built.status ?? 200, built.text !== undefined ? built.text : (built.json ?? {}), built.headers ?? scripted.headers ?? {});
    };
    if (scripted.delayMs && scripted.delayMs > 0) setTimeout(respond, scripted.delayMs);
    else respond();
  }

  #checkJwt(token: string, nowMs: number): { problems: string[]; parsed: { header: Record<string, unknown>; payload: Record<string, unknown> } | null } {
    const problems: string[] = [];
    const parts = token.split(".");
    if (parts.length !== 3) return { problems: ["malformed"], parsed: null };
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(b64urlDecode(parts[0] as string).toString("utf8")) as Record<string, unknown>;
      payload = JSON.parse(b64urlDecode(parts[1] as string).toString("utf8")) as Record<string, unknown>;
    } catch {
      return { problems: ["malformed"], parsed: null };
    }
    if (header["alg"] !== "RS256") problems.push("alg");
    if (header["typ"] !== "JWT") problems.push("typ");
    const signatureValid = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), this.#options.publicKey, b64urlDecode(parts[2] as string));
    if (!signatureValid) problems.push("signature");
    if (payload["iss"] !== this.#options.appId) problems.push("iss");
    const nowSec = Math.floor(nowMs / 1000);
    const iat = payload["iat"];
    const exp = payload["exp"];
    if (!Number.isInteger(iat)) problems.push("iat_not_integer");
    else if ((iat as number) > nowSec) problems.push("iat_in_future");
    if (!Number.isInteger(exp)) problems.push("exp_not_integer");
    else {
      if ((exp as number) <= nowSec) problems.push("exp_in_past");
      if ((exp as number) - nowSec > 600) problems.push("exp_too_far");
      if (Number.isInteger(iat) && (exp as number) - (iat as number) > 600) problems.push("lifetime_too_long");
    }
    return { problems, parsed: { header, payload } };
  }
}
