// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { RADAR_KINDS, ingestRadarItem, type RadarKind } from "@jarvis/self-modification";
import { guardedFetch } from "@jarvis/tool-gateway";

/**
 * EV-3 (D-452, WP-B): selve INNHENTINGEN for Continuous Improvement Radar - nettverksdelen som `evolution/radar.ts` bevisst lot stå DEFERRED. Sikkerhetssonen (`ingestRadarItem`: alt tagges UNTRUSTED_RESEARCH,
 * instruksjoner i kilden er data, mistenkelig innhold i karantene, sikkerhetshendelse) er uendret; her hentes bare tekst fra KILDER EIEREN SELV HAR VALGT (`JARVIS_RADAR_SOURCES`) og sendes gjennom sonen.
 *
 * Inert som standard: uten kilder gjøres ingen nettverkskall. Observasjon: rapporten får kun antall og statuskategorier per kilde (aldri innholdet), ingenting lagres og ingenting utføres. Innholdet kan ikke bli evidens
 * eller instruks - det forlater aldri denne funksjonen. Forsvar mot en feilkonfigurert eller ondsinnet kilde: kun https mot et vertsnavn (ingen IP-adresser/`localhost`/`.local`/`.internal`), ingen brukerinfo, ingen redirect
 * (en 3xx er en feil, så en kilde kan ikke sende oss videre til en intern adresse), tekst-innholdstype, størrelsestak (strøm avbrytes), tidsavbrudd og høyst 20 kilder.
 */
export const MAX_RADAR_SOURCES = 20;
export const RADAR_MAX_BYTES = 200_000;
export const RADAR_TIMEOUT_MS = 15_000;

export interface RadarSourceConfig {
  kind: RadarKind;
  name: string;
  url: string;
}

export interface RadarSourcesParse {
  sources: RadarSourceConfig[];
  /** Antall oppføringer som ble forkastet (ugyldig form/URL, for mange). Aldri innholdet. */
  rejected: number;
}

const FORBIDDEN_HOST = /^(?:localhost|.*\.(?:local|internal|localhost|lan|home|corp|intranet))$/i;
const isIpLiteral = (host: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":") || /^\[/.test(host) || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);

/** Én kilde er gyldig bare hvis den er `https` mot et vanlig vertsnavn uten brukerinfo. */
export function isAcceptableRadarUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return false;
  const host = url.hostname;
  return host.includes(".") && !isIpLiteral(host) && !FORBIDDEN_HOST.test(host) && raw.length <= 500;
}

export function parseRadarSources(raw: string | undefined): RadarSourcesParse {
  if (raw === undefined || raw.trim() === "") return { sources: [], rejected: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { sources: [], rejected: 1 };
  }
  if (!Array.isArray(parsed)) return { sources: [], rejected: 1 };
  const sources: RadarSourceConfig[] = [];
  let rejected = 0;
  for (const entry of parsed) {
    const e = entry as { kind?: unknown; name?: unknown; url?: unknown } | null;
    const ok =
      e !== null && typeof e === "object" && typeof e.kind === "string" && (RADAR_KINDS as readonly string[]).includes(e.kind) &&
      typeof e.name === "string" && e.name.trim().length > 0 && e.name.length <= 100 && typeof e.url === "string" && isAcceptableRadarUrl(e.url);
    if (!ok || sources.length >= MAX_RADAR_SOURCES) {
      rejected += 1;
      continue;
    }
    sources.push({ kind: e.kind as RadarKind, name: (e.name as string).trim(), url: e.url as string });
  }
  return { sources, rejected };
}

export type RadarSourceStatus = "ok" | "quarantined" | "fetch_failed";

export interface RadarSourceResult {
  name: string;
  kind: RadarKind;
  status: RadarSourceStatus;
  /** Funn-kategorier fra sikkerhetssonen (f.eks. `injection:role_override`) eller feilklasse (`http_503`, `too_large`, `not_text`, `timeout`). Aldri innhold. */
  findings: string[];
  bytes: number;
}

