import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { ModelProviderAdapter, ModelRequest, ModelResult } from "@jarvis/provider-adapters";
import { AiCouncil, CouncilSynthesisError, IncompleteCouncilError, MemoryTraceSink, ModelGateway } from "../src/index.ts";

/**
 * D-106 (§"AI Council"): beviser rundeprotokollen (uavhengig runde 1,
 * kryss-kritikk runde 2, revisjon runde 3, deterministisk syntese) og
 * degradert-håndtering. Samme `fakePool()`-mønster som `ua1-mesh.test.ts`
 * (ingen ekte Postgres nødvendig - kun budsjett-SELECT/cost_events-INSERT
 * fanges).
 */
function fakePool(): pg.Pool {
  const client = {
    query: async (sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM cost_events")) return { rows: [{ spent: 0 }] };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

/** Ren scriptet adapter: en responder-funksjon per provider, ingen ekte nettverk. */
class ScriptedJsonAdapter implements ModelProviderAdapter {
  readonly model = "test-model";
  constructor(
    readonly name: string,
    private readonly responder: (request: ModelRequest) => string
  ) {}
  available(): boolean {
    return true;
  }
  async complete(request: ModelRequest): Promise<ModelResult> {
    return {
      text: this.responder(request),
      usage: { input_tokens: 10, output_tokens: 10 },
      provider: this.name,
      model: this.model
    };
  }
}

class FailingAdapter implements ModelProviderAdapter {
  readonly model = "test-model";
  constructor(readonly name: string) {}
  available(): boolean {
    return true;
  }
  async complete(): Promise<ModelResult> {
    throw new Error("simulert providerfeil");
  }
}

function round1Answer(conclusion: string, confidence = 70): string {
  return JSON.stringify({
    conclusion,
    reasoning_summary: `begrunnelse for: ${conclusion}`,
    assumptions: ["antakelse-1"],
    evidence_provenance: ["kilde-1"],
    risks: ["risiko-1"],
    confidence,
    unresolved_questions: []
  });
}

function synthesisFor(supporting: string[], dissenting: string[]): string {
  return JSON.stringify({
    decision: "Anbefalt beslutning basert på rådet",
    supporting_models: supporting,
    dissenting_models: dissenting,
    key_evidence: ["evidens-1"],
    key_disagreements: dissenting.length > 0 ? ["uenighet-1"] : [],
    risk_summary: "moderat risiko",
    confidence: 80,
    recommended_action: "gå videre"
  });
}

/**
 * Generisk medlemsadapter: håndterer BÅDE runde-1/2/3-anrop (returnerer
 * `conclusion`) OG synteseanropet (leser "MEDLEMMER SOM SVARTE (a, b, ...)"
 * fra prompten og plasserer ALLE i supporting_models - trengs fordi
 * synteseanropet kan lande på HVILKEN SOM HELST konfigurert provider via
 * QUALITY-ruting, og en generisk testadapter kan ikke vite på forhånd om den
 * blir bedt om å representere ETT medlem eller UTFØRE synteserollen.
 */
function buildMember(name: string, conclusion: string): ScriptedJsonAdapter {
  return new ScriptedJsonAdapter(name, (req) => {
    const userText = req.messages[0]?.content;
    const text = typeof userText === "string" ? userText : "";
    const synthesisMatch = text.match(/MEDLEMMER SOM SVARTE \(([^)]*)\)/);
    if (synthesisMatch) {
      const responded = (synthesisMatch[1] as string).split(",").map((s) => s.trim());
      return synthesisFor(responded, []);
    }
    return round1Answer(conclusion);
  });
}

describe("D-106 AI Council: runde 1 (anti-anchoring, uavhengighet)", () => {
  it("A: alle konfigurerte medlemmer svarer i runde 1 med SIN EGEN konklusjon (ingen ser hverandre)", async () => {
    const seenPrompts: string[] = [];
    const members = ["anthropic", "openai", "gemini"].map(
      (name) =>
        new ScriptedJsonAdapter(name, (req) => {
          const c = req.messages[0]?.content;
          const text = typeof c === "string" ? c : "";
          seenPrompts.push(text);
          const synthesisMatch = text.match(/MEDLEMMER SOM SVARTE \(([^)]*)\)/);
          if (synthesisMatch) {
            return synthesisFor((synthesisMatch[1] as string).split(",").map((s) => s.trim()), []);
          }
          return round1Answer(`konklusjon-fra-${name}`);
        })
    );
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: members });
    const council = new AiCouncil(gateway);
    const result = await council.run({ tenant_id: "t1", decision_context: "Skal vi gjøre X?", members: ["anthropic", "openai", "gemini"] });

    expect(result.provenance.round1).toHaveLength(3);
    expect(result.provenance.round1.map((r) => r.provider).sort()).toEqual(["anthropic", "gemini", "openai"]);
    // Ingen av runde-1-promptene (identifisert ved fravær av senere-runde-markørene) nevner et
    // annet medlems konklusjon-som-kilde (anti-anchoring bevist strukturelt, uavhengig av async-rekkefølge).
    const round1Prompts = seenPrompts.filter(
      (p) => !p.includes("ANDRE MEDLEMMERS") && !p.includes("KRITIKK MOTTATT") && !p.includes("MEDLEMMER SOM SVARTE")
    );
    expect(round1Prompts).toHaveLength(3);
    for (const prompt of round1Prompts) {
      expect(prompt).not.toContain("konklusjon-fra-");
    }
  });

  it("B: full_council=true når alle forespurte medlemmer svarer", async () => {
    const members = ["anthropic", "openai"].map((name) => buildMember(name, `svar-${name}`));
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: members });
    const council = new AiCouncil(gateway);
    const result = await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] });
    expect(result.provenance.full_council).toBe(true);
    expect(result.provenance.unavailable_members).toEqual([]);
  });
});

