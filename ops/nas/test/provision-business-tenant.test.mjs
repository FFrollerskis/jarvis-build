import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WP-D2 (JARVIS-044/Q-48): `ops/nas/provision-business-tenant.sh`. Testes uten ekte docker: en falsk `docker` på PATH logger argumentene den fikk, så
 * kommandolinjen (kjører i `migrate`-tjenesten som har admin-DB), validering FØR docker, at navn med skall-tegn aldri tolkes av skallet og at ingen
 * hemmeligheter fra env-filen følger med er bevist. Det beviser IKKE at tenanten opprettes mot den ekte NAS-en - det gjør `provisionBusinessTenant`-testene
 * mot ekte Postgres (modules/core, apps/api) og kommandoen under «For å verifisere» i runbooken.
 */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(ROOT, "ops/nas/provision-business-tenant.sh");
const DEFAULT_COMPOSE = join(ROOT, "infra/local/docker-compose.yml");
const SENTINEL = ["ikke", "i", "args", "eller", "utdata"].join("_");

function setup(envContent = `JARVIS_DB_ADMIN_PASSWORD=${SENTINEL}\nJARVIS_OWNER_NAME=Eier\n`) {
  const dir = mkdtempSync(join(tmpdir(), "provision-test-"));
  const log = join(dir, "docker-args.log");
  const envFile = join(dir, "env");
  writeFileSync(envFile, envContent);
  // Argumentene skrives ett per linje; en NUL-skilt variant brukes til å bevise at navn med spesialtegn kommer som ÉTT argument.
  writeFileSync(join(dir, "docker"), `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "${log}"\nexit "\${FAKE_DOCKER_EXIT:-0}"\n`);
  chmodSync(join(dir, "docker"), 0o755);
  return { dir, log, envFile };
}

function run(args, { env = {} } = {}) {
  const s = setup();
  const res = spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, PATH: `${s.dir}:${process.env.PATH}`, JARVIS_ENV_FILE: s.envFile, ...env },
    encoding: "utf8",
    timeout: 30_000
  });
  const dockerArgs = existsSync(s.log) ? readFileSync(s.log, "utf8").split("\0").slice(0, -1) : null;
  return { ...res, out: res.stdout + res.stderr, dockerArgs, envFile: s.envFile };
}

const BASE_ARGS = (r, cli) => [
  "compose", "--env-file", r.envFile, "-f", DEFAULT_COMPOSE,
  "run", "--rm", "--no-deps",
  "migrate", "node", "--experimental-transform-types", "apps/api/src/provision-business-tenant-main.ts", ...cli
];

