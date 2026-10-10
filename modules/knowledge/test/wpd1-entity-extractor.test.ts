import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mentionTargets } from "../src/entity-graph.ts";
import {
  DeterministicEntityExtractor,
  ENTITY_LIMITS,
  emailEntityKey,
  maskEmail,
  normalizeEntityName,
  type EntityExtractionInput,
  type ExtractedEntity,
  type KnownEntity
} from "../src/entity-extractor.ts";

/**
 * WP-D1 (UA-2): den DETERMINISTISKE entitetsuttrekkeren. Ren logikk: kjente navn fra minnets ordliste (hele ord, aldri delstrenger), e-postadresser (kun hashet nøkkel og maskert visning), domener (fra adresser og
 * URL-er, ikke løse «filnavn.endelse»), repo-navn, prosjektnøkler og møtedeltakere. Alt som leses er ubetrodd tekst: rensing, harde grenser og lineær kjøretid.
 */
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const extractor = (repos?: string[]) => new DeterministicEntityExtractor({ repos });
function input(content: string, over: Partial<EntityExtractionInput> = {}): EntityExtractionInput {
  return { source_type: "filesystem", title: "", content, metadata: {}, known: [], ...over };
}
const keyOf = (entities: ExtractedEntity[]): string[] => entities.map((e) => `${e.kind}:${e.canonical_key}`);
const find = (entities: ExtractedEntity[], kind: string, key: string): ExtractedEntity | undefined => entities.find((e) => e.kind === kind && e.canonical_key === key);

describe("A: normalisering", () => {
  it("normalizeEntityName: NFKC, små bokstaver, ordsekvens; bindestrek og apostrof inni ord beholdes; tegnsetting er skilletegn", () => {
    expect(normalizeEntityName("  Acme   Norge AS  ")).toBe("acme norge as");
    expect(normalizeEntityName("ＡＣＭＥ")).toBe("acme");
    expect(normalizeEntityName("Ole-Martin O'Brien")).toBe("ole-martin o'brien");
    expect(normalizeEntityName("Acme, Inc. (Oslo)")).toBe("acme inc oslo");
    expect(normalizeEntityName("!!!")).toBe("");
  });

  it("e-postnøkkel er sha256 av adressen (små bokstaver) og visningen er maskert - aldri adressen selv", () => {
    expect(emailEntityKey("  Ola.Nordmann@Acme.NO ")).toBe(sha("ola.nordmann@acme.no"));
    expect(maskEmail("Ola.Nordmann@Acme.no")).toBe("o***@acme.no");
    expect(maskEmail("x")).toBe("***");
    expect(maskEmail("@acme.no")).toBe("***");
  });
});

