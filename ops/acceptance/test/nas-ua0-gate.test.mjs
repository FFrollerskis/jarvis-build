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

function run(env = {}, overrides = {}) {
  const fake = fakeDocker(overrides);
  const res = spawnSync("bash", [SCRIPT], { env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, ...env }, encoding: "utf8", timeout: 60_000 });
  return { ...res, out: res.stdout + res.stderr };
}

describe("nas-ua0-gate.sh", () => {
  it("er gyldig bash og tørrkjøringen lister alle 12 sjekker uten å kjøre docker", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    const res = spawnSync("bash", [SCRIPT], { env: { ...process.env, JARVIS_ACCEPTANCE_DRY_RUN: "1", PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(res.status).toBe(0);
    for (const id of ["C01_compose_services", "C02_migrations_applied", "C03_pgvector_hnsw", "C04_schema_features", "C05_api_health", "C06_local_model", "C07_chat_cost_24h", "C08_provider_failures_24h", "C09_ev0_boot", "C10_backup_freshness", "C11_rls_tables", "C12_container_hardening"]) {
      expect(res.stdout, id).toContain(id);
    }
  });

  it("friskt system: alt PASS (backup ukjent uten JARVIS_BACKUP_DIR), exit 0, evidensfil uten hemmeligheter skrevet", () => {
    const r = run();
    expect(r.status, r.out).toBe(0);
    for (const id of ["C01_compose_services", "C02_migrations_applied", "C03_pgvector_hnsw", "C04_schema_features", "C05_api_health", "C06_local_model", "C07_chat_cost_24h", "C08_provider_failures_24h", "C09_ev0_boot", "C11_rls_tables", "C12_container_hardening"]) {
      expect(r.out, id).toMatch(new RegExp(`${id}\\s+PASS`));
    }
    expect(r.out).toMatch(/C10_backup_freshness\s+UNKNOWN/);
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

  it("scriptet leser aldri .env og skriver aldri passord (statisk vakt)", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/(\/|\s|")\.env\b/);
    expect(code).not.toMatch(/PGPASSWORD|POSTGRES_PASSWORD|DB_ADMIN_PASSWORD/);
  });
});
