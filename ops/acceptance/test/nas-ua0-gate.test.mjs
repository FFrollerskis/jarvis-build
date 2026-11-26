import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-422: NAS-akseptansescriptet. Testes uten ekte docker: en falsk `docker` på PATH svarer med innlagte utdata, så parse-/statuslogikken, exit-koden og
 * evidensfilen er bevist. Det beviser IKKE noe om den ekte NAS-en - det er hele poenget med å kjøre scriptet der.
 */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(ROOT, "ops/acceptance/nas-ua0-gate.sh");
const MIGS = readdirSync(join(ROOT, "modules/core/src/db/migrations")).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();

function fakeDocker(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
  const cfg = {
    ps: "api=running/healthy postgres=running/healthy worker=running/healthy",
    migrations: MIGS.join("\n"),
    vector: "vector", hnsw: "2", regclass: "t", delivered: "1", select1: "1",
    health: "200", models: "llama3.1:8b,bge-m3",
    cost: "gemma_local:12 kall/0 øre", cloudOre: "0", fails: "", ev0: '{"msg":"ev0_constitution_boot","status":"verified"} {"msg":"ev0_change_ledger_boot","status":"ok"}', norls: "capabilities,evolution_change_ledger,github_rate_limit_state,owner_control_state,scheduler_state,schema_migrations,self_modification_requests,situation_domain_pauses,telegram_poll_state",
    inspect: 'jarvis|true|["ALL"]',
    wdAge: "30", // C14 (WP-OPS2a K5): sekunder siden siste vakthund-tikk (incident_producer_runs/watchdog)
    ...overrides
  };
  writeFileSync(join(dir, "cfg.json"), JSON.stringify(cfg));
  const sh = `#!/usr/bin/env bash
CFG="${join(dir, "cfg.json")}"
val() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c[process.argv[2]]??""))' "$CFG" "$1"; }
args="$*"
if [ "$1" = "inspect" ]; then val inspect; echo; exit 0; fi
case "$args" in
  *" ps --format"*) val ps | tr ' ' '\\n'; exit 0;;
  *" ps -q"*) echo cid123; exit 0;;
  *" logs "*) val ev0; echo; exit 0;;
esac
last="\${@: -1}"
case "$args" in
  *"exec -T postgres"*)
    case "$last" in
      *"FROM incident_producer_runs WHERE producer = 'watchdog'"*) val wdAge; echo;;
      *schema_migrations*) val migrations; echo;;
      *pg_extension*) val vector; echo;;
      *hnsw*) val hnsw; echo;;
      *to_regclass*) val regclass; echo;;
      *delivered_at*) val delivered; echo;;
      *"SELECT 1"*) val select1; echo;;
      *"NOT success"*) val fails; echo;;
      *"NOT IN ('gemma_local'"*) val cloudOre; echo;;
      *"purpose='CHAT' GROUP BY"*) val cost; echo;;
      *relrowsecurity*) val norls; echo;;
    esac; exit 0;;
  *"exec -T api"*)
    case "$args" in
      *"/health"*) val health; echo;;
      *GEMMA*) val models; echo;;
    esac; exit 0;;
esac
exit 0
`;
  writeFileSync(join(dir, "docker"), sh);
  chmodSync(join(dir, "docker"), 0o755);
  return dir;
}

/**
 * WP-OPS2a K5 (C13): en falsk `nas-schedule.sh`. Gaten skal kalle den med NØYAKTIG `<backup-mappe> status --json`; alt annet gir exit 64 (og dermed UNKNOWN i gaten, så en feil argumentliste kan ikke gi PASS).
 * `json` er teksten på stdout (streng eller objekt), `rc` er exit-koden, `sleepSec` lar kommandoen henge.
 */
