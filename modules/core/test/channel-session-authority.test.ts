import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  ChannelSessionAuthority,
  DeviceService,
  IdentityService,
  SessionGrantService,
  SessionService,
  createPool,
  runMigrations
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * UA-7-generalisering av D-123 (`voice-session-authority.ts`): beviser at
 * `ChannelSessionAuthority` gir NØYAKTIG den samme betrodde
 * sesjons-/identitetsautoriteten som `VoiceSessionAuthority`, men for en
 * hvilken som helst `Channel` - `mobile`, `watch`, `desktop` (den kanoniske
 * local-agent-kontrakten for Mac/Windows) og en eksplisitt kanalbytte
 * (`mobile` → `web`) som beviser server-eid sesjonskontinuitet på tvers av
 * kanaler.
 *
 * Ekte embedded PostgreSQL, ekte RLS, ekte kanoniske primitiver - ingen
 * fakes, ingen etterlignet identitetsmodell. Samme adversarielle disiplin som
 * D-123 sin egen testfil (`d123-voice-session-authority.test.ts`): hver
 * negativ test er et konkret forsøk på å få en autoritet man ikke skal ha.
 */

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
/** Tobias sine ekte enheter - én per kanal-kontekst, akkurat som i produksjon. */
const phoneKeys = generateKeyPairSync("ed25519");
const watchKeys = generateKeyPairSync("ed25519");
const macKeys = generateKeyPairSync("ed25519");
/** En ANNEN person sin fullt gyldige, registrerte enhet - angriperens utgangspunkt. */
const intruderKeys = generateKeyPairSync("ed25519");

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let devices: DeviceService;
let sessions: SessionService;
let authority: ChannelSessionAuthority;

const pem = (keys: { publicKey: KeyObject }): string =>
  keys.publicKey.export({ type: "spki", format: "pem" }).toString();

/** Et gyldig enhetsbevis for `deviceId`, signert med `key`. */
function proof(deviceId: string, key: Parameters<typeof sign>[2]): { challenge: string; signature: string } {
  const challenge = devices.issueChallenge(deviceId);
  return { challenge, signature: sign(null, Buffer.from(challenge, "utf8"), key).toString("base64") };
}

