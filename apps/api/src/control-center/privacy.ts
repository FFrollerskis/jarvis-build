// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { constants as fsConstants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanForSecrets } from "@jarvis/core";
import {
  controlItem, controlSection, unknownControlSection,
  type ControlCenterBuildContext, type ControlCenterDefinition, type ControlCenterParts, type ControlItem, type ControlSection, type ControlStatus
} from "@jarvis/executive";
import { jobState, readJobs } from "./integration.ts";
import { readErasure, type ErasureRead } from "./memory.ts";
import { buildVisionSection, type PrivacyVisionSource } from "./privacy-vision.ts";
import {
  DAY_MS, bySeverityThenLabel, countsNo, globalRows, relativeNo, safeCategory, settle, tenantRead, toInt, toIso,
  type ControlCenterPool, type Settled
} from "./shared.ts";

/**
 * WP-H2 (UA-11 Admin Control Center, masterplan v4.0 kap. 21) - PRIVACY CENTER: behandlingsoversikt, oppbevaring, DPIA-status og slettebevis.
 *
 * Kun LESING - ingen nye eksterne kall, ingen skriving, aldri personinnhold (kun antall, kategorier, tilstander og tidsstempler):
 *  - BEHANDLINGSOVERSIKT og DPIA: `docs/security/PROCESSING_INVENTORY.md` (D-420; samme dokument CI-vakten `d420-processing-inventory.test.ts` sjekker mot migrasjonene), parset strukturelt (tabellnavn,
 *    tabellrader, statusord) og sammenlignet med de LEVENDE tabellene i databasen (`pg_tables`). Dokumentet er repo-innhold og følger IKKE med i api-imaget (`api.Dockerfile` kopierer apps/packages/modules/config):
 *    uten det står dokumentdelen som `ikke målt` (aldri «i orden»). Eieren kan montere `docs/` skrivebeskyttet i containeren (se runbooken) - da måles den også i drift.
 *  - OPPBEVARING: de daglige sveipene (`scheduler_state`) og rader som er eldre enn oppbevaringsgrensen likevel står igjen (`tool_executions`, `session_grants`), pluss alder på de eldste radene i tabellene
 *    UTEN automatisk sletting (`audit_events`, `cost_events`; oppbevaring der er en eierbeslutning, jf. migrasjon 073).
 *  - SLETTEBEVIS: `erasure_requests` + `erasure_fingerprints` (gjenbruker leseren fra Minne-senteret, så to sentre aldri teller ulikt).
 *
 * WP-G3b (D-485): med `deps.vision` (kun med JARVIS_VISION_ENABLED=on, se `registerControlCenters`) kommer en sjette seksjon, «Syn og kamera» (`privacy-vision.ts`): kamerakjøretidens helsebilde og de gjeldende oppbevaringsvinduene, kun lesing.
 * Uten `vision` er senteret BYTE-IDENTISK med main (opptak i `wpg3b-privacy-parity.test.ts`).
 *
 * ÆRLIGHET: DPIA-status er det dokumentet ERKLÆRER («UTKAST», «ikke godkjent») - ikke en juridisk vurdering. Alle skyleverandører står som IKKE VERIFISERT i dokumentet, og det telles her. Slette-inngangen
 * (`ErasureService`) er ikke koblet i produksjon (JARVIS-060), og om slettinger er gjenanvendt etter en restore (`reapplyErasuresAfterRestore`) måles ikke - begge står rett ut.
 */

export const INVENTORY_MAX_BYTES = 512 * 1024;
export const INVENTORY_READ_TIMEOUT_MS = 5_000;
const INVENTORY_REL = "docs/security/PROCESSING_INVENTORY.md";
/** Oppbevaringsgrensene som `prune_operational_data()` (migrasjon 073) bruker som standard, pluss en karens før noe regnes som «henger etter». */
export const TOOL_EXECUTION_RETENTION_DAYS = 180;
export const GRANT_RETENTION_DAYS = 30;
export const RETENTION_SLACK_DAYS = 2;
const MAX_LISTED_TABLES = 12;
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

/** Retensjons- og vedlikeholdssveipene som er registrert i `main.ts` (DailyScheduler-navn). Låst mot `main.ts` av testen. */
export const RETENTION_JOBS: ReadonlyArray<{ job: string; label: string }> = [
  { job: "operational-retention-sweep", label: "Driftsrader (godkjenninger, grants, billetter, verktøyutføringer, scheduler)" },
  { job: "memory-retention-sweep", label: "Minne (konsolidering av gamle samtaleminner)" },
  { job: "location-retention-sweep", label: "Sted" },
  { job: "health-retention-sweep", label: "Helse" },
  { job: "vision-retention-sweep", label: "Syn" }
];

// ---------------------------------------------------------------------------------------------------------------------
// Behandlingsoversikten: parsing (ren funksjon, låst mot det ekte dokumentet av testen)
// ---------------------------------------------------------------------------------------------------------------------

export interface DpiaRow { trigger: string; docs: string[]; approved: boolean }
export interface InventoryParse {
  status: "draft" | "approved" | "unknown";
  not_approved_by_owner: boolean;
  categories: number;
  documented_tables: string[];
  model_providers: { rows: number; unverified: number };
  connectors: { rows: number; unverified: number };
  dpia: DpiaRow[];
}