describe("D-106 AI Council: degradert Council (medlem utilgjengelig)", () => {
  it("C: ett feilende medlem ekskluderes, resten fortsetter - full_council=false, IKKE en falsk full Council", async () => {
    const providers = [buildMember("anthropic", "ja"), new FailingAdapter("openai"), buildMember("gemini", "ja")];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const council = new AiCouncil(gateway);
    const result = await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai", "gemini"] });
    expect(result.provenance.full_council).toBe(false);
    expect(result.provenance.unavailable_members.map((u) => u.provider)).toEqual(["openai"]);
    expect(result.provenance.round1.map((r) => r.provider).sort()).toEqual(["anthropic", "gemini"]);
  });

  it("D: requireAllFive=true + ett medlem feiler -> IncompleteCouncilError (fail-closed, aldri en falsk full Council)", async () => {
    const providers = [buildMember("anthropic", "ja"), new FailingAdapter("openai")];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const council = new AiCouncil(gateway);
    await expect(
      council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"], requireAllFive: true })
    ).rejects.toThrow(IncompleteCouncilError);
  });

  it("E: requireAllFive=false (default) + ett medlem feiler -> kjøringen fullfører likevel med resten", async () => {
    const providers = [buildMember("anthropic", "ja"), new FailingAdapter("openai")];
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const council = new AiCouncil(gateway);
    const result = await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] });
    expect(result.decision).toBeTruthy();
  });
});

describe("D-106 AI Council: syntese - Jarvis eier consensus_status (aldri en selvrapportert modell-enum)", () => {
  function buildCouncilWithSynthesis(
    synthesisJson: string,
    memberNames: string[] = ["anthropic", "openai"]
  ): { gateway: ModelGateway; council: AiCouncil } {
    const providers: ModelProviderAdapter[] = memberNames.map(
      (name) =>
        new ScriptedJsonAdapter(name, (req) => {
          const c = req.messages[0]?.content;
          const text = typeof c === "string" ? c : "";
          if (text.includes("MEDLEMMER SOM SVARTE")) return synthesisJson;
          return round1Answer(`svar-${name}`);
        })
    );
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    return { gateway, council: new AiCouncil(gateway) };
  }

  it("F: alle medlemmer i supporting -> consensus_status=CONSENSUS", async () => {
    const { council } = buildCouncilWithSynthesis(synthesisFor(["anthropic", "openai"], []));
    const result = await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] });
    expect(result.consensus_status).toBe("CONSENSUS");
  });

  it("G: flertall støtter, ett dissenterer -> consensus_status=MAJORITY", async () => {
    const { council } = buildCouncilWithSynthesis(synthesisFor(["anthropic", "openai", "gemini"], ["kimi"]), [
      "anthropic",
      "openai",
      "gemini",
      "kimi"
    ]);
    const result = await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai", "gemini", "kimi"] });
    expect(result.consensus_status).toBe("MAJORITY");
  });

  it("H: jevnt delt -> consensus_status=SPLIT", async () => {
    const { council } = buildCouncilWithSynthesis(synthesisFor(["anthropic"], ["openai"]));
    const result = await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] });
    expect(result.consensus_status).toBe("SPLIT");
  });

  it("I: syntese utelater et svarende medlem fra BÅDE supporting/dissenting -> CouncilSynthesisError (feiler høylytt, aldri stille korrupt data)", async () => {
    const { council } = buildCouncilWithSynthesis(synthesisFor(["anthropic"], []));
    await expect(
      council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] })
    ).rejects.toThrow(CouncilSynthesisError);
  });

  it("J: syntese plasserer et medlem i BEGGE lister -> CouncilSynthesisError", async () => {
    const { council } = buildCouncilWithSynthesis(synthesisFor(["anthropic", "openai"], ["openai"]));
    await expect(
      council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] })
    ).rejects.toThrow(CouncilSynthesisError);
  });

  it("K: disagreement (key_disagreements) er synlig i sluttresultatet når det finnes", async () => {
    const { council } = buildCouncilWithSynthesis(synthesisFor(["anthropic"], ["openai"]));
    const result = await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] });
    expect(result.key_disagreements.length).toBeGreaterThan(0);
    expect(result.dissenting_models).toEqual(["openai"]);
  });
});

