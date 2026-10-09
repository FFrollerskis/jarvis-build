import type { JsonValue } from "@jarvis/contracts";
import type { ToolTransport } from "./gateway.ts";
import { ControlTargetHttpError, boolOrNull, isObj, jsonRequest, normalizeBaseUrl, numOrNull, strOrNull } from "./control-target-http.ts";

/**
 * WP-E1 (UA-5, D-41/D-64): Infisical (selvhostet hvelv, D-35) som KONTROLLERT MÅL - helse, secret-METADATA (nøkkelnavn, versjon, alder, tagger, rotasjonsflagg),
 * rotasjonsstatus og rotasjon der API-et støtter det. ALDRI verdier: ingen funksjon her returnerer, logger eller beholder en secrets VERDI. Forespørsler om metadata
 * sendes med `viewSecretValue=false`, og svaret hvitlistes feltvis - en server som ignorerer parameteren (eldre versjon) får altså verdien i svaret, men den kopieres
 * aldri videre (bevist av test med en server som lekker verdier).
 *
 * D-64 Core-vs-Adapter: Infisical er en ADAPTER bak `SecretProvider` (D-16/D-35) - leverandøren eier hvelvet, Jarvis eier policy, revisjon og eierens credential-binding.
 * Ingen Jarvis-domenemodell avhenger av Infisicals API-form (`CORE_DEPENDENCY_DECISION_REQUIRED=false`).
 *
 * ENDEPUNKTER (verifisert mot Infisicals dokumentasjon via søk 2026-10-09; image i compose er pinnet og versjonen er ikke verifisert i runtime):
 *   - `GET /api/status` (offentlig, uten autentisering): `message`, `date`, `emailConfigured`, `inviteOnlySignup`, `redisConfigured` … Verdien av `message` er IKKE bekreftet.
 *   - `POST /api/v1/auth/universal-auth/login` {clientId, clientSecret} -> {accessToken, expiresIn, accessTokenMaxTTL} (maskin-identitet, samme som `InfisicalSecretProvider`).
 *   - `GET /api/v3/secrets/raw?workspaceId&environment&secretPath&viewSecretValue=false` og `GET /api/v3/secrets/raw/{navn}` (markert deprecated i dokumentasjonen, men det
 *     er endepunktet den eksisterende provideren bruker); `viewSecretValue` finnes i nyere versjoner (verdien maskeres) og ignoreres av eldre.
 *   - Rotasjon V2: `GET /api/v2/secret-rotations?projectId=…` ({secretRotations[…]} med rotationStatus/lastRotatedAt/nextRotationAt …) og
 *     `POST /api/v2/secret-rotations/{type}/{rotationId}/rotate-secrets` (type-spesifikk; typen hentes fra listen - aldri fra kaller). IKKE bekreftet: svarkropp for rotate,
 *     eksakte statusverdier og feltnavn for siste feil. Rotasjon kan være lisensbegrenset i instansen - da meldes den som utilgjengelig, aldri som feil.
 *
 * SIKKERHET: maskin-identiteten (`INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET`, allerede i api/worker) brukes - ingen ny credential. Prosjekt og miljø kommer fra miljøet,
 * aldri fra kaller. Access-token caches kun i minnet og kastes ved 401. Hemmeligheter vaskes ut av alle feil. Alle kall via `guardedFetch`.
 */
