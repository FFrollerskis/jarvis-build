import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AssistOutcome, SignalAssist } from "../src/assist.ts";
import { openingDetectionKey } from "../src/home-bridge.ts";
import { SituationSignalBus } from "../src/signal-bus.ts";
import { FeedbackService } from "../src/tuning.ts";
import type { VisionObservation } from "../src/vision-bridge.ts";
import { actorOwner, minutesAgo, NOW, OTHER, OWNER, startG4Db, TENANT_A, TENANT_B, type G4Db } from "./support/wpg4-db.ts";

/**
 * WP-G4 (D-466) FIKS-RUNDE, migrasjon 139 mot en EKTE Postgres med en NOSUPERUSER/NOBYPASSRLS-rolle (samme rolle som applikasjonen).
 *
 * Reviewer B (testhull som mutantene overlevde): applikasjonstestene bruker alltid eksplisitt `tenant_id = $1`, så en RLS-policy `USING (true)` på `situation_subscriptions`/`situation_signal_log` (M05a/M05b) ble aldri oppdaget,
 * heller ikke en facts-grense på 20 MB i stedet for 2048 B (M05e) eller en UPDATE-rettighet på den påståtte append-only-loggen (M05f). Alle fem tabellene testes her med DIREKTE SQL under app-rollen, UTEN tenant-filter.
 * Regel 4 (A-INFO/B-INFO-11): signalloggen og vurderingene bærer nå PERSONEN (abonnementets eier), tuning-raden bærer task_id/session_id. A-LOW-10: samtidig tuning gir nøyaktig ÉN endring og ÉN revisjonsrad.
 */
let db: G4Db;

