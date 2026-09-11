import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { ChannelSessionAuthority, DeviceService, IdentityService, PgApprovalStore, SessionGrantService, SessionService, createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";

/**
 * UA-7-generalisering, test F: "kanalbytte uten duplikate actions" er ikke et
 * hull som må tettes med ny infrastruktur - `ToolGateway.execute()` har
 * ALLEREDE en `tenant_id + idempotency_key`-basert dedupe for C/D-handlinger
 * (Q-18/D-30, `modules/tool-gateway/src/gateway.ts`), og den er IKKE
 * kanal-spesifikk: nøkkelen inneholder ingen `channel`- eller `session_id`-
 * verdi. Denne testen beviser at kombinasjonen
 * `ChannelSessionAuthority` (server-eid sesjonskontinuitet på tvers av kanal)
 * + den eksisterende dedupen strukturelt forhindrer en dobbel side-effekt selv
 * når en handling utføres først via `mobile`, så - med SAMME
 * `idempotency_key` - via `web`, for samme person/tenant.
 */

const PORT = 30000 + Math.floor(Math.random() * 20000);
const phoneKeys = generateKeyPairSync("ed25519");

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let devices: DeviceService;
let authority: ChannelSessionAuthority;

const pem = (keys: { publicKey: KeyObject }): string =>
  keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function proof(deviceId: string, key: Parameters<typeof sign>[2]): { challenge: string; signature: string } {
  const challenge = devices.issueChallenge(deviceId);
  return { challenge, signature: sign(null, Buffer.from(challenge, "utf8"), key).toString("base64") };
}

const seedIdentity: IdentityContext = {
  person_id: "person-tobias",
  tenant_id: "tenant-chdedupe",
  memory_space_id: "personal",
  session_id: "sess-seed",
  device_id: "seed-device",
  channel: "system",
  auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-chdedupe-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_chdedupe LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_chdedupe");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-chdedupe','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-chdedupe');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-personal','tenant-chdedupe','personal');
    INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem)
      VALUES ('seed-device','tenant-chdedupe','person-tobias','service', NULL);
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_chdedupe", password: "pw2" });
  devices = new DeviceService(appPool);
  authority = new ChannelSessionAuthority({
    pool: appPool,
    devices,
    sessions: new SessionService(appPool),
    identity: new IdentityService(appPool),
    // D-131: autoriteten utsteder nå også et avgrenset, revokerbart grant.
    grants: new SessionGrantService(appPool)
  });
  await devices.registerDeviceTrusted(seedIdentity,{ device_id: "phone-tobias", kind: "mobile", public_key_pem: pem(phoneKeys) });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("F: kanalbytte-dedupe - samme idempotency_key, mobile deretter web, INGEN dobbel side-effekt", () => {
  it("andre kallet dedupliseres (deduplicated: true) og transporten kalles KUN én gang", async () => {
    const onMobile = await authority.authorize("mobile", {
      person_id: "person-tobias",
      tenant_id: "tenant-chdedupe",
      device_id: "phone-tobias",
      memory_space: "personal",
      device_proof: proof("phone-tobias", phoneKeys.privateKey)
    });
    expect(onMobile.ok).toBe(true);
    if (!onMobile.ok) return;

    const onWeb = await authority.authorize("web", {
      person_id: "person-tobias",
      tenant_id: "tenant-chdedupe",
      device_id: "phone-tobias",
      memory_space: "personal",
      device_proof: proof("phone-tobias", phoneKeys.privateKey)
    });
    expect(onWeb.ok).toBe(true);
    if (!onWeb.ok) return;

    // Sesjonskontinuiteten: begge identitetene deler SAMME server-eide
    // sesjon, kun `channel`-feltet er forskjellig.
    expect(onWeb.identity.session_id).toBe(onMobile.identity.session_id);
    expect(onMobile.identity.channel).toBe("mobile");
    expect(onWeb.identity.channel).toBe("web");

    const calendarTransport = new FakeTransport(() => ({ external_id: "evt-fra-mobil" }));
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(),
      nonces: new PgApprovalStore(appPool),
      killSwitch: new KillSwitch(),
      // Sovereign owner-config (v4.0-semantikk): klasse C krever ikke et eget
      // godkjenningsobjekt i denne testen - den undersøker KUN dedupe.
      authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-chdedupe"] }
    });
    const toolGateway = new ToolGateway(appPool, policy, { name: "test", async get() { return "secret-never-leaks"; } });
    for (const tool of firstWaveTools({ calendar: calendarTransport })) toolGateway.register(tool);

    const idempotencyKey = "not-a-real-secret-chdedupe-test-fixture-marker";
    const params = { title: "Tannlege", start: new Date().toISOString(), end: new Date(Date.now() + 3_600_000).toISOString() };

    // Første kall: utført VIA `mobile`-identiteten.
    const first = await toolGateway.execute({
      identity: onMobile.identity,
      tool_id: "calendar",
      action: "create_event",
      parameters: params,
      idempotency_key: idempotencyKey
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.deduplicated).toBe(false);
      expect(first.external_id).toBe("evt-fra-mobil");
    }
    expect(calendarTransport.calls.length).toBe(1);

    // Andre kall: SAMME idempotency_key, men denne gangen VIA `web`-identiteten
    // (kanalbytte etter D-en over) - må dedupliseres, ALDRI en ny mutasjon.
    const second = await toolGateway.execute({
      identity: onWeb.identity,
      tool_id: "calendar",
      action: "create_event",
      parameters: params,
      idempotency_key: idempotencyKey
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.deduplicated).toBe(true);
      // Samme eksterne ID som det FAKTISKE, eneste kallet ga - ingen ny hendelse ble opprettet.
      expect(second.external_id).toBe("evt-fra-mobil");
    }
    // Transporten ble ALDRI kalt en andre gang - den strukturelle beskyttelsen mot dobbel side-effekt.
    expect(calendarTransport.calls.length).toBe(1);
  });
});
