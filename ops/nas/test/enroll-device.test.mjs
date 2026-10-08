import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Innrulleringsskriptet for en ny nettleser på NAS-en. Testes uten ekte docker: en falsk `docker` på PATH logger argumentene den fikk, så kommandolinjen
 * (hvilken tjeneste, hvilke miljøvariabler, hvilken side), adressevalideringen og at ingen hemmeligheter fra env-filen følger med er bevist.
 * Det beviser IKKE at billetten virker mot den ekte NAS-en - det ble bevist av selve kommandoen (samme argumenter) 2026-10-08.
 */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(ROOT, "ops/nas/enroll-device.sh");
const DEFAULT_COMPOSE = join(ROOT, "infra/local/docker-compose.yml");
const BASE = "https://dxp4800plus-ring.tail3935f7.ts.net";
// Markør som IKKE skal dukke opp i docker-argumentene eller utdataene. Bygget ved kjøring i stedet for som bokstavelig verdi etter «PASSWORD=»:
// gitleaks (generic-api-key) leser en slik linje som en ekte hemmelighet selv i en testfixtur (PR #302, første commit).
const SENTINEL = ["ikke", "i", "args", "eller", "utdata"].join("_");

function setup(envContent = `JARVIS_DB_ADMIN_PASSWORD=${SENTINEL}\nJARVIS_OWNER_NAME=Eier\n`) {
  const dir = mkdtempSync(join(tmpdir(), "enroll-test-"));
  const log = join(dir, "docker-args.log");
  const envFile = join(dir, "env");
  writeFileSync(envFile, envContent);
  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${log}"\nexit "\${FAKE_DOCKER_EXIT:-0}"\n`
  );
  chmodSync(join(dir, "docker"), 0o755);
  return { dir, log, envFile };
}

function run(args, { env = {}, envContent } = {}) {
  const s = setup(envContent);
  const clean = { ...process.env };
  delete clean.JARVIS_PUBLIC_VOICE_BASE_URL;
  const res = spawnSync("bash", [SCRIPT, ...args], {
    env: { ...clean, PATH: `${s.dir}:${process.env.PATH}`, JARVIS_ENV_FILE: s.envFile, ...env },
    encoding: "utf8",
    timeout: 30_000
  });
  const dockerArgs = existsSync(s.log) ? readFileSync(s.log, "utf8").trim().split("\n") : null;
  return { ...res, out: res.stdout + res.stderr, dockerArgs, envFile: s.envFile };
}

