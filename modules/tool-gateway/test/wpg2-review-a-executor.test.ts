import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  HOME_CRITICAL_OPS, HomeAssistantCriticalTransport, PersonalActionJournal, ToolGateway, actionRequestDigest, executePersonalAction, homeCriticalConfigFromEnv, homeCriticalToolDefinitions,
  personalActionIndex, type ClassDNotification, type PersonalActionExecutorDeps, type SecretProvider
} from "../src/index.ts";
import { FakeHomeAssistant } from "./support/fake-home-assistant.ts";
import { G2_TENANT, g2Owner, personalGateway, startPersonalDb, type PersonalDb } from "./support/personal-db-harness.ts";

/**
 * WP-G2 fiks-runde (review A): handlingseksekutoren og journalen gjennom EKTE embedded Postgres, ekte policy og klasse D-kjede.
 *  - MEDIUM-1 gjennom gatewayen: en lås som viser gammel tilstand i tre lesinger, og alarm med 30 s utgangsforsinkelse, ender `applied` (ikke falsk MISMATCH/`outcome_unknown`).
 *  - LOW-5: en samtidig forespørsel med samme nøkkel (taperen) gir det lagrede utfallet - aldri et databaseunntak, og skriver aldri en for tidlig `outcome_unknown` over en rad som snart blir `applied`.
 *  - LOW-6: journalens proveniens (task_id/session_id/trace_id/created_at, og completed_at etter terminal status) er uforanderlig.
 *  - LOW-8: et varsel som feiler ETTER handlingen lagres (`notified=false` + `notify_error`) - også for MISMATCH/UKJENT, der resultatet ikke bærer varslingsstatus.
 *  - LOW-10/11: to handlinger mot SAMME mål serialiseres (prosess-lokal lås per (domene, mål), fiks-runde 2: ingen databaseforbindelse holdes): den andre får `personal_action_target_busy` uten å røre utstyret.
 * Hver test feller den gamle koden (se mutasjonsbeviset i rapporten).
 */
let db: PersonalDb;
let ha: FakeHomeAssistant;
beforeAll(async () => { db = await startPersonalDb("jarvis_test_g2_rev_a_exec"); ha = new FakeHomeAssistant(); await ha.start(); }, 240_000);
afterAll(async () => { await ha?.stop(); await db?.stop(); }, 120_000);
beforeEach(() => ha.reset());

const owner: IdentityContext = { ...g2Owner, memory_space_id: "personal" };
let seq = 0;
const key = (p: string): string => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;
const secrets = (): SecretProvider => ({ name: "fake", get: async (ref) => (ref === "JARVIS_HA_TOKEN" ? ha.token : null) });
const TARGETS = "lock.front_door,cover.garage,alarm_control_panel.home";
const LOCK = { entity: "lock.front_door", locked: true } as Record<string, JsonValue>;
const input = (k: string, parameters: Record<string, JsonValue> = LOCK, action = "critical_lock") => ({ domain: "home", action, parameters, idempotency_key: k });

function build(gateway: ToolGateway, opts: { settleMs?: number; byDomain?: boolean } = {}) {
  let t = 0;
  const config = homeCriticalConfigFromEnv({ JARVIS_PERSONAL_HOME_TARGETS: TARGETS });
  const settleMs = opts.settleMs ?? 20_000;
  const transport = new HomeAssistantCriticalTransport({
    baseUrl: async () => ha.baseUrl, settleMs, pollMs: 1_000, ...(opts.byDomain !== false && config.settleMsByDomain ? { settleMsByDomain: config.settleMsByDomain } : {}), now: () => t, sleep: async (ms) => { t += ms; }
  });
  for (const d of homeCriticalToolDefinitions(transport, { ...config, settleMs, pollMs: 1_000 })) gateway.register(d);
  const journal = new PersonalActionJournal(db.appPool);
  const index = personalActionIndex(HOME_CRITICAL_OPS.map((op) => ({ domain: "home" as const, toolId: "home-assistant", op })));
  const executor: PersonalActionExecutorDeps = { pool: db.appPool, gateway, journal, index };
  return { journal, executor, index };
}

