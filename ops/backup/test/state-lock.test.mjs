import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { acquireLock, classifyLock } from "../lib/lock.mjs";
import {
  EXPORT_FILE, STATUS_SCHEMA, buildExport, buildVerifyReport, emptyStatus, mergePeerVerifyReport, nextBackupDueAt, normalizeStatus, readPeerVerifyReport,
  readStatusFile, writeExport, writeJsonAtomic
} from "../lib/state.mjs";
import { cleanupTempDirs, tempDir } from "./helpers.mjs";

afterAll(cleanupTempDirs);
const NOW = new Date("2026-10-09T03:00:00.000Z");

describe("WP-C2 state: statusfilen er atomisk, 0600, og tåler korrupsjon", () => {
  it("skrives atomisk med modus 0600 (dir 0700) uten tmp-rester, og leses tilbake uendret", () => {
    const dir = tempDir();
    const file = join(dir, "state", "backup-status.json");
    const status = emptyStatus();
    status.backup.last_success_at = NOW.toISOString();
    writeJsonAtomic(file, status);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, "state"))).toEqual(["backup-status.json"]);
    const read = readStatusFile(file);
    expect(read.problem).toBeNull();
    expect(read.status.backup.last_success_at).toBe(NOW.toISOString());
  });

  it("manglende fil = tom status uten problem; korrupt/ukjent skjema/for stor = tom status MED problem (aldri et kast)", () => {
    const dir = tempDir();
    expect(readStatusFile(join(dir, "finnes-ikke.json"))).toMatchObject({ problem: null, existed: false });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ ikke json");
    expect(readStatusFile(bad)).toMatchObject({ problem: "corrupt", existed: true });
    writeFileSync(bad, JSON.stringify({ schema: 99 }));
    expect(readStatusFile(bad).problem).toBe("unsupported_schema");
    writeFileSync(bad, JSON.stringify({ schema: STATUS_SCHEMA, pad: "x".repeat(300_000) }));
    expect(readStatusFile(bad).problem).toBe("too_large");
  });

  it("normalisering forkaster ukjente felt og ugyldige typer/verdier (en redigert fil kan ikke smugle noe inn)", () => {
    const n = normalizeStatus({
      schema: 1, evil: "x", backup: { last_success_at: "ikke-en-dato", last_set: "../../etc/passwd", consecutive_failures: -5, last_error_code: "<script>", size_bytes: 1.5 },
      offsite: { state: "hacked", adapter: "ftp", verification: "magic" }, restore_verify: { state: "ok", source: "mars", tables: "12" }, heartbeat: { configured: "yes", last_ping_kind: "boom" }
    });
    expect(n).not.toHaveProperty("evil");
    expect(n.backup).toMatchObject({ last_success_at: null, last_set: null, consecutive_failures: 0, last_error_code: null, size_bytes: null });
    expect(n.offsite).toMatchObject({ state: "not_configured", adapter: null, verification: null });
    expect(n.restore_verify).toMatchObject({ state: "ok", source: null, tables: null });
    expect(n.heartbeat).toMatchObject({ configured: false, last_ping_kind: null });
  });

  it("eksporten (0644, egen mappe 0755) har KUN oppramsede verdier: ingen fritekst, ingen sti, ingen URL", () => {
    const status = emptyStatus();
    status.created_at = "2026-10-01T00:00:00.000Z";
    status.backup.last_error = "pg_dump: password authentication failed for /volume1/secret/path https://hc-ping.example/KEY";
    status.backup.last_error_code = "backup_failed";
    status.backup.consecutive_failures = 2;
    status.offsite.last_error = "rclone: could not reach b2:bucket/secret";
    status.restore_verify.last_error = "tekst";
    const exported = buildExport(status, {
      now: NOW, intervalMs: 24 * 3_600_000, verifyIntervalMs: 7 * 86_400_000,
      newest: { name: "jarvis-backup-20261009T020000Z", createdAt: "2026-10-09T02:00:00.000Z", sizeBytes: 1234 }, setsOnDisk: 5
    });
    const dir = tempDir();
    const file = writeExport(join(dir, "pub"), exported);
    expect(file).toBe(join(dir, "pub", EXPORT_FILE));
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(statSync(join(dir, "pub")).mode & 0o777).toBe(0o755);
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/password|volume1|https?:|rclone|bucket|secret|last_error"/i);
    const parsed = JSON.parse(text);
    expect(parsed.backup).toMatchObject({ state: "failing", last_set: "jarvis-backup-20261009T020000Z", sets_on_disk: 5, interval_hours: 24, consecutive_failures: 2, last_error_code: "backup_failed" });
    expect(parsed.backup).not.toHaveProperty("last_error");
    expect(parsed.restore_verify.interval_days).toBe(7);
  });

  it("neste forfall = nyeste sett + intervall, men ikke før en evt. backoff", () => {
    expect(nextBackupDueAt("2026-10-09T02:00:00.000Z", 24 * 3_600_000, null)).toBe("2026-10-10T02:00:00.000Z");
    expect(nextBackupDueAt("2026-10-09T02:00:00.000Z", 24 * 3_600_000, "2026-10-11T00:00:00.000Z")).toBe("2026-10-11T00:00:00.000Z");
    expect(nextBackupDueAt(null, 1000, null)).toBeNull();
  });

  it("kvitteringen fra en ekstern verifiserer flettes inn én gang, kun hvis NYERE, og aldri fra fremtiden", () => {
    const status = emptyStatus();
    const report = buildVerifyReport({ finished_at: "2026-10-08T12:00:00.000Z", ok: true, set: "jarvis-backup-20261008T020000Z", duration_s: 95, fetch_duration_s: 20, tables: 358, rows: 10346, source: "offsite" });
    expect(mergePeerVerifyReport(status, report, NOW)).toBe(true);
    expect(status.restore_verify).toMatchObject({ state: "ok", reported_by: "external_verifier", last_success_at: "2026-10-08T12:00:00.000Z", duration_s: 95, tables: 358, rows: 10346, source: "offsite" });
    expect(mergePeerVerifyReport(status, report, NOW)).toBe(false); // idempotent
    const failed = buildVerifyReport({ finished_at: "2026-10-09T01:00:00.000Z", ok: false, set: "jarvis-backup-20261009T020000Z", duration_s: 5, error_code: "verify_mismatch" });
    expect(mergePeerVerifyReport(status, failed, NOW)).toBe(true);
    expect(status.restore_verify).toMatchObject({ state: "failed", consecutive_failures: 1, last_error_code: "verify_mismatch", last_success_at: "2026-10-08T12:00:00.000Z" });
    const future = buildVerifyReport({ finished_at: "2026-12-01T00:00:00.000Z", ok: true, set: "jarvis-backup-20261009T020000Z", duration_s: 1 });
    expect(mergePeerVerifyReport(status, future, NOW)).toBe(false);
    expect(status.restore_verify.state).toBe("failed");
  });

  it("readPeerVerifyReport avviser ugyldig skjema, manglende sett og for store filer", () => {
    const dir = tempDir();
    expect(readPeerVerifyReport(dir)).toBeNull();
    const file = join(dir, "restore-verify-report.json");
    writeFileSync(file, JSON.stringify({ schema: 1, finished_at: NOW.toISOString(), ok: true, set: "../../x", duration_s: 1 }));
    expect(readPeerVerifyReport(dir)).toBeNull();
    writeFileSync(file, JSON.stringify({ schema: 1, finished_at: NOW.toISOString(), ok: true, set: "jarvis-backup-20261009T020000Z", duration_s: 1, source: "local" }));
    expect(readPeerVerifyReport(dir)).toMatchObject({ ok: true, set: "jarvis-backup-20261009T020000Z" });
    writeFileSync(file, "x".repeat(20_000));
    expect(readPeerVerifyReport(dir)).toBeNull();
  });
});

