import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c fiks-runde 1 (FIX-9, JARVIS-112 f1) - `DEFERRED`, og denne testen PINNER DAGENS ATFERD: «samme kontakt, ulike verdier» er IKKE bygget. Endrer en Google-kontakt telefon eller e-post mellom to synker, har pakken ingen kontakt-nivå-nøkkel å
 * kjenne den igjen på (lenkene bærer `external_id` = ressursnavnet, men identiteten er nøklet på identifikatorene), så andre synk lenker de NYE verdiene til en NY identitet, de GAMLE lenkene forblir aktive på den gamle identiteten, og ingenting lagres
 * som forslag eller konflikt. Å bygge det krever en kontakt-nivå-identitet i datamodellen (utover denne pakken): se runbook «Kontaktkonflikter (K4)» og Q-forslaget.
 * Blir denne testen rød fordi det er bygget, er det RIKTIG: snu forventningene og fjern «DEFERRED» i runbook.
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
const idOfEmail = async (email: string): Promise<string | null> => (await chain.graph.resolveIdentityByChannel(TENANT_A, "business", "email", email))?.identity_id ?? null;

beforeAll(async () => {
  chain = await startChain("g1cvc", {}, { deps: { contacts: true }, lenientToolLimits: true });
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

describe("FIX-9 (DEFERRED): samme kontakt, ENDRET telefon og e-post mellom to synker - dagens atferd er pinnet", () => {
  it("andre synk lenker de nye verdiene til en NY identitet, de gamle lenkene forblir aktive, og INGEN konflikt eller forslag lagres", async () => {
    publish(person("201", { phoneNumbers: [{ value: "+4722000201" }], emailAddresses: [{ value: "gammel@x201.no" }] }));
    const first = await sync();
    expect(first.ok).toBe(true);
    const oldIdentity = await idOfEmail("gammel@x201.no");
    expect(oldIdentity, "første synk lenket den gamle e-posten").not.toBeNull();

    publish(person("201", { phoneNumbers: [{ value: "+4722009201" }], emailAddresses: [{ value: "ny@x201.no" }] }));
    const second = await sync();
    expect(second.ok).toBe(true);
    expect((second.data as { contacts_conflict: number }).contacts_conflict, "ingen konflikt oppdages").toBe(0);

    const newIdentity = await idOfEmail("ny@x201.no");
    expect(newIdentity, "de nye verdiene er lenket").not.toBeNull();
    expect(newIdentity, "...men til en ANNEN identitet enn den gamle (kontakten kjennes ikke igjen på ressursnavnet)").not.toBe(oldIdentity);
    const oldLinks = (await chain.graph.listChannelLinks(TENANT_A, "business", oldIdentity as string)).filter((l) => l.status === "active");
    expect(oldLinks.length, "de gamle lenkene (telefon og e-post) er fortsatt aktive").toBe(2);
    expect(await idOfEmail("gammel@x201.no"), "den gamle e-posten løses fortsatt til den gamle identiteten").toBe(oldIdentity);

    const proposals = ((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_contact_conflicts WHERE tenant_id = $1", [TENANT_A])).rows[0] as { n: number }).n;
    expect(proposals, "ingen forslag lagres for en verdiendring").toBe(0);
  });
});
