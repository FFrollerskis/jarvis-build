import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

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
  /**
   * Valgfri (review delta B LOW-D4): fjerner halvferdige skriverester som verken en rad eller en gravstein peker på (adapteren vet selv hvordan slike ser ut), eldre enn `olderThanMs`. Et krasj
   * midt i `put` (eller en full disk) etterlater slike rester; uten dette ligger de for alltid. En adapter uten slike rester utelater metoden. Kalles av det daglige vedlikeholdet (sweep.ts), aldri per tenant.
   */
  purgeStaleTemp?(olderThanMs: number): Promise<{ removed: number; failed: number }>;
}

/**
 * Filsystemoperasjonene adapteren bruker, injiserbare KUN for å kunne simulere kappløp og diskfeil deterministisk i tester (standard: node:fs/promises). Kun mutasjoner er injiserbare; lesing/oppslag
 * (`lstat`, `realpath`, `readFile`) går alltid mot disken.
 */
export interface LocalFsOps {
  unlink: typeof unlink;
  rename: typeof rename;
  writeFile: typeof writeFile;
}

/** Skriveresten `put` etterlater ved et krasj: `<nøkkel>.tmp-<uuid v4>` (se `put`). Kun filer med NØYAKTIG dette navnemønsteret ryddes av `purgeStaleTemp`. */
const TEMP_FILE = /\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Dybdegrense og antall oppføringer `purgeStaleTemp` besøker (objektene ligger på `snapshots/<hash>/<id>`; en korrupt/enorm mappe skal ikke holde sveipet opptatt). */
const MAX_PURGE_DEPTH = 6;
const MAX_PURGE_ENTRIES = 200_000;
/** En grense under ett minutt kunne slettet en skriving som pågår akkurat nå. */
const MIN_PURGE_AGE_MS = 60_000;

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
  private readonly ops: LocalFsOps;

  constructor(rootDir: string, ops: Partial<LocalFsOps> = {}) {
    if (typeof rootDir !== "string" || rootDir.trim().length === 0) throw new Error("local_fs_storage_root_required");
    this.root = resolve(rootDir);
    this.ops = { unlink, rename, writeFile, ...ops };
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
    try {
      await this.ops.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      await this.ops.rename(temp, full);
    } catch (err) {
      // Review delta B LOW-D4: også en MISLYKKET skriving (full disk midt i writeFile) etterlater en halvskrevet temp-fil - ryddes her, ikke bare ved feil i rename. (Et krasj/kill midt i put kan ikke fanges her:
      // det ryddes av `purgeStaleTemp`.) Feil ved selve ryddingen skjuler aldri den opprinnelige feilen.
      await this.ops.unlink(temp).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Fjerner foreldreløse `<nøkkel>.tmp-<uuid>`-filer (skriverester) eldre enn `olderThanMs` (minst ett minutt, aldri en skriving som pågår). Rører KUN vanlige filer med akkurat dette navnemønsteret: aldri et ekte objekt,
   * aldri en symbolsk lenke (følges ikke) og aldri en katalog. En fil som ikke lar seg slette telles som `failed` (kaster ikke; resten ryddes likevel). Rotmappen kan mangle (ingenting er lagret ennå) = ingenting å rydde.
   */
  async purgeStaleTemp(olderThanMs: number): Promise<{ removed: number; failed: number }> {
    if (!Number.isFinite(olderThanMs) || olderThanMs < MIN_PURGE_AGE_MS) throw new Error("storage_purge_age_invalid");
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    let failed = 0;
    let visited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        failed += 1;
        return;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > MAX_PURGE_ENTRIES) return;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < MAX_PURGE_DEPTH) await walk(path, depth + 1);
          continue;
        }
        if (!entry.isFile() || !TEMP_FILE.test(entry.name)) continue; // symlenker (isFile() er usann for dem), fifoer og alt som ikke heter `*.tmp-<uuid>` står
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.mtimeMs > cutoff) continue;
          await this.ops.unlink(path);
          removed += 1;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // borte i mellomtiden (en annen sveiper) - ikke en feil
          failed += 1;
        }
      }
    };
    await walk(this.root, 0);
    return { removed, failed };
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
    try {
      await this.ops.unlink(full);
    } catch (err) {
      // Review delta B LOW-D3: en annen reaper kan ha slettet filen mellom `lstat` og `unlink` (samtidige vedlikeholdskjøringer ga 114 falske `failed`). Borte er borte: det samme som `existed: false`.
      // Enhver ANNEN feil (EPERM, EISDIR, EIO ...) kastes fortsatt, slik at reaperen beholder graven og prøver igjen.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { existed: false };
      throw err;
    }
    return { existed: true };
  }

  async exists(key: string): Promise<boolean> {
    const full = await this.resolveKey(key, false);
    return (await lstat(full).catch(() => null)) !== null;
  }
}
