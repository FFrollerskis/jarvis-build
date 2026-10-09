import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { MemorySpaceSchema, type MemorySpace } from "@jarvis/contracts";
import { KNOWLEDGE_SOURCE_KINDS, type KnowledgeSourceKind } from "@jarvis/tool-gateway";
import { DRIVE_PRODUCTION_PACING, type GoogleDriveSourceOptions } from "./drive-source.ts";
import { DEFAULT_TEXT_EXTENSIONS, type WalkLimits } from "./filesystem-source.ts";
import type { KnowledgeSourceConfig } from "./registry.ts";
import { InvalidSourcePolicyError, resolveSourcePolicy, type KnowledgeSourcePolicy } from "./source-policy.ts";
import { KNOWLEDGE_SENSITIVITIES, KNOWLEDGE_TRUST_LEVELS } from "./sensitivity.ts";
import type { TranscriptFormat } from "./transcript-parse.ts";

/**
 * WP-D1 (UA-2, JARVIS-032): den DEKLARATIVE kildekonfigurasjonen (`JARVIS_KNOWLEDGE_SOURCES`). Eieren oppgir hvilke kilder kunnskapslaget skal lese; ingenting registreres uten en eksplisitt oppføring
 * (ingen implisitt kilde, ingen standardrot, ingen kilde «arvet» fra en annen). Parseren er REN (ingen miljøvariabler, ingen filsystem, ingen nettverk): alt den trenger kommer inn som `context`.
 *
 * FEIL LUKKET OG HØYLYTT: all feil i konfigurasjonen (ugyldig JSON, ukjent felt, ukjent kildetype, manglende påkrevd felt, ugyldig verdi, duplikat-id, sti utenfor allowlisten, repo utenfor låsen ...) kaster
 * `KnowledgeSourcesConfigError` med ALLE problemene, og INGEN av kildene tas i bruk - aldri en delvis konfigurasjon (en kilde som stille mangler ville se ut som «ikke noe nytt der» og kunne få dokumenter til å se
 * slettet ut). Feilmeldingene nevner felt og årsak, aldri verdier.
 *
 * SIKKERHETSGRENSER (alle håndhevet i kode):
 *  - tenant kommer ALDRI fra konfigurasjonen (kun fra `context.tenant_id`), og rommet må være et kjent `MemorySpace`;
 *  - filsystem-baserte kilder (filsystem, Obsidian, møtetranskripter) må ha en ABSOLUTT, normalisert rot (ingen `..`) INNENFOR en eksplisitt allowlistet basismappe (`JARVIS_KNOWLEDGE_FS_ROOTS`; tom = ingen
 *    filsystemkilder), og aldri i systemkataloger eller hemmelighetskataloger (`.ssh`, `.aws` ...). Den sanne (symlink-oppløste) roten sjekkes mot allowlisten rett før hver synk (`verifyFilesystemRoot`);
 *  - GitHub er skrivebeskyttet og låst til `JARVIS_GITHUB_REPO` (samme lås som modellens GitHub-verktøy, `github-repo-lock.ts`) med mindre eieren selv har åpnet for andre repo;
 *  - Google Drive krever en eksplisitt mappe (`folder_id`) eller et BEVISST valg av hele disken (`whole_drive: true`) - aldri en stille standard;
 *  - sensitivitet: `default_sensitivity` er GULVET, `max_sensitivity` TAKET (se `source-policy.ts`); standard er privat (`sensitive`), ingen tak, ubetrodd.
 */
export class KnowledgeSourcesConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`knowledge_sources_config_rejected: ${problems.length} problem(er)`);
    this.name = "KnowledgeSourcesConfigError";
  }
}

