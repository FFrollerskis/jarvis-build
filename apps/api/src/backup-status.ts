// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Observation } from "@jarvis/executive";

/**
 * WP-C2 (OPS-RUNTIME / Fase 10): leseren for backup-status i selvdiagnosen (`backup`-området, EV-1). KUN observasjon - API-prosessen tar aldri backup,
 * starter aldri restore og sender aldri noe herfra. Kilden er `backup-status.json` som `ops/backup/schedule.mjs` skriver (atomisk, 0644) i en EGEN mappe
 * som api-containeren monterer `:ro` (infra/backup/docker-compose.backup-status.yml) - aldri selve backup-mappen med de krypterte settene.
 *
 * Tillit: filen er UBETRODD data (CLAUDE.md regel 7). Den leses med størrelsesgrense, valideres felt for felt mot et lukket skjema, og kun oppramsede
 * verdier (tilstander, tidspunkt, tall, feilKODER) kommer videre. Fritekst fra filen når aldri `Observation.detail` - feilkodene oversettes her.
 * Ukjent eller uleselig er UNKNOWN (aldri «frisk»); alder over terskel er en ærlig advarsel (DEGRADED/DOWN), aldri en skjult feil.
 */
export const BACKUP_STATUS_SCHEMA = 1;
export const BACKUP_STATUS_MAX_BYTES = 64 * 1024;

const SET_NAME = /^jarvis-backup-\d{8}T\d{6}Z$/;

const ERROR_LABELS = {
  backup_failed: "backup feilet",
  backup_timeout: "backup ble stoppet (tidsavbrudd)",
  backup_config_invalid: "backup er feilkonfigurert",
  offsite_failed: "off-site-kopi feilet",
  offsite_timeout: "off-site-kopi ble stoppet (tidsavbrudd)",
  offsite_ineligible: "settet ble nektet off-site (inneholder noe som ikke er age-kryptert)",
  offsite_verify_failed: "off-site-kopien stemmer ikke med det lokale settet",
  offsite_config_invalid: "off-site er feilkonfigurert (f.eks. disken er ikke montert)",
  verify_failed: "restore-verifisering feilet",
  verify_timeout: "restore-verifisering ble stoppet (tidsavbrudd)",
  verify_integrity: "backup-filene består ikke integritetssjekken",
  verify_mismatch: "restore ga andre tabeller/radtall enn manifestet",
  verify_config_invalid: "restore-verifisering er feilkonfigurert",
  heartbeat_failed: "ekstern heartbeat feilet",
  internal_error: "intern feil i backup-skriptet"
} as const;
export type BackupErrorCode = keyof typeof ERROR_LABELS;

type Iso = string;
export interface BackupStatusSnapshot {
  generated_at: Iso;
  first_seen_at: Iso | null;
  last_tick_at: Iso | null;
  backup: {
    state: "never" | "ok" | "failing";
    last_set: string | null;
    last_set_at: Iso | null;
    size_bytes: number | null;
    duration_s: number | null;
    sets_on_disk: number;
    interval_hours: number;
    next_due_at: Iso | null;
    consecutive_failures: number;
    last_error_code: BackupErrorCode | null;
  };
  offsite: {
    state: "not_configured" | "pending" | "ok" | "failed";
    adapter: "rclone" | "rsync_ssh" | "local" | null;
    last_success_at: Iso | null;
    last_verified_at: Iso | null;
    last_set: string | null;
    verification: "sha256" | "size_only" | "checksum_dry_run" | null;
    consecutive_failures: number;
    last_error_code: BackupErrorCode | null;
  };
  restore_verify: {
    state: "not_configured" | "never_run" | "ok" | "failed";
    interval_days: number;
    last_attempt_at: Iso | null;
    last_success_at: Iso | null;
    last_set: string | null;
    duration_s: number | null;
    fetch_duration_s: number | null;
    tables: number | null;
    rows: number | null;
    source: "local" | "offsite" | null;
    reported_by: "local" | "external_verifier" | null;
    consecutive_failures: number;
    last_error_code: BackupErrorCode | null;
  };
  heartbeat: {
    configured: boolean;
    last_ping_at: Iso | null;
    last_ping_kind: "start" | "success" | "fail" | null;
    last_ping_ok: boolean | null;
    last_error_code: BackupErrorCode | null;
  };
}

