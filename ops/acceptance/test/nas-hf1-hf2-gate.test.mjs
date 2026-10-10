import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WP-J (D-450): HF1/HF2-akseptansescriptet. Testes uten ekte docker: en falsk `docker` på PATH svarer med innlagte utdata, og UA-0-porten byttes mot et lite script (JARVIS_UA0_GATE), så
 * parse-/statuslogikken, flagg-inventaret (ingen verdier lekker), loggskanningen og exit-koden er bevist. Det beviser IKKE noe om den ekte NAS-en - det er hele poenget med å kjøre scriptet der.
 */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(ROOT, "ops/acceptance/nas-hf1-hf2-gate.sh");
const MIGS = readdirSync(join(ROOT, "modules/core/src/db/migrations")).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
const TEST_SRC = readFileSync(join(ROOT, "modules/core/test/remediation-2-schema-invariants.test.ts"), "utf8");
const EXEMPT = (() => {
  const block = TEST_SRC.slice(TEST_SRC.indexOf("const RLS_EXEMPT"));
  const body = block.slice(0, block.indexOf("\n  };"));
  return [...body.matchAll(/^ {4}([a-z_0-9]+):/gm)].map((m) => m[1]).sort().join(",");
})();
// bygges ved kjøring: gitleaks leser en bokstavelig token-streng i kildefilen som en ekte hemmelighet
const FAKE_GH_TOKEN = `${["gh", "p_"].join("")}${"a".repeat(36)}`;

function fakeEnv(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-hf-"));
  const cfg = {
    migrations: MIGS.join("\n"), select1: "1", norls: EXEMPT,
    apiEnv: "JARVIS_COUNCIL_PROPOSALS=off\nJARVIS_KNOWLEDGE_CLAIM_MIN_SOURCES=2\nJARVIS_OWNER_EXTRA_TENANTS=tenant-hemmelig-navn\nJARVIS_GITHUB_APP_ID=12345678\nPATH=/usr/bin",
    workerEnv: "JARVIS_KNOWLEDGE_SOURCES=[{\"id\":\"hemmelig\"}]\nJARVIS_JOB_RUNNER=\nPATH=/usr/bin",
    logs: '{"msg":"knowledge_source_synced","source_id":"notater"}\n{"msg":"heartbeat"}',
    bstat: "ok ok ok age_h=3", sockOk: "0",
    tables: { incident_transitions: "t", knowledge_documents: "t", claim_verifications: "t", product_usage_events: "t", business_change_log: "t" },
    incidents: "open:2 resolved:5", kd: "filesystem:12 obsidian:40", cl: "VERIFIED:1 PROVISIONAL:2", biztenants: "1", usage: "340", changelog: "7",
    ...overrides
  };
  writeFileSync(join(dir, "cfg.json"), JSON.stringify(cfg));
  const sh = `#!/usr/bin/env bash
CFG="${join(dir, "cfg.json")}"
val() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c[process.argv[2]]??""))' "$CFG" "$1"; }
tbl() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((c.tables||{})[process.argv[2]]??"f"))' "$CFG" "$1"; }
args="$*"
case "$args" in
  *" ps -q"*) echo cid123; exit 0;;
  *" logs "*) val logs; echo; exit 0;;
  *"exec -T api env"*) val apiEnv; echo; exit 0;;
  *"exec -T worker env"*) val workerEnv; echo; exit 0;;
  *"exec -T api node -e"*) val bstat; echo; exit 0;;
  *"exec -T worker sh -c"*) [ "$(val sockOk)" = "1" ] && exit 0 || exit 1;;
esac
last="\${@: -1}"
case "$args" in
  *"exec -T postgres"*)
    case "$last" in
      *schema_migrations*) val migrations; echo;;
      *"SELECT 1"*) val select1; echo;;
      *relrowsecurity*) val norls; echo;;
      *to_regclass*) name="\${last#*public.}"; name="\${name%%\\'*}"; tbl "$name"; echo;;
      *"FROM incidents"*) val incidents; echo;;
      *"FROM knowledge_documents"*) val kd; echo;;
      *"FROM claim_verifications"*) val cl; echo;;
      *"kind='business'"*) val biztenants; echo;;
      *"FROM product_usage_events"*) val usage; echo;;
      *"FROM business_change_log"*) val changelog; echo;;
    esac; exit 0;;
esac
exit 0
`;
  writeFileSync(join(dir, "docker"), sh);
  chmodSync(join(dir, "docker"), 0o755);
  return dir;
}

