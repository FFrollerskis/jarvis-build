import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { TENANT_A, TENANT_B } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c K4 (JARVIS-112 f1, Q-72 pkt 11): kontaktkonflikter som FORSLAG. `contacts_sync` hopper over en kontakt hvis identifikatorer eies av en annen kontakt (`shared_identity`) eller peker på flere identiteter (`split_identities`); før WP-G1c ble det kun
 * rapportert og funnet på nytt ved hver synk. Nå lagres hver konflikt idempotent (kun Googles ressursnavn - aldri telefon, e-post eller navn), og eieren godtar eller avviser den (`list_contact_conflicts`/`decide_contact_conflict`). Godta = eksplisitt lenking til den
 * delte identiteten (aldri en sammenslåing av ulike identiteter); avvis huskes. Lenkene har fortsatt `match_method: contact_sync`, så mottakeren er fortsatt KALD (dagens kald-regel er pinnet under; den venter på eierens bekreftelse, Q-72 pkt 11).
 * Fiktive Google People-svar via stubbet `fetch`; ekte Postgres, ekte Conversation Graph og den ekte eier-kjeden.
 */
let chain: Chain;
let people: Map<string, Record<string, unknown>> = new Map();
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const person = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  resourceName: `people/c${id}`, etag: `etag-${id}`, metadata: { sources: [{ type: "CONTACT", id, etag: `src-etag-${id}` }] },
  names: [{ displayName: `Kontakt ${id}`, givenName: "Kontakt", familyName: id }], emailAddresses: [{ value: `kontakt${id}@example.com` }], phoneNumbers: [{ value: `+47 900 0${id.padStart(4, "0")}` }], ...over
});
const publish = (...list: Array<Record<string, unknown>>): void => { people = new Map(list.map((p) => [String(p["resourceName"]), p])); };
const sync = () => chain.act("contacts_sync", {});
type Conflict = { resource_name: string; with: string[]; conflict_id: string | null; status: string | null };
const conflictsOf = (r: Awaited<ReturnType<typeof sync>>): Conflict[] => (r.ok ? ((r.data as { conflicts: Conflict[] }).conflicts) : []);
const countOf = (r: Awaited<ReturnType<typeof sync>>): number => (r.ok ? (r.data as { contacts_conflict: number }).contacts_conflict : -1);
const decide = (conflict_id: string, decision: "accept" | "dismiss", key = chain.key("dcc")) => chain.act("decide_contact_conflict", { conflict_id, decision }, key);
const rowsOf = async (resource: string) => (await chain.db.admin.query(
  "SELECT conflict_id, kind, status, conflicting_resources, seen_count, decided_by_person_id, decided_at FROM comms_contact_conflicts WHERE tenant_id = $1 AND resource_name = $2 ORDER BY first_seen_at, conflict_id", [TENANT_A, resource]
)).rows as Array<{ conflict_id: string; kind: string; status: string; conflicting_resources: string[]; seen_count: number; decided_by_person_id: string | null; decided_at: Date | null }>;
const identityOfEmail = async (email: string): Promise<string | null> => (await chain.graph.resolveIdentityByChannel(TENANT_A, "business", "email", email))?.identity_id ?? null;
const linksOf = async (identityId: string) => (await chain.graph.listChannelLinks(TENANT_A, "business", identityId)).filter((l) => l.status === "active");

