import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding } from "@jarvis/memory";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";
// Relativ import (IKKE en ny @jarvis/erasure -> @jarvis/situations
// pakkeavhengighet kun for en testfil) - samme presedens som
// product-erasure.test.ts/contracts-erasure.test.ts sine relative imports.
import { DomainPauseRegistry } from "../../situations/src/domain-pause.ts";
import { SituationEngine } from "../../situations/src/service.ts";

/**
 * UA-10 Proactive Situation Engine (D-64) Q-20: `modules/erasure/src/plan.ts`
 * sin `planMemorySpace()` registrerer `situations` (tenant+space-scoped,
 * samme mønster som `business_open_loops` - dens nærmeste presedens).
 * `situation_notification_policies` BEVISST utelatt (tenant/space-nivå
 * policy-konfigurasjon, ikke hendelses-/personeid data). Ende-til-ende-bevis
 * mot en EKTE embedded Postgres via den EKTE
 * `ErasureService.executeErasure()`-APIen - IKKE kun en `plan.ts`-lesning.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let embedding: LocalHashEmbedding;
let sovereignPolicy: PolicyGateway;
let situations: SituationEngine;

const TENANT_A = "tenant-sit-erase-a";
const OWNER = "person-tobias-sit-erase";

function identity(): IdentityContext {
  return {
    person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "business",
    session_id: `sess-${TENANT_A}`, device_id: "dev-sit-erase", channel: "api", auth_strength: "active"
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-sit-erasure-"));
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
  await adminPool.query("CREATE ROLE jarvis_sit_erasure_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sit_erasure_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Situations Erasure Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT_A}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sit_erasure_test", password: "pw2" });
  embedding = new LocalHashEmbedding();
  sovereignPolicy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A] }
  });
  situations = new SituationEngine(appPool, new DomainPauseRegistry());
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: en memory_space-scope erasure fjerner FULLSTENDIG situasjoner i det spacet, uten å røre et annet space, uten å røre notification-policyen", () => {
  it("executeErasure sletter situations for 'business', lar 'personal' og policy-raden stå urørt, uten FK-brudd", async () => {
    const sentinel = `SentinelSitEraseA${randomUUID().replace(/-/g, "")}`;
    const inBusiness = await situations.evaluateCandidate(TENANT_A, "business", {
      domain: "spend", detection_key: `spend:${sentinel}`, priority: "normal", reason: sentinel
    });
    const inPersonal = await situations.evaluateCandidate(TENANT_A, "personal", {
      domain: "home", detection_key: `home:${sentinel}`, priority: "normal", reason: sentinel
    });
    await situations.setNotificationPolicy(TENANT_A, "business", { resuppress_hours: 12 });

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const result = await service.executeErasure({
      scope: { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "business" },
      requestId: `req-sit-erase-${randomUUID()}`,
      identity: identity()
    });
    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.record_counts["situations"]).toBe(1);

    const goneById = await adminPool.query(`SELECT count(*)::int AS n FROM situations WHERE situation_id = $1`, [inBusiness.situation.situation_id]);
    expect((goneById.rows[0] as { n: number }).n).toBe(0);

    const stillThere = await adminPool.query(`SELECT count(*)::int AS n FROM situations WHERE situation_id = $1`, [inPersonal.situation.situation_id]);
    expect((stillThere.rows[0] as { n: number }).n).toBe(1);

    // Space-nivå notification-policyen overlever en memory_space-scope erasure uendret - policy-config, ikke hendelsesdata.
    const policy = await situations.getNotificationPolicy(TENANT_A, "business");
    expect(policy?.resuppress_hours).toBe(12);
  });
});

describe("B: idempotens - samme request_id kjørt to ganger gir samme resultat, ingen dobbel sletting", () => {
  it("andre kjøring er en idempotent replay med identiske record_counts", async () => {
    const sentinel = `SentinelSitEraseIdem${randomUUID().replace(/-/g, "")}`;
    await situations.evaluateCandidate(TENANT_A, "project", {
      domain: "infra", detection_key: `infra:${sentinel}`, priority: "normal", reason: sentinel
    });

    const service = new ErasureService(appPool, sovereignPolicy, embedding);
    const requestId = `req-sit-erase-idem-${randomUUID()}`;
    const scope = { type: "memory_space", tenant_id: TENANT_A, memory_space_id: "project" } as const;
    const id = identity();

    const first = await service.executeErasure({ scope, requestId, identity: id });
    expect(first.status).toBe("completed");
    expect(first.idempotent_replay).toBe(false);

    const second = await service.executeErasure({ scope, requestId, identity: id });
    expect(second.status).toBe("completed");
    expect(second.idempotent_replay).toBe(true);
    expect(second.record_counts).toEqual(first.record_counts);
  });
});
