import type { JsonValue } from "@jarvis/contracts";
import type { ToolTransport } from "./gateway.ts";
import { guardedFetch, isRetrySafeStatus } from "./url-safety.ts";
import {
  CLOUDFLARE_ZONE_SETTING_IDS,
  assertDnsComment,
  assertDnsContent,
  assertDnsName,
  assertDnsTtl,
  assertDnsType,
  assertMxPriority,
  assertNameWithinZone,
  assertProxiedAllowed,
  assertRateLimit,
  assertReadablePhase,
  assertWafAction,
  assertWafExpression,
  assertWafPhase,
  assertZoneSetting,
  buildPurgeBody,
  dnsContentMatches,
  isCloudflareId,
  type CloudflareRateLimit
} from "./cloudflare-target-policy.ts";

/**
 * WP-E1 (UA-5, D-41 maksimal kapabilitet): Cloudflare-transport (DNS, WAF/rate limiting via Rulesets API, sone-innstillinger, cache-purge,
 * tilgangsstyring-lesing). Rå REST via `guardedFetch` (ingen SDK - CLAUDE.md regel 3), `Authorization: Bearer <API-token>`.
 *
 * ENDEPUNKTER (verifisert mot developers.cloudflare.com via søk 2026-10-09 - direkte nedlasting av dokumentasjonen var blokkert i byggemiljøet,
 * så detaljer som IKKE kom frem i søkeutdragene er merket «ikke verifisert» under):
 *   - `GET /user/tokens/verify` og `GET /accounts/{account_id}/tokens/verify` (resultat: id, status active|disabled|expired, expires_on, not_before).
 *   - `GET /zones` (side/`per_page` 5-50, `result_info`), `GET /zones/{zone_id}`.
 *   - DNS: `GET|POST /zones/{zone_id}/dns_records`, `GET|PATCH|PUT|DELETE /zones/{zone_id}/dns_records/{dns_record_id}` (PATCH = delvis oppdatering,
 *     PUT = overskriving; vi bruker KUN PATCH). Endring av posttype via API er deprecated etter 2026-06-30 - type/navn endres derfor aldri på en eksisterende post.
 *   - Rulesets: `GET /zones/{zone_id}/rulesets/phases/{fase}/entrypoint`, `POST /zones/{zone_id}/rulesets` (opprett entrypoint når den mangler),
 *     `POST /zones/{zone_id}/rulesets/{ruleset_id}/rules`, `PATCH|DELETE …/rules/{rule_id}` (hver endring gir en ny ruleset-versjon; svaret er hele rulesettet).
 *     Legacy Firewall Rules/Filters-API er deprecated siden 2025-06-15 og brukes ikke.
 *   - Sone-innstillinger: `GET|PATCH /zones/{zone_id}/settings/{setting_id}` (batch-endepunktet er deprecated, EOL 2027-03-31, og brukes ikke).
 *   - `POST /zones/{zone_id}/purge_cache` (én velger: purge_everything | files | tags | hosts | prefixes).
 *   - `GET /accounts/{account_id}/members`, `/roles`, `/tokens`, `/logs/audit` (audit v2 med `since`/`before`). IKKE verifisert: eksakt svarform for
 *     audit-logg og nødvendig tillatelse for medlems-/rolleliste - svarene normaliseres defensivt (manglende felt blir null) og en 403 gir en tydelig feil.
 *   - Svarkonvolutt: `{success, errors[{code,message}], messages, result, result_info}`. Rate limit: 1200 forespørsler / 5 min per bruker; 429 + `Retry-After`.
 *
 * SIKKERHET (ufravikelig):
 *   - Credential KUN som parameter fra `ToolGateway` (vault/env) - aldri logget, aldri i feilmeldinger (vaskes), aldri til modellen.
 *   - Alle id-er interpoleres i URL-stien først etter streng 32-hex-validering (`isCloudflareId`) - ingen sti-injeksjon.
 *   - Sone -> konto-binding: sonen MÅ tilhøre `JARVIS_CLOUDFLARE_ACCOUNT_ID` (leses fra Cloudflare, cachet 5 min). Skriving uten konfigurert konto feiler lukket.
 *   - Mutasjoner gjentas ALDRI automatisk på 5xx (bivirkningen kan ha skjedd - JARVIS-018); bare 429 (avslag før behandling) og lesing gjentas.
 *   - Utdata er hvitlistet per ressurs (ingen ukjente felt videre). E-post i medlemslisten maskeres; audit-logg uten aktørens e-post/IP.
 *   - Mål-AUTORISASJON (sone står i eierens liste) håndheves av `ToolGateway` via `parameterAuthorizer`, ikke her (se `cloudflare-target-policy.ts`).
 */