beforeAll(async () => {
  chain = await startChain("g1ccf", {}, { deps: { contacts: true }, lenientToolLimits: true });
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);
beforeEach(() => {
  people = new Map();
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("/connections")) return jsonRes({ connections: [...people.values()] });
    const name = /\/v1\/(people\/c\d+)/.exec(u)?.[1];
    const found = name === undefined ? undefined : people.get(name);
    return found === undefined ? jsonRes({ error: { code: 404, status: "NOT_FOUND" } }, 404) : jsonRes(found);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("A: konflikter lagres som forslag (idempotent, kun ressursnavn)", () => {
  it("to kontakter med samme telefon: den andre er en `shared_identity`-konflikt, lagret som `proposed` (sync-svaret bærer id og status); samme synk igjen gir SAMME rad (teller økt, ingen duplikat); ingen telefon/e-post/navn lagres", async () => {
    publish(person("101", { phoneNumbers: [{ value: "+4722000101" }], emailAddresses: [{ value: "ola@hansen101.no" }] }), person("102", { phoneNumbers: [{ value: "+4722000101" }], emailAddresses: [{ value: "kari@hansen102.no" }] }));
    const first = await sync();
    expect(first.ok && first.data).toMatchObject({ scanned: 2, linked_identifiers: 2, contacts_conflict: 1 });
    const [c] = conflictsOf(first);
    expect(c).toMatchObject({ resource_name: "people/c102", with: ["people/c101"], status: "proposed" });
    expect(c!.conflict_id).toMatch(/^ccf-/);
    expect(await rowsOf("people/c102")).toMatchObject([{ conflict_id: c!.conflict_id, kind: "shared_identity", status: "proposed", conflicting_resources: ["people/c101"], seen_count: 1, decided_by_person_id: null, decided_at: null }]);

    const again = await sync();
    expect(conflictsOf(again)[0]).toMatchObject({ conflict_id: c!.conflict_id, status: "proposed" });
    expect(await rowsOf("people/c102")).toMatchObject([{ conflict_id: c!.conflict_id, seen_count: 2 }]);

    const dump = JSON.stringify((await chain.db.admin.query("SELECT * FROM comms_contact_conflicts WHERE tenant_id = $1", [TENANT_A])).rows);
    for (const secret of ["4722000101", "ola@hansen101.no", "kari@hansen102.no", "Kontakt 102", "hansen"]) expect(dump, secret).not.toContain(secret);
  });

  it("identifikatorer på ULIKE identiteter: `split_identities` (tomt konfliktsett); samme kontakt og samme sett gir aldri en ny rad, uansett antall synker", async () => {
    await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "email", channel_identifier: "per@firma111.no", confidence: 1, match_method: "exact_email", display_name: "Per" });
    await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "sms", channel_identifier: "+4722000111", confidence: 1, match_method: "exact_phone_e164", display_name: "Sentralbord" });
    publish(person("111", { phoneNumbers: [{ value: "+4722000111" }], emailAddresses: [{ value: "per@firma111.no" }] }));
    for (let i = 0; i < 3; i++) expect(countOf(await sync())).toBe(1);
    expect(await rowsOf("people/c111")).toMatchObject([{ kind: "split_identities", status: "proposed", conflicting_resources: [], seen_count: 3 }]);
  });

  it("endres konfliktsettet (en tredje kontakt deler samme telefon etter at eieren har godtatt den andre), er det et NYTT forslag med eget id - det gamle står urørt", async () => {
    publish(person("121", { phoneNumbers: [{ value: "+4722000121" }], emailAddresses: [{ value: "a@x121.no" }] }), person("122", { phoneNumbers: [{ value: "+4722000121" }], emailAddresses: [{ value: "b@x122.no" }] }));
    const c122 = conflictsOf(await sync())[0]!;
    expect((await decide(c122.conflict_id!, "accept")).ok).toBe(true);
    publish(person("121", { phoneNumbers: [{ value: "+4722000121" }], emailAddresses: [{ value: "a@x121.no" }] }), person("122", { phoneNumbers: [{ value: "+4722000121" }], emailAddresses: [{ value: "b@x122.no" }] }), person("123", { phoneNumbers: [{ value: "+4722000121" }], emailAddresses: [{ value: "c@x123.no" }] }));
    const r = await sync();
    expect(countOf(r)).toBe(1); // 121 og 122 er godtatt og ikke lenger en konflikt; 123 deler telefonen med BEGGE
    const c123 = conflictsOf(r)[0]!;
    expect(c123).toMatchObject({ resource_name: "people/c123", with: ["people/c121", "people/c122"], status: "proposed" });
    expect((await rowsOf("people/c122"))).toHaveLength(1);
  });
});

