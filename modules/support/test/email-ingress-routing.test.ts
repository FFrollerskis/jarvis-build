import { afterEach, describe, expect, it } from "vitest";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { BusinessService } from "@jarvis/business";
import { SupportEmailService } from "../src/email-ingress.ts";
import type { SupportService } from "../src/service.ts";

/**
 * UA-3 Native Support Core (D-66) §7: "not every arbitrary email becomes a
 * support ticket" - deterministisk routing-bevis (P), UTEN embedded
 * Postgres. `JARVIS_SUPPORT_INBOX_EMAILS` styrer klassifiseringen; en
 * ukjent tråd til en ikke-konfigurert adresse ignoreres helt.
 */
function fakeGateway(messages: Array<Record<string, unknown>>): ToolGateway {
  return { execute: async () => ({ ok: true, data: { messages } }) } as unknown as ToolGateway;
}

describe("P: ikke-support-e-post ignoreres deterministisk", () => {
  afterEach(() => {
    delete process.env["JARVIS_SUPPORT_INBOX_EMAILS"];
  });

  it("en melding til en IKKE-konfigurert adresse, paa en ukjent traad, oppretter INGEN ticket", async () => {
    const gateway = fakeGateway([
      { id: "m1", thread: "t1", from: "kunde@eksempel.no", to: "salg@tsworkflow.com", subject: "Tilbud", at: new Date().toISOString() }
    ]);
    const support = {
      hasTicketForThread: async () => false,
      ingestMessage: async () => {
        throw new Error("skal ALDRI kalles for ikke-support-post");
      }
    } as unknown as SupportService;
    const business = { findContactsByEmail: async () => [] } as unknown as BusinessService;
    process.env["JARVIS_SUPPORT_INBOX_EMAILS"] = "support@tsworkflow.com";
    const emailService = new SupportEmailService(gateway, business, support, "post@tsworkflow.com");
    const stats = await emailService.ingestFromGmail(
      "tenant-x", "business",
      { person_id: "system", tenant_id: "tenant-x", memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" } as never
    );
    expect(stats.ignored_not_support).toBe(1);
    expect(stats.ingested).toBe(0);
  });

  it("en melding TIL den konfigurerte support-innboksen ingesteres", async () => {
    const gateway = fakeGateway([
      { id: "m2", thread: "t2", from: "kunde@eksempel.no", to: "support@tsworkflow.com", subject: "Hjelp", at: new Date().toISOString() }
    ]);
    let ingested = false;
    const support = {
      hasTicketForThread: async () => false,
      ingestMessage: async () => {
        ingested = true;
        return { ticket: { ticket_id: "sup-tk-x" }, event: { event_id: "ev-x" }, ticket_created: true, event_created: true, reopened: false };
      }
    } as unknown as SupportService;
    const business = { findContactsByEmail: async () => [] } as unknown as BusinessService;
    const emailService = new SupportEmailService(gateway, business, support, "post@tsworkflow.com", ["support@tsworkflow.com"]);
    const stats = await emailService.ingestFromGmail(
      "tenant-x", "business",
      { person_id: "system", tenant_id: "tenant-x", memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" } as never
    );
    expect(ingested).toBe(true);
    expect(stats.ingested).toBe(1);
    expect(stats.ignored_not_support).toBe(0);
  });

  it("en fortsettelse av en KJENT support-traad ingesteres selv om innboks-adressen ikke lenger er i to/cc", async () => {
    const gateway = fakeGateway([
      { id: "m3", thread: "t-known", from: "kunde@eksempel.no", to: "agent@tsworkflow.com", subject: "Re: Hjelp", at: new Date().toISOString() }
    ]);
    let ingested = false;
    const support = {
      hasTicketForThread: async (_t: string, _s: string, _st: string, _si: string, threadId: string) => threadId === "t-known",
      ingestMessage: async () => {
        ingested = true;
        return { ticket: { ticket_id: "sup-tk-y" }, event: { event_id: "ev-y" }, ticket_created: false, event_created: true, reopened: false };
      }
    } as unknown as SupportService;
    const business = { findContactsByEmail: async () => [] } as unknown as BusinessService;
    const emailService = new SupportEmailService(gateway, business, support, "post@tsworkflow.com", ["support@tsworkflow.com"]);
    const stats = await emailService.ingestFromGmail(
      "tenant-x", "business",
      { person_id: "system", tenant_id: "tenant-x", memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" } as never
    );
    expect(ingested).toBe(true);
    expect(stats.ingested).toBe(1);
  });
});
