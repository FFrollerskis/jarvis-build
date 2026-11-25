import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, DeviceEnrollmentService, DeviceService, fingerprintPem, runMigrations, SessionGrantService, type DeviceEnrollmentResult } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { FamilyService, type FamilyActor } from "../src/index.ts";

/**
 * WP-G2c (D-483, JARVIS-113 j): FELLES, DETERMINISTISK LÅSREKKEFØLGE for innrullering (`device_proof`) og fjerning fra en familiesirkel. Det sjeldne tilfellet fra G2 fiks-runde 2b: en innrullering som ROTERER en eksisterende enhet D2 med en
 * autoriserende enhet D1 som sorterer ETTER D2 holdt D1 mens den ventet på D2, mens fjerningen (som låser personens enheter i sortert rekkefølge) holdt D2 mens den ventet på D1 -> Postgres 40P01; hele transaksjonen ble rullet tilbake (for
 * fjerningen, en sikkerhetskontroll: medlemmet sto `active`). Nå låser innrulleringen BEGGE enhetsradene i stigende `device_id` først (`DeviceService.lockDeviceRowsOn`), slik at begge veier tar radlåsene i samme rekkefølge.
 *
 * Kappløpene er DETERMINISTISKE (ingen `sleep`-timing): en `DeviceService`-subklasse stopper den ekte `DeviceEnrollmentService.enroll` rett etter at den autoriserende enhetens nøkkel er låst og lest (`lockDeviceKeyOn`), testen starter den
 * andre transaksjonen, venter til den faktisk står blokkert på en lås (`pg_stat_activity`), og slipper så innrulleringen videre. RØD på main (40P01 hos en av dem), grønn med fiksen.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let svc: FamilyService;
let seq = 0;

/** Stopper `enroll` ETTER at den autoriserende enhetens nøkkel er låst og lest (samme punkt på main og etter fiksen: «den autoriserende enheten er låst»). Engangs: kun neste kall stoppes. */
class GatedDevices extends DeviceService {
  private gate: { hit: () => void; open: Promise<void> } | undefined;
  arm(): { reached: Promise<void>; release: () => void } {
    let hit!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { hit = resolve; });
    const open = new Promise<void>((resolve) => { release = resolve; });
    this.gate = { hit, open };
    return { reached, release };
  }
  override async lockDeviceKeyOn(...args: Parameters<DeviceService["lockDeviceKeyOn"]>): ReturnType<DeviceService["lockDeviceKeyOn"]> {
    const result = await super.lockDeviceKeyOn(...args);
    const gate = this.gate;
    if (gate !== undefined) {
      this.gate = undefined;
      gate.hit();
      await gate.open;
    }
    return result;
  }
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-g2c-lockorder-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_g2c_lockorder LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_g2c_lockorder");
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_g2c_lockorder", password: "pw2" });
  svc = new FamilyService(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

interface Circle { tenant: string; owner: string; adult: string; n: number }
const act = (c: Circle, person: string): FamilyActor => ({ tenant_id: c.tenant, person_id: person, memory_space_id: "shared", session_id: `sess-${person}`, device_id: `dev-${person}`, channel: "api", auth_strength: "signed" });

async function mkCircle(): Promise<Circle> {
  seq += 1;
  const c: Circle = { tenant: `t-g2c-lo-${seq}`, owner: `p-g2c-lo-owner-${seq}`, adult: `p-g2c-lo-adult-${seq}`, n: seq };
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, 'Circle', 'person')`, [c.tenant]);
  await admin.query(`INSERT INTO people (person_id, display_name) VALUES ($1, 'O'), ($2, 'A')`, [c.owner, c.adult]);
  await admin.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1, $3), ($2, $3)`, [c.owner, c.adult, c.tenant]);
  await admin.query(`INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1, $2, 'shared')`, [`ms-${c.tenant}-shared`, c.tenant]);
  await svc.bootstrapOwner(act(c, c.owner), c.owner);
  const inv = await svc.invite(act(c, c.owner), { invitee_person_id: c.adult, role: "adult" });
  await svc.acceptInvitation(act(c, c.adult), inv.invitation_id);
  return c;
}

