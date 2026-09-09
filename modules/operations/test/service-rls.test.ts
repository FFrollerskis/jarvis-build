import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { OperationsService } from "../src/service.ts";
import { InvalidOperationsTaskTransitionError } from "../src/state-machine.ts";

/**
 * UA-3 Native Jarvis Operations Core (D-129): ekte Postgres/RLS-
 * integrasjonsbevis for `OperationsService` - leverandør-/runbook-
 * /driftsoppgave-lifecycle/eskalering/tenant-/memory-space-isolasjon mot en
 * EKTE NOSUPERUSER/NOBYPASSRLS-rolle (samme mønster som
 * product/service-rls.test.ts, IKKE en `fakePool()`-mock).
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: OperationsService;

const TENANT_A = "tenant-ops-svc-a";
const TENANT_B = "tenant-ops-svc-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-operations-svc-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_ops_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_ops_svc_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Operations Svc A', 'business'), ('${TENANT_B}', 'Operations Svc B', 'business')`
  );
  await adminPool.query(`INSERT INTO business_companies (company_id, tenant_id, name) VALUES ('co-ops-a', '${TENANT_A}', 'Acme AS')`);
  await adminPool.query(
    `INSERT INTO business_contacts (contact_id, tenant_id, company_id, name, email) VALUES ('ct-ops-a', '${TENANT_A}', 'co-ops-a', 'Kari', 'kari@acme.no')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-ops-owner', 'Owner One'), ('person-ops-escalation', 'Escalation Contact')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_ops_svc_test", password: "pw2" });
  service = new OperationsService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: leverandører (suppliers)", () => {
  it("createVendor returnerer en gyldig leverandør med default kategori/status", async () => {
    const vendor = await service.createVendor(TENANT_A, "business", { name: "Leverandør A" });
    expect(vendor.name).toBe("Leverandør A");
    expect(vendor.category).toBe("general");
    expect(vendor.status).toBe("active");
  });
  it("createVendor kan kobles til eksisterende Business OS company/contact + eskaleringskontakt", async () => {
    const vendor = await service.createVendor(TENANT_A, "business", {
      name: "Koblet leverandør", company_id: "co-ops-a", contact_id: "ct-ops-a", escalation_contact_person_id: "person-ops-escalation"
    });
    expect(vendor.company_id).toBe("co-ops-a");
    expect(vendor.contact_id).toBe("ct-ops-a");
    expect(vendor.escalation_contact_person_id).toBe("person-ops-escalation");
  });
  it("setVendorStatus endrer status, gjentatt SAMME status er en EKTE no-op (ingen ny updated_at)", async () => {
    const vendor = await service.createVendor(TENANT_A, "business", { name: "Status test" });
    const inactive = await service.setVendorStatus(TENANT_A, "business", vendor.vendor_id, "inactive");
    expect(inactive?.status).toBe("inactive");
    await new Promise((r) => setTimeout(r, 20));
    const again = await service.setVendorStatus(TENANT_A, "business", vendor.vendor_id, "inactive");
    expect(new Date(again!.updated_at).getTime()).toBe(new Date(inactive!.updated_at).getTime());
  });
  it("listVendors default filtrerer paa active, 'all' viser alle", async () => {
    const active = await service.createVendor(TENANT_A, "business", { name: "Active vendor" });
    const inactive = await service.createVendor(TENANT_A, "business", { name: "Inactive vendor" });
    await service.setVendorStatus(TENANT_A, "business", inactive.vendor_id, "inactive");
    const activeList = await service.listVendors(TENANT_A, "business", "active");
    expect(activeList.some((v) => v.vendor_id === active.vendor_id)).toBe(true);
    expect(activeList.some((v) => v.vendor_id === inactive.vendor_id)).toBe(false);
    const allList = await service.listVendors(TENANT_A, "business", "all");
    expect(allList.some((v) => v.vendor_id === inactive.vendor_id)).toBe(true);
  });
});

describe("B: runbooks", () => {
  it("createRunbook returnerer et gyldig runbook, is_active default true", async () => {
    const runbook = await service.createRunbook(TENANT_A, "business", { title: "Runbook A", content: "Steg 1: ..." });
    expect(runbook.title).toBe("Runbook A");
    expect(runbook.is_active).toBe(true);
    expect(runbook.category).toBe("general");
  });
  it("updateRunbookContent endrer innhold, gjentatt SAMME innhold er en EKTE no-op", async () => {
    const runbook = await service.createRunbook(TENANT_A, "business", { title: "Content test", content: "v1" });
    const updated = await service.updateRunbookContent(TENANT_A, "business", runbook.runbook_id, "v2");
    expect(updated?.content).toBe("v2");
    await new Promise((r) => setTimeout(r, 20));
    const again = await service.updateRunbookContent(TENANT_A, "business", runbook.runbook_id, "v2");
    expect(new Date(again!.updated_at).getTime()).toBe(new Date(updated!.updated_at).getTime());
  });
  it("setRunbookActive deaktiverer/aktiverer, listRunbooks default kun aktive", async () => {
    const runbook = await service.createRunbook(TENANT_A, "business", { title: "Active toggle", content: "..." });
    await service.setRunbookActive(TENANT_A, "business", runbook.runbook_id, false);
    const activeOnly = await service.listRunbooks(TENANT_A, "business", true);
    expect(activeOnly.some((r) => r.runbook_id === runbook.runbook_id)).toBe(false);
    const all = await service.listRunbooks(TENANT_A, "business", false);
    expect(all.some((r) => r.runbook_id === runbook.runbook_id)).toBe(true);
  });
  it("runbook kan kobles til en leverandør", async () => {
    const vendor = await service.createVendor(TENANT_A, "business", { name: "Runbook-vendor" });
    const runbook = await service.createRunbook(TENANT_A, "business", { title: "Vendor runbook", content: "...", vendor_id: vendor.vendor_id });
    expect(runbook.vendor_id).toBe(vendor.vendor_id);
  });
});

describe("C: driftsoppgaver (tasks/owners/deadlines)", () => {
  it("createTask returnerer en gyldig oppgave med default status/prioritet, logger 'task_created'", async () => {
    const task = await service.createTask(TENANT_A, "business", { title: "Task A" });
    expect(task.status).toBe("open");
    expect(task.priority).toBe("normal");
    expect(task.escalation_level).toBe(0);
    const events = await service.listTaskEvents(TENANT_A, "business", task.task_id);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("task_created");
  });
  it("hver ny oppgave faar et strengt stigende, unikt task_number", async () => {
    const a = await service.createTask(TENANT_A, "business", { title: "Number A" });
    const b = await service.createTask(TENANT_A, "business", { title: "Number B" });
    expect(Number(b.task_number)).toBeGreaterThan(Number(a.task_number));
  });
  it("deterministisk lifecycle: open -> in_progress -> done logges og setter closed_at", async () => {
    const task = await service.createTask(TENANT_A, "business", { title: "Transition" });
    await service.setStatus(TENANT_A, "business", task.task_id, "in_progress");
    const done = await service.setStatus(TENANT_A, "business", task.task_id, "done");
    expect(done?.status).toBe("done");
    expect(done?.closed_at).not.toBeNull();
    const events = await service.listTaskEvents(TENANT_A, "business", task.task_id);
    expect(events.filter((e) => e.event_type === "status_changed")).toHaveLength(2);
  });
  it("ugyldig overgang (done -> in_progress) kaster og endrer INGENTING", async () => {
    const task = await service.createTask(TENANT_A, "business", { title: "Bad transition" });
    await service.setStatus(TENANT_A, "business", task.task_id, "done");
    await expect(service.setStatus(TENANT_A, "business", task.task_id, "in_progress")).rejects.toThrow(InvalidOperationsTaskTransitionError);
    const unchanged = await service.getTask(TENANT_A, "business", task.task_id);
    expect(unchanged?.status).toBe("done");
  });
  it("gjenaapning fra done nullstiller closed_at", async () => {
    const task = await service.createTask(TENANT_A, "business", { title: "Reopen" });
    await service.setStatus(TENANT_A, "business", task.task_id, "done");
    const reopened = await service.setStatus(TENANT_A, "business", task.task_id, "open");
    expect(reopened?.status).toBe("open");
    expect(reopened?.closed_at).toBeNull();
  });
  it("setPriority/setOwner/setDueAt endrer og logger riktig event-type", async () => {
    const task = await service.createTask(TENANT_A, "business", { title: "Fields" });
    const withPriority = await service.setPriority(TENANT_A, "business", task.task_id, "critical");
    expect(withPriority?.priority).toBe("critical");
    const withOwner = await service.setOwner(TENANT_A, "business", task.task_id, "person-ops-owner");
    expect(withOwner?.owner_person_id).toBe("person-ops-owner");
    const withDue = await service.setDueAt(TENANT_A, "business", task.task_id, "2030-01-01T00:00:00Z");
    expect(withDue?.due_at).not.toBeNull();
    const events = await service.listTaskEvents(TENANT_A, "business", task.task_id);
    expect(events.some((e) => e.event_type === "priority_changed")).toBe(true);
    expect(events.some((e) => e.event_type === "owner_changed")).toBe(true);
    expect(events.some((e) => e.event_type === "due_at_changed")).toBe(true);
  });
  it("linkVendor/linkRunbook kobler til eksisterende entiteter og logger riktig event-type", async () => {
    const vendor = await service.createVendor(TENANT_A, "business", { name: "Link vendor" });
    const runbook = await service.createRunbook(TENANT_A, "business", { title: "Link runbook", content: "..." });
    const task = await service.createTask(TENANT_A, "business", { title: "Linking" });
    const withVendor = await service.linkVendor(TENANT_A, "business", task.task_id, vendor.vendor_id);
    expect(withVendor?.vendor_id).toBe(vendor.vendor_id);
    const withRunbook = await service.linkRunbook(TENANT_A, "business", task.task_id, runbook.runbook_id);
    expect(withRunbook?.runbook_id).toBe(runbook.runbook_id);
    const events = await service.listTaskEvents(TENANT_A, "business", task.task_id);
    expect(events.some((e) => e.event_type === "vendor_linked")).toBe(true);
    expect(events.some((e) => e.event_type === "runbook_linked")).toBe(true);
  });
  it("listByVendor finner oppgaver koblet til en leverandør (\"What's outstanding for vendor X?\")", async () => {
    const vendor = await service.createVendor(TENANT_A, "business", { name: "Outstanding vendor" });
    const task = await service.createTask(TENANT_A, "business", { title: "Vendor scoped", vendor_id: vendor.vendor_id });
    const rows = await service.listByVendor(TENANT_A, "business", vendor.vendor_id);
    expect(rows.some((t) => t.task_id === task.task_id)).toBe(true);
  });
  it("searchTasks filtrerer deterministisk paa title_contains og priority", async () => {
    await service.createTask(TENANT_A, "business", { title: "Unique-Ops-Search-Marker-XYZ" });
    const rows = await service.searchTasks(TENANT_A, "business", { title_contains: "Unique-Ops-Search-Marker-XYZ" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.title.includes("Unique-Ops-Search-Marker-XYZ"))).toBe(true);
    const critical = await service.createTask(TENANT_A, "business", { title: "Critical task", priority: "critical" });
    const criticalRows = await service.searchTasks(TENANT_A, "business", { priority: "critical" });
    expect(criticalRows.some((r) => r.task_id === critical.task_id)).toBe(true);
  });
});

describe("D: eskalering (§13 'escalations')", () => {
  it("escalateTask inkrementerer eskaleringsnivaa og logger 'escalated' med eksplisitt mottaker", async () => {
    const task = await service.createTask(TENANT_A, "business", { title: "Escalate explicit" });
    const escalated = await service.escalateTask(TENANT_A, "business", task.task_id, "person-ops-escalation");
    expect(escalated?.escalation_level).toBe(1);
    expect(escalated?.escalated_to_person_id).toBe("person-ops-escalation");
    expect(escalated?.escalated_at).not.toBeNull();
    const events = await service.listTaskEvents(TENANT_A, "business", task.task_id);
    expect(events.some((e) => e.event_type === "escalated")).toBe(true);
  });
  it("escalateTask uten eksplisitt mottaker faller tilbake til leverandørens eskaleringskontakt", async () => {
    const vendor = await service.createVendor(TENANT_A, "business", { name: "Escalation vendor", escalation_contact_person_id: "person-ops-escalation" });
    const task = await service.createTask(TENANT_A, "business", { title: "Escalate via vendor", vendor_id: vendor.vendor_id });
    const escalated = await service.escalateTask(TENANT_A, "business", task.task_id);
    expect(escalated?.escalated_to_person_id).toBe("person-ops-escalation");
  });
  it("gjentatt escalateTask inkrementerer nivaaet videre (akkumulerende, ALDRI en no-op)", async () => {
    const task = await service.createTask(TENANT_A, "business", { title: "Escalate twice" });
    await service.escalateTask(TENANT_A, "business", task.task_id, "person-ops-escalation");
    const twice = await service.escalateTask(TENANT_A, "business", task.task_id, "person-ops-escalation");
    expect(twice?.escalation_level).toBe(2);
    const events = await service.listTaskEvents(TENANT_A, "business", task.task_id);
    expect(events.filter((e) => e.event_type === "escalated")).toHaveLength(2);
  });
});

describe("E (samme-verdi-no-op-disiplin, D-128-lærdom): samme-verdi-kall er EKTE no-op'er", () => {
  it("gjentatt setStatus med SAMME status skriver INGEN nytt event, INGEN ny updated_at, INGEN ny closed_at", async () => {
    const task = await service.createTask(TENANT_A, "business", { title: "Same-status no-op" });
    await service.setStatus(TENANT_A, "business", task.task_id, "in_progress");
    const before = await service.getTask(TENANT_A, "business", task.task_id);
    const eventsBefore = await service.listTaskEvents(TENANT_A, "business", task.task_id);
    await new Promise((r) => setTimeout(r, 20));
    const after = await service.setStatus(TENANT_A, "business", task.task_id, "in_progress");
    const eventsAfter = await service.listTaskEvents(TENANT_A, "business", task.task_id);
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(before!.updated_at).getTime());
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
  it("gjentatt SAMME terminal-status (done -> done) overskriver ALDRI den opprinnelige closed_at", async () => {
    const task = await service.createTask(TENANT_A, "business", { title: "Same-terminal no-op" });
    const done = await service.setStatus(TENANT_A, "business", task.task_id, "done");
    await new Promise((r) => setTimeout(r, 20));
    const doneAgain = await service.setStatus(TENANT_A, "business", task.task_id, "done");
    expect(new Date(doneAgain!.closed_at!).getTime()).toBe(new Date(done!.closed_at!).getTime());
  });
  it("gjentatt setPriority/setOwner/setDueAt/linkVendor/linkRunbook med SAMME verdi skriver INGEN nytt event/ny updated_at", async () => {
    const vendor = await service.createVendor(TENANT_A, "business", { name: "No-op vendor" });
    const runbook = await service.createRunbook(TENANT_A, "business", { title: "No-op runbook", content: "..." });
    const task = await service.createTask(TENANT_A, "business", {
      title: "Same-field no-op", priority: "high", owner_person_id: "person-ops-owner", due_at: "2030-01-01T00:00:00Z",
      vendor_id: vendor.vendor_id, runbook_id: runbook.runbook_id
    });
    const before = await service.getTask(TENANT_A, "business", task.task_id);
    const eventsBefore = await service.listTaskEvents(TENANT_A, "business", task.task_id);
    await new Promise((r) => setTimeout(r, 20));
    await service.setPriority(TENANT_A, "business", task.task_id, "high");
    await service.setOwner(TENANT_A, "business", task.task_id, "person-ops-owner");
    await service.setDueAt(TENANT_A, "business", task.task_id, "2030-01-01T00:00:00Z");
    await service.linkVendor(TENANT_A, "business", task.task_id, vendor.vendor_id);
    const after = await service.linkRunbook(TENANT_A, "business", task.task_id, runbook.runbook_id);
    const eventsAfter = await service.listTaskEvents(TENANT_A, "business", task.task_id);
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(before!.updated_at).getTime());
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });
});

describe("F/G: tenant-/memory-space-isolasjon (RLS)", () => {
  it("F: TENANT_B ser ALDRI TENANT_A sine driftsoppgaver/leverandører/runbooks", async () => {
    const task = await service.createTask(TENANT_A, "business", { title: "Isolation task" });
    const vendor = await service.createVendor(TENANT_A, "business", { name: "Isolation vendor" });
    const runbook = await service.createRunbook(TENANT_A, "business", { title: "Isolation runbook", content: "..." });
    expect(await service.getTask(TENANT_B, "business", task.task_id)).toBeNull();
    expect(await service.getVendor(TENANT_B, "business", vendor.vendor_id)).toBeNull();
    expect(await service.getRunbook(TENANT_B, "business", runbook.runbook_id)).toBeNull();
    const listB = await service.listTasks(TENANT_B, "business", "all");
    expect(listB.some((t) => t.task_id === task.task_id)).toBe(false);
  });
  it("G: en driftsoppgave i memory_space 'business' er usynlig fra 'personal'-space-kontekst for samme tenant", async () => {
    const task = await service.createTask(TENANT_A, "business", { title: "Space isolation" });
    const foundInPersonal = await service.getTask(TENANT_A, "personal", task.task_id);
    expect(foundInPersonal).toBeNull();
  });
});
