import { describe, expect, it } from "vitest";
import { classifyContentSensitivity, partitionHistoryBySensitivity, withholdSensitiveMessages } from "../src/content-sensitivity.ts";

/**
 * Uavhengig gjennomgang nr. 2 av WP-A (D-451): parregelen gjaldt bare på den låste banen (Q-51 D); D-384-banen (`partitionHistoryBySensitivity`) fjernet kun selve den følsomme raden, så svaret rett etter
 * («Du har 45 000 igjen.») gikk til skyen. Vokabularhull («sykemeldt», «Metformin», «helsestatusen min») og falske treff på Jarvis' eget tekniske «helse» er rettet i samme runde.
 */
type Msg = { role: "user" | "assistant"; content: string };
const u = (content: string): Msg => ({ role: "user", content });
const a = (content: string): Msg => ({ role: "assistant", content });
const texts = (messages: Msg[]): string[] => messages.map((m) => m.content);

describe("partitionHistoryBySensitivity: parregelen (funn 1)", () => {
  it("et ELDRE følsomt spørsmål tar svaret rett etter med seg, også når svaret ligger i det nylige vinduet", () => {
    const history = [u("hunden"), a("ok"), u("Saldoen min er 45 000 kr"), a("Du har 45 000 igjen."), u("hva er klokka"), a("Den er ti."), u("og været?")];
    const out = partitionHistoryBySensitivity(history, "PUBLIC_OR_LOW_SENSITIVITY");
    expect(texts(out.kept)).toEqual(["hunden", "ok", "hva er klokka", "Den er ti.", "og været?"]);
    expect(out.withheld).toBe(2);
  });

  it("et ELDRE følsomt SVAR tar spørsmålet rett foran med seg", () => {
    const history = [u("hvordan ligger vi an"), a("Lånet ditt er på 2 mill."), u("a"), a("b"), u("c"), a("d"), u("e")];
    const out = partitionHistoryBySensitivity(history, "PUBLIC_OR_LOW_SENSITIVITY");
    expect(texts(out.kept)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("ingen par uten nabo av riktig rolle (to brukermeldinger på rad parres ikke), og meldinger i det nylige vinduet fjernes ikke alene", () => {
    const history = [u("Saldoen min er 45 000 kr"), u("neste ting"), a("ok"), u("a"), a("b"), u("c")];
    const out = partitionHistoryBySensitivity(history, "PUBLIC_OR_LOW_SENSITIVITY");
    expect(texts(out.kept)).toEqual(["neste ting", "ok", "a", "b", "c"]);
    const recent = [u("hei"), a("hei"), u("Saldoen min er 45 000 kr"), a("notert")];
    expect(partitionHistoryBySensitivity(recent, "PUBLIC_OR_LOW_SENSITIVITY").withheld).toBe(0);
  });

  it("tillatt tak: en forretningsmelding (BUSINESS_CONFIDENTIAL) holdes ikke ute når turen selv er forretning, men holdes ute under PRIVAT tak", () => {
    const history = [u("Vi har en avtale med kunden om levering"), a("greit"), u("a"), a("b"), u("c"), a("d")];
    expect(partitionHistoryBySensitivity(history, "BUSINESS_CONFIDENTIAL").withheld).toBe(0);
    expect(partitionHistoryBySensitivity(history, "PRIVATE").withheld).toBe(2);
  });
});

describe("withholdSensitiveMessages: forretningsmeldinger beholdes under standardtaket (mutasjonsfunn m06/m08)", () => {
  it("BUSINESS_CONFIDENTIAL er ikke strengere enn standardtaket og holdes ikke utenfor; SECRET_RESTRICTED gjør det", () => {
    const business = [u("Vi har en avtale med kunden om levering"), a("greit")];
    expect(withholdSensitiveMessages(business).withheld).toEqual([]);
    expect(withholdSensitiveMessages(business, { ceiling: "PRIVATE" }).withheld).toHaveLength(2);
  });
});

describe("ordforråd og teknisk «helse» (funn 6)", () => {
  const level = (text: string) => classifyContentSensitivity({ texts: [text] }).sensitivity;
  it.each([
    "Jeg er sykemeldt denne uka", "Jeg er sykmeldt", "Har helseplager etter ferien", "Trenger helsehjelp", "Hva er helsestatusen min?", "Jeg tar Metformin hver dag", "Jeg har astma",
    "Jarvis helsen min er dårlig", "Hvordan er helsen min?", "Serveren min har dårlig helse"
  ])("personlig helse låser: %s", (text) => {
    expect(level(text)).toBe("SECRET_RESTRICTED");
  });
  it.each([
    "Systemets helse er god", "Systemene har god helse", "helsetilstand per tilkoblet system", "Sjekk helsestatus for tilkoblingen", "connector-helse ser fin ut", "Tjenestens helse er ok",
    "Jarvis sin helse er fin", "Vis helse-endepunktet", "hiv inn en PR"
  ])("Jarvis' eget tekniske «helse» låser ikke: %s", (text) => {
    expect(level(text)).not.toBe("SECRET_RESTRICTED");
  });
});