const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const DOC_PATH = /^docs\/[A-Za-z0-9_./-]{1,120}\.md$/;
const cleanLabel = (text: string): string => text.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * Gjennomgang L4 + H2 N5 (WP-SEC2): DPIA-etiketten (`trigger`, kolonnen «Trigger» i §3) er FRI TEKST fra et dokument og var tidligere en SVARTELISTE (tegnsett, lengde, instruksjonslignende ord): alt som ikke traff et
 * kjent angrepsord slapp gjennom til modellen som elementets etikett. Et dokument kan endres av andre enn eieren (en PR, en kodejobb), så etiketten er ubetrodd data, og en svarteliste mister mot enhver formulering
 * den ikke kjenner. Nå er det en HVITELISTE: kun en ETIKETT SOM ER EKSAKT LIK (etter NFC og sammenslåing av blanke) en av de kjente radene i `docs/security/PROCESSING_INVENTORY.md` §3 (`DPIA_TRIGGER_LABELS`)
 * slipper gjennom, og det som returneres er alltid KONSTANTEN, aldri inndataene. Alt annet gir `DPIA-trigger N` (og `label_filtered: true` i måledata). `scanForSecrets`-sjekken beholdes som ekstra sikring.
 * Driftvakt: `wph2-privacy-doc-reader.test.ts` leser det ekte dokumentet og feller når en rad ikke står i konstanten (og omvendt) - en ny/omdøpt rad i §3 krever en bevisst oppdatering her.
 */
export const DPIA_TRIGGER_LABELS: readonly string[] = [
  "Særlige kategorier (helse)",
  "Lokasjon",
  "Kamera/bilder/syn",
  "Stemme/lydopptak",
  "Kundedata/CRM",
  "Annonse-/analysesporing og attribusjon (produksjonssporing)",
  "Kommunikasjon på tvers av kanaler",
  "Kunnskapskilder (dokumenter, e-postvedlegg)",
  "Ny ekstern behandler uten verifiserte vilkår",
  "Finansdata",
  "Automatiserte beslutninger med rettsvirkning/betydelig effekt",
  "Deling på tvers av memory spaces"
];
const DPIA_LABEL_SET: ReadonlySet<string> = new Set(DPIA_TRIGGER_LABELS);
const normalizeDpiaLabel = (text: string): string => text.normalize("NFC").replace(/\s+/gu, " ").trim();

export function safeDpiaLabel(label: string, index: number): { label: string; filtered: boolean } {
  const text = normalizeDpiaLabel(label);
  const known = DPIA_LABEL_SET.has(text) && scanForSecrets(text).text === text;
  return known ? { label: text, filtered: false } : { label: `DPIA-trigger ${index + 1}`, filtered: text !== "" };
}

/** Radene i en markdown-tabell (uten overskrift og skillelinje), som celler. */
function tableRows(lines: readonly string[]): string[][] {
  const rows: string[][] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows.slice(1); // første rad er overskriften
}

function section(lines: readonly string[], startPattern: RegExp, endPattern: RegExp): string[] {
  const start = lines.findIndex((l) => startPattern.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (endPattern.test(line)) break;
    out.push(line);
  }
  return out;
}

