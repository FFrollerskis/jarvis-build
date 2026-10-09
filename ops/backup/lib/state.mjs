import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * WP-C2 (OPS-RUNTIME): statusfilen til den planlagte backupen.
 *
 *  - `<state>/backup-status.json` (0600) er planleggerens INTERNE tilstand: forfall, backoff, siste feil (redigert tekst). Skrives atomisk
 *    (tmp + fsync + rename) slik at en leser aldri ser en halv fil, og en krasj midt i skrivingen aldri ødelegger forrige versjon.
 *  - `<export>/backup-status.json` (0644) er den OFFENTLIGE, skrivebeskyttede kopien API-containeren monterer `:ro`. Den har KUN oppramsede
 *    verdier (tilstander, tidspunkt, tall, feilKODER) - aldri fritekst fra verktøyutdata, aldri stier, aldri URL-er. Verktøyutdata er ubetrodd
 *    tekst (CLAUDE.md regel 7) og skal ikke kunne nå selvdiagnosen/modellen via denne filen.
 *  - `<state>/restore-verify-report.json` skrives av en verifiserer (typisk eierens PC, der den private age-nøkkelen finnes) og kan kopieres til
 *    NAS-ens state-mappe; da flettes den inn i `restore_verify` (merket `external_verifier`).
 */
export const STATUS_SCHEMA = 1;
export const STATUS_FILE = "backup-status.json";
export const EXPORT_FILE = "backup-status.json";
export const VERIFY_REPORT_FILE = "restore-verify-report.json";
export const MAX_STATUS_BYTES = 256 * 1024;

/** Lukket liste: kun disse feilkodene kan stå i den eksporterte filen (og dermed i selvdiagnosen). */
export const ERROR_CODES = Object.freeze([
  "backup_failed", "backup_timeout", "backup_config_invalid",
  "offsite_failed", "offsite_timeout", "offsite_ineligible", "offsite_verify_failed", "offsite_config_invalid",
  "verify_failed", "verify_timeout", "verify_integrity", "verify_mismatch", "verify_config_invalid",
  "heartbeat_failed", "internal_error"
]);
export const OFFSITE_ADAPTERS = Object.freeze(["rclone", "rsync_ssh", "local"]);
export const VERIFICATION_KINDS = Object.freeze(["sha256", "size_only", "checksum_dry_run"]);

const SET_NAME_RE = /^jarvis-backup-\d{8}T\d{6}Z$/;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

