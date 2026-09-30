import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailTransport } from "@jarvis/tool-gateway";

/**
 * UA-2 P1B-A §2: `GmailTransport` fikk to nye handlinger (`list_messages`/
 * `read_attachment`) med reell intern logikk (rekursiv MIME-tre-vedlegg-
 * gjenfinning, base64url→base64-konvertering) - samme begrunnelse som
 * `google-drive-transport.test.ts` sitt fetch-mock-unntak (se toppkommentaren
 * der, som IKKE lenger er "den eneste" - oppdatert i samme commit). `read_inbox`
 * (uendret fra P0/D-34) beholdes kun som regresjonssmoke.
 */
const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GmailTransport - intern logikk (fetch mocket)", () => {
  let calls: Array<{ url: string; method: string }>;
  let queue: Response[];

  beforeEach(() => {
    calls = [];
    queue = [];
    global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse(200, { access_token: "fake-access-token" });
      }
      const next = queue.shift();
      if (!next) throw new Error(`uventet fetch-kall uten kø-oppføring: ${url}`);
      return next;
    }) as unknown as typeof fetch;
    process.env["JARVIS_GOOGLE_CLIENT_ID"] = "test-client-id";
    process.env["JARVIS_GOOGLE_CLIENT_SECRET"] = "test-client-secret";
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("A: read_inbox (uendret P0-handling) - regresjonssmoke", async () => {
    queue.push(jsonResponse(200, { messages: [{ id: "m1" }] }));
    queue.push(
      jsonResponse(200, {
        id: "m1", threadId: "t1", internalDate: "1700000000000", labelIds: ["UNREAD"],
        payload: { headers: [{ name: "From", value: "a@b.no" }, { name: "Subject", value: "Hei" }] }
      })
    );
    const transport = new GmailTransport("post@tsworkflow.com");
    const result = await transport.invoke("read_inbox", { max: 5 }, "refresh-token");
    const data = result.data as { messages: Array<{ id: string; subject: string }> };
    expect(data.messages[0]?.id).toBe("m1");
    expect(data.messages[0]?.subject).toBe("Hei");
  });

  it("B: list_messages - flat (ikke-multipart) melding: body_text fra top-level payload.body, attachments=[]", async () => {
    queue.push(jsonResponse(200, { messages: [{ id: "m1" }] }));
    queue.push(
      jsonResponse(200, {
        id: "m1", threadId: "t1", internalDate: "1700000000000",
        payload: {
          headers: [{ name: "From", value: "a@b.no" }, { name: "Subject", value: "Flat" }],
          mimeType: "text/plain", body: { data: Buffer.from("hei der").toString("base64") }
        }
      })
    );
    const transport = new GmailTransport();
    const result = await transport.invoke("list_messages", { max: 5 }, "refresh-token");
    const data = result.data as { messages: Array<{ body_text: string; attachments: unknown[] }> };
    expect(data.messages[0]?.body_text).toBe("hei der");
    expect(data.messages[0]?.attachments).toEqual([]);
  });

  it("C: list_messages - nøstet multipart/mixed → multipart/alternative → vedlegg, REKURSIV gjenfinning finner vedlegget flere nivåer ned", async () => {
    queue.push(jsonResponse(200, { messages: [{ id: "m2" }] }));
    queue.push(
      jsonResponse(200, {
        id: "m2", threadId: "t2", internalDate: "1700000000000",
        payload: {
          headers: [{ name: "From", value: "c@d.no" }, { name: "Subject", value: "Med vedlegg" }],
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "multipart/alternative",
              parts: [{ mimeType: "text/plain", body: { data: Buffer.from("brødtekst").toString("base64") } }]
            },
            {
              mimeType: "application/pdf", filename: "faktura.pdf",
              body: { attachmentId: "att-123", size: 55000 }
            }
          ]
        }
      })
    );
    const transport = new GmailTransport();
    const result = await transport.invoke("list_messages", { max: 5 }, "refresh-token");
    const data = result.data as {
      messages: Array<{ body_text: string; attachments: Array<{ attachment_id: string; filename: string; mime_type: string; size_bytes: number }> }>;
    };
    expect(data.messages[0]?.body_text).toBe("brødtekst");
    expect(data.messages[0]?.attachments).toEqual([
      { attachment_id: "att-123", filename: "faktura.pdf", mime_type: "application/pdf", size_bytes: 55000 }
    ]);
  });

  it("D: list_messages - flere vedlegg på ULIKE nivåer samles ALLE, ingen tapt", async () => {
    queue.push(jsonResponse(200, { messages: [{ id: "m3" }] }));
    queue.push(
      jsonResponse(200, {
        id: "m3", threadId: "t3", internalDate: "1700000000000",
        payload: {
          headers: [],
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "image/png", filename: "skjermbilde.png", body: { attachmentId: "att-a", size: 1000 } },
            {
              mimeType: "multipart/related",
              parts: [{ mimeType: "image/jpeg", filename: "foto.jpg", body: { attachmentId: "att-b", size: 2000 } }]
            }
          ]
        }
      })
    );
    const transport = new GmailTransport();
    const result = await transport.invoke("list_messages", { max: 5 }, "refresh-token");
    const data = result.data as { messages: Array<{ attachments: Array<{ attachment_id: string }> }> };
    expect(data.messages[0]?.attachments.map((a) => a.attachment_id)).toEqual(["att-a", "att-b"]);
  });

  it("E: list_messages sender EGEN query-parameter når oppgitt, ellers default newer_than:14d", async () => {
    queue.push(jsonResponse(200, { messages: [] }));
    const transport = new GmailTransport();
    await transport.invoke("list_messages", { max: 5, query: "has:attachment newer_than:7d" }, "refresh-token");
    expect(calls.some((c) => c.url.includes(encodeURIComponent("has:attachment newer_than:7d")))).toBe(true);

    queue.push(jsonResponse(200, { messages: [] }));
    await transport.invoke("list_messages", { max: 5 }, "refresh-token");
    expect(calls.some((c) => c.url.includes(encodeURIComponent("newer_than:14d")))).toBe(true);
  });

  it("F: read_attachment - konverterer Gmail sin URL-safe base64 (-/_, ingen padding) til standard base64 (+//=, med padding)", async () => {
    // Deterministisk: "-" → "+", "_" → "/", og manglende padding gjenopprettes (14 tegn, 14%4=2 → 2 "="-tegn lagt til).
    queue.push(jsonResponse(200, { size: 11, data: "hei-ver_den123" }));
    const transport = new GmailTransport();
    const result = await transport.invoke("read_attachment", { message_id: "m1", attachment_id: "att-123" }, "refresh-token");
    const data = result.data as { content_base64: string; size_bytes: number };
    expect(data.content_base64).toBe("hei+ver/den123==");
    expect(data.size_bytes).toBe(11);
  });

  it("G: read_attachment - 404 kaster en typet gmail_attachment_not_found-feil", async () => {
    queue.push(new Response("", { status: 404 }));
    const transport = new GmailTransport();
    await expect(
      transport.invoke("read_attachment", { message_id: "m1", attachment_id: "att-mangler" }, "refresh-token")
    ).rejects.toThrow(/gmail_attachment_not_found_att-mangler/);
  });

  it("H: ukjent handling kaster fortsatt gmail_unsupported_action_<navn>", async () => {
    const transport = new GmailTransport();
    await expect(transport.invoke("delete_everything", {}, "refresh-token")).rejects.toThrow(
      /gmail_unsupported_action_delete_everything/
    );
  });

  /**
   * D-348 (Tobias direkte i chat, live: Charlie svarte `gmail_unsupported_action_send`
   * på "send en epost til henrik@ffskis.com") - `tool_id: "email", action: "send"`
   * var registrert (klasse D) og policy-testet mot en FakeTransport, men den EKTE
   * `GmailTransport` (faktisk wiret i main.ts/worker-main.ts) manglet selve casen.
   */
  /** Rebygger den avsendte `raw`-MIME-strengen fra et fanget fetch-kall sin `init.body`, for assertions mot selve meldingsinnholdet. */
  function decodeRawMessage(init: RequestInit | undefined): string {
    const parsed = JSON.parse(String(init?.body)) as { raw: string };
    const standard = parsed.raw.replace(/-/g, "+").replace(/_/g, "/");
    const padding = standard.length % 4 === 0 ? "" : "=".repeat(4 - (standard.length % 4));
    return Buffer.from(standard + padding, "base64").toString("utf8");
  }

  /** Egen, isolert fetch-mock for `send`-testene: fanger init.body for `/messages/send`-kallet spesifikt (den delte beforeEach-mocken over registrerer kun url/method, ikke body). */
  function mockFetchCapturingSendBody(sendResponse: Response): { capturedInit: () => RequestInit | undefined } {
    let captured: RequestInit | undefined;
    global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return jsonResponse(200, { access_token: "fake-access-token" });
      }
      if (url.includes("/messages/send")) {
        captured = init;
        return sendResponse;
      }
      throw new Error(`uventet fetch-kall i send-test: ${url}`);
    }) as unknown as typeof fetch;
    return { capturedInit: () => captured };
  }

  it("I: send - POSTer til users.messages.send med et base64url-kodet RFC 2822 'raw'-felt, ASCII To/Subject uendret", async () => {
    const { capturedInit } = mockFetchCapturingSendBody(jsonResponse(200, { id: "sent-1", threadId: "t9" }));
    const transport = new GmailTransport();
    const result = await transport.invoke(
      "send",
      { to: "henrik@ffskis.com", subject: "Hei", body: "Det er Jarvis" },
      "refresh-token"
    );
    expect(capturedInit()?.method).toBe("POST");
    const raw = decodeRawMessage(capturedInit());
    expect(raw).toContain("To: henrik@ffskis.com");
    expect(raw).toContain("Subject: Hei");
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    expect(raw).toContain(Buffer.from("Det er Jarvis", "utf8").toString("base64"));
    expect((result.data as { id: string }).id).toBe("sent-1");
  });

  it("J: send - Subject med norske tegn (æøå) RFC 2047-kodes (=?UTF-8?B?...?=), body base64-kodes i meldingskroppen", async () => {
    const { capturedInit } = mockFetchCapturingSendBody(jsonResponse(200, { id: "sent-2" }));
    const transport = new GmailTransport();
    await transport.invoke("send", { to: "a@b.no", subject: "Møte i går", body: "hei på deg" }, "refresh-token");
    const raw = decodeRawMessage(capturedInit());
    const expectedEncodedSubject = `=?UTF-8?B?${Buffer.from("Møte i går", "utf8").toString("base64")}?=`;
    expect(raw).toContain(`Subject: ${expectedEncodedSubject}`);
    expect(raw).toContain(Buffer.from("hei på deg", "utf8").toString("base64"));
  });

  it("K: send - feil HTTP-status kaster gmail_error_<status>", async () => {
    queue.push(new Response("", { status: 403 }));
    const transport = new GmailTransport();
    await expect(
      transport.invoke("send", { to: "a@b.no", subject: "x", body: "y" }, "refresh-token")
    ).rejects.toThrow(/gmail_error_403/);
  });
});
