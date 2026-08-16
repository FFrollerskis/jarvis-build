import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { KnowledgeListResult, KnowledgeRecord, KnowledgeSource } from "./source.ts";

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

/**
 * Generell filesystem-kilde - IKKE NAS-spesifikk (§2). En NAS-mount er bare
 * en `rootPath` denne kan lese; ingen egen NAS-domenelogikk noe sted.
 *
 * KRITISK sikkerhetsgrense: leser KUN filer hvis REELLE (symlink-oppløste)
 * sti fortsatt ligger innenfor den allowlistede roten. `path.relative` +
 * `..`-sjekk fanger både `../`-traversal og symlinker som peker ut av roten -
 * ingen fil returneres uten denne verifikasjonen, uansett hvordan stien ble
 * konstruert.
 */
export class FilesystemKnowledgeSource implements KnowledgeSource {
  readonly source_type = "filesystem";
  readonly source_instance_id: string;
  private readonly rootResolved: string;

  constructor(
    private readonly rootPath: string,
    sourceInstanceId?: string,
    private readonly allowedExtensions: ReadonlySet<string> = DEFAULT_TEXT_EXTENSIONS
  ) {
    this.rootResolved = resolve(rootPath);
    this.source_instance_id = sourceInstanceId ?? `fs:${this.rootResolved}`;
  }

  /**
   * Verifiserer at en kandidatsti (etter symlink-oppløsning) faktisk ligger
   * innenfor roten. Kastes PathEscapeError KUN ved et faktisk forsøk på å
   * forlate den allowlistede roten (traversal og symlink-escape behandles
   * identisk - begge kastes samme feiltype). Returnerer `null` (ikke en
   * sikkerhetsfeil) hvis stien rett og slett ikke kan leses.
   */
  private async assertWithinRoot(candidatePath: string): Promise<string | null> {
    let real: string;
    try {
      real = await realpath(candidatePath);
    } catch {
      return null; // finnes ikke/uleselig - ikke en sikkerhetsfeil, bare hopp over
    }
    const rel = relative(this.rootResolved, real);
    if (rel === "") {
      return real; // roten selv
    }
    if (rel.startsWith("..") || rel.split(sep)[0] === "..") {
      throw new PathEscapeError(candidatePath);
    }
    return real;
  }

  /**
   * UA-2 P1A §22: filsystem-kilden hopper aldri over noe med en klassifisert
   * feilårsak i dag (ukjente filtyper filtreres stille, som før) - `skipped`
   * returneres alltid tom. Beholdt i signaturen for kontrakt-konsistens med
   * `KnowledgeListResult`, ikke fordi denne kilden trenger den ennå.
   */
  async list(): Promise<KnowledgeListResult> {
    const records: KnowledgeRecord[] = [];
    await this.walk(this.rootResolved, records);
    return { records, skipped: [] };
  }

  private async walk(dirPath: string, records: KnowledgeRecord[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // uleselig katalog - ikke en sikkerhetsfeil, bare tom liste
    }
    for (const entry of entries) {
      const candidatePath = join(dirPath, entry.name);
      let real: string | null;
      try {
        real = await this.assertWithinRoot(candidatePath);
      } catch (err) {
        if (err instanceof PathEscapeError) {
          continue; // hopp over - ALDRI kast videre og stopp hele scanningen på én ondsinnet symlink
        }
        throw err;
      }
      if (real === null) {
        continue;
      }
      const info = await stat(real);
      if (info.isDirectory()) {
        await this.walk(real, records);
        continue;
      }
      if (!info.isFile()) {
        continue; // sockets/devices/etc - aldri lest
      }
      const ext = extname(entry.name).toLowerCase();
      if (!this.allowedExtensions.has(ext)) {
        continue;
      }
      const content = await readFile(real, "utf8");
      const relPath = relative(this.rootResolved, real).split(sep).join("/");
      records.push({
        source_type: this.source_type,
        source_instance_id: this.source_instance_id,
        external_id: relPath,
        canonical_uri: real,
        title: relPath,
        content,
        content_type: contentTypeFor(ext),
        content_hash: createHash("sha256").update(content).digest("hex"),
        modified_at: info.mtime.toISOString(),
        metadata: { extension: ext, size_bytes: info.size }
      });
    }
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
