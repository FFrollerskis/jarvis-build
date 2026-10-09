import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, writeFileSync
} from "node:fs";
import { chmod, lstat, mkdir, open as openFile, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, parse, resolve, sep } from "node:path";
import { sha256File } from "./backup.mjs";
import { envBool, envInt, envString } from "./env.mjs";
import { minimalEnv, runProcess } from "./proc.mjs";
import { assertAgeRecipient, requireBinary } from "./tools.mjs";

/**
 * WP-C2 (OPS-RUNTIME): off-site-kopi av de KRYPTERTE backup-settene. DORMANT og leverandørnøytral (CLAUDE.md regel 12): ingen env = ingen off-site,
 * og statusen sier ærlig `not_configured`. Valg av faktisk mål er eierens - rclone er et VERKTØY (dekker bucket/sftp/drive/... via eierens egen,
 * ferdig-konfigurerte remote), ikke en leverandør, og bygges ikke inn her.
 *
 * Tre adaptere bak ett grensesnitt (`list` / `push` / `verify` / `fetch`):
 *   rclone     JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE=navn:sti
 *   rsync_ssh  JARVIS_BACKUP_OFFSITE_SSH=bruker@vert:/sti  (kun nøkkelbasert: BatchMode=yes, StrictHostKeyChecking=yes)
 *   local      JARVIS_BACKUP_OFFSITE_LOCAL_DIR=/sti        (USB/annen disk; krever markørfil + annen enhet, så en avmontert disk ikke «lykkes»)
 *
 * Sikkerhetsegenskaper (angrepsflate for review):
 *  - KUN `.age`-chiffertekst forlater maskinen. Før kopiering sjekkes at settet inneholder NØYAKTIG de filene manifestet lister (+ manifest.json/SHA256SUMS
 *    som ikke sendes), at hver fil har `.age`-endelse OG age-headeren (ikke en omdøpt klartekst-dump), og at størrelse/SHA-256 stemmer med manifestet.
 *    Én ukjent fil i settet (f.eks. en klartekst `jarvis.dump`) gjør at HELE settet nektes - høylytt.
 *  - Manifestet (tabellnavn + radtall) sendes IKKE i klartekst: det krypteres med samme offentlige nøkkel til `manifest.json.age`. Krypteringsmodellen er uendret.
 *  - Ingen arbitrær kommando fra konfig (ingen `..._CMD`), ingen shell: alltid `spawn(fil, argv[])`. Verdiene valideres mot et lukket tegnsett, og
 *    kan aldri begynne med `-` (ingen flagginjeksjon). Underprosessene får et MINIMALT miljø - aldri DB-passordet.
 *  - Ingen sletting av fjerndata (`copy`, aldri `sync`/`--delete`). Opprydding av gamle off-site-sett er eierens (leverandørens livssyklusregler).
 *  - Den lokale adapteren kopierer fra et ÅPNET håndtak med O_NOFOLLOW (`copyRegularNoFollow`): en fil som byttes ut med en symlenke etter forhåndssjekken følges ikke, og
 *    ingenting skrives til målet før første blokk har age-headeren.
 */
export const SET_NAME_RE = /^jarvis-backup-\d{8}T\d{6}Z$/;
export const AGE_MAGIC = Buffer.from("age-encryption.org/v1");
export const MANIFEST_AGE = "manifest.json.age";
export const LOCAL_MARKER = ".jarvis-offsite-target";
const AGE_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.age$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class OffsiteError extends Error {
  /** @param {"offsite_failed"|"offsite_timeout"|"offsite_ineligible"|"offsite_verify_failed"|"offsite_config_invalid"} code */
  constructor(code, message) {
    super(message);
    this.name = "OffsiteError";
    this.code = code;
  }
}