export type BackupStatusRead =
  | { kind: "ok"; snapshot: BackupStatusSnapshot }
  | { kind: "missing" }
  | { kind: "invalid"; reason: "unreadable" | "too_large" | "not_json" | "bad_schema" };

// --- validering (lukket skjema; ukjente felt ignoreres, feil type = null/avvist) ----------------------------------------------------------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const iso = (v: unknown): Iso | null => (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const num = (v: unknown, max = 1e12): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
const int = (v: unknown, max = 1e12): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const setName = (v: unknown): string | null => (typeof v === "string" && SET_NAME.test(v) ? v : null);
const code = (v: unknown): BackupErrorCode | null => (typeof v === "string" && Object.prototype.hasOwnProperty.call(ERROR_LABELS, v) ? (v as BackupErrorCode) : null);
function oneOf<T extends string>(v: unknown, list: readonly T[]): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}

/** `null` når filen ikke er et gyldig skjema-1-dokument. Obligatoriske: seksjonene og `generated_at`; alt annet faller tilbake til null/0. */
export function parseBackupStatus(raw: unknown): BackupStatusSnapshot | null {
  if (!isObj(raw) || raw["schema"] !== BACKUP_STATUS_SCHEMA) return null;
  const generatedAt = iso(raw["generated_at"]);
  const b = raw["backup"];
  const o = raw["offsite"];
  const v = raw["restore_verify"];
  const h = raw["heartbeat"];
  if (generatedAt === null || !isObj(b) || !isObj(o) || !isObj(v) || !isObj(h)) return null;
  const intervalHours = num(b["interval_hours"], 24 * 365);
  const intervalDays = num(v["interval_days"], 3650);
  if (intervalHours === null || intervalHours <= 0 || intervalDays === null || intervalDays <= 0) return null;
  const backupState = oneOf(b["state"], ["never", "ok", "failing"] as const);
  const offsiteState = oneOf(o["state"], ["not_configured", "pending", "ok", "failed"] as const);
  const verifyState = oneOf(v["state"], ["not_configured", "never_run", "ok", "failed"] as const);
  if (backupState === null || offsiteState === null || verifyState === null) return null;
  return {
    generated_at: generatedAt,
    first_seen_at: iso(raw["first_seen_at"]),
    last_tick_at: iso(raw["last_tick_at"]),
    backup: {
      state: backupState, last_set: setName(b["last_set"]), last_set_at: iso(b["last_set_at"]), size_bytes: num(b["size_bytes"]), duration_s: num(b["duration_s"], 1e7),
      sets_on_disk: int(b["sets_on_disk"], 1e6) ?? 0, interval_hours: intervalHours, next_due_at: iso(b["next_due_at"]),
      consecutive_failures: int(b["consecutive_failures"], 1e6) ?? 0, last_error_code: code(b["last_error_code"])
    },
    offsite: {
      state: offsiteState, adapter: oneOf(o["adapter"], ["rclone", "rsync_ssh", "local"] as const), last_success_at: iso(o["last_success_at"]), last_verified_at: iso(o["last_verified_at"]),
      last_set: setName(o["last_set"]), verification: oneOf(o["verification"], ["sha256", "size_only", "checksum_dry_run"] as const),
      consecutive_failures: int(o["consecutive_failures"], 1e6) ?? 0, last_error_code: code(o["last_error_code"])
    },
    restore_verify: {
      state: verifyState, interval_days: intervalDays, last_attempt_at: iso(v["last_attempt_at"]), last_success_at: iso(v["last_success_at"]), last_set: setName(v["last_set"]),
      duration_s: num(v["duration_s"], 1e7), fetch_duration_s: num(v["fetch_duration_s"], 1e7), tables: int(v["tables"]), rows: int(v["rows"]),
      source: oneOf(v["source"], ["local", "offsite"] as const), reported_by: oneOf(v["reported_by"], ["local", "external_verifier"] as const),
      consecutive_failures: int(v["consecutive_failures"], 1e6) ?? 0, last_error_code: code(v["last_error_code"])
    },
    heartbeat: {
      configured: h["configured"] === true, last_ping_at: iso(h["last_ping_at"]), last_ping_kind: oneOf(h["last_ping_kind"], ["start", "success", "fail"] as const),
      last_ping_ok: typeof h["last_ping_ok"] === "boolean" ? h["last_ping_ok"] : null, last_error_code: code(h["last_error_code"])
    }
  };
}

