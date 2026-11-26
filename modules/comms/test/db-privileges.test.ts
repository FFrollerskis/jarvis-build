import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { CommsStore } from "../src/index.ts";
import { startCommsDb, TENANT_A, TENANT_B, type CommsDb } from "./support/harness.ts";

/**
 * WP-G1c fiks-runde 1 (FIX-5/FIX-6): databasen som tillitsgrense mot app-rollen. ALLE forsøk kjøres som app-rollen (NOSUPERUSER, NOBYPASSRLS, medlem av `jarvis_app`) mot ekte Postgres med FORCE RLS, og hvert forsøk ruller tilbake med mindre
 * `commit` er satt. Dekker: tabellrettighetene (en UPDATE-grant på kvitteringene var et testhull), at TRUNCATE / `session_replication_role` / DISABLE og DROP TRIGGER / `setval` gir 42501, DELETE-vernet (retensjon og erasure-GUC), den KJENTE
 * begrensningen at erasure-GUC-en kan settes av enhver app-forbindelse med fri SQL (DELVIS, FIX-5), og retensjonssveipets to DELETE-setninger (`LEAST(retention_until-grense, now())`).
 */
let db: CommsDb;
let appRole = "";
const SPACES = "personal,business,project,shared";
const H = (c: string): string => c.repeat(64);
type Step = [sql: string, params?: unknown[]];
interface Outcome { ok: boolean; code: string | null; message: string | null; n: number | null }

async function asApp(tenant: string, steps: Step[], opts: { commit?: boolean; erasure?: boolean } = {}): Promise<Outcome> {
  const c: pg.PoolClient = await db.app.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', $2, true)", [tenant, SPACES]);
    if (opts.erasure) await c.query("SELECT set_config('jarvis.erasure_in_progress', 'true', true)");
    let last: pg.QueryResult | null = null;
    for (const [sql, params] of steps) last = await c.query(sql, params as unknown[]);
    await c.query(opts.commit ? "COMMIT" : "ROLLBACK");
    return { ok: true, code: null, message: null, n: last?.rowCount ?? null };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    const e = err as { code?: string; message?: string };
    return { ok: false, code: e.code ?? null, message: e.message ?? null, n: null };
  } finally {
    c.release();
  }
}

const seedOptOut = (id: string, source: string, slot: string, hash: string, tenant = TENANT_A): Promise<unknown> => db.admin.query(
  `INSERT INTO comms_recipient_opt_outs (tenant_id, opt_out_id, memory_space_id, channel, account_ref, recipient_hash, recipient_hint, source, recorded_by, stop_seq)
   VALUES ($1, $2, 'business', 'sms', $3, $4, '+47•••••000', $5, 'seed', 5)`, [tenant, id, slot, hash, source]);
const seedReceipt = (key: string, retention: string): Promise<unknown> => db.admin.query(
  `INSERT INTO comms_inbound_receipts (tenant_id, memory_space_id, provider, event_key, kind, recv_seq, retention_until, source, ingest_id)
   VALUES ($1, 'business', 'twilio', $2, 'opt_in', 3, now() + $3::interval, 'webhook:twilio', 'ingest-privs-0001')`, [TENANT_A, key, retention]);
const seedJournal = (id: string, retention: string): Promise<unknown> => db.admin.query(
  `INSERT INTO comms_outbound_log (tenant_id, log_id, memory_space_id, request_id, kind, channel, account_ref, provider, recipient_hash, purpose, status, rule_evaluation, denial_codes, recipient_proof, content_length,
     ai_disclosure_applied, person_id, session_id, source, created_at, updated_at, retention_until, before_state, content_hash_version)
   SELECT $1, $2, 'business', $3, 'message', 'sms', 'acc1', 'twilio', $4, 'transactional', 'requested', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 5, false, 'person-g1-owner', 's1', 'owner_route', now(), now(),
     now() + $5::interval, '{"v":2,"request_fingerprint":"abc"}'::jsonb, 2`, [TENANT_A, id, `req-${id}`, H("9"), retention]);
const count = async (table: string, where: string, params: unknown[]): Promise<number> => ((await db.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0] as { n: number }).n;

