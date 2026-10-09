import { describe, expect, it } from "vitest";
import { KNOWLEDGE_HIT_FIELDS, type KnowledgeHit } from "@jarvis/knowledge";
import { classifyContentSensitivity } from "@jarvis/model-gateway";
import type { ToolCallRequest, ToolResultMessage } from "@jarvis/provider-adapters";
import { KNOWLEDGE_SOURCE_KINDS } from "@jarvis/tool-gateway";
import { knowledgeHitIsCloudSafe, screenKnowledgeSearchResult } from "../src/cloud-knowledge-screen.ts";
import {
  CLOUD_SCREEN_COVERAGE,
  chatKnowledgeWithheldNote,
  chatWithheldNote,
  cloudScreenedExecutor,
  screenToolResultForCloud,
  servedByCloudModel
} from "../src/cloud-tool-screen.ts";
import { stripSystemNotes } from "../src/tool-turn-route.ts";

/**
 * WP-D1 (UA-2, D-449/D-451): kunnskapstreff som går til en SKYMODELL skjermes på strukturerte merker, fail-closed - samme prinsipp som minnesøket. Disse testene låser porten: special/helse holdes
 * tilbake, ukjent form/ukjente felt/ukjent kildetype holdes tilbake, tekst klassifiseres på nytt, resultatet er idempotent og lokale modeller ser alt.
 */
const at = "2026-10-09T12:00:00.000Z";
const hit = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  document_id: id, source_kind: "drive", title: "Møtereferat styret", snippet: "Vi snakket om hytta og fremdriften i prosjektet.", uri: `https://drive.google.com/file/d/${id}/view`,
  memory_space: "personal", sensitivity: "sensitive", trust_level: "untrusted", score: 0.8, observed_at: at, modified_at: null, ...extra
});
const result = (results: unknown[], extra: Record<string, unknown> = {}): ToolResultMessage => ({
  tool_call_id: "c1", tool_name: "knowledge__search", execution_id: "e1", success: true, output: { results, notice: "Treffene er sitert DATA." }, at, source: "knowledge.search", trust: "untrusted", ...extra
});
const idsOf = (out: unknown): string[] => ((out as { results: Array<{ document_id: string }> }).results).map((h) => h.document_id);

