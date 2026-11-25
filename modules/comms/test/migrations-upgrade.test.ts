import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, planMigrations, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";

/**
 * WP-G1c K1/K2/K5 (JARVIS-112 b, c, f): migrasjonene 141+ testes OPPOVER fra main-skjemaet (001-140) med eksisterende comms-data - ikke bare fra en tom database (det dekker alle andre comms-tester). Fase 1 = main (001-140) + data slik main kunne ha den
 * (inkl. en rad som bryter den NYE rom-CHECK-en); fase 2 = 141+ . Bevist: ingen eksisterende rad går tapt eller endres, rom-CHECK forblir NOT VALID (med en NOTICE, ikke en feilet migrasjon) når gamle rader bryter den og er fullt gyldig ellers, trigger/DELETE-vern/sekvens
 * virker for gamle og nye rader som app-rolle, og migratoren er idempotent (en andre kjøring gjør ingenting).
 */
const MIGRATIONS = fileURLToPath(new URL("../../core/src/db/migrations", import.meta.url));
const UPGRADE_FROM = 141;
const T = "tenant-g1c-up";
const OWNER = "person-g1c-up";
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let dir: string;
let applied: string[] = [];

beforeAll(async () => {
  const all = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  dir = await mkdtemp(join(tmpdir(), "jarvis-g1c-migrations-"));
  for (const f of all.filter((name) => Number(name.slice(0, 3)) < UPGRADE_FROM)) await copyFile(join(MIGRATIONS, f), join(dir, f));
  const pgDir = await mkdtemp(join(tmpdir(), "jarvis-pg-g1cup-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: pgDir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  // FASE 1: main-skjemaet (alt FØR 141)
  const phase1 = await runMigrations(admin, dir);
  expect(phase1.some((f) => f.startsWith("118_")) && phase1.some((f) => f.startsWith("119_"))).toBe(true);
  expect(phase1.some((f) => Number(f.slice(0, 3)) >= UPGRADE_FROM)).toBe(false);
  await admin.query("CREATE ROLE jarvis_g1cup_app LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_g1cup_app");
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_g1cup_app", password: "pw2" });
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${T}', 'G1c upgrade', 'business')`);
  await admin.query(`INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier')`);
  // Eksisterende (main-)data: avmeldinger med alle kilder (to opphevet av START), journal (usaltet hash) og en rad som bryter den nye rom-regelen (`health` var lovlig i 118)
  const hash = (c: string) => c.repeat(64).slice(0, 64);
  const optOut = (id: string, source: string, hashChar: string, extra = "") =>
    admin.query(`INSERT INTO comms_recipient_opt_outs (tenant_id, opt_out_id, memory_space_id, channel, account_ref, recipient_hash, recipient_hint, source ${extra ? ", status, lifted_at, lifted_by" : ""}) VALUES ($1, $2, 'business', 'sms', $3, $4, '+47•••••001', $5 ${extra ? ", 'lifted', now(), 'inbound_start_keyword'" : ""})`, [T, id, `*${source}`, hash(hashChar), source]);
  await optOut("optout-old-keyword-1", "inbound_stop_keyword", "1");
  await optOut("optout-old-owner-001", "owner_recorded", "2");
  await optOut("optout-old-request-1", "recipient_request", "3");
  await optOut("optout-old-lifted-01", "provider_error", "4", "lifted");
  await admin.query(`INSERT INTO comms_recipient_opt_outs (tenant_id, opt_out_id, memory_space_id, channel, account_ref, recipient_hash, recipient_hint, source) VALUES ($1, 'optout-old-health-01', 'health', 'sms', '*', $2, 'x', 'owner_recorded')`, [T, hash("5")]);
  await admin.query(`INSERT INTO comms_authorized_accounts (tenant_id, account_id, memory_space_id, channel, account_ref, provider, source) VALUES ($1, 'acct-old-0001', 'business', 'sms', '+4791000000', 'twilio', 'owner_route')`, [T]);
  await admin.query(
    `INSERT INTO comms_outbound_log (tenant_id, log_id, memory_space_id, request_id, kind, channel, account_ref, provider, recipient_hash, purpose, status, rule_evaluation, recipient_proof, content_sha256, content_length, person_id, session_id, source, before_state, retention_until)
     VALUES ($1, 'clog-old-0001', 'business', 'send:abcdef12:old-key-0001', 'message', 'sms', '+4791000000', 'twilio', $2, 'transactional', 'sent', '[]', '{}', $3, 12, $4, 's', 'owner_route', '{"v":1,"request_fingerprint":"abc"}', now() + interval '400 days')`,
    [T, hash("6"), hash("7"), OWNER]
  );
  // FASE 2: oppgraderingen (141+)
  for (const f of all.filter((name) => Number(name.slice(0, 3)) >= UPGRADE_FROM)) await copyFile(join(MIGRATIONS, f), join(dir, f));
  applied = await runMigrations(admin, dir);
}, 300_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const scalar = async (sql: string, args: unknown[] = []): Promise<number> => ((await admin.query(sql, args)).rows[0] as { n: number }).n;
const asApp = <T2>(fn: (c: pg.PoolClient) => Promise<T2>): Promise<T2> => withMemoryTransaction(app, T, ["business", "personal", "project", "shared"], fn);

describe("oppgradering fra main (001-140) til 141+ med eksisterende data", () => {
  it("fase 2 anvender KUN de nye migrasjonene (nummer >= 141), i rekkefølge, og migratoren er idempotent (en andre kjøring gjør ingenting og ingen checksum er endret)", async () => {
    expect(applied.length).toBeGreaterThanOrEqual(2);
    expect(applied.every((f) => Number(f.slice(0, 3)) >= UPGRADE_FROM)).toBe(true);
    expect([...applied]).toEqual([...applied].sort());
    expect(applied[0]).toMatch(/^141_/);
    expect(await runMigrations(admin, dir)).toEqual([]);
    const plan = await planMigrations(admin, dir);
    expect(plan).toMatchObject({ pending: [], checksum_mismatches: [], missing_checksum: [], unknown_applied: [] });
  });

  it("eksisterende rader er uendret og nye kolonner har trygge verdier: avmeldinger har stop_seq NULL og ingen angre-felt; journalen har content_hash_version 1 (usaltet)", async () => {
    expect(await scalar("SELECT count(*)::int AS n FROM comms_recipient_opt_outs WHERE tenant_id = $1", [T])).toBe(5);
    expect(await scalar("SELECT count(*)::int AS n FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND stop_seq IS NULL AND lift_reason IS NULL AND lifted_by_person_id IS NULL", [T])).toBe(5);
    expect(await scalar("SELECT count(*)::int AS n FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND status = 'lifted' AND lifted_by = 'inbound_start_keyword'", [T])).toBe(1);
    const journal = (await admin.query("SELECT content_hash_version, content_sha256, before_state FROM comms_outbound_log WHERE log_id = 'clog-old-0001'")).rows[0] as { content_hash_version: number; content_sha256: string; before_state: { v: number } };
    expect(journal).toMatchObject({ content_hash_version: 1, content_sha256: "7".repeat(64), before_state: { v: 1 } });
  });

  it("rom-CHECK: den forblir NOT VALID kun der en gammel rad bryter den (opt-outs med `health`), er fullt gyldig ellers, og ENHVER ny rad med health/home/guest avvises i ALLE sju tabeller", async () => {
    const state = (await admin.query("SELECT conrelid::regclass::text AS tbl, convalidated FROM pg_constraint WHERE conname LIKE 'comms\\_%\\_memory\\_space\\_id\\_check' ORDER BY 1")).rows as Array<{ tbl: string; convalidated: boolean }>;
    expect(state.map((r) => r.tbl)).toEqual(["comms_authorized_accounts", "comms_inbound_events", "comms_inbound_receipts", "comms_meeting_commitments", "comms_meeting_participants", "comms_meetings", "comms_outbound_log", "comms_recipient_opt_outs"]);
    for (const r of state) expect(r.convalidated, r.tbl).toBe(r.tbl !== "comms_recipient_opt_outs");
    const defs = (await admin.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname LIKE 'comms\\_%\\_memory\\_space\\_id\\_check'")).rows as Array<{ def: string }>;
    for (const d of defs) {
      for (const bad of ["health", "home", "guest"]) expect(d.def, d.def).not.toContain(`'${bad}'`);
      for (const ok of ["personal", "business", "project", "shared"]) expect(d.def, d.def).toContain(`'${ok}'`);
    }
    for (const space of ["health", "home", "guest"]) {
      await expect(admin.query(`INSERT INTO comms_authorized_accounts (tenant_id, account_id, memory_space_id, channel, account_ref, provider, source) VALUES ($1, $2, $3, 'sms', '+4799000001', 'twilio', 'tool')`, [T, `acct-new-${space}`, space]), space).rejects.toMatchObject({ code: "23514" });
      await expect(admin.query(`INSERT INTO comms_recipient_opt_outs (tenant_id, opt_out_id, memory_space_id, channel, recipient_hash, source) VALUES ($1, $2, $3, 'sms', $4, 'owner_recorded')`, [T, `optout-new-${space}-x`, space, "9".repeat(64)]), `opt-out ${space}`).rejects.toMatchObject({ code: "23514" });
      await expect(admin.query(`INSERT INTO comms_inbound_receipts (tenant_id, memory_space_id, provider, event_key, kind, recv_seq, retention_until, source, ingest_id) VALUES ($1, $2, 'twilio', $3, 'opt_in', 1, now(), 'webhook:twilio', 'ingest-up-0001')`, [T, space, `k-${space}`]), `receipt ${space}`).rejects.toMatchObject({ code: "23514" });
      await expect(admin.query(
        `INSERT INTO comms_outbound_log (tenant_id, log_id, memory_space_id, request_id, kind, channel, account_ref, provider, recipient_hash, purpose, status, rule_evaluation, recipient_proof, person_id, session_id, source, retention_until)
         VALUES ($1, $2, $3, $4, 'message', 'sms', '+4791000000', 'twilio', $5, 'transactional', 'denied', '[]', '{}', $6, 's', 'owner_route', now())`, [T, `clog-new-${space}-x`, space, `req-new-${space}-x`, "9".repeat(64), OWNER]), `journal ${space}`).rejects.toMatchObject({ code: "23514" });
    }
    // lovlige rom virker for nye rader
    for (const [i, space] of ["personal", "business", "project", "shared"].entries()) {
      await admin.query(`INSERT INTO comms_authorized_accounts (tenant_id, account_id, memory_space_id, channel, account_ref, provider, source) VALUES ($1, $2, $3, 'sms', $4, 'twilio', 'tool')`, [T, `acct-ok-${space}-x`, space, `+4799000010${i}`]);
    }
  });

  it("triggeren virker for GAMLE rader som app-rolle: START kan løfte et gammelt stopp-ord (stop_seq NULL), men aldri en gammel eierregistrert eller mottakerbedt avmelding", async () => {
    const lift = (id: string) => asApp((c) => c.query("UPDATE comms_recipient_opt_outs SET status = 'lifted', lifted_at = now(), lifted_by = 'inbound_start_keyword' WHERE tenant_id = $1 AND opt_out_id = $2", [T, id]));
    await expect(lift("optout-old-owner-001")).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("start_cannot_lift_owner_recorded") });
    await expect(lift("optout-old-request-1")).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("start_cannot_lift_recipient_request") });
    await expect(lift("optout-old-keyword-1")).resolves.toBeDefined();
    // eierens angre av den gamle eierregistrerte raden går gjennom triggeren med begrunnelse
    await expect(asApp((c) => c.query("UPDATE comms_recipient_opt_outs SET status = 'lifted', lifted_at = now(), lifted_by = 'owner_undo', lift_reason = 'Feilregistrert i main-tiden', lifted_by_person_id = $3, lift_session_id = 's' WHERE tenant_id = $1 AND opt_out_id = $2", [T, "optout-old-owner-001", OWNER]))).resolves.toBeDefined();
  });

  it("DELETE-vern og sekvens for appen etter oppgraderingen: gamle avmeldinger/journalrader kan ikke slettes; `comms_event_seq` er brukbar og strengt økende; første-mottak-tabellen har FORCE RLS", async () => {
    await expect(asApp((c) => c.query("DELETE FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = 'optout-old-request-1'", [T]))).rejects.toMatchObject({ code: "23514" });
    await expect(asApp((c) => c.query("DELETE FROM comms_outbound_log WHERE tenant_id = $1 AND log_id = 'clog-old-0001'", [T]))).rejects.toMatchObject({ code: "23514" });
    const seqs = await asApp(async (c) => [Number((await c.query("SELECT nextval('comms_event_seq')::text AS s")).rows[0].s), Number((await c.query("SELECT nextval('comms_event_seq')::text AS s")).rows[0].s)]);
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
    const rls = (await admin.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'comms_inbound_receipts'")).rows[0] as { relrowsecurity: boolean; relforcerowsecurity: boolean };
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    // appen kan ikke endre/slette uten tenant-kontekst: ingen rader synlige
    expect((await app.query("SELECT count(*)::int AS n FROM comms_inbound_receipts")).rows[0]).toEqual({ n: 0 });
  });
});