const iso = (v) => (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const count = (v, max = 1e12) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const code = (v) => (ERROR_CODES.includes(v) ? v : null);
const setName = (v) => (typeof v === "string" && SET_NAME_RE.test(v) ? v : null);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const text = (v, max = 300) => (typeof v === "string" ? v.slice(0, max) : null);

export function emptyStatus() {
  return {
    schema: STATUS_SCHEMA,
    created_at: null,
    updated_at: null,
    last_tick_at: null,
    backup: {
      last_attempt_at: null, last_success_at: null, last_set: null, duration_s: null, size_bytes: null,
      consecutive_failures: 0, retry_after: null, last_error_code: null, last_error: null
    },
    retention: { last_pruned_at: null, last_pruned_count: 0, last_skipped_reason: null },
    offsite: {
      state: "not_configured", adapter: null, last_attempt_at: null, last_success_at: null, last_verified_at: null, last_set: null,
      verification: null, consecutive_failures: 0, retry_after: null, last_error_code: null, last_error: null
    },
    restore_verify: {
      state: "not_configured", last_attempt_at: null, last_success_at: null, last_set: null, duration_s: null, fetch_duration_s: null,
      tables: null, rows: null, source: null, reported_by: null, consecutive_failures: 0, retry_after: null, last_error_code: null, last_error: null
    },
    heartbeat: { configured: false, last_ping_at: null, last_ping_kind: null, last_ping_ok: null, last_error_code: null }
  };
}

/** Plukker KUN kjente felt med riktig type; alt annet forkastes (en redigert/korrupt fil kan ikke smugle inn ukjente felt). */
export function normalizeStatus(raw) {
  const d = emptyStatus();
  if (raw === null || typeof raw !== "object") return d;
  const b = raw.backup ?? {};
  const r = raw.retention ?? {};
  const o = raw.offsite ?? {};
  const v = raw.restore_verify ?? {};
  const h = raw.heartbeat ?? {};
  return {
    schema: STATUS_SCHEMA,
    created_at: iso(raw.created_at),
    updated_at: iso(raw.updated_at),
    last_tick_at: iso(raw.last_tick_at),
    backup: {
      last_attempt_at: iso(b.last_attempt_at), last_success_at: iso(b.last_success_at), last_set: setName(b.last_set),
      duration_s: count(b.duration_s), size_bytes: count(b.size_bytes), consecutive_failures: count(b.consecutive_failures, 1e6) ?? 0,
      retry_after: iso(b.retry_after), last_error_code: code(b.last_error_code), last_error: text(b.last_error)
    },
    retention: { last_pruned_at: iso(r.last_pruned_at), last_pruned_count: count(r.last_pruned_count, 1e6) ?? 0, last_skipped_reason: text(r.last_skipped_reason, 60) },
    offsite: {
      state: oneOf(o.state, ["not_configured", "pending", "ok", "failed"], d.offsite.state), adapter: oneOf(o.adapter, OFFSITE_ADAPTERS, null),
      last_attempt_at: iso(o.last_attempt_at), last_success_at: iso(o.last_success_at), last_verified_at: iso(o.last_verified_at), last_set: setName(o.last_set),
      verification: oneOf(o.verification, VERIFICATION_KINDS, null), consecutive_failures: count(o.consecutive_failures, 1e6) ?? 0,
      retry_after: iso(o.retry_after), last_error_code: code(o.last_error_code), last_error: text(o.last_error)
    },
    restore_verify: {
      state: oneOf(v.state, ["not_configured", "never_run", "ok", "failed"], d.restore_verify.state),
      last_attempt_at: iso(v.last_attempt_at), last_success_at: iso(v.last_success_at), last_set: setName(v.last_set),
      duration_s: count(v.duration_s), fetch_duration_s: count(v.fetch_duration_s), tables: count(v.tables), rows: count(v.rows),
      source: oneOf(v.source, ["local", "offsite"], null), reported_by: oneOf(v.reported_by, ["local", "external_verifier"], null),
      consecutive_failures: count(v.consecutive_failures, 1e6) ?? 0, retry_after: iso(v.retry_after), last_error_code: code(v.last_error_code), last_error: text(v.last_error)
    },
    heartbeat: {
      configured: h.configured === true, last_ping_at: iso(h.last_ping_at), last_ping_kind: oneOf(h.last_ping_kind, ["start", "success", "fail"], null),
      last_ping_ok: typeof h.last_ping_ok === "boolean" ? h.last_ping_ok : null, last_error_code: code(h.last_error_code)
    }
  };
}

/** Leser statusfilen. Mangler den: tom status. Korrupt/ukjent skjema: tom status + `problem` (kalleren logger høyt; ingenting kastes). */
export function readStatusFile(file) {
  let raw;
  try {
    if (statSync(file).size > MAX_STATUS_BYTES) return { status: emptyStatus(), problem: "too_large", existed: true };
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { status: emptyStatus(), problem: null, existed: false };
    return { status: emptyStatus(), problem: "unreadable", existed: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: emptyStatus(), problem: "corrupt", existed: true };
  }
  if (parsed === null || typeof parsed !== "object" || parsed.schema !== STATUS_SCHEMA) return { status: emptyStatus(), problem: "unsupported_schema", existed: true };
  return { status: normalizeStatus(parsed), problem: null, existed: true };
}

/** Atomisk skriving: tmp i samme mappe (create-exclusive), fsync, eksplisitt chmod (umask kan bare innskrenke), rename. */
export function writeJsonAtomic(file, data, { mode = 0o600, dirMode = 0o700 } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: dirMode });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Frist for neste planlagte backup (informasjon): sist tatte sett + intervall, men ikke før en evt. backoff etter feil. */
export function nextBackupDueAt(newestSetCreatedAt, intervalMs, retryAfter) {
  const base = newestSetCreatedAt === null ? null : Date.parse(newestSetCreatedAt) + intervalMs;
  const retry = retryAfter === null || retryAfter === undefined ? null : Date.parse(retryAfter);
  const due = base === null ? retry : retry === null ? base : Math.max(base, retry);
  return due === null || !Number.isFinite(due) ? null : new Date(due).toISOString();
}

/**
 * Den OFFENTLIGE eksporten (0644, montert `:ro` i API-containeren). `newest` er det nyeste KOMPLETTE settet på disk (manifestet er autoriteten for
 * alder/RPO - ikke planleggerens egen påstand), `null` hvis ingen finnes.
 */
