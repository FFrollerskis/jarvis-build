import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { ZodType } from "zod";
import { parseEvidenceFacts, type EvidenceFacts } from "./evidence-header.ts";
import type { Finding } from "./findings.ts";
import { GateSchema, OrlSchema, type Gate, type Orl } from "./gates.ts";
import { normalizeLineEndings, sha256Hex } from "./hash.ts";
import { LOG_D_REF, REPO_PATH } from "./ids.ts";
import { BaselineSchema, ComponentShardSchema, ManifestSchema, type Baseline, type ComponentShard, type Manifest } from "./schema.ts";
import type { RepoFacts, WorkspacePackage } from "./scan.ts";
import { parseMigrationSet } from "./sql-schema.ts";

/**
 * WP-PGA / PG1: den ENESTE modulen i programindeksen som rører filsystemet (lesing; skriving skjer kun i `fingerprint-tool.ts`). Leser `config/program/**` (sharda data) og fakta om repoet
 * (migrasjoner, kataloger, compose, kontraktfiler) til `RepoFacts`. Ikke eksportert fra `@jarvis/contracts`-barrelen (BUILT_UNWIRED).
 *
 * Sikkerhet: kun VANLIGE filer leses (aldri symlenker), JSON-filer har tak på 1 MB og hashede filer på 8 MB, og alle stier fra dataene må være repo-relative (REPO_PATH) før de brukes.
 * En fil som ikke er gyldig data gir et FUNN (`data_invalid`/`stray_file`), aldri en stille hopp; kun et ugyldig manifest eller en ugyldig baseline stopper hele kjøringen (kaster).
 */
export const LOAD_RULES = ["data_invalid", "stray_file", "shard_filename_mismatch"] as const;
export type LoadRule = (typeof LOAD_RULES)[number];

export class ProgramDataError extends Error {
  constructor(readonly code: "manifest_invalid" | "baseline_invalid", readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ProgramDataError";
  }
}

const MAX_JSON_BYTES = 1_000_000;
const MAX_HASH_BYTES = 8_000_000;
export const PROGRAM_DIR = "config/program";

type JsonRead = { ok: true; value: unknown } | { ok: false; reason: string };

/** Leser en JSON-fil trygt: vanlig fil, innenfor størrelsestaket, gyldig JSON. */
function readJsonFile(abs: string): JsonRead {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return { ok: false, reason: "symlenker er ikke tillatt" };
    if (!st.isFile()) return { ok: false, reason: "ikke en vanlig fil" };
    if (st.size > MAX_JSON_BYTES) return { ok: false, reason: `filen er over ${MAX_JSON_BYTES} byte` };
    return { ok: true, value: JSON.parse(readFileSync(abs, "utf8")) as unknown };
  } catch (err) {
    return { ok: false, reason: err instanceof SyntaxError ? "ugyldig JSON" : "kunne ikke leses" };
  }
}

