import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { ConfigError } from "./errors.mjs";
import { runProcess } from "./process.mjs";

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

/** Øvre størrelse på en hemmelighetsfil (bytes). */
export const MAX_SECRET_FILE_BYTES = 16 * 1024;

/**
 * Leser en hemmelighetsfil (bearer-token, git-PAT) med strenge krav:
 *  - ingen symlenke (O_NOFOLLOW), vanlig fil, maks 16 KiB (et git-token kan bli langt, f.eks. installasjonstokens `ghs_<APPID>_<JWT>`);
 *  - eid av root ELLER tjenestebrukeren;
 *  - modusbitene i `forbiddenModeBits` må være AV. Standard 0o137: ingen tilgang for andre og ikke skrivbar/kjørbar for gruppe - gruppen KAN lese, fordi bearer-tokenet
 *    er delt med worker via gruppen `jarvis-job-clients`. Git-PAT-en skal derimot IKKE kunne leses av noen gruppe (worker skal aldri se den): den leses med 0o177
 *    (kun eier, 0600/0400). En token andre kan lese er ikke en hemmelighet.
 * Returnerer innholdet uten avsluttende whitespace. Kaster ConfigError (aldri med filinnhold i meldingen).
 *
 * @param {string} path
 * @param {{ label?: string, allowedOwnerUids?: number[], skipOwnerCheck?: boolean, forbiddenModeBits?: number }} [options]
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
    if ((st.mode & (options.forbiddenModeBits ?? 0o137)) !== 0) throw new ConfigError(`${label}_permissions_too_open`);
    if (options.skipOwnerCheck !== true) {
      const allowed = options.allowedOwnerUids ?? [0, ...(process.getuid ? [process.getuid()] : [])];
      if (!allowed.includes(st.uid)) throw new ConfigError(`${label}_wrong_owner`);
    }
    if (st.size > MAX_SECRET_FILE_BYTES) throw new ConfigError(`${label}_too_large`);
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

/** Verktøyene som fjerner agent-skrevne trær: GNU coreutils (absolutte stier, ingen PATH-oppslag). Kontrolleres av `install-host.sh`. */
export const RM_BIN = "/bin/rm";
export const CHMOD_BIN = "/bin/chmod";
/** Minimalt, fast miljø for verktøyene (ingen arvet env, ingen locale-/temp-variabler). */
const TOOL_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" });
/** Et tre med titalls millioner filer kan ta minutter; en hengende disk skal likevel aldri holde en jobbplass for alltid. */
export const DEFAULT_REMOVE_TIMEOUT_MS = 15 * 60_000;

/**
 * Fjerner et helt katalogtre som en UBETRODD agent har skrevet i, UTEN å følge symlenker, og uansett HVA agenten har laget.
 *
 * Hvorfor GNU `rm`/`chmod` og ikke en egen JavaScript-vandring: agenten kontrollerer navn, dybde og modus i hele treet, og alle tre kan brukes til å hindre opprydding
 * (en billig tjenestenektelse mot runneren: jobben blir stående som `cleanup_pending` for alltid, holder en jobbplass, og oppstartsavstemmingen klarer det heller ikke):
 *  - filnavn er BYTES, ikke tekst: en fil kalt `\xff\xfe` kan ikke adresseres via en JavaScript-streng (Node dekoder til U+FFFD og `lstat` finner ikke fila);
 *  - et tre LENGRE enn Linux sin PATH_MAX (4096 bytes) kan ikke nås via en absolutt sti (ENAMETOOLONG) - og lengden er i bytes, så 3-byte-tegn gir en tredjedel så mange tegn;
 *  - kataloger med modus 000 / uten skrivetilgang, og millioner av oppføringer i én katalog (minne).
 * `rm -rf` (gnulib fts) går fd-relativt med `openat`/`unlinkat`, så dybde, bytes-navn og flate kataloger er ikke et problem, og den følger aldri symlenker.
 * Forpass: `chmod -R u+rwx` (pre-order: katalogen åpnes ETTER at modusen er satt, så 000-kataloger går bra; følger heller ingen symlenker). `--one-file-system`: ryd aldri på
 * tvers av et monteringspunkt. Kalles først ETTER at containeren er drept (ingen samtidige skrivere). Kaster hvis noe ikke lot seg fjerne (kalleren beholder da jobben som
 * `cleanup_pending` og prøver igjen). Meldingen inneholder aldri filnavn (agent-kontrollert).
 *
 * @param {string} path absolutt sti
 * @param {{ timeoutMs?: number, run?: typeof runProcess }} [options] `run`: kun tester
 */
export async function forceRemoveTree(path, options = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("force_remove_requires_absolute_path");
  const target = resolve(path);
  // Aldri roten eller en toppnivåkatalog: en feil hos kalleren skal ikke kunne tømme /var, /home eller lignende.
  if (target.split(sep).filter((part) => part.length > 0).length < 2) throw new Error("force_remove_refuses_shallow_path");
  const run = options.run ?? runProcess;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOVE_TIMEOUT_MS;
  let st;
  try {
    st = await lstat(target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return;
    throw new Error("force_remove_incomplete:lstat_failed");
  }
  if (!st.isDirectory()) {
    // fil, symlenke (selve lenken, aldri målet), socket, fifo
    try {
      await unlink(target);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw new Error("force_remove_incomplete:unlink_failed");
    }
    return;
  }
  // Feil i forpasset er ikke fatale i seg selv: `rm` melder det som faktisk ikke lot seg fjerne.
  await run(CHMOD_BIN, ["-R", "u+rwx", "--", target], { env: { ...TOOL_ENV }, timeoutMs, maxOutputBytes: 4096 });
  const rm = await run(RM_BIN, ["-rf", "--one-file-system", "--", target], { env: { ...TOOL_ENV }, timeoutMs, maxOutputBytes: 4096 });
  if (rm.spawnError !== undefined) throw new Error("force_remove_incomplete:rm_not_runnable");
  if (rm.timedOut) throw new Error("force_remove_incomplete:rm_timeout");
  if (rm.status !== 0) throw new Error("force_remove_incomplete:rm_failed");
  const left = await lstat(target).then(() => true, (error) => /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT");
  if (left) throw new Error("force_remove_incomplete:still_exists");
}