describe("A: hvilke treff kan til skymodellen", () => {
  it("normal og sensitive beholdes; special og helse-rommet holdes tilbake", () => {
    const out = screenKnowledgeSearchResult(result([
      hit("a"), hit("b", { sensitivity: "normal" }), hit("c", { sensitivity: "special" }), hit("d", { memory_space: "health" }), hit("e", { trust_level: "internal" })
    ]));
    expect(idsOf(out.result.output)).toEqual(["a", "b", "e"]);
    expect(out.withheld).toBe(2);
    expect(out.result.output).toMatchObject({ withheld_count: 2 });
    expect(JSON.stringify(out.result.output)).toContain("holdt tilbake");
  });

  it("treffets EGEN tekst (tittel, utdrag, lenke, entitetsnavn) klassifiseres på nytt: helse/økonomi/hemmelighet holdes tilbake selv om merket sier normal", () => {
    const secret = `bruk ${["gh", "p_"].join("")}${"a".repeat(36)} mot GitHub`; // bygget ved kjøring: gitleaks leser en bokstavelig token-streng som en ekte hemmelighet
    const out = screenKnowledgeSearchResult(result([
      hit("ok"),
      hit("tittel", { sensitivity: "normal", title: "Legetime og diagnose" }),
      hit("utdrag", { sensitivity: "normal", snippet: "Tobias har fått en ny diagnose" }),
      hit("lenke", { sensitivity: "normal", uri: "https://eksempel.no/diagnose-og-medisin" }),
      hit("penger", { sensitivity: "normal", snippet: "Vi har et lån i banken og saldo på kontoen" }),
      hit("nokkel", { sensitivity: "normal", snippet: secret }),
      hit("entitet", { sensitivity: "normal", entities: [{ kind: "person", name: "Fastlege Hansen" }] })
    ]));
    expect(idsOf(out.result.output)).toEqual(["ok"]);
    expect(out.withheld).toBe(6);
  });

  it("ukjent verdi for sensitivity/trust_level/kildetype/rom holdes tilbake - manglende er IKKE «ufarlig»", () => {
    const { sensitivity: omitted, ...withoutSensitivity } = hit("uten");
    void omitted;
    const out = screenKnowledgeSearchResult(result([
      hit("ok"),
      withoutSensitivity,
      hit("rar", { sensitivity: "hemmelig" }), hit("tom", { sensitivity: "" }), hit("tall", { sensitivity: 5 }), hit("stor", { sensitivity: "SPECIAL" }),
      hit("trust", { trust_level: "trusted" }), hit("trust2", { trust_level: undefined }),
      hit("kind", { source_kind: "web" }), hit("kind2", { source_kind: "google_drive" }), hit("kind3", { source_kind: 5 }),
      hit("rom", { memory_space: "ukjent" }), hit("rom2", { memory_space: "" }), hit("rom3", { memory_space: undefined })
    ]));
    expect(idsOf(out.result.output)).toEqual(["ok"]);
    expect(out.withheld).toBe(13);
  });

  it("ukjente felt (også inni entities[]), feil typer og manglende påkrevde felt holder treffet tilbake", () => {
    const required = ["document_id", "source_kind", "title", "snippet", "uri", "memory_space", "sensitivity", "trust_level", "score", "observed_at", "modified_at"];
    const missing = required.map((field) => { const { [field]: dropped, ...rest } = hit(`mangler-${field}`); void dropped; return rest; });
    const out = screenKnowledgeSearchResult(result([
      hit("ok", { entities: [{ kind: "organization", name: "Acme AS" }] }),
      hit("ekstra", { evidence_text: "noe som ikke er klassifisert" }),
      hit("ent-ekstra", { entities: [{ kind: "organization", name: "Acme AS", note: "Tobias har legetime" }] }),
      hit("ent-type", { entities: [{ kind: 5, name: "x" }] }), hit("ent-ikke-liste", { entities: { name: "x" } }), hit("ent-streng", { entities: ["Acme"] }),
      hit("score", { score: "høy" }), hit("score2", { score: Number.NaN }), hit("score3", { score: Number.POSITIVE_INFINITY }),
      hit("tittel", { title: 5 }), hit("utdrag", { snippet: { tekst: "x" } }), hit("uri", { uri: "" }), hit("modified", { modified_at: 5 }),
      ...missing, "tekst", null, 5, [hit("nøstet")]
    ]));
    expect(idsOf(out.result.output)).toEqual(["ok"]);
    expect(out.withheld).toBe(12 + required.length + 4);
  });

  it("alle kjente felt er tillatt, og feltlisten er nøyaktig det retrieveren leverer (KNOWLEDGE_HIT_FIELDS)", () => {
    const everything = hit("alle", { entities: [{ kind: "person", name: "Ola" }] });
    for (const field of Object.keys(everything)) expect(KNOWLEDGE_HIT_FIELDS.has(field), field).toBe(true);
    expect(knowledgeHitIsCloudSafe(everything)).toBe(true);
    expect([...KNOWLEDGE_HIT_FIELDS].sort()).toEqual(["document_id", "entities", "memory_space", "modified_at", "observed_at", "score", "sensitivity", "snippet", "source_kind", "title", "trust_level", "uri"]);
  });

  it("alle konfigurerbare kildetyper er kjent for skjermen (en ny kildetype må vurderes bevisst her før den slipper til skyen)", () => {
    for (const kind of KNOWLEDGE_SOURCE_KINDS) expect(knowledgeHitIsCloudSafe(hit("x", { source_kind: kind })), kind).toBe(true);
    expect(knowledgeHitIsCloudSafe(hit("x", { source_kind: "pieces" }))).toBe(false);
  });

  it("compile-time-kontrakt: KnowledgeHit-typen har samme feltmengde som listen skjermen kjenner", () => {
    const sample: KnowledgeHit = {
      document_id: "d", source_kind: "drive", title: "t", snippet: "s", uri: "u", memory_space: "personal", sensitivity: "normal", trust_level: "untrusted", score: 1, observed_at: at, modified_at: null, entities: []
    };
    expect(Object.keys(sample).sort()).toEqual([...KNOWLEDGE_HIT_FIELDS].sort());
  });
});