interface Keyed { id: string; keys: { publicKey: KeyObject; privateKey: KeyObject } }
const pemOf = (k: { publicKey: KeyObject }): string => k.publicKey.export({ type: "spki", format: "pem" }).toString();
/** En enhet med en ekte Ed25519-nøkkel hvis private del testen har (kan signere en `device_proof`). */
async function mkKeyed(c: Circle, id: string, withGrant = false): Promise<Keyed> {
  const keys = generateKeyPairSync("ed25519");
  await admin.query(`INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1, $2, $3, 'mobile', $4)`, [id, c.tenant, c.adult, pemOf(keys)]);
  if (withGrant) {
    // Et utestående grant (som `revokeForDeviceOn` oppdaterer under fjerningen): radene brukes av testen til å STOPPE fjerningen midt mellom to enheter.
    await admin.query(`INSERT INTO sessions (session_id, tenant_id, person_id, status, last_channel, last_device_id) VALUES ($1, $2, $3, 'closed', 'api', $4)`, [`sess-grant-${id}`, c.tenant, c.adult, id]);
    await admin.query(
      `INSERT INTO session_grants (grant_id, tenant_id, person_id, device_id, session_id, memory_space, channel, auth_strength, device_key_fingerprint, expires_at) VALUES ($1, $2, $3, $4, $5, 'shared', 'api', 'signed', $6, now() + interval '1 hour')`,
      [`grant-${id}`, c.tenant, c.adult, id, `sess-grant-${id}`, fingerprintPem(pemOf(keys))]
    );
  }
  return { id, keys };
}

const isActive = async (id: string): Promise<boolean | undefined> => ((await admin.query(`SELECT revoked_at IS NULL AS active FROM devices WHERE device_id = $1`, [id])).rows[0] as { active: boolean } | undefined)?.active;
const memberStatus = async (c: Circle): Promise<string> => ((await admin.query(`SELECT status FROM family_members WHERE tenant_id = $1 AND person_id = $2`, [c.tenant, c.adult])).rows[0] as { status: string }).status;
const verdict = (r: DeviceEnrollmentResult): string => (r.ok ? "ok" : `denied:${r.reason}`);
const settle = (p: Promise<unknown>, mapOk: (v: never) => string = () => "ok"): Promise<string> => p.then((v) => mapOk(v as never), (e: unknown) => `ERR:${(e as { code?: string }).code ?? (e as Error).message.slice(0, 100)}`);
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms))]);