const standard = () => { const h = personalGateway(db.appPool, secrets()); return { ...h, ...build(h.gateway) }; };

/** En gateway der varsleren kaster ETTER handlingen (Telegram nede mens token og chat-id finnes). */
function failingNotifier() {
  const ks = new KillSwitch();
  const controls = new OwnerControls(ks);
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: ks, controls, authority: { owner_person_id: g2Owner.person_id, owner_tenants: [G2_TENANT] } });
  const attempts: ClassDNotification[] = [];
  const gateway = new ToolGateway(db.appPool, policy, secrets(), controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (n) => { attempts.push(n); throw new Error("telegram down: 503 https://api.example.test/bot123:SECRET"); } } },
    credentialBinding: { owner_person_id: g2Owner.person_id, owner_tenants: [G2_TENANT], internalRefs: new Set() }
  });
  return { gateway, attempts, ...build(gateway) };
}

describe("A: vent på sluttilstanden gjennom gatewayen og eksekutoren (MEDIUM-1)", () => {
  it("lås som viser GAMMEL tilstand i tre lesinger etter kommandoen og så `locked`: SUCCESS, journal `applied`, ett tjenestekall", async () => {
    const h = standard();
    ha.set("lock.front_door", { state: "unlocked" });
    ha.staleReads = 3;
    const k = key("a1");
    const r = await executePersonalAction(h.executor, owner, input(k));
    expect(r).toMatchObject({ outcome: "SUCCESS", replayed: false, action: { status: "applied", failure_code: null } });
    expect(r.action.after_state).toMatchObject({ state: "locked" });
    expect(ha.serviceCalls()).toHaveLength(1);
    expect(h.notifications).toHaveLength(1);
  });

  it("armering med 30 s utgangsforsinkelse (30 lesinger `arming`): SUCCESS med alarmens 90 s - ikke MISMATCH/`outcome_unknown` etter 20 s", async () => {
    const h = standard();
    ha.set("alarm_control_panel.home", { state: "disarmed" });
    ha.transitionReads = 30;
    const k = key("a2");
    const r = await executePersonalAction(h.executor, owner, input(k, { entity: "alarm_control_panel.home", armed: true }, "critical_alarm"));
    expect(r).toMatchObject({ outcome: "SUCCESS", action: { status: "applied" } });
    expect(r.action.after_state).toMatchObject({ state: "armed_away" });
    // og en replay gir det lagrede utfallet uten ny kommando
    const again = await executePersonalAction(h.executor, owner, input(k, { entity: "alarm_control_panel.home", armed: true }, "critical_alarm"));
    expect(again).toMatchObject({ outcome: "SUCCESS", replayed: true });
    expect(ha.serviceCalls()).toHaveLength(1);
  });

  it("kontroll: uten domenets ventetid (kun globale 20 s) ville samme armering blitt gitt opp - derfor per domene", async () => {
    const h = personalGateway(db.appPool, secrets());
    const b = build(h.gateway, { byDomain: false });
    ha.set("alarm_control_panel.home", { state: "disarmed" });
    ha.transitionReads = 30;
    const r = await executePersonalAction(b.executor, owner, input(key("a3"), { entity: "alarm_control_panel.home", armed: true }, "critical_alarm"));
    expect(r.outcome).not.toBe("SUCCESS");
  });
});