export interface InfisicalTransportOptions {
  baseUrl: () => Promise<string | null>;
  clientId: () => Promise<string | null>;
  projectId: () => Promise<string | null>;
  /** `INFISICAL_ENV` (standard `dev`). */
  environment: () => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type InfisicalCapabilityStatus = "IMPLEMENTED" | "PARTIAL" | "DEFERRED";
export interface InfisicalCapability { capability: string; status: InfisicalCapabilityStatus; risk: "A" | "B" | "C" | "D" | "-"; note: string }

/** D-41-matrise (regel 11): bygget, delvis bygget eller eksplisitt DEFERRED med begrunnelse - aldri stille utelatt. */
export const INFISICAL_CAPABILITIES: readonly InfisicalCapability[] = [
  { capability: "Helse (GET /api/status)", status: "IMPLEMENTED", risk: "A", note: "200 + JSON med `message`; hvitlistede flagg (e-post/redis/invite-only)" },
  { capability: "Secret-metadata: navn, versjon, opprettet/endret, alder, tagger, rotasjonsflagg (list + enkelt)", status: "IMPLEMENTED", risk: "A", note: "verdier hentes aldri ut: viewSecretValue=false + feltvis hvitliste; stale-flagg mot maks alder" },
  { capability: "Rotasjonsstatus (GET /api/v2/secret-rotations)", status: "PARTIAL", risk: "A", note: "feltnavn for siste feil og eksakte statusverdier er ikke bekreftet (leses defensivt); utilgjengelig (lisens/feature) meldes som available:false" },
  { capability: "Rotér hemmeligheter for en V2-rotasjon (POST …/{type}/{id}/rotate-secrets)", status: "PARTIAL", risk: "D", note: "type-spesifikt endepunkt (typen leses fra rotasjonslisten, aldri fra kaller); svarkropp ikke bekreftet - readback via ny listing; kun rotasjons-id-er i JARVIS_INFISICAL_ROTATION_IDS; ingen teknisk reversering (forrige verdi ligger i Infisicals egen versjonshistorikk)" },
  { capability: "Opprette/oppdatere secret-verdi", status: "IMPLEMENTED", risk: "C", note: "dekkes av den eksisterende eierveien owner_controls.set_connector_credential (D-213, step-up) via InfisicalSecretProvider.set - bevisst ikke duplisert her" },
  { capability: "Slette secret", status: "DEFERRED", risk: "-", note: "ingen verdifri gjenopprettingsvei (verdien kan ikke snapshottes uten å lese den); Infisicals egne snapshots/rollback er plan-/lisensbegrenset og ikke verifisert" },
  { capability: "Opprette/endre rotasjonskonfigurasjon, maskin-identiteter, prosjekter, medlemmer, tilganger", status: "DEFERRED", risk: "-", note: "privilegie-eskalering: identiteten som brukes her er den samme som leser alle connector-hemmeligheter; krever en egen, isolert identitet og eierbeslutning" },
  { capability: "Secret-snapshots / point-in-time-rollback", status: "DEFERRED", risk: "-", note: "plan-/lisensbegrenset og ikke verifisert mot instansen" }
];

const DAY_MS = 86_400_000;
const MAX_SECRETS = 500;
const SECRET_NAME = /^[A-Za-z0-9_.-]{1,200}$/;
const SECRET_PATH = /^\/(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ROTATION_TYPE = /^[a-z0-9]+(?:-[a-z0-9]+){0,5}$/;

export function isRotationId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Parser `JARVIS_INFISICAL_ROTATION_IDS` - kommaseparert liste av EKSAKTE rotasjons-id-er (UUID) eieren har autorisert for rotasjon. Ugyldige oppføringer hoppes over. */
export function parseInfisicalRotationIds(raw: string | undefined | null): ReadonlySet<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (UUID.test(id)) out.add(id);
  }
  return out;
}

function assertPath(value: unknown): string {
  const path = value === undefined ? "/" : value;
  if (typeof path !== "string" || path.length > 200 || !SECRET_PATH.test(path) || path.split("/").some((s) => s === "." || s === "..")) throw new Error("infisical_invalid_path");
  return path;
}

function assertSecretName(value: unknown): string {
  if (typeof value !== "string" || !SECRET_NAME.test(value) || value === "." || value === "..") throw new Error("infisical_invalid_secret_name");
  return value;
}

export interface SecretMetadata {
  key: string;
  version: number | null;
  type: string | null;
  created_at: string | null;
  updated_at: string | null;
  age_days: number | null;
  tags: string[];
  is_rotated: boolean;
}

export interface RotationView {
  id: string | null;
  name: string | null;
  type: string | null;
  environment: string | null;
  secret_path: string | null;
  auto_rotation_enabled: boolean | null;
  rotation_status: string | null;
  last_rotated_at: string | null;
  last_rotation_attempted_at: string | null;
  next_rotation_at: string | null;
  last_error: string | null;
}

export class InfisicalTransport implements ToolTransport {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: InfisicalTransportOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async base(): Promise<string> {
    const raw = await this.options.baseUrl();
    if (raw === null || raw.trim() === "") throw new Error("infisical_base_url_not_configured");
    return normalizeBaseUrl(raw, "infisical");
  }

