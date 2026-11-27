import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_KINDS, ENROLLABLE_DEVICE_KINDS, type DeviceKind, type EnrollableDeviceKind } from "@jarvis/contracts";
import {
  DeviceEnrollmentService,
  DeviceService,
  SessionGrantService,
  authorizingKindMayVouch,
  createEnrollmentTicket,
  createPool,
  decideEnrollmentKind,
  runMigrations,
  type DeviceEnrollmentResult
} from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * WP-S1 K3/K5: ENHETSTYPEN SETTES KUN AV SERVEREN ved innrulling. Billetten bærer typen; klienten kan ikke velge eller endre den; `device_proof` endrer aldri typen; en enhet uten step-up-kanal kan ikke re-nøkle en
 * enhet som har en (ellers kunne en kompromittert Watch overta eierens iPhone og omgå kanalbindingen). Ekte embedded Postgres, ekte RLS (app-rolle), ekte Ed25519-bevis.
 */
const TENANT = "tenant-s1e";
const PERSON = "person-s1e";
const STEP_UP_KINDS: readonly DeviceKind[] = ["iphone", "mac", "windows", "web_browser", "api_client"];

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let devices: DeviceService;
let grants: SessionGrantService;
let enforce: DeviceEnrollmentService;
let observe: DeviceEnrollmentService;
let plain: DeviceEnrollmentService;
const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
let counter = 0;

const pem = (k: { publicKey: KeyObject }): string => k.publicKey.export({ type: "spki", format: "pem" }).toString();
const fresh = (prefix: string): string => `${prefix}-${++counter}`;

