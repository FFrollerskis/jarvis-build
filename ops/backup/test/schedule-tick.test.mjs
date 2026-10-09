import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError } from "../lib/env.mjs";
import { OffsiteError, prepareSetForOffsite } from "../lib/offsite.mjs";
import { loadScheduleConfig } from "../lib/config.mjs";
import {
  EXIT, ScheduleError, backupDecision, buildDefaultDeps, dropFutureTimestamps, findFutureSets, findHollowSets, findOrphanSets, listCompleteSets, offsiteDecision, retryDelayMs,
  runTick, setFileProblems, setNameMs, setsToPrune, verifyDecision
} from "../lib/schedule.mjs";
import { emptyStatus, readStatusFile } from "../lib/state.mjs";
import { RECIPIENT, cleanupTempDirs, fakeEncryptManifest, hoursAgo, makeSet, tempDir } from "./helpers.mjs";

afterAll(cleanupTempDirs);
const T0 = new Date("2026-10-09T02:00:00.000Z");
const H = 3_600_000;
const D = 24 * H;
const PASSWORD = "test-admin-pw-12345";

function fakeSink({ remote = [] } = {}) {
  const state = { remote: new Set(remote), pushes: [], fetches: [], failWith: null, listFails: false };
  return {
    state, adapter: "local", label: "local:fake",
    list: async () => { if (state.listFails) throw new OffsiteError("offsite_failed", "list feilet"); return [...state.remote].sort(); },
    push: async (prepared) => {
      if (state.failWith) throw state.failWith;
      state.pushes.push(prepared);
      state.remote.add(prepared.name);
      return { verification: "sha256", files: prepared.files.length, bytes: prepared.bytes };
    },
    verify: async (prepared) => ({ verification: "sha256", files: prepared.files.length, bytes: prepared.bytes }),
    fetch: async (name, dest) => {
      state.fetches.push(name);
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "jarvis.dump.age"), "x");
      return ["jarvis.dump.age"];
    }
  };
}

/** Et komplett testoppsett: ekte filsystem (temp), falsk klokke, falsk backup/verify/sink/heartbeat. Ingen nettverk, ingen Postgres. */
function harness({ flags = {}, env = {}, sink = null, identity = false, noHeartbeat = false } = {}) {
  const out = tempDir("wpc2-out-");
  let current = new Date(T0);
  const now = () => new Date(current);
  const identityFile = join(tempDir("wpc2-id-"), "identity.txt");
  writeFileSync(identityFile, "AGE-SECRET-KEY-1TESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTEST\n");
  const baseEnv = { JARVIS_BACKUP_AGE_RECIPIENT: RECIPIENT, JARVIS_DB_ADMIN_PASSWORD: PASSWORD, ...(identity ? { JARVIS_BACKUP_VERIFY_IDENTITY_FILE: identityFile } : {}), ...env };
  const config = loadScheduleConfig({ out, mode: "direct", ...flags }, baseEnv);
  const logs = [];
  const h = {
    out, config, logs, sink, env: baseEnv, backupCalls: 0, verifyCalls: [], hb: [], hbOk: true, backupError: null, verifyResult: null, now, identityFile,
    advance: (ms) => { current = new Date(current.getTime() + ms); },
    set: (date) => { current = new Date(date); },
    status: () => readStatusFile(config.statusFile).status,
    exported: () => (config.exportDir ? JSON.parse(readFileSync(join(config.exportDir, "backup-status.json"), "utf8")) : null),
    deps(extra = {}) {
      return buildDefaultDeps(config, baseEnv, {
        now,
        log: (level, event, fields) => logs.push({ level, event, ...fields }),
        sink: h.sink,
        backup: async () => {
          h.backupCalls += 1;
          if (h.backupError) throw h.backupError;
          return { name: makeSet(out, now()).name };
        },
        verify: async ({ setDir, identityFile: id }) => {
          h.verifyCalls.push({ setDir, existedAtCall: existsSync(setDir), identityFile: id });
          return h.verifyResult ?? { exitCode: 0, report: { ok: true, stage: "complete", databases: [{ database: "jarvis", ok: true, tables_restored: 12, total_rows_expected: 340 }, { database: "infisical", ok: true, tables_restored: 3, total_rows_expected: 7 }] } };
        },
        heartbeat: noHeartbeat ? undefined : {
          configured: true,
          start: async () => { h.hb.push("start"); return { ok: true }; },
          success: async () => { h.hb.push("success"); return { ok: h.hbOk }; },
          fail: async () => { h.hb.push("fail"); return { ok: h.hbOk }; },
          last: () => ({ last_ping_at: now().toISOString(), last_ping_kind: h.hb.at(-1) ?? null, last_ping_ok: h.hbOk, last_error_code: h.hbOk ? null : "heartbeat_failed" })
        },
        prepareSet: (dir, opts) => prepareSetForOffsite(dir, { ...opts, encryptManifest: fakeEncryptManifest }),
        materializeManifest: async (dir) => { writeFileSync(join(dir, "manifest.json"), "{}"); return true; },
        ...extra
      });
    },
    tick: (extra = {}) => runTick(config, h.deps(extra), baseEnv)
  };
  return h;
}

describe("WP-C2 forfalt-beslutninger (rene funksjoner)", () => {
  const status = emptyStatus();
  const base = { roleEnabled: true, force: false, status, nowMs: T0.getTime(), intervalMs: D };

  it("backup: ingen sett = forfalt; ferskt = ikke; grensen er intervall minus 2 min toleranse (ingen drift, men tåler cron-jitter)", () => {
    expect(backupDecision({ ...base, newestMs: null })).toEqual({ due: true, reason: "no_backup_exists" });
    expect(backupDecision({ ...base, newestMs: T0.getTime() - 2 * H })).toEqual({ due: false, reason: "fresh" });
    expect(backupDecision({ ...base, newestMs: T0.getTime() - D + 2 * 60_000 + 1 }).due).toBe(false);
    expect(backupDecision({ ...base, newestMs: T0.getTime() - D + 2 * 60_000 })).toEqual({ due: true, reason: "interval_elapsed" });
    expect(backupDecision({ ...base, newestMs: T0.getTime() - 30 * H })).toMatchObject({ due: true });
  });

  it("backup: rollen av = aldri; --force overstyrer fersk og backoff; backoff stopper et nytt forsøk", () => {
    expect(backupDecision({ ...base, roleEnabled: false, newestMs: null })).toEqual({ due: false, reason: "role_disabled" });
    expect(backupDecision({ ...base, force: true, newestMs: T0.getTime() - 1000 })).toEqual({ due: true, reason: "forced" });
    const failing = emptyStatus();
    failing.backup.retry_after = new Date(T0.getTime() + 10 * 60_000).toISOString();
    expect(backupDecision({ ...base, status: failing, newestMs: T0.getTime() - 30 * H })).toEqual({ due: false, reason: "retry_backoff" });
    expect(backupDecision({ ...base, status: failing, force: true, newestMs: null })).toMatchObject({ due: true });
    failing.backup.retry_after = new Date(T0.getTime() - 1).toISOString();
    expect(backupDecision({ ...base, status: failing, newestMs: null })).toMatchObject({ due: true });
  });

  it("retry-backoff dobler opp til 8x: 30, 60, 120, 240, 240 min", () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => retryDelayMs(n, 30 * 60_000) / 60_000)).toEqual([30, 60, 120, 240, 240, 240]);
  });

  it("off-site: aldri uten adapter; nytt sett/forrige feilet/ny kontroll er forfalt; i synk er ikke forfalt", () => {
    const o = { roleEnabled: true, sinkPresent: true, force: false, newestName: "jarvis-backup-20261009T020000Z", status: emptyStatus(), nowMs: T0.getTime(), reverifyMs: 7 * D };
    expect(offsiteDecision({ ...o, sinkPresent: false })).toEqual({ due: false, reason: "not_configured" });
    expect(offsiteDecision({ ...o, newestName: null })).toEqual({ due: false, reason: "no_set" });
    expect(offsiteDecision(o)).toEqual({ due: true, reason: "new_set" });
    const synced = emptyStatus();
    Object.assign(synced.offsite, { state: "ok", last_set: o.newestName, last_verified_at: new Date(T0.getTime() - 2 * D).toISOString() });
    expect(offsiteDecision({ ...o, status: synced })).toEqual({ due: false, reason: "in_sync" });
    expect(offsiteDecision({ ...o, status: synced, nowMs: T0.getTime() + 6 * D + 23 * H })).toMatchObject({ due: true, reason: "periodic_reverify" });
    synced.offsite.state = "failed";
    expect(offsiteDecision({ ...o, status: synced })).toMatchObject({ due: true, reason: "previous_attempt_failed" });
    synced.offsite.retry_after = new Date(T0.getTime() + 60_000).toISOString();
    expect(offsiteDecision({ ...o, status: synced })).toEqual({ due: false, reason: "retry_backoff" });
  });

  it("restore-verify: kun med identitet; aldri verifisert/uke gammel er forfalt; feilet venter på backoff", () => {
    const v = { roleEnabled: true, identityConfigured: true, force: false, hasSet: true, status: emptyStatus(), nowMs: T0.getTime(), intervalMs: 7 * D };
    expect(verifyDecision({ ...v, identityConfigured: false })).toEqual({ due: false, reason: "not_configured" });
    expect(verifyDecision({ ...v, hasSet: false })).toEqual({ due: false, reason: "no_set" });
    expect(verifyDecision(v)).toEqual({ due: true, reason: "never_verified" });
    const ok = emptyStatus();
    Object.assign(ok.restore_verify, { state: "ok", last_success_at: new Date(T0.getTime() - 3 * D).toISOString() });
    expect(verifyDecision({ ...v, status: ok })).toEqual({ due: false, reason: "fresh" });
    expect(verifyDecision({ ...v, status: ok, nowMs: T0.getTime() + 4 * D })).toEqual({ due: true, reason: "interval_elapsed" });
    ok.restore_verify.state = "failed";
    ok.restore_verify.retry_after = new Date(T0.getTime() + H).toISOString();
    expect(verifyDecision({ ...v, status: ok })).toEqual({ due: false, reason: "retry_backoff" });
    expect(verifyDecision({ ...v, status: ok, force: true })).toEqual({ due: true, reason: "forced" });
  });

  it("retensjon: eldre enn N dager fjernes, men det nyeste beholdes ALLTID (også med retain 0 dager)", () => {
    const sets = [40, 35, 10, 1].map((d) => ({ name: `s${d}`, dir: `/x/s${d}`, createdMs: T0.getTime() - d * D }));
    expect(setsToPrune(sets, 30, T0.getTime()).map((s) => s.name)).toEqual(["s40", "s35"]);
    expect(setsToPrune(sets, 0, T0.getTime() + 400 * D).map((s) => s.name)).toEqual(["s40", "s35", "s10"]);
    expect(setsToPrune([sets[0]], 1, T0.getTime())).toEqual([]);
  });
});

