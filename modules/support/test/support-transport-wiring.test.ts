import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { BusinessService } from "@jarvis/business";
import { SupportEmailService } from "../src/email-ingress.ts";
import { SupportService } from "../src/service.ts";
import { SupportTransport } from "../src/transport.ts";
import { runSupportInboxSyncForAllTenants } from "../src/support-sweep.ts";

/**
 * UA-3 Native Support Core (D-66): rene wiring-/orkestreringstester (INGEN
 * embedded Postgres - `SupportService`/`BusinessService` er fakes, samme
 * mønster som `q27-scheduler-tenant-enumeration-rls.test.ts` sine
 * fan-out-tester og `business-event-sync.test.ts` sine strukturelle
 * kildeskanninger). Beviser ToolGateway-registrering/risikoklasser (AF/AG),
 * at reply ruter GJENNOM email.send (J), idempotens (K), audit-privacy (AJ),
 * reconciliation-idempotens (AN) og ZERO Zendesk-avhengighet (AM).
 */

describe("AF: support.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("support.create_ticket/get_ticket/reply finnes i registeret og peker til support-transporten", () => {
    const supportTransport = new SupportTransport({} as unknown as SupportService);
    const tools = firstWaveTools({ support: supportTransport });
    const supportTools = tools.filter((t) => t.tool_id === "support");
    expect(supportTools.length).toBeGreaterThanOrEqual(12);
    expect(supportTools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "create_ticket", "get_ticket", "list_tickets", "search_tickets", "update_ticket",
        "set_status", "set_priority", "assign_ticket", "add_internal_note", "list_events", "reply", "ingest_message"
      ])
    );
    for (const tool of supportTools) expect(tool.transport).toBe(supportTransport);
  });
});

describe("AG: risikoklasser er effekt-baserte, ingen ordinaer support-jobb er klasse D", () => {
  it("lesing er klasse A, interne skrivinger klasse B, kunde-svar klasse C - INGEN support.*-handling er klasse D", () => {
    const tools = firstWaveTools({ support: new SupportTransport({} as unknown as SupportService) }).filter((t) => t.tool_id === "support");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction["get_ticket"]).toBe("A");
    expect(byAction["list_tickets"]).toBe("A");
    expect(byAction["search_tickets"]).toBe("A");
    expect(byAction["list_events"]).toBe("A");
    expect(byAction["create_ticket"]).toBe("B");
    expect(byAction["set_status"]).toBe("B");
    expect(byAction["assign_ticket"]).toBe("B");
    expect(byAction["add_internal_note"]).toBe("B");
    expect(byAction["reply"]).toBe("C");
    expect(tools.every((t) => t.capability_class !== "D")).toBe(true);
  });
});

function fakeSupportService(ticket: { ticket_id: string; channel: string; source_type: string; source_instance_id: string | null; source_thread_id: string | null; subject: string; company_id: string | null; contact_id: string | null; entity_resolution: string }) {
  const ingestCalls: unknown[] = [];
  return {
    getTicket: async () => ticket,
    ingestMessage: async (_tenantId: string, _space: string, input: Record<string, unknown>) => {
      ingestCalls.push(input);
      return { ticket, event: { event_id: `ev-${ingestCalls.length}`, event_type: input["is_from_customer"] ? "customer_message" : "agent_reply" }, ticket_created: false, event_created: true, reopened: false };
    },
    _ingestCalls: ingestCalls
  } as unknown as SupportService & { _ingestCalls: unknown[] };
}

describe("J: reply ruter GJENNOM eksisterende email.send (ToolGateway), ALDRI en egen SMTP-implementasjon", () => {
  it("SupportEmailService.reply() kaller gateway.execute med tool_id='email', action='send'", async () => {
    const calls: Array<{ tool_id: string; action: string }> = [];
    const gateway = {
      execute: async (req: { tool_id: string; action: string }) => {
        calls.push({ tool_id: req.tool_id, action: req.action });
        return { ok: true, data: {} };
      }
    } as unknown as ToolGateway;
    const support = fakeSupportService({
      ticket_id: "sup-tk-1", channel: "email", source_type: "gmail", source_instance_id: "acct-1",
      source_thread_id: "thread-1", subject: "Test", company_id: null, contact_id: null, entity_resolution: "unmatched"
    });
    const emailService = new SupportEmailService(gateway, {} as unknown as BusinessService, support);
    const result = await emailService.reply("tenant-x", "business", {
      person_id: "system", tenant_id: "tenant-x", memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "active"
    } as never, "sup-tk-1", { to: "kunde@example.com", subject: "Re: Test", body: "Svar", idempotency_key: "reply-1" });
    expect(calls).toEqual([{ tool_id: "email", action: "send" }]);
    expect(result.sent).toBe(true);
  });
});