  private async scope(): Promise<{ projectId: string; environment: string }> {
    const projectId = (await this.options.projectId())?.trim() ?? "";
    if (projectId === "") throw new Error("infisical_project_not_configured");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new Error("infisical_project_invalid");
    const environment = (await this.options.environment())?.trim() || "dev";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(environment)) throw new Error("infisical_environment_invalid");
    return { projectId, environment };
  }

  private async login(base: string, clientSecret: string, force: boolean): Promise<string> {
    if (!force && this.token && this.token.expiresAt > this.now()) return this.token.value;
    const clientId = (await this.options.clientId())?.trim() ?? "";
    if (clientId === "") throw new Error("infisical_client_id_not_configured");
    const res = await jsonRequest({
      service: "infisical", method: "POST", url: `${base}/api/v1/auth/universal-auth/login`, body: { clientId, clientSecret },
      secrets: [clientSecret, clientId], ...(this.options.sleep ? { sleep: this.options.sleep } : {})
    }).catch((err: unknown) => {
      if (err instanceof ControlTargetHttpError) throw new Error(`infisical_login_failed_${err.httpStatus}`);
      throw err;
    });
    const body = isObj(res.json) ? res.json : {};
    const accessToken = typeof body["accessToken"] === "string" ? body["accessToken"] : "";
    if (accessToken === "") throw new Error("infisical_login_failed_no_token");
    const expiresIn = numOrNull(body["expiresIn"]) ?? 600;
    // Fornyes i god tid (60 s margin), og aldri lenger enn en time uansett hva serveren lover.
    this.token = { value: accessToken, expiresAt: this.now() + Math.max(30, Math.min(expiresIn, 3600) - 60) * 1000 };
    return accessToken;
  }

  /** Autentisert kall; ved 401 forkastes tokenet og det logges inn på nytt ÉN gang (en utløpt/tilbakekalt maskin-token er normalt, ikke en feil). */
  private async authed(clientSecret: string, req: { method: "GET" | "POST"; path: string; query?: Record<string, string>; body?: unknown; acceptStatus?: readonly number[] }) {
    const base = await this.base();
    const qs = new URLSearchParams(Object.entries(req.query ?? {}).sort(([a], [b]) => a.localeCompare(b))).toString();
    const url = `${base}${req.path}${qs.length > 0 ? `?${qs}` : ""}`;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const token = await this.login(base, clientSecret, attempt > 1);
      try {
        return await jsonRequest({
          service: "infisical", method: req.method, url, headers: { authorization: `Bearer ${token}` }, ...(req.body !== undefined ? { body: req.body } : {}),
          secrets: [clientSecret, token], ...(req.acceptStatus ? { acceptStatus: req.acceptStatus } : {}), ...(this.options.sleep ? { sleep: this.options.sleep } : {})
        });
      } catch (err) {
        if (err instanceof ControlTargetHttpError && err.httpStatus === 401 && attempt === 1) {
          this.token = null;
          continue;
        }
        throw err;
      }
    }
    throw new Error("infisical_auth_failed");
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    switch (action) {
      case "get_health": return this.getHealth();
      case "list_secret_metadata": return this.listSecretMetadata(parameters, credential);
      case "get_secret_metadata": return this.getSecretMetadata(parameters, credential);
      case "list_secret_rotations": return this.listRotations(credential);
      case "get_rotation": return this.getRotation(parameters, credential);
      case "rotate_secrets": return this.rotateSecrets(parameters, credential);
      default: throw new Error(`infisical_unsupported_action_${action}`);
    }
  }

  // ---------------------------------------------------------------- lesing

  private async getHealth(): Promise<{ data: JsonValue }> {
    const base = await this.base();
    const res = await jsonRequest({
      service: "infisical", method: "GET", url: `${base}/api/status`, secrets: [], acceptStatus: [500, 502, 503, 504], ...(this.options.sleep ? { sleep: this.options.sleep } : {})
    }).catch((err: unknown) => {
      if (err instanceof TypeError || (err instanceof Error && err.name === "TimeoutError")) throw new Error("infisical_unreachable");
      if (err instanceof ControlTargetHttpError) return { status: err.httpStatus, ok: false, json: null };
      throw err;
    });
    const body = isObj(res.json) ? res.json : {};
    const message = strOrNull(body["message"], 40);
    return {
      data: {
        reachable: true, healthy: res.ok && message !== null, http_status: res.status, message,
        email_configured: boolOrNull(body["emailConfigured"]), redis_configured: boolOrNull(body["redisConfigured"]), invite_only_signup: boolOrNull(body["inviteOnlySignup"])
      }
    };
  }

  /** Hvitliste: ALDRI `secretValue`, `secretComment`, `secretMetadata` eller noe annet enn disse feltene. */
  private metadata(raw: unknown, now: number): SecretMetadata | null {
    if (!isObj(raw) || typeof raw["secretKey"] !== "string" || !SECRET_NAME.test(raw["secretKey"])) return null;
    const created = strOrNull(raw["createdAt"], 40);
    const updated = strOrNull(raw["updatedAt"], 40);
    const reference = Date.parse(updated ?? created ?? "");
    const tags = Array.isArray(raw["tags"]) ? raw["tags"].filter(isObj).map((t) => strOrNull(t["slug"], 60) ?? strOrNull(t["name"], 60)).filter((t): t is string => t !== null).slice(0, 5) : [];
    return {
      key: raw["secretKey"], version: numOrNull(raw["version"]), type: strOrNull(raw["type"], 20), created_at: created, updated_at: updated,
      age_days: Number.isNaN(reference) ? null : Math.max(0, Math.floor((now - reference) / DAY_MS)), tags,
      is_rotated: raw["isRotatedSecret"] === true || (typeof raw["rotationId"] === "string" && raw["rotationId"].length > 0)
    };
  }

  private async listSecretMetadata(parameters: Record<string, JsonValue>, clientSecret: string): Promise<{ data: JsonValue }> {
    const path = assertPath(parameters["path"]);
    const maxAge = parameters["max_age_days"] === undefined ? 90 : parameters["max_age_days"];
    if (typeof maxAge !== "number" || !Number.isInteger(maxAge) || maxAge < 1 || maxAge > 3650) throw new Error("infisical_invalid_max_age_days");
    const { projectId, environment } = await this.scope();
    const res = await this.authed(clientSecret, {
      method: "GET", path: "/api/v3/secrets/raw",
      query: { workspaceId: projectId, environment, secretPath: path, viewSecretValue: "false", expandSecretReferences: "false", recursive: "false", include_imports: "false" }
    });
    const rows = isObj(res.json) && Array.isArray(res.json["secrets"]) ? res.json["secrets"] : [];
    const now = this.now();
    const items = rows.map((r) => this.metadata(r, now)).filter((m): m is SecretMetadata => m !== null);
    const sorted = [...items].sort((a, b) => (b.age_days ?? -1) - (a.age_days ?? -1) || a.key.localeCompare(b.key));
    const stale = sorted.filter((s) => s.age_days !== null && s.age_days > maxAge);
    return {
      data: {
        project_id: projectId, environment, path, count: items.length, truncated: items.length > MAX_SECRETS, max_age_days: maxAge,
        stale_count: stale.length, oldest_age_days: sorted[0]?.age_days ?? null,
        secrets: sorted.slice(0, MAX_SECRETS).map((s) => ({ ...s, stale: s.age_days !== null && s.age_days > maxAge })),
        values_returned: false
      }
    };
  }

  private async getSecretMetadata(parameters: Record<string, JsonValue>, clientSecret: string): Promise<{ data: JsonValue }> {
    const key = assertSecretName(parameters["key"]);
    const path = assertPath(parameters["path"]);
    const { projectId, environment } = await this.scope();
    const res = await this.authed(clientSecret, {
      method: "GET", path: `/api/v3/secrets/raw/${encodeURIComponent(key)}`, acceptStatus: [404],
      query: { workspaceId: projectId, environment, secretPath: path, viewSecretValue: "false", expandSecretReferences: "false" }
    });
    if (res.status === 404) return { data: null };
    const meta = this.metadata(isObj(res.json) ? res.json["secret"] : null, this.now());
    return { data: meta === null ? null : { ...meta, project_id: projectId, environment, path, values_returned: false } };
  }

  private rotation(raw: unknown): RotationView | null {
    if (!isObj(raw)) return null;
    const env = isObj(raw["environment"]) ? strOrNull(raw["environment"]["slug"], 40) : strOrNull(raw["environment"], 40);
    const error = strOrNull(raw["lastRotationJobError"], 200) ?? strOrNull(raw["lastRotationError"], 200) ?? strOrNull(raw["rotationError"], 200);
    return {
      id: strOrNull(raw["id"], 64), name: strOrNull(raw["name"], 120), type: strOrNull(raw["type"], 64), environment: env, secret_path: strOrNull(raw["folder"] ?? raw["secretPath"], 200),
      auto_rotation_enabled: boolOrNull(raw["isAutoRotationEnabled"]), rotation_status: strOrNull(raw["rotationStatus"], 40),
      last_rotated_at: strOrNull(raw["lastRotatedAt"], 40), last_rotation_attempted_at: strOrNull(raw["lastRotationAttemptedAt"], 40), next_rotation_at: strOrNull(raw["nextRotationAt"], 40),
      // Feilteksten kan i prinsippet inneholde fragmenter av en tilkobling - kort og uten linjeskift.
      last_error: error === null ? null : error.replace(/\s+/g, " ").slice(0, 160)
    };
  }

  private async fetchRotations(clientSecret: string): Promise<{ available: true; rotations: RotationView[] } | { available: false; reason: string }> {
    const { projectId } = await this.scope();
    const res = await this.authed(clientSecret, { method: "GET", path: "/api/v2/secret-rotations", query: { projectId }, acceptStatus: [400, 402, 403, 404, 501] });
    if (res.status !== 200) return { available: false, reason: `http_${res.status}` };
    const rows = isObj(res.json) && Array.isArray(res.json["secretRotations"]) ? res.json["secretRotations"] : [];
    return { available: true, rotations: rows.map((r) => this.rotation(r)).filter((r): r is RotationView => r !== null && r.id !== null).slice(0, 100) };
  }

  private async listRotations(clientSecret: string): Promise<{ data: JsonValue }> {
    const result = await this.fetchRotations(clientSecret);
    if (!result.available) return { data: { available: false, reason: result.reason, count: 0, rotations: [] } };
    return { data: { available: true, count: result.rotations.length, rotations: result.rotations as unknown as JsonValue } };
  }

  /** Én rotasjon (null hvis den ikke finnes eller funksjonen er utilgjengelig) - preflight/readback for `rotate_secrets`. */
  private async getRotation(parameters: Record<string, JsonValue>, clientSecret: string): Promise<{ data: JsonValue }> {
    const id = parameters["rotation_id"];
    if (!isRotationId(id)) throw new Error("infisical_invalid_rotation_id");
    const result = await this.fetchRotations(clientSecret);
    if (!result.available) return { data: null };
    const found = result.rotations.find((r) => r.id?.toLowerCase() === id.toLowerCase());
    return { data: found === undefined ? null : (found as unknown as JsonValue) };
  }

  // ---------------------------------------------------------------- klasse D

  private async rotateSecrets(parameters: Record<string, JsonValue>, clientSecret: string): Promise<{ external_id?: string; data?: JsonValue }> {
    const id = parameters["rotation_id"];
    if (!isRotationId(id)) throw new Error("infisical_invalid_rotation_id");
    const before = await this.fetchRotations(clientSecret);
    if (!before.available) throw new Error(`infisical_rotation_unavailable:${before.reason}`);
    const current = before.rotations.find((r) => r.id?.toLowerCase() === id.toLowerCase());
    if (!current) throw new Error("infisical_rotation_not_found");
    // Typen kommer fra Infisicals EGEN liste og settes inn i en URL-sti - derfor streng validering (aldri `..`, `/`, store bokstaver eller lange verdier).
    if (current.type === null || !ROTATION_TYPE.test(current.type)) throw new Error("infisical_rotation_type_invalid");
    await this.authed(clientSecret, { method: "POST", path: `/api/v2/secret-rotations/${current.type}/${id.toLowerCase()}/rotate-secrets`, body: {} });
    const after = await this.fetchRotations(clientSecret);
    const updated = after.available ? after.rotations.find((r) => r.id?.toLowerCase() === id.toLowerCase()) : undefined;
    const status = updated?.rotation_status ?? null;
    if (status !== null && /fail|error/i.test(status)) throw new Error(`infisical_rotation_failed:${status.slice(0, 30)}`);
    return { external_id: `rotation:${id.toLowerCase()}`, data: { rotated: true, rotation: (updated ?? current) as unknown as JsonValue } };
  }
}
