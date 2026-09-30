import { describe, expect, it } from "vitest";
import { sanitizeForSpeech } from "../src/text-sanitize.ts";

/**
 * D-353 (Tobias direkte i chat, live bruk: "den leser opp tegn ... den sier
 * bla bla bla så stjerne stjerne punktum"). Se `text-sanitize.ts` sitt
 * filhode for full rotårsaksforklaring.
 */
describe("sanitizeForSpeech() - D-353", () => {
  it("fjerner fet skrift (**tekst**), beholder selve teksten", () => {
    expect(sanitizeForSpeech("**Møte 1** kl 10.")).toBe("Møte 1 kl 10.");
  });

  it("fjerner fet skrift med understrek (__tekst__)", () => {
    expect(sanitizeForSpeech("Dette er __viktig__ informasjon.")).toBe("Dette er viktig informasjon.");
  });

  it("fjerner kursiv med stjerne (*tekst*), beholder teksten", () => {
    expect(sanitizeForSpeech("Det er *ganske* bra.")).toBe("Det er ganske bra.");
  });

  it("reproduserer IKKE Tobias sitt eksakte funn: **...**. skal ALDRI bli \"stjerne stjerne punktum\"", () => {
    const out = sanitizeForSpeech("Dette er **fantastisk**.");
    expect(out).toBe("Dette er fantastisk.");
    expect(out).not.toContain("*");
  });

  it("fjerner inline kode (`kode`), beholder innholdet", () => {
    expect(sanitizeForSpeech("Kjør `npm install` først.")).toBe("Kjør npm install først.");
  });

  it("fjerner kodeblokk-gjerder (```), beholder innholdet", () => {
    expect(sanitizeForSpeech("```bash\nnpm install\n```")).toBe("npm install");
  });

  it("fjerner Markdown-lenker, beholder kun lenketeksten", () => {
    expect(sanitizeForSpeech("Se [dokumentasjonen](https://example.com) for mer.")).toBe(
      "Se dokumentasjonen for mer."
    );
  });

  it("fjerner punktliste-markører ved linjestart", () => {
    expect(sanitizeForSpeech("- Punkt en\n- Punkt to")).toBe("Punkt en\nPunkt to");
  });

  it("fjerner nummererte liste-markører ved linjestart", () => {
    expect(sanitizeForSpeech("1. Først\n2. Deretter")).toBe("Først\nDeretter");
  });

  it("fjerner overskrift-markører (#) ved linjestart", () => {
    expect(sanitizeForSpeech("## Viktig\nInnhold her.")).toBe("Viktig\nInnhold her.");
  });

  it("lar vanlig tekst UTEN Markdown stå helt uendret (ingen falske positiver)", () => {
    const plain = "Du har tre møter i dag. Det første er klokka ni.";
    expect(sanitizeForSpeech(plain)).toBe(plain);
  });

  it("ødelegger IKKE tall/klokkeslett-punktum (18.30 skal forbli 18.30)", () => {
    expect(sanitizeForSpeech("Møtet er klokka 18.30 i morgen.")).toBe("Møtet er klokka 18.30 i morgen.");
  });

  it("siste sikkerhetsnett: en upar stjerne/backtick fjernes uansett", () => {
    expect(sanitizeForSpeech("Et rart *fragment uten lukking")).toBe("Et rart fragment uten lukking");
    expect(sanitizeForSpeech("En `ukomplett kodebit")).toBe("En ukomplett kodebit");
  });

  it("slår sammen dobbel whitespace som tegnfjerning kan etterlate", () => {
    expect(sanitizeForSpeech("Tekst  **fet**  mer tekst")).toBe("Tekst fet mer tekst");
  });

  it("tom/kun-Markdown-input gir tom streng (aldri kastet feil)", () => {
    expect(sanitizeForSpeech("**")).toBe("");
    expect(sanitizeForSpeech("")).toBe("");
  });
});