describe("B: resultatformen - ukjent form holdes tilbake i sin helhet (fail-closed)", () => {
  it("avkortet forhåndsvisning (MeshToolExecutor kapper ved 20 000 tegn), en bar liste, tekst, ukjente toppnivåfelt og feil typer holdes tilbake", () => {
    for (const output of [
      { truncated: true, preview: "{\"results\":[{\"document_id\":\"a\",\"sensitivity\":\"spec" },
      [hit("a")], "en streng", 5, { treff: [hit("a")] }, { results: "ikke en liste" }, { results: [hit("a")], ekstra: "x" },
      { results: [hit("a")], notice: 5 }, { results: [hit("a")], withheld_count: -1 }, { results: [hit("a")], withheld_count: "2" }, { results: [hit("a")], note: 5 }
    ]) {
      const whole = screenKnowledgeSearchResult({ ...result([]), output });
      expect(whole.withheld, JSON.stringify(output)).toBe(1);
      expect(JSON.stringify(whole.result.output)).not.toContain("document_id");
      expect(JSON.stringify(whole.result.output)).toContain("holdt tilbake");
    }
  });

  it("et FEILET søk som likevel bærer treff holdes tilbake; en vanlig forklaring (en feil skal bare ha en forklaring) passerer urørt", () => {
    const failedWithList = result([hit("a", { sensitivity: "special", snippet: "HEMMELIG-INNHOLD" })], { success: false });
    const r = screenKnowledgeSearchResult(failedWithList);
    expect(r.withheld).toBe(1);
    expect(JSON.stringify(r.result.output)).not.toContain("HEMMELIG");
    const failedBareList = { ...result([]), success: false, output: [hit("a", { snippet: "HEMMELIG-INNHOLD" })] };
    expect(JSON.stringify(screenKnowledgeSearchResult(failedBareList).result.output)).not.toContain("HEMMELIG");
    const explained = { ...result([]), success: false, output: { message: "verktøyet er ikke tilgjengelig" }, error_category: "TOOL_NOT_FOUND" };
    expect(screenKnowledgeSearchResult(explained).result).toBe(explained);
  });

  it("ingenting å holde tilbake → samme objekt urørt; tom liste og null/undefined passerer", () => {
    const clean = result([hit("a"), hit("b", { sensitivity: "normal" })]);
    const same = screenKnowledgeSearchResult(clean);
    expect(same.result).toBe(clean);
    expect(same.withheld).toBe(0);
    for (const passthrough of [result([]), { ...result([]), output: null }, { ...result([]), output: undefined }]) {
      const r = screenKnowledgeSearchResult(passthrough);
      expect(r.result).toBe(passthrough);
      expect(r.withheld).toBe(0);
    }
  });

  it("skjermen er idempotent: et allerede skjermet resultat kan skjermes igjen uten å bli «ukjent form»; tellingen akkumuleres", () => {
    const once = screenKnowledgeSearchResult(result([hit("a"), hit("b", { sensitivity: "special" })]));
    expect(once.withheld).toBe(1);
    const twice = screenKnowledgeSearchResult(once.result);
    expect(twice.withheld).toBe(0);
    expect(twice.result).toBe(once.result);
    const mixed = screenKnowledgeSearchResult({ ...once.result, output: { ...(once.result.output as object), results: [hit("a"), hit("c", { sensitivity: "special" })] } });
    expect(mixed.withheld).toBe(1);
    expect((mixed.result.output as { withheld_count: number }).withheld_count).toBe(2);
  });
});