describe("D-106 AI Council: kryss-kritikk og revisjon (runde 2/3)", () => {
  it("L: hvert medlem mottar de ANDRES runde-1-svar i runde 2 (ikke sitt eget)", async () => {
    const round2Prompts: Record<string, string> = {};
    const providers = ["anthropic", "openai"].map(
      (name) =>
        new ScriptedJsonAdapter(name, (req) => {
          const c = req.messages[0]?.content;
          const text = typeof c === "string" ? c : "";
          if (text.includes("ANDRE MEDLEMMERS VURDERING")) {
            round2Prompts[name] = text;
            return JSON.stringify({ critiques: [] });
          }
          if (text.includes("KRITIKK MOTTATT")) return round1Answer(`revidert-${name}`);
          if (text.includes("MEDLEMMER SOM SVARTE")) return synthesisFor(["anthropic", "openai"], []);
          return round1Answer(`svar-${name}`);
        })
    );
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const council = new AiCouncil(gateway);
    await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] });
    expect(round2Prompts["anthropic"]).toContain("svar-openai");
    expect(round2Prompts["anthropic"]).not.toContain("[anthropic]");
    expect(round2Prompts["openai"]).toContain("svar-anthropic");
  });
});

/**
 * D-106 HOST-FIX 2 (§"Council Gemma family mismatch", 2026-08-22): beviser at
 * Gemma-familien løses DYNAMISK (gemma_local foretrukket, gemma_hosted kun
 * fallback) NÅR `members` IKKE er eksplisitt oppgitt - den DEFAULT-veien
 * `ConversationEngine` faktisk bruker for BÅDE eksplisitt OG automatisk
 * høy-innvirkning-Council-trigger (§"høy-innvirkning-auto-trigger må
 * fortsette å nå SAMME Council-implementasjon" - conversation.ts sender
 * ALDRI `members` til `council.run()`, uendret av denne reparasjonen -
 * strukturelt bevist ved at conversation.ts ikke er rørt i det hele tatt).
 * ALLE eksisterende tester over (A-L) bruker eksplisitt `members:` og beviser
 * dermed at rundeprotokollen (uavhengig runde 1/kryss-kritikk/revisjon/
 * syntese) forblir UENDRET av denne reparasjonen.
 */
