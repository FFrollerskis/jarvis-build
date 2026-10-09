import { describe, expect, it } from "vitest";
import { withholdSensitiveMessages } from "../src/content-sensitivity.ts";

/**
 * Gjennomgang av WP-A (D-451, funn 1): `withholdSensitiveMessages` holdt bare den følsomme meldingen og én nabo utenfor; en oppfølging uten stikkord («Det er kronisk, jeg tar Metformin», «da må jeg vente med
 * bilen til bonusen kommer») gikk dermed til skyen. Nå holdes HELE halen fra den første følsomme meldingen i det nylige vinduet utenfor (unntatt det som er `protect`-et), pluss par og eldre følsomme meldinger.
 */
type Msg = { role: "user" | "assistant"; content: string };
const u = (content: string): Msg => ({ role: "user", content });
const a = (content: string): Msg => ({ role: "assistant", content });
const texts = (messages: Msg[]): string[] => messages.map((m) => m.content);

describe("withholdSensitiveMessages: halen", () => {
  it("ingen følsomme meldinger → ingenting holdes utenfor", () => {
    const messages = [u("hei"), a("hei på deg"), u("hva er klokka"), a("ti")];
    const out = withholdSensitiveMessages(messages);
    expect(out.withheld).toEqual([]);
    expect(out.kept).toEqual(messages);
  });

  it("en følsom melding i det nylige vinduet tar med ALT etter den, også usensitive meldinger", () => {
    const messages = [u("hei"), a("hei"), u("Saldoen min er 45 000 kr"), a("Notert."), u("takk"), a("bare hyggelig")];
    const out = withholdSensitiveMessages(messages);
    expect(texts(out.kept)).toEqual(["hei", "hei"]);
    expect(texts(out.withheld)).toEqual(["Saldoen min er 45 000 kr", "Notert.", "takk", "bare hyggelig"]);
  });

  it("et følsomt SVAR tar med spørsmålet rett foran (par) og alt etter", () => {
    const messages = [u("a"), a("b"), u("hvordan ligger jeg an"), a("Lånet ditt er på 2 mill."), u("uff"), a("skjønner")];
    const out = withholdSensitiveMessages(messages);
    expect(texts(out.kept)).toEqual(["a", "b"]);
  });

  it("en følsom melding UTENFOR det nylige vinduet fjernes med paret sitt, men får ingen hale", () => {
    const messages = [u("hei"), a("hei"), u("Saldoen min er 45 000 kr"), a("Du har 45 000 igjen."), u("a"), a("b"), u("c"), a("d")];
    const out = withholdSensitiveMessages(messages);
    expect(texts(out.withheld)).toEqual(["Saldoen min er 45 000 kr", "Du har 45 000 igjen."]);
    expect(texts(out.kept)).toEqual(["hei", "hei", "a", "b", "c", "d"]);
  });

  it("vinduet styres av recentWindow: en følsom melding akkurat utenfor vinduet får ikke hale, akkurat innenfor får den", () => {
    const messages = [u("Saldoen min er 45 000 kr"), a("ok"), u("x"), a("y"), u("z")];
    expect(texts(withholdSensitiveMessages(messages, { recentWindow: 4 }).kept)).toEqual(["x", "y", "z"]); // rad 0 er utenfor vinduet (4 siste) → kun paret
    expect(texts(withholdSensitiveMessages(messages, { recentWindow: 5 }).kept)).toEqual([]); // rad 0 er innenfor → hele halen
  });

  it("`protect` beskytter eierens nåværende melding mot halen, men en bortparet melding vises fortsatt i withheld (kalleren stopper da)", () => {
    const own = u("list PR-er");
    const messages = [u("Saldoen min er 45 000 kr"), a("ok"), own, a("Lånet er på 2 mill.")];
    const out = withholdSensitiveMessages(messages, { protect: (m) => m === own });
    expect(out.kept).toEqual([]); // halen tok alt unntatt `own`... men `own` pares bort av det følsomme svaret rett etter
    expect(out.withheld).toContain(own);
    const out2 = withholdSensitiveMessages([u("Saldoen min er 45 000 kr"), a("ok"), own], { protect: (m) => m === own });
    expect(out2.kept).toEqual([own]);
    expect(texts(out2.withheld)).toEqual(["Saldoen min er 45 000 kr", "ok"]);
  });

  it("ceiling: kun meldinger strengere enn taket regnes (standard BUSINESS_CONFIDENTIAL → en PRIVAT melding holdes ikke utenfor)", () => {
    const messages = [u("Faktura fra Elkem kommer i morgen"), a("ok"), u("hei")];
    expect(withholdSensitiveMessages(messages).withheld).toEqual([]);
    expect(withholdSensitiveMessages(messages, { ceiling: "PUBLIC_OR_LOW_SENSITIVITY" }).withheld.length).toBeGreaterThan(0);
  });

  it("rekkefølgen på de som beholdes er uendret, og ingen melding går tapt eller dupliseres", () => {
    const messages = [u("1"), a("2"), u("3"), a("4"), u("Jeg har ADHD"), a("6"), u("7")];
    const out = withholdSensitiveMessages(messages);
    expect([...out.kept, ...out.withheld].sort((x, y) => x.content.localeCompare(y.content))).toEqual([...messages].sort((x, y) => x.content.localeCompare(y.content)));
    expect(texts(out.kept)).toEqual(["1", "2", "3", "4"]);
  });
});
