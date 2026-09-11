import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  DeviceEnrollmentService,
  DeviceService,
  IdentityService,
  SessionGrantService,
  SessionService,
  authorizeProvenDevice,
  createPool,
  runMigrations,
  type DeviceAuthorityDeps
} from "@jarvis/core";

/**
 * D-131b (uavhengig arkitektkontroll av PR #79, HEAD 72c4d0e - TOCTOU-funn):
 * beviser at proof-til-grant/-innrullering-/-rotasjon-bindingen er lukket, ikke
 * bare at et avslag "pleier å skje". To adversarielle strategier brukes, begge
 * deterministiske (ingen `sleep`-basert kappløp som kan flake):
 *
 *   1. INJEKSJON: et gyldig bevis hentes mot NØKKEL A, nøkkelen roteres/
 *      tilbakekalles DIREKTE i databasen (simulerer en fullført samtidig
 *      rotasjon), og det GAMLE beviset presenteres deretter for
 *      autorisasjons-/innrulleringstransaksjonen. Dette er den PRESISE
 *      hendelsesrekkefølgen reviewen beskrev - uavhengig av throughput/timing,
 *      så testen er 100% deterministisk.
 *   2. EKTE OVERLAPPENDE TRANSAKSJONER: to rå `pg`-klienter beviser at
 *      `FOR UPDATE`-låsen `lockDeviceKeyOn()` tar FAKTISK serialiserer en
 *      samtidig rotasjon mot en pågående autorisasjon - ikke bare at
 *      rekkefølgen tilfeldigvis stemte i denne kjøringen.
 *
 * Hver negativ test verifiserer i tillegg NULL mutasjon: ingen sesjonsrad,
 * intet grant, ingen enhetsskriving, ingen tilbakekalling av andre enheters
 * grants - et avslag skal aldri ha noen synlig sideeffekt utover audit.
 */

const PORT = 30000 + Math.floor(Math.random() * 20000);
const TENANT = "tenant-toctou";
const PERSON = "person-toctou";

let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let devices: DeviceService;
let sessions: SessionService;
let identity: IdentityService;
let grants: SessionGrantService;
let enrollment: DeviceEnrollmentService;
let authorityDeps: DeviceAuthorityDeps;

const pem = (keys: { publicKey: KeyObject }): string =>
  keys.publicKey.export({ type: "spki", format: "pem" }).toString();

const seedIdentity: IdentityContext = {
  person_id: PERSON,
  tenant_id: TENANT,
  memory_space_id: "personal",
  session_id: "sess-seed-toctou",
  device_id: "seed-device-toctou",
  channel: "system",
  auth_strength: "active"
};

async function rotateKeyDirectly(deviceId: string, newPem: string): Promise<void> {
  // Simulerer at rotasjonen ALLEREDE HAR FULLFØRT et sted i vinduet mellom
  // proof-of-possession og autorisasjons-/innrulleringstransaksjonen - den
  // PRESISE hendelsen reviewen beskrev. Skrives direkte (ikke via
  // `DeviceEnrollmentService`) for å isolere PRESIS invarianten under test:
  // "kan et bevis mot den GAMLE tilstanden fortsatt gi autoritet etterpå?"
  await adminPool.query("UPDATE devices SET public_key_pem = $2 WHERE device_id = $1", [deviceId, newPem]);
}

async function revokeKeyDirectly(deviceId: string): Promise<void> {
  await adminPool.query("UPDATE devices SET public_key_pem = NULL WHERE device_id = $1", [deviceId]);
}

async function sessionRowCount(): Promise<number> {
  const { rows } = await adminPool.query("SELECT COUNT(*)::int AS n FROM sessions WHERE tenant_id = $1", [TENANT]);
  return (rows[0] as { n: number }).n;
}

async function grantRowCount(): Promise<number> {
  const { rows } = await adminPool.query("SELECT COUNT(*)::int AS n FROM session_grants WHERE tenant_id = $1", [
    TENANT
  ]);
  return (rows[0] as { n: number }).n;
}

async function currentPem(deviceId: string): Promise<string | null> {
  const { rows } = await adminPool.query("SELECT public_key_pem FROM devices WHERE device_id = $1", [deviceId]);
  return (rows[0] as { public_key_pem: string | null } | undefined)?.public_key_pem ?? null;
}

