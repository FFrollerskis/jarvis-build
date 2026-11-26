import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeviceKind } from "@jarvis/contracts";
import {
  ChannelSessionAuthority, ContextBuilder, DeviceEnrollmentService, DeviceService, IdentityService, MessageStore, SessionGrantService, SessionService, VoiceSessionAuthority,
  createEnrollmentTicket, createPool, runMigrations, type ChannelBindingMode
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ScriptedAdapter } from "@jarvis/provider-adapters";
import { InProcessWorker, PgTaskQueue, TaskService } from "@jarvis/tasks";
import { ConversationEngine } from "../src/conversation.ts";
import { createApiServer } from "../src/server.ts";

/**
 * WP-S1 K5: `/session/authorize` ENDE-TIL-ENDE mot EKTE `createApiServer()` og EKTE Postgres, i BEGGE moduser. Angrepet fra JARVIS-111: en enhet som kan signere (Watch, talegateway, en gammel `legacy_unknown`-enhet)
 * PÅSTÅR kanalen `web`/`api`/`mobile` og får en økt som oppfyller step-up. I `observe` (standard) er det fortsatt mulig (identisk med main, og revidert som «ville nektet»); i `enforce` får enheten aldri grantet.
 * Step-up-flaten som brukes som probe er `POST /owner-controls/connector-credentials` (`set_connector_credential` krever signert enhetsøkt fra en eier-kanal; en falsk gateway svarer 200 når steget er passert).
 */
const TENANT = "tenant-s1x";
const PERSON = "person-s1x";
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

interface Harness { mode: ChannelBindingMode; baseUrl: string; server: ReturnType<typeof createApiServer>; executed: Array<{ action: string; channel: string }> }
const harness: Record<ChannelBindingMode, Harness> = {} as Record<ChannelBindingMode, Harness>;
const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
const pem = (k: { publicKey: KeyObject }): string => k.publicKey.export({ type: "spki", format: "pem" }).toString();

async function addDevice(deviceId: string, kind: DeviceKind): Promise<void> {
  const k = generateKeyPairSync("ed25519");
  keys.set(deviceId, k);
  await adminPool.query(
    "INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem, device_kind, device_kind_source) VALUES ($1, $2, $3, 'x', $4, $5, $6)",
    [deviceId, TENANT, PERSON, pem(k), kind, kind === "legacy_unknown" ? "unclassified" : "trusted_provisioning"]
  );
}

async function startHarness(mode: ChannelBindingMode): Promise<Harness> {
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: { consume: async () => true }, killSwitch: new KillSwitch() });
  const trace = new MemoryTraceSink();
  const gateway = new ModelGateway({ pool: appPool, trace, providers: [new ScriptedAdapter(() => "ok")] });
  const queue = new PgTaskQueue(appPool);
  const worker = new InProcessWorker(queue);
  const identity = new IdentityService(appPool);
  const sessions = new SessionService(appPool);
  const devices = new DeviceService(appPool);
  const grants = new SessionGrantService(appPool, { channelBindingMode: mode });
  const authorityDeps = { pool: appPool, devices, sessions, identity, grants, channelBindingMode: mode };
  const executed: Harness["executed"] = [];
  const server = createApiServer({
    // HTTP-grensene er ikke emnet her: mange autorisasjoner mot samme server skal ikke treffe `rate_limited`.
    rateLimits: { perIpPerMinute: 1_000_000, authPerIpPerMinute: 1_000_000, perDevicePerMinute: 1_000_000 },
    identity, sessions, devices, grants,
    enrollment: new DeviceEnrollmentService({ pool: appPool, devices, grants, channelBindingMode: mode }),
    channelAuthority: new ChannelSessionAuthority(authorityDeps),
    voiceAuthority: new VoiceSessionAuthority(authorityDeps),
    executive: { gateway: { execute: async (req: { identity: { channel: string }; action: string }) => { executed.push({ action: req.action, channel: req.identity.channel }); return { ok: true, data: {} }; } } as never },
    policy, worker,
    conversation: new ConversationEngine({ messages: new MessageStore(appPool), context: new ContextBuilder(appPool), gateway, tasks: new TaskService(appPool, queue, policy), worker, trace })
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { mode, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, executed };
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-s1x-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_s1x LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_s1x");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'S1X', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'S1X Person');
    INSERT INTO person_tenants (person_id, tenant_id, role) VALUES ('${PERSON}', '${TENANT}', 'owner');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-s1x', '${TENANT}', 'personal');`);
  for (const [id, kind] of [["x-web", "web_browser"], ["x-iphone", "iphone"], ["x-watch", "watch"], ["x-legacy", "legacy_unknown"], ["x-api", "api_client"], ["x-voice", "voice_gateway"], ["x-mac", "mac"]] as const) await addDevice(id, kind);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_s1x", password: "pw2" });
  harness.observe = await startHarness("observe");
  harness.enforce = await startHarness("enforce");
}, 240_000);