export interface ConfiguredKnowledgeSource {
  /** Kildens id (`source_instance_id`). Endres den etter første synk, blir de gamle dokumentene foreldreløse: fjern kilden (erasure) og opprett den på nytt. */
  id: string;
  kind: KnowledgeSourceKind;
  memory_space: MemorySpace;
  config: KnowledgeSourceConfig;
  policy: KnowledgeSourcePolicy;
  /** Oppbevaringsfrist i dager (indeksering + fysisk fjerning); `undefined` = ingen frist. */
  retention_days: number | undefined;
  sync_interval_minutes: number;
}

export interface KnowledgeSourcesParseContext {
  /** Eierens tenant. Konfigurasjonen kan aldri oppgi en annen. */
  tenant_id: string;
  /** Allowlistede basismapper for filsystem-baserte kilder (`parseFilesystemRoots`). Tom = ingen filsystemkilder tillatt. */
  fs_roots: readonly string[];
  /** Google-kontoen Drive-/e-postkilder autentiserer som (kun dokumenterende; selve påloggingen går via vaulten). */
  google_account: string;
  /** Repoet GitHub-kilder er låst til (`configuredGithubRepo`). */
  github_repo: string;
  /** `true` når eieren har åpnet for andre repo (`JARVIS_GITHUB_ALLOW_OTHER_REPOS`). */
  github_unlocked: boolean;
  /** (rom, id) som allerede er opptatt av statisk kode (f.eks. `email:inbox`) og ikke kan gjenbrukes. */
  reserved?: ReadonlyArray<{ memory_space: MemorySpace; id: string }>;
}

export const SOURCES_CONFIG_LIMITS = {
  maxJsonChars: 64 * 1024,
  maxSources: 20,
  defaultIntervalMinutes: 360,
  minIntervalMinutes: 15,
  maxIntervalMinutes: 10_080,
  maxRetentionDays: 3650
} as const;

const SOURCE_ID = /^[a-z0-9][a-z0-9._:-]{0,62}$/;
const DRIVE_FOLDER_ID = /^[A-Za-z0-9_-]{10,100}$/;
const GITHUB_SLUG = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const FORMATS: readonly TranscriptFormat[] = ["txt", "vtt", "srt", "json"];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Stier
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Systemkataloger som aldri kan være (eller inneholde) en kunnskapsrot. Basismapper som er IDENTISKE med eller et FORFEDER til en av dem avvises også. */
const FORBIDDEN_PATHS: readonly string[] = [
  "/", "/etc", "/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/root", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/usr", "/var/lib/docker", "/var/lib/postgresql"
];
/** Kataloger som typisk inneholder hemmeligheter/nøkler: forbudt som et hvilket som helst ledd i en rot. */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker", ".config", ".password-store"]);

/** `candidate` er `base` selv eller ligger under den (sammenligner stiledd, ikke tekstprefiks: `/kunnskap-evil` er IKKE under `/kunnskap`). */
export function isPathInside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  if (rel === "") return true;
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

function pathProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1000) return "must be a non-empty string";
  if (raw.includes("\u0000")) return "contains NUL";
  if (!isAbsolute(raw)) return "must be absolute";
  if (raw.split(/[\\/]/).includes("..")) return "must not contain '..'";
  if (normalize(raw) !== raw) return "must be normalized";
  const trimmed = raw.length > 1 && raw.endsWith(sep) ? raw.slice(0, -1) : raw;
  if (trimmed.split(sep).some((segment) => FORBIDDEN_SEGMENTS.has(segment))) return "points into a secrets directory";
  if (FORBIDDEN_PATHS.some((forbidden) => forbidden !== "/" && isPathInside(forbidden, trimmed))) return "points into a system directory";
  return null;
}

/**
 * `JARVIS_KNOWLEDGE_FS_ROOTS`: kommaseparert liste med ABSOLUTTE basismapper. Ugyldig liste = KnowledgeSourcesConfigError (ingen delvis liste). Utelatt/tom = ingen basismapper (filsystemkilder avvises).
 * En basemappe kan ikke være `/`, en systemkatalog eller et forfedre til en systemkatalog.
 */
