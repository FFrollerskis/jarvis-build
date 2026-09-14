import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VOICE_GRANT_TTL_MS, VoiceSessionGrantSchema } from "@jarvis/contracts";
import {
  DeviceService,
  IdentityService,
  SessionGrantService,
  SessionService,
  VoiceSessionAuthority,
  createPool,
  runMigrations
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * D-123 (UA-7, FJERDE slice) - Q-32 punkt (2), DB-siden.
 *
 * Her testes selve VEDTAKET mot ekte embedded PostgreSQL, ekte RLS og de ekte
 * kanoniske primitivene (`DeviceService` / `SessionService` /
 * `IdentityService.resolveIdentity()`) - ingen fakes, ingen etterlignet
 * identitetsmodell. Transportens tillitsgrense («kan klienten selv bli
 * `SERVER_VERIFIED`?») bevises separat i
 * `apps/voice-gateway/test/ua7-voice-session-authority.test.ts`.
 *
 * Adversarielt: hver test her er et konkret forsøk på å få en autoritet man
 * ikke skal ha - kryss-person, kryss-tenant, kryss-space, kryss-enhet,
 * tilbakekalt enhet, replay og utløpt nonce.
 */

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
/** Tobias sin ekte enhet. */
const watchKeys = generateKeyPairSync("ed25519");
/** En ANNEN person sin fullt gyldige, registrerte enhet - angriperens utgangspunkt. */
const intruderKeys = generateKeyPairSync("ed25519");
/** En nøkkel som aldri er registrert noe sted. */
const rogueKeys = generateKeyPairSync("ed25519");

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let devices: DeviceService;
let sessions: SessionService;
let authority: VoiceSessionAuthority;

const pem = (keys: { publicKey: KeyObject }): string =>
  keys.publicKey.export({ type: "spki", format: "pem" }).toString();

/** Et gyldig enhetsbevis for `deviceId`, signert med `key`. */
function proof(deviceId: string, key: Parameters<typeof sign>[2]): { challenge: string; signature: string } {
  const challenge = devices.issueChallenge(deviceId);
  return { challenge, signature: sign(null, Buffer.from(challenge, "utf8"), key).toString("base64") };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg123-"));
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
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");

  // Kanonisk oppsett. MERK: INGEN nye tabeller - dette er nøyaktig de samme
  // fire tabellene identitetsfundamentet (001/002) allerede definerer.
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind)
      VALUES ('tenant-a','Tobias','person'), ('tenant-b','Annen','business');
    INSERT INTO people (person_id, display_name)
      VALUES ('person-tobias','Tobias'), ('person-inntrenger','Inntrenger');
    INSERT INTO person_tenants (person_id, tenant_id)
      VALUES ('person-tobias','tenant-a'), ('person-inntrenger','tenant-b');
    -- 'personal' og 'health' finnes i tenant-a; 'business' finnes KUN i tenant-b.
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-a-personal','tenant-a','personal'),
      ('ms-a-health','tenant-a','health'),
      ('ms-b-business','tenant-b','business');
    -- Tilbakekalt enhet: registrert, men uten nøkkel. Dette ER den
    -- tilbakekallingstilstanden den kanoniske modellen faktisk eksponerer.
    INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES
      ('watch-tilbakekalt','tenant-a','person-tobias','watch', NULL);
  `);
  await adminPool.query(
    `INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES
       ('watch-tobias','tenant-a','person-tobias','watch', $1),
       ('phone-inntrenger','tenant-b','person-inntrenger','phone', $2)`,
    [pem(watchKeys), pem(intruderKeys)]
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "pw2" });
  devices = new DeviceService(appPool);
  sessions = new SessionService(appPool);
  authority = new VoiceSessionAuthority({
    pool: appPool,
    devices,
    sessions,
    identity: new IdentityService(appPool),
    // D-131: samme transaksjonelle autoritetskjerne som ChannelSessionAuthority.
    grants: new SessionGrantService(appPool)
  });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("D-123: VoiceSessionAuthority gir SERVER_VERIFIED kun for en faktisk bevist prinsipal", () => {
  it("A1: gyldig enhetsbevis + medlemskap + eksisterende space => SERVER_VERIFIED-grant", async () => {
    const now = Date.now();
    const result = await authority.authorize(
      {
        person_id: "person-tobias",
        tenant_id: "tenant-a",
        device_id: "watch-tobias",
        memory_space: "personal",
        device_proof: proof("watch-tobias", watchKeys.privateKey)
      },
      now
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Grant-en validerer mot det kanoniske skjemaet (literal SERVER_VERIFIED).
    expect(VoiceSessionGrantSchema.safeParse(result.grant).success).toBe(true);
    expect(result.grant.memory_space_authority).toBe("SERVER_VERIFIED");
    expect(result.grant.memory_space).toBe("personal");
    expect(result.grant.auth_strength).toBe("signed");
    expect(result.grant.expires_at_ms).toBe(now + VOICE_GRANT_TTL_MS);
    // Sesjonen er SERVER-eid: klienten oppga aldri en session_id.
    expect(result.grant.session_id).toMatch(/^sess-/);
  });

  it("A2: eksisterende sesjons-gjenopptak er UENDRET - tale gjenopptar samme aktive sesjon", async () => {
    // Fase 2 akseptansekriterium 3: samme samtale på tvers av kanaler.
    const web = await sessions.resumeOrCreate(
      { tenant_id: "tenant-a", person_id: "person-tobias", device_id: "watch-tobias" },
      "web"
    );
    const result = await authority.authorize({
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "watch-tobias",
      memory_space: "personal",
      device_proof: proof("watch-tobias", watchKeys.privateKey)
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.session_id).toBe(web.session_id);
  });

  // --- Kryss-person / kryss-tenant / kryss-space --------------------------

  it("B1: KRYSS-PERSON - en gyldig egen enhet gir ikke autoritet over en annen person", async () => {
    // Angriperen holder faktisk en registrert privatnøkkel (phone-inntrenger)
    // og signerer korrekt. Den lyver kun om HVEM den er.
    const result = await authority.authorize({
      person_id: "person-tobias",
      tenant_id: "tenant-b",
      device_id: "phone-inntrenger",
      memory_space: "business",
      device_proof: proof("phone-inntrenger", intruderKeys.privateKey)
    });

    expect(result).toEqual({ ok: false, reason: "device_proof_invalid" });
  });

  it("B2: KRYSS-PERSON gir INGEN sideeffekt på offerets server-eide sesjonsrad", async () => {
    // Selve grunnen til at enhetsbeviset kjøres FØR `resumeOrCreate()`.
    const before = await sessions.resumeOrCreate(
      { tenant_id: "tenant-b", person_id: "person-inntrenger", device_id: "phone-inntrenger" },
      "web"
    );
    const snapshot = await adminPool.query(
      "SELECT last_device_id, last_channel, last_active_at FROM sessions WHERE session_id = $1",
      [before.session_id]
    );

    const result = await authority.authorize({
      person_id: "person-inntrenger",
      tenant_id: "tenant-b",
      // Riktig person, men en enhet som tilhører en ANNEN person i en annen tenant.
      device_id: "watch-tobias",
      memory_space: "business",
      device_proof: proof("watch-tobias", watchKeys.privateKey)
    });
    expect(result).toEqual({ ok: false, reason: "device_proof_invalid" });

    const after = await adminPool.query(
      "SELECT last_device_id, last_channel, last_active_at FROM sessions WHERE session_id = $1",
      [before.session_id]
    );
    // Ingen rad ble rørt: samme enhet, samme kanal, samme tidsstempel.
    expect(after.rows[0]).toEqual(snapshot.rows[0]);
  });

  it("B3: KRYSS-TENANT - personen er ikke medlem av tenanten den påstår", async () => {
    // Enheten `watch-tobias` finnes i tenant-a. Her påstås tenant-b, der
    // person-tobias ikke er medlem. RLS gjør at enheten ikke engang er synlig.
    const result = await authority.authorize({
      person_id: "person-tobias",
      tenant_id: "tenant-b",
      device_id: "watch-tobias",
      memory_space: "business",
      device_proof: proof("watch-tobias", watchKeys.privateKey)
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["device_proof_invalid", "unknown_membership"]).toContain(result.reason);
  });

  it("B4: KRYSS-SPACE - en space som ikke finnes i tenanten kan ikke autoriseres", async () => {
    // 'business' finnes KUN i tenant-b. Tobias i tenant-a kan ikke få den,
    // selv med et helt gyldig enhetsbevis.
    const result = await authority.authorize({
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "watch-tobias",
      memory_space: "business",
      device_proof: proof("watch-tobias", watchKeys.privateKey)
    });

    expect(result).toEqual({ ok: false, reason: "unknown_memory_space" });
  });

  it("B5: en TILLATT space gis, en IKKE-tillatt nektes - for samme beviste prinsipal", async () => {
    // Positiv og negativ side av NØYAKTIG samme prinsipal: beviset avgjør
    // ikke space-en, den kanoniske identitets-stien gjør.
    const allowed = await authority.authorize({
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "watch-tobias",
      memory_space: "health",
      device_proof: proof("watch-tobias", watchKeys.privateKey)
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.grant.memory_space).toBe("health");

    const denied = await authority.authorize({
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "watch-tobias",
      memory_space: "guest",
      device_proof: proof("watch-tobias", watchKeys.privateKey)
    });
    expect(denied).toEqual({ ok: false, reason: "unknown_memory_space" });
  });

  // --- Enhets-/bevis-tilstander de kanoniske primitivene eksponerer -------

  it("C1: TILBAKEKALT enhet (ingen registrert nøkkel) kan ikke bevise seg", async () => {
    const result = await authority.authorize({
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "watch-tilbakekalt",
      memory_space: "personal",
      // Signert med Tobias sin ekte nøkkel - men enheten har ingen registrert
      // offentlig nøkkel å verifisere mot lenger.
      device_proof: proof("watch-tilbakekalt", watchKeys.privateKey)
    });

    expect(result).toEqual({ ok: false, reason: "device_proof_invalid" });
  });

  it("C2: UKJENT enhet avvises", async () => {
    const result = await authority.authorize({
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "dev-finnes-ikke",
      memory_space: "personal",
      device_proof: proof("dev-finnes-ikke", rogueKeys.privateKey)
    });

    expect(result).toEqual({ ok: false, reason: "device_proof_invalid" });
  });

  it("C3: FEIL nøkkel avvises selv for en registrert enhet", async () => {
    const result = await authority.authorize({
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "watch-tobias",
      memory_space: "personal",
      device_proof: proof("watch-tobias", rogueKeys.privateKey)
    });

    expect(result).toEqual({ ok: false, reason: "device_proof_invalid" });
  });

  it("C4: REPLAY av en allerede brukt challenge avvises andre gang", async () => {
    const evidence = {
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "watch-tobias",
      memory_space: "personal",
      device_proof: proof("watch-tobias", watchKeys.privateKey)
    };

    expect((await authority.authorize(evidence)).ok).toBe(true);
    // Nøyaktig samme bevis, sendt på nytt.
    expect(await authority.authorize(evidence)).toEqual({ ok: false, reason: "device_proof_invalid" });
  });

  it("C5: UTLØPT challenge avvises (60 s TTL i den eksisterende primitiven)", async () => {
    const evidence = {
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "watch-tobias",
      memory_space: "personal",
      device_proof: proof("watch-tobias", watchKeys.privateKey)
    };

    // Bare klokka flyttes - ingen kunstig tilstand settes i `DeviceService`.
    const real = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(real + 61_000);
    try {
      expect(await authority.authorize(evidence)).toEqual({ ok: false, reason: "device_proof_invalid" });
    } finally {
      spy.mockRestore();
    }
  });

  // --- Bevismaterialet valideres fail-closed ------------------------------

  it("D1: ugyldig/smuglet bevismateriale gir malformed_evidence - aldri en delvis grant", async () => {
    const base = {
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "watch-tobias",
      memory_space: "personal"
    };
    const valid = proof("watch-tobias", watchKeys.privateKey);

    for (const bad of [
      undefined,
      null,
      "streng",
      {},
      { ...base }, // uten device_proof
      { ...base, device_proof: valid, memory_space_authority: "SERVER_VERIFIED" }, // smuglet autoritet
      { ...base, device_proof: valid, session_id: "sess-valgt-selv" }, // selvvalgt sesjon
      { ...base, memory_space: "hemmelig", device_proof: valid }, // ukjent space
      { ...base, device_proof: { challenge: "", signature: "" } }
    ]) {
      expect(await authority.authorize(bad)).toEqual({ ok: false, reason: "malformed_evidence" });
    }
  });

  it("D2: et avvist bevis produserer ALDRI en grant-formet verdi", async () => {
    const result = await authority.authorize({
      person_id: "person-tobias",
      tenant_id: "tenant-a",
      device_id: "watch-tobias",
      memory_space: "personal",
      device_proof: proof("watch-tobias", rogueKeys.privateKey)
    });

    expect(result.ok).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
    expect("grant" in result).toBe(false);
  });
});