async function addDevice(deviceId: string, kind: DeviceKind): Promise<ReturnType<typeof generateKeyPairSync>> {
  const k = generateKeyPairSync("ed25519");
  keys.set(deviceId, k);
  await adminPool.query(
    `INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem, device_kind, device_kind_source) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [deviceId, TENANT, PERSON, `label-${kind}`, pem(k), kind, kind === "legacy_unknown" ? "unclassified" : "trusted_provisioning"]
  );
  return k;
}

const row = async (deviceId: string): Promise<{ kind: string; device_kind: string; device_kind_source: string; public_key_pem: string | null; revoked_at: Date | null } | undefined> =>
  (await adminPool.query("SELECT kind, device_kind, device_kind_source, public_key_pem, revoked_at FROM devices WHERE device_id = $1", [deviceId])).rows[0];
const audits = async (deviceId: string, type: string): Promise<Array<{ decision: string | null; reason: string | null; payload: Record<string, unknown> }>> =>
  (await adminPool.query("SELECT decision, reason, payload FROM audit_events WHERE device_id = $1 AND type = $2 ORDER BY audit_id", [deviceId, type])).rows;

function proofFrom(authorizingId: string): { kind: "device_proof"; authorizing_device_id: string; challenge: string; signature: string } {
  const challenge = devices.issueChallenge(authorizingId);
  const k = keys.get(authorizingId) as ReturnType<typeof generateKeyPairSync>;
  return { kind: "device_proof", authorizing_device_id: authorizingId, challenge, signature: sign(null, Buffer.from(challenge, "utf8"), k.privateKey).toString("base64") };
}

async function ticketFor(kind: EnrollableDeviceKind | undefined, deviceId?: string): Promise<{ kind: "enrollment_ticket"; ticket: string }> {
  const t = await createEnrollmentTicket(adminPool, { tenant_id: TENANT, person_id: PERSON, ...(deviceId !== undefined ? { device_id: deviceId } : {}), ...(kind !== undefined ? { device_kind: kind } : {}) });
  return { kind: "enrollment_ticket", ticket: t.ticket };
}

const request = (deviceId: string, key: ReturnType<typeof generateKeyPairSync>, enrollment: unknown, claim?: string): unknown => ({
  tenant_id: TENANT, person_id: PERSON,
  device: { device_id: deviceId, ...(claim !== undefined ? { kind: claim } : {}), public_key_pem: pem(key) },
  enrollment
});

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-s1e-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw", max: 8 });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_s1e LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_s1e");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'S1E', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${PERSON}', 'S1E Person');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${PERSON}', '${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('sp-s1e', '${TENANT}', 'personal');`);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_s1e", password: "pw2" });
  devices = new DeviceService(appPool);
  grants = new SessionGrantService(appPool);
  enforce = new DeviceEnrollmentService({ pool: appPool, devices, grants, channelBindingMode: "enforce" });
  observe = new DeviceEnrollmentService({ pool: appPool, devices, grants, channelBindingMode: "observe" });
  plain = new DeviceEnrollmentService({ pool: appPool, devices, grants });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

describe("WP-S1 K3 A: billetten BÆRER typen - klienten kan ikke velge den", () => {
  for (const kind of ENROLLABLE_DEVICE_KINDS) {
    it(`billett med type ${kind}: ny enhet får ${kind} (kilde enrollment_ticket) selv om klienten PÅSTÅR en annen type; påstanden revideres kun`, async () => {
      const id = fresh(`dev-a-${kind}`);
      const k = generateKeyPairSync("ed25519");
      const claim = kind === "iphone" ? "mac" : "iphone"; // alltid en ANNEN påstand enn billettens type
      const result = await enforce.enroll(request(id, k, await ticketFor(kind), claim));
      expect(result).toEqual({ ok: true, device_id: id, rotated: false, revoked_grants: 0 });
      expect(await row(id)).toMatchObject({ device_kind: kind, device_kind_source: "enrollment_ticket", kind });
      const [enrolled] = await audits(id, "device.enrolled");
      expect(enrolled?.payload).toMatchObject({ enrollment_method: "enrollment_ticket", device_kind: kind, device_kind_source: "enrollment_ticket", previous_device_kind: null, kind_changed: false, claimed_kind: claim, claimed_kind_matches: false });
    });
  }

  it("påstått etikett som matcher serverens beslutning (`web` for web_browser) gir claimed_kind_matches=true; utelatt etikett gir claimed_kind=null", async () => {
    const a = fresh("dev-a-match");
    expect((await enforce.enroll(request(a, generateKeyPairSync("ed25519"), await ticketFor("web_browser"), "web"))).ok).toBe(true);
    expect((await audits(a, "device.enrolled"))[0]?.payload).toMatchObject({ claimed_kind: "web", claimed_kind_matches: true });
    const b = fresh("dev-a-nokind");
    expect((await enforce.enroll(request(b, generateKeyPairSync("ed25519"), await ticketFor("watch")))).ok).toBe(true);
    expect((await audits(b, "device.enrolled"))[0]?.payload).toMatchObject({ claimed_kind: null, claimed_kind_matches: null });
  });

  it("den påståtte etiketten som havner i revisjonen er avkortet og uten kontrolltegn (ubetrodd tekst)", async () => {
    const id = fresh("dev-a-longclaim");
    const result = await enforce.enroll(request(id, generateKeyPairSync("ed25519"), await ticketFor("watch"), "x\n\u0007" + "y".repeat(500)));
    expect(result.ok).toBe(true);
    const claimed = (await audits(id, "device.enrolled"))[0]?.payload["claimed_kind"] as string;
    expect(claimed.length).toBeLessThanOrEqual(40);
    expect(claimed).toMatch(/^[\x21-\x7e]+$/);
  });

  it("klienten kan ikke smugle inn typen: `device_kind`/`kind_source` i device eller på toppnivå gir malformed_request (strict), og ingenting skrives", async () => {
    const id = fresh("dev-a-smuggle");
    const k = generateKeyPairSync("ed25519");
    const t = await ticketFor("watch");
    for (const bad of [
      { tenant_id: TENANT, person_id: PERSON, device: { device_id: id, kind: "watch", device_kind: "iphone", public_key_pem: pem(k) }, enrollment: t },
      { tenant_id: TENANT, person_id: PERSON, device: { device_id: id, device_kind_source: "enrollment_ticket", public_key_pem: pem(k) }, enrollment: t },
      { tenant_id: TENANT, person_id: PERSON, device_kind: "iphone", device: { device_id: id, public_key_pem: pem(k) }, enrollment: t },
      { tenant_id: TENANT, person_id: PERSON, device: { device_id: id, public_key_pem: pem(k) }, enrollment: { ...t, device_kind: "iphone" } }
    ]) {
      expect(await enforce.enroll(bad), JSON.stringify(Object.keys(bad))).toEqual({ ok: false, reason: "malformed_request" });
    }
    expect(await row(id)).toBeUndefined();
    // billetten er UBRUKT (avvist før konsumering): den virker fortsatt med en gyldig forespørsel
    expect((await enforce.enroll(request(id, k, t))).ok).toBe(true);
    expect(await row(id)).toMatchObject({ device_kind: "watch" });
  });

  it("billett uten type («ikke angitt»): ny enhet blir legacy_unknown/unclassified (ingen step-up-evne); standarden er minste tillit", async () => {
    const id = fresh("dev-a-notype");
    expect((await plain.enroll(request(id, generateKeyPairSync("ed25519"), await ticketFor(undefined), "iphone"))).ok).toBe(true);
    expect(await row(id)).toMatchObject({ device_kind: "legacy_unknown", device_kind_source: "unclassified" });
  });

  it("createEnrollmentTicket avviser ugyldig type (legacy_unknown, store bokstaver, tom, ukjent): en skrivefeil gir aldri en stille annen type", async () => {
    for (const bad of ["legacy_unknown", "Web_Browser", "", "web", "phone", "__proto__"]) {
      await expect(createEnrollmentTicket(adminPool, { tenant_id: TENANT, person_id: PERSON, device_kind: bad as EnrollableDeviceKind }), bad).rejects.toThrow();
    }
    const t = await createEnrollmentTicket(adminPool, { tenant_id: TENANT, person_id: PERSON, device_kind: "mac" });
    expect(t.device_kind).toBe("mac");
    expect((await createEnrollmentTicket(adminPool, { tenant_id: TENANT, person_id: PERSON })).device_kind).toBe("legacy_unknown");
  });

  it("databasen avviser en ugyldig billett-type (CHECK), og en billett kan ikke bære legacy_unknown stille: raden lagrer kun lukkede navn", async () => {
    await expect(adminPool.query(`INSERT INTO device_enrollment_tickets (ticket_id, tenant_id, person_id, expires_at, device_kind) VALUES ('x1', $1, $2, now() + interval '5 min', 'phone')`, [TENANT, PERSON])).rejects.toThrow(/device_enrollment_tickets_device_kind_ck/);
  });
});

describe("WP-S1 K3 B: å endre typen på en EKSISTERENDE enhet skjer kun via en billett (eier-handling på vertsmaskinen)", () => {
  it("legacy_unknown -> iphone via billett: typen endres, grants for enheten tilbakekalles, og endringen revideres to ganger (tjenesten og databasevakten)", async () => {
    const id = fresh("dev-b-up");
    await addDevice(id, "legacy_unknown");
    const k = keys.get(id) as ReturnType<typeof generateKeyPairSync>;
    const result = await enforce.enroll(request(id, k, await ticketFor("iphone"), "phone"));
    expect(result).toEqual({ ok: true, device_id: id, rotated: true, revoked_grants: 0 });
    expect(await row(id)).toMatchObject({ device_kind: "iphone", device_kind_source: "enrollment_ticket" });
    expect((await audits(id, "device.enrolled"))[0]?.payload).toMatchObject({ device_kind: "iphone", previous_device_kind: "legacy_unknown", kind_changed: true });
    const guard = await audits(id, "device.kind_changed");
    expect(guard).toHaveLength(1);
    expect(guard[0]?.payload).toMatchObject({ from: "legacy_unknown", to: "iphone", from_source: "unclassified", to_source: "enrollment_ticket" });
  });

  it("billett uten type på en eksisterende enhet BEVARER typen og kilden (ingen stille nedgradering som kan låse eieren ute), og skriver ingen kind_changed-rad", async () => {
    const id = fresh("dev-b-keep");
    await addDevice(id, "web_browser");
    const k = keys.get(id) as ReturnType<typeof generateKeyPairSync>;
    expect((await plain.enroll(request(id, k, await ticketFor(undefined), "watch"))).ok).toBe(true);
    expect(await row(id)).toMatchObject({ device_kind: "web_browser", device_kind_source: "trusted_provisioning" });
    expect(await audits(id, "device.kind_changed")).toEqual([]);
    expect((await audits(id, "device.enrolled"))[0]?.payload).toMatchObject({ kind_changed: false, previous_device_kind: "web_browser" });
  });

  it("billett med samme type: kilden blir enrollment_ticket (eieren har nå bekreftet typen), men ingen typeendring", async () => {
    const id = fresh("dev-b-same");
    await addDevice(id, "mac");
    const k = keys.get(id) as ReturnType<typeof generateKeyPairSync>;
    expect((await enforce.enroll(request(id, k, await ticketFor("mac")))).ok).toBe(true);
    expect(await row(id)).toMatchObject({ device_kind: "mac", device_kind_source: "enrollment_ticket" });
    // typen er den samme, men KILDEN endret seg (fra «satt av serverkode» til «valgt av eieren via billett»): det revideres som kilde-endring, og databasevakten skriver en rad fordi kilden er vernet
    expect((await audits(id, "device.enrolled"))[0]?.payload).toMatchObject({ previous_device_kind: "mac", device_kind: "mac", kind_changed: false, source_changed: true });
    expect((await audits(id, "device.kind_changed"))[0]?.payload).toMatchObject({ from: "mac", to: "mac", from_source: "trusted_provisioning", to_source: "enrollment_ticket" });
  });

  it("iphone -> watch via billett er tillatt (eieren velger bevisst en lavere tillit); enheten kan ikke lenger få en step-up-kanal", async () => {
    const id = fresh("dev-b-down");
    await addDevice(id, "iphone");
    const k = keys.get(id) as ReturnType<typeof generateKeyPairSync>;
    expect((await enforce.enroll(request(id, k, await ticketFor("watch")))).ok).toBe(true);
    expect(await row(id)).toMatchObject({ device_kind: "watch" });
  });

  it("en billett bundet til én device_id kan ikke brukes på en annen (uendret D-131-regel), og et avvist forsøk endrer ingenting", async () => {
    const id = fresh("dev-b-bound");
    await addDevice(id, "legacy_unknown");
    const k = keys.get(id) as ReturnType<typeof generateKeyPairSync>;
    const t = await ticketFor("iphone", "en-annen-enhet");
    expect(await enforce.enroll(request(id, k, t))).toEqual({ ok: false, reason: "enrollment_ticket_invalid" });
    expect(await row(id)).toMatchObject({ device_kind: "legacy_unknown" });
  });

  it("en tilbakekalt enhet kan aldri rulles inn igjen, uansett billettens type", async () => {
    const id = fresh("dev-b-revoked");
    await addDevice(id, "legacy_unknown");
    const k = keys.get(id) as ReturnType<typeof generateKeyPairSync>;
    await adminPool.query("UPDATE devices SET revoked_at = now(), public_key_pem = NULL WHERE device_id = $1", [id]);
    expect(await enforce.enroll(request(id, k, await ticketFor("iphone")))).toEqual({ ok: false, reason: "device_revoked" });
    expect(await row(id)).toMatchObject({ device_kind: "legacy_unknown" });
  });
});

describe("WP-S1 K3 C: device_proof endrer ALDRI typen, og lavtillits-enheter kan ikke overta høytillits-enheter", () => {
  it("rotasjon av egen nøkkel beholder typen og kilden; ny enhet via device_proof blir legacy_unknown selv om klienten påstår iphone", async () => {
    const own = fresh("dev-c-own");
    await addDevice(own, "iphone");
    const newKey = generateKeyPairSync("ed25519");
    expect(await enforce.enroll(request(own, newKey, proofFrom(own), "watch"))).toEqual({ ok: true, device_id: own, rotated: true, revoked_grants: 0 });
    expect(await row(own)).toMatchObject({ device_kind: "iphone", device_kind_source: "trusted_provisioning", kind: "label-iphone" });
    keys.set(own, newKey);

    const created = fresh("dev-c-new");
    expect(await enforce.enroll(request(created, generateKeyPairSync("ed25519"), proofFrom(own), "iphone"))).toEqual({ ok: true, device_id: created, rotated: false, revoked_grants: 0 });
    expect(await row(created)).toMatchObject({ device_kind: "legacy_unknown", device_kind_source: "unclassified" });
  });

  it("enforce: en Watch kan IKKE re-nøkle eierens iPhone (nektet, ingen endring, ingen grants rørt, revidert); i observe tillates det og revideres som «ville nektet»", async () => {
    const watch = fresh("dev-c-watch");
    const phone = fresh("dev-c-phone");
    await addDevice(watch, "watch");
    const phoneKey = await addDevice(phone, "iphone");
    const attackerKey = generateKeyPairSync("ed25519");

    const denied = await enforce.enroll(request(phone, attackerKey, proofFrom(watch)));
    expect(denied).toEqual({ ok: false, reason: "authorizing_device_kind_not_allowed" });
    expect((await row(phone))?.public_key_pem?.trim()).toBe(pem(phoneKey).trim());
    const [denial] = await audits(phone, "device.enrollment_denied");
    expect(denial).toMatchObject({ decision: "DENY", reason: "authorizing_device_kind_not_allowed" });
    expect(denial?.payload).toMatchObject({ mode: "enforce", authorizing_device_kind: "watch", target_device_kind: "iphone" });

    // observe = main-atferd: tillatt, men «ville nektet» står i revisjonssporet
    const allowed = await observe.enroll(request(phone, attackerKey, proofFrom(watch)));
    expect(allowed).toEqual({ ok: true, device_id: phone, rotated: true, revoked_grants: 0 });
    expect((await row(phone))?.public_key_pem?.trim()).toBe(pem(attackerKey).trim());
    const [would] = await audits(phone, "device.enrollment_would_deny");
    expect(would).toMatchObject({ decision: "ALLOW", reason: "authorizing_device_kind_not_allowed" });
    expect(would?.payload).toMatchObject({ mode: "observe", authorizing_device_kind: "watch", target_device_kind: "iphone" });
    // typen er uansett uendret: også etter en overtakelse i observe er enheten en iphone i serverens øyne (eieren ser det i revisjonen)
    expect(await row(phone)).toMatchObject({ device_kind: "iphone" });
  });

  it("uten channelBindingMode (standard) oppfører device_proof seg som observe (identisk med main)", async () => {
    const watch = fresh("dev-c-dwatch");
    const phone = fresh("dev-c-dphone");
    await addDevice(watch, "watch");
    await addDevice(phone, "iphone");
    expect((await plain.enroll(request(phone, generateKeyPairSync("ed25519"), proofFrom(watch)))).ok).toBe(true);
    expect(await audits(phone, "device.enrollment_would_deny")).toHaveLength(1);
  });

  it("MATRISE (enforce): alle 10x10 kombinasjoner av autoriserende type og måltype - tillatt nøyaktig når den autoriserende har en step-up-kanal ELLER målet ikke har det (re-nøkling av seg selv alltid tillatt)", async () => {
    for (const authorizing of DEVICE_KINDS) {
      for (const target of DEVICE_KINDS) {
        const a = fresh(`dev-m-a-${authorizing}`);
        const t = fresh(`dev-m-t-${target}`);
        await addDevice(a, authorizing);
        const targetKey = await addDevice(t, target);
        const newKey = generateKeyPairSync("ed25519");
        const expectedAllowed = STEP_UP_KINDS.includes(authorizing) || !STEP_UP_KINDS.includes(target);
        const result = await enforce.enroll(request(t, newKey, proofFrom(a)));
        const label = `${authorizing} re-nøkler ${target}`;
        if (expectedAllowed) {
          expect(result, label).toEqual({ ok: true, device_id: t, rotated: true, revoked_grants: 0 });
          expect((await row(t))?.public_key_pem?.trim(), label).toBe(pem(newKey).trim());
        } else {
          expect(result, label).toEqual({ ok: false, reason: "authorizing_device_kind_not_allowed" });
          expect((await row(t))?.public_key_pem?.trim(), label).toBe(pem(targetKey).trim());
        }
        expect(await row(t), label).toMatchObject({ device_kind: target }); // typen er uansett uendret
        // selv-rotasjon er alltid tillatt, for alle typer
        const selfKey = generateKeyPairSync("ed25519");
        expect((await enforce.enroll(request(a, selfKey, proofFrom(a)))).ok, `${authorizing} re-nøkler seg selv`).toBe(true);
        keys.set(a, selfKey);
      }
    }
  }, 180_000);

  it("den rene regelen authorizingKindMayVouch gir samme svar som databasetestene (inkl. ny enhet = tillatt og selv-rotasjon = tillatt)", () => {
    for (const authorizing of DEVICE_KINDS) {
      expect(authorizingKindMayVouch({ authorizing_device_id: "a", authorizing_kind: authorizing, target_device_id: "a", target_kind: "iphone" }), `${authorizing} selv`).toBe(true);
      expect(authorizingKindMayVouch({ authorizing_device_id: "a", authorizing_kind: authorizing, target_device_id: "b", target_kind: null }), `${authorizing} ny`).toBe(true);
      for (const target of DEVICE_KINDS) {
        expect(authorizingKindMayVouch({ authorizing_device_id: "a", authorizing_kind: authorizing, target_device_id: "b", target_kind: target }), `${authorizing}->${target}`)
          .toBe(STEP_UP_KINDS.includes(authorizing) || !STEP_UP_KINDS.includes(target));
      }
    }
  });

  it("decideEnrollmentKind (ren): billett med type vinner; ellers beholdes målets type; ny enhet uten billettype er legacy_unknown", () => {
    const existing = { device_kind: "web_browser" as const, device_kind_source: "legacy_label" as const };
    expect(decideEnrollmentKind({ method: "enrollment_ticket", ticket_kind: "watch", target: existing })).toEqual({ device_kind: "watch", device_kind_source: "enrollment_ticket" });
    expect(decideEnrollmentKind({ method: "enrollment_ticket", ticket_kind: "legacy_unknown", target: existing })).toEqual(existing);
    expect(decideEnrollmentKind({ method: "enrollment_ticket", ticket_kind: null, target: existing })).toEqual(existing);
    expect(decideEnrollmentKind({ method: "enrollment_ticket", ticket_kind: "legacy_unknown", target: null })).toEqual({ device_kind: "legacy_unknown", device_kind_source: "unclassified" });
    expect(decideEnrollmentKind({ method: "device_proof", ticket_kind: "iphone", target: existing })).toEqual(existing); // en billettype ignoreres aldri-brukt i device_proof-stien
    expect(decideEnrollmentKind({ method: "device_proof", ticket_kind: null, target: null })).toEqual({ device_kind: "legacy_unknown", device_kind_source: "unclassified" });
  });
});

describe("WP-S1 K1 D: databasevakten - typen kan kun endres via registerDeviceOn (og eieren med eksplisitt tillatelse)", () => {
  const asApp = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const c = await appPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('jarvis.tenant_id', $1, true)", [TENANT]);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) { await c.query("ROLLBACK").catch(() => undefined); throw err; } finally { c.release(); }
  };

  it("en direkte UPDATE som endrer typen avvises for app-rollen OG for superbrukeren uten tillatelsen; med tillatelsen virker den og revideres automatisk", async () => {
    const id = fresh("dev-d-guard");
    await addDevice(id, "legacy_unknown");
    await expect(asApp((c) => c.query("UPDATE devices SET device_kind = 'iphone', device_kind_source = 'trusted_provisioning' WHERE device_id = $1", [id]))).rejects.toThrow(/device_kind_change_not_authorized/);
    await expect(adminPool.query("UPDATE devices SET device_kind = 'iphone', device_kind_source = 'trusted_provisioning' WHERE device_id = $1", [id])).rejects.toThrow(/device_kind_change_not_authorized/);
    await expect(adminPool.query("UPDATE devices SET device_kind_source = 'legacy_label' WHERE device_id = $1", [id])).rejects.toThrow(); // kilden alene er også vernet (og CHECK-invarianten)
    expect(await row(id)).toMatchObject({ device_kind: "legacy_unknown" });
    expect(await audits(id, "device.kind_changed")).toEqual([]);

    await asApp(async (c) => {
      await c.query("SELECT set_config('jarvis.device_kind_change', 'on', true)");
      await c.query("UPDATE devices SET device_kind = 'iphone', device_kind_source = 'trusted_provisioning' WHERE device_id = $1", [id]);
    });
    expect(await row(id)).toMatchObject({ device_kind: "iphone" });
    expect((await audits(id, "device.kind_changed"))[0]?.payload).toMatchObject({ from: "legacy_unknown", to: "iphone" });
  });

  it("tillatelsen er transaksjonslokal: den lekker ikke til neste transaksjon på samme forbindelse", async () => {
    const id = fresh("dev-d-local");
    await addDevice(id, "legacy_unknown");
    await asApp(async (c) => { await c.query("SELECT set_config('jarvis.device_kind_change', 'on', true)"); });
    await expect(asApp((c) => c.query("UPDATE devices SET device_kind = 'mac', device_kind_source = 'trusted_provisioning' WHERE device_id = $1", [id]))).rejects.toThrow(/device_kind_change_not_authorized/);
  });

  it("tillatelsen som registerDeviceOn setter er borte igjen etter skrivingen: en UPDATE av typen i SAMME transaksjon rett etterpå avvises", async () => {
    const id = fresh("dev-d-reset");
    const seed = { person_id: PERSON, tenant_id: TENANT, memory_space_id: "personal", session_id: "sess-seed-reset", device_id: "seed-reset", channel: "system", auth_strength: "active" } as const;
    void seed;
    await asApp(async (c) => {
      expect(await devices.registerDeviceOn(c, { tenant_id: TENANT, person_id: PERSON }, { device_id: id, kind: "x", public_key_pem: pem(generateKeyPairSync("ed25519")), device_kind: "watch" })).toBe(true);
      await expect(c.query("SAVEPOINT s1")).resolves.toBeDefined();
      await expect(c.query("UPDATE devices SET device_kind = 'iphone', device_kind_source = 'trusted_provisioning' WHERE device_id = $1", [id])).rejects.toThrow(/device_kind_change_not_authorized/);
      await c.query("ROLLBACK TO SAVEPOINT s1");
    });
    expect(await row(id)).toMatchObject({ device_kind: "watch" });
  });

  it("oppdateringer som IKKE endrer typen (nøkkelrotasjon, tilbakekalling) rammes ikke av vakten", async () => {
    const id = fresh("dev-d-other");
    await addDevice(id, "watch");
    await asApp((c) => c.query("UPDATE devices SET public_key_pem = $2 WHERE device_id = $1", [id, pem(generateKeyPairSync("ed25519"))]));
    await adminPool.query("UPDATE devices SET revoked_at = now(), revoked_reason = 'test' WHERE device_id = $1", [id]);
    expect(await row(id)).toMatchObject({ device_kind: "watch" });
  });

  it("CHECK-invarianten: legacy_unknown <=> unclassified; ukjente typer og kilder avvises; en rå INSERT uten type blir legacy_unknown", async () => {
    const ins = (kind: string, source: string, id = fresh("dev-d-check")) => adminPool.query(
      "INSERT INTO devices (device_id, tenant_id, person_id, kind, device_kind, device_kind_source) VALUES ($1, $2, $3, 'x', $4, $5)", [id, TENANT, PERSON, kind, source]);
    await expect(ins("iphone", "unclassified")).rejects.toThrow(/devices_device_kind_source_consistent_ck/);
    await expect(ins("legacy_unknown", "legacy_label")).rejects.toThrow(/devices_device_kind_source_consistent_ck/);
    await expect(ins("legacy_unknown", "enrollment_ticket")).rejects.toThrow(/devices_device_kind_source_consistent_ck/);
    await expect(ins("phone", "unclassified")).rejects.toThrow(/devices_device_kind_ck/);
    await expect(ins("iphone", "magic")).rejects.toThrow(/devices_device_kind_source_ck/);
    await expect(ins("IPHONE", "trusted_provisioning")).rejects.toThrow(/devices_device_kind_ck/);
    await ins("iphone", "enrollment_ticket"); // gyldig
    const id = fresh("dev-d-default");
    await adminPool.query("INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ($1, $2, $3, 'phone')", [id, TENANT, PERSON]);
    expect(await row(id)).toMatchObject({ kind: "phone", device_kind: "legacy_unknown", device_kind_source: "unclassified" });
  });

  it("registerDeviceTrusted: etikett -> utledet type (legacy_label for kjente, unclassified ellers); eksplisitt type valideres, og en inkonsistent kilde avvises", async () => {
    const seed = { person_id: PERSON, tenant_id: TENANT, memory_space_id: "personal", session_id: "sess-seed-s1e", device_id: "seed-s1e", channel: "system", auth_strength: "active" } as const;
    const pubKey = (): string => pem(generateKeyPairSync("ed25519"));
    const a = fresh("dev-d-trust-a");
    await devices.registerDeviceTrusted(seed, { device_id: a, kind: "web", public_key_pem: pubKey() });
    expect(await row(a)).toMatchObject({ kind: "web", device_kind: "web_browser", device_kind_source: "legacy_label" });
    const b = fresh("dev-d-trust-b");
    await devices.registerDeviceTrusted(seed, { device_id: b, kind: "phone", public_key_pem: pubKey() });
    expect(await row(b)).toMatchObject({ device_kind: "legacy_unknown", device_kind_source: "unclassified" });
    const c = fresh("dev-d-trust-c");
    await devices.registerDeviceTrusted(seed, { device_id: c, kind: "whatever", public_key_pem: pubKey(), device_kind: "api_client" });
    expect(await row(c)).toMatchObject({ kind: "whatever", device_kind: "api_client", device_kind_source: "trusted_provisioning" });
    await expect(devices.registerDeviceTrusted(seed, { device_id: fresh("dev-d-trust-d"), kind: "x", public_key_pem: pubKey(), device_kind: "nope" as DeviceKind })).rejects.toThrow();
    await expect(devices.registerDeviceTrusted(seed, { device_id: fresh("dev-d-trust-e"), kind: "x", public_key_pem: pubKey(), device_kind: "iphone", device_kind_source: "unclassified" })).rejects.toThrow(/device_kind_source_inconsistent/);
  });
});

