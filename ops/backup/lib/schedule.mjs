import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DUE_TOLERANCE_MS, assertRunnable } from "./config.mjs";
import { createHeartbeat } from "./heartbeat.mjs";
import { acquireLock } from "./lock.mjs";
import { OffsiteError, SET_NAME_RE, createOffsiteSink, materializeManifest, prepareSetForOffsite } from "./offsite.mjs";
import { runProcess } from "./proc.mjs";
import { makeRedactor } from "./redact.mjs";
import {
  VERIFY_REPORT_FILE, buildExport, buildVerifyReport, mergePeerVerifyReport, readPeerVerifyReport, readStatusFile, writeExport, writeJsonAtomic
} from "./state.mjs";

/**
 * WP-C2 (OPS-RUNTIME / Fase 10): «forfalt?»-løperen for backup. Kalles av cron/systemd hvert N. minutt (`ops/backup/schedule.mjs tick`) og er:
 *  - IDEMPOTENT: avgjør alt fra det som ligger på disk (nyeste KOMPLETTE sett, manifestet er autoriteten) + statusfilen. Et tikk uten forfall gjør ingenting.
 *    Den gamle `nas-backup.sh`-cronen kan leve side om side: et sett den tok teller som ferskt.
 *  - KAPPLØPSSIKKER: lås med foreldet-deteksjon (`lock.mjs`); to tikk tar aldri backup samtidig.
 *  - ÆRLIG: alt som feiler får en oppramset feilkode, en redigert tekst i den interne statusen, en egen exit-kode og (hvis satt opp) et `/fail`-ping.
 *  - Observasjon + planlagt drift - aldri en handling i API-prosessen. API-et leser kun den skrivebeskyttede eksporten.
 *
 * Exit-koder (for cron-mail/overvåking): 0 ok/ingenting forfalt · 1 konfig/intern feil · 2 backup feilet · 3 backup er FORFALT (> 1,5 × intervall) uten at dette
 * tikket tok den - eller låsen holdes av et tikk som har gått langt utover sitt budsjett (hengt kjede) · 4 restore-verifisering feilet · 5 off-site feilet ·
 * (6 = off-site ikke satt opp, kun `offsite-check`).
 */
export const EXIT = Object.freeze({ OK: 0, USAGE: 1, BACKUP_FAILED: 2, OVERDUE: 3, VERIFY_FAILED: 4, OFFSITE_FAILED: 5, OFFSITE_NOT_CONFIGURED: 6 });
export const OVERDUE_FACTOR = 1.5;
export const MAX_OFFSITE_SETS_PER_TICK = 3;
export const ORPHAN_MAX_AGE_MS = 12 * 3_600_000;
/** Retensjon (review F7): de N nyeste settene beholdes ALLTID, og høyst så mange slettes per tikk. */
export const RETENTION_MIN_KEEP = 7;
export const RETENTION_MAX_PRUNE_PER_TICK = 3;
/** Et tikk-gap lengre enn dette (2 × intervall, minst 12 t) regnes som en tidsdiskontinuitet (NAS av, klokke hoppet): retensjonen holdes da i minst et døgn. */
const RETENTION_GAP_FACTOR = 2;
const RETENTION_GAP_MIN_MS = 12 * 3_600_000;
const RETENTION_HOLD_MIN_MS = 24 * 3_600_000;
const VERIFY_MIN_RETRY_MS = 6 * 3_600_000;
/** Tikk-budsjett når konfigen ikke oppgir et (tester som bygger config for hånd): lengre enn noe legitimt tikk, men endelig. */
const DEFAULT_TICK_BUDGET_MS = 10 * 3_600_000;
const WATCHDOG = Symbol("tick-watchdog");

export class ScheduleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
  }
}

const iso = (d) => d.toISOString();
const msOf = (value) => (typeof value === "string" ? Date.parse(value) : Number.NaN);

/** 1× base ved første feil, deretter dobling opp til 8× (30 → 60 → 120 → 240 min ved standard). */
export function retryDelayMs(failures, baseMs) {
  return baseMs * Math.min(2 ** Math.max(0, failures - 1), 8);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Sett på disk
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** Klokkeavvik vi tåler (cron-jitter, NTP-justering) før noe regnes som «datert i fremtiden». */
const FUTURE_SKEW_MS = 5 * 60_000;

const AGE_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.age$/;

/**
 * Review F8: et sett er KOMPLETT først når hver fil manifestet lister faktisk finnes (vanlig fil, ikke symlenke), er ikke tom og har størrelsen manifestet oppgir (globals har ingen
 * størrelse i manifestet: kun «ikke tom»). Bare «gyldig manifest.json» lot et hult sett (filer slettet, kopiert uten dumpene, avkortet) stå som «nyeste» og undertrykke neste backup.
 * Kun `lstat` (ingen hashing: denne kalles flere ganger per tikk); sjekksummer verifiseres der filene faktisk brukes (off-site-forhåndssjekken og restore-verifiseringen).
 * @returns {string[]} tom liste = komplett
 */
export function setFileProblems(dir, manifest) {
  const entries = [];
  if (!Array.isArray(manifest?.databases) || manifest.databases.length === 0) return ["manifestet lister ingen databaser"];
  for (const d of manifest.databases) entries.push({ file: d?.file, size: Number.isInteger(d?.size_bytes) ? d.size_bytes : null });
  entries.push({ file: manifest?.globals?.file, size: null });
  const problems = [];
  for (const { file, size } of entries) {
    if (typeof file !== "string" || !AGE_FILE.test(file)) {
      problems.push("manifestet lister en fil med ugyldig navn");
      continue;
    }
    let st;
    try {
      st = lstatSync(join(dir, file));
    } catch {
      problems.push(`mangler: ${file}`);
      continue;
    }
    if (!st.isFile()) problems.push(`ikke en vanlig fil: ${file}`);
    else if (st.size === 0) problems.push(`tom: ${file}`);
    else if (size !== null && st.size !== size) problems.push(`størrelsen avviker fra manifestet: ${file}`);
  }
  return problems;
}

/**
 * Komplette sett (gyldig manifest.json OG alle filene det lister på plass, se `setFileProblems`), eldste først. Et korrupt manifest får ikke lov til å velte hele tikket. Med `nowMs`
 * hoppes sett som er datert i FREMTIDEN over (klokkeavvik ved backup-tidspunktet): ellers ville et sett datert i 2030 stå som «nyeste» og enten blokkere alle nye backuper - eller
 * utløse en ny backup hvert tikk.
 */
export function listCompleteSets(outDir, { nowMs } = {}) {
  if (!existsSync(outDir)) return [];
  const sets = [];
  for (const name of readdirSync(outDir).filter((n) => SET_NAME_RE.test(n)).sort()) {
    const dir = join(outDir, name);
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
      const createdMs = Date.parse(manifest?.created_at_utc);
      if (!Number.isFinite(createdMs)) continue;
      if (nowMs !== undefined && createdMs > nowMs + FUTURE_SKEW_MS) continue;
      if (setFileProblems(dir, manifest).length > 0) continue;
      const sizeBytes = Array.isArray(manifest.databases) ? manifest.databases.reduce((sum, d) => sum + (Number.isInteger(d?.size_bytes) ? d.size_bytes : 0), 0) : 0;
      sets.push({ name, dir, manifest, createdMs, createdAt: new Date(createdMs).toISOString(), sizeBytes });
    } catch {
      // ufullstendig (ingen manifest) eller korrupt: ikke et komplett sett
    }
  }
  return sets;
}

