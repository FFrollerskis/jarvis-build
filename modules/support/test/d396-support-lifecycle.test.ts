import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { BusinessService, OpenLoopService } from "@jarvis/business";
import { SupportService } from "../src/service.ts";
import { SupportEmailService } from "../src/email-ingress.ts";

/**
 * D-396 (JARVIS-046): support-livssyklus.
 *  1. re-levering av en ALLEREDE innlest kundemelding gjenåpner ALDRI en løst ticket (idempotens før tilstandsendring),
 *  2. svar er idempotente: samme idempotency_key sender kun én gang (gateway kalles ikke på nytt),
 *  3. et mislykket svar lagres som `internal_note` (evidens), ALDRI som `agent_reply`, og kan prøves på nytt med samme nøkkel,
 *  4. et internt notat alene besvarer ikke en kundemelding i "trenger svar"-deteksjonen.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let support: SupportService;
let openLoops: OpenLoopService;
const TENANT = "tenant-sup-d396";
const identity = { person_id: "system", tenant_id: TENANT, memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" } as IdentityContext;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-sup-d396-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_sup_d396_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sup_d396_test");
  await adminPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'Support D396', 'business')`);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_sup_d396_test", password: "pw2" });
  support = new SupportService(appPool);
  openLoops = new OpenLoopService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

function customerMessage(thread: string, id: string) {
  return {
    channel: "email" as const, source_type: "gmail", source_instance_id: "acct-1", source_thread_id: thread,
    source_message_id: id, subject: `Tråd ${thread}`, summary: "Kunde skriver", is_from_customer: true, entity_resolution: "unmatched" as const
  };
}

async function eventCount(ticketId: string, type: string): Promise<number> {
  const events = await support.listEvents(TENANT, "business", ticketId);
  return events.filter((e) => e.event_type === type).length;
}

describe("1: re-levering gjenåpner ikke", () => {
  it("samme kundemelding på nytt etter resolved => ticket forblir resolved, ingen ny reopened/customer_message", async () => {
    const first = await support.ingestMessage(TENANT, "business", customerMessage("t-redeliver", "m-1"));
    await support.setStatus(TENANT, "business", first.ticket.ticket_id, "resolved");
    const again = await support.ingestMessage(TENANT, "business", customerMessage("t-redeliver", "m-1"));
    expect(again.reopened).toBe(false);
    expect(again.event_created).toBe(false);
    expect(again.ticket.status).toBe("resolved");
    expect(await eventCount(first.ticket.ticket_id, "customer_message")).toBe(1);
    expect(await eventCount(first.ticket.ticket_id, "reopened")).toBe(0);
  });

  it("en NY kundemelding på en løst ticket gjenåpner den fortsatt (uendret oppførsel)", async () => {
    const first = await support.ingestMessage(TENANT, "business", customerMessage("t-new", "m-a"));
    await support.setStatus(TENANT, "business", first.ticket.ticket_id, "resolved");
    const next = await support.ingestMessage(TENANT, "business", customerMessage("t-new", "m-b"));
    expect(next.reopened).toBe(true);
    expect(next.ticket.status).not.toBe("resolved");
  });
});

describe("2-3: svar er idempotente og feil lagres som notat", () => {
  function emailService(results: boolean[]) {
    let calls = 0;
    const gateway = {
      execute: async () => {
        const ok = results[Math.min(calls, results.length - 1)]!;
        calls++;
        return ok ? { ok: true, data: {} } : { ok: false, reason: "provider_outage" };
      }
    } as unknown as ToolGateway;
    const svc = new SupportEmailService(gateway, new BusinessService(appPool), support, "acct-1", []);
    return { svc, calls: () => calls };
  }

  it("samme idempotency_key to ganger => gateway kalles én gang, ETT agent_reply", async () => {
    const t = await support.ingestMessage(TENANT, "business", customerMessage("t-idem", "m-i1"));
    const { svc, calls } = emailService([true]);
    const input = { to: "k@example.no", subject: "Re", body: "Svar", idempotency_key: "idem-1" };
    const r1 = await svc.reply(TENANT, "business", identity, t.ticket.ticket_id, input);
    const r2 = await svc.reply(TENANT, "business", identity, t.ticket.ticket_id, input);
    expect(r1.sent).toBe(true);
    expect(r2.sent).toBe(true);
    expect(r2.event.event_id).toBe(r1.event.event_id);
    expect(calls()).toBe(1);
    expect(await eventCount(t.ticket.ticket_id, "agent_reply")).toBe(1);
  });

  it("mislykket sending => internal_note (ikke agent_reply); samme nøkkel kan prøves på nytt og lykkes", async () => {
    const t = await support.ingestMessage(TENANT, "business", customerMessage("t-fail", "m-f1"));
    const { svc, calls } = emailService([false, true]);
    const input = { to: "k@example.no", subject: "Re", body: "Svar", idempotency_key: "idem-fail" };
    const failed = await svc.reply(TENANT, "business", identity, t.ticket.ticket_id, input);
    expect(failed.sent).toBe(false);
    expect(failed.event.event_type).toBe("internal_note");
    expect(await eventCount(t.ticket.ticket_id, "agent_reply")).toBe(0);
    const retried = await svc.reply(TENANT, "business", identity, t.ticket.ticket_id, input);
    expect(retried.sent).toBe(true);
    expect(retried.event.event_type).toBe("agent_reply");
    expect(calls()).toBe(2);
  });
});

describe("4: internt notat besvarer ikke kunden", () => {
  it("needs_reply-loopen består etter et internt notat, men forsvinner etter et ekte agent_reply", async () => {
    const t = await support.ingestMessage(TENANT, "business", customerMessage("t-note", "m-n1"));
    await support.addInternalNote(TENANT, "business", t.ticket.ticket_id, "Ser på saken");
    await openLoops.runSweep(TENANT, "business");
    const open = await openLoops.listOpenLoops(TENANT, "business", "open");
    expect(open.some((l) => l.ticket_id === t.ticket.ticket_id && l.loop_type === "support_ticket_needs_reply")).toBe(true);
    await support.ingestMessage(TENANT, "business", { ...customerMessage("t-note", "m-n2"), is_from_customer: false, summary: "Agent svarer" });
    await openLoops.runSweep(TENANT, "business");
    const after = await openLoops.listOpenLoops(TENANT, "business", "open");
    expect(after.some((l) => l.ticket_id === t.ticket.ticket_id && l.loop_type === "support_ticket_needs_reply")).toBe(false);
  });
});
