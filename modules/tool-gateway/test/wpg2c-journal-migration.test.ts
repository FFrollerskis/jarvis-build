import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { G2_TENANT, startPersonalDb, type PersonalDb } from "./support/personal-db-harness.ts";

/**
 * WP-G2c (D-483): migrasjon 144 (`personal_action_journal`: `request_params`, `reconcile_attempts`, `reconciled_at`, `reconcile_basis`, `reconciled_state`) og den utvidede triggeren, mot EKTE Postgres. Triggerreglene fra 125 skal fortsatt
 * holde (uendret oppførsel), og avstemmingsreglene er håndhevet i databasen (ikke bare i appen): telleren +1 per forsøk og kun på `outcome_unknown`, avstemmingsfeltene endres bare sammen med telleren, `request_params` er uforanderlig,
 * en terminal rad kan ikke få endret noe, en `requested`-rad har aldri vært avstemt. Ugyldige overganger testes eksplisitt. (Triggere gjelder også superbrukeren: testene kjører som admin; at app-rollen lykkes med det lovlige er dekket i `wpg2c-reconcile-db`.)
 */
let db: PersonalDb;
beforeAll(async () => { db = await startPersonalDb("jarvis_test_g2c_mig"); }, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);

let n = 0;
const DIGEST = "a".repeat(64);
interface Seed { status?: string; attempts?: number; params?: unknown; completed?: boolean }

/** Setter inn en rad direkte (admin) med ønsket status/teller. En rad med teller > 0 får tidspunkt/begrunnelse som CHECK-en krever. */
async function seed(over: Seed = {}): Promise<string> {
  n += 1;
  const id = `pers-act-mig-${n}`;
  const status = over.status ?? "outcome_unknown";
  const attempts = over.attempts ?? 0;
  await db.adminPool.query(
    `INSERT INTO personal_action_journal
       (action_id, tenant_id, memory_space_id, domain, tool_id, action, risk_class, risk_direction, target_ref, idempotency_key, request_digest, status, actor_person_id, source, request_params, completed_at,
        reconcile_attempts, reconciled_at, reconcile_basis)
     VALUES ($1, $2, 'personal', 'home', 'home-assistant', 'critical_lock', 'D', 'reduces', 'lock.front_door', $3, $4, $5, 'person-g2-p-owner', 'owner_route', $6::jsonb, $7,
             $8::int, CASE WHEN $8::int > 0 THEN now() END, CASE WHEN $8::int > 0 THEN 'earlier_attempt' END)`,
    [id, G2_TENANT, `mig-key-${n}-abcdefgh`, DIGEST, status, over.params === undefined ? null : JSON.stringify(over.params), over.completed === false || status === "requested" ? null : new Date().toISOString(), attempts]
  );
  return id;
}

const row = async (id: string): Promise<Record<string, unknown>> => (await db.adminPool.query("SELECT * FROM personal_action_journal WHERE action_id = $1", [id])).rows[0] as Record<string, unknown>;
const update = (id: string, set: string, params: unknown[] = []): Promise<unknown> => db.adminPool.query(`UPDATE personal_action_journal SET ${set} WHERE action_id = $1`, [id, ...params]);
async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let error: { code?: string; message?: string; constraint?: string } | undefined;
  try { await promise; } catch (e) { error = e as typeof error; }
  expect(error, "forventet at databasen avviste endringen").toBeDefined();
  expect(error?.code).toBe("23514");
  expect(`${error?.message ?? ""} ${error?.constraint ?? ""}`).toMatch(pattern);
}
const ATTEMPT = "reconcile_attempts = reconcile_attempts + 1, reconciled_at = now(), reconcile_basis = 'observed_unusable', reconciled_state = '{\"state\":\"unavailable\"}'::jsonb";

describe("A: skjemaet", () => {
  it("de fem nye kolonnene finnes med riktige standarder: ingen avstemming = teller 0 og alt annet NULL", async () => {
    const cols = (await db.adminPool.query(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'personal_action_journal' AND column_name IN ('request_params','reconcile_attempts','reconciled_at','reconcile_basis','reconciled_state') ORDER BY column_name"
    )).rows as Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>;
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ["reconcile_attempts", "integer", "NO"], ["reconcile_basis", "text", "YES"], ["reconciled_at", "timestamp with time zone", "YES"], ["reconciled_state", "jsonb", "YES"], ["request_params", "jsonb", "YES"]
    ]);
    expect(cols.find((c) => c.column_name === "reconcile_attempts")?.column_default).toBe("0");
    const fresh = await row(await seed());
    expect(fresh).toMatchObject({ reconcile_attempts: 0, reconciled_at: null, reconcile_basis: null, reconciled_state: null, request_params: null });
  });
});

