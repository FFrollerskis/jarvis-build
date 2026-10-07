import { describe, expect, it } from "vitest";
import { blindLabels, parseCandidates, parsePromptsJsonl, percentile, projectMonthlyKr, seededShuffle, summarize, toolChoiceCorrect, type RunRecord } from "../src/bakeoff.ts";

describe("parseCandidates", () => {
  it("leser provider:modell (modellnavn kan inneholde kolon) og avviser tomt/duplikat/ugyldig", () => {
    expect(parseCandidates("anthropic:claude-sonnet-5-5, gemma_local:gemma3:4b")).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5-5", label: "anthropic:claude-sonnet-5-5" },
      { provider: "gemma_local", model: "gemma3:4b", label: "gemma_local:gemma3:4b" }
    ]);
    expect(() => parseCandidates("")).toThrow("no_candidates");
    expect(() => parseCandidates("a:b,a:b")).toThrow("duplicate_candidates");
    expect(() => parseCandidates("Bad Provider:x")).toThrow(/candidate_invalid/);
  });
});

describe("parsePromptsJsonl", () => {
  it("godtar kommentarer og tomme linjer, standard id og expect_tool=none; avviser ugyldig JSON, tom tekst og duplikat-id", () => {
    const ps = parsePromptsJsonl('# kommentar\n\n{"text":"hei"}\n{"id":"x","text":"sjekk github","expect_tool":"github__list_pull_requests","category":"tool"}');
    expect(ps).toEqual([
      { id: "p1", text: "hei", expect_tool: "none" },
      { id: "x", text: "sjekk github", expect_tool: "github__list_pull_requests", category: "tool" }
    ]);
    expect(() => parsePromptsJsonl("ikke json")).toThrow("prompts_line_1_not_json");
    expect(() => parsePromptsJsonl('{"text":""}')).toThrow("prompts_line_1_text_invalid");
    expect(() => parsePromptsJsonl('{"id":"a","text":"x"}\n{"id":"a","text":"y"}')).toThrow("prompts_duplicate_id:a");
    expect(() => parsePromptsJsonl("# bare kommentar")).toThrow("no_prompts");
  });
});

describe("toolChoiceCorrect", () => {
  it("none krever ingen verktøykall; ellers må første kall matche", () => {
    expect(toolChoiceCorrect("none", undefined)).toBe(true);
    expect(toolChoiceCorrect("none", "email__read_inbox")).toBe(false);
    expect(toolChoiceCorrect("email__read_inbox", "email__read_inbox")).toBe(true);
    expect(toolChoiceCorrect("email__read_inbox", undefined)).toBe(false);
    expect(toolChoiceCorrect("email__read_inbox", "calendar__read_events")).toBe(false);
  });
});

describe("blind vurdering", () => {
  it("seededShuffle er deterministisk og er en permutasjon; etiketter er unike A..", () => {
    const a = seededShuffle([1, 2, 3, 4, 5], 42);
    expect(seededShuffle([1, 2, 3, 4, 5], 42)).toEqual(a);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5]);
    const labels = blindLabels(["x", "y", "z"], 3, 7);
    expect([...labels.values()].sort()).toEqual(["A", "B", "C"]);
    expect(blindLabels(["x", "y", "z"], 3, 7)).toEqual(labels);
  });

  it("rekkefølgen varierer mellom prompts (ingen kandidat får alltid A)", () => {
    const firsts = new Set<string>();
    for (let i = 0; i < 30; i++) for (const [c, l] of blindLabels(["x", "y", "z"], i, 1)) if (l === "A") firsts.add(c);
    expect(firsts.size).toBe(3);
  });
});

describe("summarize", () => {
  const prompts = [
    { id: "p1", text: "hei", expect_tool: "none" },
    { id: "p2", text: "github", expect_tool: "github__list_pull_requests" }
  ];
  const rec = (candidate: string, prompt_id: string, over: Partial<RunRecord>): RunRecord => ({
    prompt_id, candidate, ok: true, text: "t", latency_ms: 100, input_tokens: 10, output_tokens: 5, cost_ore: 1, ...over
  });

  it("median/p95/kostnad/verktøytreff, feil telles og påvirker ikke latens", () => {
    const records = [
      rec("A", "p1", { latency_ms: 100, cost_ore: 1 }),
      rec("A", "p2", { latency_ms: 300, cost_ore: 3, tool_call: "github__list_pull_requests" }),
      rec("B", "p1", { latency_ms: 50, cost_ore: 0, tool_call: "email__read_inbox" }),
      rec("B", "p2", { ok: false, error: "timeout", latency_ms: 9999, cost_ore: 0 })
    ];
    const [a, b] = summarize(records, prompts);
    expect(a).toMatchObject({ candidate: "A", runs: 2, failures: 0, median_latency_ms: 100, p95_latency_ms: 300, total_cost_ore: 4, avg_cost_ore: 2, tool_choice_accuracy: 1 });
    expect(b).toMatchObject({ candidate: "B", runs: 2, failures: 1, median_latency_ms: 50, tool_choice_accuracy: 0 });
  });

  it("percentile og månedsprojeksjon", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(projectMonthlyKr(10, 100)).toBe(300); // 10 øre × 100 turer × 30 dager = 30 000 øre = 300 kr
  });
});
