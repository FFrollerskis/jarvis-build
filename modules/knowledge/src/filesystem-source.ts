import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { KnowledgeSourceError, type KnowledgeListResult, type KnowledgeRecord, type KnowledgeSource, type SkippedRecord } from "./source.ts";

/**
 * UA-2 P0 §2: tekstbaserte filtyper vi faktisk kan parse deterministisk.
 * Ingen OCR/bilde/PDF-pipeline i P0 (§14 - Bygges IKKE).
 */
export const DEFAULT_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".yaml", ".yml",
  ".ts", ".tsx", ".js", ".jsx", ".py", ".sql", ".html", ".css"
]);

export class PathEscapeError extends Error {
  constructor(attemptedPath: string) {
    super(`path_escapes_allowlisted_root: ${attemptedPath}`);
    this.name = "PathEscapeError";
  }
}

/** WP-D1: harde grenser for en katalogvandring - en enorm fil, en enorm katalog eller en løkke skal aldri gi ubegrenset minne/tid. */
export interface WalkLimits {
  /** Filer større enn dette leses ikke (de hoppes over med `too_large`). */
  maxFileBytes: number;
  /** Maks antall filer (lest + for store) før listingen er avkortet (`truncated`). */
  maxFiles: number;
  /** Maks katalogdybde under roten. */
  maxDepth: number;
}
export const DEFAULT_WALK_LIMITS: WalkLimits = { maxFileBytes: 5 * 1024 * 1024, maxFiles: 20_000, maxDepth: 32 };

export interface WalkedFile {
  /** Sti relativt til roten, med `/` som skilletegn. */
  relPath: string;
  /** Symlink-oppløst absolutt sti (alltid innenfor roten). */
  real: string;
  /** Filendelsen slik den står på oppføringen (små bokstaver, med punktum). */
  ext: string;
  size: number;
  mtime: Date;
}
export interface WalkResult {
  files: WalkedFile[];
  /** Filer over `maxFileBytes` - ikke lest. */
  oversized: WalkedFile[];
  /** `true` når antallsgrensen stoppet vandringen: listingen er ufullstendig og må ikke brukes til å tombstone. */
  truncated: boolean;
  /** Kataloger som ikke kunne leses eller lå under dybdegrensen (relativ sti + `/`): allerede lagrede dokumenter under dem skal ikke tombstones, resten av treet påvirkes ikke. */
  protected_prefixes: string[];
}

/**
 * Felles, sikker katalogvandring for filsystem-baserte kilder (filsystem, Obsidian, møtetranskripter).
 *
 * KRITISK sikkerhetsgrense: leser KUN filer hvis REELLE (symlink-oppløste) sti ligger innenfor den allowlistede roten. `path.relative` + `..`-sjekk fanger både `../`-traversal og symlinker som peker ut av
 * roten - ingen fil returneres uten denne verifikasjonen. WP-D1-tillegg: hver katalog besøkes høyst én gang (symlink-løkker innenfor roten, f.eks. `a/lenke -> ..`, ga før uendelig rekursjon), hver fil
 * listes høyst én gang selv om den nås via flere stier, og dybde/antall/størrelse er begrenset (se `WalkLimits`).
 */
export async function walkAllowlistedFiles(
  rootPath: string,
  allowedExtensions: ReadonlySet<string>,
  limits: Partial<WalkLimits> = {}
): Promise<WalkResult> {
  const { maxFileBytes, maxFiles, maxDepth } = { ...DEFAULT_WALK_LIMITS, ...limits };
  // Selve roten må kunne oppløses og leses: en rot som mangler (f.eks. en NAS-montering som ikke er oppe) er TOTAL svikt, aldri en tom liste som ville tombstonet alt (§5: ingen tombstoning på en feilet listing).
  let rootResolved: string;
  try {
    rootResolved = await realpath(resolve(rootPath));
    if (!(await stat(rootResolved)).isDirectory()) throw new Error("not_a_directory");
  } catch {
    throw new KnowledgeSourceError("SOURCE_UNAVAILABLE", "filesystem_root_unreadable");
  }
  const result: WalkResult = { files: [], oversized: [], truncated: false, protected_prefixes: [] };
  const visitedDirs = new Set<string>();
  const prefixOf = (dir: string): string => `${relative(rootResolved, dir).split(sep).join("/")}/`;
  const seenFiles = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootResolved, depth: 0 }];
  while (queue.length > 0) {
    const next = queue.shift() as { dir: string; depth: number };
    if (visitedDirs.has(next.dir)) continue;
    visitedDirs.add(next.dir);
    if (next.depth > maxDepth) {
      result.protected_prefixes.push(prefixOf(next.dir));
      continue;
    }
    let entries;
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      if (next.depth === 0) throw new KnowledgeSourceError("SOURCE_UNAVAILABLE", "filesystem_root_unreadable");
      result.protected_prefixes.push(prefixOf(next.dir)); // en uleselig undermappe (f.eks. lost+found): ikke bekreftet borte
      continue;
    }
    for (const entry of entries) {
      const real = await realpathWithinRoot(rootResolved, join(next.dir, entry.name));
      if (real === null) continue; // finnes ikke, uleselig eller peker ut av roten - ALDRI stopp hele scanningen på én ondsinnet symlink
      let info;
      try {
        info = await stat(real);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        queue.push({ dir: real, depth: next.depth + 1 });
        continue;
      }
      if (!info.isFile()) continue; // sockets/devices/etc - aldri lest
      const ext = extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;
      const relPath = relative(rootResolved, real).split(sep).join("/");
      if (seenFiles.has(relPath)) continue;
      if (result.files.length + result.oversized.length >= maxFiles) {
        result.truncated = true;
        return result;
      }
      seenFiles.add(relPath);
      const file: WalkedFile = { relPath, real, ext, size: info.size, mtime: info.mtime };
      if (info.size > maxFileBytes) result.oversized.push(file);
      else result.files.push(file);
    }
  }
  return result;
}