beforeAll(async () => {
  db = await startCommsDb("g1cpv");
  appRole = ((await db.app.query("SELECT current_user AS u")).rows[0] as { u: string }).u;
  await seedOptOut("pv-owner-0001", "owner_recorded", "*owner", H("1"));
  await seedOptOut("pv-ownerB-001", "owner_recorded", "*owner", H("5"), TENANT_B);
}, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);

describe("tabellrettigheter (nøyaktig, per privilegium) for app-rollen", () => {
  const priv = async (table: string, privilege: string): Promise<boolean> =>
    ((await db.admin.query("SELECT has_table_privilege($1, $2, $3) AS ok", [appRole, table, privilege])).rows[0] as { ok: boolean }).ok;
  const matrix: Array<[table: string, allowed: string[]]> = [
    ["comms_recipient_opt_outs", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
    // første-mottak: kun lese, skrive og slette (retensjon). INGEN UPDATE (S08: en UPDATE-grant ville latt app-SQL skrive om `recv_seq`).
    ["comms_inbound_receipts", ["SELECT", "INSERT", "DELETE"]],
    ["comms_outbound_log", ["SELECT", "INSERT", "UPDATE", "DELETE"]]
  ];
  for (const [table, allowed] of matrix) {
    it(`${table}: app-rollen har akkurat ${allowed.join("/")} - og ikke TRUNCATE, TRIGGER eller REFERENCES`, async () => {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        expect(await priv(table, p), `${table} ${p}`).toBe(allowed.includes(p));
      }
    });
  }

  it("sekvensen `comms_event_seq`: app-rollen kan bruke den (nextval/lese), men ikke endre den (UPDATE gjør `setval` mulig)", async () => {
    const seqPriv = async (p: string): Promise<boolean> => ((await db.admin.query("SELECT has_sequence_privilege($1, 'comms_event_seq', $2) AS ok", [appRole, p])).rows[0] as { ok: boolean }).ok;
    expect(await seqPriv("USAGE")).toBe(true);
    expect(await seqPriv("SELECT")).toBe(true);
    expect(await seqPriv("UPDATE")).toBe(false);
  });

  it("UPDATE på en kvittering gir 42501 (permission denied), og raden er uendret", async () => {
    await seedReceipt("twilio:msg:SMprivupd0000000000000000000000001", "30 days");
    const r = await asApp(TENANT_A, [["UPDATE comms_inbound_receipts SET recv_seq = 1 WHERE tenant_id = $1 AND event_key = $2", [TENANT_A, "twilio:msg:SMprivupd0000000000000000000000001"]]]);
    expect(r.code).toBe("42501");
    expect(r.message).toMatch(/permission denied/i);
    expect(await count("comms_inbound_receipts", "event_key = $1 AND recv_seq = 3", ["twilio:msg:SMprivupd0000000000000000000000001"])).toBe(1);
  });
});

describe("omgåelsesveier som krever mer enn tabellrettigheter gir 42501 (insufficient_privilege)", () => {
  const cases: Array<[name: string, sql: string]> = [
    ["TRUNCATE avmeldinger", "TRUNCATE comms_recipient_opt_outs"],
    ["TRUNCATE kvitteringer", "TRUNCATE comms_inbound_receipts"],
    ["TRUNCATE journal", "TRUNCATE comms_outbound_log"],
    ["SET session_replication_role = replica (omgår alle triggere)", "SET LOCAL session_replication_role = replica"],
    ["ALTER TABLE ... DISABLE TRIGGER (avmeldinger)", "ALTER TABLE comms_recipient_opt_outs DISABLE TRIGGER comms_recipient_opt_outs_guard"],
    ["ALTER TABLE ... DISABLE TRIGGER ALL (kvitteringer)", "ALTER TABLE comms_inbound_receipts DISABLE TRIGGER ALL"],
    ["DROP TRIGGER (avmeldinger)", "DROP TRIGGER comms_recipient_opt_outs_guard ON comms_recipient_opt_outs"],
    ["setval på hendelsessekvensen", "SELECT setval('comms_event_seq', 1)"],
    ["ALTER SEQUENCE ... RESTART", "ALTER SEQUENCE comms_event_seq RESTART"],
    ["CREATE OR REPLACE FUNCTION over vakt-funksjonen", "CREATE OR REPLACE FUNCTION comms_recipient_opt_outs_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"],
    ["SET ROLE til superbruker", "SET LOCAL ROLE postgres"]
  ];
  for (const [name, sql] of cases) {
    it(`${name}: 42501`, async () => {
      const r = await asApp(TENANT_A, [[sql]]);
      expect(r.ok, `${sql} lyktes`).toBe(false);
      expect(r.code, r.message ?? "").toBe("42501");
    });
  }

  it("alle avmeldings-/kvitterings-/journalradene og sekvensen står uendret etter forsøkene", async () => {
    expect(await count("comms_recipient_opt_outs", "tenant_id = $1 AND opt_out_id = 'pv-owner-0001' AND status = 'active'", [TENANT_A])).toBe(1);
    expect(await count("comms_recipient_opt_outs", "tenant_id = $1", [TENANT_B])).toBe(1);
  });
});

