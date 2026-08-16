import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicAdapter,
  GeminiAdapter,
  KimiAdapter,
  OllamaAdapter,
  OpenAiAdapter,
  textOnly,
  type ChatMessage,
  type ContentPart
} from "../src/index.ts";

/**
 * UA-2 P1B-A (D-43 §3): `ChatMessage.content` ble utvidet fra `string` til
 * `string | ContentPart[]` for vision/OCR-ingestion. Denne suiten beviser at
 * (a) `textOnly()` degraderer korrekt, og (b) hver adapter enten sender EKTE
 * bildeblokker (Anthropic - eneste adapter med reell støtte denne runden) eller
 * ALDRI sender et rått array som `content` til leverandøren (alle andre -
 * degraderer trygt til tekst via `textOnly()`, se capability-registry.ts sin
 * begrunnelse for hvorfor `vision` kun står på anthropic sin profil).
 */
const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const IMAGE_PART: ContentPart = { type: "image", media_type: "image/png", data: "aGVsbG8=" };
const TEXT_PART: ContentPart = { type: "text", text: "beskriv bildet" };
const MULTIMODAL_MESSAGE: ChatMessage = { role: "user", content: [TEXT_PART, IMAGE_PART] };

describe("textOnly()", () => {
  it("A: streng-innhold gis tilbake uendret", () => {
    expect(textOnly("hei verden")).toBe("hei verden");
  });
  it("B: ContentPart[] - kun tekstdelene trekkes ut, i rekkefølge, linjeskift mellom", () => {
    expect(textOnly([{ type: "text", text: "første" }, IMAGE_PART, { type: "text", text: "andre" }])).toBe("første\nandre");
  });
  it("C: ContentPart[] KUN med bilde(r) - tom streng, kaster ALDRI", () => {
    expect(textOnly([IMAGE_PART])).toBe("");
  });
  it("D: tomt array - tom streng", () => {
    expect(textOnly([])).toBe("");
  });
});

describe("AnthropicAdapter - EKTE bildestøtte (eneste adapter denne runden, se D-43 §3)", () => {
  let capturedBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    global.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(200, {
        content: [{ type: "text", text: "OK" }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn"
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("E: en melding med ContentPart[] blir en Anthropic-content-array med text- OG image-blokker", async () => {
    const adapter = new AnthropicAdapter("test-key", "test-model", "http://mock");
    await adapter.complete({ messages: [MULTIMODAL_MESSAGE] });
    const messages = capturedBody?.["messages"] as Array<{ role: string; content: unknown }>;
    const sent = messages[0]?.content as Array<Record<string, unknown>>;
    expect(sent).toEqual([
      { type: "text", text: "beskriv bildet" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }
    ]);
  });

  it("F: en vanlig streng-melding forblir en ren streng (bakoverkompatibel, ingen array-innpakking)", async () => {
    const adapter = new AnthropicAdapter("test-key", "test-model", "http://mock");
    await adapter.complete({ messages: [{ role: "user", content: "hei" }] });
    const messages = capturedBody?.["messages"] as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.content).toBe("hei");
  });
});

describe("Ikke-vision-adaptere degraderer ContentPart[] TRYGT til tekst - ALDRI et rått array sendt til leverandøren", () => {
  let capturedBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    global.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(200, {
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        message: { content: "OK" },
        prompt_eval_count: 10,
        eval_count: 5,
        done_reason: "stop"
      });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("G: OpenAiAdapter sender textOnly() - streng, ikke array", async () => {
    const adapter = new OpenAiAdapter("test-key", "test-model", "http://mock");
    await adapter.complete({ messages: [MULTIMODAL_MESSAGE] });
    const messages = capturedBody?.["messages"] as Array<{ role: string; content: unknown }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(typeof userMsg?.content).toBe("string");
    expect(userMsg?.content).toBe("beskriv bildet");
  });

  it("H: GeminiAdapter sender textOnly() inn i parts[0].text - aldri et objekt/array som text", async () => {
    const adapter = new GeminiAdapter("test-key", "test-model", "http://mock");
    await adapter.complete({ messages: [MULTIMODAL_MESSAGE] });
    const contents = capturedBody?.["contents"] as Array<{ parts: Array<{ text: unknown }> }>;
    expect(typeof contents[0]?.parts[0]?.text).toBe("string");
    expect(contents[0]?.parts[0]?.text).toBe("beskriv bildet");
  });

  it("I: KimiAdapter sender textOnly() - streng, ikke array", async () => {
    const adapter = new KimiAdapter("test-key", "test-model", "http://mock");
    await adapter.complete({ messages: [MULTIMODAL_MESSAGE] });
    const messages = capturedBody?.["messages"] as Array<{ role: string; content: unknown }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(typeof userMsg?.content).toBe("string");
  });

  it("J: OllamaAdapter sender textOnly() - streng, ikke array", async () => {
    const adapter = new OllamaAdapter("http://mock", "test-model");
    await adapter.complete({ messages: [MULTIMODAL_MESSAGE] });
    const messages = capturedBody?.["messages"] as Array<{ role: string; content: unknown }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(typeof userMsg?.content).toBe("string");
  });
});
