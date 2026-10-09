import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, fakeBinDir, hoursAgo, makeSet, tempDir } from "./helpers.mjs";

afterAll(cleanupTempDirs);
const SRC = dirname(fileURLToPath(new URL("../acceptance-ops.sh", import.meta.url)));
const SCRIPT = join(SRC, "acceptance-ops.sh");

/**
 * acceptance-ops.sh uten NAS: i et midlertidig tre ligger det ekte scriptet ved siden av STUBBER for nas-schedule.sh (nas-modus) og schedule.mjs (drill/report),
 * som svarer med innlagte fixtures. Det beviser sjekklogikken, exit-kodene og at evidensen er ærlig - IKKE at noe virker på den ekte NAS-en (det er hele poenget med å kjøre det der).
 */
function tree() {
  const root = tempDir("ops-acc-");
  mkdirSync(join(root, "ops/backup"), { recursive: true });
  mkdirSync(join(root, "infra/local"), { recursive: true });
  copyFileSync(SCRIPT, join(root, "ops/backup/acceptance-ops.sh"));
  chmodSync(join(root, "ops/backup/acceptance-ops.sh"), 0o755);
  writeFileSync(join(root, "infra/local/docker-compose.yml"), "services: {}\n");
  const fx = join(root, "fixtures");
  mkdirSync(fx);
  // nas-schedule.sh-stub: <dir> <kommando> ...  -> svarer med fixtures/<kommando>.json og exit-kode fra fixtures/<kommando>.rc
  writeFileSync(join(root, "ops/backup/nas-schedule.sh"), `#!/usr/bin/env bash
cmd="$2"
echo "$*" >> "${fx}/calls.log"
[ -f "${fx}/$cmd.json" ] && cat "${fx}/$cmd.json"
[ -f "${fx}/$cmd.err" ] && cat "${fx}/$cmd.err" >&2
rc=0; [ -f "${fx}/$cmd.rc" ] && rc="$(cat "${fx}/$cmd.rc")"
exit "$rc"
`);
  chmodSync(join(root, "ops/backup/nas-schedule.sh"), 0o755);
  // schedule.mjs-stub (drill/report): tick skriver kvitteringen i --out og svarer; status svarer med fixture.
  writeFileSync(join(root, "ops/backup/schedule.mjs"), `
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
const fx = ${JSON.stringify(fx)};
const [cmd, ...rest] = process.argv.slice(2);
appendFileSync(fx + "/calls.log", cmd + " " + rest.join(" ") + "\\n");
const out = rest[rest.indexOf("--out") + 1];
const read = (n) => (existsSync(fx + "/" + n) ? readFileSync(fx + "/" + n, "utf8") : "");
if (cmd === "tick") {
  if (existsSync(fx + "/tick.report")) writeFileSync(out + "/restore-verify-report.json", read("tick.report"));
  process.stdout.write(read("tick.json"));
  process.exit(Number(read("tick.rc") || 0));
}
if (cmd === "status") { process.stdout.write(read("status.json")); process.exit(Number(read("status.rc") || 0)); }
process.exit(1);
`);
  const bin = fakeBinDir({
    docker: `echo "docker $*" >> "${fx}/calls.log"
case "$*" in
  *" exec "*) cat "${fx}/docker.exec" 2>/dev/null; exit 0;;
  *" logs "*) cat "${fx}/docker.logs" 2>/dev/null; exit 0;;
esac
exit 0`
  });
  const put = (name, value) => writeFileSync(join(fx, name), typeof value === "string" ? value : JSON.stringify(value));
  const run = (args, env = {}) => {
    const evidence = join(root, "evidence");
    const res = spawnSync("bash", [join(root, "ops/backup/acceptance-ops.sh"), ...args], {
      encoding: "utf8", timeout: 60_000, env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, JARVIS_ACCEPTANCE_OUT_DIR: evidence, ...env }
    });
    return { ...res, evidence, evidenceFiles: existsSync(evidence) ? readdirSync(evidence) : [], calls: existsSync(join(fx, "calls.log")) ? readFileSync(join(fx, "calls.log"), "utf8") : "" };
  };
  return { root, fx, put, run };
}

