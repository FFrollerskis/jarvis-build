import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";
import {
  BusinessService, ChurnService, OpenLoopService, ProductUsageError, ProductUsageService, UsageImportError, signUsageWebhook, webhookUsageSource
} from "../src/index.ts";

/**
 * WP-D2 (UA-3 «churn/product usage», migrasjon 090): produktbruk-kilder og churn-signaler mot EKTE Postgres som APP-ROLLE (RLS). Dekker:
 *  A. innhenting + idempotens (webhook/CSV/JSONL deler regler, samtidige kall, store batcher), B. tenant-vakter og RLS, C. DB-nivå PII-vern og uforanderlighet,
 *  D. webhook-inngangen (signatur, replay, konfig), E. kobling konto -> selskap, F. oppbevaring og «glem bruker», G. churn-vurdering -> open loops (SUGGEST/INFORM),
 *  H. loop_type-CHECK uten tap av eksisterende typer.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let svc: ProductUsageService;
let business: BusinessService;
let openLoops: OpenLoopService;
let churn: ChurnService;

const BIZ = "tenant-wpd2-use";
const BIZ_B = "tenant-wpd2-use-b";
const PERSON_TENANT = "tenant-wpd2-use-person";
const OWNER = "person-wpd2-use-owner";
const SP = "business" as const;
const SECRET = "w".repeat(48);

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd2-usage-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpd2_use LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpd2_use");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${BIZ}', 'Use', 'business'), ('${BIZ_B}', 'Use B', 'business'), ('${PERSON_TENANT}', 'Person', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${BIZ}'), ('${OWNER}', '${BIZ_B}'), ('${OWNER}', '${PERSON_TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-u-biz', '${BIZ}', 'business'), ('ms-u-bizb', '${BIZ_B}', 'business'), ('ms-u-pers', '${PERSON_TENANT}', 'personal');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd2_use", password: "pw2" });
  svc = new ProductUsageService(app, { webhookSecretProvider: async () => SECRET, tenantResolver: () => BIZ });
  business = new BusinessService(app);
  openLoops = new OpenLoopService(app);
  churn = new ChurnService(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const DAY = 86_400_000;
const ago = (days: number): string => new Date(Date.now() - days * DAY - 60_000).toISOString();
const evt = (id: string, account: string, daysAgo: number, over: Record<string, unknown> = {}) =>
  ({ event_id: id, account_ref: account, feature: "chat.send", quantity: 1, occurred_at: ago(daysAgo), ...over });
const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join("\n");
const importEvents = (tenant: string, events: unknown[], label = "test") => svc.importText(tenant, "jsonl", label, jsonl(events), { actor_person_id: OWNER });
const count = async (sql: string, params: unknown[] = []) => ((await admin.query(sql, params)).rows[0] as { n: number }).n;
const asApp = <T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => withMemoryTransaction(app, tenant, [SP], fn);
const errCode = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "OK"; } catch (e) { return e instanceof ProductUsageError || e instanceof UsageImportError ? e.code : `OTHER:${(e as Error).message}`; }
};

describe("A: innhenting og idempotens", () => {
  const A1 = "acct-a-0001", B1 = "acct-b-0001";
  it("lagrer hendelser, oppretter kontoer med første/siste tidspunkt, og skriver ÉN revisjonsrad med tellere (ingen referanser)", async () => {
    const events = [
      evt("a-evt-000001", A1, 3, { quantity: 2 }),
      evt("a-evt-000002", A1, 2, { user_ref: "usr_abcdef12" }),
      evt("a-evt-000003", B1, 1, { feature: "export", quantity: 5 })
    ];
    const r = await importEvents(BIZ, events);
    expect(r).toMatchObject({ source_id: "import:test", received: 3, inserted: 3, duplicates: 0, conflicts: 0, rejected: 0, accounts_seen: 2, new_accounts: 2 });
    const acct = (await admin.query("SELECT first_event_at, last_event_at, company_id FROM product_usage_accounts WHERE tenant_id = $1 AND account_ref = $2", [BIZ, A1])).rows[0] as { first_event_at: Date; last_event_at: Date; company_id: string | null };
    expect(acct.company_id).toBeNull();
    expect(acct.last_event_at.getTime()).toBeGreaterThan(acct.first_event_at.getTime());
    const audit = (await admin.query("SELECT payload, actor_kind, person_id FROM audit_events WHERE tenant_id = $1 AND type = 'business.product_usage_ingested' ORDER BY audit_id DESC LIMIT 1", [BIZ])).rows[0] as { payload: Record<string, unknown>; actor_kind: string; person_id: string };
    expect(audit.person_id).toBe(OWNER);
    expect(Object.keys(audit.payload).sort()).toEqual(["accounts_seen", "conflicts", "duplicates", "inserted", "new_accounts", "received", "rejected", "source_id", "via"]);
    const dump = JSON.stringify(audit.payload);
    for (const secretish of [A1, B1, "usr_abcdef12", "chat.send"]) expect(dump).not.toContain(secretish);
  });

  it("samme hendelser igjen = duplikater (ingen nye rader), samme id med ANNET innhold = konflikt (ikke anvendt), og import under annen etikett dobbelttelles ikke", async () => {
    const before = await count("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1", [BIZ]);
    const again = await importEvents(BIZ, [evt("a-evt-000001", A1, 3, { quantity: 2 })]);
    expect(again).toMatchObject({ inserted: 0, duplicates: 0, conflicts: 1 }); // tidspunktet (ago) er nytt -> ikke identisk
    // eksakt identisk innhold: hent lagret tid og send den på nytt
    const stored = (await admin.query("SELECT occurred_at FROM product_usage_events WHERE tenant_id = $1 AND external_event_id = 'a-evt-000003'", [BIZ])).rows[0] as { occurred_at: Date };
    const identical = { event_id: "a-evt-000003", account_ref: B1, feature: "export", quantity: 5, occurred_at: stored.occurred_at.toISOString() };
    expect(await importEvents(BIZ, [identical], "other-label")).toMatchObject({ inserted: 0, duplicates: 1, conflicts: 0 });
    expect(await importEvents(BIZ, [{ ...identical, quantity: 6 }])).toMatchObject({ inserted: 0, duplicates: 0, conflicts: 1 });
    expect((await admin.query("SELECT quantity FROM product_usage_events WHERE tenant_id = $1 AND external_event_id = 'a-evt-000003'", [BIZ])).rows[0]).toEqual({ quantity: 5 });
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1", [BIZ])).toBe(before);
  });

  it("avviste hendelser telles og listes (maks 20), resten av batchen lagres; PII-lignende felt kommer aldri inn", async () => {
    const bad = Array.from({ length: 30 }, (_, i) => ({ event_id: `bad-evt-${String(i).padStart(4, "0")}`, account_ref: "ola@example.com", feature: "x", occurred_at: ago(1) }));
    const piiField = { ...evt("pii-evt-000001", "acct-c-0001", 1), email: "ola@example.com" };
    const r = await importEvents(BIZ, [...bad, piiField, evt("good-evt-00001", "acct-c-0001", 1)]);
    expect(r).toMatchObject({ received: 1, inserted: 1, rejected: 31 });
    expect(r.rejected_detail).toHaveLength(20);
    expect(JSON.stringify(r)).not.toContain("ola@example.com");
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1 AND (external_event_id LIKE 'bad-evt-%' OR external_event_id = 'pii-evt-000001')", [BIZ])).toBe(0);
  });

  it("store batcher (2500 hendelser, flere chunker) lagres alt-eller-ingenting", async () => {
    const events = Array.from({ length: 2500 }, (_, i) => evt(`bulk-${String(i).padStart(7, "0")}`, `acct-bulk-${i % 7}-x`, 1 + (i % 20), { quantity: 1 + (i % 3) }));
    const r = await importEvents(BIZ, events, "bulk");
    expect(r).toMatchObject({ received: 2500, inserted: 2500, duplicates: 0, accounts_seen: 7, new_accounts: 7 });
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1 AND external_event_id LIKE 'bulk-%'", [BIZ])).toBe(2500);
  });

  it("samtidige leveringer av SAMME batch gir nøyaktig én lagring per hendelse (ingen vranglås, ingen duplikater)", async () => {
    const events = Array.from({ length: 200 }, (_, i) => evt(`conc-${String(i).padStart(6, "0")}`, `acct-conc-${i % 5}-x`, 1));
    const results = await Promise.all([1, 2, 3, 4].map(() => importEvents(BIZ, events, "conc")));
    expect(results.reduce((s, r) => s + r.inserted, 0)).toBe(200);
    expect(results.reduce((s, r) => s + r.duplicates, 0)).toBe(600);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1 AND external_event_id LIKE 'conc-%'", [BIZ])).toBe(200);
  });
});

describe("B: kun bedrifts-tenant, og RLS holder tenantene adskilt", () => {
  it("person-tenant og ukjent tenant avvises FØR noe skrives (ingen hendelser, ingen revisjonsrad)", async () => {
    expect(await errCode(importEvents(PERSON_TENANT, [evt("p-evt-000001", "acct-p-0001", 1)]))).toBe("not_business_tenant");
    expect(await errCode(importEvents("tenant-finnes-ikke", [evt("p-evt-000002", "acct-p-0001", 1)]))).toBe("not_business_tenant");
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id IN ('p-evt-000001','p-evt-000002')")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id IN ($1, 'tenant-finnes-ikke') AND type LIKE 'business.product_usage%'", [PERSON_TENANT])).toBe(0);
  });

  it("samme hendelses-id kan finnes i to tenants (idempotensnøkkelen er per tenant), og en tenant ser aldri den andres rader", async () => {
    await importEvents(BIZ_B, [evt("a-evt-000001", "acct-a-0001", 2, { quantity: 7 })]);
    expect((await admin.query("SELECT quantity FROM product_usage_events WHERE tenant_id = $1 AND external_event_id = 'a-evt-000001'", [BIZ_B])).rows[0]).toEqual({ quantity: 7 });
    const seenByB = await asApp(BIZ_B, async (c) => Number(((await c.query("SELECT count(*)::int AS n FROM product_usage_events")).rows[0] as { n: number }).n));
    expect(seenByB).toBe(1);
    const seenByBAccounts = await svc.listAccounts(BIZ_B, SP);
    expect(seenByBAccounts.map((a) => a.account_ref)).toEqual(["acct-a-0001"]);
    // en kontekst uten tenant ser ingenting
    const none = await app.query("SELECT count(*)::int AS n FROM product_usage_events");
    expect((none.rows[0] as { n: number }).n).toBe(0);
  });

  it("annet memory space enn business avvises", async () => {
    expect(await errCode(svc.linkAccount(BIZ, "personal", "acct-a-0001", "biz-co-x"))).toBe("not_business_space");
  });
});

describe("C: forsvar i dybden i databasen - PII og uforanderlighet", () => {
  const ACCT = "acct-guard-001";
  beforeAll(async () => {
    await admin.query("INSERT INTO product_usage_accounts (tenant_id, account_ref) VALUES ($1, $2) ON CONFLICT DO NOTHING", [BIZ, ACCT]);
  });
  const insertAccount = (ref: string) => asApp(BIZ, (c) => c.query("INSERT INTO product_usage_accounts (tenant_id, account_ref) VALUES ($1, $2)", [BIZ, ref]));
  const insertEvent = (over: Record<string, unknown>) => {
    const e = { id: `pue-guard-${Math.random().toString(36).slice(2)}`, ext: `guard-${Math.random().toString(36).slice(2, 10)}`, source: "webhook", kind: "usage", account: ACCT, user: null, feature: "chat.send", qty: 1, ...over };
    return asApp(BIZ, (c) => c.query(
      `INSERT INTO product_usage_events (event_id, tenant_id, source_id, external_event_id, kind, account_ref, user_ref, feature, quantity, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [e.id, BIZ, e.source, e.ext, e.kind, e.account, e.user, e.feature, e.qty]
    ));
  };

  it("kontoreferanse med e-post, telefonlignende tall, IPv4, mellomrom eller for kort avvises av databasen", async () => {
    for (const ref of ["ola@example.com", "4791234567", "192.168.1.10", "has space 1", "kort1", "æøåæøåæøå"]) {
      await expect(insertAccount(ref), ref).rejects.toThrow(/product_usage_accounts_ref_pseudonymous|violates check constraint/);
    }
    await expect(insertAccount("acct-ok-123456")).resolves.toBeDefined();
  });

  it("hendelse: PII-lik user_ref, ugyldig funksjon/antall/kilde, billing_status med funksjon/bruker avvises av databasen", async () => {
    await expect(insertEvent({ user: "ola@example.com" })).rejects.toThrow(/user_ref_pseudonymous/);
    await expect(insertEvent({ user: "4791234567" })).rejects.toThrow(/user_ref_pseudonymous/);
    await expect(insertEvent({ user: "10.0.0.1" })).rejects.toThrow(/user_ref_pseudonymous/);
    await expect(insertEvent({ feature: "Chat Send" })).rejects.toThrow(/product_usage_events_shape/);
    await expect(insertEvent({ feature: null })).rejects.toThrow(/product_usage_events_shape/);
    await expect(insertEvent({ qty: 0 })).rejects.toThrow(/product_usage_events_shape/);
    await expect(insertEvent({ qty: 100_001 })).rejects.toThrow(/product_usage_events_shape/);
    await expect(insertEvent({ kind: "billing_status", feature: "chat.send", qty: 1 })).rejects.toThrow(/product_usage_events_shape/);
    await expect(insertEvent({ kind: "billing_status", feature: null, user: "usr_abcdef12", qty: 1 })).rejects.toThrow(/product_usage_events_shape/);
    await expect(insertEvent({ source: "mail" })).rejects.toThrow(/source_id/);
    await expect(insertEvent({ ext: "x y z 1" })).rejects.toThrow(/external_event_id/);
    await expect(insertEvent({ kind: "billing_status", feature: null, qty: 0 })).resolves.toBeDefined();
  });

  it("hendelser er uforanderlige for runtime: ingen UPDATE (unntatt user_ref), DELETE kun innen egen tenant; ingen kontekst = ingen rader", async () => {
    await insertEvent({ ext: "guard-immutable-1", user: "usr_immutable1" });
    await expect(asApp(BIZ, (c) => c.query("UPDATE product_usage_events SET quantity = 99 WHERE external_event_id = 'guard-immutable-1'"))).rejects.toThrow(/permission denied/);
    await expect(asApp(BIZ, (c) => c.query("UPDATE product_usage_events SET account_ref = 'acct-other-0001' WHERE external_event_id = 'guard-immutable-1'"))).rejects.toThrow(/permission denied/);
    await expect(asApp(BIZ, (c) => c.query("UPDATE product_usage_events SET user_ref = NULL WHERE external_event_id = 'guard-immutable-1'"))).resolves.toBeDefined();
    const noContextDelete = await app.query("DELETE FROM product_usage_events");
    expect(noContextDelete.rowCount).toBe(0);
    const otherTenantDelete = await asApp(BIZ_B, (c) => c.query("DELETE FROM product_usage_events WHERE external_event_id = 'guard-immutable-1'"));
    expect(otherTenantDelete.rowCount).toBe(0);
  });

  it("vurderings- og kontotabellene har RLS (FORCE) og tenant-skopede komposittnøkler", async () => {
    const rls = await admin.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('product_usage_accounts','product_usage_events','business_churn_assessments') ORDER BY 1`);
    for (const row of rls.rows as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const fks = await admin.query(`SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE contype = 'f' AND conrelid IN ('product_usage_accounts'::regclass, 'product_usage_events'::regclass, 'business_churn_assessments'::regclass) AND confrelid <> 'tenants'::regclass`);
    expect(fks.rows.length).toBe(4);
    for (const fk of fks.rows as Array<{ tbl: string; def: string }>) expect(fk.def, fk.tbl).toMatch(/FOREIGN KEY \(tenant_id, /);
  });
});

describe("D: webhook-inngangen", () => {
  const body = (events: unknown[]) => Buffer.from(JSON.stringify({ events }));
  const nowSec = () => Math.floor(Date.now() / 1000);
  const signed = (b: Buffer, ts = nowSec(), secret = SECRET) => signUsageWebhook(b, secret, ts);

  it("gyldig signatur: hendelsene lagres i den KONFIGURERTE tenanten, kilde «webhook»; replay innen vinduet gir duplikater, ikke dobbelttelling", async () => {
    const b = body([evt("wh-evt-000001", "acct-wh-0001", 1), evt("wh-evt-000002", "acct-wh-0001", 0.5, { quantity: 4 })]);
    const first = await svc.ingestWebhook(b, signed(b));
    expect(first).toMatchObject({ source_id: "webhook", received: 2, inserted: 2, duplicates: 0 });
    const replay = await svc.ingestWebhook(b, signed(b));
    expect(replay).toMatchObject({ inserted: 0, duplicates: 2 });
    expect((await admin.query("SELECT DISTINCT tenant_id, source_id FROM product_usage_events WHERE external_event_id LIKE 'wh-evt-%'")).rows).toEqual([{ tenant_id: BIZ, source_id: "webhook" }]);
    const audit = (await admin.query("SELECT payload FROM audit_events WHERE tenant_id = $1 AND type = 'business.product_usage_ingested' ORDER BY audit_id DESC LIMIT 1", [BIZ])).rows[0] as { payload: { via: string } };
    expect(audit.payload.via).toBe("webhook");
  });

  it("ugyldig/manglende/utløpt signatur og endret kropp avvises UTEN å skrive noe (heller ikke revisjon)", async () => {
    const auditBefore = await count("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND type = 'business.product_usage_ingested'", [BIZ]);
    const b = body([evt("wh-evt-000010", "acct-wh-0002", 1)]);
    expect(await errCode(svc.ingestWebhook(b, undefined))).toBe("invalid_signature");
    expect(await errCode(svc.ingestWebhook(b, signed(b, nowSec(), "x".repeat(48))))).toBe("invalid_signature");
    expect(await errCode(svc.ingestWebhook(b, signed(b, nowSec() - 400)))).toBe("invalid_signature"); // replay utenfor vinduet
    expect(await errCode(svc.ingestWebhook(b, signed(b, nowSec() + 400)))).toBe("invalid_signature");
    expect(await errCode(svc.ingestWebhook(Buffer.concat([b, Buffer.from(" ")]), signed(b)))).toBe("invalid_signature");
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id = 'wh-evt-000010'")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND type = 'business.product_usage_ingested'", [BIZ])).toBe(auditBefore);
  });

  it("ikke konfigurert (ingen/for kort hemmelighet, ingen tenant) feiler lukket FØR signaturen vurderes; konfigurert person-tenant avvises", async () => {
    const b = body([evt("wh-evt-000020", "acct-wh-0003", 1)]);
    const mk = (secret: string | null, tenant: string | null) => new ProductUsageService(app, { webhookSecretProvider: async () => secret, tenantResolver: () => tenant });
    expect(await errCode(mk(null, BIZ).ingestWebhook(b, signed(b)))).toBe("not_configured");
    expect(await errCode(mk("kort", BIZ).ingestWebhook(b, signed(b, nowSec(), "kort")))).toBe("not_configured");
    expect(await errCode(mk("w".repeat(31), BIZ).ingestWebhook(b, signed(b, nowSec(), "w".repeat(31))))).toBe("not_configured");
    expect(await errCode(mk(SECRET, null).ingestWebhook(b, signed(b)))).toBe("not_configured");
    expect(await errCode(new ProductUsageService(app).ingestWebhook(b, signed(b)))).toBe("not_configured");
    expect(await errCode(mk(SECRET, PERSON_TENANT).ingestWebhook(b, signed(b)))).toBe("not_business_tenant");
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id = 'wh-evt-000020'")).toBe(0);
  });

  it("kroppen kan ikke styre tenant: tenant_id/memory_space i en hendelse avvises som ukjent felt, og en ugyldig HEL kropp gir UsageImportError", async () => {
    const evil = body([{ ...evt("wh-evt-000030", "acct-wh-0004", 1), tenant_id: BIZ_B }]);
    const r = await svc.ingestWebhook(evil, signed(evil));
    expect(r).toMatchObject({ received: 0, inserted: 0, rejected: 1 });
    expect(r.rejected_detail).toEqual([{ position: 1, reason: "unknown_field:tenant_id" }]);
    for (const [raw, code] of [["{broken", "payload_not_json"], ["[]", "payload_not_an_object"], [JSON.stringify({ events: [] }), "payload_event_count_invalid"]] as const) {
      const b = Buffer.from(raw);
      expect(await errCode(svc.ingestWebhook(b, signed(b)))).toBe(code);
    }
    expect(webhookUsageSource.source_id).toBe("webhook");
  });
});

describe("E: kobling konto -> kundeselskap (eierens valg)", () => {
  it("kobler, er idempotent, flytter til annet selskap (med forrige), og avviser ukjent/fremmed selskap og ugyldige referanser", async () => {
    const co1 = await business.createCompany(BIZ, SP, { name: "Kunde Ett AS" });
    const co2 = await business.createCompany(BIZ, SP, { name: "Kunde To AS" });
    const foreign = await business.createCompany(BIZ_B, SP, { name: "Fremmed AS" });
    await importEvents(BIZ, [evt("lnk-evt-000001", "acct-lnk-0001", 1)]);
    const first = await svc.linkAccount(BIZ, SP, "acct-lnk-0001", co1.company_id, OWNER);
    expect(first).toEqual({ account_ref: "acct-lnk-0001", company_id: co1.company_id, changed: true, previous_company_id: null });
    expect(await svc.linkAccount(BIZ, SP, "acct-lnk-0001", co1.company_id, OWNER)).toMatchObject({ changed: false });
    expect(await svc.linkAccount(BIZ, SP, "acct-lnk-0001", co2.company_id, OWNER)).toMatchObject({ changed: true, previous_company_id: co1.company_id });
    expect(await errCode(svc.linkAccount(BIZ, SP, "acct-lnk-0001", foreign.company_id, OWNER))).toBe("company_not_found");
    expect(await errCode(svc.linkAccount(BIZ, SP, "acct-lnk-0001", "biz-co-finnes-ikke", OWNER))).toBe("company_not_found");
    expect(await errCode(svc.linkAccount(PERSON_TENANT, "business", "acct-lnk-0001", co1.company_id, OWNER))).toBe("not_business_tenant");
    for (const ref of ["ola@example.com", "4791234567", 5, null, "kort"]) expect(await errCode(svc.linkAccount(BIZ, SP, ref, co1.company_id)), String(ref)).toBe("invalid_input");
    for (const company of ["", "x y", 5, null, "a".repeat(200)]) expect(await errCode(svc.linkAccount(BIZ, SP, "acct-lnk-0001", company)), String(company)).toBe("invalid_input");
    const row = (await admin.query("SELECT company_id, linked_by FROM product_usage_accounts WHERE tenant_id = $1 AND account_ref = 'acct-lnk-0001'", [BIZ])).rows[0];
    expect(row).toEqual({ company_id: co2.company_id, linked_by: OWNER });
    const audit = await admin.query("SELECT payload FROM audit_events WHERE tenant_id = $1 AND type = 'business.product_account_linked' ORDER BY audit_id", [BIZ]);
    expect(audit.rowCount).toBe(2);
    // revisjonen er append-only (kan ikke slettes av erasure): den bærer en kort hash av kontoen, ALDRI pseudonymet selv
    const payloads = audit.rows.map((r) => r.payload as Record<string, unknown>);
    expect(Object.keys(payloads[1] as object).sort()).toEqual(["account_ref_sha256_12", "company_id", "previous_company_id"]);
    expect(JSON.stringify(payloads)).not.toContain("acct-lnk-0001");
    expect((payloads[1] as { previous_company_id: string }).previous_company_id).toBe(co1.company_id);
  });

  it("kobling kan gjøres FØR første hendelse; ukoblet/koblet-filter i listAccounts; unlink fjerner koblingen og vurderingen", async () => {
    const co = await business.createCompany(BIZ, SP, { name: "Forhåndskoblet AS" });
    await svc.linkAccount(BIZ, SP, "acct-pre-0001", co.company_id, OWNER);
    expect((await svc.listAccounts(BIZ, SP, { linked: true })).map((a) => a.account_ref)).toContain("acct-pre-0001");
    expect((await svc.listAccounts(BIZ, SP, { linked: false })).map((a) => a.account_ref)).not.toContain("acct-pre-0001");
    await importEvents(BIZ, [evt("pre-evt-000001", "acct-pre-0001", 1)]);
    expect((await admin.query("SELECT first_event_at IS NOT NULL AS has_first FROM product_usage_accounts WHERE tenant_id = $1 AND account_ref = 'acct-pre-0001'", [BIZ])).rows[0]).toEqual({ has_first: true });
    await churn.assessTenant(BIZ, SP);
    expect(await count("SELECT count(*)::int AS n FROM business_churn_assessments WHERE tenant_id = $1 AND account_ref = 'acct-pre-0001'", [BIZ])).toBe(1);
    expect(await svc.unlinkAccount(BIZ, SP, "acct-pre-0001", OWNER)).toEqual({ changed: true });
    expect(await svc.unlinkAccount(BIZ, SP, "acct-pre-0001", OWNER)).toEqual({ changed: false });
    expect(await count("SELECT count(*)::int AS n FROM business_churn_assessments WHERE tenant_id = $1 AND account_ref = 'acct-pre-0001'", [BIZ])).toBe(0);
    expect((await svc.listAccounts(BIZ, SP, { linked: false, limit: 500 })).map((a) => a.account_ref)).toContain("acct-pre-0001");
  });
});

describe("F: oppbevaring og «glem bruker»", () => {
  it("purgeExpired sletter hendelser eldre enn oppbevaringen (aldri under 30 dager), beholder resten, og berører ikke andre tenants", async () => {
    await admin.query("INSERT INTO product_usage_accounts (tenant_id, account_ref) VALUES ($1, 'acct-ret-0001'), ($2, 'acct-ret-0001') ON CONFLICT DO NOTHING", [BIZ, BIZ_B]);
    for (const [tenant, id, days] of [[BIZ, "ret-old-000001", 500], [BIZ, "ret-mid-000001", 40], [BIZ, "ret-new-000001", 10], [BIZ_B, "ret-old-000002", 500]] as const) {
      await admin.query(
        `INSERT INTO product_usage_events (event_id, tenant_id, source_id, external_event_id, kind, account_ref, feature, quantity, occurred_at)
         VALUES ($1, $2, 'webhook', $3, 'usage', 'acct-ret-0001', 'chat.send', 1, now() - make_interval(days => $4))`, [`pue-${id}`, tenant, id, days]
      );
    }
    expect(await svc.purgeExpired(BIZ, SP)).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id IN ('ret-mid-000001','ret-new-000001')")).toBe(2);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id = 'ret-old-000002'")).toBe(1); // BIZ_B urørt
    // gulvet: selv med 5 dager slettes bare det som er eldre enn 30
    expect(await svc.purgeExpired(BIZ, SP, 5)).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id = 'ret-new-000001'")).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE external_event_id = 'ret-mid-000001'")).toBe(0);
  });

  it("forgetUserRef nuller user_ref i egen tenant (volum beholdes), rører ikke andre tenants, og avviser PII-lignende referanser", async () => {
    await admin.query("INSERT INTO product_usage_accounts (tenant_id, account_ref) VALUES ($1, 'acct-frg-0001'), ($2, 'acct-frg-0001') ON CONFLICT DO NOTHING", [BIZ, BIZ_B]);
    for (const [tenant, id] of [[BIZ, "frg-evt-000001"], [BIZ, "frg-evt-000002"], [BIZ_B, "frg-evt-000003"]] as const) {
      await admin.query(
        `INSERT INTO product_usage_events (event_id, tenant_id, source_id, external_event_id, kind, account_ref, user_ref, feature, quantity, occurred_at)
         VALUES ($1, $2, 'webhook', $3, 'usage', 'acct-frg-0001', 'usr_forgetme01', 'chat.send', 3, now())`, [`pue-${id}`, tenant, id]
      );
    }
    expect(await svc.forgetUserRef(BIZ, SP, "usr_forgetme01", OWNER)).toBe(2);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1 AND user_ref = 'usr_forgetme01'", [BIZ])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1 AND user_ref = 'usr_forgetme01'", [BIZ_B])).toBe(1);
    expect((await admin.query("SELECT sum(quantity)::int AS q FROM product_usage_events WHERE tenant_id = $1 AND account_ref = 'acct-frg-0001'", [BIZ])).rows[0]).toEqual({ q: 6 });
    expect(await errCode(svc.forgetUserRef(BIZ, SP, "ola@example.com"))).toBe("invalid_input");
    const audit = (await admin.query("SELECT payload FROM audit_events WHERE tenant_id = $1 AND type = 'business.product_usage_user_forgotten' ORDER BY audit_id DESC LIMIT 1", [BIZ])).rows[0] as { payload: unknown };
    expect(JSON.stringify(audit.payload)).toBe('{"events_changed":2}');
  });
});

describe("G: churn-vurdering -> open loops (SUGGEST/INFORM, aldri ACT)", () => {
  const loopsOf = async (tenant: string, status: "open" | "resolved" | "all" = "open") =>
    (await openLoops.listOpenLoops(tenant, SP, status)).filter((l) => l.loop_type === "customer_churn_risk");
  const addTicket = (tenant: string, companyId: string, id: string, priority = "normal", status = "open") =>
    admin.query("INSERT INTO support_tickets (ticket_id, tenant_id, company_id, subject, status, priority) VALUES ($1, $2, $3, 'Emne', $4, $5)", [id, tenant, companyId, status, priority]);

  it("inaktiv konto + åpen supportsak = HØY risiko: én forklarbar loop (INFORM-nivå confidence), idempotent, lukkes automatisk når bruken kommer tilbake", async () => {
    const co = await business.createCompany(BIZ, SP, { name: "Sovende AS" });
    const ACCT = "acct-sleepy-001";
    await importEvents(BIZ, [evt("slp-evt-000001", ACCT, 40), evt("slp-evt-000002", ACCT, 38), evt("slp-evt-000003", ACCT, 36), evt("slp-evt-000004", ACCT, 35)]);
    await svc.linkAccount(BIZ, SP, ACCT, co.company_id, OWNER);
    await addTicket(BIZ, co.company_id, "tkt-sleepy-0001");
    const first = await openLoops.detectChurnRisk(BIZ, SP);
    expect(first.detected).toBeGreaterThanOrEqual(1);
    const loop = (await loopsOf(BIZ)).find((l) => l.detection_key === `customer_churn_risk:${ACCT}`);
    expect(loop).toBeDefined();
    expect(loop).toMatchObject({
      company_id: co.company_id, priority: "high", status: "open", detection_method: "deterministic", owner_person_id: null, due_at: null, ticket_id: null
    });
    expect(loop?.reason).toBe("Churn-risiko høy (55/100): Ingen produktbruk på 35 dager; 1 åpen supportsak.");
    expect(loop?.next_action).toBe("Ta kontakt med kunden og avklar bruk og eventuelle hindringer; løs de åpne supportsakene.");
    expect(Number(loop?.confidence)).toBe(0.7); // heuristikk: under SUGGEST-terskelen 0.75 -> situasjonsbroen gir INFORM
    // vurderingen er lagret og forklarbar
    const a = await churn.assessmentsForCompany(BIZ, SP, co.company_id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ account_ref: ACCT, risk_score: 55, risk_level: "high", rule_version: "churn_risk_v1", signal_families: expect.arrayContaining(["usage", "support"]) });
    expect(a[0]?.signals.map((s) => s.code)).toEqual(["inactive_30d", "open_support_tickets"]);
    expect(a[0]?.evidence).toEqual([{ type: "support_ticket", id: "tkt-sleepy-0001" }]);
    expect(a[0]?.metrics).toMatchObject({ days_since_last_usage: 35, open_support_tickets: 1, insufficient_data: false });
    // idempotent: ny kjøring oppdaterer SAMME loop
    const second = await openLoops.detectChurnRisk(BIZ, SP);
    expect(second.detected).toBe(0);
    expect((await loopsOf(BIZ)).filter((l) => l.detection_key === `customer_churn_risk:${ACCT}`)).toHaveLength(1);
    expect(await count("SELECT count(*)::int AS n FROM business_churn_assessments WHERE tenant_id = $1 AND account_ref = $2", [BIZ, ACCT])).toBe(1);
    // bruken kommer tilbake -> vilkåret er ikke lenger sant -> automatisk lukket
    await importEvents(BIZ, [evt("slp-evt-000005", ACCT, 0)]);
    const third = await openLoops.detectChurnRisk(BIZ, SP);
    expect(third.auto_resolved).toBeGreaterThanOrEqual(1);
    expect((await loopsOf(BIZ)).filter((l) => l.detection_key === `customer_churn_risk:${ACCT}`)).toHaveLength(0);
    const resolved = (await loopsOf(BIZ, "resolved")).find((l) => l.detection_key === `customer_churn_risk:${ACCT}`);
    expect(resolved?.resolution_reason).toBe("condition_no_longer_true");
  });

  it("fall i bruk + forfalte fakturaer = MIDDELS: normal prioritet; ferske data teller, en gammel faktura-status (> 45 dager) teller ikke", async () => {
    const co = await business.createCompany(BIZ, SP, { name: "Fallende AS" });
    const ACCT = "acct-drop-0001";
    await importEvents(BIZ, [
      evt("drp-evt-000001", ACCT, 45), evt("drp-evt-000002", ACCT, 20, { quantity: 10 }), evt("drp-evt-000003", ACCT, 18, { quantity: 10 }),
      evt("drp-evt-000004", ACCT, 16, { quantity: 10 }), evt("drp-evt-000005", ACCT, 2, { quantity: 5 }),
      { event_id: "drp-bill-000001", kind: "billing_status", account_ref: ACCT, quantity: 2, occurred_at: ago(3) },
      { event_id: "drp-bill-000002", kind: "billing_status", account_ref: ACCT, quantity: 9, occurred_at: ago(60) }
    ]);
    await svc.linkAccount(BIZ, SP, ACCT, co.company_id, OWNER);
    await openLoops.detectChurnRisk(BIZ, SP);
    const loop = (await loopsOf(BIZ)).find((l) => l.detection_key === `customer_churn_risk:${ACCT}`);
    expect(loop).toMatchObject({ priority: "normal", company_id: co.company_id });
    expect(loop?.reason).toBe("Churn-risiko middels (45/100): Bruken er ned 83 % siste 14 dager (5 mot 30); 2 forfalte fakturaer.");
    const [a] = await churn.assessmentsForCompany(BIZ, SP, co.company_id);
    expect(a?.signal_families.slice().sort()).toEqual(["billing", "usage"]);
    expect(a?.metrics).toMatchObject({ usage_recent_14d: 5, usage_baseline_prev_14d: 30, usage_drop_pct: 83, overdue_invoices: 2 });
    expect(a?.evidence).toEqual([{ type: "billing_event", id: expect.stringMatching(/^pue-/) }]);

    // eier lukker loopen -> neste sveip gjenåpner den IKKE (7 dagers undertrykkelse), men gjør det etter det
    await openLoops.resolveOpenLoop(BIZ, SP, loop!.open_loop_id, "Ringte kunden");
    await openLoops.detectChurnRisk(BIZ, SP);
    expect((await loopsOf(BIZ)).some((l) => l.open_loop_id === loop!.open_loop_id)).toBe(false);
    await admin.query("UPDATE business_open_loops SET resolved_at = now() - interval '8 days' WHERE open_loop_id = $1", [loop!.open_loop_id]);
    await openLoops.detectChurnRisk(BIZ, SP);
    expect((await loopsOf(BIZ)).some((l) => l.open_loop_id === loop!.open_loop_id)).toBe(true);
  });

  it("lav risiko gir vurdering men ingen loop; ukoblet konto vurderes ikke, men telles; konto uten bruksdata er «ingen data», ikke høy risiko", async () => {
    const co = await business.createCompany(BIZ, SP, { name: "Rolig AS" });
    await importEvents(BIZ, [evt("calm-evt-00001", "acct-calm-0001", 1), evt("orph-evt-0001", "acct-orphan-001", 50)]);
    await svc.linkAccount(BIZ, SP, "acct-calm-0001", co.company_id, OWNER);
    const co2 = await business.createCompany(BIZ, SP, { name: "Tom AS" });
    await svc.linkAccount(BIZ, SP, "acct-empty-0001", co2.company_id, OWNER);
    await addTicket(BIZ, co2.company_id, "tkt-empty-00001", "urgent");
    await addTicket(BIZ, co2.company_id, "tkt-empty-00002", "high");
    await addTicket(BIZ, co2.company_id, "tkt-empty-00003", "normal");
    const sweep = await churn.assessTenant(BIZ, SP);
    expect(sweep.unlinked_accounts).toBeGreaterThanOrEqual(1);
    expect(sweep.assessments.find((a) => a.account_ref === "acct-calm-0001")).toMatchObject({ risk_score: 0, risk_level: "low" });
    const empty = sweep.assessments.find((a) => a.account_ref === "acct-empty-0001");
    expect(empty).toMatchObject({ risk_score: 0, risk_level: "low", signals: [] });
    expect(empty?.metrics.insufficient_data).toBe(true);
    expect(sweep.assessments.find((a) => a.account_ref === "acct-orphan-001")).toBeUndefined();
    await openLoops.detectChurnRisk(BIZ, SP);
    const keys = (await loopsOf(BIZ, "all")).map((l) => l.detection_key);
    for (const k of ["acct-calm-0001", "acct-empty-0001", "acct-orphan-001"]) expect(keys).not.toContain(`customer_churn_risk:${k}`);
  });

  it("tenant-isolasjon: samme kontoreferanse i en annen tenant har egne vurderinger/loops, og tenantene ser ikke hverandres", async () => {
    const coB = await business.createCompany(BIZ_B, SP, { name: "Isolert AS" });
    await importEvents(BIZ_B, [evt("iso-evt-000001", "acct-iso-00001", 33)]);
    await svc.linkAccount(BIZ_B, SP, "acct-iso-00001", coB.company_id, OWNER);
    await openLoops.detectChurnRisk(BIZ_B, SP);
    const bLoops = await loopsOf(BIZ_B);
    expect(bLoops.map((l) => l.detection_key)).toEqual(["customer_churn_risk:acct-iso-00001"]); // 33 dager uten bruk = 45 = middels
    expect(bLoops[0]?.priority).toBe("normal");
    expect((await churn.listAtRisk(BIZ_B, SP)).map((a) => a.account_ref)).toEqual(["acct-iso-00001"]);
    expect((await churn.listAtRisk(BIZ, SP)).map((a) => a.account_ref)).not.toContain("acct-iso-00001");
    expect((await churn.listAtRisk(BIZ_B, SP))[0]?.company_name).toBe("Isolert AS");
  });

  it("listAtRisk sorterer høyest risiko først og kan begrenses til HØY; hele runSweep tåler en tenant uten produktbruk-data", async () => {
    const all = await churn.listAtRisk(BIZ, SP, { limit: 50 });
    const scores = all.map((a) => a.risk_score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    expect(all.every((a) => a.risk_level === "medium" || a.risk_level === "high")).toBe(true);
    expect((await churn.listAtRisk(BIZ, SP, { minLevel: "high" })).every((a) => a.risk_level === "high")).toBe(true);
    await expect(openLoops.runSweep(BIZ, SP)).resolves.toBeDefined();
    await expect(openLoops.runSweep(PERSON_TENANT, "business")).resolves.toBeDefined();
  });
});

describe("H: loop_type-CHECK ble utvidet uten å miste eksisterende typer", () => {
  it("alle kjente typer + customer_churn_risk godtas; en ukjent type avvises", async () => {
    const def = ((await admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'business_open_loops'::regclass AND conname = 'business_open_loops_loop_type_check'`)).rows[0] as { def: string }).def;
    const known = [
      "overdue_followup", "stalled_opportunity", "support_ticket_needs_reply", "support_ticket_overdue", "support_ticket_unassigned", "support_ticket_waiting_internal",
      "contract_renewal_due", "contract_termination_deadline", "contract_obligation_due", "contract_review_required", "marketing_spend_anomaly", "payment_intent_anomaly",
      "payment_intent_reconciliation_mismatch", "finance_spend_unexpected", "finance_spend_amount_deviation", "finance_recurring_charge_missing",
      "finance_recurring_charge_duplicate", "finance_spend_correction_conflict", "bank_transaction_unmatched", "bank_consent_attention", "card_anomaly_attention",
      "finance_procurement_missing", "product_item_needs_triage", "product_item_high_priority_stalled", "operations_task_overdue", "operations_task_escalation_needed",
      "customer_churn_risk"
    ];
    for (const t of known) expect(def, t).toContain(`'${t}'`);
    await expect(admin.query(
      `INSERT INTO business_open_loops (open_loop_id, tenant_id, loop_type, detection_key, reason) VALUES ('ol-bogus', $1, 'bogus_type', 'k', 'r')`, [BIZ]
    )).rejects.toThrow(/business_open_loops_loop_type_check/);
  });

  it("migrasjonens DO-blokk er idempotent og kan bygge videre på sitt eget resultat (en senere migrasjon/gren kan utvide listen på samme måte uten å miste noe)", async () => {
    const sql = await readFile(fileURLToPath(new URL("../../core/src/db/migrations/090_business_product_usage_churn.sql", import.meta.url)), "utf8");
    const block = /DO \$\$[\s\S]*?\n\$\$;/.exec(sql)?.[0];
    expect(block, "DO-blokken finnes i migrasjonen").toBeDefined();
    const defOf = async () => ((await admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'business_open_loops'::regclass AND conname = 'business_open_loops_loop_type_check'`)).rows[0] as { def: string }).def;
    const before = await defOf();
    await admin.query(block as string); // customer_churn_risk finnes allerede -> no-op
    expect(await defOf()).toBe(before);
    await admin.query((block as string).replace(/customer_churn_risk/g, "future_loop_type_x")); // en annen gren utvider listen etter oss
    const after = await defOf();
    expect(after).toContain("'future_loop_type_x'");
    expect(after).toContain("'customer_churn_risk'");
    expect(after).toContain("'operations_task_overdue'");
    expect(after).toContain("ARRAY['overdue_followup'::text"); // kanonisk visning bevart -> neste utvidelse kan parse den
  });
});
