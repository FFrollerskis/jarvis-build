import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { ProductService } from "../src/service.ts";
import { InvalidProductItemTransitionError } from "../src/state-machine.ts";

/**
 * UA-3 Native Jarvis Product Core (D-128): ekte Postgres/RLS-
 * integrasjonsbevis for `ProductService` - lifecycle/prioritering/
 * rapportør-kobling/tenant-/memory-space-isolasjon mot en EKTE
 * NOSUPERUSER/NOBYPASSRLS-rolle (samme mønster som
 * agreements/service-rls.test.ts, IKKE en `fakePool()`-mock).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: ProductService;

const TENANT_A = "tenant-prd-svc-a";
const TENANT_B = "tenant-prd-svc-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-product-svc-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_prd_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_prd_svc_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Product Svc A', 'business'), ('${TENANT_B}', 'Product Svc B', 'business')`
  );
  await adminPool.query(`INSERT INTO business_companies (company_id, tenant_id, name) VALUES ('co-prd-a', '${TENANT_A}', 'Acme AS')`);
  await adminPool.query(
    `INSERT INTO business_contacts (contact_id, tenant_id, company_id, name, email) VALUES ('ct-prd-a', '${TENANT_A}', 'co-prd-a', 'Kari', 'kari@acme.no')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-prd-owner', 'Owner One')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_prd_svc_test", password: "pw2" });
  service = new ProductService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: opprett produktpunkt", () => {
  it("createItem returnerer et gyldig punkt med default status/type/prioritet", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Test A" });
    expect(item.title).toBe("Test A");
    expect(item.status).toBe("new");
    expect(item.item_type).toBe("feature_request");
    expect(item.priority).toBe("normal");
  });
  it("oppretter et 'item_created'-event automatisk", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Test A2" });
    const events = await service.listEvents(TENANT_A, "business", item.item_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("item_created");
  });
});

describe("B: deterministisk punktnummer", () => {
  it("hvert nye punkt faar et strengt stigende, unikt item_number", async () => {
    const a = await service.createItem(TENANT_A, "business", { title: "Number A" });
    const b = await service.createItem(TENANT_A, "business", { title: "Number B" });
    expect(Number(b.item_number)).toBeGreaterThan(Number(a.item_number));
  });
});

describe("C: get/list/search", () => {
  it("getItem finner et opprettet punkt", async () => {
    const created = await service.createItem(TENANT_A, "business", { title: "Findable" });
    const found = await service.getItem(TENANT_A, "business", created.item_id);
    expect(found?.item_id).toBe(created.item_id);
  });
  it("searchItems filtrerer deterministisk paa title_contains", async () => {
    await service.createItem(TENANT_A, "business", { title: "Unique-Search-Marker-XYZ" });
    const rows = await service.searchItems(TENANT_A, "business", { title_contains: "Unique-Search-Marker-XYZ" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.title.includes("Unique-Search-Marker-XYZ"))).toBe(true);
  });
  it("searchItems filtrerer paa priority", async () => {
    const critical = await service.createItem(TENANT_A, "business", { title: "Critical item", priority: "critical" });
    const rows = await service.searchItems(TENANT_A, "business", { priority: "critical" });
    expect(rows.some((r) => r.item_id === critical.item_id)).toBe(true);
  });
});

describe("D: deterministisk lifecycle-overgang (state-machine haandheves i service-laget)", () => {
  it("gyldig kjede new -> triaged -> planned -> in_progress -> shipped fungerer og logges", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Transition" });
    await service.setStatus(TENANT_A, "business", item.item_id, "triaged");
    await service.setStatus(TENANT_A, "business", item.item_id, "planned");
    await service.setStatus(TENANT_A, "business", item.item_id, "in_progress");
    const shipped = await service.setStatus(TENANT_A, "business", item.item_id, "shipped");
    expect(shipped?.status).toBe("shipped");
    expect(shipped?.closed_at).not.toBeNull();
    const events = await service.listEvents(TENANT_A, "business", item.item_id);
    expect(events.filter((e) => e.event_type === "status_changed")).toHaveLength(4);
  });
  it("ugyldig overgang (new -> in_progress) kaster og endrer INGENTING", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Bad transition" });
    await expect(service.setStatus(TENANT_A, "business", item.item_id, "in_progress")).rejects.toThrow(InvalidProductItemTransitionError);
    const unchanged = await service.getItem(TENANT_A, "business", item.item_id);
    expect(unchanged?.status).toBe("new");
  });
  it("gjenaapning fra shipped nullstiller closed_at", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Reopen" });
    await service.setStatus(TENANT_A, "business", item.item_id, "triaged");
    await service.setStatus(TENANT_A, "business", item.item_id, "planned");
    await service.setStatus(TENANT_A, "business", item.item_id, "in_progress");
    await service.setStatus(TENANT_A, "business", item.item_id, "shipped");
    const reopened = await service.setStatus(TENANT_A, "business", item.item_id, "new");
    expect(reopened?.status).toBe("new");
    expect(reopened?.closed_at).toBeNull();
  });
});

describe("E: prioritering", () => {
  it("setPriority endrer prioritet og logger 'priority_changed'", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Priority" });
    const updated = await service.setPriority(TENANT_A, "business", item.item_id, "critical");
    expect(updated?.priority).toBe("critical");
    const events = await service.listEvents(TENANT_A, "business", item.item_id);
    expect(events.some((e) => e.event_type === "priority_changed")).toBe(true);
  });
});

describe("F: rapportør-kobling via eksisterende Business OS-entiteter", () => {
  it("linkReporter setter company_id/contact_id og logger 'reporter_linked'", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Reporter" });
    const updated = await service.linkReporter(TENANT_A, "business", item.item_id, "co-prd-a", "ct-prd-a");
    expect(updated?.company_id).toBe("co-prd-a");
    expect(updated?.contact_id).toBe("ct-prd-a");
    const events = await service.listEvents(TENANT_A, "business", item.item_id);
    expect(events.some((e) => e.event_type === "reporter_linked")).toBe(true);
  });
  it("listByCompany finner punkter rapportert av et selskap (\"What has company X reported?\")", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Company scoped", company_id: "co-prd-a" });
    const rows = await service.listByCompany(TENANT_A, "business", "co-prd-a");
    expect(rows.some((r) => r.item_id === item.item_id)).toBe(true);
  });
});

describe("G: eierskap", () => {
  it("setOwner setter/fjerner eier og logger 'owner_changed'", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Owner" });
    const withOwner = await service.setOwner(TENANT_A, "business", item.item_id, "person-prd-owner");
    expect(withOwner?.owner_person_id).toBe("person-prd-owner");
    const withoutOwner = await service.setOwner(TENANT_A, "business", item.item_id, null);
    expect(withoutOwner?.owner_person_id).toBeNull();
    const events = await service.listEvents(TENANT_A, "business", item.item_id);
    expect(events.filter((e) => e.event_type === "owner_changed")).toHaveLength(2);
  });
});

describe("H: punkt-tidslinje er separat fra audit_events", () => {
  it("listEvents returnerer punkt-spesifikke hendelser, ALDRI system-audit-radformat", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Timeline" });
    await service.setOwner(TENANT_A, "business", item.item_id, "person-prd-owner");
    const events = await service.listEvents(TENANT_A, "business", item.item_id);
    expect(events.some((e) => e.event_type === "item_created")).toBe(true);
    expect(events.some((e) => e.event_type === "owner_changed")).toBe(true);
    for (const e of events) expect(e.item_id).toBe(item.item_id);
  });
});

describe("K (arkitekt-review MERGE BLOCKER 1): samme-verdi-kall er EKTE no-op'er", () => {
  it("gjentatt setStatus med SAMME status skriver INGEN nytt event, INGEN ny updated_at, INGEN ny closed_at", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Same-status no-op" });
    await service.setStatus(TENANT_A, "business", item.item_id, "triaged");
    const before = await service.getItem(TENANT_A, "business", item.item_id);
    const eventsBefore = await service.listEvents(TENANT_A, "business", item.item_id);
    await new Promise((r) => setTimeout(r, 20));
    const after = await service.setStatus(TENANT_A, "business", item.item_id, "triaged");
    const eventsAfter = await service.listEvents(TENANT_A, "business", item.item_id);
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(before!.updated_at).getTime());
    expect(eventsAfter).toHaveLength(eventsBefore.length);
    expect(eventsAfter.filter((e) => e.event_type === "status_changed")).toHaveLength(1);
  });
  it("gjentatt SAMME terminal-status (shipped -> shipped) overskriver ALDRI den opprinnelige closed_at", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Same-terminal no-op" });
    await service.setStatus(TENANT_A, "business", item.item_id, "triaged");
    await service.setStatus(TENANT_A, "business", item.item_id, "planned");
    await service.setStatus(TENANT_A, "business", item.item_id, "in_progress");
    const shipped = await service.setStatus(TENANT_A, "business", item.item_id, "shipped");
    await new Promise((r) => setTimeout(r, 20));
    const shippedAgain = await service.setStatus(TENANT_A, "business", item.item_id, "shipped");
    expect(new Date(shippedAgain!.closed_at!).getTime()).toBe(new Date(shipped!.closed_at!).getTime());
  });
  it("gjentatt setPriority med SAMME prioritet skriver INGEN nytt event/ny updated_at", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Same-priority no-op", priority: "high" });
    const before = await service.getItem(TENANT_A, "business", item.item_id);
    const eventsBefore = await service.listEvents(TENANT_A, "business", item.item_id);
    await new Promise((r) => setTimeout(r, 20));
    const after = await service.setPriority(TENANT_A, "business", item.item_id, "high");
    const eventsAfter = await service.listEvents(TENANT_A, "business", item.item_id);
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(before!.updated_at).getTime());
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
  it("gjentatt setOwner med SAMME eier (inkl. null->null) skriver INGEN nytt event/ny updated_at", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Same-owner no-op" });
    const before = await service.getItem(TENANT_A, "business", item.item_id);
    const eventsBefore = await service.listEvents(TENANT_A, "business", item.item_id);
    await new Promise((r) => setTimeout(r, 20));
    const after = await service.setOwner(TENANT_A, "business", item.item_id, null);
    const eventsAfter = await service.listEvents(TENANT_A, "business", item.item_id);
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(before!.updated_at).getTime());
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
  it("gjentatt linkReporter med SAMME company_id/contact_id skriver INGEN nytt event/ny updated_at", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Same-reporter no-op" });
    await service.linkReporter(TENANT_A, "business", item.item_id, "co-prd-a", "ct-prd-a");
    const before = await service.getItem(TENANT_A, "business", item.item_id);
    const eventsBefore = await service.listEvents(TENANT_A, "business", item.item_id);
    await new Promise((r) => setTimeout(r, 20));
    const after = await service.linkReporter(TENANT_A, "business", item.item_id, "co-prd-a", "ct-prd-a");
    const eventsAfter = await service.listEvents(TENANT_A, "business", item.item_id);
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(before!.updated_at).getTime());
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
});

describe("I/J: tenant-/memory-space-isolasjon (RLS)", () => {
  it("I: TENANT_B ser ALDRI TENANT_A sine produktpunkter", async () => {
    const itemA = await service.createItem(TENANT_A, "business", { title: "Isolation A" });
    const foundFromB = await service.getItem(TENANT_B, "business", itemA.item_id);
    expect(foundFromB).toBeNull();
    const listB = await service.listItems(TENANT_B, "business", "all");
    expect(listB.some((i) => i.item_id === itemA.item_id)).toBe(false);
  });
  it("J: et punkt i memory_space 'business' er usynlig fra 'personal'-space-kontekst for samme tenant", async () => {
    const item = await service.createItem(TENANT_A, "business", { title: "Space isolation" });
    const foundInPersonal = await service.getItem(TENANT_A, "personal", item.item_id);
    expect(foundInPersonal).toBeNull();
  });
});
