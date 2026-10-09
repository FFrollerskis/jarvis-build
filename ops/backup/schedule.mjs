#!/usr/bin/env node
/**
 * Planlagt backup (WP-C2, OPS-RUNTIME / Fase 10): «forfalt?»-løper. Kalles av cron/DSM/UGOS Task Scheduler eller et systemd-timer-par hvert N. minutt.
 *
 *   tick           --out DIR [--mode docker|direct] [--compose-file F] [--host H --port P --user U] [--databases a,b,c]
 *                  [--state-dir DIR] [--status-export-dir DIR] [--roles backup,offsite,verify] [--verify-source local|offsite]
 *                  [--force-backup] [--force-offsite] [--force-verify] [--dry-run] [--json] [--verbose]
 *   status         --out DIR [--state-dir DIR] [--max-backup-age-hours N] [--max-verify-age-days N] [--require-verify] [--require-offsite] [--json]
 *   offsite-check  --out DIR [--state-dir DIR] [--json]       (leser fjernmålet, verifiserer nyeste sett mot manifestet; skriver ingenting dit)
 *
 * Alt det forfalte avgjøres fra settene på disk + `<state>/backup-status.json`; et tikk uten forfall gjør ingenting. Hemmeligheter kommer KUN fra miljøet
 * (JARVIS_DB_ADMIN_PASSWORD, JARVIS_BACKUP_AGE_RECIPIENT = OFFENTLIG age-nøkkel, JARVIS_SCRATCH_DB_PASSWORD) - aldri argv. Off-site (JARVIS_BACKUP_OFFSITE_*),
 * heartbeat (JARVIS_BACKUP_HEARTBEAT_URL) og restore-verifisering (JARVIS_BACKUP_VERIFY_IDENTITY_FILE) er AV til eieren setter dem. Se
 * docs/remediation/BACKUP_RESTORE_RUNBOOK.md §6 for oppsett, exit-koder og akseptanse (ops/backup/acceptance-ops.sh).
 */
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadScheduleConfig } from "./lib/config.mjs";
import { ConfigError, envInt, envString } from "./lib/env.mjs";
import { OffsiteError, createOffsiteSink, prepareSetForOffsite } from "./lib/offsite.mjs";
import { makeRedactor } from "./lib/redact.mjs";
import { EXIT, buildDefaultDeps, createLogger, findFutureSets, listCompleteSets, runTick } from "./lib/schedule.mjs";
import { EXPORT_FILE, STATUS_FILE, mergePeerVerifyReport, readPeerVerifyReport, readStatusFile } from "./lib/state.mjs";

class UsageError extends Error {}

const SPEC = {
  tick: {
    value: ["out", "mode", "compose-file", "host", "port", "user", "databases", "state-dir", "status-export-dir", "roles", "verify-source"],
    bool: ["force-backup", "force-offsite", "force-verify", "dry-run", "json", "verbose"]
  },
  status: { value: ["out", "state-dir", "max-backup-age-hours", "max-verify-age-days"], bool: ["json", "require-verify", "require-offsite"] },
  "offsite-check": { value: ["out", "state-dir"], bool: ["json", "verbose"] }
};

/** Streng: ukjente flagg (f.eks. skrivefeilen `--force-bakcup`) er en feil, ikke noe som stille ignoreres. */
export function parseArgs(argv, spec) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== "string" || !arg.startsWith("--")) throw new UsageError(`uventet argument: ${String(arg).slice(0, 40)}`);
    const key = arg.slice(2);
    if (spec.bool.includes(key)) {
      flags[key] = true;
    } else if (spec.value.includes(key)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`--${key} krever en verdi`);
      flags[key] = next;
      i++;
    } else {
      throw new UsageError(`ukjent flagg: --${key.slice(0, 40)}`);
    }
  }
  return flags;
}

const print = (value) => console.log(JSON.stringify(value, null, 2));
const hours = (ms) => Math.round((ms / 3_600_000) * 100) / 100;

