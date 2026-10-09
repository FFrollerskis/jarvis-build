import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  CHAT_READ_TIER,
  KNOWLEDGE_DEFAULT_HITS,
  KNOWLEDGE_MAX_HITS,
  KNOWLEDGE_SOURCE_KINDS,
  KNOWLEDGE_UNTRUSTED_NOTICE,
  KnowledgeSearchTransport,
  MeshToolExecutor,
  SURFACE_TOOL_GRANTS,
  assertChatReadTier,
  assertManifestInvariants,
  buildToolManifest,
  chatReadTierMeshTools,
  createTurnContext,
  describeSurfaceCatalog,
  firstWaveTools,
  knowledgeToolDefinitions,
  selectSurfaceTools,
  type KnowledgeSearchPort,
  type ToolGateway
} from "../src/index.ts";
import { classifyContentSensitivity } from "@jarvis/model-gateway";

/**
 * WP-D1 (UA-2): `knowledge.search` som chat-lese-verktøy. DB-uavhengige tester - transporten gjør ETT kall til retrieveren (RLS-skopet der), så en fake port er nok til å bevise
 * skoping, grenser, feilmodus og at verktøyet er riktig klassifisert (klasse A, ren lesing, ubetrodd output) uten embedded Postgres.
 */
const identity = (overrides: Partial<IdentityContext> = {}): IdentityContext => ({
  person_id: "person-know", tenant_id: "tenant-know", memory_space_id: "personal", session_id: "sess-know", device_id: "dev-know", channel: "web", auth_strength: "active", ...overrides
});

function fakePort(hits: unknown[] = []): { port: KnowledgeSearchPort; calls: Array<{ identity: IdentityContext; options: Parameters<KnowledgeSearchPort["searchHits"]>[1] }> } {
  const calls: Array<{ identity: IdentityContext; options: Parameters<KnowledgeSearchPort["searchHits"]>[1] }> = [];
  return { calls, port: { searchHits: async (id, options) => { calls.push({ identity: id, options }); return hits; } } };
}

