import type { JsonValue } from "@jarvis/contracts";
import type { ToolTransport } from "./gateway.ts";
import { ControlTargetHttpError, isObj, jsonRequest, normalizeBaseUrl, numOrNull } from "./control-target-http.ts";
import { vendorText } from "./vendor-text.ts";

/**
 * WP-E1 (UA-5, D-41/D-64): Langfuse som KONTROLLERT MÅL - helse, prosjekt-/nøkkel-metadata og trace-TELLING. ALDRI innhold: ingen funksjon her returnerer en traces
 * input/output/metadata/brukere/sesjoner; tellingen leses fra daglige aggregater (`/api/public/metrics/daily`, ingen trace-kropper i det hele tatt), og kun
 * `meta.totalItems` leses fra trace-listen i fallback (resten av svaret kastes uten å bli lest).
 *
 * D-64 Core-vs-Adapter: Langfuse er en ADAPTER bak observability (`TraceSink` i model-gateway) - `EXTERNAL_CANONICAL` for traces; Jarvis' egen kost-/revisjonsmodell
 * (`cost_events`, `audit_events`) er kanonisk. Ingenting her gjør Langfuse til domenekjernen (`CORE_DEPENDENCY_DECISION_REQUIRED=false`).
 *
 * ENDEPUNKTER (verifisert mot Langfuses dokumentasjon via søk 2026-10-09; selvhostet image i compose er v2.95.x - versjonsforskjeller er merket under):
 *   - `GET /api/public/health[?failIfDatabaseUnavailable=true]` (ingen autentisering; 200 = OK, 503 = nede/DB utilgjengelig). Feltet `version` i svaret er IKKE
 *     bekreftet i dokumentasjonen og leses defensivt.
 *   - `GET /api/public/projects` (Basic-auth public:secret; returnerer prosjektet nøkkelen tilhører: `data[{id,name,organization{id,name}}]`).
 *   - `GET /api/public/metrics/daily?fromTimestamp&toTimestamp` (daglige aggregater `countTraces`/`countObservations`/`totalCost`; markert deprecated i nyere Langfuse til fordel
 *     for v2 metrics - finnes i selvhostet v2). Mangler endepunktet (404) brukes `GET /api/public/traces?limit=1` og KUN `meta.totalItems` leses. IKKE bekreftet:
 *     `fromTimestamp`/`toTimestamp` på trace-listen (fra tredjepartsdokumentasjon).
 *
 * SIKKERHET: secret key kun som parameter fra `ToolGateway` (aldri logget, vaskes ut av feil, aldri til modellen); basis-URL fra miljø (aldri modellstyrt) og
 * valideres som ren opprinnelse; utdata er hvitlistet (ingen ukjente felt videre); alle kall via `guardedFetch`.
 *
 * LEVERANDØRTEKST (gjennomgang av PR #324, M1): fritekst fra Langfuse (status, prosjekt-/organisasjonsnavn, feilmeldinger) går gjennom den sentrale hemmelighetsskanneren (`vendorText`) før den forlater transporten,
 * og datofelt godtas kun som `ÅÅÅÅ-MM-DD`.
 */
