import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, envInt, envString } from "./env.mjs";
import { parseHeartbeatConfig } from "./heartbeat.mjs";
import { OffsiteError, parseOffsiteConfig } from "./offsite.mjs";
import { STATUS_FILE } from "./state.mjs";
import { assertAgeRecipient } from "./tools.mjs";

/**
 * WP-C2: all konfigurasjon for den planlagte backupen samlet og validert ett sted. Flagg overstyrer miljø; ALT har en trygg standard (av/dormant) -
 * unntatt `--out`. Hemmeligheter (DB-passord, privat nøkkel) leses ALDRI inn i dette objektet: de blir i miljøet/filene og går kun til underprosessene
 * som trenger dem. Feil i KJERNEN (mappe, roller, intervall, backup-flagg) gir `ConfigError` (exit 1) FØR noe kjører - en misforstått konfig skal være høylytt i
 * dag, ikke om et døgn. Feil i de VALGFRIE delsystemene (off-site, restore-verifisering) stopper derimot aldri selve backupen: de lagres som `offsiteError` /
 * `verifyError`, og tikket rapporterer dem høylytt (egen feilkode, status, /fail-ping) etter at backupen er tatt. En skrivefeil i en off-site-variabel skal ikke koste deg backupen.
 */
export const ROLES = Object.freeze(["backup", "offsite", "verify"]);
/** Et tikk som kommer litt FØR fristen (cron-jitter, sekunder) skal likevel gjelde - men mye mindre enn et tikk, ellers driver kjøretidspunktet. */
export const DUE_TOLERANCE_MS = 120_000;
const DB_NAME = /^[A-Za-z0-9_]{1,63}$/;

export function parseRoles(raw) {
  if (raw === undefined) return new Set(ROLES);
  const parts = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.some((p) => !ROLES.includes(p))) throw new ConfigError(`--roles: forventet en liste av ${ROLES.join(", ")}`);
  return new Set(parts);
}

function oneOf(value, list, name) {
  if (!list.includes(value)) throw new ConfigError(`${name}: forventet en av ${list.join(", ")}`);
  return value;
}