/** Leser statusfilen: størrelsesgrense FØR parsing, kun vanlige filer. Kaster aldri. */
export async function readBackupStatusFile(path: string, maxBytes = BACKUP_STATUS_MAX_BYTES): Promise<BackupStatusRead> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid", reason: "unreadable" };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { kind: "invalid", reason: "unreadable" };
    if (st.size > maxBytes) return { kind: "invalid", reason: "too_large" };
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await handle.read(buf, 0, st.size, 0);
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.subarray(0, bytesRead).toString("utf8"));
    } catch {
      return { kind: "invalid", reason: "not_json" };
    }
    const snapshot = parseBackupStatus(parsed);
    return snapshot === null ? { kind: "invalid", reason: "bad_schema" } : { kind: "ok", snapshot };
  } catch {
    return { kind: "invalid", reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** `JARVIS_BACKUP_STATUS_FILE` (container-sti til den monterte filen). Uten den finnes ingen leser, og området er UKJENT i selvdiagnosen. */
export function backupStatusSourceFromEnv(env: NodeJS.ProcessEnv = process.env): (() => Promise<BackupStatusRead>) | undefined {
  const path = env["JARVIS_BACKUP_STATUS_FILE"]?.trim();
  if (path === undefined || path === "" || path.includes("\0") || !isAbsolute(path)) return undefined;
  return () => readBackupStatusFile(path);
}

// --- tolkning ---------------------------------------------------------------------------------------------------------------------------
export interface BackupThresholds {
  /** Siste backup eldre enn dette × intervallet: DEGRADED / DOWN. */
  backupWarnFactor: number;
  backupDownFactor: number;
  /** Siste off-site-suksess eldre enn dette × backup-intervallet: DEGRADED. */
  offsiteWarnFactor: number;
  /** Siste restore-verifisering eldre enn dette × verifiseringsintervallet (og «aldri verifisert» etter like lang tid): DEGRADED. */
  verifyWarnFactor: number;
  /** Etter så mange mislykkede backup-forsøk på rad: DOWN. */
  backupDownFailures: number;
}
export const DEFAULT_BACKUP_THRESHOLDS: BackupThresholds = { backupWarnFactor: 1.5, backupDownFactor: 3, offsiteWarnFactor: 2.5, verifyWarnFactor: 2, backupDownFailures: 3 };

const SOURCE = "backup-status.json (ops/backup/schedule.mjs)";
const nb1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1).replace(".", ",");
const hoursSince = (now: Date, at: string): number => (now.getTime() - Date.parse(at)) / 3_600_000;
const age = (hours: number): string => (hours >= 48 ? `${nb1(hours / 24)} d` : `${nb1(hours)} t`);
const label = (c: BackupErrorCode | null): string => (c === null ? "ukjent årsak" : ERROR_LABELS[c]);
const INVALID_REASON: Record<string, string> = { unreadable: "filen kan ikke leses", too_large: "filen er for stor", not_json: "ugyldig JSON", bad_schema: "ukjent eller ugyldig format" };

export function observeBackupStatus(read: BackupStatusRead, now: Date, thresholds: BackupThresholds = DEFAULT_BACKUP_THRESHOLDS): Observation {
  if (read.kind === "missing") {
    return { status: "UNKNOWN", source: SOURCE, observed_at: null, detail: "Backup-statusfilen finnes ikke (backup-skriptet har ikke kjørt ennå, eller statusmappen er ikke montert i API-containeren)." };
  }
  if (read.kind === "invalid") {
    return { status: "UNKNOWN", source: SOURCE, observed_at: null, detail: `Backup-statusfilen kunne ikke leses (${INVALID_REASON[read.reason] ?? "ukjent feil"}) - jeg vet ikke hvordan backupen står.` };
  }
  const s = read.snapshot;
  const t = thresholds;
  const problems: Array<{ level: "DEGRADED" | "DOWN"; text: string }> = [];
  const good: string[] = [];
  const remarks: string[] = [];
  const statusAgeH = hoursSince(now, s.generated_at);
  const firstSeenH = s.first_seen_at === null ? 0 : hoursSince(now, s.first_seen_at);
  const interval = s.backup.interval_hours;

  // Selve statusfilen: skrives av hvert tikk. Er den eldre enn 1,5 × intervallet, kjører tikket (cron/systemd) ikke.
  if (statusAgeH > t.backupWarnFactor * interval) problems.push({ level: "DEGRADED", text: `statusfilen er ${age(statusAgeH)} gammel - backup-tikket (cron/systemd) ser ikke ut til å kjøre` });

  // --- backup ---
  const b = s.backup;
  const backupAgeH = b.last_set_at === null ? null : hoursSince(now, b.last_set_at);
  if (backupAgeH === null) {
    problems.push({ level: b.consecutive_failures >= t.backupDownFailures ? "DOWN" : "DEGRADED", text: `ingen komplett backup finnes${b.consecutive_failures > 0 ? ` (${b.consecutive_failures} mislykkede forsøk: ${label(b.last_error_code)})` : " ennå"}` });
  } else if (backupAgeH > t.backupDownFactor * interval) {
    problems.push({ level: "DOWN", text: `siste backup er ${age(backupAgeH)} gammel (forventet hver ${age(interval)}) - backupen har sviktet${b.last_error_code ? `: ${label(b.last_error_code)}` : ""}` });
  } else if (backupAgeH > t.backupWarnFactor * interval) {
    problems.push({ level: "DEGRADED", text: `siste backup er ${age(backupAgeH)} gammel (forventet hver ${age(interval)})${b.last_error_code ? `: ${label(b.last_error_code)}` : ""}` });
  } else {
    good.push(`siste backup for ${age(backupAgeH)} siden (intervall ${age(interval)})`);
  }
  if (b.consecutive_failures > 0 && backupAgeH !== null) {
    problems.push({ level: b.consecutive_failures >= t.backupDownFailures ? "DOWN" : "DEGRADED", text: `siste backup-forsøk feilet (${b.consecutive_failures} på rad: ${label(b.last_error_code)})` });
  }

  // --- off-site ---
  const o = s.offsite;
  if (o.state === "not_configured") remarks.push("INGEN off-site-kopi er satt opp (kun lokal backup)");
  else if (o.state === "pending") remarks.push("off-site er satt opp, men ingen kopi er bekreftet ennå");
  else if (o.state === "failed") problems.push({ level: "DEGRADED", text: `off-site-kopi feilet (${o.consecutive_failures} på rad: ${label(o.last_error_code)})` });
  else if (o.last_success_at === null) remarks.push("off-site er markert OK uten tidspunkt");
  else {
    const offsiteAgeH = hoursSince(now, o.last_success_at);
    if (offsiteAgeH > t.offsiteWarnFactor * interval) problems.push({ level: "DEGRADED", text: `siste vellykkede off-site-kopi er ${age(offsiteAgeH)} gammel` });
    else good.push(`off-site OK (${o.adapter ?? "ukjent adapter"}, ${age(offsiteAgeH)} siden${o.verification === "size_only" ? ", kun størrelse verifisert" : ""})`);
  }

  // --- restore-verifisering ---
  const v = s.restore_verify;
  const verifyIntervalH = v.interval_days * 24;
  const graceExceeded = firstSeenH > t.verifyWarnFactor * verifyIntervalH;
  if (v.state === "failed") problems.push({ level: "DEGRADED", text: `siste restore-verifisering FEILET (${label(v.last_error_code)}) - backupen er ikke bevist gjenopprettbar` });
  else if (v.state === "ok" && v.last_success_at !== null) {
    const verifyAgeH = hoursSince(now, v.last_success_at);
    const detail = `${v.tables ?? "?"} tabeller, ${v.rows ?? "?"} rader${v.duration_s === null ? "" : `, ${v.duration_s} s`}${v.reported_by === "external_verifier" ? ", meldt av ekstern verifiserer" : ""}`;
    if (verifyAgeH > t.verifyWarnFactor * verifyIntervalH) problems.push({ level: "DEGRADED", text: `siste vellykkede restore-verifisering er ${age(verifyAgeH)} gammel (${detail})` });
    else good.push(`restore verifisert for ${age(verifyAgeH)} siden (${detail})`);
  } else if (graceExceeded) problems.push({ level: "DEGRADED", text: `restore er ikke bevist: ingen vellykket restore-verifisering på ${age(firstSeenH)}` });
  else remarks.push("restore er ikke verifisert ennå");

  // --- ekstern heartbeat ---
  const hb = s.heartbeat;
  if (!hb.configured) remarks.push("ekstern heartbeat (dead-man's switch) er ikke satt opp");
  else if (hb.last_ping_ok === false) problems.push({ level: "DEGRADED", text: `ekstern heartbeat feilet (${label(hb.last_error_code)}) - stillhet hos monitoren er det som varsler` });
  else if (hb.last_ping_ok === true) good.push("heartbeat OK");

  const data: Observation["data"] = {
    backup_age_hours: backupAgeH === null ? null : Math.round(backupAgeH * 10) / 10,
    backup_interval_hours: interval,
    backup_consecutive_failures: b.consecutive_failures,
    offsite_state: o.state,
    restore_verify_state: v.state,
    restore_verify_age_days: v.last_success_at === null ? null : Math.round((hoursSince(now, v.last_success_at) / 24) * 10) / 10,
    restore_verify_duration_s: v.duration_s,
    heartbeat_configured: hb.configured,
    status_age_hours: Math.round(statusAgeH * 10) / 10
  };
  const level = problems.some((p) => p.level === "DOWN") ? "DOWN" : problems.length > 0 ? "DEGRADED" : "OK";
  const tail = remarks.length > 0 ? ` [${remarks.join("; ")}]` : "";
  const detail = level === "OK" ? `${good.join("; ")}.${tail}` : `${problems.map((p) => p.text).join(" | ")}.${good.length > 0 ? ` I orden: ${good.join("; ")}.` : ""}${tail}`;
  return { status: level, source: SOURCE, observed_at: s.generated_at, detail, data };
}

/**
 * EV-19-vedlikeholdskatalogen (`MAINTENANCE_CATALOG`) har `backup_status` (daglig) og `disaster_recovery_sample_restore` (månedlig). Dette er `last_run` for dem, så
 * vedlikeholdsdekningen kan vise dem som FAKTISK utført (statusfilen sist skrevet / siste vellykkede restore-verifisering) i stedet for «ukjent».
 */
export function backupMaintenanceLastRun(snapshot: BackupStatusSnapshot): Record<string, string> {
  const out: Record<string, string> = { backup_status: snapshot.generated_at };
  if (snapshot.restore_verify.last_success_at !== null) out["disaster_recovery_sample_restore"] = snapshot.restore_verify.last_success_at;
  return out;
}
