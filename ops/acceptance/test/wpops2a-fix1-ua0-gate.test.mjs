import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WP-OPS2a FIKS-RUNDE 1 (review B: M1, M2, L6-L9, L11): C13 i UA-0-gaten. Samme testteknikk som `nas-ua0-gate.test.mjs`: en falsk `docker` på PATH og en falsk `nas-schedule.sh`, så klassifiseringen, exit-koden og evidensfilen
 * er bevist uten NAS. Det beviser IKKE noe om den ekte NAS-en. Verdier som ligner hemmeligheter bygges sammensatt ved kjøring (ingen ekte-lignende fixturer).
 */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(ROOT, "ops/acceptance/nas-ua0-gate.sh");
const HF_GATE = join(ROOT, "ops/acceptance/nas-hf1-hf2-gate.sh");
const DOC = join(ROOT, "docs/runbooks/UA0_NAS_ACCEPTANCE.md");
const MIGS = readdirSync(join(ROOT, "modules/core/src/db/migrations")).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();

function fakeDocker(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fix1-fake-docker-"));
  const cfg = {
    ps: "api=running/healthy postgres=running/healthy worker=running/healthy",
    migrations: MIGS.join("\n"),
    vector: "vector", hnsw: "2", regclass: "t", delivered: "1", select1: "1",
    health: "200", models: "llama3.1:8b,bge-m3",
    cost: "gemma_local:12 kall/0 øre", cloudOre: "0", fails: "", ev0: '{"msg":"ev0_constitution_boot","status":"verified"} {"msg":"ev0_change_ledger_boot","status":"ok"}',
    norls: "capabilities,evolution_change_ledger,github_rate_limit_state,owner_control_state,scheduler_state,schema_migrations,self_modification_requests,situation_domain_pauses,telegram_poll_state",
    inspect: 'jarvis|true|["ALL"]', wdAge: "30", ...overrides
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

/** Falsk `nas-schedule.sh`: kalles med NØYAKTIG `<mappe> status --json`; skriver argumentene den fikk til `args.txt` (så testen kan se hvilken mappe gaten sendte). `body` kan avvike fra standard (for eksempel en kommando som ignorerer TERM). */
function fakeStatusCmd(rc, json, { sleepSec = 0, ignoreTerm = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fix1-fake-status-"));
  const file = join(dir, "nas-schedule.sh");
  writeFileSync(join(dir, "out.json"), typeof json === "string" ? json : JSON.stringify(json));
  writeFileSync(file, `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${join(dir, "args.txt")}"
[ "$#" = "3" ] && [ "$2" = "status" ] && [ "$3" = "--json" ] || { echo "uventede argumenter: $*" >&2; exit 64; }
${ignoreTerm ? "trap '' TERM\n" : ""}${sleepSec ? `sleep ${sleepSec}\n` : ""}cat "${join(dir, "out.json")}"
exit ${rc}
`);
  chmodSync(file, 0o755);
  return { file, argsFile: join(dir, "args.txt") };
}

const statusJson = (over = {}) => ({
  ok: true, exit_code: 0, reasons: [], backup: { newest_set: "jarvis-backup-20261125T020000Z", age_hours: 3.5, limit_hours: 36 }, offsite: { state: "ok" }, restore_verify: { state: "ok", age_days: 2 },
  heartbeat: { configured: false }, ...over
});
const withStates = (verify, offsite, extra = {}) => statusJson({ restore_verify: { state: verify }, offsite: { state: offsite }, ...extra });

function gateEnv(rc, json, extra = {}, cmdOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fix1-bk-dir-"));
  writeFileSync(join(dir, "x.age"), "x"); // C10 skal være PASS, så exit-koden kun styres av C13
  const cmd = fakeStatusCmd(rc, json, cmdOptions);
  return { JARVIS_BACKUP_DIR: dir, JARVIS_ACCEPTANCE_BACKUP_STATUS_CMD: cmd.file, ...extra, __argsFile: cmd.argsFile };
}

function run(env = {}, overrides = {}, spawnOptions = {}) {
  const fake = fakeDocker(overrides);
  const outDir = mkdtempSync(join(tmpdir(), "fix1-gate-evidence-"));
  const { __argsFile, ...cleanEnv } = env;
  void __argsFile;
  const started = Date.now();
  const res = spawnSync("bash", [spawnOptions.script ?? SCRIPT], {
    env: { ...process.env, JARVIS_ACCEPTANCE_OUT_DIR: outDir, PATH: spawnOptions.path ?? `${fake}:${process.env.PATH}`, ...cleanEnv },
    encoding: "utf8", timeout: 90_000, ...(spawnOptions.cwd ? { cwd: spawnOptions.cwd } : {})
  });
  return { ...res, out: res.stdout + res.stderr, elapsedMs: Date.now() - started };
}
const c13 = (r) => (r.out.match(/^C13_backup_status\s+(\S+)\s+(.*)$/m) ?? []).slice(1);
const c14 = (r) => (r.out.match(/^C14_watchdog_alive\s+(\S+)\s+(.*)$/m) ?? []).slice(1);

describe("B-M1: C13 gir aldri PASS fra en status-JSON uten gyldig exit_code eller med ukjente tilstander", () => {
  const cases = [
    ["tom JSON-objekt", "{}"],
    ["bare ok:true", '{"ok":true}'],
    ["exit_code mangler, resten gyldig", (() => { const j = statusJson(); delete j.exit_code; return JSON.stringify(j); })()],
    ["exit_code som tekst", JSON.stringify(statusJson({ exit_code: "0" }))],
    ["exit_code brøk", JSON.stringify(statusJson({ exit_code: 0.5 }))],
    ["exit_code null", JSON.stringify(statusJson({ exit_code: null }))],
    ["exit_code negativ", JSON.stringify(statusJson({ exit_code: -1 }))]
  ];

  it("exit 0 uten gyldig exit_code er UNKNOWN (aldri PASS), med en egen årsak som skiller seg fra «uenige» og «kunne ikke tolkes»", () => {
    for (const [label, body] of cases) {
      const r = run(gateEnv(0, body));
      const [status, detail] = c13(r);
      expect(status, `${label}: ${r.out}`).toBe("UNKNOWN");
      expect(detail, label).toMatch(/mangler gyldig exit_code/);
      expect(r.status, `${label}: ${r.out}`).toBe(0); // UNKNOWN er ikke FAIL
    }
  });

  it("også exit 3/4/5 med JSON uten gyldig exit_code er UNKNOWN (JSON-en er ikke fra statusskriptet, så ingenting kan bekreftes)", () => {
    for (const rc of [3, 4, 5]) {
      const r = run(gateEnv(rc, "{}"));
      expect(c13(r)[0], `exit ${rc}`).toBe("UNKNOWN");
      expect(r.status, `exit ${rc}`).toBe(0);
    }
  });

  it("exit 0 med gyldig exit_code men ukjent alder, ukjent restore-tilstand eller ukjent off-site-tilstand er UNKNOWN (ikke PASS)", () => {
    const incomplete = [
      ["alder mangler", statusJson({ backup: { newest_set: "x" } })],
      ["alder er tekst", statusJson({ backup: { age_hours: "3" } })],
      ["alder negativ", statusJson({ backup: { age_hours: -2 } })],
      ["alder uendelig", '{"exit_code":0,"backup":{"age_hours":1e999},"restore_verify":{"state":"ok"},"offsite":{"state":"ok"}}'],
      ["restore-tilstand mangler", (() => { const j = statusJson(); delete j.restore_verify; return j; })()],
      ["restore-tilstand ukjent", withStates("sannsynligvis_ok", "ok")],
      ["off-site-tilstand mangler", (() => { const j = statusJson(); delete j.offsite; return j; })()],
      ["off-site-tilstand ukjent", withStates("ok", "Bearer-token-xyz")]
    ];
    for (const [label, body] of incomplete) {
      const r = run(gateEnv(0, typeof body === "string" ? body : JSON.stringify(body)));
      const [status, detail] = c13(r);
      expect(status, `${label}: ${r.out}`).toBe("UNKNOWN");
      expect(detail, label).toMatch(/ufullstendig status-JSON/);
      expect(r.status, label).toBe(0);
    }
  });

  it("exit 0 med en tilstand som sier `failed` er motsigelse (aldri PASS og aldri WARN): UNKNOWN med årsaken «uenige»", () => {
    for (const [verify, offsite] of [["failed", "ok"], ["ok", "failed"], ["failed", "failed"]]) {
      const r = run(gateEnv(0, withStates(verify, offsite)));
      expect(c13(r)[0], `${verify}/${offsite}`).toBe("UNKNOWN");
      expect(c13(r)[1]).toMatch(/uenige/);
    }
  });

  it("fortsatt som før: exit 3 = FAIL, 4/5 = WARN når JSON er gyldig (M1 endrer ikke de ekte tilstandene)", () => {
    expect(c13(run(gateEnv(3, statusJson({ ok: false, exit_code: 3, backup: { age_hours: 40 } }))))[0]).toBe("FAIL");
    expect(c13(run(gateEnv(4, withStates("failed", "ok", { ok: false, exit_code: 4 }))))[0]).toBe("WARN");
    expect(c13(run(gateEnv(5, withStates("ok", "failed", { ok: false, exit_code: 5 }))))[0]).toBe("WARN");
  });
});

describe("B-M2: C13 gir WARN (ikke PASS) for nøyaktig de samme tilstandene som H07", () => {
  it("restore=never_run|not_configured og offsite=not_configured|pending med exit 0 gir WARN, og detaljen viser tilstandene", () => {
    for (const [verify, offsite] of [["never_run", "ok"], ["not_configured", "ok"], ["ok", "not_configured"], ["ok", "pending"], ["never_run", "pending"], ["not_configured", "not_configured"]]) {
      const r = run(gateEnv(0, withStates(verify, offsite)));
      const [status, detail] = c13(r);
      expect(status, `${verify}/${offsite}: ${r.out}`).toBe("WARN");
      expect(detail).toContain(`verify=${verify}`);
      expect(detail).toContain(`offsite=${offsite}`);
      expect(detail).toMatch(/ikke bekreftet/);
      expect(r.status, r.out).toBe(0); // WARN gir ikke exit 1
    }
  });

  it("restore=ok og offsite=ok gir fortsatt PASS (WARN er ikke et nytt standardsvar)", () => {
    const r = run(gateEnv(0, withStates("ok", "ok")));
    expect(c13(r)[0]).toBe("PASS");
    expect(c13(r)[1]).not.toMatch(/ikke bekreftet/);
  });

  it("paritet: C13 og H07 (`classify_backup` i nas-hf1-hf2-gate.sh, uendret) gir LIK utkomme for hver tilstandskombinasjon som kan forekomme sammen med exit 0", () => {
    const src = readFileSync(HF_GATE, "utf8");
    const fn = src.match(/^classify_backup\(\) \{[\s\S]*?^\}$/m);
    expect(fn, "classify_backup ble ikke funnet i HF-gaten").not.toBeNull();
    const h07 = (b, r, o, age = 3) => {
      const res = spawnSync("bash", ["-c", `BK_STATUS=""; BK_DETAIL=""\n${fn[0]}\nclassify_backup "backup=${b} restore=${r} offsite=${o} age_h=${age}"\nprintf '%s' "$BK_STATUS"`], { encoding: "utf8" });
      return res.stdout.trim();
    };
    // Alfabetene statusskriptet kan gi sammen med exit 0 (`schedule.mjs status`: failed gir alltid exit 4/5; `never` backup gir exit 3).
    const verifyTokens = ["not_configured", "never_run", "ok"];
    const offsiteTokens = ["not_configured", "pending", "ok"];
    const outcomes = [];
    for (const v of verifyTokens) {
      for (const o of offsiteTokens) {
        const expected = h07("ok", v, o);
        const actual = c13(run(gateEnv(0, withStates(v, o))))[0];
        outcomes.push(`${v}/${o}=${actual}`);
        expect(actual, `restore=${v} offsite=${o}: H07 sier ${expected}`).toBe(expected);
      }
    }
    expect(new Set(outcomes.map((x) => x.split("=")[1]))).toEqual(new Set(["PASS", "WARN"]));
    expect(outcomes).toHaveLength(9);
  });

  it("paritet utenfor exit 0-alfabetet: begge nekter PASS for `failed` og ukjente tilstander (C13: UNKNOWN fordi exit 0 og tilstanden er motstridende; H07: FAIL/UNKNOWN)", () => {
    const src = readFileSync(HF_GATE, "utf8");
    const fn = src.match(/^classify_backup\(\) \{[\s\S]*?^\}$/m)[0];
    const h07 = (r, o) => spawnSync("bash", ["-c", `BK_STATUS=""; BK_DETAIL=""\n${fn}\nclassify_backup "backup=ok restore=${r} offsite=${o} age_h=3"\nprintf '%s' "$BK_STATUS"`], { encoding: "utf8" }).stdout.trim();
    for (const [r, o] of [["failed", "ok"], ["ok", "failed"], ["bogus", "ok"], ["ok", "bogus"]]) {
      expect(h07(r, o), `H07 ${r}/${o}`).not.toBe("PASS");
      expect(c13(run(gateEnv(0, withStates(r, o))))[0], `C13 ${r}/${o}`).not.toBe("PASS");
    }
  });

  it("H01 i HF-gaten videreformidler C13-WARN som WARN (UA-0 med WARN/UNKNOWN er ikke bestått)", () => {
    const src = readFileSync(HF_GATE, "utf8");
    expect(src).toMatch(/\[ "\$\{ua0_warn:-0\}" -gt 0 \] \|\| \[ "\$\{ua0_unknown:-0\}" -gt 0 \]; then record H01_ua0_gate WARN/);
  });
});

describe("B-L6: kommandoen får `timeout -k 5` - en kommando som ignorerer TERM holder ikke gaten", () => {
  it("kommandolinjen i gaten bruker `timeout -k 5`", () => {
    const code = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).toMatch(/timeout -k 5 "\$BACKUP_STATUS_TIMEOUT"/);
  });

  it("en kommando som ignorerer SIGTERM gir UNKNOWN «tidsavbrudd» etter fristen + 5 s (ikke etter at kommandoen selv er ferdig)", () => {
    const r = run(gateEnv(0, statusJson(), { JARVIS_ACCEPTANCE_BACKUP_STATUS_TIMEOUT_SEC: "1" }, { sleepSec: 40, ignoreTerm: true }));
    const [status, detail] = c13(r);
    expect(status, r.out).toBe("UNKNOWN");
    expect(detail).toMatch(/tidsavbrudd etter 1 s/);
    expect(r.elapsedMs, "gaten skal ikke vente på en kommando som ignorerer TERM").toBeLessThan(30_000);
  }, 60_000);
});

describe("B-L8: JARVIS_BACKUP_DIR absolutiseres i gaten (C10 og C13 ser samme mappe uansett arbeidskatalog)", () => {
  it("en relativ mappe fra en annen arbeidskatalog sendes til status-kommandoen som absolutt sti", () => {
    const base = mkdtempSync(join(tmpdir(), "fix1-cwd-"));
    mkdirSync(join(base, "backups"));
    writeFileSync(join(base, "backups", "x.age"), "x");
    const env = gateEnv(0, withStates("ok", "ok"), { JARVIS_BACKUP_DIR: "backups" });
    const r = run(env, {}, { cwd: base });
    expect(c13(r)[0], r.out).toBe("PASS");
    expect(r.out).toMatch(/C10_backup_freshness\s+PASS/);
    const args = readFileSync(env.__argsFile, "utf8").split("\n").filter(Boolean);
    expect(isAbsolute(args[0])).toBe(true);
    expect(args[0]).toBe(join(base, "backups"));
    expect(args.slice(1)).toEqual(["status", "--json"]);
  });

  it("en absolutt mappe sendes uendret; en mappe som begynner med bindestrek tolkes ikke som et flagg", () => {
    const env = gateEnv(0, withStates("ok", "ok"));
    const r = run(env);
    expect(c13(r)[0]).toBe("PASS");
    expect(readFileSync(env.__argsFile, "utf8").split("\n")[0]).toBe(env.JARVIS_BACKUP_DIR);
    const base = mkdtempSync(join(tmpdir(), "fix1-dash-"));
    mkdirSync(join(base, "-rf"));
    const dash = gateEnv(0, withStates("ok", "ok"), { JARVIS_BACKUP_DIR: "-rf" });
    run(dash, {}, { cwd: base });
    expect(readFileSync(dash.__argsFile, "utf8").split("\n")[0]).toBe(join(base, "-rf"));
  });
});

describe("B-L9: test-seams er synlige i C13-detaljen", () => {
  /** Et uttrekk av repoet med en falsk `nas-schedule.sh`, så gaten kan kjøres UTEN seam (standardveien `$ROOT/ops/backup/nas-schedule.sh`). */
  function sandboxTree(rc, json) {
    const root = mkdtempSync(join(tmpdir(), "fix1-tree-"));
    mkdirSync(join(root, "ops/acceptance"), { recursive: true });
    mkdirSync(join(root, "ops/backup"), { recursive: true });
    mkdirSync(join(root, "infra/local"), { recursive: true });
    mkdirSync(join(root, "modules/core/src/db/migrations"), { recursive: true });
    copyFileSync(SCRIPT, join(root, "ops/acceptance/nas-ua0-gate.sh"));
    writeFileSync(join(root, "infra/local/docker-compose.yml"), "services: {}\n");
    const dir = mkdtempSync(join(tmpdir(), "fix1-tree-out-"));
    writeFileSync(join(dir, "out.json"), JSON.stringify(json));
    writeFileSync(join(root, "ops/backup/nas-schedule.sh"), `#!/usr/bin/env bash\ncat "${join(dir, "out.json")}"\nexit ${rc}\n`);
    chmodSync(join(root, "ops/backup/nas-schedule.sh"), 0o755);
    return join(root, "ops/acceptance/nas-ua0-gate.sh");
  }
  const bk = () => { const d = mkdtempSync(join(tmpdir(), "fix1-bk-")); writeFileSync(join(d, "x.age"), "x"); return d; };

  it("uten seam: ingen merknad; med JARVIS_ACCEPTANCE_BACKUP_STATUS_CMD, JARVIS_ACCEPTANCE_NODE_BIN eller _TIMEOUT_SEC: «(OVERSTYRT, kun test)» på C13-raden", () => {
    const script = sandboxTree(0, withStates("ok", "ok"));
    const plain = run({ JARVIS_BACKUP_DIR: bk() }, {}, { script });
    expect(c13(plain)[0], plain.out).toBe("PASS");
    expect(c13(plain)[1]).not.toMatch(/OVERSTYRT/);
    for (const seam of [{ JARVIS_ACCEPTANCE_NODE_BIN: "node" }, { JARVIS_ACCEPTANCE_BACKUP_STATUS_TIMEOUT_SEC: "100" }, { JARVIS_ACCEPTANCE_BACKUP_STATUS_CMD: join(dirname(script), "../backup/nas-schedule.sh") }]) {
      const r = run({ JARVIS_BACKUP_DIR: bk(), ...seam }, {}, { script });
      expect(c13(r)[0], JSON.stringify(seam)).toBe("PASS");
      expect(c13(r)[1], JSON.stringify(seam)).toMatch(/\(OVERSTYRT, kun test\)$/);
    }
  });

  it("merknaden står også i evidensfilen og på UNKNOWN/WARN-rader, ikke bare PASS", () => {
    const warn = run(gateEnv(0, withStates("never_run", "ok")));
    expect(c13(warn)[0]).toBe("WARN");
    expect(c13(warn)[1]).toMatch(/\(OVERSTYRT, kun test\)$/);
    const unknown = run(gateEnv(0, "{}"));
    expect(c13(unknown)[1]).toMatch(/\(OVERSTYRT, kun test\)$/);
    const doc = readFileSync(warn.out.match(/Evidens skrevet til: (.+)/)[1].trim(), "utf8");
    expect(doc).toMatch(/\| C13_backup_status \| WARN \| .*\(OVERSTYRT, kun test\) \|/);
  });

  it("C14 har ingen test-seam (leser via docker/psql): raden har aldri merknaden", () => {
    const r = run(gateEnv(0, withStates("ok", "ok")));
    expect(c14(r)[0]).toBe("PASS");
    expect(c14(r)[1]).not.toMatch(/OVERSTYRT/);
  });
});

describe("B-L7: toppteksten og dokumentet sier ikke lenger at hele kjøringen aldri leser .env", () => {
  it("scriptets topptekst skiller gaten selv (leser aldri .env) fra C13-barnet (nas-schedule.sh leser .env)", () => {
    const header = readFileSync(SCRIPT, "utf8").split("\n").slice(0, 12).join("\n");
    expect(header).not.toMatch(/^# Leser aldri \.env og skriver aldri passord\/tokens:/m);
    expect(header).toMatch(/Selve gaten leser aldri \.env/);
    expect(header).toMatch(/nas-schedule\.sh/);
    expect(header).toMatch(/leser \.env/);
  });

  it("UA0-dokumentet sier det samme", () => {
    const doc = readFileSync(DOC, "utf8");
    expect(doc).not.toMatch(/^Skriptet leser aldri `\.env` og skriver aldri passord;/m);
    expect(doc).toMatch(/Selve gaten leser aldri `\.env`/);
    expect(doc).toMatch(/nas-schedule\.sh[^\n]*`\.env`|`\.env`[^\n]*nas-schedule\.sh/);
  });
});

describe("B-L11: grener som manglet test", () => {
  it("årsakslisten er kuttet ved 6 koder (ikke flere), og settnavn/fritekst kommer aldri med", () => {
    const reasons = Array.from({ length: 9 }, (_, i) => `reason_${i}`);
    const r = run(gateEnv(3, statusJson({ ok: false, exit_code: 3, reasons, backup: { age_hours: 50 } })));
    const detail = c13(r)[1];
    expect(detail).toMatch(/reasons=reason_0,reason_1,reason_2,reason_3,reason_4,reason_5(?: |$)/);
    expect(detail).not.toContain("reason_6");
  });

  it("uten `timeout`-binær på PATH kjøres kommandoen likevel (uten frist) og klassifiseres som vanlig", () => {
    // PATH med KUN det gaten trenger, uten `timeout`: symlenker til verktøyene i en egen mappe.
    const bin = mkdtempSync(join(tmpdir(), "fix1-bin-"));
    const need = ["bash", "sh", "env", "node", "cat", "date", "sort", "tr", "grep", "ls", "comm", "tail", "head", "cut", "find", "id", "mkdir", "chmod", "sed", "printf", "sleep", "dirname", "uniq", "basename", "rm", "wc", "xargs", "awk", "readlink", "realpath", "mktemp", "tee", "true", "false", "test"];
    for (const name of need) {
      const w = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      if (w && isAbsolute(w) && !existsSync(join(bin, name))) symlinkSync(w, join(bin, name));
    }
    expect(existsSync(join(bin, "timeout"))).toBe(false);
    const fake = fakeDocker();
    const env = gateEnv(0, withStates("ok", "ok"));
    const r = run(env, {}, { path: `${fake}${delimiter}${bin}` });
    expect(spawnSync("bash", ["-c", "command -v timeout"], { env: { PATH: `${fake}${delimiter}${bin}` }, encoding: "utf8" }).stdout.trim()).toBe("");
    const [status, detail] = c13(r);
    expect(status, r.out).toBe("PASS");
    expect(detail).toBe("exit=0 age_h=3.5 verify=ok offsite=ok reasons=- (OVERSTYRT, kun test)");
    // Exit-koden følger kommandoen også uten `timeout`-binær (exit 3 = FAIL, ikke forkastet til 0).
    const overdue = run(gateEnv(3, statusJson({ ok: false, exit_code: 3, backup: { age_hours: 40 } })), {}, { path: `${fake}${delimiter}${bin}` });
    expect(c13(overdue)[0], overdue.out).toBe("FAIL");
    expect(c13(overdue)[1]).toMatch(/^exit=3 age_h=40 /);
    expect(overdue.status).toBe(1);
  });

  it("exit 137 UTEN at fristen er gått (kommandoen ble drept av noe annet) er «uventet exit», ikke «tidsavbrudd»", () => {
    const r = run(gateEnv(137, statusJson({ exit_code: 137 })));
    const [status, detail] = c13(r);
    expect(status, r.out).toBe("UNKNOWN");
    expect(detail).toMatch(/uventet exit 137/);
    expect(detail).not.toMatch(/tidsavbrudd/);
  });
});
