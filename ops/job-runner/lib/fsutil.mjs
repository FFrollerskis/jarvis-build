import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { ConfigError } from "./errors.mjs";

/**
 * WP-C1: filsystemhjelpere for en tjeneste som arbeider i kataloger en UBETRODD agent skriver i.
 * Regel: aldri følg symlenker fra agent-kontrollert innhold; aldri les en sti agenten kan ha byttet ut; hemmelighetsfiler
 * åpnes med O_NOFOLLOW og vurderes på den ÅPNE fildeskriptoren (ingen TOCTOU mellom stat og read).
 */

/** Er `candidate` strengt innenfor `base` (begge normaliseres; ingen `..`-flukt)? */
export function isPathInside(base, candidate) {
  const b = resolve(base);
  const c = resolve(candidate);
  return c !== b && c.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Oppretter en katalog med modus 0700 (eid av tjenesten). Eksisterer den, må den være en ekte katalog (ikke symlenke) eid av
 * tjenesten uten tilgang for gruppe/andre - ellers nekter vi (en annen bruker kunne forhåndsplassert den).
 */
export async function ensurePrivateDir(dir, options = {}) {
  if (!isAbsolute(dir)) throw new ConfigError("dir_not_absolute", dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertPrivateDir(dir, options);
}

export async function assertPrivateDir(dir, options = {}) {
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ConfigError("dir_not_a_plain_directory", dir);
  const uid = options.uid ?? process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new ConfigError("dir_wrong_owner", dir);
  if ((st.mode & 0o077) !== 0) {
    await chmod(dir, 0o700);
    const again = await lstat(dir);
    if ((again.mode & 0o077) !== 0) throw new ConfigError("dir_not_private", dir);
  }
}

/**
 * Leser en hemmelighetsfil (bearer-token, git-PAT) med strenge krav:
 *  - ingen symlenke (O_NOFOLLOW), vanlig fil, maks 8 KiB;
 *  - eid av root ELLER tjenestebrukeren;
 *  - INGEN tilgang for andre (0o007) og ikke skrivbar/kjørbar for gruppe (0o137): en token andre kan lese er ikke en hemmelighet.
 * Returnerer innholdet uten avsluttende whitespace. Kaster ConfigError (aldri med filinnhold i meldingen).
 *
 * @param {string} path
 * @param {{ label?: string, allowedOwnerUids?: number[], skipOwnerCheck?: boolean }} [options]
 */
export async function readSecretFile(path, options = {}) {
  const label = options.label ?? "secret_file";
  if (typeof path !== "string" || !isAbsolute(path)) throw new ConfigError(`${label}_path_not_absolute`);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    throw new ConfigError(code === "ELOOP" ? `${label}_is_symlink` : `${label}_unreadable`);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new ConfigError(`${label}_not_a_regular_file`);
    if ((st.mode & 0o137) !== 0) throw new ConfigError(`${label}_permissions_too_open`);
    if (options.skipOwnerCheck !== true) {
      const allowed = options.allowedOwnerUids ?? [0, ...(process.getuid ? [process.getuid()] : [])];
      if (!allowed.includes(st.uid)) throw new ConfigError(`${label}_wrong_owner`);
    }
    if (st.size > 8192) throw new ConfigError(`${label}_too_large`);
    const buffer = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const { bytesRead } = await handle.read(buffer, offset, st.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8").replace(/\s+$/u, "");
  } finally {
    await handle.close();
  }
}

/**
 * Fjerner et helt katalogtre som en UBETRODD agent har skrevet i, UTEN å følge symlenker.
 *  - `lstat` på hver oppføring; symlenker/filer/spesialfiler fjernes med `unlink` (selve lenken, aldri målet);
 *  - kataloger får `chmod 0700` først (agenten kan ha satt modus 000 eller fjernet skrivetilgang), deretter tømmes de og fjernes;
 *  - kalles først ETTER at containeren er drept (ingen samtidige skrivere).
 * Kaster hvis noe ikke lot seg fjerne (kalleren beholder da jobben som `cleanup_pending` og prøver igjen).
 *
 * @param {string} path absolutt sti
 */
export async function forceRemoveTree(path) {
  if (!isAbsolute(path)) throw new Error("force_remove_requires_absolute_path");
  /** @type {string[]} */
  const failures = [];
  /** @param {string} p */
  const walk = async (p) => {
    let st;
    try {
      st = await lstat(p);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return;
      failures.push(p);
      return;
    }
    if (!st.isDirectory()) {
      try {
        await unlink(p);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") failures.push(p);
      }
      return;
    }
    try {
      await chmod(p, 0o700);
    } catch {
      // chmod kan feile for kataloger vi ikke eier - forsøk å lese likevel
    }
    let entries;
    try {
      entries = await readdir(p);
    } catch {
      failures.push(p);
      return;
    }
    for (const name of entries) await walk(`${p}${p.endsWith(sep) ? "" : sep}${name}`);
    try {
      await rmdir(p);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") failures.push(p);
    }
  };
  await walk(resolve(path));
  if (failures.length > 0) throw new Error(`force_remove_incomplete:${failures.length}`);
}