const NOW = new Date();
const statusFixture = (newest, over = {}) => ({
  ok: true, exit_code: 0, reasons: [],
  backup: { newest_set: newest, newest_at: new Date().toISOString(), age_hours: 0.02, consecutive_failures: 0, last_error_code: null },
  offsite: { state: "ok", adapter: "local" }, restore_verify: { state: "not_configured" },
  heartbeat: { configured: true, last_ping_at: new Date().toISOString(), last_ping_kind: "success", last_ping_ok: true, last_error_code: null },
  config: { backup_interval_hours: 24, restore_verify_interval_days: 7 },
  export: { configured: true, present: true, mode: "0644", world_readable: true, generated_at: new Date().toISOString(), age_minutes: 0 },
  ...over
});

describe("acceptance-ops.sh", () => {
  it("er gyldig bash; tørrkjøring lister sjekkene per modus uten å kjøre noe; ukjent modus og manglende mappe gir exit 1", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    const t = tree();
    const nas = t.run(["nas"], { JARVIS_ACCEPTANCE_DRY_RUN: "1" });
    expect(nas.status).toBe(0);
    for (const id of ["O01_scheduled_backup", "O02_set_encrypted", "O03_offsite_copy", "O04_heartbeat_received", "O05_status_export", "O06_api_sees_status", "O07_api_uptime_heartbeat", "O08_rpo"]) expect(nas.stdout).toContain(id);
    const drill = t.run(["drill"], { JARVIS_ACCEPTANCE_DRY_RUN: "1" });
    for (const id of ["D01_restore_verify", "D02_rto", "D03_rpo", "D04_report_for_nas"]) expect(drill.stdout).toContain(id);
    expect(nas.calls + drill.calls).toBe("");
    expect(t.run(["bogus", "/x"]).status).toBe(1);
    expect(t.run(["nas"]).status).toBe(1);
    expect(t.run(["nas", join(t.root, "finnes-ikke")]).status).toBe(1);
  });

  it("nas: alt bestått → exit 0, evidensfil skrevet; tvunget tikk brukt; ingen hemmeligheter i utskriften", () => {
    const t = tree();
    const dir = join(t.root, "backups");
    mkdirSync(dir);
    const set = makeSet(dir, hoursAgo(NOW, 0.01));
    t.put("tick.json", { ok: true, exit_code: 0, outcome: "ok", actions: ["backup", "offsite"], failed: [], newest_set: set.name });
    t.put("status.json", statusFixture(set.name));
    t.put("offsite-check.json", { configured: true, ok: true, adapter: "local", verification: "sha256", files: 5, bytes: 4096 });
    t.put("docker.exec", "READABLE\n");
    t.put("docker.logs", '{"msg":"uptime_heartbeat_started","host":"hc.example"}\n');
    const r = t.run(["nas", dir], { JARVIS_RPO_TARGET_HOURS: "30" });
    expect(r.stdout).toMatch(/O01_scheduled_backup\s+PASS/);
    expect(r.stdout).toMatch(/O02_set_encrypted\s+PASS/);
    expect(r.stdout).toMatch(/O03_offsite_copy\s+PASS.*sha256/);
    expect(r.stdout).toMatch(/O04_heartbeat_received\s+PASS/);
    expect(r.stdout).toMatch(/O05_status_export\s+PASS/);
    expect(r.stdout).toMatch(/O06_api_sees_status\s+PASS/);
    expect(r.stdout).toMatch(/O07_api_uptime_heartbeat\s+PASS/);
    expect(r.stdout).toMatch(/O08_rpo\s+PASS.*24\.25/);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.calls).toContain(`${dir} tick --force-backup --json --roles backup,offsite`);
    expect(r.evidenceFiles).toHaveLength(1);
    expect(readFileSync(join(r.evidence, r.evidenceFiles[0]), "utf8")).toContain("PASS=8 FAIL=0");
  });

  it("nas: ikke satt opp (off-site, heartbeat, eksport, API) er IKKE bestått - exit 3 med NOT_CONFIGURED, aldri en stille grønn", () => {
    const t = tree();
    const dir = join(t.root, "backups");
    mkdirSync(dir);
    const set = makeSet(dir, hoursAgo(NOW, 0.01));
    t.put("tick.json", { exit_code: 0, outcome: "ok", actions: ["backup"], failed: [], newest_set: set.name });
    t.put("status.json", statusFixture(set.name, { heartbeat: { configured: false }, export: { configured: false } }));
    t.put("offsite-check.json", { configured: false, ok: false });
    t.put("offsite-check.rc", "6");
    t.put("docker.exec", "UNSET\n");
    t.put("docker.logs", "");
    const r = t.run(["nas", dir]);
    expect(r.stdout).toMatch(/O03_offsite_copy\s+NOT_CONFIGURED.*BLOCKED_EXTERNAL/);
    expect(r.stdout).toMatch(/O04_heartbeat_received\s+NOT_CONFIGURED/);
    expect(r.stdout).toMatch(/O05_status_export\s+NOT_CONFIGURED/);
    expect(r.stdout).toMatch(/O06_api_sees_status\s+NOT_CONFIGURED/);
    expect(r.stdout).toMatch(/O07_api_uptime_heartbeat\s+NOT_CONFIGURED/);
    expect(r.stdout).toMatch(/O08_rpo\s+UNKNOWN.*RPO-mål er ikke satt/);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("IKKE lukket");
  });

  it("nas: feil gir FAIL og exit 1 - feilet tikk, klartekst i settet, ulesbar eksport, avvikende off-site, heartbeat som ikke ble mottatt", () => {
    const t = tree();
    const dir = join(t.root, "backups");
    mkdirSync(dir);
    const set = makeSet(dir, hoursAgo(NOW, 0.01));
    writeFileSync(join(set.dir, "jarvis.dump"), "PGDMP"); // en klartekst-dump i settet
    writeFileSync(join(set.dir, "globals.sql.age"), "ikke age"); // en fil uten age-header
    t.put("tick.json", { exit_code: 2, outcome: "failed", actions: ["backup"], failed: ["backup"], newest_set: set.name });
    t.put("tick.rc", "2");
    t.put("tick.err", '{"level":"error","event":"backup_failed"}\n');
    t.put("status.json", statusFixture(set.name, {
      heartbeat: { configured: true, last_ping_kind: "fail", last_ping_ok: false, last_error_code: "heartbeat_failed" },
      export: { configured: true, present: true, mode: "0600", world_readable: false, age_minutes: 1 }
    }));
    t.put("offsite-check.json", { configured: true, ok: false, error_code: "offsite_verify_failed", error: "mangler: jarvis.dump.age" });
    t.put("offsite-check.rc", "5");
    t.put("docker.exec", "MISSING\n");
    t.put("docker.logs", '{"msg":"uptime_heartbeat_started"}\n{"msg":"uptime_heartbeat_ping_failed"}\n');
    const r = t.run(["nas", dir]);
    expect(r.stdout).toMatch(/O01_scheduled_backup\s+FAIL.*exit 2/);
    expect(r.stdout).toMatch(/O02_set_encrypted\s+FAIL.*uten age-header/);
    expect(r.stdout).toMatch(/O03_offsite_copy\s+FAIL.*offsite_verify_failed/);
    expect(r.stdout).toMatch(/O04_heartbeat_received\s+FAIL/);
    expect(r.stdout).toMatch(/O05_status_export\s+FAIL.*ikke lesbar for andre/);
    expect(r.stdout).toMatch(/O06_api_sees_status\s+FAIL/);
    expect(r.stdout).toMatch(/O07_api_uptime_heartbeat\s+FAIL/);
    expect(r.status).toBe(1);
  });

  it("nas: for høyt RPO-verstetilfelle mot eierens mål gir FAIL (senk intervallet)", () => {
    const t = tree();
    const dir = join(t.root, "backups");
    mkdirSync(dir);
    const set = makeSet(dir, hoursAgo(NOW, 0.01));
    t.put("tick.json", { exit_code: 0, outcome: "ok", actions: ["backup"], failed: [], newest_set: set.name });
    t.put("status.json", statusFixture(set.name));
    t.put("offsite-check.json", { configured: true, ok: true, adapter: "local", verification: "size_only", files: 5, bytes: 1 });
    const r = t.run(["nas", dir], { JARVIS_RPO_TARGET_HOURS: "12" });
    expect(r.stdout).toMatch(/O08_rpo\s+FAIL.*> mål 12 t/);
    expect(r.status).toBe(1);
  });

  it("drill: måler RTO (henting + restore) og RPO (alder på settet), sammenligner med eierens mål, og peker på kvitteringen til NAS-en", () => {
    const t = tree();
    const dir = join(t.root, "pc-copy");
    const identity = join(t.root, "identity.txt");
    writeFileSync(identity, "AGE-SECRET-KEY-1TEST\n");
    const setName = `jarvis-backup-${new Date(NOW.getTime() - 6 * 3_600_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
    t.put("tick.json", { exit_code: 0, outcome: "ok", actions: ["verify"], failed: [], newest_set: null });
    t.put("tick.report", { schema: 1, finished_at: new Date().toISOString(), ok: true, set: setName, duration_s: 212, fetch_duration_s: 41, tables: 358, rows: 10346, source: "offsite" });
    t.put("status.json", statusFixture(null, { restore_verify: { state: "ok", last_set: setName, duration_s: 212, fetch_duration_s: 41, tables: 358, rows: 10346, source: "offsite" } }));
    const ok = t.run(["drill", dir, "--identity", identity, "--from-offsite"], { JARVIS_RTO_TARGET_MINUTES: "10", JARVIS_RPO_TARGET_HOURS: "26" });
    expect(ok.stdout).toMatch(/D01_restore_verify\s+PASS.*358 tabeller, 10346 rader/);
    expect(ok.stdout).toMatch(/D02_rto\s+PASS.*MÅLT RTO \(scratch\) = 4\.2 min.*henting 41 s \+ restore\/verifisering 212 s.*mål 10 min oppfylt/);
    expect(ok.stdout).toMatch(/D03_rpo\s+PASS.*MÅLT RPO = 6 t/);
    expect(ok.stdout).toMatch(/D04_report_for_nas\s+PASS/);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.calls).toContain(`tick --out ${dir} --roles verify --force-verify --json --verify-source offsite`);

    const tight = t.run(["drill", dir, "--identity", identity], { JARVIS_RTO_TARGET_MINUTES: "3", JARVIS_RPO_TARGET_HOURS: "4" });
    expect(tight.stdout).toMatch(/D02_rto\s+FAIL.*IKKE oppfylt/);
    expect(tight.stdout).toMatch(/D03_rpo\s+FAIL.*IKKE oppfylt/);
    expect(tight.status).toBe(1);
    expect(tight.calls.split("\n").filter((l) => l.startsWith("tick")).at(-1)).not.toContain("--verify-source"); // lokal kilde uten --from-offsite

    const noTargets = t.run(["drill", dir, "--identity", identity]);
    expect(noTargets.stdout).toMatch(/D02_rto\s+UNKNOWN.*RTO-mål er ikke satt/);
    expect(noTargets.stdout).toMatch(/D03_rpo\s+UNKNOWN.*RPO-mål er ikke satt/);
    expect(noTargets.status).toBe(3);
  });

  it("drill: uten privatnøkkel (eller med en verifisering som feilet) er det FAIL - aldri en stille bestått", () => {
    const t = tree();
    const dir = join(t.root, "pc-copy");
    const none = t.run(["drill", dir]);
    expect(none.stdout).toMatch(/D01_restore_verify\s+FAIL.*--identity/);
    expect(none.status).toBe(1);
    const identity = join(t.root, "identity.txt");
    writeFileSync(identity, "x");
    t.put("tick.rc", "4");
    t.put("tick.err", '{"level":"error","event":"verify_failed"}\n');
    t.put("status.json", statusFixture(null, { restore_verify: { state: "failed", last_error_code: "verify_mismatch" } }));
    const bad = t.run(["drill", dir, "--identity", identity]);
    expect(bad.stdout).toMatch(/D01_restore_verify\s+FAIL.*verify_mismatch/);
    expect(bad.stdout).toMatch(/D02_rto\s+FAIL/);
    expect(bad.status).toBe(1);
  });

  it("report: leser kun status (ingen kjøring) og skriver en sammenfatning", () => {
    const t = tree();
    const dir = join(t.root, "backups");
    mkdirSync(dir);
    t.put("status.json", statusFixture("jarvis-backup-20261009T020000Z"));
    const r = t.run(["report", dir]);
    expect(r.stdout).toMatch(/R01_status\s+PASS.*off-site ok.*restore-verify not_configured/);
    expect(r.calls).toMatch(/^status --out .* --json$/m);
    expect(r.calls).not.toContain("tick");
    expect(r.status).toBe(0);
  });
});
