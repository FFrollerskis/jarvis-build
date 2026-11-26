import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_KINDS, type Channel, type DeviceKind } from "@jarvis/contracts";
import {
  ChannelSessionAuthority,
  DeviceService,
  IdentityService,
  SessionGrantService,
  SessionService,
  VoiceSessionAuthority,
  authorizeProvenDevice,
  createPool,
  runMigrations,
  type ChannelBindingMode,
  type DeviceAuthorityDeps
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * WP-S1 K2/K5: server-side kanalbinding i autorisasjonskjernen, mot EKTE embedded Postgres og ekte RLS (app-rolle). En enhet beviser besittelse av nøkkelen sin og ber om en kanal; serveren avgjør om kanalen
 * hører til enhetstypen (`devices.device_kind`, satt av serveren ved innrulling). Observe = dagens atferd + revisjonsrad; enforce = `channel_not_allowed_for_device_kind`, fail-closed, uten sideeffekt.
 */
const TENANT = "tenant-s1";
const PERSON = "person-s1";
const CHANNELS: readonly Channel[] = ["web", "mobile", "watch", "voice", "api", "system", "telegram", "desktop", "slack", "discord", "twilio"];
/** Uavhengig forventet matrise (samme som contracts-testen, skrevet ut igjen her så DB-testen ikke avhenger av implementasjonen). */
const ALLOWED: Readonly<Record<DeviceKind, readonly Channel[]>> = {
  iphone: ["mobile"], mac: ["desktop"], windows: ["desktop"], web_browser: ["web", "voice"], watch: ["watch"], voice_gateway: ["voice"], telegram_gateway: ["telegram"],
  api_client: ["api"], service: ["system"], legacy_unknown: ["watch", "voice", "system", "telegram", "slack", "discord", "twilio"]
};

let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let devices: DeviceService;
let sessions: SessionService;
let identity: IdentityService;
let grants: SessionGrantService;
let enforceDeps: DeviceAuthorityDeps;
let observeDeps: DeviceAuthorityDeps;
let defaultDeps: DeviceAuthorityDeps;
let enforceAuthority: ChannelSessionAuthority;
let observeAuthority: ChannelSessionAuthority;
let defaultAuthority: ChannelSessionAuthority;
const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();

const pem = (k: { publicKey: KeyObject }): string => k.publicKey.export({ type: "spki", format: "pem" }).toString();
const deviceIdOf = (kind: DeviceKind): string => `dev-s1-${kind}`;

async function addDevice(deviceId: string, kind: DeviceKind, source?: string): Promise<ReturnType<typeof generateKeyPairSync>> {
  const k = generateKeyPairSync("ed25519");
  keys.set(deviceId, k);
  await adminPool.query(
    `INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem, device_kind, device_kind_source) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [deviceId, TENANT, PERSON, `label-${kind}`, pem(k), kind, source ?? (kind === "legacy_unknown" ? "unclassified" : "trusted_provisioning")]
  );
  return k;
}

function evidence(deviceId: string): { person_id: string; tenant_id: string; device_id: string; memory_space: "personal"; device_proof: { challenge: string; signature: string } } {
  const challenge = devices.issueChallenge(deviceId);
  const k = keys.get(deviceId) as ReturnType<typeof generateKeyPairSync>;
  return {
    person_id: PERSON, tenant_id: TENANT, device_id: deviceId, memory_space: "personal",
    device_proof: { challenge, signature: sign(null, Buffer.from(challenge, "utf8"), k.privateKey).toString("base64") }
  };
}

const grantCount = async (deviceId: string): Promise<number> =>
  (await adminPool.query("SELECT count(*)::int AS n FROM session_grants WHERE device_id = $1", [deviceId])).rows[0].n as number;
const auditRows = async (deviceId: string, type: string): Promise<Array<{ decision: string | null; reason: string | null; payload: Record<string, unknown> }>> =>
  (await adminPool.query("SELECT decision, reason, payload FROM audit_events WHERE device_id = $1 AND type = $2 ORDER BY audit_id", [deviceId, type])).rows;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-s1-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  epg = leased.postgres;
  stopEmbeddedPostgres = leased.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_s1 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_s1");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'S1', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'S1 Person');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON}', '${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-s1', '${TENANT}', 'personal');`);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_s1", password: "pw2" });
  devices = new DeviceService(appPool);
  sessions = new SessionService(appPool);
  identity = new IdentityService(appPool);
  grants = new SessionGrantService(appPool);
  const base = { pool: appPool, sessions, identity, grants, devices };
  enforceDeps = { ...base, channelBindingMode: "enforce" satisfies ChannelBindingMode };
  observeDeps = { ...base, channelBindingMode: "observe" satisfies ChannelBindingMode };
  defaultDeps = base;
  enforceAuthority = new ChannelSessionAuthority(enforceDeps);
  observeAuthority = new ChannelSessionAuthority(observeDeps);
  defaultAuthority = new ChannelSessionAuthority(defaultDeps);
  for (const kind of DEVICE_KINDS) await addDevice(deviceIdOf(kind), kind);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("WP-S1 K2/K5 A: enforce - hver kanal x enhetstype (110 kombinasjoner) mot ekte Postgres", () => {
  for (const kind of DEVICE_KINDS) {
    it(`${kind}: nøyaktig kanalene ${ALLOWED[kind].join(", ")} gir grant; alle andre nektes channel_not_allowed_for_device_kind uten sideeffekt`, async () => {
      const deviceId = deviceIdOf(kind);
      for (const channel of CHANNELS) {
        const before = await grantCount(deviceId);
        const result = await enforceAuthority.authorize(channel, evidence(deviceId));
        if (ALLOWED[kind].includes(channel)) {
          expect(result.ok, `${kind} x ${channel}`).toBe(true);
          if (result.ok) {
            expect(result.identity.channel, `${kind} x ${channel}`).toBe(channel);
            expect(result.grant.channel, `${kind} x ${channel}`).toBe(channel);
            expect(result.grant.auth_strength).toBe("signed");
          }
          expect(await grantCount(deviceId), `${kind} x ${channel}`).toBe(before + 1);
        } else {
          expect(result, `${kind} x ${channel}`).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
          expect(await grantCount(deviceId), `${kind} x ${channel}: ingen grant ved avslag`).toBe(before);
        }
      }
    }, 60_000);
  }

  it("step-up kan ALDRI oppfylles av en lavtillits-type: ingen enhetstype utenom de fem eier-typene får noen økt med en step-up-kanal", async () => {
    const stepUp: Channel[] = ["web", "desktop", "api", "mobile"];
    for (const kind of ["watch", "voice_gateway", "telegram_gateway", "service", "legacy_unknown"] as const) {
      for (const channel of stepUp) {
        const result = await enforceAuthority.authorize(channel, evidence(deviceIdOf(kind)));
        expect(result, `${kind} x ${channel}`).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
      }
    }
  });
});

describe("WP-S1 K2/K5 B: observe - identisk med dagens atferd (alle kombinasjoner gir grant) pluss en revisjonsrad der enforce ville nektet", () => {
  for (const kind of DEVICE_KINDS) {
    it(`${kind}: ALLE kanaler gir grant med den påståtte kanalen (som main), og «ville nektet»-rad skrives nøyaktig for de som enforce ville nektet`, async () => {
      const deviceId = `${deviceIdOf(kind)}-obs`;
      await addDevice(deviceId, kind);
      for (const channel of CHANNELS) {
        const result = await observeAuthority.authorize(channel, evidence(deviceId));
        expect(result.ok, `${kind} x ${channel}`).toBe(true);
        if (result.ok) {
          expect(result.identity.channel).toBe(channel);
          expect(result.grant.channel).toBe(channel);
          expect(result.grant.auth_strength).toBe("signed");
        }
      }
      const would = await auditRows(deviceId, "identity.channel_binding_would_deny");
      const expectedDenied = CHANNELS.filter((c) => !ALLOWED[kind].includes(c));
      expect(would.map((r) => (r.payload as { channel: string }).channel).sort(), kind).toEqual([...expectedDenied].sort());
      for (const row of would) {
        expect(row.decision).toBe("ALLOW");
        expect(row.reason).toBe("channel_not_allowed_for_device_kind");
        expect(row.payload).toMatchObject({ mode: "observe", device_kind: kind });
      }
      // observe nekter aldri: ingen `identity.denied`-rad for binding-årsaken
      expect((await auditRows(deviceId, "identity.denied")).filter((r) => r.reason === "channel_not_allowed_for_device_kind")).toEqual([]);
    }, 60_000);
  }

  it("uten channelBindingMode i deps er standarden observe (alle de ~100 eksisterende testene er uendret)", async () => {
    const deviceId = deviceIdOf("watch");
    const result = await defaultAuthority.authorize("web", evidence(deviceId));
    expect(result.ok).toBe(true);
    expect((await auditRows(deviceId, "identity.channel_binding_would_deny")).some((r) => (r.payload as { channel: string }).channel === "web")).toBe(true);
  });
});

describe("WP-S1 K2 C: avslaget er revidert og har INGEN sideeffekt på server-eid tilstand", () => {
  it("enforce: `identity.denied` med årsak, type, kanal og modus; sesjonsraden er urørt; nonce er brukt (replay umulig)", async () => {
    const deviceId = deviceIdOf("watch");
    const sessionBefore = (await adminPool.query("SELECT session_id, last_channel, last_device_id, last_active_at FROM sessions WHERE tenant_id = $1 AND person_id = $2 AND status = 'active'", [TENANT, PERSON])).rows;
    const deniedBefore = (await auditRows(deviceId, "identity.denied")).length;
    const ev = evidence(deviceId);
    const first = await enforceAuthority.authorize("web", ev);
    expect(first).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
    const sessionAfter = (await adminPool.query("SELECT session_id, last_channel, last_device_id, last_active_at FROM sessions WHERE tenant_id = $1 AND person_id = $2 AND status = 'active'", [TENANT, PERSON])).rows;
    expect(sessionAfter).toEqual(sessionBefore);
    const denied = await auditRows(deviceId, "identity.denied");
    expect(denied.length).toBe(deniedBefore + 1);
    const last = denied[denied.length - 1] as (typeof denied)[number];
    expect(last.decision).toBe("DENY");
    expect(last.reason).toBe("channel_not_allowed_for_device_kind");
    expect(last.payload).toMatchObject({ mode: "enforce", device_kind: "watch", channel: "web" });
    // samme bevis kan ikke brukes på nytt (engangs-nonce er konsumert også ved avslag)
    expect(await enforceAuthority.authorize("watch", ev)).toEqual({ ok: false, reason: "device_proof_invalid" });
  });

  it("enforce: et avslag skjer FØR enhver sesjons-/grant-mutasjon, også når enheten ellers er gyldig (ingen `sessions.last_channel`-endring)", async () => {
    const deviceId = deviceIdOf("telegram_gateway");
    // Etabler en kjent tilstand: en tillatt autorisasjon på telegram setter last_channel = telegram.
    expect((await enforceAuthority.authorize("telegram", evidence(deviceId))).ok).toBe(true);
    const before = (await adminPool.query("SELECT last_channel, last_device_id FROM sessions WHERE tenant_id = $1 AND person_id = $2 AND status = 'active'", [TENANT, PERSON])).rows[0];
    expect(before).toMatchObject({ last_channel: "telegram", last_device_id: deviceId });
    for (const channel of ["web", "mobile", "api", "desktop", "voice"] as const) {
      expect(await enforceAuthority.authorize(channel, evidence(deviceId)), channel).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
    }
    const after = (await adminPool.query("SELECT last_channel, last_device_id FROM sessions WHERE tenant_id = $1 AND person_id = $2 AND status = 'active'", [TENANT, PERSON])).rows[0];
    expect(after).toEqual(before);
  });

  it("andre avslagsårsaker er uendret og går FØR bindingen: ugyldig kanal, ugyldig bevis, ukjent space og tilbakekalt enhet gir sine egne årsaker i begge moduser", async () => {
    const deviceId = deviceIdOf("web_browser");
    for (const authority of [enforceAuthority, observeAuthority]) {
      expect(await authority.authorize("fax", evidence(deviceId))).toEqual({ ok: false, reason: "unknown_channel" });
      expect(await authority.authorize("web", { ...evidence(deviceId), device_proof: { challenge: "chal-x", signature: "AAAA" } })).toEqual({ ok: false, reason: "device_proof_invalid" });
      expect(await authority.authorize("web", { ...evidence(deviceId), memory_space: "health" })).toEqual({ ok: false, reason: "unknown_memory_space" });
    }
  });
});

describe("WP-S1 K2 F: fail-closed ved en type databasen ikke skal kunne inneholde", () => {
  class BogusKindDevices extends DeviceService {
    constructor(pool: pg.Pool, private readonly bogus: unknown) { super(pool); }
    override async lockDeviceKeyOn(client: pg.PoolClient, principal: { tenant_id: string; person_id: string; device_id: string }) {
      const real = await super.lockDeviceKeyOn(client, principal);
      return real === null ? null : { ...real, device_kind: this.bogus as DeviceKind };
    }
  }
  it("en ukjent/tom/ikke-streng type nektes i enforce (aldri tillatt ved et uhell) og meldes i observe", async () => {
    const deviceId = deviceIdOf("web_browser");
    for (const bogus of ["WEB_BROWSER", "web", "", null, undefined, 7, {}]) {
      const bogusDevices = new BogusKindDevices(appPool, bogus);
      const enforce = new ChannelSessionAuthority({ ...enforceDeps, devices: bogusDevices });
      const observe = new ChannelSessionAuthority({ ...observeDeps, devices: bogusDevices });
      const k = keys.get(deviceId) as ReturnType<typeof generateKeyPairSync>;
      const ev = () => { const challenge = bogusDevices.issueChallenge(deviceId); return { person_id: PERSON, tenant_id: TENANT, device_id: deviceId, memory_space: "personal" as const, device_proof: { challenge, signature: sign(null, Buffer.from(challenge, "utf8"), k.privateKey).toString("base64") } }; };
      expect(await enforce.authorize("web", ev()), `enforce ${String(bogus)}`).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
      expect((await observe.authorize("web", ev())).ok, `observe ${String(bogus)}`).toBe(true);
    }
  });
});

describe("WP-S1 K2 voice: VoiceSessionAuthority bruker SAMME kjerne - kanalen voice er bundet til typen", () => {
  it("enforce: web_browser og voice_gateway får talegrant; en iPhone/Watch/legacy... får det kun der typen tillater det; observe gir alltid grant", async () => {
    const voiceEnforce = new VoiceSessionAuthority(enforceDeps);
    const voiceObserve = new VoiceSessionAuthority(observeDeps);
    for (const kind of DEVICE_KINDS) {
      const deviceId = deviceIdOf(kind);
      const allowedVoice = ALLOWED[kind].includes("voice");
      const e = await voiceEnforce.authorize(evidence(deviceId));
      expect(e.ok, `enforce ${kind}`).toBe(allowedVoice);
      if (!e.ok) expect(e).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
      expect((await voiceObserve.authorize(evidence(deviceId))).ok, `observe ${kind}`).toBe(true);
    }
  });
});

describe("WP-S1 K2 E: ingen TOCTOU - typen leses under radlåsen i SAMME transaksjon som nøkkelen", () => {
  it("E1: typen endret FØR autorisasjonstransaksjonen (etter beviset) gjelder: enforce bruker den nye typen, ikke typen beviset ble gitt for", async () => {
    const deviceId = "dev-s1-toctou-1";
    const k = await addDevice(deviceId, "web_browser");
    const challenge = devices.issueChallenge(deviceId);
    const signature = sign(null, Buffer.from(challenge, "utf8"), k.privateKey).toString("base64");
    const proven = await devices.verifyChallenge(TENANT, deviceId, challenge, signature, PERSON);
    expect(proven).not.toBeNull();
    // en fullført endring i vinduet mellom bevis og autorisasjon (admin med eksplisitt tillatelse, som runbookens SQL)
    const admin = await adminPool.connect();
    try {
      await admin.query("BEGIN");
      await admin.query("SELECT set_config('jarvis.device_kind_change', 'on', true)");
      await admin.query("UPDATE devices SET device_kind = 'watch', device_kind_source = 'trusted_provisioning' WHERE device_id = $1", [deviceId]);
      await admin.query("COMMIT");
    } finally { admin.release(); }
    const outcome = await authorizeProvenDevice(enforceDeps, { person_id: PERSON, tenant_id: TENANT, device_id: deviceId, memory_space: "personal", channel: "web", auth_strength: "signed", proven_key_fingerprint: proven as string });
    expect(outcome).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
  });

  it("E2: ekte overlappende transaksjoner - en pågående typeendring (radlås) BLOKKERER autorisasjonen, som deretter ser den NYE typen", async () => {
    const deviceId = "dev-s1-toctou-2";
    const k = await addDevice(deviceId, "web_browser");
    const challenge = devices.issueChallenge(deviceId);
    const signature = sign(null, Buffer.from(challenge, "utf8"), k.privateKey).toString("base64");
    const proven = (await devices.verifyChallenge(TENANT, deviceId, challenge, signature, PERSON)) as string;

    const holder = await adminPool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('jarvis.device_kind_change', 'on', true)");
      await holder.query("UPDATE devices SET device_kind = 'legacy_unknown', device_kind_source = 'unclassified' WHERE device_id = $1", [deviceId]); // radlås holdt

      let finished = false;
      pending = authorizeProvenDevice(enforceDeps, { person_id: PERSON, tenant_id: TENANT, device_id: deviceId, memory_space: "personal", channel: "web", auth_strength: "signed", proven_key_fingerprint: proven })
        .then((o) => { finished = true; return o; });
      await new Promise((r) => setTimeout(r, 400));
      expect(finished, "autorisasjonen må vente på radlåsen").toBe(false);
      await holder.query("COMMIT");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    expect(await pending).toEqual({ ok: false, reason: "channel_not_allowed_for_device_kind" });
    expect(await grantCount(deviceId)).toBe(0);
  });

  it("E3: motsatt rekkefølge - en pågående autorisasjon (radlås) holder en samtidig typeendring tilbake til den er ferdig", async () => {
    const deviceId = "dev-s1-toctou-3";
    const k = await addDevice(deviceId, "web_browser");
    const challenge = devices.issueChallenge(deviceId);
    const signature = sign(null, Buffer.from(challenge, "utf8"), k.privateKey).toString("base64");
    const proven = (await devices.verifyChallenge(TENANT, deviceId, challenge, signature, PERSON)) as string;

    const authClient = await appPool.connect();
    let change: Promise<void> | undefined;
    let changed = false;
    try {
      await authClient.query("BEGIN");
      await authClient.query("SELECT set_config('jarvis.tenant_id', $1, true)", [TENANT]);
      const locked = await devices.lockDeviceKeyOn(authClient, { tenant_id: TENANT, person_id: PERSON, device_id: deviceId });
      expect(locked?.device_kind).toBe("web_browser");
      expect(locked?.fingerprint).toBe(proven);

      change = (async () => {
        const c = await adminPool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config('jarvis.device_kind_change', 'on', true)");
          await c.query("UPDATE devices SET device_kind = 'watch', device_kind_source = 'trusted_provisioning' WHERE device_id = $1", [deviceId]);
          changed = true;
          await c.query("COMMIT");
        } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
      })();
      await new Promise((r) => setTimeout(r, 400));
      expect(changed, "typeendringen må vente på autorisasjonens radlås").toBe(false);
      await authClient.query("COMMIT");
    } finally {
      await authClient.query("ROLLBACK").catch(() => undefined);
      authClient.release();
    }
    await change;
    expect(changed).toBe(true);
    expect((await adminPool.query("SELECT device_kind FROM devices WHERE device_id = $1", [deviceId])).rows[0].device_kind).toBe("watch");
  });
});
