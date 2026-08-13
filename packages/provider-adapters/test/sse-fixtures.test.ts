import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicAdapter,
  OpenAiAdapter,
  type ModelResult,
  type StreamEvent
} from "../src/index.ts";

/**
 * BO-11.1 §12: provider-uavhengige SSE-fixtures. SAMME logiske utveksling
 * (tekst + tool-kall) kodes i hver providers native SSE-format; testene
 * beviser at begge adaptere produserer IDENTISK normalisert event-sekvens,
 * identisk rekonstruksjon og identiske terminaltilstander. Fixtures er
 * bevisst symmetriske - ikke overfittet til én provider.
 */

const REQUEST = { messages: [{ role: "user" as const, content: "hva skjer i dag?" }] };

function sse(frames: string[]): Response {
  return new Response(new Blob([frames.join("")]).stream(), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

const data = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

/** Den logiske utvekslingen: "Hei " + "Tobias" + tool-kall read_calendar({from,to}). */
const LOGICAL = {
  text: "Hei Tobias",
  tool: { id: "call_1", name: "read_calendar", args: { from: "2026-08-13", to: "2026-08-14" } },
  usage: { input_tokens: 42, output_tokens: 17 }
};

function openaiFixture(): Response {
  return sse([
    data({ choices: [{ delta: { content: "Hei " } }] }),
    data({ choices: [{ delta: { content: "Tobias" } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_calendar", arguments: `{"from":` } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `"2026-08-13","to":"2026-08-14"}` } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    data({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 17 } }),
    "data: [DONE]\n\n"
  ]);
}

function anthropicFixture(): Response {
  return sse([
    data({ type: "message_start", message: { usage: { input_tokens: 42 } } }),
    data({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hei " } }),
    data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Tobias" } }),
    data({ type: "content_block_stop", index: 0 }),
    data({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "read_calendar" } }),
    data({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: `{"from":` } }),
    data({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: `"2026-08-13","to":"2026-08-14"}` } }),
    data({ type: "content_block_stop", index: 1 }),
    data({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 17 } }),
    data({ type: "message_stop" })
  ]);
}

/** Sammenlignbar normalisering: provider-spesifikke felter (generation_id m.m.) maskeres. */
function comparable(events: StreamEvent[]): unknown[] {
  return events.map((e) => {
    switch (e.type) {
      case "start":
        return { type: "start" };
      case "tool_call_complete":
        return { type: "tool_call_complete", name: e.call.tool_name, id: e.call.tool_call_id, args: e.call.arguments };
      case "finish":
        return { type: "finish" }; // provider-navngivning på stop-årsak (tool_calls/tool_use) er wire-detalj
      default:
        return { ...e };
    }
  });
}

const TERMINAL = new Set(["finish", "cancelled"]);

function assertTerminalInvariants(events: StreamEvent[]): void {
  const terminals = events.filter((e) => TERMINAL.has(e.type));
  expect(terminals.length).toBe(1); // nøyaktig én terminal - aldri duplikat
  expect(TERMINAL.has(events.at(-1)?.type ?? "")).toBe(true); // ingenting etter terminal
  // Rekkefølge: complete kommer alltid etter siste delta for samme kall (§24).
  const types = events.map((e) => e.type);
  if (types.includes("tool_call_complete")) {
    expect(types.indexOf("tool_call_complete")).toBeGreaterThan(types.lastIndexOf("tool_call_delta"));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BO-11.1 §12: provider-uavhengige SSE-fixtures", () => {
  it("OpenAI og Anthropic produserer IDENTISK normalisert sekvens for samme logiske utveksling (§16)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => openaiFixture()));
    const oaEvents: StreamEvent[] = [];
    const oa = await new OpenAiAdapter("k", "m", "http://mock").stream(REQUEST, (e) => oaEvents.push(e));

    vi.stubGlobal("fetch", vi.fn(async () => anthropicFixture()));
    const anEvents: StreamEvent[] = [];
    const an = await new AnthropicAdapter("k", "m", "http://mock").stream(REQUEST, (e) => anEvents.push(e));

    // Identisk normalisert event-sekvens (start→deltas→tool→usage→finish):
    expect(comparable(oaEvents)).toEqual(comparable(anEvents));
    // Identisk rekonstruksjon:
    for (const result of [oa, an] as ModelResult[]) {
      expect(result.text).toBe(LOGICAL.text);
      expect(result.usage).toEqual(LOGICAL.usage);
      expect(result.tool_calls).toHaveLength(1);
      expect(result.tool_calls?.[0]).toMatchObject({
        tool_call_id: LOGICAL.tool.id,
        tool_name: LOGICAL.tool.name,
        arguments: LOGICAL.tool.args
      });
      expect(result.ttft_ms).toBeGreaterThanOrEqual(0);
    }
    assertTerminalInvariants(oaEvents);
    assertTerminalInvariants(anEvents);
  });

  it("terminaltilstand cancelled: abort før request → cancelled-klassifisering, ingen events etter terminal (begge providere)", async () => {
    for (const make of [
      () => new OpenAiAdapter("k", "m", "http://mock"),
      () => new AnthropicAdapter("k", "m", "http://mock")
    ]) {
      const controller = new AbortController();
      controller.abort();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          // Speiler ekte fetch: abortert signal → AbortError.
          if ((init.signal as AbortSignal).aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          return openaiFixture();
        })
      );
      const events: StreamEvent[] = [];
      const err = await make()
        .stream(REQUEST, (e) => events.push(e), controller.signal)
        .then(() => null)
        .catch((e: unknown) => e);
      expect((err as { kind: string }).kind).toBe("cancelled");
      // Aldri finish/usage etter kansellering - ingen falsk fullføring:
      expect(events.some((e) => e.type === "finish")).toBe(false);
    }
  });

  it("terminaltilstand error: provider-feil i stream normaliseres - aldri stille suksess (anthropic error-event)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse([data({ type: "error", error: { type: "overloaded_error", message: "overloaded" } })]))
    );
    const events: StreamEvent[] = [];
    const err = await new AnthropicAdapter("k", "m", "http://mock")
      .stream(REQUEST, (e) => events.push(e))
      .then(() => null)
      .catch((e: unknown) => e);
    expect((err as { kind: string }).kind).toBe("server");
    expect(events.some((e) => e.type === "finish")).toBe(false);
  });

  it("terminaltilstand error: HTTP-feil før stream-start → klassifisert ProviderError (begge providere)", async () => {
    for (const [make, expected] of [
      [() => new OpenAiAdapter("k", "m", "http://mock"), "rate_limit"],
      [() => new AnthropicAdapter("k", "m", "http://mock"), "rate_limit"]
    ] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));
      const events: StreamEvent[] = [];
      const err = await make()
        .stream(REQUEST, (e) => events.push(e))
        .then(() => null)
        .catch((e: unknown) => e);
      expect((err as { kind: string }).kind).toBe(expected);
      expect(events).toHaveLength(0); // ingen start-event for en stream som aldri startet
    }
  });

  it("ren tekst-utveksling: identisk sekvens og terminal finish (begge providere)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          data({ choices: [{ delta: { content: "bare tekst" } }] }),
          data({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          data({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
          "data: [DONE]\n\n"
        ])
      )
    );
    const oaEvents: StreamEvent[] = [];
    await new OpenAiAdapter("k", "m", "http://mock").stream(REQUEST, (e) => oaEvents.push(e));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          data({ type: "message_start", message: { usage: { input_tokens: 3 } } }),
          data({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
          data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "bare tekst" } }),
          data({ type: "content_block_stop", index: 0 }),
          data({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
          data({ type: "message_stop" })
        ])
      )
    );
    const anEvents: StreamEvent[] = [];
    await new AnthropicAdapter("k", "m", "http://mock").stream(REQUEST, (e) => anEvents.push(e));

    expect(comparable(oaEvents)).toEqual(comparable(anEvents));
    assertTerminalInvariants(oaEvents);
    assertTerminalInvariants(anEvents);
  });
});