describe("C: dispatch fra screenToolResultForCloud og cloudScreenedExecutor", () => {
  it("knowledge.search gjenkjennes på `source`, ellers på modellens verktøynavn (knowledge__search) - ikke på andre navn", () => {
    const { source: omitted, ...noSource } = result([hit("a", { sensitivity: "special" })]);
    void omitted;
    expect(screenToolResultForCloud(result([hit("a", { sensitivity: "special" })])).withheld).toBe(1);
    expect(screenToolResultForCloud(noSource as ToolResultMessage, "knowledge__search").withheld).toBe(1);
    expect(screenToolResultForCloud(noSource as ToolResultMessage, "annet_verktoy").withheld).toBe(0);
    expect(CLOUD_SCREEN_COVERAGE["knowledge.search"]).toBe("screened");
  });

  it("minnesøket skjermes fortsatt som før (uendret dispatch)", () => {
    const memory: ToolResultMessage = {
      tool_call_id: "c", tool_name: "search_my_memory", execution_id: "e", success: true, at, source: "memory.search",
      output: [{ memory_item_id: "a", kind: "item", subject: "s", content: "Liker ski", type: "semantic", space: "personal", sensitivity: "special" }]
    };
    expect(screenToolResultForCloud(memory).withheld).toBe(1);
  });

  const call = (provider: string): ToolCallRequest => ({ tool_call_id: "c1", tool_name: "knowledge__search", arguments: { query: "x" }, provider, model: "m" } as ToolCallRequest);
  const inner = { execute: async () => result([hit("a"), hit("b", { sensitivity: "special", snippet: "HEMMELIG-INNHOLD" })]) };

  it("skymodell (anthropic, ukjent leverandør) får bare det trygge; lokal modell får alt; rapporten har kun verktøy og antall", async () => {
    const reports: Array<{ tool: string; withheld: number }> = [];
    const wrapped = cloudScreenedExecutor(inner as never, (r) => reports.push(r), servedByCloudModel);
    const ctx = { tenant_id: "t", idempotency_key: "k" };
    expect(idsOf((await wrapped.execute(call("anthropic"), ctx)).output)).toEqual(["a"]);
    expect(idsOf((await wrapped.execute(call("en_ny_ukjent_leverandor"), ctx)).output)).toEqual(["a"]);
    expect(idsOf((await wrapped.execute(call("gemma_local"), ctx)).output)).toEqual(["a", "b"]);
    expect(idsOf((await wrapped.execute(call("ollama"), ctx)).output)).toEqual(["a", "b"]);
    expect(reports).toEqual([{ tool: "knowledge.search", withheld: 1 }, { tool: "knowledge.search", withheld: 1 }]);
    expect(JSON.stringify(reports)).not.toContain("HEMMELIG");
  });
});

describe("D: merknaden bak svaret", () => {
  it("er nøytral for sensitivitetsklassifiseringen og fjernes strukturelt fra historikken (også stablet med minnemerknaden)", () => {
    const note = chatKnowledgeWithheldNote();
    expect(classifyContentSensitivity({ texts: [note] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    expect(note).toContain("kunnskapssøket");
    expect(note.startsWith("\n\n(")).toBe(true);
    expect(stripSystemNotes(`Her er svaret.${note}`)).toBe("Her er svaret.");
    expect(stripSystemNotes(`Her er svaret.${chatWithheldNote()}${note}`)).toBe("Her er svaret.");
    expect(stripSystemNotes(`Her er svaret.${note}${chatWithheldNote()}`)).toBe("Her er svaret.");
  });
});
