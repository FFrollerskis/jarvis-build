import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * EV-0 break-glass (D-410): nødstopp-skriptet kjøres mot en fake `docker` som logger kallene. Beviser: tørrkjøring endrer ingenting, --yes gjør
 * nøyaktig det som er lovet (kill switch + revisjon + stopp), --release fjerner kun kill switch og starter ingenting, ugyldig .env avbryter,
 * og ingen hemmelighet fra .env havner i utskriften.
 */
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "freeze-jarvis.sh");

function setup({ envLines, dockerFails = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-breakglass-"));
  const log = join(dir, "docker.log");
  const bin = join(dir, "docker");
  writeFileSync(bin, `#!/usr/bin/env bash\necho "$*" >> "${log}"\n${dockerFails ? `case "$*" in ${dockerFails}) exit 1;; esac\n` : ""}exit 0\n`);
  chmodSync(bin, 0o755);
  const envFile = join(dir, ".env");
  writeFileSync(envFile, (envLines ?? [
    "JARVIS_TENANT_ID=tenant-personal", "JARVIS_OWNER_PERSON_ID=person-owner",
    "INFISICAL_ENCRYPTION_KEY=SUPERSECRETVALUE123", "ANTHROPIC_API_KEY=sk-ant-SECRETKEY999"
  ]).join("\n") + "\n");
  return { dir, log, envFile };
}

function run(args, ctx) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${ctx.dir}:${process.env.PATH}`, JARVIS_BREAKGLASS_ENV_FILE: ctx.envFile, JARVIS_BREAKGLASS_COMPOSE_FILE: "/x/docker-compose.yml" }
  });
  const calls = existsSync(ctx.log) ? readFileSync(ctx.log, "utf8").trim().split("\n").filter(Boolean) : [];
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

describe("break-glass freeze-jarvis.sh", () => {
  it("tørrkjøring (standard): viser planen, kaller IKKE docker", () => {
    const ctx = setup();
    const r = run([], ctx);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("TØRRKJØRING");
    expect(r.out).toContain("kill_switch");
    expect(r.out).toContain("docker compose stop api worker voice-gateway");
  });

  it("--yes: revisjon FØRST, så kill switch, så stopp av api/worker/voice-gateway", () => {
    const ctx = setup();
    const r = run(["--yes"], ctx);
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(3);
    expect(r.calls[0]).toContain("INSERT INTO audit_events");
    expect(r.calls[0]).toContain("break_glass.freeze");
    expect(r.calls[0]).toContain("tenant-personal");
    expect(r.calls[1]).toContain("INSERT INTO owner_control_state");
    expect(r.calls[1]).toContain("'kill_switch', 'GLOBAL'");
    expect(r.calls[2]).toContain("stop api worker voice-gateway");
  });

  it("--no-stop --yes: kun kill switch og revisjon, ingen stopp", () => {
    const r = run(["--no-stop", "--yes"], setup());
    expect(r.calls).toHaveLength(2);
    expect(r.calls.some((c) => c.includes(" stop "))).toBe(false);
  });

  it("--release --yes: sletter kun kill switch-raden, skriver revisjon, starter/stopper INGENTING", () => {
    const r = run(["--release", "--yes"], setup());
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]).toContain("break_glass.release");
    expect(r.calls[1]).toContain("DELETE FROM owner_control_state WHERE control_kind = 'kill_switch'");
    expect(r.calls.some((c) => / (stop|start|up) /.test(c))).toBe(false);
  });

  it("--release uten --yes er også tørrkjøring", () => {
    const r = run(["--release"], setup());
    expect(r.calls).toEqual([]);
  });

  it("ugyldig eller manglende tenant/eier i .env avbryter FØR noe kjøres (hindrer SQL-injeksjon via .env)", () => {
    for (const envLines of [["JARVIS_OWNER_PERSON_ID=p"], ["JARVIS_TENANT_ID=t';DROP TABLE x;--", "JARVIS_OWNER_PERSON_ID=p"]]) {
      const ctx = setup({ envLines });
      const r = run(["--yes"], ctx);
      expect(r.status).toBe(2);
      expect(r.calls).toEqual([]);
    }
  });

  it("revisjonsfeil stopper IKKE nødstoppet, men meldes høyt", () => {
    const ctx = setup({ dockerFails: "*audit_events*" });
    const r = run(["--yes"], ctx);
    expect(r.status).toBe(0);
    expect(r.out).toContain("ADVARSEL");
    expect(r.calls.some((c) => c.includes("owner_control_state"))).toBe(true);
    expect(r.calls.some((c) => c.includes("stop api worker voice-gateway"))).toBe(true);
  });

  it("kill switch-feil gir feilkode og stopper IKKE containerne på halvveien", () => {
    const ctx = setup({ dockerFails: "*owner_control_state*" });
    const r = run(["--yes"], ctx);
    expect(r.status).toBe(1);
    expect(r.calls.some((c) => c.includes(" stop "))).toBe(false);
  });

  it("ingen hemmelighet fra .env havner i utskriften eller i docker-kallene, og ukjent argument avvises", () => {
    const ctx = setup();
    const r = run(["--yes"], ctx);
    for (const secret of ["SUPERSECRETVALUE123", "sk-ant-SECRETKEY999"]) {
      expect(r.out).not.toContain(secret);
      expect(r.calls.join("\n")).not.toContain(secret);
    }
    expect(run(["--bogus"], ctx).status).toBe(2);
  });
});
