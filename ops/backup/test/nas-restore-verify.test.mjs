import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../nas-restore-verify.sh", import.meta.url));
const source = readFileSync(SCRIPT, "utf8");

/**
 * nas-restore-verify.sh startes mot en ENGANGS Postgres-container. Det kan ikke kjøres uten en Docker-daemon (NOT VERIFIED her - eieren kjører
 * `ops/backup/acceptance-ops.sh drill ...`), men argumentene til `docker run` er en sikkerhetsegenskap som kan låses fast statisk.
 */
describe("nas-restore-verify.sh", () => {
  it("er gyldig bash", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });

  it("review F2: scratch-containeren startes UTEN nettverk (settet er ubetrodd og dumpen kjører SQL som superuser der), med engangsdata i minnet og passord ved NAVN", () => {
    const run = source.split("\n").filter((l) => /^docker run /.test(l));
    expect(run).toHaveLength(1);
    expect(run[0]).toContain("--network none");
    expect(run[0]).toContain("--tmpfs /var/lib/postgresql/data");
    expect(run[0]).toContain("-e POSTGRES_PASSWORD"); // ved navn: verdien står aldri i argv
    expect(run[0]).not.toMatch(/-p \d|--publish|--network (host|bridge)|--privileged|-v |--volume/);
  });

  it("containeren fjernes alltid (trap), og rapporten må inneholde ok:true selv om exit-koden er 0 (D-372)", () => {
    expect(source).toMatch(/trap cleanup EXIT/);
    expect(source).toMatch(/docker rm -f "\$NAME"/);
    expect(source).toContain('grep -q \'"ok": true\'');
  });
});