/** Venter til minst `n` transaksjoner står blokkert på en LÅS (kappløpet er da deterministisk satt opp). */
async function waitBlocked(n: number): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`);
    if ((rows[0] as { n: number }).n >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("blocked_wait_timeout");
}

function rig(): { gated: GatedDevices; enrollment: DeviceEnrollmentService } {
  const gated = new GatedDevices(app);
  return { gated, enrollment: new DeviceEnrollmentService({ pool: app, devices: gated, grants: new SessionGrantService(app) }) };
}

/** En `device_proof`-forespørsel: `authorizing` signerer en ferskt utstedt utfordring og autoriserer innrullering/rotasjon av `target` med en NY nøkkel. */
function proof(gated: GatedDevices, c: Circle, authorizing: Keyed, targetId: string): { tenant_id: string; person_id: string; device: { device_id: string; kind: string; public_key_pem: string }; enrollment: { kind: "device_proof"; authorizing_device_id: string; challenge: string; signature: string } } {
  const challenge = gated.issueChallenge(authorizing.id);
  const signature = sign(null, Buffer.from(challenge, "utf8"), authorizing.keys.privateKey).toString("base64");
  return {
    tenant_id: c.tenant, person_id: c.adult, device: { device_id: targetId, kind: "mobile", public_key_pem: pemOf(generateKeyPairSync("ed25519")) },
    enrollment: { kind: "device_proof", authorizing_device_id: authorizing.id, challenge, signature }
  };
}

describe("A: fjerning mot en SAMTIDIG device_proof-innrullering som roterer en annen av personens enheter", () => {
  for (const how of ["removed", "left"] as const) {
    it(`den autoriserende enheten D1 sorterer ETTER den roterte D2 (${how}): ingen deadlock - innrulleringen lykkes, fjerningen/forlatelsen lykkes, medlemmet er \`${how}\` og BEGGE enheter er tilbakekalt (RØD på main: 40P01 og/eller medlem \`active\`)`, async () => {
      const c = await mkCircle();
      const d1 = await mkKeyed(c, `dev-lo-b-auth-${c.n}`); // settes inn FØRST (fysisk rekkefølge b, a) men sorterer SIST
      await mkKeyed(c, `dev-lo-a-target-${c.n}`);
      const { gated, enrollment } = rig();
      const request = proof(gated, c, d1, `dev-lo-a-target-${c.n}`);
      const gate = gated.arm();
      const enrolling = settle(enrollment.enroll(request), verdict as never);
      await within(gate.reached, 15_000, "innrulleringen nådde ikke låsepunktet");
      const ending = settle(how === "removed" ? svc.removeMember(act(c, c.owner), c.adult) : svc.leave(act(c, c.adult)));
      await waitBlocked(1); // den andre transaksjonen står blokkert på en rad innrulleringen holder
      gate.release();
      const results = await within(Promise.all([enrolling, ending]), 40_000, "deadlock eller hengende transaksjon");
      expect(results, "innrullering, fjerning").toEqual(["ok", "ok"]);
      expect(await memberStatus(c)).toBe(how);
      expect(await isActive(`dev-lo-b-auth-${c.n}`), "D1 tilbakekalt").toBe(false);
      expect(await isActive(`dev-lo-a-target-${c.n}`), "D2 (rotert) tilbakekalt").toBe(false);
    }, 90_000);
  }

  it("kontroll: D1 sorterer FØR D2 - samme resultat (aldri en deadlock hverken på main eller med fiksen)", async () => {
    const c = await mkCircle();
    const d1 = await mkKeyed(c, `dev-lo-a-auth-${c.n}`);
    await mkKeyed(c, `dev-lo-b-target-${c.n}`);
    const { gated, enrollment } = rig();
    const gate = gated.arm();
    const enrolling = settle(enrollment.enroll(proof(gated, c, d1, `dev-lo-b-target-${c.n}`)), verdict as never);
    await within(gate.reached, 15_000, "innrulleringen nådde ikke låsepunktet");
    const removing = settle(svc.removeMember(act(c, c.owner), c.adult));
    await waitBlocked(1);
    gate.release();
    expect(await within(Promise.all([enrolling, removing]), 40_000, "hengende")).toEqual(["ok", "ok"]);
    expect(await memberStatus(c)).toBe("removed");
    expect([await isActive(`dev-lo-a-auth-${c.n}`), await isActive(`dev-lo-b-target-${c.n}`)]).toEqual([false, false]);
  }, 90_000);

  it("en NY enhet (ikke en rotasjon) autorisert av en eksisterende: lykkes ved siden av fjerningen, og den nye enheten er tilbakekalt etterpå (ingen aktiv enhet overlever)", async () => {
    const c = await mkCircle();
    const d1 = await mkKeyed(c, `dev-lo-b-auth-${c.n}`);
    const { gated, enrollment } = rig();
    const gate = gated.arm();
    const enrolling = settle(enrollment.enroll(proof(gated, c, d1, `dev-lo-a-brandnew-${c.n}`)), verdict as never);
    await within(gate.reached, 15_000, "innrulleringen nådde ikke låsepunktet");
    const removing = settle(svc.removeMember(act(c, c.owner), c.adult));
    await waitBlocked(1);
    gate.release();
    expect(await within(Promise.all([enrolling, removing]), 40_000, "hengende")).toEqual(["ok", "ok"]);
    expect([await isActive(`dev-lo-b-auth-${c.n}`), await isActive(`dev-lo-a-brandnew-${c.n}`)]).toEqual([false, false]);
  }, 90_000);
});

