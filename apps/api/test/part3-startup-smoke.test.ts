import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * Røyktest for prosessinngangene (api + worker). Bakgrunn: del 3 la en manifest-vakt i oppstarten; workeren krasjet i drift
 * (`ToolManifestViolationError`) fordi INGEN test startet `worker-main.ts`. Denne starter de ekte inngangene som egne prosesser
 * (samme `node --experimental-transform-types`-kommando som i docker-compose) mot ekte Postgres med en NOSUPERUSER-runtimerolle,
 * og krever at de kommer opp uten å krasje. Fanger enhver fremtidig oppstartsvakt (manifest, rolle, pris, wiring) før NAS.
 */
const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(API_DIR, "..", "..");

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let port = 0;
const children: ChildProcess[] = [];

function envFor(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? tmpdir(),
    JARVIS_ENV: "dev",
    JARVIS_DB_HOST: "127.0.0.1",
    JARVIS_DB_PORT: String(port),
    JARVIS_DB_NAME: "jarvis_smoke",
    JARVIS_DB_USER: "jarvis_smoke_rt",
    JARVIS_DB_PASSWORD: "smoke-runtime-pw-123456",
    JARVIS_DB_ADMIN_USER: "postgres",
    JARVIS_TENANT_ID: "tenant-smoke",
    JARVIS_OWNER_PERSON_ID: "person-smoke",
    JARVIS_OWNER_NAME: "Smoke",
    ...extra
  };
}

/** Starter prosessen og venter på en loggfrase, eller feiler med hele loggen hvis den dør/timer ut. */
function startAndWait(file: string, env: NodeJS.ProcessEnv, readyPhrase: string, cwd: string, timeoutMs = 90_000): Promise<{ child: ChildProcess; log: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", join(API_DIR, "src", file)], { env: env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let log = "";
    const onData = (buf: Buffer): void => {
      log += buf.toString();
      if (log.includes(readyPhrase)) {
        clearTimeout(timer);
        resolvePromise({ child, log });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${file} avsluttet (exit ${code}) før «${readyPhrase}»:\n${log.slice(-2500)}`));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${file}: timeout uten «${readyPhrase}»:\n${log.slice(-2500)}`));
    }, timeoutMs);
  });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    child.removeAllListeners("exit");
    child.once("exit", () => done());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-smoke-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  port = leased.port;
  await leased.postgres.createDatabase("jarvis_smoke");
  admin = new pg.Pool({ host: "127.0.0.1", port, database: "jarvis_smoke", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_smoke_rt LOGIN PASSWORD 'smoke-runtime-pw-123456' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_smoke_rt");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-smoke','Smoke','person') ON CONFLICT DO NOTHING;
    INSERT INTO people (person_id, display_name) VALUES ('person-smoke','Smoke') ON CONFLICT DO NOTHING;
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-smoke','tenant-smoke') ON CONFLICT DO NOTHING;
  `);
}, 240_000);

afterAll(async () => {
  for (const c of children) await killAndWait(c);
  await admin?.end();
  await stop?.();
}, 120_000);

describe("oppstartsrøyktest: prosessinngangene kommer opp mot ekte Postgres", () => {
  it("worker-main.ts starter (manifest-vakt, rolle-vakt, prisvakt, wiring) og logger «jarvis-worker started»", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jarvis-smoke-worker-"));
    const { child, log } = await startAndWait("worker-main.ts", envFor({}), "jarvis-worker started", cwd);
    expect(log).not.toContain("ToolManifestViolationError");
    expect(log).not.toContain("startup_failed");
    expect(child.exitCode).toBeNull(); // lever fortsatt
    await killAndWait(child);
  }, 120_000);

  it("main.ts (api) starter og svarer 200 på /health", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jarvis-smoke-api-"));
    const apiPort = String(20_000 + Math.floor(Math.random() * 20_000));
    const { child, log } = await startAndWait("main.ts", envFor({ JARVIS_API_PORT: apiPort }), "jarvis-api listening", cwd);
    expect(log).not.toContain("ToolManifestViolationError");
    const res = await fetch(`http://127.0.0.1:${apiPort}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
    await killAndWait(child);
  }, 120_000);

  it("worker feiler lukket (exit ≠ 0) når runtime-rollen er superuser - vakten er virksom, ikke bare fraværende", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jarvis-smoke-worker-su-"));
    await expect(
      startAndWait("worker-main.ts", envFor({ JARVIS_DB_USER: "postgres", JARVIS_DB_PASSWORD: "pw", JARVIS_DB_ADMIN_USER: "annen_admin" }), "jarvis-worker started", cwd, 60_000)
    ).rejects.toThrow(/runtime_db_role_unsafe|startup_failed/);
  }, 90_000);
});
