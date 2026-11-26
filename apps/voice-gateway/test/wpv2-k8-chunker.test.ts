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

describe("FIX-8 (F8): ordinaltall + månedsnavn («den 1. mai») er ikke en setningsslutt (norsk)", () => {
  it("«den 1. mai», «17. mai», «31. desember»: én setning (hele, tegn for tegn og i større deler)", () => {
    for (const [text, expected] of [
      ["Nasjonaldagen vår feires den 1. mai hvert år. Neste setning følger.", "Nasjonaldagen vår feires den 1. mai hvert år."],
      ["Folk samles i byen på 17. mai med flagg i hånden. Alle koser seg.", "Folk samles i byen på 17. mai med flagg i hånden."],
      ["Årets siste dag er alltid den 31. desember. Så starter et nytt år.", "Årets siste dag er alltid den 31. desember."],
      ["Flyet lander mandag 3. mars klokka 14:30 i Oslo. Takk for tålmodigheten.", "Flyet lander mandag 3. mars klokka 14:30 i Oslo."]
    ] as const) {
      for (const input of [text, chars(text), [text.slice(0, 30), text.slice(30)], [text.slice(0, 33), text.slice(33, 40), text.slice(40)]]) {
        expect(run(input)[0]).toBe(expected);
      }
    }
  });

  it("holdes til månedsnavnet er sett: en tekst som slutter på «1. » eller «1. m» sender ingenting ennå (flush sender alt), og «1. mars»/«1. mai» holdes til ordet er ferdig", () => {
    const out: string[] = [];
    const chunker = new SentenceChunker((c) => out.push(c));
    chunker.push("Nasjonaldagen vår feires den 1. ");
    expect(out).toEqual([]); // ordet etter «1.» er ikke sett
    chunker.push("m");
    expect(out).toEqual([]); // «m» kan bli «mai»/«mars»
    chunker.push("ai");
    expect(out).toEqual([]); // «mai» kan ennå bli et lengre ord - ordet er ikke avsluttet
    chunker.push(" hvert år. Neste.");
    expect(out).toEqual(["Nasjonaldagen vår feires den 1. mai hvert år."]);
    chunker.flush();
    expect(out).toEqual(["Nasjonaldagen vår feires den 1. mai hvert år.", "Neste."]);

    const flushed: string[] = [];
    const early = new SentenceChunker((c) => flushed.push(c));
    early.push("Nasjonaldagen vår feires den 1. ");
    early.flush(); // slutt på generering: holdt tekst går aldri tapt
    expect(flushed).toEqual(["Nasjonaldagen vår feires den 1."]);
  });

  it("alle tolv månedsnavn, og både små og store forbokstaver etter tall (Mai/mai)", () => {
    for (const month of ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"]) {
      const text = `Fristen for innsending av skjemaet er satt til den 15. ${month} i år. Takk.`;
      expect(run(chars(text))[0]).toBe(`Fristen for innsending av skjemaet er satt til den 15. ${month} i år.`);
    }
    expect(run(chars("Fristen for innsending av skjemaet er satt til den 15. Mai i år. Takk."))[0]).toBe("Fristen for innsending av skjemaet er satt til den 15. Mai i år.");
  });

  it("IKKE en dato: år/store tall (2024.), null, vanlig ord etter tallet, og tall som er del av et ord/kode kuttes som før (tegn for tegn OG som hel tekst)", () => {
    const cases: Array<[string, string]> = [
      ["Selskapet ble stiftet i det herrens år 2024. Mai ble en travel måned for alle.", "Selskapet ble stiftet i det herrens år 2024."],
      ["Du har akkurat nå fått til sammen 32. Mai kommer snart.", "Du har akkurat nå fått til sammen 32."], // 32 er ikke en dag
      ["Det står null på tavla akkurat nå 0. Mai kommer snart.", "Det står null på tavla akkurat nå 0."],
      ["Han endte på en delt tredjeplass, altså 3. Deretter gikk vi hjem.", "Han endte på en delt tredjeplass, altså 3."], // ikke månedsnavn
      ["Produktet heter modell A1. Mai er den neste måneden for oss alle.", "Produktet heter modell A1."], // tall midt i en kode (selv om ordet etter ER en måned)
      ["Nasjonaldagen vår feires den 1.\nmai er nasjonaldagen vår, sa han til alle.", "Nasjonaldagen vår feires den 1."], // linjeskift er en setningsslutt
      ["Fristen for innsending av skjemaet er den 1.     mai i år. Takk.", "Fristen for innsending av skjemaet er den 1."], // mer enn tre mellomrom er ingen dato
      ["Vi tok med oss 12. Marsipan er godt, sa han. Takk.", "Vi tok med oss 12."] // «marsipan» er ikke «mars»
    ];
    for (const [text, expected] of cases) {
      for (const input of [chars(text), text, [text.slice(0, 40), text.slice(40)]]) {
        expect(run(input)[0]).toBe(expected);
      }
    }
  });

  it("linjeskift rett etter dagstallet sendes UMIDDELBART (ingen hold): «den 1.\n» uten mer tekst", () => {
    const out: string[] = [];
    const chunker = new SentenceChunker((c) => out.push(c));
    chunker.push("Nasjonaldagen vår feires den 1.\n");
    expect(out).toEqual(["Nasjonaldagen vår feires den 1."]);
  });

  it("vanlig tall + punktum + mellomrom + ny setning (ikke måned) sendes uten ekstra forsinkelse når neste ord er sett", () => {
    const out: string[] = [];
    const chunker = new SentenceChunker((c) => out.push(c));
    chunker.push("Du har akkurat nå fått til sammen 3. Deretter");
    expect(out).toEqual(["Du har akkurat nå fått til sammen 3."]); // «deretter» er ikke et månedsnavn: ingen hold
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

  it("skanningen er INKREMENTELL: 100 KB uten kutt (hard grense 1 MB) i 4-tegns deltaer skanner hver posisjon én gang, ikke på nytt per push", () => {
    // Med en høy hard grense vokser bufferen uten å bli kuttet; en implementasjon som skanner fra `minChars` ved hver push bruker da O(n²)
    // (her ca. 10^9 tegnsjekker) mot O(n) for scanPos-løsningen.
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const chunker = new SentenceChunker(() => undefined, { maxChars: 2_000_000, hardMaxChars: 2_000_001 });
      const start = performance.now();
      for (let i = 0; i < 100_000; i += 4) chunker.push("aaaa");
      best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(1_500);
  }, 60_000);

  it("200 KB med mange punktum uten mellomrom (a.a.a.…) er også lineær - ubegrenset bakoverskanning er en kvadratisk felle", () => {
    const t200 = timeStreaming(200_000, ".a");
    expect(t200).toBeLessThan(3_000);
  }, 60_000);

  it("200 KB med mellomrom, men uten setningsgrenser: raskt", () => {
    expect(timeStreaming(200_000, "ab c")).toBeLessThan(3_000);
  }, 60_000);
});
