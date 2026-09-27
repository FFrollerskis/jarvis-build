import { afterEach, describe, expect, it, vi } from "vitest";
import { MicrosoftOutlookTransport } from "../src/live-transports.ts";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * D-310. `Authorization: Bearer`-header mot Microsoft Graph v1.0 (SAMME
 * vertsnavn/auth-mønster som OneDrive D-309). `send_mail` er BEVISST klasse
 * D - SAMME klassifisering som Gmail sin `email.send` (sending av e-post er
 * ikke reverserbar). Den generiske klasse D-håndteringen i `PolicyGateway`/
 * `ToolGateway.execute()` dekker godkjenningskravet - ingen egen
 * per-connector-kode testes her, kun selve HTTP-kallformen.
 */
describe("A: MicrosoftOutlookTransport.invoke('list_messages', ...) - GET /me/messages, ren lesing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller med Bearer-header og $top-query-parameter", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ value: [] }) } as unknown as Response;
    });
    const transport = new MicrosoftOutlookTransport();
    const result = await transport.invoke("list_messages", { max: 5 }, "test-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/me/messages?$top=5");
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer test-token" });
    expect(result.data).toEqual({ value: [] });
  });

  it("manglende max defaulter til 10", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } as unknown as Response; });
    const transport = new MicrosoftOutlookTransport();
    await transport.invoke("list_messages", {}, "tok");
    expect(calls[0]).toBe("https://graph.microsoft.com/v1.0/me/messages?$top=10");
  });

  it("en HTTP-feil kaster 'microsoft_outlook_error_<status>'", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }) as unknown as Response);
    const transport = new MicrosoftOutlookTransport();
    await expect(transport.invoke("list_messages", {}, "bad-token")).rejects.toThrow("microsoft_outlook_error_401");
  });
});

describe("B: MicrosoftOutlookTransport.invoke('send_mail', ...) - POST /me/sendMail, klasse D (ikke reverserbar)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("kaller mot /me/sendMail med korrekt message-form, håndterer 202-Accepted uten body", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 202, json: async () => { throw new Error("no body on 202"); } } as unknown as Response;
    });
    const transport = new MicrosoftOutlookTransport();
    const result = await transport.invoke("send_mail", { to: "tobias@example.com", subject: "Hei", body: "Test" }, "test-token");
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({
      message: {
        subject: "Hei",
        body: { contentType: "Text", content: "Test" },
        toRecipients: [{ emailAddress: { address: "tobias@example.com" } }]
      }
    }));
    expect(result.data).toBeNull();
  });
});

describe("C: en ukjent handling kaster 'microsoft_outlook_unsupported_action_<action>'", () => {
  it("invoke('delete_message', ...) kaster (ikke registrert)", async () => {
    const transport = new MicrosoftOutlookTransport();
    await expect(transport.invoke("delete_message", {}, "tok")).rejects.toThrow("microsoft_outlook_unsupported_action_delete_message");
  });
});

describe("D: firstWaveTools() registrerer microsoft_outlook.list_messages som klasse A og microsoft_outlook.send_mail som klasse D", () => {
  it("list_messages er klasse A (ren lesing), send_mail er klasse D (SAMME klassifisering som email.send)", () => {
    const tools = firstWaveTools().filter((t) => t.tool_id === "microsoft_outlook");
    expect(tools.map((t) => t.action).sort()).toEqual(["list_messages", "send_mail"]);
    const listMessages = tools.find((t) => t.action === "list_messages")!;
    expect(listMessages.capability_class).toBe("A");
    expect(listMessages.credential_ref).toBe("JARVIS_OUTLOOK_TOKEN");
    expect(listMessages.output_trust).toBe("untrusted");
    expect(listMessages.idempotent_external).toBe(true);
    const sendMail = tools.find((t) => t.action === "send_mail")!;
    expect(sendMail.capability_class).toBe("D");
    expect(sendMail.credential_ref).toBe("JARVIS_OUTLOOK_TOKEN");
    expect(sendMail.reversible).toBe(false);
    expect(sendMail.idempotent_external).toBe(false);
  });
});