describe("WP-C2 tick: planlagt backup (falsk backup/klokke, ekte filsystem)", () => {
  it("første kjøring: tar backup, skriver status (0600) + eksport (0644), pinger start→suksess, exit 0", async () => {
    const exportDir = join(tempDir("wpc2-exp-"), "pub");
    const h = harness({ flags: { "status-export-dir": exportDir } });
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OK, outcome: "ok", actions: ["backup"], failed: [] });
    expect(h.backupCalls).toBe(1);
    expect(h.hb).toEqual(["start", "success"]);
    expect(statSync(h.config.statusFile).mode & 0o777).toBe(0o600);
    const s = h.status();
    expect(s).toMatchObject({ created_at: T0.toISOString(), last_tick_at: T0.toISOString(), backup: { last_success_at: T0.toISOString(), consecutive_failures: 0, last_error_code: null }, offsite: { state: "not_configured", adapter: null } });
    expect(s.backup.last_set).toMatch(/^jarvis-backup-20261009T020000Z$/);
    expect(s.backup.size_bytes).toBeGreaterThan(0);
    expect(s.restore_verify.state).toBe("not_configured");
    expect(statSync(join(exportDir, "backup-status.json")).mode & 0o777).toBe(0o644);
    const pub = h.exported();
    expect(pub).toMatchObject({ schema: 1, backup: { state: "ok", sets_on_disk: 1, interval_hours: 24, last_set: s.backup.last_set }, offsite: { state: "not_configured" }, heartbeat: { configured: true, last_ping_ok: true } });
    expect(readdirSync(h.out).filter((n) => n.endsWith(".lock") || n.endsWith(".tmp") || n.endsWith(".takeover"))).toEqual([]); // låsen er frigitt
  });

  it("idempotent: et nytt tikk uten forfall gjør INGENTING (ingen backup, ingen heartbeat, stille), men fornyer last_tick_at og eksporten", async () => {
    const exportDir = tempDir("wpc2-exp-");
    const h = harness({ flags: { "status-export-dir": exportDir } });
    await h.tick();
    h.hb.length = 0;
    h.logs.length = 0;
    h.advance(15 * 60_000);
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OK, outcome: "nothing_due", actions: [] });
    expect(h.backupCalls).toBe(1);
    expect(h.hb).toEqual([]);
    expect(h.logs.filter((l) => l.level !== "debug")).toEqual([]);
    expect(h.status().last_tick_at).toBe(new Date(T0.getTime() + 15 * 60_000).toISOString());
    expect(h.exported().generated_at).toBe(new Date(T0.getTime() + 15 * 60_000).toISOString());
  });

  it("intervallet styrer: 23 t 57 min senere = ikke forfalt, 23 t 58 min = forfalt (ny backup)", async () => {
    const h = harness();
    await h.tick();
    h.advance(D - 2 * 60_000 - 1);
    expect((await h.tick()).actions).toEqual([]);
    h.advance(1);
    const r = await h.tick();
    expect(r.actions).toEqual(["backup"]);
    expect(h.backupCalls).toBe(2);
    h.set(new Date(T0.getTime() + 3 * D));
    expect((await h.tick()).actions).toEqual(["backup"]);
  });

  it("konfigurerbart intervall (JARVIS_BACKUP_INTERVAL_HOURS)", async () => {
    const h = harness({ env: { JARVIS_BACKUP_INTERVAL_HOURS: "6" } });
    await h.tick();
    h.advance(5 * H);
    expect((await h.tick()).actions).toEqual([]);
    h.advance(61 * 60_000);
    expect((await h.tick()).actions).toEqual(["backup"]);
  });

  it("et sett tatt av den gamle nas-backup.sh-cronen teller som ferskt (settene på disk er autoriteten, ikke statusfilen)", async () => {
    const h = harness();
    makeSet(h.out, hoursAgo(T0, 2));
    const r = await h.tick();
    expect(r.outcome).toBe("nothing_due");
    expect(h.backupCalls).toBe(0);
  });

  it("korrupt statusfil: logges høyt, tikket fortsetter og utleder alt fra settene på disk", async () => {
    const h = harness();
    makeSet(h.out, hoursAgo(T0, 2));
    writeFileSync(h.config.statusFile, "{ halv fil");
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OK, outcome: "nothing_due" });
    expect(h.logs).toContainEqual(expect.objectContaining({ level: "warn", event: "status_file_unusable", problem: "corrupt" }));
    expect(h.status().created_at).toBe(T0.toISOString()); // skrevet på nytt og gyldig
  });

  it("backup feiler: exit 2, /fail-ping, feilkode + REDIGERT tekst (aldri DB-passordet), teller + backoff 30 → 60 min; suksess nullstiller", async () => {
    const h = harness();
    h.backupError = new ScheduleError("backup_failed", `pg_dump: FATAL password authentication failed (PGPASSWORD=${PASSWORD}) at https://x.example/secret`);
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.BACKUP_FAILED, outcome: "failed", failed: ["backup"] });
    expect(h.hb).toEqual(["start", "fail"]);
    let s = h.status();
    expect(s.backup).toMatchObject({ consecutive_failures: 1, last_error_code: "backup_failed", retry_after: new Date(T0.getTime() + 30 * 60_000).toISOString() });
    expect(s.backup.last_error).toContain("password authentication failed");
    expect(JSON.stringify(s)).not.toContain(PASSWORD);
    expect(readFileSync(h.config.statusFile, "utf8")).not.toMatch(/x\.example/);

    h.advance(10 * 60_000); // innenfor backoff: ikke forsøk, men forfalt (ingen backup finnes) => exit 3
    const mid = await h.tick();
    expect(mid).toMatchObject({ exitCode: EXIT.OVERDUE, outcome: "overdue", actions: [] });
    expect(h.backupCalls).toBe(1);

    h.advance(21 * 60_000); // 31 min etter første feil: nytt forsøk, feiler igjen => 60 min backoff
    await h.tick();
    s = h.status();
    expect(h.backupCalls).toBe(2);
    expect(s.backup).toMatchObject({ consecutive_failures: 2, retry_after: new Date(h.now().getTime() + 60 * 60_000).toISOString() });

    h.backupError = null;
    h.advance(61 * 60_000);
    expect((await h.tick()).exitCode).toBe(EXIT.OK);
    expect(h.status().backup).toMatchObject({ consecutive_failures: 0, retry_after: null, last_error_code: null, last_error: null });
    expect(h.logs.some((l) => JSON.stringify(l).includes(PASSWORD))).toBe(false);
  });

  it("tidsavbrudd i backup får egen feilkode; en backup som meldte OK uten komplett sett på disk regnes som feil", async () => {
    const h = harness();
    h.backupError = new ScheduleError("backup_timeout", "backup brukte mer enn 240 min");
    await h.tick();
    expect(h.status().backup.last_error_code).toBe("backup_timeout");
    h.backupError = null;
    h.advance(31 * 60_000);
    await h.tick({ backup: async () => ({ name: "jarvis-backup-20261009T999999Z" }) });
    expect(h.status().backup).toMatchObject({ last_error_code: "backup_failed", consecutive_failures: 2 });
  });

  it("forfalt (> 1,5 × intervall) uten at tikket tok backup (backoff) gir exit 3; en ferdig tatt backup gir aldri `overdue`", async () => {
    const h = harness();
    makeSet(h.out, hoursAgo(T0, 40));
    const st = emptyStatus();
    st.backup.retry_after = new Date(T0.getTime() + H).toISOString();
    st.backup.consecutive_failures = 1;
    writeFileSync(h.config.statusFile, JSON.stringify(st));
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OVERDUE, outcome: "overdue", actions: [] });
    expect(h.logs).toContainEqual(expect.objectContaining({ level: "error", event: "backup_overdue" }));
    h.advance(2 * H);
    expect((await h.tick()).exitCode).toBe(EXIT.OK);
  });

  it("review F3 (mutant H2): et tikk som gjør noe men ender FORFALT (exit 3) sender /fail til monitoren - aldri `success`", async () => {
    const h = harness({ identity: true });
    makeSet(h.out, hoursAgo(T0, 40)); // eldre enn 1,5 × intervall
    const st = emptyStatus();
    st.backup.retry_after = new Date(T0.getTime() + H).toISOString(); // backup i backoff: tikket tar den ikke
    st.backup.consecutive_failures = 1;
    writeFileSync(h.config.statusFile, JSON.stringify(st));
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OVERDUE, outcome: "overdue", actions: ["verify"], failed: [] }); // verify kjørte og lyktes - men backupen er forfalt
    expect(h.verifyCalls).toHaveLength(1);
    expect(h.hb).toEqual(["start", "fail"]);
    expect(h.status().heartbeat).toMatchObject({ configured: true, last_ping_kind: "fail" });

    // motstykket: samme tikk uten forfall (backupen er fersk) sender `success`
    const fresh = harness({ identity: true });
    makeSet(fresh.out, hoursAgo(T0, 2));
    expect(await fresh.tick()).toMatchObject({ exitCode: EXIT.OK, actions: ["verify"] });
    expect(fresh.hb).toEqual(["start", "success"]);
  });

  it("lås: et levende tikk blokkerer (exit 0, ingenting kjører, ingen status skrevet); en lås fra en død prosess tas over", async () => {
    const h = harness();
    const lockFile = h.config.lockFile;
    writeFileSync(lockFile, `${JSON.stringify({ token: "annen", pid: process.pid, host: (await import("node:os")).hostname(), started_at: T0.toISOString() })}\n`);
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OK, outcome: "skipped_lock_held" });
    expect(h.backupCalls).toBe(0);
    expect(existsSync(h.config.statusFile)).toBe(false);
    expect(existsSync(lockFile)).toBe(true); // den andres lås røres ikke
    writeFileSync(lockFile, `${JSON.stringify({ token: "dod", pid: 99_999_999, host: (await import("node:os")).hostname(), started_at: T0.toISOString() })}\n`);
    expect((await h.tick()).outcome).toBe("ok");
    expect(h.backupCalls).toBe(1);
  });

  it("låsen frigjøres også når et steg kaster uventet", async () => {
    const h = harness();
    await expect(h.tick({ prepareSet: undefined, backup: async () => { throw new Error("uventet"); } })).resolves.toMatchObject({ exitCode: EXIT.BACKUP_FAILED });
    expect(existsSync(h.config.lockFile)).toBe(false);
  });

  it("--dry-run: avgjør kun - ingen lås, ingen status, ingen backup, ingen ping", async () => {
    const h = harness({ flags: { "dry-run": true } });
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OK, outcome: "dry_run", decisions: { backup: { due: true, reason: "no_backup_exists" } } });
    expect(readdirSync(h.out)).toEqual([]);
    expect(h.backupCalls).toBe(0);
    expect(h.hb).toEqual([]);
  });

  it("retensjon: gamle sett fjernes, de 7 nyeste beholdes uansett alder; hoppes over når kjeden er stille (gamle sett er alt vi har)", async () => {
    const h = harness();
    for (const d of [40, 35, 10]) makeSet(h.out, new Date(T0.getTime() - d * D));
    for (const d of [8, 7, 6, 5, 4, 3, 2]) makeSet(h.out, new Date(T0.getTime() - d * D));
    makeSet(h.out, hoursAgo(T0, 1));
    const r = await h.tick();
    expect(r.actions).toEqual([]);
    expect(listCompleteSets(h.out).map((s) => s.name.slice(14, 22))).toEqual(["20260929", "20261001", "20261002", "20261003", "20261004", "20261005", "20261006", "20261007", "20261009"]);
    expect(h.status().retention).toMatchObject({ last_pruned_count: 2, last_skipped_reason: null });

    const stale = harness();
    for (const d of [60, 45]) makeSet(stale.out, new Date(T0.getTime() - d * D));
    stale.backupError = new ScheduleError("backup_failed", "nede");
    await stale.tick();
    expect(listCompleteSets(stale.out)).toHaveLength(2); // ingenting slettet mens backupene uteblir
    expect(stale.status().retention.last_skipped_reason).toBe("pipeline_stale");
  });

  it("foreldreløse settkataloger (uten manifest, > 12 t) ryddes; ferske, ferdige og korrupte-manifest-sett røres ikke", async () => {
    const h = harness();
    makeSet(h.out, hoursAgo(T0, 1));
    const mk = (name, ageH, files = { "x.age": "x" }) => {
      const dir = join(h.out, name);
      mkdirSync(dir);
      for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
      const t = new Date(T0.getTime() - ageH * H);
      utimesSync(dir, t, t);
      return dir;
    };
    const old = mk("jarvis-backup-20261001T000000Z", 30);
    const fresh = mk("jarvis-backup-20261009T013000Z", 0.5);
    const corrupt = mk("jarvis-backup-20260901T000000Z", 90, { "manifest.json": "{ikke json" });
    expect(findOrphanSets(h.out, T0.getTime())).toEqual([old]);
    await h.tick();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(corrupt)).toBe(true);
    expect(h.logs).toContainEqual(expect.objectContaining({ level: "warn", event: "orphan_set_removed", set: "jarvis-backup-20261001T000000Z" }));
  });

  it("en heartbeat som feiler påvirker aldri backupen: exit 0, men statusen sier ærlig at pinget feilet", async () => {
    const h = harness({ flags: { "status-export-dir": tempDir("wpc2-exp-") } });
    h.hbOk = false;
    const r = await h.tick();
    expect(r.exitCode).toBe(EXIT.OK);
    expect(h.status().heartbeat).toMatchObject({ configured: true, last_ping_ok: false, last_error_code: "heartbeat_failed" });
    expect(h.exported().heartbeat).toMatchObject({ last_ping_ok: false });
  });

  it("uten heartbeat-konfig (standard): ingenting pinges og statusen sier configured:false", async () => {
    const h = harness({ noHeartbeat: true });
    await h.tick();
    expect(h.status().heartbeat).toMatchObject({ configured: false, last_ping_at: null });
  });

  it("hemmeligheter havner aldri i status, eksport eller logg - selv når en feilmelding inneholder dem", async () => {
    const exportDir = tempDir("wpc2-exp-");
    const h = harness({ flags: { "status-export-dir": exportDir }, env: { JARVIS_BACKUP_HEARTBEAT_URL: "https://hc-ping.example/not-real-not-real-not-real" } });
    h.backupError = new Error(`boom ${PASSWORD} not-real-not-real-not-real AGE-SECRET-KEY-1ABCDEFGHIJKLMNOP`);
    await h.tick();
    const everything = [readFileSync(h.config.statusFile, "utf8"), readFileSync(join(exportDir, "backup-status.json"), "utf8"), JSON.stringify(h.logs)].join("\n");
    for (const secret of [PASSWORD, "not-real-not-real-not-real", "AGE-SECRET-KEY-1ABCDEFGHIJKLMNOP"]) expect(everything).not.toContain(secret);
  });

  it("konfig-feil i kjernen stopper FØR noe kjører: manglende mottaker/passord og docker uten compose-fil (identitetsfil hører til verifiseringssteget og stopper ikke backupen)", async () => {
    const run = (flags, env) => runTick(loadScheduleConfig({ out: tempDir(), ...flags }, env), buildDefaultDeps(loadScheduleConfig({ out: tempDir(), ...flags }, env), env), env);
    await expect(run({ mode: "direct" }, { JARVIS_DB_ADMIN_PASSWORD: PASSWORD })).rejects.toThrow(/JARVIS_BACKUP_AGE_RECIPIENT/);
    await expect(run({ mode: "direct" }, { JARVIS_BACKUP_AGE_RECIPIENT: "age-secret-key-1abc", JARVIS_DB_ADMIN_PASSWORD: PASSWORD })).rejects.toThrow(/OFFENTLIG/);
    await expect(run({ mode: "direct" }, { JARVIS_BACKUP_AGE_RECIPIENT: RECIPIENT })).rejects.toThrow(/JARVIS_DB_ADMIN_PASSWORD/);
    await expect(run({ mode: "docker" }, { JARVIS_BACKUP_AGE_RECIPIENT: RECIPIENT, JARVIS_DB_ADMIN_PASSWORD: PASSWORD })).rejects.toThrow(/--compose-file/);
    expect(() => loadScheduleConfig({}, {})).toThrow(/--out/);
    expect(() => loadScheduleConfig({ out: "/x", roles: "backup,rm" }, {})).toThrow(/--roles/);
    expect(() => loadScheduleConfig({ out: "/x", databases: "jarvis;drop" }, {})).toThrow(/--databases/);
    expect(() => loadScheduleConfig({ out: "/x" }, { JARVIS_BACKUP_INTERVAL_HOURS: "0" })).toThrow(/JARVIS_BACKUP_INTERVAL_HOURS/);
    expect(() => loadScheduleConfig({ out: "/x" }, { JARVIS_BACKUP_INTERVAL_HOURS: "mange" })).not.toThrow(/mange/);
  });
});

