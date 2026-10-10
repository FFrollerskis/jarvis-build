import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding } from "@jarvis/memory";
import { MeetingTranscriptKnowledgeSource } from "../src/meeting-transcript-source.ts";
import { KnowledgeRetentionService } from "../src/retention.ts";
import { KnowledgeRetriever } from "../src/retriever.ts";
import { KnowledgeSyncService } from "../src/sync.ts";
import type { KnowledgeListResult, KnowledgeRecord, KnowledgeSource } from "../src/source.ts";

/**
 * WP-D1 (UA-2): beskyttede prefikser i tombstone-steget, oppbevaringsfrist i synk, fysisk fjerning (med alt avledet) i `KnowledgeRetentionService`, og møtetranskripter hele veien
 * (fil -> synk -> søketreff) mot EKTE Postgres som app-rolle.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const embedding = new LocalHashEmbedding();
let sync: KnowledgeSyncService;
let retention: KnowledgeRetentionService;
let retriever: KnowledgeRetriever;

const TENANT = "tenant-wpd1-ret";
const identity = (space: MemorySpace = "personal"): IdentityContext => ({
  person_id: "person-ret", tenant_id: TENANT, memory_space_id: space, session_id: "sess-ret", device_id: "dev-ret", channel: "api", auth_strength: "active"
});
const NOW = new Date("2026-06-01T12:00:00Z");
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function record(instance: string, ext: string, content: string, modifiedAt: string | null = null, type = "test"): KnowledgeRecord {
  return {
    source_type: type, source_instance_id: instance, external_id: ext, canonical_uri: `test://${instance}/${ext}`, title: ext,
    content, content_type: "text/plain", content_hash: `h-${instance}-${ext}-${content.length}-${content.slice(0, 10)}`, modified_at: modifiedAt, metadata: {}
  };
}
const source = (instance: string, records: KnowledgeRecord[], extra: Partial<KnowledgeListResult> = {}): KnowledgeSource => ({
  source_type: "test", source_instance_id: instance,
  list: async (): Promise<KnowledgeListResult> => ({ records, skipped: [], ...extra })
});

async function docs(instance: string, space = "personal"): Promise<Array<{ external_id: string; deleted: boolean; knowledge_document_id: string }>> {
  const { rows } = await adminPool.query(
    "SELECT external_id, deleted, knowledge_document_id FROM knowledge_documents WHERE tenant_id = $1 AND memory_space_id = $2 AND source_instance_id = $3 ORDER BY external_id",
    [TENANT, space, instance]
  );
  return rows as Array<{ external_id: string; deleted: boolean; knowledge_document_id: string }>;
}
async function count(table: string, where: string, values: unknown[] = []): Promise<number> {
  const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values);
  return (rows[0] as { n: number }).n;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd1-ret-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpd1_ret LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpd1_ret");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','R','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-ret','R');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-ret','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd1_ret", password: "pw2" });
  sync = new KnowledgeSyncService(appPool, embedding);
  retention = new KnowledgeRetentionService(appPool);
  retriever = new KnowledgeRetriever(appPool, embedding);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: beskyttede prefikser i tombstone-steget", () => {
  it("dokumenter under et beskyttet prefiks tombstones ikke selv om de mangler; resten tombstones som vanlig", async () => {
    await sync.sync(identity(), "personal", source("pp-1", [record("pp-1", "ark#1", "ark en"), record("pp-1", "ark#2", "ark to"), record("pp-1", "andre", "annet")]));
    const guarded = await sync.sync(identity(), "personal", source("pp-1", [record("pp-1", "andre", "annet")], { protected_prefixes: ["ark#"] }));
    expect(guarded.tombstoned).toBe(0);
    expect((await docs("pp-1")).every((d) => !d.deleted)).toBe(true);
    const open = await sync.sync(identity(), "personal", source("pp-1", [record("pp-1", "andre", "annet")]));
    expect(open.tombstoned).toBe(2);
    expect((await docs("pp-1")).filter((d) => d.deleted).map((d) => d.external_id)).toEqual(["ark#1", "ark#2"]);
  });

  it("prefikset er en ren prefiks-sammenligning (ingen jokertegn), og gjelder også i den scopede partielle varianten", async () => {
    await sync.sync(identity(), "personal", source("pp-2", [record("pp-2", "a%b", "x"), record("pp-2", "azzb", "y"), record("pp-2", "m1:a", "z")]));
    // «%» og «_» er ikke jokertegn: prefikset «a%» beskytter bare «a%b», ikke «azzb».
    const report = await sync.sync(identity(), "personal", source("pp-2", [record("pp-2", "m1:a", "z")], { protected_prefixes: ["a%"] }));
    expect(report.tombstoned).toBe(1);
    expect((await docs("pp-2")).filter((d) => d.deleted).map((d) => d.external_id)).toEqual(["azzb"]);
    const withScope = await sync.sync(identity(), "personal", {
      source_type: "test", source_instance_id: "pp-2",
      list: async () => ({ records: [], skipped: [], listing: "partial" as const, tombstone_scope: { metadata_key: "message_id", values: ["m1"] }, protected_prefixes: ["m1:"] })
    });
    expect(withScope.tombstoned).toBe(0);
  });
});

describe("B: oppbevaringsfrist i synk", () => {
  it("for gammelt innhold indekseres ikke (expired), ukjent alder regnes ikke som utløpt, nytt innhold indekseres", async () => {
    const report = await sync.sync(
      identity(), "personal",
      source("rs-1", [record("rs-1", "gammel", "gammelt referat", daysAgo(100)), record("rs-1", "ny", "nytt referat", daysAgo(3)), record("rs-1", "ukjent", "uten dato", null)]),
      { retention_days: 30, now: NOW }
    );
    expect(report).toMatchObject({ scanned: 3, created: 2, expired: 1 });
    expect((await docs("rs-1")).map((d) => d.external_id)).toEqual(["ny", "ukjent"]);
  });

  it("et allerede indeksert dokument som passerer fristen tombstones av den vanlige mekanismen", async () => {
    await sync.sync(identity(), "personal", source("rs-2", [record("rs-2", "d", "referat", daysAgo(10))]), { retention_days: 30, now: NOW });
    const later = new Date(NOW.getTime() + 40 * 86_400_000);
    const report = await sync.sync(identity(), "personal", source("rs-2", [record("rs-2", "d", "referat", daysAgo(10))]), { retention_days: 30, now: later });
    expect(report).toMatchObject({ expired: 1, tombstoned: 1, created: 0 });
    expect((await docs("rs-2"))[0]!.deleted).toBe(true);
  });

  it("uten frist indekseres alt som før (expired utelates fra rapporten)", async () => {
    const report = await sync.sync(identity(), "personal", source("rs-3", [record("rs-3", "gammel", "gammelt", daysAgo(4000))]));
    expect(report.created).toBe(1);
    expect(report.expired).toBeUndefined();
  });
});

describe("C: KnowledgeRetentionService fjerner innholdet fysisk, med alt avledet", () => {
  it("utløpte og gamle tombstones fjernes med embeddings, lenker, foreldreløse entiteter og evidens; det som deles, nyere innhold, andre rom og andre kilder blir stående", async () => {
    const instance = "pg-1";
    await sync.sync(identity(), "personal", source(instance, [
      record(instance, "A-gammel", "gammelt referat om prosjektet", daysAgo(100)),
      record(instance, "B-ny", "nytt referat om prosjektet", daysAgo(2)),
      record(instance, "C-tombstone-gammel", "slettet i kilden for lenge siden", daysAgo(5)),
      record(instance, "D-tombstone-fersk", "slettet i kilden nylig", daysAgo(5)),
      record(instance, "E-ukjent-alder", "uten dato", null)
    ]));
    await sync.sync(identity("business"), "business", source(instance, [record(instance, "A-gammel", "gammelt referat i annet rom", daysAgo(100))]));
    await sync.sync(identity(), "personal", source("pg-annen-kilde", [record("pg-annen-kilde", "A-gammel", "gammelt referat fra en annen kilde", daysAgo(100))]));
    const rows = Object.fromEntries((await docs(instance)).map((d) => [d.external_id, d.knowledge_document_id]));
    // C og D tombstones (C for 40 dager siden, D for 5 dager siden):
    await adminPool.query("UPDATE knowledge_documents SET deleted = true, deleted_at = $2 WHERE knowledge_document_id = $1", [rows["C-tombstone-gammel"], daysAgo(40)]);
    await adminPool.query("UPDATE knowledge_documents SET deleted = true, deleted_at = $2 WHERE knowledge_document_id = $1", [rows["D-tombstone-fersk"], daysAgo(5)]);
    // Grafen: entitet «delt» nevnes i A og B, entitet «kun-a» bare i A, «kun-c» bare i C. Evidens fra A og B.
    const ent = async (key: string): Promise<string> => {
      const id = `ke-${key}`;
      await adminPool.query("INSERT INTO knowledge_entities (entity_id, tenant_id, memory_space_id, kind, canonical_key, display_name, method) VALUES ($1, $2, 'personal', 'domain', $3, $3, 'deterministic')", [id, TENANT, key]);
      return id;
    };
    const link = (doc: string, entity: string) =>
      adminPool.query("INSERT INTO knowledge_links (tenant_id, memory_space_id, knowledge_document_id, entity_id, method) VALUES ($1, 'personal', $2, $3, 'deterministic')", [TENANT, doc, entity]);
    const shared = await ent("delt.no");
    const onlyA = await ent("kun-a.no");
    const onlyC = await ent("kun-c.no");
    await link(rows["A-gammel"]!, shared);
    await link(rows["B-ny"]!, shared);
    await link(rows["A-gammel"]!, onlyA);
    await link(rows["C-tombstone-gammel"]!, onlyC);
    await adminPool.query("INSERT INTO claim_verifications (claim_id, tenant_id, memory_space_id, claim_text, claim_hash) VALUES ('cl-ret', $1, 'personal', 'en påstand', 'h-ret')", [TENANT]);
    const evidence = (id: string, doc: string) =>
      adminPool.query(
        "INSERT INTO claim_evidence (evidence_id, tenant_id, memory_space_id, claim_id, stance, source_ref, knowledge_document_id, independence_key, retrieved_at, excerpt) VALUES ($1, $2, 'personal', 'cl-ret', 'supports', $3, $4, $3, now(), 'utdrag')",
        [id, TENANT, id, doc]
      );
    await evidence("ev-a", rows["A-gammel"]!);
    await evidence("ev-b", rows["B-ny"]!);

    const report = await retention.purgeExpired(identity(), "personal", { source_type: "test", source_instance_id: instance }, 30, { now: NOW });
    expect(report).toMatchObject({ documents: 2, embeddings: 2, links: 3, entities: 2, evidence: 1 });
    expect((await docs(instance)).map((d) => d.external_id)).toEqual(["B-ny", "D-tombstone-fersk", "E-ukjent-alder"]);
    expect(await count("knowledge_embeddings", "knowledge_document_id = ANY($1::text[])", [[rows["A-gammel"], rows["C-tombstone-gammel"]]])).toBe(0);
    expect(await count("knowledge_entities", "entity_id = ANY($1::text[])", [[onlyA, onlyC]])).toBe(0);
    expect(await count("knowledge_entities", "entity_id = $1", [shared])).toBe(1);
    expect(await count("knowledge_links", "entity_id = $1", [shared])).toBe(1);
    expect(await count("claim_evidence", "evidence_id = 'ev-a'")).toBe(0);
    expect(await count("claim_evidence", "evidence_id = 'ev-b'")).toBe(1);
    expect(await count("claim_verifications", "claim_id = 'cl-ret'")).toBe(1);
    // Andre rom og andre kilder er urørt:
    expect((await docs(instance, "business")).map((d) => d.external_id)).toEqual(["A-gammel"]);
    expect((await docs("pg-annen-kilde")).map((d) => d.external_id)).toEqual(["A-gammel"]);

    // Idempotent: en ny kjøring finner ingenting mer.
    const again = await retention.purgeExpired(identity(), "personal", { source_type: "test", source_instance_id: instance }, 30, { now: NOW });
    expect(again).toMatchObject({ documents: 0, batches: 0 });
  });

  it("batcher: flere utløpte dokumenter enn batchstørrelsen fjernes i flere omganger; maxBatches avgrenser jobben", async () => {
    const instance = "pg-batch";
    await sync.sync(identity(), "personal", source(instance, [1, 2, 3, 4, 5].map((i) => record(instance, `r${i}`, `referat ${i}`, daysAgo(200)))));
    const partial = await retention.purgeExpired(identity(), "personal", { source_type: "test", source_instance_id: instance }, 30, { now: NOW, batchSize: 2, maxBatches: 2 });
    expect(partial).toMatchObject({ documents: 4, batches: 2 });
    const rest = await retention.purgeExpired(identity(), "personal", { source_type: "test", source_instance_id: instance }, 30, { now: NOW, batchSize: 2, maxBatches: 5 });
    expect(rest).toMatchObject({ documents: 1, batches: 1 });
    expect(await docs(instance)).toEqual([]);
  });

  it("ugyldig frist avvises (aldri en stille «slett alt»)", async () => {
    for (const bad of [0, -1, 1.5, 4000, Number.NaN]) {
      await expect(retention.purgeExpired(identity(), "personal", { source_type: "test", source_instance_id: "x" }, bad)).rejects.toThrow(/invalid_retention_days/);
    }
  });

  it("app-rollen kan ikke fjerne dokumenter i et rom uten rommet i konteksten (RLS): tenant-isolasjon", async () => {
    const other: IdentityContext = { ...identity(), tenant_id: "tenant-wpd1-ret-annen" };
    await adminPool.query("INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-wpd1-ret-annen','Annen','person')");
    const report = await retention.purgeExpired(other, "personal", { source_type: "test", source_instance_id: "pg-annen-kilde" }, 30, { now: NOW });
    expect(report.documents).toBe(0);
    expect((await docs("pg-annen-kilde")).length).toBe(1);
  });
});

describe("D: møtetranskripter hele veien (fil -> synk -> søketreff)", () => {
  it("transkriptet lagres uten e-post, treffet har source_kind meeting_transcript og sensitive som gulv, og gamle filer indekseres ikke når fristen er satt", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-wpd1-mt-"));
    await mkdir(join(root, "2026"), { recursive: true });
    await writeFile(join(root, "2026", "produktmote.txt"), ["Tittel: Produktmøte lansering", "Deltakere: Ola Nordmann, Kari Hansen", "[00:00:05] Ola Nordmann: Vi lanserer zebrafink-modulen i mai. Send til ola.nordmann@acme.no", "[00:00:20] Kari Hansen: Budsjettet er godkjent."].join("\n"));
    await writeFile(join(root, "2026", "gammelt.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Per>Dette er et veldig gammelt møte om quokka</v>\n");
    const old = new Date(NOW.getTime() - 400 * 86_400_000);
    await utimes(join(root, "2026", "gammelt.vtt"), old, old);
    const fresh = new Date();
    await utimes(join(root, "2026", "produktmote.txt"), fresh, fresh);

    const src = new MeetingTranscriptKnowledgeSource(root, "mt:ret");
    const report = await sync.sync(identity("business"), "business", src, { policy: { default_sensitivity: "sensitive", trust: "untrusted" }, retention_days: 365, now: new Date() });
    expect(report).toMatchObject({ scanned: 2, created: 1, expired: 1 });

    const stored = await adminPool.query("SELECT title, content, canonical_uri, external_id, sensitivity, trust_level FROM knowledge_documents WHERE source_instance_id = 'mt:ret'");
    expect(stored.rowCount).toBe(1);
    const row = stored.rows[0] as { title: string; content: string; canonical_uri: string; external_id: string; sensitivity: string; trust_level: string };
    expect(JSON.stringify(row)).not.toContain("@");
    expect(row.sensitivity).toBe("sensitive");
    expect(row.trust_level).toBe("untrusted");
    expect(row.content).toContain("zebrafink");

    const hits = await retriever.searchHits(identity("business"), { query: "zebrafink modulen", spaces: ["business"] });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source_kind: "meeting_transcript", memory_space: "business", sensitivity: "sensitive", trust_level: "untrusted" });
    expect(JSON.stringify(hits[0])).not.toContain("@");
    expect(hits[0]!.uri).toMatch(/^transcript:\/\/mt:ret\/[0-9a-f]{16}$/);
    expect(await retriever.searchHits(identity("business"), { query: "quokka", spaces: ["business"] })).toEqual([]);
    // Søket i et annet rom ser ingenting:
    expect(await retriever.searchHits(identity("personal"), { query: "zebrafink", spaces: ["personal"] })).toEqual([]);
  });
});
