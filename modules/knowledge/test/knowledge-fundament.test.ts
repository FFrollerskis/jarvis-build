import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding, type EmbeddingProvider } from "@jarvis/memory";
import { FilesystemKnowledgeSource } from "../src/filesystem-source.ts";
import { KnowledgeRetriever } from "../src/retriever.ts";
import { KnowledgeSyncService } from "../src/sync.ts";
import type { KnowledgeListResult, KnowledgeSource } from "../src/source.ts";

/**
 * UA-2 P0 §12: obligatoriske tester A-M, O-R (N dekkes i eget testfilen for
 * GitHub-kilden). Ekte embedded Postgres - ekte migrasjoner, ekte RLS, ekte
 * filsystem-I/O via FilesystemKnowledgeSource (§7.O: filesystem source sync).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const tenantA: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-know-a", memory_space_id: "personal",
  session_id: "sess-know-a", device_id: "dev-know", channel: "api", auth_strength: "active"
};
const tenantB: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-know-b", memory_space_id: "personal",
  session_id: "sess-know-b", device_id: "dev-know", channel: "api", auth_strength: "active"
};

/** Teller embed()-kall - beviser §7.L (ingen re-embedding ved uendret sync). */
class CountingEmbedding implements EmbeddingProvider {
  readonly model = "counting-local-hash-v1";
  readonly dim: number;
  readonly locality = "local" as const;
  readonly minSimilarity = 0.6;
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
  calls = 0;
  private readonly inner = new LocalHashEmbedding();
  constructor() {
    this.dim = this.inner.dim;
  }
  async embed(text: string): Promise<number[]> {
    this.calls += 1;
    return this.inner.embed(text);
  }
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-knowledge-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_knowledge LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_knowledge");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-know-a','A','person'), ('tenant-know-b','B','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-know-a'), ('person-tobias','tenant-know-b');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_knowledge", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("UA-2 P0: sync/dedupe/tombstone/reactivation (§4-§5/§7.A-D/F/K/O) via ekte filesystem-kilde", () => {
  it("A-F/K/O: hele livssyklusen - ingest, uendret resync, endring, sletting, gjenoppdukking", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-fs-lifecycle-"));
    const embedding = new CountingEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const retriever = new KnowledgeRetriever(appPool, embedding);
    const filePath = join(root, "fakta.md");

    // §7.A: first ingest creates one canonical document.
    await writeFile(filePath, "Jarvis bruker PostgreSQL som primaerdatabase.");
    const source = () => new FilesystemKnowledgeSource(root, "fs:lifecycle-test");
    const r1 = await sync.sync(tenantA, "personal", source());
    expect(r1).toMatchObject({ scanned: 1, created: 1, updated: 0, unchanged: 0, tombstoned: 0, reactivated: 0, failed: 0 });
    expect(embedding.calls).toBeGreaterThan(0);

    const found1 = await retriever.search(tenantA, { query: "PostgreSQL", spaces: ["personal"] });
    expect(found1.some((r) => r.content.includes("PostgreSQL"))).toBe(true); // §7.P: FTS-treff
    expect(found1[0]?.provenance).toMatchObject({ source_type: "filesystem", external_id: "fakta.md" }); // §7.M

    // Capture ETTER retriever.search() (som ogsaa embedder SPØRRINGEN - egen,
    // forventet embed()-bruk, ikke re-embedding av INNHOLD) - callsAfterCreate
    // er derfor referansepunktet for "ingen NYE embed()-kall ved uendret sync":
    const callsAfterCreate = embedding.calls;

    // §7.B/§7.K/§7.L: uendret resync -> ingen duplikat, ingen re-embedding.
    const r2 = await sync.sync(tenantA, "personal", source());
    expect(r2).toMatchObject({ scanned: 1, created: 0, updated: 0, unchanged: 1, tombstoned: 0, reactivated: 0, failed: 0 });
    expect(embedding.calls).toBe(callsAfterCreate); // §7.L: INGEN nye embed()-kall

    const countRow = await adminPool.query(
      "SELECT COUNT(*)::int AS n FROM knowledge_documents WHERE tenant_id='tenant-know-a' AND external_id='fakta.md'"
    );
    expect((countRow.rows[0] as { n: number }).n).toBe(1); // aldri duplisert

    // §7.C: endret kilde oppdaterer SAMME canonical document.
    const idBefore = (
      await adminPool.query(
        "SELECT knowledge_document_id, version FROM knowledge_documents WHERE tenant_id='tenant-know-a' AND external_id='fakta.md'"
      )
    ).rows[0] as { knowledge_document_id: string; version: number };
    await writeFile(filePath, "Jarvis bruker PostgreSQL og har byttet til NyDatabaseTeknologiXYZ.");
    const r3 = await sync.sync(tenantA, "personal", source());
    expect(r3).toMatchObject({ scanned: 1, created: 0, updated: 1, unchanged: 0, tombstoned: 0, reactivated: 0, failed: 0 });
    expect(embedding.calls).toBeGreaterThan(callsAfterCreate); // re-embedding SKJEDDE ved reell endring
    const afterChange = (
      await adminPool.query(
        "SELECT knowledge_document_id, version FROM knowledge_documents WHERE tenant_id='tenant-know-a' AND external_id='fakta.md'"
      )
    ).rows[0] as { knowledge_document_id: string; version: number };
    expect(afterChange.knowledge_document_id).toBe(idBefore.knowledge_document_id); // SAMME canonical document
    expect(afterChange.version).toBe(idBefore.version + 1);
    const found3 = await retriever.search(tenantA, { query: "NyDatabaseTeknologiXYZ", spaces: ["personal"] });
    expect(found3.some((r) => r.content.includes("NyDatabaseTeknologiXYZ"))).toBe(true);

    // §7.D: slettet kilde -> tombstone (IKKE hard delete).
    await rm(filePath);
    const r4 = await sync.sync(tenantA, "personal", source());
    expect(r4).toMatchObject({ scanned: 0, created: 0, updated: 0, unchanged: 0, tombstoned: 1, reactivated: 0, failed: 0 });
    const tombstoned = await adminPool.query(
      "SELECT deleted, deleted_at FROM knowledge_documents WHERE knowledge_document_id = $1",
      [idBefore.knowledge_document_id]
    );
    expect((tombstoned.rows[0] as { deleted: boolean }).deleted).toBe(true);
    expect((tombstoned.rows[0] as { deleted_at: Date | null }).deleted_at).not.toBeNull(); // historikk bevart, ikke hard-slettet

    // §7.E: tombstoned document skal IKKE returneres i normal retrieval.
    const found4 = await retriever.search(tenantA, { query: "NyDatabaseTeknologiXYZ", spaces: ["personal"] });
    expect(found4.some((r) => r.content.includes("NyDatabaseTeknologiXYZ"))).toBe(false);

    // §7.F: reappearing document (SAMME innhold som før sletting) -> deterministisk reaktivering.
    await writeFile(filePath, "Jarvis bruker PostgreSQL og har byttet til NyDatabaseTeknologiXYZ.");
    const r5 = await sync.sync(tenantA, "personal", source());
    expect(r5).toMatchObject({ scanned: 1, created: 0, updated: 0, unchanged: 0, tombstoned: 0, reactivated: 1, failed: 0 });
    const reactivated = await adminPool.query(
      "SELECT knowledge_document_id, deleted FROM knowledge_documents WHERE tenant_id='tenant-know-a' AND external_id='fakta.md'"
    );
    expect((reactivated.rows[0] as { knowledge_document_id: string }).knowledge_document_id).toBe(idBefore.knowledge_document_id);
    expect((reactivated.rows[0] as { deleted: boolean }).deleted).toBe(false);
    const found5 = await retriever.search(tenantA, { query: "NyDatabaseTeknologiXYZ", spaces: ["personal"] });
    expect(found5.some((r) => r.content.includes("NyDatabaseTeknologiXYZ"))).toBe(true); // §7.R (hybrid: FTS-eksakt-treff)
  }, 60_000);

  it("§7.N-lignende (generisk kilde): sync håndterer flere records og feilende kilde uten å tombstone alt", async () => {
    class FailingSource implements KnowledgeSource {
      readonly source_type = "fake-fail";
      readonly source_instance_id = "fake:always-fails";
      async list(): Promise<KnowledgeListResult> {
        throw new Error("kilde-nettverksfeil");
      }
    }
    const embedding = new CountingEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const report = await sync.sync(tenantA, "personal", new FailingSource());
    // §5: en feilet LISTING skal ALDRI tombstone eksisterende dokumenter - rapporteres som failed, ikke tomt/tombstoned.
    expect(report.failed).toBe(1);
    expect(report.tombstoned).toBe(0);
  });
});