async function tickCommand(argv, env, injected) {
  const flags = parseArgs(argv, SPEC.tick);
  const config = loadScheduleConfig(flags, env);
  const deps = buildDefaultDeps(config, env, injected.deps ?? {});
  const result = await runTick(config, deps, env);
  if (config.json || config.dryRun || result.actions.length > 0 || result.outcome === "overdue" || result.outcome === "lock_held_too_long" || config.verbose) {
    const { exitCode, ...rest } = result;
    print({ ok: exitCode === EXIT.OK, exit_code: exitCode, ...rest });
  }
  return result.exitCode;
}

/** Den offentlige statuseksporten (den API-containeren monterer `:ro`): finnes den, er den lesbar for andre, og hvor fersk er den? Kun metadata - innholdet skrives ikke ut. */
function exportInfo(env, now) {
  const dir = envString(env, "JARVIS_BACKUP_STATUS_EXPORT_DIR");
  if (dir === undefined) return { configured: false };
  const file = join(resolve(dir), EXPORT_FILE);
  try {
    const st = statSync(file);
    let generatedAt = null;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      generatedAt = typeof raw?.generated_at === "string" ? raw.generated_at : null;
    } catch {
      generatedAt = null;
    }
    return {
      configured: true, present: true, mode: (st.mode & 0o777).toString(8).padStart(4, "0"), world_readable: (st.mode & 0o004) !== 0, generated_at: generatedAt,
      age_minutes: generatedAt === null ? null : Math.round((now.getTime() - Date.parse(generatedAt)) / 60_000)
    };
  } catch {
    return { configured: true, present: false };
  }
}