const configError = (message) => new OffsiteError("offsite_config_invalid", message);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Konfig
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** `navn:sti` - en FERDIG-konfigurert remote. `:backend,param=...:`-strenger (on-the-fly, kan bære legitimasjon) er ikke tillatt. */
export function validateRcloneRemote(raw) {
  // eslint-disable-next-line no-control-regex
  if (raw.length > 300 || /[\u0000-\u001f\u007f\\"'`$]/.test(raw)) throw configError("JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE: for lang eller ugyldige tegn");
  const m = /^([A-Za-z0-9_][A-Za-z0-9_.+@-]{0,63}):(.*)$/.exec(raw);
  if (!m) throw configError("JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE: forventet «navn:sti» (en ferdig-konfigurert rclone-remote)");
  const path = (m[2] ?? "").replace(/\/+$/, "");
  // Lukket tegnsett i stien (bokstaver/tall inkl. æøå, mellomrom og _ . + @ / ( ) = , -): ingen glob-/filtertegn (* ? [ ] { }), ingen kolon, ingen shell-tegn.
  if (!/^[\p{L}\p{N} _.+@/()=,-]*$/u.test(path)) throw configError("JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE: ugyldige tegn i stien (tillatt: bokstaver, tall, mellomrom og _ . + @ / ( ) = , -)");
  if (path.split("/").some((segment) => segment === "..")) throw configError("JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE: «..» i stien er ikke tillatt");
  return `${m[1]}:${path}`;
}

/** `bruker@vert:/absolutt/sti`. Bruker og vert kan aldri begynne med `-` (ville blitt tolket som et ssh-/rsync-flagg). */
export function validateSshTarget(raw) {
  const m = /^([A-Za-z_][A-Za-z0-9_.-]{0,31})@([A-Za-z0-9][A-Za-z0-9.-]{0,252}|\[[0-9A-Fa-f:]{2,45}\]):(\/[A-Za-z0-9_.+@/-]{0,300})$/.exec(raw);
  if (!m) throw configError("JARVIS_BACKUP_OFFSITE_SSH: forventet «bruker@vert:/absolutt/sti» (tegn: A-Z a-z 0-9 _ . + @ / -)");
  const path = (m[3] ?? "").replace(/\/+$/, "");
  if (path === "" || path.split("/").some((segment) => segment === "..")) throw configError("JARVIS_BACKUP_OFFSITE_SSH: stien må være en underkatalog (ikke «/» og ikke «..»)");
  return { user: m[1], host: m[2], path, spec: `${m[1]}@${m[2]}:${path}` };
}

function optionalSafePath(env, name) {
  const raw = envString(env, name);
  if (raw === undefined) return null;
  if (!/^(\/|[A-Za-z]:\/)[A-Za-z0-9_.+@/-]{0,300}$/.test(raw)) throw configError(`${name}: forventet absolutt sti med skråstrek og tegnene A-Z a-z 0-9 _ . + @ - (ingen mellomrom)`);
  return raw;
}

export function validateLocalDir(raw) {
  // eslint-disable-next-line no-control-regex
  if (raw.length > 500 || /[\u0000-\u001f\u007f]/.test(raw) || !isAbsolute(raw)) throw configError("JARVIS_BACKUP_OFFSITE_LOCAL_DIR: forventet absolutt sti uten kontrolltegn");
  const dir = resolve(raw);
  if (dir === parse(dir).root) throw configError("JARVIS_BACKUP_OFFSITE_LOCAL_DIR: rotkatalogen er ikke tillatt");
  return dir;
}

/**
 * @returns {null
 *   | { adapter: "rclone", remote: string, timeoutMs: number }
 *   | { adapter: "rsync_ssh", target: { user: string, host: string, path: string, spec: string }, keyFile: string | null, knownHosts: string | null, timeoutMs: number }
 *   | { adapter: "local", dir: string, allowSameDevice: boolean, timeoutMs: number }}
 */
export function parseOffsiteConfig(env = process.env) {
  const rclone = envString(env, "JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE");
  const ssh = envString(env, "JARVIS_BACKUP_OFFSITE_SSH");
  const local = envString(env, "JARVIS_BACKUP_OFFSITE_LOCAL_DIR");
  const chosen = [rclone && "rclone", ssh && "rsync_ssh", local && "local"].filter(Boolean);
  if (chosen.length === 0) return null;
  // To mål samtidig er et valg systemet ikke skal ta stille - eieren velger ÉN adapter.
  if (chosen.length > 1) throw configError(`kun ÉN off-site-adapter kan være satt (funnet: ${chosen.join(", ")})`);
  const timeoutMs = envInt(env, "JARVIS_BACKUP_OFFSITE_TIMEOUT_MINUTES", 120, { min: 1, max: 1440 }) * 60_000;
  if (rclone !== undefined) return { adapter: "rclone", remote: validateRcloneRemote(rclone), timeoutMs };
  if (ssh !== undefined) {
    return {
      adapter: "rsync_ssh", target: validateSshTarget(ssh), keyFile: optionalSafePath(env, "JARVIS_BACKUP_OFFSITE_SSH_KEY"),
      knownHosts: optionalSafePath(env, "JARVIS_BACKUP_OFFSITE_SSH_KNOWN_HOSTS"), timeoutMs
    };
  }
  return { adapter: "local", dir: validateLocalDir(local), allowSameDevice: envBool(env, "JARVIS_BACKUP_OFFSITE_LOCAL_ALLOW_SAME_DEVICE", false), timeoutMs };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Settet: hva som FÅR forlate maskinen
// ---------------------------------------------------------------------------------------------------------------------------------------------
const ineligible = (why) => new OffsiteError("offsite_ineligible", why);
const safeEntry = (name) => String(name).replace(/[^A-Za-z0-9._-]/g, "?").slice(0, 60);

function readsAsAge(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(AGE_MAGIC.length);
    return readSync(fd, buf, 0, buf.length, 0) === buf.length && buf.equals(AGE_MAGIC);
  } finally {
    closeSync(fd);
  }
}

function expectedFiles(manifest, name) {
  if (manifest === null || typeof manifest !== "object" || manifest.set !== name || !Array.isArray(manifest.databases) || manifest.databases.length === 0 || manifest.databases.length > 32) {
    throw ineligible("manifest har ikke forventet form");
  }
  const out = new Map();
  const add = (file, sha256, size) => {
    if (typeof file !== "string" || !AGE_FILE.test(file)) throw ineligible("manifestet lister en fil uten .age-endelse eller med utrygt navn");
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw ineligible(`manifestet har ugyldig sjekksum for ${safeEntry(file)}`);
    if (out.has(file)) throw ineligible(`manifestet lister ${safeEntry(file)} to ganger`);
    out.set(file, { sha256, size });
  };
  for (const d of manifest.databases) add(d?.file, d?.sha256, Number.isInteger(d?.size_bytes) ? d.size_bytes : null);
  add(manifest.globals?.file, manifest.globals?.sha256, null);
  return out;
}

/** Krypterer manifest.json til manifest.json.age med den OFFENTLIGE nøkkelen (samme `age`-binær/wrapper som selve backupen). */
export async function encryptManifestWithAge({ setDir, recipient, env = process.env }) {
  assertAgeRecipient(recipient);
  const tmp = join(setDir, `${MANIFEST_AGE}.tmp-${randomBytes(6).toString("hex")}`);
  const res = await runProcess(requireBinary("age", env), ["-r", recipient, "-o", tmp], {
    input: readFileSync(join(setDir, "manifest.json")), timeoutMs: 120_000,
    env: minimalEnv({ JARVIS_AGE_IMAGE: env.JARVIS_AGE_IMAGE, DOCKER_HOST: env.DOCKER_HOST })
  });
  if (res.code !== 0 || res.timedOut) {
    rmSync(tmp, { force: true });
    throw new OffsiteError("offsite_failed", `age kunne ikke kryptere manifestet (exit ${res.code ?? "?"}${res.timedOut ? ", tidsavbrudd" : ""})`);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, join(setDir, MANIFEST_AGE));
}

/**
 * Forhåndssjekk + forberedelse. Kaster `offsite_ineligible` ved ENHVER avvikende fil (ukjent/klartekst/ikke-age/feil sjekksum), uten å ha kopiert noe.
 * @returns {Promise<{ name: string, dir: string, files: Array<{ name: string, size: number, sha256: string }>, bytes: number, createdAt: string | null }>}
 */
export async function prepareSetForOffsite(setDir, { recipient, encryptManifest = encryptManifestWithAge } = {}) {
  const name = basename(setDir);
  if (!SET_NAME_RE.test(name)) throw ineligible("mappenavnet er ikke et backup-sett");
  const top = lstatSync(setDir);
  if (!top.isDirectory() || top.isSymbolicLink()) throw ineligible("settet er ikke en vanlig katalog");
  for (const entry of readdirSync(setDir)) {
    if (/^manifest\.json\.age\.tmp-[0-9a-f]{12}$/.test(entry)) rmSync(join(setDir, entry), { force: true }); // vår egen rest etter en avbrutt kryptering
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(setDir, "manifest.json"), "utf8"));
  } catch {
    throw ineligible("manifest.json mangler eller er ulesbar");
  }
  const expected = expectedFiles(manifest, name);
  const allowed = new Set(["manifest.json", "SHA256SUMS", MANIFEST_AGE, ...expected.keys()]);
  const problems = [];
  for (const entry of readdirSync(setDir)) if (!allowed.has(entry)) problems.push(`ukjent fil i settet: ${safeEntry(entry)}`);
  const files = [];
  for (const [file, exp] of expected) {
    const path = join(setDir, file);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      problems.push(`mangler: ${file}`);
      continue;
    }
    if (!st.isFile() || st.isSymbolicLink()) { problems.push(`ikke en vanlig fil: ${file}`); continue; }
    if (!readsAsAge(path)) { problems.push(`ikke age-chiffertekst: ${file}`); continue; }
    if (exp.size !== null && st.size !== exp.size) { problems.push(`størrelsen avviker fra manifestet: ${file}`); continue; }
    const actual = await sha256File(path);
    if (actual !== exp.sha256) { problems.push(`sjekksummen avviker fra manifestet: ${file}`); continue; }
    files.push({ name: file, size: st.size, sha256: actual });
  }
  if (problems.length > 0) throw ineligible(`sett ${name} nektes off-site: ${problems.slice(0, 6).join("; ")}`);

  const manifestAge = join(setDir, MANIFEST_AGE);
  if (!existsSync(manifestAge)) {
    if (recipient === undefined) throw configError("JARVIS_BACKUP_AGE_RECIPIENT kreves for å kryptere manifestet før off-site-kopi");
    await encryptManifest({ setDir, recipient });
  }
  const mst = lstatSync(manifestAge);
  if (!mst.isFile() || mst.isSymbolicLink() || !readsAsAge(manifestAge)) throw ineligible(`${MANIFEST_AGE} er ikke age-chiffertekst`);
  files.push({ name: MANIFEST_AGE, size: mst.size, sha256: await sha256File(manifestAge) });
  return { name, dir: setDir, files, bytes: files.reduce((sum, f) => sum + f.size, 0), createdAt: typeof manifest.created_at_utc === "string" ? manifest.created_at_utc : null };
}