/** Registrering av tjenesteidentiteten som skriver enheter/audit i seed-fasen. */
const seedIdentity: IdentityContext = {
  person_id: "person-tobias",
  tenant_id: "tenant-a",
  memory_space_id: "personal",
  session_id: "sess-seed",
  device_id: "seed-device",
  channel: "system",
  auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-chsess-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_chsess LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_chsess");

  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind)
      VALUES ('tenant-a','Tobias','person'), ('tenant-b','Annen','business');
    INSERT INTO people (person_id, display_name)
      VALUES ('person-tobias','Tobias'), ('person-inntrenger','Inntrenger');
    INSERT INTO person_tenants (person_id, tenant_id)
      VALUES ('person-tobias','tenant-a'), ('person-inntrenger','tenant-b');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-a-personal','tenant-a','personal'),
      ('ms-b-business','tenant-b','business');
    -- Seed-enheten "system"-tjenesten skriver enhetsregistrering/audit med.
    INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem)
      VALUES ('seed-device','tenant-a','person-tobias','service', NULL);
  `);
  await adminPool.query(
    `INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES
       ('phone-inntrenger','tenant-b','person-inntrenger','phone', $1)`,
    [pem(intruderKeys)]
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_chsess", password: "pw2" });
  devices = new DeviceService(appPool);
  sessions = new SessionService(appPool);
  authority = new ChannelSessionAuthority({
    pool: appPool,
    devices,
    sessions,
    identity: new IdentityService(appPool),
    // D-131: autoriteten utsteder nå et avgrenset, revokerbart grant i SAMME
    // transaksjon som sesjonen - se modules/core/src/services/device-authority.ts.
    grants: new SessionGrantService(appPool)
  });

  // Tobias sine tre kanal-enheter seedes via `registerDeviceTrusted()` - den
  // BETRODDE server-side provisjoneringsprimitiven, ikke en nettverksvei.
  // D-131 funn 2: den nettverksnære innrulleringen går gjennom
  // `DeviceEnrollmentService` og krever eksplisitt eier-/bootstrap-autoritet;
  // den testes for seg i `apps/api/test/d131-authority-hardening-e2e.test.ts`.
  // `kind = 'desktop-agent'` dekker local-agent-kontrakten (masterplan del 2).
  await devices.registerDeviceTrusted(seedIdentity,{ device_id: "phone-tobias", kind: "mobile", public_key_pem: pem(phoneKeys) });
  await devices.registerDeviceTrusted(seedIdentity,{ device_id: "watch-tobias", kind: "watch", public_key_pem: pem(watchKeys) });
  await devices.registerDeviceTrusted(seedIdentity,{ device_id: "mac-tobias", kind: "desktop-agent", public_key_pem: pem(macKeys) });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("ChannelSessionAuthority: samme betrodde autoritet som D-123, generalisert til enhver kanal", () => {
  it("A: mobile-kanal med gyldig enhetsbevis => betrodd identitet, server-eid sesjon", async () => {
    const result = await authority.authorize("mobile", {
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "phone-tobias",
      memory_space: "personal",
      device_proof: proof("phone-tobias", phoneKeys.privateKey)
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.channel).toBe("mobile");
    expect(result.identity.auth_strength).toBe("signed");
    expect(result.identity.memory_space_id).toBe("personal");
    expect(result.identity.person_id).toBe("person-tobias");
    expect(result.identity.session_id).toMatch(/^sess-/);
  });

  it("B: watch-kanal med gyldig enhetsbevis => samme autoritet, annen kanal", async () => {
    const result = await authority.authorize("watch", {
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "watch-tobias",
      memory_space: "personal",
      device_proof: proof("watch-tobias", watchKeys.privateKey)
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.channel).toBe("watch");
    expect(result.identity.auth_strength).toBe("signed");
  });

  it("C/G: desktop-kanal (kanonisk local-agent-kontrakt, Mac/Windows) - registrer nøkkel, bevis besittelse, autoriser", async () => {
    // Dette ER local-agent-kontrakten: en `devices`-rad med kind
    // 'desktop-agent' (registrert i beforeAll via DEN VANLIGE
    // `registerDevice()`-primitiven), som beviser besittelse gjennom DEN
    // SAMME `DeviceService.verifyChallenge()`-challengen som enhver annen
    // enhet, og autoriseres via `ChannelSessionAuthority` med
    // `channel = "desktop"`. Ingen egen server-side primitiv kreves utover
    // dette - se D-64-vurderingen i sluttrapporten.
    const challenge = devices.issueChallenge("mac-tobias");
    const signature = sign(null, Buffer.from(challenge, "utf8"), macKeys.privateKey).toString("base64");

    const result = await authority.authorize("desktop", {
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "mac-tobias",
      memory_space: "personal",
      device_proof: { challenge, signature }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.channel).toBe("desktop");
    expect(result.identity.device_id).toBe("mac-tobias");
    expect(result.identity.auth_strength).toBe("signed");
    expect(result.session.session_id).toMatch(/^sess-/);

    // Enheten som faktisk ble bevist er registrert som 'desktop-agent'.
    const row = await adminPool.query("SELECT kind FROM devices WHERE device_id = 'mac-tobias'");
    expect((row.rows[0] as { kind: string }).kind).toBe("desktop-agent");
  });

  it("D: kanalbytte (mobile -> web) gjenopptar SAMME server-eide sesjon, ikke en ny", async () => {
    const onMobile = await authority.authorize("mobile", {
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "phone-tobias",
      memory_space: "personal",
      device_proof: proof("phone-tobias", phoneKeys.privateKey)
    });
    expect(onMobile.ok).toBe(true);
    if (!onMobile.ok) return;

    const onWeb = await authority.authorize("web", {
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "phone-tobias",
      memory_space: "personal",
      device_proof: proof("phone-tobias", phoneKeys.privateKey)
    });
    expect(onWeb.ok).toBe(true);
    if (!onWeb.ok) return;

    // SAMME session_id begge veier - klienten har aldri oppgitt den selv,
    // serveren har gjenopptatt personens ene aktive sesjon på tvers av kanal.
    expect(onWeb.identity.session_id).toBe(onMobile.identity.session_id);
    expect(onWeb.session.resumed).toBe(true);
    expect(onWeb.identity.channel).toBe("web");
    expect(onMobile.identity.channel).toBe("mobile");
  });

  it("E: enhetsbevis bundet til FEIL person avvises uansett kanal", async () => {
    // Angriperen holder en ekte, registrert privatnøkkel (phone-inntrenger)
    // og signerer korrekt - den lyver kun om HVEM den er. Prøves på to ulike
    // kanaler for å bevise at bindingen ikke er kanalspesifikk.
    const onMobile = await authority.authorize("mobile", {
      person_id: "person-tobias",
      tenant_id: "tenant-b",
      device_id: "phone-inntrenger",
      memory_space: "business",
      device_proof: proof("phone-inntrenger", intruderKeys.privateKey)
    });
    expect(onMobile).toEqual({ ok: false, reason: "device_proof_invalid" });

    const onDesktop = await authority.authorize("desktop", {
      person_id: "person-tobias",
      tenant_id: "tenant-b",
      device_id: "phone-inntrenger",
      memory_space: "business",
      device_proof: proof("phone-inntrenger", intruderKeys.privateKey)
    });
    expect(onDesktop).toEqual({ ok: false, reason: "device_proof_invalid" });
  });

  it("kryss-person gir INGEN sideeffekt på offerets server-eide sesjonsrad (samme grunn som D-123 B2)", async () => {
    const before = await sessions.resumeOrCreate(
      { tenant_id: "tenant-b", person_id: "person-inntrenger", device_id: "phone-inntrenger" },
      "web"
    );
    const snapshot = await adminPool.query(
      "SELECT last_device_id, last_channel, last_active_at FROM sessions WHERE session_id = $1",
      [before.session_id]
    );

    const result = await authority.authorize("desktop", {
      person_id: "person-inntrenger",
      tenant_id: "tenant-b",
      // Riktig person, men en enhet som tilhører en ANNEN person i en annen tenant.
      device_id: "phone-tobias",
      memory_space: "business",
      device_proof: proof("phone-tobias", phoneKeys.privateKey)
    });
    expect(result).toEqual({ ok: false, reason: "device_proof_invalid" });

    const after = await adminPool.query(
      "SELECT last_device_id, last_channel, last_active_at FROM sessions WHERE session_id = $1",
      [before.session_id]
    );
    expect(after.rows[0]).toEqual(snapshot.rows[0]);
  });

  it("bevismateriale valideres fail-closed - smuglede felt gir malformed_evidence, aldri en delvis grant", async () => {
    const valid = proof("phone-tobias", phoneKeys.privateKey);
    const base = { person_id: "person-tobias", tenant_id: "tenant-a", device_id: "phone-tobias", memory_space: "personal" };

    for (const bad of [
      undefined,
      null,
      "streng",
      {},
      { ...base }, // uten device_proof
      { ...base, device_proof: valid, session_id: "sess-valgt-selv" }, // selvvalgt sesjon smuglet inn
      { ...base, device_proof: valid, channel: "desktop" }, // kanal skal komme fra kalleren, ikke bevismaterialet
      { ...base, memory_space: "hemmelig", device_proof: valid } // ukjent space-verdi
    ]) {
      const result = await authority.authorize("mobile", bad);
      expect(result).toEqual({ ok: false, reason: "malformed_evidence" });
    }
  });
});