function fakeStatusCmd(rc, json, sleepSec = 0) {
  const dir = mkdtempSync(join(tmpdir(), "fake-status-"));
  const file = join(dir, "nas-schedule.sh");
  writeFileSync(join(dir, "out.json"), typeof json === "string" ? json : JSON.stringify(json));
  writeFileSync(file, `#!/usr/bin/env bash\n[ "$#" = "3" ] && [ "$2" = "status" ] && [ "$3" = "--json" ] || { echo "uventede argumenter: $*" >&2; exit 64; }\n${sleepSec ? `sleep ${sleepSec}\n` : ""}cat "${join(dir, "out.json")}"\nexit ${rc}\n`);
  chmodSync(file, 0o755);
  return file;
}
const statusJson = (over = {}) => ({
  ok: true, exit_code: 0, reasons: [], backup: { newest_set: "jarvis-backup-20261125T020000Z", age_hours: 3.5, limit_hours: 36 }, offsite: { state: "ok" }, restore_verify: { state: "ok", age_days: 2 },
  heartbeat: { configured: false }, ...over
});
function gateEnv(rc, json, extra = {}, sleepSec = 0) {
  const dir = mkdtempSync(join(tmpdir(), "bk-dir-"));
  writeFileSync(join(dir, "x.age"), "x"); // C10 (alder ≤ 25 t) skal være PASS, så exit-koden i testene kun styres av C13
  return { JARVIS_BACKUP_DIR: dir, JARVIS_ACCEPTANCE_BACKUP_STATUS_CMD: fakeStatusCmd(rc, json, sleepSec), ...extra };
}

function run(env = {}, overrides = {}) {
  const fake = fakeDocker(overrides);
  // Evidensmappen er som standard en frisk tmp-mappe (ikke repoets `ops/acceptance/out`, som ikke alltid er skrivbar for den som kjører testen, og som testen ikke skal fylle opp). Tester kan overstyre den.
  const outDir = mkdtempSync(join(tmpdir(), "gate-evidence-"));
  const res = spawnSync("bash", [SCRIPT], { env: { ...process.env, JARVIS_ACCEPTANCE_OUT_DIR: outDir, PATH: `${fake}:${process.env.PATH}`, ...env }, encoding: "utf8", timeout: 60_000 });
  return { ...res, out: res.stdout + res.stderr };
}