describe("D-106 HOST-FIX 2: dynamisk Gemma-familie-oppløsning (default fem-familie-vei)", () => {
  function fiveFamilyGateway(opts: {
    includeGemmaLocal?: boolean;
    includeGemmaHosted?: boolean;
    markGemmaLocalUnavailable?: boolean;
  }): { gateway: ModelGateway; council: AiCouncil } {
    const providers: ModelProviderAdapter[] = ["anthropic", "openai", "gemini", "kimi"].map((n) => buildMember(n, `svar-${n}`));
    if (opts.includeGemmaLocal !== false) providers.push(buildMember("gemma_local", "svar-gemma_local"));
    if (opts.includeGemmaHosted) providers.push(buildMember("gemma_hosted", "svar-gemma_hosted"));
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    if (opts.markGemmaLocalUnavailable) {
      // UNAVAILABLE_THRESHOLD=3 i provider-health.ts - tre påfølgende feil gir UNAVAILABLE.
      gateway.health.recordFailure("gemma_local", "server", "simulert nedetid");
      gateway.health.recordFailure("gemma_local", "server", "simulert nedetid");
      gateway.health.recordFailure("gemma_local", "server", "simulert nedetid");
    }
    return { gateway, council: new AiCouncil(gateway) };
  }

  it("M: gemma_local konfigurert+frisk -> Council bruker gemma_local (foretrukket, aldri gemma_hosted samtidig)", async () => {
    const { council } = fiveFamilyGateway({ includeGemmaLocal: true, includeGemmaHosted: true });
    const result = await council.run({ tenant_id: "t1", decision_context: "Skal vi X?" });
    expect(result.provenance.gemma_family_provider).toBe("gemma_local");
    expect(result.provenance.round1.map((r) => r.provider).sort()).toEqual(["anthropic", "gemini", "gemma_local", "kimi", "openai"]);
    expect(result.provenance.round1.some((r) => r.provider === "gemma_hosted")).toBe(false);
  });

  it("N: gemma_local UNAVAILABLE (helse) -> gemma_hosted brukes som fallback når konfigurert/tillatt/sensitivitet-kvalifisert", async () => {
    const { council } = fiveFamilyGateway({ includeGemmaLocal: true, includeGemmaHosted: true, markGemmaLocalUnavailable: true });
    // gemma_hosted er hosted_free_tier (D-81 P0-sikkerhetsfiks, router.ts) - krever EKSPLISITT
    // sensitivity="PUBLIC_OR_LOW_SENSITIVITY" for å kvalifisere, samme regel gjenbrukt uendret her.
    const result = await council.run({ tenant_id: "t1", decision_context: "Skal vi X?", sensitivity: "PUBLIC_OR_LOW_SENSITIVITY" });
    expect(result.provenance.gemma_family_provider).toBe("gemma_hosted");
    expect(result.provenance.round1.some((r) => r.provider === "gemma_local")).toBe(false);
    expect(result.provenance.round1.some((r) => r.provider === "gemma_hosted")).toBe(true);
  });

  it("N2: gemma_local UNAVAILABLE + udefinert sensitivity -> gemma_hosted IKKE brukt (D-81 fail-safe: udefinert sensitivitet kvalifiserer ALDRI en hosted_free_tier-provider) - familien unavailable", async () => {
    const { council } = fiveFamilyGateway({ includeGemmaLocal: true, includeGemmaHosted: true, markGemmaLocalUnavailable: true });
    const result = await council.run({ tenant_id: "t1", decision_context: "Skal vi X?" });
    expect(result.provenance.gemma_family_provider).toBeUndefined();
    expect(result.provenance.full_council).toBe(false);
    expect(result.provenance.unavailable_members).toEqual([
      { provider: "gemma", reason: "gemma_local_unavailable_and_gemma_hosted_not_sensitivity_eligible" }
    ]);
  });

  it("O: gemma_local UNAVAILABLE + paid_models_allowed=false (selv med sensitivitet kvalifisert) -> gemma_hosted (betalt) IKKE brukt for Gemma-familien", async () => {
    // Merk: anthropic/openai/gemini/kimi er ALLE `locality:"cloud"` i den ekte
    // CapabilityRegistry-en (samme registry testadapterne rutes gjennom via
    // provider-navn) - `paid_models_allowed=false` avviser derfor OGSÅ dem her
    // (korrekt, uendret router-oppførsel, IKKE noe denne reparasjonen endrer).
    // Testen isolerer derfor KUN Gemma-familie-signalet via den kastede
    // `IncompleteCouncilError` sin `.unavailable`-liste, ikke et fullført resultat.
    const { council } = fiveFamilyGateway({ includeGemmaLocal: true, includeGemmaHosted: true, markGemmaLocalUnavailable: true });
    try {
      await council.run({
        tenant_id: "t1",
        decision_context: "Skal vi X?",
        paid_models_allowed: false,
        sensitivity: "PUBLIC_OR_LOW_SENSITIVITY"
      });
      expect.unreachable("forventet IncompleteCouncilError");
    } catch (err) {
      expect(err).toBeInstanceOf(IncompleteCouncilError);
      const unavailable = (err as InstanceType<typeof IncompleteCouncilError>).unavailable;
      expect(unavailable).toContainEqual({ provider: "gemma", reason: "gemma_local_unavailable_and_paid_models_disabled" });
      expect(unavailable.some((u) => u.provider.startsWith("gemma_"))).toBe(false);
    }
  });

  it("P: verken gemma_local eller gemma_hosted konfigurert -> Gemma-familien unavailable, FULL_COUNCIL=false, de fire andre familiene uendret", async () => {
    const { council } = fiveFamilyGateway({ includeGemmaLocal: false, includeGemmaHosted: false });
    const result = await council.run({ tenant_id: "t1", decision_context: "Skal vi X?" });
    expect(result.provenance.gemma_family_provider).toBeUndefined();
    expect(result.provenance.full_council).toBe(false);
    expect(result.provenance.unavailable_members).toEqual([
      { provider: "gemma", reason: "neither_gemma_local_nor_gemma_hosted_available" }
    ]);
    expect(result.provenance.round1.map((r) => r.provider).sort()).toEqual(["anthropic", "gemini", "kimi", "openai"]);
  });

  it("Q: requireAllFive=true + Gemma-familien unresolved -> IncompleteCouncilError (fail-closed, ALDRI en falsk full Council)", async () => {
    const { council } = fiveFamilyGateway({ includeGemmaLocal: false, includeGemmaHosted: false });
    await expect(council.run({ tenant_id: "t1", decision_context: "Skal vi X?", requireAllFive: true })).rejects.toThrow(
      IncompleteCouncilError
    );
  });

  it("R: Gemma-familien telles NØYAKTIG én gang selv når BÅDE gemma_local OG gemma_hosted er konfigurert+friske samtidig", async () => {
    const { council } = fiveFamilyGateway({ includeGemmaLocal: true, includeGemmaHosted: true });
    const result = await council.run({ tenant_id: "t1", decision_context: "Skal vi X?" });
    const gemmaMembers = result.provenance.round1.filter((r) => r.provider.startsWith("gemma"));
    expect(gemmaMembers).toHaveLength(1);
    expect(result.provenance.requested_members).toHaveLength(5);
  });

  it("S: rundeprotokollen (uavhengig runde 1, kryss-kritikk, revisjon, syntese) forblir UENDRET i default-veien - alle fem svarer, konsensus beregnes", async () => {
    const { council } = fiveFamilyGateway({ includeGemmaLocal: true, includeGemmaHosted: false });
    const result = await council.run({ tenant_id: "t1", decision_context: "Skal vi X?" });
    expect(result.provenance.full_council).toBe(true);
    expect(result.provenance.round1).toHaveLength(5);
    expect(result.provenance.round2).toHaveLength(5);
    expect(result.provenance.round3).toHaveLength(5);
    expect(result.consensus_status).toBe("CONSENSUS");
  });

  it("T: eksplisitt oppgitte `members` overstyrer FORTSATT dynamisk Gemma-oppløsning helt (bakoverkompatibel, ingen familie-spesialhåndtering)", async () => {
    const providers = ["anthropic", "gemma_hosted"].map((n) => buildMember(n, `svar-${n}`));
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const council = new AiCouncil(gateway);
    const result = await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "gemma_hosted"] });
    expect(result.provenance.gemma_family_provider).toBeUndefined();
    expect(result.provenance.requested_members).toEqual(["anthropic", "gemma_hosted"]);
  });
});

