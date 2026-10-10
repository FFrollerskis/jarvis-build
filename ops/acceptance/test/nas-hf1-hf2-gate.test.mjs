import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildExport, emptyStatus } from "../../backup/lib/state.mjs";

/**
 * WP-J (D-450): HF1/HF2-akseptansescriptet. Testes uten ekte docker: en falsk `docker` på PATH svarer med innlagte utdata, og UA-0-porten byttes mot et lite script (JARVIS_UA0_GATE), så
 * parse-/statuslogikken, flagg-inventaret (ingen verdier lekker), loggskanningen og exit-koden er bevist. Det beviser IKKE noe om den ekte NAS-en - det er hele poenget med å kjøre scriptet der.
 * H12 bruker normalt opptakerens `--scan`; testene bytter den mot en liten falsk opptaker (kontrakten: leser stdin, skriver «regel=antall», exit 1 ved treff) og kjører i tillegg mot den ekte
 * opptakeren når den finnes i treet.
 */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(ROOT, "ops/acceptance/nas-hf1-hf2-gate.sh");
const REAL_RECORDER = join(ROOT, "ops/acceptance/record-evidence.mjs");
const MIGS = readdirSync(join(ROOT, "modules/core/src/db/migrations")).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
const TEST_SRC = readFileSync(join(ROOT, "modules/core/test/remediation-2-schema-invariants.test.ts"), "utf8");
const EXEMPT = (() => {
  const block = TEST_SRC.slice(TEST_SRC.indexOf("const RLS_EXEMPT"));
  const body = block.slice(0, block.indexOf("\n  };"));
  return [...body.matchAll(/^ {4}([a-z_0-9]+):/gm)].map((m) => m[1]).sort().join(",");
})();
// bygges ved kjøring: gitleaks leser en bokstavelig token-streng i kildefilen som en ekte hemmelighet
const FAKE_GH_TOKEN = `${["gh", "p_"].join("")}${"a".repeat(36)}`;
const FAKE_GH_PAT = `${["github", "_pat_"].join("")}${"B".repeat(30)}`;
const BACKUP_JS = /^BACKUP_JS='(.*)'$/m.exec(readFileSync(SCRIPT, "utf8"))?.[1] ?? "";

