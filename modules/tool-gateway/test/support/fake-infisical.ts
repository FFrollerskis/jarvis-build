import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * WP-E1: lokal FAKE Infisical-server (ekte `node:http`, ingen nettverk ut av maskinen). Etterligner KUN det delsettet transporten bruker: `/api/status`, universal-auth-login,
 * `/api/v3/secrets/raw` (liste + enkelt, med `viewSecretValue`) og Secret Rotation V2 (`/api/v2/secret-rotations`, type-spesifikk `rotate-secrets`). Secrets har
 * BEVISST verdier ("SUPER-HEMMELIG-…") - testene beviser at de aldri kommer ut av transporten, heller ikke når serveren IGNORERER `viewSecretValue=false` (`leakValues`).
 * Brytere: `leakValues`, `rotationsStatus` (feature utilgjengelig), `rotationFails`, `silentlyIgnoreRotate`, `revokeTokens()`, `failNext`, `failReadbackAfterRotate()` (WP-K M-1: rotasjons-listen/readback feiler ETTER at en rotate-POST er akseptert).
 * Gjennomgang av PR #324 (M1): `rotationErrorText` (teksten en feilet rotasjon skriver i `lastRotationJobError`) og meldingen i `failNext` kan settes til FIENDTLIG tekst (se `hostile.ts`).
 */
export interface FakeSecret { key: string; value: string; version: number; createdAt: string; updatedAt: string; tags?: string[]; rotationId?: string; comment?: string }
export interface FakeRotation { id: string; name: string; type: string; environment: string; folder: string; isAutoRotationEnabled: boolean; rotationStatus: string; lastRotatedAt: string | null; lastRotationAttemptedAt: string | null; nextRotationAt: string | null; lastRotationJobError?: string }
export interface InfisicalLoggedRequest { method: string; path: string; query: Record<string, string>; body: unknown; auth: "ok" | "missing" | "wrong" }