export function parseFilesystemRoots(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const problems: string[] = [];
  const roots: string[] = [];
  for (const [i, part] of raw.split(",").map((p) => p.trim()).entries()) {
    if (part === "") {
      problems.push(`fs_roots[${i}]: empty entry`);
      continue;
    }
    const problem = pathProblem(part);
    const trimmed = part.length > 1 && part.endsWith(sep) ? part.slice(0, -1) : part;
    if (problem !== null) problems.push(`fs_roots[${i}]: ${problem}`);
    else if (FORBIDDEN_PATHS.some((forbidden) => isPathInside(trimmed, forbidden))) problems.push(`fs_roots[${i}]: is a system directory or one of its ancestors`);
    else roots.push(trimmed);
  }
  if (problems.length > 0) throw new KnowledgeSourcesConfigError(problems);
  return [...new Set(roots)];
}

/**
 * Kjøres rett FØR hver synk av en filsystem-basert kilde: den SANNE (symlink-oppløste) roten må ligge innenfor en SANN allowlistet basemappe. Fanger en rot som er (eller er blitt) en symlink ut av
 * allowlisten. `null` = OK; ellers en kort årsak (kilden synkes da ikke, og ingenting tombstones).
 */
export async function verifyFilesystemRoot(rootPath: string, bases: readonly string[]): Promise<string | null> {
  if (bases.length === 0) return "no_allowlisted_roots";
  let real: string;
  try {
    real = await realpath(rootPath);
  } catch {
    return "root_unreadable";
  }
  for (const base of bases) {
    try {
      if (isPathInside(await realpath(base), real)) return null;
    } catch {
      // en basemappe som ikke finnes (NAS-montering nede) kan ikke godkjenne noe
    }
  }
  return "root_outside_allowlist";
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const safeKey = (key: string): string => (/^[A-Za-z0-9_.-]{1,40}$/.test(key) ? key : "<invalid key>");

const COMMON_KEYS = ["id", "kind", "memory_space", "enabled", "default_sensitivity", "max_sensitivity", "trust", "retention_days", "sync_interval_minutes"] as const;
const LIMIT_KEYS = ["max_files", "max_file_bytes", "max_depth"] as const;
const KIND_KEYS: Readonly<Record<KnowledgeSourceKind, readonly string[]>> = {
  drive: ["folder_id", "whole_drive", "sheets", "max_sheet_rows", "max_sheet_columns", "max_sheets_per_file"],
  obsidian: ["path", ...LIMIT_KEYS],
  filesystem: ["path", "extensions", ...LIMIT_KEYS],
  github: ["repo"],
  email_attachment: ["max", "query"],
  meeting_transcript: ["path", "formats", ...LIMIT_KEYS]
};

function intField(raw: Raw, key: string, min: number, max: number, problems: string[], at: string): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    problems.push(`${at}.${key}: must be an integer in ${min}..${max}`);
    return undefined;
  }
  return value;
}

function walkLimits(raw: Raw, problems: string[], at: string): Partial<WalkLimits> | undefined {
  const maxFiles = intField(raw, "max_files", 1, 100_000, problems, at);
  const maxFileBytes = intField(raw, "max_file_bytes", 1024, 20 * 1024 * 1024, problems, at);
  const maxDepth = intField(raw, "max_depth", 1, 64, problems, at);
  const limits: Partial<WalkLimits> = { ...(maxFiles !== undefined ? { maxFiles } : {}), ...(maxFileBytes !== undefined ? { maxFileBytes } : {}), ...(maxDepth !== undefined ? { maxDepth } : {}) };
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function enumField<T extends string>(raw: Raw, key: string, allowed: readonly T[], problems: string[], at: string): T | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    problems.push(`${at}.${key}: must be one of ${allowed.join("|")}`);
    return undefined;
  }
  return value as T;
}

