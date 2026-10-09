import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
 * tikket tok den · 4 restore-verifisering feilet · 5 off-site feilet · (6 = off-site ikke satt opp, kun `offsite-check`).
 */
export const EXIT = Object.freeze({ OK: 0, USAGE: 1, BACKUP_FAILED: 2, OVERDUE: 3, VERIFY_FAILED: 4, OFFSITE_FAILED: 5, OFFSITE_NOT_CONFIGURED: 6 });
export const OVERDUE_FACTOR = 1.5;
export const MAX_OFFSITE_SETS_PER_TICK = 3;
export const ORPHAN_MAX_AGE_MS = 12 * 3_600_000;
const VERIFY_MIN_RETRY_MS = 6 * 3_600_000;

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

/**
 * Komplette sett (gyldig manifest.json), eldste først. Et korrupt manifest får ikke lov til å velte hele tikket. Med `nowMs` hoppes sett som er datert i FREMTIDEN over
 * (klokkeavvik ved backup-tidspunktet): ellers ville et sett datert i 2030 stå som «nyeste» og enten blokkere alle nye backuper - eller utløse en ny backup hvert tikk.
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
      const sizeBytes = Array.isArray(manifest.databases) ? manifest.databases.reduce((sum, d) => sum + (Number.isInteger(d?.size_bytes) ? d.size_bytes : 0), 0) : 0;
      sets.push({ name, dir, manifest, createdMs, createdAt: new Date(createdMs).toISOString(), sizeBytes });
    } catch {
      // ufullstendig (ingen manifest) eller korrupt: ikke et komplett sett
    }
  }
  return sets;
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
      if (typeof value !== "string" || !(key.endsWith("_at") || key === "retry_after")) continue;
      const t = Date.parse(value);
      const limit = key === "retry_after" ? nowMs + 24 * 3_600_000 : nowMs + FUTURE_SKEW_MS;
      if (Number.isFinite(t) && t > limit) {
        obj[key] = null;
        dropped.push(`${section}.${key}`);
      }
    }
  }
  return dropped;
}

/** Settkataloger UTEN manifest (backup som døde midt i) og eldre enn terskelen: rester som ellers fyller disken stille. Manifest = ferdig, så ferdige sett røres ikke. */
export function findOrphanSets(outDir, nowMs, maxAgeMs = ORPHAN_MAX_AGE_MS) {
  if (!existsSync(outDir)) return [];
  const orphans = [];
  for (const name of readdirSync(outDir).filter((n) => SET_NAME_RE.test(n))) {
    const dir = join(outDir, name);
    try {
      if (!statSync(dir).isDirectory() || existsSync(join(dir, "manifest.json"))) continue;
      if (nowMs - statSync(dir).mtimeMs > maxAgeMs) orphans.push(dir);
    } catch {
      // forsvunnet underveis
    }
  }
  return orphans;
}

