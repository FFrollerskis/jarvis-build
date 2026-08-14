import { describe, expect, it } from "vitest";
import { transcriptMatches } from "../src/acceptance.ts";

/**
 * D-30 live-funn (§10): live-Whisper transkriberte "Hva er atten ganger sju?"
 * semantisk korrekt som "Hva er 18 x 7?", men naiv ord-overlapp kalte det FAIL.
 * Akseptansen skal godta kjente ekvivalente representasjoner - og fortsatt
 * avvise vilkårlig dårlige transkript (norsk kalender-setning er IKKE svekket).
 */
describe("D-30 §10: semantisk robust STT-akseptanse", () => {
  const MATH = "Hva er atten ganger sju?";

  it("godtar live-funnet: 'atten ganger sju' ≙ '18 x 7'", () => {
    expect(transcriptMatches(MATH, "Hva er 18 x 7?")).toBe(true);
  });

  it("godtar '18 × 7' (typografisk gangetegn) og '18 ganger 7'", () => {
    expect(transcriptMatches(MATH, "Hva er 18 × 7?")).toBe(true);
    expect(transcriptMatches(MATH, "Hva er 18 ganger 7?")).toBe(true);
  });

  it("godtar ordrett transkript (og 'syv' for 'sju')", () => {
    expect(transcriptMatches(MATH, "Hva er atten ganger sju?")).toBe(true);
    expect(transcriptMatches(MATH, "hva er atten ganger syv")).toBe(true);
  });

  it("avviser vilkårlig dårlige transkript - terskelen er ikke senket", () => {
    expect(transcriptMatches(MATH, "")).toBe(false);
    expect(transcriptMatches(MATH, "helt annen tekst uten samsvar")).toBe(false);
    // Kun 2 kanoniserte ord felles ("hva er") er fortsatt under terskelen:
    expect(transcriptMatches(MATH, "Hva er klokka?")).toBe(false);
  });

  it("norsk kalender-setning: uendret streng - matcher seg selv, avviser støy", () => {
    const CAL = "Hva står på kalenderen min i dag?";
    expect(transcriptMatches(CAL, "Hva står på kalenderen min i dag?")).toBe(true);
    expect(transcriptMatches(CAL, "hva står på kalenderen")).toBe(true);
    expect(transcriptMatches(CAL, "atten sju ganger")).toBe(false);
  });
});
