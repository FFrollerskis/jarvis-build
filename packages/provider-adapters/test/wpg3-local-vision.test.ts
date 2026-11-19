import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicAdapter,
  GemmaHostedAdapter,
  LocalOpenAiCompatibleAdapter,
  ProviderError,
  assertNoRestrictedMedia,
  hasRestrictedMedia,
  type ChatMessage,
  type ContentPart
} from "../src/index.ts";

/**
 * WP-G3 (D-465), P1b: (a) den lokale adapteren sender bilder KUN når den er konstruert med `{ vision: true }` (ellers droppes de som før -
 * `local_llm`/`gemma_local` er uendret), som `image_url` med base64 `data:`-URL og ALDRI en ekstern URL; (b) et BEGRENSET kamerabilde
 * (`restricted: true`) kommer aldri ut av en skyadapter med bildestøtte (Anthropic, Gemma hostet) - kastet FØR noe sendes.
 * Ingen ekte nettkall: `fetch` er en fake.
 */
const originalFetch = global.fetch;
const fetchSpy = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const IMAGE: ContentPart = { type: "image", media_type: "image/jpeg", data: "aGVsbG8=" };
const RESTRICTED_IMAGE: ContentPart = { type: "image", media_type: "image/jpeg", data: "aGVsbG8=", restricted: true };
const TEXT: ContentPart = { type: "text", text: "beskriv bildet" };
const message = (...parts: ContentPart[]): ChatMessage => ({ role: "user", content: parts });

let captured: Record<string, unknown> | undefined;