describe("WP-S1 K3 E: samtidighet - ingen vranglås og ingen tapt typeendring", () => {
  it("to samtidige billettinnrullinger av SAMME enhet med ulike typer: begge fullfører uten vranglås, sluttilstanden er den sist committede, og hver endring er revidert", async () => {
    const id = fresh("dev-e-race");
    await addDevice(id, "legacy_unknown");
    const k = keys.get(id) as ReturnType<typeof generateKeyPairSync>;
    const [t1, t2] = [await ticketFor("watch"), await ticketFor("iphone")];
    const results: DeviceEnrollmentResult[] = await Promise.all([enforce.enroll(request(id, k, t1)), enforce.enroll(request(id, k, t2))]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    const finalKind = (await row(id))?.device_kind;
    expect(["watch", "iphone"]).toContain(finalKind);
    const changes = await audits(id, "device.kind_changed");
    expect(changes).toHaveLength(2); // legacy_unknown -> X og X -> Y: ingen endring gikk tapt
    const [first, second] = changes as [(typeof changes)[number], (typeof changes)[number]];
    expect(first.payload).toMatchObject({ from: "legacy_unknown" });
    expect(second.payload["from"]).toBe(first.payload["to"]); // kjeden henger sammen: den andre endringen startet der den første sluttet
    expect(second.payload["to"]).toBe(finalKind);
    expect(new Set([first.payload["to"], second.payload["to"]])).toEqual(new Set(["watch", "iphone"]));
  });

  it("innrulling og tilbakekalling av samme enhet samtidig: ingen krasj/vranglås; enheten ender tilbakekalt og kan ikke rulles inn igjen", async () => {
    const id = fresh("dev-e-revoke");
    await addDevice(id, "legacy_unknown");
    const k = keys.get(id) as ReturnType<typeof generateKeyPairSync>;
    const ticket = await ticketFor("iphone");
    const enrollP = enforce.enroll(request(id, k, ticket));
    const revokeP = (async () => {
      const c = await appPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('jarvis.tenant_id', $1, true)", [TENANT]);
        const ok = await devices.revokeDeviceKeyOn(c, { tenant_id: TENANT, device_id: id }, "race-test");
        await c.query("COMMIT");
        return ok;
      } catch (err) { await c.query("ROLLBACK").catch(() => undefined); throw err; } finally { c.release(); }
    })();
    const [enrolled, revoked] = await Promise.all([enrollP, revokeP]);
    expect(revoked).toBe(true);
    // utfallene: innrullingen vant (ok), eller tilbakekallingen ble sett (enheten eller nøkkelen er tilbakekalt: `device_revoked`/`key_revoked`, avhengig av hvilket av de to ulåste sjekkene som så den først) - aldri noe annet
    expect(enrolled.ok === true || ["device_revoked", "key_revoked"].includes(enrolled.reason), JSON.stringify(enrolled)).toBe(true);
    expect((await row(id))?.revoked_at).not.toBeNull();
    expect(await enforce.enroll(request(id, k, await ticketFor("iphone")))).toEqual({ ok: false, reason: "device_revoked" });
  });

  it("E4: tilbakekalling som committer i vinduet ETTER den ulåste sjekken men FØR målraden låses: innrullingen ser den (device_revoked), ikke et misvisende «eid av en annen»", async () => {
    const id = fresh("dev-e-revwin");
    await addDevice(id, "legacy_unknown");
    const k = keys.get(id) as ReturnType<typeof generateKeyPairSync>;
    const holder = await adminPool.connect();
    let pending: Promise<DeviceEnrollmentResult> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM devices WHERE device_id = $1 FOR UPDATE", [id]); // radlås: tilbakekallingen er «underveis»
      pending = enforce.enroll(request(id, generateKeyPairSync("ed25519"), await ticketFor("iphone")));
      await new Promise((r) => setTimeout(r, 300)); // innrullingen har gjort de ulåste sjekkene (ikke tilbakekalt ennå) og venter nå på radlåsen
      await holder.query("UPDATE devices SET revoked_at = now(), revoked_reason = 'e4', public_key_pem = NULL WHERE device_id = $1", [id]);
      await holder.query("COMMIT");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    expect(await pending).toEqual({ ok: false, reason: "device_revoked" });
    expect(await row(id)).toMatchObject({ device_kind: "legacy_unknown" });
    void k;
  });

  it("E5: en billett uten type bevarer typen slik den står ETTER en samtidig endring (ingen tapt oppdatering): målraden leses under radlås", async () => {
    const id = fresh("dev-e-lost");
    await addDevice(id, "legacy_unknown");
    const k = keys.get(id) as ReturnType<typeof generateKeyPairSync>;
    const holder = await adminPool.connect();
    let pending: Promise<DeviceEnrollmentResult> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('jarvis.device_kind_change', 'on', true)");
      await holder.query("UPDATE devices SET device_kind = 'mac', device_kind_source = 'enrollment_ticket' WHERE device_id = $1", [id]); // en samtidig typeendring (uncommittet)
      pending = plain.enroll(request(id, k, await ticketFor(undefined)));
      await new Promise((r) => setTimeout(r, 300));
      await holder.query("COMMIT");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    expect((await pending)?.ok).toBe(true);
    expect(await row(id)).toMatchObject({ device_kind: "mac", device_kind_source: "enrollment_ticket" }); // IKKE nedgradert til det enrollment så før den ventet
  });
});


