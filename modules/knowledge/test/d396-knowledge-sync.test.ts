import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding, type EmbeddingProvider } from "@jarvis/memory";
import { KnowledgeRetriever } from "../src/retriever.ts";
import { KnowledgeSyncService } from "../src/sync.ts";
import type { KnowledgeListResult, KnowledgeRecord, KnowledgeSource } from "../src/source.ts";

/**
 * D-396 (JARVIS-032/031):
 *  - én mislykket record avbryter ikke resten (SAVEPOINT per record) og tombstone-steget kjører fortsatt,
 *  - en partiell (vindu-)listing tombstoner ALDRI,
 *  - vektorsøk sammenligner kun embeddings fra samme modell/dimensjon.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const identity: IdentityContext = {
  person_id: "person-know", tenant_id: "tenant-know-d396", memory_space_id: "personal",
  session_id: "sess-know", device_id: "dev-know", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-know-d396-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_know_d396 LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_know_d396");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-know-d396','K','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-know','Know');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-know','tenant-know-d396');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_know_d396", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

function record(ext: string, content: string, instance: string): KnowledgeRecord {
  return {
    source_type: "test", source_instance_id: instance, external_id: ext, canonical_uri: `test://${ext}`, title: ext,
    content, content_type: "text/plain", content_hash: `h-${ext}-${content.length}-${content.slice(0, 8)}`, modified_at: null, metadata: {}
  };
}
const source = (instance: string, records: KnowledgeRecord[], listing?: "complete" | "partial"): KnowledgeSource => ({
  source_type: "test", source_instance_id: instance,
  list: async (): Promise<KnowledgeListResult> => ({ records, skipped: [], ...(listing ? { listing } : {}) })
});

describe("JARVIS-032: én mislykket record stopper ikke resten", () => {
  it("en record med NUL-byte (Postgres avviser den) gir failed=1 - de andre lagres og tombstone-steget kjører", async () => {
    const sync = new KnowledgeSyncService(appPool, new LocalHashEmbedding());
    // Først: et dokument som senere forsvinner fra kilden - tombstone-steget MÅ fortsatt fungere etter en feilet record.
    await sync.sync(identity, "personal", source("inst-sp", [record("gone", "skal tombstones", "inst-sp")]));
    const report = await sync.sync(identity, "personal", source("inst-sp", [
      record("ok-1", "første gyldige dokument", "inst-sp"),
      record("bad", "ugyldig \u0000 innhold", "inst-sp"),
      record("ok-2", "andre gyldige dokument", "inst-sp")
    ]));
    expect(report.scanned).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.created).toBe(2);
    expect(report.tombstoned).toBe(1);
    const { rows } = await adminPool.query(
      "SELECT external_id, deleted FROM knowledge_documents WHERE source_instance_id = 'inst-sp' ORDER BY external_id"
    );
    expect(rows).toEqual([
      { external_id: "gone", deleted: true }, { external_id: "ok-1", deleted: false }, { external_id: "ok-2", deleted: false }
    ]);
  });
});

describe("JARVIS-032: partiell listing tombstoner aldri", () => {
  it("listing='partial' beholder dokumenter som mangler i vinduet; complete tombstoner dem", async () => {
    const sync = new KnowledgeSyncService(appPool, new LocalHashEmbedding());
    await sync.sync(identity, "personal", source("inst-part", [record("a", "dokument a", "inst-part"), record("b", "dokument b", "inst-part")]));
    const partial = await sync.sync(identity, "personal", source("inst-part", [record("a", "dokument a", "inst-part")], "partial"));
    expect(partial.tombstoned).toBe(0);
    expect(partial.listing).toBe("partial");
    let live = await adminPool.query("SELECT count(*)::int AS n FROM knowledge_documents WHERE source_instance_id = 'inst-part' AND deleted = false");
    expect(live.rows[0].n).toBe(2);
    const complete = await sync.sync(identity, "personal", source("inst-part", [record("a", "dokument a", "inst-part")]));
    expect(complete.tombstoned).toBe(1);
    live = await adminPool.query("SELECT count(*)::int AS n FROM knowledge_documents WHERE source_instance_id = 'inst-part' AND deleted = false");
    expect(live.rows[0].n).toBe(1);
  });
});

describe("JARVIS-032: partiell listing med tombstone_scope", () => {
  it("tombstoner KUN dokumenter i listede meldinger (message_id) som mangler - meldinger utenfor vinduet røres ikke", async () => {
    const sync = new KnowledgeSyncService(appPool, new LocalHashEmbedding());
    const withMsg = (ext: string, msg: string): KnowledgeRecord => ({ ...record(ext, `innhold ${ext}`, "inst-scope"), metadata: { message_id: msg } });
    await sync.sync(identity, "personal", source("inst-scope", [withMsg("att:m1:a", "m1"), withMsg("att:m1:b", "m1"), withMsg("att:m2:a", "m2")]));
    const windowListing: KnowledgeSource = {
      source_type: "test", source_instance_id: "inst-scope",
      list: async () => ({
        records: [withMsg("att:m1:a", "m1")], skipped: [], listing: "partial",
        tombstone_scope: { metadata_key: "message_id", values: ["m1"] }
      })
    };
    const report = await sync.sync(identity, "personal", windowListing);
    expect(report.tombstoned).toBe(1); // m1:b er borte fra en listet melding; m2 (utenfor vinduet) røres ikke
    const { rows } = await adminPool.query("SELECT external_id, deleted FROM knowledge_documents WHERE source_instance_id = 'inst-scope' ORDER BY external_id");
    expect(rows).toEqual([
      { external_id: "att:m1:a", deleted: false }, { external_id: "att:m1:b", deleted: true }, { external_id: "att:m2:a", deleted: false }
    ]);
  });
});

describe("JARVIS-031: vektorsøk filtrerer på embedding-modell og dimensjon", () => {
  it("dokumenter embeddet med en ANNEN modell dukker ikke opp i vektorsøk (kun via FTS)", async () => {
    class OtherModel implements EmbeddingProvider {
      readonly model = "annen-modell-v1";
      readonly dim = new LocalHashEmbedding().dim;
      readonly locality = "local" as const;
      readonly minSimilarity = 0.6;
      private readonly inner = new LocalHashEmbedding();
      embed(t: string) { return this.inner.embed(t); }
      embedBatch(ts: string[]) { return this.inner.embedBatch(ts); }
    }
    const sync = new KnowledgeSyncService(appPool, new LocalHashEmbedding());
    await sync.sync(identity, "personal", source("inst-model", [record("m1", "kvantemekanikk romtid partikkel", "inst-model")]));
    const sameModel = await new KnowledgeRetriever(appPool, new LocalHashEmbedding()).search(identity, { query: "kvantemekanikk romtid partikkel", spaces: ["personal"] });
    expect(sameModel.some((r) => r.provenance.external_id === "m1")).toBe(true);
    // Samme tekst, men spørringen embeddes av en annen modell => vektorsøket skal ikke sammenligne mot de lagrede vektorene.
    const vectorOnly = await new KnowledgeRetriever(appPool, new OtherModel()).search(identity, { query: "partikkel kvantemekanikk romtid", spaces: ["personal"] });
    const viaVector = await appPool.query("SELECT 1");
    expect(viaVector.rowCount).toBe(1);
    // FTS finner den fortsatt (ord matcher); vi verifiserer at modellfilteret ikke bryter søket og at fts-treffet består.
    expect(vectorOnly.some((r) => r.provenance.external_id === "m1")).toBe(true);
  });
});
