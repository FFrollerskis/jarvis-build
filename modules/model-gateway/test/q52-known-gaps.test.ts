import { describe, expect, it } from "vitest";
import { classifyContentSensitivity } from "../src/content-sensitivity.ts";

/**
 * Q-52 (funnet av den uavhengige gjennomgangen av Q-50, målt 2026-10-08): sensitivitetsklassifiseringen er STIKKORDSBASERT, og ordforrådet er smalt. Det gjelder chatten (D-378) like mye som
 * bakgrunnsjobber på skyruten (D-449) - «økonomi/helse forblir lokale» gjelder bare for ordene mønstrene faktisk kjenner. Denne filen låser hullene som KJENTE og dokumenterte, så de ikke
 * kan glemmes eller misforstås som dekket.
 *
 * `it.fails` BESKRIVER ønsket oppførsel (SECRET_RESTRICTED = kun lokal modell) og forventes å feile i dag. Utvides mønstrene (Q-52 alternativ A, krever eierens ja), vil `it.fails` bli rød - fjern da `.fails`
 * på de ordene som nå fanges. `it` (uten fails) låser at det som FANGES i dag fortsatt fanges (ingen regresjon mens Q-52 er åpen).
 */
const classify = (word: string) => classifyContentSensitivity({ texts: [`jeg må snakke om ${word} i dag`] }).sensitivity;

describe("Q-52: det som fanges i dag fortsatt fanges (ubestemte former og enkelte bestemte)", () => {
  for (const word of ["legetime", "fastlege", "lege", "kreft", "sykehuset", "diagnosen", "medisinen", "resepten", "depresjonen", "sykemeldingen", "lønnen", "lånet", "gjelden", "saldoen", "formuen", "inntekten"]) {
    it(`«${word}» → SECRET_RESTRICTED`, () => {
      expect(classify(word)).toBe("SECRET_RESTRICTED");
    });
  }
});

describe("Q-52: KJENTE HULL (klassifiseres i dag som uskyldig; ønsket oppførsel er SECRET_RESTRICTED)", () => {
  const definiteForms = ["legen", "fastlegen", "legetimen", "behandlingen", "kreften", "kontoutskriften", "pensjonen", "aksjene", "blodtrykket"];
  const healthVocabulary = ["helse", "helseproblemer", "ADHD", "psykiater", "tannlege", "tannlegen", "terapi", "terapeut", "migrene", "kolesterol", "insulin", "kjemoterapi", "antidepressiva", "covid", "sykmelding"];
  const financeVocabulary = ["skatten", "kontoen", "pengene", "økonomien"];
  for (const word of [...definiteForms, ...healthVocabulary, ...financeVocabulary]) {
    it.fails(`«${word}» fanges ikke i dag (Q-52)`, () => {
      expect(classify(word)).toBe("SECRET_RESTRICTED");
    });
  }
});