export function buildExport(status, ctx) {
  const { now, intervalMs, verifyIntervalMs, newest, setsOnDisk } = ctx;
  const b = status.backup;
  const o = status.offsite;
  const v = status.restore_verify;
  const h = status.heartbeat;
  return {
    schema: STATUS_SCHEMA,
    generated_at: now.toISOString(),
    first_seen_at: status.created_at,
    last_tick_at: status.last_tick_at,
    backup: {
      state: newest === null ? "never" : b.consecutive_failures > 0 ? "failing" : "ok",
      last_set: newest?.name ?? null,
      last_set_at: newest?.createdAt ?? null,
      size_bytes: newest?.sizeBytes ?? b.size_bytes,
      duration_s: b.duration_s,
      sets_on_disk: setsOnDisk,
      interval_hours: Math.round((intervalMs / 3_600_000) * 100) / 100,
      next_due_at: nextBackupDueAt(newest?.createdAt ?? null, intervalMs, b.retry_after),
      consecutive_failures: b.consecutive_failures,
      last_error_code: b.last_error_code
    },
    offsite: {
      state: o.state, adapter: o.adapter, last_success_at: o.last_success_at, last_verified_at: o.last_verified_at, last_set: o.last_set,
      verification: o.verification, consecutive_failures: o.consecutive_failures, last_error_code: o.last_error_code
    },
    restore_verify: {
      state: v.state, interval_days: Math.round((verifyIntervalMs / 86_400_000) * 100) / 100, last_attempt_at: v.last_attempt_at, last_success_at: v.last_success_at,
      last_set: v.last_set, duration_s: v.duration_s, fetch_duration_s: v.fetch_duration_s, tables: v.tables, rows: v.rows, source: v.source,
      reported_by: v.reported_by, consecutive_failures: v.consecutive_failures, last_error_code: v.last_error_code
    },
    heartbeat: { configured: h.configured, last_ping_at: h.last_ping_at, last_ping_kind: h.last_ping_kind, last_ping_ok: h.last_ping_ok, last_error_code: h.last_error_code }
  };
}

/** Skriver eksporten til `<dir>/backup-status.json` (0644; mappen 0755 - den inneholder KUN denne filen og monteres skrivebeskyttet). */
export function writeExport(dir, exported) {
  const file = join(dir, EXPORT_FILE);
  writeJsonAtomic(file, exported, { mode: 0o644, dirMode: 0o755 });
  return file;
}

/** Verifiserer-rapport (skrives av den som holder den private nøkkelen). Samme disiplin: kun oppramsede verdier. */
export function buildVerifyReport(record) {
  return {
    schema: STATUS_SCHEMA,
    finished_at: iso(record.finished_at),
    ok: record.ok === true,
    set: setName(record.set),
    duration_s: count(record.duration_s),
    fetch_duration_s: count(record.fetch_duration_s ?? null),
    tables: count(record.tables ?? null),
    rows: count(record.rows ?? null),
    source: oneOf(record.source, ["local", "offsite"], null),
    error_code: code(record.error_code ?? null)
  };
}

export function readPeerVerifyReport(stateDir) {
  try {
    const file = join(stateDir, VERIFY_REPORT_FILE);
    if (statSync(file).size > 16 * 1024) return null;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object" || raw.schema !== STATUS_SCHEMA) return null;
    const report = buildVerifyReport(raw);
    return report.finished_at === null || report.set === null ? null : report;
  } catch {
    return null;
  }
}

/**
 * Fletter en ekstern verifiserer-rapport inn i `restore_verify`. Idempotent (tas kun i bruk når den er NYERE enn siste forsøk), og en rapport
 * datert i fremtiden (> 5 min) forkastes - ellers kunne en feil klokke eller en redigert fil «verifisere» frem i tid. Returnerer true hvis den ble brukt.
 */
export function mergePeerVerifyReport(status, report, now) {
  if (report === null) return false;
  const finished = Date.parse(report.finished_at);
  if (finished > now.getTime() + MAX_FUTURE_SKEW_MS) return false;
  const rv = status.restore_verify;
  if (rv.last_attempt_at !== null && finished <= Date.parse(rv.last_attempt_at)) return false;
  rv.last_attempt_at = report.finished_at;
  rv.reported_by = "external_verifier";
  rv.source = report.source;
  rv.duration_s = report.duration_s;
  rv.fetch_duration_s = report.fetch_duration_s;
  rv.tables = report.tables;
  rv.rows = report.rows;
  rv.last_set = report.set;
  rv.retry_after = null;
  if (report.ok) {
    rv.state = "ok";
    rv.last_success_at = report.finished_at;
    rv.consecutive_failures = 0;
    rv.last_error_code = null;
    rv.last_error = null;
  } else {
    rv.state = "failed";
    rv.consecutive_failures += 1;
    rv.last_error_code = report.error_code ?? "verify_failed";
    rv.last_error = null;
  }
  return true;
}
