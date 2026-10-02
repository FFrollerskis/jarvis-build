import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Remediation part 1: the runtime-baseline collector must be read-only and must never print secrets.
 * Runs the real script with fake `docker` / `ss` / `tailscale` binaries and an .env full of secret-looking values.
 */
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "collect-runtime-baseline.sh");

function fakeBin(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function run(extraEnv = {}, { openPorts = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-baseline-"));
  const log = join(dir, "docker-calls.log");
  fakeBin(
    dir,
    "docker",
    `echo "$@" >> "${log}"
case "$*" in
  *"ps -q"*) printf 'cid-api\\ncid-pg\\n' ;;
  *" ps") echo "NAME  IMAGE  STATUS"; echo "local-api-1  local-api  Up" ;;
  *"config --no-interpolate"*) echo '    ports:'; echo '      - "127.0.0.1:3010:3010"' ;;
  *"inspect --format {{.Name}} cid-api"*) echo "/local-api-1" ;;
  *"inspect --format {{.Name}} cid-pg"*) echo "/local-postgres-1" ;;
  *"inspect --format {{.Config.Image}}"*) echo "pgvector/pgvector:pg16@sha256:abc" ;;
  *"inspect --format {{.Image}}"*) echo "sha256:deadbeef" ;;
  *"image inspect"*) echo "pgvector/pgvector@sha256:abc" ;;
  *"port cid-api"*) echo "3010/tcp -> 127.0.0.1:3010" ;;
  *"port cid-pg"*) echo "5432/tcp -> ${openPorts ? "0.0.0.0" : "127.0.0.1"}:5432" ;;
  *"psql"*"schema_migrations"*) echo 62 ;;
  *"psql"*"gemma_local"*) echo "0 rows, 0 ore" ;;
  *"psql"*) echo 7 ;;
  *) echo "unexpected: $*" >&2 ;;
esac`
  );
  fakeBin(dir, "ss", `echo "Listen 0 4096 ${openPorts ? "0.0.0.0" : "127.0.0.1"}:5432 0.0.0.0:*"; echo "Listen 0 4096 127.0.0.1:3010 0.0.0.0:*"`);
  fakeBin(dir, "tailscale", `echo "https://nas.tailnet.ts.net (tailnet only)"`);
  const envFile = join(dir, ".env");
  writeFileSync(
    envFile,
    [
      "JARVIS_ENV=dev",
      "JARVIS_BUDGET_APPROVED=false",
      "JARVIS_DB_ADMIN_PASSWORD=SUPERSECRET-DB-PASSWORD-123",
      "INFISICAL_ENCRYPTION_KEY=SUPERSECRET-VAULT-KEY-456",
      "JARVIS_GITHUB_TOKEN=ghp_SUPERSECRETTOKEN789",
      "OPENAI_API_KEY=",
      "JARVIS_STRIPE_SYNC_HOUR=",
      "JARVIS_STRIPE_SYNC_HOUR=3"
    ].join("\n")
  );
  const res = spawnSync("bash", [SCRIPT], {
    env: { PATH: `${dir}:/usr/bin:/bin`, JARVIS_BASELINE_ENV_FILE: envFile, JARVIS_BASELINE_COMPOSE_FILE: join(dir, "compose.yml") , ...extraEnv },
    encoding: "utf8",
    timeout: 60_000
  });
  return { out: res.stdout, err: res.stderr, status: res.status, dockerLog: (() => { try { return spawnSync("cat", [log], { encoding: "utf8" }).stdout; } catch { return ""; } })() };
}

describe("collect-runtime-baseline.sh", () => {
  it("skriver aldri hemmeligheter - kun allow-listede ikke-hemmelige verdier og tilstedeværelse (set/empty/absent)", () => {
    const { out, status } = run();
    expect(status).toBe(0);
    for (const secret of ["SUPERSECRET-DB-PASSWORD-123", "SUPERSECRET-VAULT-KEY-456", "ghp_SUPERSECRETTOKEN789"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("JARVIS_ENV=dev");
    expect(out).toContain("JARVIS_BUDGET_APPROVED=false");
    expect(out).toContain("JARVIS_DB_ADMIN_PASSWORD: set");
    expect(out).toContain("INFISICAL_ENCRYPTION_KEY: set");
    expect(out).toContain("OPENAI_API_KEY: empty");
    expect(out).toContain("JARVIS_TELEGRAM_TOKEN: absent");
    expect(out).toContain("duplicate keys: JARVIS_STRIPE_SYNC_HOUR");
    expect(out).toContain("blank KEY= lines: 2");
  });

  it("rapporterer image-identitet, publiserte porter og databasefakta fra (fake) docker", () => {
    const { out } = run();
    expect(out).toContain("local-postgres-1 | image=pgvector/pgvector:pg16@sha256:abc | id=sha256:deadbeef");
    expect(out).toContain("local-api-1 | 3010/tcp -> 127.0.0.1:3010");
    expect(out).toContain("migrations applied:      62");
    expect(out).toContain("gemma_local cost rows:   0 rows, 0 ore");
    expect(out).toContain("https://nas.tailnet.ts.net");
    expect(out).not.toContain("FINDING");
  });

  it("flagger en port som lytter på alle grensesnitt", () => {
    const { out } = run({}, { openPorts: true });
    expect(out).toContain("FINDING: a Jarvis port listens on all interfaces");
  });

  it("er skrivebeskyttet: ingen docker-kall som endrer noe (kun ps/inspect/port/image inspect/config/exec psql)", () => {
    const { dockerLog } = run();
    const mutating = dockerLog.split("\n").filter((l) => /\b(up|down|rm|restart|stop|start|kill|run|build|pull|create|exec -T postgres (?!psql))\b/.test(l.replace(/psql.*/, "psql")));
    expect(mutating).toEqual([]);
    // alle SQL-kall er SELECT
    for (const line of dockerLog.split("\n").filter((l) => l.includes("psql"))) {
      expect(line).toMatch(/-c (SELECT|"SELECT)/);
    }
  });
});
