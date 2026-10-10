import { describe, expect, it } from "vitest";
import { containsHiddenCharacters, sanitizeDisplayText, sanitizeParameterValue, scanForSecrets } from "../src/index.ts";

/**
 * WP-D4 (gjennomgang av PR #315, M4): rådets visningstekst er modellskrevet og vises til eieren rett før han godkjenner en handling. Reviewerens eksempler (bidi, nullbredde, markdown, HTML) og en deterministisk fuzz på Unicode:
 * resultatet er alltid ren, velformet tekst innenfor grensen, og renseren er idempotent (rådet og porten renser begge, og de må gi samme tekst).
 */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const BIDI = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c].map((c) => cp(c));
const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e].map((c) => cp(c));
const TAGS = [0xe0001, 0xe0020, 0xe0041, 0xe007f].map((c) => cp(c));
const MARKUP = "[]()<>`*_#!|\\".split("");
const ANY_HIDDEN = /[\p{C}\p{Zl}\p{Zp}]/u;
const MARKUP_RE = /[[\]()<>`*_#!|\\]/;
/** Velformet UTF-16 (ingen løse surrogater): rundtur gjennom UTF-8 gir samme streng. */
const wellFormed = (text: string): boolean => Buffer.from(text, "utf8").toString("utf8") === text;

describe("reviewerens eksempler", () => {
  it("bidi-overstyring og isolater (U+202E, U+2066-2069) fjernes - teksten kan ikke snus visuelt", () => {
    const evil = `Sender til anna${cp(0x202e)}moc.liamg@x${cp(0x202c)} og ${cp(0x2066)}skjult${cp(0x2069)}`;
    const out = sanitizeDisplayText(evil, 300);
    expect(out).toBe("Sender til annamoc.liamg@x og skjult");
    expect(ANY_HIDDEN.test(out)).toBe(false);
  });

  it("nullbredde (U+200B) og tag-tegn fjernes (kan ikke skjule tekst eller smugle instruksjoner)", () => {
    expect(sanitizeDisplayText(`He${cp(0x200b)}llo${cp(0xe0041, 0xe0042)} verden`, 50)).toBe("Hello verden");
  });

  it("nullbredde inni en hemmelighet hjelper ikke: skanneren ser det som vises", () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const hidden = token.split("").join(cp(0x200b));
    const out = sanitizeDisplayText(`nøkkel ${hidden} slutt`, 300);
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("a1B2c3D4e5");
    expect(scanForSecrets(out).findings).toHaveLength(0);
    expect(out).toBe("nøkkel REDACTED slutt");
  });

  it("markdown-lenke, bilde og rå HTML blir ren tekst uten lenke-/bilde-/HTML-tegn og uten URL", () => {
    const cases = [
      "[trykk her](https://evil.example/login)",
      "![x](http://evil.example/p.png)",
      "<img src=x onerror=alert(1)>",
      "<a href=\"https://evil.example\">godkjenn</a>",
      "<script>fetch('//evil.example')</script>",
      "`rm -rf /` **fet** _kursiv_ # overskrift | tabell |",
      "www.evil.example/phish",
      "javascript:alert(1) via https://evil.example"
    ];
    for (const evil of cases) {
      const out = sanitizeDisplayText(evil, 300);
      expect(MARKUP_RE.test(out), evil).toBe(false);
      expect(out, evil).not.toMatch(/https?:\/\//i);
      expect(out, evil).not.toMatch(/www\./i);
      expect(ANY_HIDDEN.test(out), evil).toBe(false);
    }
    expect(sanitizeDisplayText("[trykk her](https://evil.example/login)", 300)).toBe("trykk her lenke-fjernet");
    expect(sanitizeDisplayText("<img src=x onerror=alert(1)>", 300)).toBe("img src=x onerror=alert 1");
  });

  it("HTML-entiteter nøytraliseres (de kan dekodes til tegn rensingen nettopp fjernet)", () => {
    const out = sanitizeDisplayText("&lt;script&gt; &#60;b&#62; &#x3c;i&#x3e; Smith & Wesson, R&D", 300);
    expect(out).not.toContain("&lt;");
    expect(out).not.toContain("&#");
    expect(out).toContain("Smith & Wesson, R&D"); // et vanlig «&» er uskyldig og beholdes
  });

  it("vanlig norsk tekst er uendret (æøå, tall, tegnsetting, tankestrek) - kun markup-tegnene er borte", () => {
    const text = "Oppretter en oppgave: «Ring leverandøren» – frist 12.10.2026 kl. 14:30, beløp 1 500 kr (ca. 15 % av budsjettet) for Ærlig Åse Ødegård";
    expect(sanitizeDisplayText(text, 300)).toBe(text.replace("(", " ").replace(")", " ").replace(/\s+/g, " "));
  });
});

describe("normalisering, grenser og kappelogikk", () => {
  it("fullbredde-, ligatur- og kompatibilitetstegn faller til vanlig form (NFKC), og komponerte/dekomponerte æøå gir samme tekst", () => {
    expect(sanitizeDisplayText("［ｔｒｙｋｋ］ ｆｕｌｌｂｒｅｄｄｅ ﬁnn ²", 100)).toBe("trykk fullbredde finn 2");
    expect(sanitizeDisplayText("å", 10)).toBe("å");
    expect(sanitizeDisplayText("Å", 10)).toBe("Å");
  });

  it("linje-/avsnittsskilletegn, NEL, TAB, LF, CR og alle mellomrom blir ETT mellomrom", () => {
    const seps = [cp(0x2028), cp(0x2029), cp(0x0085), "\t", "\n", "\r\n", "\v", "\f", cp(0x00a0), cp(0x3000), cp(0x2003)];
    expect(sanitizeDisplayText(seps.map((s) => `a${s}b`).join(" "), 100)).toBe("a b ".repeat(seps.length).trim());
  });

  it("kontrolltegn (NUL, ESC, DEL, C1) og private-bruk-tegn er borte", () => {
    expect(sanitizeDisplayText(`a${cp(0, 1, 0x1b, 0x7f, 0x80, 0x9f, 0xe000, 0xf8ff)}b`, 10)).toBe("ab");
  });

  it("rekker av kombinerende tegn (zalgo) kappes til to, og kombinerende tegn uten grunntegn følger ikke med", () => {
    const zalgo = `a${cp(0x300, 0x301, 0x302, 0x303, 0x304, 0x305, 0x306)}b`;
    const out = sanitizeDisplayText(zalgo, 50);
    expect(out).not.toMatch(/\p{M}{3}/u);
    expect(out.startsWith("à")).toBe(true); // grunntegnet og første aksent komponeres (NFKC); resten av rekka er kappet
    expect(sanitizeDisplayText(`${cp(0x301)}hei ${cp(0x302, 0x303)}verden`, 50)).toBe("hei verden");
  });

  it("kappes på KODEPUNKTGRENSE med «…» (aldri midt i et surrogatpar) og aldri over grensen", () => {
    const emoji = "😀".repeat(40);
    const out = sanitizeDisplayText(emoji, 11);
    expect(Array.from(out)).toHaveLength(11);
    expect(out.endsWith("…")).toBe(true);
    expect(wellFormed(out)).toBe(true);
    expect(sanitizeDisplayText("abcdefghij", 10)).toBe("abcdefghij");
    expect(sanitizeDisplayText("abcdefghijk", 10)).toBe("abcdefghi…");
    expect(sanitizeDisplayText("x".repeat(100_000), 300)).toHaveLength(300);
  });

  it("løse surrogater fjernes (Postgres jsonb ville avvist dem) og resultatet overlever JSON- og UTF-8-rundtur", () => {
    const out = sanitizeDisplayText(`a${String.fromCharCode(0xd83d)}b${String.fromCharCode(0xde00)}c`, 20);
    expect(out).toBe("abc");
    expect(JSON.parse(JSON.stringify({ out })).out).toBe(out);
  });

  it("ikke-strenger og ugyldig grense gir tom streng", () => {
    for (const bad of [5, undefined, null, {}, [], true]) expect(sanitizeDisplayText(bad, 10)).toBe("");
    expect(sanitizeDisplayText("abc", 0)).toBe("");
    expect(sanitizeDisplayText("abc", -1)).toBe("");
    expect(sanitizeDisplayText("abc", Number.NaN)).toBe("");
  });

  it("lenker fjernes bare som URL-er: «f.eks.», filnavn og klokkeslett røres ikke", () => {
    expect(sanitizeDisplayText("f.eks. rapport.pdf kl. 14.30 og a.b", 100)).toBe("f.eks. rapport.pdf kl. 14.30 og a.b");
  });
});

describe("sanitizeParameterValue - verdier som er del av selve handlingen", () => {
  it("beholder URL, understrek og hash (det er verdien som utføres), men fjerner lenke-/bilde-/HTML-tegn", () => {
    expect(sanitizeParameterValue("https://example.com/my_file#a", 100)).toBe("https://example.com/my_file#a");
    expect(sanitizeParameterValue("[x](http://evil/p.png) <b>fet</b> `kode`", 100)).toBe("x http://evil/p.png b fet /b kode");
    expect(sanitizeParameterValue("repo_name", 100)).toBe("repo_name");
  });
  it("kapper på kodepunktgrense og normaliserer mellomrom; ikke-strenger gir tom streng", () => {
    expect(sanitizeParameterValue("a\n\n  b", 10)).toBe("a b");
    expect(Array.from(sanitizeParameterValue("😀".repeat(30), 5))).toHaveLength(5);
    expect(sanitizeParameterValue(42, 10)).toBe("");
  });
  it("redigerer hemmeligheter", () => {
    expect(sanitizeParameterValue(`token ghp_${"a1B2c3D4e5".repeat(4)}`, 200)).not.toContain("ghp_");
  });
});

describe("containsHiddenCharacters - parametere med usynlige tegn avvises, de renses ikke", () => {
  it.each([
    ["bidi-overstyring", `alice${cp(0x202e)}@example.com`],
    ["bidi-isolat", `${cp(0x2066)}x${cp(0x2069)}`],
    ["nullbredde", `a${cp(0x200b)}b`],
    ["ZWJ", `a${cp(0x200d)}b`],
    ["tag-tegn", `a${cp(0xe0041)}b`],
    ["NUL", "a\u0000b"],
    ["ESC", "a\u001bb"],
    ["DEL", "a\u007fb"],
    ["C1-kontroll", `a${cp(0x85)}b`],
    ["linjeskilletegn", `a${cp(0x2028)}b`],
    ["avsnittsskilletegn", `a${cp(0x2029)}b`],
    ["løst surrogat", `a${String.fromCharCode(0xd800)}b`],
    ["private-bruk", `a${cp(0xe000)}b`]
  ])("%s i en streng", (_label, value) => {
    expect(containsHiddenCharacters(value)).toBe(true);
    expect(containsHiddenCharacters({ to: value })).toBe(true);
    expect(containsHiddenCharacters({ nested: { list: [1, value] } })).toBe(true);
  });
  it("også i nøkler", () => {
    expect(containsHiddenCharacters({ [`k${cp(0x200b)}ey`]: "ok" })).toBe(true);
  });
  it("vanlig innhold passerer: æøå, emoji (uten ZWJ), TAB/LF/CR i lengre tekst, tall, null, boolske", () => {
    expect(containsHiddenCharacters({ to: "anna@firma.no", body: "Hei Åse,\n\tTakk 😀\r\n– Tobias", n: 5, b: false, z: null, list: ["æ", "ø", "å"] })).toBe(false);
  });
  it("for dyp eller for stor struktur regnes som skjult (fail-closed)", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 20; i++) deep = { a: deep };
    expect(containsHiddenCharacters(deep)).toBe(true);
    expect(containsHiddenCharacters(Array.from({ length: 2500 }, (_, i) => i))).toBe(true);
  });
});

// --- fuzz ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ATOMS: string[] = [
  ..."abcdefghijklmnopqrstuvwxyzÆØÅæøå0123456789 .,:;-/=@&%",
  ...MARKUP, ...BIDI, ...ZERO_WIDTH, ...TAGS,
  cp(0x300), cp(0x301), cp(0x302), cp(0x20d0), cp(0xfe0f), cp(0xe0100),
  String.fromCharCode(0xd800), String.fromCharCode(0xdc00), String.fromCharCode(0xdbff), String.fromCharCode(0xdfff),
  "😀", "👨‍👩‍👧", "𝔘", cp(0x10ffff), cp(0xe000), cp(0xf8ff),
  "\u0000", "\u0001", "\u001b", "\u007f", cp(0x80), cp(0x85), cp(0x9f), "\t", "\n", "\r", cp(0x2028), cp(0x2029), cp(0xa0), cp(0x3000),
  "［", "］", "（", "）", "＜", "＞", "ｈｔｔｐ", "ﬁ", "㌀", "﷽",
  "http://", "https://evil.example/x", "www.evil.example", "ftp://x", "javascript:", "&lt;", "&#60;", "&#x3c;", "&amp;",
  "ghp_", "a1B2c3D4e5", "sk-", "AKIA", "Bearer "
];
function fuzzString(next: () => number): string {
  const n = Math.floor(next() * 80);
  let s = "";
  for (let i = 0; i < n; i++) s += ATOMS[Math.floor(next() * ATOMS.length)] as string;
  return s;
}

describe("fuzz (Unicode: bidi, nullbredde, kombinerende tegn, surrogater, markup, lenker)", () => {
  it("sanitizeDisplayText: 4000 tilfeldige strenger - ren, velformet, innenfor grensen og idempotent", () => {
    const next = rng(20261009);
    for (let i = 0; i < 4000; i++) {
      const raw = fuzzString(next);
      const max = 1 + Math.floor(next() * 120);
      const out = sanitizeDisplayText(raw, max);
      const ctx = JSON.stringify({ i, max, raw: raw.slice(0, 120) });
      expect(Array.from(out).length, ctx).toBeLessThanOrEqual(max);
      expect(ANY_HIDDEN.test(out), ctx).toBe(false);
      expect(MARKUP_RE.test(out), ctx).toBe(false);
      expect(wellFormed(out), ctx).toBe(true);
      expect(out, ctx).toBe(out.trim());
      expect(out, ctx).not.toMatch(/\s{2,}/);
      expect(out, ctx).not.toMatch(/https?:\/\/|www\./i);
      expect(out, ctx).not.toMatch(/&(?=#?\w{1,12};)/);
      expect(out, ctx).not.toMatch(/\p{M}{3}/u);
      expect(JSON.parse(JSON.stringify({ out })).out, ctx).toBe(out);
      expect(Buffer.from(out, "utf8").toString("utf8"), ctx).toBe(out);
      expect(sanitizeDisplayText(out, max), ctx).toBe(out); // rådet og porten renser begge - samme tekst
    }
  });

  it("sanitizeParameterValue: 3000 tilfeldige strenger - ingen lenke-/bilde-/HTML-tegn, ingen usynlige tegn, velformet, innenfor grensen, idempotent", () => {
    const next = rng(7);
    for (let i = 0; i < 3000; i++) {
      const raw = fuzzString(next);
      const max = 1 + Math.floor(next() * 150);
      const out = sanitizeParameterValue(raw, max);
      const ctx = JSON.stringify({ i, max, raw: raw.slice(0, 120) });
      expect(Array.from(out).length, ctx).toBeLessThanOrEqual(max);
      expect(ANY_HIDDEN.test(out), ctx).toBe(false);
      expect(/[[\]()<>`]/.test(out), ctx).toBe(false);
      expect(wellFormed(out), ctx).toBe(true);
      expect(sanitizeParameterValue(out, max), ctx).toBe(out);
    }
  });

  it("containsHiddenCharacters er sann for HVER streng som inneholder minst ett usynlig tegn, og usann når alle er fjernet", () => {
    const next = rng(99);
    for (let i = 0; i < 2000; i++) {
      const raw = fuzzString(next);
      // eslint-disable-next-line no-control-regex -- kontrolltegnene er nettopp det som fjernes
      const stripped = raw.replace(/[\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
      expect(containsHiddenCharacters(stripped), JSON.stringify(stripped.slice(0, 80))).toBe(false);
      if (stripped !== raw) expect(containsHiddenCharacters(raw), JSON.stringify(raw.slice(0, 80))).toBe(true);
    }
  });
});