describe("K: reply-idempotens", () => {
  it("samme idempotency_key gir samme source_message_id inn i ingestMessage (gjenbruker EKSISTERENDE idempotens-mekanisme)", async () => {
    const gateway = { execute: async () => ({ ok: true, data: {} }) } as unknown as ToolGateway;
    const support = fakeSupportService({
      ticket_id: "sup-tk-2", channel: "email", source_type: "gmail", source_instance_id: "acct-1",
      source_thread_id: "thread-2", subject: "Test2", company_id: null, contact_id: null, entity_resolution: "unmatched"
    });
    const emailService = new SupportEmailService(gateway, {} as unknown as BusinessService, support);
    const identity = { person_id: "system", tenant_id: "tenant-x", memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" } as never;
    await emailService.reply("tenant-x", "business", identity, "sup-tk-2", { to: "a@b.no", subject: "S", body: "B", idempotency_key: "idem-42" });
    await emailService.reply("tenant-x", "business", identity, "sup-tk-2", { to: "a@b.no", subject: "S", body: "B", idempotency_key: "idem-42" });
    const calls = support._ingestCalls as Array<{ source_message_id: string }>;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.source_message_id).toBe(calls[1]!.source_message_id);
    expect(calls[0]!.source_message_id).toContain("idem-42");
  });
});

describe("AJ: audit-privacy - reply-eventet lagrer ALDRI raatt meldingsinnhold (kun et kort, strukturert sammendrag)", () => {
  it("summary-feltet er en kort statusmelding, aldri 'body'-teksten selv", async () => {
    const gateway = { execute: async () => ({ ok: true, data: {} }) } as unknown as ToolGateway;
    const support = fakeSupportService({
      ticket_id: "sup-tk-3", channel: "email", source_type: "gmail", source_instance_id: "acct-1",
      source_thread_id: "thread-3", subject: "Test3", company_id: null, contact_id: null, entity_resolution: "unmatched"
    });
    const emailService = new SupportEmailService(gateway, {} as unknown as BusinessService, support);
    const secretBody = "HEMMELIG-KUNDEDATA-1234567890";
    await emailService.reply(
      "tenant-x", "business",
      { person_id: "system", tenant_id: "tenant-x", memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" } as never,
      "sup-tk-3", { to: "a@b.no", subject: "S", body: secretBody, idempotency_key: "idem-privacy" }
    );
    const calls = support._ingestCalls as Array<{ summary: string }>;
    expect(calls[0]!.summary).not.toContain(secretBody);
  });
});

describe("AN: reconciliation-idempotens (periodisk innboks-sveip)", () => {
  it("runSupportInboxSyncForAllTenants isolerer en tenant sin feil fra resten (ingen ny koe, samme fan-out-mønster som andre UA-3-sveip)", async () => {
    const pool = { query: async () => ({ rows: [{ tenant_id: "tenant-fail" }, { tenant_id: "tenant-ok" }] }) } as never;
    const emailService = {
      ingestFromGmail: async (tenantId: string) => {
        if (tenantId === "tenant-fail") throw new Error("boom");
        return { scanned: 1, ingested: 1, ignored_not_support: 0, unmatched: 0, ambiguous: 0 };
      }
    } as unknown as SupportEmailService;
    const results = await runSupportInboxSyncForAllTenants(pool, emailService);
    expect(results["tenant-fail"]!.error).toBeDefined();
    expect(results["tenant-ok"]).toEqual({ scanned: 1, ingested: 1, ignored_not_support: 0, unmatched: 0, ambiguous: 0 });
  });
});

describe("AM: ZERO Zendesk-avhengighet", () => {
  it("ingen kildefil i modules/support importerer eller refererer noe Zendesk-spesifikt", async () => {
    const files = ["types.ts", "state-machine.ts", "service.ts", "email-ingress.ts", "support-sweep.ts", "transport.ts", "index.ts"];
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of files) {
      const content = await readFile(`${dir}${file}`, "utf8");
      expect(content.toLowerCase()).not.toMatch(/zendesk/);
    }
  });
  it("ingen JARVIS_ZENDESK_*-miljøvariabel leses noe sted i modules/support", async () => {
    const files = ["service.ts", "email-ingress.ts", "support-sweep.ts", "transport.ts"];
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of files) {
      const content = await readFile(`${dir}${file}`, "utf8");
      expect(content).not.toMatch(/JARVIS_ZENDESK/);
    }
  });
});
