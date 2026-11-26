import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_KINDS, type Channel, type DeviceKind } from "@jarvis/contracts";
import { ChannelSessionAuthority, DeviceService, IdentityService, SessionGrantService, SessionService, createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * WP-S1 K2 (dybdeforsvar): `SessionGrantService.verify()` i `enforce` sjekker at grantets kanal FORTSATT hører til enhetens type slik den står nå. Et grant utstedt FØR `enforce` ble slått på (observe-grant med en kanal
 * enheten ikke skulle hatt), eller før en typeendring, slutter å virke umiddelbart - i stedet for å leve ut de 15 minuttene. I `observe` er `verify()` uendret (identisk med main).
 */
const TENANT = "tenant-s1g";
const PERSON = "person-s1g";
const CHANNELS: readonly Channel[] = ["web", "mobile", "watch", "voice", "api", "system", "telegram", "desktop", "slack", "discord", "twilio"];
const ALLOWED: Readonly<Record<DeviceKind, readonly Channel[]>> = {
  iphone: ["mobile"], mac: ["desktop"], windows: ["desktop"], web_browser: ["web", "voice"], watch: ["watch"], voice_gateway: ["voice"], telegram_gateway: ["telegram"],
  api_client: ["api"], service: ["system"], legacy_unknown: ["watch", "voice", "system", "telegram", "slack", "discord", "twilio"]
};

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let devices: DeviceService;
let observeAuthority: ChannelSessionAuthority;
let observeGrants: SessionGrantService;
let enforceGrants: SessionGrantService;
const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
let counter = 0;
const pem = (k: { publicKey: KeyObject }): string => k.publicKey.export({ type: "spki", format: "pem" }).toString();

async function addDevice(kind: DeviceKind): Promise<string> {
  const id = `dev-s1g-${kind}-${++counter}`;
  const k = generateKeyPairSync("ed25519");
  keys.set(id, k);
  await adminPool.query(
    "INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem, device_kind, device_kind_source) VALUES ($1, $2, $3, 'x', $4, $5, $6)",
    [id, TENANT, PERSON, pem(k), kind, kind === "legacy_unknown" ? "unclassified" : "trusted_provisioning"]
  );
  return id;
}

/** Mint et grant i OBSERVE (som main: enhver kanal gir grant) og returnér tokenet. */
async function mint(deviceId: string, channel: Channel): Promise<string> {
  const challenge = devices.issueChallenge(deviceId);
  const k = keys.get(deviceId) as ReturnType<typeof generateKeyPairSync>;
  const result = await observeAuthority.authorize(channel, {
    person_id: PERSON, tenant_id: TENANT, device_id: deviceId, memory_space: "personal",
    device_proof: { challenge, signature: sign(null, Buffer.from(challenge, "utf8"), k.privateKey).toString("base64") }
  });
  if (!result.ok) throw new Error(`mint_failed:${result.reason}`);
  return result.grant.grant_token;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-s1g-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_s1g LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_s1g");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'S1G', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'S1G Person');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON}', '${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-s1g', '${TENANT}', 'personal');`);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_s1g", password: "pw2" });
  devices = new DeviceService(appPool);
  observeGrants = new SessionGrantService(appPool, { channelBindingMode: "observe" });
  enforceGrants = new SessionGrantService(appPool, { channelBindingMode: "enforce" });
  observeAuthority = new ChannelSessionAuthority({ pool: appPool, devices, sessions: new SessionService(appPool), identity: new IdentityService(appPool), grants: observeGrants, channelBindingMode: "observe" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

describe("WP-S1 K2: verify() i enforce - hver (type, kanal) (110 kombinasjoner) mot et grant utstedt i observe", () => {
  for (const kind of DEVICE_KINDS) {
    it(`${kind}: grant for ${ALLOWED[kind].join(", ")} består i enforce; grant for alle andre kanaler nektes channel_not_allowed_for_device_kind (observe består alltid)`, async () => {
      const deviceId = await addDevice(kind);
      for (const channel of CHANNELS) {
        const token = await mint(deviceId, channel);
        const inObserve = await observeGrants.verify(token);
        expect(inObserve.ok, `observe ${kind} x ${channel}`).toBe(true);
        const inEnforce = await enforceGrants.verify(token);
        if (ALLOWED[kind].includes(channel)) {
          expect(inEnforce.ok, `enforce ${kind} x ${channel}`).toBe(true);
          if (inEnforce.ok) expect(inEnforce.grant.channel).toBe(channel);
        } else {
          expect(inEnforce, `enforce ${kind} x ${channel}`).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
        }
      }
    }, 120_000);
  }

  it("avslaget revideres (`session_grant.denied`, årsaken) og er ikke et nytt grant: tokenet gir fortsatt ingenting i enforce", async () => {
    const deviceId = await addDevice("watch");
    const token = await mint(deviceId, "web");
    const before = (await adminPool.query("SELECT count(*)::int AS n FROM audit_events WHERE device_id = $1 AND type = 'session_grant.denied'", [deviceId])).rows[0].n as number;
    expect(await enforceGrants.verify(token)).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
    expect(await enforceGrants.verify(token)).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
    const rows = (await adminPool.query("SELECT reason FROM audit_events WHERE device_id = $1 AND type = 'session_grant.denied' ORDER BY audit_id", [deviceId])).rows;
    expect(rows.length).toBe(before + 2);
    expect(rows.every((r) => r.reason === "channel_not_allowed_for_device_kind")).toBe(true);
  });

  it("standarden (ingen option) er observe: verify() er uendret (identisk med main) for en kanal typen ikke tillater", async () => {
    const deviceId = await addDevice("legacy_unknown");
    const token = await mint(deviceId, "web");
    expect((await new SessionGrantService(appPool).verify(token)).ok).toBe(true);
    expect((await new SessionGrantService(appPool, {}).verify(token)).ok).toBe(true);
    // en feiltolket modusverdi i koden (kun eksakt `enforce` håndhever) er også observe
    expect((await new SessionGrantService(appPool, { channelBindingMode: "enforced" as never }).verify(token)).ok).toBe(true);
  });

  it("typen endret ETTER utstedelsen (eier retter en type via admin-SQL med eksplisitt tillatelse): et gyldig grant slutter å virke umiddelbart i enforce, men ikke i observe", async () => {
    const deviceId = await addDevice("web_browser");
    const token = await mint(deviceId, "web");
    expect((await enforceGrants.verify(token)).ok).toBe(true);
    const c = await adminPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('jarvis.device_kind_change', 'on', true)");
      await c.query("UPDATE devices SET device_kind = 'watch', device_kind_source = 'trusted_provisioning' WHERE device_id = $1", [deviceId]);
      await c.query("COMMIT");
    } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
    expect(await enforceGrants.verify(token)).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
    expect((await observeGrants.verify(token)).ok).toBe(true);
  });

  it("rekkefølgen er uendret: tilbakekalt, utløpt og rotert nøkkel gir SINE årsaker FØR kanalbindingen (enforce)", async () => {
    const watch = await addDevice("watch");
    const revoked = await mint(watch, "web");
    await adminPool.query("UPDATE session_grants SET revoked_at = now() WHERE device_id = $1", [watch]);
    expect(await enforceGrants.verify(revoked)).toEqual({ ok: false, reason: "grant_revoked" });

    const watch2 = await addDevice("watch");
    const token2 = await mint(watch2, "web");
    expect(await enforceGrants.verify(token2, Date.now() + 16 * 60 * 1000)).toEqual({ ok: false, reason: "grant_expired" });

    const watch3 = await addDevice("watch");
    const token3 = await mint(watch3, "web");
    await adminPool.query("UPDATE devices SET public_key_pem = $2 WHERE device_id = $1", [watch3, pem(generateKeyPairSync("ed25519"))]);
    expect(await enforceGrants.verify(token3)).toEqual({ ok: false, reason: "device_authority_revoked" });
  });
});