/** Symlink-oppløst sti hvis den ligger innenfor roten (eller er roten); `null` ellers (finnes ikke / uleselig / peker ut av roten). */
async function realpathWithinRoot(rootResolved: string, candidatePath: string): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(candidatePath);
  } catch {
    return null;
  }
  const rel = relative(rootResolved, real);
  if (rel === "") return real;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null; // (et filnavn som «..notat.md» er IKKE et utbrudd)
  return real;
}

export interface FilesystemSourceOptions {
  allowedExtensions?: ReadonlySet<string>;
  limits?: Partial<WalkLimits>;
}

/**
 * Leser en fil som er funnet av vandringen. `null` = filen skal hoppes over (vokste forbi grensen siden `stat`, eller har NUL-byte = binærinnhold som Postgres ikke kan lagre som tekst).
 */
export async function readWalkedFile(file: WalkedFile, maxFileBytes: number): Promise<{ text: string } | { skip: "too_large" | "binary_content" | "unreadable" }> {
  let buf: Buffer;
  try {
    buf = await readFile(file.real);
  } catch {
    return { skip: "unreadable" };
  }
  if (buf.length > maxFileBytes) return { skip: "too_large" };
  if (buf.includes(0)) return { skip: "binary_content" };
  return { text: buf.toString("utf8") };
}

/**
 * Generell filesystem-kilde - IKKE NAS-spesifikk (§2). En NAS-mount er bare
 * en `rootPath` denne kan lese; ingen egen NAS-domenelogikk noe sted.
 *
 * Sikkerhetsgrensene (rot-allowlist, traversal/symlink-escape, løkker, størrelse) ligger i `walkAllowlistedFiles`. WP-D1: filer over størrelsesgrensen og binærfiler hoppes over som
 * `UNSUPPORTED_CONTENT` (beskyttet mot tombstoning), og en avkortet vandring gir en `partial` listing (ingenting tombstones på grunnlag av en ufullstendig oversikt).
 */
export class FilesystemKnowledgeSource implements KnowledgeSource {
  readonly source_type = "filesystem";
  readonly source_instance_id: string;
  private readonly rootResolved: string;
  private readonly allowedExtensions: ReadonlySet<string>;
  private readonly limits: WalkLimits;

  constructor(
    private readonly rootPath: string,
    sourceInstanceId?: string,
    allowedExtensionsOrOptions: ReadonlySet<string> | FilesystemSourceOptions = DEFAULT_TEXT_EXTENSIONS
  ) {
    this.rootResolved = resolve(rootPath);
    this.source_instance_id = sourceInstanceId ?? `fs:${this.rootResolved}`;
    const options: FilesystemSourceOptions = allowedExtensionsOrOptions instanceof Set ? { allowedExtensions: allowedExtensionsOrOptions } : (allowedExtensionsOrOptions as FilesystemSourceOptions);
    this.allowedExtensions = options.allowedExtensions ?? DEFAULT_TEXT_EXTENSIONS;
    this.limits = { ...DEFAULT_WALK_LIMITS, ...(options.limits ?? {}) };
  }

  async list(): Promise<KnowledgeListResult> {
    const walk = await walkAllowlistedFiles(this.rootResolved, this.allowedExtensions, this.limits);
    const records: KnowledgeRecord[] = [];
    const skipped: SkippedRecord[] = walk.oversized.map((f) => ({ external_id: f.relPath, reason: "UNSUPPORTED_CONTENT" as const, detail: "too_large" }));
    for (const file of walk.files) {
      const read = await readWalkedFile(file, this.limits.maxFileBytes);
      if ("skip" in read) {
        skipped.push({ external_id: file.relPath, reason: read.skip === "unreadable" ? "SOURCE_UNAVAILABLE" : "UNSUPPORTED_CONTENT", detail: read.skip });
        continue;
      }
      records.push({
        source_type: this.source_type,
        source_instance_id: this.source_instance_id,
        external_id: file.relPath,
        canonical_uri: file.real,
        title: file.relPath,
        content: read.text,
        content_type: contentTypeFor(file.ext),
        content_hash: createHash("sha256").update(read.text).digest("hex"),
        modified_at: file.mtime.toISOString(),
        metadata: { extension: file.ext, size_bytes: file.size }
      });
    }
    return {
      records, skipped,
      ...(walk.truncated ? { listing: "partial" as const } : {}),
      ...(walk.protected_prefixes.length > 0 ? { protected_prefixes: walk.protected_prefixes } : {})
    };
  }
}

function contentTypeFor(ext: string): string {
  switch (ext) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    default:
      return "text/plain";
  }
}