describe("ops/nas/enroll-device.sh", () => {
  it("er gyldig bash", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });

  it("kjører CLI-en i migrate-tjenesten (kun den har admin-DB) med adressen som miljøvariabel og dashboard som standardside", () => {
    const r = run([BASE]);
    expect(r.status, r.out).toBe(0);
    expect(r.dockerArgs).toEqual([
      "compose", "--env-file", r.envFile, "-f", DEFAULT_COMPOSE,
      "run", "--rm", "--no-deps",
      "-e", `JARVIS_PUBLIC_VOICE_BASE_URL=${BASE}`,
      "migrate", "node", "--experimental-transform-types", "apps/api/src/enroll-ticket-main.ts", "--path", "dashboard"
    ]);
    // Aldri api/worker (de har bevisst ikke admin-databasetilgang).
    expect(r.dockerArgs).not.toContain("api");
    expect(r.dockerArgs).not.toContain("worker");
    expect(r.out).toMatch(/Lim aldri billetten eller lenken inn i chat/);
  });

  it("avsluttende skråstrek fjernes; side velges: voice, chat (forsiden) og ukjent side avvises", () => {
    expect(run([`${BASE}/`, "voice"]).dockerArgs?.slice(-2)).toEqual(["--path", "voice"]);
    expect(run([BASE, "chat"]).dockerArgs?.slice(-2)).toEqual(["--path", "/"]);
    const slash = run([`${BASE}/`]);
    expect(slash.dockerArgs).toContain(`JARVIS_PUBLIC_VOICE_BASE_URL=${BASE}`);
    const bad = run([BASE, "admin"]);
    expect(bad.status).toBe(2);
    expect(bad.dockerArgs).toBeNull();
    expect(bad.out).toMatch(/ukjent side/);
  });

  it("http:// og ugyldige adresser avvises FØR docker kjøres (enhetsnøkkelen krever HTTPS)", () => {
    const http = run(["http://dxp4800plus-ring.tail3935f7.ts.net"]);
    expect(http.status).toBe(2);
    expect(http.dockerArgs).toBeNull();
    expect(http.out).toMatch(/https:\/\//);
    for (const bad of ["https://", "https://a b.ts.net", `${BASE}/dashboard`, "https://-x.ts.net", "ftp://x.ts.net", "https://x.ts.net;rm"]) {
      const r = run([bad]);
      expect(r.status, bad).toBe(2);
      expect(r.dockerArgs, bad).toBeNull();
    }
  });

  it("uten adresse (argument, miljø eller env-fil) stopper den med en tydelig melding", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.dockerArgs).toBeNull();
    expect(r.out).toMatch(/mangler adresse/);
  });

  it("adressen kan komme fra miljøet eller fra env-filen (anførselstegn og CRLF fjernes) - og ingenting annet fra env-filen følger med", () => {
    const fromEnv = run([], { env: { JARVIS_PUBLIC_VOICE_BASE_URL: BASE } });
    expect(fromEnv.dockerArgs).toContain(`JARVIS_PUBLIC_VOICE_BASE_URL=${BASE}`);

    const fromFile = run([], {
      envContent: `JARVIS_DB_ADMIN_PASSWORD=${SENTINEL}\r\nJARVIS_PUBLIC_VOICE_BASE_URL="${BASE}"\r\nJARVIS_OWNER_NAME=Eier\r\n`
    });
    expect(fromFile.status, fromFile.out).toBe(0);
    expect(fromFile.dockerArgs).toContain(`JARVIS_PUBLIC_VOICE_BASE_URL=${BASE}`);
    expect(fromFile.dockerArgs?.join("\n")).not.toContain(SENTINEL);
    expect(fromFile.out).not.toContain(SENTINEL);

    // Argumentet vinner over miljø og fil.
    const arg = run(["https://annen.ts.net"], { env: { JARVIS_PUBLIC_VOICE_BASE_URL: BASE } });
    expect(arg.dockerArgs).toContain("JARVIS_PUBLIC_VOICE_BASE_URL=https://annen.ts.net");
  });

  it("feil fra docker/compose gir samme avslutningskode videre (ingen stille suksess)", () => {
    const r = run([BASE], { env: { FAKE_DOCKER_EXIT: "3" } });
    expect(r.status).toBe(3);
    expect(r.out).not.toMatch(/Lim aldri billetten/);
  });

  it("billetten skrives aldri til fil eller logg, og kun den ene adresselinjen leses fra env-filen (statisk vakt)", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\btee\b/);
    expect(code).not.toMatch(/>>/);
    // Omdirigeringer er kun til stderr eller /dev/null - aldri til en fil (billetten går bare til terminalen).
    for (const m of code.matchAll(/(?<![<>=-])\s*[0-9]?>(?!>)\s*(\S+)/g)) {
      expect(["&2", "&1", "/dev/null"], `uventet omdirigering: ${m[0]}`).toContain(m[1].replace(/[;})"']+$/g, ""));
    }
    // Alle grep mot env-filen gjelder kun adressevariabelen.
    for (const line of code.split("\n").filter((l) => /grep .*"\$ENV_FILE"/.test(l))) {
      expect(line).toContain("JARVIS_PUBLIC_VOICE_BASE_URL");
    }
    expect(code).not.toMatch(/PASSWORD|SECRET|TOKEN/);
  });
});