describe("B: kjente entiteter fra minnets ordliste", () => {
  const known: KnownEntity[] = [
    { entity_id: "ent-1", kind: "organization", name: "Acme Norge" },
    { entity_id: "ent-2", kind: "person", name: "Ola Nordmann" },
    { entity_id: "ent-3", kind: "contact", name: "Per" },
    { entity_id: "ent-4", kind: "place", name: "Oslo" },
    { entity_id: "ent-5", kind: "topic", name: "Acme" }
  ];

  it("hele ord og ordsekvenser, uten hensyn til store/små bokstaver; antall omtaler telles; memory_entity_id følger med; art fra minnet (ukjent art = known_entity)", () => {
    const out = extractor().extract(input("Møtet med Acme Norge ble holdt i Oslo. ACME NORGE sendte ola nordmann. Oslo er pent. Per kommer.", { known }));
    expect(find(out, "organization", "acme norge")).toMatchObject({ mention_count: 2, memory_entity_id: "ent-1", display_name: "Acme Norge" });
    expect(find(out, "person", "ola nordmann")).toMatchObject({ mention_count: 1, memory_entity_id: "ent-2" });
    expect(find(out, "place", "oslo")).toMatchObject({ mention_count: 2 });
    // «Acme» som eget navn telles også når det står inni «Acme Norge» (en omtale av Acme Norge omtaler Acme).
    expect(find(out, "topic", "acme")).toMatchObject({ mention_count: 2 });
    expect(find(out, "known_entity", "per")).toMatchObject({ memory_entity_id: "ent-3" });
  });

  it("aldri delstrengtreff: «Acmeco», «Osloveien» og «Oslos» er ikke Oslo/Acme, og navn i andre ordgrenser treffer ikke", () => {
    const out = extractor().extract(input("Acmeco bor i Osloveien. Nordmannsdalen. Ola Nordmannsen.", { known }));
    expect(keyOf(out)).not.toContain("place:oslo");
    expect(keyOf(out)).not.toContain("topic:acme");
    expect(keyOf(out)).not.toContain("person:ola nordmann");
  });

  it("korte enkeltnavn (<= 4 tegn) må være skrevet med stor forbokstav: «per» som vanlig ord (per år) teller ikke, «Per» gjør", () => {
    const shortKnown: KnownEntity[] = [{ entity_id: "e-per", kind: "person", name: "Per" }, { entity_id: "e-mai", kind: "person", name: "Mai" }];
    const lower = extractor().extract(input("kostnaden er 100 kr per år per bruker og i mai", { known: shortKnown }));
    expect(lower).toEqual([]);
    const upper = extractor().extract(input("Per og Mai møttes", { known: shortKnown }));
    expect(keyOf(upper).sort()).toEqual(["person:mai", "person:per"]);
  });

  it("for korte navn, rene tall og navn med for mange ord ignoreres i ordlisten; tomme/ugyldige oppføringer krasjer ikke", () => {
    const junk = [
      { entity_id: "a", kind: "person", name: "Jo" }, { entity_id: "b", kind: "topic", name: "2026" }, { entity_id: "c", kind: "topic", name: "12 34" },
      { entity_id: "d", kind: "topic", name: "en to tre fire fem seks sju" }, { entity_id: "e", kind: "topic", name: "" }, { entity_id: "f", kind: "topic", name: "!!!" },
      { entity_id: 5 as unknown as string, kind: "topic", name: "Gyldig" }, { entity_id: "g", kind: "topic", name: 7 as unknown as string }
    ] as KnownEntity[];
    expect(extractor().extract(input("Jo 2026 12 34 en to tre fire fem seks sju Gyldig", { known: junk }))).toEqual([]);
  });

  it("visningsnavn fra ordlisten renses (tagger og kontrolltegn)", () => {
    const evil: KnownEntity[] = [{ entity_id: "x1", kind: "topic", name: "Prosjekt<Alfa>" }, { entity_id: "x2", kind: "topic", name: `Prosjekt${String.fromCharCode(0)}Beta` }];
    const out = extractor().extract(input("Prosjekt Alfa og Prosjekt Beta", { known: evil }));
    expect(out.map((e) => e.display_name).sort()).toEqual(["Prosjekt Beta", "Prosjekt\u2039Alfa\u203a"]);
  });

  it("ordlisten er begrenset (maks 2000 oppføringer leses)", () => {
    const many: KnownEntity[] = Array.from({ length: ENTITY_LIMITS.maxKnown + 50 }, (_, i) => ({ entity_id: `e${i}`, kind: "topic", name: `Navn${i} Test` }));
    const out = extractor().extract(input(`Navn1 Test og Navn${ENTITY_LIMITS.maxKnown + 10} Test`, { known: many }));
    expect(keyOf(out)).toEqual(["topic:navn1 test"]);
  });
});

describe("C: e-postadresser og domener", () => {
  it("e-post: hashet nøkkel + maskert visning (adressen finnes ingen steder i resultatet), domenet blir egen entitet, gratis e-posttjenester gir ingen domene-entitet", () => {
    const out = extractor().extract(input("Kontakt Ola.Nordmann@Acme.no eller ola.nordmann@acme.no, og privat: kari@gmail.com"));
    const ola = find(out, "email_address", sha("ola.nordmann@acme.no"));
    expect(ola).toMatchObject({ mention_count: 2, display_name: "o***@acme.no" });
    expect(find(out, "email_address", sha("kari@gmail.com"))).toMatchObject({ display_name: "k***@gmail.com" });
    expect(find(out, "domain", "acme.no")).toMatchObject({ mention_count: 2 });
    expect(keyOf(out)).not.toContain("domain:gmail.com");
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("nordmann@");
    expect(serialized).not.toContain("kari@");
  });

  it("domener fra URL-er og www-navn (www/port/sti fjernes, subdomener samles), men aldri løse «filnavn.endelse», IP-adresser eller plattformdomener", () => {
    const out = extractor().extract(input(
      "Se https://www.acme.no/om-oss?x=1, http://shop.acme.no:8080/a og www.bedrift.co.uk. Filer: package.json, README.md, notater.txt, versjon 1.2.3 og e.g. dette. " +
      "Ekstern: https://docs.google.com/document/d/1 og http://192.168.0.10/admin og https://github.com/features/actions"
    ));
    expect(find(out, "domain", "acme.no")).toMatchObject({ mention_count: 2 });
    expect(find(out, "domain", "bedrift.co.uk")).toBeDefined();
    const domains = out.filter((e) => e.kind === "domain").map((e) => e.canonical_key).sort();
    expect(domains).toEqual(["acme.no", "bedrift.co.uk"]);
  });

  it("e-post med ikke-ASCII-bokstaver og veldig lange lokaldeler håndteres uten feil", () => {
    const out = extractor().extract(input(`Skriv til ærlig.råd@bedrift.no og ${"a".repeat(100)}@x.no`));
    expect(out.some((e) => e.kind === "email_address" && e.display_name === "æ***@bedrift.no")).toBe(true);
  });
});