describe("A: KnowledgeSearchTransport.invoke('search') - skopes ALLTID til identity.memory_space_id", () => {
  it("videresender spørringen med spaces=[identity.memory_space_id] og standardgrense; resultatet er { results, notice }", async () => {
    const { port, calls } = fakePort([{ document_id: "kd-1" }]);
    const out = await new KnowledgeSearchTransport(port).invoke("search", { query: "  oppsigelse  " }, "cred", { identity: identity({ memory_space_id: "business" }) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({ query: "oppsigelse", spaces: ["business"], limit: KNOWLEDGE_DEFAULT_HITS });
    expect(out.data).toEqual({ results: [{ document_id: "kd-1" }], notice: KNOWLEDGE_UNTRUSTED_NOTICE });
  });

  it("modellen kan ikke velge space eller tenant: kun identiteten i konteksten gjelder (parametre med slike felt påvirker ikke kallet)", async () => {
    const { port, calls } = fakePort();
    await new KnowledgeSearchTransport(port).invoke("search", { query: "x", memory_space: "health", tenant_id: "tenant-angriper", spaces: ["health"] }, "c", { identity: identity() });
    expect(calls[0]!.identity.tenant_id).toBe("tenant-know");
    expect(calls[0]!.options.spaces).toEqual(["personal"]);
  });

  it("limit klemmes til 1..KNOWLEDGE_MAX_HITS, ikke-tall/NaN gir standard, og fraksjoner rundes ned", async () => {
    const { port, calls } = fakePort();
    const transport = new KnowledgeSearchTransport(port);
    const ctx = { identity: identity() };
    await transport.invoke("search", { query: "x", limit: 3 }, "c", ctx);
    await transport.invoke("search", { query: "x", limit: 9999 }, "c", ctx);
    await transport.invoke("search", { query: "x", limit: -4 }, "c", ctx);
    await transport.invoke("search", { query: "x", limit: 2.9 }, "c", ctx);
    await transport.invoke("search", { query: "x", limit: "mange" as never }, "c", ctx);
    expect(calls.map((c) => c.options.limit)).toEqual([3, KNOWLEDGE_MAX_HITS, 1, 2, KNOWLEDGE_DEFAULT_HITS]);
  });

  it("source_kind må være en kjent kildetype og videresendes som liste; en ukjent verdi feiler lukket UTEN kall", async () => {
    const { port, calls } = fakePort();
    const transport = new KnowledgeSearchTransport(port);
    await transport.invoke("search", { query: "x", source_kind: "drive" }, "c", { identity: identity() });
    expect(calls[0]!.options.source_kinds).toEqual(["drive"]);
    for (const bad of ["google_drive", "DRIVE", "", 5, ["drive"], null]) {
      await expect(transport.invoke("search", { query: "x", source_kind: bad as never }, "c", { identity: identity() }), JSON.stringify(bad)).rejects.toThrow("invalid_parameter:source_kind");
    }
    expect(calls).toHaveLength(1);
  });

  it("manglende/tom/blank/ikke-streng query kaster missing_parameter:query uten kall; manglende kontekst og ukjent action feiler lukket", async () => {
    const { port, calls } = fakePort();
    const transport = new KnowledgeSearchTransport(port);
    for (const bad of [{}, { query: "" }, { query: "   " }, { query: 5 }, { query: null }]) {
      await expect(transport.invoke("search", bad as never, "c", { identity: identity() })).rejects.toThrow("missing_parameter:query");
    }
    await expect(transport.invoke("search", { query: "x" }, "c")).rejects.toThrow("knowledge_missing_invocation_context");
    await expect(transport.invoke("search", { query: "x" }, "c", { identity: { tenant_id: 5 } as never })).rejects.toThrow("knowledge_missing_invocation_context");
    await expect(transport.invoke("slett_alt", {}, "c", { identity: identity() })).rejects.toThrow("unknown_knowledge_action:slett_alt");
    expect(calls).toHaveLength(0);
  });

  it("merknaden om ubetrodd data er nøytral for sensitivitetsklassifiseringen (kan ende i historikken) og forbyr å følge instruksjoner", () => {
    expect(classifyContentSensitivity({ texts: [KNOWLEDGE_UNTRUSTED_NOTICE] }).sensitivity).toBe("PUBLIC_OR_LOW_SENSITIVITY");
    expect(KNOWLEDGE_UNTRUSTED_NOTICE).toMatch(/ALDRI instruksjoner/);
    expect(KNOWLEDGE_UNTRUSTED_NOTICE).toMatch(/sitert DATA/);
  });
});

describe("B: verktøydefinisjonen - klasse A, ren lesing, ubetrodd output, strengt skjema uten identitetsfelt", () => {
  const defs = knowledgeToolDefinitions(new KnowledgeSearchTransport(fakePort().port));
  const search = defs.find((d) => d.action === "search")!;
  const schema = search.input_schema as unknown as { safeParse: (v: unknown) => { success: boolean } };

  it("tool_id=knowledge/action=search, klasse A, scope knowledge.read, reverserbar lesing, output_trust=untrusted", () => {
    expect(defs.map((d) => `${d.tool_id}.${d.action}`)).toEqual(["knowledge.search"]);
    expect(search.capability_class).toBe("A");
    expect(search.scopes).toEqual(["knowledge.read"]);
    expect(search.reversible).toBe(true);
    expect(search.output_trust).toBe("untrusted");
    expect(search.credential_ref).toBe("JARVIS_BUSINESS_INTERNAL_TOKEN");
  });

  it("skjemaet er strict: identitets-/space-felt og ukjente felt avvises; lengde- og enum-grenser holder", () => {
    expect(schema.safeParse({ query: "x" }).success).toBe(true);
    expect(schema.safeParse({ query: "x", source_kind: "meeting_transcript", limit: 10 }).success).toBe(true);
    for (const bad of [{}, { query: "" }, { query: "x".repeat(501) }, { query: "x", tenant_id: "t" }, { query: "x", memory_space: "health" }, { query: "x", spaces: ["health"] },
      { query: "x", source_kind: "web" }, { query: "x", limit: 0 }, { query: "x", limit: KNOWLEDGE_MAX_HITS + 1 }, { query: "x", limit: 1.5 }, { query: "x", ekstra: 1 }]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("alle kildetypene i skjemaet er de konfigurerbare kildetypene (én kilde til sannhet)", () => {
    expect([...KNOWLEDGE_SOURCE_KINDS]).toEqual(["drive", "obsidian", "filesystem", "github", "email_attachment", "meeting_transcript"]);
  });
});

describe("C: flatene og manifestet - kunnskapssøket er på chattens lese-nivå (web_chat + tale), aldri på bakgrunn/Telegram/kode", () => {
  const registry = firstWaveTools({}, { additionalTools: knowledgeToolDefinitions(new KnowledgeSearchTransport(fakePort().port)) });
  const gw = { list: () => registry } as unknown as ToolGateway;

  it("står i CHAT_READ_TIER, og lese-nivået består (registrert, klasse A, effekt read, ikke forbudt id)", () => {
    expect(CHAT_READ_TIER.some((g) => g.tool_id === "knowledge" && g.action === "search")).toBe(true);
    // Registeret her har bare første-bølge-verktøyene + kunnskapssøket (executive/run_rate/hjem registreres i main.ts): kunnskapsparet er det som testes.
    expect(() => assertChatReadTier(gw, { allowUnregistered: true })).not.toThrow();
    expect(() => assertChatReadTier({ list: () => registry.filter((d) => d.tool_id !== "knowledge") } as unknown as ToolGateway, { allowUnregistered: true })).not.toThrow();
  });

  it("manifestet: jarvis_core, intern datasone, privat sensitivitet, ingen nettverk, effekt read, ubetrodd output, flater web_chat + voice", () => {
    const manifest = buildToolManifest(registry);
    const entry = manifest.get("knowledge.search")!;
    expect(entry).toMatchObject({ owner: "jarvis_core", risk: "A", effect: "read", data_zone: "internal", sensitivity: "private", cost: "free", network: "none", output_trust: "untrusted" });
    expect(entry.scope_fields).toEqual([]);
    expect([...entry.surfaces].sort()).toEqual(["voice", "web_chat"]);
    expect(() => assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true })).not.toThrow();
    for (const surface of ["telegram", "background", "coding"] as const) {
      expect(SURFACE_TOOL_GRANTS[surface].some((g) => g.tool_id === "knowledge"), surface).toBe(false);
    }
  });

  it("katalogen over tjenester viser kunnskapsbasen (kun lese) for web_chat", () => {
    const surface = chatReadTierMeshTools(registry, CHAT_READ_TIER, "read");
    const catalog = describeSurfaceCatalog(surface, "web_chat");
    expect(catalog.services.find((s) => s.tool_id === "knowledge")).toMatchObject({ label: expect.stringContaining("kunnskapsbase"), reads: 1, acts: 0 });
  });

  it("skjemaet modellen ser har ingen identitetsfelt, og verktøynavnet er knowledge__search", () => {
    const mapping = chatReadTierMeshTools(registry, CHAT_READ_TIER, "read").find((m) => m.tool_id === "knowledge")!;
    expect(mapping.def.name).toBe("knowledge__search");
    expect(mapping.def.description.startsWith("[lesing]")).toBe(true);
    const props = Object.keys((mapping.def.input_schema as { properties: Record<string, unknown> }).properties).sort();
    expect(props).toEqual(["limit", "query", "source_kind"]);
  });
});

describe("D: utvalg per melding (norske nøkkelord) - smalt, så en tilfeldig ordtreff ikke gir kunnskapsverktøyet", () => {
  const registry = firstWaveTools({}, { additionalTools: knowledgeToolDefinitions(new KnowledgeSearchTransport(fakePort().port)) });
  const surface = chatReadTierMeshTools(registry, CHAT_READ_TIER, "read");
  const keys = (text: string, s: "web_chat" | "voice" = "web_chat") => selectSurfaceTools(s, text, surface).selected.map((m) => `${m.tool_id}.${m.action}`);

  it.each([
    "hva står det i dokumentene mine om oppsigelsestid?",
    "søk i notatene etter hytta",
    "finn i referatene hva vi sa om budsjettet",
    "står det noe om bindingstid i kontrakten?",
    "hvilke dokumenter nevner Acme?",
    "hva henger sammen med prosjekt Alfa?",
    "hva sa vi i møtereferatet fra mandag?",
    "se i kunnskapsbasen min",
    "finn det i obsidian",
    "gi meg transkriptet fra møtet"
  ])("«%s» velger knowledge.search", (text) => {
    expect(keys(text)).toContain("knowledge.search");
  });

  it.each([
    "hei",
    "snakk om været",
    "hva husker du fra i går",
    "hva synes du om hytta vår",
    "har jeg fått noen e-poster?",
    "hva står i kalenderen i dag?",
    "list filene i drive",
    "søk i notion etter møtenotater"
  ])("«%s» velger IKKE knowledge.search", (text) => {
    expect(keys(text)).not.toContain("knowledge.search");
  });

  it("uten treff velges fortsatt bare det billigste generelle verktøyet (memory.search) - kunnskapssøket er aldri et fallback", () => {
    expect(keys("snakk om været")).not.toContain("knowledge.search");
  });

  it("tale får også kunnskapssøket (lese-nivået uten finans), men aldri en handling", () => {
    expect(keys("hva står det i dokumentene mine om oppsigelsestid?", "voice")).toContain("knowledge.search");
  });
});

describe("E: MeshToolExecutor - utførelsen tainter turen (ubetrodd output) og bruker identiteten fra trusted lag", () => {
  it("et vellykket kall merker turen som tainted med untrusted_output:knowledge.search, og modell-argumenter kan ikke bære identitet", async () => {
    const registry = firstWaveTools({}, { additionalTools: knowledgeToolDefinitions(new KnowledgeSearchTransport(fakePort().port)) });
    const mappings = chatReadTierMeshTools(registry, CHAT_READ_TIER, "read");
    const seen: Array<{ tool_id: string; action: string; parameters: Record<string, unknown> }> = [];
    const gateway = {
      execute: async (req: { tool_id: string; action: string; parameters: Record<string, unknown> }) => {
        seen.push(req);
        return { ok: true, data: { results: [], notice: KNOWLEDGE_UNTRUSTED_NOTICE }, output_trust: "untrusted", deduplicated: false };
      }
    } as unknown as ToolGateway;
    const turn = createTurnContext("web_chat", "hva står det i dokumentene mine om x?");
    const manifest = buildToolManifest(registry);
    const executor = new MeshToolExecutor(gateway, identity(), 20_000, mappings, turn, { manifest });
    expect(turn.taint.tainted).toBe(false);
    const result = await executor.execute(
      { tool_call_id: "c1", tool_name: "knowledge__search", arguments: { query: "x" }, provider: "anthropic", model: "m" },
      { tenant_id: "tenant-know", idempotency_key: "k1" }
    );
    expect(result.success).toBe(true);
    expect(result.trust).toBe("untrusted");
    expect(result.source).toBe("knowledge.search");
    expect(turn.taint.tainted).toBe(true);
    expect(turn.taint.reasons).toContain("untrusted_output:knowledge.search");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tool_id: "knowledge", action: "search", parameters: { query: "x" } });
  });

  it("på Telegram/bakgrunn er verktøyet utenfor flaten: TOOL_NOT_ON_SURFACE og ingen gateway-kall", async () => {
    const registry = firstWaveTools({}, { additionalTools: knowledgeToolDefinitions(new KnowledgeSearchTransport(fakePort().port)) });
    const mappings = chatReadTierMeshTools(registry, CHAT_READ_TIER, "read");
    let calls = 0;
    const gateway = { execute: async () => { calls += 1; return { ok: true, output_trust: "untrusted", deduplicated: false }; } } as unknown as ToolGateway;
    for (const surface of ["telegram", "background"] as const) {
      const executor = new MeshToolExecutor(gateway, identity(), 20_000, mappings, createTurnContext(surface, "x"), { manifest: buildToolManifest(registry) });
      const result = await executor.execute({ tool_call_id: "c1", tool_name: "knowledge__search", arguments: { query: "x" }, provider: "p", model: "m" }, { tenant_id: "t", idempotency_key: "k" });
      expect(result.success, surface).toBe(false);
      expect(result.error_category, surface).toBe("TOOL_NOT_ON_SURFACE");
    }
    expect(calls).toBe(0);
  });
});