describe("B: lovlige avstemminger (og at 125-oppførselen er bevart)", () => {
  it("et forsøk på en `outcome_unknown`-rad: teller +1 med tidspunkt, begrunnelse og lest tilstand - raden forblir `outcome_unknown`; et nytt forsøk +1 igjen", async () => {
    const id = await seed();
    await update(id, ATTEMPT);
    expect(await row(id)).toMatchObject({ status: "outcome_unknown", reconcile_attempts: 1, reconcile_basis: "observed_unusable", reconciled_state: { state: "unavailable" } });
    await update(id, ATTEMPT);
    expect(await row(id)).toMatchObject({ reconcile_attempts: 2 });
  });

  it("`outcome_unknown -> applied|failed` MED avstemming (teller +1) er lovlig; samme overgang UTEN avstemming (replay-ferdigstilling som i 125) er også fortsatt lovlig", async () => {
    for (const status of ["applied", "failed"]) {
      const withReconcile = await seed();
      await update(withReconcile, `status = '${status}', completed_at = now(), ${ATTEMPT}`);
      expect(await row(withReconcile)).toMatchObject({ status, reconcile_attempts: 1 });
      const plain = await seed();
      await update(plain, `status = '${status}', completed_at = now()`);
      expect(await row(plain)).toMatchObject({ status, reconcile_attempts: 0, reconciled_at: null });
    }
  });

  it("en rad kan ha `request_params` fra INSERT (lagrede, validerte parametre), og de leses tilbake uendret", async () => {
    const id = await seed({ params: { entity: "lock.front_door", locked: true } });
    expect((await row(id))["request_params"]).toEqual({ entity: "lock.front_door", locked: true });
  });
});

describe("C: UGYLDIGE overganger avvises av databasen (trigger)", () => {
  it("telleren kan ikke gå bakover, hoppe over ett forsøk, endres uten å være `outcome_unknown`, eller stå uendret mens tidspunkt/begrunnelse/tilstand endres", async () => {
    const id = await seed({ attempts: 2 });
    await rejects(update(id, "reconcile_attempts = 1"), /invalid_reconcile/);
    await rejects(update(id, "reconcile_attempts = 0, reconciled_at = NULL, reconcile_basis = NULL"), /invalid_reconcile/);
    await rejects(update(id, "reconcile_attempts = reconcile_attempts + 2, reconciled_at = now(), reconcile_basis = 'x'"), /invalid_reconcile/);
    await rejects(update(id, "reconciled_at = now()"), /invalid_reconcile/);
    await rejects(update(id, "reconcile_basis = 'omskrevet_begrunnelse'"), /invalid_reconcile/);
    await rejects(update(id, "reconciled_state = '{\"state\":\"locked\"}'::jsonb"), /invalid_reconcile/);
    expect(await row(id)).toMatchObject({ reconcile_attempts: 2, reconcile_basis: "earlier_attempt" });
  });

  it("en `requested`-rad kan ikke avstemmes (teller +1) - verken via UPDATE (trigger) eller via INSERT med teller > 0 (CHECK)", async () => {
    const id = await seed({ status: "requested" });
    await rejects(update(id, ATTEMPT), /invalid_reconcile/);
    await expect(seed({ status: "requested", attempts: 1 })).rejects.toMatchObject({ code: "23514", constraint: "personal_action_journal_reconcile_not_before_unknown" });
  });

  it("en TERMINAL rad (applied/failed) kan ikke få endret noe av avstemmingsfeltene, telleren eller parameterne (terminal_status / immutable_column)", async () => {
    for (const status of ["applied", "failed"]) {
      const id = await seed({ status, attempts: 1, params: { entity: "lock.front_door", locked: true } });
      await rejects(update(id, ATTEMPT), /terminal_status/);
      await rejects(update(id, "reconcile_attempts = 0"), /terminal_status/);
      await rejects(update(id, "reconcile_basis = 'omskrevet'"), /terminal_status/);
      await rejects(update(id, "reconciled_at = now()"), /terminal_status/);
      await rejects(update(id, "reconciled_state = '{}'::jsonb"), /terminal_status/);
      await rejects(update(id, "request_params = '{\"entity\":\"lock.back_door\",\"locked\":false}'::jsonb"), /immutable_column/);
      expect(await row(id)).toMatchObject({ status, reconcile_attempts: 1, reconcile_basis: "earlier_attempt" });
    }
  });

  it("`request_params` er uforanderlig også på en åpen rad - både endring, tømming og første-gangs-setting etterpå (det som ble bedt om kan ikke omskrives)", async () => {
    const withParams = await seed({ params: { entity: "lock.front_door", locked: true } });
    await rejects(update(withParams, "request_params = '{\"entity\":\"lock.front_door\",\"locked\":false}'::jsonb"), /immutable_column/);
    await rejects(update(withParams, "request_params = NULL"), /immutable_column/);
    const without = await seed();
    await rejects(update(without, "request_params = '{\"entity\":\"lock.front_door\",\"locked\":true}'::jsonb"), /immutable_column/);
  });

  it("statusovergangene fra 125 er uendret: `outcome_unknown -> requested` og enhver endring av en terminal status avvises; kjernekolonnene er uforanderlige", async () => {
    const unknown = await seed();
    await rejects(update(unknown, "status = 'requested'"), /invalid_transition/);
    const done = await seed({ status: "applied" });
    await rejects(update(done, "status = 'outcome_unknown'"), /terminal_status/);
    await rejects(update(done, "status = 'failed'"), /terminal_status/);
    await rejects(update(unknown, "target_ref = 'lock.back_door'"), /immutable_column/);
    await rejects(update(unknown, "request_digest = '" + "b".repeat(64) + "'"), /immutable_column/);
    await rejects(update(unknown, "task_id = 'omskrevet'"), /immutable_column/);
  });
});