describe("WP-C2 lock: kappløpssikker med foreldet-deteksjon", () => {
  const lockOf = (dir) => join(dir, ".backup-schedule.lock");

  it("første vinner; den andre nektes mens den første lever; frigjøring gjør den ledig igjen", () => {
    const dir = tempDir();
    const a = acquireLock(lockOf(dir), { staleMs: 3_600_000 });
    expect(a.acquired).toBe(true);
    expect(statSync(lockOf(dir)).mode & 0o777).toBe(0o600);
    const b = acquireLock(lockOf(dir), { staleMs: 3_600_000 });
    expect(b).toMatchObject({ acquired: false, reason: "held" });
    expect(b.holder?.pid).toBe(process.pid);
    a.release();
    expect(existsSync(lockOf(dir))).toBe(false);
    expect(acquireLock(lockOf(dir), { staleMs: 3_600_000 }).acquired).toBe(true);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("en lås fra en død prosess på samme vert tas over; en levende holder aldri (uansett alder under grensen)", () => {
    const dir = tempDir();
    writeFileSync(lockOf(dir), `${JSON.stringify({ token: "gammel", pid: 99_999_999, host: "min-vert", started_at: NOW.toISOString() })}\n`);
    const warnings = [];
    const taken = acquireLock(lockOf(dir), { staleMs: 3_600_000, host: "min-vert", alive: () => false, log: (l, e) => warnings.push(e) });
    expect(taken.acquired).toBe(true);
    expect(warnings).toContain("lock_stale_taken_over");
    expect(readdirSync(dir).filter((n) => n.includes("stale-") || n.endsWith(".takeover") || n.endsWith(".tmp"))).toEqual([]);
    taken.release();

    writeFileSync(lockOf(dir), `${JSON.stringify({ token: "levende", pid: process.pid, host: "min-vert", started_at: NOW.toISOString() })}\n`);
    expect(acquireLock(lockOf(dir), { staleMs: 3_600_000, host: "min-vert" })).toMatchObject({ acquired: false, reason: "held" });
  });

  it("utløpt hjerteslag (mtime) tas over selv om pid lever (PID-gjenbruk/hengt løkke); et annet vertsnavn vurderes kun på alder", () => {
    const dir = tempDir();
    writeFileSync(lockOf(dir), `${JSON.stringify({ token: "t1", pid: process.pid, host: "min-vert", started_at: "2026-10-01T00:00:00.000Z" })}\n`);
    const old = new Date(Date.now() - 10 * 3_600_000);
    utimesSync(lockOf(dir), old, old);
    expect(acquireLock(lockOf(dir), { staleMs: 3_600_000, host: "min-vert" }).acquired).toBe(true);

    const dir2 = tempDir();
    writeFileSync(lockOf(dir2), `${JSON.stringify({ token: "t2", pid: 1, host: "annen-vert", started_at: NOW.toISOString() })}\n`);
    expect(acquireLock(lockOf(dir2), { staleMs: 3_600_000, host: "min-vert", alive: () => false })).toMatchObject({ acquired: false, reason: "held" });
  });

  it("classifyLock: ødelagt innhold gir en kort frist (kan være midt i skriving), deretter foreldet", () => {
    const base = { content: null, nowMs: 1_000_000, staleMs: 3_600_000, host: "h" };
    expect(classifyLock({ ...base, mtimeMs: 1_000_000 - 10_000 })).toMatchObject({ stale: false });
    expect(classifyLock({ ...base, mtimeMs: 1_000_000 - 500_000 })).toMatchObject({ stale: true, reason: "malformed" });
  });

  it("touch() fornyer hjerteslaget kun for egen lås; release() sletter aldri en lås vi har mistet", () => {
    const dir = tempDir();
    const a = acquireLock(lockOf(dir), { staleMs: 3_600_000 });
    expect(a.touch()).toBe(true);
    // Noen overtok (simulert): innholdet har en annen token.
    writeFileSync(lockOf(dir), `${JSON.stringify({ token: "andres", pid: process.pid, host: "h", started_at: NOW.toISOString() })}\n`);
    expect(a.touch()).toBe(false);
    a.release();
    expect(existsSync(lockOf(dir))).toBe(true);
    expect(JSON.parse(readFileSync(lockOf(dir), "utf8")).token).toBe("andres");
  });

  it("en gammel takeover-mutex (krasj midt i en overtakelse) ryddes, men blokkerer ikke for alltid", () => {
    const dir = tempDir();
    writeFileSync(lockOf(dir), `${JSON.stringify({ token: "d", pid: 99_999_999, host: "h", started_at: NOW.toISOString() })}\n`);
    writeFileSync(`${lockOf(dir)}.takeover`, `${JSON.stringify({ token: "x", pid: 1, host: "h" })}\n`);
    expect(acquireLock(lockOf(dir), { staleMs: 3_600_000, host: "h", alive: () => false })).toMatchObject({ acquired: false, reason: "takeover_in_progress" });
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(`${lockOf(dir)}.takeover`, old, old);
    acquireLock(lockOf(dir), { staleMs: 3_600_000, host: "h", alive: () => false }); // rydder den gamle mutexen
    expect(acquireLock(lockOf(dir), { staleMs: 3_600_000, host: "h", alive: () => false }).acquired).toBe(true);
  });
});

/** Ekte kappløp: åtte SEPARATE prosesser prøver samtidig. Holderen sitter på låsen lenge nok til at alle forsøk faller innenfor. */
describe("WP-C2 lock: kappløp mellom prosesser", () => {
  const LOCK_MODULE = fileURLToPath(new URL("../lib/lock.mjs", import.meta.url));
  const script = (dir) => {
    const file = join(dir, "worker.mjs");
    writeFileSync(file, `
      import { acquireLock } from ${JSON.stringify(LOCK_MODULE)};
      const lock = acquireLock(process.argv[2], { staleMs: 3_600_000 });
      if (lock.acquired) { console.log("WON"); await new Promise((r) => setTimeout(r, 1500)); lock.release(); } else { console.log("LOST:" + lock.reason); }
    `);
    return file;
  };
  const race = async (dir, n = 8) => {
    const file = script(dir);
    const lock = join(dir, ".backup-schedule.lock");
    const outputs = await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
      const child = spawn(process.execPath, [file, lock], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.on("close", () => resolve(out.trim()));
    })));
    return outputs;
  };

  it("fersk lås: nøyaktig én vinner av åtte", async () => {
    const outputs = await race(tempDir());
    expect(outputs.filter((o) => o === "WON")).toHaveLength(1);
    expect(outputs.filter((o) => o.startsWith("LOST:"))).toHaveLength(7);
  }, 30_000);

  it("foreldet lås (død prosess): nøyaktig én overtaker av åtte - ingen dobbel eier", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".backup-schedule.lock"), `${JSON.stringify({ token: "dod", pid: 99_999_999, host: hostname(), started_at: NOW.toISOString() })}\n`);
    const outputs = await race(dir);
    expect(outputs.filter((o) => o === "WON")).toHaveLength(1);
  }, 30_000);
});