describe("DELETE-vernet (trigger): retensjon for kvitteringer og journal, erasure-GUC for avmeldinger", () => {
  it("avmelding: DELETE uten erasure-GUC avvises (23514 comms_row_delete_forbidden), også en spørring som treffer alle tenantens rader", async () => {
    const one = await asApp(TENANT_A, [["DELETE FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = 'pv-owner-0001'", [TENANT_A]]]);
    expect(one.code).toBe("23514");
    expect(one.message).toMatch(/comms_row_delete_forbidden/);
    const all = await asApp(TENANT_A, [["DELETE FROM comms_recipient_opt_outs WHERE tenant_id = $1", [TENANT_A]]]);
    expect(all.code).toBe("23514");
    expect(await count("comms_recipient_opt_outs", "tenant_id = $1 AND opt_out_id = 'pv-owner-0001'", [TENANT_A])).toBe(1);
  });

  it("kvittering: DELETE før `retention_until` avvises (23514), etter utløp tillatt", async () => {
    await seedReceipt("twilio:msg:SMprivdel0000000000000000000000001", "30 days");
    await seedReceipt("twilio:msg:SMprivdel0000000000000000000000002", "-1 day");
    const fresh = await asApp(TENANT_A, [["DELETE FROM comms_inbound_receipts WHERE tenant_id = $1 AND event_key = 'twilio:msg:SMprivdel0000000000000000000000001'", [TENANT_A]]]);
    expect(fresh.code).toBe("23514");
    expect(fresh.message).toMatch(/comms_row_delete_forbidden:comms_inbound_receipts/);
    const expired = await asApp(TENANT_A, [["DELETE FROM comms_inbound_receipts WHERE tenant_id = $1 AND event_key = 'twilio:msg:SMprivdel0000000000000000000000002'", [TENANT_A]]]);
    expect(expired.ok).toBe(true);
    expect(expired.n).toBe(1);
  });

  it("journal: DELETE før `retention_until` avvises (23514), etter utløp tillatt; retention_until og content_hash_version er uforanderlige", async () => {
    await seedJournal("log-priv-0001", "30 days");
    await seedJournal("log-priv-0002", "-1 day");
    const fresh = await asApp(TENANT_A, [["DELETE FROM comms_outbound_log WHERE tenant_id = $1 AND log_id = 'log-priv-0001'", [TENANT_A]]]);
    expect(fresh.code).toBe("23514");
    expect((await asApp(TENANT_A, [["DELETE FROM comms_outbound_log WHERE tenant_id = $1 AND log_id = 'log-priv-0002'", [TENANT_A]]])).n).toBe(1);
    const shorten = await asApp(TENANT_A, [["UPDATE comms_outbound_log SET retention_until = now() - interval '1 day' WHERE tenant_id = $1 AND log_id = 'log-priv-0001'", [TENANT_A]]]);
    const version = await asApp(TENANT_A, [["UPDATE comms_outbound_log SET content_hash_version = 1 WHERE tenant_id = $1 AND log_id = 'log-priv-0001'", [TENANT_A]]]);
    expect(shorten.ok, "retention_until kan ikke kortes ned av app-SQL").toBe(false);
    expect(version.ok, "content_hash_version kan ikke nedgraderes av app-SQL").toBe(false);
  });

  it("KJENT BEGRENSNING (DELVIS, fiks-runde 1 FIX-5): en app-forbindelse med FRI SQL kan sette erasure-GUC-en selv og slette en eierregistrert avmelding - vernet er mot kodefeil, ikke mot en kompromittert app-tilkobling", async () => {
    await seedOptOut("pv-erase-0001", "owner_recorded", "*owner", H("6"));
    const r = await asApp(TENANT_A, [["DELETE FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = 'pv-erase-0001'", [TENANT_A]]], { erasure: true, commit: true });
    // Denne testen BESKRIVER dagens begrensning (SECURITY DEFINER-funksjon eller egen erasure-rolle er Q-forslaget). Blir den røde fordi vernet er skjerpet, er det RIKTIG: snu forventningen og fjern «KJENT BEGRENSNING».
    expect(r.ok).toBe(true);
    expect(r.n).toBe(1);
    expect(await count("comms_recipient_opt_outs", "opt_out_id = 'pv-erase-0001'", [])).toBe(0);
  });

  it("GUC-en gir aldri tilgang på tvers av tenant (RLS): en erasure-økt i tenant A sletter 0 rader i tenant B", async () => {
    const r = await asApp(TENANT_A, [["DELETE FROM comms_recipient_opt_outs WHERE opt_out_id = 'pv-ownerB-001'"]], { erasure: true, commit: true });
    expect(r.ok).toBe(true);
    expect(r.n).toBe(0);
    expect(await count("comms_recipient_opt_outs", "opt_out_id = 'pv-ownerB-001'", [])).toBe(1);
  });
});

