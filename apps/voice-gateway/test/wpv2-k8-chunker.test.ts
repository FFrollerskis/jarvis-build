import { describe, expect, it } from "vitest";
import { SentenceChunker, type ChunkerOptions } from "../src/chunker.ts";
import { normalizeForNorwegianSpeech, sanitizeForSpeech } from "../src/text-sanitize.ts";

/**
 * WP-V2 K8 (JARVIS-098): tekst-kanttilfeller i setningschunkeren. Norske eksempler: klokkeslett, desimaltall og forkortelser skal ikke kuttes
 * midt i (da mister chunken `normalizeForNorwegianSpeech`), en chunk har en HARD maks-lengde på kodepunktgrense, og skanningen er lineær.
 */
function run(input: string | string[], options?: ChunkerOptions, flush = true): string[] {
  const out: string[] = [];
  const chunker = new SentenceChunker((c) => out.push(c), options);
  for (const piece of Array.isArray(input) ? input : [input]) chunker.push(piece);
  if (flush) chunker.flush();
  return out;
}

/** Strømmer teksten ett tegn om gangen (verste tilfelle for tokengrenser midt i «14:30»/«f.eks.»). */
function chars(text: string): string[] {
  return Array.from(text);
}

describe("klokkeslett og desimaltall kuttes ikke midt i", () => {
  it("«klokka 14:30» gir én chunk med hele klokkeslettet, og normalisering gjør 14:30 til 14.30", () => {
    const text = "Møtet starter klokka 14:30 i morgen. Husk å ta med notatene.";
    for (const input of [text, chars(text), [text.slice(0, 22), text.slice(22)]]) {
      const chunks = run(input);
      expect(chunks).toEqual(["Møtet starter klokka 14:30 i morgen.", "Husk å ta med notatene."]);
      expect(sanitizeForSpeech(chunks[0] as string)).toContain("klokka 14.30");
    }
  });

  it("kolon FØR et tall på chunk-grensen holdes til neste token er sett («14:» + «30»)", () => {
    const chunks = run(["Avtalen er satt til klokka 14:", "30 på mandag. Greit."]);
    expect(chunks[0]).toBe("Avtalen er satt til klokka 14:30 på mandag.");
  });

  it("desimaltall og klokkeslett med punktum: «18.30», «3.5 prosent»", () => {
    expect(run(chars("Bussen går klokka 18.30 hver kveld. Takk."))).toEqual(["Bussen går klokka 18.30 hver kveld.", "Takk."]);
    expect(run(["Renten er 3.", "5 prosent i år. Greit nok."])[0]).toBe("Renten er 3.5 prosent i år.");
  });

  it("adresse som avsluttes med punktum + mellomrom er fortsatt en setningsgrense; e-postadresser kuttes ikke", () => {
    expect(run(chars("Du finner det på https://eksempel.no/side. Neste punkt følger her."))).toEqual([
      "Du finner det på https://eksempel.no/side.",
      "Neste punkt følger her."
    ]);
    expect(run(chars("Send en mail til navn@firma.no så snart du kan. Takk."))[0]).toBe("Send en mail til navn@firma.no så snart du kan.");
  });

  it("kolon ved vanlig setningsdeling kuttes fortsatt (kolon + mellomrom)", () => {
    expect(run("Du har tre ting å gjøre i dag: møte, mail og lunsj. Ellers rolig.")[0]).toBe("Du har tre ting å gjøre i dag:");
  });

  it("URL-skjema («https://») kuttes ikke ved kolon, så URL-fjerningen i normaliseringen får hele adressen", () => {
    const chunks = run(chars("Les mer på https://eksempel.no/side for detaljer. Ferdig."));
    expect(chunks[0]).toBe("Les mer på https://eksempel.no/side for detaljer.");
    expect(normalizeForNorwegianSpeech(chunks[0] as string)).not.toContain("eksempel");
  });
});

