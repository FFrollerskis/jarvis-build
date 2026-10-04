import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  LocalHashEmbedding,
  MemoryRetriever,
  MemoryWriter,
  OllamaEmbedding,
  OpenAiEmbedding,
  RuleBasedExtractor,
  assertLocalEmbedding,
  createEmbeddingProviderFromEnv,
  itemSensitivity,
  orTsQuery,
  queryTerms,
  runMemoryReembedSweepForAllTenants,
  withMemoryTransaction,
  type EmbeddingProvider,
  type SourceRef
} from "@jarvis/memory";

/**
 * D-386 Minne v2 - slice A: modellbevisst vektorlager, ELLER-fulltekst, RRF-fusjon med viktighet/ferskhet, episode- og
 * sammendragslegg, tokenbudsjett, sist-brukt, profilblokk, innholdsbasert sensitivitet og re-embed-sveip. Alt mot EKTE
 * embedded Postgres (uten pgvector - samme `cosine_sim`-vei som før; pgvector-grenen bekreftes på NAS).
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let writer: MemoryWriter;
let retriever: MemoryRetriever;
let policy: PolicyGateway;

const TRUSTED: SourceRef = { kind: "manual", ref: "seed", trust: "internal" };

function identity(space: MemorySpace, tenant = "tenant-a", person = "person-tobias"): IdentityContext {
  return { person_id: person, tenant_id: tenant, memory_space_id: space, session_id: "sess-v2", device_id: "dev-pc", channel: "web", auth_strength: "active" };
}

function candidate(space: MemorySpace, subject: string, content: string, extra: Record<string, unknown> = {}) {
  return { space, type: "semantic" as const, subject, content, confidence: 0.9, ...extra };
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-memv2-"));
  const leased = await startLeasedEmbeddedPostgres(
    (port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "test-superuser-pw", port, persistent: false }),
    { identity: { user: "postgres", password: "test-superuser-pw", database: "postgres" } }
  );
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "test-superuser-pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'test-app-pw'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a', 'Tobias personlig', 'person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias', 'Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias', 'tenant-a');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-personal', 'tenant-a', 'personal'), ('ms-health', 'tenant-a', 'health');
    INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ('dev-pc', 'tenant-a', 'person-tobias', 'pc');
    INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id, status) VALUES ('sess-v2', 'tenant-a', 'person-tobias', 'web', 'dev-pc', 'active');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test", password: "test-app-pw" });
  policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch() });
  const embeddings = new LocalHashEmbedding();
  writer = new MemoryWriter(appPool, embeddings, new RuleBasedExtractor(), policy);
  retriever = new MemoryRetriever(appPool, embeddings);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: embedding-laget er lokalt, modellbevisst og fail-closed", () => {
  it("assertLocalEmbedding avviser en sky-provider; writer/retriever nekter å konstrueres med OpenAiEmbedding", () => {
    const cloud = new OpenAiEmbedding("dummy-key");
    expect(() => assertLocalEmbedding(cloud)).toThrow(/memory_embedding_must_be_local/);
    expect(() => new MemoryRetriever(appPool, cloud)).toThrow(/memory_embedding_must_be_local/);
    expect(() => new MemoryWriter(appPool, cloud, new RuleBasedExtractor(), policy)).toThrow(/memory_embedding_must_be_local/);
  });

  it("faktory: tom config => local-hash; ollama krever URL; kjent modell gir dimensjon; ukjent provider avvises", () => {
    expect(createEmbeddingProviderFromEnv({}).model).toBe("local-hash-v1");
    expect(() => createEmbeddingProviderFromEnv({ JARVIS_EMBEDDING_PROVIDER: "ollama" })).toThrow(/memory_embedding_url_missing/);
    const p = createEmbeddingProviderFromEnv({ JARVIS_EMBEDDING_PROVIDER: "ollama", JARVIS_GEMMA_LOCAL_URL: "http://10.0.0.1:11434/v1" });
    expect(p).toBeInstanceOf(OllamaEmbedding);
    expect(p.model).toBe("bge-m3");
    expect(p.dim).toBe(1024);
    expect(p.locality).toBe("local");
    expect(createEmbeddingProviderFromEnv({ JARVIS_EMBEDDING_MODEL: "nomic-embed-text", JARVIS_OLLAMA_URL: "http://x:11434" }).dim).toBe(768);
    expect(() => createEmbeddingProviderFromEnv({ JARVIS_EMBEDDING_MODEL: "ukjent-modell", JARVIS_OLLAMA_URL: "http://x" })).toThrow(/dim_unknown/);
    expect(createEmbeddingProviderFromEnv({ JARVIS_EMBEDDING_MODEL: "ukjent-modell", JARVIS_EMBEDDING_DIM: "512", JARVIS_OLLAMA_URL: "http://x" }).dim).toBe(512);
    expect(() => createEmbeddingProviderFromEnv({ JARVIS_EMBEDDING_PROVIDER: "openai" })).toThrow(/provider_unknown/);
  });

  it("OllamaEmbedding: kaller /api/embed med batch, validerer dimensjon, og rapporterer nede tjeneste tydelig", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body });
      const n = (body["input"] as string[]).length;
      return new Response(JSON.stringify({ embeddings: Array.from({ length: n }, () => [0.1, 0.2, 0.3, 0.4]) }), { status: 200 });
    }));
    try {
      const p = new OllamaEmbedding("http://ollama.test:11434/v1/", "tiny", { dim: 4 });
      const vectors = await p.embedBatch(["a", "b"]);
      expect(vectors).toHaveLength(2);
      expect(calls[0]?.url).toBe("http://ollama.test:11434/api/embed");
      expect(calls[0]?.body).toMatchObject({ model: "tiny", input: ["a", "b"], truncate: true });
      const wrongDim = new OllamaEmbedding("http://ollama.test:11434", "tiny", { dim: 8 });
      await expect(wrongDim.embed("x")).rejects.toThrow(/dim_mismatch/);
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
      await expect(p.embed("x")).rejects.toThrow(/memory_embedding_unreachable/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("queryTerms/orTsQuery: stoppord ut, ELLER mellom innholdsord, sanert", () => {
    expect(queryTerms("Hva heter egentlig hunden min?")).toEqual(["heter", "hunden"]);
    expect(orTsQuery(queryTerms("Hva heter egentlig hunden min?"))).toBe("heter | hunden");
    expect(queryTerms("x' OR 1=1 --")).toEqual(["or"]);
    expect(queryTerms("hei")).toEqual([]);
  });

  it("itemSensitivity: helseinnhold i personal-rommet => special; forretning => sensitive; helse-rommet alltid special", () => {
    expect(itemSensitivity("personal", { subject: "tobias.helse", content: "Tobias fikk en ny diagnose i går." })).toBe("special");
    expect(itemSensitivity("personal", { subject: "tobias.okonomi", content: "Saldoen på kontoen er lav." })).toBe("special");
    expect(itemSensitivity("personal", { subject: "firma.kontrakt", content: "Kontrakten med kunden signeres fredag." })).toBe("sensitive");
    expect(itemSensitivity("personal", { subject: "tobias.hund", content: "Hunden heter Rex." })).toBe("normal");
    expect(itemSensitivity("health", { subject: "x", content: "Hunden heter Rex." })).toBe("special");
  });
});

describe("B: skriving går til memory_vectors (modellbevisst), og innholdsbasert sensitivitet lagres", () => {
  it("ADD skriver vektor til memory_vectors med providerens modell; ingen rad i den frosne embeddings-tabellen", async () => {
    const id = identity("personal");
    const out = await writer.apply(id, TRUSTED, candidate("personal", "tobias.hund", "Tobias har en hund som heter Rex zeta91."));
    expect(out.op).toBe("ADD");
    const v = await adminPool.query("SELECT model, dim FROM memory_vectors WHERE ref_kind = 'item' AND ref_id = $1", [out.memory_item_id]);
    expect(v.rows).toEqual([{ model: "local-hash-v1", dim: 64 }]);
    expect((await adminPool.query("SELECT 1 FROM embeddings WHERE memory_item_id = $1", [out.memory_item_id])).rowCount).toBe(0);
  });

  it("helsefaktum fortalt i personal-rommet lagres som sensitivity=special (ikke lenger 'normal')", async () => {
    const out = await writer.apply(identity("personal"), TRUSTED, candidate("personal", "tobias.medisin", "Tobias tar blodtrykksmedisin hver morgen zeta92."));
    const row = await adminPool.query("SELECT sensitivity FROM memory_items WHERE memory_item_id = $1", [out.memory_item_id]);
    expect(row.rows[0]).toEqual({ sensitivity: "special" });
  });

  it("en embedding-feil velter ALDRI minneskrivingen: faktumet lagres, vektoren mangler, og re-embed-sveipet fyller den", async () => {
    const failing: EmbeddingProvider = {
      model: "flaky-local", dim: 64, locality: "local", minSimilarity: 0.6,
      embed: async () => { throw new Error("ollama nede"); },
      embedBatch: async () => { throw new Error("ollama nede"); }
    };
    const w = new MemoryWriter(appPool, failing, new RuleBasedExtractor(), policy);
    const out = await w.apply(identity("personal"), TRUSTED, candidate("personal", "tobias.bil", "Tobias kjører en rød Volvo zeta93."));
    expect(out.op).toBe("ADD");
    expect((await adminPool.query("SELECT 1 FROM memory_vectors WHERE ref_id = $1 AND model = 'flaky-local'", [out.memory_item_id])).rowCount).toBe(0);
    // Sveipet med en fungerende provider under SAMME modellnavn fyller hullet (modellbevisst: kun rader uten vektor for 'flaky-local').
    const working: EmbeddingProvider = { ...failing, embed: (t) => new LocalHashEmbedding().embed(t), embedBatch: (ts) => new LocalHashEmbedding().embedBatch(ts) };
    const summary = await runMemoryReembedSweepForAllTenants(appPool, working, { maxRows: 100, batchSize: 4 });
    expect(summary.failed).toEqual([]);
    expect(summary.embeddedByTenant["tenant-a:personal"]).toBeGreaterThanOrEqual(1);
    expect((await adminPool.query("SELECT 1 FROM memory_vectors WHERE ref_id = $1 AND model = 'flaky-local'", [out.memory_item_id])).rowCount).toBe(1);
  });
});

describe("C: gjenfinning v2 - ELLER-fulltekst, nøkkelord, fusjon, episoder, sammendrag, budsjett, sist brukt", () => {
  const id = identity("personal");

  it("ett ekstra ord i spørsmålet dreper ikke lenger treffet (ELLER-semantikk); treffet rangeres først", async () => {
    await writer.apply(id, TRUSTED, candidate("personal", "tobias.katt", "Tobias har en katt som heter Mons omega77."));
    const hits = await retriever.search(id, { spaces: ["personal"], query: "hva heter egentlig katten min omega77 tror du?" });
    expect(hits[0]?.content).toContain("Mons");
    expect(hits[0]?.kind).toBe("item");
    expect(hits[0]?.via).toBe("search");
  });

  it("nøkkelord (keywords) gir eksakt-navn-treff selv når innholdet er omformulert", async () => {
    const out = await writer.apply(id, TRUSTED, candidate("personal", "prosjekt.hytte", "Hytteprosjektet er i gang omega78."));
    await adminPool.query("UPDATE memory_items SET keywords = ARRAY['fjellheimen','snekkern'] WHERE memory_item_id = $1", [out.memory_item_id]);
    const hits = await retriever.search(id, { spaces: ["personal"], query: "noe om Fjellheimen?" });
    expect(hits.map((h) => h.memory_item_id)).toContain(out.memory_item_id);
  });

  it("viktighet og ferskhet påvirker rangeringen ved likt tekstlig treff", async () => {
    const low = await writer.apply(id, TRUSTED, candidate("personal", "notat.lav", "Tobias nevnte sigma55 i forbifarten."));
    const high = await writer.apply(id, TRUSTED, candidate("personal", "notat.hoy", "Tobias nevnte sigma55 som avgjørende."));
    await adminPool.query("UPDATE memory_items SET importance = 2, observed_at = now() - interval '400 days' WHERE memory_item_id = $1", [low.memory_item_id]);
    await adminPool.query("UPDATE memory_items SET importance = 9 WHERE memory_item_id = $1", [high.memory_item_id]);
    const hits = await retriever.search(id, { spaces: ["personal"], query: "sigma55" });
    const order = hits.filter((h) => [low.memory_item_id, high.memory_item_id].includes(h.memory_item_id)).map((h) => h.memory_item_id);
    expect(order[0]).toBe(high.memory_item_id);
  });

  it("verbatim episoder og sammendrag er søkbare lag; sist-brukt oppdateres på items som returneres", async () => {
    await withMemoryTransaction(appPool, "tenant-a", ["personal"], async (client) => {
      await client.query(
        `INSERT INTO memory_episodes (episode_id, tenant_id, space, owner_person_id, session_id, channel, role, content, content_hash, trust_level)
         VALUES ('ep-1', 'tenant-a', 'personal', 'person-tobias', 'sess-v2', 'web', 'user', 'Jeg skal på fisketur med Dennis på lørdag kappa31.', 'h1', 'trusted')`
      );
      await client.query(
        `INSERT INTO summaries (summary_id, tenant_id, space, scope, scope_key, content)
         VALUES ('sum-1', 'tenant-a', 'personal', 'daily', '2026-09-01', 'Dagssammendrag: planla fisketur kappa31 og handlet.')`
      );
    });
    const hits = await retriever.search(id, { spaces: ["personal"], query: "fisketur kappa31" });
    expect(hits.map((h) => h.kind)).toEqual(expect.arrayContaining(["episode", "summary"]));
    const item = await writer.apply(id, TRUSTED, candidate("personal", "tobias.fiske", "Tobias liker fisketur kappa31."));
    const before = await adminPool.query("SELECT access_count, last_accessed_at FROM memory_items WHERE memory_item_id = $1", [item.memory_item_id]);
    expect(before.rows[0]).toEqual({ access_count: 0, last_accessed_at: null });
    await retriever.search(id, { spaces: ["personal"], query: "fisketur kappa31" });
    const after = await adminPool.query("SELECT access_count, last_accessed_at FROM memory_items WHERE memory_item_id = $1", [item.memory_item_id]);
    expect(after.rows[0].access_count).toBe(1);
    expect(after.rows[0].last_accessed_at).not.toBeNull();
    const untouched = await retriever.search(id, { spaces: ["personal"], query: "fisketur kappa31", touch: false });
    expect(untouched.length).toBeGreaterThan(0);
    expect((await adminPool.query("SELECT access_count FROM memory_items WHERE memory_item_id = $1", [item.memory_item_id])).rows[0].access_count).toBe(1);
  });

  it("kontekstblokk: profil alltid først, tokenbudsjett respekteres, og linjene bærer type/dato/kilde", async () => {
    await withMemoryTransaction(appPool, "tenant-a", ["personal"], (client) =>
      client.query("INSERT INTO memory_profiles (tenant_id, space, content) VALUES ('tenant-a', 'personal', '- Tobias bor i Oslo\n- Har hund (Rex) og katt (Mons)')")
    );
    for (let i = 0; i < 12; i++) {
      await writer.apply(id, TRUSTED, candidate("personal", `lambda.${i}`, `Faktum nummer ${i} om lambda44 med en del ekstra tekst som fyller budsjettet ganske raskt ${"x".repeat(80)}.`));
    }
    const full = await retriever.contextWithMeta(id, "lambda44", { budgetTokens: 5000 });
    expect(full.profile_included).toBe(true);
    expect(full.text.startsWith("Profil (det Jarvis vet om eieren")).toBe(true);
    expect(full.text).toContain("Relevant minne (med kilde):");
    expect(full.text).toMatch(/- \[fakta · \d{4}-\d{2}-\d{2}\] Faktum nummer \d+ om lambda44 .* \[kilde: manual:seed\]/);
    const tight = await retriever.contextWithMeta(id, "lambda44", { budgetTokens: 250 });
    expect(tight.profile_included).toBe(true);
    expect(tight.item_count).toBeLessThan(full.item_count);
    expect(tight.item_count).toBeGreaterThanOrEqual(1);
    expect(full.spaces).toEqual(["personal"]);
  });

  it("D-384 bevart: special-faktum i personal-rommet og episode i helse-rommet tas KUN med ved direkte treff", async () => {
    const special = await writer.apply(id, TRUSTED, candidate("personal", "tobias.diagnose", "Tobias har diabetes type 2 rho66."));
    expect((await adminPool.query("SELECT sensitivity FROM memory_items WHERE memory_item_id = $1", [special.memory_item_id])).rows[0].sensitivity).toBe("special");
    const direct = await retriever.contextWithMeta(id, "rho66 diabetes");
    expect(direct.text).toContain("rho66");
    expect(direct.sensitivities).toContain("special");
    const weak = await retriever.contextWithMeta(id, "rho66 diabetes", { restrictedMinScore: 1.5 });
    expect(weak.text).not.toContain("rho66");
    expect(weak.withheld_restricted).toBeGreaterThanOrEqual(1);
    expect(weak.sensitivities).not.toContain("special");
  });

  it("timeref: historiske versjoner kommer med EKTE proveniens (type/kilde fra item), ikke fabrikkert", async () => {
    const first = await writer.apply(id, TRUSTED, candidate("personal", "tobias.jobb", "Tobias jobber hos Alfa AS tau12."));
    await adminPool.query("UPDATE memory_items SET valid_from = now() - interval '30 days' WHERE memory_item_id = $1", [first.memory_item_id]);
    await writer.apply(id, TRUSTED, candidate("personal", "tobias.jobb", "Tobias jobber hos Beta AS tau12."));
    const then = new Date(Date.now() - 10 * 86_400_000);
    const hits = await retriever.search(id, { spaces: ["personal"], query: "tau12", timeref: then });
    const old = hits.find((h) => h.content.includes("Alfa AS"));
    expect(old).toBeDefined();
    expect(old?.type).toBe("semantic");
    expect(old?.source.kind).toBe("manual");
    expect(old?.source.ref).toMatch(/^seed \(v1\)$/);
  });
});

describe("D (slice B): skrivevei v2 - episoder, konfidensgate, negasjon, trivial-gating, betrodd overstyrer karantene", () => {
  const id = { ...identity("personal"), session_id: "sess-v2-b" };
  const CONV: SourceRef = { kind: "conversation", ref: "sess-v2-b", trust: "trusted" };

  /** Skriptet uttrekk: returnerer kandidater per tekst (DB-fri, som FakeCompleter-mønsteret i llm-extraction.test.ts). */
  function scripted(map: Record<string, Array<Record<string, unknown>>>) {
    const seen: Array<{ text: string; context: unknown; hints: number }> = [];
    const extractor = {
      async extract(text: string, ident: IdentityContext, _t: unknown, existing: unknown[] = [], context: unknown) {
        seen.push({ text, context, hints: existing.length });
        return (map[text] ?? []).map((c) => ({ space: ident.memory_space_id, confidence: 0.9, type: "semantic", ...c }));
      }
    };
    return { extractor, seen };
  }

  it("verbatim ytring lagres som episode med bevis-peker fra faktumet, med vektor, dedupet per sesjon; trivielle ytringer hopper over alt", async () => {
    const { extractor, seen } = scripted({
      "Søsteren min heter Ida og bor i Tromsø phi21.": [{ subject: "tobias.soster", content: "Tobias sin søster heter Ida og bor i Tromsø phi21.", type: "relation", keywords: ["Ida", "Tromsø"], importance: 8, entities: [{ kind: "person", name: "Ida" }] }]
    });
    const w = new MemoryWriter(appPool, new LocalHashEmbedding(), extractor as never, policy);
    expect(await w.ingestText(id, CONV, "ok takk!")).toEqual([]);
    expect(await w.ingestText(id, CONV, "hei")).toEqual([]);
    expect(seen).toHaveLength(0);
    const out = await w.ingestText(id, CONV, "Søsteren min heter Ida og bor i Tromsø phi21.", { recent_turns: [{ role: "assistant", content: "Har du søsken?" }], channel: "voice" });
    expect(out[0]?.op).toBe("ADD");
    expect(seen[0]?.hints).toBeGreaterThanOrEqual(0);
    expect((seen[0]?.context as { observed_at?: string }).observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const ep = await adminPool.query("SELECT episode_id, content, channel, sensitivity, role FROM memory_episodes WHERE session_id = 'sess-v2-b' AND content LIKE '%phi21%'");
    expect(ep.rowCount).toBe(1);
    expect(ep.rows[0]).toMatchObject({ content: "Søsteren min heter Ida og bor i Tromsø phi21.", channel: "voice", sensitivity: "normal", role: "user" });
    const item = await adminPool.query("SELECT evidence_episode_id, keywords, importance FROM memory_items WHERE memory_item_id = $1", [(out[0] as { memory_item_id: string }).memory_item_id]);
    expect(item.rows[0]).toEqual({ evidence_episode_id: ep.rows[0].episode_id, keywords: ["ida", "tromsø"], importance: 8 });
    expect((await adminPool.query("SELECT 1 FROM memory_vectors WHERE ref_kind = 'episode' AND ref_id = $1", [ep.rows[0].episode_id])).rowCount).toBe(1);
    // Entitet lenket med tenant-skopet id
    const ent = await adminPool.query("SELECT e.entity_id, e.name FROM memory_item_entities me JOIN entities e ON e.entity_id = me.entity_id WHERE me.memory_item_id = $1", [(out[0] as { memory_item_id: string }).memory_item_id]);
    expect(ent.rows[0]?.name).toBe("Ida");
    expect(String(ent.rows[0]?.entity_id)).toMatch(/^ent-[0-9a-f]{24}$/);
    // Samme ytring en gang til i samme sesjon: ingen ny episode
    await w.ingestText(id, CONV, "Søsteren min heter Ida og bor i Tromsø phi21.");
    expect((await adminPool.query("SELECT count(*)::int AS n FROM memory_episodes WHERE session_id = 'sess-v2-b' AND content LIKE '%phi21%'")).rows[0].n).toBe(1);
    // Episoden er søkbar verbatim
    const hits = await retriever.search(id, { spaces: ["personal"], query: "phi21 Tromsø", kinds: ["episode"] });
    expect(hits[0]?.kind).toBe("episode");
  });

  it("lav konfidens fra betrodd kilde => karantene (synlig som forslag), ikke aktivt minne; betrodd høy-konfidens overstyrer karantene senere", async () => {
    const { extractor } = scripted({
      "Tror kanskje Ola har bursdag i mai chi33?": [{ subject: "ola.bursdag", content: "Ola har bursdag i mai chi33.", confidence: 0.3 }],
      "Ola har bursdag 12. mai chi33.": [{ subject: "ola.bursdag", content: "Ola har bursdag 12. mai chi33.", confidence: 0.95, contradicts_existing: false }]
    });
    const w = new MemoryWriter(appPool, new LocalHashEmbedding(), extractor as never, policy);
    const low = await w.ingestText(id, CONV, "Tror kanskje Ola har bursdag i mai chi33?");
    expect(low[0]).toMatchObject({ op: "ADD", status: "quarantined" });
    expect((await retriever.search(id, { spaces: ["personal"], query: "chi33" })).map((h) => h.memory_item_id)).not.toContain((low[0] as { memory_item_id: string }).memory_item_id);
    expect((await w.listProposals(id)).map((p) => p.memory_item_id)).toContain((low[0] as { memory_item_id: string }).memory_item_id);
    const high = await w.ingestText(id, CONV, "Ola har bursdag 12. mai chi33.");
    expect(high[0]).toMatchObject({ op: "UPDATE", conflict: false });
    const row = await adminPool.query("SELECT status, has_conflict, content FROM memory_items WHERE memory_item_id = $1", [(high[0] as { memory_item_id: string }).memory_item_id]);
    expect(row.rows[0]).toEqual({ status: "active", has_conflict: false, content: "Ola har bursdag 12. mai chi33." });
  });

  it("negasjon (op INVALIDATE) invaliderer det aktive minnet - aldri sletting; hendelsestid blir valid_from (bitemporalt)", async () => {
    const { extractor } = scripted({
      "Jeg skal til tannlegen neste fredag psi44.": [{ subject: "tobias.tannlege", content: "Tobias skal til tannlegen psi44.", type: "commitment", event_time: "2026-10-09", event_time_raw: "neste fredag" }],
      "Glem det med tannlegen psi44, den er avlyst.": [{ subject: "tobias.tannlege", content: "Tannlegetimen er avlyst.", type: "commitment", op: "INVALIDATE" }]
    });
    const w = new MemoryWriter(appPool, new LocalHashEmbedding(), extractor as never, policy);
    const add = await w.ingestText(id, CONV, "Jeg skal til tannlegen neste fredag psi44.");
    const itemId = (add[0] as { memory_item_id: string }).memory_item_id;
    const row = await adminPool.query("SELECT valid_from::date::text AS vf, event_time_raw, importance FROM memory_items WHERE memory_item_id = $1", [itemId]);
    expect(row.rows[0]).toEqual({ vf: "2026-10-09", event_time_raw: "neste fredag", importance: 8 });
    const neg = await w.ingestText(id, CONV, "Glem det med tannlegen psi44, den er avlyst.");
    expect(neg[0]).toEqual({ op: "INVALIDATE", memory_item_id: itemId });
    expect((await adminPool.query("SELECT status FROM memory_items WHERE memory_item_id = $1", [itemId])).rows[0].status).toBe("invalidated");
    expect((await adminPool.query("SELECT change_kind FROM memory_versions WHERE memory_item_id = $1", [itemId])).rows.map((r) => r.change_kind)).toContain("invalidated");
  });

  it("én kandidat som feiler mister ikke resten (isolert per kandidat)", async () => {
    const { extractor } = scripted({
      "To ting omega12.": [
        { subject: "ugyldig.type", content: "Ugyldig type omega12.", type: "bogus" },
        { subject: "ok.emne", content: "Gyldig faktum omega12." }
      ]
    });
    const w = new MemoryWriter(appPool, new LocalHashEmbedding(), extractor as never, policy);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const out = await w.ingestText(id, CONV, "To ting omega12.");
      expect(out.map((o) => o.op)).toEqual(["ADD"]);
      expect(spy.mock.calls.some((c) => String(c[0]).includes("memory_candidate_apply_failed"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