export interface LangfuseTransportOptions {
  /** `LANGFUSE_BASE_URL` (f.eks. `http://langfuse:3000` eller Langfuse Cloud), slått opp ved hvert kall. */
  baseUrl: () => Promise<string | null>;
  /** `LANGFUSE_PUBLIC_KEY` (brukernavn i Basic-auth). */
  publicKey: () => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type LangfuseCapabilityStatus = "IMPLEMENTED" | "PARTIAL" | "DEFERRED";
export interface LangfuseCapability { capability: string; status: LangfuseCapabilityStatus; risk: "A" | "B" | "C" | "D" | "-"; note: string }

/** D-41-matrise (regel 11): bygget, delvis bygget eller eksplisitt DEFERRED med begrunnelse - aldri stille utelatt. */
export const LANGFUSE_CAPABILITIES: readonly LangfuseCapability[] = [
  { capability: "Helse (GET /api/public/health?failIfDatabaseUnavailable=true)", status: "IMPLEMENTED", risk: "A", note: "200 = OK; `version` leses defensivt (feltet er ikke bekreftet i dokumentasjonen)" },
  { capability: "Prosjekt- og nøkkel-metadata (GET /api/public/projects)", status: "PARTIAL", risk: "A", note: "prosjekt-id/-navn/organisasjon + MASKERT public key; selve nøkkellisten (GET /projects/{id}/apiKeys) krever en organisasjons-nøkkel og Enterprise Edition ved selvhosting - DEFERRED" },
  { capability: "Trace-telling per dag (GET /api/public/metrics/daily; fallback traces?limit=1 meta.totalItems)", status: "IMPLEMENTED", risk: "A", note: "kun tall (traces/observasjoner/kost) - ALDRI trace-innhold, brukere, sesjoner eller metadata; endepunktet er deprecated i nyere Langfuse" },
  { capability: "Slette traces/sesjoner (DELETE /api/public/traces, /traces/{id}) - f.eks. for sletting/erasure", status: "DEFERRED", risk: "-", note: "ikke verifisert mot selvhostet v2.95.x (nyere Langfuse sletter asynkront uten bekreftelse, maks 30-50 id-er per kall); irreversibelt og uten gjenopprettingsvei; erasure-gapet står i DATA_ERASURE.md og krever egen eierbeslutning + verifisert endepunkt/readback" },
  { capability: "Opprette/slette prosjekt-API-nøkler og rotere nøkkelpar", status: "DEFERRED", risk: "-", note: "organisasjons-nøkkel + Enterprise Edition kreves; den nye secret key returneres én gang og må rett inn i Infisical uten å passere modell/logg - krever egen flyt og eierbeslutning" },
  { capability: "Prompts, datasett, scores, annotering, LLM-som-dommer", status: "DEFERRED", risk: "-", note: "produkt-/evalueringsfunksjoner, ikke infrastrukturdrift; utenfor UA-5" },
  { capability: "Sende traces (ingestion)", status: "IMPLEMENTED", risk: "-", note: "gjøres av LangfuseTraceSink i model-gateway (BO-09/D-27), ikke av dette verktøyet" }
];

const DAY_MS = 86_400_000;
const MAX_DAYS = 31;
/** Identifikatorer (prosjekt, organisasjon) og datoer låses til sin form - de kan aldri bære fritekst fra leverandøren. */
const idOrNull = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
const dayOrNull = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** `pk-lf-1234…abcd`: nok til å kjenne igjen NØKKELEN i dashbordet, aldri nok til å bruke den. */
export function maskPublicKey(key: string): string {
  return key.length >= 16 ? `${key.slice(0, 9)}…${key.slice(-4)}` : "***";
}

export class LangfuseTransport implements ToolTransport {
  constructor(private readonly options: LangfuseTransportOptions) {}

  private async base(): Promise<string> {
    const raw = await this.options.baseUrl();
    if (raw === null || raw.trim() === "") throw new Error("langfuse_base_url_not_configured");
    return normalizeBaseUrl(raw, "langfuse");
  }