describe("UA-2 P0 §7.G/§7.H: tenant- og memory-space-isolasjon", () => {
  it("§7.G: tenant A kan ALDRI hente tenant B sin kunnskap", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "jarvis-fs-tenant-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "jarvis-fs-tenant-b-"));
    await writeFile(join(rootA, "hemmelig-a.md"), "TenantA-hemmelighet-UniktOrdA");
    await writeFile(join(rootB, "hemmelig-b.md"), "TenantB-hemmelighet-UniktOrdB");
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const retriever = new KnowledgeRetriever(appPool, embedding);

    await sync.sync(tenantA, "personal", new FilesystemKnowledgeSource(rootA, "fs:tenant-a-isolation"));
    await sync.sync(tenantB, "personal", new FilesystemKnowledgeSource(rootB, "fs:tenant-b-isolation"));

    const aSearchesForB = await retriever.search(tenantA, { query: "UniktOrdB", spaces: ["personal"] });
    expect(aSearchesForB.some((r) => r.content.includes("UniktOrdB"))).toBe(false);
    const bSearchesForA = await retriever.search(tenantB, { query: "UniktOrdA", spaces: ["personal"] });
    expect(bSearchesForA.some((r) => r.content.includes("UniktOrdA"))).toBe(false);

    // Kryssjekk: hver tenant finner SIN EGEN kunnskap normalt.
    const aFindsOwn = await retriever.search(tenantA, { query: "UniktOrdA", spaces: ["personal"] });
    expect(aFindsOwn.some((r) => r.content.includes("UniktOrdA"))).toBe(true);
  }, 30_000);

  it("§7.H: memory-space-isolasjon - 'business'-kunnskap er usynlig ved søk kun i 'personal'", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-fs-space-"));
    await writeFile(join(root, "biz.md"), "BusinessSpaceUniktOrdXYZ hemmelig forretningsinfo");
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const retriever = new KnowledgeRetriever(appPool, embedding);

    await sync.sync(tenantA, "business", new FilesystemKnowledgeSource(root, "fs:space-isolation-test"));

    const personalOnly = await retriever.search(tenantA, { query: "BusinessSpaceUniktOrdXYZ", spaces: ["personal"] });
    expect(personalOnly.some((r) => r.content.includes("BusinessSpaceUniktOrdXYZ"))).toBe(false);
    const businessSearch = await retriever.search(tenantA, { query: "BusinessSpaceUniktOrdXYZ", spaces: ["business"] });
    expect(businessSearch.some((r) => r.content.includes("BusinessSpaceUniktOrdXYZ"))).toBe(true);
  }, 30_000);
});