describe("WP-S1 K3 F: en ny enhet skrives som ren innsetting - et samtidig kappløp kan ikke overstyre regler som ikke er vurdert mot den raden", () => {
  async function raceAgainstUncommittedInsert(buildEnrollment: (deviceId: string) => Promise<unknown>): Promise<{ id: string; ownerKey: ReturnType<typeof generateKeyPairSync>; result: DeviceEnrollmentResult }> {
    const id = fresh("dev-f-race");
    const ownerKey = generateKeyPairSync("ed25519");
    const holder = await adminPool.connect();
    let pending: Promise<DeviceEnrollmentResult> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('jarvis.device_kind_change', 'on', true)");
      await holder.query(
        "INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem, device_kind, device_kind_source) VALUES ($1, $2, $3, 'iphone', $4, 'iphone', 'enrollment_ticket')",
        [id, TENANT, PERSON, pem(ownerKey)]
      );
      // innrullingen ser IKKE den ucommitede raden (målraden er `null` => «ny enhet»), og må vente på innsettingen
      pending = enforce.enroll(await buildEnrollment(id)) as Promise<DeviceEnrollmentResult>;
      await new Promise((r) => setTimeout(r, 300));
      await holder.query("COMMIT");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    return { id, ownerKey, result: await (pending as Promise<DeviceEnrollmentResult>) };
  }

  it("device_proof som «oppretter» en enhet som samtidig ble opprettet som iphone: taper (device_owned_by_other_principal), typen OG nøkkelen til den som kom først er uendret", async () => {
    const authorizing = fresh("dev-f-watch");
    await addDevice(authorizing, "watch");
    const attackerKey = generateKeyPairSync("ed25519");
    const { id, ownerKey, result } = await raceAgainstUncommittedInsert(async (deviceId) => request(deviceId, attackerKey, proofFrom(authorizing)));
    expect(result).toEqual({ ok: false, reason: "device_owned_by_other_principal" });
    expect(await row(id)).toMatchObject({ device_kind: "iphone", device_kind_source: "enrollment_ticket" });
    expect((await row(id))?.public_key_pem?.trim()).toBe(pem(ownerKey).trim());
  });

  it("billett uten type (ikke angitt) som «oppretter» en enhet som samtidig ble opprettet med en type: taper i stedet for å nedgradere den, og billetten er ikke brukt opp", async () => {
    const t = await ticketFor(undefined);
    const { id, result } = await raceAgainstUncommittedInsert(async (deviceId) => request(deviceId, generateKeyPairSync("ed25519"), t));
    expect(result).toEqual({ ok: false, reason: "device_owned_by_other_principal" });
    expect(await row(id)).toMatchObject({ device_kind: "iphone" });
    const consumed = (await adminPool.query("SELECT consumed_at FROM device_enrollment_tickets WHERE consumed_device_id = $1", [id])).rows;
    expect(consumed).toEqual([]); // hele transaksjonen rullet tilbake: billetten kan brukes på nytt
  });

  it("en device_id som tilhører en ANNEN person i samme tenant eller en annen tenant lekker aldri: samme avslag som før, ingen overskriving", async () => {
    const other = fresh("dev-f-other");
    await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-s1e-b', 'S1E B', 'person') ON CONFLICT DO NOTHING");
    await adminPool.query("INSERT INTO people (person_id, display_name) VALUES ('person-s1e-b', 'B') ON CONFLICT DO NOTHING");
    await adminPool.query("INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-s1e-b', 'tenant-s1e-b') ON CONFLICT DO NOTHING");
    await adminPool.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, device_kind, device_kind_source) VALUES ($1, 'tenant-s1e-b', 'person-s1e-b', 'x', 'iphone', 'trusted_provisioning')", [other]);
    expect(await enforce.enroll(request(other, generateKeyPairSync("ed25519"), await ticketFor("watch")))).toEqual({ ok: false, reason: "device_owned_by_other_principal" });
    expect(await row(other)).toMatchObject({ device_kind: "iphone" });
  });
});

