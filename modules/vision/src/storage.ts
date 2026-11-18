import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * WP-G3 (D-465): `StorageAdapter` (CLAUDE.md regel 3) - lagring av øyeblikksbilder bak en adaptergrense.
 *
 * Domenekoden (snapshots.ts, pipeline.ts) kjenner kun dette grensesnittet; hvor bildebytes faktisk ligger (lokal disk i dag, en
 * annen lokal lagring senere) er en adapterdetalj. Jarvis eier metadataene og livssyklusen (vision_snapshots/-tombstones, 134);
 * adapteren eier KUN bytes under en nøkkel Jarvis har bygget. Kontrakt:
 *   - `put` er trygg å gjenta med samme nøkkel (samme bildeobjekt skrives på nytt; nøkkelen er unik per snapshot-id),
 *   - `delete` er IDEMPOTENT: et objekt som ikke finnes er en vellykket sletting (`existed: false`), så en gjentatt sletting aldri
 *     feiler på noe som allerede er borte. En ekte feil (I/O, tilgang) KASTER - kalleren (reaper) beholder da graven og prøver igjen,
 *   - nøkler valideres her OGSÅ (forsvar i dybden mot den samme CHECK-en som 134 har): ingen `..`, ingen absolutte stier, ingen
 *     bakstreker, ingen tomme segmenter.
 * Bildebytes logges aldri og står aldri i feilmeldinger (kun nøkkelen og en kort kode).
 */
export interface StorageAdapter {
  /** Kort, stabil identifikator lagret i vision_snapshots.storage_backend (`[a-z0-9_]{1,32}`). */
  readonly backend: string;
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** `null` når objektet ikke finnes. `maxBytes` er en lesegrense (objekter over grensen gir `storage_object_too_large`). */
  get(key: string, maxBytes?: number): Promise<Uint8Array | null>;
  delete(key: string): Promise<{ existed: boolean }>;
  exists(key: string): Promise<boolean>;
}

export class StorageKeyError extends Error {
  constructor(readonly reason: string) {
    super(`storage_key_invalid:${reason}`);
    this.name = "StorageKeyError";
  }
}

const SAFE_KEY = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

/** Samme regel som CHECK-en på vision_snapshots.storage_key (134). */
export function assertSafeStorageKey(key: unknown): string {
  if (typeof key !== "string" || !SAFE_KEY.test(key)) throw new StorageKeyError("charset_or_length");
  if (key.includes("..") || key.includes("//") || key.endsWith("/")) throw new StorageKeyError("path_segments");
  return key;
}

/**
 * Lokal diskadapter. Alt ligger under én rotmappe (Docker-volum, eier-konfigurert via `JARVIS_VISION_STORAGE_DIR`). Mapper opprettes
 * med 0700 og filer med 0600 (kun tjenestebrukeren). Skriving er atomisk (temp-fil + rename). Symbolske lenker følges ALDRI: en
 * rotmappe- eller nøkkelsti som er en lenke (eller peker utenfor roten) avvises. Ingen kryptering på applikasjonsnivå i denne
 * versjonen (DEFERRED, se UA9_VISION_DPIA.md): volumet bør ligge på en kryptert disk.
 */
export class LocalFsStorageAdapter implements StorageAdapter {
  readonly backend = "local_fs";
  private readonly root: string;

  constructor(rootDir: string) {
    if (typeof rootDir !== "string" || rootDir.trim().length === 0) throw new Error("local_fs_storage_root_required");
    this.root = resolve(rootDir);
  }

  private async resolveKey(key: string, forWrite: boolean): Promise<string> {
    assertSafeStorageKey(key);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new StorageKeyError("outside_root");
    if (forWrite) {
      await mkdir(dirname(full), { recursive: true, mode: 0o700 });
      const realRoot = await realpath(this.root);
      const realParent = await realpath(dirname(full));
      if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) throw new StorageKeyError("outside_root");
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const full = await this.resolveKey(key, true);
    const existing = await lstat(full).catch(() => null);
    if (existing !== null && !existing.isFile()) throw new StorageKeyError("not_a_regular_file");
    const temp = `${full}.tmp-${randomUUID()}`;
    await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    try {
      await rename(temp, full);
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      throw err;
    }
  }

  async get(key: string, maxBytes = 20 * 1024 * 1024): Promise<Uint8Array | null> {
    const full = await this.resolveKey(key, false);
    const info = await lstat(full).catch((err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? null : Promise.reject(err)));
    if (info === null) return null;
    if (!info.isFile()) throw new StorageKeyError("not_a_regular_file");
    if (info.size > maxBytes) throw new Error("storage_object_too_large");
    return new Uint8Array(await readFile(full));
  }

  async delete(key: string): Promise<{ existed: boolean }> {
    const full = await this.resolveKey(key, false);
    const info = await lstat(full).catch((err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? null : Promise.reject(err)));
    if (info === null) return { existed: false };
    // En symbolsk lenke slettes som lenken selv (aldri målet) - unlink fjerner kun navnet.
    await unlink(full);
    return { existed: true };
  }

  async exists(key: string): Promise<boolean> {
    const full = await this.resolveKey(key, false);
    return (await lstat(full).catch(() => null)) !== null;
  }
}
