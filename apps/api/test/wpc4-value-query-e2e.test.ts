import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ChannelSessionAuthority, DeviceEnrollmentService, DeviceService, IdentityService,
  SessionGrantService, SessionService, createPool, runMigrations
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { createApiServer } from "../src/server.ts";

/**
 * WP-C4: ekte HTTP mot en ekte `createApiServer()`, ekte Postgres og ekte grant-autoritet (samme `/session/authorize`-vei som `/executive/query`).
 * Beviser `/value/query`s egne ansvar: gyldig grant gir rapporten (gateway fikk den LØSTE identiteten, aldri body), ugyldig/manglende grant avvises FØR gateway kalles, ruten har sitt eget lese-allowlist (ingen annen handling
 * nås herfra, heller ikke `get_slo_report`), og `parameters` fra kroppen (f.eks. en annen tenant) videresendes ALDRI. Tool Gateway stubbes (pipelinen er dekket i `modules/executive`).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let baseUrl: string;
let server: ReturnType<typeof createApiServer>;

const TENANT_A = "tenant-wpc4q-a";
const OWNER = "person-wpc4q-owner";
const DEVICE = "dev-wpc4q-web";
const keys = generateKeyPairSync("ed25519");
const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

interface ExecuteCall { identity: { tenant_id: string; person_id: string; memory_space_id: string }; tool_id: string; action: string; parameters: Record<string, unknown> }
let executeCalls: ExecuteCall[] = [];
const REPORT = { as_of: "2026-10-09T10:00:00.000Z", summary_no: "Verdi og bruk\nV1 Daglig brief: 3 sendt siste 7 dager", loops: [] };
let nextResult: unknown = { ok: true, data: REPORT, output_trust: "internal", deduplicated: false };

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpc4q-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir, user: "postgres", password: "test-superuser-pw", port, persistent: false }),
    { identity: { user: "postgres", password: "test-superuser-pw", database: "postgres" } }
  );
  epg = leased.postgres;
  PORT = leased.port;
  stopEmbeddedPostgres = leased.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "test-superuser-pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpc4q LOGIN PASSWORD 'test-app-pw'");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpc4q");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'WPC4Q A', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${TENANT_A}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-wpc4q-a', '${TENANT_A}', 'personal');
  `);
  await adminPool.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1,$2,$3,$4,$5)", [DEVICE, TENANT_A, OWNER, "web", pem]);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_wpc4q", password: "test-app-pw" });
  const identityService = new IdentityService(appPool);
  const sessionService = new SessionService(appPool);
  const deviceService = new DeviceService(appPool);
  const grantService = new SessionGrantService(appPool);
  const stubGateway = { execute: async (request: ExecuteCall) => { executeCalls.push(request); return nextResult; } } as unknown as ToolGateway;

  server = createApiServer({
    identity: identityService, sessions: sessionService, devices: deviceService, grants: grantService,
    enrollment: new DeviceEnrollmentService({ pool: appPool, devices: deviceService, grants: grantService }),
    channelAuthority: new ChannelSessionAuthority({ pool: appPool, devices: deviceService, sessions: sessionService, identity: identityService, grants: grantService }),
    policy: {} as never, worker: {} as never, conversation: {} as never,
    executive: { gateway: stubGateway }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

beforeEach(() => {
  executeCalls = [];
  nextResult = { ok: true, data: REPORT, output_trust: "internal", deduplicated: false };
});

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function validGrant(): Promise<string> {
  const challengeRes = await post("/devices/challenge", { device_id: DEVICE });
  const challenge = challengeRes.body["challenge"] as string;
  const signature = sign(null, Buffer.from(challenge, "utf8"), keys.privateKey).toString("base64");
  const authRes = await post("/session/authorize", {
    channel: "web", person_id: OWNER, tenant_id: TENANT_A, device_id: DEVICE, memory_space: "personal", device_proof: { challenge, signature }
  });
  expect(authRes.status, JSON.stringify(authRes.body)).toBe(200);
  return (authRes.body["grant"] as Record<string, unknown>)["grant_token"] as string;
}

describe("A: /value/query med gyldig grant gir rapporten via Tool Gateway", () => {
  it("get_value_report: 200, data videreformidlet uendret, gateway fikk den LØSTE identiteten og tomme parametre", async () => {
    const grant = await validGrant();
    const res = await post("/value/query", { grant_token: grant, action: "get_value_report" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true, data: REPORT });
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]).toMatchObject({ tool_id: "executive", action: "get_value_report", parameters: {} });
    expect(executeCalls[0]?.identity.tenant_id).toBe(TENANT_A);
    expect(executeCalls[0]?.identity.person_id).toBe(OWNER);
  });

  it("handlingen kan utelates (standard er get_value_report)", async () => {
    const grant = await validGrant();
    const res = await post("/value/query", { grant_token: grant });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(executeCalls.map((c) => c.action)).toEqual(["get_value_report"]);
  });

  it("parameters i kroppen (f.eks. en annen tenant eller et rom) videresendes ALDRI - kallet har alltid tomme parametre", async () => {
    const grant = await validGrant();
    const res = await post("/value/query", { grant_token: grant, action: "get_value_report", parameters: { tenant_id: "tenant-annen", memory_space: "health", window: 9999 } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.parameters).toEqual({});
    expect(executeCalls[0]?.identity.tenant_id).toBe(TENANT_A);
  });

  it("gateway-avslag (policy, kill switch ...) videreformidles som 403 tool_denied, ikke svelget", async () => {
    nextResult = { ok: false, reason: "kill_switch_active" };
    const grant = await validGrant();
    const res = await post("/value/query", { grant_token: grant, action: "get_value_report" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "tool_denied", reason: "kill_switch_active" });
  });
});

describe("B: avvisning FØR gateway.execute() kalles", () => {
  it("uten grant_token: 401 grant_required", async () => {
    const res = await post("/value/query", { action: "get_value_report" });
    expect(res.status).toBe(401);
    expect(res.body["error"]).toBe("grant_required");
    expect(executeCalls).toHaveLength(0);
  });

  it("oppdiktet grant_token: 403 identity_denied", async () => {
    const res = await post("/value/query", { grant_token: "grant-som-ikke-finnes", action: "get_value_report" });
    expect(res.status).toBe(403);
    expect(res.body["error"]).toBe("identity_denied");
    expect(executeCalls).toHaveLength(0);
  });

  it("selvutnevnt identitet i kroppen (tenant_id/person_id/memory_space) avvises fail-closed", async () => {
    const grant = await validGrant();
    for (const field of ["tenant_id", "person_id", "memory_space_id"]) {
      const res = await post("/value/query", { grant_token: grant, action: "get_value_report", [field]: "x" });
      expect(res.status, field).toBe(400);
      expect(res.body["error"], field).toBe("identity_field_forbidden");
    }
    const unknown = await post("/value/query", { grant_token: grant, action: "get_value_report", extra: 1 });
    expect(unknown.status).toBe(400);
    expect(unknown.body["reason"]).toBe("unknown_field");
    expect(executeCalls).toHaveLength(0);
  });

  it("ikke-objekt som kropp avvises", async () => {
    const res = await post("/value/query", [1, 2, 3]);
    expect(res.status).toBe(400);
    expect(executeCalls).toHaveLength(0);
  });
});

describe("C: ruten har sitt EGET lese-allowlist - ingen annen handling er nåbar herfra", () => {
  it.each([["get_slo_report"], ["get_self_diagnosis"], ["get_attention_queue"], ["activate_kill_switch"], ["pause_domain"], ["does_not_exist"], [""], ["GET_VALUE_REPORT"], ["get_value_report "]])(
    "action=%j: 400 action_not_allowed, gateway.execute() ALDRI kalt",
    async (action) => {
      const grant = await validGrant();
      const res = await post("/value/query", { grant_token: grant, action });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "malformed_request", reason: "action_not_allowed" });
      expect(executeCalls).toHaveLength(0);
    }
  );

  it("ikke-streng handling (tall/objekt) faller tilbake til standarden og kan aldri velge en annen handling", async () => {
    const grant = await validGrant();
    const res = await post("/value/query", { grant_token: grant, action: { evil: true } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(executeCalls.map((c) => c.action)).toEqual(["get_value_report"]);
  });

  it("andre veier: GET mot ruten er ikke en lese-rute, og det finnes ingen skrive-variant", async () => {
    const get = await fetch(`${baseUrl}/value/query`, { method: "GET" });
    expect([404, 405]).toContain(get.status);
    const mutate = await post("/value/mutate", { grant_token: await validGrant(), action: "get_value_report" });
    expect(mutate.status).toBe(404);
    expect(executeCalls).toHaveLength(0);
  });
});