afterAll(async () => {
  for (const h of Object.values(harness)) await new Promise<void>((resolve) => h.server.close(() => resolve()));
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

async function postJson(h: Harness, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function authorize(h: Harness, deviceId: string, channel: string, path = "/session/authorize"): Promise<{ status: number; body: Record<string, unknown> }> {
  const issued = await postJson(h, "/devices/challenge", { device_id: deviceId });
  const challenge = issued.body["challenge"];
  if (typeof challenge !== "string") throw new Error(`challenge_failed:${issued.status}:${JSON.stringify(issued.body)}`);
  const k = keys.get(deviceId) as ReturnType<typeof generateKeyPairSync>;
  const evidence = { person_id: PERSON, tenant_id: TENANT, device_id: deviceId, memory_space: "personal", device_proof: { challenge, signature: sign(null, Buffer.from(challenge, "utf8"), k.privateKey).toString("base64") } };
  return postJson(h, path, path === "/voice/session/authorize" ? evidence : { channel, ...evidence });
}

const grantOf = (r: { body: Record<string, unknown> }): string => (r.body["grant"] as { grant_token: string }).grant_token;
const stepUpProbe = (h: Harness, grantToken: string) => postJson(h, "/owner-controls/connector-credentials", { grant_token: grantToken, action: "set_connector_credential", parameters: {} });
const wouldDenyRows = async (deviceId: string): Promise<number> =>
  (await adminPool.query("SELECT count(*)::int AS n FROM audit_events WHERE device_id = $1 AND type = 'identity.channel_binding_would_deny'", [deviceId])).rows[0].n as number;

describe("A: angrepet fra JARVIS-111 - en enhet uten step-up-rolle PÅSTÅR en step-up-kanal", () => {
  it("OBSERVE (standard = main): Watch påstår `web`, får grant OG passerer step-up (hullet er der fortsatt, men revidert som «ville nektet»)", async () => {
    const h = harness.observe;
    const before = await wouldDenyRows("x-watch");
    const r = await authorize(h, "x-watch", "web");
    expect(r.status).toBe(200);
    expect((r.body["grant"] as { channel: string }).channel).toBe("web");
    const probe = await stepUpProbe(h, grantOf(r));
    expect(probe.status).toBe(200); // dette ER JARVIS-111 i observe: step-up oppfylt av en Watch som påsto web
    expect(await wouldDenyRows("x-watch")).toBe(before + 1);
  });

  it("ENFORCE: den samme påstanden gir 403 `channel_not_allowed_for_device_kind` - INGEN grant, og svaret røper ikke enhetens type", async () => {
    const h = harness.enforce;
    for (const [device, channel] of [["x-watch", "web"], ["x-watch", "api"], ["x-watch", "mobile"], ["x-watch", "desktop"], ["x-legacy", "web"], ["x-legacy", "api"], ["x-legacy", "mobile"], ["x-legacy", "desktop"],
      ["x-voice", "web"], ["x-iphone", "web"], ["x-web", "api"], ["x-api", "web"], ["x-mac", "mobile"]] as const) {
      const before = (await adminPool.query("SELECT count(*)::int AS n FROM session_grants WHERE device_id = $1", [device])).rows[0].n as number;
      const r = await authorize(h, device, channel);
      expect(r.status, `${device} x ${channel}`).toBe(403);
      expect(r.body, `${device} x ${channel}`).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
      expect((await adminPool.query("SELECT count(*)::int AS n FROM session_grants WHERE device_id = $1", [device])).rows[0].n, `${device} x ${channel}`).toBe(before);
    }
    expect(h.executed).toEqual([]); // ingenting nådde gatewayen
  });

  it("ENFORCE: de legitime eier-enhetene får grant og passerer step-up (nettleser/web, iPhone/mobile, Mac/desktop, api-klient/api)", async () => {
    const h = harness.enforce;
    for (const [device, channel] of [["x-web", "web"], ["x-iphone", "mobile"], ["x-mac", "desktop"], ["x-api", "api"]] as const) {
      const r = await authorize(h, device, channel);
      expect(r.status, device).toBe(200);
      const probe = await stepUpProbe(h, grantOf(r));
      expect(probe.status, `${device} x ${channel}`).toBe(200);
    }
    expect(h.executed.map((e) => e.channel).sort()).toEqual(["api", "desktop", "mobile", "web"]);
  });

  it("ENFORCE: en Watch får fortsatt grant for `watch`, men step-up-flaten nekter kanalen (eksisterende regel er uendret)", async () => {
    const h = harness.enforce;
    const executedBefore = h.executed.length;
    const r = await authorize(h, "x-watch", "watch");
    expect(r.status).toBe(200);
    const probe = await stepUpProbe(h, grantOf(r));
    expect(probe.status).toBe(403);
    expect(probe.body).toMatchObject({ error: "step_up_required", reason: "step_up_required:channel_watch_not_allowed" });
    expect(h.executed.length).toBe(executedBefore);
  });

  it("OVERGANGEN observe -> enforce: et grant utstedt i observe for en kanal typen ikke tillater slutter å virke UMIDDELBART mot enforce-serveren (dybdeforsvar i verify), selv om det ikke er utløpt", async () => {
    const minted = await authorize(harness.observe, "x-legacy", "web");
    expect(minted.status).toBe(200);
    const token = grantOf(minted);
    expect((await stepUpProbe(harness.observe, token)).status).toBe(200); // observe: gyldig
    const executedBefore = harness.enforce.executed.length;
    const viaEnforce = await stepUpProbe(harness.enforce, token);
    expect(viaEnforce.status).toBe(403);
    expect(viaEnforce.body).toMatchObject({ error: "identity_denied", reason: "channel_not_allowed_for_device_kind" });
    expect(harness.enforce.executed.length).toBe(executedBefore);
  });
});

describe("B: /voice/session/authorize bruker SAMME kjerne", () => {
  it("ENFORCE: nettleser (web_browser) og talegateway får talegrant; Watch, iPhone og legacy_unknown... får det kun der typen tillater det; OBSERVE gir alltid grant", async () => {
    const expected: Record<string, number> = { "x-web": 200, "x-voice": 200, "x-watch": 403, "x-iphone": 403, "x-api": 403, "x-mac": 403, "x-legacy": 200 };
    for (const [device, status] of Object.entries(expected)) {
      const e = await authorize(harness.enforce, device, "voice", "/voice/session/authorize");
      expect(e.status, `enforce ${device}`).toBe(status);
      if (status === 403) expect(e.body).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
      const o = await authorize(harness.observe, device, "voice", "/voice/session/authorize");
      expect(o.status, `observe ${device}`).toBe(200);
    }
  });
});

describe("C: innrulling over HTTP - billetten bærer typen, klienten kan ikke velge den", () => {
  const register = (h: Harness, deviceId: string, key: ReturnType<typeof generateKeyPairSync>, enrollment: unknown, claim?: string) =>
    postJson(h, "/devices/register", { tenant_id: TENANT, person_id: PERSON, device: { device_id: deviceId, ...(claim !== undefined ? { kind: claim } : {}), public_key_pem: pem(key) }, enrollment });

  it("en Watch rullet inn med en watch-billett som PÅSTÅR `web`: serveren lagrer watch, og enforce nekter den kanalen web men tillater watch", async () => {
    const h = harness.enforce;
    const key = generateKeyPairSync("ed25519");
    keys.set("x-newwatch", key);
    const t = await createEnrollmentTicket(adminPool, { tenant_id: TENANT, person_id: PERSON, device_kind: "watch" });
    const reg = await register(h, "x-newwatch", key, { kind: "enrollment_ticket", ticket: t.ticket }, "web");
    expect(reg).toEqual({ status: 200, body: { ok: true, registered: "x-newwatch", rotated: false, revoked_grants: 0 } });
    expect((await adminPool.query("SELECT device_kind, device_kind_source FROM devices WHERE device_id = 'x-newwatch'")).rows[0]).toEqual({ device_kind: "watch", device_kind_source: "enrollment_ticket" });
    expect((await authorize(h, "x-newwatch", "web")).status).toBe(403);
    expect((await authorize(h, "x-newwatch", "watch")).status).toBe(200);
  });

  it("en billett uten type («ikke angitt») gir en enhet som kun kan få ikke-step-up-kanaler (aldri web/api/mobile/desktop) i enforce", async () => {
    const h = harness.enforce;
    const key = generateKeyPairSync("ed25519");
    keys.set("x-notype", key);
    const t = await createEnrollmentTicket(adminPool, { tenant_id: TENANT, person_id: PERSON });
    expect((await register(h, "x-notype", key, { kind: "enrollment_ticket", ticket: t.ticket }, "iphone")).status).toBe(200);
    for (const channel of ["web", "api", "mobile", "desktop"]) expect((await authorize(h, "x-notype", channel)).status, channel).toBe(403);
    expect((await authorize(h, "x-notype", "voice")).status).toBe(200);
  });

  it("smuglet type i forespørselen gir 400 malformed_request (strict), og en Watch kan ikke re-nøkle iPhonen via device_proof i enforce (403), men i observe tillates det (revidert)", async () => {
    const h = harness.enforce;
    const key = generateKeyPairSync("ed25519");
    const smuggled = await postJson(h, "/devices/register", { tenant_id: TENANT, person_id: PERSON, device: { device_id: "x-smug", device_kind: "iphone", public_key_pem: pem(key) }, enrollment: { kind: "enrollment_ticket", ticket: "t" } });
    expect(smuggled.status).toBe(400);

    const proof = async (hh: Harness, authorizing: string) => {
      const { challenge } = (await postJson(hh, "/devices/challenge", { device_id: authorizing })).body as { challenge: string };
      const k = keys.get(authorizing) as ReturnType<typeof generateKeyPairSync>;
      return { kind: "device_proof", authorizing_device_id: authorizing, challenge, signature: sign(null, Buffer.from(challenge, "utf8"), k.privateKey).toString("base64") };
    };
    const attackerKey = generateKeyPairSync("ed25519");
    const denied = await register(h, "x-iphone", attackerKey, await proof(h, "x-watch"));
    expect(denied).toEqual({ status: 403, body: { ok: false, reason: "authorizing_device_kind_not_allowed" } });
    expect((await adminPool.query("SELECT public_key_pem FROM devices WHERE device_id = 'x-iphone'")).rows[0].public_key_pem.trim()).toBe(pem(keys.get("x-iphone") as ReturnType<typeof generateKeyPairSync>).trim());
  });
});
