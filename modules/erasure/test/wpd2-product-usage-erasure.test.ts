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
import { BusinessService, OpenLoopService, ProductUsageService } from "@jarvis/business";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";

/**
 * WP-D2 (090): produktbruk, kontoer, churn-vurderinger og churn-loops følger Q-20-slettingen av memory space «business» - med den runtime-rollen som faktisk kjører
 * (NOSUPERUSER/NOBYPASSRLS). Beviser også at en situasjon som peker på churn-loopen ikke blokkerer sletting (rekkefølge), at konto-pseudonymene ikke overlever noe sted,
 * og at en annen tenants data er urørt.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let usage: ProductUsageService;
let business: BusinessService;
let loops: OpenLoopService;
let erasure: ErasureService;
const A = "tenant-wpd2-ue-a";
const B = "tenant-wpd2-ue-b";
const OWNER = "person-tobias";
const SENTINEL_ACCT = `acct-sentinel-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const SENTINEL_USER = `usr_sentinel${randomUUID().replace(/-/g, "").slice(0, 10)}`;

const identityFor = (tenantId: string): IdentityContext => ({
  person_id: OWNER, tenant_id: tenantId, memory_space_id: "business", session_id: `sess-${tenantId}`, device_id: "dev-wpd2-ue", channel: "api", auth_strength: "active"
});

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd2-usage-erasure-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpd2_ue LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpd2_ue");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}','Ue A','business'), ('${B}','Ue B','business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${A}'), ('${OWNER}','${B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-wpd2-ue-a','${A}','business'), ('ms-wpd2-ue-b','${B}','business');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd2_ue", password: "pw2" });
  usage = new ProductUsageService(app);
  business = new BusinessService(app);
  loops = new OpenLoopService(app);
  erasure = new ErasureService(app, new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER, owner_tenants: [A, B] }
  }), new LocalHashEmbedding());
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const n = async (sql: string, params: unknown[] = []) => ((await admin.query(sql, params)).rows[0] as { n: number }).n;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000 - 60_000).toISOString();

async function seed(tenant: string, account: string, userRef: string): Promise<{ companyId: string; loopId: string }> {
  const company = await business.createCompany(tenant, "business", { name: `Kunde ${tenant}` });
  const lines = [40, 38, 36, 35].map((d, i) => JSON.stringify({ event_id: `${tenant.slice(-1)}-ue-evt-0000${i}`, account_ref: account, user_ref: userRef, feature: "chat.send", quantity: 2, occurred_at: ago(d) }));
  lines.push(JSON.stringify({ event_id: `${tenant.slice(-1)}-ue-bill-0001`, kind: "billing_status", account_ref: account, quantity: 2, occurred_at: ago(3) }));
  await usage.importText(tenant, "jsonl", "seed", lines.join("\n"), { actor_person_id: OWNER });
  await usage.linkAccount(tenant, "business", account, company.company_id, OWNER);
  await loops.detectChurnRisk(tenant, "business");
  const loop = (await loops.listOpenLoops(tenant, "business", "open")).find((l) => l.loop_type === "customer_churn_risk");
  if (!loop) throw new Error("seed: forventet en churn-loop");
  // en situasjon som peker på churn-loopen (056: sammensatt FK) - skal ikke blokkere slettingen
  await admin.query(
    `INSERT INTO situations (situation_id, tenant_id, memory_space_id, domain, source_open_loop_id, detection_key, reason)
     VALUES ($1, $2, 'business', 'retention', $3, $4, $5)`,
    [`sit-ue-${tenant}`, tenant, loop.open_loop_id, `open_loop:${loop.detection_key}`, loop.reason]
  );
  return { companyId: company.company_id, loopId: loop.open_loop_id };
}

describe("produktbruk + churn og Q-20-erasure", () => {
  it("memory-space-sletting fjerner hendelser, kontoer, vurderinger, churn-loops og situasjonen som peker på dem - og ingenting hos en annen tenant", async () => {
    await seed(A, SENTINEL_ACCT, SENTINEL_USER);
    await seed(B, "acct-keep-b-0001", "usr_keepb00001");
    const tables = ["product_usage_events", "product_usage_accounts", "business_churn_assessments"];
    for (const t of tables) expect(await n(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [A]), t).toBeGreaterThan(0);
    expect(await n("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND loop_type = 'customer_churn_risk'", [A])).toBe(1);
    expect(await n("SELECT count(*)::int AS n FROM situations WHERE tenant_id = $1", [A])).toBe(1);
    const bBefore = await Promise.all(tables.map((t) => n(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [B])));
    // pseudonymene finnes i dag i revisjonsloggen? (aldri: kun tellere) - og i loop-nøkkelen
    expect(await n("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND detection_key LIKE $2", [A, `%${SENTINEL_ACCT}%`])).toBe(1);

    const result = await erasure.executeErasure({
      scope: { type: "memory_space", tenant_id: A, memory_space_id: "business" },
      requestId: `req-wpd2-use-${randomUUID()}`,
      identity: identityFor(A)
    });
    expect(result.status).toBe("completed");

    for (const t of tables) expect(await n(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [A]), t).toBe(0);
    expect(await n("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND loop_type = 'customer_churn_risk'", [A])).toBe(0);
    expect(await n("SELECT count(*)::int AS n FROM situations WHERE tenant_id = $1", [A])).toBe(0);
    // ingen rest av pseudonymene i NOEN tabell vi vet kan bære dem
    expect(await n("SELECT count(*)::int AS n FROM business_open_loops WHERE detection_key LIKE $1 OR reason LIKE $1", [`%${SENTINEL_ACCT}%`])).toBe(0);
    expect(await n("SELECT count(*)::int AS n FROM audit_events WHERE payload::text LIKE $1 OR payload::text LIKE $2", [`%${SENTINEL_ACCT}%`, `%${SENTINEL_USER}%`])).toBe(0);
    // annen tenant urørt
    const bAfter = await Promise.all(tables.map((t) => n(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [B])));
    expect(bAfter).toEqual(bBefore);
    expect(await n("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND loop_type = 'customer_churn_risk'", [B])).toBe(1);
    expect(await n("SELECT count(*)::int AS n FROM situations WHERE tenant_id = $1", [B])).toBe(1);
  });

  it("etter sletting kan samme tenant ta imot og vurdere nye data (ingen rester som blokkerer)", async () => {
    const company = await business.createCompany(A, "business", { name: "Etterpå AS" });
    await usage.importText(A, "jsonl", "after", JSON.stringify({ event_id: "after-erasure-0001", account_ref: SENTINEL_ACCT, feature: "chat.send", occurred_at: ago(2) }), { actor_person_id: OWNER });
    await usage.linkAccount(A, "business", SENTINEL_ACCT, company.company_id, OWNER);
    const sweep = await loops.detectChurnRisk(A, "business");
    expect(sweep).toBeDefined();
    expect(await n("SELECT count(*)::int AS n FROM product_usage_events WHERE tenant_id = $1", [A])).toBe(1);
  });
});
