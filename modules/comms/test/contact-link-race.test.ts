import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { ConversationGraphService, type LinkExclusiveIdentifiersResult } from "@jarvis/conversation-graph";
import { startCommsDb, TENANT_A, type CommsDb } from "./support/harness.ts";

/**
 * WP-G1c fiks-runde 1 (FIX-6 d og e): `linkExclusiveIdentifiers` har TO komplementære lag som hver for seg ikke ble felt av noen test (mutantene Y19/M63, M65 og M66 overlevde):
 *  (1) LÅSEN per (tenant, rom): to samtidige synker mot en eksisterende identitet ser hverandres resultat. Uten den kryss-lenket to synker mot en eksisterende identitet i 11 av 25 runder (reviewer B).
 *  (2) ETTERKONTROLLEN (`ExclusiveLinkRace`): en skriver UTENFOR låsen (en innkommende melding, en `restoreLinksBySource`) kan komme mellom oppløsningen og skrivingen. Lenken som da kommer tilbake fra en annen kilde/identitet ruller hele jobben
 *      tilbake og gir `conflict`. Uten den kryss-lenket en restore mot en synk i 5 av 25 runder.
 * Etterkontrollen testes DETERMINISTISK: en forbindelse-krok kjører den utenforliggende skriveren (på en annen forbindelse, committet) akkurat mellom oppløsningen og skrivingen i synk-transaksjonen.
 */
let db: CommsDb;
let g: ConversationGraphService;
let n = 0;
const phone = (): string => `+4793${String(100000 + ++n).padStart(6, "0").slice(-6)}`;
const src = (id: string) => ({ source_type: "google_contacts", external_id: id });
const syncVia = (service: ConversationGraphService, id: string, phones: string[], allow?: string[]): Promise<LinkExclusiveIdentifiersResult> => service.linkExclusiveIdentifiers(TENANT_A, "business", {
  identifiers: phones.map((identifier) => ({ channel: "phone" as const, identifier })), source: src(id), confidence: 0.9, match_method: "contact_sync", ...(allow !== undefined ? { allow_shared_with: allow } : {})
});
const sync = (id: string, phones: string[]) => syncVia(g, id, phones);
/** En identitet med ett nummer fra en kilde UTEN kontakt-id (manuell/innkommende): ingen «eier» i eksklusivitetskontrollen. */
const seedIdentity = (num: string) => g.linkChannelIdentity(TENANT_A, "business", { channel: "phone", channel_identifier: num, confidence: 0.95, match_method: "exact_phone_e164", display_name: "Kunde" });
const activeLinks = async (num: string): Promise<Array<{ identity_id: string; external_id: string | null }>> =>
  (await db.admin.query("SELECT identity_id, external_id FROM conversation_channel_links WHERE tenant_id = $1 AND channel_identifier = $2 AND status = 'active'", [TENANT_A, num])).rows as Array<{ identity_id: string; external_id: string | null }>;

