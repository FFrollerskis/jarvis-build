import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { OperationsContactCompanyMismatchError, OperationsCrossScopeReferenceError, OperationsService } from "../src/service.ts";

/**
 * Arkitekt-review MERGE BLOCKER (D-129, PR #78, review 5148211856): en enkel
 * FK på en global ID er IKKE en tenant/space-autorisasjonsgrense - RLS
 * beskytter LESING/SKRIVING av EGNE rader, men en FK-sjekk kjører med
 * forhøyet privilegium og omgår RLS, saa et FK-maal fra en ANNEN
 * tenant/space ville blitt akseptert stille (skjulte cross-tenant/
 * cross-space-relasjoner + senere FK-blokkert erasure).
 *
 * Denne testmatrisen beviser BEGGE håndhevingslag mot EKTE embedded
 * Postgres/NOSUPERUSER NOBYPASSRLS: (a) `048_operations.sql` sine
 * sammensatte `(tenant_id, memory_space_id, id)`-fremmednøkler (operations-
 * eide relasjoner: vendor/runbook/task) OG (b) `OperationsService` sine
 * eksplisitte, deterministiske tjenestelags-vakter (BEGGE de
 * operations-eide relasjonene OG Business Graph company/contact-koblingen,
 * som IKKE har en sammensatt nøkkel - se D-129 i
 * DECISIONS_AND_ASSUMPTIONS.md). Hver avvist mutasjon MAA vaere ATOMISK:
 * ingen delvis rad, ingen event, ingen `updated_at`-endring.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let operations: OperationsService;

const TENANT_A = "tenant-ops-scope-a";
const TENANT_B = "tenant-ops-scope-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-ops-scope-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_ops_scope_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_ops_scope_test");

  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','Ops Scope A','business'), ('${TENANT_B}','Ops Scope B','business');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-a-business','${TENANT_A}','business'), ('ms-a-personal','${TENANT_A}','personal'), ('ms-b-business','${TENANT_B}','business');
    INSERT INTO business_companies (company_id, tenant_id, memory_space_id, name) VALUES
      ('co-scope-a-biz','${TENANT_A}','business','A Biz Co'),
      ('co-scope-a-biz-2','${TENANT_A}','business','A Biz Co 2'),
      ('co-scope-a-personal','${TENANT_A}','personal','A Personal Co'),
      ('co-scope-b','${TENANT_B}','business','B Co');
    INSERT INTO business_contacts (contact_id, tenant_id, memory_space_id, company_id, name) VALUES
      ('ct-scope-a-biz','${TENANT_A}','business','co-scope-a-biz','A Biz Contact'),
      ('ct-scope-a-biz-other','${TENANT_A}','business','co-scope-a-biz-2','A Biz Contact Other Company'),
      ('ct-scope-a-personal','${TENANT_A}','personal',NULL,'A Personal Contact'),
      ('ct-scope-b','${TENANT_B}','business',NULL,'B Contact');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_ops_scope_test", password: "pw2" });
  operations = new OperationsService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: cross-tenant vendor-referanse avvises deterministisk, ingen rad opprettes", () => {
  it("runbook i tenant B kan IKKE bruke en vendor-ID fra tenant A", async () => {
    const vendor = await operations.createVendor(TENANT_A, "business", { name: "Cross-tenant vendor target" });
    await expect(
      operations.createRunbook(TENANT_B, "business", { title: "Cross-tenant runbook", content: "...", vendor_id: vendor.vendor_id })
    ).rejects.toThrow(OperationsCrossScopeReferenceError);
    const runbooksB = await operations.listRunbooks(TENANT_B, "business", false);
    expect(runbooksB.some((r) => r.title === "Cross-tenant runbook")).toBe(false);
  });
  it("task i tenant B kan IKKE bruke en vendor-ID fra tenant A", async () => {
    const vendor = await operations.createVendor(TENANT_A, "business", { name: "Cross-tenant vendor target 2" });
    await expect(
      operations.createTask(TENANT_B, "business", { title: "Cross-tenant task", vendor_id: vendor.vendor_id })
    ).rejects.toThrow(OperationsCrossScopeReferenceError);
    const tasksB = await operations.listTasks(TENANT_B, "business", "all");
    expect(tasksB.some((t) => t.title === "Cross-tenant task")).toBe(false);
  });
});

describe("B: cross-memory-space vendor-referanse avvises deterministisk (samme tenant)", () => {
  it("runbook i 'personal' kan IKKE bruke en vendor-ID fra 'business' (samme tenant A)", async () => {
    const vendor = await operations.createVendor(TENANT_A, "business", { name: "Cross-space vendor target" });
    await expect(
      operations.createRunbook(TENANT_A, "personal", { title: "Cross-space runbook", content: "...", vendor_id: vendor.vendor_id })
    ).rejects.toThrow(OperationsCrossScopeReferenceError);
    const runbooksPersonal = await operations.listRunbooks(TENANT_A, "personal", false);
    expect(runbooksPersonal.some((r) => r.title === "Cross-space runbook")).toBe(false);
  });
  it("task i 'personal' kan IKKE bruke en vendor-ID fra 'business' (samme tenant A)", async () => {
    const vendor = await operations.createVendor(TENANT_A, "business", { name: "Cross-space vendor target 2" });
    await expect(
      operations.createTask(TENANT_A, "personal", { title: "Cross-space task", vendor_id: vendor.vendor_id })
    ).rejects.toThrow(OperationsCrossScopeReferenceError);
    const tasksPersonal = await operations.listTasks(TENANT_A, "personal", "all");
    expect(tasksPersonal.some((t) => t.title === "Cross-space task")).toBe(false);
  });
});

describe("C: cross-tenant runbook-referanse avvises deterministisk", () => {
  it("task i tenant B kan IKKE bruke en runbook-ID fra tenant A", async () => {
    const runbook = await operations.createRunbook(TENANT_A, "business", { title: "Runbook target cross-tenant", content: "..." });
    await expect(
      operations.createTask(TENANT_B, "business", { title: "Cross-tenant runbook task", runbook_id: runbook.runbook_id })
    ).rejects.toThrow(OperationsCrossScopeReferenceError);
    const tasksB = await operations.listTasks(TENANT_B, "business", "all");
    expect(tasksB.some((t) => t.title === "Cross-tenant runbook task")).toBe(false);
  });
});

describe("D: cross-memory-space runbook-referanse avvises deterministisk (samme tenant)", () => {
  it("task i 'personal' kan IKKE bruke en runbook-ID fra 'business' (samme tenant A)", async () => {
    const runbook = await operations.createRunbook(TENANT_A, "business", { title: "Runbook target cross-space", content: "..." });
    await expect(
      operations.createTask(TENANT_A, "personal", { title: "Cross-space runbook task", runbook_id: runbook.runbook_id })
    ).rejects.toThrow(OperationsCrossScopeReferenceError);
    const tasksPersonal = await operations.listTasks(TENANT_A, "personal", "all");
    expect(tasksPersonal.some((t) => t.title === "Cross-space runbook task")).toBe(false);
  });
});

describe("E: linkVendor avviser cross-tenant/cross-space, ingen update/event (atomisk)", () => {
  it("cross-tenant: linkVendor mot en tenant-A-vendor fra tenant B feiler, task.vendor_id/updated_at/events uendret", async () => {
    const vendor = await operations.createVendor(TENANT_A, "business", { name: "LinkVendor cross-tenant target" });
    const task = await operations.createTask(TENANT_B, "business", { title: "LinkVendor cross-tenant task" });
    const eventsBefore = await operations.listTaskEvents(TENANT_B, "business", task.task_id);
    await expect(operations.linkVendor(TENANT_B, "business", task.task_id, vendor.vendor_id)).rejects.toThrow(OperationsCrossScopeReferenceError);
    const after = await operations.getTask(TENANT_B, "business", task.task_id);
    expect(after?.vendor_id).toBeNull();
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(task.updated_at).getTime());
    const eventsAfter = await operations.listTaskEvents(TENANT_B, "business", task.task_id);
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
  it("cross-space: linkVendor mot en 'business'-vendor fra 'personal' (samme tenant A) feiler, task uendret", async () => {
    const vendor = await operations.createVendor(TENANT_A, "business", { name: "LinkVendor cross-space target" });
    const task = await operations.createTask(TENANT_A, "personal", { title: "LinkVendor cross-space task" });
    const eventsBefore = await operations.listTaskEvents(TENANT_A, "personal", task.task_id);
    await expect(operations.linkVendor(TENANT_A, "personal", task.task_id, vendor.vendor_id)).rejects.toThrow(OperationsCrossScopeReferenceError);
    const after = await operations.getTask(TENANT_A, "personal", task.task_id);
    expect(after?.vendor_id).toBeNull();
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(task.updated_at).getTime());
    const eventsAfter = await operations.listTaskEvents(TENANT_A, "personal", task.task_id);
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
});

describe("F: linkRunbook avviser cross-tenant/cross-space, ingen update/event (atomisk)", () => {
  it("cross-tenant: linkRunbook mot en tenant-A-runbook fra tenant B feiler, task uendret", async () => {
    const runbook = await operations.createRunbook(TENANT_A, "business", { title: "LinkRunbook cross-tenant target", content: "..." });
    const task = await operations.createTask(TENANT_B, "business", { title: "LinkRunbook cross-tenant task" });
    const eventsBefore = await operations.listTaskEvents(TENANT_B, "business", task.task_id);
    await expect(operations.linkRunbook(TENANT_B, "business", task.task_id, runbook.runbook_id)).rejects.toThrow(OperationsCrossScopeReferenceError);
    const after = await operations.getTask(TENANT_B, "business", task.task_id);
    expect(after?.runbook_id).toBeNull();
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(task.updated_at).getTime());
    const eventsAfter = await operations.listTaskEvents(TENANT_B, "business", task.task_id);
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
  it("cross-space: linkRunbook mot en 'business'-runbook fra 'personal' (samme tenant A) feiler, task uendret", async () => {
    const runbook = await operations.createRunbook(TENANT_A, "business", { title: "LinkRunbook cross-space target", content: "..." });
    const task = await operations.createTask(TENANT_A, "personal", { title: "LinkRunbook cross-space task" });
    const eventsBefore = await operations.listTaskEvents(TENANT_A, "personal", task.task_id);
    await expect(operations.linkRunbook(TENANT_A, "personal", task.task_id, runbook.runbook_id)).rejects.toThrow(OperationsCrossScopeReferenceError);
    const after = await operations.getTask(TENANT_A, "personal", task.task_id);
    expect(after?.runbook_id).toBeNull();
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(task.updated_at).getTime());
    const eventsAfter = await operations.listTaskEvents(TENANT_A, "personal", task.task_id);
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
});

describe("G: Business Graph company/contact-koblingen avviser cross-tenant/cross-space/feil-selskap deterministisk", () => {
  it("cross-tenant company avvises, ingen vendor-rad opprettes", async () => {
    await expect(
      operations.createVendor(TENANT_B, "business", { name: "Reject cross-tenant company", company_id: "co-scope-a-biz" })
    ).rejects.toThrow(OperationsCrossScopeReferenceError);
    const vendorsB = await operations.listVendors(TENANT_B, "business", "all");
    expect(vendorsB.some((v) => v.name === "Reject cross-tenant company")).toBe(false);
  });
  it("cross-space company avvises (samme tenant A, 'personal' prøver en 'business'-company)", async () => {
    await expect(
      operations.createVendor(TENANT_A, "personal", { name: "Reject cross-space company", company_id: "co-scope-a-biz" })
    ).rejects.toThrow(OperationsCrossScopeReferenceError);
    const vendorsPersonal = await operations.listVendors(TENANT_A, "personal", "all");
    expect(vendorsPersonal.some((v) => v.name === "Reject cross-space company")).toBe(false);
  });
  it("cross-tenant contact avvises, ingen vendor-rad opprettes", async () => {
    await expect(
      operations.createVendor(TENANT_B, "business", { name: "Reject cross-tenant contact", contact_id: "ct-scope-a-biz" })
    ).rejects.toThrow(OperationsCrossScopeReferenceError);
    const vendorsB = await operations.listVendors(TENANT_B, "business", "all");
    expect(vendorsB.some((v) => v.name === "Reject cross-tenant contact")).toBe(false);
  });
  it("cross-space contact avvises (samme tenant A, 'personal' prøver en 'business'-contact)", async () => {
    await expect(
      operations.createVendor(TENANT_A, "personal", { name: "Reject cross-space contact", contact_id: "ct-scope-a-biz" })
    ).rejects.toThrow(OperationsCrossScopeReferenceError);
    const vendorsPersonal = await operations.listVendors(TENANT_A, "personal", "all");
    expect(vendorsPersonal.some((v) => v.name === "Reject cross-space contact")).toBe(false);
  });
  it("company A + en contact som faktisk tilhører company B avvises deterministisk (ingen vendor-rad)", async () => {
    await expect(
      operations.createVendor(TENANT_A, "business", {
        name: "Reject mismatched contact-company", company_id: "co-scope-a-biz", contact_id: "ct-scope-a-biz-other"
      })
    ).rejects.toThrow(OperationsContactCompanyMismatchError);
    const vendorsA = await operations.listVendors(TENANT_A, "business", "all");
    expect(vendorsA.some((v) => v.name === "Reject mismatched contact-company")).toBe(false);
  });
  it("gyldig company + dens FAKTISKE contact lykkes (positiv kontrolltest for G)", async () => {
    const vendor = await operations.createVendor(TENANT_A, "business", {
      name: "Valid company+contact", company_id: "co-scope-a-biz", contact_id: "ct-scope-a-biz"
    });
    expect(vendor.company_id).toBe("co-scope-a-biz");
    expect(vendor.contact_id).toBe("ct-scope-a-biz");
  });
});

describe("I (nummerert som i byggeordren, §9): gyldig same-tenant/same-space vendor -> runbook -> task fortsatt PASS", () => {
  it("hele kjeden vendor -> runbook(vendor) -> task(vendor+runbook) lykkes naar alt er i SAMME tenant+space", async () => {
    const vendor = await operations.createVendor(TENANT_A, "business", { name: "Valid chain vendor" });
    const runbook = await operations.createRunbook(TENANT_A, "business", { title: "Valid chain runbook", content: "...", vendor_id: vendor.vendor_id });
    const task = await operations.createTask(TENANT_A, "business", {
      title: "Valid chain task", vendor_id: vendor.vendor_id, runbook_id: runbook.runbook_id
    });
    expect(task.vendor_id).toBe(vendor.vendor_id);
    expect(task.runbook_id).toBe(runbook.runbook_id);
    const linked = await operations.linkVendor(TENANT_A, "business", task.task_id, vendor.vendor_id);
    expect(linked?.vendor_id).toBe(vendor.vendor_id); // same-value no-op, ikke en cross-scope-avvisning
  });
});
