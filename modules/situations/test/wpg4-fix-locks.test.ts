import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@jarvis/contracts";
import { PgApprovalStore } from "@jarvis/core";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider, type ToolTransport } from "@jarvis/tool-gateway";
import { DomainLockBusyError, domainLockCapacity, MAX_LOCK_WAITERS, withDomainAdvisoryLocks } from "../src/advisory-lock.ts";
import { DomainPauseRegistry } from "../src/domain-pause.ts";
import { SituationEngine } from "../src/service.ts";
import { identity, NOW, OWNER, record, startG4Db, TENANT_A, type G4Db } from "./support/wpg4-db.ts";
import { TEST_BINDABLE } from "./support/bindable.ts";

/**
 * WP-G4 (D-466) FIKS-RUNDE, A-MEDIUM-5 (ARVET, men G4 gjør ACT hyppigere): `withDomainAdvisoryLocks` holdt ÉN pool-forbindelse per sesjonslås (`pg_advisory_lock`) - også mens den VENTET på låsen. Pool max 10 uten
 * connectionTimeout: én pågående `actOn` + to samtidige `pause_domain` (hver ventende på låsen med en forbindelse) tømte en pool på 3 - `actOn` fikk aldri en forbindelse til sine egne spørringer = dødlås (reviewer-probe R4).
 * Rettet UTEN å røre den delte poolen: en prosess-lokal semafor (per pool) begrenser antall samtidige lås-holdere/-ventere som har en forbindelse til `max(1, floor(poolMax/2) - 1)`; resten venter i en kø UTEN forbindelse
 * (begrenset ventetid og køstørrelse: raskt `DomainLockBusyError`, «ikke utført, prøv igjen»). Låsene mellom `actOn` og pause er fortsatt blokkerende gjensidig utelukkelse (uendret).
 */
let db: G4Db;
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });
const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };

function poolOf(max: number): pg.Pool {
  const opts = (db.appPool as unknown as { options: { host: string; port: number; database: string; user: string; password: string } }).options;
  const pool = new pg.Pool({ host: opts.host, port: opts.port, database: opts.database, user: opts.user, password: opts.password, max });
  pool.on("error", () => undefined);
  return pool;
}

beforeAll(async () => { db = await startG4Db("fixlocks"); }, 240_000);
afterAll(async () => { await db?.stop(); }, 120_000);
beforeEach(async () => { await db.reset(); });