export const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 10_000;
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const DNS_PAGE_SIZE = 100;
const MAX_PAGES = 10;
const ZONE_PAGE_SIZE = 50;
const ACCOUNT_PAGE_SIZE = 50;
const MAX_ACCOUNT_PAGES = 4;
const MAX_RULES_RETURNED = 500;
const ZONE_CACHE_MS = 5 * 60_000;

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
    readonly cloudflareCode?: number
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export interface CloudflareTransportOptions {
  /** Test-/self-host-søm. Produksjon bruker alltid `CLOUDFLARE_API_BASE_URL` (aldri env-styrt). Må være ren http(s) (guardedFetch). */
  baseUrl?: string;
  /** Konto-id-en alle soner MÅ tilhøre (`JARVIS_CLOUDFLARE_ACCOUNT_ID` via secret-kjeden, slått opp ved hvert kall). */
  accountId?: () => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Envelope {
  result: unknown;
  result_info?: { page?: number; per_page?: number; total_pages?: number; count?: number; total_count?: number };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const json = (v: unknown): JsonValue => v as JsonValue;

function scrub(text: string, credential: string): string {
  return credential.length >= 8 ? text.split(credential).join("[REDACTED]") : text;
}

/** Cloudflare sin feilkonvolutt `{errors:[{code,message}]}` - kode + avkortet melding (200 tegn), aldri rå kropp. */
function classifyBody(raw: string, credential: string): { text: string; code?: number } {
  try {
    const parsed = JSON.parse(raw) as { errors?: Array<{ code?: unknown; message?: unknown }> };
    const first = parsed.errors?.[0];
    if (!first) return { text: "UNCLASSIFIED" };
    const code = typeof first.code === "number" ? first.code : undefined;
    const message = scrub(typeof first.message === "string" ? first.message : "", credential).replace(/\s+/g, " ").slice(0, 160);
    return { text: `${code ?? "NA"}:${message}`, ...(code !== undefined ? { code } : {}) };
  } catch {
    return { text: "UNCLASSIFIED_ERROR_BODY" };
  }
}

export function maskEmail(email: string | null): string | null {
  if (email === null) return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** Felt vi kjenner på en ruleset-regel; alt annet (action_parameters, logging …) bevares i `extra` slik at endring/gjenoppretting aldri mister dem. */
const RULE_KNOWN = new Set(["id", "ref", "version", "last_updated", "action", "expression", "description", "enabled", "ratelimit", "categories"]);
const RULE_READ_ONLY = new Set(["id", "version", "last_updated", "categories"]);

export interface NormalizedRule {
  id: string;
  ref: string | null;
  action: string | null;
  expression: string | null;
  description: string;
  enabled: boolean;
  version: string | null;
  last_updated: string | null;
  ratelimit: JsonValue | null;
  extra: Record<string, JsonValue>;
}

function normalizeRule(raw: unknown): NormalizedRule | null {
  if (!isObj(raw) || typeof raw["id"] !== "string") return null;
  const extra: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!RULE_KNOWN.has(key) && JSON.stringify(value).length <= 4000) extra[key] = json(value);
  }
  return {
    id: raw["id"],
    ref: str(raw["ref"]),
    action: str(raw["action"]),
    expression: str(raw["expression"]),
    description: str(raw["description"]) ?? "",
    enabled: raw["enabled"] === false ? false : true,
    version: str(raw["version"]),
    last_updated: str(raw["last_updated"]),
    ratelimit: isObj(raw["ratelimit"]) ? json(raw["ratelimit"]) : null,
    extra
  };
}

/** Rule -> forespørselskropp (uten skrivebeskyttede felt; `extra` bevares så en endring/gjenoppretting aldri mister f.eks. action_parameters). */
function ruleBody(rule: Pick<NormalizedRule, "ref" | "action" | "expression" | "description" | "enabled" | "ratelimit" | "extra">): Record<string, unknown> {
  const body: Record<string, unknown> = { ...rule.extra, action: rule.action, expression: rule.expression, description: rule.description, enabled: rule.enabled };
  if (rule.ref !== null) body["ref"] = rule.ref;
  if (rule.ratelimit !== null) body["ratelimit"] = rule.ratelimit;
  for (const key of RULE_READ_ONLY) delete body[key];
  return body;
}

export interface NormalizedRuleset {
  exists: boolean;
  id: string | null;
  name: string | null;
  phase: string;
  version: string | null;
  last_updated: string | null;
  rules: NormalizedRule[];
  truncated: boolean;
}

function normalizeRuleset(raw: unknown, phase: string): NormalizedRuleset {
  if (!isObj(raw)) return { exists: false, id: null, name: null, phase, version: null, last_updated: null, rules: [], truncated: false };
  const rules = (Array.isArray(raw["rules"]) ? raw["rules"] : []).map(normalizeRule).filter((r): r is NormalizedRule => r !== null);
  return {
    exists: true, id: str(raw["id"]), name: str(raw["name"]), phase: str(raw["phase"]) ?? phase, version: str(raw["version"]),
    last_updated: str(raw["last_updated"]), rules: rules.slice(0, MAX_RULES_RETURNED), truncated: rules.length > MAX_RULES_RETURNED
  };
}

function normalizeZone(raw: unknown): JsonValue | null {
  if (!isObj(raw) || typeof raw["id"] !== "string") return null;
  const account = isObj(raw["account"]) ? raw["account"] : {};
  const plan = isObj(raw["plan"]) ? raw["plan"] : {};
  return json({
    id: raw["id"], name: str(raw["name"]), status: str(raw["status"]), paused: bool(raw["paused"]), type: str(raw["type"]),
    account_id: str(account["id"]), account_name: str(account["name"]), plan: str(plan["name"]),
    name_servers: Array.isArray(raw["name_servers"]) ? raw["name_servers"].filter((n): n is string => typeof n === "string").slice(0, 8) : []
  });
}

export interface NormalizedDnsRecord {
  id: string;
  type: string | null;
  name: string | null;
  content: string | null;
  ttl: number | null;
  proxied: boolean | null;
  comment: string | null;
  priority: number | null;
  data: JsonValue | null;
  created_on: string | null;
  modified_on: string | null;
}

function normalizeDnsRecord(raw: unknown): NormalizedDnsRecord | null {
  if (!isObj(raw) || typeof raw["id"] !== "string") return null;
  const data = raw["data"];
  return {
    id: raw["id"], type: str(raw["type"]), name: str(raw["name"])?.toLowerCase() ?? null, content: str(raw["content"]), ttl: num(raw["ttl"]),
    proxied: bool(raw["proxied"]), comment: str(raw["comment"]), priority: num(raw["priority"]),
    data: isObj(data) && JSON.stringify(data).length <= 1000 ? json(data) : null,
    created_on: str(raw["created_on"]), modified_on: str(raw["modified_on"])
  };
}

function normalizeSetting(raw: unknown): JsonValue | null {
  if (!isObj(raw) || typeof raw["id"] !== "string") return null;
  const value = raw["value"];
  return json({ id: raw["id"], value: typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null, editable: bool(raw["editable"]), modified_on: str(raw["modified_on"]) });
}

export class CloudflareTransport implements ToolTransport {
  private readonly zoneCache = new Map<string, { name: string; account_id: string | null; at: number }>();

  constructor(private readonly options: CloudflareTransportOptions = {}) {}

  private get baseUrl(): string {
    return (this.options.baseUrl ?? CLOUDFLARE_API_BASE_URL).replace(/\/+$/, "");
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep ? this.options.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async configuredAccountId(): Promise<string | null> {
    const raw = (await this.options.accountId?.())?.trim().toLowerCase() ?? null;
    if (raw === null || raw === "") return null;
    if (!isCloudflareId(raw)) throw new Error("cloudflare_account_id_invalid");
    return raw;
  }

  private async requireAccountId(): Promise<string> {
    const id = await this.configuredAccountId();
    if (id === null) throw new Error("cloudflare_account_not_configured");
    return id;
  }

  /** Ett HTTP-kall. Lesing gjentas på 429/5xx; mutasjon KUN på 429. `allowNotFound` gir `null` ved 404 (preflight/readback for «finnes ikke»). */
  private async call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    credential: string,
    init: { query?: Record<string, string>; body?: unknown; allowNotFound?: boolean } = {}
  ): Promise<Envelope | null> {
    const params = new URLSearchParams(Object.entries(init.query ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    const queryString = params.toString();
    const url = `${this.baseUrl}${path}${queryString.length > 0 ? `?${queryString}` : ""}`;
    let lastError: CloudflareApiError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await guardedFetch(url, {
        method,
        headers: {
          authorization: `Bearer ${credential}`, accept: "application/json",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {})
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
      });
      if (response.status === 404 && init.allowNotFound === true) return null;
      const rawBody = await response.text().catch(() => "");
      if (response.ok) {
        let parsed: unknown;
        try { parsed = JSON.parse(rawBody); } catch { throw new CloudflareApiError("cloudflare_invalid_response:non_json", response.status, false); }
        if (!isObj(parsed) || parsed["success"] !== true || !("result" in parsed)) {
          const c = classifyBody(rawBody, credential);
          throw new CloudflareApiError(`cloudflare_error_${response.status}:${c.text === "UNCLASSIFIED" ? "success_flag_missing" : c.text}`, response.status, false, c.code);
        }
        const info = parsed["result_info"];
        return isObj(info) ? { result: parsed["result"], result_info: info as NonNullable<Envelope["result_info"]> } : { result: parsed["result"] };
      }
      const c = classifyBody(rawBody, credential);
      const retryable = RETRYABLE_STATUS.has(response.status) && isRetrySafeStatus(method, response.status);
      lastError = new CloudflareApiError(`cloudflare_error_${response.status}:${c.text}`, response.status, retryable, c.code);
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await this.sleep(wait);
    }
    throw lastError!;
  }

  private async paged(path: string, credential: string, query: Record<string, string>, perPage: number, maxPages: number): Promise<{ items: unknown[]; truncated: boolean }> {
    const items: unknown[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const env = (await this.call("GET", path, credential, { query: { ...query, page: String(page), per_page: String(perPage) } }))!;
      const batch = Array.isArray(env.result) ? env.result : [];
      items.push(...batch);
      const totalPages = env.result_info?.total_pages;
      if (batch.length < perPage || (typeof totalPages === "number" && page >= totalPages)) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  /** Sone -> (navn, konto). Cachet 5 min. Med konfigurert konto avvises en sone fra en annen konto (`cloudflare_zone_not_in_account`). */
  private async zoneBinding(zoneId: string, credential: string): Promise<{ name: string; account_id: string | null }> {
    const cached = this.zoneCache.get(zoneId);
    if (cached && this.now() - cached.at < ZONE_CACHE_MS) return cached;
    const env = (await this.call("GET", `/zones/${zoneId}`, credential))!;
    const zone = isObj(env.result) ? env.result : {};
    const name = str(zone["name"]);
    if (name === null) throw new CloudflareApiError("cloudflare_invalid_response:zone_name_missing", 200, false);
    const account = isObj(zone["account"]) ? str(zone["account"]["id"]) : null;
    const configured = await this.configuredAccountId();
    if (configured !== null && account?.toLowerCase() !== configured) throw new Error("cloudflare_zone_not_in_account");
    const binding = { name: name.toLowerCase(), account_id: account, at: this.now() };
    this.zoneCache.set(zoneId, binding);
    return binding;
  }

  /** Skriving krever KONFIGURERT konto (ellers kan sone->konto-bindingen ikke bevises) og en bundet sone. */
  private async writableZone(parameters: Record<string, JsonValue>, credential: string): Promise<{ zoneId: string; zoneName: string }> {
    const zoneId = this.requireId(parameters, "zone_id");
    await this.requireAccountId();
    const binding = await this.zoneBinding(zoneId, credential);
    return { zoneId, zoneName: binding.name };
  }

  private requireId(parameters: Record<string, JsonValue>, key: string): string {
    const value = parameters[key];
    if (!isCloudflareId(value)) throw new Error(`cloudflare_invalid_${key}`);
    return value;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    switch (action) {
      case "check_token": return this.checkToken(credential);
      case "list_zones": return this.listZones(credential);
      case "get_zone": return this.getZone(parameters, credential);
      case "list_dns_records": return this.findDns(parameters, credential, "list");
      case "find_dns_records": return this.findDns(parameters, credential, "find");
      case "get_dns_record": return this.getDnsRecord(parameters, credential);
      case "create_dns_record": return this.createDnsRecord(parameters, credential);
      case "update_dns_record": return this.updateDnsRecord(parameters, credential);
      case "delete_dns_record": return this.deleteDnsRecord(parameters, credential);
      case "get_ruleset": return this.getRuleset(parameters, credential);
      case "create_waf_rule": return this.createWafRule(parameters, credential);
      case "update_waf_rule": return this.updateWafRule(parameters, credential);
      case "delete_waf_rule": return this.deleteWafRule(parameters, credential);
      case "get_zone_setting": return this.getZoneSetting(parameters, credential);
      case "list_zone_settings": return this.listZoneSettings(parameters, credential);
      case "update_zone_setting": return this.updateZoneSetting(parameters, credential);
      case "purge_cache": return this.purgeCache(parameters, credential);
      case "list_account_members": return this.listAccountMembers(credential);
      case "list_account_roles": return this.listAccountRoles(credential);
      case "list_api_tokens": return this.listApiTokens(credential);
      case "list_audit_logs": return this.listAuditLogs(parameters, credential);
      default: throw new Error(`cloudflare_unsupported_action_${action}`);
    }
  }

  // ---------------------------------------------------------------- lesing

  private async checkToken(credential: string): Promise<{ data: JsonValue }> {
    const accountId = await this.configuredAccountId();
    let kind: "account" | "user" = "user";
    let env: Envelope | null = null;
    if (accountId !== null) {
      try {
        env = await this.call("GET", `/accounts/${accountId}/tokens/verify`, credential);
        kind = "account";
      } catch (err) {
        // Et BRUKER-eid token kan ikke verifiseres mot konto-endepunktet (4xx) - prøv bruker-endepunktet; 401 (ugyldig token) er et svar i seg selv.
        if (!(err instanceof CloudflareApiError) || err.httpStatus === 401 || err.httpStatus >= 500) throw err;
      }
    }
    env ??= (await this.call("GET", "/user/tokens/verify", credential))!;
    const r = isObj(env.result) ? env.result : {};
    return { data: json({ kind, id: str(r["id"]), status: str(r["status"]), expires_on: str(r["expires_on"]), not_before: str(r["not_before"]) }) };
  }

  private async listZones(credential: string): Promise<{ data: JsonValue }> {
    const accountId = await this.configuredAccountId();
    const { items, truncated } = await this.paged("/zones", credential, accountId ? { "account.id": accountId } : {}, ZONE_PAGE_SIZE, 5);
    const zones = items.map(normalizeZone).filter((z): z is JsonValue => z !== null)
      .filter((z) => accountId === null || (z as { account_id?: unknown }).account_id === accountId);
    return { data: json({ zones, truncated, account_filter: accountId !== null }) };
  }

  private async getZone(parameters: Record<string, JsonValue>, credential: string): Promise<{ data: JsonValue }> {
    const zoneId = this.requireId(parameters, "zone_id");
    const env = (await this.call("GET", `/zones/${zoneId}`, credential, { allowNotFound: true }));
    if (env === null) return { data: null };
    const zone = normalizeZone(env.result);
    const accountId = await this.configuredAccountId();
    if (zone !== null && accountId !== null && (zone as { account_id?: unknown }).account_id !== accountId) throw new Error("cloudflare_zone_not_in_account");
    return { data: zone };
  }

  /** `list` = alle poster (evt. filtrert på type/navn); `find` = alltid et objekt `{records}` (også tomt) - brukes som preflight/readback for opprettelse. */
  private async findDns(parameters: Record<string, JsonValue>, credential: string, mode: "list" | "find"): Promise<{ data: JsonValue }> {
    const zoneId = this.requireId(parameters, "zone_id");
    const binding = await this.zoneBinding(zoneId, credential);
    const typeFilter = parameters["type"] === undefined ? null : String(parameters["type"]).toUpperCase();
    if (typeFilter !== null && !/^[A-Z0-9]{1,12}$/.test(typeFilter)) throw new Error("cloudflare_invalid_type");
    const nameFilter = parameters["name"] === undefined ? null : assertDnsName(parameters["name"]);
    const query: Record<string, string> = {};
    if (typeFilter !== null) query["type"] = typeFilter;
    if (nameFilter !== null) query["name.exact"] = nameFilter;
    const { items, truncated } = await this.paged(`/zones/${zoneId}/dns_records`, credential, query, DNS_PAGE_SIZE, MAX_PAGES);
    // Eksakt filtrering gjøres OGSÅ lokalt: et filter serveren ikke kjenner igjen ville ellers returnert alle poster.
    const records = items.map(normalizeDnsRecord).filter((r): r is NormalizedDnsRecord => r !== null)
      .filter((r) => (typeFilter === null || r.type === typeFilter) && (nameFilter === null || r.name === nameFilter));
    if (mode === "find") return { data: json({ zone_id: zoneId, type: typeFilter, name: nameFilter, count: records.length, records, truncated }) };
    return { data: json({ zone_id: zoneId, zone_name: binding.name, count: records.length, records, truncated }) };
  }

  private async getDnsRecord(parameters: Record<string, JsonValue>, credential: string): Promise<{ data: JsonValue }> {
    const zoneId = this.requireId(parameters, "zone_id");
    const recordId = this.requireId(parameters, "record_id");
    await this.zoneBinding(zoneId, credential);
    const env = await this.call("GET", `/zones/${zoneId}/dns_records/${recordId}`, credential, { allowNotFound: true });
    if (env === null) return { data: null };
    return { data: json(normalizeDnsRecord(env.result)) };
  }

  private async getRuleset(parameters: Record<string, JsonValue>, credential: string): Promise<{ data: JsonValue }> {
    const zoneId = this.requireId(parameters, "zone_id");
    const phase = assertReadablePhase(parameters["phase"]);
    await this.zoneBinding(zoneId, credential);
    const env = await this.call("GET", `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, credential, { allowNotFound: true });
    return { data: json(normalizeRuleset(env?.result, phase)) };
  }

  private async getZoneSetting(parameters: Record<string, JsonValue>, credential: string): Promise<{ data: JsonValue }> {
    const zoneId = this.requireId(parameters, "zone_id");
    const settingId = String(parameters["setting_id"] ?? "");
    if (!CLOUDFLARE_ZONE_SETTING_IDS.includes(settingId)) throw new Error("cloudflare_invalid_setting_id");
    await this.zoneBinding(zoneId, credential);
    const env = await this.call("GET", `/zones/${zoneId}/settings/${settingId}`, credential, { allowNotFound: true });
    return { data: env === null ? null : normalizeSetting(env.result) };
  }

  private async listZoneSettings(parameters: Record<string, JsonValue>, credential: string): Promise<{ data: JsonValue }> {
    const zoneId = this.requireId(parameters, "zone_id");
    await this.zoneBinding(zoneId, credential);
    const settings: JsonValue[] = [];
    for (const id of CLOUDFLARE_ZONE_SETTING_IDS) {
      const env = await this.call("GET", `/zones/${zoneId}/settings/${id}`, credential, { allowNotFound: true });
      const s = env === null ? null : normalizeSetting(env.result);
      if (s !== null) settings.push(s);
    }
    return { data: json({ zone_id: zoneId, settings }) };
  }

  private async listAccountMembers(credential: string): Promise<{ data: JsonValue }> {
    const accountId = await this.requireAccountId();
    const { items, truncated } = await this.paged(`/accounts/${accountId}/members`, credential, {}, ACCOUNT_PAGE_SIZE, MAX_ACCOUNT_PAGES);
    const members = items.filter(isObj).map((m) => {
      const user = isObj(m["user"]) ? m["user"] : {};
      const roles = Array.isArray(m["roles"]) ? m["roles"].filter(isObj).map((r) => str(r["name"])).filter((n): n is string => n !== null) : [];
      return { id: str(m["id"]), status: str(m["status"]), email: maskEmail(str(user["email"])), two_factor_enabled: bool(user["two_factor_authentication_enabled"]), roles };
    });
    return { data: json({ members, truncated }) };
  }

  private async listAccountRoles(credential: string): Promise<{ data: JsonValue }> {
    const accountId = await this.requireAccountId();
    const { items, truncated } = await this.paged(`/accounts/${accountId}/roles`, credential, {}, ACCOUNT_PAGE_SIZE, MAX_ACCOUNT_PAGES);
    const roles = items.filter(isObj).map((r) => ({ id: str(r["id"]), name: str(r["name"]), description: str(r["description"]) }));
    return { data: json({ roles, truncated }) };
  }

  private async listApiTokens(credential: string): Promise<{ data: JsonValue }> {
    const accountId = await this.requireAccountId();
    const { items, truncated } = await this.paged(`/accounts/${accountId}/tokens`, credential, {}, ACCOUNT_PAGE_SIZE, MAX_ACCOUNT_PAGES);
    // Kun metadata: Cloudflare returnerer aldri token-verdier i lister, og policy-detaljer utelates bevisst.
    const tokens = items.filter(isObj).map((t) => ({
      id: str(t["id"]), name: str(t["name"]), status: str(t["status"]), issued_on: str(t["issued_on"]), modified_on: str(t["modified_on"]),
      expires_on: str(t["expires_on"]), not_before: str(t["not_before"]), last_used_on: str(t["last_used_on"])
    }));
    return { data: json({ tokens, truncated }) };
  }

  private async listAuditLogs(parameters: Record<string, JsonValue>, credential: string): Promise<{ data: JsonValue }> {
    const accountId = await this.requireAccountId();
    const query: Record<string, string> = {};
    for (const key of ["since", "before"] as const) {
      const value = parameters[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`cloudflare_invalid_${key}`);
      query[key] = new Date(value).toISOString();
    }
    const limit = parameters["limit"];
    if (limit !== undefined) {
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("cloudflare_invalid_limit");
      query["limit"] = String(limit);
    }
    const env = (await this.call("GET", `/accounts/${accountId}/logs/audit`, credential, { query }))!;
    const events = (Array.isArray(env.result) ? env.result : []).filter(isObj).slice(0, 100).map((e) => {
      const action = isObj(e["action"]) ? e["action"] : {};
      const resource = isObj(e["resource"]) ? e["resource"] : {};
      const actor = isObj(e["actor"]) ? e["actor"] : {};
      const zone = isObj(e["zone"]) ? e["zone"] : {};
      // Aktørens e-post og IP utelates bevisst (personopplysninger) - kun aktørtype.
      return { id: str(e["id"]), when: str(action["time"]) ?? str(e["when"]), action_type: str(action["type"]), action_result: str(action["result"]),
        resource_type: str(resource["type"]), resource_id: str(resource["id"]), resource_product: str(resource["product"]), actor_type: str(actor["type"]), zone_name: str(zone["name"]) };
    });
    return { data: json({ events }) };
  }

  // ---------------------------------------------------------------- DNS-skriving

  private async createDnsRecord(parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const { zoneId, zoneName } = await this.writableZone(parameters, credential);
    const type = assertDnsType(parameters["type"]);
    const name = assertDnsName(parameters["name"]);
    assertNameWithinZone(name, zoneName);
    const content = assertDnsContent(type, parameters["content"]);
    const ttl = parameters["ttl"] === undefined ? 1 : assertDnsTtl(parameters["ttl"]);
    const proxied = parameters["proxied"] === undefined ? false : assertProxiedAllowed(type, parameters["proxied"]);
    const body: Record<string, unknown> = { type, name, content, ttl };
    if (type === "A" || type === "AAAA" || type === "CNAME") body["proxied"] = proxied;
    if (type === "MX") body["priority"] = assertMxPriority(parameters["priority"]);
    else if (parameters["priority"] !== undefined) throw new Error("cloudflare_invalid_priority:kun_for_mx");
    if (parameters["comment"] !== undefined) body["comment"] = assertDnsComment(parameters["comment"]);
    // Idempotent opprettelse: finnes en IDENTISK post allerede (type+navn+innhold), returneres den uten nytt POST (Cloudflare ville avvist duplikatet).
    const existing = ((await this.findDns({ zone_id: zoneId, type, name }, credential, "find")).data as unknown as { records: NormalizedDnsRecord[] }).records
      .find((r) => r.content !== null && dnsContentMatches(type, content, r.content));
    if (existing) return { external_id: existing.id, data: json({ ...existing, already_existed: true }) };
    const env = (await this.call("POST", `/zones/${zoneId}/dns_records`, credential, { body }))!;
    const record = normalizeDnsRecord(env.result);
    if (record === null) throw new CloudflareApiError("cloudflare_invalid_response:record_missing", 200, false);
    return { external_id: record.id, data: json(record) };
  }

  private async updateDnsRecord(parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const { zoneId } = await this.writableZone(parameters, credential);
    const recordId = this.requireId(parameters, "record_id");
    for (const forbidden of ["type", "name"]) if (parameters[forbidden] !== undefined) throw new Error(`cloudflare_invalid_${forbidden}:kan_ikke_endres`);
    const env = await this.call("GET", `/zones/${zoneId}/dns_records/${recordId}`, credential, { allowNotFound: true });
    const current = env === null ? null : normalizeDnsRecord(env.result);
    if (current === null || current.type === null) throw new CloudflareApiError("cloudflare_error_404:record_not_found", 404, false);
    assertDnsType(current.type);
    const body: Record<string, unknown> = {};
    if (parameters["content"] !== undefined) body["content"] = assertDnsContent(current.type, parameters["content"]);
    if (parameters["ttl"] !== undefined) body["ttl"] = assertDnsTtl(parameters["ttl"]);
    if (parameters["proxied"] !== undefined) body["proxied"] = assertProxiedAllowed(current.type, parameters["proxied"]);
    if (parameters["priority"] !== undefined) {
      if (current.type !== "MX") throw new Error("cloudflare_invalid_priority:kun_for_mx");
      body["priority"] = assertMxPriority(parameters["priority"]);
    }
    if (parameters["comment"] !== undefined) body["comment"] = assertDnsComment(parameters["comment"]);
    if (Object.keys(body).length === 0) throw new Error("cloudflare_invalid_update:ingen_felt");
    // Idempotent: er alt allerede som ønsket, gjøres ingen skriving.
    const unchanged = Object.entries(body).every(([k, v]) =>
      k === "content" ? current.content !== null && dnsContentMatches(current.type as string, v as string, current.content) : (current as unknown as Record<string, unknown>)[k] === v);
    if (unchanged) return { external_id: current.id, data: json({ ...current, unchanged: true }) };
    const updated = (await this.call("PATCH", `/zones/${zoneId}/dns_records/${recordId}`, credential, { body }))!;
    const record = normalizeDnsRecord(updated.result);
    if (record === null) throw new CloudflareApiError("cloudflare_invalid_response:record_missing", 200, false);
    return { external_id: record.id, data: json(record) };
  }

  private async deleteDnsRecord(parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const { zoneId } = await this.writableZone(parameters, credential);
    const recordId = this.requireId(parameters, "record_id");
    const env = (await this.call("DELETE", `/zones/${zoneId}/dns_records/${recordId}`, credential))!;
    const id = isObj(env.result) ? str(env.result["id"]) : null;
    return { external_id: id ?? recordId, data: json({ deleted: true, id: id ?? recordId }) };
  }

  // ---------------------------------------------------------------- WAF / rate limiting (Rulesets API)

  private async entrypoint(zoneId: string, phase: string, credential: string): Promise<NormalizedRuleset> {
    const env = await this.call("GET", `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, credential, { allowNotFound: true });
    return normalizeRuleset(env?.result, phase);
  }

  private wafInput(parameters: Record<string, JsonValue>, partial: boolean) {
    const phase = assertWafPhase(parameters["phase"]);
    const out: { phase: typeof phase; action?: string; expression?: string; description?: string; enabled?: boolean; ratelimit?: CloudflareRateLimit } = { phase };
    if (!partial || parameters["action"] !== undefined) out.action = assertWafAction(parameters["action"]);
    if (!partial || parameters["expression"] !== undefined) out.expression = assertWafExpression(parameters["expression"], out.action ?? String(parameters["action"] ?? ""));
    if (parameters["description"] !== undefined) {
      const d = parameters["description"];
      if (typeof d !== "string" || d.length > 500) throw new Error("cloudflare_invalid_description");
      out.description = d;
    }
    if (parameters["enabled"] !== undefined) {
      if (typeof parameters["enabled"] !== "boolean") throw new Error("cloudflare_invalid_enabled");
      out.enabled = parameters["enabled"];
    }
    if (parameters["ratelimit"] !== undefined) {
      if (phase !== "http_ratelimit") throw new Error("cloudflare_invalid_ratelimit:kun_for_http_ratelimit");
      out.ratelimit = assertRateLimit(parameters["ratelimit"]);
    } else if (!partial && phase === "http_ratelimit") {
      throw new Error("cloudflare_invalid_ratelimit:paakrevd_for_http_ratelimit");
    }
    return out;
  }

  private async createWafRule(parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const { zoneId } = await this.writableZone(parameters, credential);
    const input = this.wafInput(parameters, false);
    const before = await this.entrypoint(zoneId, input.phase, credential);
    const description = input.description ?? "";
    const duplicate = before.rules.find((r) => r.action === input.action && r.expression === input.expression && r.description === description);
    if (duplicate) return { external_id: duplicate.id, data: json({ ruleset_id: before.id, rule: duplicate, already_existed: true }) };
    const rule = { action: input.action, expression: input.expression, description, enabled: input.enabled ?? true, ...(input.ratelimit ? { ratelimit: input.ratelimit } : {}) };
    // Mangler entrypoint-rulesettet, opprettes det med regelen i `rules` (dokumentert flyt); ellers legges regelen til i det eksisterende.
    const env = before.exists && before.id
      ? (await this.call("POST", `/zones/${zoneId}/rulesets/${before.id}/rules`, credential, { body: rule }))!
      : (await this.call("POST", `/zones/${zoneId}/rulesets`, credential, { body: { name: "default", kind: "zone", phase: input.phase, rules: [rule] } }))!;
    const after = normalizeRuleset(env.result, input.phase);
    const knownIds = new Set(before.rules.map((r) => r.id));
    const created = after.rules.find((r) => !knownIds.has(r.id) && r.action === input.action && r.expression === input.expression)
      ?? after.rules.find((r) => !knownIds.has(r.id));
    if (!created) throw new CloudflareApiError("cloudflare_invalid_response:rule_missing", 200, false);
    return { external_id: created.id, data: json({ ruleset_id: after.id, rule: created }) };
  }

  private async updateWafRule(parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const { zoneId } = await this.writableZone(parameters, credential);
    const ruleId = this.requireId(parameters, "rule_id");
    const input = this.wafInput(parameters, true);
    const before = await this.entrypoint(zoneId, input.phase, credential);
    const current = before.rules.find((r) => r.id === ruleId);
    if (!before.id || !current) throw new CloudflareApiError("cloudflare_error_404:rule_not_found", 404, false);
    if (current.action === null || current.expression === null) throw new Error("cloudflare_rule_not_modelled");
    const merged = {
      ref: current.ref, action: input.action ?? current.action, expression: input.expression ?? current.expression,
      description: input.description ?? current.description, enabled: input.enabled ?? current.enabled,
      ratelimit: (input.ratelimit as unknown as JsonValue | undefined) ?? current.ratelimit, extra: current.extra
    };
    if (input.action !== undefined || input.expression !== undefined) assertWafExpression(merged.expression, merged.action);
    const unchanged = merged.action === current.action && merged.expression === current.expression && merged.description === current.description
      && merged.enabled === current.enabled && JSON.stringify(merged.ratelimit) === JSON.stringify(current.ratelimit);
    if (unchanged) return { external_id: current.id, data: json({ ruleset_id: before.id, rule: current, unchanged: true }) };
    const env = (await this.call("PATCH", `/zones/${zoneId}/rulesets/${before.id}/rules/${ruleId}`, credential, { body: ruleBody(merged) }))!;
    const after = normalizeRuleset(env.result, input.phase);
    const updated = after.rules.find((r) => r.id === ruleId);
    if (!updated) throw new CloudflareApiError("cloudflare_invalid_response:rule_missing", 200, false);
    return { external_id: updated.id, data: json({ ruleset_id: after.id, rule: updated }) };
  }

  private async deleteWafRule(parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const { zoneId } = await this.writableZone(parameters, credential);
    const ruleId = this.requireId(parameters, "rule_id");
    const phase = assertWafPhase(parameters["phase"]);
    const before = await this.entrypoint(zoneId, phase, credential);
    if (!before.id || !before.rules.some((r) => r.id === ruleId)) throw new CloudflareApiError("cloudflare_error_404:rule_not_found", 404, false);
    await this.call("DELETE", `/zones/${zoneId}/rulesets/${before.id}/rules/${ruleId}`, credential);
    return { external_id: ruleId, data: json({ deleted: true, ruleset_id: before.id, rule_id: ruleId }) };
  }

  // ---------------------------------------------------------------- sone-innstillinger og cache

  private async updateZoneSetting(parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const { zoneId } = await this.writableZone(parameters, credential);
    const { setting_id, value } = assertZoneSetting(parameters["setting_id"], parameters["value"]);
    const env = (await this.call("PATCH", `/zones/${zoneId}/settings/${setting_id}`, credential, { body: { value } }))!;
    return { external_id: `${setting_id}:${value}`, data: normalizeSetting(env.result) };
  }

  private async purgeCache(parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const { zoneId, zoneName } = await this.writableZone(parameters, credential);
    const body = buildPurgeBody(parameters["mode"], parameters["items"], zoneName);
    const env = (await this.call("POST", `/zones/${zoneId}/purge_cache`, credential, { body }))!;
    const id = isObj(env.result) ? str(env.result["id"]) : null;
    return { external_id: `purge:${id ?? "ok"}`, data: json({ purged: true, mode: Object.keys(body)[0] ?? null }) };
  }
}