describe("WP-C2 tick: off-site (falsk sink, ekte forhåndssjekk av settet)", () => {
  it("uten adapter er den AV: ingen sink-kall, status `not_configured`, eksport sier det ærlig", async () => {
    const exportDir = tempDir("wpc2-exp-");
    const h = harness({ flags: { "status-export-dir": exportDir } });
    await h.tick();
    expect(h.status().offsite).toMatchObject({ state: "not_configured", adapter: null, last_set: null });
    expect(h.exported().offsite).toMatchObject({ state: "not_configured", adapter: null });
  });

  it("nytt sett → pushes i SAMME tikk, kun age-filer (aldri manifest.json/SHA256SUMS); status ok; neste tikk gjør ingenting; ny kontroll etter en uke", async () => {
    const sink = fakeSink();
    const h = harness({ sink, flags: { roles: "backup,offsite" } });
    const r = await h.tick();
    expect(r.actions).toEqual(["backup", "offsite"]);
    expect(sink.state.pushes).toHaveLength(1);
    const pushed = sink.state.pushes[0];
    expect(pushed.files.map((f) => f.name).sort()).toEqual(["globals.sql.age", "infisical.dump.age", "jarvis.dump.age", "langfuse.dump.age", "manifest.json.age"]);
    expect(pushed.files.map((f) => f.name)).not.toContain("manifest.json");
    expect(h.status().offsite).toMatchObject({ state: "ok", adapter: "local", last_set: pushed.name, verification: "sha256", consecutive_failures: 0, last_success_at: T0.toISOString() });
    expect(h.hb).toEqual(["start", "success"]);

    h.advance(15 * 60_000);
    expect((await h.tick()).actions).toEqual([]);
    expect(sink.state.pushes).toHaveLength(1);

    // Kun off-site-rollen, en uke senere: periodisk ny kontroll (idempotent push + verifisering) selv uten nytt sett.
    const only = harness({ sink: fakeSink(), flags: { roles: "offsite" } });
    makeSet(only.out, hoursAgo(T0, 1));
    expect((await only.tick()).actions).toEqual(["offsite"]);
    only.advance(7 * D - 60_000);
    expect((await only.tick()).actions).toEqual(["offsite"]);
    expect(only.sink.state.pushes).toHaveLength(2);
  });

  it("off-site feiler: exit 5, /fail-ping, feilkode, backoff; backupen er likevel tatt; nytt forsøk etter backoff lykkes og nullstiller", async () => {
    const sink = fakeSink();
    sink.state.failWith = new OffsiteError("offsite_verify_failed", "off-site-kopien avviker fra det lokale settet: sjekksummen avviker: jarvis.dump.age");
    const h = harness({ sink, flags: { roles: "backup,offsite", "status-export-dir": tempDir("wpc2-exp-") } });
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OFFSITE_FAILED, failed: ["offsite"], actions: ["backup", "offsite"] });
    expect(h.hb).toEqual(["start", "fail"]);
    expect(h.backupCalls).toBe(1);
    expect(h.status().offsite).toMatchObject({ state: "failed", last_error_code: "offsite_verify_failed", consecutive_failures: 1, retry_after: new Date(T0.getTime() + 30 * 60_000).toISOString() });
    expect(h.exported().offsite).toMatchObject({ state: "failed", last_error_code: "offsite_verify_failed" });

    h.advance(10 * 60_000);
    expect((await h.tick()).actions).toEqual([]); // backoff
    sink.state.failWith = null;
    h.advance(21 * 60_000);
    const ok = await h.tick();
    expect(ok).toMatchObject({ exitCode: EXIT.OK, actions: ["offsite"] });
    expect(h.status().offsite).toMatchObject({ state: "ok", consecutive_failures: 0, retry_after: null, last_error_code: null });
  });

  it("et sett med en klartekst-fil sendes ALDRI: ineligible → exit 5, sink.push er ikke kalt", async () => {
    const sink = fakeSink();
    const h = harness({ sink, flags: { roles: "offsite" } });
    const set = makeSet(h.out, hoursAgo(T0, 1));
    writeFileSync(join(set.dir, "jarvis.dump"), "PGDMP...");
    const r = await h.tick();
    expect(r.exitCode).toBe(EXIT.OFFSITE_FAILED);
    expect(sink.state.pushes).toEqual([]);
    expect(h.status().offsite).toMatchObject({ state: "failed", last_error_code: "offsite_ineligible" });
  });

  it("etterfyller eldre sett som mangler (nyeste først, maks 3 per tikk); en feil på et ELDRE sett er en advarsel, ikke en feilet off-site", async () => {
    const sink = fakeSink({ remote: ["jarvis-backup-20261004T020000Z"] });
    const h = harness({ sink, flags: { roles: "offsite" } });
    for (const d of [5, 4, 3, 2, 1]) makeSet(h.out, new Date(T0.getTime() - d * D));
    const r = await h.tick();
    expect(r.exitCode).toBe(EXIT.OK);
    expect(sink.state.pushes.map((p) => p.name.slice(14, 22))).toEqual(["20261008", "20261007", "20261006"]);
    expect(sink.state.remote.has("jarvis-backup-20261004T020000Z")).toBe(true);

    const broken = fakeSink({ remote: ["jarvis-backup-20261004T020000Z"] });
    const h2 = harness({ sink: broken, flags: { roles: "offsite" } });
    for (const d of [3, 2, 1]) makeSet(h2.out, new Date(T0.getTime() - d * D));
    writeFileSync(join(h2.out, "jarvis-backup-20261006T020000Z", "plantet.txt"), "x"); // det midterste settet er ineligible
    const r2 = await h2.tick();
    expect(r2.exitCode).toBe(EXIT.OK);
    expect(h2.logs).toContainEqual(expect.objectContaining({ level: "warn", event: "offsite_backfill_failed", code: "offsite_ineligible" }));
    expect(h2.status().offsite.state).toBe("ok");
  });

  it("feiler oversikten (list) sendes det nyeste settet likevel; feiler pushen, er DEN feilen som rapporteres", async () => {
    const sink = fakeSink();
    sink.state.listFails = true;
    const h = harness({ sink, flags: { roles: "offsite" } });
    makeSet(h.out, hoursAgo(T0, 1));
    expect((await h.tick()).exitCode).toBe(EXIT.OK);
    expect(sink.state.pushes).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "offsite_list_failed" }));
  });

  it("off-site-rollen uten sett å sende: ingenting skjer (ikke en feil)", async () => {
    const h = harness({ sink: fakeSink(), flags: { roles: "offsite" } });
    expect((await h.tick()).outcome).toBe("nothing_due");
  });
});