describe("A-MEDIUM-5: kapasitet og avvisning", () => {
  it("kapasiteten følger poolstørrelsen: max(1, floor(max/2) - 1) (3 -> 1, 10 -> 4, 20 -> 9), og en ukjent størrelse bruker standard 10", async () => {
    const pools = [1, 2, 3, 10, 20].map(poolOf);
    try {
      expect(pools.map(domainLockCapacity)).toEqual([1, 1, 1, 4, 9]);
      expect(domainLockCapacity({} as pg.Pool)).toBe(4);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it("samtidige holdere er begrenset til kapasiteten: 6 holdere i en pool på 10 -> nøyaktig 4 inne samtidig, resten venter UTEN forbindelse og slippes inn etter hvert som plasser frigjøres", async () => {
    const pool = poolOf(10);
    try {
      let inside = 0;
      let peak = 0;
      const gates: Array<() => void> = [];
      const runs = Array.from({ length: 6 }, (_, i) => withDomainAdvisoryLocks(pool, [`fix-cap-${i}`], async () => {
        inside += 1;
        peak = Math.max(peak, inside);
        await new Promise<void>((resolve) => gates.push(resolve));
        inside -= 1;
      }));
      for (let i = 0; i < 100 && gates.length < 4; i += 1) await sleep(10);
      await sleep(100);
      expect(gates).toHaveLength(4); // de to siste venter på en plass
      expect(pool.totalCount).toBeLessThanOrEqual(4); // ventere har ingen forbindelse
      gates.splice(0).forEach((release) => release());
      for (let i = 0; i < 100 && gates.length < 2; i += 1) await sleep(10);
      gates.splice(0).forEach((release) => release());
      await Promise.all(runs);
      expect(peak).toBe(4);
    } finally {
      await pool.end();
    }
  });

  it("full kø venter begrenset og feiler så raskt med `DomainLockBusyError` (ikke utført, prøv igjen); plassen er fortsatt brukbar etterpå, og ingen plass lekker (heller ikke ved kastet kropp)", async () => {
    const pool = poolOf(3); // kapasitet 1
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const holder = withDomainAdvisoryLocks(pool, ["fix-busy"], async () => { await gate; return "holder"; });
      await sleep(50);
      const started = Date.now();
      await expect(withDomainAdvisoryLocks(pool, ["fix-busy-2"], async () => "never", { waitMs: 60 })).rejects.toMatchObject({ name: "DomainLockBusyError", reason: "wait_timeout" });
      expect(Date.now() - started).toBeLessThan(2_000);
      release();
      expect(await holder).toBe("holder");
      // plassen er frigjort: neste kall går rett inn; en kropp som kaster frigjør også plassen
      expect(await withDomainAdvisoryLocks(pool, ["fix-busy-3"], async () => "ok", { waitMs: 60 })).toBe("ok");
      await expect(withDomainAdvisoryLocks(pool, ["fix-busy-4"], async () => { throw new Error("kropp feilet"); })).rejects.toThrow("kropp feilet");
      expect(await withDomainAdvisoryLocks(pool, ["fix-busy-5"], async () => "ok2", { waitMs: 60 })).toBe("ok2");
      // en feil ved forbindelsen frigjør også plassen
      const originalConnect = pool.connect.bind(pool);
      (pool as unknown as { connect: () => Promise<never> }).connect = async () => { throw new Error("ingen forbindelse"); };
      await expect(withDomainAdvisoryLocks(pool, ["fix-busy-6"], async () => "x")).rejects.toThrow("ingen forbindelse");
      (pool as unknown as { connect: typeof originalConnect }).connect = originalConnect;
      expect(await withDomainAdvisoryLocks(pool, ["fix-busy-7"], async () => "ok3", { waitMs: 60 })).toBe("ok3");
    } finally {
      await pool.end();
    }
  });

  it("køen har et tak (MAX_LOCK_WAITERS): kall nummer MAX+2 avvises UMIDDELBART med `queue_full`, og de som står i køen blir behandlet i rekkefølge når holderen er ferdig", async () => {
    const pool = poolOf(3);
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const order: number[] = [];
      const holder = withDomainAdvisoryLocks(pool, ["fix-queue"], async () => { await gate; });
      await sleep(50);
      const waiters = Array.from({ length: MAX_LOCK_WAITERS }, (_, i) => withDomainAdvisoryLocks(pool, ["fix-queue"], async () => { order.push(i); }, { waitMs: 20_000 }));
      await sleep(50);
      const started = Date.now();
      await expect(withDomainAdvisoryLocks(pool, ["fix-queue"], async () => "never", { waitMs: 20_000 })).rejects.toMatchObject({ name: "DomainLockBusyError", reason: "queue_full" });
      expect(Date.now() - started).toBeLessThan(500); // umiddelbart, ikke etter ventetiden
      release();
      await holder;
      await Promise.all(waiters);
      expect(order).toEqual(Array.from({ length: MAX_LOCK_WAITERS }, (_, i) => i));
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("`DomainLockBusyError` er en egen, navngitt feil", () => {
    const err = new DomainLockBusyError("wait_timeout");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("domain_lock_busy:wait_timeout");
  });
});

describe("A-MEDIUM-5: probe R4 - én pågående actOn + to samtidige pause_domain tømmer ikke lenger poolen", () => {
  class Spy implements ToolTransport {
    calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
    async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
      this.calls.push({ action, parameters });
      return { external_id: `x-${this.calls.length}` };
    }
  }

  it("pool på BARE 3 forbindelser: actOn fullfører etter at gaten åpnes, begge pausene gjennomføres etterpå (i rekkefølge), og poolen er sunn", async () => {
    const small = poolOf(3);
    try {
      const pauses = new DomainPauseRegistry(small, { owner_person_id: OWNER });
      const engineSmall = new SituationEngine(small, pauses, { owner_person_id: OWNER });
      const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(small), killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A] } });
      const gateway = new ToolGateway(small, policy, secrets);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered = false;
      const blocking: ToolTransport = { async invoke() { entered = true; await gate; return { external_id: "b-1" }; } };
      gateway.register({
        tool_id: "test_act", action: "apply", description: "t", input_schema: record({ situation_id: z.string() }), capability_class: "B", scopes: [], reversible: true,
        rollback_procedure: "undo", idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_ACT_TOKEN", output_trust: "internal", transport: blocking, autonomy_bindable: TEST_BINDABLE
      });
      gateway.register({
        tool_id: "telegram", action: "notify", description: "t", input_schema: record({ message: z.string() }), capability_class: "B", scopes: [], reversible: true,
        rollback_procedure: "x", idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: new Spy(), autonomy_bindable: TEST_BINDABLE
      });
      await db.engine.evaluateCandidate(TENANT_A, "home", { domain: "home", detection_key: "home:deadlock:1", priority: "high", confidence: 0.9, reason: "r" }, NOW);
      // WP-G4b K1: bindingen skrives med en motor (stor pool) som slår opp definisjonen i DENNE testens gateway; den lille poolen er det som testes.
      const binder = new SituationEngine(db.appPool, db.domainPauses, { owner_person_id: OWNER }, { definitionLookup: (t, a) => gateway.get(t, a) });
      await binder.setAutonomyPolicy(TENANT_A, "home", { domain: "home", tool_id: "test_act", action: "apply", parameters: { situation_id: "{{situation_id}}" } }, OWNER);
      const acting = engineSmall.autoActPending(TENANT_A, "home", gateway, identity(TENANT_A, "home"));
      for (let i = 0; i < 200 && !entered; i += 1) await sleep(25);
      expect(entered).toBe(true);
      const finished: string[] = [];
      const pauseA = pauses.pauseDurable("home", "a", OWNER).then(() => finished.push("a"));
      const pauseB = pauses.pauseDurable("home", "b", OWNER).then(() => finished.push("b"));
      await sleep(600); // uten fiksen står begge pausene nå med hver sin forbindelse på låsen, og poolen er tom
      expect(small.totalCount).toBeLessThanOrEqual(3);
      release();
      const outcome = await Promise.race([acting.then(() => "DONE"), sleep(4_000).then(() => "TIMEOUT")]);
      expect(outcome).toBe("DONE");
      expect(await acting).toMatchObject({ attempted: 1, succeeded: 1 });
      await Promise.all([pauseA, pauseB]);
      expect(finished).toEqual(["a", "b"]);
      expect(small.waitingCount).toBe(0);
      expect((await small.query("SELECT 1 AS ok")).rows[0].ok).toBe(1); // poolen svarer
    } finally {
      await db.adminPool.query(`DELETE FROM situation_domain_pauses`);
      await small.end().catch(() => undefined);
    }
  }, 60_000);
});