function fsRoot(raw: Raw, context: KnowledgeSourcesParseContext, problems: string[], at: string): string | undefined {
  const value = raw["path"];
  const problem = pathProblem(value);
  if (problem !== null) {
    problems.push(`${at}.path: ${problem}`);
    return undefined;
  }
  const trimmed = (value as string).length > 1 && (value as string).endsWith(sep) ? (value as string).slice(0, -1) : (value as string);
  if (context.fs_roots.length === 0) {
    problems.push(`${at}.path: no allowlisted base directory is configured (JARVIS_KNOWLEDGE_FS_ROOTS)`);
    return undefined;
  }
  if (!context.fs_roots.some((base) => isPathInside(base, trimmed))) {
    problems.push(`${at}.path: is outside every allowlisted base directory`);
    return undefined;
  }
  return trimmed;
}

/** Parser ÉN kildeoppføring. Legger alle problemer i `problems`; returnerer `undefined` når oppføringen ikke er gyldig (eller er avslått med `enabled: false`). */
function parseOne(raw: unknown, index: number, context: KnowledgeSourcesParseContext, problems: string[]): ConfiguredKnowledgeSource | undefined {
  const at = `sources[${index}]`;
  const before = problems.length;
  if (!isRecord(raw)) {
    problems.push(`${at}: must be an object`);
    return undefined;
  }
  const kind = enumField(raw, "kind", KNOWLEDGE_SOURCE_KINDS, problems, at);
  if (kind === undefined && raw["kind"] === undefined) problems.push(`${at}.kind: required`);
  const allowedKeys = new Set<string>([...COMMON_KEYS, ...(kind !== undefined ? KIND_KEYS[kind] : [])]);
  for (const key of Object.keys(raw)) if (!allowedKeys.has(key)) problems.push(`${at}: unknown key '${safeKey(key)}'${kind === undefined ? "" : ` for kind ${kind}`}`);

  const id = raw["id"];
  if (typeof id !== "string" || !SOURCE_ID.test(id)) problems.push(`${at}.id: must match ${SOURCE_ID.source}`);
  const spaceParsed = MemorySpaceSchema.safeParse(raw["memory_space"]);
  if (!spaceParsed.success) problems.push(`${at}.memory_space: required, must be a known memory space`);
  if (raw["enabled"] !== undefined && typeof raw["enabled"] !== "boolean") problems.push(`${at}.enabled: must be boolean`);

  const defaultSensitivity = enumField(raw, "default_sensitivity", KNOWLEDGE_SENSITIVITIES, problems, at);
  const maxSensitivity = enumField(raw, "max_sensitivity", KNOWLEDGE_SENSITIVITIES, problems, at);
  const trust = enumField(raw, "trust", KNOWLEDGE_TRUST_LEVELS, problems, at);
  const retentionDays = intField(raw, "retention_days", 1, SOURCES_CONFIG_LIMITS.maxRetentionDays, problems, at);
  const interval = intField(raw, "sync_interval_minutes", SOURCES_CONFIG_LIMITS.minIntervalMinutes, SOURCES_CONFIG_LIMITS.maxIntervalMinutes, problems, at);
  const policy: KnowledgeSourcePolicy = {
    ...(defaultSensitivity !== undefined ? { default_sensitivity: defaultSensitivity } : {}),
    ...(maxSensitivity !== undefined ? { max_sensitivity: maxSensitivity } : {}),
    ...(trust !== undefined ? { trust } : {})
  };
  try {
    resolveSourcePolicy(policy);
  } catch (err) {
    if (err instanceof InvalidSourcePolicyError) problems.push(`${at}: ${err.reason}`);
    else throw err;
  }

  const tenant_id = context.tenant_id;
  const memory_space_id = spaceParsed.success ? spaceParsed.data : undefined;
  let config: KnowledgeSourceConfig | undefined;
  if (kind !== undefined && memory_space_id !== undefined && typeof id === "string") {
    const base = { tenant_id, memory_space_id, source_instance_id: id };
    switch (kind) {
      case "drive": {
        const folderId = raw["folder_id"];
        const wholeDrive = raw["whole_drive"];
        if (wholeDrive !== undefined && wholeDrive !== true) problems.push(`${at}.whole_drive: may only be true (a deliberate choice) - omit it to use folder_id`);
        if (wholeDrive === true && folderId !== undefined) problems.push(`${at}: folder_id and whole_drive are mutually exclusive`);
        if (wholeDrive !== true && (typeof folderId !== "string" || !DRIVE_FOLDER_ID.test(folderId))) problems.push(`${at}.folder_id: required (or whole_drive: true), must be a Drive folder id`);
        const sheets = enumField(raw, "sheets", ["first", "all"] as const, problems, at);
        const maxRows = intField(raw, "max_sheet_rows", 1, 20_000, problems, at);
        const maxColumns = intField(raw, "max_sheet_columns", 1, 200, problems, at);
        const maxSheets = intField(raw, "max_sheets_per_file", 1, 100, problems, at);
        const options: GoogleDriveSourceOptions = {
          // Produksjonskilden følger Drive-begrenserens takt (se `DRIVE_PRODUCTION_PACING`); klassens egen standard er ingen pause.
          ...DRIVE_PRODUCTION_PACING,
          ...(sheets !== undefined ? { sheets } : {}), ...(maxRows !== undefined ? { max_sheet_rows: maxRows } : {}),
          ...(maxColumns !== undefined ? { max_sheet_columns: maxColumns } : {}), ...(maxSheets !== undefined ? { max_sheets_per_file: maxSheets } : {})
        };
        if (problems.length === before) {
          config = {
            source_type: "google_drive", ...base, account: context.google_account, options,
            scope: wholeDrive === true ? { kind: "whole_drive" } : { kind: "folder", folder_id: folderId as string }
          };
        }
        break;
      }
      case "obsidian": {
        const root = fsRoot(raw, context, problems, at);
        const limits = walkLimits(raw, problems, at);
        if (problems.length === before && root !== undefined) config = { source_type: "obsidian", ...base, vault_root: root, ...(limits ? { limits } : {}) };
        break;
      }
      case "filesystem": {
        const root = fsRoot(raw, context, problems, at);
        const limits = walkLimits(raw, problems, at);
        let extensions: ReadonlySet<string> | undefined;
        const rawExt = raw["extensions"];
        if (rawExt !== undefined) {
          if (!Array.isArray(rawExt) || rawExt.length === 0 || rawExt.length > 20 || !rawExt.every((e) => typeof e === "string" && DEFAULT_TEXT_EXTENSIONS.has(e))) {
            problems.push(`${at}.extensions: must be a non-empty list of text extensions (${[...DEFAULT_TEXT_EXTENSIONS].join(" ")})`);
          } else {
            extensions = new Set(rawExt as string[]);
          }
        }
        if (problems.length === before && root !== undefined) {
          config = { source_type: "filesystem", ...base, root_path: root, ...(extensions ? { allowed_extensions: extensions } : {}), ...(limits ? { limits } : {}) };
        }
        break;
      }
      case "meeting_transcript": {
        const root = fsRoot(raw, context, problems, at);
        const limits = walkLimits(raw, problems, at);
        let formats: TranscriptFormat[] | undefined;
        const rawFormats = raw["formats"];
        if (rawFormats !== undefined) {
          if (!Array.isArray(rawFormats) || rawFormats.length === 0 || !rawFormats.every((f) => typeof f === "string" && (FORMATS as readonly string[]).includes(f))) {
            problems.push(`${at}.formats: must be a non-empty list of ${FORMATS.join("|")}`);
          } else {
            formats = [...new Set(rawFormats as TranscriptFormat[])];
          }
        }
        if (problems.length === before && root !== undefined) {
          config = { source_type: "meeting_transcript", ...base, root_path: root, ...(formats ? { formats } : {}), ...(limits ? { limits } : {}) };
        }
        break;
      }
      case "github": {
        const repo = raw["repo"];
        if (typeof repo !== "string" || !GITHUB_SLUG.test(repo)) {
          problems.push(`${at}.repo: required, must be owner/name`);
        } else if (!context.github_unlocked && repo.toLowerCase() !== context.github_repo.toLowerCase()) {
          problems.push(`${at}.repo: is locked to JARVIS_GITHUB_REPO (open other repos with JARVIS_GITHUB_ALLOW_OTHER_REPOS=true)`);
        } else if (problems.length === before) {
          config = { source_type: "github", ...base, repo };
        }
        break;
      }
      case "email_attachment": {
        const max = intField(raw, "max", 1, 100, problems, at);
        const query = raw["query"];
        // eslint-disable-next-line no-control-regex -- kontrolltegn i en søkespørring avvises bevisst
        if (query !== undefined && (typeof query !== "string" || query.length === 0 || query.length > 200 || /[\u0000-\u001f\u007f]/.test(query))) problems.push(`${at}.query: must be a short single-line string`);
        if (problems.length === before) {
          config = { source_type: "email_attachment", ...base, account: context.google_account, ...(max !== undefined ? { max } : {}), ...(typeof query === "string" ? { query } : {}) };
        }
        break;
      }
    }
  }
  if (problems.length > before || config === undefined || kind === undefined || memory_space_id === undefined || typeof id !== "string") return undefined;
  if (raw["enabled"] === false) return undefined;
  return { id, kind, memory_space: memory_space_id, config, policy, retention_days: retentionDays, sync_interval_minutes: interval ?? SOURCES_CONFIG_LIMITS.defaultIntervalMinutes };
}

