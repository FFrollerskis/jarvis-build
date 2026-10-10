import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * WP-E1: lokal FAKE Langfuse-server (ekte `node:http`, ingen nettverk ut av maskinen). Etterligner KUN det delsettet transporten bruker: `/api/public/health`,
 * `/api/public/projects` (Basic-auth), `/api/public/metrics/daily` og `/api/public/traces` (med `meta.totalItems`). Trace-listen inneholder BEVISST sensitivt
 * innhold (prompt/svar/bruker) - testene beviser at det aldri kommer ut av transporten.
 * Brytere: `dailyMetricsAvailable` (404 på metrics/daily -> fallback), `healthStatus`, `healthBody`, `failNext` (valgfri melding - M1: fiendtlig tekst, se `hostile.ts`).
 * Nøkkelverdier lagres ALDRI i forespørselsloggen - kun om autentiseringen var riktig/feil/mangler.
 */
const hex = (n: number): string => randomBytes(n).toString("hex");

export interface LangfuseLoggedRequest { method: string; path: string; query: Record<string, string>; auth: "ok" | "missing" | "wrong" }

export class FakeLangfuse {
  readonly publicKey = `pk-lf-${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`;
  readonly secretKey = `sk-lf-${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`;
  readonly requests: LangfuseLoggedRequest[] = [];
  dailyMetricsAvailable = true;
  healthStatus = 200;
  healthBody: unknown = { status: "OK", version: "2.95.11" };
  projects: unknown[] = [{ id: "proj-1", name: "Jarvis", organization: { id: "org-1", name: "Tobias" }, secretNote: "skal-ikke-videre" }];
  daily: Array<Record<string, unknown>> = [
    { date: "2026-10-07", countTraces: 12, countObservations: 40, totalCost: 0.1234, usage: [{ model: "gpt-x", inputUsage: 1, outputUsage: 2 }] },
    { date: "2026-10-08", countTraces: 30, countObservations: 90, totalCost: 0.5, usage: [] }
  ];
  /** Skal ALDRI sees i noe transporten returnerer. */
  readonly traces = [{ id: "t1", name: "chat", input: "HEMMELIG-PROMPT-INNHOLD", output: "HEMMELIG-SVAR", userId: "bruker-42", sessionId: "sesjon-7", metadata: { tenant_id: "tenant-x" } }];
  private readonly failures: Array<{ pattern: RegExp; status: number; remaining: number; message: string }> = [];
  private server: Server | undefined;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  failNext(pattern: RegExp, status: number, times = 1, message = "forced failure"): void {
    this.failures.push({ pattern, status, remaining: times, message });
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  private authOf(req: IncomingMessage): "ok" | "missing" | "wrong" {
    const header = req.headers["authorization"];
    if (typeof header !== "string") return "missing";
    return header === `Basic ${Buffer.from(`${this.publicKey}:${this.secretKey}`).toString("base64")}` ? "ok" : "wrong";
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://fake");
    const query = Object.fromEntries(url.searchParams.entries());
    const auth = this.authOf(req);
    this.requests.push({ method: req.method ?? "GET", path: url.pathname, query, auth });
    const line = `${req.method} ${url.pathname}`;
    const failure = this.failures.find((f) => f.remaining > 0 && f.pattern.test(line));
    if (failure) {
      failure.remaining -= 1;
      return this.send(res, failure.status, { message: failure.message });
    }
    if (req.method === "GET" && url.pathname === "/api/public/health") {
      return this.send(res, this.healthStatus, this.healthBody);
    }
    if (auth !== "ok") return this.send(res, 401, { message: "Invalid credentials" });
    if (req.method === "GET" && url.pathname === "/api/public/projects") return this.send(res, 200, { data: this.projects });
    if (req.method === "GET" && url.pathname === "/api/public/metrics/daily") {
      if (!this.dailyMetricsAvailable) return this.send(res, 404, { message: "Not found" });
      return this.send(res, 200, { data: this.daily, meta: { page: 1, limit: Number(query["limit"] ?? 50), totalItems: this.daily.length, totalPages: 1 } });
    }
    if (req.method === "GET" && url.pathname === "/api/public/traces") {
      return this.send(res, 200, { data: this.traces.slice(0, Number(query["limit"] ?? 50)), meta: { page: 1, limit: Number(query["limit"] ?? 50), totalItems: 4321, totalPages: 4321 } });
    }
    this.send(res, 404, { message: "Not found" });
  }
}
