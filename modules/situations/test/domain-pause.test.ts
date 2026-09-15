import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ALL_DOMAINS, DomainPauseRegistry } from "../src/domain-pause.ts";

/**
 * UA-10 akseptansekriterium: "Owner can pause a domain or entire Situation
 * Engine instantly". Rent enhets-nivå-bevis (ingen embedded Postgres
 * nødvendig - in-memory, deterministisk, samme "instantly"-disiplin som
 * `KillSwitch`, se domain-pause.ts sitt filhode).
 */
describe("A: domene-scoped pause - kun det navngitte domenet paavirkes", () => {
  it("et paused domene er paused; et annet domene er upaavirket", () => {
    const registry = new DomainPauseRegistry();
    registry.pause("spend", "manuell pause - undersoeker et avvik");
    expect(registry.isPaused("spend")).toBe(true);
    expect(registry.isPaused("pipeline")).toBe(false);
    expect(registry.pauseReason("spend")).toBe("manuell pause - undersoeker et avvik");
  });

  it("unpause fjerner pausen for akkurat det domenet", () => {
    const registry = new DomainPauseRegistry();
    registry.pause("spend", "test");
    registry.unpause("spend");
    expect(registry.isPaused("spend")).toBe(false);
  });

  it("et domene som aldri ble paused er alltid upaused", () => {
    const registry = new DomainPauseRegistry();
    expect(registry.isPaused("infra")).toBe(false);
    expect(registry.pauseReason("infra")).toBeUndefined();
  });
});

describe("B: pauseAll - hele Situation Engine, vinner over enkelt-domene-tilstand", () => {
  it("pauseAll paaviker ETHVERT domenenavn, inkl. ett som aldri ble eksplisitt registrert", () => {
    const registry = new DomainPauseRegistry();
    registry.pauseAll("owner freezet alt midlertidig");
    expect(registry.isPaused("spend")).toBe(true);
    expect(registry.isPaused("a-helt-nytt-domene-ingen-har-hoert-om")).toBe(true);
    expect(registry.pausedDomains()).toContain(ALL_DOMAINS);
  });

  it("unpauseAll gjenoppretter individuelle domene-pauser (som IKKE ble fjernet av pauseAll)", () => {
    const registry = new DomainPauseRegistry();
    registry.pause("spend", "spesifikk grunn");
    registry.pauseAll("global grunn");
    registry.unpauseAll();
    expect(registry.isPaused("spend")).toBe(true); // domene-spesifikk pause overlevde alt-pausen sin fjerning.
    expect(registry.isPaused("pipeline")).toBe(false);
  });

  it("alt-domene-grunnen foretrekkes i pauseReason() naar BEGGE er satt for samme domene", () => {
    const registry = new DomainPauseRegistry();
    registry.pause("spend", "domene-spesifikk grunn");
    registry.pauseAll("bredere, mer relevant grunn");
    expect(registry.pauseReason("spend")).toBe("bredere, mer relevant grunn");
  });
});

describe("C: Funn 6 (arkitekt-review runde 1, PR #85) - Durable-variant, fail-CLOSED oppstartsgjenoppretting", () => {
  let PORT = 0;
  let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
  let epg: InstanceType<typeof EmbeddedPostgres>;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  const TENANT = "tenant-sit-domain-pause-durable";

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-sit-domain-pause-"));
    const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
      new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
    );
    epg = leasedPostgres.postgres;
    PORT = leasedPostgres.port;
    stopEmbeddedPostgres = leasedPostgres.stop;
    await epg.createDatabase("jarvis_test");
    adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
    adminPool.on("error", () => undefined);
    await runMigrations(adminPool);
    await adminPool.query("CREATE ROLE jarvis_sit_domain_pause_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
    await adminPool.query("GRANT jarvis_app TO jarvis_sit_domain_pause_test");
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'DomainPauseDurable', 'business');
      INSERT INTO people (person_id, display_name) VALUES ('person-owner-pause-test', 'Owner');
    `);
    appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sit_domain_pause_test", password: "pw2" });
  }, 240_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    await stopEmbeddedPostgres?.();
  }, 120_000);

  it("uten et pool gitt til konstruktøren er *Durable()-metodene en ren no-op-persistens (kun in-memory, uendret oppførsel)", async () => {
    const registry = new DomainPauseRegistry();
    await registry.pauseDurable("spend", "test uten pool");
    expect(registry.isPaused("spend")).toBe(true);
    await registry.restore(); // no-op naar pool mangler - MÅ IKKE tømme in-memory-tilstanden.
    expect(registry.isPaused("spend")).toBe(true);
  });

  it("en pause satt via pauseDurable() OVERLEVER en simulert prosess-omstart (en HELT NY DomainPauseRegistry-instans + restore())", async () => {
    const first = new DomainPauseRegistry(appPool);
    await first.pauseDurable("infra", "undersoeker en alvorlig hendelse", "person-owner-pause-test");
    expect(first.isPaused("infra")).toBe(true);

    // Simulerer en prosess-OMSTART: en HELT NY instans, ingen delt in-memory-tilstand med `first`.
    const restarted = new DomainPauseRegistry(appPool);
    expect(restarted.isPaused("infra")).toBe(false); // FØR restore() - fersk instans, tom Map.
    await restarted.restore();
    expect(restarted.isPaused("infra")).toBe(true); // ETTER restore() - fail-CLOSED, pausen ble IKKE glemt.
    expect(restarted.pauseReason("infra")).toBe("undersoeker en alvorlig hendelse");
  });

  it("unpauseDurable() fjerner pausen VARIG - en påfølgende restore() (simulert omstart) gjenoppretter IKKE en fjernet pause", async () => {
    const first = new DomainPauseRegistry(appPool);
    await first.pauseDurable("home", "midlertidig");
    await first.unpauseDurable("home");

    const restarted = new DomainPauseRegistry(appPool);
    await restarted.restore();
    expect(restarted.isPaused("home")).toBe(false);
  });

  it("pauseAllDurable()/unpauseAllDurable() er VARIG - overlever restore() på samme måte som en enkelt-domene-pause", async () => {
    const first = new DomainPauseRegistry(appPool);
    await first.pauseAllDurable("owner fryser hele Situation Engine varig");

    const restarted = new DomainPauseRegistry(appPool);
    await restarted.restore();
    expect(restarted.isPaused("et-helt-vilkaarlig-domene")).toBe(true);
    expect(restarted.pausedDomains()).toContain(ALL_DOMAINS);

    await restarted.unpauseAllDurable();
    const restartedAgain = new DomainPauseRegistry(appPool);
    await restartedAgain.restore();
    expect(restartedAgain.isPaused("et-helt-vilkaarlig-domene")).toBe(false);
  });

  it("restore() erstatter HELE in-memory-tilstanden med det som FAKTISK er persistert - en lokal in-memory-only pause (satt via den RENE synkrone pause(), IKKE persistert) overlever IKKE en restore()", async () => {
    const registry = new DomainPauseRegistry(appPool);
    registry.pause("kun-in-memory-aldri-persistert", "test");
    expect(registry.isPaused("kun-in-memory-aldri-persistert")).toBe(true);
    await registry.restore();
    expect(registry.isPaused("kun-in-memory-aldri-persistert")).toBe(false);
  });
});