function flagInt(value, name, { min, max }) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name}: forventet heltall ${min}..${max}`);
  return n;
}

export function loadScheduleConfig(flags, env = process.env) {
  if (typeof flags.out !== "string" || flags.out === "") throw new ConfigError("--out <backup-mappe> er påkrevd");
  const out = resolve(flags.out);
  const stateDir = resolve(typeof flags["state-dir"] === "string" ? flags["state-dir"] : envString(env, "JARVIS_BACKUP_STATE_DIR") ?? out);
  const exportRaw = typeof flags["status-export-dir"] === "string" ? flags["status-export-dir"] : envString(env, "JARVIS_BACKUP_STATUS_EXPORT_DIR");
  const roles = parseRoles(flags.roles);
  const mode = oneOf(typeof flags.mode === "string" ? flags.mode : "docker", ["docker", "direct"], "--mode");
  const databases = typeof flags.databases === "string" ? flags.databases.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  if (databases !== undefined && (databases.length === 0 || databases.some((d) => !DB_NAME.test(d)))) throw new ConfigError("--databases: kommaseparerte databasenavn (A-Z a-z 0-9 _)");
  let verify = { identityFile: null, intervalMs: 7 * 86_400_000, source: "local", scratch: null, timeoutMs: 120 * 60_000 };
  let verifyError = null;
  try {
    const source = oneOf(typeof flags["verify-source"] === "string" ? flags["verify-source"] : envString(env, "JARVIS_BACKUP_VERIFY_SOURCE") ?? "local", ["local", "offsite"], "verify-source");
    const scratchHost = envString(env, "JARVIS_BACKUP_VERIFY_SCRATCH_HOST");
    verify = {
      identityFile: envString(env, "JARVIS_BACKUP_VERIFY_IDENTITY_FILE") ?? null,
      intervalMs: envInt(env, "JARVIS_BACKUP_VERIFY_INTERVAL_DAYS", 7, { min: 1, max: 365 }) * 86_400_000,
      source,
      scratch: scratchHost === undefined ? null : {
        host: scratchHost,
        port: envInt(env, "JARVIS_BACKUP_VERIFY_SCRATCH_PORT", 5432, { min: 1, max: 65_535 }),
        user: envString(env, "JARVIS_BACKUP_VERIFY_SCRATCH_USER") ?? "postgres"
      },
      timeoutMs: envInt(env, "JARVIS_BACKUP_VERIFY_TIMEOUT_MINUTES", 120, { min: 5, max: 1440 }) * 60_000
    };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    verifyError = err.message;
  }
  let offsite = null;
  let offsiteError = null;
  try {
    offsite = parseOffsiteConfig(env);
  } catch (err) {
    if (!(err instanceof OffsiteError || err instanceof ConfigError)) throw err;
    offsiteError = err.message;
  }
  if (verifyError === null && verify.source === "offsite" && roles.has("verify") && offsite === null) {
    verifyError = offsiteError === null ? "--verify-source offsite krever en off-site-adapter (JARVIS_BACKUP_OFFSITE_*)" : "--verify-source offsite, men off-site-konfigurasjonen er ugyldig";
  }
  // Review F2: et sett fra fjernmålet er ubetrodd (age er ikke autentisert), og dumpen kjører SQL som SUPERUSER på scratch-serveren. Mot en varig, direkte scratch-server
  // er det ikke akseptabelt - da må restoren gå mot engangs-containeren (nas-restore-verify.sh, uten nettverk) som kastes etterpå.
  if (verifyError === null && verify.source === "offsite" && roles.has("verify") && verify.scratch !== null) {
    verifyError = "JARVIS_BACKUP_VERIFY_SCRATCH_HOST (varig, direkte scratch-server) kan ikke kombineres med kilde off-site: settet fra fjernmålet er ubetrodd og dumpen kjører SQL som superuser på scratch-serveren - la JARVIS_BACKUP_VERIFY_SCRATCH_HOST stå tom (engangs-container) eller bruk kilde local";
  }
  const config = {
    out,
    stateDir,
    statusFile: join(stateDir, STATUS_FILE),
    lockFile: join(stateDir, ".backup-schedule.lock"),
    exportDir: exportRaw === undefined ? null : resolve(exportRaw),
    roles,
    mode,
    composeFile: typeof flags["compose-file"] === "string" ? resolve(flags["compose-file"]) : null,
    host: typeof flags.host === "string" ? flags.host : "127.0.0.1",
    port: flags.port === undefined ? 5432 : flagInt(flags.port, "--port", { min: 1, max: 65_535 }),
    user: typeof flags.user === "string" ? flags.user : null,
    databases,
    intervalMs: envInt(env, "JARVIS_BACKUP_INTERVAL_HOURS", 24, { min: 1, max: 720 }) * 3_600_000,
    retainDays: envInt(env, "JARVIS_BACKUP_RETAIN_DAYS", 30, { min: 1, max: 3650 }),
    retryMs: envInt(env, "JARVIS_BACKUP_RETRY_MINUTES", 30, { min: 5, max: 1440 }) * 60_000,
    maxRunMs: envInt(env, "JARVIS_BACKUP_MAX_RUN_MINUTES", 240, { min: 5, max: 2880 }) * 60_000,
    lockStaleMs: envInt(env, "JARVIS_BACKUP_LOCK_STALE_MINUTES", 360, { min: 10, max: 4320 }) * 60_000,
    verify,
    verifyError,
    offsite,
    offsiteError,
    heartbeat: parseHeartbeatConfig(env),
    force: { backup: flags["force-backup"] === true, offsite: flags["force-offsite"] === true, verify: flags["force-verify"] === true },
    dryRun: flags["dry-run"] === true,
    json: flags.json === true,
    verbose: flags.verbose === true
  };
  return Object.freeze(config);
}

/**
 * Forutsetninger som MÅ stemme før et tikk kjører (ikke ved --dry-run). Kaster `ConfigError`.
 * @param env miljøet underprosessene får (kun lest for tilstedeværelse - verdiene kopieres ikke)
 */
export function assertRunnable(config, env = process.env) {
  if (config.roles.has("backup") || (config.roles.has("offsite") && config.offsite !== null)) {
    try {
      assertAgeRecipient(env.JARVIS_BACKUP_AGE_RECIPIENT);
    } catch {
      throw new ConfigError("JARVIS_BACKUP_AGE_RECIPIENT må være en age-OFFENTLIG nøkkel (age1...): backup uten kryptering nektes, og manifestet krypteres før off-site");
    }
  }
  if (config.roles.has("backup")) {
    if (envString(env, "JARVIS_DB_ADMIN_PASSWORD") === undefined) throw new ConfigError("JARVIS_DB_ADMIN_PASSWORD mangler (kun i miljøet - aldri på kommandolinjen)");
    if (config.mode === "docker" && (config.composeFile === null || !existsSync(config.composeFile))) throw new ConfigError("--mode docker krever --compose-file <eksisterende docker-compose.yml>");
  }
  // Restore-verifisering (identitetsfil, scratch-passord) sjekkes i selve verifiseringssteget: en skrivefeil der skal ikke hindre backupen.
}