describe("A2: fjerningen er MIDT I FLUKT (holder sin første enhetsrad) når innrulleringen starter - rekkefølgen INNE i innrulleringens låsing avgjør", () => {
  /**
   * En åpen transaksjon (X) holder grant-radene til begge enhetene. Fjerningen låser sin første enhet (den som sorterer først) og står så blokkert på dens grant-rad: den holder én enhetsrad og venter. DA starter innrulleringen. Låser den i
   * stigende rekkefølge (a, så b) venter den på a (som fjerningen holder) uten å holde noe selv - ingen sirkel. Låser den i en annen rekkefølge (b først, eller bare den ene), holder den b mens fjerningen (etter X) trenger b -> deadlock.
   * Dette fanger det de andre kappløpene ikke gjør: rekkefølgen MELLOM de to radene i innrulleringens egen låsing, og at fjerningens liste og innrulleringen bruker SAMME sortering.
   */
  for (const [label, authorizingFirst] of [["autoriserende enhet sorterer ETTER den roterte", false], ["autoriserende enhet sorterer FØR den roterte", true]] as const) {
    it(`${label}: fjerningen holder første enhet og venter på X; innrulleringen venter UTEN å holde noe; når X slipper er resultatet fjerning ok + innrullering avvist (nøkkelen er tilbakekalt) - aldri 40P01`, async () => {
      const c = await mkCircle();
      const lo = await mkKeyed(c, `dev-lo-a-mid-${c.n}`, true); // sorterer først
      const hi = await mkKeyed(c, `dev-lo-b-mid-${c.n}`, true); // sorterer sist (settes inn etter, så fysisk rekkefølge = sortert: kun ORDER BY skiller riktig fra feil)
      const authorizing = authorizingFirst ? lo : hi;
      const target = authorizingFirst ? hi : lo;
      const { gated, enrollment } = rig();
      const request = proof(gated, c, authorizing, target.id);
      const x = await admin.connect();
      try {
        await x.query("BEGIN");
        await x.query(`SELECT 1 FROM session_grants WHERE device_id = ANY($1::text[]) FOR UPDATE`, [[lo.id, hi.id]]);
        const removing = settle(svc.removeMember(act(c, c.owner), c.adult));
        await waitBlocked(1); // fjerningen holder sin første enhetsrad og venter på grant-raden X holder
        const enrolling = settle(enrollment.enroll(request), verdict as never);
        await waitBlocked(2); // innrulleringen står også blokkert (på en enhetsrad fjerningen holder)
        await x.query("COMMIT");
        const results = await within(Promise.all([removing, enrolling]), 40_000, "deadlock eller hengende transaksjon");
        expect(results, "fjerning, innrullering").toEqual(["ok", "denied:authorizing_device_proof_invalid"]);
      } finally {
        await x.query("ROLLBACK").catch(() => undefined);
        x.release();
      }
      expect(await memberStatus(c)).toBe("removed");
      expect([await isActive(lo.id), await isActive(hi.id)]).toEqual([false, false]);
    }, 90_000);
  }
});

describe("B: to innrulleringer som krysser hverandre (D1 autoriserer rotasjon av D2, og D2 autoriserer rotasjon av D1)", () => {
  it("ingen deadlock: den første lykkes, den andre får det legitime avslaget `authorizing_device_proof_invalid` (nøkkelen den bygde på er rotert) - ikke 40P01 (RØD på main)", async () => {
    const c = await mkCircle();
    const a = await mkKeyed(c, `dev-lo-a-cross-${c.n}`);
    const b = await mkKeyed(c, `dev-lo-b-cross-${c.n}`);
    const { gated, enrollment } = rig();
    const first = proof(gated, c, a, b.id); // a autoriserer rotasjon av b
    const second = proof(gated, c, b, a.id); // b autoriserer rotasjon av a
    const gate = gated.arm();
    const e1 = settle(enrollment.enroll(first), verdict as never);
    await within(gate.reached, 15_000, "første innrullering nådde ikke låsepunktet");
    const e2 = settle(enrollment.enroll(second), verdict as never);
    await waitBlocked(1);
    gate.release();
    const results = await within(Promise.all([e1, e2]), 40_000, "deadlock eller hengende innrullering");
    expect(results).toEqual(["ok", "denied:authorizing_device_proof_invalid"]);
    expect([await isActive(a.id), await isActive(b.id)], "ingen enhet er tilbakekalt av dette").toEqual([true, true]);
  }, 90_000);
});

