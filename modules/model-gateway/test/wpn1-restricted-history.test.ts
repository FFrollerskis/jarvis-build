import { describe, expect, it } from "vitest";
import type { DataSensitivity } from "@jarvis/contracts";
import { classifyContentSensitivity, partitionHistoryBySensitivity, withholdSensitiveMessages } from "../src/content-sensitivity.ts";

/**
 * WP-N1 (Q-66, JARVIS-101, K4): de RENE partisjonsfunksjonene leser `restricted`-merket.
 *  - en melding med `restricted === true` er SECRET_RESTRICTED uansett tekst (par-regelen, halen og `protect` gjelder uendret),
 *  - uten merking (ingen egenskap, `false`, `undefined`, alt annet enn eksakt `true`) er oppførselen NØYAKTIG den gamle - bevist mot en ORAKEL-kopi av algoritmen slik den står på origin/main
 *    (`git show origin/main:modules/model-gateway/src/content-sensitivity.ts`, ec3e684e), kjørt over tusenvis av tilfeldige historikker. Orakelet kaller den LEVENDE klassifisereren, så testen er
 *    knyttet til ALGORITMEN og ikke til et ordforråd som senere WP-er legitimt kan utvide.
 */
const RANK: Record<DataSensitivity, number> = { PUBLIC_OR_LOW_SENSITIVITY: 0, PRIVATE: 1, BUSINESS_CONFIDENTIAL: 2, SECRET_RESTRICTED: 3 };
const level = (text: string): DataSensitivity => classifyContentSensitivity({ texts: [text] }).sensitivity;

type Row = { role: "user" | "assistant"; content: string; restricted?: boolean };
const u = (content: string, restricted?: boolean): Row => ({ role: "user", content, ...(restricted === undefined ? {} : { restricted }) });
const a = (content: string, restricted?: boolean): Row => ({ role: "assistant", content, ...(restricted === undefined ? {} : { restricted }) });
const texts = (rows: ReadonlyArray<{ content: string }>): string[] => rows.map((r) => r.content);

// En tekst UTEN noe stikkord (klassifiseres PUBLIC) - nettopp det et lokalt svar fra en låst tur ofte ser ut som.
const NEUTRAL = "Det er 45 000 igjen.";
const CLEAN = (n: number): string => `ren melding ${n}`;

describe("forutsetning: teksten alene er ufarlig (ellers ville testene under bevist for lite)", () => {
  it("de nøytrale tekstene klassifiseres som PUBLIC, mens finansordet gjør det SECRET_RESTRICTED", () => {
    expect(level(NEUTRAL)).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    expect(level(CLEAN(1))).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    expect(level("Saldoen min er 45 000 kr")).toBe("SECRET_RESTRICTED");
  });
});

