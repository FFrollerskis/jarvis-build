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
import { BusinessPipelineService } from "@jarvis/business";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";

/**
 * WP-D2 (089_business_pipeline_writes.sql, Q-20): `business_change_log` holder KOPIER av lead-/opportunity-felt (tittel, neste handling, lukkegrunn) og skal
 * følge memory-space-slettingen - med nøyaktig den runtime-rollen som faktisk kjører (NOSUPERUSER/NOBYPASSRLS). Beviser også at tabellen er uforanderlig for
 * runtime (ingen UPDATE) og at en annen tenants logg ikke berøres.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let pipeline: BusinessPipelineService;
let erasure: ErasureService;
const A = "tenant-wpd2-er-a";
const B = "tenant-wpd2-er-b";

const identityFor = (tenantId: string): IdentityContext => ({
  person_id: "person-tobias", tenant_id: tenantId, memory_space_id: "business", session_id: `sess-${tenantId}`, device_id: "dev-wpd2-er", channel: "api", auth_strength: "active"
});

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd2-erasure-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpd2_er LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpd2_er");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}','Er A','business'), ('${B}','Er B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${A}'), ('person-tobias','${B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-wpd2-er-a','${A}','business'), ('ms-wpd2-er-b','${B}','business');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd2_er", password: "pw2" });
  pipeline = new BusinessPipelineService(app);
  erasure = new ErasureService(app, new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [A, B] }
  }), new LocalHashEmbedding());
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const logCount = async (tenant: string) => ((await admin.query("SELECT count(*)::int AS n FROM business_change_log WHERE tenant_id = $1", [tenant])).rows[0] as { n: number }).n;

describe("business_change_log og Q-20-erasure", () => {
  it("runtime kan ikke endre (UPDATE) eller slette utenfor erasure-kontekst uten RLS-treff; raden er uforanderlig for appen", async () => {
    await pipeline.createLead(A, "business", { title: "Uforanderlig" }, { actor_person_id: "person-tobias" });
    await expect(app.query("UPDATE business_change_log SET action = 'update'")).rejects.toThrow(/permission denied/);
    // DELETE er gitt (kun for erasure), men uten tenant-kontekst treffer RLS ingen rader
    const del = await app.query("DELETE FROM business_change_log");
    expect(del.rowCount).toBe(0);
    expect(await logCount(A)).toBeGreaterThan(0);
  });

  it("executeErasure av memory space business fjerner change-loggen (inkl. før-tilstanden med tittel) - og berører ikke en annen tenant", async () => {
    const sentinel = `SentinelChg${randomUUID().replace(/-/g, "")}`;
    const lead = (await pipeline.createLead(A, "business", { title: sentinel }, { actor_person_id: "person-tobias" })).entity as unknown as { lead_id: string };
    await pipeline.updateLead(A, "business", lead.lead_id, { title: `${sentinel} v2` }, { actor_person_id: "person-tobias" });
    await pipeline.deleteLead(A, "business", lead.lead_id, { actor_person_id: "person-tobias" });
    await pipeline.createLead(B, "business", { title: "Annen tenant beholdes" }, { actor_person_id: "person-tobias" });
    expect((await admin.query("SELECT count(*)::int AS n FROM business_change_log WHERE before_state::text LIKE $1 OR after_state::text LIKE $1", [`%${sentinel}%`])).rows[0]).toEqual({ n: 3 });
    const bBefore = await logCount(B);

    const result = await erasure.executeErasure({
      scope: { type: "memory_space", tenant_id: A, memory_space_id: "business" },
      requestId: `req-wpd2-chg-${randomUUID()}`,
      identity: identityFor(A)
    });
    expect(result.status).toBe("completed");
    expect(await logCount(A)).toBe(0);
    // ingen rest av sentinelen i noen change-rad (før/etter-tilstanden bar tittelen)
    expect((await admin.query("SELECT count(*)::int AS n FROM business_change_log WHERE before_state::text LIKE $1 OR after_state::text LIKE $1", [`%${sentinel}%`])).rows[0]).toEqual({ n: 0 });
    expect(await logCount(B)).toBe(bBefore);
  });
});