export interface RadarSweepResult {
  at: string;
  configured: number;
  ok: number;
  quarantined: number;
  failed: number;
  security_events: number;
  per_source: RadarSourceResult[];
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Leser høyst `maxBytes` fra strømmen og avbryter den ved overskridelse. */
async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; bytes: number } | "too_large"> {
  if (response.body === null) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes };
}

/** Enkel HTML→tekst: skript/stil fjernes helt, tagger blir mellomrom. Teksten er fortsatt UBETRODD (sonen sanerer og tester videre). */
export function htmlToText(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&");
}

export interface RadarSweepDeps {
  sources: ReadonlyArray<RadarSourceConfig>;
  fetchImpl?: FetchLike;
  now?: () => Date;
  maxBytes?: number;
  timeoutMs?: number;
}

export async function runRadarSweep(deps: RadarSweepDeps): Promise<RadarSweepResult> {
  const now = deps.now ?? (() => new Date());
  const doFetch: FetchLike = deps.fetchImpl ?? ((url, init) => guardedFetch(url, init));
  const maxBytes = deps.maxBytes ?? RADAR_MAX_BYTES;
  const timeoutMs = deps.timeoutMs ?? RADAR_TIMEOUT_MS;
  const per_source: RadarSourceResult[] = [];
  let securityEvents = 0;
  for (const source of deps.sources) {
    const result: RadarSourceResult = { name: source.name, kind: source.kind, status: "fetch_failed", findings: [], bytes: 0 };
    try {
      const response = await doFetch(source.url, {
        method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "text/html, text/plain, application/json, application/xml, application/atom+xml, text/xml;q=0.9" }
      });
      if (response.status >= 300) {
        result.findings = [response.status >= 300 && response.status < 400 ? "redirect_refused" : `http_${response.status}`];
      } else if (!/^(?:text\/|application\/(?:json|xml|atom\+xml|rss\+xml|xhtml\+xml))/i.test(response.headers.get("content-type") ?? "")) {
        result.findings = ["not_text"];
      } else {
        const body = await readCapped(response, maxBytes);
        if (body === "too_large") {
          result.findings = ["too_large"];
        } else {
          result.bytes = body.bytes;
          const text = /html/i.test(response.headers.get("content-type") ?? "") ? htmlToText(body.text) : body.text;
          const ingested = ingestRadarItem({ kind: source.kind, source_url: source.url, source_name: source.name, title: source.name, body: text.slice(0, 20_000), fetched_at: now().toISOString() });
          if (ingested.security_event) securityEvents += 1;
          result.status = ingested.quarantined ? "quarantined" : "ok";
          result.findings = ingested.findings;
        }
      }
    } catch (err) {
      result.findings = [(err as Error).name === "TimeoutError" || (err as Error).name === "AbortError" ? "timeout" : "network_error"];
    }
    per_source.push(result);
  }
  return {
    at: now().toISOString(),
    configured: deps.sources.length,
    ok: per_source.filter((s) => s.status === "ok").length,
    quarantined: per_source.filter((s) => s.status === "quarantined").length,
    failed: per_source.filter((s) => s.status === "fetch_failed").length,
    security_events: securityEvents,
    per_source
  };
}

/** Prosess-lokal holder for siste sveip (rapporten leser den; sveipet kjører planlagt, aldri fra rapporten). */
export interface RadarState {
  configured: number;
  rejected: number;
  last(): RadarSweepResult | null;
  run(): Promise<RadarSweepResult>;
}

export function createRadarState(env: Readonly<Record<string, string | undefined>>, overrides: Partial<Pick<RadarSweepDeps, "fetchImpl" | "now" | "maxBytes" | "timeoutMs">> = {}): RadarState {
  const { sources, rejected } = parseRadarSources(env["JARVIS_RADAR_SOURCES"]);
  let last: RadarSweepResult | null = null;
  return {
    configured: sources.length,
    rejected,
    last: () => last,
    run: async () => {
      last = await runRadarSweep({ sources, ...overrides });
      return last;
    }
  };
}
