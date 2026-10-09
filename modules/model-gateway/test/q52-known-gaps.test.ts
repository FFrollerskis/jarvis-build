import { describe, expect, it } from "vitest";
import { classifyContentSensitivity } from "../src/content-sensitivity.ts";

/**
 * Q-52 (funnet av den uavhengige gjennomgangen av Q-50, målt 2026-10-08): sensitivitetsklassifiseringen er STIKKORDSBASERT, og ordforrådet var smalt - «økonomi/helse forblir lokale» gjelder bare for ordene mønstrene
 * faktisk kjenner. Chatten (D-378) og bakgrunnsjobber på skyruten (D-449) bruker samme klassifisering.
 *
 * Q-52 A (D-450, Tobias 2026-10-09: «Ja til alle Q»): mønstrene er utvidet med de bestemte formene av ord som allerede ble fanget og med de entydige helse-/økonomiordene (de 35 ordene som tidligere var `it.fails` her
 * er nå vanlige tester). De TVETYDIGE ordene - skatt, konto, penger, økonomi, operasjon, behandling og programvare-«abort» - er BEVISST ikke gjort sensitive ennå («ta de tvetydige først etter at du har sett hvor
 * ofte de treffer»): de telles bare (`ambiguous_terms`, logget som `q52_ambiguous_terms`). Å gjøre dem sensitive er et eget valg og krever at disse testene endres bevisst.
 *
 * Fortsatt gjelder: dette er ordgjenkjenning, ikke en garanti. Ord som ikke står her (og omskrivinger) fanges ikke.
 */
const classify = (word: string) => classifyContentSensitivity({ texts: [`jeg må snakke om ${word} i dag`] });

describe("Q-52: det som alltid har blitt fanget fortsatt fanges", () => {
  for (const word of ["legetime", "fastlege", "lege", "kreft", "sykehuset", "diagnosen", "medisinen", "resepten", "depresjonen", "sykemeldingen", "lønnen", "lånet", "gjelden", "saldoen", "formuen", "inntekten"]) {
    it(`«${word}» → SECRET_RESTRICTED`, () => {
      expect(classify(word).sensitivity).toBe("SECRET_RESTRICTED");
    });
  }
});

describe("Q-52 A (D-450): utvidet ordforråd - fanges nå som SECRET_RESTRICTED", () => {
  // Bestemte former av ord som fanges i ubestemt form («lege» fanges, «legen» fanget ikke).
  const definiteForms = ["legen", "fastlegen", "legetimen", "kreften", "blodtrykket", "legene", "legens"];
  // Fanget i INGEN form før (målt av gjennomgang nr. 2 av Q-50).
  const healthNew = ["gravid", "HIV", "sykmeldt", "svangerskap", "kolonoskopi", "helse", "helsen", "helseproblemer", "ADHD", "psykiater", "tannlege", "tannlegen", "terapi", "terapien", "terapeut", "migrene", "kolesterol", "insulin", "kjemoterapi", "antidepressiva", "covid", "covid-19", "sykmelding"];
  const financeNew = ["kontoutskrift", "kontoutskriften", "pensjon", "pensjonen", "aksjer", "aksjene", "aksjefond", "aksjekursen", "bankkonto", "bankkontoen", "kredittkortet", "inkasso", "inkassokravet"];
  for (const word of [...definiteForms, ...healthNew, ...financeNew]) {
    it(`«${word}» → SECRET_RESTRICTED`, () => {
      expect(classify(word).sensitivity).toBe("SECRET_RESTRICTED");
    });
  }

  it("«PIN-koden er 4321» (bankkode uten kjent hemmelighetsformat) → SECRET_RESTRICTED med årsak text:secret", () => {
    const decision = classify("PIN-koden er 4321");
    expect(decision.sensitivity).toBe("SECRET_RESTRICTED");
    expect(decision.reasons).toContain("text:secret");
  });

  it("BankID-kode og engangskode er også hemmeligheter", () => {
    for (const phrase of ["BankID-koden min er 123456", "engangskoden fra banken er 998877", "pinkoden"]) {
      expect(classifyContentSensitivity({ texts: [phrase] }).reasons, phrase).toContain("text:secret");
    }
  });
});

describe("Q-52 A (D-450): ord som IKKE skal låse noe (falske treff i Jarvis' egen hverdag)", () => {
  const harmless = [
    "gjelder", "gjeldende", "aksjeselskap", "aksjon", "bicycle", "legenden", "legende", "helsesjekk", "helsestatus", "systemhelse", "helsa",
    "terapien er utenfor", "hivkontroll", "archive", "abortcontroller", "AbortController", "behandlingstid"
  ];
  for (const word of harmless) {
    // «terapien er utenfor» ER et helseord (terapi) - tas ut av listen under; resten må forbli uskyldige.
    if (word.startsWith("terapien")) continue;
    it(`«${word}» → ikke SECRET_RESTRICTED`, () => {
      expect(classify(word).sensitivity, word).not.toBe("SECRET_RESTRICTED");
    });
  }

  it("«leger» som verb-lignende ord («legger») gir ikke treff, men «legene» gjør", () => {
    expect(classify("han legger fra seg boka").sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    expect(classify("legene sa det").sensitivity).toBe("SECRET_RESTRICTED");
  });
});

describe("Q-52 A (D-450): de tvetydige ordene er BEVISST ikke sensitive - men telles", () => {
  const ambiguous: Array<[string, string]> = [
    ["skatten", "skatt"], ["skatt", "skatt"], ["kontoen", "konto"], ["pengene", "penger"], ["økonomien", "økonomi"], ["operasjon", "operasjon"], ["behandling", "behandling"], ["behandlingen", "behandling"]
  ];
  for (const [word, key] of ambiguous) {
    it(`«${word}» låser ikke noe (PUBLIC), men rapporteres som «${key}»`, () => {
      const decision = classify(word);
      expect(decision.sensitivity, word).toBe("PUBLIC_OR_LOW_SENSITIVITY");
      expect(decision.ambiguous_terms, word).toContain(key);
    });
  }

  it("rapporterer kun nøkler, aldri tekst, og kun når et tvetydig ord forekommer", () => {
    expect(classifyContentSensitivity({ texts: ["hei, hva skjer"] }).ambiguous_terms).toBeUndefined();
    const decision = classifyContentSensitivity({ texts: ["jeg lurer på skatten og kontoen min"] });
    expect(decision.ambiguous_terms?.sort()).toEqual(["konto", "skatt"]);
    expect(JSON.stringify(decision)).not.toContain("lurer");
  });

  it("et tvetydig ord sammen med et sterkt ord gir fortsatt SECRET_RESTRICTED (det sterke vinner)", () => {
    const decision = classifyContentSensitivity({ texts: ["kontoen min har lav saldo"] });
    expect(decision.sensitivity).toBe("SECRET_RESTRICTED");
    expect(decision.ambiguous_terms).toContain("konto");
  });
});