/** Kjører `fn` i en transaksjon som app-rollen med nøyaktig de RLS-innstillingene som gis (`null` = ikke satt), og ruller alltid tilbake. */
async function asApp<T>(tenant: string | null, spaces: string | null, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.appPool.connect();
  try {
    await client.query("BEGIN");
    if (tenant !== null) await client.query("SELECT set_config('jarvis.tenant_id', $1, true)", [tenant]);
    if (spaces !== null) await client.query("SELECT set_config('jarvis.memory_spaces', $1, true)", [spaces]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
/** SQLSTATE for en setning som skal feile (hver feilende setning i sin egen transaksjon: Postgres avbryter transaksjonen ved feil). */
async function sqlState(tenant: string | null, spaces: string | null, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await asApp(tenant, spaces, (c) => c.query(sql, params));
  } catch (err) {
    return (err as { code?: string }).code ?? "ukjent";
  }
  return "ok";
}
async function adminState(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await db.adminPool.query(sql, params);
  } catch (err) {
    return (err as { code?: string }).code ?? "ukjent";
  }
  return "ok";
}

const TABLES = ["situation_subscriptions", "situation_signal_log", "situation_feedback", "situation_rule_tuning", "situation_assessments"] as const;
type Table = (typeof TABLES)[number];

/** (tenant, rom) som seedes med ÉN rad i hver av de fem tabellene. */
const SCOPES: Array<{ tenant: string; space: "home" | "personal" }> = [
  { tenant: TENANT_A, space: "home" }, { tenant: TENANT_A, space: "personal" }, { tenant: TENANT_B, space: "home" }
];
const sitIds = new Map<string, string>();
const scopeKey = (tenant: string, space: string): string => `${tenant}|${space}`;

/** INSERT-setning (parametrisert på tenant, rom og unik tag) for en gyldig rad i tabellen, med gyldig FK-mål for situasjonen. Tuning har fast nøkkel (PK): en ny rad for samme (tenant, rom) er et unik-brudd, ikke et RLS-brudd. */
function insertSql(table: Table): string {
  switch (table) {
    case "situation_subscriptions":
      return `INSERT INTO situation_subscriptions (subscription_id, tenant_id, memory_space_id, source, event_type, domain, filter, filter_digest, created_by_person_id)
              VALUES ('sub-' || $3::text, $1, $2, 'home_assistant', 'door_open_too_long', 'home', '{}'::jsonb, md5('s' || $3::text) || md5('t' || $3::text), '${OWNER}')`;
    case "situation_signal_log":
      return `INSERT INTO situation_signal_log (signal_id, tenant_id, memory_space_id, source, event_type, domain, source_ref, detection_key, situation_id, occurred_at, outcome, stage_after, priority, notified, facts, person_id)
              VALUES ('sig-' || $3::text, $1, $2, 'home_assistant', 'door_open_too_long', 'home', 'ref-' || $3::text, 'home:opening:' || $3::text, $4, now(), 'created', 'inform', 'normal', false, '{}'::jsonb, '${OWNER}')`;
    case "situation_feedback":
      return `INSERT INTO situation_feedback (feedback_id, tenant_id, memory_space_id, situation_id, rule_key, verdict, actor_person_id)
              VALUES ('fb-' || $3::text, $1, $2, $4, 'home_assistant:door_open_too_long', 'noise', '${OWNER}')`;
    case "situation_rule_tuning":
      return `INSERT INTO situation_rule_tuning (tenant_id, memory_space_id, rule_key, threshold, reason, updated_by_person_id)
              VALUES ($1, $2, 'home_assistant:door_open_too_long', 20, 'test ' || $3::text, '${OWNER}')`;
    case "situation_assessments":
      return `INSERT INTO situation_assessments (assessment_id, tenant_id, memory_space_id, situation_id, input_digest, status, person_id)
              VALUES ('asm-' || $3::text, $1, $2, $4, md5('a' || $3::text) || md5('b' || $3::text), 'applied', '${OWNER}')`;
  }
}
/** Parametre til `insertSql(table)`: tenant, rom, tag og (kun for tabellene som peker på en situasjon) situasjons-id. */
const insertParams = (table: Table, tenant: string, space: string, tag: string): string[] =>
  table === "situation_subscriptions" || table === "situation_rule_tuning" ? [tenant, space, tag] : [tenant, space, tag, sitIds.get(scopeKey(tenant, space)) ?? ""];

/** Setter inn en gyldig rad via admin (omgår RLS) - seeding. */
async function seedRow(table: Table, tenant: string, space: string, tag: string): Promise<void> {
  await db.adminPool.query(insertSql(table), insertParams(table, tenant, space, tag));
}

async function seedAll(): Promise<void> {
  sitIds.clear();
  for (const { tenant, space } of SCOPES) {
    await db.engine.evaluateCandidate(tenant, space, { domain: "home", detection_key: `home:opening:${tenant}-${space}`, priority: "normal", reason: "r" }, NOW);
    const row = await db.adminPool.query(`SELECT situation_id FROM situations WHERE tenant_id = $1 AND memory_space_id = $2`, [tenant, space]);
    sitIds.set(scopeKey(tenant, space), row.rows[0].situation_id as string);
    for (const table of TABLES) await seedRow(table, tenant, space, `${tenant}-${space}`);
  }
}

/** Direkte lesing UTEN tenant-/rom-filter under app-rollen: RLS alene avgjør hva som er synlig. */
async function visible(tenant: string | null, spaces: string | null, table: Table): Promise<string[]> {
  const rows = (await asApp(tenant, spaces, (c) => c.query(`SELECT tenant_id, memory_space_id FROM ${table} ORDER BY tenant_id, memory_space_id`))).rows as Array<{ tenant_id: string; memory_space_id: string }>;
  return rows.map((r) => `${r.tenant_id}|${r.memory_space_id}`);
}

/** `count` ulike dør-situasjoner gjennom den EKTE bussen (ulik `last_changed` = ulik hendelsesnøkkel; åpne 16+ min = over standardterskelen på 15). Krever et dørabonnement. */
async function seedDoors(count: number): Promise<string[]> {
  const bus = new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), now: () => NOW });
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const minutes = 16 + i;
    const out = await bus.publishBatch(TENANT_A, "home", [{ source: "home_assistant", entity_id: "binary_sensor.inngang", role: "door", state: "on", last_changed: minutesAgo(minutes) }]);
    expect(out.evaluated, `dør ${i}`).toBe(1);
    const row = await db.engine.findByDetectionKey(TENANT_A, "home", openingDetectionKey("binary_sensor.inngang", Date.parse(minutesAgo(minutes))));
    ids.push(row!.situation_id);
  }
  return ids;
}