describe("D: CHECK-reglene (form og sammenheng)", () => {
  const bad = (set: string, constraint: string, id: Promise<string> = seed()): Promise<void> => id.then((rowId) => expect(update(rowId, set)).rejects.toMatchObject({ code: "23514", constraint }));

  it("begrunnelsen er en kort kode (liten bokstav først, [a-z0-9_:.-], maks 80): store bokstaver, mellomrom, norske tegn, tom og for lang avvises", async () => {
    for (const basis of ["Observed_unusable", "has space", "tegn_æøå", "", "1starts_with_digit", `a${"b".repeat(80)}`]) {
      await bad(`reconcile_attempts = reconcile_attempts + 1, reconciled_at = now(), reconcile_basis = '${basis}'`, "personal_action_journal_reconcile_basis_code");
    }
    const ok = await seed();
    await update(ok, `reconcile_attempts = reconcile_attempts + 1, reconciled_at = now(), reconcile_basis = 'a${"b".repeat(79)}'`);
    expect((await row(ok))["reconcile_attempts"]).toBe(1);
  });

  it("teller, tidspunkt og begrunnelse hører sammen: teller > 0 krever begge; teller 0 tillater ingen av dem; negativ teller avvises", async () => {
    await bad("reconcile_attempts = reconcile_attempts + 1, reconciled_at = now()", "personal_action_journal_reconcile_complete");
    await bad("reconcile_attempts = reconcile_attempts + 1, reconcile_basis = 'x'", "personal_action_journal_reconcile_complete");
    await expect(seed({ attempts: -1 })).rejects.toMatchObject({ code: "23514", constraint: "personal_action_journal_reconcile_attempts_nonneg" });
    await expect(db.adminPool.query(
      `INSERT INTO personal_action_journal (action_id, tenant_id, memory_space_id, domain, tool_id, action, risk_class, risk_direction, target_ref, idempotency_key, request_digest, status, actor_person_id, source, reconcile_basis)
       VALUES ('pers-act-mig-basis-only', $1, 'personal', 'home', 'home-assistant', 'critical_lock', 'D', 'reduces', 'lock.front_door', 'mig-key-basis-only-1', $2, 'outcome_unknown', 'person-g2-p-owner', 'owner_route', 'orphan_basis')`, [G2_TENANT, DIGEST]
    )).rejects.toMatchObject({ code: "23514", constraint: "personal_action_journal_reconcile_complete" });
  });

  it("`request_params` må være et objekt på maks 4000 byte; `reconciled_state` et objekt på maks 8000 byte", async () => {
    for (const params of [[1, 2], "streng", 7, false]) {
      await expect(seed({ params })).rejects.toMatchObject({ code: "23514", constraint: "personal_action_journal_request_params_shape" });
    }
    await expect(seed({ params: { entity: "x".repeat(4_100) } })).rejects.toMatchObject({ code: "23514", constraint: "personal_action_journal_request_params_shape" });
    const state = (extra: string): string => `reconcile_attempts = reconcile_attempts + 1, reconciled_at = now(), reconcile_basis = 'x', reconciled_state = ${extra}`;
    await bad(state("'[1]'::jsonb"), "personal_action_journal_reconcile_state_shape");
    await bad(state(`jsonb_build_object('k', repeat('x', 8100))`), "personal_action_journal_reconcile_state_shape");
    const okRow = await seed();
    await update(okRow, state(`jsonb_build_object('k', repeat('x', 3000))`));
    expect((await row(okRow))["reconcile_attempts"]).toBe(1);
  });
});