/** Sett MED gyldig manifest som likevel ikke er komplette (hule: filer mangler/er avkortet) - logges som advarsel og rives aldri automatisk (restene kan være det eneste som er igjen). */
export function findHollowSets(outDir) {
  if (!existsSync(outDir)) return [];
  const hollow = [];
  for (const name of readdirSync(outDir).filter((n) => SET_NAME_RE.test(n)).sort()) {
    try {
      const manifest = JSON.parse(readFileSync(join(outDir, name, "manifest.json"), "utf8"));
      if (!Number.isFinite(Date.parse(manifest?.created_at_utc))) continue;
      const problems = setFileProblems(join(outDir, name), manifest);
      if (problems.length > 0) hollow.push({ name, problems });
    } catch {
      // uten (lesbart) manifest: foreldreløst/korrupt, håndteres andre steder
    }
  }
  return hollow;
}

/** Navn på komplette sett som er datert i fremtiden (klokkeavvik) - logges som advarsel; de teller ikke som «nyeste». */
export function findFutureSets(outDir, nowMs) {
  return listCompleteSets(outDir).filter((s) => s.createdMs > nowMs + FUTURE_SKEW_MS).map((s) => s.name);
}

/** Tidsstempler i statusfilen som ligger i fremtiden (klokkeavvik/redigert fil) forkastes: ellers ville «sist verifisert i 2030» holde en fornyelse borte i årevis. */
export function dropFutureTimestamps(status, nowMs) {
  const dropped = [];
  const sections = { backup: status.backup, retention: status.retention, offsite: status.offsite, restore_verify: status.restore_verify, heartbeat: status.heartbeat };
  for (const [section, obj] of Object.entries(sections)) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== "string" || !(key.endsWith("_at") || key === "retry_after" || key === "hold_until")) continue;
      const t = Date.parse(value);
      const limit = key === "retry_after" ? nowMs + 24 * 3_600_000 : key === "hold_until" ? nowMs + 7 * 24 * 3_600_000 : nowMs + FUTURE_SKEW_MS;
      if (Number.isFinite(t) && t > limit) {
        obj[key] = null;
        dropped.push(`${section}.${key}`);
      }
    }
  }
  return dropped;
}

const errorCode = (err) => (typeof err?.code === "string" ? err.code : "unknown");

/**
 * Settkataloger UTEN manifest.json (backup som døde midt i) og eldre enn terskelen. Review runde 2 (M3): tidligere ble hver slik katalog `rm -rf`-et, FØR alle pausene og uten tak, og
 * «mangler manifest» ble avgjort med `existsSync` - som gir `false` ved ENHVER feil (EACCES/EIO/ESTALE på en ustø NFS-/USB-montering), så et GODT sett (også det siste verifiserte) kunne
 * slettes av en forbigående feil. Nå:
 *  - `lstat` med feilkode: BARE `ENOENT` beviser at manifestet mangler; enhver annen feil betyr «vet ikke» og katalogen røres ikke (`unverified`, logges).
 *  - bare ekte kataloger (aldri en symlenke), eldre enn `maxAgeMs` (mtime), og aldri et navn i `protect` (siste verifiserte / off-site-bekreftede sett).
 *  - `removable` er KUN helt tomme kataloger. En katalog uten manifest men med innhold (typisk en avkortet `*.dump.age` etter en backup som døde midt i) kan være det eneste som er igjen
 *    av en backup: den RAPPORTERES (`withData`) og slettes aldri automatisk.
 * Leser kun; sletting gjøres av kalleren (etter pausene, med taket).
 * @returns {{ removable: string[], withData: Array<{ name: string, entries: number }>, unverified: Array<{ name: string, code: string }> }}
 */
export function scanManifestlessSets(outDir, nowMs, { maxAgeMs = ORPHAN_MAX_AGE_MS, protect = [] } = {}) {
  const result = { removable: [], withData: [], unverified: [] };
  let names;
  try {
    names = readdirSync(outDir).filter((n) => SET_NAME_RE.test(n)).sort();
  } catch (err) {
    if (errorCode(err) !== "ENOENT") result.unverified.push({ name: "(backup-mappen)", code: errorCode(err) });
    return result;
  }
  const protectedNames = new Set(protect.filter((n) => typeof n === "string"));
  for (const name of names) {
    const dir = join(outDir, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || nowMs - st.mtimeMs <= maxAgeMs) continue; // symlenke/fil røres ikke; en ung katalog kan være en backup som pågår
      try {
        lstatSync(join(dir, "manifest.json"));
        continue; // manifestet finnes (gyldig eller ikke): ikke foreldreløst
      } catch (err) {
        if (errorCode(err) !== "ENOENT") {
          result.unverified.push({ name, code: errorCode(err) });
          continue;
        }
      }
      if (protectedNames.has(name)) continue;
      const entries = readdirSync(dir).length;
      if (entries === 0) result.removable.push(dir);
      else result.withData.push({ name, entries });
    } catch (err) {
      if (errorCode(err) !== "ENOENT") result.unverified.push({ name, code: errorCode(err) }); // forsvunnet underveis er greit; alt annet er «vet ikke»
    }
  }
  return result;
}

/** Tomme settkataloger som kan ryddes (se `scanManifestlessSets`). */
export function findOrphanSets(outDir, nowMs, maxAgeMs = ORPHAN_MAX_AGE_MS, protect = []) {
  return scanManifestlessSets(outDir, nowMs, { maxAgeMs, protect }).removable;
}

/** `.verify-tmp-XXXXXX` (mkdtemp i backup-mappen): arbeidsmappen for en henting fra off-site. Nøyaktig dette mønsteret er vårt. */
export const VERIFY_TMP_RE = /^\.verify-tmp-[A-Za-z0-9]{6}$/;

/**
 * Review F12: arbeidsmapper fra en henting som døde midt i (strøm, kill, vaktbikkje) og aldri ble ryddet - de inneholder krypterte sett og fyller disken stille. Bare ekte kataloger
 * (aldri en symlenke eller fil med samme navn) som er eldre enn `maxAgeMs`; kalles under tikk-låsen, så ingen levende verifisering i DETTE tikket bruker dem.
 */
export function findStaleTempDirs(outDir, nowMs, maxAgeMs = ORPHAN_MAX_AGE_MS) {
  if (!existsSync(outDir)) return [];
  const stale = [];
  for (const name of readdirSync(outDir).filter((n) => VERIFY_TMP_RE.test(n)).sort()) {
    try {
      const st = lstatSync(join(outDir, name));
      if (st.isDirectory() && !st.isSymbolicLink() && nowMs - st.mtimeMs > maxAgeMs) stale.push(join(outDir, name));
    } catch {
      // forsvunnet underveis
    }
  }
  return stale;
}

/** `jarvis-backup-20261009T020000Z` -> epoch-ms (UTC); null hvis navnet ikke er en ekte dato (siffer-mønsteret slipper f.eks. `99999999T999999Z` gjennom). */
export function setNameMs(name) {
  const m = /^jarvis-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(name));
  if (m === null) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const back = new Date(ms);
  // Date.UTC ruller over (måned 13, time 25): kun navn som overlever en rundtur er ekte tidspunkt.
  return Number.isFinite(ms) && back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d && back.getUTCHours() === h && back.getUTCMinutes() === mi && back.getUTCSeconds() === se ? ms : null;
}

/**
 * Retensjon: komplette sett STRENGT eldre enn `retainDays`, men aldri de `keepNewest` nyeste (minst 1) og aldri de navngitte i `protect` (siste verifiserte og siste off-site-bekreftede sett:
 * de er det eneste beviset på at en restore faktisk virker / at kopien finnes utenfor huset). Settene er sortert eldste først; resultatet også.
 */
