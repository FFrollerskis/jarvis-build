import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { MemoryTraceSink, ModelGateway, type SmokeEvidence } from "@jarvis/model-gateway";
import type { ModelProviderAdapter } from "@jarvis/provider-adapters";
import { createAiMeshReportProvider } from "../src/ai-mesh-source.ts";

/**
 * WP-D4 (JARVIS-033/036/078): HELE akseptanseløpet mot ekte Postgres - eierens `mesh-live-smoke.ts --db` kjørt SOM PROSESS (ekte fetch, ekte adaptere, ekte ModelGateway, fake leverandør-servere), og deretter
 * `executive.get_ai_mesh_status`-kilden lest mot de samme radene. Beviser at «≥3 live providers med fallback og kost-synlighet» faktisk blir synlig i statusrapporten rett etter røyktesten:
 * tre leverandører med egne kostrader (`cost_events`, riktig tenant), fallback-raden med `fallback = true`, og akseptansen MET. Verifiserer IKKE ekte Kimi/Hermes/Gemma (det er hele poenget med at eieren kjører skriptet).
 */
const SCRIPT = fileURLToPath(new URL("../../../modules/model-gateway/scripts/mesh-live-smoke.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OWNER_TENANT = "tenant-owner";
const OTHER_TENANT = "tenant-annen";
// Fiktive, lavt-entropi nøkler: skal ALDRI dukke opp i evidens eller utskrift.
const KIMI_KEY = "ikke-en-ekte-kimi-nokkel-db";
const HERMES_KEY = "ikke-en-ekte-hermes-nokkel-db";

const servers: Server[] = [];
async function openAiServer(style: "native" | "hermes" = "native"): Promise<string> {
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: style === "hermes" ? "OK" : "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2 } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let dbPort = 0;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-smoke-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  dbPort = leased.port;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  // Samme mønster som produksjon: en innloggingsrolle som arver `jarvis_app` (RLS-bundet), aldri superbruker.
  await admin.query("CREATE ROLE jarvis_smoke LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_smoke;");
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${OWNER_TENANT}', 'Eier', 'person'), ('${OTHER_TENANT}', 'Annen', 'person')`);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_smoke", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); })));
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

interface Run { code: number | null; stdout: string; stderr: string; evidencePath: string }
async function runSmoke(args: string[], env: Record<string, string>): Promise<Run> {
  const dir = await mkdtemp(join(tmpdir(), "mesh-smoke-db-"));
  const evidencePath = join(dir, "evidens.json");
  const childEnv: Record<string, string> = {
    PATH: process.env["PATH"] ?? "", HOME: dir,
    JARVIS_DB_HOST: "127.0.0.1", JARVIS_DB_PORT: String(dbPort), JARVIS_DB_NAME: "jarvis_test", JARVIS_DB_USER: "jarvis_smoke", JARVIS_DB_PASSWORD: "pw2",
    ...env
  };
  return await new Promise<Run>((resolve) => {
    const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", SCRIPT, ...args, "--out", evidencePath], { cwd: ROOT, env: childEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("close", (code) => resolve({ code, stdout, stderr, evidencePath }));
  });
}
const evidenceOf = async (run: Run): Promise<SmokeEvidence> => JSON.parse(await readFile(run.evidencePath, "utf8")) as SmokeEvidence;

interface Row { provider: string; success: boolean; fallback: boolean; task_id: string; tenant_id: string; kind: string; amount_ore: number; input_tokens: number | null; latency_ms: number | null }
const rowsFor = async (tenant: string, taskLike: string): Promise<Row[]> =>
  (await admin.query("SELECT provider, success, fallback, task_id, tenant_id, kind, amount_ore, input_tokens, latency_ms FROM cost_events WHERE tenant_id = $1 AND task_id LIKE $2 ORDER BY cost_id", [tenant, taskLike])).rows as Row[];

describe("mesh-live-smoke.ts --db: røyktesten skriver bevisene dit executive.get_ai_mesh_status leser dem", () => {
  let run: Run;
  let evidence: SmokeEvidence;
  let runId = "";

  beforeAll(async () => {
    const [local, kimi, hermes] = await Promise.all([openAiServer(), openAiServer(), openAiServer("hermes")]);
    run = await runSmoke(["--providers", "gemma_local,kimi,hermes", "--db"], {
      JARVIS_TENANT_ID: OWNER_TENANT, JARVIS_GEMMA_LOCAL_URL: local, JARVIS_KIMI_URL: kimi, KIMI_API_KEY: KIMI_KEY, JARVIS_HERMES_URL: hermes, HERMES_API_KEY: HERMES_KEY
    });
    evidence = await evidenceOf(run);
    runId = /task_id (smoke-\d+)-probe/.exec(run.stdout)?.[1] ?? "";
  }, 120_000);

  it("PASS med eierens tenant fra JARVIS_TENANT_ID, fase 1 gjennom gatewayen, og fallback-raden lest tilbake med fallback = true", () => {
    expect(run.stderr).not.toContain("mesh-live-smoke avbrutt");
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(evidence).toMatchObject({ verdict: "PASS", mode: "db", probe_route: "gateway_db", reasons: [], live_providers: ["gemma_local", "kimi", "hermes"] });
    expect(evidence.options.tenant).toBe(OWNER_TENANT);
    // Ærlig om hva som faktisk ligger i cost_events: tre probe-rader + minst reserven og den sperrede.
    expect(evidence.cost_rows?.expected_min).toBe(3);
    expect(evidence.cost_rows?.written).toBeGreaterThanOrEqual(5);
    expect(evidence.fallback).toMatchObject({ status: "PROVEN", blocked: "gemma_local", served_by: "kimi", cost_row_fallback: true });
    expect(run.stdout).toContain("kostraden har fallback=true");
    expect(runId).toMatch(/^smoke-\d{14}$/);
  });

  it("hver live leverandør har sin egen kostrad (riktig tenant, modellrad, suksess, ikke fallback) fra fase 1", async () => {
    const probes = await rowsFor(OWNER_TENANT, `${runId}-probe`);
    expect(probes.map((r) => r.provider).sort()).toEqual(["gemma_local", "hermes", "kimi"]);
    for (const r of probes) {
      expect(r).toMatchObject({ tenant_id: OWNER_TENANT, success: true, fallback: false });
      expect(r.kind).toMatch(/^model:/);
      expect(r.input_tokens).toBeGreaterThan(0);
      expect(r.latency_ms).not.toBeNull();
    }
  });

  it("fallback-fasen: den sperrede har feilede rader, reserven har en vellykket rad med fallback = true - alt under egen task_id", async () => {
    const rows = await rowsFor(OWNER_TENANT, `${runId}-fallback`);
    expect(rows.some((r) => r.provider === "gemma_local" && !r.success)).toBe(true);
    const served = rows.filter((r) => r.success);
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ provider: "kimi", fallback: true });
  });

  it("ingenting ble skrevet for en annen tenant, og ingen nøkler havnet i evidens, utskrift eller kostrader", async () => {
    expect((await admin.query("SELECT count(*)::int AS n FROM cost_events WHERE tenant_id = $1", [OTHER_TENANT])).rows[0].n).toBe(0);
    const everything = (await readFile(run.evidencePath, "utf8")) + run.stdout + run.stderr + JSON.stringify((await admin.query("SELECT * FROM cost_events")).rows);
    for (const secret of [KIMI_KEY, HERMES_KEY]) expect(everything).not.toContain(secret);
  });

  it("AKSEPTANSEN SER BEVISET: get_ai_mesh_status-kilden gir ≥3 live leverandører, kost per leverandør og fallback observert → MET (etter røyktesten, i en ny prosess uten egen trafikk)", async () => {
    const adapters: ModelProviderAdapter[] = ["gemma_local", "kimi", "hermes"].map((name) => ({ name, model: `${name}-m`, available: () => true, complete: async () => { throw new Error("rapporten gjør aldri et modellkall"); } }));
    const gateway = new ModelGateway({ pool: app, trace: new MemoryTraceSink(), providers: adapters });
    const report = await createAiMeshReportProvider({ pool: app, tenantId: OWNER_TENANT, details: () => gateway.meshDetails(), mesh: () => gateway.meshStatus() })();
    // Prosessen som leser har ingen egen trafikk: bevisene kommer utelukkende fra cost_events.
    expect(report.providers.filter((p) => p.configured).every((p) => p.state === "CONFIGURED")).toBe(true);
    expect(report.acceptance).toMatchObject({ verdict: "MET", live_providers: 3, fallback_verified_in_process: false, missing: [] });
    expect(report.acceptance.live.sort()).toEqual(["gemma_local", "hermes", "kimi"]);
    expect(report.acceptance.fallback_ok_calls_7d).toBe(1);
    for (const name of ["gemma_local", "kimi", "hermes"]) {
      const usage = report.providers.find((p) => p.provider === name)?.usage_7d;
      expect(usage, name).toMatchObject({ ok_calls: expect.any(Number), tokens_in: expect.any(Number) });
      expect(usage?.ok_calls, name).toBeGreaterThanOrEqual(1);
      expect(usage?.cost_ore, name).toBeGreaterThanOrEqual(0);
      expect(usage?.p50_latency_ms, name).not.toBeNull();
    }
    expect(report.providers.find((p) => p.provider === "gemma_local")?.usage_7d?.failed_calls).toBeGreaterThanOrEqual(1); // den sperrede
    expect(report.summary_no).toContain("OPPFYLT");
    expect(report.acts).toBe(false);
  });

  it("en annen tenant ser ingenting av beviset (RLS + tenant-filter): akseptansen er IKKE oppfylt der", async () => {
    const adapters: ModelProviderAdapter[] = ["gemma_local", "kimi", "hermes"].map((name) => ({ name, model: `${name}-m`, available: () => true, complete: async () => { throw new Error("nei"); } }));
    const gateway = new ModelGateway({ pool: app, trace: new MemoryTraceSink(), providers: adapters });
    const report = await createAiMeshReportProvider({ pool: app, tenantId: OTHER_TENANT, details: () => gateway.meshDetails(), mesh: () => gateway.meshStatus() })();
    expect(report.acceptance).toMatchObject({ verdict: "NOT_MET", live_providers: 0, fallback_ok_calls_7d: 0 });
  });
});

describe("mesh-live-smoke.ts --db: feil eier-tenant gir aldri en falsk PASS", () => {
  it("en tenant som ikke finnes (fremmednøkkel) → ikke PASS, ingen rader, og feilen er forklart uten hemmeligheter", async () => {
    const [local, kimi, hermes] = await Promise.all([openAiServer(), openAiServer(), openAiServer("hermes")]);
    const run = await runSmoke(["--providers", "gemma_local,kimi,hermes", "--db"], {
      JARVIS_TENANT_ID: "tenant-finnes-ikke", JARVIS_GEMMA_LOCAL_URL: local, JARVIS_KIMI_URL: kimi, KIMI_API_KEY: KIMI_KEY, JARVIS_HERMES_URL: hermes, HERMES_API_KEY: HERMES_KEY
    });
    expect(run.code, run.stdout + run.stderr).not.toBe(0);
    expect(run.stdout).not.toContain("AI Mesh røyktest (med database): PASS");
    const evidence = await evidenceOf(run);
    expect(evidence.cost_rows).toEqual({ written: 0, expected_min: 3 });
    expect(evidence.notes.join(" ")).toContain("Bare 0 av minst 3 forventede kostrader");
    expect(run.stdout).toContain("merk: Bare 0 av minst 3 forventede kostrader");
    expect(run.stdout).toContain("Kostrader i cost_events for tenant-finnes-ikke: 0 rader");
    expect((await admin.query("SELECT count(*)::int AS n FROM cost_events WHERE tenant_id = 'tenant-finnes-ikke'")).rows[0].n).toBe(0);
    expect(run.stdout + run.stderr).not.toContain(KIMI_KEY);
    expect(run.stdout + run.stderr).not.toContain(HERMES_KEY);
  }, 120_000);
});