describe("D: repo-navn og prosjektnøkler", () => {
  it("github.com/eier/repo (.git og avsluttende tegn fjernes), reserverte stier er ikke repo, konfigurerte eier/repo gjenkjennes som ren tekst med ordgrense", () => {
    const text = "Se https://github.com/TSWorkflow/JarvisBuild.git og github.com/tsworkflow/jarvisbuild/issues/5, github.com/features/actions, github.com/orgs/x/people. " +
      "Intern omtale: tsworkflow/jarvisbuild er repoet. xtsworkflow/jarvisbuild2 er ikke det. and/or er ikke et repo.";
    const out = extractor(["tsworkflow/jarvisbuild", "ugyldig repo!", "../../etc"]).extract(input(text));
    expect(out.filter((e) => e.kind === "repo").map((e) => e.canonical_key)).toEqual(["tsworkflow/jarvisbuild"]);
    expect(find(out, "repo", "tsworkflow/jarvisbuild")?.mention_count).toBe(3); // 2 URL-er + 1 ren omtale
    // Uten konfigurasjon finnes bare URL-formene.
    expect(find(extractor().extract(input("tsworkflow/jarvisbuild alene")), "repo", "tsworkflow/jarvisbuild")).toBeUndefined();
  });

  it("prosjektnøkler (ABC-123 -> ABC), ikke standarder (ISO-9001, UTF-8, COVID-19), årstall (FY-2026) eller én-bokstavs-prefiks (Q4-2026); små bokstaver treffer ikke", () => {
    const out = extractor().extract(input("JARV-12 og JARV-13 henger sammen med AB-7. ISO-9001, UTF-8, COVID-19, SHA-256, FY-2026, ABC-2026, Q4-2026, H1-5 og abc-123 er ikke saker."));
    expect(out.filter((e) => e.kind === "project_key").map((e) => `${e.canonical_key}:${e.mention_count}`).sort()).toEqual(["AB:1", "JARV:2"]);
  });
});

describe("E: møtedeltakere (kun fra kildens egen metadata)", () => {
  it("møtereferat: deltakernavn blir person-entiteter (e-post forkastes), og et navn som også er kjent i minnet får minnets id", () => {
    const meta = { participants: [{ name: "Ola Nordmann", ref: "p1" }, { name: "Kari", ref: "p2" }, { name: "ola@acme.no", ref: "p3" }, { ref: "p4" }, "tekst", null] };
    const known: KnownEntity[] = [{ entity_id: "ent-ola", kind: "person", name: "Ola Nordmann" }];
    const out = extractor().extract(input("tekst uten navn", { source_type: "meeting_transcript", metadata: meta as never, known }));
    expect(find(out, "person", "ola nordmann")).toMatchObject({ display_name: "Ola Nordmann", memory_entity_id: "ent-ola" });
    expect(find(out, "person", "kari")).toBeDefined();
    expect(JSON.stringify(out)).not.toContain("ola@acme.no");
    // Deltakerlisten i metadata fra en ANNEN kilde er ikke en deltakerliste kilden har laget.
    expect(extractor().extract(input("tekst", { source_type: "google_drive", metadata: meta as never }))).toEqual([]);
  });

  it("maks 50 deltakere leses, og metadata som ikke er en liste ignoreres", () => {
    const participants = Array.from({ length: 80 }, (_, i) => ({ name: `Person Nummer${i}`, ref: `p${i}` }));
    const out = extractor().extract(input("x", { source_type: "meeting_transcript", metadata: { participants } as never }));
    expect(out.length).toBe(ENTITY_LIMITS.maxParticipants);
    expect(extractor().extract(input("x", { source_type: "meeting_transcript", metadata: { participants: "ola" } as never }))).toEqual([]);
  });
});

