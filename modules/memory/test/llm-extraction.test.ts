import { describe, expect, it } from "vitest";
import type { CompleteInput } from "@jarvis/model-gateway";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { LlmExtractionAdapter, type MemoryExtractionCompleter } from "../src/extraction.ts";

/**
 * D-300 (Tobias direkte i chat: "husker han ingenting... vi trodde det
 * fungerte fungerte det ikke" - `RuleBasedExtractor` sin D-287-strenghet var
 * for streng til reell samtale, Tobias valgte "bygg ekte LLM-basert uttrekk").
 * SAMME test-double-mønster som `modules/knowledge/test/ocr-provider.test.ts`
 * sin `FakeVisionCompleter` - ingen ekte `ModelGateway` (Postgres-pool/
 * trace-sink) konstrueres.
 */
class FakeCompleter implements MemoryExtractionCompleter {
  calls: CompleteInput[] = [];
  constructor(private readonly reply: (input: CompleteInput) => { text: string; structured_output?: unknown }) {}
  async complete(input: CompleteInput): Promise<{ text: string; structured_output?: unknown }> {
    this.calls.push(input);
    return this.reply(input);
  }
}

function identity(space: MemorySpace, tenant = "tenant-a", session = "sess-llm-extract"): IdentityContext {
  return {
    person_id: "person-tobias",
    tenant_id: tenant,
    memory_space_id: space,
    session_id: session,
    device_id: "dev-pc",
    channel: "web",
    auth_strength: "active"
  };
}

describe("A: LlmExtractionAdapter.extract - sender korrekt CompleteInput", () => {
  it("purpose:EXTRACT, required_capabilities:[structured_output], tenant_id/session_id fra identity, systemprompt + brukertekst", async () => {
    const fake = new FakeCompleter(() => ({ text: "{}", structured_output: { candidates: [] } }));
    const extractor = new LlmExtractionAdapter(fake);
    await extractor.extract("Jeg heter Tobias.", identity("personal", "tenant-x", "sess-y"), "trusted");
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.purpose).toBe("EXTRACT");
    expect(call.required_capabilities).toEqual(["structured_output"]);
    expect(call.tenant_id).toBe("tenant-x");
    expect(call.session_id).toBe("sess-y");
    expect(call.request.system).toContain("minne-uttrekkssystem");
    expect(call.request.messages).toEqual([{ role: "user", content: "Jeg heter Tobias." }]);
    expect(call.request.structured_schema).toBeDefined();
  });
});

describe("B: LlmExtractionAdapter.extract - gyldig strukturert svar mappes til MemoryCandidate[]", () => {
  it("mapper type/subject/content/confidence, space settes fra identity.memory_space_id", async () => {
    const fake = new FakeCompleter(() => ({
      text: "",
      structured_output: {
        candidates: [
          { type: "relation", subject: "tobias.bosted", content: "Tobias bor i Trondheim.", confidence: 0.9 }
        ]
      }
    }));
    const extractor = new LlmExtractionAdapter(fake);
    const candidates = await extractor.extract("Jeg bor i Trondheim.", identity("business"), "trusted");
    expect(candidates).toEqual([
      { space: "business", type: "relation", subject: "tobias.bosted", content: "Tobias bor i Trondheim.", confidence: 0.9 }
    ]);
  });

  it("tom candidates-array gir tom liste (gyldig 'ingenting å huske'-utfall, ikke en feil)", async () => {
    const fake = new FakeCompleter(() => ({ text: "", structured_output: { candidates: [] } }));
    const extractor = new LlmExtractionAdapter(fake);
    const candidates = await extractor.extract("Hei Charlie!", identity("personal"), "trusted");
    expect(candidates).toEqual([]);
  });
});

describe("C: LlmExtractionAdapter.extract - fail-closed på ugyldig/manglende strukturert svar, ALDRI en kastet feil", () => {
  it("manglende structured_output gir tom liste", async () => {
    const fake = new FakeCompleter(() => ({ text: "beklager, jeg forstod ikke" }));
    const extractor = new LlmExtractionAdapter(fake);
    const candidates = await extractor.extract("noe tekst", identity("personal"), "trusted");
    expect(candidates).toEqual([]);
  });

  it("ugyldig type-enum-verdi i én kandidat forkaster HELE svaret (fail-closed), ikke bare den ene kandidaten", async () => {
    const fake = new FakeCompleter(() => ({
      text: "",
      structured_output: { candidates: [{ type: "not_a_real_type", subject: "x", content: "y", confidence: 0.5 }] }
    }));
    const extractor = new LlmExtractionAdapter(fake);
    const candidates = await extractor.extract("noe tekst", identity("personal"), "trusted");
    expect(candidates).toEqual([]);
  });

  it("confidence utenfor [0,1] forkaster hele svaret", async () => {
    const fake = new FakeCompleter(() => ({
      text: "",
      structured_output: { candidates: [{ type: "relation", subject: "x", content: "y", confidence: 1.5 }] }
    }));
    const extractor = new LlmExtractionAdapter(fake);
    const candidates = await extractor.extract("noe tekst", identity("personal"), "trusted");
    expect(candidates).toEqual([]);
  });

  it("flere enn 20 kandidater forkaster hele svaret (forsvar-i-dybden mot ubegrenset vekst)", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ type: "episodic" as const, subject: `s${i}`, content: `c${i}`, confidence: 0.5 }));
    const fake = new FakeCompleter(() => ({ text: "", structured_output: { candidates: many } }));
    const extractor = new LlmExtractionAdapter(fake);
    const candidates = await extractor.extract("noe tekst", identity("personal"), "trusted");
    expect(candidates).toEqual([]);
  });
});

describe("D: subject-normalisering", () => {
  it("modellens subject normaliseres til små bokstaver/punktum-separert", async () => {
    const fake = new FakeCompleter(() => ({
      text: "",
      structured_output: { candidates: [{ type: "relation", subject: "Tobias Bosted", content: "x", confidence: 0.7 }] }
    }));
    const extractor = new LlmExtractionAdapter(fake);
    const candidates = await extractor.extract("noe tekst", identity("personal"), "trusted");
    expect(candidates[0]?.subject).toBe("tobias.bosted");
  });

  it("tomt/ugyldig subject faller tilbake til mekanisk avledning fra content (samme mønster som RuleBasedExtractor)", async () => {
    const fake = new FakeCompleter(() => ({
      text: "",
      structured_output: { candidates: [{ type: "relation", subject: "###", content: "Pappa heter Henrik og bor i Oslo", confidence: 0.7 }] }
    }));
    const extractor = new LlmExtractionAdapter(fake);
    const candidates = await extractor.extract("noe tekst", identity("personal"), "trusted");
    expect(candidates[0]?.subject).toBe("pappa.heter.henrik.og.bor");
  });
});

describe("E: trust-parameteren påvirker ALDRI uttrekksoppførsel", () => {
  it("samme modellsvar gir IDENTISK resultat for trust:'trusted' og trust:'untrusted'", async () => {
    const structured = { candidates: [{ type: "semantic" as const, subject: "x", content: "y", confidence: 0.8 }] };
    const fakeTrusted = new FakeCompleter(() => ({ text: "", structured_output: structured }));
    const fakeUntrusted = new FakeCompleter(() => ({ text: "", structured_output: structured }));
    const trustedResult = await new LlmExtractionAdapter(fakeTrusted).extract("noe tekst", identity("personal"), "trusted");
    const untrustedResult = await new LlmExtractionAdapter(fakeUntrusted).extract("noe tekst", identity("personal"), "untrusted");
    expect(trustedResult).toEqual(untrustedResult);
  });
});
