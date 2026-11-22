import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import {
  HOME_CRITICAL_OPS, HomeAssistantCriticalTransport, PersonalActionJournal, executePersonalAction, homeCriticalConfigFromEnv, homeCriticalToolDefinitions, personalActionIndex, personalTargetLockKey,
  personalTargetLocksHeld, type PersonalActionExecutorDeps, type SecretProvider
} from "../src/index.ts";
import { FakeHomeAssistant } from "./support/fake-home-assistant.ts";
import { G2_OTHER_TENANT, G2_TENANT, g2Owner, personalGateway, startPersonalDb, type PersonalDb } from "./support/personal-db-harness.ts";

/**
 * WP-G2 fiks-runde 2 (delta-review A, NY-1 HIGH / NY-2 / NY-3): målets lås i eksekutoren.
 *  - NY-1: den forrige låsen holdt en forbindelse fra den DELTE poolen (max 10, ingen timeout) HELE handlingen, mens journal/ledger/revisjon/varsel trengte flere fra samme pool: N samtidige handlinger mot ulike mål = dødlås, og
 *    kommandoer som allerede var sendt sto uten ferdigstilling og uten eier-varsel. Nå holder låsen INGEN forbindelse (prosess-lokal, ikke-blokkerende): her bevist med en pool på BARE 4 forbindelser og 12 samtidige handlinger.
 *  - NY-2: låsen slippes etter fullført OG etter feilet/kastet handling (tester som dreper en lås som aldri frigis).
 *  - NY-3: nøkkelen er (domene, mål) UTEN tenant: to tenanter som styrer SAMME fysiske lås serialiseres.
 * Hver test feller den gamle koden (se mutasjonsbeviset i rapporten).
 */
let db: PersonalDb;
let ha: FakeHomeAssistant;
let small: pg.Pool;
beforeAll(async () => {
  db = await startPersonalDb("jarvis_test_g2_fix2_locks");
  ha = new FakeHomeAssistant();
  await ha.start();
  const o = db.appPool.options;
  small = new pg.Pool({ host: o.host as string, port: o.port as number, database: o.database as string, user: o.user as string, password: o.password as string, max: 4 });
  small.on("error", () => undefined);
}, 240_000);
afterAll(async () => {
  ha?.releaseHeld();
  await ha?.stop();
  await Promise.race([small?.end().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 3_000))]); // en hengende (rød) kjøring kan ha forbindelser som aldri kommer tilbake
  await db?.stop();
}, 120_000);
beforeEach(() => ha.reset());