describe("C: DeviceService.lockDeviceRowsOn - enhetsradene låses (FOR UPDATE) i STIGENDE device_id, kun personens egne i tenanten", () => {
  async function locked(client: pg.PoolClient, ids: string[]): Promise<string[]> {
    const free: string[] = [];
    for (const id of ids) {
      try {
        await client.query("SAVEPOINT s");
        await client.query("SELECT 1 FROM devices WHERE device_id = $1 FOR UPDATE NOWAIT", [id]);
        free.push(id);
        await client.query("ROLLBACK TO s");
      } catch {
        await client.query("ROLLBACK TO s");
      }
    }
    return ids.filter((id) => !free.includes(id));
  }

  it("alle oppgitte, eksisterende rader for (tenant, person) låses - også en tilbakekalt - og rader som tilhører en annen person eller tenant, eller ikke finnes, røres ikke; tom liste og duplikater er greit", async () => {
    const c = await mkCircle();
    const mine = [await mkKeyed(c, `dev-lo-m1-${c.n}`), await mkKeyed(c, `dev-lo-m2-${c.n}`), await mkKeyed(c, `dev-lo-m3-${c.n}`)];
    await admin.query(`UPDATE devices SET revoked_at = now(), public_key_pem = NULL WHERE device_id = $1`, [mine[2]!.id]);
    await admin.query(`INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1, $2, $3, 'mobile', $4)`, [`dev-lo-owner-${c.n}`, c.tenant, c.owner, pemOf(generateKeyPairSync("ed25519"))]);
    const devices = new DeviceService(app);
    const holder = await app.connect();
    const probe = await admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('jarvis.tenant_id', $1, true)", [c.tenant]); // som i `withTenantTransaction`: RLS på `devices` krever tenant-konteksten
      await devices.lockDeviceRowsOn(holder, { tenant_id: c.tenant, person_id: c.adult }, []);
      await devices.lockDeviceRowsOn(holder, { tenant_id: c.tenant, person_id: c.adult }, [mine[0]!.id, mine[0]!.id, mine[2]!.id, `dev-lo-owner-${c.n}`, `dev-lo-finnes-ikke-${c.n}`, "dev-lo-annen-tenant"]);
      await probe.query("BEGIN");
      expect(await locked(probe, [mine[0]!.id, mine[1]!.id, mine[2]!.id, `dev-lo-owner-${c.n}`])).toEqual([mine[0]!.id, mine[2]!.id]);
      await probe.query("ROLLBACK");
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
      probe.release();
    }
  });

  it("rekkefølgen er `ORDER BY device_id` i databasen (samme som fjerningens liste): setningen som låser bærer ORDER BY og en kilde-vakt hindrer at det glir", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../core/src/services/device-service.ts", import.meta.url), "utf8");
    const fn = source.slice(source.indexOf("async lockDeviceRowsOn("), source.indexOf("private async publicKeyFromDb("));
    expect(fn).toMatch(/ORDER BY device_id FOR UPDATE/);
    const family = readFileSync(new URL("../src/family/service.ts", import.meta.url), "utf8");
    expect(family).toMatch(/revoked_at IS NULL ORDER BY device_id/); // fjerningens liste bruker SAMME sortering
    const enrollmentSource = readFileSync(new URL("../../core/src/services/device-enrollment-service.ts", import.meta.url), "utf8");
    expect(enrollmentSource.indexOf("lockDeviceRowsOn(")).toBeGreaterThan(-1);
    expect(enrollmentSource.indexOf("lockDeviceRowsOn("), "radlåsene tas FØR den autoriserende nøkkelen leses").toBeLessThan(enrollmentSource.indexOf("lockDeviceKeyOn(client"));
  });
});
