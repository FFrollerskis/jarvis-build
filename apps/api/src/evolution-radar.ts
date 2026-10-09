// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { RADAR_KINDS, ingestRadarItem, type RadarKind } from "@jarvis/self-modification";
import { assertSafeVendorUrl, guardedFetch } from "@jarvis/tool-gateway";
import { RadarHostBlockedError, assertPublicHost, radarHostRejection, systemLookup, type LookupImpl } from "./radar-url-guard.ts";

/**
 * EV-3 (D-452, WP-B): selve INNHENTINGEN for Continuous Improvement Radar - nettverksdelen som `evolution/radar.ts` bevisst lot stå DEFERRED. Sikkerhetssonen (`ingestRadarItem`: alt tagges UNTRUSTED_RESEARCH,
 * instruksjoner i kilden er data, mistenkelig innhold i karantene, sikkerhetshendelse) er uendret; her hentes bare tekst fra KILDER EIEREN SELV HAR VALGT (`JARVIS_RADAR_SOURCES`) og sendes gjennom sonen.
 *
 * Inert som standard: uten kilder gjøres ingen nettverkskall. Observasjon: rapporten får kun antall og statuskategorier per kilde (aldri innholdet), ingenting lagres og ingenting utføres. Innholdet kan ikke bli evidens
 * eller instruks - det forlater aldri denne funksjonen. Forsvar mot en feilkonfigurert eller ondsinnet kilde: kun https (port 443) mot et vanlig, OFFENTLIG vertsnavn uten brukerinfo - vertsreglene og adresseklassifiseringen står i
 * `radar-url-guard.ts`: reserverte/interne suffikser, jokertegn-DNS med innebygd IP og IP-litteraler avvises syntaktisk (etter normalisering), og vertsnavnet LØSES FØR HVER HENTING slik at en privat/loopback/link-local/CGNAT/
 * metadata/unik-lokal adresse i svaret avviser kilden. Videre: ingen redirect (en 3xx er en feil, så en kilde kan ikke sende oss videre til en intern adresse), tekst-innholdstype, størrelsestak (strøm avbrytes), tidsavbrudd og
 * høyst 20 kilder. KJENT RESTRISIKO: DNS-rebinding mellom kontrollen og tilkoblingen er ikke lukket (global `fetch` kan ikke festes til den kontrollerte IP-en) - se `radar-url-guard.ts` for hva som begrenser skaden.
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

/**
 * Én kilde er gyldig bare hvis den er `https` mot et vanlig, offentlig vertsnavn uten brukerinfo og port. SYNTAKTISK sjekk (ingen DNS): den rå strengen må bestå samme regler som `guardedFetch` (ren ASCII-vert, ingen kontrolltegn/backslash/
 * punktum-segmenter/stille normalisering), og verten vurderes ETTER normalisering (`radarHostRejection`). Den oppløste adressen kontrolleres separat rett før hver henting (`assertPublicHost`).
 */