describe("B: eierens avgjørelse", () => {
  it("avvis: huskes (samme konflikt foreslås ikke på nytt, status `dismissed` i sync-svaret), listen er tom som standard og viser den med status-filter; ingenting lenkes", async () => {
    publish(person("131", { phoneNumbers: [{ value: "+4722000131" }], emailAddresses: [{ value: "a@x131.no" }] }), person("132", { phoneNumbers: [{ value: "+4722000131" }], emailAddresses: [{ value: "b@x132.no" }] }));
    const c = conflictsOf(await sync())[0]!;
    const d = await decide(c.conflict_id!, "dismiss");
    expect(d.ok, JSON.stringify(d)).toBe(true);
    expect(d.ok && d.data).toMatchObject({ conflict: { conflict_id: c.conflict_id, status: "dismissed" }, linked: 0 });
    const row = (await rowsOf("people/c132"))[0]!;
    expect(row).toMatchObject({ status: "dismissed", decided_by_person_id: "person-g1-owner" });
    expect(row.decided_at).toBeInstanceOf(Date);
    const again = await sync();
    expect(countOf(again)).toBe(1);
    expect(conflictsOf(again)[0]).toMatchObject({ conflict_id: c.conflict_id, status: "dismissed" });
    expect((await rowsOf("people/c132")).length).toBe(1);
    expect(await identityOfEmail("b@x132.no")).toBeNull();
    const open = await chain.act("list_contact_conflicts", {});
    expect(open.ok && (open.data as Array<{ conflict_id: string }>).map((x) => x.conflict_id)).not.toContain(c.conflict_id);
    const dismissed = await chain.act("list_contact_conflicts", { status: "dismissed", limit: 200 });
    expect(dismissed.ok && (dismissed.data as Array<{ conflict_id: string }>).map((x) => x.conflict_id)).toContain(c.conflict_id);
  });

  it("godta: kontaktens identifikatorer lenkes til den delte identiteten (contact_sync, 0.9; ingen sammenslåing, ingen ny identitet), valget huskes, og senere synker gir ingen konflikt i NOEN retning", async () => {
    publish(person("141", { phoneNumbers: [{ value: "+4722000141" }], emailAddresses: [{ value: "ola@x141.no" }] }), person("142", { phoneNumbers: [{ value: "+4722000141" }], emailAddresses: [{ value: "kari@x142.no" }] }));
    const c = conflictsOf(await sync())[0]!;
    const identity = (await identityOfEmail("ola@x141.no"))!;
    const merges = async () => ((await chain.db.admin.query("SELECT count(*)::int AS n FROM conversation_identity_merges WHERE tenant_id = $1", [TENANT_A])).rows[0] as { n: number }).n;
    const identitiesBefore = ((await chain.db.admin.query("SELECT count(*)::int AS n FROM conversation_identities WHERE tenant_id = $1", [TENANT_A])).rows[0] as { n: number }).n;
    const mergesBefore = await merges();

    const accepted = await decide(c.conflict_id!, "accept");
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    expect(accepted.ok && accepted.data).toMatchObject({ conflict: { status: "accepted" }, linked: 2 });
    expect(await identityOfEmail("kari@x142.no")).toBe(identity);
    const links = await linksOf(identity);
    expect(links.filter((l) => l.external_id === "people/c142").map((l) => `${l.match_method}:${Number(l.confidence)}`)).toEqual(["contact_sync:0.9"]);
    expect(links.every((l) => l.match_method === "contact_sync")).toBe(true);
    expect(await merges()).toBe(mergesBefore);
    expect(((await chain.db.admin.query("SELECT count(*)::int AS n FROM conversation_identities WHERE tenant_id = $1", [TENANT_A])).rows[0] as { n: number }).n).toBe(identitiesBefore);
    expect(await rowsOf("people/c142")).toMatchObject([{ status: "accepted", decided_by_person_id: "person-g1-owner" }]);

    // begge retninger: ingen konflikt for 142 (godtatt) og ingen for 141 (142 eier nå en lenke på identiteten, men eieren har godtatt det)
    const later = await sync();
    expect(countOf(later), JSON.stringify(later)).toBe(0);
    expect(await rowsOf("people/c141")).toEqual([]);
    expect((await rowsOf("people/c142")).length).toBe(1);
  });

  it("godta en `split_identities`-konflikt avvises (ville slått sammen identiteter) - både av koden og av databasen; forslaget forblir åpent, og ingenting lenkes", async () => {
    const own = await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "email", channel_identifier: "per@firma151.no", confidence: 1, match_method: "exact_email", display_name: "Per" });
    await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "sms", channel_identifier: "+4722000151", confidence: 1, match_method: "exact_phone_e164", display_name: "Sentralbord" });
    publish(person("151", { phoneNumbers: [{ value: "+4722000151" }], emailAddresses: [{ value: "per@firma151.no" }] }));
    const c = conflictsOf(await sync())[0]!;
    const r = await decide(c.conflict_id!, "accept");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("comms_contact_conflict_not_acceptable:split_identities");
    expect((await rowsOf("people/c151"))[0]).toMatchObject({ kind: "split_identities", status: "proposed" });
    expect((await linksOf(own.identity_id)).map((l) => l.external_id)).toEqual([null]);
    // DB-sperre (som tabelleier, uten om koden): godtatt er ikke lov for `split_identities`
    await expect(chain.db.admin.query("UPDATE comms_contact_conflicts SET status = 'accepted', decided_at = now(), decided_by_person_id = 'person-g1-owner' WHERE tenant_id = $1 AND conflict_id = $2", [TENANT_A, c.conflict_id])).rejects.toThrow(/check constraint/);
    // ... men å avvise den er lov
    expect((await decide(c.conflict_id!, "dismiss")).ok).toBe(true);
  });

  it("lagringslaget alene avviser å godta en `split_identities`-konflikt (tredje lag etter koden og databasen) og kjenner ikke igjen et ukjent forslag", async () => {
    await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "email", channel_identifier: "per@firma155.no", confidence: 1, match_method: "exact_email", display_name: "Per" });
    await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "sms", channel_identifier: "+4722000155", confidence: 1, match_method: "exact_phone_e164", display_name: "Sentralbord" });
    publish(person("155", { phoneNumbers: [{ value: "+4722000155" }], emailAddresses: [{ value: "per@firma155.no" }] }));
    const c = conflictsOf(await sync())[0]!;
    await expect(chain.store.decideContactConflict(TENANT_A, "business", c.conflict_id!, "accepted", { person_id: "person-g1-owner", session_id: "sess-store" })).rejects.toThrow("comms_contact_conflict_not_acceptable:split_identities");
    expect(await chain.store.decideContactConflict(TENANT_A, "business", "ccf-finnes-ikke-0000", "dismissed", { person_id: "person-g1-owner", session_id: "sess-store" })).toBeNull();
    expect((await rowsOf("people/c155"))[0]).toMatchObject({ status: "proposed", decided_by_person_id: null });
  });

  it("endret konfliktsett mellom forslag og godkjenning: godta avbrytes UTEN skriving (`comms_contact_conflict_changed`), forslaget forblir åpent", async () => {
    publish(person("161", { phoneNumbers: [{ value: "+4722000161" }], emailAddresses: [{ value: "a@x161.no" }] }), person("162", { phoneNumbers: [{ value: "+4722000161" }], emailAddresses: [{ value: "b@x162.no" }] }));
    const c = conflictsOf(await sync())[0]!;
    // en tredje kontakt lenkes (utenfor forslaget) til samme identitet mens eieren vurderer: identiteten har nå en eier til
    const identity = (await identityOfEmail("a@x161.no"))!;
    await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "email", channel_identifier: "c@x163.no", confidence: 0.9, match_method: "contact_sync", identity_id: identity, source_type: "google_contacts", external_id: "people/c163" });
    const r = await decide(c.conflict_id!, "accept");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("comms_contact_conflict_changed");
    expect(await identityOfEmail("b@x162.no")).toBeNull();
    expect((await rowsOf("people/c162"))[0]).toMatchObject({ status: "proposed" });
  });

  it("ukjent id, manglende idempotensnøkkel og ugyldige parametre: avvist uten sideeffekt; en annen tenant ser aldri forslagene", async () => {
    expect(JSON.stringify(await decide("ccf-finnes-ikke-0000", "dismiss"))).toContain("comms_contact_conflict_not_found");
    publish(person("171", { phoneNumbers: [{ value: "+4722000171" }], emailAddresses: [{ value: "a@x171.no" }] }), person("172", { phoneNumbers: [{ value: "+4722000171" }], emailAddresses: [{ value: "b@x172.no" }] }));
    const c = conflictsOf(await sync())[0]!;
    const noKey = await chain.act("decide_contact_conflict", { conflict_id: c.conflict_id!, decision: "dismiss" });
    expect(noKey).toMatchObject({ ok: false, reason: "idempotency_key_required" });
    for (const bad of [{ conflict_id: c.conflict_id!, decision: "merge" }, { conflict_id: c.conflict_id!, decision: "accept", extra: 1 }, { conflict_id: "kort", decision: "accept" }, { decision: "accept" }] as Array<Record<string, JsonValue>>) {
      expect((await chain.act("decide_contact_conflict", bad, chain.key("bad"))).ok, JSON.stringify(bad)).toBe(false);
    }
    expect((await rowsOf("people/c172"))[0]).toMatchObject({ status: "proposed" });
    expect(await chain.store.listContactConflicts(TENANT_B, "business", { limit: 200 })).toEqual([]);
    expect(await chain.store.getContactConflict(TENANT_B, "business", c.conflict_id!)).toBeNull();
  });

  it("idempotens: samme nøkkel og samme avgjørelse gir ekte gjenspilling (ingen ny lenking); ULIK avgjørelse med samme nøkkel er en uavhengig forespørsel (G1b-mønsteret)", async () => {
    publish(person("181", { phoneNumbers: [{ value: "+4722000181" }], emailAddresses: [{ value: "a@x181.no" }] }), person("182", { phoneNumbers: [{ value: "+4722000181" }], emailAddresses: [{ value: "b@x182.no" }] }));
    const c = conflictsOf(await sync())[0]!;
    const key = chain.key("same");
    const first = await decide(c.conflict_id!, "accept", key);
    const replay = await decide(c.conflict_id!, "accept", key);
    expect(first.ok && replay.ok && replay.deduplicated).toBe(true);
    const other = await decide(c.conflict_id!, "dismiss", key);
    expect(other.ok && other.deduplicated, JSON.stringify(other)).toBe(false);
    expect((await rowsOf("people/c182"))[0]).toMatchObject({ status: "dismissed" });
  });
});