describe("ops/nas/provision-business-tenant.sh", () => {
  it("er gyldig bash", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });

  it("dry-run (kun navn): kjører CLI-en i migrate-tjenesten (kun den har admin-DB) uten --confirm - aldri api/worker", () => {
    const r = run(["Kundeoppfølging AS"]);
    expect(r.status, r.out).toBe(0);
    expect(r.dockerArgs).toEqual(BASE_ARGS(r, ["--name", "Kundeoppfølging AS"]));
    expect(r.dockerArgs).not.toContain("api");
    expect(r.dockerArgs).not.toContain("worker");
    expect(r.dockerArgs).not.toContain("--confirm");
  });

  it("slug og --confirm sendes videre som egne argumenter", () => {
    const r = run(["Kundeoppfølging AS", "kundeoppfolging", "--confirm", "tenant-kundeoppfolging"]);
    expect(r.status, r.out).toBe(0);
    expect(r.dockerArgs).toEqual(BASE_ARGS(r, ["--name", "Kundeoppfølging AS", "--slug", "kundeoppfolging", "--confirm", "tenant-kundeoppfolging"]));
    const noSlug = run(["Kundeoppfølging AS", "--confirm", "tenant-kundeoppfolging-as"]);
    expect(noSlug.dockerArgs).toEqual(BASE_ARGS(noSlug, ["--name", "Kundeoppfølging AS", "--confirm", "tenant-kundeoppfolging-as"]));
  });

  it("navn med skall-tegn tolkes aldri av skallet: kommer som ÉN nøyaktig argumentstreng", () => {
    for (const name of ["A; rm -rf /", "Navn $(touch /tmp/x) AS", "Navn `id` AS", "Navn && echo hei", "Ola's  Firma"]) {
      const r = run([name]);
      expect(r.status, name).toBe(0);
      expect(r.dockerArgs?.at(-1), name).toBe(name);
      expect(r.dockerArgs?.at(-2)).toBe("--name");
    }
  });

  it("ugyldige argumenter avvises FØR docker kjøres (exit 2)", () => {
    const cases = [
      [],
      ["x"],
      ["a".repeat(81)],
      ["Navn\ttab"],
      ["<b>Navn</b>"],
      ["Gyldig Navn", "UPPER"],
      ["Gyldig Navn", "-bindestrek"],
      ["Gyldig Navn", "a"],
      ["Gyldig Navn", "ok-slug", "--confirm"],
      ["Gyldig Navn", "ok-slug", "--confirm", "ikke-tenant-prefiks"],
      ["Gyldig Navn", "ok-slug", "--confirm", "tenant-ok; rm"],
      ["Gyldig Navn", "ok-slug", "--bekreft", "tenant-ok-slug"],
      ["Gyldig Navn", "ok-slug", "--confirm", "tenant-ok-slug", "ekstra"]
    ];
    for (const args of cases) {
      const r = run(args);
      expect(r.status, JSON.stringify(args)).toBe(2);
      expect(r.dockerArgs, JSON.stringify(args)).toBeNull();
    }
  });

  it("feil fra docker/compose gir samme avslutningskode videre (ingen stille suksess)", () => {
    const r = run(["Kundeoppfølging AS"], { env: { FAKE_DOCKER_EXIT: "3" } });
    expect(r.status).toBe(3);
  });

  it("ingen hemmeligheter fra env-filen følger med argumenter eller utdata, og skriptet leser ikke env-filens innhold (statisk vakt)", () => {
    const r = run(["Kundeoppfølging AS", "kundeoppfolging", "--confirm", "tenant-kundeoppfolging"]);
    expect(r.dockerArgs?.join("\n")).not.toContain(SENTINEL);
    expect(r.out).not.toContain(SENTINEL);
    const code = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/PASSWORD|SECRET|TOKEN/);
    expect(code).not.toMatch(/grep .*"\$ENV_FILE"/);
    expect(code).not.toMatch(/\btee\b|>>/);
  });
});

describe("ops/nas/enroll-device.sh: valgfri tenant-parameter (WP-D2)", () => {
  const ENROLL = join(ROOT, "ops/nas/enroll-device.sh");
  const BASE = "https://dxp4800plus-ring.tail3935f7.ts.net";
  function runEnroll(args) {
    const s = setup();
    const clean = { ...process.env };
    delete clean.JARVIS_PUBLIC_VOICE_BASE_URL;
    const res = spawnSync("bash", [ENROLL, ...args], { env: { ...clean, PATH: `${s.dir}:${process.env.PATH}`, JARVIS_ENV_FILE: s.envFile }, encoding: "utf8", timeout: 30_000 });
    return { ...res, dockerArgs: existsSync(s.log) ? readFileSync(s.log, "utf8").split("\0").slice(0, -1) : null };
  }

  it("med tenant-id sendes --tenant til CLI-en; uten den er kommandolinjen UENDRET (ingen ekstra argumenter)", () => {
    const withTenant = runEnroll([BASE, "dashboard", "tenant-kundeoppfolging"]);
    expect(withTenant.status).toBe(0);
    expect(withTenant.dockerArgs?.slice(-4)).toEqual(["--path", "dashboard", "--tenant", "tenant-kundeoppfolging"]);
    const without = runEnroll([BASE, "dashboard"]);
    expect(without.dockerArgs?.slice(-2)).toEqual(["--path", "dashboard"]);
    expect(without.dockerArgs).not.toContain("--tenant");
  });

  it("ugyldig tenant-id avvises FØR docker (exit 2)", () => {
    for (const bad of ["UPPER", "a", "../x", "x;y", "tenant med mellomrom", "a".repeat(65)]) {
      const r = runEnroll([BASE, "dashboard", bad]);
      expect(r.status, bad).toBe(2);
      expect(r.dockerArgs, bad).toBeNull();
    }
  });
});
