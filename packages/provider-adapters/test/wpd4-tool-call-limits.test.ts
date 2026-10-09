import { describe, expect, it } from "vitest";
import { MAX_ARGUMENT_CHARS, MAX_STREAMED_CALLS, ProviderError, ToolCallStreamAssembler, normalizeToolCalls, type StreamEvent } from "../src/index.ts";

/**
 * WP-D4 (gjennomgang av PR #315, M5 iv): grensene for verktøykall fra Kimi (OpenAI-kompatibelt) var ikke låst av tester - de kunne settes til 100000 / 1e12 uten rød test. Her testes HVER grense på begge sider:
 * nøyaktig grensen passerer, ett over gir `invalid_tool_call` (og ingenting leveres). Verdiene er også festet, slik at en endring er en bevisst endring med et testutslag.
 */
const bad = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("invalid_tool_call");
    expect((err as ProviderError).message).toBe(`kimi_${code}`);
    return;
  }
  throw new Error(`forventet invalid_tool_call (${code})`);
};
/** Bevisst litteraler (ikke de eksporterte konstantene): en mutert konstant skal gi en RASK rød test, ikke en løkke på 100 000 kall eller en streng på 1e12 tegn. */
const CALLS = 64;
const CHARS = 1_000_000;
const raw = (i: number) => ({ id: `call-${i}`, type: "function", function: { name: "get_weather", arguments: "{}" } });

describe("grensene er festet", () => {
  it("MAX_STREAMED_CALLS = 64 og MAX_ARGUMENT_CHARS = 1 000 000", () => {
    expect(MAX_STREAMED_CALLS).toBe(64);
    expect(MAX_ARGUMENT_CHARS).toBe(1_000_000);
  });
});

describe("normalizeToolCalls (ikke-strømmet svar): maks 64 kall", () => {
  it("nøyaktig grensen passerer og bevarer rekkefølgen", () => {
    const out = normalizeToolCalls("kimi", "m", Array.from({ length: CALLS }, (_, i) => raw(i)));
    expect(out).toHaveLength(CALLS);
    expect(out[0]?.tool_call_id).toBe("call-0");
    expect(out[CALLS - 1]?.tool_call_id).toBe(`call-${CALLS - 1}`);
  });
  it("ett kall over grensen avvises (too_many_tool_calls) - ingen delvis liste", () => {
    bad(() => normalizeToolCalls("kimi", "m", Array.from({ length: CALLS + 1 }, (_, i) => raw(i))), "too_many_tool_calls");
    bad(() => normalizeToolCalls("kimi", "m", Array.from({ length: 1000 }, (_, i) => raw(i))), "too_many_tool_calls");
  });
});

describe("ToolCallStreamAssembler (strømmet svar): maks 64 kall og 1 000 000 argumenttegn per kall", () => {
  const assembler = () => {
    const events: StreamEvent[] = [];
    return { events, a: new ToolCallStreamAssembler("kimi", "m", (e) => events.push(e)) };
  };
  const delta = (index: number, args = "") => ({ index, id: `call-${index}`, function: { name: "get_weather", arguments: args } });

  it("nøyaktig 64 ulike kall passerer og leveres komplette", () => {
    const { a } = assembler();
    for (let i = 0; i < CALLS; i++) a.push([delta(i, "{}")]);
    expect(a.complete()).toHaveLength(CALLS);
  });

  it("kall nummer 65 avvises (too_many_tool_calls), uansett om det kommer som index eller bare nytt id", () => {
    const { a } = assembler();
    for (let i = 0; i < CALLS; i++) a.push([delta(i)]);
    bad(() => a.push([delta(CALLS)]), "too_many_tool_calls");
    const withIds = assembler().a;
    for (let i = 0; i < CALLS; i++) withIds.push([{ id: `id-${i}`, function: { name: "get_weather", arguments: "" } }]);
    bad(() => withIds.push([{ id: "id-over", function: { name: "get_weather", arguments: "" } }]), "too_many_tool_calls");
  });

  it("nytt fragment til et EKSISTERENDE kall teller ikke som et nytt kall", () => {
    const { a } = assembler();
    for (let i = 0; i < CALLS; i++) a.push([delta(i, "{")]);
    for (let i = 0; i < CALLS; i++) a.push([{ index: i, function: { arguments: "}" } }]);
    expect(a.complete()).toHaveLength(CALLS);
  });

  it("nøyaktig 1 000 000 tegn argumenter passerer (fordelt på fragmenter)", () => {
    const { a } = assembler();
    const value = "x".repeat(CHARS - '{"k":""}'.length);
    a.push([{ index: 0, id: "c", function: { name: "get_weather", arguments: '{"k":"' } }]);
    a.push([{ index: 0, function: { arguments: value } }]);
    a.push([{ index: 0, function: { arguments: '"}' } }]);
    const [call] = a.complete();
    expect(JSON.stringify(call?.arguments).length).toBe(CHARS);
  });

  it("ett tegn over 1 000 000 avvises (tool_arguments_too_large) - i ett fragment og over flere", () => {
    const one = assembler().a;
    bad(() => one.push([{ index: 0, id: "c", function: { name: "get_weather", arguments: "y".repeat(CHARS + 1) } }]), "tool_arguments_too_large");
    const many = assembler().a;
    many.push([{ index: 0, id: "c", function: { name: "get_weather", arguments: "y".repeat(CHARS) } }]);
    bad(() => many.push([{ index: 0, function: { arguments: "y" } }]), "tool_arguments_too_large");
  });

  it("grensen gjelder per kall: to kall som hver er under grensen men til sammen over, passerer ikke-parsbare men ikke avvises for størrelse", () => {
    const { a } = assembler();
    a.push([{ index: 0, id: "a", function: { name: "get_weather", arguments: "z".repeat(CHARS) } }]);
    expect(() => a.push([{ index: 1, id: "b", function: { name: "get_weather", arguments: "z".repeat(CHARS) } }])).not.toThrow();
  });
});
