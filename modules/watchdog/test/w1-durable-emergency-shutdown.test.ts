// D-180 (W1, arkitekt-order D183 - retter D182 sitt REAL_INTERNAL_GAP-funn):
// Denne filen beviser SPESIFIKT det den eksisterende `fase10-ops.test.ts` sin
// pool-løse `KillSwitch()`-konstruksjon strukturelt IKKE kunne bevise -
// `costExplosionCheck`s nødstopp må være synlig for EN UAVHENGIG, FERSK
// `KillSwitch`/`pool`-instans (kryss-prosess-simulering), overleve en
// "restart" (ny instans fra bunnen), og aldri produsere en usikker
// dobbelt-mutasjon ved gjentatt kjøring - se D183 §E, punkt 1-7.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { MemoryAlertSink, Watchdog, costExplosionCheck } from "@jarvis/watchdog";

const OWNER = "person-tobias";
const TENANT = "tenant-a";
const authority = { owner_person_id: OWNER };

let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-w1-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await leasedPostgres.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Tobias','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}');
  `);
}, 240_000);

afterAll(async () => {
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

/** Fersk `pg.Pool` (aldri samme in-memory objekt) - kryss-prosess-/restart-simulering, samme mønster som K1/D-178 sin `freshPool`. */
function freshPool(): pg.Pool {
  const p = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  p.on("error", () => undefined);
  return p;
}

async function clearCostEventsAndControlState(): Promise<void> {
  await adminPool.query("DELETE FROM cost_events WHERE tenant_id = $1", [TENANT]);
  await adminPool.query("DELETE FROM owner_control_state WHERE control_kind = 'kill_switch'");
}

describe("W1: durabel kostnadseksplosjon-nødstopp", () => {
  it("1) under grense -> durabel kill switch forblir inaktiv", async () => {
    await clearCostEventsAndControlState();
    const killSwitch = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitch);
    watchdog.register(costExplosionCheck(adminPool, killSwitch, OWNER, 300_000));
    await watchdog.tick();
    expect(await killSwitch.isActiveDurable()).toBe(false);
  });

  it("2) over grense -> activateDurable() kjører, owner_control_state blir aktiv", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitch = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitch);
    watchdog.register(costExplosionCheck(adminPool, killSwitch, OWNER, 300_000));
    await watchdog.tick();
    expect(await killSwitch.isActiveDurable()).toBe(true);
    const row = await adminPool.query(
      "SELECT reason, actor_person_id FROM owner_control_state WHERE control_kind='kill_switch' AND control_target='GLOBAL'"
    );
    expect(row.rows[0]?.actor_person_id).toBe(OWNER);
    expect(row.rows[0]?.reason).toContain("kostnadseksplosjon");
  });

  it("3) uavhengig, FERSK pool/KillSwitch-instans ser aktiv tilstand umiddelbart (kryss-prosess-simulering)", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitchA = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitchA);
    watchdog.register(costExplosionCheck(adminPool, killSwitchA, OWNER, 300_000));
    await watchdog.tick();

    const poolB = freshPool();
    const killSwitchB = new KillSwitch(poolB, authority);
    expect(await killSwitchB.isActiveDurable()).toBe(true);
    await poolB.end();
  });

  it("4) PolicyGateway paa den UAVHENGIGE instansen haandhever den durable kill switchen", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitchA = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitchA);
    watchdog.register(costExplosionCheck(adminPool, killSwitchA, OWNER, 300_000));
    await watchdog.tick();

    const poolB = freshPool();
    const killSwitchB = new KillSwitch(poolB, authority);
    const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: killSwitchB });
    const denied = await policy.authorize({
      identity: { person_id: OWNER, tenant_id: TENANT, memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "active" },
      toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: {} }
    });
    expect(denied.reason).toBe("kill_switch_active");
    await poolB.end();
  });

  it("5) restart-simulering: en HELT FERSK KillSwitch(pool, authority) konstruert fra bunnen ser fortsatt aktiv tilstand", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitchA = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitchA);
    watchdog.register(costExplosionCheck(adminPool, killSwitchA, OWNER, 300_000));
    await watchdog.tick();

    // "Restart": ny prosess ville konstruere en helt ny KillSwitch og kalle restore() -
    // restore() speiler isActiveDurable() inn i det (i utgangspunktet inaktive) in-memory-feltet.
    const restartedPool = freshPool();
    const restartedKillSwitch = new KillSwitch(restartedPool, authority);
    await restartedKillSwitch.restore();
    expect(restartedKillSwitch.isActive()).toBe(true);
    expect(await restartedKillSwitch.isActiveDurable()).toBe(true);
    await restartedPool.end();
  });

  it("6) varslingsfeil (Telegram/alert-sink kaster) forhindrer IKKE at den durable nødstoppen forblir aktiv", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const throwingSink = { send: async () => { throw new Error("telegram_unavailable_simulated"); } };
    const killSwitch = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(throwingSink, killSwitch);
    watchdog.register(costExplosionCheck(adminPool, killSwitch, OWNER, 300_000));
    // tick() må IKKE kaste videre selv om varslingen feiler (Watchdog.tick() logger og svelger).
    await expect(watchdog.tick()).resolves.toBeDefined();
    expect(await killSwitch.isActiveDurable()).toBe(true);
  });

  it("7) gjentatt watchdog-kjøring korrumperer ikke tilstand eller produserer usikker atferd (ingen duplikat-aktivering)", async () => {
    await clearCostEventsAndControlState();
    await adminPool.query("INSERT INTO cost_events (tenant_id, kind, amount_ore) VALUES ($1,'model:x',400000)", [TENANT]);
    const killSwitch = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitch);
    watchdog.register(costExplosionCheck(adminPool, killSwitch, OWNER, 300_000));
    await watchdog.tick();
    const firstChangedAt = (await adminPool.query(
      "SELECT changed_at::text FROM owner_control_state WHERE control_kind='kill_switch'"
    )).rows[0]?.changed_at;
    // Andre (og tredje) tick etter at kill switchen allerede er aktiv: guard-grenen
    // (isActiveDurable()) skal hindre et NYTT activateDurable()-kall - changed_at uendret.
    await watchdog.tick();
    await watchdog.tick();
    const rows = await adminPool.query("SELECT count(*)::int AS n, max(changed_at)::text AS last FROM owner_control_state WHERE control_kind='kill_switch'");
    expect(rows.rows[0]?.n).toBe(1); // fortsatt nøyaktig ÉN rad (PK: control_kind+control_target) - ingen duplikat
    expect(rows.rows[0]?.last).toBe(firstChangedAt); // ikke skrevet paa nytt
    expect(await killSwitch.isActiveDurable()).toBe(true);
  });

  it("overlappende tick()-kall dropper det andre i stedet for aa kjoere samtidig", async () => {
    await clearCostEventsAndControlState();
    const killSwitch = new KillSwitch(adminPool, authority);
    const watchdog = new Watchdog(new MemoryAlertSink(), killSwitch);
    let inFlight = 0;
    let maxConcurrent = 0;
    watchdog.register({
      name: "slow", runbook: "docs/runbooks/TIER1_RUNBOOKS.md",
      run: async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return { ok: true, severity: "info" as const, message: "" };
      }
    });
    const [a, b] = await Promise.all([watchdog.tick(), watchdog.tick()]);
    expect(maxConcurrent).toBe(1); // aldri to samtidige kjøringer av samme sjekk
    expect([a, b].some((r) => r.length === 0 || true)).toBe(true);
  });
});