const owner: IdentityContext = { ...g2Owner, memory_space_id: "personal" };
let seq = 0;
const key = (p: string): string => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;
const secrets = (): SecretProvider => ({ name: "fake", get: async (ref) => (ref === "JARVIS_HA_TOKEN" ? ha.token : null) });
/** 6 brytere + 6 porter: gatewayens rate-grense er 10 per minutt PER handling, så 12 like handlinger ville gitt to avvisninger FØR HA (ikke det denne testen måler). */
const SWITCHES = Array.from({ length: 6 }, (_v, i) => `switch.t${String(i + 1).padStart(2, "0")}`);
const COVERS = Array.from({ length: 6 }, (_v, i) => `cover.t${String(i + 1).padStart(2, "0")}`);
const TARGETS12 = [...SWITCHES, ...COVERS];
const initial = (entity: string): { state: string } => ({ state: entity.startsWith("cover.") ? "closed" : "off" });
const switchInput = (k: string, entity: string) => (entity.startsWith("cover.")
  ? { domain: "home", action: "critical_cover", parameters: { entity, target: "open" } as Record<string, JsonValue>, idempotency_key: k }
  : { domain: "home", action: "critical_switch", parameters: { entity, on: true } as Record<string, JsonValue>, idempotency_key: k });

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > ms) throw new Error(`timeout: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function buildOn(pool: pg.Pool, targets: readonly string[]) {
  const h = personalGateway(pool, secrets());
  const config = homeCriticalConfigFromEnv({ JARVIS_PERSONAL_HOME_TARGETS: targets.join(",") });
  const transport = new HomeAssistantCriticalTransport({ baseUrl: async () => ha.baseUrl, settleMs: 20_000, pollMs: 1_000 });
  for (const d of homeCriticalToolDefinitions(transport, { ...config, settleMs: 20_000, pollMs: 1_000 })) h.gateway.register(d);
  const journal = new PersonalActionJournal(pool);
  const index = personalActionIndex(HOME_CRITICAL_OPS.map((op) => ({ domain: "home" as const, toolId: "home-assistant", op })));
  const executor: PersonalActionExecutorDeps = { pool, gateway: h.gateway, journal, index };
  return { ...h, journal, executor };
}

const POOLS: ReadonlyArray<readonly [string, () => pg.Pool]> = [["pool med BARE 4 forbindelser", () => small], ["standardpoolen (max 10) - flere samtidige handlinger enn forbindelser", () => db.appPool]];

describe("A: ingen dødlås - 12 samtidige handlinger mot ulike mål (NY-1)", () => {
  for (const [label, poolOf] of POOLS) it(`${label}: alle 12 når HA samtidig (også de som kommer SENT, mens de første allerede er sendt), og når HA svarer er hver handling ferdig: journal \`applied\`, ledger ferdig og eier-varsel sendt`, async () => {
    const pool = poolOf();
    const h = buildOn(pool, TARGETS12);
    for (const t of TARGETS12) ha.set(t, initial(t));
    ha.holdServices = true;
    const keys = TARGETS12.map((_s, i) => key(`p${i}`));
    const results: Array<Promise<unknown>> = [];
    const launch = (i: number): void => { results.push(executePersonalAction(h.executor, owner, switchInput(keys[i]!, TARGETS12[i]!)).catch((e: unknown) => e)); };
    for (let i = 0; i < 6; i += 1) launch(i);
    await until(() => ha.heldCount() === 6, "6 kommandoer er sendt til HA (poolen har bare 4 forbindelser)");
    for (let i = 6; i < 12; i += 1) launch(i); // forskjøvet ankomst: de første seks er allerede i flukt
    await until(() => ha.heldCount() === 12, "12 kommandoer er sendt til HA");
    expect(ha.serviceCalls()).toHaveLength(12);
    ha.releaseHeld();
    const settled = await Promise.race([Promise.all(results), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timeout: handlingene ble ikke ferdige etter at HA svarte")), 20_000))]);
    for (const r of settled) expect(r, String(r)).toMatchObject({ outcome: "SUCCESS", action: { status: "applied" } });
    for (const k of keys) expect((await h.journal.findByKey(G2_TENANT, "personal", k))?.status, k).toBe("applied");
    const ledger = await db.adminPool.query("SELECT status FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = ANY($2::text[])", [G2_TENANT, keys]);
    expect(ledger.rowCount).toBe(12);
    for (const row of ledger.rows as Array<{ status: string }>) expect(row.status).not.toBe("reserved");
    expect(h.notifications).toHaveLength(12); // eier-varselet uteble før (steg etter kommandoen sto fast)
    expect(personalTargetLocksHeld()).toBe(0);
    expect(pool.waitingCount).toBe(0);
  }, 60_000);

  it("en handling mot et mål som allerede har en kommando i flukt avvises UMIDDELBART med `personal_action_target_busy` FØR noe sendes (ingen HA-kall, ingen journalrad); resten er uberørt, og retry etter ferdig går gjennom", async () => {
    const h = buildOn(small, TARGETS12);
    const targets = [...SWITCHES.slice(0, 4), ...COVERS.slice(0, 4)];
    for (const t of targets) ha.set(t, initial(t));
    ha.holdServices = true;
    const first = targets.map((t, i) => ({ k: key(`f${i}`), t }));
    const running = first.map(({ k, t }) => executePersonalAction(h.executor, owner, switchInput(k, t)).catch((e: unknown) => e));
    await until(() => ha.heldCount() === 8, "8 kommandoer i flukt");
    const dupes = [0, 1, 4, 5].map((i) => ({ k: key(`d${i}`), t: targets[i]! }));
    for (const { k, t } of dupes) {
      await expect(executePersonalAction(h.executor, owner, switchInput(k, t))).rejects.toThrow("personal_action_target_busy");
      expect(await h.journal.findByKey(G2_TENANT, "personal", k), "avvist = ingen journalrad").toBeNull();
    }
    expect(ha.serviceCalls()).toHaveLength(8); // de fire avviste sendte ingenting
    ha.releaseHeld();
    for (const r of await Promise.all(running)) expect(r).toMatchObject({ outcome: "SUCCESS" });
    expect(personalTargetLocksHeld()).toBe(0);
    for (const { k, t } of dupes) expect(await executePersonalAction(h.executor, owner, switchInput(k, t))).toMatchObject({ outcome: "SUCCESS" });
  }, 60_000);
});