describe("C: databasens egne regler for forslagene (som tabelleier, uten om koden)", () => {
  it("kjernekolonnene er uforanderlige, teller og sist-sett kan bare øke, et avgjort forslag blir aldri åpent igjen, og ingenting kan slettes utenfor erasure", async () => {
    publish(person("191", { phoneNumbers: [{ value: "+4722000191" }], emailAddresses: [{ value: "a@x191.no" }] }), person("192", { phoneNumbers: [{ value: "+4722000191" }], emailAddresses: [{ value: "b@x192.no" }] }));
    const c = conflictsOf(await sync())[0]!;
    const where = [TENANT_A, c.conflict_id];
    for (const set of ["resource_name = 'people/c1'", "kind = 'split_identities'", "fingerprint = repeat('a', 64)", "conflicting_resources = '[]'::jsonb", "memory_space_id = 'project'", "first_seen_at = first_seen_at - interval '1 day'", "detected_by_person_id = 'person-g1-guest'", "tenant_id = 'tenant-g1-b'"]) {
      await expect(chain.db.admin.query(`UPDATE comms_contact_conflicts SET ${set} WHERE tenant_id = $1 AND conflict_id = $2`, where), set).rejects.toThrow(/uforanderlige/);
    }
    await expect(chain.db.admin.query("UPDATE comms_contact_conflicts SET seen_count = 0 WHERE tenant_id = $1 AND conflict_id = $2", where)).rejects.toThrow();
    await expect(chain.db.admin.query("UPDATE comms_contact_conflicts SET last_seen_at = last_seen_at - interval '1 day' WHERE tenant_id = $1 AND conflict_id = $2", where)).rejects.toThrow(/kan kun øke/);
    expect((await decide(c.conflict_id!, "dismiss")).ok).toBe(true);
    await expect(chain.db.admin.query("UPDATE comms_contact_conflicts SET status = 'proposed', decided_at = NULL, decided_by_person_id = NULL WHERE tenant_id = $1 AND conflict_id = $2", where)).rejects.toThrow(/kan ikke gjøres om/);
    // eieren kan ombestemme seg mellom godtatt og avvist
    expect((await decide(c.conflict_id!, "accept")).ok).toBe(true);
    expect((await rowsOf("people/c192"))[0]).toMatchObject({ status: "accepted" });
    // sletting: kun i en erasure-transaksjon (som app-rollen; tabelleieren omgår triggere ikke, men appen kan ikke)
    const client = await chain.db.app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', 'business', true)", [TENANT_A]);
      await expect(client.query("DELETE FROM comms_contact_conflicts WHERE tenant_id = $1", [TENANT_A])).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("comms_row_delete_forbidden") });
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', 'business', true), set_config('jarvis.erasure_in_progress', 'true', true)", [TENANT_A]);
      const del = await client.query("DELETE FROM comms_contact_conflicts WHERE tenant_id = $1 AND conflict_id = $2", where);
      expect(del.rowCount).toBe(1);
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });

  it("FORCE RLS: en annen tenant og et annet rom ser ingenting", async () => {
    const rls = (await chain.db.admin.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'comms_contact_conflicts'")).rows[0] as { relrowsecurity: boolean; relforcerowsecurity: boolean };
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await chain.store.listContactConflicts(TENANT_A, "project", { status: "accepted", limit: 200 })).toEqual([]);
  });
});