/** En pool som kjører `before` rett FØR den `occurrence`-te spørringen som passer `matches` på en transaksjonsforbindelse (kun den første transaksjonen som når den). */
function hookedPool(matches: (sql: string, params: unknown[] | undefined) => boolean, occurrence: number, before: () => Promise<void>): pg.Pool {
  let seen = 0;
  let fired = false;
  return new Proxy(db.app, {
    get(target, prop) {
      if (prop === "connect") {
        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
          (client as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = async (...a: unknown[]) => {
            const text = typeof a[0] === "string" ? a[0] : (a[0] as { text?: string } | undefined)?.text ?? "";
            if (!fired && matches(text, a[1] as unknown[] | undefined) && ++seen === occurrence) { fired = true; await before(); }
            return query(...a);
          };
          return client;
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    }
  }) as pg.Pool;
}

beforeAll(async () => {
  db = await startCommsDb("g1ccl");
  g = new ConversationGraphService(db.app);
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);

describe("lag 1: låsen per (tenant, rom)", () => {
  it("låsen FINNES: mens en annen transaksjon holder `conv-exclusive`-låsen, VENTER synken; når den slippes, fullføres den", async () => {
    const holder = await db.admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [`conv-exclusive:${TENANT_A}`, "business"]);
      let done = false;
      const pending = sync("people/c-lock-1", [phone()]).then((r) => { done = true; return r; });
      const waiting = async (): Promise<number> => ((await db.admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0] as { n: number }).n;
      const until = Date.now() + 3_000;
      while (Date.now() < until && (await waiting()) === 0 && !done) await new Promise((r) => setTimeout(r, 10));
      expect(done, "synken skal ikke gå forbi låsen").toBe(false);
      expect(await waiting(), "synken skal stå i kø på rom-låsen").toBeGreaterThanOrEqual(1);
      await new Promise((r) => setTimeout(r, 300));
      expect(done, "synken skal fortsatt vente").toBe(false);
      await holder.query("COMMIT");
      expect(await pending).toMatchObject({ status: "linked" });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }, 60_000);

  it("25 runder: to samtidige synker av to ULIKE kontakter mot en EKSISTERENDE identitet med en delt telefon: nøyaktig én lenkes, den andre gir `conflict`, og identiteten har aldri to kontakter", async () => {
    let bothLinked = 0;
    for (let round = 0; round < 25; round++) {
      const shared = phone();
      await seedIdentity(shared);
      const [a, b] = await Promise.all([sync(`people/c-race-a-${round}`, [shared, phone()]), sync(`people/c-race-b-${round}`, [shared, phone()])]);
      const statuses = [a.status, b.status].sort();
      if (statuses[0] === "linked" && statuses[1] === "linked") bothLinked++;
      expect(statuses, `runde ${round}`).toEqual(["conflict", "linked"]);
      const contacts = ((await db.admin.query(
        `SELECT count(DISTINCT external_id)::int AS n FROM conversation_channel_links
          WHERE tenant_id = $1 AND status = 'active' AND source_type = 'google_contacts'
            AND identity_id IN (SELECT identity_id FROM conversation_channel_links WHERE tenant_id = $1 AND channel_identifier = $2 AND status = 'active')`, [TENANT_A, shared]
      )).rows[0] as { n: number }).n;
      expect(contacts, `runde ${round}: kontakter festet til den delte identiteten`).toBe(1);
    }
    expect(bothLinked).toBe(0);
  }, 120_000);
});

describe("lag 2: etterkontrollen (ExclusiveLinkRace) rulle tilbake og gir `conflict` når en skriver utenfor låsen kommer imellom", () => {
  const isPerIdentifierLock = (sql: string, params: unknown[] | undefined): boolean => sql.includes("pg_advisory_xact_lock") && typeof params?.[0] === "string" && params[0].startsWith("conv:");
  const isLinkInsert = (sql: string): boolean => sql.includes("INSERT INTO conversation_channel_links");

  it("alt er NYTT: en `restoreLinksBySource` for en ANNEN kontakt kommer imellom oppløsningen og skrivingen og reaktiverer nummeret -> `conflict`, ingenting skrevet av synken (y19/M63)", async () => {
    const [shared, own] = [phone(), phone()];
    // kontakt C eier `shared`, men lenken er tilbakekalt: nummeret er «nytt» for en synk av D
    expect((await sync("people/c-restore-c", [shared])).status).toBe("linked");
    await g.revokeLinksBySource(TENANT_A, "business", src("people/c-restore-c"));
    expect(await activeLinks(shared)).toEqual([]);
    const racing = hookedPool(isPerIdentifierLock, 1, async () => { await g.restoreLinksBySource(TENANT_A, "business", src("people/c-restore-c")); });
    const result = await syncVia(new ConversationGraphService(racing), "people/c-restore-d", [shared, own]);
    expect(result).toEqual({ status: "conflict", with: [] });
    const sharedLinks = await activeLinks(shared);
    expect(sharedLinks.map((l) => l.external_id), "nummeret tilhører fortsatt C (restore vant)").toEqual(["people/c-restore-c"]);
    expect(await activeLinks(own), "ingenting ble delvis skrevet for D (hele jobben rullet tilbake)").toEqual([]);
  }, 60_000);

  it("alt er NYTT: en innkommende melding (lenke uten kontakt-id) kommer imellom for det første nummeret -> `conflict`, ingenting skrevet av synken", async () => {
    const [first, second] = [phone(), phone()];
    const racing = hookedPool(isPerIdentifierLock, 1, async () => { await seedIdentity(first); });
    const result = await syncVia(new ConversationGraphService(racing), "people/c-inbound-d", [first, second]);
    expect(result).toEqual({ status: "conflict", with: [] });
    expect((await activeLinks(first)).map((l) => l.external_id)).toEqual([null]);
    expect(await activeLinks(second)).toEqual([]);
  }, 60_000);

  it("EKSISTERENDE identitet: det andre nummeret får en lenke fra en ANNEN identitet (skriver utenfor låsen) før synkens skriving -> `conflict`, og det første nummeret er ikke lenket av synken (etterkontrollens andre gren, M66)", async () => {
    const [known, fresh] = [phone(), phone()];
    await seedIdentity(known);
    // kroken fyrer rett før INSERT nr. 2 (nummeret `fresh`): en annen identitet tar det først
    const racing = hookedPool((sql) => isLinkInsert(sql), 2, async () => { await seedIdentity(fresh); });
    const result = await syncVia(new ConversationGraphService(racing), "people/c-existing-d", [known, fresh]);
    expect(result).toEqual({ status: "conflict", with: [] });
    expect((await activeLinks(fresh)).map((l) => l.external_id), "`fresh` tilhører skriveren utenfor låsen").toEqual([null]);
    expect((await activeLinks(known)).map((l) => l.external_id), "`known` er ikke festet til kontakt D (jobben ble rullet tilbake)").toEqual([null]);
    const identities = new Set([...(await activeLinks(known)), ...(await activeLinks(fresh))].map((l) => l.identity_id));
    expect(identities.size, "de to numrene er IKKE slått sammen til én identitet").toBe(2);
  }, 60_000);

  it("kontroll uten kappløp: den samme synken uten kroken lenker begge numrene til den eksisterende identiteten", async () => {
    const [known, fresh] = [phone(), phone()];
    const seeded = await seedIdentity(known);
    const result = await sync("people/c-control-d", [known, fresh]);
    expect(result).toMatchObject({ status: "linked", identity_id: seeded.identity_id, linked: 2 });
  }, 60_000);
});