describe("B: låsen slippes alltid (NY-2)", () => {
  it("etter en FULLFØRT handling og etter en FEILET (HA avviser): ingen lås er igjen, og et nytt kall mot samme mål er ikke opptatt", async () => {
    const h = buildOn(db.appPool, TARGETS12);
    ha.set("switch.t01", { state: "off" });
    expect(await executePersonalAction(h.executor, owner, switchInput(key("b1"), "switch.t01"))).toMatchObject({ outcome: "SUCCESS" });
    expect(personalTargetLocksHeld()).toBe(0);
    ha.nextServiceStatus = 400;
    expect(await executePersonalAction(h.executor, owner, switchInput(key("b2"), "switch.t01"))).toMatchObject({ outcome: "FAILED" });
    expect(personalTargetLocksHeld()).toBe(0);
    expect(await executePersonalAction(h.executor, owner, switchInput(key("b3"), "switch.t01"))).toMatchObject({ outcome: "SUCCESS" });
    expect(personalTargetLocksHeld()).toBe(0);
  });

  it("etter at gatewayen KASTER midt i handlingen: unntaket går videre, låsen slippes, og målet er ikke stengt for neste kall", async () => {
    const h = buildOn(db.appPool, TARGETS12);
    ha.set("switch.t02", { state: "off" });
    const throwing: PersonalActionExecutorDeps = { ...h.executor, gateway: { get: () => ({}) as never, execute: async () => { throw new Error("gateway_boom"); } } as never };
    await expect(executePersonalAction(throwing, owner, switchInput(key("b4"), "switch.t02"))).rejects.toThrow("gateway_boom");
    expect(personalTargetLocksHeld()).toBe(0);
    expect(await executePersonalAction(h.executor, owner, switchInput(key("b5"), "switch.t02"))).toMatchObject({ outcome: "SUCCESS" });
  });

  it("en lås holdes MENS handlingen kjører (og kun da): ett mål = én lås, og den er borte når handlingen er ferdig", async () => {
    const h = buildOn(db.appPool, TARGETS12);
    ha.set("switch.t03", { state: "off" });
    ha.holdServices = true;
    const run = executePersonalAction(h.executor, owner, switchInput(key("b6"), "switch.t03"));
    await until(() => ha.heldCount() === 1, "kommandoen er sendt");
    expect(personalTargetLocksHeld()).toBe(1);
    ha.releaseHeld();
    expect(await run).toMatchObject({ outcome: "SUCCESS" });
    expect(personalTargetLocksHeld()).toBe(0);
  });
});

describe("C: nøkkelen er (domene, mål) UTEN tenant - HA og bil er globale enheter (NY-3)", () => {
  it("nøkkelen inneholder ingen tenant, og to tenanter som styrer SAMME lås serialiseres: den andre tenanten får `personal_action_target_busy` uten at noe sendes", async () => {
    expect(personalTargetLockKey("home", "lock.front_door")).toBe(personalTargetLockKey("home", "lock.front_door"));
    expect(personalTargetLockKey("home", "lock.front_door")).not.toContain(G2_TENANT);
    expect(personalTargetLockKey("home", "lock.front_door")).not.toBe(personalTargetLockKey("car", "lock.front_door"));
    const h = buildOn(db.appPool, ["lock.front_door", ...TARGETS12]);
    ha.set("lock.front_door", { state: "unlocked" });
    ha.holdServices = true;
    const a = executePersonalAction(h.executor, owner, { domain: "home", action: "critical_lock", parameters: { entity: "lock.front_door", locked: true }, idempotency_key: key("c1") });
    await until(() => ha.heldCount() === 1, "tenant A har en kommando i flukt mot låsen");
    const otherTenant: IdentityContext = { ...owner, tenant_id: G2_OTHER_TENANT, person_id: "person-g2-p-other" };
    const k = key("c2");
    await expect(executePersonalAction(h.executor, otherTenant, { domain: "home", action: "critical_lock", parameters: { entity: "lock.front_door", locked: false }, idempotency_key: k })).rejects.toThrow("personal_action_target_busy");
    expect(ha.serviceCalls()).toHaveLength(1);
    expect(await h.journal.findByKey(G2_OTHER_TENANT, "personal", k)).toBeNull();
    ha.releaseHeld();
    expect(await a).toMatchObject({ outcome: "SUCCESS" });
    expect(personalTargetLocksHeld()).toBe(0);
  });
});