describe("D: kald-regelen er UENDRET (Q-72 pkt 11 venter på eierens bekreftelse): en kontakt lenket via contact_sync - også etter en godtatt konflikt - regnes fortsatt som KALD", () => {
  const sendTo = (recipient: string, basis?: string) => chain.act("send", { channel: "sms", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, timen din er bekreftet.", ...(basis !== undefined ? { purpose_basis: basis } : {}) }, chain.key("cold"));

  it("synket kontakt (ingen konflikt): sending uten grunnlag avslås (`purpose_basis_required`), med grunnlag går den; samme for en kontakt godtatt via en konflikt", async () => {
    publish(person("201", { phoneNumbers: [{ value: "+4799000201" }], emailAddresses: [{ value: "a@x201.no" }] }), person("202", { phoneNumbers: [{ value: "+4799000201" }], emailAddresses: [{ value: "b@x202.no" }] }), person("203", { phoneNumbers: [{ value: "+4799000203" }], emailAddresses: [{ value: "c@x203.no" }] }));
    const r = await sync();
    expect(countOf(r)).toBe(1);
    // 201 og 203 er lenket via contact_sync (varm = nei)
    const noBasis = await sendTo("+4799000203");
    expect(noBasis.ok).toBe(false);
    expect(JSON.stringify(noBasis)).toContain("purpose_basis_required");
    expect((await sendTo("+4799000203", "existing_customer_relationship")).ok).toBe(true);
    // godta konflikten for 202 (delt telefon med 201): fortsatt contact_sync, fortsatt kald
    expect((await decide(conflictsOf(r)[0]!.conflict_id!, "accept")).ok).toBe(true);
    const acceptedNoBasis = await sendTo("+4799000201");
    expect(acceptedNoBasis.ok).toBe(false);
    expect(JSON.stringify(acceptedNoBasis)).toContain("purpose_basis_required");
    expect((await sendTo("+4799000201", "existing_customer_relationship")).ok).toBe(true);
  });
});