/**
 * D-106 HOST-FIX 3 (re-audit, 2026-08-23): `extractJson()` sin egen unit-test-
 * dekning (`d106-council-json-extraction.test.ts`) beviser uthentingskontrakten
 * isolert. Denne describe-blokken beviser i tillegg at DEN FAKTISKE Council-
 * rundeprotokollen (runde 1, syntese) fungerer ENDE-TIL-ENDE når et medlems
 * FULLE `ModelGateway.complete()`-svar er pakket i realistisk "messy"
 * modell-formatering (markdown-fences, avgrenset fritekst) - nøyaktig den
 * klassen live-observerte formater (`invalid_json_shape`/
 * `council_synthesis_invalid`) som utløste Defekt D. Provider-nøytralt bevist
 * (samme `ScriptedJsonAdapter`-mønster som resten av filen).
 */
describe("D-106 HOST-FIX 3: full Council-rundeprotokoll håndterer realistisk messy modell-formatering ende-til-ende", () => {
  it("U: runde-1-svar pakket i \\`\\`\\`json-fence parses korrekt gjennom HELE pipelinen (medlemmet er IKKE unavailable)", async () => {
    const providers = ["anthropic", "openai"].map(
      (name) =>
        new ScriptedJsonAdapter(name, (req) => {
          const c = req.messages[0]?.content;
          const text = typeof c === "string" ? c : "";
          if (text.includes("MEDLEMMER SOM SVARTE")) return synthesisFor(["anthropic", "openai"], []);
          return `Her er min vurdering:\n\n\`\`\`json\n${round1Answer(`konklusjon-${name}`)}\n\`\`\`\n\nLa meg vite om du har spørsmål.`;
        })
    );
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const council = new AiCouncil(gateway);
    const result = await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] });
    expect(result.provenance.full_council).toBe(true);
    expect(result.provenance.unavailable_members).toEqual([]);
    expect(result.provenance.round1.map((r) => r.conclusion).sort()).toEqual(["konklusjon-anthropic", "konklusjon-openai"]);
  });

  it("V: syntese-svar pakket i generisk \\`\\`\\`-fence (uten 'json'-tag) parses korrekt", async () => {
    const providers = ["anthropic", "openai"].map(
      (name) =>
        new ScriptedJsonAdapter(name, (req) => {
          const c = req.messages[0]?.content;
          const text = typeof c === "string" ? c : "";
          if (text.includes("MEDLEMMER SOM SVARTE")) {
            return `\`\`\`\n${synthesisFor(["anthropic", "openai"], [])}\n\`\`\``;
          }
          return round1Answer(`svar-${name}`);
        })
    );
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const council = new AiCouncil(gateway);
    const result = await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] });
    expect(result.decision).toBe("Anbefalt beslutning basert på rådet");
    expect(result.consensus_status).toBe("CONSENSUS");
  });

  it("W: runde-1-svar med avgrenset fritekst rundt JSON-objektet ('Her er svaret mitt: {...} Håper det hjelper!') parses korrekt", async () => {
    const providers = ["anthropic", "openai"].map(
      (name) =>
        new ScriptedJsonAdapter(name, (req) => {
          const c = req.messages[0]?.content;
          const text = typeof c === "string" ? c : "";
          if (text.includes("MEDLEMMER SOM SVARTE")) return synthesisFor(["anthropic", "openai"], []);
          return `Basert på min analyse er konklusjonen: ${round1Answer(`konklusjon-${name}`)} - dette er mitt endelige svar.`;
        })
    );
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers });
    const council = new AiCouncil(gateway);
    const result = await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] });
    expect(result.provenance.full_council).toBe(true);
    expect(result.provenance.round1.map((r) => r.conclusion).sort()).toEqual(["konklusjon-anthropic", "konklusjon-openai"]);
  });

  it("X: samme messy-fence-formaterte respons gir IDENTISK, repeterbart resultat over flere uavhengige kjøringer (determinisme, ikke flaky reproduksjon av Defekt D)", async () => {
    const makeProviders = (): ModelProviderAdapter[] =>
      ["anthropic", "openai"].map(
        (name) =>
          new ScriptedJsonAdapter(name, (req) => {
            const c = req.messages[0]?.content;
            const text = typeof c === "string" ? c : "";
            if (text.includes("MEDLEMMER SOM SVARTE")) return `\`\`\`json\n${synthesisFor(["anthropic", "openai"], [])}\n\`\`\``;
            return `\`\`\`json\n${round1Answer(`konklusjon-${name}`)}\n\`\`\``;
          })
      );
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: makeProviders() });
        const council = new AiCouncil(gateway);
        return council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] });
      })
    );
    for (const r of results) {
      expect(r.provenance.full_council).toBe(true);
      expect(r.consensus_status).toBe("CONSENSUS");
      expect(r.provenance.round1.map((x) => x.conclusion).sort()).toEqual(["konklusjon-anthropic", "konklusjon-openai"]);
    }
  });
});

