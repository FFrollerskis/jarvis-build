import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { createPool, planMigrations, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding } from "@jarvis/memory";
import { InvalidSourcePolicyError, exceedsCeiling, resolveSourcePolicy } from "../src/source-policy.ts";
import { KnowledgeSyncService, type KnowledgeEntityIndexPort } from "../src/sync.ts";
import type { KnowledgeListResult, KnowledgeRecord, KnowledgeSource } from "../src/source.ts";

/**
 * WP-D1 (UA-2, JARVIS-032): kunnskapslaget er space-bevisst. Mot EKTE embedded Postgres som app-rolle (RLS):
 *  A. canonical identity er (tenant, rom, kilde, instans, ekstern id) - samme dokument kan finnes i to rom, men aldri to ganger i ett,
 *  B. migrasjon 086 har en pre-flight som melder ALLE rader som ville brutt den nye nøkkelen i ÉN feil (kun id-er) og endrer ingenting når den kaster,
 *  C. kildens policy (sensitivitetsgulv/-tak, tillit) styrer merkene og hva som i det hele tatt indekseres,
 *  D. entitetsindekseringen kjører i en egen delsavepoint og mister aldri dokumentet.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let preflightPool: pg.Pool;
let pgPort = 0;

class CountingEmbedding extends LocalHashEmbedding {
  calls = 0;
  override async embed(text: string): Promise<number[]> {
    this.calls += 1;
    return super.embed(text);
  }
}
const embedding = new CountingEmbedding();
let sync: KnowledgeSyncService;

const TENANT = "tenant-wpd1-space";
const identity = (space: MemorySpace = "personal"): IdentityContext => ({
  person_id: "person-wpd1", tenant_id: TENANT, memory_space_id: space, session_id: "sess-wpd1", device_id: "dev-wpd1", channel: "api", auth_strength: "active"
});

function record(instance: string, ext: string, content: string, title = ext): KnowledgeRecord {
  return {
    source_type: "test", source_instance_id: instance, external_id: ext, canonical_uri: `test://${instance}/${ext}`, title,
    content, content_type: "text/plain", content_hash: `h-${instance}-${ext}-${content.length}-${content.slice(0, 12)}`, modified_at: null, metadata: {}
  };
}
const source = (instance: string, records: KnowledgeRecord[], listing?: "complete" | "partial"): KnowledgeSource => ({
  source_type: "test", source_instance_id: instance,
  list: async (): Promise<KnowledgeListResult> => ({ records, skipped: [], ...(listing ? { listing } : {}) })
});

interface DocRow {
  knowledge_document_id: string;
  memory_space_id: string;
  sensitivity: string;
  trust_level: string;
  deleted: boolean;
  version: number;
  content: string;
  entities_indexed_key: string | null;
}
async function docRow(instance: string, ext: string, space = "personal"): Promise<DocRow | undefined> {
  const { rows } = await adminPool.query(
    `SELECT knowledge_document_id, memory_space_id, sensitivity, trust_level, deleted, version, content, entities_indexed_key
       FROM knowledge_documents WHERE tenant_id = $1 AND source_instance_id = $2 AND external_id = $3 AND memory_space_id = $4`,
    [TENANT, instance, ext, space]
  );
  return rows[0] as DocRow | undefined;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd1-space-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  pgPort = leased.port;
  await leased.postgres.createDatabase("jarvis_test");
  await leased.postgres.createDatabase("jarvis_preflight");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  preflightPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_preflight", user: "postgres", password: "pw" });
  preflightPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpd1_space LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpd1_space");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','S','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-wpd1','W');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-wpd1','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd1_space", password: "pw2" });
  sync = new KnowledgeSyncService(appPool, embedding);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await preflightPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: space-bevisst canonical identity", () => {
  it("samme kildeinstans og samme dokument-id kan finnes i to rom i samme tenant - hvert rom får sin egen rad og sin egen embedding", async () => {
    const personal = await sync.sync(identity("personal"), "personal", source("inst-shared", [record("inst-shared", "doc-1", "felles dokument om ski")]));
    const business = await sync.sync(identity("business"), "business", source("inst-shared", [record("inst-shared", "doc-1", "felles dokument om ski")]));
    expect(personal.created).toBe(1);
    expect(personal.failed).toBe(0);
    expect(business.created).toBe(1);
    expect(business.failed).toBe(0); // før 086 var dette et UNIQUE-brudd talt som failed
    const a = await docRow("inst-shared", "doc-1", "personal");
    const b = await docRow("inst-shared", "doc-1", "business");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.knowledge_document_id).not.toBe(b!.knowledge_document_id);
    const emb = await adminPool.query(
      "SELECT e.memory_space_id AS emb_space, d.memory_space_id AS doc_space FROM knowledge_embeddings e JOIN knowledge_documents d ON d.knowledge_document_id = e.knowledge_document_id WHERE d.source_instance_id = 'inst-shared'"
    );
    expect(emb.rowCount).toBe(2);
    for (const r of emb.rows as Array<{ emb_space: string; doc_space: string }>) expect(r.emb_space).toBe(r.doc_space);
  });

  it("tombstoning er per rom: et tomt resultat i personal rører ikke samme instans i business", async () => {
    const report = await sync.sync(identity("personal"), "personal", source("inst-shared", []));
    expect(report.tombstoned).toBe(1);
    expect((await docRow("inst-shared", "doc-1", "personal"))!.deleted).toBe(true);
    expect((await docRow("inst-shared", "doc-1", "business"))!.deleted).toBe(false);
  });

  it("endret innhold i ett rom oppdaterer kun det rommets rad", async () => {
    const before = await docRow("inst-shared", "doc-1", "personal");
    const report = await sync.sync(identity("business"), "business", source("inst-shared", [record("inst-shared", "doc-1", "oppdatert felles dokument om sykkel")]));
    expect(report.updated).toBe(1);
    expect((await docRow("inst-shared", "doc-1", "business"))!.version).toBe(2);
    const after = await docRow("inst-shared", "doc-1", "personal");
    expect(after!.version).toBe(before!.version);
    expect(after!.content).toBe(before!.content);
  });

  it("databasen avviser fortsatt et duplikat INNENFOR ett rom (nøkkelen er utvidet, ikke fjernet)", async () => {
    const insert = (id: string) =>
      adminPool.query(
        `INSERT INTO knowledge_documents (knowledge_document_id, tenant_id, memory_space_id, source_type, source_instance_id, external_id, canonical_uri, title, content, content_type, content_hash)
         VALUES ($1, $2, 'project', 'test', 'inst-dup', 'same', 'u', 't', 'c', 'text/plain', 'h')`,
        [id, TENANT]
      );
    await insert("kd-dup-1");
    await expect(insert("kd-dup-2")).rejects.toThrow(/knowledge_documents_identity_key/);
  });

  it("en embedding kan ikke ligge i et annet rom enn dokumentet (komposittnøkkel med rom), og en lenke kan ikke binde dokument og entitet i ulike rom", async () => {
    const doc = await docRow("inst-shared", "doc-1", "business");
    await expect(
      adminPool.query(
        "INSERT INTO knowledge_embeddings (knowledge_document_id, tenant_id, memory_space_id, model, dim, embedding) VALUES ($1, $2, 'personal', 'm', 2, '{0.1,0.2}')",
        ["kd-finnes-ikke", TENANT]
      )
    ).rejects.toThrow(/foreign key|knowledge_embeddings_document_space_fkey/);
    await adminPool.query("DELETE FROM knowledge_embeddings WHERE knowledge_document_id = $1", [doc!.knowledge_document_id]);
    await expect(
      adminPool.query(
        "INSERT INTO knowledge_embeddings (knowledge_document_id, tenant_id, memory_space_id, model, dim, embedding) VALUES ($1, $2, 'personal', 'm', 2, '{0.1,0.2}')",
        [doc!.knowledge_document_id, TENANT]
      )
    ).rejects.toThrow(/knowledge_embeddings_document_space_fkey/);
    await adminPool.query("INSERT INTO knowledge_entities (entity_id, tenant_id, memory_space_id, kind, canonical_key, display_name, method) VALUES ('ke-other-space', $1, 'personal', 'domain', 'acme.no', 'acme.no', 'deterministic')", [TENANT]);
    await expect(
      adminPool.query("INSERT INTO knowledge_links (tenant_id, memory_space_id, knowledge_document_id, entity_id, method) VALUES ($1, 'business', $2, 'ke-other-space', 'deterministic')", [TENANT, doc!.knowledge_document_id])
    ).rejects.toThrow(/knowledge_links_.*fkey/);
  });

  it("pre-flight-funksjonen er ikke kjørbar for app-rollen", async () => {
    await expect(appPool.query("SELECT jarvis_knowledge_space_preflight()")).rejects.toThrow(/permission denied/);
  });
});

describe("B: migrasjon 086 - pre-flight, atomisk avvisning og idempotens", () => {
  const MIGRATIONS = fileURLToPath(new URL("../../core/src/db/migrations", import.meta.url));

  it("en embedding i feil rom stopper migrasjonen med ÉN feil som lister id-er (aldri innhold), og skjemaet er urørt; etter retting går den gjennom, og en ny kjøring er en no-op", async () => {
    const olderDir = await mkdtemp(join(tmpdir(), "jarvis-wpd1-mig-old-"));
    const all = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
    const older = all.filter((f) => !/^08[678]_/.test(f));
    expect(older.length).toBeGreaterThan(70);
    for (const f of older) await copyFile(join(MIGRATIONS, f), join(olderDir, f));
    await runMigrations(preflightPool, olderDir);

    await preflightPool.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('t-pre', 'P', 'person')`);
    const insertDoc = (id: string, space: string) =>
      preflightPool.query(
        `INSERT INTO knowledge_documents (knowledge_document_id, tenant_id, memory_space_id, source_type, source_instance_id, external_id, canonical_uri, title, content, content_type, content_hash)
         VALUES ($1, 't-pre', $2, 'test', 'inst', $1, 'u', 'HEMMELIG-TITTEL-XYZ', 'HEMMELIG-INNHOLD-XYZ', 'text/plain', 'h')`,
        [id, space]
      );
    await insertDoc("kd-pre-bad", "personal");
    await insertDoc("kd-pre-ok", "personal");
    await preflightPool.query("INSERT INTO knowledge_embeddings (knowledge_document_id, tenant_id, memory_space_id, model, dim, embedding) VALUES ('kd-pre-bad', 't-pre', 'business', 'm', 2, '{0.1,0.2}')");
    await preflightPool.query("INSERT INTO knowledge_embeddings (knowledge_document_id, tenant_id, memory_space_id, model, dim, embedding) VALUES ('kd-pre-ok', 't-pre', 'personal', 'm', 2, '{0.1,0.2}')");

    const failure = await runMigrations(preflightPool).then(() => undefined, (e: Error) => e);
    expect(failure).toBeDefined();
    expect(failure!.message).toMatch(/086_knowledge_space_aware\.sql feilet/);
    expect(failure!.message).toMatch(/knowledge_space_preflight: 1 embeddings/);
    expect(failure!.message).toContain("kd-pre-bad");
    expect(failure!.message).not.toContain("kd-pre-ok");
    expect(failure!.message).not.toContain("HEMMELIG");
    // Atomisk: ingenting av 086 er anvendt.
    const cols = await preflightPool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'knowledge_documents' AND column_name = 'sensitivity'");
    expect(cols.rowCount).toBe(0);
    const applied = await preflightPool.query("SELECT name FROM schema_migrations WHERE name LIKE '08%' ORDER BY name");
    expect((applied.rows as Array<{ name: string }>).map((r) => r.name)).not.toContain("086_knowledge_space_aware.sql");

    await preflightPool.query("UPDATE knowledge_embeddings SET memory_space_id = 'personal' WHERE knowledge_document_id = 'kd-pre-bad'");
    const appliedNow = await runMigrations(preflightPool);
    expect(appliedNow).toEqual(["086_knowledge_space_aware.sql", "087_knowledge_entity_graph.sql", "088_claim_verifications.sql"]);
    // Eksisterende rader får fail-closed standarder: privat og ubetrodd, aldri normal.
    const rows = await preflightPool.query("SELECT sensitivity, trust_level, entities_indexed_key FROM knowledge_documents");
    expect(rows.rowCount).toBe(2);
    for (const r of rows.rows as Array<{ sensitivity: string; trust_level: string; entities_indexed_key: string | null }>) {
      expect(r.sensitivity).toBe("sensitive");
      expect(r.trust_level).toBe("untrusted");
      expect(r.entities_indexed_key).toBeNull();
    }
    expect(await runMigrations(preflightPool)).toEqual([]);
    const plan = await planMigrations(preflightPool);
    expect(plan.pending).toEqual([]);
    expect(plan.checksum_mismatches).toEqual([]);
    expect(plan.missing_checksum).toEqual([]);
    // Den nye nøkkelen gjelder: samme identitet i ett rom avvises (på identitetsnøkkelen, ikke på primærnøkkelen), i et annet rom går det.
    const insertIdentity = (id: string, space: string, ext: string) =>
      preflightPool.query(
        `INSERT INTO knowledge_documents (knowledge_document_id, tenant_id, memory_space_id, source_type, source_instance_id, external_id, canonical_uri, title, content, content_type, content_hash)
         VALUES ($1, 't-pre', $2, 'test', 'inst', $3, 'u', 't', 'c', 'text/plain', 'h')`,
        [id, space, ext]
      );
    await expect(insertIdentity("kd-pre-dup", "personal", "kd-pre-ok")).rejects.toThrow(/knowledge_documents_identity_key/);
    await insertIdentity("kd-pre-other-space", "business", "kd-pre-ok");
    expect(pgPort).toBeGreaterThan(0);
  }, 240_000);

  it("migrasjon 086-088 har lagret sjekksum i hoved-databasen, og de tre filene er de eneste nye (085 er reservert)", async () => {
    const { rows } = await adminPool.query("SELECT name, checksum FROM schema_migrations WHERE name ~ '^08[5-9]_' ORDER BY name");
    const names = (rows as Array<{ name: string; checksum: string | null }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["086_knowledge_space_aware.sql", "087_knowledge_entity_graph.sql", "088_claim_verifications.sql"]));
    for (const r of rows as Array<{ checksum: string | null }>) expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("C: kildens policy - sensitivitetsgulv, tak og tillit", () => {
  it("rene hjelpere: standard er privat og ubetrodd; ukjente verdier og et gulv over taket avvises; taket sammenlignes riktig", () => {
    expect(resolveSourcePolicy()).toEqual({ floor: "sensitive", ceiling: undefined, trust: "untrusted" });
    expect(resolveSourcePolicy({ default_sensitivity: "normal", max_sensitivity: "special", trust: "internal" })).toEqual({ floor: "normal", ceiling: "special", trust: "internal" });
    expect(() => resolveSourcePolicy({ default_sensitivity: "hemmelig" as never })).toThrow(InvalidSourcePolicyError);
    expect(() => resolveSourcePolicy({ max_sensitivity: "alt" as never })).toThrow(/max_sensitivity_unknown/);
    expect(() => resolveSourcePolicy({ trust: "trusted" as never })).toThrow(/trust_unknown/);
    expect(() => resolveSourcePolicy({ default_sensitivity: "special", max_sensitivity: "normal" })).toThrow(/default_sensitivity_above_max_sensitivity/);
    expect(exceedsCeiling("special", "sensitive")).toBe(true);
    expect(exceedsCeiling("sensitive", "sensitive")).toBe(false);
    expect(exceedsCeiling("special", undefined)).toBe(false);
  });

  it("uten policy lagres dokumentet som sensitive + untrusted (aldri normal ved en feil)", async () => {
    await sync.sync(identity(), "personal", source("pol-default", [record("pol-default", "a", "en helt vanlig setning om ski")]));
    const row = await docRow("pol-default", "a");
    expect(row!.sensitivity).toBe("sensitive");
    expect(row!.trust_level).toBe("untrusted");
  });

  it("eksplisitt gulv normal gir normal for ren tekst, men teksten kan fortsatt løfte (diagnose = special); trust internal lagres", async () => {
    const report = await sync.sync(
      identity(), "personal",
      source("pol-normal", [record("pol-normal", "ren", "en helt vanlig setning om ski"), record("pol-normal", "medisin", "Tobias har fått en ny diagnose")]),
      { policy: { default_sensitivity: "normal", trust: "internal" } }
    );
    expect(report.created).toBe(2);
    expect((await docRow("pol-normal", "ren"))!.sensitivity).toBe("normal");
    expect((await docRow("pol-normal", "ren"))!.trust_level).toBe("internal");
    expect((await docRow("pol-normal", "medisin"))!.sensitivity).toBe("special");
  });

  it("helse-rommet er alltid special, uansett gulv", async () => {
    await sync.sync(identity("health"), "health", source("pol-health", [record("pol-health", "x", "en helt vanlig setning")]), { policy: { default_sensitivity: "normal" } });
    expect((await docRow("pol-health", "x", "health"))!.sensitivity).toBe("special");
  });

  it("taket: et dokument over taket indekseres ikke (excluded), resten lagres", async () => {
    const report = await sync.sync(
      identity(), "personal",
      source("pol-ceiling", [record("pol-ceiling", "ok", "vanlig notat om prosjektet"), record("pol-ceiling", "medisin", "Tobias har fått en ny diagnose")]),
      { policy: { max_sensitivity: "sensitive" } }
    );
    expect(report.created).toBe(1);
    expect(report.excluded).toBe(1);
    expect(await docRow("pol-ceiling", "medisin")).toBeUndefined();
    expect(await docRow("pol-ceiling", "ok")).toBeDefined();
  });

  it("taket: et allerede indeksert dokument som blir strengere enn taket tombstones, og det nye innholdet lagres aldri", async () => {
    await sync.sync(identity(), "personal", source("pol-grow", [record("pol-grow", "d", "vanlig notat om ski")]), { policy: { max_sensitivity: "sensitive" } });
    const report = await sync.sync(
      identity(), "personal",
      source("pol-grow", [record("pol-grow", "d", "Tobias har fått en ny diagnose og skal på sykehus")]),
      { policy: { max_sensitivity: "sensitive" } }
    );
    expect(report.excluded).toBe(1);
    expect(report.tombstoned).toBe(1);
    expect(report.updated).toBe(0);
    const row = await docRow("pol-grow", "d");
    expect(row!.deleted).toBe(true);
    expect(row!.content).toBe("vanlig notat om ski"); // det strengere innholdet kom aldri inn
  });

  it("uendret innhold regnes om uten ny embedding (billig): gulvet endres fra sensitive til normal", async () => {
    await sync.sync(identity(), "personal", source("pol-recalc", [record("pol-recalc", "r", "vanlig notat om fjell")]));
    expect((await docRow("pol-recalc", "r"))!.sensitivity).toBe("sensitive");
    const before = embedding.calls;
    const report = await sync.sync(identity(), "personal", source("pol-recalc", [record("pol-recalc", "r", "vanlig notat om fjell")]), { policy: { default_sensitivity: "normal" } });
    expect(report.unchanged).toBe(1);
    expect(embedding.calls).toBe(before);
    expect((await docRow("pol-recalc", "r"))!.sensitivity).toBe("normal");
  });

  it("ugyldig policy avvises FØR kilden listes og før noe skrives", async () => {
    let listed = 0;
    const spy: KnowledgeSource = { source_type: "test", source_instance_id: "pol-bad", list: async () => { listed += 1; return { records: [record("pol-bad", "z", "tekst")], skipped: [] }; } };
    await expect(sync.sync(identity(), "personal", spy, { policy: { default_sensitivity: "special", max_sensitivity: "normal" } })).rejects.toBeInstanceOf(InvalidSourcePolicyError);
    await expect(sync.sync(identity(), "personal", spy, { policy: { trust: "trusted" as never } })).rejects.toBeInstanceOf(InvalidSourcePolicyError);
    expect(listed).toBe(0);
    expect(await docRow("pol-bad", "z")).toBeUndefined();
  });

  it("en partiell listing tombstoner ikke, heller ikke når et dokument ble holdt utenfor på grunn av taket", async () => {
    await sync.sync(identity(), "personal", source("pol-partial", [record("pol-partial", "a", "notat a"), record("pol-partial", "b", "notat b")]));
    const report = await sync.sync(identity(), "personal", source("pol-partial", [record("pol-partial", "a", "notat a")], "partial"), { policy: { max_sensitivity: "sensitive" } });
    expect(report.tombstoned).toBe(0);
    expect((await docRow("pol-partial", "b"))!.deleted).toBe(false);
  });
});

describe("D: entitetsindeksering via porten (egen delsavepoint)", () => {
  function indexer(version: string, behaviour: { fail?: boolean } = {}): KnowledgeEntityIndexPort & { calls: string[] } {
    const calls: string[] = [];
    return {
      version,
      calls,
      async index(client, input) {
        calls.push(input.knowledge_document_id);
        const entityId = `ke-${input.knowledge_document_id}`;
        await client.query(
          `INSERT INTO knowledge_entities (entity_id, tenant_id, memory_space_id, kind, canonical_key, display_name, method)
           VALUES ($1, $2, $3, 'domain', $4, $4, 'deterministic') ON CONFLICT (tenant_id, memory_space_id, kind, canonical_key) DO NOTHING`,
          [entityId, input.tenant_id, input.memory_space_id, `${input.knowledge_document_id}.example.no`]
        );
        if (behaviour.fail) throw new Error("indekseringen feilet midt i skrivingen");
        await client.query(
          `INSERT INTO knowledge_links (tenant_id, memory_space_id, knowledge_document_id, entity_id, method)
           SELECT tenant_id, memory_space_id, $3, entity_id, 'deterministic' FROM knowledge_entities WHERE tenant_id = $1 AND memory_space_id = $2 AND entity_id = $4
           ON CONFLICT DO NOTHING`,
          [input.tenant_id, input.memory_space_id, input.knowledge_document_id, entityId]
        );
      }
    };
  }

  it("indekseres én gang per (innhold, versjon): uendret synk hopper over, ny versjon bygger på nytt, endret innhold bygger på nytt", async () => {
    const v1 = indexer("v1");
    const src = () => source("idx-basic", [record("idx-basic", "a", "dokument om et prosjekt")]);
    const first = await sync.sync(identity(), "personal", src(), { entity_indexer: v1 });
    expect(first.created).toBe(1);
    expect(v1.calls).toHaveLength(1);
    const row = await docRow("idx-basic", "a");
    expect(row!.entities_indexed_key).toBe(`${record("idx-basic", "a", "dokument om et prosjekt").content_hash}:v1`);
    const links = await adminPool.query("SELECT count(*)::int AS n FROM knowledge_links WHERE knowledge_document_id = $1", [row!.knowledge_document_id]);
    expect(links.rows[0]).toEqual({ n: 1 });

    await sync.sync(identity(), "personal", src(), { entity_indexer: v1 });
    expect(v1.calls).toHaveLength(1); // uendret nøkkel = no-op

    const v2 = indexer("v2");
    await sync.sync(identity(), "personal", src(), { entity_indexer: v2 });
    expect(v2.calls).toHaveLength(1); // ny uttrekker-versjon
    expect((await docRow("idx-basic", "a"))!.entities_indexed_key).toMatch(/:v2$/);

    await sync.sync(identity(), "personal", source("idx-basic", [record("idx-basic", "a", "dokument om et helt annet prosjekt")]), { entity_indexer: v2 });
    expect(v2.calls).toHaveLength(2); // endret innhold
  });

  it("en feil i indekseringen mister aldri dokumentet: delsavepointen rulles tilbake (ingen halvskrevne rader), feilen telles, nøkkelen forblir tom, neste synk reparerer", async () => {
    const broken = indexer("v1", { fail: true });
    const report = await sync.sync(identity(), "personal", source("idx-fail", [record("idx-fail", "a", "dokument som feiler i indekseringen")]), { entity_indexer: broken });
    expect(report.created).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.entity_index_failed).toBe(1);
    const row = await docRow("idx-fail", "a");
    expect(row).toBeDefined();
    expect(row!.deleted).toBe(false);
    expect(row!.entities_indexed_key).toBeNull();
    const entities = await adminPool.query("SELECT count(*)::int AS n FROM knowledge_entities WHERE canonical_key = $1", [`${row!.knowledge_document_id}.example.no`]);
    expect(entities.rows[0]).toEqual({ n: 0 }); // INSERT-en før feilen er rullet tilbake

    const fixed = indexer("v1");
    const repair = await sync.sync(identity(), "personal", source("idx-fail", [record("idx-fail", "a", "dokument som feiler i indekseringen")]), { entity_indexer: fixed });
    expect(repair.unchanged).toBe(1);
    expect(repair.entity_index_failed).toBeUndefined();
    expect(fixed.calls).toHaveLength(1);
    expect((await docRow("idx-fail", "a"))!.entities_indexed_key).toMatch(/:v1$/);
  });

  it("uten indekserer røres ikke grafen (av som standard)", async () => {
    await sync.sync(identity(), "personal", source("idx-off", [record("idx-off", "a", "dokument uten indeksering")]));
    expect((await docRow("idx-off", "a"))!.entities_indexed_key).toBeNull();
  });
});