function fakeUa0(rc = 0, summary = "Sammendrag: PASS=12 WARN=0 UNKNOWN=0 FAIL=0") {
  const dir = mkdtempSync(join(tmpdir(), "fake-ua0-"));
  const file = join(dir, "ua0.sh");
  writeFileSync(file, `#!/usr/bin/env bash\necho "C01 PASS ok"\necho "${summary}"\nexit ${rc}\n`);
  chmodSync(file, 0o755);
  return file;
}

function run({ env = {}, overrides = {}, ua0 = fakeUa0() } = {}) {
  const fake = fakeEnv(overrides);
  const out = mkdtempSync(join(tmpdir(), "hf-out-"));
  const res = spawnSync("bash", [SCRIPT], {
    env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, JARVIS_UA0_GATE: ua0, JARVIS_ACCEPTANCE_OUT_DIR: out, ...env },
    encoding: "utf8", timeout: 90_000
  });
  return { ...res, text: res.stdout + res.stderr, outDir: out };
}
const rowOf = (text, id) => (text.split("\n").find((l) => l.startsWith(id)) ?? "");

describe("nas-hf1-hf2-gate.sh", () => {
  it("er gyldig bash og tørrkjøringen lister alle 13 sjekker uten å kjøre docker", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    const res = spawnSync("bash", [SCRIPT], { env: { ...process.env, JARVIS_ACCEPTANCE_DRY_RUN: "1", PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(res.status).toBe(0);
    for (const id of ["H00_code_version", "H01_ua0_gate", "H02_migrations_applied", "H03_rls_global_tables", "H04_feature_flags", "H05_exact_on_flags", "H06_job_runner", "H07_backup_status", "H08_sweep_failures_24h", "H09_incident_state", "H10_knowledge_state", "H11_business_state", "H12_secrets_in_logs"]) {
      expect(res.stdout, id).toContain(id);
    }
  });

  it("alt grønt: exit 0, evidensfil skrevet, og tilstandsradene viser tallene", () => {
    const res = run();
    expect(res.status, res.text).toBe(0);
    expect(rowOf(res.text, "H01_ua0_gate")).toContain("PASS");
    expect(rowOf(res.text, "H02_migrations_applied")).toContain("PASS");
    expect(rowOf(res.text, "H03_rls_global_tables")).toContain("PASS");
    expect(rowOf(res.text, "H05_exact_on_flags")).toContain("PASS");
    expect(rowOf(res.text, "H07_backup_status")).toContain("PASS");
    expect(rowOf(res.text, "H08_sweep_failures_24h")).toContain("PASS");
    expect(rowOf(res.text, "H12_secrets_in_logs")).toContain("PASS");
    expect(rowOf(res.text, "H09_incident_state")).toContain("open:2 resolved:5");
    expect(rowOf(res.text, "H10_knowledge_state")).toContain("filesystem:12");
    expect(rowOf(res.text, "H10_knowledge_state")).toContain("VERIFIED:1");
    expect(rowOf(res.text, "H11_business_state")).toContain("produktbruk-hendelser: 340");
    const files = readdirSync(res.outDir).filter((f) => f.startsWith("nas-hf1-hf2-gate-"));
    expect(files).toHaveLength(1);
    const evidence = readFileSync(join(res.outDir, files[0]), "utf8");
    expect(evidence).toContain("# HF1/HF2 NAS-akseptanse");
    expect(evidence).toMatch(/Sammendrag: PASS=\d+ WARN=0 UNKNOWN=\d+ FAIL=0 INFO=\d+/);
  });

  it("flagg-inventaret viser verdi KUN for ufarlige verdier (on/off/tall) - ellers «satt», og aldri tenant-navn, URL-er eller JSON", () => {
    const res = run();
    const row = rowOf(res.text, "H04_feature_flags");
    expect(row).toContain("INFO");
    expect(row).toContain("JARVIS_COUNCIL_PROPOSALS=off");
    expect(row).toContain("JARVIS_KNOWLEDGE_CLAIM_MIN_SOURCES=2");
    expect(row).toContain("JARVIS_OWNER_EXTRA_TENANTS=satt");
    expect(row).toContain("JARVIS_GITHUB_APP_ID=satt"); // rene tall vises bare opp til 6 siffer; en lengre id (GitHub App-id) er «satt», aldri verdien
    expect(res.text).not.toContain("12345678");
    expect(res.text).not.toContain("tenant-hemmelig-navn");
    expect(res.text).not.toContain("hemmelig\"");
  });

  it("UA-0-porten med FAIL gir H01 FAIL og exit 1; en UA-0-port som ikke kan kjøre gir UNKNOWN", () => {
    const failed = run({ ua0: fakeUa0(1, "Sammendrag: PASS=10 WARN=0 UNKNOWN=0 FAIL=2") });
    expect(rowOf(failed.text, "H01_ua0_gate")).toContain("FAIL");
    expect(failed.status).toBe(1);
    const broken = run({ ua0: fakeUa0(2) });
    expect(rowOf(broken.text, "H01_ua0_gate")).toContain("UNKNOWN");
    const missing = run({ env: { JARVIS_UA0_GATE: "/finnes/ikke.sh" } });
    expect(rowOf(missing.text, "H01_ua0_gate")).toContain("UNKNOWN");
  });

  it("migrasjoner som ikke er anvendt gir H02 FAIL og navngir dem", () => {
    const res = run({ overrides: { migrations: MIGS.slice(0, -2).join("\n") } });
    const row = rowOf(res.text, "H02_migrations_applied");
    expect(row).toContain("FAIL");
    expect(row).toContain(MIGS[MIGS.length - 1]);
    expect(res.status).toBe(1);
  });

  it("RLS: avvik fra de dokumenterte globale tabellene (listen leses fra CI-testen) gir FAIL; samme liste gir PASS", () => {
    expect(rowOf(run().text, "H03_rls_global_tables")).toContain("PASS");
    const extra = run({ overrides: { norls: `${EXEMPT},ny_tabell_uten_rls` } });
    expect(rowOf(extra.text, "H03_rls_global_tables")).toContain("FAIL");
    expect(rowOf(extra.text, "H03_rls_global_tables")).toContain("ny_tabell_uten_rls");
    expect(extra.status).toBe(1);
  });

  it("nesten-riktige flaggverdier (ON, 1, yes) gir H05 WARN - flagget er da STILLE AV", () => {
    const res = run({ overrides: { apiEnv: "JARVIS_KNOWLEDGE_CLAIM_WRITES=ON\nJARVIS_COUNCIL_PROPOSALS=yes\nJARVIS_INCIDENT_PRODUCERS_ENABLED=1\nPATH=/usr/bin" } });
    const row = rowOf(res.text, "H05_exact_on_flags");
    expect(row).toContain("WARN");
    for (const name of ["JARVIS_KNOWLEDGE_CLAIM_WRITES", "JARVIS_COUNCIL_PROPOSALS", "JARVIS_INCIDENT_PRODUCERS_ENABLED"]) expect(row).toContain(name);
    const exact = run({ overrides: { apiEnv: "JARVIS_KNOWLEDGE_CLAIM_WRITES=on\nJARVIS_COUNCIL_PROPOSALS=off\nJARVIS_INCIDENT_PRODUCERS_ENABLED=true\nPATH=/usr/bin" } });
    expect(rowOf(exact.text, "H05_exact_on_flags")).toContain("PASS");
  });

  it("job-runner: av = INFO; host uten socket-variabel = FAIL; host med socket i containeren = PASS; host uten socket i containeren = FAIL", () => {
    expect(rowOf(run().text, "H06_job_runner")).toContain("INFO");
    const noVar = run({ overrides: { workerEnv: "JARVIS_JOB_RUNNER=host\nPATH=/usr/bin" } });
    expect(rowOf(noVar.text, "H06_job_runner")).toContain("FAIL");
    const withSock = run({ overrides: { workerEnv: "JARVIS_JOB_RUNNER=host\nJARVIS_JOB_RUNNER_SOCKET=/run/jarvis/runner.sock\nPATH=/usr/bin", sockOk: "1" } });
    expect(rowOf(withSock.text, "H06_job_runner")).toContain("PASS");
    const missing = run({ overrides: { workerEnv: "JARVIS_JOB_RUNNER=host\nJARVIS_JOB_RUNNER_SOCKET=/run/jarvis/runner.sock\nPATH=/usr/bin", sockOk: "0" } });
    expect(rowOf(missing.text, "H06_job_runner")).toContain("FAIL");
  });

  it("backup-status: ok = PASS, failing/never = WARN, ikke konfigurert = INFO, ulesbar = UNKNOWN", () => {
    expect(rowOf(run().text, "H07_backup_status")).toContain("PASS");
    expect(rowOf(run({ overrides: { bstat: "failing ok never age_h=30" } }).text, "H07_backup_status")).toContain("WARN");
    expect(rowOf(run({ overrides: { bstat: "NOFILE" } }).text, "H07_backup_status")).toContain("INFO");
    expect(rowOf(run({ overrides: { bstat: "ERR" } }).text, "H07_backup_status")).toContain("UNKNOWN");
  });

  it("sveipfeil siste 24 t gir WARN med antall per melding", () => {
    const res = run({ overrides: { logs: '{"msg":"knowledge_source_failed"}\n{"msg":"knowledge_source_failed"}\n{"msg":"open_loop_sweep_tenant_failed"}\n{"msg":"ok"}' } });
    const row = rowOf(res.text, "H08_sweep_failures_24h");
    expect(row).toContain("WARN");
    expect(row).toContain("knowledge_source_failed");
    expect(row).toContain("open_loop_sweep_tenant_failed");
  });

  it("hemmelighetsformer i loggene gir FAIL med antall per mønster - og selve verdien står aldri i utdataene eller evidensfilen", () => {
    const res = run({ overrides: { logs: `{"msg":"x","token":"${FAKE_GH_TOKEN}"}\nAuthorization: Bearer ${"a".repeat(40)}\n{"msg":"ok"}` } });
    const row = rowOf(res.text, "H12_secrets_in_logs");
    expect(row).toContain("FAIL");
    expect(row).toContain("github_token=1");
    expect(row).toContain("bearer=1");
    expect(res.status).toBe(1);
    expect(res.text).not.toContain(FAKE_GH_TOKEN);
    const evidence = readFileSync(join(res.outDir, readdirSync(res.outDir)[0]), "utf8");
    expect(evidence).not.toContain(FAKE_GH_TOKEN);
  });

  it("tilstandsradene tåler at funksjonene ikke er utrullet (tabeller mangler) uten å feile", () => {
    const res = run({ overrides: { tables: { knowledge_documents: "t" } } });
    expect(rowOf(res.text, "H09_incident_state")).toContain("E1 ikke utrullet");
    expect(rowOf(res.text, "H11_business_state")).toContain("D2 ikke utrullet");
    expect(res.status, res.text).toBe(0);
  });

  it("en ikke-skrivbar evidensmappe gir en ærlig advarsel (aldri «skrevet») og exit-koden følger kun sjekkene", () => {
    const res = run({ env: { JARVIS_ACCEPTANCE_OUT_DIR: "/proc/ikke-skrivbar/ut" } });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("evidensfilen ble IKKE skrevet");
    expect(res.stdout).not.toContain("Evidens skrevet til");
    expect(existsSync("/proc/ikke-skrivbar")).toBe(false);
    void mkdirSync;
  });
});