export class FakeInfisical {
  readonly clientId = `client-${randomBytes(4).toString("hex")}`;
  readonly clientSecret = `cs-${randomBytes(16).toString("hex")}`;
  readonly projectId = "proj-e1";
  readonly environment = "dev";
  readonly requests: InfisicalLoggedRequest[] = [];
  readonly secrets = new Map<string, FakeSecret>();
  readonly rotations = new Map<string, FakeRotation>();
  leakValues = false;
  rotationsStatus = 200;
  rotationFails = false;
  /** Teksten en feilet rotasjon skriver i `lastRotationJobError` (M1: testene setter den til en fiendtlig streng som siterer en tilkoblingsstreng/et token). */
  rotationErrorText = "upstream rejected credentials for supabase";
  silentlyIgnoreRotate = false;
  statusBody: unknown = { date: "2026-10-09T12:00:00.000Z", message: "Ok", emailConfigured: false, inviteOnlySignup: true, redisConfigured: true, secretScanningConfigured: false };
  loginCount = 0;
  /** WP-K (M-1): antall `rotate-secrets`-POST-er serveren har AKSEPTERT (svart 2xx på). */
  acceptedRotations = 0;
  /** WP-K (M-1): feil som listen (`GET /api/v2/secret-rotations`) gir ETTER at en rotate-POST er akseptert - readback i `rotateSecrets`. `null` = av. */
  private readbackFailure: { status: number; body: string; remaining: number; afterAccepted: number } | null = null;
  private tokens = new Set<string>();
  private readonly failures: Array<{ pattern: RegExp; status: number; remaining: number; message: string }> = [];
  private server: Server | undefined;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res).catch(() => this.send(res, 500, { message: "fake error" })));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Klokken `seedSecret` regner alder mot. Testen setter den til SAMME klokke som transporten bruker, ellers blir `age_days` timing-avhengig (ett ms forskjell gir 9 i stedet for 10). */
  clock: () => number = () => Date.now();

  seedSecret(key: string, value: string, opts: { ageDays?: number; tags?: string[]; rotationId?: string; comment?: string } = {}): void {
    const updated = new Date(this.clock() - (opts.ageDays ?? 0) * 86_400_000).toISOString();
    this.secrets.set(key, { key, value, version: 1, createdAt: updated, updatedAt: updated, ...(opts.tags ? { tags: opts.tags } : {}), ...(opts.rotationId ? { rotationId: opts.rotationId } : {}), ...(opts.comment ? { comment: opts.comment } : {}) });
  }

  seedRotation(opts: Partial<FakeRotation> = {}): FakeRotation {
    const r: FakeRotation = {
      id: randomUUID(), name: "supabase-key", type: "supabase-api-key", environment: this.environment, folder: "/", isAutoRotationEnabled: true, rotationStatus: "success",
      lastRotatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), lastRotationAttemptedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), nextRotationAt: null, ...opts
    };
    this.rotations.set(r.id, r);
    return r;
  }

  revokeTokens(): void {
    this.tokens = new Set();
  }

  failNext(pattern: RegExp, status: number, times = 1, message = "forced failure"): void {
    this.failures.push({ pattern, status, remaining: times, message });
  }

  /**
   * WP-K (M-1): etter at den NESTE `rotate-secrets`-POST-en (etter at bryteren er satt) er AKSEPTERT svarer rotasjons-listen med `status` (og `body`, standard et JSON-objekt; en ikke-JSON-kropp gir en JSON-feil hos klienten) `times` ganger
   * (standard: til `clearReadbackFailure()`). Beviser at en feil i readback ETTER akseptert mutasjon aldri blir en retry-bar `failed`.
   */
  failReadbackAfterRotate(status: number, opts: { body?: string; times?: number } = {}): void {
    this.readbackFailure = { status, body: opts.body ?? JSON.stringify({ message: "readback failed" }), remaining: opts.times ?? Number.POSITIVE_INFINITY, afterAccepted: this.acceptedRotations };
  }

  clearReadbackFailure(): void {
    this.readbackFailure = null;
  }

  requestsMatching(method: string, pattern: RegExp): InfisicalLoggedRequest[] {
    return this.requests.filter((r) => r.method === method && pattern.test(r.path));
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  private sendRaw(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.length === 0) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  private secretView(s: FakeSecret, hide: boolean): Record<string, unknown> {
    return {
      id: `sec-${s.key}`, secretKey: s.key, secretValue: hide ? "<hidden-by-infisical>" : s.value, secretValueHidden: hide, version: s.version, type: "shared",
      createdAt: s.createdAt, updatedAt: s.updatedAt, secretComment: s.comment ?? "", tags: (s.tags ?? []).map((slug) => ({ id: slug, slug, name: slug, color: "#fff" })),
      ...(s.rotationId ? { isRotatedSecret: true, rotationId: s.rotationId } : {})
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const query = Object.fromEntries(url.searchParams.entries());
    const body = req.method === "GET" ? null : await this.readBody(req);
    const header = req.headers["authorization"];
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
    const auth: "ok" | "missing" | "wrong" = token === null ? "missing" : this.tokens.has(token) ? "ok" : "wrong";
    this.requests.push({ method: req.method ?? "GET", path: url.pathname, query, body: url.pathname.includes("/login") ? "(login)" : body, auth });
    const line = `${req.method} ${url.pathname}`;
    const failure = this.failures.find((f) => f.remaining > 0 && f.pattern.test(line));
    if (failure) {
      failure.remaining -= 1;
      return this.send(res, failure.status, { message: failure.message });
    }
    if (req.method === "GET" && url.pathname === "/api/status") return this.send(res, 200, this.statusBody);
    if (req.method === "POST" && url.pathname === "/api/v1/auth/universal-auth/login") {
      const b = (body ?? {}) as { clientId?: string; clientSecret?: string };
      if (b.clientId !== this.clientId || b.clientSecret !== this.clientSecret) return this.send(res, 401, { message: "Invalid credentials" });
      this.loginCount += 1;
      const accessToken = `at-${randomBytes(12).toString("hex")}`;
      this.tokens.add(accessToken);
      return this.send(res, 200, { accessToken, expiresIn: 7200, accessTokenMaxTTL: 43200, tokenType: "Bearer" });
    }
    if (auth !== "ok") return this.send(res, 401, { message: "Unauthorized" });
    const hide = query["viewSecretValue"] === "false" && !this.leakValues;
    if (req.method === "GET" && url.pathname === "/api/v3/secrets/raw") {
      if (query["workspaceId"] !== this.projectId || query["environment"] !== this.environment) return this.send(res, 404, { message: "Folder not found" });
      return this.send(res, 200, { secrets: [...this.secrets.values()].map((s) => this.secretView(s, hide)), imports: [] });
    }
    const one = /^\/api\/v3\/secrets\/raw\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && one) {
      const s = this.secrets.get(decodeURIComponent(one[1]!));
      return s ? this.send(res, 200, { secret: this.secretView(s, hide) }) : this.send(res, 404, { message: "Secret not found" });
    }
    if (req.method === "GET" && url.pathname === "/api/v2/secret-rotations") {
      const failure = this.readbackFailure;
      if (failure && this.acceptedRotations > failure.afterAccepted && failure.remaining > 0) {
        failure.remaining -= 1;
        return this.sendRaw(res, failure.status, failure.body);
      }
      if (this.rotationsStatus !== 200) return this.send(res, this.rotationsStatus, { message: "feature unavailable" });
      return this.send(res, 200, { secretRotations: [...this.rotations.values()] });
    }
    const rotate = /^\/api\/v2\/secret-rotations\/([^/]+)\/([^/]+)\/rotate-secrets$/.exec(url.pathname);
    if (req.method === "POST" && rotate) {
      const r = this.rotations.get(rotate[2]!);
      if (!r || r.type !== rotate[1]) return this.send(res, 404, { message: "Rotation not found" });
      this.acceptedRotations += 1;
      if (this.silentlyIgnoreRotate) return this.send(res, 200, { secretRotation: r });
      if (this.rotationFails) {
        r.rotationStatus = "failed";
        r.lastRotationJobError = this.rotationErrorText;
        r.lastRotationAttemptedAt = new Date().toISOString();
        return this.send(res, 200, { secretRotation: r });
      }
      r.rotationStatus = "success";
      r.lastRotatedAt = new Date().toISOString();
      r.lastRotationAttemptedAt = r.lastRotatedAt;
      delete r.lastRotationJobError;
      return this.send(res, 200, { secretRotation: r });
    }
    this.send(res, 404, { message: "Not found" });
  }
}