describe("K10: retensjonssveipets to DELETE-setninger hopper over rader databasen ikke ville tillatt (LEAST(appklokke, now()))", () => {
  /**
   * `purgeExpired` bruker appens (injiserbare) klokke. Står den FORAN databasens (eller er den en fremtidig testklokke), ville et utvalg uten `LEAST(.., now())` ta med rader databasen selv avviser, og HELE sveipet feilet på triggeren i stedet for å
   * hoppe over dem. Hver av de to setningene (kvitteringer og journal) testes for seg: begge MÅ ha begrensningen.
   */
  const FUTURE = new Date("2040-01-01T00:00:00Z");
  const sweeper = (): CommsStore => new CommsStore(db.app, () => FUTURE);
  // utløpte rester fra testene over (en slettet-og-rullet-tilbake rad) fjernes først, så tellingene under gjelder KUN radene hver test legger inn
  beforeAll(async () => { await sweeper().purgeExpired(TENANT_A, "business"); });

  it("kvitteringer: en ikke-utløpt rad (databasens klokke) hoppes over uten feil mens appklokken står i 2040; en utløpt rad slettes", async () => {
    await seedReceipt("twilio:msg:SMsweepR0000000000000000000000001", "30 days");
    await seedReceipt("twilio:msg:SMsweepR0000000000000000000000002", "-1 day");
    const swept = await sweeper().purgeExpired(TENANT_A, "business");
    expect(swept.receipts, "kun den utløpte kvitteringen").toBe(1);
    expect(await count("comms_inbound_receipts", "event_key = 'twilio:msg:SMsweepR0000000000000000000000001'", [])).toBe(1);
    expect(await count("comms_inbound_receipts", "event_key = 'twilio:msg:SMsweepR0000000000000000000000002'", [])).toBe(0);
  });

  it("journal: en ikke-utløpt rad hoppes over uten feil mens appklokken står i 2040; en utløpt rad slettes", async () => {
    await seedJournal("log-sweep-0001", "30 days");
    await seedJournal("log-sweep-0002", "-1 day");
    const swept = await sweeper().purgeExpired(TENANT_A, "business");
    expect(swept.journal, "kun den utløpte journalraden").toBe(1);
    expect(await count("comms_outbound_log", "log_id = 'log-sweep-0001'", [])).toBe(1);
    expect(await count("comms_outbound_log", "log_id = 'log-sweep-0002'", [])).toBe(0);
  });

  it("begge samtidig: ikke-utløpte rader i begge tabellene gir et sveip som ikke feiler og returnerer 0/0", async () => {
    await seedReceipt("twilio:msg:SMsweepB0000000000000000000000001", "30 days");
    await seedJournal("log-sweep-0003", "30 days");
    await expect(sweeper().purgeExpired(TENANT_A, "business")).resolves.toMatchObject({ journal: 0, receipts: 0 });
  });
});