describe("partitionHistoryBySensitivity: merket rad = SECRET_RESTRICTED uansett tekst", () => {
  it("en ELDRE merket rad uten stikkord holdes utenfor (sammen med paret), mens den samme raden uten merke beholdes", () => {
    const rows = (restricted: boolean | undefined): Row[] => [u("hva er status på lånet", restricted), a(NEUTRAL, restricted), u(CLEAN(1)), a(CLEAN(2)), u(CLEAN(3)), a(CLEAN(4)), u(CLEAN(5))];
    const marked = partitionHistoryBySensitivity(rows(true), "PUBLIC_OR_LOW_SENSITIVITY");
    expect(marked.withheld).toBe(2);
    expect(texts(marked.kept)).toEqual([CLEAN(1), CLEAN(2), CLEAN(3), CLEAN(4), CLEAN(5)]);
    // uten merke: «lånet» er ellers følsomt, så bruk en helt nøytral første melding som kontroll
    const neutral = [u("hei på deg"), a(NEUTRAL), u(CLEAN(1)), a(CLEAN(2)), u(CLEAN(3)), a(CLEAN(4)), u(CLEAN(5))];
    expect(partitionHistoryBySensitivity(neutral, "PUBLIC_OR_LOW_SENSITIVITY").withheld).toBe(0);
    const neutralMarked = neutral.map((m, i) => (i < 2 ? { ...m, restricted: true } : m));
    const out = partitionHistoryBySensitivity(neutralMarked, "PUBLIC_OR_LOW_SENSITIVITY");
    expect(out.withheld).toBe(2);
    expect(texts(out.kept)).toEqual([CLEAN(1), CLEAN(2), CLEAN(3), CLEAN(4), CLEAN(5)]);
  });

  it("par-regelen gjelder begge veier: et merket SVAR tar spørsmålet rett foran med, et merket SPØRSMÅL tar svaret rett etter med", () => {
    const answerMarked = [u("hva er klokka"), u("og i morgen?"), a(NEUTRAL, true), u(CLEAN(1)), a(CLEAN(2)), u(CLEAN(3)), a(CLEAN(4)), u(CLEAN(5))];
    const outA = partitionHistoryBySensitivity(answerMarked, "PUBLIC_OR_LOW_SENSITIVITY");
    expect(texts(outA.kept)).not.toContain(NEUTRAL);
    expect(texts(outA.kept)).not.toContain("og i morgen?");
    expect(outA.withheld).toBe(2);
    const questionMarked = [u("hva ble det av det", true), a(NEUTRAL), u(CLEAN(1)), a(CLEAN(2)), u(CLEAN(3)), a(CLEAN(4)), u(CLEAN(5))];
    const outQ = partitionHistoryBySensitivity(questionMarked, "PUBLIC_OR_LOW_SENSITIVITY");
    expect(texts(outQ.kept)).not.toContain("hva ble det av det");
    expect(texts(outQ.kept)).not.toContain(NEUTRAL);
    expect(outQ.withheld).toBe(2);
  });

  it("en merket rad i det NYLIGE vinduet (de fire siste) beholdes som før (oppfølgingsspørsmål trenger konteksten) - motoren løfter turen i stedet", () => {
    const rows = [u(CLEAN(1)), a(CLEAN(2)), u("hva ble det av det", true), a(NEUTRAL, true), u(CLEAN(3))];
    const out = partitionHistoryBySensitivity(rows, "PUBLIC_OR_LOW_SENSITIVITY");
    expect(out.withheld).toBe(0);
    expect(out.kept).toHaveLength(5);
    expect(out.kept.filter((m) => m.restricted === true)).toHaveLength(2);
  });

  it("taket SECRET_RESTRICTED (turen er allerede låst) holder ingenting utenfor, heller ikke merkede rader", () => {
    const rows = [u("hva ble det av det", true), a(NEUTRAL, true), u(CLEAN(1)), a(CLEAN(2)), u(CLEAN(3)), a(CLEAN(4)), u(CLEAN(5))];
    expect(partitionHistoryBySensitivity(rows, "SECRET_RESTRICTED").withheld).toBe(0);
    expect(partitionHistoryBySensitivity(rows, "BUSINESS_CONFIDENTIAL").withheld).toBe(2);
    expect(partitionHistoryBySensitivity(rows, "PRIVATE").withheld).toBe(2);
  });

  it("bare EKSAKT `true` er et merke: false, undefined, strengen «true», tallet 1 og null klassifiseres etter teksten", () => {
    for (const value of [false, undefined, "true", 1, null, "yes", {}]) {
      const rows = [{ role: "user", content: "hei på deg", restricted: value }, { role: "assistant", content: NEUTRAL, restricted: value }, u(CLEAN(1)), a(CLEAN(2)), u(CLEAN(3)), a(CLEAN(4)), u(CLEAN(5))];
      expect(partitionHistoryBySensitivity(rows as unknown as Row[], "PUBLIC_OR_LOW_SENSITIVITY").withheld, String(value)).toBe(0);
    }
  });

  it("rekkefølgen på de som beholdes er uendret, og et tilpasset vindu (recentWindow) respekteres for merkede rader", () => {
    const rows = [u(CLEAN(0)), u("x", true), a("y"), u(CLEAN(3)), a(CLEAN(4)), u(CLEAN(5))];
    // vindu 2: rad 1 og 2 er utenfor vinduet (indeks < 4) -> paret holdes utenfor
    expect(texts(partitionHistoryBySensitivity(rows, "PUBLIC_OR_LOW_SENSITIVITY", 2).kept)).toEqual([CLEAN(0), CLEAN(3), CLEAN(4), CLEAN(5)]);
    // vindu 6: alle er innenfor vinduet -> ingenting holdes utenfor
    expect(partitionHistoryBySensitivity(rows, "PUBLIC_OR_LOW_SENSITIVITY", 6).withheld).toBe(0);
  });
});