describe("WP-C2 tick: restore-verifisering (scratch, uten å røre produksjon)", () => {
  it("uten identitet (privatnøkkelen er offline på NAS) kjører den ikke - status `not_configured`, ingen verify-kall", async () => {
    const h = harness();
    makeSet(h.out, hoursAgo(T0, 1));
    await h.tick();
    expect(h.verifyCalls).toEqual([]);
    expect(h.status().restore_verify.state).toBe("not_configured");
  });

  it("med identitet: aldri verifisert = forfalt, kjører mot nyeste sett, registrerer tid/tabeller/rader, skriver kvittering (0600), og er ukentlig", async () => {
    const h = harness({ identity: true });
    const set = makeSet(h.out, hoursAgo(T0, 1));
    expect(h.status().restore_verify.state).toBe("not_configured"); // før første tikk finnes ingen status
    const r = await h.tick();
    expect(r.actions).toEqual(["verify"]);
    expect(h.verifyCalls).toEqual([{ setDir: set.dir, existedAtCall: true, identityFile: h.identityFile }]);
    expect(h.status().restore_verify).toMatchObject({ state: "ok", last_set: set.name, tables: 15, rows: 347, source: "local", reported_by: "local", consecutive_failures: 0, last_success_at: T0.toISOString() });
    expect(h.hb).toEqual(["start", "success"]);
    const report = join(h.config.stateDir, "restore-verify-report.json");
    expect(statSync(report).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({ ok: true, set: set.name, tables: 15, rows: 347, source: "local" });

    h.advance(6 * D);
    expect((await h.tick()).actions).toEqual(["backup"]); // backup forfalt, verify ikke ennå
    h.advance(D + 60_000);
    expect((await h.tick()).actions).toContain("verify");
  });

  it("feilet verifisering: exit 4, /fail-ping, kode fra rapporten (integritet/avvik/annet), backoff på minst 6 t; kvittering sier ok:false", async () => {
    const h = harness({ identity: true });
    makeSet(h.out, hoursAgo(T0, 1));
    h.verifyResult = { exitCode: 2, report: { ok: false, stage: "integrity", databases: [] } };
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.VERIFY_FAILED, failed: ["verify"] });
    expect(h.hb).toEqual(["start", "fail"]);
    expect(h.status().restore_verify).toMatchObject({ state: "failed", last_error_code: "verify_integrity", consecutive_failures: 1, retry_after: new Date(T0.getTime() + 6 * H).toISOString() });
    expect(JSON.parse(readFileSync(join(h.config.stateDir, "restore-verify-report.json"), "utf8"))).toMatchObject({ ok: false, error_code: "verify_integrity" });

    h.advance(H);
    expect((await h.tick()).actions).toEqual([]);
    h.verifyResult = { exitCode: 2, report: { ok: false, stage: "complete", databases: [{ database: "jarvis", ok: false, tables_restored: 3, total_rows_expected: 9 }] } };
    h.advance(6 * H);
    await h.tick();
    expect(h.status().restore_verify).toMatchObject({ last_error_code: "verify_mismatch", consecutive_failures: 2, retry_after: new Date(h.now().getTime() + 12 * H).toISOString() });
  });

  it("vaktene i verifiseringen (manifest, scratch) gir egne feilkoder og en forklaring i den interne statusen; tekst fra andre trinn (kan sitere ubetrodd SQL) kommer aldri inn", async () => {
    const h = harness({ identity: true });
    makeSet(h.out, hoursAgo(T0, 1));
    h.verifyResult = { exitCode: 2, report: { ok: false, stage: "scratch_guard", error: "scratch-serveren er ikke en tom, kastbar instans: 3 database(r) utenfor systemdatabasene (f.eks. jarvis)", databases: [] } };
    expect(await h.tick()).toMatchObject({ exitCode: EXIT.VERIFY_FAILED, failed: ["verify"] });
    expect(h.status().restore_verify).toMatchObject({ state: "failed", last_error_code: "verify_config_invalid" });
    expect(h.status().restore_verify.last_error).toContain("scratch_guard");
    expect(h.status().restore_verify.last_error).toContain("ikke en tom, kastbar instans");

    h.verifyResult = { exitCode: 2, report: { ok: false, stage: "manifest", error: "manifest.json har ugyldig form: databases[0].tables har ugyldig tabellnavn eller radtall", databases: [] } };
    h.advance(7 * H);
    await h.tick();
    expect(h.status().restore_verify).toMatchObject({ last_error_code: "verify_integrity", consecutive_failures: 2 });
    expect(h.status().restore_verify.last_error).toContain("ugyldig tabellnavn");

    h.verifyResult = { exitCode: 2, report: { ok: false, stage: "restore", error: "pg_restore: ERROR: EVIL-SENTINEL (siterer SQL fra settet)", databases: [] } };
    h.advance(13 * H);
    await h.tick();
    expect(h.status().restore_verify).toMatchObject({ last_error_code: "verify_failed", consecutive_failures: 3 });
    expect(JSON.stringify(h.status())).not.toContain("EVIL-SENTINEL");
  });

  it("en rapport med ok:true men exit-kode ≠ 0 (eller omvendt) regnes IKKE som verifisert (aldri stol på ett signal alene)", async () => {
    const h = harness({ identity: true });
    makeSet(h.out, hoursAgo(T0, 1));
    h.verifyResult = { exitCode: 1, report: { ok: true, stage: "complete", databases: [] } };
    expect((await h.tick()).exitCode).toBe(EXIT.VERIFY_FAILED);
    expect(h.status().restore_verify.state).toBe("failed");
  });

  it("verify-kallet kaster (tidsavbrudd/ingen rapport): feilkoden bevares", async () => {
    const h = harness({ identity: true });
    makeSet(h.out, hoursAgo(T0, 1));
    await h.tick({ verify: async () => { throw new ScheduleError("verify_timeout", "for lang tid"); } });
    expect(h.status().restore_verify).toMatchObject({ state: "failed", last_error_code: "verify_timeout" });
  });

  it("kilde = off-site: henter nyeste sett fra fjernmålet til en midlertidig mappe, dekrypterer manifestet, verifiserer, og RYDDER mappen etterpå", async () => {
    const sink = fakeSink({ remote: ["jarvis-backup-20261001T020000Z", "jarvis-backup-20261008T020000Z"] });
    // Konfig-parsing krever at en adapter er satt når kilden er off-site; selve sinken injiseres.
    const h = harness({ identity: true, sink, env: { JARVIS_BACKUP_OFFSITE_LOCAL_DIR: "/mnt/usb/jarvis" }, flags: { roles: "verify", "verify-source": "offsite" } });
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OK, actions: ["verify"] });
    expect(sink.state.fetches).toEqual(["jarvis-backup-20261008T020000Z"]);
    expect(h.verifyCalls).toHaveLength(1);
    expect(h.verifyCalls[0].setDir).toContain(".verify-tmp-");
    expect(h.verifyCalls[0].existedAtCall).toBe(true);
    expect(readdirSync(h.out).filter((n) => n.startsWith(".verify-tmp-"))).toEqual([]);
    expect(h.status().restore_verify).toMatchObject({ state: "ok", source: "offsite", last_set: "jarvis-backup-20261008T020000Z", fetch_duration_s: 0 });
  });

  it("en ekstern verifiserers kvittering (PC med privat nøkkel) flettes inn på NAS-en og vises som `external_verifier`", async () => {
    const h = harness();
    makeSet(h.out, hoursAgo(T0, 1));
    writeFileSync(join(h.config.stateDir, "restore-verify-report.json"), JSON.stringify({
      schema: 1, finished_at: new Date(T0.getTime() - D).toISOString(), ok: true, set: "jarvis-backup-20261008T020000Z", duration_s: 212, fetch_duration_s: 41, tables: 358, rows: 10346, source: "offsite"
    }));
    await h.tick();
    expect(h.status().restore_verify).toMatchObject({ state: "ok", reported_by: "external_verifier", duration_s: 212, fetch_duration_s: 41, tables: 358, rows: 10346, source: "offsite" });
    expect(h.verifyCalls).toEqual([]); // NAS-en verifiserer ikke selv
  });
});

