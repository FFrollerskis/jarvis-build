import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { MessageStore, planMigrations, runMigrations, withTenantTransaction } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";

/**
 * WP-N1 (Q-66, JARVIS-101): migrasjon 140 (`messages.restricted`) og `MessageStore.save/markRestricted/history` mot EKTE Postgres (ingen mocks).
 *  A. skjema: kolonnen, standardverdi, RLS uendret, kolonne-nivå UPDATE (kun `restricted`), enveis-trigger, migrasjonsvaktene
 *  B. `save`: uendret SQL/revisjon uten valget; `restricted: true` lagres begrenset; revisjonen bærer aldri innhold
 *  C. `markRestricted`: idempotent, kun egen tenant og egen sesjon, én revisjonsrad, aldri innhold
 *  D. `history()` returnerer `restricted`, og RLS skjuler en annen tenants rader
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let store: MessageStore;

const base = { person_id: "p-1", device_id: "d-1", channel: "web", auth_strength: "active", memory_space_id: "personal" } as const;
const idA1: IdentityContext = { ...base, tenant_id: "t-a", session_id: "s-a1" };
const idA2: IdentityContext = { ...base, tenant_id: "t-a", session_id: "s-a2" };
const idB1: IdentityContext = { ...base, tenant_id: "t-b", session_id: "s-b1" };

const rowOf = async (messageId: string): Promise<{ restricted: boolean; content: string; session_id: string } | undefined> =>
  (await admin.query("SELECT restricted, content, session_id FROM messages WHERE message_id = $1", [messageId])).rows[0];
const auditOf = async (type: string): Promise<Array<{ payload: Record<string, unknown>; session_id: string | null; tenant_id: string }>> =>
  (await admin.query("SELECT payload, session_id, tenant_id FROM audit_events WHERE type = $1 ORDER BY audit_id", [type])).rows;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpn1-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const conn = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  admin = new pg.Pool({ ...conn, user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpn1 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpn1");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('t-a','A','person'), ('t-b','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('p-1','Én');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('p-1','t-a'), ('p-1','t-b');
    INSERT INTO sessions (session_id, tenant_id, person_id, status, last_channel, last_device_id) VALUES
      ('s-a1','t-a','p-1','active','web','d-1'), ('s-a2','t-a','p-1','closed','web','d-1'), ('s-b1','t-b','p-1','active','web','d-1');`);
  app = new pg.Pool({ ...conn, user: "jarvis_wpn1", password: "pw2" });
  app.on("error", () => undefined);
  store = new MessageStore(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("A: migrasjon 140 - skjema, rettigheter og vakter", () => {
  it("kolonnen er boolean NOT NULL DEFAULT false, og en rad satt inn uten kolonnen (som main-koden gjør) er false", async () => {
    const col = await admin.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'restricted'`
    );
    expect(col.rows).toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "false" }]);
    await admin.query(`INSERT INTO messages (message_id, tenant_id, session_id, role, content) VALUES ('m-legacy','t-a','s-a1','user','gammel rad')`);
    expect((await rowOf("m-legacy"))?.restricted).toBe(false);
  });

  it("RLS er fortsatt FORCE på messages med tenant-isolasjonspolicyen (uendret fra 005), og ingen ny policy er lagt til", async () => {
    const t = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.messages'::regclass`);
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await admin.query(`SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'messages' ORDER BY 1`);
    expect(policies.rows).toEqual([{ policyname: "messages_tenant_isolation", cmd: "ALL" }]);
  });

  it("app-rollen kan oppdatere KUN kolonnen restricted (ikke innhold, rolle, sesjon, tenant, id eller tid); DELETE er uendret (kun sletting etter DATA_ERASURE, 018) og TRUNCATE finnes ikke", async () => {
    const colPriv = async (column: string): Promise<boolean> =>
      (await admin.query("SELECT has_column_privilege('jarvis_app', 'messages', $1, 'UPDATE') AS ok", [column])).rows[0].ok as boolean;
    expect(await colPriv("restricted")).toBe(true);
    for (const column of ["content", "role", "session_id", "tenant_id", "message_id", "created_at"]) expect(await colPriv(column), column).toBe(false);
    const table = async (priv: string): Promise<boolean> => (await admin.query("SELECT has_table_privilege('jarvis_app', 'messages', $1) AS ok", [priv])).rows[0].ok as boolean;
    expect(await table("UPDATE")).toBe(false); // tabell-nivå UPDATE finnes ikke - kun kolonne-nivå
    expect(await table("DELETE")).toBe(true); // fra 018 (erasure) - IKKE endret av 140; en begrenset melding kan fortsatt slettes (se testen under)
    expect(await table("TRUNCATE")).toBe(false);
    await expect(withTenantTransaction(app, "t-a", (c) => c.query(`UPDATE messages SET content = 'omskrevet' WHERE message_id = 'm-legacy'`))).rejects.toThrow(/permission denied/);
    expect((await rowOf("m-legacy"))?.content).toBe("gammel rad");
  });

  it("merket er ENVEIS: ikke engang en superbruker kan gjøre en begrenset melding ubegrenset (trigger), og app-rollen heller ikke", async () => {
    const id = await store.save(idA1, "assistant", "begrenset svar", { restricted: true });
    await expect(admin.query("UPDATE messages SET restricted = false WHERE message_id = $1", [id])).rejects.toThrow(/messages_restricted_monotonic/);
    await expect(withTenantTransaction(app, "t-a", (c) => c.query("UPDATE messages SET restricted = false WHERE message_id = $1", [id]))).rejects.toThrow(/messages_restricted_monotonic/);
    expect((await rowOf(id))?.restricted).toBe(true);
    // false -> true og true -> true er tillatt (idempotent)
    await withTenantTransaction(app, "t-a", (c) => c.query("UPDATE messages SET restricted = true WHERE message_id = $1", [id]));
    expect((await rowOf(id))?.restricted).toBe(true);
  });

  it("en begrenset melding kan fortsatt slettes (erasure, 018): monotonitetstriggeren gjelder kun UPDATE", async () => {
    const id = await store.save(idA1, "assistant", "skal slettes", { restricted: true });
    const res = await withTenantTransaction(app, "t-a", (c) => c.query("DELETE FROM messages WHERE message_id = $1", [id]));
    expect(res.rowCount).toBe(1);
    expect(await rowOf(id)).toBeUndefined();
  });

  it("migrasjonsvaktene: filen er anvendt med sjekksum, en ny kjøring gjør ingenting, og planen har ingen avvik", async () => {
    expect(await runMigrations(admin)).toEqual([]);
    const plan = await planMigrations(admin);
    expect(plan.pending).toEqual([]);
    expect(plan.checksum_mismatches).toEqual([]);
    expect(plan.missing_checksum).toEqual([]);
    const row = await admin.query("SELECT checksum FROM schema_migrations WHERE name = '140_messages_restricted.sql'");
    expect(row.rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("B: save - uendret uten valget, begrenset med valget, aldri innhold i revisjonen", () => {
  it("uten valg (og med restricted:false): kolonnen settes aldri (standard false), revisjonsraden er nøyaktig {role} som før N1", async () => {
    const before = (await auditOf("message.saved")).length;
    const a = await store.save(idA1, "user", "hemmelig-innhold-1");
    const b = await store.save(idA1, "assistant", "hemmelig-innhold-2", { restricted: false });
    const c = await store.save(idA1, "assistant", "hemmelig-innhold-3", {});
    for (const id of [a, b, c]) expect((await rowOf(id))?.restricted, id).toBe(false);
    const rows = (await auditOf("message.saved")).slice(before);
    expect(rows.map((r) => r.payload)).toEqual([{ role: "user" }, { role: "assistant" }, { role: "assistant" }]);
  });

  it("med restricted:true lagres raden begrenset fra første stund, i egen sesjon/tenant, og revisjonsraden har kun {role, restricted:true}", async () => {
    const before = (await auditOf("message.saved")).length;
    const id = await store.save(idA1, "assistant", "hemmelig-innhold-4", { restricted: true });
    expect(await rowOf(id)).toEqual({ restricted: true, content: "hemmelig-innhold-4", session_id: "s-a1" });
    const rows = (await auditOf("message.saved")).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ role: "assistant", restricted: true });
    expect(rows[0]?.tenant_id).toBe("t-a");
    expect(rows[0]?.session_id).toBe("s-a1");
  });

  it("revisjonen bærer ALDRI meldingsinnhold - verken for vanlige, begrensede eller markerte meldinger", async () => {
    const id = await store.save(idA2, "user", "unik-hemmelig-streng-xyz");
    await store.markRestricted(idA2, id);
    await store.save(idA2, "assistant", "unik-hemmelig-streng-xyz-svar", { restricted: true });
    const all = await admin.query(`SELECT payload::text AS p, coalesce(reason, '') AS r FROM audit_events WHERE type IN ('message.saved', 'message.restricted_marked')`);
    for (const row of all.rows as Array<{ p: string; r: string }>) {
      expect(row.p).not.toContain("unik-hemmelig-streng");
      expect(row.r).not.toContain("unik-hemmelig-streng");
    }
  });
});

describe("C: markRestricted - idempotent, kun egen tenant og egen sesjon", () => {
  it("merker en lagret melding, og audit har kun id-en (aldri innhold); andre rader i samme sesjon berøres ikke", async () => {
    const target = await store.save(idA1, "user", "hva er saldoen min igjen");
    const bystander = await store.save(idA1, "user", "en annen melding");
    const before = (await auditOf("message.restricted_marked")).length;
    expect(await store.markRestricted(idA1, target)).toBe(true);
    expect((await rowOf(target))?.restricted).toBe(true);
    expect((await rowOf(bystander))?.restricted).toBe(false);
    const rows = (await auditOf("message.restricted_marked")).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ message_id: target });
    expect(JSON.stringify(rows[0]?.payload)).not.toContain("saldoen");
  });

  it("idempotent: en ny merking (også samtidig) er en no-op - fortsatt true, raden uendret, og kun ÉN revisjonsrad totalt", async () => {
    const target = await store.save(idA1, "user", "samtidig merking");
    const before = (await auditOf("message.restricted_marked")).length;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => store.markRestricted(idA1, target)));
    expect(results).toEqual([true, true, true, true, true]);
    expect(await store.markRestricted(idA1, target)).toBe(true);
    expect((await rowOf(target))?.restricted).toBe(true);
    expect((await auditOf("message.restricted_marked")).length - before).toBe(1);
  });

  it("en melding som allerede ble lagret begrenset gir true uten ny revisjonsrad (ingenting å merke)", async () => {
    const id = await store.save(idA1, "assistant", "alt begrenset", { restricted: true });
    const before = (await auditOf("message.restricted_marked")).length;
    expect(await store.markRestricted(idA1, id)).toBe(true);
    expect((await auditOf("message.restricted_marked")).length).toBe(before);
  });

  it("ukjent melding-id gir false uten revisjonsrad og uten å røre noe", async () => {
    const before = (await auditOf("message.restricted_marked")).length;
    expect(await store.markRestricted(idA1, "msg-finnes-ikke")).toBe(false);
    expect((await auditOf("message.restricted_marked")).length).toBe(before);
  });

  it("KUN egen sesjon: en annen sesjon i SAMME tenant får false og raden forblir ubegrenset", async () => {
    const id = await store.save(idA1, "user", "sesjon A1");
    expect(await store.markRestricted(idA2, id)).toBe(false);
    expect((await rowOf(id))?.restricted).toBe(false);
    expect(await store.markRestricted(idA1, id)).toBe(true);
  });

  it("KUN egen tenant: en annen tenants identitet får false (RLS), også når sesjons-id-en forfalskes, og raden forblir ubegrenset", async () => {
    const id = await store.save(idA1, "user", "tenant A");
    expect(await store.markRestricted(idB1, id)).toBe(false);
    expect(await store.markRestricted({ ...idB1, session_id: "s-a1" }, id)).toBe(false);
    expect(await store.markRestricted({ ...idA1, tenant_id: "t-b" }, id)).toBe(false);
    expect((await rowOf(id))?.restricted).toBe(false);
  });

  it("dybdeforsvar: de EKSPLISITTE tenant- og sesjonsklausulene holder også UTEN RLS (en superbruker-pool omgår RLS, men en annen tenants identitet merker likevel ingenting)", async () => {
    const noRls = new MessageStore(admin);
    const id = await store.save(idA1, "user", "uten RLS");
    expect(await noRls.markRestricted({ ...idB1, session_id: "s-a1" }, id)).toBe(false); // samme sesjons-id, feil tenant: kun tenant-klausulen stopper den
    expect(await noRls.markRestricted({ ...idA1, session_id: "s-a2" }, id)).toBe(false); // riktig tenant, feil sesjon: kun sesjonsklausulen stopper den
    expect((await rowOf(id))?.restricted).toBe(false);
    expect(await noRls.markRestricted(idA1, id)).toBe(true);
    expect((await rowOf(id))?.restricted).toBe(true);
  });

  it("direkte SQL fra app-rollen under en ANNEN tenants kontekst treffer heller ingenting (RLS USING), og lagring med feil tenant-sesjon avvises", async () => {
    const id = await store.save(idA1, "user", "RLS-sjekk");
    const res = await withTenantTransaction(app, "t-b", (c) => c.query("UPDATE messages SET restricted = true WHERE message_id = $1", [id]));
    expect(res.rowCount).toBe(0);
    expect((await rowOf(id))?.restricted).toBe(false);
    await expect(store.save({ ...idA1, tenant_id: "t-b" }, "user", "feil tenant for sesjonen")).rejects.toThrow();
  });
});

describe("D: history() returnerer restricted, og RLS skjuler andre tenanter", () => {
  it("hver rad har restricted som boolean (false for vanlige, true for begrensede/merkede), i kronologisk rekkefølge", async () => {
    const s = { ...idA1, session_id: "s-a2" };
    const first = await store.save(s, "user", "h1");
    const second = await store.save(s, "assistant", "h2", { restricted: true });
    const third = await store.save(s, "user", "h3");
    await store.markRestricted(s, third);
    const history = await store.history(s, 50);
    const mine = history.filter((m) => [first, second, third].includes(m.message_id));
    expect(mine.map((m) => [m.content, m.restricted])).toEqual([["h1", false], ["h2", true], ["h3", true]]);
    for (const m of history) expect(typeof m.restricted, m.message_id).toBe("boolean");
  });

  it("en annen tenant ser verken meldingene eller merkene", async () => {
    await store.save(idB1, "user", "kun tenant B");
    const aSeen = (await store.history(idA1, 100)).map((m) => m.content);
    const bSeen = (await store.history(idB1, 100)).map((m) => m.content);
    expect(aSeen).not.toContain("kun tenant B");
    expect(bSeen).toEqual(["kun tenant B"]);
  });
});