describe("withholdSensitiveMessages: merket rad er direkte følsom (par, hale og protect uendret)", () => {
  it("en merket melding uten stikkord holdes utenfor sammen med paret, og de øvrige beholdes i uendret rekkefølge", () => {
    const rows = [u(CLEAN(1)), a(CLEAN(2)), u("hva ble det av det", true), a(NEUTRAL, true), u(CLEAN(3)), a(CLEAN(4))];
    const out = withholdSensitiveMessages(rows);
    // merket spørsmål + merket svar, og halen (alt etter den første merkede i det nylige vinduet) holdes også utenfor
    expect(texts(out.withheld)).toEqual(["hva ble det av det", NEUTRAL, CLEAN(3), CLEAN(4)]);
    expect(texts(out.kept)).toEqual([CLEAN(1), CLEAN(2)]);
  });

  it("HALEN gjelder uendret: en nøytral oppfølging ETTER en nylig merket rad holdes også utenfor - men aldri det `protect` peker ut", () => {
    const own = u(CLEAN(9));
    const rows = [u(CLEAN(1)), a(CLEAN(2)), u(CLEAN(8)), a(NEUTRAL, true), u(CLEAN(3)), own];
    const out = withholdSensitiveMessages(rows, { protect: (m) => m === own });
    expect(texts(out.kept)).toEqual([CLEAN(1), CLEAN(2), CLEAN(9)]);
    expect(texts(out.withheld)).toEqual([CLEAN(8), NEUTRAL, CLEAN(3)]); // paret (CLEAN(8)) og halen (CLEAN(3))
    // uten protect tas også den egne meldingen av halen
    expect(texts(withholdSensitiveMessages(rows).kept)).toEqual([CLEAN(1), CLEAN(2)]);
  });

  it("`protect` beskytter mot halen men IKKE mot paret: et nøytralt spørsmål rett foran et merket svar parer seg bort selv om det er beskyttet", () => {
    const own = u(CLEAN(9));
    const rows = [u(CLEAN(1)), own, a(NEUTRAL, true)];
    const out = withholdSensitiveMessages(rows, { protect: (m) => m === own });
    expect(out.withheld).toContain(own); // kalleren (cloudVariantFor) ser det og lar turen forbli lokal
    expect(texts(out.withheld)).toEqual([CLEAN(9), NEUTRAL]);
  });

  it("en merket rad UTENFOR det nylige vinduet utløser ingen hale (som for tekst), men selve raden og paret holdes utenfor", () => {
    const rows = [u("hva ble det av det", true), a(NEUTRAL, true), u(CLEAN(1)), a(CLEAN(2)), u(CLEAN(3)), a(CLEAN(4)), u(CLEAN(5))];
    const out = withholdSensitiveMessages(rows);
    expect(texts(out.withheld)).toEqual(["hva ble det av det", NEUTRAL]);
    expect(out.kept).toHaveLength(5);
  });

  it("taket (`ceiling`): SECRET_RESTRICTED holder ingenting utenfor, lavere tak holder merkede rader utenfor", () => {
    const rows = [u("hva ble det av det", true), a(NEUTRAL, true), u(CLEAN(1))];
    expect(withholdSensitiveMessages(rows, { ceiling: "SECRET_RESTRICTED" }).withheld).toEqual([]);
    expect(withholdSensitiveMessages(rows, { ceiling: "PRIVATE" }).withheld).toHaveLength(3);
    expect(withholdSensitiveMessages(rows, { ceiling: "PUBLIC_OR_LOW_SENSITIVITY" }).withheld.length).toBeGreaterThan(0);
  });

  it("bare EKSAKT `true` er et merke (som for partisjoneringen)", () => {
    for (const value of [false, undefined, "true", 1, null]) {
      const rows = [{ role: "user", content: "hei på deg", restricted: value }, { role: "assistant", content: NEUTRAL, restricted: value }, u(CLEAN(1))];
      expect(withholdSensitiveMessages(rows as unknown as Row[]).withheld, String(value)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Orakel: algoritmene slik de står på origin/main (kun klassifiseringen er den levende `classifyContentSensitivity`)
// ---------------------------------------------------------------------------------------------------------------------
const RECENT_WINDOW = 4;
function oraclePartition<T extends { content: string; role?: string }>(history: ReadonlyArray<T>, ceiling: DataSensitivity, recentWindow: number = RECENT_WINDOW): { kept: T[]; withheld: number } {
  const cutoff = Math.max(0, history.length - recentWindow);
  const drop = history.map((message, index) => index < cutoff && RANK[level(message.content)] > RANK[ceiling]);
  const direct = [...drop];
  direct.forEach((isDirect, index) => {
    if (!isDirect) return;
    const role = history[index]!.role;
    if (role === "user" && history[index + 1]?.role === "assistant") drop[index + 1] = true;
    if (role === "assistant" && history[index - 1]?.role === "user") drop[index - 1] = true;
  });
  const kept: T[] = [];
  let withheld = 0;
  history.forEach((message, index) => {
    if (drop[index]) withheld += 1;
    else kept.push(message);
  });
  return { kept, withheld };
}
function oracleWithhold<T extends { role: string; content: string }>(
  messages: ReadonlyArray<T>,
  options: { ceiling?: DataSensitivity; recentWindow?: number; protect?: (message: T, index: number) => boolean } = {}
): { kept: T[]; withheld: T[] } {
  const ceiling = options.ceiling ?? "BUSINESS_CONFIDENTIAL";
  const recentWindow = options.recentWindow ?? RECENT_WINDOW;
  const direct = messages.map((message) => RANK[level(message.content)] > RANK[ceiling]);
  const drop = [...direct];
  direct.forEach((isDirect, index) => {
    if (!isDirect) return;
    const role = messages[index]!.role;
    if (role === "user" && messages[index + 1]?.role === "assistant") drop[index + 1] = true;
    if (role === "assistant" && messages[index - 1]?.role === "user") drop[index - 1] = true;
  });
  const cutoff = Math.max(0, messages.length - recentWindow);
  const firstRecent = direct.findIndex((isDirect, index) => index >= cutoff && isDirect);
  if (firstRecent >= 0) {
    for (let index = firstRecent + 1; index < messages.length; index += 1) {
      if (!(options.protect?.(messages[index]!, index) ?? false)) drop[index] = true;
    }
  }
  const kept: T[] = [];
  const withheld: T[] = [];
  messages.forEach((message, index) => (drop[index] ? withheld : kept).push(message));
  return { kept, withheld };
}

/** Deterministisk PRNG (mulberry32) så en feil kan gjengis. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const POOL: readonly string[] = [
  "hva er klokka", "Den er ti.", NEUTRAL, "takk for hjelpen", "hei på deg", "Det er notert.", "skriv en kort e-post til naboen", "Saldoen min er 45 000 kr", "Lønnen min kom i dag", "Jeg har diabetes",
  "Det er kronisk, jeg tar Metformin", "list åpne PR-er", "møtet er flyttet til fredag", "kontrakten er signert", "passordet mitt er hemmelig", "regningen kommer i morgen", "da må jeg vente med bilen",
  "Lånet ditt er på 2 mill.", "ok", "hva heter hunden til naboen", "legen ringte i dag", "fint vær i dag"
];
function randomHistory(next: () => number): Array<{ role: "user" | "assistant"; content: string }> {
  const n = Math.floor(next() * 11); // 0..10 meldinger
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = 0; i < n; i += 1) out.push({ role: next() < 0.5 ? "user" : "assistant", content: POOL[Math.floor(next() * POOL.length)]! });
  return out;
}
const CEILINGS: readonly DataSensitivity[] = ["PUBLIC_OR_LOW_SENSITIVITY", "PRIVATE", "BUSINESS_CONFIDENTIAL", "SECRET_RESTRICTED"];

describe("differensial mot origin/main-algoritmen: uten merking er oppførselen BIT-FOR-BIT den gamle", () => {
  const next = prng(20261122);
  const histories = Array.from({ length: 3000 }, () => randomHistory(next));

  it("partitionHistoryBySensitivity: 3000 tilfeldige historikker x 4 tak x 3 vinduer = identisk med orakelet (også med `restricted: false`/`undefined` på radene)", () => {
    let compared = 0;
    for (const history of histories) {
      for (const ceiling of CEILINGS) {
        for (const window of [2, 4, 8]) {
          const want = oraclePartition(history, ceiling, window);
          for (const variant of [history, history.map((m) => ({ ...m, restricted: false })), history.map((m) => ({ ...m, restricted: undefined }))]) {
            const got = partitionHistoryBySensitivity(variant, ceiling, window);
            expect(got.withheld).toBe(want.withheld);
            expect(texts(got.kept)).toEqual(texts(want.kept));
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(3000 * 4 * 3 * 3);
  });

  it("withholdSensitiveMessages: 3000 tilfeldige historikker x 3 tak x 3 vinduer, med og uten protect = identisk med orakelet", () => {
    for (const history of histories) {
      for (const ceiling of ["PUBLIC_OR_LOW_SENSITIVITY", "PRIVATE", "BUSINESS_CONFIDENTIAL"] as const) {
        for (const recentWindow of [2, 4, 8]) {
          const protectLast = (m: unknown): boolean => m === history[history.length - 1];
          for (const protect of [undefined, protectLast]) {
            const opts = { ceiling, recentWindow, ...(protect ? { protect } : {}) };
            const want = oracleWithhold(history, opts);
            for (const variant of [history, history.map((m) => ({ ...m, restricted: false }))]) {
              const optsV = { ceiling, recentWindow, ...(protect ? { protect: (m: unknown) => m === variant[variant.length - 1] } : {}) };
              const got = withholdSensitiveMessages(variant, optsV);
              expect(texts(got.kept)).toEqual(texts(want.kept));
              expect(texts(got.withheld)).toEqual(texts(want.withheld));
            }
          }
        }
      }
    }
  });
});

describe("«merket = følsom tekst»: en merket rad oppfører seg NØYAKTIG som om teksten var SECRET_RESTRICTED", () => {
  const next = prng(1337);
  const histories = Array.from({ length: 2000 }, () => randomHistory(next));
  /** Merk et tilfeldig utvalg rader; orakelet får i stedet en tekst som SIKKERT er SECRET_RESTRICTED på de samme radene. */
  function mark(history: Array<{ role: "user" | "assistant"; content: string }>, nextBit: () => number): { marked: Row[]; swapped: Row[] } {
    const flags = history.map(() => nextBit() < 0.3);
    return {
      marked: history.map((m, i) => (flags[i] ? { ...m, restricted: true } : { ...m })),
      swapped: history.map((m, i) => (flags[i] ? { ...m, content: "Saldoen min er 45 000 kr" } : { ...m }))
    };
  }

  it("partitionHistoryBySensitivity: samme antall holdt utenfor og samme rader beholdt (på posisjon) som for sensitiv tekst", () => {
    const bit = prng(7);
    for (const history of histories) {
      const { marked, swapped } = mark(history, bit);
      for (const ceiling of CEILINGS) {
        const got = partitionHistoryBySensitivity(marked, ceiling);
        const want = partitionHistoryBySensitivity(swapped, ceiling);
        expect(got.withheld).toBe(want.withheld);
        expect(got.kept.map((m) => marked.indexOf(m))).toEqual(want.kept.map((m) => swapped.indexOf(m)));
      }
    }
  });

  it("withholdSensitiveMessages (med og uten protect): samme rader holdt utenfor og beholdt (på posisjon)", () => {
    const bit = prng(99);
    for (const history of histories) {
      const { marked, swapped } = mark(history, bit);
      for (const ceiling of ["PUBLIC_OR_LOW_SENSITIVITY", "PRIVATE", "BUSINESS_CONFIDENTIAL", "SECRET_RESTRICTED"] as const) {
        for (const useProtect of [false, true]) {
          const got = withholdSensitiveMessages(marked, { ceiling, ...(useProtect ? { protect: (m: Row) => m === marked[marked.length - 1] } : {}) });
          const want = withholdSensitiveMessages(swapped, { ceiling, ...(useProtect ? { protect: (m: Row) => m === swapped[swapped.length - 1] } : {}) });
          expect(got.withheld.map((m) => marked.indexOf(m))).toEqual(want.withheld.map((m) => swapped.indexOf(m)));
          expect(got.kept.map((m) => marked.indexOf(m))).toEqual(want.kept.map((m) => swapped.indexOf(m)));
        }
      }
    }
  });
});
