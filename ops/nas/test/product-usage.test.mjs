import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WP-D2 (UA-3 «churn/product usage»): `ops/nas/product-usage.sh`. Testes uten ekte docker: en falsk `docker` på PATH logger argumentene den fikk (og stdin den fikk), så
 * kommandolinjen (kjører i `migrate`-tjenesten, ALDRI api/worker), validering FØR docker, at verdier med skall-tegn aldri tolkes av skallet og at filen kommer på stdin
 * er bevist. Det beviser IKKE at importen lykkes mot den ekte NAS-en - det gjør CLI-testene mot ekte Postgres (apps/api) og kommandoen under «For å verifisere» i runbooken.
 */
const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(ROOT, "ops/nas/product-usage.sh");
const DEFAULT_COMPOSE = join(ROOT, "infra/local/docker-compose.yml");
const SENTINEL = ["ikke", "i", "args", "eller", "utdata"].join("_");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "usage-script-test-"));
  const log = join(dir, "docker-args.log");
  const stdinLog = join(dir, "docker-stdin.log");
  const envFile = join(dir, "env");
  writeFileSync(envFile, `JARVIS_DB_ADMIN_PASSWORD=${SENTINEL}\nJARVIS_PRODUCT_USAGE_WEBHOOK_SECRET=${SENTINEL}\n`);
  writeFileSync(join(dir, "docker"), `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "${log}"\ncat > "${stdinLog}"\nexit "\${FAKE_DOCKER_EXIT:-0}"\n`);
  chmodSync(join(dir, "docker"), 0o755);
  return { dir, log, stdinLog, envFile };
}

function run(args, { input = "", env = {} } = {}) {
  const s = setup();
  const res = spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, PATH: `${s.dir}:${process.env.PATH}`, JARVIS_ENV_FILE: s.envFile, ...env },
    input,
    encoding: "utf8",
    timeout: 30_000
  });
  const dockerArgs = existsSync(s.log) ? readFileSync(s.log, "utf8").split("\0").slice(0, -1) : null;
  const dockerStdin = existsSync(s.stdinLog) ? readFileSync(s.stdinLog, "utf8") : null;
  return { ...res, out: res.stdout + res.stderr, dockerArgs, dockerStdin, envFile: s.envFile };
}

const BASE = (r, cli) => [
  "compose", "--env-file", r.envFile, "-f", DEFAULT_COMPOSE,
  "run", "--rm", "--no-deps", "-T",
  "migrate", "node", "--experimental-transform-types", "apps/api/src/product-usage-main.ts", ...cli
];
const T = "tenant-kundeoppfolging";