describe("nas-ua0-gate.sh", () => {
  it("er gyldig bash og tørrkjøringen lister alle 14 sjekker uten å kjøre docker", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    const res = spawnSync("bash", [SCRIPT], { env: { ...process.env, JARVIS_ACCEPTANCE_DRY_RUN: "1", PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(res.status).toBe(0);
    for (const id of ["C01_compose_services", "C02_migrations_applied", "C03_pgvector_hnsw", "C04_schema_features", "C05_api_health", "C06_local_model", "C07_chat_cost_24h", "C08_provider_failures_24h", "C09_ev0_boot", "C10_backup_freshness", "C11_rls_tables", "C12_container_hardening", "C13_backup_status", "C14_watchdog_alive"]) {
      expect(res.stdout, id).toContain(id);
    }
    expect(res.stdout.split("\n").filter((l) => /^\s+C\d\d_/.test(l))).toHaveLength(14);
  });

  it("friskt system: alt PASS (backup ukjent uten JARVIS_BACKUP_DIR), exit 0, evidensfil uten hemmeligheter skrevet", () => {
    const r = run();
    expect(r.status, r.out).toBe(0);
    for (const id of ["C01_compose_services", "C02_migrations_applied", "C03_pgvector_hnsw", "C04_schema_features", "C05_api_health", "C06_local_model", "C07_chat_cost_24h", "C08_provider_failures_24h", "C09_ev0_boot", "C11_rls_tables", "C12_container_hardening", "C14_watchdog_alive"]) {
      expect(r.out, id).toMatch(new RegExp(`${id}\\s+PASS`));
    }
    expect(r.out).toMatch(/C10_backup_freshness\s+UNKNOWN/);
    expect(r.out).toMatch(/C13_backup_status\s+UNKNOWN.*JARVIS_BACKUP_DIR/);
    expect(r.out).toMatch(/C11_rls_tables\s+PASS/);
    const m = r.out.match(/Evidens skrevet til: (.+)/);
    expect(m).not.toBeNull();
    const file = m[1].trim();
    expect(existsSync(file)).toBe(true);
    const doc = readFileSync(file, "utf8");
    expect(doc).toContain("PASS betyr at denne målingen var som forventet");
    expect(doc).not.toMatch(/password|passord=|token=|secret=/i);
  });

  it("uanvendt migrasjon, manglende pgvector og rotbruker gir FAIL og exit 1", () => {
    const r = run({}, { migrations: MIGS.slice(0, -2).join("\n"), vector: "", inspect: "root|false|null" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/C02_migrations_applied\s+FAIL.*ikke anvendt/);
    expect(r.out).toMatch(/C03_pgvector_hnsw\s+FAIL/);
    expect(r.out).toMatch(/C12_container_hardening\s+FAIL.*AVVIK/);
  });

  it("skykostnad og feilede kall gir WARN (aldri stille PASS); uoppnåelig lokal modell er FAIL", () => {
    const warn = run({}, { cost: "anthropic:3 kall/60 øre", cloudOre: "60", fails: "gemma_local:5/20" });
    expect(warn.out).toMatch(/C07_chat_cost_24h\s+WARN.*skykostnad 60/);
    expect(warn.out).toMatch(/C08_provider_failures_24h\s+WARN.*gemma_local:5\/20/);
    const dead = run({}, { models: "ERR" });
    expect(dead.out).toMatch(/C06_local_model\s+FAIL/);
    expect(dead.status).toBe(1);
  });

  it("ev0-sjekken finner de faktiske loggnøklene; usignert konstitusjon gir WARN; ingen linjer gir UNKNOWN", () => {
    expect(run({}, { ev0: '{"msg":"ev0_constitution_boot","status":"unsigned"}' }).out).toMatch(/C09_ev0_boot\s+WARN/);
    expect(run({}, { ev0: "" }).out).toMatch(/C09_ev0_boot\s+UNKNOWN/);
  });

  it("RLS: ekstra tabell uten RLS er FAIL (avvik fra de dokumenterte globale)", () => {
    const r = run({}, { norls: "capabilities,hemmelig_tabell" });
    expect(r.out).toMatch(/C11_rls_tables\s+FAIL.*hemmelig_tabell/);
    expect(r.status).toBe(1);
  });

  it("backup: fersk PASS, gammel og ukryptert stray/ gir WARN, manglende mappe FAIL", () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-"));
    writeFileSync(join(dir, "x.age"), "x");
    const ok = run({ JARVIS_BACKUP_DIR: dir });
    expect(ok.out).toMatch(/C10_backup_freshness\s+PASS/);
    mkdirSync(join(dir, "stray"));
    expect(run({ JARVIS_BACKUP_DIR: dir }).out).toMatch(/C10_backup_freshness\s+WARN.*stray/);
    expect(run({ JARVIS_BACKUP_DIR: join(dir, "finnes-ikke") }).out).toMatch(/C10_backup_freshness\s+FAIL/);
  });

  describe("C13_backup_status (WP-OPS2a K5): backup-skriptets egen status, kun koder og tall", () => {
    const c13 = (r) => (r.out.match(/^C13_backup_status\s+(\S+)\s+(.*)$/m) ?? []).slice(1);

    it("exit 0 = PASS: gaten kaller kommandoen med nøyaktig `<mappe> status --json`, og detaljen har kun koder og tall", () => {
      const r = run(gateEnv(0, statusJson()));
      const [status, detail] = c13(r);
      expect(status, r.out).toBe("PASS");
      expect(detail).toBe("exit=0 age_h=3.5 verify=ok offsite=ok reasons=-");
      expect(r.status, r.out).toBe(0);
    });

    it("exit 3 (forfalt) = FAIL og gir exit 1; exit 4 (restore-verifisering) og 5 (off-site) = WARN; årsakskodene vises, men ikke settnavn", () => {
      const overdue = run(gateEnv(3, statusJson({ ok: false, exit_code: 3, reasons: ["newest_backup_40h_old_limit_36h", "set_dated_in_future:jarvis-backup-20301231T000000Z"], backup: { age_hours: 40 } })));
      const [status, detail] = c13(overdue);
      expect(status, overdue.out).toBe("FAIL");
      expect(detail).toBe("exit=3 age_h=40 verify=ok offsite=ok reasons=newest_backup_40h_old_limit_36h,set_dated_in_future");
      expect(overdue.status).toBe(1);
      const verify = run(gateEnv(4, statusJson({ ok: false, exit_code: 4, reasons: ["restore_verify_failed:verify_failed"], restore_verify: { state: "failed" } })));
      expect(c13(verify)[0]).toBe("WARN");
      expect(c13(verify)[1]).toContain("verify=failed");
      expect(c13(verify)[1]).toContain("reasons=restore_verify_failed:verify_failed");
      expect(verify.status, verify.out).toBe(0); // WARN gir ikke exit 1
      const offsite = run(gateEnv(5, statusJson({ ok: false, exit_code: 5, reasons: ["offsite_failed:offsite_failed"], offsite: { state: "failed" } })));
      expect(c13(offsite)[0]).toBe("WARN");
      expect(c13(offsite)[1]).toContain("offsite=failed");
    });

    it("alt annet er UNKNOWN (aldri PASS): konfig (1), backup feilet (2), off-site ikke satt opp (6), kommando ikke funnet (127), ukjent kode", () => {
      for (const rc of [1, 2, 6, 7, 64, 127, 255]) {
        const [status, detail] = c13(run(gateEnv(rc, statusJson({ exit_code: rc }))));
        expect(status, `exit ${rc}`).toBe("UNKNOWN");
        expect(detail).toContain(`exit ${rc}`);
      }
    });

    it("ugyldig JSON (tom, ikke JSON, array, null, tall), og JSON som er uenig med exit-koden, gir UNKNOWN - også ved exit 0 og 3", () => {
      for (const [rc, body] of [[0, ""], [0, "dette er ikke json"], [0, "[]"], [0, "null"], [0, "42"], [3, "{ikke json"], [0, JSON.stringify(statusJson({ exit_code: 3 }))], [3, JSON.stringify(statusJson({ exit_code: 0 }))]]) {
        const r = run(gateEnv(rc, body));
        expect(c13(r)[0], `exit ${rc} / ${body.slice(0, 20)}`).toBe("UNKNOWN");
        expect(r.status, r.out).toBe(0); // ukjent er ikke FAIL
      }
      // Årsaken skilles: ugyldig JSON er «kunne ikke tolkes», og uenighet er «uenige» (aldri det samme svaret på to ulike feil).
      expect(c13(run(gateEnv(0, "ikke json")))[1]).toContain("kunne ikke tolkes");
      expect(c13(run(gateEnv(0, JSON.stringify(statusJson({ exit_code: 3 })))))[1]).toMatch(/uenige/);
    });

    it("ugyldig tidsavbrudds-verdi (tekst, 0, for stor) faller tilbake til standarden (120 s) i stedet for å ødelegge sjekken", () => {
      for (const bad of ["abc", "0", "99999", "-5", "1.5", ""]) {
        const r = run(gateEnv(0, statusJson(), { JARVIS_ACCEPTANCE_BACKUP_STATUS_TIMEOUT_SEC: bad }));
        expect(c13(r)[0], `timeout=${bad}`).toBe("PASS");
      }
    });

    it("uten JARVIS_BACKUP_DIR, uten node, og med en hengende kommando (tidsavbrudd) er det UNKNOWN - kommandoen kalles ikke uten mappe", () => {
      const noDir = run({ JARVIS_ACCEPTANCE_BACKUP_STATUS_CMD: fakeStatusCmd(0, statusJson()) });
      expect(c13(noDir)[0]).toBe("UNKNOWN");
      expect(c13(noDir)[1]).toContain("JARVIS_BACKUP_DIR");
      const noNode = run(gateEnv(0, statusJson(), { JARVIS_ACCEPTANCE_NODE_BIN: "/finnes/ikke/node" }));
      expect(c13(noNode)[0]).toBe("UNKNOWN");
      expect(c13(noNode)[1]).toContain("node");
      const slow = run(gateEnv(0, statusJson(), { JARVIS_ACCEPTANCE_BACKUP_STATUS_TIMEOUT_SEC: "1" }, 5));
      expect(c13(slow)[0]).toBe("UNKNOWN");
      expect(c13(slow)[1]).toMatch(/tidsavbrudd/);
    });

    it("ubetrodd tekst i JSON (årsaker med mellomrom/Bearer, ukjente tilstander, felt med hemmeligheter) når aldri skjerm eller evidensfil", () => {
      const hostile = statusJson({
        reasons: ["newest_backup_1h_old_limit_36h", "Authorization: Bearer abc.def", "../../etc/passwd", "ok;rm -rf /", "x".repeat(200)], offsite: { state: "Bearer-token-xyz" }, restore_verify: { state: "<script>" },
        backup: { age_hours: "ikke et tall" }, note: "password=hunter2 JARVIS_DB_ADMIN_PASSWORD=pw", last_error: "secret-value"
      });
      const r = run(gateEnv(0, hostile));
      expect(c13(r)[1]).toBe("exit=0 age_h=? verify=? offsite=? reasons=newest_backup_1h_old_limit_36h");
      const file = r.out.match(/Evidens skrevet til: (.+)/)[1].trim();
      for (const text of [r.out, readFileSync(file, "utf8")]) {
        expect(text).not.toMatch(/Bearer|hunter2|passwd|script|secret-value|rm -rf|JARVIS_DB_ADMIN_PASSWORD/);
      }
    });

    it("evidensfilen har C13-raden", () => {
      const r = run(gateEnv(0, statusJson()));
      const doc = readFileSync(r.out.match(/Evidens skrevet til: (.+)/)[1].trim(), "utf8");
      expect(doc).toMatch(/\| C13_backup_status \| PASS \| exit=0 /);
    });
  });

  describe("C14_watchdog_alive (WP-OPS2a K5): alder på siste vakthund-tikk (incident_producer_runs)", () => {
    const c14 = (r) => (r.out.match(/^C14_watchdog_alive\s+(\S+)\s+(.*)$/m) ?? []).slice(1);

    it("grensene: opptil 300 s = PASS, opptil 900 s = WARN, over 900 s = FAIL (exit 1); detaljen er kun tall", () => {
      for (const [age, expected] of [["0", "PASS"], ["30", "PASS"], ["300", "PASS"], ["301", "WARN"], ["900", "WARN"], ["901", "FAIL"], ["86400", "FAIL"]]) {
        const r = run({}, { wdAge: age });
        const [status, detail] = c14(r);
        expect(status, `${age} s`).toBe(expected);
        expect(detail).toContain(`${age} s`);
        expect(r.status, `${age} s`).toBe(expected === "FAIL" ? 1 : 0);
      }
    });

    it("ingen rad (produsentene er AV, eller worker har aldri tikket) = UNKNOWN med den årsaken - aldri PASS", () => {
      const r = run({}, { wdAge: "" });
      expect(c14(r)[0]).toBe("UNKNOWN");
      expect(c14(r)[1]).toContain("incident-produsentene er AV");
      expect(c14(r)[1]).toContain("worker har aldri tikket");
      expect(r.status, r.out).toBe(0);
    });

    it("databasen svarer ikke = UNKNOWN (annen årsak); ikke-tall fra psql er UNKNOWN, ikke PASS", () => {
      const down = run({}, { wdAge: "", select1: "" });
      expect(c14(down)[0]).toBe("UNKNOWN");
      expect(c14(down)[1]).toContain("kontakt med databasen");
      for (const junk of ["ERROR", "abc", "12abc", "1.5", "--1", "t"]) expect(c14(run({}, { wdAge: junk }))[0], junk).toBe("UNKNOWN");
    });

    it("klokkeavvik: en liten negativ alder (under 60 s) regnes som 0; en stor negativ (tikket er datert frem i tid) er UNKNOWN", () => {
      const small = run({}, { wdAge: "-5" });
      expect(c14(small)[0]).toBe("PASS");
      expect(c14(small)[1]).toBe("siste vakthund-tikk for 0 s siden (grense 300 s)");
      expect(c14(run({}, { wdAge: "-60" }))[0]).toBe("PASS");
      const large = run({}, { wdAge: "-61" });
      expect(c14(large)[0]).toBe("UNKNOWN");
      expect(c14(large)[1]).toContain("klokkeavvik");
    });

    it("evidensfilen har C14-raden og ingen hemmeligheter", () => {
      const r = run({}, { wdAge: "42" });
      const doc = readFileSync(r.out.match(/Evidens skrevet til: (.+)/)[1].trim(), "utf8");
      expect(doc).toMatch(/\| C14_watchdog_alive \| PASS \| .*42 s/);
      expect(doc).not.toMatch(/password|passord=|token=|secret=/i);
    });
  });

  it("scriptet leser aldri .env og skriver aldri passord (statisk vakt)", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/(\/|\s|")\.env\b/);
    expect(code).not.toMatch(/PGPASSWORD|POSTGRES_PASSWORD|DB_ADMIN_PASSWORD/);
  });

  it("JARVIS_ACCEPTANCE_OUT_DIR styrer hvor evidensfilen havner", () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "gate-out-")), "evidens");
    const r = run({ JARVIS_ACCEPTANCE_OUT_DIR: outDir });
    expect(r.status, r.out).toBe(0);
    const m = r.out.match(/Evidens skrevet til: (.+)/);
    expect(m).not.toBeNull();
    expect(m[1].trim().startsWith(outDir)).toBe(true);
    expect(readdirSync(outDir).some((n) => /^nas-ua0-gate-.*\.md$/.test(n))).toBe(true);
  });

  it("evidensfilen kan ikke skrives: scriptet påstår ALDRI at den ble skrevet, sier hvorfor og hva som rettes, og exit-koden følger fortsatt kun sjekkene", () => {
    // En vanlig FIL der mappen skulle ligge: mkdir feiler uavhengig av hvem som kjører testen (root omgår ellers rettighetssjekker).
    const blocker = join(mkdtempSync(join(tmpdir(), "gate-blocker-")), "ikke-en-mappe");
    writeFileSync(blocker, "x");
    const outDir = join(blocker, "out");

    const ok = run({ JARVIS_ACCEPTANCE_OUT_DIR: outDir });
    expect(ok.out).not.toMatch(/Evidens skrevet til/);
    expect(ok.out).toMatch(/ADVARSEL: evidensfilen ble IKKE skrevet/);
    expect(ok.out).toContain(outDir);
    expect(ok.out).toMatch(/sudo chown -R /);
    expect(ok.out).toContain("JARVIS_ACCEPTANCE_OUT_DIR");
    // Sjekkene og sammendraget skrives uansett: skjermen er evidensen.
    expect(ok.out).toMatch(/C02_migrations_applied\s+PASS/);
    expect(ok.out).toMatch(/Sammendrag: PASS=\d+ WARN=\d+ UNKNOWN=\d+ FAIL=0/);
    expect(ok.status, ok.out).toBe(0);

    // En ekte FAIL gir fortsatt exit 1, også når filen ikke kan skrives.
    const bad = run({ JARVIS_ACCEPTANCE_OUT_DIR: outDir }, { norls: "capabilities,hemmelig_tabell" });
    expect(bad.out).toMatch(/ADVARSEL: evidensfilen ble IKKE skrevet/);
    expect(bad.status).toBe(1);
  });
});