const issueText = (error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "(rot)"}: ${i.message}`)
    .join("; ");

export interface ProgramData {
  manifest: Manifest;
  baseline: Baseline;
  components: ComponentShard[];
  gates: Gate[];
  orls: Orl[];
  /** Funn fra selve lastingen (ugyldige filer, løse filer, feil filnavn). */
  findings: Finding[];
}

function loadDirectory<T>(root: string, sub: string, schema: ZodType<T>, idOf: (value: T) => string, findings: Finding[]): T[] {
  const relDir = `${PROGRAM_DIR}/${sub}`;
  const absDir = join(root, relDir);
  const out: T[] = [];
  const addFinding = (rule: LoadRule, subject: string, message: string): void => {
    findings.push({ rule, component_id: null, subject, id: `${rule}:${subject}`, message });
  };
  let entries: string[];
  try {
    entries = readdirSync(absDir).sort();
  } catch {
    addFinding("data_invalid", relDir, `mappen ${relDir} mangler eller kan ikke leses`);
    return out;
  }
  for (const name of entries) {
    const rel = `${relDir}/${name}`;
    const abs = join(absDir, name);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      addFinding("data_invalid", rel, "kunne ikke leses");
      continue;
    }
    if (!st.isFile() || !name.endsWith(".json")) {
      addFinding("stray_file", rel, st.isSymbolicLink() ? "symlenker er ikke tillatt i dataene" : "kun vanlige .json-filer hører hjemme her (løse filer, mapper og symlenker avvises)");
      continue;
    }
    const read = readJsonFile(abs);
    if (!read.ok) {
      addFinding("data_invalid", rel, read.reason);
      continue;
    }
    const parsed = schema.safeParse(read.value);
    if (!parsed.success) {
      addFinding("data_invalid", rel, issueText(parsed.error));
      continue;
    }
    const id = idOf(parsed.data);
    if (`${id}.json` !== name) {
      addFinding("shard_filename_mismatch", rel, `filnavnet skal være ${id}.json`);
      continue;
    }
    out.push(parsed.data);
  }
  return out;
}

/** Leser manifest, baseline og alle skjerver/porter/nivåer. Kaster `ProgramDataError` ved ugyldig manifest/baseline; alt annet blir funn. */
export function loadProgramData(root: string): ProgramData {
  const manifestRead = readJsonFile(join(root, PROGRAM_DIR, "manifest.json"));
  if (!manifestRead.ok) throw new ProgramDataError("manifest_invalid", manifestRead.reason);
  const manifest = ManifestSchema.safeParse(manifestRead.value);
  if (!manifest.success) throw new ProgramDataError("manifest_invalid", issueText(manifest.error));
  const baselineRead = readJsonFile(join(root, PROGRAM_DIR, "baseline.json"));
  if (!baselineRead.ok) throw new ProgramDataError("baseline_invalid", baselineRead.reason);
  const baseline = BaselineSchema.safeParse(baselineRead.value);
  if (!baseline.success) throw new ProgramDataError("baseline_invalid", issueText(baseline.error));
  const findings: Finding[] = [];
  const components = loadDirectory(root, "components", ComponentShardSchema, (c) => c.component_id, findings);
  const gates = loadDirectory(root, "gates", GateSchema, (g) => g.id, findings);
  const orls = loadDirectory(root, "orl", OrlSchema, (o) => o.id, findings);
  return { manifest: manifest.data, baseline: baseline.data, components, gates, orls, findings };
}

/** Compose-tjenestene: nøklene rett under `services:` (to blanke innrykk). Kommentarer og andre toppnøkler (x-*, volumes) leses ikke. */
export function parseComposeServiceNames(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^services:\s*(?:#.*)?$/.test(l));
  if (start === -1) return [];
  const names: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (/^\S/.test(line) && !line.startsWith("#")) break;
    const m = /^ {2}([A-Za-z0-9_.-]+):\s*(?:#.*)?$/.exec(line);
    if (m !== null) names.push(m[1] as string);
  }
  return names;
}

const listDirs = (abs: string): string[] => {
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
};

const readPackage = (abs: string, dir: string): WorkspacePackage | null => {
  const read = readJsonFile(join(abs, "package.json"));
  if (!read.ok || typeof read.value !== "object" || read.value === null) return null;
  const pkg = read.value as { name?: unknown; dependencies?: unknown };
  const deps = typeof pkg.dependencies === "object" && pkg.dependencies !== null ? (pkg.dependencies as Record<string, unknown>) : {};
  return {
    dir,
    name: typeof pkg.name === "string" ? pkg.name : null,
    workspace_deps: Object.entries(deps)
      .filter(([, v]) => typeof v === "string" && v.startsWith("workspace:"))
      .map(([k]) => k)
      .sort()
  };
};

/** Fakta om repoet: migrasjoner (parset), kataloger, compose-tjenester, kontraktfiler, pakker, og hash-/eksistens-/beslutningsoppslag med stibeskyttelse. */
export function collectRepoFacts(root: string, manifest: Manifest): RepoFacts {
  const cov = manifest.coverage;
  const migrationsAbs = join(root, cov.migrations_dir);
  const sqlNames = (() => {
    try {
      return readdirSync(migrationsAbs).filter((n) => n.endsWith(".sql")).sort();
    } catch {
      return [] as string[];
    }
  })();
  const set = parseMigrationSet(sqlNames.map((name) => ({ name, sql: readFileSync(join(migrationsAbs, name), "utf8") })));

  const workspaceDirs = cov.workspace_roots.flatMap((r) => listDirs(join(root, r)).map((n) => `${r}/${n}`));
  const packages = workspaceDirs.flatMap((d) => {
    const p = readPackage(join(root, d), d);
    return p === null ? [] : [p];
  });
  const composeText = (() => {
    try {
      return readFileSync(join(root, cov.compose_file), "utf8");
    } catch {
      return "";
    }
  })();
  const contractFiles = cov.contract_roots.flatMap((r) => {
    try {
      return readdirSync(join(root, r), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts"))
        .map((e) => `${r}/${e.name}`)
        .sort();
    } catch {
      return [] as string[];
    }
  });

  const reader = makeFileReader(root);
  return {
    tables: set.tables,
    created: set.created,
    alters: set.alters,
    duplicates: set.duplicates,
    migration_files: sqlNames,
    workspace_dirs: workspaceDirs,
    compose_services: parseComposeServiceNames(composeText),
    contract_files: contractFiles,
    workspace_packages: packages,
    path_exists: reader.path_exists,
    file_sha256: reader.file_sha256,
    decision_exists: reader.decision_exists
  };
}

/** Evidensens topptekst ligger helt først i filen: 64 kB er mer enn nok (høyst 30 linjer leses), og en stor fil leses ikke i sin helhet bare for å vurdere styrken. */
const HEADER_READ_BYTES = 65_536;

/**
 * Ligger `abs` (etter at ALLE symlenker er fulgt, også mellomkataloger) innenfor repo-roten? `lstat` avviser bare at SELVE filen er en symlenke; en symlenket MELLOMKATALOG (`docs/evidence -> et annet sted`)
 * ville ellers latt oss lese og hashe filer utenfor repoet. En sti som ikke kan løses er utenfor.
 */
export function isInsideRoot(root: string, abs: string): boolean {
  try {
    const r = realpathSync(root);
    const a = realpathSync(abs);
    return a === r || a.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
  } catch {
    return false;
  }
}

export interface FileReader extends Pick<RepoFacts, "path_exists" | "file_sha256" | "decision_exists"> {
  /** Toppteksten i en evidensfil (exit, kommando, tidspunkt, git, merknad); null hvis filen ikke finnes, ikke er en vanlig fil innenfor repoet eller ikke kan leses. */
  evidence_facts: (path: string) => EvidenceFacts | null;
}

/** Eksistens-, hash- og beslutningsoppslag med stibeskyttelse (kun repo-relative stier innenfor repoet; symlenker, symlenkede mellomkataloger og for store filer gir null). */
export function makeFileReader(root: string): FileReader {
  const safe = (p: string): boolean => typeof p === "string" && REPO_PATH.test(p);
  let decisionLog: string | null | undefined;
  const regularInside = (p: string): { abs: string; size: number } | null => {
    if (!safe(p)) return null;
    try {
      const abs = join(root, p);
      const st = lstatSync(abs);
      if (!st.isFile() || st.size > MAX_HASH_BYTES || !isInsideRoot(root, abs)) return null;
      return { abs, size: st.size };
    } catch {
      return null;
    }
  };
  return {
    path_exists: (p) => safe(p) && existsSync(join(root, p)),
    file_sha256: (p) => {
      const f = regularInside(p);
      if (f === null) return null;
      try {
        return sha256Hex(normalizeLineEndings(readFileSync(f.abs, "utf8")));
      } catch {
        return null;
      }
    },
    evidence_facts: (p) => {
      const f = regularInside(p);
      if (f === null) return null;
      try {
        const fd = openSync(f.abs, "r");
        try {
          const buf = Buffer.alloc(Math.min(f.size, HEADER_READ_BYTES));
          const n = readSync(fd, buf, 0, buf.length, 0);
          return parseEvidenceFacts(buf.subarray(0, n).toString("utf8"));
        } finally {
          closeSync(fd);
        }
      } catch {
        return null;
      }
    },
    decision_exists: (id) => {
      if (!LOG_D_REF.test(id)) return false;
      if (decisionLog === undefined) {
        try {
          decisionLog = readFileSync(join(root, "docs/DECISIONS_AND_ASSUMPTIONS.md"), "utf8");
        } catch {
          decisionLog = null;
        }
      }
      return decisionLog !== null && new RegExp(`^\\| ${id} \\|`, "m").test(decisionLog);
    }
  };
}