describe("B: samtidig dobbeltsending med samme nøkkel (LOW-5)", () => {
  const entryFor = (k: string) => ({
    domain: "home" as const, tool_id: "home-assistant", action: "critical_lock", risk_class: "D" as const, risk_direction: "reduces" as const, target_ref: "lock.front_door", idempotency_key: k,
    request_digest: actionRequestDigest("home", "critical_lock", LOCK), actor_person_id: owner.person_id, source: "owner_route" as const
  });
  const stubbed = (journal: PersonalActionJournal, index: ReturnType<typeof build>["index"], execute: () => Promise<{ ok: false; reason: string }>): PersonalActionExecutorDeps => ({
    pool: db.appPool, journal, index, gateway: { get: () => ({}) as never, execute } as never
  });

  it("vinneren ferdigstiller raden MENS taperens gatewaykall pågår: taperen gir det lagrede utfallet (SUCCESS, replayed) i stedet for et databaseunntak", async () => {
    const h = standard();
    const k = key("b1");
    const winner = await h.journal.begin(G2_TENANT, "personal", entryFor(k));
    expect(winner.created).toBe(true);
    const deps = stubbed(h.journal, h.index, async () => {
      await h.journal.complete(G2_TENANT, "personal", winner.row.action_id, { status: "applied", external_id: "lock.lock:lock.front_door" });
      return { ok: false, reason: "execution_in_flight_or_outcome_unknown" };
    });
    const loser = await executePersonalAction(deps, owner, input(k));
    expect(loser).toMatchObject({ outcome: "SUCCESS", replayed: true, action: { status: "applied" } });
    expect((await h.journal.findByKey(G2_TENANT, "personal", k))?.status).toBe("applied");
  });

  it("vinneren er fortsatt UNDERVEIS (`requested`): taperen skriver INGENTING og svarer UKJENT - raden blir ikke for tidlig `outcome_unknown`", async () => {
    const h = standard();
    const k = key("b2");
    await h.journal.begin(G2_TENANT, "personal", entryFor(k));
    const loser = await executePersonalAction(stubbed(h.journal, h.index, async () => ({ ok: false, reason: "execution_in_flight_or_outcome_unknown" })), owner, input(k));
    expect(loser).toMatchObject({ outcome: "UNKNOWN", replayed: true });
    expect((await h.journal.findByKey(G2_TENANT, "personal", k))?.status).toBe("requested");
  });

  it("en KRASJET vinner (`requested` eldre enn 5 min) settes `outcome_unknown` som før - raden blir ikke stående som `requested` for alltid", async () => {
    const h = standard();
    const k = key("b3");
    await h.journal.begin(G2_TENANT, "personal", entryFor(k));
    const c = await db.adminPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica"); // kun testen: backdater requested_at forbi triggeren
      await c.query("UPDATE personal_action_journal SET requested_at = now() - interval '10 minutes' WHERE tenant_id = $1 AND idempotency_key = $2", [G2_TENANT, k]);
      await c.query("COMMIT");
    } finally { c.release(); }
    const r = await executePersonalAction(stubbed(h.journal, h.index, async () => ({ ok: false, reason: "execution_in_flight_or_outcome_unknown" })), owner, input(k));
    expect(r.outcome).toBe("UNKNOWN");
    expect((await h.journal.findByKey(G2_TENANT, "personal", k))?.status).toBe("outcome_unknown");
  });

  it("journalen alene: `complete` på en allerede terminal rad returnerer det LAGREDE (ingen overskriving, intet unntak)", async () => {
    const h = standard();
    const k = key("b4");
    const { row } = await h.journal.begin(G2_TENANT, "personal", entryFor(k));
    const first = await h.journal.complete(G2_TENANT, "personal", row.action_id, { status: "applied", failure_code: null, external_id: "x.y:z" });
    const second = await h.journal.complete(G2_TENANT, "personal", row.action_id, { status: "outcome_unknown", failure_code: "execution_in_flight_or_outcome_unknown" });
    expect(second.status).toBe("applied");
    expect(second.failure_code).toBeNull();
    expect(second.completed_at).toEqual(first.completed_at);
  });

  it("ekte samtidighet (to kall, samme nøkkel): ingen av dem kaster, ett HA-kall, raden ender terminal", async () => {
    for (let i = 0; i < 3; i += 1) {
      const h = standard();
      ha.reset();
      ha.set("lock.front_door", { state: "unlocked" });
      ha.transitionReads = 1;
      const k = key(`b5${i}`);
      const settled = await Promise.allSettled([executePersonalAction(h.executor, owner, input(k)), executePersonalAction(h.executor, owner, input(k))]);
      for (const s of settled) {
        // taperen får enten det lagrede utfallet eller `personal_action_target_busy` (målets lås) - men aldri et databaseunntak
        if (s.status === "rejected") expect(String(s.reason)).toMatch(/personal_action_target_busy/);
      }
      expect(ha.serviceCalls().length).toBe(1);
      expect(["applied", "outcome_unknown"]).toContain((await h.journal.findByKey(G2_TENANT, "personal", k))?.status);
    }
  });
});

