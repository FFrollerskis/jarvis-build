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
  type KnowledgeClaimsPort,
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
    // Uten `claimWrites` finnes KUN lesehandlingene i gatewayen (skrive-handlingene registreres ikke engang).
    expect(defs.map((d) => `${d.tool_id}.${d.action}`)).toEqual(["knowledge.search", "knowledge.get_claim_status"]);
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

  it("mentions-filteret (entitetsgrafen) er et valgfritt, begrenset tekstfelt i skjemaet", () => {
    expect(schema.safeParse({ query: "x", mentions: "Acme AS" }).success).toBe(true);
    for (const bad of [{ query: "x", mentions: "" }, { query: "x", mentions: "a".repeat(201) }, { query: "x", mentions: 5 }, { query: "x", mentions: ["Acme"] }]) {
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
    expect(catalog.services.find((s) => s.tool_id === "knowledge")).toMatchObject({ label: expect.stringContaining("kunnskapsbase"), reads: 2, acts: 0 });
  });

  it("skjemaet modellen ser har ingen identitetsfelt, og verktøynavnet er knowledge__search", () => {
    const mapping = chatReadTierMeshTools(registry, CHAT_READ_TIER, "read").find((m) => m.tool_id === "knowledge")!;
    expect(mapping.def.name).toBe("knowledge__search");
    expect(mapping.def.description.startsWith("[lesing]")).toBe(true);
    const props = Object.keys((mapping.def.input_schema as { properties: Record<string, unknown> }).properties).sort();
    expect(props).toEqual(["limit", "mentions", "query", "source_kind"]);
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Entitetsgrafen (mentions) og Q-26 påstandsverifisering
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("F: mentions-filteret (entitetsgrafen) videresendes trimmet og validert", () => {
  it("«hvilke dokumenter nevner X»: mentions havner i retrieverkallet; ugyldige verdier feiler lukket UTEN kall", async () => {
    const { port, calls } = fakePort();
    const transport = new KnowledgeSearchTransport(port);
    await transport.invoke("search", { query: "kontrakt", mentions: "  Acme AS " }, "c", { identity: identity() });
    expect(calls[0]!.options.mentions).toBe("Acme AS");
    for (const bad of ["", "   ", "a".repeat(201), 5, ["Acme"], null, { navn: "Acme" }]) {
      await expect(transport.invoke("search", { query: "x", mentions: bad as never }, "c", { identity: identity() }), JSON.stringify(bad)).rejects.toThrow("invalid_parameter:mentions");
    }
    expect(calls).toHaveLength(1);
    // Uten mentions sendes feltet ikke i det hele tatt (retrieveren skiller «ikke oppgitt» fra «ingen treff»).
    await transport.invoke("search", { query: "x" }, "c", { identity: identity() });
    expect("mentions" in calls[1]!.options).toBe(false);
  });
});

function fakeClaims(overrides: Partial<KnowledgeClaimsPort> = {}): { port: KnowledgeClaimsPort; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, result: unknown) => async (...args: unknown[]) => { calls.push({ method, args }); return result; };
  const port: KnowledgeClaimsPort = {
    getClaimStatus: record("getClaimStatus", { found: false, status: "UNKNOWN", claim: null, notice: "n" }) as KnowledgeClaimsPort["getClaimStatus"],
    ...overrides
  };
  return { port, calls };
}

function fullClaims(): ReturnType<typeof fakeClaims> {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string) => async (...args: unknown[]) => { calls.push({ method, args }); return { ok: method }; };
  return {
    calls,
    port: {
      getClaimStatus: record("getClaimStatus") as KnowledgeClaimsPort["getClaimStatus"],
      registerClaim: record("registerClaim") as NonNullable<KnowledgeClaimsPort["registerClaim"]>,
      addClaimEvidence: record("addClaimEvidence") as NonNullable<KnowledgeClaimsPort["addClaimEvidence"]>,
      retractClaimEvidence: record("retractClaimEvidence") as NonNullable<KnowledgeClaimsPort["retractClaimEvidence"]>,
      proposeClaimPromotion: record("proposeClaimPromotion") as NonNullable<KnowledgeClaimsPort["proposeClaimPromotion"]>
    }
  };
}

describe("G: get_claim_status - ren lesing, identitet fra konteksten, strengt validert", () => {
  it("slår opp på påstandstekst (trimmet) eller claim_id og leverer rapporten uendret som data", async () => {
    const { port, calls } = fakeClaims();
    const transport = new KnowledgeSearchTransport(fakePort().port, port);
    const out = await transport.invoke("get_claim_status", { claim: "  Jorden er rund  " }, "c", { identity: identity({ memory_space_id: "business" }) });
    expect(out.data).toEqual({ found: false, status: "UNKNOWN", claim: null, notice: "n" });
    expect(calls[0]!.method).toBe("getClaimStatus");
    expect(calls[0]!.args[0]).toMatchObject({ tenant_id: "tenant-know", memory_space_id: "business" });
    expect(calls[0]!.args[1]).toEqual({ claim: "Jorden er rund" });
    await transport.invoke("get_claim_status", { claim_id: "cl-123e4567-e89b" }, "c", { identity: identity() });
    expect(calls[1]!.args[1]).toEqual({ claim_id: "cl-123e4567-e89b" });
  });

  it("modellen kan ikke velge rom/tenant: ekstra felt påvirker ikke kallet (identiteten er den fra konteksten)", async () => {
    const { port, calls } = fakeClaims();
    await new KnowledgeSearchTransport(fakePort().port, port).invoke(
      "get_claim_status", { claim: "påstand om x", memory_space: "health", tenant_id: "tenant-angriper" }, "c", { identity: identity() }
    );
    expect(calls[0]!.args[0]).toMatchObject({ tenant_id: "tenant-know", memory_space_id: "personal" });
    expect(calls[0]!.args[1]).toEqual({ claim: "påstand om x" });
  });

  it("manglende referanse, ugyldig påstand eller ugyldig claim_id feiler lukket UTEN kall; uten port feiler den lukket", async () => {
    const { port, calls } = fakeClaims();
    const transport = new KnowledgeSearchTransport(fakePort().port, port);
    const ctx = { identity: identity() };
    await expect(transport.invoke("get_claim_status", {}, "c", ctx)).rejects.toThrow("missing_parameter:claim");
    for (const bad of ["", "  ", "ab", "x".repeat(1001), 5, null, ["a"]]) {
      await expect(transport.invoke("get_claim_status", { claim: bad as never }, "c", ctx), JSON.stringify(bad)).rejects.toThrow("invalid_parameter:claim");
    }
    for (const bad of ["", "ab", "../etc/passwd", "cl 123", "cl-123'; DROP TABLE x;--", "x".repeat(101), 5, null]) {
      await expect(transport.invoke("get_claim_status", { claim_id: bad as never }, "c", ctx), JSON.stringify(bad)).rejects.toThrow("invalid_parameter:claim_id");
    }
    expect(calls).toHaveLength(0);
    await expect(new KnowledgeSearchTransport(fakePort().port).invoke("get_claim_status", { claim: "påstand om x" }, "c", ctx)).rejects.toThrow("knowledge_claims_not_configured");
  });

  it("skjemaet er strict (kun claim/claim_id), og handlingen er klasse A, ren lesing, ubetrodd output", () => {
    const def = knowledgeToolDefinitions(new KnowledgeSearchTransport(fakePort().port, fakeClaims().port)).find((d) => d.action === "get_claim_status")!;
    expect(def).toMatchObject({ tool_id: "knowledge", capability_class: "A", scopes: ["knowledge.read"], reversible: true, output_trust: "untrusted" });
    const schema = def.input_schema as unknown as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ claim: "Jorden er rund" }).success).toBe(true);
    expect(schema.safeParse({ claim_id: "cl-abc" }).success).toBe(true);
    for (const bad of [{ claim: "ab" }, { claim: "x".repeat(1001) }, { claim_id: "ab" }, { claim: "påstand om x", tenant_id: "t" }, { claim: "påstand om x", memory_space: "health" }, { ekstra: 1 }]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("H: skrive-handlingene i kildeverifiseringen - AV som standard, aldri på en modellflate, strengt validert", () => {
  const writesOn = () => knowledgeToolDefinitions(new KnowledgeSearchTransport(fakePort().port, fullClaims().port), { claimWrites: true });

  it("uten claimWrites registreres de ikke; med claimWrites er de klasse B/write, eier-/system-veier med eget scope", () => {
    const off = knowledgeToolDefinitions(new KnowledgeSearchTransport(fakePort().port, fullClaims().port)).map((d) => d.action);
    expect(off).toEqual(["search", "get_claim_status"]);
    const defs = writesOn();
    expect(defs.map((d) => d.action)).toEqual(["search", "get_claim_status", "register_claim", "add_claim_evidence", "retract_claim_evidence", "propose_claim_promotion"]);
    for (const d of defs.filter((x) => x.action !== "search" && x.action !== "get_claim_status")) {
      expect(d.capability_class, d.action).toBe("B");
      expect(d.scopes, d.action).toEqual(["knowledge.claims.write"]);
      expect(d.output_trust, d.action).toBe("untrusted");
    }
  });

  it("manifestet: skrivingene er internt Jarvis-eide write-handlinger uten NOEN flate, og invariantene består; lese-nivået eksponerer dem ikke for modellen", () => {
    const registry = firstWaveTools({}, { additionalTools: writesOn() });
    const manifest = buildToolManifest(registry);
    for (const action of ["register_claim", "add_claim_evidence", "retract_claim_evidence", "propose_claim_promotion"]) {
      const entry = manifest.get(`knowledge.${action}`)!;
      expect(entry, action).toMatchObject({ owner: "jarvis_core", risk: "B", effect: "write", data_zone: "internal", network: "none", surfaces: [] });
      for (const surface of Object.keys(SURFACE_TOOL_GRANTS) as Array<keyof typeof SURFACE_TOOL_GRANTS>) {
        expect(SURFACE_TOOL_GRANTS[surface].some((g) => g.tool_id === "knowledge" && g.action === action), `${action} på ${surface}`).toBe(false);
      }
    }
    expect(manifest.get("knowledge.get_claim_status")).toMatchObject({ risk: "A", effect: "read", output_trust: "untrusted" });
    expect([...manifest.get("knowledge.get_claim_status")!.surfaces].sort()).toEqual(["voice", "web_chat"]);
    expect(() => assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true })).not.toThrow();
    const names = chatReadTierMeshTools(registry, CHAT_READ_TIER, "read").filter((m) => m.tool_id === "knowledge").map((m) => m.def.name).sort();
    expect(names).toEqual(["knowledge__get_claim_status", "knowledge__search"]);
  });

  it("uten skrive-port avvises hver skrive-handling lukket UTEN kall (selv om en kaller omgår gatewayen og kaller transporten direkte)", async () => {
    const { port, calls } = fakeClaims();
    const transport = new KnowledgeSearchTransport(fakePort().port, port);
    const ctx = { identity: identity() };
    const inputs: Array<[string, Record<string, unknown>]> = [
      ["register_claim", { claim: "Jorden er rund" }],
      ["add_claim_evidence", { claim_id: "cl-abc", stance: "supports", source_ref: "https://ex.org/a" }],
      ["retract_claim_evidence", { claim_id: "cl-abc", evidence_id: "ev-abc", reason: "feil kilde" }],
      ["propose_claim_promotion", { claim_id: "cl-abc" }]
    ];
    for (const [action, params] of inputs) {
      await expect(transport.invoke(action, params as never, "c", ctx), action).rejects.toThrow("knowledge_claim_writes_not_configured");
    }
    expect(calls).toHaveLength(0);
  });

  it("register_claim: grenser på N (2..10) og flaggtyper håndheves; påstanden trimmes; identiteten er den fra konteksten", async () => {
    const { port, calls } = fullClaims();
    const transport = new KnowledgeSearchTransport(fakePort().port, port);
    const ctx = { identity: identity({ memory_space_id: "business" }) };
    await transport.invoke("register_claim", { claim: "  Jorden er rund ", min_independent_sources: 3, time_sensitive: true, start_research: true }, "c", ctx);
    expect(calls[0]!.method).toBe("registerClaim");
    expect(calls[0]!.args[0]).toMatchObject({ memory_space_id: "business" });
    expect(calls[0]!.args[1]).toEqual({ claim: "Jorden er rund", min_independent_sources: 3, time_sensitive: true, start_research: true });
    for (const bad of [{ claim: "ab" }, { claim: 5 }, { claim: "påstand om x", min_independent_sources: 1 }, { claim: "påstand om x", min_independent_sources: 11 }, { claim: "påstand om x", min_independent_sources: 2.5 },
      { claim: "påstand om x", time_sensitive: "ja" }, { claim: "påstand om x", start_research: 1 }]) {
      await expect(transport.invoke("register_claim", bad as never, "c", ctx), JSON.stringify(bad)).rejects.toThrow(/invalid_parameter:/);
    }
    expect(calls).toHaveLength(1);
  });

  it("add_claim_evidence / retract_claim_evidence / propose_claim_promotion: id-formatene valideres og claim_id skilles fra evidensfeltene", async () => {
    const { port, calls } = fullClaims();
    const transport = new KnowledgeSearchTransport(fakePort().port, port);
    const ctx = { identity: identity() };
    await transport.invoke("add_claim_evidence", { claim_id: "cl-abc", stance: "supports", source_ref: "https://ex.org/a", is_primary: true }, "c", ctx);
    expect(calls[0]!.args[1]).toBe("cl-abc");
    expect(calls[0]!.args[2]).toEqual({ stance: "supports", source_ref: "https://ex.org/a", is_primary: true });
    await transport.invoke("retract_claim_evidence", { claim_id: "cl-abc", evidence_id: "ev-abc", reason: "  feil kilde " }, "c", ctx);
    expect(calls[1]!.args.slice(1)).toEqual(["cl-abc", "ev-abc", "feil kilde"]);
    await transport.invoke("propose_claim_promotion", { claim_id: "cl-abc" }, "c", ctx);
    expect(calls[2]!.method).toBe("proposeClaimPromotion");
    for (const [action, params] of [
      ["add_claim_evidence", { claim_id: "../x", stance: "supports", source_ref: "r" }],
      ["retract_claim_evidence", { claim_id: "cl-abc", evidence_id: "ev abc", reason: "r" }],
      ["retract_claim_evidence", { claim_id: "cl-abc", evidence_id: "ev-abc", reason: "   " }],
      ["retract_claim_evidence", { claim_id: "cl-abc", evidence_id: "ev-abc", reason: "x".repeat(301) }],
      ["propose_claim_promotion", { claim_id: "x" }]
    ] as Array<[string, Record<string, unknown>]>) {
      await expect(transport.invoke(action, params as never, "c", ctx), `${action} ${JSON.stringify(params)}`).rejects.toThrow(/invalid_parameter:/);
    }
    expect(calls).toHaveLength(3);
  });

  it("skjemaene er strict: identitetsfelt og ukjente felt avvises, holdning er kun supports/contradicts", () => {
    const byAction = new Map(writesOn().map((d) => [d.action, d.input_schema as unknown as { safeParse: (v: unknown) => { success: boolean } }]));
    expect(byAction.get("add_claim_evidence")!.safeParse({ claim_id: "cl-abc", stance: "supports", source_ref: "r" }).success).toBe(true);
    for (const bad of [{ claim_id: "cl-abc", stance: "maybe", source_ref: "r" }, { claim_id: "cl-abc", stance: "supports", source_ref: "r", tenant_id: "t" }, { claim_id: "cl-abc", stance: "supports", source_ref: "" }]) {
      expect(byAction.get("add_claim_evidence")!.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(byAction.get("register_claim")!.safeParse({ claim: "påstand om x", memory_space: "health" }).success).toBe(false);
    expect(byAction.get("propose_claim_promotion")!.safeParse({ claim_id: "cl-abc", content: "overstyr minnet" }).success).toBe(false);
  });
});

describe("I: utvalg per melding - påstandsfraser velger kunnskapsverktøyene, tilfeldige ord gjør det ikke", () => {
  const registry = firstWaveTools({}, { additionalTools: knowledgeToolDefinitions(new KnowledgeSearchTransport(fakePort().port, fakeClaims().port)) });
  const surface = chatReadTierMeshTools(registry, CHAT_READ_TIER, "read");
  const keys = (text: string) => selectSurfaceTools("web_chat", text, surface).selected.map((m) => `${m.tool_id}.${m.action}`);

  it.each([
    "er påstanden om skatten verifisert?",
    "kan du faktasjekke dette?",
    "hva er verifiseringsstatusen til den påstanden?",
    "er dette bekreftet av flere kilder?"
  ])("«%s» velger knowledge.get_claim_status", (text) => {
    expect(keys(text)).toContain("knowledge.get_claim_status");
  });

  it.each(["hei", "hva er klokka", "bekreft møtet i morgen", "hva synes du om hytta vår"])("«%s» velger IKKE kunnskapsverktøyene", (text) => {
    const selected = keys(text);
    expect(selected).not.toContain("knowledge.get_claim_status");
    expect(selected).not.toContain("knowledge.search");
  });
});