describe("forkortelser kuttes ikke midt i", () => {
  it("«f.eks.» (hele og tegn for tegn): én setning, og normaliseringen får «for eksempel»", () => {
    const text = "Jeg har mange ting å gjøre, f.eks. møter og e-post. Så kommer lunsj.";
    for (const input of [text, chars(text)]) {
      const chunks = run(input);
      expect(chunks).toEqual(["Jeg har mange ting å gjøre, f.eks. møter og e-post.", "Så kommer lunsj."]);
      expect(sanitizeForSpeech(chunks[0] as string)).toContain("for eksempel møter");
    }
  });

  it("«f.eks.» som deles midt i mellom to tokens («f.» + «eks.»)", () => {
    const chunks = run(["Vi bruker verktøy, f.", "eks. kalender og e-post, hver dag. Fint."]);
    expect(chunks[0]).toBe("Vi bruker verktøy, f.eks. kalender og e-post, hver dag.");
  });

  it("«kl. 14», «ca. 5», «bl.a.»: punktum etter forkortelsen er ikke en grense", () => {
    expect(run(chars("Vi møtes kl. 14 på kontoret i dag. Takk."))[0]).toBe("Vi møtes kl. 14 på kontoret i dag.");
    expect(run(chars("Prosjektet tar ca. 5 uker å gjennomføre. Så ferdig."))[0]).toBe("Prosjektet tar ca. 5 uker å gjennomføre.");
    expect(run(chars("Vi tar opp mye, bl.a. budsjettet for neste år. Takk."))[0]).toBe("Vi tar opp mye, bl.a. budsjettet for neste år.");
  });

  it("vanlig setningsslutt på slutten av bufferen sendes UMIDDELBART (ingen holdt latens): «dag.» uten mer tekst", () => {
    const out: string[] = [];
    const chunker = new SentenceChunker((c) => out.push(c));
    chunker.push("Du har tre møter i dag.");
    expect(out).toEqual(["Du har tre møter i dag."]); // ikke holdt til flush
  });

  it("holdte tegn går aldri tapt: flush() sender alt (slutt på generering rett etter «klokka 14.»)", () => {
    const out: string[] = [];
    const chunker = new SentenceChunker((c) => out.push(c));
    chunker.push("Møtet er satt til klokka 14.");
    expect(out).toEqual([]); // holdt - kan bli «14.30»
    chunker.flush();
    expect(out).toEqual(["Møtet er satt til klokka 14."]);
  });

  it("uendret oppførsel for ordinære setninger, spørsmål og linjeskift", () => {
    // (minChars = 16 teller fra starten av HVER chunk, som før: «Hva sier du?» er for kort alene og slås sammen med «Ja!».)
    expect(run("Hei der, dette er en test. Hva sier du? Ja!\nOk da.")).toEqual(["Hei der, dette er en test.", "Hva sier du? Ja!", "Ok da."]);
  });
});

describe("hard maks chunk-lengde (OpenAI-TTS tar 4 096 tegn)", () => {
  it("tekst uten mellomrom og grenser: hver chunk <= hardMaxChars, og ingen tekst går tapt", () => {
    const text = "x".repeat(10_000);
    const chunks = run(text, { hardMaxChars: 4_000 });
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(4_000);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it("standard hard grense er 4 000 (under OpenAIs 4 096)", () => {
    const chunks = run("y".repeat(9_000));
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(4_000);
  });

  it("en setningsgrense LANGT bak hard grense gir fortsatt chunker <= hard grense (ikke én kjempechunk)", () => {
    const text = `${"z".repeat(9_500)}. Slutt.`;
    const chunks = run(text, { hardMaxChars: 1_000 });
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(1_000);
    expect(chunks.join("")).toContain("Slutt.");
  });

  it("surrogatpar: aldri kuttet midt i et par (emoji uten mellomrom, oddetall grense)", () => {
    const text = "😀".repeat(2_000); // 4 000 UTF-16-enheter, 2 000 kodepunkt
    for (const limit of [101, 100, 333]) {
      const chunks = run(text, { hardMaxChars: limit, maxChars: 50 });
      for (const chunk of chunks) {
        const last = chunk.charCodeAt(chunk.length - 1);
        const first = chunk.charCodeAt(0);
        expect(last >= 0xd800 && last <= 0xdbff, `chunk ender på høy surrogat (grense ${limit})`).toBe(false);
        expect(first >= 0xdc00 && first <= 0xdfff, `chunk starter på lav surrogat (grense ${limit})`).toBe(false);
        expect(chunk.length).toBeLessThanOrEqual(limit);
      }
      expect(chunks.join("")).toBe(text);
    }
  });

  it("den myke ordgrensen (maxChars) virker som før når det finnes mellomrom", () => {
    const text = `${"ord ".repeat(200)}`.trim();
    const chunks = run(text);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(321);
    expect(chunks.join(" ")).toBe(text);
  });
});

describe("lineær tid (skanningen er inkrementell)", () => {
  /** Strømmer `total` tegn uten grenser i deltaer på 4 tegn og returnerer medgått tid (ms) - minste av tre kjøringer. */
  function timeStreaming(total: number, filler: string): number {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const chunker = new SentenceChunker(() => undefined);
      const start = performance.now();
      for (let i = 0; i < total; i += 4) chunker.push(filler.repeat(4));
      chunker.flush();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  it("200 KB uten grenser og mellomrom i 4-tegns deltaer: raskt, og tiden vokser lineært (ikke kvadratisk)", () => {
    const t200 = timeStreaming(200_000, "a");
    expect(t200).toBeLessThan(3_000);
    const t50 = timeStreaming(50_000, "a");
    // Lineær: 4x data ~ 4x tid (her gis romslig slingring for jitter); kvadratisk ville gitt ~16x.
    expect(t200 / Math.max(t50, 1)).toBeLessThan(10);
  }, 60_000);

  it("200 KB med mange punktum uten mellomrom (a.a.a.…) er også lineær - ubegrenset bakoverskanning er en kvadratisk felle", () => {
    const t200 = timeStreaming(200_000, ".a");
    expect(t200).toBeLessThan(3_000);
  }, 60_000);

  it("200 KB med mellomrom, men uten setningsgrenser: raskt", () => {
    expect(timeStreaming(200_000, "ab c")).toBeLessThan(3_000);
  }, 60_000);
});