describe("ops/nas/product-usage.sh", () => {
  it("er gyldig bash og kjørbar", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it("import: kjører CLI-en i migrate-tjenesten (aldri api/worker), uten --confirm = dry-run, og filen kommer uendret på stdin", () => {
    const csv = "event_id,account_ref,feature,occurred_at\nevt-000001,acct-0000001,chat.send,2026-10-09T10:00:00Z\n";
    const r = run(["import", "--tenant", T, "--format", "csv", "--label", "2026-10"], { input: csv });
    expect(r.status, r.out).toBe(0);
    expect(r.dockerArgs).toEqual(BASE(r, ["import", "--tenant", T, "--format", "csv", "--label", "2026-10"]));
    expect(r.dockerArgs).not.toContain("api");
    expect(r.dockerArgs).not.toContain("worker");
    expect(r.dockerArgs).not.toContain("--confirm");
    expect(r.dockerStdin).toBe(csv);
  });

  it("--confirm og øvrige flagg sendes videre som egne argumenter i oppgitt rekkefølge", () => {
    const r = run(["import", "--tenant", T, "--format", "jsonl", "--label", "backfill_1", "--confirm"], { input: "{}\n" });
    expect(r.dockerArgs).toEqual(BASE(r, ["import", "--tenant", T, "--format", "jsonl", "--label", "backfill_1", "--confirm"]));
    const link = run(["link", "--tenant", T, "--account", "acct-abc123", "--company", "biz-co-1234", "--confirm"]);
    expect(link.dockerArgs).toEqual(BASE(link, ["link", "--tenant", T, "--account", "acct-abc123", "--company", "biz-co-1234", "--confirm"]));
    const accounts = run(["accounts", "--tenant", T, "--unlinked"]);
    expect(accounts.dockerArgs).toEqual(BASE(accounts, ["accounts", "--tenant", T, "--unlinked"]));
    const forget = run(["forget-user", "--tenant", T, "--user", "usr_abcdef12"]);
    expect(forget.dockerArgs).toEqual(BASE(forget, ["forget-user", "--tenant", T, "--user", "usr_abcdef12"]));
    const unlink = run(["unlink", "--tenant", T, "--account", "acct-abc123", "--confirm"]);
    expect(unlink.dockerArgs).toEqual(BASE(unlink, ["unlink", "--tenant", T, "--account", "acct-abc123", "--confirm"]));
  });

  it("uten ekstra flagg gir kommandoen ingen tomme argumenter (accounts uten filter)", () => {
    const r = run(["accounts", "--tenant", T]);
    expect(r.status, r.out).toBe(0);
    expect(r.dockerArgs).toEqual(BASE(r, ["accounts", "--tenant", T]));
    expect(r.dockerArgs).not.toContain("");
  });

  it("ugyldige argumenter avvises FØR docker kjøres (exit 2) - skall-tegn, feil format, doble flagg, ukjente flagg og kommandoer", () => {
    const cases = [
      [],
      ["rm"],
      ["import"],
      ["import", "--tenant"],
      ["import", "--tenant", "UPPER", "--format", "csv", "--label", "x"],
      ["import", "--tenant", "a", "--format", "csv", "--label", "x"],
      ["import", "--tenant", T, "--format", "xlsx", "--label", "x"],
      ["import", "--tenant", T, "--format", "csv", "--label", "Upper"],
      ["import", "--tenant", T, "--format", "csv", "--label", "-lead"],
      ["import", "--tenant", T, "--format", "csv", "--label", "x;touch /tmp/x"],
      ["import", "--tenant", "tenant-x; rm -rf /", "--format", "csv", "--label", "x"],
      ["import", "--tenant", T, "--tenant", T, "--format", "csv", "--label", "x"],
      ["import", "--tenant", T, "--format", "csv", "--label", "x", "--confirm", "--confirm"],
      ["import", "--tenant", T, "--format", "csv", "--label", "x", "--yes"],
      ["import", "--tenant", T, "--format", "csv", "--label", "x", "ekstra"],
      ["link", "--tenant", T, "--account", "ola@example.com", "--company", "biz-co-1"],
      ["link", "--tenant", T, "--account", "kort", "--company", "biz-co-1"],
      ["link", "--tenant", T, "--account", "acct-abc123", "--company", "biz co"],
      ["link", "--tenant", T, "--account", "acct-abc123", "--company", "$(id)"],
      ["forget-user", "--tenant", T, "--user", "ola nordmann"],
      ["accounts", "--tenant", T, "--linked", "--linked"]
    ];
    for (const args of cases) {
      const r = run(args);
      expect(r.status, JSON.stringify(args)).toBe(2);
      expect(r.dockerArgs, JSON.stringify(args)).toBeNull();
    }
  });

  it("verdier med spesialtegn som passerer mønsteret tolkes aldri av skallet (hver kommer som ÉN streng)", () => {
    const r = run(["link", "--tenant", T, "--account", "A.b_c:d-12345", "--company", "x:y.z-1", "--confirm"]);
    expect(r.status, r.out).toBe(0);
    expect(r.dockerArgs).toEqual(BASE(r, ["link", "--tenant", T, "--account", "A.b_c:d-12345", "--company", "x:y.z-1", "--confirm"]));
  });

  it("feil fra docker/compose gir samme avslutningskode videre (ingen stille suksess)", () => {
    const r = run(["accounts", "--tenant", T], { env: { FAKE_DOCKER_EXIT: "3" } });
    expect(r.status).toBe(3);
  });

  it("ingen hemmeligheter fra env-filen følger med argumenter eller utdata, og skriptet leser ikke env-filens innhold (statisk vakt)", () => {
    const r = run(["import", "--tenant", T, "--format", "csv", "--label", "x", "--confirm"], { input: "x\n" });
    expect(r.dockerArgs?.join("\n")).not.toContain(SENTINEL);
    expect(r.out).not.toContain(SENTINEL);
    const code = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/PASSWORD|SECRET|TOKEN/);
    expect(code).not.toMatch(/grep .*"\$ENV_FILE"/);
    expect(code).not.toMatch(/\btee\b|>>/);
  });
});