describe("F: grenser og robusthet mot ondsinnet tekst", () => {
  it("maks 200 entiteter per dokument, sortert på antall omtaler (deretter art og nøkkel) - deterministisk rekkefølge", () => {
    const text = Array.from({ length: 300 }, (_, i) => `bruker${i}@firma${i}.no`).join(" ") + " ".concat("vanlig@topp.no ".repeat(5));
    const out = extractor().extract(input(text));
    expect(out).toHaveLength(ENTITY_LIMITS.maxPerDocument);
    expect(out[0]?.mention_count).toBeGreaterThanOrEqual(out[out.length - 1]?.mention_count ?? 0);
    expect(JSON.stringify(extractor().extract(input(text)))).toBe(JSON.stringify(out));
    expect(new DeterministicEntityExtractor({ maxEntities: 5 }).extract(input(text))).toHaveLength(5);
  });

  it("kun de første 500 000 tegnene leses (et navn langt ute i en enorm fil finnes ikke, og kjøretiden er begrenset)", () => {
    const filler = "ord ".repeat(ENTITY_LIMITS.maxScanChars / 4 + 10);
    const out = extractor().extract(input(`${filler} sent@langt.no`));
    expect(out).toEqual([]);
  });

  it("patologiske inndata gir lineær kjøretid (ingen regex-eksplosjon): lange runs, mange @, mange http://, mange bindestreker", () => {
    const half = ENTITY_LIMITS.maxScanChars / 2;
    const cases = [
      "a".repeat(half), "a@".repeat(half / 2), "http://".repeat(Math.floor(half / 7)), "A-".repeat(half / 2),
      "www.".repeat(half / 4), "github.com/".repeat(Math.floor(half / 11)), `${"a.".repeat(half / 2)}@x`, "AB-1 ".repeat(half / 5)
    ];
    const known: KnownEntity[] = [{ entity_id: "k", kind: "topic", name: "Acme Norge" }];
    for (const [i, text] of cases.entries()) {
      const start = Date.now();
      extractor(["a/b"]).extract(input(text, { known }));
      expect(Date.now() - start, `case ${i}`).toBeLessThan(4000);
    }
  }, 60_000);

  it("tittelen leses også, og resultatet er rent data (visningsnavn uten tagger/kontrolltegn)", () => {
    const out = extractor().extract(input("tekst", { title: "Møte om JARV-1 hos www.titteldomene.no" }));
    expect(keyOf(out).sort()).toEqual(["domain:titteldomene.no", "project_key:JARV"]);
    for (const e of out) expect([...e.display_name].some((ch) => ch === "<" || ch === ">" || ch.codePointAt(0) === 0)).toBe(false);
  });
});

describe("G: mentionTargets (spørringen bruker samme normalisering som uttrekket)", () => {
  const targets = (raw: string) => mentionTargets(raw).map((t) => `${t.kind}:${t.key}`).sort();

  it("e-postadresse -> hashet nøkkel (aldri klartekst) + navn; URL og bart domene -> registrerbart domene; eier/repo; prosjektnøkkel", () => {
    expect(targets("Ola.Nordmann@Acme.no")).toContain(`email_address:${sha("ola.nordmann@acme.no")}`);
    expect(JSON.stringify(mentionTargets("ola@acme.no"))).not.toContain("ola@acme.no");
    expect(targets("https://www.shop.acme.no/side")).toContain("domain:acme.no");
    expect(targets("www.acme.no")).toContain("domain:acme.no");
    expect(targets("ACME.NO")).toContain("domain:acme.no");
    expect(targets("TSWorkflow/JarvisBuild")).toContain("repo:tsworkflow/jarvisbuild");
    expect(targets("https://github.com/tsworkflow/jarvisbuild.git")).toContain("repo:tsworkflow/jarvisbuild");
    expect(targets("JARV-123")).toContain("project_key:JARV");
    expect(targets("jarv")).toContain("project_key:JARV");
  });

  it("navn -> normalisert navn for alle navneartene; tom, blank og tegnsetting gir ingen kandidater; lang input kuttes", () => {
    expect(targets("  Acme   Norge ")).toEqual(["known_entity:acme norge", "organization:acme norge", "person:acme norge", "place:acme norge", "topic:acme norge"]);
    expect(mentionTargets("")).toEqual([]);
    expect(mentionTargets("   ")).toEqual([]);
    expect(mentionTargets("!!!")).toEqual([]);
    for (const t of mentionTargets("x".repeat(5000))) expect(t.key.length).toBeLessThanOrEqual(200);
  });

  it("SQL-tegn og injeksjonstekst er bare tekst (nøklene er data; de brukes kun som parametre)", () => {
    expect(() => mentionTargets("'; DROP TABLE knowledge_entities; --")).not.toThrow();
    expect(targets("'; DROP TABLE knowledge_entities; --").every((t) => !t.includes("'"))).toBe(true);
  });
});
