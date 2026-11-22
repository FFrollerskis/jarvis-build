import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding } from "@jarvis/memory";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";
// Relativ import (IKKE en ny @jarvis/erasure -> @jarvis/context pakkeavhengighet kun for en testfil) - samme presedens som vision-erasure.test.ts.
import { FamilyService } from "../../context/src/family/service.ts";
import type { FamilyActor } from "../../context/src/family/types.ts";

/**
 * WP-G2 (D-464) P1c: end-to-end-bevis, via den EKTE `ErasureService.executeErasure()`, at sletting fjerner familiesirkel-dataene (migrasjon 126/127) fullstendig og uten FK-brudd:
 *  A: person-scope fjerner ALT om personen (medlemskap, delinger begge veier, delegasjoner begge veier, felles innhold personen har opprettet/gjelder, invitasjoner) uten å røre andre medlemmer sine rader.
 *  B: memory space-scope (`shared`) fjerner hele sirkelen i tenanten og lar en annen sirkel stå urørt.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let policy: PolicyGateway;
let embedding: LocalHashEmbedding;
let family: FamilyService;

const TENANT = "tenant-fam-erase";
const OTHER = "tenant-fam-erase-other";
const OWNER = "person-fam-e-owner";
const A = "person-fam-e-a";
const B = "person-fam-e-b";
const C = "person-fam-e-c";
const OTHER_OWNER = "person-fam-e-other-owner";
const OTHER_ADULT = "person-fam-e-other-adult";

const actor = (tenant: string, person: string): FamilyActor => ({ tenant_id: tenant, person_id: person, memory_space_id: "shared", session_id: `sess-${person}`, device_id: `dev-${person}`, channel: "api", auth_strength: "signed" });
const identityFor = (tenant: string): IdentityContext => ({ person_id: OWNER, tenant_id: tenant, memory_space_id: "personal", session_id: `sess-erase-${tenant}`, device_id: "dev-erase", channel: "api", auth_strength: "active" });

const FAMILY_TABLES = ["family_delegations", "family_events", "family_invitations", "family_list_items", "family_lists", "family_members", "family_shares"] as const;

async function counts(tenant: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of FAMILY_TABLES) out[table] = ((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenant])).rows[0] as { n: number }).n;
  return out;
}

async function personRows(table: string, columns: string[], person: string): Promise<number> {
  const where = columns.map((c) => `${c} = $2`).join(" OR ");
  return ((await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND (${where})`, [TENANT, person])).rows[0] as { n: number }).n;
}

async function join_(service: FamilyService, tenant: string, owner: string, person: string, role: "adult" | "child"): Promise<void> {
  const inv = await service.invite(actor(tenant, owner), { invitee_person_id: person, role });
  await service.acceptInvitation(actor(tenant, person), inv.invitation_id);
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-fam-erasure-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_fam_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_fam_erasure_test");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Family circle','person'), ('${OTHER}','Other circle','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Owner'), ('${A}','A'), ('${B}','B'), ('${C}','C'), ('${OTHER_OWNER}','OO'), ('${OTHER_ADULT}','OA');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}'), ('${A}','${TENANT}'), ('${B}','${TENANT}'), ('${C}','${TENANT}'), ('${OWNER}','${OTHER}'), ('${OTHER_OWNER}','${OTHER}'), ('${OTHER_ADULT}','${OTHER}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-fam-e-shared','${TENANT}','shared'), ('ms-fam-e-other-shared','${OTHER}','shared');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_fam_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [TENANT, OTHER] } });
  family = new FamilyService(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("A: person-scope erasure fjerner personens sirkel-avtrykk uten å røre andre medlemmer", () => {
  it("medlemskap, delinger/delegasjoner begge veier, felles innhold og invitasjoner for A slettes; B, C og eier urørt; ingen FK-brudd", async () => {
    // Sirkel med eier, to voksne og et barn
    await family.bootstrapOwner(actor(TENANT, OWNER), OWNER);
    await join_(family, TENANT, OWNER, A, "adult");
    await join_(family, TENANT, OWNER, B, "adult");
    await join_(family, TENANT, OWNER, C, "child");
    // Delinger: A -> eier (lokasjon), eier -> A (lokasjon), B -> eier (helse) [urørt], B -> A (lokasjon)
    await family.grantShare(actor(TENANT, A), { viewer_person_id: OWNER, category: "location" });
    await family.grantShare(actor(TENANT, OWNER), { viewer_person_id: A, category: "location" });
    await family.grantShare(actor(TENANT, B), { viewer_person_id: OWNER, category: "health_summary" });
    await family.grantShare(actor(TENANT, B), { viewer_person_id: A, category: "location" });
    // Delegasjoner: A -> eier (lister og kalender), eier -> A (kalender), B -> eier (lister) [urørt]
    await family.grantDelegation(actor(TENANT, A), { agent_person_id: OWNER, scope: "shared_lists" });
    await family.grantDelegation(actor(TENANT, A), { agent_person_id: OWNER, scope: "shared_calendar" });
    await family.grantDelegation(actor(TENANT, OWNER), { agent_person_id: A, scope: "shared_calendar" });
    await family.grantDelegation(actor(TENANT, B), { agent_person_id: OWNER, scope: "shared_lists" });
    // Felles innhold: A sin liste (med elementer fra B og C), B sin liste (med element fra A, C og eieren på vegne av A), hendelser
    const listA = await family.createList(actor(TENANT, A), { name: "A sin liste" });
    await family.addListItem(actor(TENANT, B), listA.list_id, { body: "fra B i A sin liste" });
    await family.addListItem(actor(TENANT, C), listA.list_id, { body: "fra C i A sin liste" });
    const listB = await family.createList(actor(TENANT, B), { name: "B sin liste" });
    const itemFromA = await family.addListItem(actor(TENANT, A), listB.list_id, { body: "fra A i B sin liste" });
    await family.addListItem(actor(TENANT, C), listB.list_id, { body: "fra C i B sin liste" });
    await family.addListItem(actor(TENANT, OWNER), listB.list_id, { body: "fra eier på vegne av A", on_behalf_of: A });
    const itemDoneByA = await family.addListItem(actor(TENANT, B), listB.list_id, { body: "B sitt element utført av A" });
    await family.setItemDone(actor(TENANT, A), itemDoneByA.item_id, true);
    await family.createEvent(actor(TENANT, A), { title: "A sin hendelse", starts_at: "2026-12-01T10:00:00Z", ends_at: "2026-12-01T11:00:00Z" });
    await family.createEvent(actor(TENANT, B), { title: "B sin hendelse", starts_at: "2026-12-02T10:00:00Z", ends_at: "2026-12-02T11:00:00Z" });
    await family.createEvent(actor(TENANT, OWNER), { title: "Eier for A", starts_at: "2026-12-03T10:00:00Z", ends_at: "2026-12-03T11:00:00Z", on_behalf_of: A });
    const cancelled = await family.createEvent(actor(TENANT, B), { title: "B sin avlyste", starts_at: "2026-12-04T10:00:00Z", ends_at: "2026-12-04T11:00:00Z" });
    await family.cancelEvent(actor(TENANT, A), cancelled.event_id); // A er voksen og kan avlyse (events:cancel): avlysningen peker på A
    const before = await counts(TENANT);
    expect(before["family_members"]).toBe(4);
    expect(before["family_shares"]).toBe(4);
    expect(before["family_delegations"]).toBe(4);
    expect(before["family_invitations"]).toBe(3);
    expect(before["family_lists"]).toBe(2);
    expect(before["family_list_items"]).toBe(6);
    expect(before["family_events"]).toBe(4);

    const service = new ErasureService(app, policy, embedding);
    const result = await service.executeErasure({ scope: { type: "person", tenant_id: TENANT, person_id: A }, requestId: `req-fam-erase-${randomUUID()}`, identity: identityFor(TENANT) });
    expect(result.status).toBe("completed"); // ville vært "failed" ved feil slettingsrekkefølge mot sammensatte FK-er
    expect(result.error).toBeUndefined();

    // Ingenting igjen som peker på A, i noen kolonne.
    expect(await personRows("family_members", ["person_id", "added_by_person_id"], A)).toBe(0);
    expect(await personRows("family_shares", ["subject_person_id", "viewer_person_id", "granted_by_person_id", "revoked_by_person_id"], A)).toBe(0);
    expect(await personRows("family_delegations", ["principal_person_id", "agent_person_id", "granted_by_person_id", "revoked_by_person_id"], A)).toBe(0);
    expect(await personRows("family_lists", ["created_by_person_id", "on_behalf_of_person_id"], A)).toBe(0);
    expect(await personRows("family_list_items", ["added_by_person_id", "on_behalf_of_person_id", "done_by_person_id"], A)).toBe(0);
    expect(await personRows("family_events", ["created_by_person_id", "on_behalf_of_person_id", "cancelled_by_person_id"], A)).toBe(0);
    expect(await personRows("family_invitations", ["invitee_person_id", "decided_by_person_id"], A)).toBe(0);

    // Andre er urørt: eier/B/C sine medlemskap, B -> eier-delingen og -delegasjonen, B sin liste (uten A sine elementer), B sine hendelser.
    const after = await counts(TENANT);
    expect(after["family_members"]).toBe(3);
    expect(after["family_shares"]).toBe(1); // kun B -> eier (helse)
    expect(after["family_delegations"]).toBe(1); // kun B -> eier (lister): A som prinsipal (to) og som agent (en) er slettet
    expect(after["family_lists"]).toBe(1); // B sin; A sin liste tok sine elementer med seg
    expect(after["family_list_items"]).toBe(1); // kun «fra C i B sin liste»
    expect(after["family_events"]).toBe(1); // B sin hendelse (den avlyste ble avlyst av A: peker på A og slettes; «Eier for A» gjelder A)
    expect(after["family_invitations"]).toBe(2); // kun invitasjonene til B og C; invitasjonen til A er slettet (eierens øvrige er urørt)
    const { rows: items } = await admin.query(`SELECT body FROM family_list_items WHERE tenant_id = $1`, [TENANT]);
    expect((items as Array<{ body: string }>).map((r) => r.body)).toEqual(["fra C i B sin liste"]);
    expect(itemFromA.item_id).toBeTruthy();
    // Telleren i resultatet speiler det som ble slettet.
    expect(result.record_counts["family_members"]).toBe(1);
    expect(result.record_counts["family_shares"]).toBe(3);
    expect(result.record_counts["family_delegations"]).toBe(3);
    expect(result.record_counts["family_invitations"]).toBe(1);
    expect(result.record_counts["family_lists"]).toBe(1);
    expect(result.record_counts["family_list_items"]).toBe(5);
    expect(result.record_counts["family_events"]).toBe(3);
    // Sirkelen fungerer fortsatt for de gjenværende, og A har ingen tilgang lenger.
    expect((await family.getCircle(actor(TENANT, OWNER))).members.map((m) => m.person_id).sort()).toEqual([OWNER, B, C].sort());
    await expect(family.getCircle(actor(TENANT, A))).rejects.toMatchObject({ code: "not_a_member" });
  });
});

describe("B: memory space-scope (`shared`) fjerner hele sirkelen og lar en annen sirkel stå urørt", () => {
  it("alle sju tabeller er tomme for tenanten etter sletting; den andre sirkelen er uendret", async () => {
    await family.bootstrapOwner(actor(OTHER, OWNER), OWNER);
    await join_(family, OTHER, OWNER, OTHER_ADULT, "adult");
    await family.grantShare(actor(OTHER, OTHER_ADULT), { viewer_person_id: OWNER, category: "location" });
    const otherList = await family.createList(actor(OTHER, OTHER_ADULT), { name: "Annen sirkel" });
    await family.addListItem(actor(OTHER, OWNER), otherList.list_id, { body: "urørt" });
    const otherBefore = await counts(OTHER);
    expect(otherBefore["family_members"]).toBe(2);
    expect((await counts(TENANT))["family_members"]).toBeGreaterThan(0);

    const service = new ErasureService(app, policy, embedding);
    const result = await service.executeErasure({ scope: { type: "memory_space", tenant_id: TENANT, memory_space_id: "shared" }, requestId: `req-fam-erase-space-${randomUUID()}`, identity: identityFor(TENANT) });
    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
    const gone = await counts(TENANT);
    for (const table of FAMILY_TABLES) expect(gone[table]).toBe(0);
    expect(await counts(OTHER)).toEqual(otherBefore);
  });
});