/**
 * Etter `fetch` (eller for en lokal kopi): lag manifest.json av manifest.json.age med den PRIVATE nøkkelen, slik at restore-verifiseringen kan kjøre.
 * Kjøres kun der identitetsfilen finnes (verifisererens maskin, aldri NAS-en).
 */
export async function materializeManifest(setDir, identityFile, { env = process.env } = {}) {
  const plain = join(setDir, "manifest.json");
  if (existsSync(plain)) return false;
  const encrypted = join(setDir, MANIFEST_AGE);
  if (!existsSync(encrypted)) throw new OffsiteError("offsite_failed", "settet har verken manifest.json eller manifest.json.age");
  const tmp = join(setDir, `manifest.json.tmp-${randomBytes(6).toString("hex")}`);
  const res = await runProcess(requireBinary("age", env), ["-d", "-i", identityFile, "-o", tmp, encrypted], { timeoutMs: 120_000, env: minimalEnv() });
  if (res.code !== 0) {
    rmSync(tmp, { force: true });
    throw new OffsiteError("offsite_failed", `kunne ikke dekryptere manifestet (exit ${res.code ?? "?"}) - feil privatnøkkel?`);
  }
  try {
    const parsed = JSON.parse(readFileSync(tmp, "utf8"));
    if (parsed?.set !== basename(setDir)) throw new Error("set mismatch");
  } catch {
    rmSync(tmp, { force: true });
    throw new OffsiteError("offsite_failed", "dekryptert manifest er ugyldig eller tilhører et annet sett");
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, plain);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Felles hjelpere for adapterne
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function withListFile(names, fn) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-offsite-"));
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, "files.txt");
    writeFileSync(file, `${names.join("\n")}\n`, { mode: 0o600 });
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function listAgeFiles(dir) {
  return readdirSync(dir).filter((n) => AGE_FILE.test(n) && lstatSync(join(dir, n)).isFile());
}