describe("WP-S1 K3 G: device.enrolled-revisjonen sier hva serveren bestemte (type, kilde, forrige type, endret) for HVER vei", () => {
  const enrolled = async (id: string): Promise<Record<string, unknown>> => ((await audits(id, "device.enrolled")).at(-1)?.payload ?? {}) as Record<string, unknown>;

  it("billett med type, ny enhet: iphone / enrollment_ticket, ingen forrige type, ingen endring", async () => {
    const id = fresh("dev-g-ticket-new");
    expect((await enforce.enroll(request(id, generateKeyPairSync("ed25519"), await ticketFor("iphone")))).ok).toBe(true);
    expect(await enrolled(id)).toMatchObject({ enrollment_method: "enrollment_ticket", device_kind: "iphone", device_kind_source: "enrollment_ticket", previous_device_kind: null, kind_changed: false, source_changed: false });
  });

  it("device_proof, ny enhet: legacy_unknown / unclassified (aldri enrollment_ticket), ingen endring", async () => {
    const authorizing = fresh("dev-g-auth");
    await addDevice(authorizing, "iphone");
    const id = fresh("dev-g-proof-new");
    expect((await enforce.enroll(request(id, generateKeyPairSync("ed25519"), proofFrom(authorizing)))).ok).toBe(true);
    expect(await enrolled(id)).toMatchObject({ enrollment_method: "device_proof", device_kind: "legacy_unknown", device_kind_source: "unclassified", previous_device_kind: null, kind_changed: false, source_changed: false });
  });

  it("device_proof (re-nøkling av seg selv) av en enhet med kilden legacy_label: typen OG kilden beholdes og revisjonen sier det", async () => {
    const id = fresh("dev-g-legacy-label");
    const k = generateKeyPairSync("ed25519");
    keys.set(id, k);
    await adminPool.query("INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem, device_kind, device_kind_source) VALUES ($1, $2, $3, 'web', $4, 'web_browser', 'legacy_label')", [id, TENANT, PERSON, pem(k)]);
    expect((await enforce.enroll(request(id, generateKeyPairSync("ed25519"), proofFrom(id)))).ok).toBe(true);
    expect(await row(id)).toMatchObject({ device_kind: "web_browser", device_kind_source: "legacy_label" });
    expect(await enrolled(id)).toMatchObject({ enrollment_method: "device_proof", rotated: true, device_kind: "web_browser", device_kind_source: "legacy_label", previous_device_kind: "web_browser", kind_changed: false, source_changed: false });
  });

  it("billett UTEN type for en eksisterende enhet: typen og kilden beholdes (trusted_provisioning), revisjonen sier ingen endring", async () => {
    const id = fresh("dev-g-notype-existing");
    await addDevice(id, "watch");
    expect((await plain.enroll(request(id, generateKeyPairSync("ed25519"), await ticketFor(undefined, id)))).ok).toBe(true);
    expect(await enrolled(id)).toMatchObject({ device_kind: "watch", device_kind_source: "trusted_provisioning", previous_device_kind: "watch", kind_changed: false, source_changed: false });
  });

  it("billett med ANNEN type for en eksisterende enhet: ny type + kilde enrollment_ticket, forrige type, kind_changed og source_changed", async () => {
    const id = fresh("dev-g-change");
    await addDevice(id, "watch");
    expect((await enforce.enroll(request(id, generateKeyPairSync("ed25519"), await ticketFor("iphone", id)))).ok).toBe(true);
    expect(await enrolled(id)).toMatchObject({ device_kind: "iphone", device_kind_source: "enrollment_ticket", previous_device_kind: "watch", kind_changed: true, source_changed: true });
  });

  it("billett med SAMME type for en eksisterende enhet: typen er uendret, men kilden flyttes til enrollment_ticket (eieren har nå bekreftet typen)", async () => {
    const id = fresh("dev-g-same");
    await addDevice(id, "watch");
    expect((await enforce.enroll(request(id, generateKeyPairSync("ed25519"), await ticketFor("watch", id)))).ok).toBe(true);
    expect(await row(id)).toMatchObject({ device_kind: "watch", device_kind_source: "enrollment_ticket" });
    expect(await enrolled(id)).toMatchObject({ device_kind: "watch", device_kind_source: "enrollment_ticket", previous_device_kind: "watch", kind_changed: false, source_changed: true });
  });
});

