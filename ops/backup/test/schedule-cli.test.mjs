import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { LOCAL_MARKER } from "../lib/offsite.mjs";
import { emptyStatus, writeJsonAtomic } from "../lib/state.mjs";
import { RECIPIENT, cleanupTempDirs, fakeEncryptManifest, hoursAgo, makeSet, tempDir } from "./helpers.mjs";

afterAll(cleanupTempDirs);
const CLI = fileURLToPath(new URL("../schedule.mjs", import.meta.url));
const NOW = new Date();

/** Kjører CLI-en som en egen prosess med et RENT miljø (ingenting fra verten lekker inn). */
function run(args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH, HOME: tempDir("wpc2-home-"), ...env } });
  return { ...res, json: (() => { try { return JSON.parse(res.stdout); } catch { return null; } })() };
}

describe("WP-C2 schedule.mjs: kommandolinje (streng, uten hemmeligheter på argv)", () => {
  it("ukjent kommando, ukjent flagg (skrivefeil), manglende --out og posisjonsargument gir exit 1 med tydelig feil - aldri en stille exit 0", () => {
    expect(run(["bogus"])).toMatchObject({ status: 1 });
    expect(run(["bogus"]).stderr).toContain("usage: schedule.mjs");
    const typo = run(["tick", "--out", tempDir(), "--force-bakcup"]);
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain("ukjent flagg: --force-bakcup");
    expect(run(["tick"]).stderr).toContain("--out");
    expect(run(["tick", "--out", tempDir(), "stray"]).status).toBe(1);
    expect(run(["tick", "--out"]).status).toBe(1);
    expect(run(["tick", "--out", tempDir(), "--roles", "backup,hack"]).stderr).toContain("--roles");
  });

  it("--dry-run viser hva som ville skjedd uten å skrive noe (ingen status, ingen lås) og uten hemmeligheter i miljøet", () => {
    const out = tempDir();
    const r = run(["tick", "--out", out, "--dry-run", "--roles", "backup,offsite,verify"]);
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({ ok: true, exit_code: 0, outcome: "dry_run", decisions: { backup: { due: true, reason: "no_backup_exists" }, offsite: { due: false, reason: "not_configured" }, verify: { due: false, reason: "not_configured" } } });
    expect(readdirSync(out)).toEqual([]);
  });

  it("tikk uten påkrevd miljø feiler høylytt FØR noe kjøres (exit 1), og feilen siterer aldri en hemmelig verdi", () => {
    const r = run(["tick", "--out", tempDir(), "--mode", "direct"], { JARVIS_BACKUP_AGE_RECIPIENT: "AGE-SECRET-KEY-1HEMMELIG" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("JARVIS_BACKUP_AGE_RECIPIENT");
    expect(r.stderr + r.stdout).not.toContain("HEMMELIG");
  });
});

describe("WP-C2 schedule.mjs status: overvåkingsvennlige exit-koder", () => {
  const stateWith = (out, mutate) => {
    const st = emptyStatus();
    mutate(st);
    writeJsonAtomic(join(out, "backup-status.json"), st);
  };

  it("frisk = 0; ingen backup eller for gammel = 3; feilet/gammel restore-verify = 4; feilet off-site = 5 (prioritet 3 > 4 > 5)", () => {
    const out = tempDir();
    expect(run(["status", "--out", out]).status).toBe(3);
    expect(run(["status", "--out", out]).json.reasons).toEqual(["no_complete_backup_set"]);

    makeSet(out, hoursAgo(NOW, 5));
    const ok = run(["status", "--out", out]);
    expect(ok.status).toBe(0);
    expect(ok.json).toMatchObject({ ok: true, reasons: [], backup: { age_hours: expect.any(Number) }, offsite: { state: "not_configured" }, restore_verify: { state: "not_configured" } });
    expect(ok.json.backup.age_hours).toBeGreaterThan(4.9);

    stateWith(out, (st) => { Object.assign(st.offsite, { state: "failed", last_error_code: "offsite_verify_failed" }); });
    expect(run(["status", "--out", out]).status).toBe(5);
    stateWith(out, (st) => { Object.assign(st.offsite, { state: "failed", last_error_code: "offsite_failed" }); Object.assign(st.restore_verify, { state: "failed", last_error_code: "verify_mismatch" }); });
    expect(run(["status", "--out", out]).status).toBe(4);
    expect(run(["status", "--out", out, "--max-backup-age-hours", "1"]).status).toBe(3);
  });

  it("restore-verify som er for gammel regnes som feil; --require-verify/--require-offsite krever bevis også når det ikke er satt opp", () => {
    const out = tempDir();
    makeSet(out, hoursAgo(NOW, 1));
    stateWith(out, (st) => { Object.assign(st.restore_verify, { state: "ok", last_success_at: new Date(NOW.getTime() - 20 * 86_400_000).toISOString() }); });
    expect(run(["status", "--out", out]).status).toBe(4);
    stateWith(out, (st) => { Object.assign(st.restore_verify, { state: "ok", last_success_at: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() }); });
    expect(run(["status", "--out", out]).status).toBe(0);
    stateWith(out, () => undefined);
    expect(run(["status", "--out", out, "--require-verify"]).status).toBe(4);
    expect(run(["status", "--out", out, "--require-offsite"]).status).toBe(5);
  });

  it("en ekstern verifiserers kvittering i state-mappen telles med (PC med privat nøkkel → NAS)", () => {
    const out = tempDir();
    makeSet(out, hoursAgo(NOW, 1));
    writeFileSync(join(out, "restore-verify-report.json"), JSON.stringify({ schema: 1, finished_at: hoursAgo(NOW, 3).toISOString(), ok: true, set: "jarvis-backup-20261001T000000Z", duration_s: 120, source: "offsite" }));
    const r = run(["status", "--out", out, "--require-verify"]);
    expect(r.status).toBe(0);
    expect(r.json.restore_verify).toMatchObject({ state: "ok", reported_by: "external_verifier", duration_s: 120, source: "offsite" });
  });

  it("ugyldige tall for terskler er en brukerfeil (exit 1)", () => {
    const out = tempDir();
    expect(run(["status", "--out", out, "--max-backup-age-hours", "-5"]).status).toBe(1);
    expect(run(["status", "--out", out, "--max-verify-age-days", "abc"]).status).toBe(1);
  });
});

describe("WP-C2 schedule.mjs: ekte kjøring med lokal off-site-adapter (ekte prosess, ekte filsystem)", () => {
  const setup = () => {
    const out = tempDir("wpc2-out-");
    const usb = tempDir("wpc2-usb-");
    writeFileSync(join(usb, LOCAL_MARKER), "");
    const set = makeSet(out, hoursAgo(NOW, 1));
    return { out, usb, set, prepare: () => fakeEncryptManifest({ setDir: set.dir }), env: { JARVIS_BACKUP_AGE_RECIPIENT: RECIPIENT, JARVIS_BACKUP_OFFSITE_LOCAL_DIR: usb, JARVIS_BACKUP_OFFSITE_LOCAL_ALLOW_SAME_DEVICE: "true" } };
  };

  it("tick --roles offsite: kopierer settet (kun .age), skriver status + eksport, er stille neste gang; offsite-check verifiserer og oppdager manipulasjon", async () => {
    const { out, usb, set, prepare, env } = setup();
    await prepare();
    const exportDir = join(tempDir("wpc2-exp-"), "pub");
    const first = run(["tick", "--out", out, "--roles", "offsite", "--status-export-dir", exportDir], env);
    expect(first.status, first.stderr).toBe(0);
    expect(first.json).toMatchObject({ ok: true, outcome: "ok", actions: ["offsite"], newest_set: set.name });
    expect(readdirSync(join(usb, set.name)).sort()).toEqual(["globals.sql.age", "infisical.dump.age", "jarvis.dump.age", "langfuse.dump.age", "manifest.json.age"]);
    expect(statSync(join(out, "backup-status.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(exportDir, "backup-status.json"), "utf8")).offsite).toMatchObject({ state: "ok", adapter: "local", last_set: set.name, verification: "sha256" });

    const second = run(["tick", "--out", out, "--roles", "offsite", "--status-export-dir", exportDir], env);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(""); // ingenting forfalt = stille (cron-mail)
    expect(second.stderr).toBe("");

    const check = run(["offsite-check", "--out", out], env);
    expect(check.status).toBe(0);
    expect(check.json).toMatchObject({ configured: true, ok: true, adapter: "local", newest_in_remote: true, verification: "sha256", files: 5 });

    writeFileSync(join(usb, set.name, "jarvis.dump.age"), "manipulert");
    const bad = run(["offsite-check", "--out", out], env);
    expect(bad.status).toBe(5);
    expect(bad.json).toMatchObject({ ok: false, error_code: "offsite_verify_failed" });
  });

  it("offsite-check uten adapter = exit 6 (BLOCKED_EXTERNAL, ikke en feil i koden); med et sett som mangler fjernt = exit 5", () => {
    const out = tempDir();
    makeSet(out, hoursAgo(NOW, 1));
    const none = run(["offsite-check", "--out", out]);
    expect(none.status).toBe(6);
    expect(none.json).toMatchObject({ configured: false, ok: false });
    const { usb } = setup();
    const missing = run(["offsite-check", "--out", out], { JARVIS_BACKUP_OFFSITE_LOCAL_DIR: usb, JARVIS_BACKUP_OFFSITE_LOCAL_ALLOW_SAME_DEVICE: "1", JARVIS_BACKUP_AGE_RECIPIENT: RECIPIENT });
    expect(missing.status).toBe(5);
    expect(missing.json.newest_in_remote).toBe(false);
  });

  it("to off-site-adaptere samtidig er en konfig-feil som rapporteres høylytt (exit 5, status `offsite_config_invalid`) - eieren velger ÉN, og ingenting sendes", async () => {
    const { out, usb, set, prepare, env } = setup();
    await prepare();
    const r = run(["tick", "--out", out, "--roles", "offsite"], { ...env, JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE: "b2:x" });
    expect(r.status).toBe(5);
    expect(r.json).toMatchObject({ outcome: "failed", failed: ["offsite"] });
    const st = JSON.parse(readFileSync(join(out, "backup-status.json"), "utf8"));
    expect(st.offsite).toMatchObject({ state: "failed", last_error_code: "offsite_config_invalid" });
    expect(st.offsite.last_error).toContain("kun ÉN off-site-adapter");
    expect(readdirSync(usb).filter((n) => n.startsWith("jarvis-backup-"))).toEqual([]);
    expect(set.name).toBeTruthy();
    const check = run(["offsite-check", "--out", out], { ...env, JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE: "b2:x" });
    expect(check.status).toBe(5);
    expect(check.json).toMatchObject({ configured: true, ok: false, error_code: "offsite_config_invalid" });
  });

  it("en lokal sti uten markørfil (avmontert disk) gir feilet off-site (exit 5), ikke en falsk suksess", async () => {
    const { out, prepare, env } = setup();
    await prepare();
    const bare = tempDir("wpc2-unmounted-");
    mkdirSync(join(bare, "jarvis"));
    const r = run(["tick", "--out", out, "--roles", "offsite"], { ...env, JARVIS_BACKUP_OFFSITE_LOCAL_DIR: join(bare, "jarvis") });
    expect(r.status).toBe(5);
    expect(r.json).toMatchObject({ outcome: "failed", failed: ["offsite"] });
    const st = JSON.parse(readFileSync(join(out, "backup-status.json"), "utf8"));
    expect(st.offsite).toMatchObject({ state: "failed", last_error_code: "offsite_config_invalid" });
  });
});