export function parseProcessingInventory(markdown: string): InventoryParse {
  const lines = markdown.split(/\r?\n/);
  const head = lines.slice(0, 16).join(" ");
  const statusMatch = /\*\*Status:\s*([A-ZÆØÅ]+)/.exec(head);
  const status: InventoryParse["status"] = statusMatch === null ? "unknown" : /^UTKAST$/i.test(statusMatch[1] as string) ? "draft" : /^GODKJENT$/i.test(statusMatch[1] as string) ? "approved" : "unknown";
  const tables = new Set<string>();
  for (const line of lines) {
    const m = /^\s*-\s*\*\*Tabeller:\*\*\s*(.+)$/.exec(line);
    if (m === null) continue;
    for (const name of (m[1] as string).matchAll(/`([a-z][a-z0-9_]*)`/g)) if (TABLE_NAME.test(name[1] as string)) tables.add(name[1] as string);
  }
  const part1 = section(lines, /^## 1\./, /^## 2\./);
  const providers = tableRows(section(lines, /^### 2a\./, /^###? /));
  const connectors = tableRows(section(lines, /^### 2b\./, /^###? /));
  const dpiaRows = tableRows(section(lines, /^## 3\./, /^## 4\./));
  return {
    status,
    not_approved_by_owner: /IKKE\s+(juridisk\s+gjennomgått\s+og\s+IKKE\s+)?godkjent/i.test(head),
    categories: part1.filter((l) => /^### /.test(l)).length,
    documented_tables: [...tables].sort(),
    model_providers: { rows: providers.length, unverified: providers.filter((r) => r.some((c) => /IKKE VERIFISERT/.test(c))).length },
    connectors: { rows: connectors.length, unverified: connectors.filter((r) => r.some((c) => /IKKE VERIFISERT/.test(c))).length },
    dpia: dpiaRows.filter((r) => r.length >= 5).map((r) => ({
      trigger: cleanLabel(r[0] as string),
      docs: [...(r[3] as string).matchAll(/`(docs\/[^`]+)`/g)].map((m) => m[1] as string).filter((p) => DOC_PATH.test(p) && !p.includes("..")),
      approved: /^GODKJENT\b/.test((r[4] as string).trim())
    }))
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Dokumentlesing (ubetrodd fil i en montert mappe: ren sti uten symlenker, lstat før open, størrelsesgrense, frist - som backup-status.ts)
// ---------------------------------------------------------------------------------------------------------------------

export type DocRead = { kind: "ok"; text: string } | { kind: "missing" } | { kind: "invalid"; reason: "unreadable" | "too_large" | "timeout" };

/** Gjennomgang L4: første forsinkelse etter en tidsavbrutt lesing (en hengt mount), og taket forsinkelsen dobles opp til. */
export const DOC_BACKOFF_BASE_MS = 30_000;
export const DOC_BACKOFF_MAX_MS = 10 * 60_000;

type PlainPath = { kind: "ok"; size: number; mtimeMs: number; ino: number } | { kind: "missing" } | { kind: "unsafe" };

/**
 * Gjennomgang L4: stien under `root` må bestå av VANLIGE kataloger og en vanlig fil - ingen komponent kan være en symlenke. `lstat` av selve filen og `O_NOFOLLOW` på open() beskytter kun SISTE komponent; en
 * mellomliggende `docs`- eller `docs/security`-symlenke ble tidligere fulgt (en symlenke i en montert mappe kunne peke ut av mappen). Hver prefiks-komponent sjekkes derfor med `lstat` (følger aldri).
 * `root` selv er konfigurasjon (rotkatalogen kan ligge bak en symlenke i deployen) og sjekkes ikke. En komponent som ikke finnes er «missing»; alt annet uvanlig er «unsafe» (behandles som uleselig).
 */
async function plainPath(root: string, rel: string): Promise<PlainPath> {
  const parts = rel.split("/");
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i] as string);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(current);
    } catch (err) {
      return (err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? { kind: "missing" } : { kind: "unsafe" };
    }
    if (st.isSymbolicLink()) return { kind: "unsafe" };
    const last = i === parts.length - 1;
    if (last ? !st.isFile() : !st.isDirectory()) return { kind: "unsafe" };
    if (last) return { kind: "ok", size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
  }
  return { kind: "unsafe" };
}

interface DocCacheEntry { size: number; mtimeMs: number; ino: number; text: string }

async function readPlainFileOnce(root: string, rel: string, maxBytes: number, cache: Map<string, DocCacheEntry>): Promise<DocRead> {
  const key = join(root, rel);
  const found = await plainPath(root, rel);
  if (found.kind === "missing") return { kind: "missing" };
  if (found.kind === "unsafe") return { kind: "invalid", reason: "unreadable" };
  if (found.size > maxBytes) return { kind: "invalid", reason: "too_large" };
  const hit = cache.get(key);
  // Gjennomgang L4: uendret fil (samme mtime, størrelse og inode) leses ikke på nytt - dokumentet parses fra minnet.
  if (hit !== undefined && hit.size === found.size && hit.mtimeMs === found.mtimeMs && hit.ino === found.ino) return { kind: "ok", text: hit.text };
  let handle: FileHandle;
  try {
    handle = await open(key, OPEN_FLAGS);
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? { kind: "missing" } : { kind: "invalid", reason: "unreadable" };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { kind: "invalid", reason: "unreadable" };
    if (st.size > maxBytes) return { kind: "invalid", reason: "too_large" };
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await handle.read(buf, 0, st.size, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    cache.set(key, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, text });
    return { kind: "ok", text };
  } catch {
    return { kind: "invalid", reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface DocReaderOptions {
  maxBytes?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Injiserbar klokke (ms). */
  now?: () => number;
  /** Injiserbar filoperasjon (tester simulerer en hengt mount med en lesing som aldri avsluttes). Standard: `readPlainFileOnce` med en cache på mtime/størrelse/inode. */
  readOnce?: (root: string, rel: string, maxBytes: number) => Promise<DocRead>;
  existsOnce?: (root: string, rel: string) => Promise<boolean | null>;
}

interface GuardState { inflight: boolean; blockedUntil: number; failures: number }

/**
 * Gjennomgang L4: lesing av dokumenter fra en (eventuelt hengt) montert mappe uten å la libuv-tråder hope seg opp. Et filsystemkall som henger KAN ikke avbrytes - `Promise.race` mot en frist (som før) gir en
 * feilmelding etter 5 s, men tråden i libuv sitter fast, og siden oppfriskes hvert minutt: hver bygging la en ny fastsittende tråd i den lille tråd-poolen (standard 4) som API-et også bruker til annen fil-/DNS-aktivitet.
 * Nå gjelder, per fil:
 *  - SINGLE-FLIGHT: mens en lesing ikke har avsluttet (også etter fristen), startes IKKE en ny - kallet får `timeout` uten å røre filsystemet. Maks ÉN hengt operasjon per fil, aldri én per bygging.
 *  - BACKOFF: etter en tidsavbrutt lesing svares `timeout` umiddelbart (ingen filsystemkall) til forsinkelsen (30 s, dobles opp til 10 min) er over; en vellykket lesing nullstiller den.
 *  - CACHE: en uendret fil (mtime, størrelse, inode) leses ikke på nytt (se `readPlainFileOnce`).
 */
export class DocReader {
  private readonly states = new Map<string, GuardState>();
  private readonly cache = new Map<string, DocCacheEntry>();
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly now: () => number;
  private readonly readOnce: (root: string, rel: string, maxBytes: number) => Promise<DocRead>;
  private readonly existsOnce: (root: string, rel: string) => Promise<boolean | null>;

  constructor(options: DocReaderOptions = {}) {
    this.maxBytes = options.maxBytes ?? INVENTORY_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? INVENTORY_READ_TIMEOUT_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? DOC_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DOC_BACKOFF_MAX_MS;
    this.now = options.now ?? Date.now;
    this.readOnce = options.readOnce ?? ((root, rel, maxBytes) => readPlainFileOnce(root, rel, maxBytes, this.cache));
    this.existsOnce = options.existsOnce ?? (async (root, rel) => {
      const found = await plainPath(root, rel);
      return found.kind === "ok" ? true : found.kind === "missing" ? false : null;
    });
  }

  /** Kjører `op` under frist, single-flight og backoff for `key`. `blocked` = ingen filsystemkall ble gjort (hengt operasjon i flukt eller backoff). */
  private async guarded<T>(key: string, op: () => Promise<T>): Promise<{ kind: "done"; value: T } | { kind: "timeout" }> {
    const state = this.states.get(key) ?? { inflight: false, blockedUntil: 0, failures: 0 };
    this.states.set(key, state);
    if (state.inflight || this.now() < state.blockedUntil) return { kind: "timeout" };
    state.inflight = true;
    // `inflight` slippes først når operasjonen FAKTISK har avsluttet (også en som avsluttes lenge etter fristen) - det er det som hindrer en ny fastsittende tråd.
    const work = op().finally(() => { state.inflight = false; });
    work.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => { timer = setTimeout(() => resolve("expired"), this.timeoutMs); });
    try {
      const first = await Promise.race([work.then((value) => ({ value })), expired]);
      if (first === "expired") {
        state.failures += 1;
        state.blockedUntil = this.now() + Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (state.failures - 1));
        return { kind: "timeout" };
      }
      state.failures = 0;
      state.blockedUntil = 0;
      return { kind: "done", value: first.value };
    } finally {
      clearTimeout(timer);
    }
  }

  async read(root: string, rel: string): Promise<DocRead> {
    try {
      const out = await this.guarded(join(root, rel), () => this.readOnce(root, rel, this.maxBytes));
      return out.kind === "timeout" ? { kind: "invalid", reason: "timeout" } : out.value;
    } catch {
      return { kind: "invalid", reason: "unreadable" };
    }
  }

  /** Finnes dokumentet som en vanlig fil (uten symlenker i stien)? `null` = ukjent (hengt mount, uvanlig sti, feil). */
  async exists(root: string, rel: string): Promise<boolean | null> {
    if (!DOC_PATH.test(rel) || rel.includes("..")) return null;
    try {
      const out = await this.guarded(`exists:${join(root, rel)}`, () => this.existsOnce(root, rel));
      return out.kind === "timeout" ? null : out.value;
    } catch {
      return null;
    }
  }
}

/** Standardleseren for api-prosessen: delt tilstand (cache, backoff) på tvers av bygginger - det er poenget. Tester lager egne instanser. */
const defaultDocReader = new DocReader();

// ---------------------------------------------------------------------------------------------------------------------
// Lesere (ekte SQL - bevist som app-rolle i wph2-privacy-center-db.test.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** Navnene på tabellene som finnes i databasen akkurat nå (`public`). Systemkatalogen - ingen rader leses. */
export async function readLiveTables(pool: ControlCenterPool): Promise<string[]> {
  const rows = await globalRows(pool, `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  return rows.map((r) => String(r["tablename"])).filter((n) => TABLE_NAME.test(n));
}

export interface RetentionBacklogRead {
  tool_executions_overdue: number;
  session_grants_overdue: number;
  audit_oldest_at: string | null;
  cost_oldest_at: string | null;
}

export async function readRetentionBacklog(pool: ControlCenterPool, tenantId: string, nowMs: number): Promise<RetentionBacklogRead> {
  const execCut = new Date(nowMs - (TOOL_EXECUTION_RETENTION_DAYS + RETENTION_SLACK_DAYS) * DAY_MS);
  const grantCut = new Date(nowMs - (GRANT_RETENTION_DAYS + RETENTION_SLACK_DAYS) * DAY_MS);
  return tenantRead(pool, tenantId, async (query) => {
    const backlog = (await query(
      `SELECT (SELECT count(*) FROM tool_executions WHERE tenant_id = $1 AND status IN ('succeeded', 'failed') AND executed_at < $2)::int AS tool_executions,
              (SELECT count(*) FROM session_grants WHERE tenant_id = $1 AND (expires_at < $3 OR revoked_at < $3))::int AS session_grants`, [tenantId, execCut, grantCut]
    ))[0] ?? {};
    const oldest = (await query(
      `SELECT (SELECT min(at) FROM audit_events WHERE tenant_id = $1) AS audit_oldest, (SELECT min(at) FROM cost_events WHERE tenant_id = $1) AS cost_oldest`, [tenantId]
    ))[0] ?? {};
    return {
      tool_executions_overdue: toInt(backlog["tool_executions"]), session_grants_overdue: toInt(backlog["session_grants"]),
      audit_oldest_at: toIso(oldest["audit_oldest"]), cost_oldest_at: toIso(oldest["cost_oldest"])
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Senteret
// ---------------------------------------------------------------------------------------------------------------------

export interface PrivacyCenterDeps {
  pool: ControlCenterPool;
  env: Readonly<Record<string, string | undefined>>;
  /** Rotkatalogen som `docs/…` ligger under. Standard: repo-roten utledet fra denne filens plassering (`/app` i api-imaget, der `docs/` ikke finnes). Injiserbar for tester. */
  repoRoot?: string;
  /** Gjennomgang L4: dokumentleseren (cache, single-flight og backoff mot en hengt mount). Standard: den delte leseren for prosessen; injiserbar for tester. */
  docReader?: DocReader;
  /** WP-G3b (D-485): Syn-kortet. Utelatt (standard, og alltid med JARVIS_VISION_ENABLED av) = ingen seksjon og en rapport byte-identisk med main. */
  vision?: PrivacyVisionSource;
}

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export function createPrivacyCenter(deps: PrivacyCenterDeps): ControlCenterDefinition {
  const repoRoot = deps.repoRoot ?? DEFAULT_REPO_ROOT;
  const docReader = deps.docReader ?? defaultDocReader;
  return {
    id: "privacy",
    title_no: "Personvern",
    description_no: "Behandlingsoversikt mot de levende tabellene, DPIA-status, oppbevaring og slettebevis - kun antall og tilstander, aldri personinnhold; det som ikke kan måles står som ikke målt",
    async build(ctx: ControlCenterBuildContext): Promise<ControlCenterParts> {
      const nowMs = ctx.now.getTime();
      const nowIso = ctx.now.toISOString();
      const tenantId = ctx.identity.tenant_id;
      const rel = (iso: string | null | undefined): string => relativeNo(iso, nowMs);
      const failed = (r: Settled<unknown>): string => (r.ok ? "" : ` (${r.category})`);

      const [docR, liveR, jobsR, backlogR, erasureR] = await Promise.all([
        settle(() => docReader.read(repoRoot, INVENTORY_REL)),
        settle(() => readLiveTables(deps.pool)),
        settle(() => readJobs(deps.pool, RETENTION_JOBS.map((j) => j.job))),
        settle(() => readRetentionBacklog(deps.pool, tenantId, nowMs)),
        settle(() => readErasure(deps.pool, tenantId, nowMs))
      ]);
      const doc = docR.ok ? docR.value : null;
      const parsed: InventoryParse | null = doc !== null && doc.kind === "ok" ? parseProcessingInventory(doc.text) : null;
      const docWhy = doc === null ? `kunne ikke leses${failed(docR)}`
        : doc.kind === "missing" ? "dokumentet finnes ikke i denne kjøringen (docs/ følger ikke med api-imaget; monter docs/ skrivebeskyttet for å måle det i drift)"
          : doc.kind === "invalid" ? `dokumentet kunne ikke leses (${doc.reason === "too_large" ? "for stort" : doc.reason === "timeout" ? "tok for lang tid" : "ikke en vanlig fil/uleselig"})` : "";
      const DOC_SOURCE = `${INVENTORY_REL} (D-420; repo-innhold, parset strukturelt - kun tabellnavn, antall rader og statusord)`;
      const sections: ControlSection[] = [];

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 1. Behandlingsoversikt mot de levende tabellene
      // -------------------------------------------------------------------------------------------------------------------------------------------
      {
        const items: ControlItem[] = [];
        if (parsed === null) {
          items.push(controlItem({ id: "inventory_doc", label: "Behandlingsoversikten (dokumentet)", status: "UNKNOWN", detail_no: `IKKE MÅLT: ${docWhy}.`, facts: { measured: false } }));
        } else {
          items.push(controlItem({
            id: "inventory_doc", label: "Behandlingsoversikten (dokumentet)", status: parsed.status === "approved" ? "OK" : parsed.status === "draft" ? "WARN" : "UNKNOWN",
            detail_no: parsed.status === "draft" ? `UTKAST${parsed.not_approved_by_owner ? ", ikke juridisk gjennomgått og ikke godkjent av eier (som dokumentet selv sier)" : ""}; ${parsed.categories} datakategorier, ${parsed.documented_tables.length} dokumenterte tabeller.`
              : parsed.status === "approved" ? `Godkjent (som dokumentet erklærer); ${parsed.categories} datakategorier, ${parsed.documented_tables.length} dokumenterte tabeller.` : "Dokumentets status kunne ikke leses ut av teksten.",
            facts: { status: parsed.status, categories: parsed.categories, documented_tables: parsed.documented_tables.length, not_approved_by_owner: parsed.not_approved_by_owner }
          }));
        }
        if (liveR.ok) {
          const live = liveR.value;
          if (parsed === null) {
            items.push(controlItem({ id: "coverage", label: "Dekning: levende tabeller mot oversikten", status: "UNKNOWN", detail_no: `${live.length} tabeller finnes i databasen, men dekningen kan ikke vurderes uten dokumentet.`, facts: { live_tables: live.length, measured: false } }));
          } else {
            const documented = new Set(parsed.documented_tables);
            const missing = live.filter((t) => !documented.has(t));
            const stale = parsed.documented_tables.filter((t) => !new Set(live).has(t));
            items.push(controlItem({
              id: "coverage", label: "Dekning: levende tabeller mot oversikten", status: missing.length > 0 ? "WARN" : "OK",
              detail_no: missing.length > 0
                ? `${missing.length} av ${live.length} tabeller i databasen står IKKE i behandlingsoversikten: ${missing.slice(0, MAX_LISTED_TABLES).map(safeCategory).join(", ")}${missing.length > MAX_LISTED_TABLES ? ", …" : ""}.`
                : `Alle ${live.length} tabeller i databasen står i behandlingsoversikten.`,
              facts: { live_tables: live.length, undocumented: missing.length, documented_not_in_database: stale.length }
            }));
          }
        } else {
          items.push(controlItem({ id: "coverage", label: "Dekning: levende tabeller mot oversikten", status: "UNKNOWN", detail_no: `Tabelloversikten kunne ikke leses${failed(liveR)}.`, facts: { measured: false } }));
        }
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "inventory", title_no: "Behandlingsoversikt", observed_at: nowIso, items,
          source: `${DOC_SOURCE} + pg_tables (systemkatalogen, ingen rader)`,
          summary_no: `${parsed === null ? "Dokumentdelen er ikke målt." : `Oversikten er ${parsed.status === "draft" ? "et UTKAST" : parsed.status === "approved" ? "godkjent" : "av ukjent status"}.`} ${countsNo(items)}.`
        }));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 2. Behandlere (eksterne mottakere) slik dokumentet erklærer dem
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (parsed === null) {
        sections.push(unknownControlSection("processors", "Eksterne behandlere", DOC_SOURCE, docWhy));
      } else {
        const p = parsed.model_providers;
        const c = parsed.connectors;
        const items: ControlItem[] = [
          controlItem({
            id: "model_providers", label: "Modellleverandører (LLM)", status: p.rows === 0 ? "UNKNOWN" : p.unverified > 0 ? "WARN" : "OK",
            detail_no: p.rows === 0 ? "Ingen rader funnet i dokumentet (ikke målt)." : `${p.unverified} av ${p.rows} rader har vilkår (region, DPA, trening, retensjon) som er IKKE VERIFISERT. Sensitivitetsregelen holder uansett SECRET_RESTRICTED lokalt (D-378).`,
            facts: { rows: p.rows, unverified: p.unverified }
          }),
          controlItem({
            id: "connectors", label: "Connectorer (eierens kontoer)", status: c.rows === 0 ? "UNKNOWN" : c.unverified > 0 ? "WARN" : "OK",
            detail_no: c.rows === 0 ? "Ingen rader funnet i dokumentet (ikke målt)." : `${c.unverified} av ${c.rows} connectorer har vilkår som er IKKE VERIFISERT (krever eier/juridisk handling, Q-32).`,
            facts: { rows: c.rows, unverified: c.unverified }
          })
        ];
        sections.push(controlSection({
          id: "processors", title_no: "Eksterne behandlere", observed_at: nowIso, items, source: `${DOC_SOURCE} (§2a og §2b)`,
          summary_no: `${p.unverified + c.unverified} av ${p.rows + c.rows} behandlerrader har uverifiserte vilkår (slik dokumentet erklærer; ikke en juridisk vurdering). ${countsNo(items)}.`
        }));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 3. DPIA-status (som dokumentet erklærer) og om DPIA-dokumentene finnes
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (parsed === null) {
        sections.push(unknownControlSection("dpia", "DPIA-status", DOC_SOURCE, docWhy));
      } else if (parsed.dpia.length === 0) {
        sections.push(unknownControlSection("dpia", "DPIA-status", DOC_SOURCE, "ingen DPIA-trigger-rader funnet i dokumentet (§3) - ikke målt"));
      } else {
        const existence = await Promise.all(parsed.dpia.map(async (d) => Promise.all(d.docs.map((docPath) => docReader.exists(repoRoot, docPath)))));
        const items: ControlItem[] = parsed.dpia.map((d, index) => {
          const files = existence[index] ?? [];
          const missingFiles = files.filter((e) => e === false).length;
          const unknownFiles = files.filter((e) => e === null).length;
          const status: ControlStatus = missingFiles > 0 ? "WARN" : !d.approved ? "WARN" : unknownFiles > 0 ? "UNKNOWN" : "OK";
          const safe = safeDpiaLabel(d.trigger, index);
          return controlItem({
            id: `dpia:${index + 1}`, label: safe.label, status,
            detail_no: `${d.approved ? "godkjent" : "UTKAST/ikke godkjent"}; ${d.docs.length === 0 ? "ingen DPIA-dokument oppgitt" : `${d.docs.length} DPIA-dokument(er) oppgitt${missingFiles > 0 ? `, ${missingFiles} finnes IKKE` : ""}`}.`,
            facts: { approved: d.approved, documents: d.docs.length, missing_documents: missingFiles, unknown_documents: unknownFiles, label_filtered: safe.filtered }
          });
        });
        items.sort(bySeverityThenLabel);
        const approved = parsed.dpia.filter((d) => d.approved).length;
        sections.push(controlSection({
          id: "dpia", title_no: "DPIA-status", observed_at: nowIso, items, source: `${DOC_SOURCE} (§3 DPIA-trigger-matrisen) + eksistens av de oppgitte DPIA-filene (kun lstat)`,
          summary_no: `${approved} av ${parsed.dpia.length} DPIA-triggere har godkjent DPIA (slik dokumentet erklærer; ingen juridisk verifisering). ${countsNo(items)}.`
        }));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 4. Oppbevaring
      // -------------------------------------------------------------------------------------------------------------------------------------------
      {
        const items: ControlItem[] = [];
        const jobs = jobsR.ok ? new Map(jobsR.value.map((j) => [j.job_name, j])) : null;
        for (const { job, label } of RETENTION_JOBS) {
          if (jobs === null) {
            items.push(controlItem({ id: `job:${job}`, label: `Sveip: ${label}`, status: "UNKNOWN", detail_no: `Kunne ikke leses${failed(jobsR)}.`, facts: { job, measured: false } }));
            continue;
          }
          const st = jobState(jobs.get(job), nowMs);
          items.push(controlItem({ id: `job:${job}`, label: `Sveip: ${label}`, status: st.status, observed_at: st.last_completed_at, detail_no: st.detail_no, facts: { job, last_completed_at: st.last_completed_at, lag_hours: st.lag_hours } }));
        }
        if (backlogR.ok) {
          const b = backlogR.value;
          items.push(controlItem({
            id: "backlog_tool_executions", label: `Verktøyutføringer eldre enn ${TOOL_EXECUTION_RETENTION_DAYS} døgn`, status: b.tool_executions_overdue > 0 ? "WARN" : "OK",
            detail_no: b.tool_executions_overdue > 0 ? `${b.tool_executions_overdue} ferdige rader er eldre enn oppbevaringsgrensen og er ikke slettet - sveipet henger etter eller har ikke kjørt.` : "Ingen ferdige rader står igjen etter oppbevaringsgrensen.",
            facts: { overdue: b.tool_executions_overdue, retention_days: TOOL_EXECUTION_RETENTION_DAYS }
          }));
          items.push(controlItem({
            id: "backlog_session_grants", label: `Utløpte/tilbakekalte sesjons-grants eldre enn ${GRANT_RETENTION_DAYS} døgn`, status: b.session_grants_overdue > 0 ? "WARN" : "OK",
            detail_no: b.session_grants_overdue > 0 ? `${b.session_grants_overdue} grants er eldre enn oppbevaringsgrensen og er ikke slettet.` : "Ingen grants står igjen etter oppbevaringsgrensen.",
            facts: { overdue: b.session_grants_overdue, retention_days: GRANT_RETENTION_DAYS }
          }));
          for (const [id, label, oldest] of [["audit_events", "Revisjonslogg (audit_events)", b.audit_oldest_at], ["cost_events", "Kostnadsledger (cost_events)", b.cost_oldest_at]] as const) {
            const ageDays = oldest === null ? null : Math.floor((nowMs - Date.parse(oldest)) / DAY_MS);
            items.push(controlItem({
              id: `no_auto:${id}`, label: `${label} - ingen automatisk sletting`, status: "WARN", observed_at: oldest,
              detail_no: `Append-only/beholdes: oppbevaringsgrense er en eierbeslutning (ikke satt). Eldste rad ${oldest === null ? "- (ingen rader)" : `${rel(oldest)} (${ageDays} døgn)`}.`,
              facts: { oldest_at: oldest, age_days: ageDays, automatic_deletion: false }
            }));
          }
        } else {
          for (const [id, label] of [["backlog_tool_executions", "Verktøyutføringer"], ["backlog_session_grants", "Sesjons-grants"], ["no_auto:audit_events", "Revisjonslogg"], ["no_auto:cost_events", "Kostnadsledger"]] as const) {
            items.push(controlItem({ id, label: `${label} - oppbevaring`, status: "UNKNOWN", detail_no: `Kunne ikke leses${failed(backlogR)}.`, facts: { measured: false } }));
          }
        }
        items.push(controlItem({
          id: "no_auto:messages_tasks", label: "Samtaler (messages) og jobber (tasks) - ingen automatisk sletting", status: "UNKNOWN",
          detail_no: "Ingen oppbevaringsgrense finnes (eierbeslutning, jf. behandlingsoversikten §4). Alderen på eldste rad er IKKE målt her (en full telling ville vært tung på store tabeller).", facts: { automatic_deletion: false, measured: false }
        }));
        // Miljøverdien er ubetrodd tekst: kun et heltall på 1-4 sifre vises (alt annet regnes som ikke satt).
        const memoryRaw = deps.env["JARVIS_MEMORY_RETENTION_DAYS"];
        const memoryDays = memoryRaw !== undefined && /^\d{1,4}$/.test(memoryRaw.trim()) ? Number(memoryRaw.trim()) : null;
        items.push(controlItem({
          id: "memory_consolidation_days", label: "Minnekonsolidering (episodiske samtaleminner)", status: "OK",
          detail_no: `Gamle episodiske samtaleminner konsolideres til dagssammendrag etter ${memoryDays === null ? "60 (standard)" : memoryDays} døgn (JARVIS_MEMORY_RETENTION_DAYS). Rører aldri preferanser, beslutninger, relasjoner eller semantiske minner.`,
          facts: { configured_days: memoryDays, default_days: 60 }
        }));
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "retention", title_no: "Oppbevaring", observed_at: nowIso, items,
          source: "scheduler_state (retensjonssveipene) + tool_executions + session_grants + audit_events + cost_events (tenant-RLS; kun antall og tidsstempler)",
          summary_no: `${RETENTION_JOBS.length} oppbevaringssveip følges. Revisjon, kostnad, samtaler og jobber har ingen automatisk sletting (eierbeslutning). ${countsNo(items)}.`
        }));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // 5. Slettebevis
      // -------------------------------------------------------------------------------------------------------------------------------------------
      if (erasureR.ok) {
        const v: ErasureRead = erasureR.value;
        const completed = v.by_status.filter((g) => g.status === "completed");
        const completedCount = completed.reduce((a, g) => a + g.n, 0);
        const lastCompleted = completed.map((g) => g.last_completed_at).filter((x): x is string => x !== null).sort().pop() ?? null;
        const items: ControlItem[] = [
          controlItem({
            id: "completed", label: "Fullførte slettinger", status: "OK", observed_at: lastCompleted,
            detail_no: `${completedCount} sletteforespørsler er fullført${lastCompleted ? `, sist ${rel(lastCompleted)}` : ""}.`, facts: { completed: completedCount, last_completed_at: lastCompleted }
          }),
          controlItem({
            id: "failed", label: "Mislykkede slettinger", status: v.failed > 0 ? "FAIL" : "OK",
            detail_no: v.failed > 0 ? `${v.failed} sletteforespørsler FEILET - innholdet er ikke bevist slettet.` : "Ingen mislykkede slettinger.", facts: { failed: v.failed }
          }),
          controlItem({
            id: "pending_stale", label: "Slettinger som står fast", status: v.pending_stale > 0 ? "WARN" : "OK",
            detail_no: v.pending_stale > 0 ? `${v.pending_stale} sletteforespørsler har stått som «pågår» i over en time - sletting er ikke bevist fullført.` : "Ingen slettinger står fast.", facts: { pending_stale: v.pending_stale }
          }),
          controlItem({
            id: "fingerprints", label: "Slettebevis (fingeravtrykk)", status: "OK",
            detail_no: `${v.fingerprints} fingeravtrykk er lagret: de beviser en sletting og hindrer at slettet innhold kommer tilbake ved synk - uten å inneholde selve innholdet.`, facts: { fingerprints: v.fingerprints }
          }),
          controlItem({
            id: "restore_reapply", label: "Gjenanvendelse av slettinger etter restore", status: "UNKNOWN",
            detail_no: "IKKE målt: om reapplyErasuresAfterRestore er kjørt etter siste restore registreres ikke noe sted. Etter en restore må slettinger gjenanvendes før systemet regnes som klart.", facts: { measured: false }
          }),
          controlItem({
            id: "entry_point", label: "Slette-inngang (ErasureService)", status: "WARN",
            detail_no: "Sletting på forespørsel er ikke tilgjengelig som app-rute (JARVIS-060, DEFERRED): bevisene over kommer fra sletteforespørsler som er kjørt utenfor appen.", facts: { wired: false }
          })
        ];
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "deletion_evidence", title_no: "Slettebevis", observed_at: nowIso, items,
          source: "erasure_requests + erasure_fingerprints (tenant-RLS; omfang og antall, aldri innhold) - samme leser som Minne-senteret",
          summary_no: `${completedCount} fullførte slettinger, ${v.failed} mislykkede, ${v.fingerprints} slettebevis. ${countsNo(items)}.`
        }));
      } else {
        sections.push(unknownControlSection("deletion_evidence", "Slettebevis", "erasure_requests + erasure_fingerprints (tenant-RLS)", `kunne ikke leses${failed(erasureR)}`));
      }

      // WP-G3b (D-485): Syn-kortet SIST og kun når en kilde er koblet inn - uten den er alt over uendret. Bygges aldri-kastende (en feil gir «utilgjengelig», ikke et kastet senter).
      if (deps.vision !== undefined) sections.push(await buildVisionSection({ source: deps.vision, pool: deps.pool, tenantId, nowMs, nowIso }));

      return { sections, actions: [] };
    }
  };
}
