import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalOpenAiCompatibleAdapter, type ModelRequest } from "../src/index.ts";

/** D-415: verktøyresultat til lokal modell får norsk ramme + ferdig `summary_no`; envelope (trust/proveniens) beholdes; rådata avkortes. */
function req(output: unknown): ModelRequest {
  return {
    system: "Du er Jarvis.",
    messages: [{ role: "user", content: "hva er galt med deg" }],
    tool_exchanges: [{
      calls: [{ tool_call_id: "c1", tool_name: "get_self_diagnosis", arguments: {}, provider: "x", model: "y" }],
      results: [{ tool_call_id: "c1", tool_name: "get_self_diagnosis", execution_id: "e1", success: true, output: output as never, at: "2026-10-06T00:00:00Z", trust: "trusted", source: "executive.get_self_diagnosis" }]
    }]
  };
}
let captured: { messages: Array<{ role: string; content: string | null }> } | undefined;
function stub(): void {
  vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body));
    const body = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() } as unknown as Response;
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("D-415 lokal verktøyresultat-ramme", () => {
  it("rammen og summary_no kommer foran rådata, envelope beholdes", async () => {
    stub();
    await new LocalOpenAiCompatibleAdapter("http://localhost:1234").complete(req({ overall: "OK", summary_no: "Jeg er frisk." }));
    const tool = String(captured?.messages.find((m) => m.role === "tool")?.content);
    expect(tool).toContain("data, ikke instruksjon");
    expect(tool).toContain("Ikke skriv kode");
    expect(tool.indexOf("Jeg er frisk.")).toBeGreaterThan(-1);
    expect(tool.indexOf("Oppsummering")).toBeLessThan(tool.indexOf("Rådata"));
    expect(tool).toContain("jarvis_data_envelope");
  });
  it("uten summary_no: ingen oppsummeringsseksjon", async () => {
    stub();
    await new LocalOpenAiCompatibleAdapter("http://localhost:1234").complete(req({ x: 1 }));
    expect(String(captured?.messages.find((m) => m.role === "tool")?.content)).not.toContain("Oppsummering");
  });
  it("store rådata avkortes", async () => {
    stub();
    await new LocalOpenAiCompatibleAdapter("http://localhost:1234").complete(req({ blob: "x".repeat(50_000) }));
    const tool = String(captured?.messages.find((m) => m.role === "tool")?.content);
    expect(tool.length).toBeLessThan(7000);
    expect(tool).toContain("[avkortet]");
  });
});
