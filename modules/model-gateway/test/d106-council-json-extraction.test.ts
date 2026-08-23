import { describe, expect, it } from "vitest";
import { extractJson } from "../src/index.ts";

/**
 * D-106 HOST-FIX (produksjonsherding, Defekt D): live host-kjøring viste
 * ekte parse-feil (`invalid_json_shape`/`council_synthesis_invalid`) mot
 * FAKTISKE modellsvar - den opprinnelige `extractJson()` tok naivt den
 * FØRSTE balanserte `{...}`-blokken uten å sjekke om en ANNEN, konkurrerende
 * kandidat fantes lenger ut i teksten (stille tvetydighet), og strippet
 * ALDRI markdown-kodeblokk-fences. Denne testfilen beviser den nye, strenge
 * uthentingen dekker ALLE åtte formateringsklassene ordren listet eksplisitt,
 * samt at ALDRI en fabrikert/gjettet struktur returneres ved feil.
 */
describe("D-106 HOST-FIX Defekt D: extractJson() - deterministisk, streng JSON-uthenting", () => {
  const ROUND1_PAYLOAD = {
    conclusion: "gå videre med planen",
    reasoning_summary: "begrunnelse",
    assumptions: ["a1"],
    evidence_provenance: ["k1"],
    risks: ["r1"],
    confidence: 70,
    unresolved_questions: []
  };
  const RAW = JSON.stringify(ROUND1_PAYLOAD);

  it("A: rå JSON (ingen fence, ingen fritekst) parses direkte", () => {
    expect(extractJson(RAW)).toEqual(ROUND1_PAYLOAD);
  });

  it("B: ledende/etterfølgende whitespace tillates", () => {
    expect(extractJson(`\n\n  ${RAW}  \t\n`)).toEqual(ROUND1_PAYLOAD);
  });

  it("C: ```json-fenced JSON strippes og parses", () => {
    expect(extractJson(`Her er svaret mitt:\n\n\`\`\`json\n${RAW}\n\`\`\`\n\nHåper det hjelper!`)).toEqual(ROUND1_PAYLOAD);
  });

  it("D: generisk \\`\\`\\`-fenced JSON (uten 'json'-språk-tag) strippes og parses", () => {
    expect(extractJson(`\`\`\`\n${RAW}\n\`\`\``)).toEqual(ROUND1_PAYLOAD);
  });

  it("E: ett utvetydig JSON-objekt omgitt av avgrenset fritekst (bounded prose) aksepteres", () => {
    expect(extractJson(`Basert på analysen min er konklusjonen: ${RAW} - dette er mitt endelige svar.`)).toEqual(ROUND1_PAYLOAD);
  });

  it("F: malformert JSON feiler ÆRLIG (undefined, ALDRI en fabrikert/delvis struktur)", () => {
    expect(extractJson(`{"conclusion": "gå videre", "confidence": ,}`)).toBeUndefined();
  });

  it("F2: avkuttet (ubalansert) JSON feiler ÆRLIG", () => {
    expect(extractJson(`{"conclusion": "gå videre", "confidence": 70`)).toBeUndefined();
  });

  it("G: FLERE JSON-objekter i samme svar er tvetydig - feiler ÆRLIG, ALDRI en gjettet 'riktig' kandidat", () => {
    const other = JSON.stringify({ ...ROUND1_PAYLOAD, conclusion: "et annet svar" });
    expect(extractJson(`${RAW} ${other}`)).toBeUndefined();
  });

  it("G2: FLERE fenced kodeblokker er OGSÅ tvetydig - feiler ÆRLIG", () => {
    const other = JSON.stringify({ ...ROUND1_PAYLOAD, conclusion: "et annet svar" });
    expect(extractJson(`\`\`\`json\n${RAW}\n\`\`\`\n\n\`\`\`json\n${other}\n\`\`\``)).toBeUndefined();
  });

  it("H: skjema-ugyldig (men strukturelt gyldig) JSON returneres UENDRET av extractJson selv - skjemavalidering er kallerens ansvar (isRoundAnswer), ALDRI fabrikert her", () => {
    const missingFields = JSON.stringify({ conclusion: "kun konklusjon, mangler resten" });
    expect(extractJson(missingFields)).toEqual({ conclusion: "kun konklusjon, mangler resten" });
  });

  it("I: en fenced blokk med ugyldig innhold feiler ÆRLIG - ALDRI et fallback-søk andre steder i teksten selv om et gyldig objekt finnes utenfor fence-en", () => {
    const text = `Se JSON: \`\`\`json\n{"conclusion": ,}\n\`\`\` (forresten, ${RAW} er urelatert)`;
    expect(extractJson(text)).toBeUndefined();
  });

  it("J: tom/whitespace-only tekst feiler ÆRLIG", () => {
    expect(extractJson("   \n\t  ")).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
  });

  it("K: en bokstavelig `{`/`}` INNI et streng-felt forstyrrer IKKE den streng-bevisste balanse-tellingen", () => {
    const withBraceInString = JSON.stringify({ ...ROUND1_PAYLOAD, reasoning_summary: "config er {slik} strukturert" });
    expect(extractJson(withBraceInString)).toEqual({ ...ROUND1_PAYLOAD, reasoning_summary: "config er {slik} strukturert" });
  });

  it("L: provider-nøytral - ingen leverandørspesifikk formatering antas eller kreves (samme funksjon for alle fem familier)", () => {
    for (const wrapper of [
      (s: string) => s,
      (s: string) => `\`\`\`json\n${s}\n\`\`\``,
      (s: string) => `Svar: ${s}`
    ]) {
      expect(extractJson(wrapper(RAW))).toEqual(ROUND1_PAYLOAD);
    }
  });
});