describe("D-106 PR #53 HOST FIX: runde-`max_tokens` har reell margin for reasoning-modeller (live-bevis 2026-08-23)", () => {
  /** Fanger `request.max_tokens` for hvert kall, i tillegg til å svare normalt via ScriptedJsonAdapter sin logikk. */
  class MaxTokensCapturingAdapter implements ModelProviderAdapter {
    readonly model = "test-model";
    readonly seenMaxTokens: Array<number | undefined> = [];
    constructor(
      readonly name: string,
      private readonly responder: (request: ModelRequest) => string
    ) {}
    available(): boolean {
      return true;
    }
    async complete(request: ModelRequest): Promise<ModelResult> {
      this.seenMaxTokens.push(request.max_tokens);
      return { text: this.responder(request), usage: { input_tokens: 10, output_tokens: 10 }, provider: this.name, model: this.model };
    }
  }

  it("Y: runde 1/2/3 og syntese ber ALLE om et `max_tokens`-budsjett godt over 1024 (live-bevis: gpt-5 brukte HELE 1024 på reasoning-tokens uten synlig tekst i det hele tatt, Anthropic ble kuttet midt i et ellers gyldig JSON-objekt)", async () => {
    const anthropic = new MaxTokensCapturingAdapter("anthropic", (req) => {
      const c = req.messages[0]?.content;
      const text = typeof c === "string" ? c : "";
      if (text.includes("MEDLEMMER SOM SVARTE")) return synthesisFor(["anthropic", "openai"], []);
      if (text.includes("ANDRE MEDLEMMERS VURDERING")) return JSON.stringify({ critiques: [] });
      return round1Answer("konklusjon-anthropic");
    });
    const openai = new MaxTokensCapturingAdapter("openai", (req) => {
      const c = req.messages[0]?.content;
      const text = typeof c === "string" ? c : "";
      if (text.includes("MEDLEMMER SOM SVARTE")) return synthesisFor(["anthropic", "openai"], []);
      if (text.includes("ANDRE MEDLEMMERS VURDERING")) return JSON.stringify({ critiques: [] });
      return round1Answer("konklusjon-openai");
    });
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [anthropic, openai] });
    const council = new AiCouncil(gateway);
    await council.run({ tenant_id: "t1", decision_context: "X?", members: ["anthropic", "openai"] });

    // Minst runde 1 (og for anthropic/openai her: runde 2, runde 3, og trolig synteseanropet) må ha blitt fanget.
    expect(anthropic.seenMaxTokens.length).toBeGreaterThanOrEqual(3);
    expect(openai.seenMaxTokens.length).toBeGreaterThanOrEqual(3);
    for (const seen of [...anthropic.seenMaxTokens, ...openai.seenMaxTokens]) {
      expect(seen).toBeDefined();
      expect(seen as number).toBeGreaterThan(2048);
    }
  });
});