/** Retensjon: komplette sett eldre enn `retainDays`, men ALLTID det nyeste. */
export function setsToPrune(sets, retainDays, nowMs) {
  const cutoff = nowMs - retainDays * 86_400_000;
  return sets.slice(0, -1).filter((s) => s.createdMs < cutoff);
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
    if (report.stage === "integrity" || report.stage === "manifest") code = "verify_integrity";
    else if (report.stage === "scratch_guard") code = "verify_config_invalid"; // scratch-serveren er ikke tom/kastbar: feilpekt konfig, ikke en feil i settet
    else if (dbs.some((d) => d?.ok === false)) code = "verify_mismatch";
    else code = "verify_failed";
  }
  // Vaktene (manifest, scratch) har faste norske feiltekster uten innhold fra settet: de vises i den interne statusen - «hvorfor» er hele poenget med vakten.
  // Annen verktøyfeil (stderr fra pg_restore/psql kan sitere ubetrodd SQL) kommer aldri hit.
  const guarded = (report.stage === "manifest" || report.stage === "scratch_guard") && typeof report.error === "string";
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
  const lock = deps.acquireLock(config.lockFile, { now, staleMs: config.lockStaleMs, log });
  if (!lock.acquired) {
    log("debug", "tick_skipped_lock_held", { reason: lock.reason, holder_pid: lock.holder?.pid ?? null });
    return { exitCode: EXIT.OK, outcome: "skipped_lock_held", actions: [], failed: [], decisions: {}, newest_set: null, duration_ms: 0 };
  }
  const lockBeat = setInterval(() => void lock.touch(), 60_000);
  lockBeat.unref();
  try {
    return await tickBody();
  } finally {
    clearInterval(lockBeat);
    lock.release();
  }

  async function tickBody() {
    const read = readStatusFile(config.statusFile);
    const status = read.status;
    if (read.problem !== null) log("warn", "status_file_unusable", { problem: read.problem, note: "starter på nytt fra settene på disk" });
    const dropped = dropFutureTimestamps(status, startedMs);
    if (dropped.length > 0) log("warn", "status_timestamps_in_future_dropped", { fields: dropped, note: "klokkeavvik? tidsstempler fremover i tid ble forkastet" });
    for (const name of findFutureSets(config.out, startedMs)) log("warn", "set_dated_in_future", { set: name, note: "teller ikke som nyeste sett (klokkeavvik ved backup-tidspunktet?)" });
    status.created_at ??= iso(t0);
    status.last_tick_at = iso(t0);
    let storeFailed = false;

    const commit = () => {
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
    const decisions = decide(status, readSets());
    const work = decisions.backup.due || decisions.offsite.due || decisions.verify.due;
    if (!work) log("debug", "tick_nothing_due", { decisions });
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
        const result = await deps.backup({ now: t0 });
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
        b.consecutive_failures += 1;
        b.retry_after = iso(new Date(now().getTime() + retryDelayMs(b.consecutive_failures, config.retryMs)));
        b.last_error_code = err instanceof ScheduleError && (err.code === "backup_timeout" || err.code === "backup_failed") ? err.code : "backup_failed";
        b.last_error = deps.redact(err?.message ?? "backup feilet");
        failed.push("backup");
        log("error", "backup_failed", { code: b.last_error_code, consecutive_failures: b.consecutive_failures, error: b.last_error });
      }
      commit();
    }
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
      await offsiteStage(status, failed);
      commit();
    }

    // --- 3. restore-verifisering ---------------------------------------------------------------------------------------------------------------
    const verifyNow = verifyDecision({
      roleEnabled: config.roles.has("verify"), identityConfigured: verifyEnabled, force: config.force.verify, hasSet: readSets().length > 0 || config.verify.source === "offsite",
      status, nowMs: now().getTime(), intervalMs: config.verify.intervalMs, configError: config.verifyError !== null
    });
    decisions.verify = verifyNow;
    if (verifyNow.due) {
      actions.push("verify");
      await ensureStarted();
      await verifyStage(status, failed);
      commit();
    }

    // --- 4. avslutning -------------------------------------------------------------------------------------------------------------------------
    const sets = readSets();
    const newest = sets.at(-1) ?? null;
    const overdue = config.roles.has("backup") && !(backupRan && !failed.includes("backup")) && (newest === null || now().getTime() - newest.createdMs > OVERDUE_FACTOR * config.intervalMs);
    if (actions.length > 0) {
      if (failed.length === 0) await heartbeat.success();
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
    return { exitCode, outcome, actions, failed, decisions, newest_set: newest?.name ?? null, duration_ms: now().getTime() - startedMs };

    function retention() {
      const sets2 = readSets();
      const newest2 = sets2.at(-1) ?? null;
      const orphans = findOrphanSets(config.out, now().getTime());
      for (const dir of orphans) {
        deps.remove(dir);
        log("warn", "orphan_set_removed", { set: dir.split(/[\\/]/).at(-1) ?? "" });
      }
      // Ingen sletting mens kjeden er stille: gamle sett er det eneste vi har hvis backupene har sluttet å komme.
      if (newest2 === null || now().getTime() - newest2.createdMs > 2 * config.intervalMs) {
        status.retention.last_skipped_reason = "pipeline_stale";
        return;
      }
      const prune = setsToPrune(sets2, config.retainDays, now().getTime());
      for (const s of prune) deps.remove(s.dir);
      status.retention.last_skipped_reason = null;
      if (prune.length > 0) {
        status.retention.last_pruned_at = iso(now());
        status.retention.last_pruned_count = prune.length;
        log("info", "retention_pruned", { count: prune.length, sets: prune.map((s) => s.name) });
      }
    }

    async function offsiteStage(st, failures) {
      const o = st.offsite;
      o.last_attempt_at = iso(now());
      commit();
      const sets3 = readSets();
      const newest3 = sets3.at(-1);
      try {
        if (config.offsiteError !== null) throw new OffsiteError("offsite_config_invalid", config.offsiteError);
        // Oversikten brukes bare til etterfylling av eldre sett; feiler den, sendes det nyeste settet likevel (og feiler pushen, rapporteres DEN).
        let remote = null;
        try {
          remote = new Set(await deps.sink.list());
        } catch (err) {
          log("warn", "offsite_list_failed", { code: err?.code ?? "offsite_failed", error: deps.redact(err?.message ?? "") });
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
          try {
            await deps.sink.push(await deps.prepareSet(s.dir, { recipient: deps.recipient }));
            log("info", "offsite_backfilled", { set: s.name });
          } catch (err) {
            log("warn", "offsite_backfill_failed", { set: s.name, code: err?.code ?? "offsite_failed", error: deps.redact(err?.message ?? "") });
          }
        }
      } catch (err) {
        o.state = "failed";
        o.consecutive_failures += 1;
        o.retry_after = iso(new Date(now().getTime() + retryDelayMs(o.consecutive_failures, config.retryMs)));
        o.last_error_code = ["offsite_failed", "offsite_timeout", "offsite_ineligible", "offsite_verify_failed", "offsite_config_invalid"].includes(err?.code) ? err.code : "offsite_failed";
        o.last_error = deps.redact(err?.message ?? "off-site feilet");
        failures.push("offsite");
        log("error", "offsite_failed", { code: o.last_error_code, consecutive_failures: o.consecutive_failures, error: o.last_error });
      }
    }

    async function verifyStage(st, failures) {
      const v = st.restore_verify;
      v.last_attempt_at = iso(now());
      v.reported_by = "local";
      v.source = config.verify.source;
      commit();
      const t1 = now().getTime();
      let tmpRoot = null;
      let fetchSeconds = null;
      let setName = null;
      try {
        if (config.verifyError !== null) throw new ScheduleError("verify_config_invalid", config.verifyError);
        if (config.verify.identityFile === null || !existsSync(config.verify.identityFile)) throw new ScheduleError("verify_config_invalid", "JARVIS_BACKUP_VERIFY_IDENTITY_FILE er ikke satt eller peker på en fil som ikke finnes");
        if (config.verify.scratch !== null && (env.JARVIS_SCRATCH_DB_PASSWORD ?? "") === "") throw new ScheduleError("verify_config_invalid", "JARVIS_SCRATCH_DB_PASSWORD mangler (kreves med JARVIS_BACKUP_VERIFY_SCRATCH_HOST)");
        let setDir;
        if (config.verify.source === "offsite") {
          if (!sinkPresent) throw new ScheduleError("verify_config_invalid", "kilde off-site krever en off-site-adapter");
          const names = await deps.sink.list();
          const name = names.at(-1);
          if (name === undefined) throw new ScheduleError("verify_failed", "ingen sett i off-site-målet å verifisere");
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
        v.consecutive_failures = 0;
        v.retry_after = null;
        v.last_error_code = null;
        v.last_error = null;
        log("info", "verify_completed", { set: setName, duration_s: v.duration_s, tables: v.tables, rows: v.rows });
      } catch (err) {
        v.state = "failed";
        v.consecutive_failures += 1;
        v.retry_after = iso(new Date(now().getTime() + retryDelayMs(v.consecutive_failures, Math.max(config.retryMs, VERIFY_MIN_RETRY_MS))));
        v.last_error_code = ["verify_failed", "verify_timeout", "verify_integrity", "verify_mismatch", "verify_config_invalid"].includes(err?.code) ? err.code : "verify_failed";
        v.last_error = deps.redact(err?.message ?? "verifisering feilet");
        v.duration_s ??= Math.round((now().getTime() - t1) / 1000);
        failures.push("verify");
        log("error", "verify_failed", { code: v.last_error_code, consecutive_failures: v.consecutive_failures, error: v.last_error });
      } finally {
        if (tmpRoot !== null) rmSync(tmpRoot, { recursive: true, force: true });
      }
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