describe("C: journalens proveniens er uforanderlig (LOW-6)", () => {
  async function appliedRow() {
    const h = standard();
    ha.set("lock.front_door", { state: "unlocked" });
    const r = await executePersonalAction(h.executor, owner, { ...input(key("c1")), task_id: "task-orig", trace_id: "trace-orig" });
    expect(r.action.status).toBe("applied");
    return r.action.action_id;
  }

  it("UPDATE av task_id, session_id, trace_id og created_at avvises av databasevakten (også for en superbruker), uansett status", async () => {
    const id = await appliedRow();
    for (const sql of [
      "UPDATE personal_action_journal SET task_id = 'task-FORGED' WHERE action_id = $1", "UPDATE personal_action_journal SET session_id = 'sess-FORGED' WHERE action_id = $1",
      "UPDATE personal_action_journal SET trace_id = 'trace-FORGED' WHERE action_id = $1", "UPDATE personal_action_journal SET created_at = created_at - interval '1 day' WHERE action_id = $1"
    ]) await expect(db.adminPool.query(sql, [id]), sql).rejects.toThrow(/personal_action_journal_immutable_column/);
    const { rows } = await db.adminPool.query("SELECT task_id, trace_id FROM personal_action_journal WHERE action_id = $1", [id]);
    expect(rows[0]).toEqual({ task_id: "task-orig", trace_id: "trace-orig" });
  });

  it("ferdigstillingstidspunktet kan ikke endres etter terminal status; varslingsstatus (operasjonell metadata) KAN oppdateres", async () => {
    const id = await appliedRow();
    await expect(db.adminPool.query("UPDATE personal_action_journal SET completed_at = completed_at - interval '1 hour' WHERE action_id = $1", [id])).rejects.toThrow(/personal_action_journal_terminal_status/);
    await db.adminPool.query("UPDATE personal_action_journal SET notified = true, notify_error = NULL WHERE action_id = $1", [id]);
    await db.adminPool.query("UPDATE personal_action_journal SET notified = false, notify_error = 'retry_pending' WHERE action_id = $1", [id]);
    expect((await db.adminPool.query("SELECT notified, notify_error FROM personal_action_journal WHERE action_id = $1", [id])).rows[0]).toEqual({ notified: false, notify_error: "retry_pending" });
  });
});