describe("D-106 Council reliability (§ARCHITECTURE DECISION, 2026-08-24): Council bruker en generisk, arbeidsmengde-spesifikk timeout - ALDRI provider-spesifikk", () => {
  /** Fanger `request.timeoutMs` for hvert kall, i tillegg til å svare normalt via ScriptedJsonAdapter sin logikk (samme mønster som MaxTokensCapturingAdapter over). */
  class TimeoutCapturingAdapter implements ModelProviderAdapter {
    readonly model = "test-model";
    readonly seenTimeouts: Array<number | undefined> = [];
    constructor(
      readonly name: string,
      private readonly responder: (request: ModelRequest) => string
    ) {}
    available(): boolean {
      return true;
    }
    async complete(request: ModelRequest): Promise<ModelResult> {
      this.seenTimeouts.push(request.timeoutMs);
      return { text: this.responder(request), usage: { input_tokens: 10, output_tokens: 10 }, provider: this.name, model: this.model };
    }
  }

  /** Ett medlem som håndterer runde 1/2/3 OG (om QUALITY-ruting velger det) synteserollen - samme mønster som `buildMember()` over, men timeout-fangende. */
  function buildTimeoutCapturingMember(name: string, conclusion: string, allMemberNames: string[]): TimeoutCapturingAdapter {
    return new TimeoutCapturingAdapter(name, (req) => {
      const c = req.messages[0]?.content;
      const text = typeof c === "string" ? c : "";
      if (text.includes("MEDLEMMER SOM SVARTE")) return synthesisFor(allMemberNames, []);
      if (text.includes("ANDRE MEDLEMMERS VURDERING")) return JSON.stringify({ critiques: [] });
      return round1Answer(conclusion);
    });
  }

  it("Z: runde 1, kryss-kritikk (runde 2), revisjon (runde 3) og syntese ber ALLE om NØYAKTIG COUNCIL_MODEL_TIMEOUT_MS (default 120000) - IKKE den ordinære 60000ms-defaulten", async () => {
    const memberNames = ["anthropic", "openai"];
    const anthropic = buildTimeoutCapturingMember("anthropic", "konklusjon-anthropic", memberNames);
    const openai = buildTimeoutCapturingMember("openai", "konklusjon-openai", memberNames);
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [anthropic, openai] });
    const council = new AiCouncil(gateway);
    await council.run({ tenant_id: "t1", decision_context: "X?", members: memberNames });

    // Minst runde 1/2/3 (+ evt. syntese, avhengig av QUALITY-rutingens providervalg) må ha blitt fanget for begge.
    expect(anthropic.seenTimeouts.length).toBeGreaterThanOrEqual(3);
    expect(openai.seenTimeouts.length).toBeGreaterThanOrEqual(3);
    for (const seen of [...anthropic.seenTimeouts, ...openai.seenTimeouts]) {
      expect(seen).toBe(120_000);
    }
  });

  it("Æ: provider-identitet avgjør ALDRI timeouten - et medlem navngitt eksakt 'kimi' ser NØYAKTIG samme verdi som anthropic/openai/gemini/gemma_local i SAMME Council-kjøring (ingen `if provider === \"kimi\"`-spesialbehandling)", async () => {
    const memberNames = ["anthropic", "openai", "gemini", "kimi", "gemma_local"];
    const members = memberNames.map((name) => buildTimeoutCapturingMember(name, `konklusjon-${name}`, memberNames));
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: members });
    const council = new AiCouncil(gateway);
    const result = await council.run({ tenant_id: "t1", decision_context: "X?", members: memberNames, requireAllFive: true });

    expect(result.provenance.full_council).toBe(true);
    const kimi = members.find((m) => m.name === "kimi") as TimeoutCapturingAdapter;
    expect(kimi.seenTimeouts.length).toBeGreaterThan(0);
    const allSeenAcrossAllMembers = members.flatMap((m) => m.seenTimeouts);
    // Presist ÉN distinkt verdi observert på tvers av ALLE fem medlemmer, uansett navn - beviser fravær av provider-spesifikk gren.
    expect(new Set(allSeenAcrossAllMembers).size).toBe(1);
    expect(allSeenAcrossAllMembers[0]).toBe(120_000);
  });

  it("Ø: JARVIS_COUNCIL_MODEL_TIMEOUT_MS-miljøoverstyring endrer IKKE den ordinære JARVIS_MODEL_TIMEOUT_MS/60000-defaulten for ikke-Council-kall (verifisert strukturelt: Council-kallet bruker den eksporterte konstanten, ordinære kall i denne filens øvrige tester forblir uendret siden de aldri setter CompleteInput.timeoutMs)", async () => {
    // `COUNCIL_MODEL_TIMEOUT_MS` leses ved modul-load (samme konvensjon som JARVIS_MODEL_TIMEOUT_MS ellers) -
    // denne testen bekrefter kun at council.ts sin faktiske konstant (uansett verdi, default eller miljø-overstyrt)
    // konsekvent er DEN SAMME på tvers av samtlige fire kallesteder (runde 1/2/3 + syntese), aldri ulik per runde.
    const memberNames = ["anthropic", "openai"];
    const anthropic = buildTimeoutCapturingMember("anthropic", "konklusjon-anthropic", memberNames);
    const openai = buildTimeoutCapturingMember("openai", "konklusjon-openai", memberNames);
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [anthropic, openai] });
    const council = new AiCouncil(gateway);
    await council.run({ tenant_id: "t1", decision_context: "X?", members: memberNames });

    const distinct = new Set([...anthropic.seenTimeouts, ...openai.seenTimeouts]);
    expect(distinct.size).toBe(1);
  });

  it("Å: requireAllFive fail-closed forblir UENDRET når Council-medlemmer bruker den nye timeout-overstyringen (én manglende provider -> IncompleteCouncilError, aldri en falsk full Council)", async () => {
    const memberNames = ["anthropic", "openai", "gemini"];
    const anthropic = buildTimeoutCapturingMember("anthropic", "konklusjon-anthropic", memberNames);
    const openai = buildTimeoutCapturingMember("openai", "konklusjon-openai", memberNames);
    // "gemini" er IKKE registrert i det hele tatt -> manglende medlem, fail-closed.
    const gateway = new ModelGateway({ pool: fakePool(), trace: new MemoryTraceSink(), providers: [anthropic, openai] });
    const council = new AiCouncil(gateway);
    await expect(
      council.run({ tenant_id: "t1", decision_context: "X?", members: memberNames, requireAllFive: true })
    ).rejects.toBeInstanceOf(IncompleteCouncilError);
  });
});