function fakeEnv(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-hf-"));
  const cfg = {
    migrations: MIGS.join("\n"), select1: "1", norls: EXEMPT,
    webEnv: "JARVIS_COUNCIL_PROPOSALS=off\nJARVIS_KNOWLEDGE_CLAIM_MIN_SOURCES=2\nJARVIS_OWNER_EXTRA_TENANTS=tenant-hemmelig-navn\nJARVIS_GITHUB_APP_ID=12345678\nPATH=/usr/bin",
    workerEnv: "JARVIS_KNOWLEDGE_SOURCES=[{\"id\":\"hemmelig\"}]\nJARVIS_JOB_RUNNER=\nPATH=/usr/bin",
    logs: '{"msg":"knowledge_source_synced","source_id":"notater"}\n{"msg":"heartbeat"}', logsFail: "0", psFails: "0",
    bstat: "backup=ok restore=ok offsite=ok age_h=3", bstatFile: "", sockOk: "0",
    tables: { incident_transitions: "t", knowledge_documents: "t", claim_verifications: "t", product_usage_events: "t", business_change_log: "t" },
    incidents: "open:2 resolved:5", kd: "filesystem:12 obsidian:40", cl: "VERIFIED:1 PROVISIONAL:2", biztenants: "1", usage: "340", changelog: "7",
    ...overrides
  };
  // hver verdi i en egen fil: den falske dockeren er ren bash (en node-start per oppslag gjorde hver kjøring til flere sekunder og blokkerte vitest-arbeideren)
  for (const [key, value] of Object.entries(cfg)) if (key !== "tables") writeFileSync(join(dir, `v_${key}`), String(value));
  for (const [name, value] of Object.entries(cfg.tables)) writeFileSync(join(dir, `t_${name}`), String(value));
  const sh = `#!/usr/bin/env bash
D="${dir}"
val() { [ -f "$D/v_$1" ] && cat "$D/v_$1"; }
tbl() { if [ -f "$D/t_$1" ]; then cat "$D/t_$1"; else printf f; fi; }
args="$*"
last="\${@: -1}"
case "$args" in
  *" ps -q"*) [ "$(val psFails)" = "1" ] && exit 1; echo cid123; exit 0;;
  *" logs "*) [ "$(val logsFail)" = "1" ] && exit 1; val logs; echo; exit 0;;
  *"exec -T api env"*) val webEnv; echo; exit 0;;
  *"exec -T worker env"*) val workerEnv; echo; exit 0;;
  *"exec -T api node -e"*)
    if [ -n "$(val bstatFile)" ]; then JARVIS_BACKUP_STATUS_FILE="$(val bstatFile)" node -e "$last"; else val bstat; echo; fi; exit 0;;
  *"exec -T worker sh -c"*) [ "$(val sockOk)" = "1" ] && exit 0 || exit 1;;
esac
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

function fakeUa0(rc = 0, summary = "Sammendrag: PASS=12 WARN=0 UNKNOWN=0 FAIL=0", lines = []) {
  const dir = mkdtempSync(join(tmpdir(), "fake-ua0-"));
  const file = join(dir, "ua0.sh");
  const body = ["C01 PASS ok", ...lines, ...(summary ? [summary] : [])].map((l) => `echo ${JSON.stringify(l)}`).join("\n");
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\nexit ${rc}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** Etterligner KUN `--scan`-kontrakten til record-evidence.mjs. «CRASH_ME» i loggene krasjer den; «TRUNCATE_ME» gir «avkortet=1». */
function fakeRecorder() {
  const file = join(mkdtempSync(join(tmpdir(), "fake-rec-")), "record-evidence.mjs");
  writeFileSync(file, `import { readFileSync } from "node:fs";
const t = readFileSync(0, "utf8");
if (process.argv[2] !== "--scan") process.exit(9);
if (t.includes("CRASH_ME")) process.exit(7);
const out = [];
const gh = (t.match(/gh[p]_[A-Za-z0-9]{20,}/g) ?? []).length; if (gh) out.push("github_token=" + gh);
const bearer = (t.match(/Bearer [A-Za-z0-9._~+/=-]{16,}/g) ?? []).length; if (bearer) out.push("bearer=" + bearer);
if (t.includes("TRUNCATE_ME")) out.push("avkortet=1");
if (out.length) console.log(out.join("\\n"));
process.exit(gh + bearer > 0 ? 1 : 0);
`);
  return file;
}

function tempRepo({ dirty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hf-repo-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
  const g = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8", env });
  g("init", "-q");
  writeFileSync(join(dir, "a.txt"), "a");
  g("add", ".");
  g("commit", "-q", "-m", "x");
  if (dirty) writeFileSync(join(dir, "b.txt"), "b");
  return dir;
}

// ett lite git-uttrekk for alle kjøringer: H00 blir deterministisk (uavhengig av om arbeidstreet er rent) og `git status` på hele repoet koster flere hundre ms per kjøring
const SHARED_REPO = tempRepo();

function run({ env = {}, overrides = {}, ua0 = fakeUa0(), recorder = fakeRecorder() } = {}) {
  const fake = fakeEnv(overrides);
  const out = mkdtempSync(join(tmpdir(), "hf-out-"));
  const res = spawnSync("bash", [SCRIPT], {
    env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, JARVIS_UA0_GATE: ua0, JARVIS_ACCEPTANCE_OUT_DIR: out, JARVIS_EVIDENCE_RECORDER: recorder, JARVIS_ACCEPTANCE_GIT_ROOT: SHARED_REPO, ...env },
    encoding: "utf8", timeout: 90_000
  });
  return { ...res, text: res.stdout + res.stderr, outDir: out };
}
const rowOf = (text, id) => (text.split("\n").find((l) => l.startsWith(id)) ?? "");
const evidenceOf = (res) => readFileSync(join(res.outDir, readdirSync(res.outDir).find((f) => f.startsWith("nas-hf1-hf2-gate-"))), "utf8");

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
    const res = run({ overrides: { webEnv: "JARVIS_KNOWLEDGE_CLAIM_WRITES=ON\nJARVIS_COUNCIL_PROPOSALS=yes\nJARVIS_INCIDENT_PRODUCERS_ENABLED=1\nPATH=/usr/bin" } });
    const row = rowOf(res.text, "H05_exact_on_flags");
    expect(row).toContain("WARN");
    for (const name of ["JARVIS_KNOWLEDGE_CLAIM_WRITES", "JARVIS_COUNCIL_PROPOSALS", "JARVIS_INCIDENT_PRODUCERS_ENABLED"]) expect(row).toContain(name);
    const exact = run({ overrides: { webEnv: "JARVIS_KNOWLEDGE_CLAIM_WRITES=on\nJARVIS_COUNCIL_PROPOSALS=off\nJARVIS_INCIDENT_PRODUCERS_ENABLED=true\nPATH=/usr/bin" } });
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

  it("sveipfeil siste 24 t gir WARN med antall per melding", () => {
    const res = run({ overrides: { logs: '{"msg":"knowledge_source_failed"}\n{"msg":"knowledge_source_failed"}\n{"msg":"open_loop_sweep_tenant_failed"}\n{"msg":"ok"}' } });
    const row = rowOf(res.text, "H08_sweep_failures_24h");
    expect(row).toContain("WARN");
    expect(row).toContain("knowledge_source_failed");
    expect(row).toContain("open_loop_sweep_tenant_failed");
  });

  it("H08 dekker hele familien av feilmeldinger i koden (sweep/sync/purge/kunnskapskilde), ikke bare en håndskrevet liste - og ikke ubeslektede feil", () => {
    const names = ["vipps_sweep_tenant_failed", "stripe_sweep_tenant_failed", "support_inbox_sync_tenant_failed", "vision_retention_purge_failed", "situation_sweep_failed", "knowledge_source_timeout", "product_usage_purge_failed"];
    const res = run({ overrides: { logs: [...names.map((n) => `{"msg":"${n}"}`), '{"msg":"telegram_poll_failed"}', '{"msg":"heartbeat"}'].join("\n") } });
    const row = rowOf(res.text, "H08_sweep_failures_24h");
    expect(row).toContain("WARN");
    for (const n of names) expect(row, n).toContain(n);
    expect(row).not.toContain("telegram_poll_failed");
    expect(rowOf(run({ overrides: { logs: '{"msg":"telegram_poll_failed"}\n{"msg":"heartbeat"}' } }).text, "H08_sweep_failures_24h")).toContain("PASS");
  });

  it("hemmelighetsformer i loggene gir FAIL med antall per mønster - og selve verdien står aldri i utdataene eller evidensfilen", () => {
    const res = run({ overrides: { logs: `{"msg":"x","token":"${FAKE_GH_TOKEN}"}\nAuthorization: Bearer ${"a".repeat(40)}\n{"msg":"ok"}` } });
    const row = rowOf(res.text, "H12_secrets_in_logs");
    expect(row).toContain("FAIL");
    expect(row).toContain("github_token=1");
    expect(row).toContain("bearer=1");
    expect(res.status).toBe(1);
    expect(res.text).not.toContain(FAKE_GH_TOKEN);
    expect(evidenceOf(res)).not.toContain(FAKE_GH_TOKEN);
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

describe("nas-hf1-hf2-gate.sh: rettelser etter uavhengig review (M4-M8, L6-L7) og mutantene som overlevde (G4, G11-G15, G18)", () => {
  it("G4/L7: uten docker, eller når docker-daemonen ikke svarer, stopper porten med exit 2 og skriver ingen sjekkrader (aldri en rekke UNKNOWN som ligner en kjøring)", () => {
    const noDocker = run({ env: { JARVIS_DOCKER_BIN: "docker-finnes-ikke-xyz" } });
    expect(noDocker.status).toBe(2);
    expect(noDocker.stderr).toContain("docker finnes ikke");
    expect(noDocker.stdout).not.toContain("H02_migrations_applied");
    const daemonDown = run({ overrides: { psFails: "1" } });
    expect(daemonDown.status).toBe(2);
    expect(daemonDown.stderr).toContain("docker compose svarer ikke");
    expect(daemonDown.stdout).not.toContain("H02_migrations_applied");
  });

  it("L7: når ingenting kan måles (ingen PASS, ingen FAIL) er exit 3 og meldingen sier at de fleste sjekkene ikke kunne måles", () => {
    const res = run({ ua0: fakeUa0(2), overrides: { select1: "", webEnv: "", workerEnv: "", bstat: "", logs: "" } });
    expect(res.status, res.text).toBe(3);
    expect(res.stderr).toContain("de fleste sjekkene kunne ikke måles");
    expect(res.stdout).toContain("IKKE bestått");
    expect(rowOf(res.text, "H11_business_state")).toContain("UNKNOWN");
    expect(rowOf(res.text, "H11_business_state")).not.toContain("ikke utrullet");
  });

  it("L7: selv med en PASS (UA-0) er exit 3 når flere sjekker er UNKNOWN enn PASS - meldingen og exit-koden bruker samme vilkår", () => {
    const res = run({ overrides: { select1: "", webEnv: "", workerEnv: "", bstat: "", logs: "" } });
    expect(rowOf(res.text, "H01_ua0_gate")).toContain("PASS");
    expect(res.text).toMatch(/Sammendrag: PASS=1 .*UNKNOWN=1\d/);
    expect(res.stderr).toContain("de fleste sjekkene kunne ikke måles");
    expect(res.status, res.text).toBe(3);
    const fine = run({ overrides: { bstat: "ERR" } }); // én UNKNOWN blant mange PASS: fortsatt exit 0
    expect(rowOf(fine.text, "H07_backup_status")).toContain("UNKNOWN");
    expect(fine.status, fine.text).toBe(0);
    expect(fine.stderr).not.toContain("de fleste sjekkene");
  });

  it("G11/L7: databasen svarer ikke = UNKNOWN i H02/H03/H09/H10/H11 (aldri FAIL/«ikke utrullet»); tom migrasjonsliste med levende database er også UNKNOWN", () => {
    const down = run({ overrides: { select1: "" } });
    for (const id of ["H02_migrations_applied", "H03_rls_global_tables", "H09_incident_state", "H10_knowledge_state", "H11_business_state"]) expect(rowOf(down.text, id), id).toContain("UNKNOWN");
    expect(down.text).not.toContain("ikke utrullet");
    const emptyMigs = run({ overrides: { migrations: "" } });
    expect(rowOf(emptyMigs.text, "H02_migrations_applied")).toContain("UNKNOWN");
    expect(rowOf(emptyMigs.text, "H02_migrations_applied")).toContain("schema_migrations");
  });

  it("G15/H00: lokale endringer gir WARN, ren katalog gir INFO med sha, og en katalog uten git gir UNKNOWN", () => {
    const dirty = run({ env: { JARVIS_ACCEPTANCE_GIT_ROOT: tempRepo({ dirty: true }) } });
    expect(rowOf(dirty.text, "H00_code_version")).toContain("WARN");
    const clean = run({ env: { JARVIS_ACCEPTANCE_GIT_ROOT: tempRepo() } });
    expect(rowOf(clean.text, "H00_code_version")).toContain("INFO");
    expect(rowOf(clean.text, "H00_code_version")).toContain("ren arbeidskatalog");
    const noGit = run({ env: { JARVIS_ACCEPTANCE_GIT_ROOT: mkdtempSync(join(tmpdir(), "hf-nogit-")) } });
    expect(rowOf(noGit.text, "H00_code_version")).toContain("UNKNOWN");
  });

  it("H00: en evidensfil i docs/evidence (reservert av opptakeren før porten kjører) er ikke «lokale endringer» - andre uspora filer er det fortsatt", () => {
    const onlyEvidence = tempRepo();
    mkdirSync(join(onlyEvidence, "docs", "evidence"), { recursive: true });
    writeFileSync(join(onlyEvidence, "docs", "evidence", "2026-10-10-hf-0-gate.md"), "");
    const clean = run({ env: { JARVIS_ACCEPTANCE_GIT_ROOT: onlyEvidence } });
    expect(rowOf(clean.text, "H00_code_version")).toContain("INFO");
    expect(rowOf(clean.text, "H00_code_version")).toContain("ren arbeidskatalog");
    const evidenceAndOther = tempRepo({ dirty: true });
    mkdirSync(join(evidenceAndOther, "docs", "evidence"), { recursive: true });
    writeFileSync(join(evidenceAndOther, "docs", "evidence", "x.md"), "");
    expect(rowOf(run({ env: { JARVIS_ACCEPTANCE_GIT_ROOT: evidenceAndOther } }).text, "H00_code_version")).toContain("WARN");
  });

  it("M7: UA-0 med exit 0 men WARN/UNKNOWN i sammendraget er IKKE PASS - linjene vises og havner i evidensfilen; uten sammendragslinje er det UNKNOWN", () => {
    const res = run({ ua0: fakeUa0(0, "Sammendrag: PASS=6 WARN=4 UNKNOWN=5 FAIL=0", ["C07_constitution WARN constitution_unsigned", "C09_embedding UNKNOWN ikke målt"]) });
    expect(rowOf(res.text, "H01_ua0_gate")).toContain("WARN");
    expect(rowOf(res.text, "H01_ua0_gate")).not.toContain("PASS ");
    expect(res.text).toContain("UA-0> C07_constitution WARN constitution_unsigned");
    expect(res.text).toContain("UA-0> C09_embedding UNKNOWN ikke målt");
    const evidence = evidenceOf(res);
    expect(evidence).toContain("## UA-0-linjer som ikke er PASS/INFO");
    expect(evidence).toContain("C07_constitution WARN constitution_unsigned");
    expect(res.status).toBe(0);
    const noSummary = run({ ua0: fakeUa0(0, "") });
    expect(rowOf(noSummary.text, "H01_ua0_gate")).toContain("UNKNOWN");
  });

  it("M4/G12: H07 PASS bare når backup, restore-verifisering og off-site alle er «ok» og filen er fersk; failed/failing = FAIL; never/never_run/not_configured/pending = WARN; ukjent kode eller alder = UNKNOWN", () => {
    const h07 = (bstat) => run({ overrides: { bstat } });
    const row = (bstat) => rowOf(h07(bstat).text, "H07_backup_status");
    expect(row("backup=ok restore=ok offsite=ok age_h=3")).toContain("PASS");
    expect(row("backup=ok restore=ok offsite=failed age_h=3")).toContain("FAIL");
    expect(row("backup=failing restore=ok offsite=ok age_h=3")).toContain("FAIL");
    expect(row("backup=ok restore=failed offsite=ok age_h=3")).toContain("FAIL");
    expect(h07("backup=ok restore=ok offsite=failed age_h=3").status).toBe(1);
    expect(row("backup=never restore=ok offsite=ok age_h=3")).toContain("WARN");
    expect(row("backup=ok restore=never_run offsite=ok age_h=3")).toContain("WARN");
    expect(row("backup=ok restore=ok offsite=not_configured age_h=3")).toContain("WARN");
    expect(row("backup=ok restore=ok offsite=pending age_h=3")).toContain("WARN");
    expect(row("backup=ok restore=ok offsite=ok age_h=900")).toContain("WARN");
    expect(row("backup=ok restore=ok offsite=ok age_h=900")).toContain("over 36 t gammel");
    expect(row("backup=ok restore=ok offsite=ok age_h=NaN")).toContain("UNKNOWN");
    expect(row("backup=ok restore=ok offsite=ok age_h=-4")).toContain("UNKNOWN");
    expect(row("backup=ok restore=ok offsite=bogus age_h=3")).toContain("UNKNOWN");
    expect(row("noe helt annet")).toContain("UNKNOWN");
    expect(row("NOFILE")).toContain("INFO");
    expect(row("ERR")).toContain("UNKNOWN");
    expect(row("")).toContain("UNKNOWN");
  });

  it("M4: uttrekket (BACKUP_JS) leser den ekte eksporten fra ops/backup/lib/state.mjs - skjemaet er bundet til koden, og en korrupt fil gir ERR/UNKNOWN i stedet for å slippe tekst gjennom", () => {
    expect(BACKUP_JS.length).toBeGreaterThan(50);
    const dir = mkdtempSync(join(tmpdir(), "hf-bstat-"));
    const now = new Date();
    const fresh = buildExport(emptyStatus(), { now, intervalMs: 86_400_000, verifyIntervalMs: 7 * 86_400_000, newest: null, setsOnDisk: 0 });
    writeFileSync(join(dir, "fresh.json"), JSON.stringify(fresh));
    const status = emptyStatus();
    status.offsite.state = "ok"; status.restore_verify.state = "ok";
    const healthy = buildExport(status, { now, intervalMs: 86_400_000, verifyIntervalMs: 7 * 86_400_000, newest: { name: "set-1", createdAt: now.toISOString(), sizeBytes: 10 }, setsOnDisk: 1 });
    writeFileSync(join(dir, "healthy.json"), JSON.stringify(healthy));
    writeFileSync(join(dir, "corrupt.json"), "{ ikke json");
    writeFileSync(join(dir, "hostile.json"), JSON.stringify({ generated_at: now.toISOString(), backup: { state: `ok\nINJISERT ${FAKE_GH_TOKEN}` }, restore_verify: { state: { a: 1 } }, offsite: { state: "ok" } }));

    const viaGate = (file) => run({ overrides: { bstatFile: join(dir, file) } });
    expect(rowOf(viaGate("fresh.json").text, "H07_backup_status")).toContain("backup=never restore_verify=not_configured offsite=not_configured age_h=0");
    expect(rowOf(viaGate("fresh.json").text, "H07_backup_status")).toContain("WARN");
    expect(rowOf(viaGate("healthy.json").text, "H07_backup_status")).toContain("PASS");
    expect(rowOf(viaGate("healthy.json").text, "H07_backup_status")).toContain("backup=ok restore_verify=ok offsite=ok age_h=0");
    expect(rowOf(viaGate("corrupt.json").text, "H07_backup_status")).toContain("UNKNOWN");
    const hostile = viaGate("hostile.json");
    expect(hostile.text).not.toContain(FAKE_GH_TOKEN);
    expect(hostile.text).not.toContain("INJISERT");
    expect(rowOf(hostile.text, "H07_backup_status")).toMatch(/UNKNOWN|WARN|FAIL/);
  });

  it("M6: en treffende logglinje uten JSON-«msg» telles som «annen_loggrad» og skrives aldri ut (token i URL-en lekker ikke via H08)", () => {
    const res = run({ overrides: { logs: `ERROR knowledge_source_failed url=https://x.example/feed?api_key=${FAKE_GH_TOKEN}\n{"msg":"knowledge_source_failed"}` } });
    const row = rowOf(res.text, "H08_sweep_failures_24h");
    expect(row).toContain("WARN");
    expect(row).toContain("annen_loggrad");
    expect(row).toContain("knowledge_source_failed");
    expect(res.text).not.toContain(FAKE_GH_TOKEN);
    expect(evidenceOf(res)).not.toContain(FAKE_GH_TOKEN);
  });

  it("M8: tomme eller uleselige logger gir UNKNOWN i H08 og H12 (ikke PASS), og et ulesbart worker-/api-miljø gir UNKNOWN i H05 (ikke PASS) - G13", () => {
    const emptyLogs = run({ overrides: { logs: "" } });
    expect(rowOf(emptyLogs.text, "H08_sweep_failures_24h")).toContain("UNKNOWN");
    expect(rowOf(emptyLogs.text, "H12_secrets_in_logs")).toContain("UNKNOWN");
    const failingLogs = run({ overrides: { logsFail: "1" } });
    expect(rowOf(failingLogs.text, "H08_sweep_failures_24h")).toContain("UNKNOWN");
    expect(rowOf(failingLogs.text, "H12_secrets_in_logs")).toContain("UNKNOWN");
    const noWorker = run({ overrides: { workerEnv: "" } });
    expect(rowOf(noWorker.text, "H05_exact_on_flags")).toContain("UNKNOWN");
    expect(rowOf(noWorker.text, "H05_exact_on_flags")).toContain("worker");
    expect(rowOf(noWorker.text, "H06_job_runner")).toContain("UNKNOWN");
    const noApi = run({ overrides: { webEnv: "" } });
    expect(rowOf(noApi.text, "H05_exact_on_flags")).toContain("UNKNOWN");
    expect(rowOf(noApi.text, "H05_exact_on_flags")).toContain("api");
    const warnStillShown = run({ overrides: { webEnv: "JARVIS_COUNCIL_PROPOSALS=yes\nPATH=/usr/bin", workerEnv: "" } });
    expect(rowOf(warnStillShown.text, "H05_exact_on_flags")).toContain("WARN");
    expect(rowOf(warnStillShown.text, "H05_exact_on_flags")).toContain("worker");
  });

  it("M5: H12 bruker opptakerens skanner - treff gir FAIL med regelnavn og antall (aldri tekst), «avkortet» gir WARN, krasj gir UNKNOWN, ren logg gir PASS", () => {
    const hit = run({ overrides: { logs: `x ${FAKE_GH_TOKEN} y\nAuthorization: Bearer ${"b".repeat(30)}` } });
    expect(rowOf(hit.text, "H12_secrets_in_logs")).toContain("FAIL");
    expect(rowOf(hit.text, "H12_secrets_in_logs")).toContain("github_token=1 bearer=1");
    expect(hit.text).not.toContain(FAKE_GH_TOKEN);
    expect(hit.status).toBe(1);
    expect(rowOf(run({ overrides: { logs: "ren logg\nTRUNCATE_ME" } }).text, "H12_secrets_in_logs")).toContain("WARN");
    expect(rowOf(run({ overrides: { logs: "ren logg\nCRASH_ME" } }).text, "H12_secrets_in_logs")).toContain("UNKNOWN");
    expect(rowOf(run().text, "H12_secrets_in_logs")).toContain("PASS");
  });

  it("M5: uten opptaker (eller node) faller H12 tilbake til en FORENKLET liste og kan ikke gi PASS; treff på den forenklede listen er fortsatt FAIL", () => {
    const missing = { JARVIS_EVIDENCE_RECORDER: "/finnes/ikke/record-evidence.mjs" };
    const clean = run({ env: missing });
    expect(rowOf(clean.text, "H12_secrets_in_logs")).toContain("WARN");
    expect(rowOf(clean.text, "H12_secrets_in_logs")).toContain("FORENKLEDE");
    expect(clean.status).toBe(0);
    const hit = run({ env: missing, overrides: { logs: `x ${FAKE_GH_TOKEN}` } });
    expect(rowOf(hit.text, "H12_secrets_in_logs")).toContain("FAIL");
    expect(rowOf(hit.text, "H12_secrets_in_logs")).toContain("github_token=1");
    expect(hit.text).not.toContain(FAKE_GH_TOKEN);
  });

  it.skipIf(!existsSync(REAL_RECORDER))("M5: mot den EKTE opptakeren fanges former den gamle 7-mønsterlisten slapp gjennom (github_pat_, Authorization: Basic, sk-proj-), uten at verdiene vises", () => {
    const basic = `Authorization: Basic ${"dXNlcjpwYXNzd29yZC1zb20tZXI="}`;
    const proj = `${["sk", "-proj-"].join("")}${"Q".repeat(40)}`;
    const res = run({ recorder: REAL_RECORDER, overrides: { logs: `{"msg":"x","t":"${FAKE_GH_PAT}"}\n${basic}\nkey ${proj}\n{"msg":"ok"}` } });
    const row = rowOf(res.text, "H12_secrets_in_logs");
    expect(row).toContain("FAIL");
    expect(row).toContain("github_pat=1");
    expect(row).toContain("authorization_header=1");
    for (const secret of [FAKE_GH_PAT, "dXNlcjpwYXNz", proj]) expect(res.text, secret.slice(0, 8)).not.toContain(secret);
    expect(rowOf(run({ recorder: REAL_RECORDER }).text, "H12_secrets_in_logs")).toContain("PASS");
  });

  it("L6: JARVIS_JOB_RUNNER vises aldri som rå verdi (kun host/on/off/tall - ellers «satt»)", () => {
    const res = run({ overrides: { workerEnv: "JARVIS_JOB_RUNNER=hemmelig-verdi-xyz\nPATH=/usr/bin" } });
    expect(rowOf(res.text, "H06_job_runner")).toContain("JARVIS_JOB_RUNNER=satt");
    expect(res.text).not.toContain("hemmelig-verdi-xyz");
    expect(evidenceOf(res)).not.toContain("hemmelig-verdi-xyz");
  });

  it("G14/L6: en NY evidensmappe låses (700), men en eksisterende mappe eieren har satt opp rettighetene på røres ikke", () => {
    const fresh = join(mkdtempSync(join(tmpdir(), "hf-base-")), "nytt", "ut");
    run({ env: { JARVIS_ACCEPTANCE_OUT_DIR: fresh } });
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    const existing = mkdtempSync(join(tmpdir(), "hf-existing-"));
    chmodSync(existing, 0o755);
    run({ env: { JARVIS_ACCEPTANCE_OUT_DIR: existing } });
    expect(statSync(existing).mode & 0o777).toBe(0o755);
  });

  it("G18: pipe-tegn i en detalj ødelegger ikke markdown-tabellen i evidensfilen (RLS-avviket inneholder « | Forventet: »)", () => {
    const res = run({ overrides: { norls: `${EXEMPT},ny_tabell_uten_rls` } });
    const evidenceRow = evidenceOf(res).split("\n").find((l) => l.startsWith("| H03_rls_global_tables"));
    expect(evidenceRow).toBeTruthy();
    expect(evidenceRow.split("|")).toHaveLength(5); // "", id, status, detalj, ""
    expect(evidenceRow).toContain("/ Forventet:");
  });
});
