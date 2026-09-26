import { describe, expect, it } from "vitest";
import { RuleBasedExtractor } from "../src/extraction.ts";

/**
 * D-286 (Tobias direkte i chat, "alle" - se `docs/DECISIONS_AND_ASSUMPTIONS.md`):
 * BEVISER at `RuleBasedExtractor` ikke lenger er en ubegrenset catch-all
 * (FØR denne posten ble ALLE setninger over lengdeterskelen lagret som
 * "semantic", inkl. ren småprat) - et eksplisitt, navngitt signalord kreves
 * nå for HVER kandidat. Ren funksjon, ingen DB/pool nødvendig - i
 * motsetning til `memory.test.ts` (som øver `MemoryWriter`/`MemoryRetriever`
 * mot en ekte embedded Postgres).
 */
const extractor = new RuleBasedExtractor();

describe("D-286: RuleBasedExtractor krever et eksplisitt signalord - ingen catch-all", () => {
  it("A: ren småprat (ingen signalord) gir INGEN kandidater", async () => {
    const candidates = await extractor.extract(
      "Hei Charlie! Takk, i like måte! Hva skjer med deg i dag da kompis?",
      "personal",
      "trusted"
    );
    // D-286: "i dag" er faktisk et DATE-signalord (episodic) - resten er
    // ren småprat uten noe signalord, og skal derfor forkastes.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe("episodic");
  });

  it("B: ekte relasjons-/identitetsutsagn gir type 'relation'", async () => {
    const candidates = await extractor.extract("Pappa heter Henrik.", "personal", "trusted");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ type: "relation", content: "Pappa heter Henrik.", confidence: 0.6 });
  });

  it("C: whisper.cpp sin EGEN, allerede live-observerte STT-bøyningsfeil ('hete' i stedet for 'heter') fanges FORTSATT", async () => {
    // D-285-loggen viste ORDRETT "Pappa, hete Henrik." - en streng
    // `\bheter\b`-only-variant ville IKKE fanget den ekte, allerede
    // vellykkede live-testen (§ det faktiske beviset for at minnet virker).
    const candidates = await extractor.extract("Pappa, hete Henrik.", "personal", "trusted");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe("relation");
  });

  it("D: preferanse-utsagn gir type 'preference', uendret fra før", async () => {
    const candidates = await extractor.extract("Jeg liker sjokolade veldig godt.", "personal", "trusted");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe("preference");
  });

  it("E: beslutnings-utsagn gir type 'decision', uendret fra før", async () => {
    const candidates = await extractor.extract("Jeg besluttet å slutte i jobben.", "personal", "trusted");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe("decision");
  });

  it("F: dato-/hendelsesutsagn gir type 'episodic', uendret fra før", async () => {
    const candidates = await extractor.extract("Jeg dro til Oslo i går kveld.", "personal", "trusted");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe("episodic");
  });

  it("G: bosted-/yrkesutsagn gir type 'relation'", async () => {
    const candidates = await extractor.extract("Jeg bor i Trondheim og jobber som lærer.", "personal", "trusted");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe("relation");
  });

  it("H: blandet tekst - kun setninger MED signalord blir kandidater, resten forkastes", async () => {
    const candidates = await extractor.extract(
      "Hei Charlie, hyggelig å prate! Pappa heter Henrik. Så morsomt at du spør!",
      "personal",
      "trusted"
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.content).toBe("Pappa heter Henrik.");
  });

  it("I: for korte setninger (<= 8 tegn) forkastes uansett signalord, uendret fra før", async () => {
    const candidates = await extractor.extract("Liker X.", "personal", "trusted");
    expect(candidates).toHaveLength(0);
  });

  it("J: subject/space/confidence bygges uendret fra før for godkjente kandidater", async () => {
    const candidates = await extractor.extract("Jeg jobber som lærer på en skole i Bergen.", "business", "internal");
    expect(candidates[0]).toMatchObject({
      space: "business",
      subject: "jeg.jobber.som.lærer.på",
      confidence: 0.6
    });
  });
});