describe("WP-C2 tick: valgfrie delsystemer med ugyldig konfig stopper ALDRI selve backupen (men feiler høylytt)", () => {
  it("ugyldig off-site-konfig (to adaptere): backupen tas likevel, off-site rapporteres som feilet (exit 5, /fail), feilen står i hele backoff-vinduet", async () => {
    const exportDir = tempDir("wpc2-exp-");
    const h = harness({ flags: { "status-export-dir": exportDir }, env: { JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE: "b2:x", JARVIS_BACKUP_OFFSITE_LOCAL_DIR: "/mnt/usb/x" } });
    expect(h.config.offsite).toBeNull();
    expect(h.config.offsiteError).toContain("kun ÉN off-site-adapter");
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OFFSITE_FAILED, outcome: "failed", actions: ["backup", "offsite"], failed: ["offsite"] });
    expect(h.backupCalls).toBe(1); // backupen ble tatt
    expect(listCompleteSets(h.out)).toHaveLength(1);
    expect(h.hb).toEqual(["start", "fail"]);
    expect(h.status().offsite).toMatchObject({ state: "failed", last_error_code: "offsite_config_invalid", consecutive_failures: 1 });
    expect(h.exported().offsite).toMatchObject({ state: "failed", last_error_code: "offsite_config_invalid" });
    // innenfor backoff: ikke nytt forsøk, og tilstanden er fortsatt «feilet» (ikke tilbakestilt til «ikke satt opp»)
    h.advance(10 * 60_000);
    expect((await h.tick()).actions).toEqual([]);
    expect(h.status().offsite.state).toBe("failed");
    expect(h.exported().offsite.state).toBe("failed");
  });

  it("ugyldig restore-verifiserings-konfig (env): backupen tas likevel, verify rapporteres som feilet (exit 4, kode verify_config_invalid)", async () => {
    const h = harness({ env: { JARVIS_BACKUP_VERIFY_INTERVAL_DAYS: "mange" } });
    expect(h.config.verifyError).toContain("JARVIS_BACKUP_VERIFY_INTERVAL_DAYS");
    expect(h.config.verifyError).not.toContain("mange"); // siterer aldri verdien
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.VERIFY_FAILED, actions: ["backup", "verify"], failed: ["verify"] });
    expect(h.backupCalls).toBe(1);
    expect(h.verifyCalls).toEqual([]);
    expect(h.status().restore_verify).toMatchObject({ state: "failed", last_error_code: "verify_config_invalid" });
  });

  it("identitetsfil som ikke finnes, scratch uten passord og kilde off-site uten adapter er verify_config_invalid - ikke et hardt stopp av backupen", async () => {
    const missing = harness({ env: { JARVIS_BACKUP_VERIFY_IDENTITY_FILE: "/finnes/ikke/identity.txt" } });
    expect((await missing.tick()).exitCode).toBe(EXIT.VERIFY_FAILED);
    expect(missing.backupCalls).toBe(1);
    expect(missing.status().restore_verify).toMatchObject({ state: "failed", last_error_code: "verify_config_invalid" });
    expect(missing.status().restore_verify.last_error).toContain("IDENTITY_FILE");

    const noPw = harness({ identity: true, env: { JARVIS_BACKUP_VERIFY_SCRATCH_HOST: "127.0.0.1", JARVIS_SCRATCH_DB_PASSWORD: "" } });
    makeSet(noPw.out, hoursAgo(T0, 1));
    expect((await noPw.tick()).exitCode).toBe(EXIT.VERIFY_FAILED);
    expect(noPw.status().restore_verify.last_error).toContain("JARVIS_SCRATCH_DB_PASSWORD");

    const noAdapter = harness({ identity: true, flags: { "verify-source": "offsite" } });
    expect(noAdapter.config.verifyError).toContain("krever en off-site-adapter");
    makeSet(noAdapter.out, hoursAgo(T0, 1));
    expect((await noAdapter.tick()).failed).toContain("verify");
    expect(noAdapter.verifyCalls).toEqual([]);
  });

  it("review F2: en varig, direkte scratch-server kan ikke kombineres med kilde off-site (settet fra fjernmålet er ubetrodd) - verify_config_invalid, backupen tas likevel", async () => {
    const env = { JARVIS_BACKUP_OFFSITE_LOCAL_DIR: "/mnt/usb/jarvis", JARVIS_BACKUP_VERIFY_SCRATCH_HOST: "127.0.0.1", JARVIS_SCRATCH_DB_PASSWORD: "scratch-pw-123" };
    const h = harness({ identity: true, sink: fakeSink(), env, flags: { "verify-source": "offsite" } });
    expect(h.config.verifyError).toContain("kan ikke kombineres med kilde off-site");
    expect(h.config.verifyError).not.toContain("scratch-pw-123");
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.VERIFY_FAILED, failed: ["verify"] });
    expect(r.actions).toEqual(["backup", "offsite", "verify"]);
    expect(h.verifyCalls).toEqual([]); // verifiseringen ble aldri startet
    expect(h.status().restore_verify).toMatchObject({ state: "failed", last_error_code: "verify_config_invalid" });
    expect(h.status().restore_verify.last_error).toContain("engangs-container");

    // samme forbud via miljøvariabelen, og kun når verify-rollen er på og kilden faktisk er off-site
    const viaEnv = (flags, extra = {}) => loadScheduleConfig({ out: tempDir(), ...flags }, { ...env, ...extra });
    expect(viaEnv({}, { JARVIS_BACKUP_VERIFY_SOURCE: "offsite" }).verifyError).toContain("kan ikke kombineres");
    expect(viaEnv({ roles: "backup,offsite", "verify-source": "offsite" }).verifyError).toBeNull();
    expect(viaEnv({ "verify-source": "local" }).verifyError).toBeNull();
    expect(viaEnv({}, { JARVIS_BACKUP_VERIFY_SCRATCH_HOST: "" }).verifyError).toBeNull();
    expect(viaEnv({ "verify-source": "offsite" }, { JARVIS_BACKUP_VERIFY_SCRATCH_HOST: "" }).verifyError).toBeNull(); // engangs-containeren (standard) er tillatt med off-site
  });

  it("review F9: eksportmappen må være en EGEN mappe - lik, inni eller rundt backup-/state-mappen (også via symlenke) er en konfig-feil før noe kjører", () => {
    const base = tempDir();
    const out = join(base, "backups");
    mkdirSync(out);
    const state = join(base, "state");
    mkdirSync(state);
    const load = (exportDir, extra = {}, env = {}) => loadScheduleConfig({ out, "status-export-dir": exportDir, ...extra }, env);
    // likt og nøstet, i begge retninger
    for (const bad of [out, `${out}/`, join(out, "."), join(out, "status"), join(out, "a", "b"), base, dirname(base), "/"]) {
      expect(() => load(bad), bad).toThrow(ConfigError);
      expect(() => load(bad), bad).toThrow(/EGEN mappe/);
    }
    // state-mappen er ikke backup-mappen: samme regler mot den
    for (const bad of [state, join(state, "pub")]) expect(() => load(bad, { "state-dir": state }), bad).toThrow(/state-mappen/);
    expect(() => load(join(state, "pub"), {}, { JARVIS_BACKUP_STATE_DIR: state })).toThrow(/EGEN mappe/);
    // miljøvariabelen er underlagt samme regel
    expect(() => loadScheduleConfig({ out }, { JARVIS_BACKUP_STATUS_EXPORT_DIR: out })).toThrow(/EGEN mappe/);
    // en symlenke til backup-mappen er fortsatt backup-mappen
    const alias = join(base, "alias");
    symlinkSync(out, alias);
    expect(() => load(alias)).toThrow(/EGEN mappe/);
    expect(() => load(join(alias, "pub"))).toThrow(/EGEN mappe/);
    // en egen søsken-mappe (også en som ikke finnes ennå) er helt greit, og uten eksport er det ingen sjekk
    expect(load(join(base, "pub")).exportDir).toBe(join(base, "pub"));
    expect(load(join(base, "sub", "dypere", "pub")).exportDir).toBe(join(base, "sub", "dypere", "pub"));
    expect(load(join(base, "backups-status")).exportDir).toBe(join(base, "backups-status")); // felles prefiks er ikke nesting
    expect(loadScheduleConfig({ out }, {}).exportDir).toBeNull();
  });

  it("kjernekonfig er fortsatt streng: ugyldig intervall/roller/mappe stopper tikket FØR noe kjører (exit 1)", () => {
    expect(() => loadScheduleConfig({ out: tempDir() }, { JARVIS_BACKUP_INTERVAL_HOURS: "0" })).toThrow(ConfigError);
    expect(() => loadScheduleConfig({ out: tempDir(), roles: "backup,rm" }, {})).toThrow(ConfigError);
    expect(() => loadScheduleConfig({}, {})).toThrow(ConfigError);
  });
});

describe("WP-C2 tick: klokkeavvik - fremtidsdaterte sett og tidsstempler kan ikke lamme eller overbelaste backupen", () => {
  it("et sett datert i fremtiden er ikke «nyeste»: ny backup tas (ikke blokkert i årevis), og fremtidssettet logges som advarsel - uten å utløse backup hvert tikk", async () => {
    const h = harness();
    const future = makeSet(h.out, new Date(T0.getTime() + 3 * D));
    expect(findFutureSets(h.out, T0.getTime())).toEqual([future.name]);
    expect(listCompleteSets(h.out, { nowMs: T0.getTime() })).toEqual([]);
    expect(listCompleteSets(h.out)).toHaveLength(1);
    const first = await h.tick();
    expect(first.actions).toEqual(["backup"]);
    expect(h.logs).toContainEqual(expect.objectContaining({ level: "warn", event: "set_dated_in_future", set: future.name }));
    h.advance(15 * 60_000);
    const second = await h.tick();
    expect(second.actions).toEqual([]); // det nye (riktig daterte) settet er ferskt - fremtidssettet utløser ikke noe mer
    expect(h.backupCalls).toBe(1);
    expect(h.status().backup.last_set).not.toBe(future.name);
  });

  it("beslutningen er også robust alene: et fremtidsdatert nyeste sett er aldri «fersk»", () => {
    const status = emptyStatus();
    const nowMs = T0.getTime();
    expect(backupDecision({ roleEnabled: true, force: false, newestMs: nowMs + 3 * D, status, nowMs, intervalMs: D })).toEqual({ due: true, reason: "newest_set_dated_in_future" });
    expect(backupDecision({ roleEnabled: true, force: false, newestMs: nowMs + 60_000, status, nowMs, intervalMs: D })).toEqual({ due: false, reason: "fresh" }); // 1 min jitter tåles
  });

  it("tidsstempler i statusfilen som ligger i fremtiden forkastes (en rapport om «verifisert i 2030» holder ikke en fornyelse borte)", async () => {
    const h = harness({ identity: true });
    makeSet(h.out, hoursAgo(T0, 1));
    const st = emptyStatus();
    Object.assign(st.restore_verify, { state: "ok", last_success_at: "2030-01-01T00:00:00.000Z", last_attempt_at: "2030-01-01T00:00:00.000Z" });
    Object.assign(st.backup, { retry_after: "2031-01-01T00:00:00.000Z" });
    writeFileSync(h.config.statusFile, JSON.stringify(st));
    const r = await h.tick();
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "status_timestamps_in_future_dropped", fields: expect.arrayContaining(["restore_verify.last_success_at", "backup.retry_after"]) }));
    expect(r.actions).toEqual(["verify"]); // ikke lenger «fersk»: verifiseringen kjører
    expect(h.status().restore_verify.last_success_at).toBe(T0.toISOString());

    const status = emptyStatus();
    status.offsite.last_success_at = "2026-10-09T02:03:00.000Z"; // 3 min frem: innenfor jitter, beholdes
    expect(dropFutureTimestamps(status, T0.getTime())).toEqual([]);
    status.offsite.last_success_at = "2026-10-09T02:30:00.000Z";
    expect(dropFutureTimestamps(status, T0.getTime())).toEqual(["offsite.last_success_at"]);
    expect(status.offsite.last_success_at).toBeNull();
  });
});