export function setsToPrune(sets, retainDays, nowMs, { keepNewest = 1, protect = [] } = {}) {
  const cutoff = nowMs - retainDays * 86_400_000;
  const keep = new Set(sets.slice(Math.max(0, sets.length - Math.max(1, keepNewest))).map((s) => s.name));
  for (const name of protect) if (typeof name === "string") keep.add(name);
  return sets.filter((s) => !keep.has(s.name) && s.createdMs < cutoff);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// «Forfalt?» - rene beslutninger
// ---------------------------------------------------------------------------------------------------------------------------------------------
const gate = (retryAfter, nowMs, reason) => (retryAfter !== null && nowMs < msOf(retryAfter) ? { due: false, reason: "retry_backoff" } : { due: true, reason });

export function backupDecision({ roleEnabled, force, newestMs, status, nowMs, intervalMs, toleranceMs = DUE_TOLERANCE_MS }) {
  if (!roleEnabled) return { due: false, reason: "role_disabled" };
  if (force) return { due: true, reason: "forced" };
  if (newestMs === null) return gate(status.backup.retry_after, nowMs, "no_backup_exists");
  if (newestMs > nowMs + FUTURE_SKEW_MS) return gate(status.backup.retry_after, nowMs, "newest_set_dated_in_future"); // klokkeavvik: et fremtidsdatert sett er ikke «ferskt»
  if (nowMs - newestMs < intervalMs - toleranceMs) return { due: false, reason: "fresh" };
  return gate(status.backup.retry_after, nowMs, "interval_elapsed");
}

/** Det NYESTE settet sendes alltid (idempotent); gjenta bare når det er nytt, forrige forsøk feilet, eller det er tid for en ny kontroll av kopien. */
export function offsiteDecision({ roleEnabled, sinkPresent, force, newestName, status, nowMs, reverifyMs, configError = false, toleranceMs = DUE_TOLERANCE_MS }) {
  if (!roleEnabled) return { due: false, reason: "role_disabled" };
  // En ugyldig off-site-konfig rapporteres høylytt (med backoff), men stopper aldri selve backupen.
  if (configError) return gate(status.offsite.retry_after, nowMs, "config_invalid");
  if (!sinkPresent) return { due: false, reason: "not_configured" };
  if (newestName === null) return { due: false, reason: "no_set" };
  if (force) return { due: true, reason: "forced" };
  const o = status.offsite;
  if (o.last_set !== newestName) return gate(o.retry_after, nowMs, "new_set");
  if (o.state !== "ok") return gate(o.retry_after, nowMs, "previous_attempt_failed");
  if (o.last_verified_at === null || nowMs - msOf(o.last_verified_at) >= reverifyMs - toleranceMs) return gate(o.retry_after, nowMs, "periodic_reverify");
  return { due: false, reason: "in_sync" };
}

export function verifyDecision({ roleEnabled, identityConfigured, force, hasSet, status, nowMs, intervalMs, configError = false, toleranceMs = DUE_TOLERANCE_MS }) {
  if (!roleEnabled) return { due: false, reason: "role_disabled" };
  if (configError) return gate(status.restore_verify.retry_after, nowMs, "config_invalid");
  if (!identityConfigured) return { due: false, reason: "not_configured" };
  if (!hasSet) return { due: false, reason: "no_set" };
  if (force) return { due: true, reason: "forced" };
  const v = status.restore_verify;
  if (v.state === "failed") return gate(v.retry_after, nowMs, "retry_after_failure");
  if (v.last_success_at === null) return gate(v.retry_after, nowMs, "never_verified");
  if (nowMs - msOf(v.last_success_at) >= intervalMs - toleranceMs) return gate(v.retry_after, nowMs, "interval_elapsed");
  return { due: false, reason: "fresh" };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Logg
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** Strukturert JSON-linje per hendelse på stderr, alltid redigert. `debug` vises bare med --verbose (et tikk uten forfall skal være stille i cron-mail). */
export function createLogger({ redact, verbose = false, write = (line) => process.stderr.write(line) }) {
  const rank = { debug: 0, info: 1, warn: 2, error: 3 };
  return (level, event, fields = {}) => {
    if ((rank[level] ?? 1) < (verbose ? 0 : 1)) return;
    const safe = {};
    for (const [key, value] of Object.entries(fields)) safe[key] = typeof value === "string" ? redact(value, 300) : value;
    write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe })}\n`);
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Standard-implementasjoner (byttes ut i tester)
// ---------------------------------------------------------------------------------------------------------------------------------------------
const tail = (text, n = 3) => String(text).split("\n").filter(Boolean).slice(-n).join(" ");

/** Første «{» til siste «}» - verktøyene skriver ev. loggtekst rundt rapporten. */
export function parseJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const HERE = (rel) => fileURLToPath(new URL(rel, import.meta.url));
/** Git Bash på Windows forstår `C:/…` men ikke alltid `C:\\…` som argument (jf. D-372): bruk skråstrek når vi kaller bash. IKKE verifisert på Windows i dette miljøet. */
const forBash = (p) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);

/** Backup via den eksisterende CLI-en i en egen prosess: kan drepes ved tidsavbrudd (hele prosessgruppen), og er nøyaktig samme vei som `nas-backup.sh`. */
export function defaultBackup(config, env, redact) {
  return async () => {
    const args = [HERE("../jarvis-backup.mjs"), "backup", "--out", config.out, "--mode", config.mode];
    if (config.composeFile !== null) args.push("--compose-file", config.composeFile);
    if (config.mode === "direct") args.push("--host", config.host, "--port", String(config.port));
    if (config.user !== null) args.push("--user", config.user);
    if (config.databases !== undefined) args.push("--databases", config.databases.join(","));
    const res = await runProcess(process.execPath, args, { env: { ...env }, timeoutMs: config.maxRunMs, maxStdout: 1024 * 1024 });
    if (res.timedOut) throw new ScheduleError("backup_timeout", `backup brukte mer enn ${Math.round(config.maxRunMs / 60_000)} min og ble stoppet`);
    if (res.spawnError !== null || res.code !== 0) throw new ScheduleError("backup_failed", `backup avsluttet med exit ${res.code ?? "?"}: ${redact(tail(res.stderr), 240)}`);
    // Aldri stol på exit-koden alene (D-372): krev en OK-rapport.
    const report = parseJsonObject(res.stdout);
    if (report === null || report.ok !== true || typeof report.set !== "string" || !SET_NAME_RE.test(report.set)) throw new ScheduleError("backup_failed", "backup ga ingen gyldig OK-rapport");
    return { name: report.set };
  };
}

/** Restore-verifisering mot en SCRATCH-database/-container (aldri produksjon): `nas-restore-verify.sh` (engangs-container) eller direkte mot en scratch-server. */
export function defaultVerify(config, env) {
  return async ({ setDir, identityFile }) => {
    let res;
    if (config.verify.scratch !== null) {
      const s = config.verify.scratch;
      const args = [HERE("../jarvis-backup.mjs"), "verify", "--set", setDir, "--identity", identityFile, "--scratch-host", s.host, "--scratch-port", String(s.port), "--scratch-user", s.user];
      res = await runProcess(process.execPath, args, { env: { ...env }, timeoutMs: config.verify.timeoutMs });
    } else {
      res = await runProcess("bash", [forBash(HERE("../nas-restore-verify.sh")), forBash(setDir), forBash(identityFile)], { env: { ...env }, timeoutMs: config.verify.timeoutMs });
    }
    if (res.timedOut) throw new ScheduleError("verify_timeout", `restore-verifisering brukte mer enn ${Math.round(config.verify.timeoutMs / 60_000)} min og ble stoppet`);
    const report = parseJsonObject(res.stdout);
    if (report === null) {
      const why = tail(res.stderr, 2);
      throw new ScheduleError("verify_failed", `restore-verifisering ga ingen rapport (exit ${res.code ?? res.spawnError ?? "?"}) - IKKE verifisert${why === "" ? "" : `: ${why}`}`);
    }
    return { report, exitCode: res.code };
  };
}

export function buildDefaultDeps(config, env = process.env, overrides = {}) {
  const now = overrides.now ?? (() => new Date());
  const redact = overrides.redact ?? makeRedactor(env);
  const log = overrides.log ?? createLogger({ redact, verbose: config.verbose });
  const sink = "sink" in overrides ? overrides.sink : config.offsite === null ? null : createOffsiteSink(config.offsite, { redact, sourceDir: config.out });
  return {
    now,
    redact,
    log,
    sink,
    heartbeat: overrides.heartbeat ?? createHeartbeat(config.heartbeat, { now, log }),
    acquireLock: overrides.acquireLock ?? acquireLock,
    backup: overrides.backup ?? defaultBackup(config, env, redact),
    verify: overrides.verify ?? defaultVerify(config, env),
    prepareSet: overrides.prepareSet ?? prepareSetForOffsite,
    materializeManifest: overrides.materializeManifest ?? materializeManifest,
    remove: overrides.remove ?? ((dir) => rmSync(dir, { recursive: true, force: true })),
    // Foreldreløse settkataloger fjernes med `rmdir` (ikke rekursivt): er noe dukket opp i katalogen siden skanningen, feiler fjerningen i stedet for å slette det (review runde 2, M3/L3).
    removeEmptyDir: overrides.removeEmptyDir ?? ((dir) => rmdirSync(dir)),
    recipient: env.JARVIS_BACKUP_AGE_RECIPIENT
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Tikket
// ---------------------------------------------------------------------------------------------------------------------------------------------
function verifyOutcome(result) {
  const report = result.report;
  const dbs = Array.isArray(report.databases) ? report.databases : [];
  const sum = (key) => dbs.reduce((a, d) => a + (Number.isInteger(d?.[key]) ? d[key] : 0), 0);
  const ok = report.ok === true && result.exitCode === 0;
  let code = null;
  if (!ok) {
    if (report.stage === "integrity" || report.stage === "manifest" || report.stage === "globals") code = "verify_integrity";
    else if (report.stage === "scratch_guard") code = "verify_config_invalid"; // scratch-serveren er ikke tom/kastbar: feilpekt konfig, ikke en feil i settet
    else if (dbs.some((d) => d?.ok === false)) code = "verify_mismatch";
    else code = "verify_failed";
  }
  // Vaktene (manifest, scratch, globals) har faste norske feiltekster uten innhold fra settet: de vises i den interne statusen - «hvorfor» er hele poenget med vakten.
  // Annen verktøyfeil (stderr fra pg_restore/psql kan sitere ubetrodd SQL) kommer aldri hit.
  const guarded = (report.stage === "manifest" || report.stage === "scratch_guard" || report.stage === "globals") && typeof report.error === "string";
  return { ok, code, tables: sum("tables_restored"), rows: sum("total_rows_expected"), detail: guarded ? `restore-verifisering stoppet (${report.stage}): ${report.error}`.slice(0, 280) : null };
}

/**
 * Ett tikk. Kaster aldri for forventede feil (de blir exit-kode + status); `ConfigError` fra `assertRunnable` kastes FØR noe kjører.
 * @returns {Promise<{ exitCode: number, outcome: string, actions: string[], failed: string[], decisions: object, newest_set: string | null, duration_ms: number }>}
 */
export async function runTick(config, deps, env = process.env) {
  const { now, log, heartbeat } = deps;
  const t0 = now();
  const startedMs = t0.getTime();
  const verifyEnabled = config.roles.has("verify") && config.verify.identityFile !== null;
  const sinkPresent = deps.sink !== null && deps.sink !== undefined;

  const readSets = () => listCompleteSets(config.out, { nowMs: now().getTime() });
  const decide = (status, sets) => {
    const newest = sets.at(-1) ?? null;
    return {
      backup: backupDecision({ roleEnabled: config.roles.has("backup"), force: config.force.backup, newestMs: newest?.createdMs ?? null, status, nowMs: startedMs, intervalMs: config.intervalMs }),
      offsite: offsiteDecision({
        roleEnabled: config.roles.has("offsite"), sinkPresent, force: config.force.offsite, newestName: newest?.name ?? null, status, nowMs: startedMs, reverifyMs: config.verify.intervalMs,
        configError: config.offsiteError !== null
      }),
      verify: verifyDecision({
        roleEnabled: config.roles.has("verify"), identityConfigured: verifyEnabled, force: config.force.verify, configError: config.verifyError !== null,
        // Fra off-site hentes settet først ved kjøring; da trengs ikke et lokalt sett.
        hasSet: newest !== null || config.verify.source === "offsite",
        status, nowMs: startedMs, intervalMs: config.verify.intervalMs
      })
    };
  };

  if (config.dryRun) {
    const { status } = readStatusFile(config.statusFile);
    const decisions = decide(status, readSets());
    return { exitCode: EXIT.OK, outcome: "dry_run", actions: [], failed: [], decisions, newest_set: readSets().at(-1)?.name ?? null, duration_ms: 0 };
  }

  assertRunnable(config, env);
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 }); // første kjøring på en ny maskin: mappen for lås + status finnes ikke ennå
  const budgetMs = config.tickBudgetMs ?? DEFAULT_TICK_BUDGET_MS;
  const lock = deps.acquireLock(config.lockFile, { now, staleMs: config.lockStaleMs, log });
  if (!lock.acquired) {
    // Review F4: en lås som holdes lenger enn et tikk kan vare (og lenger enn 2 × intervallet) er ikke «et annet tikk som jobber» - det er en hengt kjede. Stille exit 0 hver 15. minutt
    // var nettopp feilen: backupene stoppet uten at noe varslet. Nå: høylytt feil + exit 3 (cron-mail/overvåking), men aldri noe handling uten låsen.
    const heldSince = Date.parse(lock.holder?.started_at ?? "");
    const heldMs = Number.isFinite(heldSince) ? startedMs - heldSince : null;
    const limitMs = Math.max(2 * config.intervalMs, budgetMs);
    if (heldMs !== null && heldMs > limitMs) {
      log("error", "lock_held_too_long", {
        holder_pid: lock.holder?.pid ?? null, holder_host: lock.holder?.host ?? null, held_hours: Math.round((heldMs / 3_600_000) * 10) / 10, limit_hours: Math.round((limitMs / 3_600_000) * 10) / 10,
        note: "låsen holdes av et tikk som har gått langt utover sitt tidsbudsjett (hengt disk/nettverksmontering/prosess?) - sjekk holderen og avslutt den, eller slett låsfilen hvis prosessen er borte"
      });
      return { exitCode: EXIT.OVERDUE, outcome: "lock_held_too_long", actions: [], failed: [], decisions: {}, newest_set: null, duration_ms: 0 };
    }
    log("debug", "tick_skipped_lock_held", { reason: lock.reason, holder_pid: lock.holder?.pid ?? null });
    return { exitCode: EXIT.OK, outcome: "skipped_lock_held", actions: [], failed: [], decisions: {}, newest_set: null, duration_ms: 0 };
  }
  const lockBeat = setInterval(() => void lock.touch(), 60_000);
  lockBeat.unref();
  // Review F4: tikk-dekkende vaktbikkje. Hver enkelt operasjon har egen frist, men uansett hva som henger (en prosess som ikke dør, en disk, en avhengighet) skal ETT tikk aldri holde låsen
  // utover budsjettet: vaktbikkja gir opp, registrerer feilen på steget som hang, sender /fail, og slipper låsen. Timeren er bevisst IKKE unref'd (da kunne prosessen avslutte stille med exit 0).
  const guard = { abandoned: false, fire: async () => ({ exitCode: EXIT.USAGE, outcome: "failed", actions: [], failed: ["tick"], decisions: {}, newest_set: null, duration_ms: now().getTime() - startedMs }) };
  let watchdogTimer;
  try {
    const timedOut = new Promise((resolve) => { watchdogTimer = setTimeout(() => resolve(WATCHDOG), budgetMs); });
    const first = await Promise.race([tickBody(), timedOut]);
    return first === WATCHDOG ? await guard.fire() : first;
  } finally {
    clearTimeout(watchdogTimer);
    clearInterval(lockBeat);
    lock.release();
  }

  async function tickBody() {
    const read = readStatusFile(config.statusFile);
    const status = read.status;
    if (read.problem !== null) log("warn", "status_file_unusable", { problem: read.problem, note: "starter på nytt fra settene på disk" });
    // Review runde 2 (M4): F7-vernene (siste verifiserte/off-site-bekreftede sett, forrige tikk) HVILER på statusfilen. Er den borte eller ubrukelig, er de nullstilt - og en klokkehopp
    // kunne slettet det siste verifiserte settet. Da pauses retensjonen (`status_unusable`) til en verifisering eller off-site-bekreftelse har skrevet gyldig status på nytt (se `retention`).
    // Gjelder også første kjøring uten status: ingenting slettes før det finnes et bevis, men det blokkerer ikke for alltid (se `retention`).
    if (read.problem !== null || !read.existed) {
      status.retention.status_reset_at = iso(t0);
      if (read.problem === null) {
        const onDisk = readSets().length;
        log(onDisk > 0 ? "warn" : "info", "status_file_missing", { sets_on_disk: onDisk, note: onDisk > 0 ? "statusfilen mangler, men det finnes sett på disk (slettet? ny state-mappe?): retensjonen pauses til en verifisering/off-site-bekreftelse er registrert" : "første kjøring: retensjonen pauses til en verifisering/off-site-bekreftelse er registrert" });
      }
    }
    const dropped = dropFutureTimestamps(status, startedMs);
    if (dropped.length > 0) log("warn", "status_timestamps_in_future_dropped", { fields: dropped, note: "klokkeavvik? tidsstempler fremover i tid ble forkastet" });
    for (const name of findFutureSets(config.out, startedMs)) log("warn", "set_dated_in_future", { set: name, note: "teller ikke som nyeste sett (klokkeavvik ved backup-tidspunktet?)" });
    for (const { name, problems } of findHollowSets(config.out)) log("warn", "set_incomplete", { set: name, problems: problems.slice(0, 4).join("; "), note: "har manifest, men filene stemmer ikke: teller ikke som komplett sett (og undertrykker ikke neste backup) - røres ikke automatisk" });
    // Review runde 2 (M3): kataloger uten manifest MED innhold rapporteres hver gang, men slettes aldri (kan være det eneste som er igjen av en backup); `unverified` = en fs-feil (EACCES/EIO/ESTALE) hindret avgjørelsen.
    const manifestless = scanManifestlessSets(config.out, startedMs);
    for (const o of manifestless.withData) log("warn", "orphan_set_has_data", { set: o.name, entries: o.entries, note: "ingen manifest.json, men innhold (avkortet dump etter en backup som døde midt i?): slettes ikke automatisk - undersøk og fjern for hånd" });
    for (const u of manifestless.unverified) log("warn", "orphan_check_unverified", { set: u.name, code: u.code, note: "kunne ikke avgjøre om manifest.json mangler (ustø disk/NFS?): røres ikke" });
    // Review F12: arbeidsmapper fra en off-site-henting som døde midt i. Under låsen finnes ingen levende bruker av dem; alderen (minst 12 t og minst tikk-budsjettet) beskytter mot et
    // tikk vi har tatt over låsen fra og som mot formodning fortsatt kjører.
    for (const dir of findStaleTempDirs(config.out, startedMs, Math.max(ORPHAN_MAX_AGE_MS, budgetMs))) {
      try {
        deps.remove(dir);
        log("warn", "stale_tmp_removed", { entry: dir.split(/[\\/]/).at(-1) ?? "", note: "arbeidsmappe fra en avbrutt off-site-henting (ikke ryddet av tikket som laget den)" });
      } catch (err) {
        log("warn", "stale_tmp_remove_failed", { entry: dir.split(/[\\/]/).at(-1) ?? "", code: err?.code ?? "unknown" });
      }
    }
    // Review F7: et langt gap siden forrige tikk (NAS av, eller klokken hoppet fremover) får alle sett til å se «gamle» ut på én gang. Retensjonen holdes da i minst et døgn,
    // så en feil klokke kan rettes (NTP) før noe slettes - et tak per tikk alene stopper det ikke på 15 minutter.
    const previousTickMs = msOf(status.last_tick_at);
    const gapMs = Number.isFinite(previousTickMs) ? startedMs - previousTickMs : 0;
    if (gapMs > Math.max(RETENTION_GAP_FACTOR * config.intervalMs, RETENTION_GAP_MIN_MS)) {
      const holdMs = Math.max(config.intervalMs, RETENTION_HOLD_MIN_MS);
      status.retention.hold_until = iso(new Date(startedMs + holdMs));
      log("warn", "tick_gap_retention_hold", { gap_hours: Math.round((gapMs / 3_600_000) * 10) / 10, hold_hours: Math.round(holdMs / 3_600_000), note: "langt gap siden forrige tikk (NAS av eller klokkehopp?): ingen sletting av gamle sett før holdet utløper" });
    }
    status.created_at ??= iso(t0);
    status.last_tick_at = iso(t0);
    let storeFailed = false;
    let stage = "other"; // hvilket steg som kjører nå (for vaktbikkja): backup | offsite | verify | other

    const writeAll = () => {
      status.updated_at = iso(now());
      try {
        writeJsonAtomic(config.statusFile, status, { mode: 0o600, dirMode: 0o700 });
      } catch (err) {
        storeFailed = true;
        log("error", "status_write_failed", { code: err?.code ?? "unknown" });
      }
      if (config.exportDir !== null) {
        try {
          const sets = readSets();
          const newest = sets.at(-1) ?? null;
          writeExport(config.exportDir, buildExport(status, {
            now: now(), intervalMs: config.intervalMs, verifyIntervalMs: config.verify.intervalMs,
            newest: newest === null ? null : { name: newest.name, createdAt: newest.createdAt, sizeBytes: newest.sizeBytes }, setsOnDisk: sets.length
          }));
        } catch (err) {
          storeFailed = true;
          log("error", "status_export_failed", { code: err?.code ?? "unknown" });
        }
      }
    };
    // Et tikk vaktbikkja har gitt opp skriver ikke lenger (det kunne overskrevet statusen til tikket som har tatt over låsen).
    const commit = () => {
      if (!guard.abandoned) writeAll();
    };
    const recordHeartbeat = () => {
      status.heartbeat = { configured: heartbeat.configured, ...heartbeat.last() };
    };

    // Baseline for tilstandene som følger av konfigurasjonen (aldri en gammel «ok» for noe som er skrudd av).
    status.heartbeat.configured = heartbeat.configured;
    if (!sinkPresent) {
      // En ugyldig off-site-konfig er IKKE «ikke satt opp»: den feilede tilstanden skal stå i hele backoff-vinduet.
      if (config.offsiteError === null) status.offsite.state = "not_configured";
      status.offsite.adapter = null;
    } else {
      status.offsite.adapter = deps.sink.adapter;
      if (status.offsite.state === "not_configured") status.offsite.state = "pending";
    }
    if (status.restore_verify.last_attempt_at === null) status.restore_verify.state = verifyEnabled ? "never_run" : "not_configured";
    if (mergePeerVerifyReport(status, readPeerVerifyReport(config.stateDir), t0)) log("info", "peer_verify_report_merged", { ok: status.restore_verify.state === "ok", set: status.restore_verify.last_set });

    const actions = [];
    const failed = [];
    const retentionSummary = { paused: null, pruned: 0, orphans_removed: 0 }; // hva retensjonen gjorde (eller hvorfor den lot være) i DETTE tikket - synlig i tikkresultatet
    const decisions = decide(status, readSets());
    const work = decisions.backup.due || decisions.offsite.due || decisions.verify.due;
    if (!work) log("debug", "tick_nothing_due", { decisions });
    const abandonedResult = () => ({ exitCode: EXIT.USAGE, outcome: "abandoned", actions, failed, decisions, newest_set: null, retention: retentionSummary, duration_ms: now().getTime() - startedMs });
    guard.fire = async () => {
      guard.abandoned = true;
      const hung = stage;
      const minutes = Math.round(budgetMs / 60_000);
      const why = `tikket brukte mer enn ${minutes} min og ble avbrutt av vaktbikkja (steg: ${hung}) - en hengt prosess, disk eller nettverksmontering?`;
      log("error", "tick_watchdog_fired", { stage: hung, budget_minutes: minutes });
      if (hung === "backup") recordBackupFailure(new ScheduleError("backup_timeout", why));
      else if (hung === "offsite") recordOffsiteFailure(new OffsiteError("offsite_timeout", why));
      else if (hung === "verify") recordVerifyFailure(new ScheduleError("verify_timeout", why), now().getTime());
      else failed.push("tick");
      await heartbeat.fail();
      recordHeartbeat();
      writeAll();
      const exitCode = hung === "backup" ? EXIT.BACKUP_FAILED : hung === "offsite" ? EXIT.OFFSITE_FAILED : hung === "verify" ? EXIT.VERIFY_FAILED : EXIT.USAGE;
      return { exitCode, outcome: "failed", actions, failed, decisions, newest_set: readSets().at(-1)?.name ?? null, duration_ms: now().getTime() - startedMs };
    };
    // «start»-pinget sendes ÉN gang, når tikket faktisk skal gjøre noe (også hvis et steg først blir forfalt underveis).
    let started = false;
    const ensureStarted = async () => {
      if (started) return;
      started = true;
      await heartbeat.start();
      recordHeartbeat();
    };
    if (work) await ensureStarted();
    commit();

    // --- 1. backup + retensjon ----------------------------------------------------------------------------------------------------------------
    let backupRan = false;
    if (decisions.backup.due) {
      backupRan = true;
      actions.push("backup");
      const b = status.backup;
      b.last_attempt_at = iso(now());
      commit();
      log("info", "backup_started", { reason: decisions.backup.reason });
      const b0 = now().getTime();
      try {
        stage = "backup";
        const result = await deps.backup({ now: t0 });
        stage = "other";
        const done = readSets().find((s) => s.name === result.name);
        if (done === undefined) throw new ScheduleError("backup_failed", "backup meldte OK, men settet har ikke et komplett manifest på disk");
        b.last_success_at = iso(now());
        b.last_set = done.name;
        b.duration_s = Math.round((now().getTime() - b0) / 1000);
        b.size_bytes = done.sizeBytes;
        b.consecutive_failures = 0;
        b.retry_after = null;
        b.last_error_code = null;
        b.last_error = null;
        log("info", "backup_completed", { set: done.name, size_bytes: done.sizeBytes, duration_s: b.duration_s });
      } catch (err) {
        stage = "other";
        recordBackupFailure(err);
      }
      commit();
    }
    if (guard.abandoned) return abandonedResult();
    if (config.roles.has("backup")) retention();

    // --- 2. off-site ---------------------------------------------------------------------------------------------------------------------------
    // Beslutningen tas på nytt: et nytt sett fra steg 1 gjør off-site forfalt i SAMME tikk.
    const offsiteNow = offsiteDecision({
      roleEnabled: config.roles.has("offsite"), sinkPresent, force: config.force.offsite, newestName: readSets().at(-1)?.name ?? null, status, nowMs: now().getTime(), reverifyMs: config.verify.intervalMs,
      configError: config.offsiteError !== null
    });
    decisions.offsite = offsiteNow;
    if (offsiteNow.due) {
      actions.push("offsite");
      await ensureStarted();
      await offsiteStage(status);
      commit();
    }
    if (guard.abandoned) return abandonedResult();

    // --- 3. restore-verifisering ---------------------------------------------------------------------------------------------------------------
    const verifyNow = verifyDecision({
      roleEnabled: config.roles.has("verify"), identityConfigured: verifyEnabled, force: config.force.verify, hasSet: readSets().length > 0 || config.verify.source === "offsite",
      status, nowMs: now().getTime(), intervalMs: config.verify.intervalMs, configError: config.verifyError !== null
    });
    decisions.verify = verifyNow;
    if (verifyNow.due) {
      actions.push("verify");
      await ensureStarted();
      await verifyStage(status);
      commit();
    }
    if (guard.abandoned) return abandonedResult();

    // --- 4. avslutning -------------------------------------------------------------------------------------------------------------------------
    const sets = readSets();
    const newest = sets.at(-1) ?? null;
    const overdue = config.roles.has("backup") && !(backupRan && !failed.includes("backup")) && (newest === null || now().getTime() - newest.createdMs > OVERDUE_FACTOR * config.intervalMs);
    if (actions.length > 0) {
      // Review F3: `success` bare når tikket også ender med exit 0. En forfalt backup (exit 3, f.eks. i backoff mens off-site/verify likevel kjørte) er IKKE suksess - monitoren skal få /fail.
      if (failed.length === 0 && !overdue) await heartbeat.success();
      else await heartbeat.fail();
      recordHeartbeat();
    }
    let exitCode = EXIT.OK;
    if (failed.includes("backup")) exitCode = EXIT.BACKUP_FAILED;
    else if (failed.includes("verify")) exitCode = EXIT.VERIFY_FAILED;
    else if (failed.includes("offsite")) exitCode = EXIT.OFFSITE_FAILED;
    else if (overdue) exitCode = EXIT.OVERDUE;
    if (overdue) log("error", "backup_overdue", { newest_set: newest?.name ?? null, newest_at: newest?.createdAt ?? null, interval_hours: config.intervalMs / 3_600_000 });
    commit();
    if (storeFailed && exitCode === EXIT.OK) exitCode = EXIT.USAGE;
    const outcome = failed.length > 0 ? "failed" : overdue ? "overdue" : actions.length > 0 ? "ok" : "nothing_due";
    return { exitCode, outcome, actions, failed, decisions, newest_set: newest?.name ?? null, retention: retentionSummary, duration_ms: now().getTime() - startedMs };

    function retention() {
      if (guard.abandoned) return;
      const nowMs2 = now().getTime();
      const sets2 = readSets();
      const newest2 = sets2.at(-1) ?? null;
      const r = status.retention;
      const pause = (reason) => {
        r.last_skipped_reason = reason;
        retentionSummary.paused = reason;
      };
      // --- PAUSER: i hver av dem slettes ingenting som helst (hverken gamle sett eller foreldreløse kataloger) ---
      // Ingen sletting mens kjeden er stille: gamle sett er det eneste vi har hvis backupene har sluttet å komme.
      if (newest2 === null || nowMs2 - newest2.createdMs > 2 * config.intervalMs) {
        pause("pipeline_stale");
        return;
      }
      // Review runde 2 (M4): statusfilen var borte/ubrukelig, så «siste verifiserte/off-site-bekreftede sett» og forrige tikk er glemt. Pauset varer til en vellykket verifisering eller off-site-bekreftelse
      // har skrevet gyldig status på nytt (da er det siste beviset kjent og beskyttet igjen). Uten noen av dem (kun backup-rollen: det finnes ingen bevis å vente på) varer pausen i et døgn -
      // samme hold som etter et langt tikk-gap, så en feil klokke kan rettes - og slippes deretter. Første kjøring uten status går samme vei.
      if (r.status_reset_at !== null) {
        const proofRecorded = status.restore_verify.last_success_set !== null || status.offsite.last_set !== null;
        const proofPossible = verifyEnabled || (sinkPresent && config.roles.has("offsite"));
        const holdOver = nowMs2 >= msOf(r.status_reset_at) + Math.max(config.intervalMs, RETENTION_HOLD_MIN_MS);
        if (proofRecorded || (!proofPossible && holdOver)) {
          r.status_reset_at = null;
          log("info", "retention_status_reset_cleared", { reason: proofRecorded ? "proof_recorded" : "hold_elapsed_without_proof_source" });
        } else {
          const announce = r.last_skipped_reason !== "status_unusable"; // én melding når pausen begynner, ikke hvert 15. minutt (et tikk uten forfall skal være stille)
          pause("status_unusable");
          if (announce) log(read.problem !== null ? "warn" : "info", "retention_paused_status_unusable", { proof_possible: proofPossible, note: "statusfilen var borte/ubrukelig: ingen sletting før en verifisering eller off-site-bekreftelse er registrert" });
          return;
        }
      }
      // Review F7: heller for mange sett enn for få. Slett ingenting mens off-site eller restore-verifisering feiler (da er de lokale settene det eneste bevisste sikkerhetsnettet),
      // eller mens en tidsdiskontinuitet gjør at alt ser gammelt ut.
      if (r.hold_until !== null && nowMs2 < msOf(r.hold_until)) {
        pause("time_gap_hold");
        return;
      }
      if (status.offsite.state === "failed") {
        pause("offsite_failing");
        return;
      }
      if (status.restore_verify.state === "failed") {
        pause("verify_failing");
        return;
      }
      // --- SLETTING: kun etter ALLE pausene, med ÉTT felles tak per tikk (sett først, så foreldreløse) og med de beskyttede settene utelatt ---
      const protect = [status.restore_verify.last_success_set, status.offsite.last_set];
      const candidates = setsToPrune(sets2, config.retainDays, nowMs2, { keepNewest: RETENTION_MIN_KEEP, protect });
      const prune = candidates.slice(0, RETENTION_MAX_PRUNE_PER_TICK); // eldste først
      for (const s of prune) deps.remove(s.dir);
      r.last_skipped_reason = null;
      if (candidates.length > prune.length) {
        log("warn", "retention_prune_capped", { candidates: candidates.length, pruned_now: prune.length, cap: RETENTION_MAX_PRUNE_PER_TICK, note: "mange sett er eldre enn retensjonen (klokkeavvik? nylig senket JARVIS_BACKUP_RETAIN_DAYS?) - resten slettes gradvis" });
      }
      if (prune.length > 0) {
        r.last_pruned_at = iso(now());
        r.last_pruned_count = prune.length;
        retentionSummary.pruned = prune.length;
        log("info", "retention_pruned", { count: prune.length, sets: prune.map((s) => s.name) });
      }
      // Foreldreløse (helt tomme) settkataloger, innenfor det som er igjen av taket. Skannes på nytt her: backupen i dette tikket kan ha tatt timer. Hver fjernes med `rmdir`, så
      // noe som dukket opp siden skanningen aldri slettes.
      const budgetLeft = RETENTION_MAX_PRUNE_PER_TICK - prune.length;
      for (const dir of scanManifestlessSets(config.out, now().getTime(), { protect }).removable.slice(0, Math.max(0, budgetLeft))) {
        try {
          deps.removeEmptyDir(dir);
          retentionSummary.orphans_removed += 1;
          log("warn", "orphan_set_removed", { set: dir.split(/[\\/]/).at(-1) ?? "" });
        } catch (err) {
          log("warn", "orphan_set_remove_failed", { set: dir.split(/[\\/]/).at(-1) ?? "", code: errorCode(err) });
        }
      }
    }

    function recordBackupFailure(err) {
      const b = status.backup;
      b.consecutive_failures += 1;
      b.retry_after = iso(new Date(now().getTime() + retryDelayMs(b.consecutive_failures, config.retryMs)));
      b.last_error_code = err instanceof ScheduleError && (err.code === "backup_timeout" || err.code === "backup_failed") ? err.code : "backup_failed";
      b.last_error = deps.redact(err?.message ?? "backup feilet");
      failed.push("backup");
      log("error", "backup_failed", { code: b.last_error_code, consecutive_failures: b.consecutive_failures, error: b.last_error });
    }

    function recordOffsiteFailure(err) {
      const o = status.offsite;
      o.state = "failed";
      o.consecutive_failures += 1;
      o.retry_after = iso(new Date(now().getTime() + retryDelayMs(o.consecutive_failures, config.retryMs)));
      o.last_error_code = ["offsite_failed", "offsite_timeout", "offsite_ineligible", "offsite_verify_failed", "offsite_config_invalid"].includes(err?.code) ? err.code : "offsite_failed";
      o.last_error = deps.redact(err?.message ?? "off-site feilet");
      failed.push("offsite");
      log("error", "offsite_failed", { code: o.last_error_code, consecutive_failures: o.consecutive_failures, error: o.last_error });
    }

    function recordVerifyFailure(err, startedAtMs) {
      const v = status.restore_verify;
      v.state = "failed";
      v.consecutive_failures += 1;
      v.retry_after = iso(new Date(now().getTime() + retryDelayMs(v.consecutive_failures, Math.max(config.retryMs, VERIFY_MIN_RETRY_MS))));
      v.last_error_code = ["verify_failed", "verify_timeout", "verify_integrity", "verify_mismatch", "verify_config_invalid"].includes(err?.code) ? err.code : "verify_failed";
      v.last_error = deps.redact(err?.message ?? "verifisering feilet");
      v.duration_s ??= Math.round((now().getTime() - startedAtMs) / 1000);
      failed.push("verify");
      log("error", "verify_failed", { code: v.last_error_code, consecutive_failures: v.consecutive_failures, error: v.last_error });
    }

    async function offsiteStage(st) {
      const o = st.offsite;
      o.last_attempt_at = iso(now());
      commit();
      const sets3 = readSets();
      const newest3 = sets3.at(-1);
      stage = "offsite";
      try {
        if (config.offsiteError !== null) throw new OffsiteError("offsite_config_invalid", config.offsiteError);
        // Oversikten brukes bare til etterfylling av eldre sett; feiler den, sendes det nyeste settet likevel (og feiler pushen, rapporteres DEN).
        let remote = null;
        try {
          remote = new Set(await deps.sink.list());
        } catch (err) {
          log("warn", "offsite_list_failed", { code: err?.code ?? "offsite_failed", error: deps.redact(err?.message ?? "") });
        }
        // Review F12: egne foreldede rester i målet (`.incoming-*` etter en kopi som døde midt i). Aldri fatalt: oppryddingen er best effort, og pushen skal ikke avhenge av den.
        if (typeof deps.sink.cleanupStale === "function") {
          try {
            const removed = await deps.sink.cleanupStale();
            if (removed.length > 0) log("warn", "offsite_stale_incoming_removed", { count: removed.length, entries: removed.slice(0, 3).join(","), note: "foreldede rester etter en avbrutt kopi i off-site-målet" });
          } catch (err) {
            log("warn", "offsite_cleanup_failed", { code: err?.code ?? "offsite_failed", error: deps.redact(err?.message ?? "") });
          }
        }
        const older = remote === null ? [] : sets3.slice(0, -1).reverse().filter((s) => !remote.has(s.name)).slice(0, MAX_OFFSITE_SETS_PER_TICK - 1);
        log("info", "offsite_started", { set: newest3.name, adapter: deps.sink.adapter, backfill: older.length });
        const prepared = await deps.prepareSet(newest3.dir, { recipient: deps.recipient });
        const pushed = await deps.sink.push(prepared);
        log("info", "offsite_completed", { set: newest3.name, files: pushed.files, bytes: pushed.bytes, verification: pushed.verification });
        o.state = "ok";
        o.last_set = newest3.name;
        o.last_success_at = iso(now());
        o.last_verified_at = iso(now());
        o.verification = pushed.verification;
        o.consecutive_failures = 0;
        o.retry_after = null;
        o.last_error_code = null;
        o.last_error = null;
        // Etterfyll eldre sett som mangler (nyeste først). Feil her er en advarsel - det nyeste settet er allerede trygt.
        for (const s of older) {
          if (guard.abandoned) break;
          try {
            await deps.sink.push(await deps.prepareSet(s.dir, { recipient: deps.recipient }));
            log("info", "offsite_backfilled", { set: s.name });
          } catch (err) {
            log("warn", "offsite_backfill_failed", { set: s.name, code: err?.code ?? "offsite_failed", error: deps.redact(err?.message ?? "") });
          }
        }
      } catch (err) {
        recordOffsiteFailure(err);
      } finally {
        stage = "other";
      }
    }

    /**
     * Review F11: hvilket sett fra fjernmålet som verifiseres. «Leksikografisk siste navn» lot hvem som helst med skrivetilgang til målet bestemme det: et navn langt frem
     * (`jarvis-backup-99999999T999999Z`) eller et plausibelt navn rett etter det nyeste sorterte sist og ble det «nyeste». Nå: (1) navn som ikke er en ekte dato eller ligger mer enn
     * 5 min frem i tid (klokkeavvik/plantet) er aldri kandidater, og nevnes som advarsel; (2) finnes et lokalt komplett sett, SKAL fjernmålets nyeste (plausible) sett være nøyaktig det -
     * ellers er off-site ikke à jour (eller målet har uventede sett) og ingenting verifiseres i stedet; (3) uten lokale sett (PC med privatnøkkelen) velges det nyeste plausible.
     */
    async function chooseOffsiteSet() {
      const nowMs = now().getTime();
      const plausible = [];
      const implausible = [];
      for (const n of (await deps.sink.list()).slice().sort()) {
        const ms = setNameMs(n);
        (ms !== null && ms <= nowMs + FUTURE_SKEW_MS ? plausible : implausible).push(n);
      }
      if (implausible.length > 0) log("warn", "offsite_set_name_implausible", { count: implausible.length, sets: implausible.slice(-3).join(","), note: "navn som ikke er en ekte dato eller ligger frem i tid er ikke kandidater for verifisering" });
      const remoteNewest = plausible.at(-1);
      const localNewest = readSets().at(-1);
      if (localNewest === undefined) {
        if (remoteNewest === undefined) throw new ScheduleError("verify_failed", "ingen sett i off-site-målet å verifisere");
        return remoteNewest;
      }
      if (remoteNewest === localNewest.name) return remoteNewest;
      if (!plausible.includes(localNewest.name)) {
        throw new ScheduleError("verify_failed", `det nyeste lokale settet (${localNewest.name}) finnes ikke i off-site-målet - kopien er ikke à jour, så et eldre fjernt sett verifiseres ikke i stedet`);
      }
      throw new ScheduleError("verify_failed", `off-site-målet har nyere sett (${remoteNewest}) enn det nyeste lokale (${localNewest.name}) - uventet (annen vert, klokkeavvik eller et plantet navn): ingenting verifiseres`);
    }

    async function verifyStage(st) {
      const v = st.restore_verify;
      v.last_attempt_at = iso(now());
      v.reported_by = "local";
      v.source = config.verify.source;
      commit();
      const t1 = now().getTime();
      let tmpRoot = null;
      let fetchSeconds = null;
      let setName = null;
      stage = "verify";
      try {
        if (config.verifyError !== null) throw new ScheduleError("verify_config_invalid", config.verifyError);
        if (config.verify.identityFile === null || !existsSync(config.verify.identityFile)) throw new ScheduleError("verify_config_invalid", "JARVIS_BACKUP_VERIFY_IDENTITY_FILE er ikke satt eller peker på en fil som ikke finnes");
        if (config.verify.scratch !== null && (env.JARVIS_SCRATCH_DB_PASSWORD ?? "") === "") throw new ScheduleError("verify_config_invalid", "JARVIS_SCRATCH_DB_PASSWORD mangler (kreves med JARVIS_BACKUP_VERIFY_SCRATCH_HOST)");
        let setDir;
        if (config.verify.source === "offsite") {
          if (!sinkPresent) throw new ScheduleError("verify_config_invalid", "kilde off-site krever en off-site-adapter");
          const name = await chooseOffsiteSet();
          mkdirSync(config.out, { recursive: true, mode: 0o700 });
          tmpRoot = mkdtempSync(join(config.out, ".verify-tmp-"));
          setDir = join(tmpRoot, name);
          const f0 = now().getTime();
          await deps.sink.fetch(name, setDir);
          await deps.materializeManifest(setDir, config.verify.identityFile, { env });
          fetchSeconds = Math.round((now().getTime() - f0) / 1000);
          setName = name;
        } else {
          const newest4 = readSets().at(-1);
          if (newest4 === undefined) throw new ScheduleError("verify_failed", "ingen sett å verifisere");
          setDir = newest4.dir;
          setName = newest4.name;
        }
        log("info", "verify_started", { set: setName, source: config.verify.source });
        const v0 = now().getTime();
        const result = await deps.verify({ setDir, identityFile: config.verify.identityFile });
        const outcome = verifyOutcome(result);
        v.duration_s = Math.round((now().getTime() - v0) / 1000);
        v.fetch_duration_s = fetchSeconds;
        v.last_set = setName;
        v.tables = outcome.tables;
        v.rows = outcome.rows;
        if (!outcome.ok) throw new ScheduleError(outcome.code ?? "verify_failed", outcome.detail ?? "restore-verifisering avdekket avvik (se rapporten fra verktøyet)");
        v.state = "ok";
        v.last_success_at = iso(now());
        v.last_success_set = setName;
        v.consecutive_failures = 0;
        v.retry_after = null;
        v.last_error_code = null;
        v.last_error = null;
        log("info", "verify_completed", { set: setName, duration_s: v.duration_s, tables: v.tables, rows: v.rows });
      } catch (err) {
        recordVerifyFailure(err, t1);
      } finally {
        stage = "other";
        if (tmpRoot !== null) rmSync(tmpRoot, { recursive: true, force: true });
      }
      if (guard.abandoned) return;
      // `last_attempt_at` = FERDIG-tidspunktet: da flettes ikke vår egen kvittering tilbake som «ekstern» (mergePeerVerifyReport tar kun NYERE rapporter).
      const finishedAt = iso(now());
      v.last_attempt_at = finishedAt;
      // Kvittering som eieren kan kopiere til NAS-ens state-mappe: kun oppramsede verdier.
      try {
        writeJsonAtomic(join(config.stateDir, VERIFY_REPORT_FILE), buildVerifyReport({
          finished_at: finishedAt, ok: v.state === "ok", set: v.last_set, duration_s: v.duration_s, fetch_duration_s: v.fetch_duration_s,
          tables: v.tables, rows: v.rows, source: v.source, error_code: v.state === "ok" ? null : v.last_error_code
        }), { mode: 0o600, dirMode: 0o700 });
      } catch (err) {
        log("warn", "verify_report_write_failed", { code: err?.code ?? "unknown" });
      }
    }
  }
}
