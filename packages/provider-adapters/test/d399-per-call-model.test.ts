import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter, OpenAiAdapter, effectiveModel } from "../src/index.ts";

/** D-399: ModelRequest.model overstyrer adapterens standardmodell per kall - validert, og rapportert i resultatet. */
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

describe("effectiveModel", () => {
  it("udefinert => standard; gyldig id => id; ugyldig => kaster (URL/JSON-injeksjon)", () => {
    expect(effectiveModel({}, "default")).toBe("default");
    expect(effectiveModel({ model: "claude-sonnet-5-5" }, "default")).toBe("claude-sonnet-5-5");
    for (const bad of ["", "../x", "a b", "m?x=1", "m/../../n", "-start", "x".repeat(101)]) {
      expect(() => effectiveModel({ model: bad }, "default"), bad).toThrow("invalid_model_override");
    }
  });
});

describe("adaptere sender per-kall-modellen", () => {
  it("Anthropic: body.model = overstyring, result.model likeså; uten overstyring standard", async () => {
    const bodies: Array<{ model: string }> = [];
    global.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "hei" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const a = new AnthropicAdapter("key", "claude-sonnet-5");
    const withOverride = await a.complete({ messages: [{ role: "user", content: "x" }], model: "claude-haiku-4-5-20251001" });
    const without = await a.complete({ messages: [{ role: "user", content: "x" }] });
    expect(bodies.map((b) => b.model)).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-5"]);
    expect(withOverride.model).toBe("claude-haiku-4-5-20251001");
    expect(without.model).toBe("claude-sonnet-5");
  });

  it("OpenAI: body.model = overstyring", async () => {
    const bodies: Array<{ model: string }> = [];
    global.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "hei" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const o = new OpenAiAdapter("key", "gpt-5");
    const r = await o.complete({ messages: [{ role: "user", content: "x" }], model: "gpt-4o-mini" });
    expect(bodies[0]?.model).toBe("gpt-4o-mini");
    expect(r.model).toBe("gpt-4o-mini");
  });

  it("ugyldig overstyring avvises før noe nettverkskall", async () => {
    const f = vi.fn();
    global.fetch = f as unknown as typeof fetch;
    const a = new AnthropicAdapter("key", "claude-sonnet-5");
    await expect(a.complete({ messages: [{ role: "user", content: "x" }], model: "../evil" })).rejects.toThrow("invalid_model_override");
    expect(f).not.toHaveBeenCalled();
  });
});