beforeEach(() => {
  captured = undefined;
  fetchSpy.mockReset();
  global.fetch = (async (input: string | URL, init?: RequestInit) => {
    fetchSpy(String(input));
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse(200, { choices: [{ message: { content: "{\"detections\":[]}" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("hasRestrictedMedia", () => {
  it("er sann kun når en bildedel har restricted: true", () => {
    expect(hasRestrictedMedia({ messages: [message(TEXT, RESTRICTED_IMAGE)] })).toBe(true);
    expect(hasRestrictedMedia({ messages: [message(TEXT, IMAGE)] })).toBe(false);
    expect(hasRestrictedMedia({ messages: [{ role: "user", content: "ren tekst" }] })).toBe(false);
    expect(hasRestrictedMedia({})).toBe(false);
  });

  it("kaster aldri på en deformert delliste (null, tall, streng) - gatewayen tåler slikt innhold fra før", () => {
    const malformed = { role: "user", content: [null, 7, "x", { type: "text", text: "a" }, RESTRICTED_IMAGE] } as unknown as ChatMessage;
    expect(hasRestrictedMedia({ messages: [malformed] })).toBe(true);
    const malformedNoImage = { role: "user", content: [null, 7, "x"] } as unknown as ChatMessage;
    expect(hasRestrictedMedia({ messages: [malformedNoImage] })).toBe(false);
  });

  it("restricted står aldri på en tekstdel og en streng-melding kan ikke bære den", () => {
    const sneaky = { role: "user", content: [{ type: "text", text: "x", restricted: true }] } as unknown as ChatMessage;
    expect(hasRestrictedMedia({ messages: [sneaky] })).toBe(false);
    expect(() => assertNoRestrictedMedia("anthropic", { messages: [message(RESTRICTED_IMAGE)] })).toThrow(ProviderError);
  });
});

describe("LocalOpenAiCompatibleAdapter - vision er av som standard (uendret oppførsel)", () => {
  it("uten { vision: true } droppes bildedelen stille og content er ren tekst (som før WP-G3)", async () => {
    const adapter = new LocalOpenAiCompatibleAdapter("http://127.0.0.1:11434", "m", 5_000, "gemma_local");
    await adapter.complete({ messages: [message(TEXT, IMAGE)] });
    const sent = (captured?.["messages"] as Array<{ content: unknown }>)[0]?.content;
    expect(sent).toBe("beskriv bildet");
  });

  it("en ren tekstmelding er byte-for-byte lik med og uten vision", async () => {
    const plain = new LocalOpenAiCompatibleAdapter("http://127.0.0.1:11434", "m", 5_000, "local_llm");
    await plain.complete({ messages: [{ role: "user", content: "hei" }] });
    const a = JSON.stringify(captured);
    const vision = new LocalOpenAiCompatibleAdapter("http://127.0.0.1:11434", "m", 5_000, "local_llm", "default", { vision: true });
    await vision.complete({ messages: [{ role: "user", content: "hei" }] });
    expect(JSON.stringify(captured)).toBe(a);
  });
});

describe("LocalOpenAiCompatibleAdapter - { vision: true } (local_vision)", () => {
  const vision = () => new LocalOpenAiCompatibleAdapter("http://127.0.0.1:11434/v1", "vl-model", 5_000, "local_vision", "default", { vision: true });

  it("sender tekst + image_url med base64 data-URL (aldri en ekstern URL), til det lokale endepunktet", async () => {
    await vision().complete({ messages: [message(TEXT, RESTRICTED_IMAGE)] });
    const content = (captured?.["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]?.content;
    expect(content).toEqual([
      { type: "text", text: "beskriv bildet" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,aGVsbG8=" } }
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(JSON.stringify(captured)).not.toMatch(/https?:\/\/[^"]*\.(jpe?g|png|webp)/i);
  });

  it("avviser ugyldig media type, ikke-base64 og tom bildedata som bad_request FØR noe sendes", async () => {
    for (const bad of [
      { type: "image", media_type: "image/svg+xml", data: "aGVsbG8=" },
      { type: "image", media_type: "image/jpeg", data: "http://evil.example/x.jpg" },
      { type: "image", media_type: "image/jpeg", data: "" },
      { type: "image", media_type: "image/jpeg\"; drop", data: "aGVsbG8=" }
    ] as ContentPart[]) {
      await expect(vision().complete({ messages: [message(TEXT, bad)] })).rejects.toMatchObject({ kind: "bad_request" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("en melding uten bildedeler er identisk med standardstien (tekst slås sammen som før)", async () => {
    await vision().complete({ messages: [message(TEXT, { type: "text", text: "mer" })] });
    expect((captured?.["messages"] as Array<{ content: unknown }>)[0]?.content).toBe("beskriv bildet\nmer");
  });

  it("følger ALDRI en redirect (redirect: «error») - en 307/308 ville sendt kamerabildene videre; øvrige identiteter sender ingen redirect-policy (uendret)", async () => {
    const policies: Array<RequestInit["redirect"]> = [];
    global.fetch = (async (_input: string | URL, init?: RequestInit) => {
      policies.push(init?.redirect);
      return jsonResponse(200, { choices: [{ message: { content: "{\"detections\":[]}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as unknown as typeof fetch;
    await vision().complete({ messages: [message(TEXT, RESTRICTED_IMAGE)] });
    await new LocalOpenAiCompatibleAdapter("http://127.0.0.1:11434/v1", "m", 5_000, "gemma_local").complete({ messages: [message(TEXT)] });
    await new LocalOpenAiCompatibleAdapter("http://127.0.0.1:11434/v1", "m", 5_000).complete({ messages: [message(TEXT)] });
    expect(policies).toEqual(["error", undefined, undefined]);
  });

  it("en server som svarer med redirect gir en klassifisert leverandørfeil og ingen oppfølgingsforespørsel (ekte HTTP mot lokal server)", async () => {
    global.fetch = originalFetch; // ekte fetch mot to ekte lokale servere
    const { createServer } = await import("node:http");
    const hits: string[] = [];
    const target = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetPort = (target.address() as { port: number }).port;
    const redirector = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/exfil` });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const port = (redirector.address() as { port: number }).port;
    try {
      const adapter = new LocalOpenAiCompatibleAdapter(`http://127.0.0.1:${port}`, "vl", 5_000, "local_vision", "default", { vision: true });
      await expect(adapter.complete({ messages: [message(TEXT, RESTRICTED_IMAGE)] })).rejects.toBeInstanceOf(ProviderError);
      await expect(adapter.stream({ messages: [message(TEXT, RESTRICTED_IMAGE)] }, () => undefined)).rejects.toBeInstanceOf(ProviderError);
      expect(hits).toEqual([]); // målet fikk aldri en forespørsel (heller ikke bildene)
    } finally {
      redirector.closeAllConnections();
      target.closeAllConnections();
      await new Promise<void>((resolve) => redirector.close(() => resolve()));
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
});

describe("LocalOpenAiCompatibleAdapter - bytetak på svaret for visjonsidentiteten (review A-L6)", () => {
  const vision = () => new LocalOpenAiCompatibleAdapter("http://127.0.0.1:11434/v1", "vl-model", 5_000, "local_vision", "default", { vision: true });
  const plain = () => new LocalOpenAiCompatibleAdapter("http://127.0.0.1:11434/v1", "m", 5_000, "local_llm");
  const hugeAnswer = (chars: number) => ({ choices: [{ message: { content: "x".repeat(chars) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

  it("et 3 MiB svar avvises som invalid_response (local_vision_response_too_large), mens et vanlig svar og en annen identitet med samme store svar er uendret", async () => {
    global.fetch = (async () => jsonResponse(200, hugeAnswer(3 * 1024 * 1024))) as unknown as typeof fetch;
    await expect(vision().complete({ messages: [message(TEXT, RESTRICTED_IMAGE)] })).rejects.toMatchObject({ kind: "invalid_response", message: "local_vision_response_too_large" });
    const unchanged = await plain().complete({ messages: [message(TEXT)] });
    expect(unchanged.text).toHaveLength(3 * 1024 * 1024); // øvrige identiteter leser som før (flagg-AV-identitet)
    global.fetch = (async () => jsonResponse(200, hugeAnswer(2_000))) as unknown as typeof fetch;
    expect((await vision().complete({ messages: [message(TEXT, RESTRICTED_IMAGE)] })).text).toHaveLength(2_000);
  });

  it("en deklarert content-length over taket avvises uten å lese kroppen; ugyldig JSON og manglende choices er fortsatt invalid_response (uten too_large)", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
    global.fetch = (async () => new Response(body, { status: 200, headers: { "content-length": String(50 * 1024 * 1024), "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(vision().complete({ messages: [message(TEXT)] })).rejects.toMatchObject({ kind: "invalid_response", message: "local_vision_response_too_large" });
    expect(cancelled).toBe(true);
    global.fetch = (async () => new Response("ikke json", { status: 200 })) as unknown as typeof fetch;
    await expect(vision().complete({ messages: [message(TEXT)] })).rejects.toMatchObject({ kind: "invalid_response", message: "local_vision_invalid_response" });
    global.fetch = (async () => jsonResponse(200, { feil: true })) as unknown as typeof fetch;
    await expect(vision().complete({ messages: [message(TEXT)] })).rejects.toMatchObject({ message: "local_vision_invalid_response" });
  });

  it("en svært stor kropp fra en ekte lokal server stoppes ved taket: klienten avbryter og serveren skriver ikke videre", async () => {
    global.fetch = originalFetch;
    const { createServer } = await import("node:http");
    let sent = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{\"choices\":[{\"message\":{\"content\":\"");
      const chunk = "a".repeat(64 * 1024);
      timer = setInterval(() => {
        // Serveren avslutter selv gyldig JSON ved 32 MiB: uten taket i adapteren ville klienten lest ALT og godtatt svaret (testen feiler da på assertionen, uten å tømme minnet).
        if (sent >= 32 * 1024 * 1024) {
          clearInterval(timer);
          res.end("\"}}]}");
          return;
        }
        sent += chunk.length;
        res.write(chunk);
      }, 1);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const adapter = new LocalOpenAiCompatibleAdapter(`http://127.0.0.1:${port}`, "vl", 20_000, "local_vision", "default", { vision: true });
      await expect(adapter.complete({ messages: [message(TEXT, RESTRICTED_IMAGE)] })).rejects.toMatchObject({ kind: "invalid_response", message: "local_vision_response_too_large" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const afterAbort = sent;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sent).toBe(afterAbort); // serveren ser at forbindelsen er lukket og slutter å skrive
      expect(sent).toBeLessThan(32 * 1024 * 1024); // klienten avbrøt langt før serveren var ferdig
    } finally {
      if (timer !== undefined) clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("skyadaptere med bildestøtte nekter BEGRENSEDE kamerabilder (forsvar i dybden)", () => {
  it("AnthropicAdapter kaster bad_request og sender ingenting for et restricted bilde; et vanlig bilde fungerer som før", async () => {
    const adapter = new AnthropicAdapter("fake-key-for-test", "test-model", "http://mock");
    await expect(adapter.complete({ messages: [message(TEXT, RESTRICTED_IMAGE)] })).rejects.toMatchObject({ kind: "bad_request", provider: "anthropic" });
    await expect(adapter.stream({ messages: [message(TEXT, RESTRICTED_IMAGE)] }, () => undefined)).rejects.toMatchObject({ kind: "bad_request" });
    expect(fetchSpy).not.toHaveBeenCalled();
    global.fetch = (async (_input: string | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(200, { content: [{ type: "text", text: "OK" }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" });
    }) as unknown as typeof fetch;
    await adapter.complete({ messages: [message(TEXT, IMAGE)] });
    expect(JSON.stringify(captured)).toContain('"type":"image"');
  });

  it("GemmaHostedAdapter kaster bad_request og sender ingenting for et restricted bilde", async () => {
    const adapter = new GemmaHostedAdapter("fake-key-for-test");
    await expect(adapter.complete({ messages: [message(TEXT, RESTRICTED_IMAGE)] })).rejects.toMatchObject({ kind: "bad_request" });
    await expect(adapter.stream({ messages: [message(TEXT, RESTRICTED_IMAGE)] }, () => undefined)).rejects.toMatchObject({ kind: "bad_request" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
