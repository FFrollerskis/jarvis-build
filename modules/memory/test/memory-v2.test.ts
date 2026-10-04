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
