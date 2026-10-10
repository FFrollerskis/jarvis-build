import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * WP-E1: lokal FAKE Cloudflare-API-server (ekte `node:http`, ingen nettverk ut av maskinen) for transport-/gateway-/gjenopprettingstester. Den
 * etterligner KUN det delsettet av API-et som er verifisert mot dokumentasjonen (se `cloudflare-transport.ts`): svarkonvolutt
 * `{success, errors, messages, result, result_info}`, paginering, Bearer-autentisering, DNS-poster, Rulesets (entrypoint, regler med versjonering),
 * per-innstilling sone-innstillinger, cache-purge og konto-lister. Feilkodene i `errors[].code` er FAKE-spesifikke (ikke Cloudflares ekte koder).
 *
 * Atferdsbrytere for å bevise fail-closed/PARTIAL-stier: `ignoreFilters` (serveren ignorerer name/type-filter), `silentlyIgnoreWrites` (200 uten
 * endring), `ruleUpdateSemantics` ("replace" = verste tilfelle: felt som ikke sendes forsvinner), `quoteTxt`, `rateLimitNext`, `failNext`.
 * Token-verdien lagres ALDRI i forespørselsloggen - kun om headeren var riktig/feil/mangler.
 */
export const hex32 = (): string => randomBytes(16).toString("hex");

export interface FakeZone { id: string; name: string; account_id: string; status: string }
export interface FakeDnsRecord { id: string; type: string; name: string; content: string; ttl: number; proxied: boolean; comment: string | null; priority?: number; created_on: string; modified_on: string }
export interface FakeRule { id: string; ref?: string; version: string; last_updated: string; action: string; expression: string; description: string; enabled: boolean; [key: string]: unknown }
export interface FakeRuleset { id: string; name: string; phase: string; kind: string; version: string; last_updated: string; rules: FakeRule[] }
export interface LoggedRequest { method: string; path: string; query: Record<string, string>; body: unknown; auth: "ok" | "missing" | "wrong" }

const SETTINGS_DEFAULT: Record<string, string> = { ssl: "full", min_tls_version: "1.2", always_use_https: "off", development_mode: "off", security_level: "medium", tls_1_3: "on" };
const SETTINGS_ALLOWED: Record<string, string[]> = {
  ssl: ["off", "flexible", "full", "strict"], min_tls_version: ["1.0", "1.1", "1.2", "1.3"], always_use_https: ["on", "off"],
  development_mode: ["on", "off"], security_level: ["off", "essentially_off", "low", "medium", "high", "under_attack"], tls_1_3: ["on", "off", "zrt"]
};

export class FakeCloudflare {
  readonly token: string;
  readonly accountId: string;
  readonly zones = new Map<string, FakeZone>();
  readonly dns = new Map<string, Map<string, FakeDnsRecord>>();
  readonly rulesets = new Map<string, Map<string, FakeRuleset>>();
  readonly settings = new Map<string, Map<string, string>>();
  readonly purges: Array<{ zone_id: string; body: Record<string, unknown> }> = [];
  readonly requests: LoggedRequest[] = [];
  members: unknown[] = [];
  roles: unknown[] = [];
  apiTokens: unknown[] = [];
  auditEvents: unknown[] = [];
  tokenKind: "account" | "user" = "account";
  tokenStatus = "active";
  ignoreFilters = false;
  silentlyIgnoreWrites = false;
  ruleUpdateSemantics: "replace" | "merge" = "replace";
  /** M4: feltnavn en PATCH SILENT dropper fra regelen uansett hva som sendes (simulerer en leverandør som ikke bevarer ukjente felt). */
  patchDropsFields: string[] = [];
  /** M4: felt leverandøren SELV legger til en regel ved hver PATCH (f.eks. standardverdier) - skal ikke gi falsk «felt mistet». */
  patchAddsFields: Record<string, unknown> = {};
  quoteTxt = true;
  /** Visningsnavn i sone-svaret (M1: testene setter dem til fiendtlig tekst, se `hostile.ts`). */
  accountName = "Test account";
  planName = "Free";
  /** L2: de neste forespørslene hvis «METHOD /sti» matcher `pattern` svarer med en redirect (`status` + `location`). */
  private readonly redirects: Array<{ pattern: RegExp; status: number; location: string; remaining: number }> = [];
  private rateLimited = 0;
  private rateLimitRetryAfter: string | null = null;
  private readonly failures: Array<{ pattern: RegExp; status: number; body?: unknown; remaining: number }> = [];
  private server: Server | undefined;
  baseUrl = "";

