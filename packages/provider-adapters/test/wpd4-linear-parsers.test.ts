import { describe, expect, it } from "vitest";
import { HermesToolParseError, parseHermesOutput, stripThinking, type ToolDefinition } from "../src/index.ts";

/**
 * WP-D4 (JARVIS-036): parserne som leser UBETRODD modelltekst skal være lineære. `stripThinking` (regex-par) og Hermes-parserens gren uten tilbudte verktøy (`/<tool_call>[\s\S]*?<\/tool_call>/g`) var
 * kvadratiske i antall uavsluttede åpningstagger: en lang respons (140 000-220 000 tegn) blokkerte hendelsesløkken i 1-2 sekunder, og tiden firedoblet seg per fordobling. De er nå lineære, og denne testen låser
 * (a) at resultatet er NØYAKTIG det samme som de gamle regex-ene (differensialtest over tilfeldige tagg-sekvenser med fast frø) og (b) at tiden ikke lenger vokser kvadratisk.
 */
const refStripThinking = (text: string): string => text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
const refNoTools = (raw: string): { text: string; ignored: number } => {
  const visible = refStripThinking(raw);
  let ignored = 0;
  const text = visible
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, () => {
      ignored += 1;
      return "";
    })
    .trim();
  return { text, ignored };
};

/** Liten, deterministisk PRNG (mulberry32): samme sekvens hver gang, så en feil kan gjenskapes fra frøet. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  "<think>", "</think>", "<THINK>", "</Think>", "<think >", "< think>", "<think", "think>", "</think",
  "<tool_call>", "</tool_call>", "<TOOL_CALL>", "<tool_call", "tool_call>",
  "a", "bc ", " ", "\n", "<", ">", "</", "x<y", "æøå", "{\"name\":\"a\"}"
];

function randomText(next: () => number): string {
  const length = Math.floor(next() * 14);
  let out = "";
  for (let i = 0; i < length; i += 1) out += TOKENS[Math.floor(next() * TOKENS.length)];
  return out;
}

const TOOL: ToolDefinition = { name: "get_weather", description: "Hent været", input_schema: { type: "object", properties: {}, additionalProperties: false } };

describe("stripThinking: lineær, men identisk med de gamle regex-ene", () => {
  it("eksplisitte kanttilfeller (lukket, nestet åpning, løs lukking, åpen blokk, store/små bokstaver)", () => {
    const cases: Array<[string, string]> = [
      ["", ""],
      ["bare tekst", "bare tekst"],
      ["<think>a</think>svar", "svar"],
      ["før<think>a</think>midt<think>b</think>etter", "førmidtetter"],
      ["<think>a<think>b</think>svar", "svar"],
      ["svar</think>mer", "svar</think>mer"],
      ["<think>a</think></think>svar", "</think>svar"],
      ["svar<think>avkuttet uten slutt", "svar"],
      ["<think>x</think>ok<think>y", "ok"],
      ["<THINK>a</Think>svar", "svar"],
      ["<think >a</think>svar", "<think >a</think>svar"],
      ["<think></think>", ""],
      ["  <think>a</think>  svar  ", "svar"]
    ];
    for (const [input, expected] of cases) {
      expect(stripThinking(input)).toBe(expected);
      expect(refStripThinking(input)).toBe(expected); // referansen er enig, så forventningene over er ikke funnet på
    }
  });

  it("differensialtest: 30 000 tilfeldige tagg-sekvenser gir NØYAKTIG samme resultat som den gamle implementasjonen", () => {
    const next = prng(0x5eed1);
    for (let i = 0; i < 30_000; i += 1) {
      const input = randomText(next);
      const got = stripThinking(input);
      const want = refStripThinking(input);
      if (got !== want) throw new Error(`avvik for ${JSON.stringify(input)}: fikk ${JSON.stringify(got)}, ventet ${JSON.stringify(want)}`);
    }
  });

  it("tiden vokser ikke kvadratisk: 400 000 tegn med uavsluttede <think> går på brøkdeler av et sekund (den gamle brukte flere sekunder)", () => {
    for (const unit of ["<think>", "<think>x", "</think><think>"]) {
      const input = unit.repeat(Math.ceil(400_000 / unit.length));
      const started = Date.now();
      stripThinking(input);
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });
});

describe("parseHermesOutput uten tilbudte verktøy: lineær, men identisk med den gamle regex-en", () => {
  it("eksplisitte kanttilfeller: fullstendige blokker fjernes og telles, uavsluttet står, løs lukking står", () => {
    const cases: Array<[string, string, number]> = [
      ["hei", "hei", 0],
      ["a<tool_call>{}</tool_call>b", "ab", 1],
      ["<tool_call>{}</tool_call><tool_call>{}</tool_call>", "", 2],
      ["a<tool_call>uavsluttet", "a<tool_call>uavsluttet", 0],
      ["a<tool_call>x<tool_call>y</tool_call>b", "ab", 1],
      ["løs</tool_call>slutt", "løs</tool_call>slutt", 0],
      ["<tool_call>a</tool_call>b<tool_call>uavsluttet", "b<tool_call>uavsluttet", 1],
      ["<TOOL_CALL>x</TOOL_CALL>", "<TOOL_CALL>x</TOOL_CALL>", 0],
      ["<think><tool_call>{}</tool_call></think>svar", "svar", 0]
    ];
    for (const [input, text, ignored] of cases) {
      for (const tools of [undefined, []] as const) {
        const parsed = parseHermesOutput(input, tools);
        expect({ text: parsed.text, ignored: parsed.ignored_blocks, calls: parsed.calls.length }).toEqual({ text, ignored, calls: 0 });
      }
      expect(refNoTools(input)).toEqual({ text, ignored });
    }
  });

  it("differensialtest: 30 000 tilfeldige tagg-sekvenser gir samme tekst og samme antall ignorerte blokker som den gamle implementasjonen", () => {
    const next = prng(0x5eed2);
    for (let i = 0; i < 30_000; i += 1) {
      const input = randomText(next);
      const parsed = parseHermesOutput(input, undefined);
      const want = refNoTools(input);
      if (parsed.text !== want.text || parsed.ignored_blocks !== want.ignored) {
        throw new Error(`avvik for ${JSON.stringify(input)}: fikk ${JSON.stringify([parsed.text, parsed.ignored_blocks])}, ventet ${JSON.stringify([want.text, want.ignored])}`);
      }
      expect(parsed.calls).toEqual([]);
    }
  });

  it("tiden vokser ikke kvadratisk: 400 000 tegn med uavsluttede <tool_call> går på brøkdeler av et sekund", () => {
    for (const unit of ["<tool_call>", "<tool_call>x", "</tool_call><tool_call>"]) {
      const input = unit.repeat(Math.ceil(400_000 / unit.length));
      const started = Date.now();
      parseHermesOutput(input, undefined);
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it("med tilbudte verktøy avvises de samme patologiske inputene raskt og fail-closed (aldri en delvis utførelse)", () => {
    for (const input of ["<tool_call>".repeat(40_000), "</tool_call>".repeat(40_000), "<tool_call>{\"name\":\"get_weather\"}</tool_call>".repeat(40_000)]) {
      const started = Date.now();
      let caught: unknown;
      try {
        parseHermesOutput(input, [TOOL]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HermesToolParseError);
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });
});