/** Fjerner alt som IKKE er en .age-fil etter en henting (en angriper med skrivetilgang til fjernmålet kan ha lagt noe ved). */
function pruneNonAge(dir) {
  for (const n of readdirSync(dir)) if (!AGE_FILE.test(n)) rmSync(join(dir, n), { recursive: true, force: true });
}

export function parseLsjson(stdout) {
  let arr;
  try {
    arr = JSON.parse(stdout);
  } catch {
    throw new OffsiteError("offsite_failed", "rclone lsjson ga ugyldig JSON");
  }
  if (!Array.isArray(arr)) throw new OffsiteError("offsite_failed", "rclone lsjson ga uventet format");
  return arr.slice(0, 5000).map((e) => ({
    name: String(e?.Name ?? e?.Path ?? ""),
    isDir: e?.IsDir === true,
    size: Number.isInteger(e?.Size) ? e.Size : -1,
    sha256: typeof e?.Hashes?.sha256 === "string" ? e.Hashes.sha256.toLowerCase() : null
  }));
}

/** Sammenligner et fjernt filoversikt mot det vi sendte. Mangler/størrelse/sjekksum avviker = `offsite_verify_failed`. */
export function compareRemoteListing(prepared, entries) {
  const byName = new Map(entries.filter((e) => !e.isDir).map((e) => [e.name, e]));
  const problems = [];
  let sizeOnly = false;
  for (const f of prepared.files) {
    const e = byName.get(f.name);
    if (!e) { problems.push(`mangler: ${f.name}`); continue; }
    if (e.size !== f.size) { problems.push(`størrelsen avviker: ${f.name}`); continue; }
    if (e.sha256 === null) sizeOnly = true;
    else if (e.sha256 !== f.sha256) problems.push(`sjekksummen avviker: ${f.name}`);
  }
  if (problems.length > 0) throw new OffsiteError("offsite_verify_failed", `off-site-kopien avviker fra det lokale settet: ${problems.slice(0, 6).join("; ")}`);
  return { verification: sizeOnly ? "size_only" : "sha256", files: prepared.files.length, bytes: prepared.bytes };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// rclone
// ---------------------------------------------------------------------------------------------------------------------------------------------
function joinRemote(remote, ...segments) {
  const tail = segments.join("/");
  return remote.endsWith(":") ? `${remote}${tail}` : `${remote}/${tail}`;
}

export function rcloneCopyArgs({ remote, setName, srcDir, listFile }) {
  return [
    "copy", "--files-from-raw", listFile, "--checksum", "--contimeout", "30s", "--timeout", "10m", "--retries", "3", "--low-level-retries", "5", "--stats", "0",
    srcDir, joinRemote(remote, setName)
  ];
}

class RcloneSink {
  constructor(config, deps) {
    this.adapter = "rclone";
    this.config = config;
    this.deps = deps;
    this.label = `rclone:${config.remote.split(":")[0]}`;
  }

  async #run(args, what) {
    const res = await this.deps.run("rclone", args, { timeoutMs: this.config.timeoutMs });
    return this.deps.check(res, what);
  }

  async list() {
    const res = await this.deps.run("rclone", ["lsjson", "--dirs-only", "--no-modtime", "--no-mimetype", this.config.remote], { timeoutMs: this.config.timeoutMs });
    if (res.code === 3) return []; // rclone: «directory not found» - ingenting er sendt ennå
    this.deps.check(res, "rclone lsjson");
    return parseLsjson(res.stdout).filter((e) => e.isDir && SET_NAME_RE.test(e.name)).map((e) => e.name).sort();
  }

  async push(prepared) {
    await withListFile(prepared.files.map((f) => f.name), (listFile) =>
      this.#run(rcloneCopyArgs({ remote: this.config.remote, setName: prepared.name, srcDir: prepared.dir, listFile }), "rclone copy"));
    return this.verify(prepared);
  }

  async verify(prepared) {
    const res = await this.#run(["lsjson", "--hash", "--no-modtime", "--no-mimetype", joinRemote(this.config.remote, prepared.name)], "rclone lsjson");
    return compareRemoteListing(prepared, parseLsjson(res.stdout));
  }

  async fetch(name, destDir) {
    if (!SET_NAME_RE.test(name)) throw ineligible("ugyldig settnavn");
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    await this.#run(["copy", "--checksum", "--include", "*.age", "--contimeout", "30s", "--timeout", "10m", "--stats", "0", joinRemote(this.config.remote, name), destDir], "rclone copy");
    pruneNonAge(destDir);
    return listAgeFiles(destDir);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// rsync over ssh
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** ssh-kommandoen rsync starter (-e). Kun nøkkelbasert; ingen passordspørsmål; vertsnøkkelen MÅ være kjent på forhånd. */
export function sshCommand({ keyFile = null, knownHosts = null } = {}) {
  const parts = [
    "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
    "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no"
  ];
  if (keyFile !== null) parts.push("-o", "IdentitiesOnly=yes", "-i", keyFile);
  if (knownHosts !== null) parts.push("-o", `UserKnownHostsFile=${knownHosts}`);
  return parts.join(" ");
}

export function rsyncPushArgs({ ssh, srcDir, destSpec, setName, listFile }) {
  return ["-a", "--partial-dir=.rsync-partial", "--chmod=D700,F600", `--files-from=${listFile}`, "-e", ssh, "--timeout=300", "--", `${srcDir}/`, `${destSpec}/${setName}/`];
}

export function rsyncVerifyArgs({ ssh, srcDir, destSpec, setName, listFile }) {
  return ["-a", "--checksum", "--dry-run", "--itemize-changes", `--files-from=${listFile}`, "-e", ssh, "--timeout=300", "--", `${srcDir}/`, `${destSpec}/${setName}/`];
}

/** Filer rsync ville overført (= avvik): `>f…`, `<f…`, `cf…`. Rene attributtlinjer (`.f…`, `.d…`) er ikke innholdsavvik. */
export function rsyncDifferences(stdout) {
  const out = [];
  for (const line of stdout.split("\n")) {
    const m = /^([<>c]f\S*)\s+(.+)$/.exec(line.trimEnd());
    if (m) out.push(String(m[2]));
  }
  return out;
}

class RsyncSshSink {
  constructor(config, deps) {
    this.adapter = "rsync_ssh";
    this.config = config;
    this.deps = deps;
    this.ssh = sshCommand({ keyFile: config.keyFile, knownHosts: config.knownHosts });
    this.label = `rsync_ssh:${config.target.host}`;
  }

  async list() {
    const res = await this.deps.run("rsync", ["--list-only", "-e", this.ssh, "--timeout=60", "--", `${this.config.target.spec}/`], { timeoutMs: this.config.timeoutMs });
    // «No such file or directory» (exit 23) når basestien ikke finnes: eieren oppretter den på forhånd, så dette er en ekte feil.
    this.deps.check(res, "rsync --list-only");
    const names = [];
    for (const line of res.stdout.split("\n")) {
      const m = /^d\S+\s+[\d,.]+\s+\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+(jarvis-backup-\d{8}T\d{6}Z)\s*$/.exec(line);
      if (m) names.push(String(m[1]));
    }
    return names.sort();
  }

  async push(prepared) {
    await withListFile(prepared.files.map((f) => f.name), async (listFile) => {
      const res = await this.deps.run("rsync", rsyncPushArgs({ ssh: this.ssh, srcDir: prepared.dir, destSpec: this.config.target.spec, setName: prepared.name, listFile }), { timeoutMs: this.config.timeoutMs });
      this.deps.check(res, "rsync");
    });
    return this.verify(prepared);
  }

  async verify(prepared) {
    return withListFile(prepared.files.map((f) => f.name), async (listFile) => {
      const res = await this.deps.run("rsync", rsyncVerifyArgs({ ssh: this.ssh, srcDir: prepared.dir, destSpec: this.config.target.spec, setName: prepared.name, listFile }), { timeoutMs: this.config.timeoutMs });
      this.deps.check(res, "rsync --checksum --dry-run");
      const diff = rsyncDifferences(res.stdout);
      if (diff.length > 0) throw new OffsiteError("offsite_verify_failed", `off-site-kopien avviker fra det lokale settet: ${diff.slice(0, 6).map(safeEntry).join(", ")}`);
      return { verification: "checksum_dry_run", files: prepared.files.length, bytes: prepared.bytes };
    });
  }

  async fetch(name, destDir) {
    if (!SET_NAME_RE.test(name)) throw ineligible("ugyldig settnavn");
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    const res = await this.deps.run(
      "rsync",
      ["-a", "--partial-dir=.rsync-partial", "--include=*.age", "--exclude=*", "-e", this.ssh, "--timeout=300", "--", `${this.config.target.spec}/${name}/`, `${destDir}/`],
      { timeoutMs: this.config.timeoutMs }
    );
    this.deps.check(res, "rsync");
    pruneNonAge(destDir);
    return listAgeFiles(destDir);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Lokal sti (USB / annen disk)
// ---------------------------------------------------------------------------------------------------------------------------------------------
const COPY_CHUNK = 4 * 1024 * 1024;
/** O_NOFOLLOW: en symlenke gir ELOOP i stedet for å bli fulgt. O_NONBLOCK: open() på en FIFO uten skriver venter ikke for alltid. (Begge mangler på Windows: ukjent konstant blir 0.) */
const SOURCE_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
/**
 * Kopierer ÉN fil fra et ÅPNET håndtak (review F13). `copyFile(src, dest)` slår opp stien på nytt og FØLGER en symlenke: byttes `src` ut mellom forhåndssjekken og kopieringen
 * (TOCTOU) kopieres det symlenken peker på - f.eks. en klartekstfil - til off-site-målet. Her åpnes kilden med O_NOFOLLOW (symlenke -> ELOOP -> `offsite_ineligible`) og O_NONBLOCK,
 * `fstat` på det ÅPNE håndtaket må si «vanlig fil», og det er DET håndtaket som leses: bytene vi hasher og skriver er nøyaktig de vi åpnet, ikke det stien peker på et øyeblikk senere.
 * Med `expect` avvises avvik FØR noe skrives (størrelse, age-header i første blokk) eller før kopien beholdes (lengde og SHA-256 av det som faktisk ble skrevet); en avvist kopi fjernes.
 * @param {{ size?: number, sha256?: string, ageHeader?: boolean }} [expect] fra forhåndssjekken (`prepareSetForOffsite`)
 */
export async function copyRegularNoFollow(src, dest, expect = {}) {
  const label = safeEntry(basename(src));
  let source;
  try {
    source = await openFile(src, SOURCE_FLAGS);
  } catch (err) {
    if (err?.code === "ELOOP" || err?.code === "EMLINK") throw ineligible(`kilden er en symlenke og følges ikke: ${label}`);
    throw err;
  }
  let target = null;
  try {
    const st = await source.stat();
    if (!st.isFile()) throw ineligible(`kilden er ikke en vanlig fil: ${label}`);
    if (expect.size !== undefined && st.size !== expect.size) throw new OffsiteError("offsite_verify_failed", `størrelsen avviker fra forhåndssjekken: ${label}`);
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(st.size, 1)));
    let total = 0;
    for (;;) {
      const { bytesRead } = await source.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      if (target === null) {
        // Ingenting opprettes i målet før første blokk er sett: en omdøpt klartekstfil kommer aldri inn i off-site-målet, heller ikke et øyeblikk.
        if (expect.ageHeader === true && (bytesRead < AGE_MAGIC.length || !buf.subarray(0, AGE_MAGIC.length).equals(AGE_MAGIC))) throw ineligible(`ikke age-chiffertekst: ${label}`);
        target = await openFile(dest, "wx", 0o600);
      }
      hash.update(buf.subarray(0, bytesRead));
      for (let written = 0; written < bytesRead;) written += (await target.write(buf, written, bytesRead - written)).bytesWritten;
      total += bytesRead;
    }
    if (target === null) {
      if (expect.ageHeader === true) throw ineligible(`ikke age-chiffertekst (tom fil): ${label}`);
      target = await openFile(dest, "wx", 0o600);
    }
    if ((expect.size !== undefined && total !== expect.size) || (expect.sha256 !== undefined && hash.digest("hex") !== expect.sha256)) {
      throw new OffsiteError("offsite_verify_failed", `kilden endret seg etter forhåndssjekken eller avviker fra den: ${label}`);
    }
    await target.sync();
  } catch (err) {
    if (target !== null) {
      await target.close().catch(() => undefined);
      target = null;
      await rm(dest, { force: true }).catch(() => undefined);
    }
    throw err;
  } finally {
    if (target !== null) await target.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}
/**
 * Frist for ÉN sink-operasjon (review F4). En hengt USB-disk eller NFS-montering kan ikke avbrytes i Node - kallet sitter i kjernen - men tikket skal ikke vente på det for
 * alltid: vi gir opp, rapporterer `offsite_timeout` og går videre. Uten dette ble en kopi som aldri ferdigstilles stående med låsen, og alle senere tikk gjorde ingenting.
 * Selve kallet blir stående i bakgrunnen (trådpoolen) til kjernen slipper det; resultatet ignoreres.
 */
class Budget {
  constructor(totalMs, label) {
    this.endsAt = Date.now() + totalMs;
    this.label = label;
  }

  async run(what, op) {
    const left = this.endsAt - Date.now();
    const timeout = () => new OffsiteError("offsite_timeout", `${this.label}: ${what} brukte for lang tid (hengt disk eller nettverksmontering?)`);
    if (left <= 0) throw timeout();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(op),
        new Promise((_, reject) => { timer = setTimeout(() => reject(timeout()), left); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Opprydding etter en feilet/avbrutt kopi: best effort med egen, kort frist - en hengt disk skal ikke også henge oppryddingen. */
async function bestEffort(promiseFactory, ms = 15_000) {
  let timer;
  try {
    await Promise.race([Promise.resolve().then(promiseFactory), new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  } catch {
    // restene ryddes av en senere kjøring (foreldede .incoming-*)
  } finally {
    clearTimeout(timer);
  }
}

class LocalSink {
  constructor(config, deps) {
    this.adapter = "local";
    this.config = config;
    this.deps = deps;
    this.label = `local:${basename(config.dir)}`;
    // Filsystem-kallene kan byttes ut i tester (en hengt disk lar seg ikke lage ellers).
    this.fs = { stat, lstat, readdir, mkdir, copyFile: copyRegularNoFollow, chmod, rename, rm, ...(deps.fs ?? {}) };
  }

  #budget() {
    return new Budget(this.config.timeoutMs, "off-site (lokal sti)");
  }

  async #exists(budget, path) {
    try {
      await budget.run(`stat ${basename(path)}`, () => this.fs.stat(path));
      return true;
    } catch (err) {
      if (err instanceof OffsiteError) throw err; // tidsavbrudd er ikke «finnes ikke»
      return false;
    }
  }

  /** En avmontert USB-disk er bare en tom katalog på systemdisken: uten markørfil og (som standard) en ANNEN enhet enn backup-mappen «lykkes» ingenting. */
  async #assertTarget(budget) {
    const dir = this.config.dir;
    let st;
    try {
      st = await budget.run("stat av målet", () => this.fs.stat(dir));
    } catch (err) {
      if (err instanceof OffsiteError) throw err;
      throw configError("off-site-målet (lokal sti) finnes ikke - er disken montert?");
    }
    if (!st.isDirectory()) throw configError("off-site-målet (lokal sti) er ikke en katalog");
    if (!(await this.#exists(budget, join(dir, LOCAL_MARKER)))) {
      throw configError(`off-site-målet mangler markørfilen ${LOCAL_MARKER} (opprett den én gang på den riktige disken: touch <sti>/${LOCAL_MARKER}) - er disken montert?`);
    }
    const source = this.deps.sourceDir;
    if (source !== undefined) {
      const s = resolve(source);
      const d = resolve(dir);
      if (d === s || d.startsWith(`${s}${sep}`)) throw configError("off-site-målet ligger inne i backup-mappen");
      if (!this.config.allowSameDevice && (await budget.run("stat av backup-mappen", () => this.fs.stat(source))).dev === st.dev) {
        throw configError("off-site-målet ligger på SAMME enhet som backup-mappen (ingen beskyttelse mot diskfeil) - sett JARVIS_BACKUP_OFFSITE_LOCAL_ALLOW_SAME_DEVICE=true kun hvis det er bevisst");
      }
    }
    return dir;
  }

  async list() {
    const budget = this.#budget();
    const dir = await this.#assertTarget(budget);
    const sets = [];
    for (const n of (await budget.run("lese målet", () => this.fs.readdir(dir))).filter((name) => SET_NAME_RE.test(name)).sort()) {
      if ((await budget.run(`lstat ${n}`, () => this.fs.lstat(join(dir, n)))).isDirectory()) sets.push(n);
    }
    return sets;
  }

  async #listAgeFiles(budget, dir) {
    const names = [];
    for (const n of await budget.run("lese settet", () => this.fs.readdir(dir))) {
      if (AGE_FILE.test(n) && (await budget.run(`lstat ${n}`, () => this.fs.lstat(join(dir, n)))).isFile()) names.push(n);
    }
    return names;
  }

  async #hashAll(budget, dir, prepared) {
    const problems = [];
    for (const f of prepared.files) {
      const path = join(dir, f.name);
      try {
        const st = await budget.run(`lstat ${f.name}`, () => this.fs.lstat(path));
        if (!st.isFile() || st.isSymbolicLink() || st.size !== f.size) problems.push(`størrelsen avviker: ${f.name}`);
        else if ((await budget.run(`sjekksum ${f.name}`, () => sha256File(path))) !== f.sha256) problems.push(`sjekksummen avviker: ${f.name}`);
      } catch (err) {
        if (err instanceof OffsiteError) throw err; // tidsavbrudd er ikke «mangler»
        problems.push(`mangler: ${f.name}`);
      }
    }
    return problems;
  }

  async push(prepared) {
    const budget = this.#budget();
    const root = await this.#assertTarget(budget);
    const finalDir = join(root, prepared.name);
    if (await this.#exists(budget, finalDir)) {
      // Atomisk publisert tidligere: skal være identisk. Vi overskriver aldri.
      const problems = await this.#hashAll(budget, finalDir, prepared);
      if (problems.length > 0) throw new OffsiteError("offsite_verify_failed", `settet finnes allerede i off-site-målet, men avviker (overskrives ikke): ${problems.slice(0, 4).join("; ")}`);
      return { verification: "sha256", files: prepared.files.length, bytes: prepared.bytes };
    }
    const tmp = join(root, `.incoming-${prepared.name}-${randomBytes(4).toString("hex")}`);
    await budget.run("opprette midlertidig katalog", () => this.fs.mkdir(tmp, { mode: 0o700 }));
    try {
      for (const f of prepared.files) {
        const dest = join(tmp, f.name);
        // asynkront: en kopi på flere GB skal ikke fryse event-løkken (lås-hjerteslag, signaler). Fra et åpnet håndtak uten å følge symlenker (F13), mot det forhåndssjekken målte.
        await budget.run(`kopiere ${f.name}`, () => this.fs.copyFile(join(prepared.dir, f.name), dest, { size: f.size, sha256: f.sha256, ageHeader: true }));
        await budget.run(`chmod ${f.name}`, () => this.fs.chmod(dest, 0o600));
      }
      const problems = await this.#hashAll(budget, tmp, prepared);
      if (problems.length > 0) throw new OffsiteError("offsite_verify_failed", `kopien til off-site-målet er ikke identisk: ${problems.slice(0, 4).join("; ")}`);
      await budget.run("publisere (rename)", () => this.fs.rename(tmp, finalDir));
    } catch (err) {
      await bestEffort(() => this.fs.rm(tmp, { recursive: true, force: true }), this.deps.cleanupMs);
      if (err instanceof OffsiteError) throw err;
      throw new OffsiteError("offsite_failed", `kunne ikke kopiere til off-site-målet: ${err?.code ?? "feil"}`);
    }
    return { verification: "sha256", files: prepared.files.length, bytes: prepared.bytes };
  }

  async verify(prepared) {
    const budget = this.#budget();
    const root = await this.#assertTarget(budget);
    const dir = join(root, prepared.name);
    if (!(await this.#exists(budget, dir))) throw new OffsiteError("offsite_verify_failed", "settet finnes ikke i off-site-målet");
    const problems = await this.#hashAll(budget, dir, prepared);
    if (problems.length > 0) throw new OffsiteError("offsite_verify_failed", `off-site-kopien avviker fra det lokale settet: ${problems.slice(0, 6).join("; ")}`);
    return { verification: "sha256", files: prepared.files.length, bytes: prepared.bytes };
  }

  async fetch(name, destDir) {
    if (!SET_NAME_RE.test(name)) throw ineligible("ugyldig settnavn");
    const budget = this.#budget();
    const root = await this.#assertTarget(budget);
    const dir = join(root, name);
    if (!(await this.#exists(budget, dir))) throw new OffsiteError("offsite_failed", "settet finnes ikke i off-site-målet");
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    for (const n of await this.#listAgeFiles(budget, dir)) {
      await budget.run(`kopiere ${n}`, () => this.fs.copyFile(join(dir, n), join(destDir, n)));
      await budget.run(`chmod ${n}`, () => this.fs.chmod(join(destDir, n), 0o600));
    }
    return listAgeFiles(destDir);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
/**
 * @param config resultatet av `parseOffsiteConfig` (ikke null)
 * @param options `run` (injiserbar prosesskjører for tester), `redact` (feiltekst), `sourceDir` (backup-mappen, for «annen enhet»-sjekken), `fs`/`cleanupMs` (filsystem-kall og oppryddingsfrist for den lokale adapteren; kun tester)
 */
export function createOffsiteSink(config, { run, redact = (s) => String(s), sourceDir, fs, cleanupMs } = {}) {
  const runner = run ?? ((file, args, o) => runProcess(file, args, { env: minimalEnv(), ...o }));
  const check = (res, what) => {
    if (res.spawnError) throw new OffsiteError("offsite_failed", `${what}: kunne ikke starte (${res.spawnError}) - er verktøyet installert og i PATH?`);
    if (res.timedOut) throw new OffsiteError("offsite_timeout", `${what}: tidsavbrudd`);
    if (res.code !== 0) throw new OffsiteError("offsite_failed", `${what}: exit ${res.code}: ${redact(String(res.stderr).split("\n").filter(Boolean).slice(-3).join(" "), 200)}`);
    return res;
  };
  const deps = { run: runner, check, sourceDir, fs, cleanupMs };
  if (config.adapter === "rclone") return new RcloneSink(config, deps);
  if (config.adapter === "rsync_ssh") return new RsyncSshSink(config, deps);
  return new LocalSink(config, deps);
}