  constructor(options: { token?: string; accountId?: string } = {}) {
    this.token = options.token ?? `cf-test-token-${hex32()}`;
    this.accountId = options.accountId ?? hex32();
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res).catch((err) => this.send(res, 500, this.error(99999, String(err)))));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/client/v4`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  addZone(name: string, accountId: string = this.accountId): string {
    const id = hex32();
    this.zones.set(id, { id, name, account_id: accountId, status: "active" });
    this.dns.set(id, new Map());
    this.rulesets.set(id, new Map());
    this.settings.set(id, new Map(Object.entries(SETTINGS_DEFAULT)));
    return id;
  }

  seedDns(zoneId: string, r: { type: string; name: string; content: string; ttl?: number; proxied?: boolean; comment?: string | null; priority?: number }): string {
    const id = hex32();
    const now = new Date().toISOString();
    this.dns.get(zoneId)!.set(id, {
      id, type: r.type, name: r.name.toLowerCase(), content: this.storeContent(r.type, r.content), ttl: r.ttl ?? 1, proxied: r.proxied ?? false,
      comment: r.comment ?? null, ...(r.priority !== undefined ? { priority: r.priority } : {}), created_on: now, modified_on: now
    });
    return id;
  }

  seedRule(zoneId: string, phase: string, rule: Partial<FakeRule> & { action: string; expression: string }): { rulesetId: string; ruleId: string } {
    let rs = this.rulesets.get(zoneId)!.get(phase);
    if (!rs) {
      rs = { id: hex32(), name: "default", phase, kind: "zone", version: "1", last_updated: new Date().toISOString(), rules: [] };
      this.rulesets.get(zoneId)!.set(phase, rs);
    }
    const id = hex32();
    rs.rules.push({ id, version: "1", last_updated: new Date().toISOString(), description: "", enabled: true, ...rule });
    return { rulesetId: rs.id, ruleId: id };
  }

  redirectNext(pattern: RegExp, status: number, location: string, times = 1): void {
    this.redirects.push({ pattern, status, location, remaining: times });
  }

  /** De neste `n` forespørslene svarer 429 (med valgfri Retry-After). */
  rateLimitNext(n: number, retryAfterSeconds: number | null = null): void {
    this.rateLimited = n;
    this.rateLimitRetryAfter = retryAfterSeconds === null ? null : String(retryAfterSeconds);
  }

  /** De neste `times` forespørslene hvis «METHOD /sti» matcher `pattern` svarer `status`. */
  failNext(pattern: RegExp, status: number, body?: unknown, times = 1): void {
    this.failures.push({ pattern, status, ...(body !== undefined ? { body } : {}), remaining: times });
  }

  requestsMatching(method: string, pathPattern: RegExp): LoggedRequest[] {
    return this.requests.filter((r) => r.method === method && pathPattern.test(r.path));
  }

  writeRequests(): LoggedRequest[] {
    return this.requests.filter((r) => r.method !== "GET");
  }

  private storeContent(type: string, content: string): string {
    return type === "TXT" && this.quoteTxt && !(content.startsWith('"') && content.endsWith('"')) ? `"${content}"` : content;
  }

  private error(code: number, message: string): unknown {
    return { success: false, errors: [{ code, message }], messages: [], result: null };
  }

  private ok(result: unknown, info?: Record<string, unknown>): unknown {
    return { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) };
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private paginate<T>(items: T[], query: Record<string, string>): { page: T[]; info: Record<string, unknown> } {
    const perPage = Math.max(1, Math.min(Number(query["per_page"] ?? 20), 5_000_000));
    const pageNo = Math.max(1, Number(query["page"] ?? 1));
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    const page = items.slice((pageNo - 1) * perPage, pageNo * perPage);
    return { page, info: { page: pageNo, per_page: perPage, count: page.length, total_count: items.length, total_pages: totalPages } };
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.length === 0) return undefined;
    try { return JSON.parse(text); } catch { return { __invalid_json: true }; }
  }

  private versionBump(rs: FakeRuleset): void {
    rs.version = String(Number(rs.version) + 1);
    rs.last_updated = new Date().toISOString();
  }

  private rulesetView(rs: FakeRuleset): unknown {
    return { id: rs.id, name: rs.name, phase: rs.phase, kind: rs.kind, version: rs.version, last_updated: rs.last_updated, rules: rs.rules.map((r) => ({ ...r })) };
  }

  private dnsView(r: FakeDnsRecord): unknown {
    return { ...r };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });
    const header = req.headers["authorization"];
    const auth: LoggedRequest["auth"] = header === undefined ? "missing" : header === `Bearer ${this.token}` ? "ok" : "wrong";
    const body = method === "GET" || method === "DELETE" ? undefined : await this.readBody(req);
    const path = url.pathname.replace(/^\/client\/v4/, "");
    this.requests.push({ method, path, query, body, auth });

    for (const r of this.redirects) {
      if (r.remaining > 0 && r.pattern.test(`${method} ${path}`)) {
        r.remaining -= 1;
        res.writeHead(r.status, { location: r.location });
        return void res.end();
      }
    }
    if (auth !== "ok") return this.send(res, 401, this.error(10000, "Authentication error"));
    if (this.rateLimited > 0) {
      this.rateLimited -= 1;
      return this.send(res, 429, this.error(971, "Rate limited"), this.rateLimitRetryAfter ? { "retry-after": this.rateLimitRetryAfter } : {});
    }
    for (const f of this.failures) {
      if (f.remaining > 0 && f.pattern.test(`${method} ${path}`)) {
        f.remaining -= 1;
        return this.send(res, f.status, f.body ?? this.error(f.status * 10, "injected failure"));
      }
    }

    let m: RegExpMatchArray | null;
    // --- token
    if (method === "GET" && path === "/user/tokens/verify") {
      if (this.tokenKind !== "user") return this.send(res, 400, this.error(1000, "Invalid API Token"));
      return this.send(res, 200, this.ok({ id: "tokid-user", status: this.tokenStatus, expires_on: "2030-01-01T00:00:00Z", not_before: "2020-01-01T00:00:00Z" }));
    }
    if (method === "GET" && (m = path.match(/^\/accounts\/([0-9a-f]{32})\/tokens\/verify$/))) {
      if (this.tokenKind !== "account" || m[1] !== this.accountId) return this.send(res, 400, this.error(1000, "Invalid API Token"));
      return this.send(res, 200, this.ok({ id: "tokid-account", status: this.tokenStatus }));
    }
    // --- zoner
    if (method === "GET" && path === "/zones") {
      let list = [...this.zones.values()];
      if (query["account.id"] !== undefined && !this.ignoreFilters) list = list.filter((z) => z.account_id === query["account.id"]);
      const { page, info } = this.paginate(list, { ...query, per_page: String(Math.min(Number(query["per_page"] ?? 20), 50)) });
      return this.send(res, 200, this.ok(page.map((z) => ({ id: z.id, name: z.name, status: z.status, paused: false, type: "full", account: { id: z.account_id, name: this.accountName }, name_servers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"], plan: { name: this.planName } })), info));
    }
    if (method === "GET" && (m = path.match(/^\/zones\/([0-9a-f]{32})$/))) {
      const z = this.zones.get(m[1]!);
      if (!z) return this.send(res, 404, this.error(7003, "Could not route to /zones/x, perhaps your object identifier is invalid?"));
      return this.send(res, 200, this.ok({ id: z.id, name: z.name, status: z.status, paused: false, type: "full", account: { id: z.account_id, name: this.accountName }, name_servers: ["a.ns.cloudflare.com"], plan: { name: this.planName } }));
    }
    // --- DNS
    if ((m = path.match(/^\/zones\/([0-9a-f]{32})\/dns_records$/))) {
      const records = this.dns.get(m[1]!);
      if (!records) return this.send(res, 404, this.error(7003, "zone not found"));
      if (method === "GET") {
        let list = [...records.values()];
        if (!this.ignoreFilters) {
          if (query["type"]) list = list.filter((r) => r.type === query["type"]);
          if (query["name.exact"]) list = list.filter((r) => r.name === query["name.exact"]!.toLowerCase());
        }
        const { page, info } = this.paginate(list, query);
        return this.send(res, 200, this.ok(page.map((r) => this.dnsView(r)), info));
      }
      if (method === "POST") {
        const b = (body ?? {}) as Record<string, unknown>;
        for (const k of ["type", "name", "content"]) if (typeof b[k] !== "string") return this.send(res, 400, this.error(9005, `Content for ${k} is invalid`));
        const content = this.storeContent(String(b["type"]), String(b["content"]));
        if ([...records.values()].some((r) => r.type === b["type"] && r.name === String(b["name"]).toLowerCase() && r.content === content)) {
          return this.send(res, 400, this.error(81058, "An identical record already exists."));
        }
        const id = hex32();
        const now = new Date().toISOString();
        const rec: FakeDnsRecord = {
          id, type: String(b["type"]), name: String(b["name"]).toLowerCase(), content, ttl: typeof b["ttl"] === "number" ? b["ttl"] : 1,
          proxied: b["proxied"] === true, comment: typeof b["comment"] === "string" ? b["comment"] : null,
          ...(typeof b["priority"] === "number" ? { priority: b["priority"] } : {}), created_on: now, modified_on: now
        };
        if (!this.silentlyIgnoreWrites) records.set(id, rec);
        return this.send(res, 200, this.ok(this.dnsView(rec)));
      }
    }
    if ((m = path.match(/^\/zones\/([0-9a-f]{32})\/dns_records\/([0-9a-f]{32})$/))) {
      const records = this.dns.get(m[1]!);
      const rec = records?.get(m[2]!);
      if (!records || !rec) return this.send(res, 404, this.error(81044, "Record does not exist."));
      if (method === "GET") return this.send(res, 200, this.ok(this.dnsView(rec)));
      if (method === "PATCH") {
        const b = (body ?? {}) as Record<string, unknown>;
        const next: FakeDnsRecord = { ...rec };
        if (typeof b["content"] === "string") next.content = this.storeContent(rec.type, b["content"]);
        if (typeof b["ttl"] === "number") next.ttl = b["ttl"];
        if (typeof b["proxied"] === "boolean") next.proxied = b["proxied"];
        if (typeof b["comment"] === "string") next.comment = b["comment"];
        if (typeof b["priority"] === "number") next.priority = b["priority"];
        next.modified_on = new Date().toISOString();
        if (!this.silentlyIgnoreWrites) records.set(rec.id, next);
        return this.send(res, 200, this.ok(this.dnsView(this.silentlyIgnoreWrites ? rec : next)));
      }
      if (method === "DELETE") {
        if (!this.silentlyIgnoreWrites) records.delete(rec.id);
        return this.send(res, 200, this.ok({ id: rec.id }));
      }
    }
    // --- rulesets
    if (method === "GET" && (m = path.match(/^\/zones\/([0-9a-f]{32})\/rulesets\/phases\/([a-z_]+)\/entrypoint$/))) {
      const rs = this.rulesets.get(m[1]!)?.get(m[2]!);
      if (!rs) return this.send(res, 404, this.error(10003, "could not find entrypoint ruleset"));
      return this.send(res, 200, this.ok(this.rulesetView(rs)));
    }
    if (method === "POST" && (m = path.match(/^\/zones\/([0-9a-f]{32})\/rulesets$/))) {
      const b = (body ?? {}) as { name?: string; kind?: string; phase?: string; rules?: Array<Record<string, unknown>> };
      const zoneSets = this.rulesets.get(m[1]!);
      if (!zoneSets || typeof b.phase !== "string") return this.send(res, 400, this.error(20002, "invalid ruleset"));
      if (zoneSets.has(b.phase)) return this.send(res, 400, this.error(20003, "ruleset already exists for phase"));
      const rs: FakeRuleset = { id: hex32(), name: b.name ?? "default", phase: b.phase, kind: b.kind ?? "zone", version: "1", last_updated: new Date().toISOString(), rules: [] };
      for (const r of b.rules ?? []) rs.rules.push({ id: hex32(), version: "1", last_updated: new Date().toISOString(), description: "", enabled: true, action: "", expression: "", ...r } as FakeRule);
      if (!this.silentlyIgnoreWrites) zoneSets.set(b.phase, rs);
      return this.send(res, 200, this.ok(this.rulesetView(rs)));
    }
    if ((m = path.match(/^\/zones\/([0-9a-f]{32})\/rulesets\/([0-9a-f]{32})\/rules(?:\/([0-9a-f]{32}))?$/))) {
      const rulesetIdParam = m[2];
      const rs = [...(this.rulesets.get(m[1]!)?.values() ?? [])].find((x) => x.id === rulesetIdParam);
      if (!rs) return this.send(res, 404, this.error(10003, "ruleset not found"));
      if (method === "POST" && m[3] === undefined) {
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b["expression"] !== "string" || typeof b["action"] !== "string") return this.send(res, 400, this.error(20217, "invalid rule"));
        if (!this.silentlyIgnoreWrites) {
          rs.rules.push({ id: hex32(), version: "1", last_updated: new Date().toISOString(), description: "", enabled: true, ...b } as FakeRule);
          this.versionBump(rs);
        }
        return this.send(res, 200, this.ok(this.rulesetView(rs)));
      }
      const ruleIdParam = m[3];
      const idx = rs.rules.findIndex((r) => r.id === ruleIdParam);
      if (idx < 0) return this.send(res, 404, this.error(10003, "rule not found"));
      if (method === "PATCH") {
        const b = (body ?? {}) as Record<string, unknown>;
        const old = rs.rules[idx]!;
        if (!this.silentlyIgnoreWrites) {
          const base = this.ruleUpdateSemantics === "merge" ? { ...old } : {};
          rs.rules[idx] = { ...base, ...b, id: old.id, version: String(Number(old.version) + 1), last_updated: new Date().toISOString() } as FakeRule;
          for (const field of this.patchDropsFields) delete rs.rules[idx]![field];
          Object.assign(rs.rules[idx]!, this.patchAddsFields);
          this.versionBump(rs);
        }
        return this.send(res, 200, this.ok(this.rulesetView(rs)));
      }
      if (method === "DELETE") {
        if (!this.silentlyIgnoreWrites) {
          rs.rules.splice(idx, 1);
          this.versionBump(rs);
        }
        return this.send(res, 200, this.ok(this.rulesetView(rs)));
      }
    }
    // --- innstillinger
    if ((m = path.match(/^\/zones\/([0-9a-f]{32})\/settings\/([a-z0-9_]+)$/))) {
      const s = this.settings.get(m[1]!);
      const id = m[2]!;
      if (!s || !s.has(id)) return this.send(res, 404, this.error(1007, "Invalid zone setting"));
      if (method === "GET") return this.send(res, 200, this.ok({ id, value: s.get(id), editable: true, modified_on: "2026-01-01T00:00:00Z" }));
      if (method === "PATCH") {
        const value = (body as { value?: unknown } | undefined)?.value;
        if (typeof value !== "string" || !SETTINGS_ALLOWED[id]?.includes(value)) return this.send(res, 400, this.error(1006, "Invalid value for zone setting"));
        if (!this.silentlyIgnoreWrites) s.set(id, value);
        return this.send(res, 200, this.ok({ id, value: this.silentlyIgnoreWrites ? s.get(id) : value, editable: true, modified_on: new Date().toISOString() }));
      }
    }
    // --- cache
    if (method === "POST" && (m = path.match(/^\/zones\/([0-9a-f]{32})\/purge_cache$/))) {
      const b = (body ?? {}) as Record<string, unknown>;
      const keys = Object.keys(b);
      if (keys.length !== 1) return this.send(res, 400, this.error(1092, "purge_everything cannot be combined with other selectors"));
      this.purges.push({ zone_id: m[1]!, body: b });
      return this.send(res, 200, this.ok({ id: hex32() }));
    }
    // --- konto
    if (method === "GET" && (m = path.match(/^\/accounts\/([0-9a-f]{32})\/(members|roles|tokens|logs\/audit)$/))) {
      if (m[1] !== this.accountId) return this.send(res, 403, this.error(9109, "Unauthorized to access requested resource"));
      const source = m[2] === "members" ? this.members : m[2] === "roles" ? this.roles : m[2] === "tokens" ? this.apiTokens : this.auditEvents;
      if (m[2] === "logs/audit") return this.send(res, 200, this.ok(source));
      const { page, info } = this.paginate(source, query);
      return this.send(res, 200, this.ok(page, info));
    }
    return this.send(res, 404, this.error(7000, `No route for the URI: ${method} ${path}`));
  }
}