describe("WP-C2 tick (review F4): vaktbikkja og hengt kjede - ETT tikk holder aldri låsen utover budsjettet, og en hengt lås varsles", () => {
  const never = () => new Promise(() => undefined);
  /** Samme tikk, men med et lite budsjett slik at vaktbikkja slår til i løpet av millisekunder. */
  const tiny = (h, ms = 150) => ({ ...h.config, tickBudgetMs: ms });

  it("off-site som henger for alltid: vaktbikkja gir opp, offsite_timeout i statusen, /fail, exit 5, og låsen er sluppet - neste tikk går som normalt", async () => {
    const sink = fakeSink();
    let resume;
    sink.push = () => new Promise((resolve) => { resume = () => resolve({ verification: "sha256", files: 5, bytes: 1 }); });
    const h = harness({ sink, flags: { roles: "backup,offsite", "status-export-dir": tempDir("wpc2-exp-") } });
    const t0 = Date.now();
    const r = await runTick(tiny(h), h.deps(), h.env);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r).toMatchObject({ exitCode: EXIT.OFFSITE_FAILED, outcome: "failed", failed: ["offsite"], actions: ["backup", "offsite"] });
    expect(h.logs).toContainEqual(expect.objectContaining({ level: "error", event: "tick_watchdog_fired", stage: "offsite" }));
    expect(h.hb).toEqual(["start", "fail"]);
    expect(existsSync(h.config.lockFile)).toBe(false); // låsen er sluppet: ingen skal vente på det hengte tikket
    expect(h.status().offsite).toMatchObject({ state: "failed", last_error_code: "offsite_timeout", consecutive_failures: 1 });
    expect(h.status().backup).toMatchObject({ consecutive_failures: 0 }); // backupen i samme tikk lyktes og står
    expect(h.exported().offsite).toMatchObject({ state: "failed", last_error_code: "offsite_timeout" });

    // Det hengte tikket våkner senere: det skal IKKE kunne skrive status, kjøre verify, pinge eller slette noe.
    const before = readFileSync(h.config.statusFile, "utf8");
    const hbBefore = [...h.hb];
    resume();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(h.config.statusFile, "utf8")).toBe(before);
    expect(h.hb).toEqual(hbBefore);

    // neste tikk (etter backoff) tar over uten å bli blokkert
    sink.push = async (prepared) => { sink.state.pushes.push(prepared); sink.state.remote.add(prepared.name); return { verification: "sha256", files: 5, bytes: 1 }; };
    h.advance(31 * 60_000);
    expect(await h.tick()).toMatchObject({ exitCode: EXIT.OK, actions: ["offsite"] });
  });

  it("backup som henger: backup_timeout, exit 2, /fail; retensjon kjører ikke; ingen halv suksess i statusen", async () => {
    const h = harness();
    for (const d of [40, 35]) makeSet(h.out, new Date(T0.getTime() - d * D)); // gamle sett som retensjonen ville fjernet
    const r = await runTick(tiny(h), h.deps({ backup: never }), h.env);
    expect(r).toMatchObject({ exitCode: EXIT.BACKUP_FAILED, outcome: "failed", failed: ["backup"], actions: ["backup"] });
    expect(h.status().backup).toMatchObject({ consecutive_failures: 1, last_error_code: "backup_timeout" });
    expect(h.hb).toEqual(["start", "fail"]);
    expect(existsSync(h.config.lockFile)).toBe(false);
    expect(listCompleteSets(h.out)).toHaveLength(2);
  });

  it("verify som henger: verify_timeout, exit 4; steg etter det hengte kjører ikke; en hengt heartbeat-start (utenfor steg) gir exit 1 uten å lyve om hvilket steg", async () => {
    const h = harness({ identity: true });
    makeSet(h.out, hoursAgo(T0, 1));
    const r = await runTick(tiny(h), h.deps({ verify: never }), h.env);
    expect(r).toMatchObject({ exitCode: EXIT.VERIFY_FAILED, outcome: "failed", failed: ["verify"] });
    expect(h.status().restore_verify).toMatchObject({ state: "failed", last_error_code: "verify_timeout" });

    const g = harness();
    const hung = { configured: true, start: never, success: async () => ({ ok: true }), fail: async () => { g.hb.push("fail"); return { ok: true }; }, last: () => ({ last_ping_at: null, last_ping_kind: null, last_ping_ok: null, last_error_code: null }) };
    const r2 = await runTick(tiny(g), g.deps({ heartbeat: hung }), g.env);
    expect(r2).toMatchObject({ exitCode: EXIT.USAGE, outcome: "failed", failed: ["tick"] });
    expect(g.backupCalls).toBe(0);
    expect(existsSync(g.config.lockFile)).toBe(false);
  });

  it("et tikk innenfor budsjettet påvirkes ikke (vaktbikkja er bare et tak)", async () => {
    const h = harness();
    const r = await runTick({ ...h.config, tickBudgetMs: 60_000 }, h.deps(), h.env);
    expect(r).toMatchObject({ exitCode: EXIT.OK, outcome: "ok" });
    expect(h.logs.filter((l) => l.event === "tick_watchdog_fired")).toEqual([]);
  });

  it("tikk-budsjettet i konfigen er summen av de påslåtte stegenes frister + slark", () => {
    const cfg = (flags, env = {}) => loadScheduleConfig({ out: tempDir(), ...flags }, env).tickBudgetMs / 60_000;
    expect(cfg({})).toBe(240 + 120 + 15); // backup + verify (off-site ikke satt opp)
    expect(cfg({ roles: "backup" })).toBe(240 + 15);
    expect(cfg({ roles: "verify" })).toBe(120 + 15);
    expect(cfg({}, { JARVIS_BACKUP_OFFSITE_LOCAL_DIR: "/mnt/usb/x", JARVIS_BACKUP_OFFSITE_TIMEOUT_MINUTES: "30", JARVIS_BACKUP_MAX_RUN_MINUTES: "60", JARVIS_BACKUP_VERIFY_TIMEOUT_MINUTES: "10" })).toBe(60 + 2 * 30 + 10 + 15);
  });

  it("en lås som har vært holdt lenger enn 2 × intervallet (og tikk-budsjettet) er en HENGT kjede: høylytt feil + exit 3, men aldri noe handling uten låsen", async () => {
    const h = harness();
    const holder = (startedMsAgo) => writeFileSync(h.config.lockFile, `${JSON.stringify({ token: "annen", pid: process.pid, host: hostname(), started_at: new Date(T0.getTime() - startedMsAgo).toISOString() })}\n`);
    holder(3 * D);
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OVERDUE, outcome: "lock_held_too_long", actions: [] });
    expect(h.logs).toContainEqual(expect.objectContaining({ level: "error", event: "lock_held_too_long", holder_pid: process.pid, held_hours: 72, limit_hours: 48 }));
    expect(h.backupCalls).toBe(0);
    expect(existsSync(h.config.statusFile)).toBe(false);
    expect(existsSync(h.config.lockFile)).toBe(true); // den andres lås røres ikke

    // innenfor 2 × intervall er det et vanlig, stille hopp over (et langt, men legitimt tikk)
    holder(47 * H);
    expect(await h.tick()).toMatchObject({ exitCode: EXIT.OK, outcome: "skipped_lock_held" });
    // ukjent starttid: kan ikke vurderes, så stille hopp over (alder på hjerteslaget avgjør foreldelse som før)
    writeFileSync(h.config.lockFile, `${JSON.stringify({ token: "annen", pid: process.pid, host: hostname() })}\n`);
    expect(await h.tick()).toMatchObject({ exitCode: EXIT.OK, outcome: "skipped_lock_held" });
    // et langt intervall hever terskelen tilsvarende
    const long = harness({ env: { JARVIS_BACKUP_INTERVAL_HOURS: "168" } });
    writeFileSync(long.config.lockFile, `${JSON.stringify({ token: "annen", pid: process.pid, host: hostname(), started_at: new Date(T0.getTime() - 10 * D).toISOString() })}\n`);
    expect(await long.tick()).toMatchObject({ outcome: "skipped_lock_held" });
  });
});