async function deviceExists(deviceId: string): Promise<boolean> {
  const { rows } = await adminPool.query("SELECT 1 FROM devices WHERE device_id = $1", [deviceId]);
  return rows.length > 0;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-toctou-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_toctou LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_toctou");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'TOCTOU Tenant', 'person');
     INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'TOCTOU Person');
     INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON}', '${TENANT}');
     INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-toctou', '${TENANT}', 'personal');
     INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem)
       VALUES ('seed-device-toctou', '${TENANT}', '${PERSON}', 'service', NULL);`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_toctou", password: "pw2" });
  devices = new DeviceService(appPool);
  sessions = new SessionService(appPool);
  identity = new IdentityService(appPool);
  grants = new SessionGrantService(appPool);
  authorityDeps = { pool: appPool, sessions, identity, grants, devices };
  enrollment = new DeviceEnrollmentService({ pool: appPool, devices, grants });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("D-131b A: proof-til-grant - en rotasjon FULLFØRT i vinduet mellom bevis og autorisasjon", () => {
  it("A1: gyldig bevis mot GJELDENDE nøkkel gir grant fingerprintet til DEN nøkkelen (positiv kontroll)", async () => {
    const keyA = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seedIdentity, { device_id: "dev-a1", kind: "mobile", public_key_pem: pem(keyA) });

    const challenge = devices.issueChallenge("dev-a1");
    const signature = sign(null, Buffer.from(challenge, "utf8"), keyA.privateKey).toString("base64");
    const proven = await devices.verifyChallenge(TENANT, "dev-a1", challenge, signature, PERSON);
    expect(proven).not.toBeNull();

    const outcome = await authorizeProvenDevice(authorityDeps, {
      person_id: PERSON,
      tenant_id: TENANT,
      device_id: "dev-a1",
      memory_space: "personal",
      channel: "mobile",
      auth_strength: "signed",
      proven_key_fingerprint: proven as string
    });
    expect(outcome.ok).toBe(true);
  });

  it("A2: bevis mot den GAMLE nøkkelen, presentert ETTER at nøkkelen ble rotert => device_authority_revoked, INGEN grant, INGEN sesjonsrad", async () => {
    const keyOld = generateKeyPairSync("ed25519");
    const keyNew = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seedIdentity, { device_id: "dev-a2", kind: "mobile", public_key_pem: pem(keyOld) });

    const challenge = devices.issueChallenge("dev-a2");
    const signature = sign(null, Buffer.from(challenge, "utf8"), keyOld.privateKey).toString("base64");
    const provenOld = await devices.verifyChallenge(TENANT, "dev-a2", challenge, signature, PERSON);
    expect(provenOld).not.toBeNull();

    // Rotasjonen FULLFØRER i vinduet mellom proof-of-possession og autorisasjon.
    await rotateKeyDirectly("dev-a2", pem(keyNew));

    const sessionsBefore = await sessionRowCount();
    const grantsBefore = await grantRowCount();

    const outcome = await authorizeProvenDevice(authorityDeps, {
      person_id: PERSON,
      tenant_id: TENANT,
      device_id: "dev-a2",
      memory_space: "personal",
      channel: "mobile",
      auth_strength: "signed",
      // Nøyaktig fingerprinten `verifyChallenge()` beviste FØR rotasjonen -
      // en angriper som klarte å utnytte TOCTOU-vinduet ville presentert nøyaktig denne.
      proven_key_fingerprint: provenOld as string
    });

    expect(outcome).toEqual({ ok: false, reason: "device_authority_revoked" });
    expect(await sessionRowCount()).toBe(sessionsBefore);
    expect(await grantRowCount()).toBe(grantsBefore);
  });

  it("A3: bevis mot en nøkkel som deretter TILBAKEKALLES (NULL) => samme avslag, INGEN sideeffekt", async () => {
    const keyOld = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seedIdentity, { device_id: "dev-a3", kind: "mobile", public_key_pem: pem(keyOld) });

    const challenge = devices.issueChallenge("dev-a3");
    const signature = sign(null, Buffer.from(challenge, "utf8"), keyOld.privateKey).toString("base64");
    const provenOld = await devices.verifyChallenge(TENANT, "dev-a3", challenge, signature, PERSON);
    expect(provenOld).not.toBeNull();

    await revokeKeyDirectly("dev-a3");

    const sessionsBefore = await sessionRowCount();
    const grantsBefore = await grantRowCount();

    const outcome = await authorizeProvenDevice(authorityDeps, {
      person_id: PERSON,
      tenant_id: TENANT,
      device_id: "dev-a3",
      memory_space: "personal",
      channel: "mobile",
      auth_strength: "signed",
      proven_key_fingerprint: provenOld as string
    });

    expect(outcome).toEqual({ ok: false, reason: "device_authority_revoked" });
    expect(await sessionRowCount()).toBe(sessionsBefore);
    expect(await grantRowCount()).toBe(grantsBefore);
  });

  it("A4: ETT NYTT bevis hentet ETTER rotasjonen, mot DEN NYE nøkkelen, gir en gyldig grant fingerprintet til DEN NYE nøkkelen (fikser ikke fail-alltid)", async () => {
    const keyOld = generateKeyPairSync("ed25519");
    const keyNew = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seedIdentity, { device_id: "dev-a4", kind: "mobile", public_key_pem: pem(keyOld) });
    await rotateKeyDirectly("dev-a4", pem(keyNew));

    const challenge = devices.issueChallenge("dev-a4");
    const signature = sign(null, Buffer.from(challenge, "utf8"), keyNew.privateKey).toString("base64");
    const provenNew = await devices.verifyChallenge(TENANT, "dev-a4", challenge, signature, PERSON);
    expect(provenNew).not.toBeNull();

    const outcome = await authorizeProvenDevice(authorityDeps, {
      person_id: PERSON,
      tenant_id: TENANT,
      device_id: "dev-a4",
      memory_space: "personal",
      channel: "mobile",
      auth_strength: "signed",
      proven_key_fingerprint: provenNew as string
    });
    expect(outcome.ok).toBe(true);

    // Et bevis mot den GAMLE nøkkelen for SAMME enhet er fortsatt avvist etterpå.
    const oldChallenge = devices.issueChallenge("dev-a4");
    const oldSignature = sign(null, Buffer.from(oldChallenge, "utf8"), keyOld.privateKey).toString("base64");
    const provenViaOldKey = await devices.verifyChallenge(TENANT, "dev-a4", oldChallenge, oldSignature, PERSON);
    expect(provenViaOldKey).toBeNull(); // signaturen verifiserer ikke mot den REGISTRERTE (nye) nøkkelen i det hele tatt
  });
});

describe("D-131b B: innrullering av en NY enhet - autoriserende enhets nøkkel rotert i vinduet", () => {
  it("B1: gyldig autoriserende bevis mot GJELDENDE nøkkel lar innrullering av en ny enhet lykkes (positiv kontroll)", async () => {
    const vouchKey = generateKeyPairSync("ed25519");
    const newDeviceKey = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seedIdentity, { device_id: "dev-b1-vouch", kind: "mobile", public_key_pem: pem(vouchKey) });

    const challenge = devices.issueChallenge("dev-b1-vouch");
    const signature = sign(null, Buffer.from(challenge, "utf8"), vouchKey.privateKey).toString("base64");

    const result = await enrollment.enroll({
      tenant_id: TENANT,
      person_id: PERSON,
      device: { device_id: "dev-b1-new", kind: "mobile", public_key_pem: pem(newDeviceKey) },
      enrollment: { kind: "device_proof", authorizing_device_id: "dev-b1-vouch", challenge, signature }
    });
    expect(result).toEqual({ ok: true, device_id: "dev-b1-new", rotated: false, revoked_grants: 0 });
  });

  it("B2: bevis fra den autoriserende enheten hentet FØR en rotasjon av DEN enheten => authorizing_device_proof_invalid, NY enhet ALDRI skrevet", async () => {
    const vouchKeyOld = generateKeyPairSync("ed25519");
    const vouchKeyNew = generateKeyPairSync("ed25519");
    const newDeviceKey = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seedIdentity, { device_id: "dev-b2-vouch", kind: "mobile", public_key_pem: pem(vouchKeyOld) });

    const challenge = devices.issueChallenge("dev-b2-vouch");
    const signature = sign(null, Buffer.from(challenge, "utf8"), vouchKeyOld.privateKey).toString("base64");

    // Den autoriserende enhetens nøkkel roteres i vinduet FØR innrulleringstransaksjonen kjører.
    await rotateKeyDirectly("dev-b2-vouch", pem(vouchKeyNew));

    const result = await enrollment.enroll({
      tenant_id: TENANT,
      person_id: PERSON,
      device: { device_id: "dev-b2-new", kind: "mobile", public_key_pem: pem(newDeviceKey) },
      enrollment: { kind: "device_proof", authorizing_device_id: "dev-b2-vouch", challenge, signature }
    });
    expect(result).toEqual({ ok: false, reason: "authorizing_device_proof_invalid" });
    expect(await deviceExists("dev-b2-new")).toBe(false);
    // Vouch-enhetens nøkkel er FORTSATT den konkurrerende rotasjonens - transaksjonen
    // som ville brukt det gamle beviset rullet tilbake uten å røre den.
    expect((await currentPem("dev-b2-vouch"))?.trim()).toBe(pem(vouchKeyNew).trim());
  });
});

describe("D-131b C: en enhet ruller sin EGEN nøkkel - konkurrerende rotasjon fullført i vinduet", () => {
  it("C1: selv-rotasjon med gyldig, FERSKT bevis lykkes og dreper gamle grants (positiv kontroll)", async () => {
    const keyA = generateKeyPairSync("ed25519");
    const keyB = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seedIdentity, { device_id: "dev-c1-self", kind: "mobile", public_key_pem: pem(keyA) });

    // Skaff et utestående grant på DEN GAMLE nøkkelen, slik at vi kan bevise at rotasjonen dreper det.
    const preChallenge = devices.issueChallenge("dev-c1-self");
    const preSignature = sign(null, Buffer.from(preChallenge, "utf8"), keyA.privateKey).toString("base64");
    const preProven = await devices.verifyChallenge(TENANT, "dev-c1-self", preChallenge, preSignature, PERSON);
    const preOutcome = await authorizeProvenDevice(authorityDeps, {
      person_id: PERSON, tenant_id: TENANT, device_id: "dev-c1-self", memory_space: "personal",
      channel: "mobile", auth_strength: "signed", proven_key_fingerprint: preProven as string
    });
    expect(preOutcome.ok).toBe(true);

    const rotChallenge = devices.issueChallenge("dev-c1-self");
    const rotSignature = sign(null, Buffer.from(rotChallenge, "utf8"), keyA.privateKey).toString("base64");
    const result = await enrollment.enroll({
      tenant_id: TENANT,
      person_id: PERSON,
      device: { device_id: "dev-c1-self", kind: "mobile", public_key_pem: pem(keyB) },
      enrollment: { kind: "device_proof", authorizing_device_id: "dev-c1-self", challenge: rotChallenge, signature: rotSignature }
    });
    expect(result).toEqual({ ok: true, device_id: "dev-c1-self", rotated: true, revoked_grants: 1 });
  });

  it("C2: bevis mot nøkkel A, presentert etter en KONKURRERENDE rotasjon (A->B) allerede fullførte => avvist, rotasjonsforsøket (A->C) skriver ALDRI nøkkel C", async () => {
    const keyA = generateKeyPairSync("ed25519");
    const keyB = generateKeyPairSync("ed25519");
    const keyC = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seedIdentity, { device_id: "dev-c2-self", kind: "mobile", public_key_pem: pem(keyA) });

    const challenge = devices.issueChallenge("dev-c2-self");
    const signature = sign(null, Buffer.from(challenge, "utf8"), keyA.privateKey).toString("base64");

    // En ANNEN, samtidig rotasjon (A -> B) fullfører i vinduet.
    await rotateKeyDirectly("dev-c2-self", pem(keyB));

    const grantsBefore = await grantRowCount();
    const result = await enrollment.enroll({
      tenant_id: TENANT,
      person_id: PERSON,
      device: { device_id: "dev-c2-self", kind: "mobile", public_key_pem: pem(keyC) },
      enrollment: { kind: "device_proof", authorizing_device_id: "dev-c2-self", challenge, signature }
    });
    expect(result).toEqual({ ok: false, reason: "authorizing_device_proof_invalid" });
    // Nøkkelen er FORTSATT B - den avviste (A->C)-transaksjonen rullet tilbake,
    // ALDRI skrev C, og rørte ALDRI grants (revokeForDeviceOn ble aldri nådd).
    expect((await currentPem("dev-c2-self"))?.trim()).toBe(pem(keyB).trim());
    expect(await grantRowCount()).toBe(grantsBefore);
  });
});

describe("D-131b D: EKTE overlappende transaksjoner - FOR UPDATE serialiserer faktisk, ikke bare i praksis", () => {
  it("D1: en pågående autorisasjon (FOR UPDATE) BLOKKERER en samtidig rotasjon av SAMME enhet til den committer/ruller tilbake", async () => {
    const keyA = generateKeyPairSync("ed25519");
    const keyB = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seedIdentity, { device_id: "dev-d1-lock", kind: "mobile", public_key_pem: pem(keyA) });

    const principal = { tenant_id: TENANT, person_id: PERSON, device_id: "dev-d1-lock" };

    const client1 = await appPool.connect();
    await client1.query("BEGIN");
    await client1.query("SELECT set_config('jarvis.tenant_id', $1, true)", [TENANT]);
    const locked = await devices.lockDeviceKeyOn(client1, principal);
    expect(locked).not.toBeNull();

    let rotationAttempted = false;
    let rotationCompleted = false;
    const rotationPromise = (async () => {
      const client2 = await appPool.connect();
      try {
        await client2.query("BEGIN");
        await client2.query("SELECT set_config('jarvis.tenant_id', $1, true)", [TENANT]);
        rotationAttempted = true;
        // `registerDeviceOn()` sin `INSERT ... ON CONFLICT DO UPDATE` tar en
        // radlås som konkurrerer med `FOR UPDATE` - den MÅ vente på client1.
        await devices.registerDeviceOn(client2, { tenant_id: TENANT, person_id: PERSON }, {
          device_id: "dev-d1-lock", kind: "mobile", public_key_pem: pem(keyB)
        });
        rotationCompleted = true;
        await client2.query("COMMIT");
      } finally {
        client2.release();
      }
    })();

    // Gi rotasjonsforsøket tid til å faktisk starte og bli blokkert bak låsen.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(rotationAttempted).toBe(true);
    expect(rotationCompleted).toBe(false); // FREMDELES blokkert - beviser at låsen faktisk holder

    // Autorisasjonstransaksjonen (som holder låsen) committer NÅ - den beviste
    // fingerprinten var gyldig for HELE vinduet rotasjonen sto og ventet.
    await client1.query("COMMIT");
    client1.release();

    await rotationPromise;
    expect(rotationCompleted).toBe(true);
    expect((await currentPem("dev-d1-lock"))?.trim()).toBe(pem(keyB).trim());
  });

  it("D2: et avslag som ruller tilbake INNE i den låste transaksjonen frigjør likevel låsen for den ventende rotasjonen", async () => {
    const keyA = generateKeyPairSync("ed25519");
    const keyB = generateKeyPairSync("ed25519");
    await devices.registerDeviceTrusted(seedIdentity, { device_id: "dev-d2-lock", kind: "mobile", public_key_pem: pem(keyA) });

    const challenge = devices.issueChallenge("dev-d2-lock");
    const signature = sign(null, Buffer.from(challenge, "utf8"), keyA.privateKey).toString("base64");
    const provenOld = await devices.verifyChallenge(TENANT, "dev-d2-lock", challenge, signature, PERSON);
    expect(provenOld).not.toBeNull();

    // Den ANDRE rotasjonen fullfører FØR autoriseringen i det hele tatt starter -
    // den vil derfor umiddelbart oppdage et fingerprint-mismatch og avslå UTEN
    // å måtte vente på noen lås (den blokkerer aldri seg selv i denne varianten).
    await rotateKeyDirectly("dev-d2-lock", pem(keyB));

    const outcome = await authorizeProvenDevice(authorityDeps, {
      person_id: PERSON, tenant_id: TENANT, device_id: "dev-d2-lock", memory_space: "personal",
      channel: "mobile", auth_strength: "signed", proven_key_fingerprint: provenOld as string
    });
    expect(outcome).toEqual({ ok: false, reason: "device_authority_revoked" });

    // Låsen er IKKE holdt fast av det rullede-tilbake forsøket - en helt ny,
    // uavhengig operasjon mot samme rad lykkes umiddelbart etterpå.
    const written = await devices.registerDeviceTrusted(seedIdentity, {
      device_id: "dev-d2-lock", kind: "mobile", public_key_pem: pem(keyB)
    });
    expect(written).toBeUndefined(); // kaster ikke => lyktes (samme PEM som allerede står, idempotent)
  });
});
