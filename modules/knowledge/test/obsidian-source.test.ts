import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { allocateEmbeddedPostgresPort, computeErasureFingerprint, createPool, runMigrations } from "@jarvis/core";
import { LocalHashEmbedding } from "@jarvis/memory";
import { ObsidianVaultKnowledgeSource } from "../src/obsidian-source.ts";
import { KnowledgeSyncService } from "../src/sync.ts";
import { KnowledgeRetriever } from "../src/retriever.ts";

/**
 * UA-2 P1A §19/§26/§29: Obsidian/lokal vault som kunnskapskilde. Ekte
 * embedded Postgres (ekte migrasjoner/RLS/sync), ekte filsystem-I/O i en
 * midlertidig vault - ALDRI Tobias sin ekte vault.
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-obsidian-know", memory_space_id: "personal",
  session_id: "sess-obs-know", device_id: "dev-know", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-obsidian-know-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_obsidian_know LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_obsidian_know");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-obsidian-know','Obsidian-know','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-obsidian-know');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_obsidian_know", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

async function tempVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jarvis-obsidian-vault-"));
}

describe("ObsidianVaultKnowledgeSource - lister/filtrerer (ingen DB nødvendig)", () => {
  it("§29.l lister KUN .md-filer - ikke andre tekstformater FilesystemKnowledgeSource ellers ville tatt med", async () => {
    const vault = await tempVault();
    await writeFile(join(vault, "notat.md"), "# Notat\n\nInnhold.");
    await writeFile(join(vault, "data.json"), '{"a":1}'); // IKKE et Obsidian-notat
    await writeFile(join(vault, "script.ts"), "export const x = 1;");
    const source = new ObsidianVaultKnowledgeSource(vault);
    const { records } = await source.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.external_id).toBe("notat.md");
  });

  it("§29.m .obsidian/ (intern verktøykonfig) er EKSKLUDERT fra ingestion som default", async () => {
    const vault = await tempVault();
    await writeFile(join(vault, "ekte-notat.md"), "Ekte innhold");
    await mkdir(join(vault, ".obsidian"), { recursive: true });
    await writeFile(join(vault, ".obsidian", "config.md"), "# skal ALDRI indekseres"); // usannsynlig i praksis, men verifiserer filteret uansett
    const source = new ObsidianVaultKnowledgeSource(vault);
    const { records } = await source.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.external_id).toBe("ekte-notat.md");
    expect(records.some((r) => r.external_id.startsWith(".obsidian/"))).toBe(false);
  });

  it("§29.n traversal/symlink-escape er umulig - gjenbruker P0 sin sikkerhetsgrunnmur (FilesystemKnowledgeSource)", async () => {
    const vault = await tempVault();
    const outside = await tempVault();
    await writeFile(join(vault, "lovlig.md"), "lovlig");
    await writeFile(join(outside, "hemmelig.md"), "hemmelig utenfor vault-roten");
    try {
      await symlink(join(outside, "hemmelig.md"), join(vault, "lenke.md"));
    } catch {
      return; // symlink-rettigheter mangler i sandbox - ikke kjørbar her
    }
    const source = new ObsidianVaultKnowledgeSource(vault);
    const { records } = await source.list();
    expect(records.some((r) => r.external_id === "lovlig.md")).toBe(true);
    expect(records.some((r) => r.content.includes("hemmelig"))).toBe(false);
  });

  it("§29.o frontmatter parses til metadata.frontmatter (flat key/value), content beholder HELE filen uendret", async () => {
    const vault = await tempVault();
    await writeFile(
      join(vault, "med-frontmatter.md"),
      "---\ntitle: Mitt Notat\ntags: [jarvis, test]\npublished: true\npriority: 3\n---\n\n# Mitt Notat\n\nBrødtekst her."
    );
    const source = new ObsidianVaultKnowledgeSource(vault);
    const { records } = await source.list();
    const record = records[0];
    expect(record?.content).toContain("---\ntitle: Mitt Notat"); // rå fil, uendret - IKKE strippet
    expect(record?.content).toContain("Brødtekst her.");
    const frontmatter = record?.metadata["frontmatter"] as Record<string, unknown>;
    expect(frontmatter["title"]).toBe("Mitt Notat");
    expect(frontmatter["tags"]).toEqual(["jarvis", "test"]);
    expect(frontmatter["published"]).toBe(true);
    expect(frontmatter["priority"]).toBe(3);
  });

  it("§29.p wiki-lenker ([[Notat]], [[Notat|Visning]], [[Notat#Del]]) trekkes ut som en FLAT liste - ikke en graf", async () => {
    const vault = await tempVault();
    await writeFile(
      join(vault, "lenker.md"),
      "Se [[Annet Notat]] og [[Tredje Notat|med visningstekst]] og [[Fjerde Notat#En seksjon]]. Duplikat: [[Annet Notat]]."
    );
    const source = new ObsidianVaultKnowledgeSource(vault);
    const { records } = await source.list();
    const links = records[0]?.metadata["wiki_links"];
    expect(links).toEqual(["Annet Notat", "Tredje Notat", "Fjerde Notat"]);
  });

  it("notat UTEN frontmatter gir tom frontmatter-metadata og uendret innhold", async () => {
    const vault = await tempVault();
    await writeFile(join(vault, "enkelt.md"), "Bare vanlig markdown, ingen frontmatter.");
    const source = new ObsidianVaultKnowledgeSource(vault);
    const { records } = await source.list();
    expect(records[0]?.metadata["frontmatter"]).toEqual({});
    expect(records[0]?.content).toBe("Bare vanlig markdown, ingen frontmatter.");
  });
});

describe("ObsidianVaultKnowledgeSource - full livssyklus via KnowledgeSyncService (Postgres nødvendig)", () => {
  it("§29.q create/update/delete(tombstone)/reappear - samme sync-fundament som alle andre kilder", async () => {
    const vault = await tempVault();
    const path = join(vault, "livssyklus.md");
    await writeFile(path, "versjon 1");
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const source = () => new ObsidianVaultKnowledgeSource(vault, "obsidian:lifecycle-test");

    const created = await sync.sync(identity, "personal", source());
    expect(created).toMatchObject({ created: 1, updated: 0 });

    const unchanged = await sync.sync(identity, "personal", source());
    expect(unchanged).toMatchObject({ created: 0, updated: 0, unchanged: 1 });

    await writeFile(path, "versjon 2 - endret innhold");
    const updated = await sync.sync(identity, "personal", source());
    expect(updated).toMatchObject({ created: 0, updated: 1 });

    await rm(path);
    const tombstoned = await sync.sync(identity, "personal", source());
    expect(tombstoned).toMatchObject({ tombstoned: 1 });

    await writeFile(path, "versjon 2 - endret innhold"); // samme innhold som før sletting
    const reactivated = await sync.sync(identity, "personal", source());
    expect(reactivated).toMatchObject({ reactivated: 1 });
  }, 30_000);

  it("§29.r omdøpning = slett+ny (external_id er relativ sti, IKKE en stabil note-id) - dokumentert bevisst forskjell fra Drive", async () => {
    const vault = await tempVault();
    await writeFile(join(vault, "gammelt-navn.md"), "samme innhold");
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const source = () => new ObsidianVaultKnowledgeSource(vault, "obsidian:rename-test");

    const first = await sync.sync(identity, "personal", source());
    expect(first).toMatchObject({ created: 1 });

    await rm(join(vault, "gammelt-navn.md"));
    await writeFile(join(vault, "nytt-navn.md"), "samme innhold"); // "omdøpt" = ny fil på disk
    const second = await sync.sync(identity, "personal", source());
    // Gammel sti tombstones, ny sti er en HELT NY canonical document - ikke en oppdatering:
    expect(second).toMatchObject({ created: 1, tombstoned: 1, updated: 0 });
  }, 30_000);

  it("§29.s Q-20 resurrection-suppression: en fingerprint-slettet note gjenoppstår IKKE ved resync selv om filen fortsatt ligger på disk", async () => {
    const vault = await tempVault();
    const sentinel = `ObsidianSentinel${randomUUID().replace(/-/g, "")}`;
    await writeFile(join(vault, "slettet-notat.md"), sentinel);
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const sourceInstanceId = "obsidian:resurrection-test";
    const source = () => new ObsidianVaultKnowledgeSource(vault, sourceInstanceId);

    const first = await sync.sync(identity, "personal", source());
    expect(first).toMatchObject({ created: 1 });

    // Simulerer det Q-20 sin ErasureService gjør: hard-delete raden (+ avledede
    // embeddings, FK-rekkefølge) + skriv resurrection-fingerprint, i SAMME
    // transaksjonsmønster (egen tabell, aldri selve innholdet).
    await adminPool.query(
      `DELETE FROM knowledge_embeddings WHERE knowledge_document_id IN (
         SELECT knowledge_document_id FROM knowledge_documents
         WHERE tenant_id=$1 AND source_type='obsidian' AND source_instance_id=$2 AND external_id='slettet-notat.md')`,
      [identity.tenant_id, sourceInstanceId]
    );
    await adminPool.query(
      "DELETE FROM knowledge_documents WHERE tenant_id=$1 AND source_type='obsidian' AND source_instance_id=$2 AND external_id='slettet-notat.md'",
      [identity.tenant_id, sourceInstanceId]
    );
    const requestId = `req-${randomUUID()}`;
    await adminPool.query(
      `INSERT INTO erasure_requests (request_id, tenant_id, scope_type, scope_summary, status)
       VALUES ($1, $2, 'knowledge_document', '{}'::jsonb, 'completed')`,
      [requestId, identity.tenant_id]
    );
    const fingerprint = computeErasureFingerprint(identity.tenant_id, "obsidian", sourceInstanceId, "slettet-notat.md");
    await adminPool.query(
      `INSERT INTO erasure_fingerprints (fingerprint, tenant_id, source_type, source_instance_id, erasure_request_id)
       VALUES ($1, $2, 'obsidian', $3, $4)`,
      [fingerprint, identity.tenant_id, sourceInstanceId, requestId]
    );

    // Filen ligger FORTSATT på disk (kilden er uendret) - resync skal IKKE gjenopplive dokumentet.
    const resync = await sync.sync(identity, "personal", source());
    expect(resync.created).toBe(0);
    expect(resync.suppressed).toBe(1);

    const retriever = new KnowledgeRetriever(appPool, embedding);
    const found = await retriever.search(identity, { query: sentinel, spaces: ["personal"] });
    expect(found.some((r) => r.content.includes(sentinel))).toBe(false);
  }, 30_000);
});
