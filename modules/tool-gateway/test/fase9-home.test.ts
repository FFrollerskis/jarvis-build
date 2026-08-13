import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalSigningBytes, type ApprovalPayload, type IdentityContext, type SignedApproval } from "@jarvis/contracts";
import { PgApprovalStore, createPool, fastRoute, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, homeAssistantTools, type SecretProvider } from "@jarvis/tool-gateway";

const PORT = 30000 + Math.floor(Math.random() * 20000);
const watchKeys = generateKeyPairSync("ed25519");
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let gateway: ToolGateway;
let ha: FakeTransport;

// Talekanal med rom-metadata: rommet kommer fra identitetskonteksten.
const voiceIdentity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "home",
  session_id: "sess-stue", device_id: "satellitt-stue", channel: "voice",
  auth_strength: "active", site_id: "site-hus", room_id: "rom-stue"
};

const secrets: SecretProvider = { name: "test", async get() { return "ha-token"; } };

function approval(action: string, parameters: Record<string, unknown>): SignedApproval {
  const payload: ApprovalPayload = {
    action, parameters: parameters as ApprovalPayload["parameters"],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    nonce: `nonce-${randomUUID()}`, approving_device_id: "watch-1"
  };
  return { ...payload, signature: sign(null, approvalSigningBytes(payload), watchKeys.privateKey).toString("base64") };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg9-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "pw2" });
  const devices = new InMemoryDeviceRegistry();
  devices.register("watch-1", watchKeys.publicKey);
  const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
  ha = new FakeTransport(() => ({ external_id: "ha-ok" }));
  gateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of homeAssistantTools(ha)) gateway.register(tool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("Akseptanse 2: stedsriktige kommandoer per rom", () => {
  it("'skru på lyset her' rutes deterministisk og bærer rommet fra identiteten", async () => {
    const intent = fastRoute("skru på lyset her");
    expect(intent).toEqual({ kind: "home_light", on: true });
    expect(fastRoute("slå av lyset")).toEqual({ kind: "home_light", on: false });

    const result = await gateway.execute({
      identity: voiceIdentity, tool_id: "home-assistant", action: "light_set",
      parameters: { site_id: voiceIdentity.site_id!, room_id: voiceIdentity.room_id!, on: true }
    });
    expect(result.ok).toBe(true);
    expect(ha.calls.at(-1)?.parameters["room_id"]).toBe("rom-stue");
  });

  it("lesing av romtilstand er klasse A og output er untrusted", async () => {
    const result = await gateway.execute({
      identity: voiceIdentity, tool_id: "home-assistant", action: "read_state",
      parameters: { site_id: "site-hus", room_id: "rom-stue" }
    });
    expect(result.ok && result.output_trust).toBe("untrusted");
  });
});

describe("Akseptanse 3: lås/alarm krever signert godkjenning - også via tale", () => {
  it("lock_set via talekanal uten godkjenning → DENY; med gyldig → ALLOW; replay → DENY", async () => {
    const parameters = { site_id: "site-hus", room_id: "rom-gang", entity: "lock.ytterdor", locked: false };
    const denied = await gateway.execute({
      identity: voiceIdentity, tool_id: "home-assistant", action: "lock_set", parameters
    });
    expect((denied as { reason: string }).reason).toBe("class_d_missing_approval");
    expect(ha.calls.filter((c) => c.action === "lock_set")).toHaveLength(0);

    const signed = approval("lock_set", parameters);
    const allowed = await gateway.execute({
      identity: voiceIdentity, tool_id: "home-assistant", action: "lock_set", parameters, approval: signed
    });
    expect(allowed.ok).toBe(true);
    const replay = await gateway.execute({
      identity: voiceIdentity, tool_id: "home-assistant", action: "lock_set", parameters, approval: signed
    });
    expect((replay as { reason: string }).reason).toBe("class_d_nonce_already_used");
  });

  it("alarm_set uten godkjenning → DENY ('sagt høyt' gir aldri unntak)", async () => {
    const denied = await gateway.execute({
      identity: voiceIdentity, tool_id: "home-assistant", action: "alarm_set",
      parameters: { site_id: "site-hus", room_id: "rom-gang", armed: false }
    });
    expect((denied as { reason: string }).reason).toBe("class_d_missing_approval");
  });

  it("HA-verktøyene har komplett capability-metadata og riktige klasser", () => {
    const tools = homeAssistantTools();
    expect(tools.find((t) => t.action === "lock_set")?.capability_class).toBe("D");
    expect(tools.find((t) => t.action === "alarm_set")?.capability_class).toBe("D");
    expect(tools.find((t) => t.action === "light_set")?.capability_class).toBe("B");
    for (const t of tools) {
      expect(t.rollback_procedure.length).toBeGreaterThan(0);
      expect(t.credential_ref).toBe("JARVIS_HA_TOKEN");
    }
  });
});