describe("WP-C2 tick (review F7): retensjon beskytter siste verifiserte og off-site-bekreftede sett, pauser ved feil og har tak per tikk", () => {
  const mk = (days) => ({ name: `s${days}`, dir: `/x/s${days}`, createdMs: T0.getTime() - days * D });
  const names = (list) => list.map((x) => x.name);
  /** `n` daglige sett, det nyeste 2 t gammelt (ferskt nok til at backup ikke er forfalt). */
  const manySets = (h, n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(makeSet(h.out, new Date(T0.getTime() - (2 / 24 + i) * D)));
    return out; // [0] = nyeste
  };
  const withStatus = (h, mutate) => {
    const st = emptyStatus();
    mutate(st);
    writeFileSync(h.config.statusFile, JSON.stringify(st));
  };

  it("setsToPrune: de N nyeste og de beskyttede beholdes; grensen er STRENGT eldre enn retainDays (mutant R8: ±1 dag/±1 ms)", () => {
    const sets = [50, 45, 40, 35, 31, 29, 10, 5, 1].map(mk);
    expect(names(setsToPrune(sets, 30, T0.getTime()))).toEqual(["s50", "s45", "s40", "s35", "s31"]);
    expect(names(setsToPrune(sets, 30, T0.getTime(), { keepNewest: 7 }))).toEqual(["s50", "s45"]);
    expect(names(setsToPrune(sets, 30, T0.getTime(), { protect: ["s45", "s31", null, "finnes-ikke"] }))).toEqual(["s50", "s40", "s35"]);
    expect(names(setsToPrune(sets, 30, T0.getTime(), { keepNewest: 0 }))).toEqual(["s50", "s45", "s40", "s35", "s31"]); // minst det nyeste, også med 0
    expect(setsToPrune(sets, 30, T0.getTime(), { keepNewest: 99 })).toEqual([]);
    // grensen: nøyaktig 30 døgn gammelt beholdes, 1 ms eldre fjernes; 1 døgn feil i hver retning
    const older = { name: "eldre", dir: "/x/eldre", createdMs: T0.getTime() - 30 * D - 1 };
    const exact = { name: "noyaktig", dir: "/x/noyaktig", createdMs: T0.getTime() - 30 * D };
    const newer = { name: "nyere", dir: "/x/nyere", createdMs: T0.getTime() - 29 * D };
    expect(names(setsToPrune([older, exact, newer, mk(0)], 30, T0.getTime()))).toEqual(["eldre"]);
    expect(names(setsToPrune([older, exact, newer, mk(0)], 31, T0.getTime()))).toEqual([]); // +1 døgn i retensjon: ingenting er gammelt nok
    expect(names(setsToPrune([older, exact, newer, mk(0)], 29, T0.getTime()))).toEqual(["eldre", "noyaktig"]); // -1 døgn: også det nøyaktige er gammelt nok
  });

  it("46 sett og off-site som har feilet 99 ganger: INGENTING slettes (pause `offsite_failing`) - tidligere gikk 16 sett, inkludert det siste verifiserte", async () => {
    const sink = fakeSink();
    const h = harness({ sink, flags: { roles: "backup,offsite" } });
    manySets(h, 46);
    withStatus(h, (st) => {
      Object.assign(st.offsite, { state: "failed", adapter: "local", consecutive_failures: 99, retry_after: new Date(T0.getTime() + 3 * H).toISOString(), last_error_code: "offsite_failed" });
    });
    const r = await h.tick();
    expect(r.actions).toEqual([]);
    expect(listCompleteSets(h.out)).toHaveLength(46);
    expect(h.status().retention).toMatchObject({ last_skipped_reason: "offsite_failing", last_pruned_count: 0 });
    expect(h.status().offsite).toMatchObject({ state: "failed", consecutive_failures: 99 });
  });

  it("restore-verifisering som har feilet: ingen sletting (pause `verify_failing`), også når feilen er meldt av en ekstern verifiserer", async () => {
    const h = harness({ identity: true });
    manySets(h, 46);
    withStatus(h, (st) => {
      Object.assign(st.restore_verify, { state: "failed", last_attempt_at: new Date(T0.getTime() - H).toISOString(), retry_after: new Date(T0.getTime() + 5 * H).toISOString(), last_error_code: "verify_mismatch", consecutive_failures: 2 });
    });
    await h.tick();
    expect(listCompleteSets(h.out)).toHaveLength(46);
    expect(h.status().retention.last_skipped_reason).toBe("verify_failing");
  });

  it("frisk kjede: siste verifiserte og siste off-site-bekreftede sett er beskyttet uansett alder, de 7 nyeste beholdes, og høyst 3 slettes per tikk (eldste først) med en advarsel", async () => {
    const h = harness();
    const sets = manySets(h, 46);
    const verified = sets[40]; // 40 døgn gammelt: utenfor retensjonen, men det siste beviset på at en restore virker
    const confirmed = sets[35];
    withStatus(h, (st) => {
      Object.assign(st.restore_verify, { state: "ok", last_attempt_at: new Date(T0.getTime() - D).toISOString(), last_success_at: new Date(T0.getTime() - D).toISOString(), last_success_set: verified.name, last_set: sets[0].name });
      Object.assign(st.offsite, { state: "ok", last_set: confirmed.name, last_success_at: new Date(T0.getTime() - D).toISOString() });
    });
    await h.tick();
    // kandidater: sett eldre enn 30 d (i = 30..45, 16 stk) minus de to beskyttede = 14; høyst 3 av dem, de eldste
    expect(listCompleteSets(h.out).map((x) => x.name)).not.toContain(sets[45].name);
    expect(listCompleteSets(h.out)).toHaveLength(43);
    expect(h.status().retention).toMatchObject({ last_pruned_count: 3, last_skipped_reason: null });
    expect(h.logs).toContainEqual(expect.objectContaining({ level: "warn", event: "retention_prune_capped", candidates: 14, pruned_now: 3, cap: 3 }));
    // flere tikk: resten (14 totalt) går gradvis, de to beskyttede og alt innenfor retensjonen står
    for (let i = 0; i < 6; i++) {
      h.advance(15 * 60_000);
      await h.tick();
    }
    const left = new Set(listCompleteSets(h.out).map((x) => x.name));
    expect(left.size).toBe(46 - 14);
    expect(left.has(verified.name) && left.has(confirmed.name)).toBe(true);
    for (let i = 0; i < 30; i++) expect(left.has(sets[i].name), `sett ${i} d`).toBe(true);
    for (const i of [30, 31, 32, 33, 34, 36, 37, 38, 39, 41, 42, 43, 44, 45]) expect(left.has(sets[i].name), `sett ${i} d`).toBe(false);
  });

  it("retensjonsdøgn satt til 1 beholder likevel de 7 nyeste (en feilkonfigurasjon eller klokkefeil tømmer ikke mappen)", async () => {
    const h = harness({ env: { JARVIS_BACKUP_RETAIN_DAYS: "1" } });
    const sets = manySets(h, 20);
    for (let i = 0; i < 8; i++) {
      await h.tick();
      h.advance(15 * 60_000);
    }
    const left = listCompleteSets(h.out).map((x) => x.name);
    expect(left).toEqual(sets.slice(0, 7).map((x) => x.name).reverse());
  });

  it("klokken hopper 20 døgn frem: retensjonen HOLDES i minst et døgn (ingen sletting) i stedet for å tømme mappen på 15 minutter; deretter gradvis", async () => {
    const h = harness();
    const sets = [];
    for (let i = 1; i <= 29; i++) sets.push(makeSet(h.out, new Date(T0.getTime() - i * D)));
    withStatus(h, (st) => {
      st.last_tick_at = T0.toISOString(); // forrige tikk, før hoppet
    });
    h.set(new Date(T0.getTime() + 20 * D));
    const first = await h.tick();
    expect(first.actions).toEqual(["backup"]); // nyeste sett er nå 21 d gammelt: backup tas
    expect(listCompleteSets(h.out)).toHaveLength(30);
    expect(h.status().retention).toMatchObject({ last_skipped_reason: "time_gap_hold", hold_until: new Date(T0.getTime() + 21 * D).toISOString() });
    expect(h.logs).toContainEqual(expect.objectContaining({ level: "warn", event: "tick_gap_retention_hold", gap_hours: 480, hold_hours: 24 }));
    h.advance(15 * 60_000);
    await h.tick();
    expect(listCompleteSets(h.out)).toHaveLength(30);
    h.advance(25 * H); // holdet har utløpt, og klokken har stått feil lenge nok til at det er den nye virkeligheten
    await h.tick();
    expect(h.status().retention.last_skipped_reason).toBeNull();
    expect(listCompleteSets(h.out).length).toBeLessThan(31); // pruning pågår igjen (høyst 3 per tikk), ikke alt på én gang
    expect(listCompleteSets(h.out).length).toBeGreaterThan(26);
    expect(sets.length).toBe(29);
  });

  it("en hold_until langt frem i tid (redigert/korrupt statusfil) forkastes: pruning blokkeres ikke for alltid", async () => {
    const h = harness();
    manySets(h, 40);
    withStatus(h, (st) => {
      st.retention.hold_until = "2099-01-01T00:00:00.000Z";
    });
    await h.tick();
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "status_timestamps_in_future_dropped", fields: expect.arrayContaining(["retention.hold_until"]) }));
    expect(h.status().retention.last_skipped_reason).toBeNull();
    expect(listCompleteSets(h.out).length).toBeLessThan(40);
  });

  it("mutant R7: uten backup-rollen (verifisering/off-site på en annen maskin eller en drill-mappe) slettes ALDRI sett, uansett alder", async () => {
    for (const flags of [{ roles: "verify" }, { roles: "offsite" }, { roles: "verify,offsite" }]) {
      const h = harness({ identity: true, sink: fakeSink(), flags });
      const old = [];
      for (const d of [90, 60, 45, 40]) old.push(makeSet(h.out, new Date(T0.getTime() - d * D)));
      manySets(h, 10);
      await h.tick();
      const left = new Set(listCompleteSets(h.out).map((x) => x.name));
      for (const o of old) expect(left.has(o.name), `${flags.roles}: ${o.name}`).toBe(true);
      expect(h.status().retention).toMatchObject({ last_pruned_at: null, last_pruned_count: 0 });
    }
    // motstykket: med backup-rollen slettes de gamle
    const h = harness();
    for (const d of [90, 60]) makeSet(h.out, new Date(T0.getTime() - d * D));
    manySets(h, 10);
    await h.tick();
    expect(listCompleteSets(h.out)).toHaveLength(10);
  });
});

