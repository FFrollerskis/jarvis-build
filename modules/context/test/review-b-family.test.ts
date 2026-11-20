import { generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnrollmentTicket, createPool, DeviceEnrollmentService, DeviceService, enrollmentTicketId, fingerprintPem, IdentityService, RevokedDeviceKeyError, runMigrations, SessionGrantService, withTenantTransaction } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";
import { FamilyService, type FamilyActor, type SharedDataReaders } from "../src/index.ts";

/**
 * WP-G2 fiks-runde (review B, familie): mot EKTE Postgres/RLS (NOSUPERUSER/NOBYPASSRLS-rolle).
 *  - LOW-5: fjerning/forlating tilbakekaller OGSÅ personens enheter og grants i sirkel-tenanten (identitetsnivået ga ellers fortsatt tilgang til sirkelens `shared`-rom).
 *  - LOW-6: to samtidige `grantShare`/`grantDelegation` med samme innhold gir en idempotent retur (vinnerens rad), ikke en rå pg-feil 23505 (-> 500).
 *  - LOW-7: `setItemDone` skriver en revisjonsrad (aldri innholdet).
 *  - fiks-runde 2 (delta-review B INFO): fjerning/forlating forbruker OGSÅ personens åpne innrullingsbilletter i sirkel-tenanten, i samme transaksjon (ellers kunne et tidligere medlem rulle inn en NY enhet med en billett utstedt før fjerningen).
 *  - fiks-runde 2b (delta-review B NY2-1): rekkefølgen mot en SAMTIDIG innrullering (billett FØRST, så enheter i løkke) - tre deterministiske kappløp (R-A billett, R-B deadlock, R-C device_proof).
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let svc: FamilyService;
const identity = (): IdentityService => new IdentityService(app);

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-family-rb-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_family_rb_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_family_rb_test");
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_family_rb_test", password: "pw2" });
  svc = new FamilyService(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

interface Circle { tenant: string; owner: string; adult: string; child: string; adultData: string; n: number }
let seq = 0;

async function mkFull(): Promise<Circle> {
  const n = ++seq;
  const c: Circle = { tenant: `t-famrb-${n}`, owner: `p-famrb-owner-${n}`, adult: `p-famrb-adult-${n}`, child: `p-famrb-child-${n}`, adultData: `t-famrb-data-${n}`, n };
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ($1, 'Circle', 'person'), ($2, 'Adult data', 'person')`, [c.tenant, c.adultData]);
  await admin.query(`INSERT INTO people (person_id, display_name) VALUES ($1, 'O'), ($2, 'A'), ($3, 'C')`, [c.owner, c.adult, c.child]);
  await admin.query(`INSERT INTO person_tenants (person_id, tenant_id) VALUES ($1, $4), ($2, $4), ($3, $4), ($2, $5)`, [c.owner, c.adult, c.child, c.tenant, c.adultData]);
  await admin.query(`INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ($1, $2, 'shared'), ($3, $4, 'shared')`, [`ms-${c.tenant}-shared`, c.tenant, `ms-${c.adultData}-shared`, c.adultData]);
  await svc.bootstrapOwner(act(c, c.owner), c.owner);
  for (const [person, role] of [[c.adult, "adult"], [c.child, "child"]] as const) {
    const inv = await svc.invite(act(c, c.owner), { invitee_person_id: person, role });
    await svc.acceptInvitation(act(c, person), inv.invitation_id);
  }
  return c;
}

const act = (c: Circle, person: string): FamilyActor => ({ tenant_id: c.tenant, person_id: person, memory_space_id: "shared", session_id: `sess-${person}`, device_id: `dev-${person}`, channel: "api", auth_strength: "signed" });

/** Enhet med en ekte Ed25519-nøkkel (samme form som innrullering) + et utestående grant (kun for tester: grantet settes direkte). */
async function mkDevice(tenant: string, person: string, deviceId: string): Promise<string> {
  const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  await admin.query(`INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1, $2, $3, 'phone', $4)`, [deviceId, tenant, person, pem]);
  const sessionId = `sess-grant-${deviceId}`;
  await admin.query(`INSERT INTO sessions (session_id, tenant_id, person_id, status, last_channel, last_device_id) VALUES ($1, $2, $3, 'closed', 'api', $4)`, [sessionId, tenant, person, deviceId]);
  await admin.query(
    `INSERT INTO session_grants (grant_id, tenant_id, person_id, device_id, session_id, memory_space, channel, auth_strength, device_key_fingerprint, expires_at) VALUES ($1, $2, $3, $4, $5, 'shared', 'api', 'signed', $6, now() + interval '1 hour')`,
    [`grant-${deviceId}`, tenant, person, deviceId, sessionId, fingerprintPem(pem)]
  );
  return pem;
}

