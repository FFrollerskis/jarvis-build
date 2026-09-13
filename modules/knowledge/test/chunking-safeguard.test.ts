import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { LocalHashEmbedding, type EmbeddingProvider } from "@jarvis/memory";
import { FilesystemKnowledgeSource } from "../src/filesystem-source.ts";
import { KnowledgeSyncService } from "../src/sync.ts";

/**
 * UA-2 P1A §27: chunking-safeguard. Beviser BEGGE halvdeler av kontrakten -
 * `content` (og dermed FTS) beholder HELE, utrunkerte teksten, mens KUN det
 * som sendes til `EmbeddingProvider.embed()` er avkortet - ellers ville en
 * stor Drive/Obsidian-fil enten kastet en API-feil (ekte leverandør med
 * token-tak) eller stille mistet halene av innholdet fra fulltekstsøk (hvis
 * noen ved en feil hadde trunkert `content` selv).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-chunk-know", memory_space_id: "personal",
  session_id: "sess-chunk-know", device_id: "dev-know", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-chunk-know-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_chunk_know LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_chunk_know");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-chunk-know','Chunk-know','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-chunk-know');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_chunk_know", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

/** Registrerer lengden på HVER tekst den faktisk fikk til embed() - beviser trunkeringsgrensen uten å bry seg om selve vektoren. */
class LengthRecordingEmbedding implements EmbeddingProvider {
  readonly model = "length-recording-v1";
  readonly dim: number;
  receivedLengths: number[] = [];
  private readonly inner = new LocalHashEmbedding();
  constructor() {
    this.dim = this.inner.dim;
  }
  async embed(text: string): Promise<number[]> {
    this.receivedLengths.push(text.length);
    return this.inner.embed(text);
  }
}

describe("Chunking-safeguard (§27): embedding-input trunkeres, content/FTS gjør IKKE", () => {
  it("et dokument over grensen lagres med HELE innholdet, men embed() mottar KUN en avkortet tekst", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-chunk-fs-"));
    // Godt over MAX_EMBEDDING_INPUT_CHARS (24 000) - simulerer et stort Drive/Obsidian-dokument.
    const hugeContent = "Jarvis-sentinel-ord ".repeat(2000); // ~40 000 tegn
    expect(hugeContent.length).toBeGreaterThan(24_000);
    await writeFile(join(root, "stor-fil.md"), hugeContent);

    const embedding = new LengthRecordingEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const source = new FilesystemKnowledgeSource(root, "fs:chunk-safeguard-test");
    const report = await sync.sync(identity, "personal", source);
    expect(report).toMatchObject({ created: 1, failed: 0 });

    // embed() fikk KUN en avkortet tekst - aldri hele 40 000-tegns-strengen:
    expect(embedding.receivedLengths).toHaveLength(1);
    expect(embedding.receivedLengths[0]).toBeLessThanOrEqual(24_000);

    // content-kolonnen (og dermed FTS, generert derfra) beholder HELE, utrunkerte teksten:
    const row = await adminPool.query(
      "SELECT content, length(content) AS len FROM knowledge_documents WHERE tenant_id=$1 AND external_id='stor-fil.md'",
      [identity.tenant_id]
    );
    const stored = row.rows[0] as { content: string; len: number };
    expect(stored.content).toBe(hugeContent);
    expect(stored.len).toBe(hugeContent.length);
  }, 30_000);

  it("et dokument UNDER grensen sendes UENDRET til embed() - ingen unødvendig trunkering av korte dokumenter", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-chunk-fs-small-"));
    const smallContent = "Et helt vanlig, kort notat.";
    await writeFile(join(root, "liten-fil.md"), smallContent);

    const embedding = new LengthRecordingEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const source = new FilesystemKnowledgeSource(root, "fs:chunk-safeguard-small-test");
    await sync.sync(identity, "personal", source);

    expect(embedding.receivedLengths).toEqual([smallContent.length]);
  }, 30_000);
});