  private async auth(secretKey: string): Promise<{ header: string; publicKey: string }> {
    const publicKey = (await this.options.publicKey())?.trim() ?? "";
    if (publicKey === "") throw new Error("langfuse_public_key_not_configured");
    return { header: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`, publicKey };
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string): Promise<{ external_id?: string; data?: JsonValue }> {
    switch (action) {
      case "get_health": return this.getHealth();
      case "get_project": return this.getProject(credential);
      case "get_trace_counts": return this.getTraceCounts(parameters, credential);
      default: throw new Error(`langfuse_unsupported_action_${action}`);
    }
  }

  private async getHealth(): Promise<{ data: JsonValue }> {
    const base = await this.base();
    const res = await jsonRequest({
      service: "langfuse", method: "GET", url: `${base}/api/public/health?failIfDatabaseUnavailable=true`, secrets: [],
      acceptStatus: [500, 502, 503, 504], ...(this.options.sleep ? { sleep: this.options.sleep } : {})
    }).catch((err: unknown) => {
      // Et nettverksavbrudd (kastet fetch-feil) er «utilgjengelig»; alt annet (usikker URL, for stort svar …) er en konfig-/protokollfeil og skal ikke skjules som nedetid.
      if (err instanceof TypeError || (err instanceof Error && err.name === "TimeoutError")) throw new Error("langfuse_unreachable");
      if (err instanceof ControlTargetHttpError) return { status: err.httpStatus, ok: false, json: null };
      throw err;
    });
    const body = isObj(res.json) ? res.json : {};
    // Redigert FØR formsjekken: et token-formet «version»-felt (`ghp_…`) består tegnsett-regexen, men blir `[REDACTED:…]` her og forkastes av den.
    const version = vendorText(body["version"], 40);
    return {
      data: {
        reachable: true, healthy: res.ok, http_status: res.status, database_checked: true,
        status: vendorText(body["status"], 20), version: version !== null && /^[0-9A-Za-z.+_-]+$/.test(version) ? version : null
      }
    };
  }

  private async getProject(secretKey: string): Promise<{ data: JsonValue }> {
    const base = await this.base();
    const { header, publicKey } = await this.auth(secretKey);
    const res = await jsonRequest({
      service: "langfuse", method: "GET", url: `${base}/api/public/projects`, headers: { authorization: header },
      secrets: [secretKey, header, publicKey], ...(this.options.sleep ? { sleep: this.options.sleep } : {})
    });
    const rows = isObj(res.json) && Array.isArray(res.json["data"]) ? res.json["data"] : [];
    const projects = rows.filter(isObj).slice(0, 20).map((p) => {
      const org = isObj(p["organization"]) ? p["organization"] : {};
      return { id: idOrNull(p["id"]), name: vendorText(p["name"], 120), organization_id: idOrNull(org["id"]), organization_name: vendorText(org["name"], 120) };
    });
    return { data: { credentials_valid: true, key: { public_key_hint: maskPublicKey(publicKey), scope: "project" }, projects, project_count: projects.length } };
  }

  private async getTraceCounts(parameters: Record<string, JsonValue>, secretKey: string): Promise<{ data: JsonValue }> {
    const raw = parameters["window_days"];
    const windowDays = raw === undefined ? 7 : raw;
    if (typeof windowDays !== "number" || !Number.isInteger(windowDays) || windowDays < 1 || windowDays > MAX_DAYS) throw new Error("langfuse_invalid_window_days");
    const base = await this.base();
    const { header, publicKey } = await this.auth(secretKey);
    const to = new Date((this.options.now ?? Date.now)());
    const from = new Date(to.getTime() - windowDays * DAY_MS);
    const query = new URLSearchParams({ fromTimestamp: from.toISOString(), toTimestamp: to.toISOString() });
    const common = { service: "langfuse", method: "GET" as const, headers: { authorization: header }, secrets: [secretKey, header, publicKey], ...(this.options.sleep ? { sleep: this.options.sleep } : {}) };
    const daily = await jsonRequest({ ...common, url: `${base}/api/public/metrics/daily?${query.toString()}&limit=${windowDays + 1}&page=1`, acceptStatus: [404] });
    if (daily.status !== 404) {
      const rows = isObj(daily.json) && Array.isArray(daily.json["data"]) ? daily.json["data"] : [];
      const days = rows.filter(isObj).slice(0, MAX_DAYS + 1).map((d) => ({
        date: dayOrNull(d["date"]), traces: numOrNull(d["countTraces"]) ?? 0, observations: numOrNull(d["countObservations"]) ?? 0,
        cost_usd: Math.round((numOrNull(d["totalCost"]) ?? 0) * 10_000) / 10_000
      }));
      const meta = isObj(daily.json) && isObj(daily.json["meta"]) ? daily.json["meta"] : {};
      return {
        data: {
          source: "metrics_daily", window_days: windowDays, from: from.toISOString(), to: to.toISOString(), days,
          total_traces: days.reduce((s, d) => s + d.traces, 0), total_observations: days.reduce((s, d) => s + d.observations, 0),
          total_cost_usd: Math.round(days.reduce((s, d) => s + d.cost_usd, 0) * 10_000) / 10_000,
          truncated: (numOrNull(meta["totalPages"]) ?? 1) > 1
        }
      };
    }
    // Fallback: KUN totalItems leses - resten av trace-listen (innhold) kastes uten å bli videreført.
    const list = await jsonRequest({ ...common, url: `${base}/api/public/traces?limit=1&page=1&${query.toString()}` });
    const meta = isObj(list.json) && isObj(list.json["meta"]) ? list.json["meta"] : {};
    const total = numOrNull(meta["totalItems"]);
    if (total === null) throw new Error("langfuse_invalid_response:trace_total_missing");
    return { data: { source: "traces_meta", window_days: windowDays, from: from.toISOString(), to: to.toISOString(), days: [], total_traces: total, total_observations: null, total_cost_usd: null, truncated: false, note: "fallback: daglige aggregater finnes ikke i denne Langfuse-versjonen" } };
  }
}