/**
 * Parser `JARVIS_KNOWLEDGE_SOURCES` (en JSON-liste). Kaster `KnowledgeSourcesConfigError` med alle problemene hvis NOE er galt (aldri en delvis liste). En avslått oppføring (`enabled: false`) valideres
 * som alle andre, men tas ikke med. Tom/utelatt streng = ingen kilder (dvalemodus), ikke en feil.
 */
export function parseKnowledgeSources(raw: string | undefined, context: KnowledgeSourcesParseContext): ConfiguredKnowledgeSource[] {
  if (raw === undefined || raw.trim() === "") return [];
  if (raw.length > SOURCES_CONFIG_LIMITS.maxJsonChars) throw new KnowledgeSourcesConfigError([`config: larger than ${SOURCES_CONFIG_LIMITS.maxJsonChars} characters`]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KnowledgeSourcesConfigError(["config: not valid JSON"]);
  }
  if (!Array.isArray(parsed)) throw new KnowledgeSourcesConfigError(["config: must be a JSON array of source objects"]);
  if (parsed.length > SOURCES_CONFIG_LIMITS.maxSources) throw new KnowledgeSourcesConfigError([`config: more than ${SOURCES_CONFIG_LIMITS.maxSources} sources`]);
  const problems: string[] = [];
  const sources: ConfiguredKnowledgeSource[] = [];
  const seen = new Set<string>((context.reserved ?? []).map((r) => `${r.memory_space}\u0000${r.id}`));
  parsed.forEach((entry, index) => {
    // Duplikat-id (samme rom): sjekkes på de rå feltene, også for avslåtte og ugyldige oppføringer, så en feil ikke gjemmer seg bak en annen.
    if (isRecord(entry) && typeof entry["id"] === "string" && typeof entry["memory_space"] === "string") {
      const key = `${entry["memory_space"]}\u0000${entry["id"]}`;
      if (seen.has(key)) problems.push(`sources[${index}].id: duplicate or reserved id in this memory space`);
      seen.add(key);
    }
    const source = parseOne(entry, index, context, problems);
    if (source !== undefined) sources.push(source);
  });
  if (problems.length > 0) throw new KnowledgeSourcesConfigError(problems);
  return sources;
}