/** Overvåkingsvennlig status (exit 0 frisk · 3 backup forfalt · 4 restore-verifisering feilet/for gammel · 5 off-site feilet/for gammel). Leser kun; skriver ingenting. */
function statusCommand(argv, env, now) {
  const flags = parseArgs(argv, SPEC.status);
  if (typeof flags.out !== "string") throw new UsageError("--out <backup-mappe> er påkrevd");
  const out = resolve(flags.out);
  const stateDir = resolve(typeof flags["state-dir"] === "string" ? flags["state-dir"] : envString(env, "JARVIS_BACKUP_STATE_DIR") ?? out);
  const intervalH = envInt(env, "JARVIS_BACKUP_INTERVAL_HOURS", 24, { min: 1, max: 720 });
  const maxBackupAgeH = flags["max-backup-age-hours"] === undefined ? intervalH * 1.5 : Number(flags["max-backup-age-hours"]);
  const verifyIntervalD = envInt(env, "JARVIS_BACKUP_VERIFY_INTERVAL_DAYS", 7, { min: 1, max: 365 });
  const maxVerifyAgeD = flags["max-verify-age-days"] === undefined ? verifyIntervalD * 2 : Number(flags["max-verify-age-days"]);
  if (!Number.isFinite(maxBackupAgeH) || maxBackupAgeH <= 0 || !Number.isFinite(maxVerifyAgeD) || maxVerifyAgeD <= 0) throw new UsageError("--max-backup-age-hours/--max-verify-age-days må være positive tall");

  const { status } = readStatusFile(join(stateDir, STATUS_FILE));
  mergePeerVerifyReport(status, readPeerVerifyReport(stateDir), now);
  // Review F5: samme klokkeavvik-vern som tikket. Uten `nowMs` ble et sett datert +400 d «nyeste» med alder -9600 t og `ok: true`. Fremtidsdaterte sett teller ikke som nyeste,
  // og rapporteres som EGEN årsak (de står igjen til eieren fjerner dem: retensjon rører dem ikke).
  const future = findFutureSets(out, now.getTime());
  const newest = listCompleteSets(out, { nowMs: now.getTime() }).at(-1) ?? null;
  const reasons = [];
  const codes = new Set();
  const flag = (code, reason) => {
    codes.add(code);
    reasons.push(reason);
  };

  const ageH = newest === null ? null : hours(now.getTime() - newest.createdMs);
  for (const name of future.slice(-3)) flag(EXIT.OVERDUE, `set_dated_in_future:${name}`);
  if (newest === null) flag(EXIT.OVERDUE, "no_complete_backup_set");
  else if (ageH > maxBackupAgeH) flag(EXIT.OVERDUE, `newest_backup_${ageH}h_old_limit_${maxBackupAgeH}h`);

  const v = status.restore_verify;
  const verifyAgeD = v.last_success_at === null ? null : Math.round(((now.getTime() - Date.parse(v.last_success_at)) / 86_400_000) * 100) / 100;
  if (v.state === "failed") flag(EXIT.VERIFY_FAILED, `restore_verify_failed:${v.last_error_code ?? "verify_failed"}`);
  else if (v.state === "ok" && verifyAgeD !== null && verifyAgeD > maxVerifyAgeD) flag(EXIT.VERIFY_FAILED, `restore_verify_${verifyAgeD}d_old_limit_${maxVerifyAgeD}d`);
  else if (flags["require-verify"] === true && v.state !== "ok") flag(EXIT.VERIFY_FAILED, `restore_verify_${v.state}`);

  const o = status.offsite;
  const offsiteAgeH = o.last_success_at === null ? null : hours(now.getTime() - Date.parse(o.last_success_at));
  if (o.state === "failed") flag(EXIT.OFFSITE_FAILED, `offsite_failed:${o.last_error_code ?? "offsite_failed"}`);
  else if (o.state === "ok" && offsiteAgeH !== null && offsiteAgeH > intervalH * 2.5) flag(EXIT.OFFSITE_FAILED, `offsite_${offsiteAgeH}h_since_last_success`);
  else if (flags["require-offsite"] === true && o.state !== "ok") flag(EXIT.OFFSITE_FAILED, `offsite_${o.state}`);

  // Prioritet: forfalt backup (3) > restore-verifisering (4) > off-site (5).
  const exit = [EXIT.OVERDUE, EXIT.VERIFY_FAILED, EXIT.OFFSITE_FAILED].find((c) => codes.has(c)) ?? EXIT.OK;
  print({
    ok: exit === EXIT.OK,
    exit_code: exit,
    reasons,
    backup: { newest_set: newest?.name ?? null, newest_at: newest?.createdAt ?? null, age_hours: ageH, limit_hours: maxBackupAgeH, future_dated_sets: future, consecutive_failures: status.backup.consecutive_failures, last_error_code: status.backup.last_error_code },
    offsite: { state: o.state, adapter: o.adapter, last_set: o.last_set, last_success_at: o.last_success_at, verification: o.verification, hours_since_success: offsiteAgeH, last_error_code: o.last_error_code },
    restore_verify: {
      state: v.state, last_attempt_at: v.last_attempt_at, last_success_at: v.last_success_at, age_days: verifyAgeD, last_set: v.last_set, tables: v.tables, rows: v.rows, duration_s: v.duration_s,
      fetch_duration_s: v.fetch_duration_s, source: v.source, reported_by: v.reported_by, last_error_code: v.last_error_code
    },
    heartbeat: status.heartbeat,
    config: { backup_interval_hours: intervalH, restore_verify_interval_days: verifyIntervalD },
    export: exportInfo(env, now)
  });
  return exit;
}