describe("D: varsling som feiler ETTER handlingen lagres (LOW-8)", () => {
  it("SUCCESS med varsler nede: handlingen står, journalen har `notified=false` og en sanert `notify_error` (ingen URL/token-tekst)", async () => {
    const h = failingNotifier();
    ha.set("lock.front_door", { state: "unlocked" });
    const r = await executePersonalAction(h.executor, owner, input(key("d1")));
    expect(r.outcome).toBe("SUCCESS");
    expect(h.attempts).toHaveLength(1);
    expect(r.action).toMatchObject({ status: "applied", notified: false });
    // kun en FAST kode - feilteksten (som her siterer en URL og et token) lagres aldri
    expect(r.action.notify_error).toMatch(/^notification_failed(:[a-z]+)?$/);
    expect(JSON.stringify(r.action)).not.toMatch(/SECRET|https|bot123/);
    expect((await h.journal.findByKey(G2_TENANT, "personal", (r.action.idempotency_key)))?.notified).toBe(false);
  });

  it("MISMATCH med varsler nede (resultatet bærer ikke varslingsstatus): journalen har likevel `notified=false`", async () => {
    const h = failingNotifier();
    ha.set("lock.front_door", { state: "unlocked", mode: "jam" });
    const r = await executePersonalAction(h.executor, owner, input(key("d2")));
    expect(r.outcome).toBe("MISMATCH");
    expect(r.action).toMatchObject({ status: "outcome_unknown", notified: false });
  });

  it("varsler OK: `notified=true`, ingen feilkode; avvist FØR handlingen (aldri varslet): `notified` forblir null", async () => {
    const h = standard();
    ha.set("lock.front_door", { state: "unlocked" });
    const ok = await executePersonalAction(h.executor, owner, input(key("d3")));
    expect(ok.action).toMatchObject({ notified: true, notify_error: null });
    const denied = await executePersonalAction(h.executor, owner, input(key("d4"), { entity: "lock.not_mine", locked: true }));
    expect(denied.outcome).toBe("FAILED");
    expect(denied.action.notified).toBeNull();
  });
});

describe("E: to handlinger mot samme mål serialiseres (LOW-10/11)", () => {
  /** En ANNEN handling mot målet er i flukt (gatewaykallet holdes til `release()`): målets lås holdes. (Selve låsen er bevist mot ekte HA og en pool med 4 forbindelser i `wpg2-fix2-executor-locks.test.ts`.) */
  async function holdLock(target: string): Promise<{ release(): Promise<void> }> {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const holder: PersonalActionExecutorDeps = { ...standard().executor, gateway: { get: () => ({}) as never, execute: async () => { entered(); await gate; return { ok: false, reason: "tool_failed:test_hold" }; } } as never };
    const run = executePersonalAction(holder, owner, input(key("hold"), { entity: target, locked: true } as Record<string, JsonValue>)).catch(() => undefined);
    await reached;
    return { release: async () => { open(); await run; } };
  }

  it("mens en annen handling holder målets lås: `personal_action_target_busy`, ingen HA-forespørsel og INGEN journalrad - så går den samme nøkkelen gjennom når låsen er sluppet", async () => {
    const h = standard();
    ha.set("lock.front_door", { state: "unlocked" });
    const lock = await holdLock("lock.front_door");
    const k = key("e1");
    await expect(executePersonalAction(h.executor, owner, input(k))).rejects.toThrow("personal_action_target_busy");
    expect(ha.requests).toHaveLength(0);
    expect(await h.journal.findByKey(G2_TENANT, "personal", k)).toBeNull();
    await lock.release();
    const r = await executePersonalAction(h.executor, owner, input(k));
    expect(r.outcome).toBe("SUCCESS");
  });

  it("en lås på ET mål stenger ikke andre mål, og motstridende kommandoer (lås/lås opp) mot samme mål blir ikke utført samtidig", async () => {
    const h = standard();
    ha.set("lock.front_door", { state: "unlocked" });
    ha.set("cover.garage", { state: "closed" });
    const lock = await holdLock("lock.front_door");
    try {
      const other = await executePersonalAction(h.executor, owner, input(key("e2"), { entity: "cover.garage", target: "open" }, "critical_cover"));
      expect(other.outcome).toBe("SUCCESS");
      const conflicting = await Promise.allSettled([executePersonalAction(h.executor, owner, input(key("e3"))), executePersonalAction(h.executor, owner, input(key("e4"), { entity: "lock.front_door", locked: false }))]);
      expect(conflicting.every((s) => s.status === "rejected" && /personal_action_target_busy/.test(String(s.reason)))).toBe(true);
      expect(ha.serviceCalls().filter((c) => /lock\//.test(c.path))).toHaveLength(0);
    } finally { await lock.release(); }
  });
});