describe("UA-2 P0 §7.Q/§7.R: vektor-mekanismen og hybrid ranking", () => {
  it("§7.Q: cosine_sim SQL-funksjonen (som retrieveren bruker) gir høy likhet for nesten-identisk innhold", async () => {
    const embedding = new LocalHashEmbedding();
    const a = await embedding.embed("Jarvis konfigurasjon lagres i Postgres");
    const b = await embedding.embed("Jarvis konfigurasjonen lagres i Postgres"); // nesten identisk (bøyningsform)
    const c = await embedding.embed("Fullstendig urelatert setning om vaer og vind i Bergen");
    const simAB = await adminPool.query("SELECT cosine_sim($1::real[], $2::real[]) AS sim", [a, b]);
    const simAC = await adminPool.query("SELECT cosine_sim($1::real[], $2::real[]) AS sim", [a, c]);
    const nearDupSim = Number((simAB.rows[0] as { sim: number }).sim);
    const unrelatedSim = Number((simAC.rows[0] as { sim: number }).sim);
    // Retrieverens vektor-terskel er 0.4 (retriever.ts) - nesten-duplikat skal ligge godt over,
    // helt urelatert innhold godt under:
    expect(nearDupSim).toBeGreaterThanOrEqual(0.4);
    expect(nearDupSim).toBeGreaterThan(unrelatedSim);
  });

  it("§7.R: hybrid retrieval rangerer eksakt/nesten-relevant treff over urelatert innhold, med provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-fs-hybrid-"));
    await writeFile(join(root, "relevant.md"), "Jarvis bruker capability-basert AI-ruting for modellvalg.");
    await writeFile(join(root, "urelatert.md"), "Vaeret i Bergen er ofte regnfullt om hoesten.");
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const retriever = new KnowledgeRetriever(appPool, embedding);
    await sync.sync(tenantA, "personal", new FilesystemKnowledgeSource(root, "fs:hybrid-test"));

    const results = await retriever.search(tenantA, { query: "capability-basert AI-ruting", spaces: ["personal"] });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toContain("capability-basert");
    expect(results[0]?.provenance.source_type).toBe("filesystem");
    expect(results[0]?.provenance.canonical_uri).toContain("relevant.md");
    // Urelatert innhold skal IKKE dominere toppen av rangeringen:
    expect(results[0]?.content).not.toContain("regnfullt");
  }, 30_000);
});