beforeAll(async () => { db = await startG4Db("fixdb"); }, 240_000);
beforeEach(async () => { await db.reset(); await seedAll(); });
afterAll(async () => { await db?.stop(); }, 120_000);

describe("M05a/M05b: RLS (FORCE) på alle fem G4-tabellene, målt med direkte SQL UTEN tenant-/rom-filter", () => {
  it.each(TABLES)("%s: lesing ser kun egen tenant og egne rom; ingen innstilling = ingenting (fail-closed)", async (table) => {
    expect(await visible(TENANT_A, "home,personal", table)).toEqual([`${TENANT_A}|home`, `${TENANT_A}|personal`]); // tenant-policyen: B sin rad er skjult
    expect(await visible(TENANT_A, "home", table)).toEqual([`${TENANT_A}|home`]); // rom-policyen (RESTRICTIVE): personal er skjult
    expect(await visible(TENANT_A, "personal", table)).toEqual([`${TENANT_A}|personal`]);
    expect(await visible(TENANT_B, "home", table)).toEqual([`${TENANT_B}|home`]);
    expect(await visible(TENANT_B, "personal", table)).toEqual([]); // B har ingen rad i personal
    expect(await visible(TENANT_A, "business", table)).toEqual([]); // et rom uten rader
    expect(await visible(null, null, table)).toEqual([]);
    expect(await visible(TENANT_A, null, table)).toEqual([]); // tenant uten rom
    expect(await visible(null, "home,personal", table)).toEqual([]); // rom uten tenant
    expect(await visible("tenant-finnes-ikke", "home,personal", table)).toEqual([]);
    // adminrollen (eier av tabellen, omgår ikke FORCE-løst) bekrefter at alle tre radene faktisk finnes: testen måler RLS, ikke tomme tabeller
    expect((await db.adminPool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(3);
  });

  it.each(TABLES)("%s: skriving utenfor egen tenant/eget rom nektes av RLS (WITH CHECK, 42501), og DELETE rører kun egne rader", async (table) => {
    // en rad for TENANT_B under TENANT_A sin innstilling (gyldig FK-mål: B sin situasjon) nektes
    expect(await sqlState(TENANT_A, "home,personal", insertSql(table), insertParams(table, TENANT_B, "home", "skriv-b"))).toBe("42501");
    // et rom utenfor innstillingen nektes
    expect(await sqlState(TENANT_A, "home", insertSql(table), insertParams(table, TENANT_A, "personal", "skriv-personal"))).toBe("42501");
    // uten innstilling nektes alt
    expect(await sqlState(null, null, insertSql(table), insertParams(table, TENANT_A, "home", "skriv-ingen"))).toBe("42501");
    // positiv kontroll: egen tenant og eget rom er tillatt (en ny unik rad; for tuning er nøkkelen allerede tatt -> unik-brudd 23505, ikke RLS)
    const own = await sqlState(TENANT_A, "home", insertSql(table), insertParams(table, TENANT_A, "home", "skriv-egen"));
    expect(own).toBe(table === "situation_rule_tuning" ? "23505" : "ok");
    // DELETE uten WHERE rører bare synlige rader
    const deleted = await asApp(TENANT_A, "home", (c) => c.query(`DELETE FROM ${table}`));
    expect(deleted.rowCount).toBe(1);
    const deletedAll = await asApp(null, null, (c) => c.query(`DELETE FROM ${table}`));
    expect(deletedAll.rowCount).toBe(0);
    expect((await db.adminPool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(3); // alt ble rullet tilbake: ingen sidevirkning mellom kontrollene
  });
});

describe("M05e: facts-størrelsen er begrenset til 2048 B i selve databasen (minimeringen kan ikke omgås)", () => {
  const insertWithFacts = (facts: string): Promise<string> =>
    adminState(
      `INSERT INTO situation_signal_log (signal_id, tenant_id, memory_space_id, source, event_type, domain, source_ref, detection_key, situation_id, occurred_at, outcome, stage_after, priority, notified, facts, person_id)
       VALUES ('sig-facts', $1, 'home', 'home_assistant', 'door_open_too_long', 'home', 'ref-facts', 'home:opening:facts', $2, now(), 'created', 'inform', 'normal', false, $3::jsonb, '${OWNER}')`,
      [TENANT_A, sitIds.get(scopeKey(TENANT_A, "home")), facts]
    );

  it("en facts-verdi over 2048 B (selv 5000 B) avvises (23514); en liten og en nær grensen godtas; ikke-objekter avvises", async () => {
    expect(await insertWithFacts(JSON.stringify({ blob: "x".repeat(5_000) }))).toBe("23514");
    expect(await insertWithFacts(JSON.stringify({ blob: "x".repeat(2_100) }))).toBe("23514");
    expect(await insertWithFacts(JSON.stringify({ liste: [1, 2, 3] }))).toBe("ok"); // et lite objekt godtas
    await db.adminPool.query(`DELETE FROM situation_signal_log WHERE signal_id = 'sig-facts'`);
    expect(await insertWithFacts(JSON.stringify({ blob: "x".repeat(1_900) }))).toBe("ok"); // nær grensen, men under
    await db.adminPool.query(`DELETE FROM situation_signal_log WHERE signal_id = 'sig-facts'`);
    expect(await insertWithFacts(JSON.stringify([1, 2, 3]))).toBe("23514"); // et array er ikke et objekt
    expect(await insertWithFacts(JSON.stringify("tekst"))).toBe("23514");
  });
});

describe("M05f: uforanderlighet håndheves av databasens rettigheter, ikke bare av koden", () => {
  it("signalloggen og vurderingene kan ikke oppdateres av app-rollen (42501), men kan slettes (retensjon); tabellene har ingen UPDATE-rettighet", async () => {
    expect(await sqlState(TENANT_A, "home", `UPDATE situation_signal_log SET notified = true`)).toBe("42501");
    expect(await sqlState(TENANT_A, "home", `UPDATE situation_signal_log SET facts = '{}'::jsonb`)).toBe("42501");
    expect(await sqlState(TENANT_A, "home", `UPDATE situation_signal_log SET person_id = '${OTHER}'`)).toBe("42501");
    expect(await sqlState(TENANT_A, "home", `UPDATE situation_assessments SET status = 'rejected'`)).toBe("42501");
    expect(await sqlState(TENANT_A, "home", `UPDATE situation_assessments SET explanation = 'omskrevet'`)).toBe("42501");
    // samme sak målt i rettighetskatalogen for den faktiske app-rollen: ingen tabell-UPDATE på noen av de tre append-only-tabellene, og kolonne-UPDATE kun der det er ment
    const role = (await asApp(null, null, (c) => c.query("SELECT current_user AS u"))).rows[0].u as string;
    const priv = async (fn: "has_table_privilege" | "has_any_column_privilege", table: string): Promise<boolean> =>
      (await db.adminPool.query(`SELECT ${fn}($1, $2, 'UPDATE') AS u`, [role, table])).rows[0].u as boolean;
    for (const table of ["situation_signal_log", "situation_assessments", "situation_feedback", "situation_subscriptions"]) expect(await priv("has_table_privilege", table), `${table} tabell-UPDATE`).toBe(false);
    expect(await priv("has_any_column_privilege", "situation_signal_log")).toBe(false);
    expect(await priv("has_any_column_privilege", "situation_assessments")).toBe(false);
    expect(await priv("has_any_column_privilege", "situation_feedback")).toBe(true); // consumed_at
    expect(await priv("has_any_column_privilege", "situation_subscriptions")).toBe(true); // enabled, updated_at
    const del = await asApp(TENANT_A, "home", (c) => c.query(`DELETE FROM situation_signal_log`));
    expect(del.rowCount).toBe(1);
  });

  it("tilbakemeldingen: kun `consumed_at` kan endres (kolonne-GRANT); stemmen (verdict) og eieren kan aldri omskrives", async () => {
    expect(await sqlState(TENANT_A, "home", `UPDATE situation_feedback SET verdict = 'useful'`)).toBe("42501");
    expect(await sqlState(TENANT_A, "home", `UPDATE situation_feedback SET actor_person_id = '${OTHER}'`)).toBe("42501");
    expect(await sqlState(TENANT_A, "home", `UPDATE situation_feedback SET rule_key = 'home_assistant:water_leak'`)).toBe("42501");
    const consumed = await asApp(TENANT_A, "home", (c) => c.query(`UPDATE situation_feedback SET consumed_at = now()`));
    expect(consumed.rowCount).toBe(1);
  });

  it("abonnementet (B-INFO-11): kun av/på (`enabled`, `updated_at`) kan endres; kilde, type, filter, eier, rom og tenant kan ALDRI omskrives på en eksisterende rad", async () => {
    for (const set of [
      `source = 'vision'`, `event_type = 'water_leak'`, `domain = 'vision'`, `filter = '{"x":1}'::jsonb`, `filter_digest = repeat('c', 64)`,
      `created_by_person_id = '${OTHER}'`, `memory_space_id = 'personal'`, `tenant_id = '${TENANT_B}'`, `subscription_id = 'sub-nytt'`, `task_id = 't'`, `session_id = 's'`, `created_at = now()`
    ]) {
      expect(await sqlState(TENANT_A, "home", `UPDATE situation_subscriptions SET ${set}`), set).toBe("42501");
    }
    const toggled = await asApp(TENANT_A, "home", (c) => c.query(`UPDATE situation_subscriptions SET enabled = false, updated_at = now()`));
    expect(toggled.rowCount).toBe(1);
    const del = await asApp(TENANT_A, "home", (c) => c.query(`DELETE FROM situation_subscriptions`));
    expect(del.rowCount).toBe(1);
  });

  it("regeltuningen kan oppdateres av app-rollen (upsert fra tilbakemeldingen), men en gyldig terskel er begrenset av CHECK", async () => {
    const ok = await asApp(TENANT_A, "home", (c) => c.query(`UPDATE situation_rule_tuning SET threshold = 25`));
    expect(ok.rowCount).toBe(1);
    expect(await sqlState(TENANT_A, "home", `UPDATE situation_rule_tuning SET threshold = 0`)).toBe("23514");
    expect(await sqlState(TENANT_A, "home", `UPDATE situation_rule_tuning SET threshold = 100001`)).toBe("23514");
  });
});

describe("Regel 4 (A-INFO/B-INFO-11): personen er merket på signalloggen og vurderingene (NOT NULL + FK mot personen i tenanten); tuning-raden bærer task_id/session_id", () => {
  it("person_id er påkrevd, må være en person i SAMME tenant (sammensatt FK), og tabellene har kolonnene", async () => {
    const sit = sitIds.get(scopeKey(TENANT_A, "home"))!;
    const logSql = (person: string | null, tenant: string, situation: string): [string, unknown[]] => [
      `INSERT INTO situation_signal_log (signal_id, tenant_id, memory_space_id, source, event_type, domain, source_ref, detection_key, situation_id, occurred_at, outcome, stage_after, priority, notified, facts, person_id)
       VALUES ('sig-p', $1, 'home', 'home_assistant', 'door_open_too_long', 'home', 'ref-p', 'home:opening:p', $2, now(), 'created', 'inform', 'normal', false, '{}'::jsonb, $3)`,
      [tenant, situation, person]
    ];
    expect(await adminState(...logSql(null, TENANT_A, sit))).toBe("23502"); // NOT NULL
    expect(await adminState(...logSql("person-finnes-ikke", TENANT_A, sit))).toBe("23503"); // FK mot people
    expect(await adminState(...logSql(OTHER, TENANT_B, sitIds.get(scopeKey(TENANT_B, "home"))!))).toBe("23503"); // OTHER er ikke medlem av tenant B (sammensatt FK)
    expect(await adminState(...logSql(OTHER, TENANT_A, sit))).toBe("ok"); // OTHER er medlem av tenant A
    const asm = (person: string | null, tenant: string, situation: string): [string, unknown[]] => [
      `INSERT INTO situation_assessments (assessment_id, tenant_id, memory_space_id, situation_id, input_digest, status, person_id) VALUES ('asm-p', $1, 'home', $2, repeat('d', 64), 'applied', $3)`,
      [tenant, situation, person]
    ];
    expect(await adminState(...asm(null, TENANT_A, sit))).toBe("23502");
    expect(await adminState(...asm("person-finnes-ikke", TENANT_A, sit))).toBe("23503");
    expect(await adminState(...asm(OTHER, TENANT_B, sitIds.get(scopeKey(TENANT_B, "home"))!))).toBe("23503");
    expect(await adminState(...asm(OTHER, TENANT_A, sit))).toBe("ok");
    const cols = (await db.adminPool.query(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_name IN ('situation_signal_log', 'situation_assessments', 'situation_rule_tuning') AND column_name IN ('person_id', 'task_id', 'session_id') ORDER BY table_name, column_name`
    )).rows;
    expect(cols).toEqual([
      { table_name: "situation_assessments", column_name: "person_id", is_nullable: "NO" },
      { table_name: "situation_assessments", column_name: "session_id", is_nullable: "YES" },
      { table_name: "situation_assessments", column_name: "task_id", is_nullable: "YES" },
      { table_name: "situation_rule_tuning", column_name: "session_id", is_nullable: "YES" },
      { table_name: "situation_rule_tuning", column_name: "task_id", is_nullable: "YES" },
      { table_name: "situation_signal_log", column_name: "person_id", is_nullable: "NO" },
      { table_name: "situation_signal_log", column_name: "session_id", is_nullable: "YES" },
      { table_name: "situation_signal_log", column_name: "task_id", is_nullable: "YES" }
    ]);
  });

  const camera = (over: Partial<VisionObservation> = {}): VisionObservation => ({
    source: "vision", observation_id: "obs-p", event_type: "person_present", source_instance_id: "camera.inngang", source_event_id: `binary_sensor.person@${minutesAgo(1)}`,
    observed_at: minutesAgo(1), object_label: null, classification_status: "classified", ...over
  });
  const UPLIFT: AssistOutcome = { status: "assessed", assessment: { category: "attention", priority_hint: "normal", explanation: "Trenger oppmerksomhet", provider: "local_llm", model: "test" } };
  const assist: SignalAssist = { assess: async () => UPLIFT };

  it("bussen merker signalloggraden OG modellvurderingen med abonnementets eier (ikke en fast verdi, ikke den som kjører tikket), sammen med task_id/session_id", async () => {
    await db.reset();
    // abonnement eid av OTHER (medlem av tenant A) satt inn direkte: registeret tillater bare den sovereigne eieren
    await db.adminPool.query(
      `INSERT INTO situation_subscriptions (subscription_id, tenant_id, memory_space_id, source, event_type, domain, filter, filter_digest, created_by_person_id)
       VALUES ('sub-other', $1, 'home', 'vision', 'person_present', 'home', '{}'::jsonb, repeat('e', 64), $2)`,
      [TENANT_A, OTHER]
    );
    const bus = new SituationSignalBus({ pool: db.appPool, engine: db.engine, domainPauses: db.domainPauses, subscriptions: (t, s) => db.registry.listEnabled(t, s), assist, now: () => NOW });
    const out = await bus.publishBatch(TENANT_A, "home", [camera()], { assistBudget: { remaining: 2 }, task_id: "task-p", session_id: "sess-p" });
    expect(out).toMatchObject({ evaluated: 1, failed: 0 });
    expect(out.assist).toMatchObject({ assessed: 1 });
    const log = (await db.adminPool.query(`SELECT person_id, task_id, session_id, subscription_id FROM situation_signal_log`)).rows;
    expect(log).toEqual([{ person_id: OTHER, task_id: "task-p", session_id: "sess-p", subscription_id: "sub-other" }]);
    const asm = (await db.adminPool.query(`SELECT person_id, task_id, session_id, status FROM situation_assessments`)).rows;
    expect(asm).toEqual([{ person_id: OTHER, task_id: "task-p", session_id: "sess-p", status: "applied" }]);

    // et abonnement eid av eieren gir eieren
    await db.reset();
    await db.registry.subscribe(TENANT_A, "home", { source: "vision", event_type: "person_present", filter: {} }, actorOwner);
    await bus.publishBatch(TENANT_A, "home", [camera({ observation_id: "obs-p2" })], { assistBudget: { remaining: 2 }, task_id: "task-q", session_id: "sess-q" });
    expect((await db.adminPool.query(`SELECT person_id FROM situation_signal_log`)).rows).toEqual([{ person_id: OWNER }]);
    expect((await db.adminPool.query(`SELECT person_id FROM situation_assessments`)).rows).toEqual([{ person_id: OWNER }]);
  });

  it("tuning-raden bærer task_id/session_id fra aktøren som utløste endringen (og nullstilles ikke til null ved neste endring uten dem)", async () => {
    await db.reset();
    await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.inngang", role: "door" }] } }, actorOwner);
    const ids = await seedDoors(6);
    let clock = NOW;
    const feedback = new FeedbackService(db.appPool, { owner_person_id: OWNER }, true, () => clock);
    for (const id of ids.slice(0, 3)) { clock += 60_000; await feedback.submit(TENANT_A, "home", id, "noise", { person_id: OWNER, session_id: "sess-t", task_id: "task-t" }); }
    const tuned = (await db.adminPool.query(`SELECT threshold::float8 AS threshold, updated_by_person_id, task_id, session_id FROM situation_rule_tuning`)).rows;
    expect(tuned).toEqual([{ threshold: 20, updated_by_person_id: OWNER, task_id: "task-t", session_id: "sess-t" }]);
    // neste steg (utenfor nedkjølingen) uten task/session: kolonnene følger den siste endringen (null), ikke en gammel verdi
    clock += 25 * 3_600_000;
    for (const id of ids.slice(3, 6)) { clock += 60_000; await feedback.submit(TENANT_A, "home", id, "noise", { person_id: OWNER }); }
    expect((await db.adminPool.query(`SELECT threshold::float8 AS threshold, task_id, session_id FROM situation_rule_tuning`)).rows).toEqual([{ threshold: 25, task_id: null, session_id: null }]);
  });
});

describe("B-LOW-10: indekser på (tenant, rom, situasjon) for signalloggen og tilbakemeldingen", () => {
  it("begge indeksene finnes med riktige kolonner i riktig rekkefølge (oppslag per situasjon uten full gjennomgang)", async () => {
    const rows = (await db.adminPool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('situation_signal_log', 'situation_feedback') AND indexname LIKE '%situation_idx' ORDER BY indexname`
    )).rows as Array<{ indexname: string; indexdef: string }>;
    expect(rows.map((r) => r.indexname)).toEqual(["situation_feedback_situation_idx", "situation_signal_log_situation_idx"]);
    for (const r of rows) expect(r.indexdef).toMatch(/\(tenant_id, memory_space_id, situation_id\)$/);
  });
});

describe("A-LOW-10: samtidig tuning gir nøyaktig ÉN endring og ÉN revisjonsrad (advisory-lås per regel)", () => {
  it("30 samtidige «støy»-stemmer på samme regel: terskelen går ETT steg (15 -> 20), ÉN `situation.rule_tuned`-rad, alle stemmer lagret; en annen regel/tenant påvirkes ikke", async () => {
    await db.reset();
    await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.inngang", role: "door" }] } }, actorOwner);
    const ids = await seedDoors(30);
    expect(new Set(ids).size).toBe(30);
    const baseline = Number((await db.adminPool.query(`SELECT coalesce(max(audit_id), 0)::text AS id FROM audit_events`)).rows[0].id);
    const feedback = new FeedbackService(db.appPool, { owner_person_id: OWNER }, true, () => NOW + 60_000);
    const results = await Promise.all(ids.map((id) => feedback.submit(TENANT_A, "home", id, "noise", { person_id: OWNER, session_id: "sess-k" })));
    expect(results.filter((r) => r.tuning.action === "relax")).toHaveLength(1);
    expect(results.filter((r) => r.tuning.action === "none").length).toBe(29);
    expect((await db.adminPool.query(`SELECT count(*)::int AS n FROM situation_feedback`)).rows[0].n).toBe(30);
    const audits = (await db.adminPool.query(`SELECT decision, payload FROM audit_events WHERE audit_id > $1 AND type = 'situation.rule_tuned'`, [baseline])).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ decision: "relax", payload: { rule_key: "home_assistant:door_open_too_long", from: 15, to: 20 } });
    expect((await db.adminPool.query(`SELECT threshold::float8 AS threshold FROM situation_rule_tuning`)).rows).toEqual([{ threshold: 20 }]);
    // de tre stemmene som utløste steget er brukt; resten (27) venter på nedkjølingen og er ubrukte
    expect((await db.adminPool.query(`SELECT count(*)::int AS n FROM situation_feedback WHERE consumed_at IS NOT NULL`)).rows[0].n).toBe(3);
  }, 120_000);

  it("deterministisk: `submit` og `resetTuning` for en regel VENTER på regelens lås (men en annen regel eller en annen tenant gjør det ikke)", async () => {
    await db.reset();
    await db.registry.subscribe(TENANT_A, "home", { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.inngang", role: "door" }] } }, actorOwner);
    const [id] = await seedDoors(1);
    const feedback = new FeedbackService(db.appPool, { owner_person_id: OWNER }, true, () => NOW);
    const holder = await db.adminPool.connect();
    const settled: string[] = [];
    try {
      await holder.query("BEGIN");
      // samme nøkkel og frø som `FeedbackService.lockRule` (regelens lås for (tenant A, home, dørregelen))
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340466))", [`situation-tuning|${TENANT_A}|home|home_assistant:door_open_too_long`]);
      const submit = feedback.submit(TENANT_A, "home", id!, "noise", actorOwner).then((r) => { settled.push("submit"); return r; });
      const reset = feedback.resetTuning(TENANT_A, "home", "home_assistant:door_open_too_long", actorOwner).then((r) => { settled.push("reset"); return r; });
      // uberørte: annen regel (samme tenant) og samme regel i en annen tenant går rett gjennom mens låsen holdes
      expect(await feedback.resetTuning(TENANT_A, "home", "home_assistant:water_leak", actorOwner)).toBe(false);
      expect(await feedback.resetTuning(TENANT_B, "home", "home_assistant:door_open_too_long", actorOwner)).toBe(false);
      await new Promise<void>((resolve) => { setTimeout(resolve, 500).unref(); });
      expect(settled).toEqual([]); // begge venter fortsatt på låsen
      await holder.query("COMMIT");
      const [s] = await Promise.all([submit, reset]);
      expect(s.rule_key).toBe("home_assistant:door_open_too_long");
      expect(settled.sort()).toEqual(["reset", "submit"]);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }, 60_000);
});
