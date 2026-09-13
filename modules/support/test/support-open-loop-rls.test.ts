import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, listBusinessTenantIds, runMigrations } from "@jarvis/core";
import { OpenLoopService } from "@jarvis/business";
import { SupportService } from "../src/service.ts";

/**
 * UA-3 Native Support Core (D-66) §17: bevis at support-ticket-open-loop-
 * reglene faktisk kjoerer via DEN EKSISTERENDE `OpenLoopService.runSweep()` -
 * ingen ny motor - mot en EKTE RLS-rolle (ikke `fakePool()`). §23: Q-27 sin
 * kanoniske `listBusinessTenantIds()` er den ENESTE tenant-katalog-veien,
 * verifisert direkte her.
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let support: SupportService;
let openLoops: OpenLoopService;

const TENANT = "tenant-sup-loop-a";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-support-loop-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_sup_loop_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sup_loop_test");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'Support Loop A', 'business')`);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sup_loop_test", password: "pw2" });
  support = new SupportService(appPool);
  openLoops = new OpenLoopService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("X: open-loop opprettes for en ticket som trenger svar", () => {
  it("en ticket med siste event = customer_message faar en support_ticket_needs_reply-loop", async () => {
    const result = await support.ingestMessage(TENANT, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-needsreply",
      source_message_id: "msg-needsreply-1", subject: "Needs reply", summary: "Kunde spoer", is_from_customer: true, entity_resolution: "unmatched"
    });
    const sweep = await openLoops.runSweep(TENANT, "business");
    expect(sweep.detected + sweep.updated).toBeGreaterThan(0);
    const loops = await openLoops.listOpenLoops(TENANT, "business", "open");
    const loop = loops.find((l) => l.ticket_id === result.ticket.ticket_id && l.loop_type === "support_ticket_needs_reply");
    expect(loop).toBeDefined();
  });
});

describe("Y: open-loop auto-resolves naar vilkaaret ikke lenger er sant", () => {
  it("naar et agent-svar registreres, forsvinner 'needs_reply'-loopen ved neste sveip", async () => {
    const result = await support.ingestMessage(TENANT, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-getsreply",
      source_message_id: "msg-getsreply-1", subject: "Gets reply", summary: "Kunde spoer", is_from_customer: true, entity_resolution: "unmatched"
    });
    await openLoops.runSweep(TENANT, "business");
    await support.ingestMessage(TENANT, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1", source_thread_id: "thread-getsreply",
      source_message_id: "msg-getsreply-2", subject: "Gets reply", summary: "Agent svarer", is_from_customer: false, entity_resolution: "unmatched"
    });
    await openLoops.runSweep(TENANT, "business");
    const loops = await openLoops.listOpenLoops(TENANT, "business", "open");
    const stillOpen = loops.find((l) => l.ticket_id === result.ticket.ticket_id && l.loop_type === "support_ticket_needs_reply");
    expect(stillOpen).toBeUndefined();
  });
});

describe("Z: forfalt-deteksjon", () => {
  it("en ticket med next_response_due_at i fortiden faar en support_ticket_overdue-loop", async () => {
    const ticket = await support.createTicket(TENANT, "business", { subject: "Overdue test" });
    await support.setNextResponseDue(TENANT, "business", ticket.ticket_id, new Date(Date.now() - 3_600_000).toISOString());
    const sweep = await openLoops.runSweep(TENANT, "business");
    expect(sweep.detected + sweep.updated).toBeGreaterThan(0);
    const loops = await openLoops.listOpenLoops(TENANT, "business", "open");
    expect(loops.some((l) => l.ticket_id === ticket.ticket_id && l.loop_type === "support_ticket_overdue")).toBe(true);
  });
  it("uassignerte tickets faar en support_ticket_unassigned-loop", async () => {
    const ticket = await support.createTicket(TENANT, "business", { subject: "Unassigned test" });
    await openLoops.runSweep(TENANT, "business");
    const loops = await openLoops.listOpenLoops(TENANT, "business", "open");
    expect(loops.some((l) => l.ticket_id === ticket.ticket_id && l.loop_type === "support_ticket_unassigned")).toBe(true);
  });
});

describe("AE: Q-27 kanonisk katalogfunksjon - ingen egen/duplisert tenant-enumering", () => {
  it("listBusinessTenantIds() (SAMME funksjon som andre UA-3-sveip) finner tenanten", async () => {
    const ids = await listBusinessTenantIds(appPool, 200);
    expect(ids).toContain(TENANT);
  });
});
