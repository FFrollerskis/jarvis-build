import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LocalOpenAiCompatibleAdapter, ThinkFilter } from "../src/local-llm.ts";
import { ProviderError, type StreamEvent } from "../src/types.ts";

/** D-404: ekte SSE-strømming i den lokale OpenAI-kompatible adapteren. Mot en fake SSE-server (ikke en ekte Ollama). */
const servers: Server[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

type Handler = (body: Record<string, unknown>) => { status?: number; chunks?: string[]; hang?: boolean; endEarly?: boolean };
async function sseServer(handler: Handler): Promise<{ url: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>;
      bodies.push(body);
      const r = handler(body);
      if (r.hang) return;
      res.writeHead(r.status ?? 200, { "content-type": "text/event-stream" });
      for (const c of r.chunks ?? []) res.write(`data: ${c}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}
const delta = (content: string) => JSON.stringify({ choices: [{ delta: { content } }] });
const finish = (reason = "stop") => JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] });
const usage = JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } });

async function run(adapter: LocalOpenAiCompatibleAdapter, request = { messages: [{ role: "user" as const, content: "hei" }] }, signal?: AbortSignal) {
  const events: StreamEvent[] = [];
  const result = await adapter.stream(request, (e) => events.push(e), signal);
  return { events, result };
}
const texts = (events: StreamEvent[]) => events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text);

describe("ThinkFilter", () => {
  it("fjerner <think>-blokker, også når taggene er delt over deltaer", () => {
    const f = new ThinkFilter();
    const out = ["Hei <th", "ink>hemmelig tenk", "ing</thi", "nk> verden"].map((c) => f.push(c)).join("") + f.flush();
    expect(out).toBe("Hei  verden");
    expect(out).not.toContain("hemmelig");
  });
  it("er ikke case-sensitiv og forkaster en åpen blokk ved slutten", () => {
    const f = new ThinkFilter();
    expect(f.push("A<THINK>skjult") + f.flush()).toBe("A");
  });
  it("slipper vanlig tekst og et '<' som ikke er en tagg gjennom", () => {
    const f = new ThinkFilter();
    expect(f.push("a < b og <b>fet</b>") + f.flush()).toBe("a < b og <b>fet</b>");
    const g = new ThinkFilter();
    expect(g.push("slutter på <thi") + g.flush()).toBe("slutter på <thi");
  });
});

describe("LocalOpenAiCompatibleAdapter.stream()", () => {
  it("strømmer tekst som deltaer, rapporterer usage/finish og ber om stream_options.include_usage", async () => {
    const s = await sseServer(() => ({ chunks: [delta("Hei"), delta(" Tobias"), finish(), usage, "[DONE]"] }));
    const { events, result } = await run(new LocalOpenAiCompatibleAdapter(s.url, "llama3.1:8b", 5000, "gemma_local"));
    expect(texts(events)).toEqual(["Hei", " Tobias"]);
    expect(result.text).toBe("Hei Tobias");
    expect(result.provider).toBe("gemma_local");
    expect(result.model).toBe("llama3.1:8b");
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    expect(result.finish_reason).toBe("stop");
    expect(result.ttft_ms).toBeTypeOf("number");
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "text_delta", "usage", "finish"]);
    expect(s.bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true }, model: "llama3.1:8b" });
  });

  it("filtrerer <think> bort fra det som strømmes og fra sluttteksten", async () => {
    const s = await sseServer(() => ({ chunks: [delta("<think>plan"), delta("legging</think>Svar"), delta(" her"), finish(), "[DONE]"] }));
    const { events, result } = await run(new LocalOpenAiCompatibleAdapter(s.url, "qwen3:8b", 5000, "gemma_local"));
    expect(texts(events).join("")).toBe("Svar her");
    expect(result.text).toBe("Svar her");
  });

  it("setter sammen verktøykall fra deltaer (med og uten index) og leverer tool_call_complete", async () => {
    const withIndex = await sseServer(() => ({ chunks: [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "calendar_list", arguments: "{\"da" } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "y\":\"i dag\"}" } }] } }] }),
      finish("tool_calls"), "[DONE]"
    ] }));
    const a = await run(new LocalOpenAiCompatibleAdapter(withIndex.url, "m", 5000, "gemma_local"));
    expect(a.result.tool_calls).toHaveLength(1);
    expect(a.result.tool_calls![0]).toMatchObject({ tool_call_id: "call_1", tool_name: "calendar_list", arguments: { day: "i dag" }, provider: "gemma_local" });
    expect(a.events.some((e) => e.type === "tool_call_complete")).toBe(true);

    // Enkelte lokale servere utelater `index`: posisjonen i listen brukes.
    const noIndex = await sseServer(() => ({ chunks: [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "a", arguments: "{}" } }, { id: "c2", function: { name: "b", arguments: "{}" } }] } }] }),
      finish("tool_calls"), "[DONE]"
    ] }));
    const b = await run(new LocalOpenAiCompatibleAdapter(noIndex.url, "m", 5000, "gemma_local"));
    expect(b.result.tool_calls!.map((c) => c.tool_name)).toEqual(["a", "b"]);
  });

  it("ugyldige verktøyargumenter gir invalid_tool_call (aldri stille)", async () => {
    const s = await sseServer(() => ({ chunks: [JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "t", arguments: "{ikke json" } }] } }] }), finish("tool_calls"), "[DONE]"] }));
    await expect(run(new LocalOpenAiCompatibleAdapter(s.url, "m", 5000, "gemma_local"))).rejects.toMatchObject({ kind: "invalid_tool_call" });
  });

  it("en strøm uten finish_reason og uten [DONE] er stream_interrupted, ikke et komplett svar", async () => {
    const s = await sseServer(() => ({ chunks: [delta("halv")] }));
    await expect(run(new LocalOpenAiCompatibleAdapter(s.url, "m", 5000, "gemma_local"))).rejects.toMatchObject({ kind: "stream_interrupted" });
  });

  it("HTTP-feil og utilgjengelig server klassifiseres (server / network), timeout klassifiseres som timeout", async () => {
    const s500 = await sseServer(() => ({ status: 500 }));
    await expect(run(new LocalOpenAiCompatibleAdapter(s500.url, "m", 5000, "gemma_local"))).rejects.toMatchObject({ kind: "server" });
    await expect(run(new LocalOpenAiCompatibleAdapter("http://127.0.0.1:1", "m", 2000, "gemma_local"))).rejects.toBeInstanceOf(ProviderError);
    const hang = await sseServer(() => ({ hang: true }));
    await expect(run(new LocalOpenAiCompatibleAdapter(hang.url, "m", 150, "gemma_local"))).rejects.toMatchObject({ kind: "timeout" });
  });

  it("avbrudd via signal gir cancelled", async () => {
    const hang = await sseServer(() => ({ hang: true }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(run(new LocalOpenAiCompatibleAdapter(hang.url, "m", 5000, "gemma_local"), undefined, ac.signal)).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("uten URL: not_configured", async () => {
    await expect(run(new LocalOpenAiCompatibleAdapter(undefined, "m", 5000, "gemma_local"))).rejects.toMatchObject({ kind: "not_configured" });
  });

  it("complete() er uendret: stream:false og ingen stream_options i forespørselen", async () => {
    const s = await sseServer(() => ({ chunks: [] }));
    const a = new LocalOpenAiCompatibleAdapter(s.url, "m", 5000, "gemma_local");
    await a.complete({ messages: [{ role: "user", content: "hei" }] }).catch(() => undefined);
    expect(s.bodies[0]).toMatchObject({ stream: false });
    expect(s.bodies[0]).not.toHaveProperty("stream_options");
  });
});