export function isAcceptableRadarUrl(raw: string): boolean {
  if (typeof raw !== "string" || raw.length > 500) return false;
  try {
    assertSafeVendorUrl(raw);
  } catch {
    return false;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return false;
  return radarHostRejection(url.hostname) === null;
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
  /** Funn-kategorier fra sikkerhetssonen (f.eks. `injection:role_override`) eller feilklasse (`http_503`, `too_large`, `not_text`, `timeout`, `url_rejected`, `blocked_address`, `dns_failure`). Aldri innhold. */
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

/** Tekst som sendes til sikkerhetssonen kuttes alltid til dette (samme tak som `RadarItemSchema.body`). Kuttet gjøres på RÅ inndata, FØR enhver stripping. */
export const RADAR_TEXT_MAX_CHARS = 20_000;
/** Lengste «tagg» (`<` … `>`) som strippes. En `<` uten `>` innenfor dette er vanlig tekst, ikke en tagg som sluker resten av siden. */
const MAX_TAG_CHARS = 2_000;

/** ASCII-små bokstaver med uendret lengde (til forskjell fra `toLowerCase()`, som kan endre lengden og dermed flytte indeksene). */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/**
 * Enkel HTML→tekst: skript/stil/kommentarer fjernes helt, tagger blir mellomrom. Teksten er fortsatt UBETRODD (sonen sanerer og tester videre).
 *
 * M1 (gjennomgang av PR #313): den forrige regex-versjonen (`<(script|style)[\s\S]*?<\/\1>` og `<[^>]+>`) var KVADRATISK på fiendtlig inndata - `"<".repeat(190000)` blokkerte API-prosessen i 55 s (koden er synkron, så
 * `AbortSignal.timeout` hjelper ikke). Nå: (1) inndata kuttes til `maxChars` FØR noe annet, og (2) skanningen er LINEÆR - én gjennomgang, ingen regex med bakoverreferanser/overlappende kvantorer. Hver `indexOf` starter der
 * forrige slapp, og «finnes ikke mer» (`-1`) huskes, så en `<` som aldri lukkes ikke gir en ny søk til slutten av teksten for hver `<`. Uavsluttet skript/stil/kommentar strippes ikke som blokk (innholdet blir stående som tekst, slik
 * at sonen ser MER, ikke mindre); det er også derfor en `<` uten `>` innenfor `MAX_TAG_CHARS` er ren tekst.
 */
export function htmlToText(html: string, maxChars: number = RADAR_TEXT_MAX_CHARS): string {
  const src = html.length > maxChars ? html.slice(0, maxChars) : html;
  const lower = asciiLower(src);
  const n = src.length;
  const out: string[] = [];
  let i = 0;
  let textStart = 0;
  // Neste `>` på eller etter forrige søkeposisjon (-1 = det finnes ingen flere; -2 = ikke søkt ennå). Søkeposisjonen vokser bare, så en eldre treffposisjon `>= from` er fortsatt den første.
  let gt = -2;
  const nextGt = (from: number): number => {
    if (gt === -1) return -1;
    if (gt < from) gt = src.indexOf(">", from);
    return gt;
  };
  // Husker at en lukkende markør ikke finnes (ellers ville hver uavsluttet åpner søkt gjennom resten av teksten på nytt).
  const missing = { script: false, style: false, comment: false };
  const flush = (end: number): void => {
    if (end > textStart) out.push(src.slice(textStart, end));
  };
  const skip = (from: number, to: number): void => {
    flush(from);
    out.push(" ");
    i = to;
    textStart = to;
  };
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    i = lt + 1;
    const c = src.charAt(lt + 1);
    if (c === "!" && src.startsWith("!--", lt + 1) && !missing.comment) {
      // Søker fra `lt + 2`, så de tomme kommentarene `<!-->` og `<!--->` lukkes som i nettleseren (ellers kunne tekst etter dem skjules for sonen).
      const end = src.indexOf("-->", lt + 2);
      if (end !== -1) { skip(lt, end + 3); continue; }
      missing.comment = true;
    }
    const rawText = lower.startsWith("script", lt + 1) ? "script" : lower.startsWith("style", lt + 1) ? "style" : null;
    if (rawText !== null && /[\s/>]/.test(src.charAt(lt + 1 + rawText.length) || ">") && !missing[rawText]) {
      const close = lower.indexOf(`</${rawText}`, lt + 1 + rawText.length);
      if (close !== -1) {
        const g = nextGt(close + 2 + rawText.length);
        skip(lt, g !== -1 && g - close <= MAX_TAG_CHARS ? g + 1 : close + 2 + rawText.length);
        continue;
      }
      missing[rawText] = true;
    }
    // En tagg begynner med `<` + bokstav, `/`, `!` eller `?` (som i HTML-spesifikasjonen); `a < b` er tekst. Tagger lengre enn `MAX_TAG_CHARS` er også tekst.
    if (/[A-Za-z/!?]/.test(c)) {
      const g = nextGt(lt + 1);
      if (g !== -1 && g - lt <= MAX_TAG_CHARS) { skip(lt, g + 1); continue; }
    }
  }
  flush(n);
  return out.join("").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&");
}

export interface RadarSweepDeps {
  sources: ReadonlyArray<RadarSourceConfig>;
  fetchImpl?: FetchLike;
  /** DNS-oppløsning FØR hver henting (L1). Standard: `dns.promises.lookup(host, { all: true })`. Tester injiserer en falsk - ingen test kaller nettet. Kan ikke hoppes over ved å injisere `fetchImpl`. */
  lookupImpl?: LookupImpl;
  now?: () => Date;
  maxBytes?: number;
  timeoutMs?: number;
}

export async function runRadarSweep(deps: RadarSweepDeps): Promise<RadarSweepResult> {
  const now = deps.now ?? (() => new Date());
  const doFetch: FetchLike = deps.fetchImpl ?? ((url, init) => guardedFetch(url, init));
  const lookup: LookupImpl = deps.lookupImpl ?? systemLookup;
  const maxBytes = deps.maxBytes ?? RADAR_MAX_BYTES;
  const timeoutMs = deps.timeoutMs ?? RADAR_TIMEOUT_MS;
  const per_source: RadarSourceResult[] = [];
  let securityEvents = 0;
  for (const source of deps.sources) {
    const result: RadarSourceResult = { name: source.name, kind: source.kind, status: "fetch_failed", findings: [], bytes: 0 };
    try {
      // L1: kilden vurderes på nytt her (ikke bare ved parsing av konfigurasjonen), og vertsnavnet løses FØR hver henting. Ingenting hentes hvis noen av delene avviser kilden.
      if (!isAcceptableRadarUrl(source.url)) {
        result.findings = ["url_rejected"];
        per_source.push(result);
        continue;
      }
      await assertPublicHost(new URL(source.url).hostname, lookup, timeoutMs);
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
          // M1: kuttet gjøres på RÅ tekst, FØR enhver stripping/regex (en kropp på opptil 200 kB skal aldri nå skanneren i full lengde).
          const raw = body.text.slice(0, RADAR_TEXT_MAX_CHARS);
          const text = /html/i.test(response.headers.get("content-type") ?? "") ? htmlToText(raw) : raw;
          const ingested = ingestRadarItem({ kind: source.kind, source_url: source.url, source_name: source.name, title: source.name, body: text.slice(0, RADAR_TEXT_MAX_CHARS), fetched_at: now().toISOString() });
          if (ingested.security_event) securityEvents += 1;
          result.status = ingested.quarantined ? "quarantined" : "ok";
          result.findings = ingested.findings;
        }
      }
    } catch (err) {
      result.findings = [err instanceof RadarHostBlockedError ? err.reason : (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError" ? "timeout" : "network_error"];
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
/**
 * Hva en planlagt kjøring skal feile høyt på (D-442, L6): KUN når ALLE kilder feilet - da er nett/DNS eller konfigurasjonen nede, og scheduleren kan prøve igjen med backoff og til slutt gi opp synlig. En
 * delvis svikt (noen kilder hentet) er et funn i EV-3-seksjonen, ikke en feilet kjøring. Feilen bærer kun kildenavn (eierens eget) og feilkoder - aldri innhold, URL eller meldingstekst.
 */
export function radarSweepFailures(result: RadarSweepResult, tenantId: string): Array<{ tenant_id: string; scope: string; error: string }> {
  if (result.configured === 0 || result.failed === 0 || result.ok + result.quarantined > 0) return [];
  return result.per_source.filter((s) => s.status === "fetch_failed").map((s) => ({ tenant_id: tenantId, scope: s.name, error: s.findings.join(",") || "fetch_failed" }));
}

export interface RadarState {
  configured: number;
  rejected: number;
  last(): RadarSweepResult | null;
  run(): Promise<RadarSweepResult>;
}

export function createRadarState(env: Readonly<Record<string, string | undefined>>, overrides: Partial<Pick<RadarSweepDeps, "fetchImpl" | "lookupImpl" | "now" | "maxBytes" | "timeoutMs">> = {}): RadarState {
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