const authz = (tenant: string, person: string, deviceId: string) =>
  withTenantTransaction(app, tenant, (client) => identity().checkAuthorizationOn(client, { person_id: person, tenant_id: tenant, memory_space: "shared", device_id: deviceId }));
const grantRevoked = async (deviceId: string): Promise<boolean> => ((await admin.query(`SELECT revoked_at FROM session_grants WHERE device_id = $1`, [deviceId])).rows[0] as { revoked_at: Date | null }).revoked_at !== null;
const audits = async (c: Circle, type: string): Promise<Array<Record<string, unknown>>> => ((await admin.query(`SELECT payload FROM audit_events WHERE tenant_id = $1 AND type = $2 ORDER BY audit_id`, [c.tenant, type])).rows as Array<{ payload: Record<string, unknown> }>).map((r) => r.payload);

describe("A: fjerning og forlating tilbakekaller identitetsnivået i sirkel-tenanten (LOW-5)", () => {
  for (const how of ["removed", "left"] as const) {
    it(`${how}: personens enheter og grants i sirkelen tilbakekalles (identitetssjekken gir unknown_device); eier, andre medlemmer og personens enhet i EGEN tenant røres ikke; revisjonen teller`, async () => {
      const c = await mkFull();
      const adultPem = await mkDevice(c.tenant, c.adult, `dev-adult-${c.n}`);
      await mkDevice(c.tenant, c.adult, `dev-adult-2-${c.n}`);
      await mkDevice(c.tenant, c.owner, `dev-owner-${c.n}`);
      await mkDevice(c.tenant, c.child, `dev-child-${c.n}`);
      await mkDevice(c.adultData, c.adult, `dev-adult-own-${c.n}`);
      expect(await authz(c.tenant, c.adult, `dev-adult-${c.n}`)).toEqual({ ok: true });

      if (how === "removed") await svc.removeMember(act(c, c.owner), c.adult);
      else await svc.leave(act(c, c.adult));

      for (const device of [`dev-adult-${c.n}`, `dev-adult-2-${c.n}`]) {
        expect(await authz(c.tenant, c.adult, device), device).toEqual({ ok: false, reason: "unknown_device" });
        expect(await grantRevoked(device), device).toBe(true);
      }
      const row = (await admin.query(`SELECT revoked_at, public_key_pem, revoked_reason FROM devices WHERE device_id = $1`, [`dev-adult-${c.n}`])).rows[0] as { revoked_at: Date | null; public_key_pem: string | null; revoked_reason: string };
      expect(row.revoked_at).not.toBeNull();
      expect(row.public_key_pem).toBeNull();
      expect(row.revoked_reason).toBe(`family_member_${how}`);
      expect(((await admin.query(`SELECT 1 FROM revoked_device_keys WHERE tenant_id = $1 AND key_fingerprint = $2`, [c.tenant, fingerprintPem(adultPem)])).rowCount)).toBe(1);

      // Uberørt: eier og andre medlemmer i sirkelen, og personens enhet i hennes EGEN datatenant.
      for (const [person, device] of [[c.owner, `dev-owner-${c.n}`], [c.child, `dev-child-${c.n}`]] as const) {
        expect(await authz(c.tenant, person, device), device).toEqual({ ok: true });
        expect(await grantRevoked(device), device).toBe(false);
      }
      expect(await authz(c.adultData, c.adult, `dev-adult-own-${c.n}`)).toEqual({ ok: true });
      expect(await grantRevoked(`dev-adult-own-${c.n}`)).toBe(false);

      const [audit] = await audits(c, how === "removed" ? "family.member_removed" : "family.member_left");
      expect(audit).toMatchObject({ person_id: c.adult, devices_revoked: 2, grants_revoked: 2 });
    });
  }

  it("den tilbakekalte nøkkelen kan ikke rulles inn igjen i sirkelen under en ny enhets-id (et nytt medlemskap krever en NY nøkkel); en fersk nøkkel kan", async () => {
    const c = await mkFull();
    const pem = await mkDevice(c.tenant, c.adult, `dev-adult-${c.n}`);
    await svc.removeMember(act(c, c.owner), c.adult);
    const devices = new DeviceService(app);
    const enroll = (deviceId: string, key: string) => withTenantTransaction(app, c.tenant, (client) => devices.registerDeviceOn(client, { tenant_id: c.tenant, person_id: c.adult }, { device_id: deviceId, kind: "phone", public_key_pem: key }));
    await expect(enroll(`dev-new-${c.n}`, pem)).rejects.toBeInstanceOf(RevokedDeviceKeyError);
    const fresh = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(await enroll(`dev-new2-${c.n}`, fresh)).toBe(true);
  });

  it("en person uten enheter kan fjernes som før (ingen feil, null tilbakekalt); eierens egne enheter kan aldri tilbakekalles via fjerning (eier kan ikke fjernes/forlate)", async () => {
    const c = await mkFull();
    await mkDevice(c.tenant, c.owner, `dev-owner-${c.n}`);
    await svc.removeMember(act(c, c.owner), c.child);
    expect((await audits(c, "family.member_removed"))[0]).toMatchObject({ devices_revoked: 0, grants_revoked: 0, tickets_consumed: 0 });
    await expect(svc.leave(act(c, c.owner))).rejects.toMatchObject({ code: "owner_cannot_leave" });
    await expect(svc.removeMember(act(c, c.owner), c.owner)).rejects.toMatchObject({ code: "cannot_remove_owner" });
    expect(await authz(c.tenant, c.owner, `dev-owner-${c.n}`)).toEqual({ ok: true });
  });
});

