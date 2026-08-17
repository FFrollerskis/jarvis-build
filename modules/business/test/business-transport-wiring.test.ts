import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { BusinessInternalSecretProvider, BusinessService, BusinessTransport } from "../src/index.ts";

/**
 * UA-3 P0: bevis at Business Graph-verktøyene er korrekt registrert og
 * FAKTISK kjører gjennom den EKSISTERENDE, generiske ToolGateway/Policy
 * Gateway-pipelinen (autorisasjon/audit/idempotens) - ingen egen, parallell
 * sikkerhetsmodell for Business OS. Dekker §30 O (owner sovereign),
 * P (delegert policy trygg), N (ingen sensitivt innhold i audit-payload).
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let toolGateway: ToolGateway;

const TENANT = "tenant-biz-wiring";
const ownerIdentity: IdentityContext = {
  person_id: "person-tobias", tenant_id: TENANT, memory_space_id: "business",
  session_id: "sess-owner", device_id: "dev-owner", channel: "api", auth_strength: "active"
};
const delegateIdentity: IdentityContext = {
  person_id: "person-delegate", tenant_id: TENANT, memory_space_id: "business",
  session_id: "sess-delegate", device_id: "dev-delegate", channel: "api", auth_strength: "active",
  delegation_id: "deleg-1"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-business-wiring-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_business_wiring_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_business_wiring_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Wiring Test','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias'), ('person-delegate','Delegate');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}'), ('person-delegate','${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-wiring-business','${TENANT}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_business_wiring_test", password: "pw2" });

  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT] }
  });
  toolGateway = new ToolGateway(
    appPool, policy,
    new FallbackSecretProvider(
      { name: "env-empty", get: async () => null },
      new BusinessInternalSecretProvider()
    )
  );
  const service = new BusinessService(appPool);
  for (const tool of firstWaveTools({ business: new BusinessTransport(service) })) toolGateway.register(tool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("registrering: alle 13 business-handlinger er registrert med riktig risikoklasse", () => {
  it("A-klasse for lesing, B for enkle reversible skrivinger, C for tilstandsoverganger - ingen D i dette sliceet", () => {
    const defs = firstWaveTools({});
    const business = new Map(defs.filter((d) => d.tool_id === "business").map((d) => [d.action, d.capability_class]));
    expect(business.size).toBe(13);
    expect(business.get("create_company")).toBe("B");
    expect(business.get("create_contact")).toBe("B");
    expect(business.get("create_lead")).toBe("B");
    expect(business.get("update_lead_status")).toBe("C");
    expect(business.get("create_opportunity")).toBe("B");
    expect(business.get("update_opportunity_stage")).toBe("C");
    expect(business.get("record_activity")).toBe("B");
    expect(business.get("read_company_timeline")).toBe("A");
    expect(business.get("create_followup")).toBe("B");
    expect(business.get("complete_followup")).toBe("C");
    expect(business.get("cancel_followup")).toBe("C");
    expect(business.get("list_overdue_followups")).toBe("A");
    expect(business.get("read_metrics")).toBe("A");
    expect([...business.values()]).not.toContain("D");
  });
});

describe("O: owner sovereign policy - full autonom utførelse, ingen approval-friksjon", () => {
  it("owner sin capability_class C-handling (update_opportunity_stage) kjører uten approval under SOVEREIGN authority", async () => {
    const create = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "create_opportunity",
      parameters: { tenant_id: TENANT, memory_space: "business", title: "Sovereign-test" }
    });
    expect(create.ok).toBe(true);
    const opportunityId = create.ok ? create.external_id : undefined;
    const result = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "update_opportunity_stage",
      parameters: { tenant_id: TENANT, memory_space: "business", opportunity_id: opportunityId as string, stage: "won" }
    });
    expect(result.ok).toBe(true);
  });
});

describe("P: delegert policy forblir trygg - ingen implisitt owner-autoritet", () => {
  it("en delegat (delegation_id satt) faar IKKE class-C-handlinger autonomt uten mandat/approval - identisk EKSISTERENDE PolicyGateway-regel, ikke ny logikk", async () => {
    const result = await toolGateway.execute({
      identity: delegateIdentity, tool_id: "business", action: "update_opportunity_stage",
      parameters: { tenant_id: TENANT, memory_space: "business", opportunity_id: "biz-op-nonexistent", stage: "won" }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("class_c_no_mandate");
    }
  });

  it("en delegat FAAR likevel class-A-lesing (read_metrics) - lesing er alltid tillatt, uavhengig av mandate", async () => {
    const result = await toolGateway.execute({
      identity: delegateIdentity, tool_id: "business", action: "read_metrics",
      parameters: { tenant_id: TENANT, memory_space: "business" }
    });
    expect(result.ok).toBe(true);
  });
});

describe("N: audit-metadata inneholder aldri sensitivt kundeinnhold", () => {
  it("audit_events.payload for create_contact inneholder KUN credential_ref/external_id/scopes/rollback - aldri navn/e-post/telefon", async () => {
    const result = await toolGateway.execute({
      identity: ownerIdentity, tool_id: "business", action: "create_contact",
      parameters: { tenant_id: TENANT, memory_space: "business", name: "Sensitiv Person", email: "sensitiv@eksempel.no", phone: "+4712345678" }
    });
    expect(result.ok).toBe(true);
    const { rows } = await adminPool.query(
      "SELECT payload FROM audit_events WHERE tenant_id = $1 AND tool_id = 'business' AND action = 'create_contact' ORDER BY at DESC LIMIT 1",
      [TENANT]
    );
    const payload = JSON.stringify((rows[0] as { payload: unknown }).payload);
    expect(payload).not.toContain("Sensitiv Person");
    expect(payload).not.toContain("sensitiv@eksempel.no");
    expect(payload).not.toContain("+4712345678");
  });
});
