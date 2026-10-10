import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, fakeBinDir, tempDir } from "./helpers.mjs";

afterAll(cleanupTempDirs);
const SCRIPT = fileURLToPath(new URL("../nas-restore-verify.sh", import.meta.url));
const source = readFileSync(SCRIPT, "utf8");
const IMAGE = /^IMAGE="([^"]+)"$/m.exec(source)?.[1] ?? "";

/**
 * nas-restore-verify.sh startes mot en ENGANGS Postgres-container. Det kan ikke kjøres mot en ekte Docker-daemon her (NOT VERIFIED - eieren kjører
 * `ops/backup/nas-restore-verify.sh --selftest` og `ops/backup/acceptance-ops.sh drill ...`), men ARGUMENTENE til `docker run` er en sikkerhetsegenskap som kan låses fast: scriptet kjøres
 * for ekte med en falsk `docker` først i PATH som logger hvert kall (argv, ett kall per linje, skilt med \x1f) og miljøet `docker run` ble startet med.
 */
function runSelftest() {
  const dir = tempDir("wpc2-nasverify-");
  const log = join(dir, "docker-calls.log");
  const envLog = join(dir, "docker-run-env.log");
  const bin = fakeBinDir({
    docker: `
      ( IFS=$'\\x1f'; echo "$*" ) >> "${log}"
      case "$1" in
        run) printf 'POSTGRES_PASSWORD=%s\\nMSYS_NO_PATHCONV=%s\\n' "$POSTGRES_PASSWORD" "$MSYS_NO_PATHCONV" >> "${envLog}"; echo "abc123containerid" ;;
        inspect) echo "network=none memory=4294967296" ;;
      esac
      exit 0`
  });
  const res = spawnSync("bash", [SCRIPT, "--selftest"], { encoding: "utf8", timeout: 90_000, env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir } });
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\x1f")) : [];
  return { res, calls, runEnv: existsSync(envLog) ? readFileSync(envLog, "utf8") : "" };
}

describe("nas-restore-verify.sh", () => {
  it("er gyldig bash", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });

  it("review F2 + runde 2 L4: scratch-containeren startes UTEN nettverk, med minne-/CPU-/prosessgrenser, alle capabilities droppet (kun de fem Postgres trenger), no-new-privileges, read-only rotfs og tmpfs med størrelse - eksakt argv", () => {
    const { res, calls, runEnv } = runSelftest();
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("selftest OK");
    const runs = calls.filter((c) => c[0] === "run");
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run[3]).toMatch(/^jarvis-restore-scratch-\d+$/);
    expect(IMAGE).toMatch(/^pgvector\/pgvector:pg16@sha256:[0-9a-f]{64}$/);
    expect(run).toEqual([
      "run", "-d", "--name", run[3],
      "--network", "none",
      "--memory", "4g", "--memory-swap", "4g", "--cpus", "2", "--pids-limit", "512",
      "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--cap-add", "SETGID", "--cap-add", "SETUID",
      "--security-opt", "no-new-privileges:true",
      "--read-only",
      "--tmpfs", "/var/lib/postgresql/data:size=3g", "--tmpfs", "/run/postgresql:size=16m", "--tmpfs", "/tmp:size=256m",
      "-e", "POSTGRES_PASSWORD",
      IMAGE
    ]);
    // passordet sendes ved NAVN (verdien står aldri i argv), og Git Bash omskriver ikke container-stiene
    const password = /^POSTGRES_PASSWORD=(.+)$/m.exec(runEnv)?.[1] ?? "";
    expect(password).toMatch(/^[0-9a-f]{48}$/);
    expect(calls.flat().join(" ")).not.toContain(password);
    expect(runEnv).toContain("MSYS_NO_PATHCONV=1");
    // ingenting som åpner containeren mot verten eller gir den mer enn det trenger
    expect(run.join(" ")).not.toMatch(/-p \d|--publish|--network (host|bridge)|--privileged|--volume|-v |--device|--pid[= ]|--ipc[= ]|--cap-add (SYS_|NET_|ALL)|--security-opt (seccomp|apparmor)=unconfined/);
  });

  it("selftest: venter på `select 1` to ganger, viser grensene Docker faktisk satte (inspect), og fjerner containeren til slutt (også ved feil: trap)", () => {
    const { calls } = runSelftest();
    const verbs = calls.map((c) => c[0]);
    expect(verbs.filter((v) => v === "exec")).toHaveLength(2);
    expect(verbs).toContain("inspect");
    const inspect = calls.find((c) => c[0] === "inspect");
    expect(inspect.join(" ")).toMatch(/HostConfig\.Memory.*HostConfig\.PidsLimit.*HostConfig\.ReadonlyRootfs.*HostConfig\.CapDrop.*HostConfig\.SecurityOpt/);
    const last = calls.at(-1);
    expect(last.slice(0, 2)).toEqual(["rm", "-f"]);
    expect(last[2]).toMatch(/^jarvis-restore-scratch-\d+$/);
  });

  it("uten --selftest kreves backup-sett og identitetsfil, og docker kontaktes ikke før begge finnes", () => {
    const dir = tempDir("wpc2-nasverify-");
    const log = join(dir, "docker-calls.log");
    const bin = fakeBinDir({ docker: `echo "$*" >> "${log}"; exit 0` });
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir };
    const noArgs = spawnSync("bash", [SCRIPT], { encoding: "utf8", env });
    expect(noArgs.status).not.toBe(0);
    expect(noArgs.stderr).toContain("bruk: nas-restore-verify.sh");
    const missingSet = spawnSync("bash", [SCRIPT, join(dir, "finnes-ikke"), join(dir, "id.txt")], { encoding: "utf8", env });
    expect(missingSet.status).toBe(1);
    expect(missingSet.stderr).toContain("finner ikke backup-sett");
    expect(existsSync(log)).toBe(false);
  });

  it("containeren fjernes alltid (trap), og rapporten må inneholde ok:true selv om exit-koden er 0 (D-372)", () => {
    expect(source).toMatch(/trap cleanup EXIT/);
    expect(source).toMatch(/docker rm -f "\$NAME"/);
    expect(source).toContain('grep -q \'"ok": true\'');
  });
});