/** Venter til minst `n` av tjenestens egne transaksjoner står blokkert på en lås (kappløpet er da DETERMINISTISK satt opp, ikke avhengig av timing). */
async function waitBlocked(n: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`);
    if ((rows[0] as { n: number }).n >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("blocked_wait_timeout");
}

/**
 * Setter opp kappløpet deterministisk: en åpen transaksjon (vinneren) har satt inn den aktive raden men ikke committet; tjenestekallet (taperen) ser ingenting og blokkerer på den unike indeksen; vinneren committer;
 * taperen våkner med en unik-konflikt.
 */
async function race<T>(c: Circle, winnerInsert: (client: pg.PoolClient) => Promise<void>, loserCall: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let inserted!: () => void;
  const insertedSignal = new Promise<void>((resolve) => { inserted = resolve; });
  const winner = withMemoryTransaction(app, c.tenant, ["shared"], async (client) => { await winnerInsert(client); inserted(); await hold; });
  await insertedSignal;
  const loser = loserCall();
  loser.catch(() => undefined); // feilen (gammel kode) leses under; ingen ubehandlet avvisning før den
  await waitBlocked(1);
  release();
  await winner;
  return loser;
}

describe("B: samtidige grant gir en idempotent retur, ikke en rå unik-feil (LOW-6)", () => {
  it("grantDelegation: taperen av kappløpet får vinnerens rad (samme delegation_id), ingen ny revisjonsrad, og det finnes nøyaktig én aktiv rad", async () => {
    const c = await mkFull();
    const winnerId = `fam-del-winner-${c.n}`;
    const result = await race(c, async (client) => {
      await client.query(
        `INSERT INTO family_delegations (delegation_id, tenant_id, principal_person_id, agent_person_id, scope, granted_by_person_id, granted_at, expires_at) VALUES ($1, $2, $3, $4, 'shared_lists', $3, now(), now() + interval '30 days')`,
        [winnerId, c.tenant, c.owner, c.adult]
      );
    }, () => svc.grantDelegation(act(c, c.owner), { agent_person_id: c.adult, scope: "shared_lists" }));
    expect(result.delegation_id).toBe(winnerId);
    expect(((await admin.query(`SELECT 1 FROM family_delegations WHERE tenant_id = $1 AND revoked_at IS NULL`, [c.tenant])).rowCount)).toBe(1);
    expect(await audits(c, "family.delegation_granted")).toHaveLength(0); // vinneren (direkte innsetting her) reviderte ikke; taperen skriver ingen duplikat
  });

  it("grantShare: samme mønster (vinnerens rad returneres uendret, ingen revisjonsrad fra taperen, én aktiv rad)", async () => {
    const c = await mkFull();
    const winnerId = `fam-shr-winner-${c.n}`;
    const result = await race(c, async (client) => {
      await client.query(
        `INSERT INTO family_shares (share_id, tenant_id, subject_person_id, viewer_person_id, category, granted_by_person_id, granted_at, expires_at) VALUES ($1, $2, $3, $4, 'location', $3, now(), now() + interval '30 days')`,
        [winnerId, c.tenant, c.adult, c.owner]
      );
    }, () => svc.grantShare(act(c, c.adult), { viewer_person_id: c.owner, category: "location", ttl_days: 7 }));
    expect(result.share_id).toBe(winnerId);
    expect(((await admin.query(`SELECT 1 FROM family_shares WHERE tenant_id = $1 AND revoked_at IS NULL`, [c.tenant])).rowCount)).toBe(1);
    expect(await audits(c, "family.share_granted")).toHaveLength(0);
  });

  it("uten kappløp er oppførselen uendret: første kall oppretter og reviderer, gjentakelsen returnerer samme rad uten ny revisjon", async () => {
    const c = await mkFull();
    const first = await svc.grantDelegation(act(c, c.owner), { agent_person_id: c.adult, scope: "shared_calendar" });
    const again = await svc.grantDelegation(act(c, c.owner), { agent_person_id: c.adult, scope: "shared_calendar" });
    expect(again.delegation_id).toBe(first.delegation_id);
    expect(await audits(c, "family.delegation_granted")).toHaveLength(1);
    const s = await svc.grantShare(act(c, c.adult), { viewer_person_id: c.owner, category: "location" });
    expect((await svc.grantShare(act(c, c.adult), { viewer_person_id: c.owner, category: "location" })).share_id).toBe(s.share_id);
    expect(await audits(c, "family.share_granted")).toHaveLength(1);
  });
});

describe("C: avhuking av en listepost revideres (LOW-7)", () => {
  it("setItemDone skriver en revisjonsrad per endring med id og tilstand - aldri postens tekst; en avvist endring (ukjent post) skriver ingen", async () => {
    const c = await mkFull();
    const list = await svc.createList(act(c, c.owner), { name: "Handleliste" });
    const item = await svc.addListItem(act(c, c.adult), list.list_id, { body: "Hemmelig innkjøp: melk og brød" });
    await svc.setItemDone(act(c, c.adult), item.item_id, true);
    await svc.setItemDone(act(c, c.owner), item.item_id, false);
    await expect(svc.setItemDone(act(c, c.adult), "finnes-ikke", true)).rejects.toMatchObject({ code: "not_found" });
    const rows = await audits(c, "family.list_item_done_set");
    expect(rows).toEqual([expect.objectContaining({ item_id: item.item_id, done: true }), expect.objectContaining({ item_id: item.item_id, done: false })]);
    expect(JSON.stringify(rows)).not.toContain("melk");
    const actors = ((await admin.query(`SELECT person_id FROM audit_events WHERE tenant_id = $1 AND type = 'family.list_item_done_set' ORDER BY audit_id`, [c.tenant])).rows as Array<{ person_id: string }>).map((r) => r.person_id);
    expect(actors).toEqual([c.adult, c.owner]);
  });
});

describe("D: subjektets rolle sjekkes også ved lesing av en helsedeling (INFO-1, forsvar i dybden)", () => {
  it("en helsedeling fra et barn (satt inn utenom tjenesten) leveres aldri: share_required, leseren kalles ikke, avslaget revideres med årsak; en voksens helsedeling virker som før", async () => {
    const calls: string[] = [];
    const readers: SharedDataReaders = {
      currentPlace: async () => null,
      healthSummary: async (_tenant, person) => { calls.push(person); return { steps_today: 4200, sleep_minutes_last_night: 431, observed_at: "2026-11-18T09:50:00.000Z" }; }
    };
    const reading = new FamilyService(app, { readers });
    const c = await mkFull();
    await admin.query(`INSERT INTO family_shares (share_id, tenant_id, subject_person_id, viewer_person_id, category, granted_by_person_id) VALUES ($1, $2, $3, $4, 'health_summary', $3)`, [`fam-shr-child-${c.n}`, c.tenant, c.child, c.owner]);
    await expect(reading.readShared(act(c, c.owner), c.child, "health_summary")).rejects.toMatchObject({ code: "share_required" });
    expect(calls).toEqual([]);
    const denied = ((await admin.query(`SELECT reason FROM audit_events WHERE tenant_id = $1 AND type = 'family.share_denied' ORDER BY audit_id`, [c.tenant])).rows as Array<{ reason: string }>).map((r) => r.reason);
    expect(denied).toEqual(["subject_role_may_not_share"]);

    await reading.grantShare(act(c, c.adult), { viewer_person_id: c.owner, category: "health_summary" });
    expect(await reading.readShared(act(c, c.owner), c.adult, "health_summary")).toMatchObject({ category: "health_summary", steps_today: 4200 });
    expect(calls).toEqual([c.adult]);
  });
});

describe("E: fjerning og forlating forbruker personens åpne innrullingsbilletter i sirkel-tenanten (delta-review B INFO)", () => {
  /** En ekte billett fra samme funksjon som eier-CLI-en bruker: den rå billetten (til innrullering) og radens ID (SHA-256). `ttl_minutes: -5` gir en billett som nettopp har utløpt uten å ha vært brukt. */
  const issue = async (tenant: string, person: string, opts: { device_id?: string; ttl_minutes?: number } = {}): Promise<{ ticket: string; id: string }> => {
    const created = await createEnrollmentTicket(admin, { tenant_id: tenant, person_id: person, ...(opts.device_id !== undefined ? { device_id: opts.device_id } : {}), ...(opts.ttl_minutes !== undefined ? { ttl_minutes: opts.ttl_minutes } : {}) });
    return { ticket: created.ticket, id: enrollmentTicketId(created.ticket) };
  };
  const ticketRow = async (id: string): Promise<{ consumed_at: Date | null; consumed_device_id: string | null }> =>
    (await admin.query(`SELECT consumed_at, consumed_device_id FROM device_enrollment_tickets WHERE ticket_id = $1`, [id])).rows[0] as { consumed_at: Date | null; consumed_device_id: string | null };
  const enrollWith = (c: Circle, person: string, ticket: string, deviceId: string) =>
    new DeviceEnrollmentService({ pool: app, devices: new DeviceService(app), grants: new SessionGrantService(app) }).enroll({
      tenant_id: c.tenant, person_id: person,
      device: { device_id: deviceId, kind: "phone", public_key_pem: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() },
      enrollment: { kind: "enrollment_ticket", ticket }
    });

  for (const how of ["removed", "left"] as const) {
    it(`${how}: personens åpne billetter i sirkelen forbrukes (også en enhetsbundet og en som nettopp har utløpt uten å bli brukt); en allerede brukt billett, personens billett i EGEN tenant og andres billetter røres ikke; revisjonen teller`, async () => {
      const c = await mkFull();
      const wildcard = await issue(c.tenant, c.adult);
      const narrowed = await issue(c.tenant, c.adult, { device_id: `dev-narrow-${c.n}` });
      const expired = await issue(c.tenant, c.adult, { ttl_minutes: -5 });
      const used = await issue(c.tenant, c.adult);
      await admin.query(`UPDATE device_enrollment_tickets SET consumed_at = '2026-01-01T00:00:00Z', consumed_device_id = 'dev-old' WHERE ticket_id = $1`, [used.id]);
      const ownTenant = await issue(c.adultData, c.adult); // personens egne data: en ANNEN tenant
      const ownerTicket = await issue(c.tenant, c.owner);
      const childTicket = await issue(c.tenant, c.child);

      if (how === "removed") await svc.removeMember(act(c, c.owner), c.adult);
      else await svc.leave(act(c, c.adult));

      for (const [name, t] of [["jokertegn", wildcard], ["enhetsbundet", narrowed], ["utløpt", expired]] as const) {
        const row = await ticketRow(t.id);
        expect(row.consumed_at, name).not.toBeNull();
        expect(row.consumed_device_id, name).toBeNull(); // forbrukt av fjerningen, ikke av en innrullering: ingen enhet ble innrullert
      }
      const usedRow = await ticketRow(used.id);
      expect(usedRow.consumed_device_id).toBe("dev-old"); // en allerede brukt billett forblir uendret
      expect(new Date(usedRow.consumed_at as Date).toISOString()).toBe("2026-01-01T00:00:00.000Z");
      for (const [name, t] of [["egen tenant", ownTenant], ["eier", ownerTicket], ["barn", childTicket]] as const) expect((await ticketRow(t.id)).consumed_at, name).toBeNull();

      const [audit] = await audits(c, how === "removed" ? "family.member_removed" : "family.member_left");
      expect(audit).toMatchObject({ person_id: c.adult, tickets_consumed: 3 });
    });
  }

  it("hele veien: en billett utstedt FØR fjerningen kan ikke lenger rulle inn en ny enhet (`enrollment_ticket_invalid`, ingen enhet skrevet) - og billetter virker som vanlig FØR fjerningen", async () => {
    const c = await mkFull();
    const control = await issue(c.tenant, c.adult);
    const before = await issue(c.tenant, c.adult);
    expect(await enrollWith(c, c.adult, control.ticket, `dev-control-${c.n}`)).toMatchObject({ ok: true }); // billetter virker (ellers sier testen under ingenting)
    await svc.removeMember(act(c, c.owner), c.adult);
    expect(await enrollWith(c, c.adult, before.ticket, `dev-after-${c.n}`)).toEqual({ ok: false, reason: "enrollment_ticket_invalid" });
    expect((await admin.query(`SELECT 1 FROM devices WHERE device_id = $1`, [`dev-after-${c.n}`])).rowCount).toBe(0);
    expect(await authz(c.tenant, c.adult, `dev-after-${c.n}`)).toEqual({ ok: false, reason: "unknown_device" });
  });

  it("en avvist fjerning forbruker ingen billetter (eier kan ikke fjernes; ikke-eier kan ikke fjerne), og en billett utstedt ETTER fjerningen (nytt medlemskap) er ikke berørt", async () => {
    const c = await mkFull();
    const ownerTicket = await issue(c.tenant, c.owner);
    const adultTicket = await issue(c.tenant, c.adult);
    await expect(svc.removeMember(act(c, c.owner), c.owner)).rejects.toMatchObject({ code: "cannot_remove_owner" });
    await expect(svc.removeMember(act(c, c.adult), c.child)).rejects.toMatchObject({ code: "role_not_allowed" });
    await expect(svc.leave(act(c, c.owner))).rejects.toMatchObject({ code: "owner_cannot_leave" });
    expect((await ticketRow(ownerTicket.id)).consumed_at).toBeNull();
    expect((await ticketRow(adultTicket.id)).consumed_at).toBeNull();
    await svc.removeMember(act(c, c.owner), c.adult);
    expect((await ticketRow(adultTicket.id)).consumed_at).not.toBeNull();
    const reissued = await issue(c.tenant, c.adult); // utstedt etter fjerningen: en bevisst, ny handling av eieren
    expect((await ticketRow(reissued.id)).consumed_at).toBeNull();
  });

  it("billettene forbrukes i SAMME transaksjon som fjerningen: hele fjerningen (medlemskap, delinger, enheter, grants, billetter, revisjon) bruker nøyaktig én forbindelse fra poolen", async () => {
    for (const how of ["removed", "left"] as const) {
      const c = await mkFull();
      await issue(c.tenant, c.adult);
      let acquired = 0;
      const onAcquire = (): void => { acquired += 1; };
      app.on("acquire", onAcquire);
      try {
        if (how === "removed") await svc.removeMember(act(c, c.owner), c.adult);
        else await svc.leave(act(c, c.adult));
      } finally { app.off("acquire", onAcquire); }
      expect(acquired, how).toBe(1);
    }
  });
});

/**
 * Delta-review B NY2-1 (adfa8308): fjerning er en SIKKERHETSKONTROLL og må være riktig også mot en SAMTIDIG innrullering. Den forrige rekkefølgen (liste og tilbakekalle enheter FØR billett-UPDATE, én gang) var motsatt av innrulleringens (billett, så enhet):
 *  - R-A: en billett-innrullering som committer mellom enhetslistingen og billett-UPDATE ga en NY enhet som sto AKTIV hos et fjernet medlem;
 *  - R-C: det samme via `device_proof` (den autoriserende enheten er låst `FOR UPDATE`, den nye settes inn ucommittet);
 *  - R-B: innrullering av en EKSISTERENDE enhet med billett ga deadlock (40P01): fjerningen rullet tilbake (500) og medlemmet sto `active` (regresjon fra runde 2).
 * Nå: billettene FØRST (samme låsrekkefølge som innrulleringen), så list + tilbakekall av enheter i en LØKKE til ingen aktive står igjen. Samtidigheten settes opp DETERMINISTISK (en åpen transaksjon holder radlåsen, og testen venter til fjerningen faktisk står blokkert).
 */
describe("F: fjerning mot en SAMTIDIG innrullering - ingen aktiv enhet overlever, ingen deadlock (delta-review B NY2-1)", () => {
  const rawKey = (): string => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const issueTicket = async (tenant: string, person: string): Promise<string> => enrollmentTicketId((await createEnrollmentTicket(admin, { tenant_id: tenant, person_id: person })).ticket);
  const isActive = async (deviceId: string): Promise<boolean | undefined> => ((await admin.query(`SELECT revoked_at IS NULL AS active FROM devices WHERE device_id = $1`, [deviceId])).rows[0] as { active: boolean } | undefined)?.active;
  const memberStatus = async (c: Circle, person: string): Promise<string> => ((await admin.query(`SELECT status FROM family_members WHERE tenant_id = $1 AND person_id = $2`, [c.tenant, person])).rows[0] as { status: string }).status;
  const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: unknown) => `ERR:${(e as { code?: string }).code ?? (e as Error).message.slice(0, 120)}`);
  /** Aldri et hengende test: en deadlock/ventende fjerning gir en tydelig feil i stedet for en timeout i vitest. */
  const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`timeout: ${what}`)), ms))]);

  it("R-A (billett): innrulleringen har konsumert billetten og satt inn en NY enhet, men er ikke committet når fjerningen starter - når fjerningen er ferdig er den nye enheten tilbakekalt (identitetssjekken gir `unknown_device`), medlemmet er `removed`", async () => {
    const c = await mkFull();
    const ticket = await issueTicket(c.tenant, c.adult);
    const deviceId = `dev-race-a-${c.n}`;
    const redeemer = await admin.connect();
    try {
      await redeemer.query("BEGIN");
      const consumed = await redeemer.query(`UPDATE device_enrollment_tickets SET consumed_at = now(), consumed_device_id = $2 WHERE ticket_id = $1 AND consumed_at IS NULL RETURNING ticket_id`, [ticket, deviceId]);
      expect(consumed.rowCount).toBe(1); // innrulleringens første steg (billett), så enheten - transaksjonen holdes ÅPEN
      await redeemer.query(`INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1, $2, $3, 'phone', $4)`, [deviceId, c.tenant, c.adult, rawKey()]);
      const removal = outcome(svc.removeMember(act(c, c.owner), c.adult));
      await waitBlocked(1); // fjerningen står blokkert på billett-raden som innrulleringen holder
      await redeemer.query("COMMIT");
      expect(await within(removal, 20_000, "fjerningen ble ikke ferdig")).toBe("ok");
    } finally {
      await redeemer.query("ROLLBACK").catch(() => undefined);
      redeemer.release();
    }
    expect(await memberStatus(c, c.adult)).toBe("removed");
    expect(await isActive(deviceId), "den nye enheten er tilbakekalt").toBe(false);
    expect(await authz(c.tenant, c.adult, deviceId)).toEqual({ ok: false, reason: "unknown_device" });
    expect((await audits(c, "family.member_removed"))[0]).toMatchObject({ devices_revoked: 1 });
  }, 60_000);

  it("R-B (motsatt låsrekkefølge): innrullering av en EKSISTERENDE enhet med billett (billett, så enhet) mot fjerningen gir ingen deadlock - begge fullfører, fjerningen er ok, medlemmet `removed` og enheten tilbakekalt", async () => {
    const c = await mkFull();
    const deviceId = `dev-race-b-${c.n}`;
    await mkDevice(c.tenant, c.adult, deviceId);
    const ticket = await issueTicket(c.tenant, c.adult);
    const redeemer = await admin.connect();
    let results: [string, string] = ["", ""];
    try {
      await redeemer.query("BEGIN");
      await redeemer.query(`UPDATE device_enrollment_tickets SET consumed_at = now(), consumed_device_id = $2 WHERE ticket_id = $1 AND consumed_at IS NULL`, [ticket, deviceId]);
      const removal = outcome(svc.removeMember(act(c, c.owner), c.adult));
      await waitBlocked(1); // fjerningen står blokkert (på billett-raden) - gammel kode har da allerede låst enheten
      // innrulleringens neste steg: skriv den eksisterende enheten (nøkkelrotasjon). Gammel kode: deadlock mellom enheten (fjerningen) og billetten (innrulleringen).
      const redeem = redeemer.query(`UPDATE devices SET public_key_pem = $3 WHERE device_id = $1 AND tenant_id = $2`, [deviceId, c.tenant, rawKey()]).then(
        async () => { await redeemer.query("COMMIT"); return "ok"; },
        async (e: unknown) => { await redeemer.query("ROLLBACK").catch(() => undefined); return `ERR:${(e as { code?: string }).code ?? "?"}`; }
      );
      results = await within(Promise.all([removal, redeem]), 30_000, "deadlock eller hengende fjerning");
    } finally {
      await redeemer.query("ROLLBACK").catch(() => undefined);
      redeemer.release();
    }
    expect(results, "fjerning, innrullering").toEqual(["ok", "ok"]);
    expect(await memberStatus(c, c.adult)).toBe("removed");
    expect(await isActive(deviceId)).toBe(false);
    expect(await authz(c.tenant, c.adult, deviceId)).toEqual({ ok: false, reason: "unknown_device" });
  }, 60_000);

  for (const how of ["removed", "left"] as const) {
    it(`R-C (device_proof, ${how}): innrulleringen holder den autoriserende enheten (FOR UPDATE) og har satt inn en NY enhet (ucommittet) - den nye enheten er også tilbakekalt når ${how === "removed" ? "fjerningen" : "forlatelsen"} er ferdig`, async () => {
      const c = await mkFull();
      const authorizing = `dev-race-c1-${c.n}`;
      const added = `dev-race-c2-${c.n}`;
      await mkDevice(c.tenant, c.adult, authorizing);
      const redeemer = await admin.connect();
      try {
        await redeemer.query("BEGIN");
        await redeemer.query(`SELECT 1 FROM devices WHERE device_id = $1 AND tenant_id = $2 FOR UPDATE`, [authorizing, c.tenant]);
        await redeemer.query(`INSERT INTO devices (device_id, tenant_id, person_id, kind, public_key_pem) VALUES ($1, $2, $3, 'phone', $4)`, [added, c.tenant, c.adult, rawKey()]);
        const end = outcome(how === "removed" ? svc.removeMember(act(c, c.owner), c.adult) : svc.leave(act(c, c.adult)));
        await waitBlocked(1); // står blokkert på den autoriserende enhetens rad
        await redeemer.query("COMMIT");
        expect(await within(end, 20_000, "fjerningen ble ikke ferdig")).toBe("ok");
      } finally {
        await redeemer.query("ROLLBACK").catch(() => undefined);
        redeemer.release();
      }
      expect(await memberStatus(c, c.adult)).toBe(how);
      expect(await isActive(authorizing)).toBe(false);
      expect(await isActive(added), "den NYE enheten er tilbakekalt").toBe(false);
      expect(await authz(c.tenant, c.adult, added)).toEqual({ ok: false, reason: "unknown_device" });
      expect((await audits(c, how === "removed" ? "family.member_removed" : "family.member_left"))[0]).toMatchObject({ devices_revoked: 2 });
    }, 60_000);
  }
});
