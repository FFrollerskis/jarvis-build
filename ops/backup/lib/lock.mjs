import { randomBytes } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { hostname as osHostname } from "node:os";

/**
 * WP-C2: kappløpssikker lås for den planlagte backupen (cron-tikk kan overlappe en lang backup, og den gamle `nas-backup.sh`-cronen kan finnes parallelt).
 *
 *  - OPPRETT-HVIS-FRAVÆRENDE er den eneste atomiske primitiven vi bruker for å ERVERVE: innholdet skrives først til en privat staging-fil og publiseres med
 *    `link()` (alt-eller-ingenting, ingen halvskrevet lås kan sees); filsystem uten hardlenker faller tilbake til `open(..., "wx")`.
 *  - HJERTESLAG = mtime på låsfilen (`touch()` hvert minutt mens jobben lever). En lås er foreldet når (a) samme vert og prosessen er borte, eller
 *    (b) mtime er eldre enn `staleMs` (vern mot PID-gjenbruk og en hengt event-loop). Et annet vertsnavn (delt disk) vurderes kun på alder.
 *  - OVERTAKELSE av en foreldet lås skjer under en egen, kortlivet TAKEOVER-mutex (også opprett-hvis-fraværende). Den som holder mutexen leser låsen på nytt,
 *    sjekker at den fortsatt er NØYAKTIG den foreldede (token + mtime), sletter den og publiserer sin egen. En levende lås flyttes/slettes dermed aldri:
 *    mens den foreldede filen ligger der, kan ingen annen publisere, og alle overtakere må innom mutexen. (Tidligere utkast brukte rename-til-gravstein,
 *    som i et 3-veis kappløp kunne flytte en NY, levende lås.)
 *  - FRIGJØRING: kun hvis låsfilen fortsatt er VÅR (token). En lås vi har mistet slettes aldri.
 */
const MALFORMED_GRACE_MS = 120_000;
const TAKEOVER_MUTEX_STALE_MS = 60_000;

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // finnes, men tilhører en annen bruker
  }
}

function parseLock(text) {
  try {
    const c = JSON.parse(text);
    if (c !== null && typeof c === "object" && typeof c.token === "string" && Number.isInteger(c.pid) && typeof c.host === "string") return c;
  } catch {
    // håndteres av kalleren
  }
  return null;
}

/** Ren klassifisering (testbar uten filsystem): `{ stale, reason }`. */
export function classifyLock({ content, mtimeMs, nowMs, staleMs, host, alive = isProcessAlive }) {
  const ageMs = nowMs - mtimeMs;
  if (content === null) return ageMs > MALFORMED_GRACE_MS ? { stale: true, reason: "malformed" } : { stale: false, reason: "malformed_recent" };
  if (content.host === host && !alive(content.pid)) return { stale: true, reason: "dead_holder" };
  if (ageMs > staleMs) return { stale: true, reason: "expired" };
  return { stale: false, reason: "held" };
}

function readLock(file) {
  try {
    const stat = statSync(file);
    return { content: parseLock(readFileSync(file, "utf8")), mtimeMs: stat.mtimeMs };
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** create-if-absent med innholdet komplett fra første synlige øyeblikk. */
function publish(file, body) {
  const staging = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(staging, body, { mode: 0o600, flag: "wx" });
  try {
    linkSync(staging, file);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"].includes(err?.code)) throw err;
    // Filsystem uten hardlenker: eksklusiv opprettelse, samme innhold.
    try {
      const fd = openSync(file, "wx", 0o600);
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (inner) {
      if (inner?.code === "EEXIST") return false;
      throw inner;
    }
  } finally {
    rmSync(staging, { force: true });
  }
}

/**
 * @returns {{ acquired: true, release: () => void, touch: () => boolean, token: string }
 *          | { acquired: false, reason: string, holder: { pid: number | null, host: string | null, started_at: string | null } | null }}
 */
export function acquireLock(file, { now = () => new Date(), staleMs, host = osHostname(), pid = process.pid, alive = isProcessAlive, log = () => undefined } = {}) {
  const token = randomBytes(12).toString("hex");
  const body = `${JSON.stringify({ token, pid, host, started_at: now().toISOString(), tool: "ops/backup/schedule.mjs" })}\n`;
  const mine = () => {
    try {
      return parseLock(readFileSync(file, "utf8"))?.token === token;
    } catch {
      return false;
    }
  };
  const handle = {
    acquired: true,
    token,
    touch() {
      if (!mine()) return false;
      try {
        const t = now();
        utimesSync(file, t, t);
        return true;
      } catch {
        return false;
      }
    },
    release() {
      if (mine()) {
        try {
          unlinkSync(file);
        } catch {
          // allerede borte
        }
      } else {
        log("warn", "lock_lost_before_release", {});
      }
    }
  };
  const holderOf = (content) => (content ? { pid: content.pid, host: content.host, started_at: typeof content.started_at === "string" ? content.started_at : null } : null);

  if (publish(file, body)) return handle;
  const existing = readLock(file);
  if (existing === null) return publish(file, body) ? handle : { acquired: false, reason: "held", holder: null }; // forsvant mellom forsøkene
  const verdict = classifyLock({ content: existing.content, mtimeMs: existing.mtimeMs, nowMs: now().getTime(), staleMs, host, alive });
  if (!verdict.stale) return { acquired: false, reason: verdict.reason, holder: holderOf(existing.content) };

  // --- overtakelse under mutex ---------------------------------------------------------------------------------------------------------------
  const mutex = `${file}.takeover`;
  const mutexBody = `${JSON.stringify({ token, pid, host })}\n`;
  if (!publish(mutex, mutexBody)) {
    const m = readLock(mutex);
    // En mutex holdes i mikrosekunder; en gammel én er en rest etter en krasj midt i en overtakelse.
    if (m !== null && now().getTime() - m.mtimeMs > TAKEOVER_MUTEX_STALE_MS) rmSync(mutex, { force: true });
    return { acquired: false, reason: "takeover_in_progress", holder: holderOf(existing.content) };
  }
  try {
    const again = readLock(file);
    if (again !== null) {
      const same = (again.content?.token ?? null) === (existing.content?.token ?? null) && again.mtimeMs === existing.mtimeMs;
      if (!same) return { acquired: false, reason: "lost_takeover_race", holder: holderOf(again.content) }; // holderen levde likevel (hjerteslag) eller noen andre rakk det
      rmSync(file, { force: true });
      log("warn", "lock_stale_taken_over", { reason: verdict.reason, previous_pid: existing.content?.pid ?? null });
    }
    return publish(file, body) ? handle : { acquired: false, reason: "lost_takeover_race", holder: null };
  } finally {
    rmSync(mutex, { force: true });
  }
}