describe("WP-C2 tick (review F8): «komplett sett» betyr at filene manifestet lister faktisk finnes - et hult sett undertrykker ikke neste backup", () => {
  const hollowCases = [
    ["en dump er slettet", (set) => rmSync(join(set.dir, "jarvis.dump.age")), /mangler: jarvis\.dump\.age/],
    ["globals er slettet", (set) => rmSync(join(set.dir, "globals.sql.age")), /mangler: globals\.sql\.age/],
    ["en dump er avkortet (størrelsen avviker fra manifestet)", (set) => writeFileSync(join(set.dir, "infisical.dump.age"), "kort"), /størrelsen avviker fra manifestet: infisical\.dump\.age/],
    ["en dump er tom", (set) => writeFileSync(join(set.dir, "langfuse.dump.age"), ""), /tom: langfuse\.dump\.age/],
    ["globals er tom", (set) => writeFileSync(join(set.dir, "globals.sql.age"), ""), /tom: globals\.sql\.age/],
    ["en dump er byttet ut med en katalog", (set) => { rmSync(join(set.dir, "jarvis.dump.age")); mkdirSync(join(set.dir, "jarvis.dump.age")); }, /ikke en vanlig fil: jarvis\.dump\.age/],
    ["en dump er byttet ut med en symlenke", (set) => { rmSync(join(set.dir, "jarvis.dump.age")); symlinkSync(join(set.dir, "infisical.dump.age"), join(set.dir, "jarvis.dump.age")); }, /ikke en vanlig fil: jarvis\.dump\.age/],
    ["manifestet lister en sti utenfor settet", (set) => { const m = JSON.parse(readFileSync(join(set.dir, "manifest.json"), "utf8")); m.databases[0].file = "../../etc/passwd.age"; writeFileSync(join(set.dir, "manifest.json"), JSON.stringify(m)); }, /ugyldig navn/],
    ["manifestet lister ingen databaser", (set) => { const m = JSON.parse(readFileSync(join(set.dir, "manifest.json"), "utf8")); m.databases = []; writeFileSync(join(set.dir, "manifest.json"), JSON.stringify(m)); }, /ingen databaser/]
  ];

  it("hvert hult sett er IKKE komplett (setFileProblems forklarer hvorfor) - et helt sett er det, også med ekstra filer (SHA256SUMS, manifest.json.age)", () => {
    for (const [what, damage, expected] of hollowCases) {
      const out = tempDir();
      const set = makeSet(out, hoursAgo(T0, 2));
      writeFileSync(join(set.dir, "manifest.json.age"), "ekstra");
      damage(set);
      const manifest = JSON.parse(readFileSync(join(set.dir, "manifest.json"), "utf8"));
      expect(setFileProblems(set.dir, manifest).join("; "), what).toMatch(expected);
      expect(listCompleteSets(out), what).toEqual([]);
      expect(findHollowSets(out).map((h) => h.name), what).toEqual([set.name]);
    }
    const out = tempDir();
    const whole = makeSet(out, hoursAgo(T0, 2));
    writeFileSync(join(whole.dir, "manifest.json.age"), "ekstra");
    expect(listCompleteSets(out).map((x) => x.name)).toEqual([whole.name]);
    expect(findHollowSets(out)).toEqual([]);
  });

  it("et HULT sett tatt for 2 t siden undertrykker ikke lenger neste backup: backup tas, det hule settet logges og røres ikke", async () => {
    const h = harness();
    const hollow = makeSet(h.out, hoursAgo(T0, 2));
    rmSync(join(hollow.dir, "jarvis.dump.age"));
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OK, actions: ["backup"], decisions: { backup: { due: true, reason: "no_backup_exists" } } });
    expect(h.logs).toContainEqual(expect.objectContaining({ level: "warn", event: "set_incomplete", set: hollow.name, problems: expect.stringContaining("mangler: jarvis.dump.age") }));
    expect(listCompleteSets(h.out).map((x) => x.name)).not.toContain(hollow.name);
    expect(existsSync(join(hollow.dir, "infisical.dump.age"))).toBe(true); // restene kan være det eneste som er igjen: aldri automatisk sletting
    expect(h.status().backup.last_set).not.toBe(hollow.name);
  });

  it("før F8: nyeste sett hult + 2 t gammelt ga `fresh` og null backup; nå vurderes backup-beslutningen fra det nyeste KOMPLETTE settet", async () => {
    const h = harness();
    makeSet(h.out, hoursAgo(T0, 30)); // komplett men gammelt
    const hollow = makeSet(h.out, hoursAgo(T0, 1));
    writeFileSync(join(hollow.dir, "globals.sql.age"), "");
    const r = await h.tick();
    expect(r.actions).toEqual(["backup"]);
    expect(r.decisions.backup).toMatchObject({ due: true, reason: "interval_elapsed" });
  });
});

describe("WP-C2 tick (review F11): kilde off-site verifiserer settet som hører til det lokale nyeste - ikke «siste navn» fra et mål andre kan skrive til", () => {
  const MIN = 60_000;
  /** PC-en med privatnøkkelen (kun verify-rollen) eller NAS-en (har lokale sett): `local` bestemmer om det finnes et lokalt komplett sett. */
  const setup = (remote, { local = true } = {}) => {
    const sink = fakeSink({ remote });
    const h = harness({ identity: true, sink, env: { JARVIS_BACKUP_OFFSITE_LOCAL_DIR: "/mnt/usb/jarvis" }, flags: { roles: "verify", "verify-source": "offsite" } });
    const set = local ? makeSet(h.out, hoursAgo(T0, 3)) : null;
    return { sink, h, set };
  };
  const stamp = (ms) => `jarvis-backup-${new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;

  it("setNameMs: kun navn som er en ekte dato gir et tidspunkt (siffermønsteret alene slipper `99999999T999999Z` og måned 00 gjennom)", () => {
    expect(setNameMs("jarvis-backup-20261009T020000Z")).toBe(Date.UTC(2026, 9, 9, 2, 0, 0));
    expect(setNameMs("jarvis-backup-20240229T235959Z")).toBe(Date.UTC(2024, 1, 29, 23, 59, 59));
    for (const bad of ["jarvis-backup-99999999T999999Z", "jarvis-backup-20260000T000000Z", "jarvis-backup-20261301T000000Z", "jarvis-backup-20260100T000000Z", "jarvis-backup-20260229T000000Z",
      "jarvis-backup-20261009T250000Z", "jarvis-backup-20261009T006000Z", "jarvis-backup-20261009T000060Z", "jarvis-backup-20261009", "annet", "", undefined]) {
      expect(setNameMs(bad), String(bad)).toBeNull();
    }
  });

  it("plantede navn (langt frem, umulig dato, ugyldig måned) er aldri kandidater: settet som hører til det lokale nyeste hentes og verifiseres, og navnene nevnes som advarsel", async () => {
    const planted = ["jarvis-backup-20991231T235959Z", "jarvis-backup-99999999T999999Z", "jarvis-backup-20261340T000000Z", stamp(T0.getTime() + 20 * MIN)];
    const { sink, h, set } = setup(["jarvis-backup-20261001T020000Z", ...planted]);
    // fjernmålet har det lokale nyeste settet også
    sink.state.remote.add(set.name);
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.OK, actions: ["verify"] });
    expect(sink.state.fetches).toEqual([set.name]);
    expect(h.status().restore_verify).toMatchObject({ state: "ok", last_set: set.name, last_success_set: set.name, source: "offsite" });
    expect(h.logs).toContainEqual(expect.objectContaining({ level: "warn", event: "offsite_set_name_implausible", count: 4 }));
  });

  it("et PLAUSIBELT, nyere navn rett etter det nyeste (alle 'ser' ekte ut) stjeler ikke verifiseringen: den feiler høylytt og ingenting hentes", async () => {
    const { sink, h, set } = setup([]);
    const planted = stamp(T0.getTime() - 1 * MIN); // etter det lokale nyeste (-3 t), før «nå»: lexikografisk SIST, men ikke vårt
    sink.state.remote.add(set.name);
    sink.state.remote.add(planted);
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.VERIFY_FAILED, failed: ["verify"] });
    expect(sink.state.fetches).toEqual([]);
    expect(h.verifyCalls).toEqual([]);
    expect(h.status().restore_verify).toMatchObject({ state: "failed", last_error_code: "verify_failed" });
    expect(h.status().restore_verify.last_error).toContain(`off-site-målet har nyere sett (${planted}) enn det nyeste lokale (${set.name})`);
    expect(readdirSync(h.out).filter((n) => n.startsWith(".verify-tmp-"))).toEqual([]);
  });

  it("det nyeste lokale settet finnes ikke off-site (kopien er etter): verifiseres IKKE et eldre fjernt sett i stedet - feil med årsaken", async () => {
    const { sink, h, set } = setup(["jarvis-backup-20261001T020000Z", "jarvis-backup-20261005T020000Z"]);
    const r = await h.tick();
    expect(r).toMatchObject({ exitCode: EXIT.VERIFY_FAILED, failed: ["verify"] });
    expect(sink.state.fetches).toEqual([]);
    expect(h.status().restore_verify.last_error).toContain(`det nyeste lokale settet (${set.name}) finnes ikke i off-site-målet`);
    expect(h.status().restore_verify.last_success_at).toBeNull();
  });

  it("uten lokale sett (PC-en): det nyeste PLAUSIBLE fjerne settet velges - fremtidsnavn hoppes over; bare implausible navn gir «ingen sett»", async () => {
    const a = setup(["jarvis-backup-20261001T020000Z", "jarvis-backup-20261008T020000Z", "jarvis-backup-20991231T235959Z", "jarvis-backup-99999999T999999Z"], { local: false });
    expect((await a.h.tick()).exitCode).toBe(EXIT.OK);
    expect(a.sink.state.fetches).toEqual(["jarvis-backup-20261008T020000Z"]);

    const b = setup(["jarvis-backup-20260000T000000Z", "jarvis-backup-20991231T235959Z", "jarvis-backup-99999999T999999Z"], { local: false });
    expect(await b.h.tick()).toMatchObject({ exitCode: EXIT.VERIFY_FAILED, failed: ["verify"] });
    expect(b.sink.state.fetches).toEqual([]);
    expect(b.h.status().restore_verify.last_error).toContain("ingen sett i off-site-målet å verifisere");

    const empty = setup([], { local: false });
    expect(await empty.h.tick()).toMatchObject({ exitCode: EXIT.VERIFY_FAILED });
    expect(empty.h.status().restore_verify.last_error).toContain("ingen sett i off-site-målet å verifisere");
  });

  it("et lokalt sett datert i FREMTIDEN er ikke «det lokale nyeste» (klokkeavvik): da gjelder PC-regelen", async () => {
    const { sink, h } = setup(["jarvis-backup-20261008T020000Z"], { local: false });
    makeSet(h.out, new Date(T0.getTime() + 3 * D));
    const r = await h.tick();
    expect(r.exitCode).toBe(EXIT.OK);
    expect(sink.state.fetches).toEqual(["jarvis-backup-20261008T020000Z"]);
  });
});

describe("WP-C2 findOrphanSets / listCompleteSets", () => {
  it("komplett = gyldig manifest med dato; ufullstendige og korrupte listes ikke; ukjente navn ignoreres", () => {
    const out = tempDir();
    makeSet(out, hoursAgo(T0, 5));
    mkdirSync(join(out, "jarvis-backup-20261009T000000Z"));
    mkdirSync(join(out, "annet"));
    writeFileSync(join(out, "fil.txt"), "x");
    mkdirSync(join(out, "jarvis-backup-20250101T000000Z"));
    writeFileSync(join(out, "jarvis-backup-20250101T000000Z", "manifest.json"), "{kaputt");
    expect(listCompleteSets(out)).toHaveLength(1);
    expect(listCompleteSets(join(out, "finnes-ikke"))).toEqual([]);
  });
});