async function offsiteCheckCommand(argv, env, injected) {
  const flags = parseArgs(argv, SPEC["offsite-check"]);
  const nowMs = (injected.now ?? (() => new Date()))().getTime();
  const config = loadScheduleConfig({ out: flags.out, "state-dir": flags["state-dir"], roles: "offsite" }, env);
  if (config.offsiteError !== null) {
    print({ configured: true, ok: false, error_code: "offsite_config_invalid", error: makeRedactor(env)(config.offsiteError, 300) });
    return EXIT.OFFSITE_FAILED;
  }
  if (config.offsite === null) {
    print({ configured: false, ok: false, note: "ingen off-site-adapter er satt opp (JARVIS_BACKUP_OFFSITE_*) - BLOCKED_EXTERNAL: mål må velges av eieren" });
    return EXIT.OFFSITE_NOT_CONFIGURED;
  }
  const redact = makeRedactor(env);
  const sink = injected.sink ?? createOffsiteSink(config.offsite, { redact, sourceDir: config.out });
  // Review F5: fremtidsdaterte sett (klokkeavvik) er aldri «nyeste lokale sett» - og nevnes eksplisitt i stedet for å se ut som «ingen sett».
  const future = findFutureSets(config.out, nowMs);
  const newest = listCompleteSets(config.out, { nowMs }).at(-1) ?? null;
  const report = { configured: true, adapter: sink.adapter, target: sink.label, newest_local: newest?.name ?? null, future_dated_sets: future, remote_sets: [], newest_in_remote: false, ok: false, verification: null, files: null, bytes: null, error_code: null };
  try {
    report.remote_sets = await sink.list();
    if (newest === null) throw new OffsiteError("offsite_failed", future.length > 0 ? "ingen lokale sett å sammenligne med: kun sett datert i fremtiden (klokkeavvik ved backup-tidspunktet?)" : "ingen lokale sett å sammenligne med");
    report.newest_in_remote = report.remote_sets.includes(newest.name);
    const prepared = await prepareSetForOffsite(newest.dir, { ...(env.JARVIS_BACKUP_AGE_RECIPIENT ? { recipient: env.JARVIS_BACKUP_AGE_RECIPIENT } : {}) });
    const result = await sink.verify(prepared);
    Object.assign(report, { ok: true, verification: result.verification, files: result.files, bytes: result.bytes });
  } catch (err) {
    report.error_code = err?.code ?? "offsite_failed";
    report.error = redact(err?.message ?? "feil", 300);
  }
  print(report);
  return report.ok ? EXIT.OK : EXIT.OFFSITE_FAILED;
}

export async function main(argv = process.argv.slice(2), env = process.env, injected = {}) {
  const [command, ...rest] = argv;
  try {
    if (command === "tick") return await tickCommand(rest, env, injected);
    if (command === "status") return statusCommand(rest, env, (injected.now ?? (() => new Date()))());
    if (command === "offsite-check") return await offsiteCheckCommand(rest, env, injected);
    console.error("usage: schedule.mjs tick|status|offsite-check --out DIR ... (se filhodet)");
    return EXIT.USAGE;
  } catch (err) {
    const redact = makeRedactor(env);
    const kind = err instanceof ConfigError || err instanceof UsageError || (err instanceof OffsiteError && err.code === "offsite_config_invalid") ? "konfig" : "intern feil";
    createLogger({ redact })("error", "schedule_aborted", { kind, error: String(err?.message ?? err).slice(0, 400) });
    return EXIT.USAGE;
  }
}

// D-372: sammenlign file://-URL-er (Windows ga ellers `main()` som aldri kjørte og en falsk grønn exit 0).
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const forceExit = (code) => {
    // Review F4: en operasjon tikket har gitt opp (hengt disk/nettverksmontering) kan holde event-løkken i live. Tving avslutning etter en kort frist - utskriften er da for lengst
    // skrevet. Timeren er unref'd: en prosess som avslutter av seg selv påvirkes ikke.
    setTimeout(() => process.exit(code), 10_000).unref();
  };
  main().then((code) => { process.exitCode = code; forceExit(code); }).catch((err) => {
    console.error(`[schedule] FEILET: ${String(err?.message ?? err).slice(0, 400)}`);
    process.exitCode = EXIT.USAGE;
    forceExit(EXIT.USAGE);
  });
}
