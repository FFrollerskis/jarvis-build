import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding } from "@jarvis/memory";
import { KnowledgeSyncService, type KnowledgeListResult, type KnowledgeRecord, type KnowledgeSource } from "@jarvis/knowledge";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ErasureService } from "../src/erasure-service.ts";

/**
 * WP-D1 (UA-2, migrasjon 087/088): erasure må ta med alt som er AVLEDET av kunnskapsdokumenter - entitetslenker, entiteter som ikke har noen lenke igjen (navnene er hentet fra det
 * slettede innholdet) og påstandsevidens (utdrag er kopiert fra dokumentet) - uten å røre det som deles med dokumenter som blir stående. Ekte embedded Postgres, ekte RLS (app-rolle),
 * ekte `ErasureService`.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let sync: KnowledgeSyncService;
let service: ErasureService;
const embedding = new LocalHashEmbedding();

const TENANT = "tenant-wpd1-erase";

const identity = (space: MemorySpace = "personal"): IdentityContext => ({
  person_id: "person-tobias", tenant_id: TENANT, memory_space_id: space, session_id: `sess-${TENANT}`, device_id: "dev-wpd1-erase", channel: "api", auth_strength: "active"
});

function record(instance: string, ext: string, content: string): KnowledgeRecord {
  return {
    source_type: "test", source_instance_id: instance, external_id: ext, canonical_uri: `test://${instance}/${ext}`, title: ext,
    content, content_type: "text/plain", content_hash: `h-${instance}-${ext}-${content.length}`, modified_at: null, metadata: {}
  };
}
const source = (instance: string, records: KnowledgeRecord[]): KnowledgeSource => ({
  source_type: "test", source_instance_id: instance,
  list: async (): Promise<KnowledgeListResult> => ({ records, skipped: [] })
});

async function docId(instance: string, ext: string, space: MemorySpace): Promise<string> {
  const { rows } = await adminPool.query(
    "SELECT knowledge_document_id FROM knowledge_documents WHERE tenant_id = $1 AND memory_space_id = $2 AND source_instance_id = $3 AND external_id = $4",
    [TENANT, space, instance, ext]
  );
  return (rows[0] as { knowledge_document_id: string }).knowledge_document_id;
}
async function plantEntity(space: MemorySpace, key: string): Promise<string> {
  const id = `ke-${randomUUID()}`;
  await adminPool.query(
    "INSERT INTO knowledge_entities (entity_id, tenant_id, memory_space_id, kind, canonical_key, display_name, method) VALUES ($1, $2, $3, 'domain', $4, $4, 'deterministic')",
    [id, TENANT, space, key]
  );
  return id;
}
async function plantLink(space: MemorySpace, documentId: string, entityId: string): Promise<void> {
  await adminPool.query(
    "INSERT INTO knowledge_links (tenant_id, memory_space_id, knowledge_document_id, entity_id, method) VALUES ($1, $2, $3, $4, 'deterministic')",
    [TENANT, space, documentId, entityId]
  );
}
async function plantClaim(space: MemorySpace, text: string, createdBy: string): Promise<string> {
  const id = `cl-${randomUUID()}`;
  await adminPool.query(
    "INSERT INTO claim_verifications (claim_id, tenant_id, memory_space_id, claim_text, claim_hash, created_by_person_id) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, TENANT, space, text, `hash-${id}`, createdBy]
  );
  return id;
}
async function plantEvidence(space: MemorySpace, claimId: string, ref: string, documentId: string | null, excerpt: string | null): Promise<string> {
  const id = `ev-${randomUUID()}`;
  await adminPool.query(
    `INSERT INTO claim_evidence (evidence_id, tenant_id, memory_space_id, claim_id, stance, source_ref, knowledge_document_id, independence_key, retrieved_at, excerpt)
     VALUES ($1, $2, $3, $4, 'supports', $5, $6, $7, now(), $8)`,
    [id, TENANT, space, claimId, ref, documentId, `key-${ref}`, excerpt]
  );
  return id;
}
async function count(table: string, where: string, values: unknown[] = []): Promise<number> {
  const { rows } = await adminPool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values);
  return (rows[0] as { n: number }).n;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd1-erase-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpd1_erase LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpd1_erase");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','E','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias'), ('person-other','Other');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT}'), ('person-other','${TENANT}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-wpd1-personal','${TENANT}','personal'), ('ms-wpd1-business','${TENANT}','business'), ('ms-wpd1-project','${TENANT}','project'), ('ms-wpd1-home','${TENANT}','home');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd1_erase", password: "pw2" });
  sync = new KnowledgeSyncService(appPool, embedding);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT] }
  });
  service = new ErasureService(appPool, policy, embedding);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: knowledge_document-scope tar med det avledede, men ikke det som deles", () => {
  it("lenker, foreldreløse entiteter og evidens for dokumentet forsvinner; delte entiteter, andres evidens og selve påstanden blir stående; forhåndsvisning = utført", async () => {
    await sync.sync(identity(), "personal", source("er-a", [record("er-a", "d1", "første dokument om acme"), record("er-a", "d2", "andre dokument om acme")]));
    const d1 = await docId("er-a", "d1", "personal");
    const d2 = await docId("er-a", "d2", "personal");
    const shared = await plantEntity("personal", "acme-shared.no");
    const only1 = await plantEntity("personal", "only-d1.no");
    const only2 = await plantEntity("personal", "only-d2.no");
    await plantLink("personal", d1, shared);
    await plantLink("personal", d1, only1);
    await plantLink("personal", d2, shared);
    await plantLink("personal", d2, only2);
    const claim = await plantClaim("personal", "acme har sitt hovedkontor i Oslo", "person-tobias");
    const ev1 = await plantEvidence("personal", claim, d1, d1, "UTDRAG-FRA-D1-SENTINEL");
    const ev2 = await plantEvidence("personal", claim, d2, d2, "utdrag fra d2");
    const ev3 = await plantEvidence("personal", claim, "https://example.no/acme", null, null);

    const scope = { type: "knowledge_document" as const, tenant_id: TENANT, knowledge_document_id: d1 };
    const preview = await service.previewErasure(scope);
    expect(preview.affected).toMatchObject({ knowledge_documents: 1, knowledge_embeddings: 1, knowledge_links: 2, knowledge_entities: 1, claim_evidence: 1 });

    const result = await service.executeErasure({ scope, requestId: `req-${randomUUID()}`, identity: identity() });
    expect(result.status).toBe("completed");
    expect(result.record_counts).toMatchObject(preview.affected);

    expect(await count("knowledge_documents", "knowledge_document_id = $1", [d1])).toBe(0);
    expect(await count("knowledge_links", "knowledge_document_id = $1", [d1])).toBe(0);
    expect(await count("knowledge_entities", "entity_id = $1", [only1])).toBe(0); // navnet overlevde ikke dokumentet
    expect(await count("knowledge_entities", "entity_id = $1", [shared])).toBe(1); // deles med d2
    expect(await count("knowledge_entities", "entity_id = $1", [only2])).toBe(1);
    expect(await count("knowledge_links", "knowledge_document_id = $1", [d2])).toBe(2);
    expect(await count("claim_evidence", "evidence_id = $1", [ev1])).toBe(0);
    expect(await count("claim_evidence", "evidence_id = ANY($1::text[])", [[ev2, ev3]])).toBe(2);
    expect(await count("claim_verifications", "claim_id = $1", [claim])).toBe(1);
    expect(await count("claim_evidence", "excerpt LIKE '%UTDRAG-FRA-D1-SENTINEL%'")).toBe(0);
  });
});

describe("B: knowledge_source-scope tar med dokumentene i ALLE rom kilden finnes i, og det avledede", () => {
  it("samme kildeinstans i to rom: begge settene dokumenter, lenker, foreldreløse entiteter og evidens er borte - en annen kilde røres ikke", async () => {
    await sync.sync(identity("personal"), "personal", source("er-src", [record("er-src", "x", "dokument x")]));
    await sync.sync(identity("business"), "business", source("er-src", [record("er-src", "x", "dokument x")]));
    await sync.sync(identity("personal"), "personal", source("er-keep", [record("er-keep", "k", "dokument k")]));
    const px = await docId("er-src", "x", "personal");
    const bx = await docId("er-src", "x", "business");
    const keep = await docId("er-keep", "k", "personal");
    const ep = await plantEntity("personal", "src-only-personal.no");
    const eb = await plantEntity("business", "src-only-business.no");
    const ek = await plantEntity("personal", "keep.no");
    await plantLink("personal", px, ep);
    await plantLink("business", bx, eb);
    await plantLink("personal", keep, ek);
    const claim = await plantClaim("business", "påstand med evidens fra business-dokumentet", "person-tobias");
    await plantEvidence("business", claim, bx, bx, "utdrag");

    const scope = { type: "knowledge_source" as const, tenant_id: TENANT, source_type: "test", source_instance_id: "er-src" };
    const preview = await service.previewErasure(scope);
    expect(preview.affected).toMatchObject({ knowledge_documents: 2, knowledge_links: 2, knowledge_entities: 2, claim_evidence: 1 });
    const result = await service.executeErasure({ scope, requestId: `req-${randomUUID()}`, identity: identity() });
    expect(result.status).toBe("completed");
    expect(await count("knowledge_documents", "source_instance_id = 'er-src'")).toBe(0);
    expect(await count("knowledge_entities", "entity_id = ANY($1::text[])", [[ep, eb]])).toBe(0);
    expect(await count("claim_evidence", "claim_id = $1", [claim])).toBe(0);
    expect(await count("knowledge_documents", "knowledge_document_id = $1", [keep])).toBe(1);
    expect(await count("knowledge_entities", "entity_id = $1", [ek])).toBe(1);
    expect(await count("knowledge_links", "knowledge_document_id = $1", [keep])).toBe(1);
  });
});

describe("C: memory_space-scope tar hele rommets graf og påstander - og kun det rommets", () => {
  it("project-rommet tømmes (påstander, evidens, lenker, entiteter, dokumenter); home-rommet er urørt", async () => {
    await sync.sync(identity("project"), "project", source("er-space", [record("er-space", "p", "prosjektdokument")]));
    await sync.sync(identity("home"), "home", source("er-space", [record("er-space", "h", "hjemmedokument")]));
    const pdoc = await docId("er-space", "p", "project");
    const hdoc = await docId("er-space", "h", "home");
    const pe = await plantEntity("project", "proj.no");
    const he = await plantEntity("home", "home.no");
    await plantLink("project", pdoc, pe);
    await plantLink("home", hdoc, he);
    const pc = await plantClaim("project", "prosjektpåstand", "person-tobias");
    const hc = await plantClaim("home", "hjempåstand", "person-tobias");
    await plantEvidence("project", pc, "https://example.no/p", null, "p");
    await plantEvidence("home", hc, "https://example.no/h", null, "h");

    const result = await service.executeErasure({ scope: { type: "memory_space", tenant_id: TENANT, memory_space_id: "project" }, requestId: `req-${randomUUID()}`, identity: identity("project") });
    expect(result.status).toBe("completed");
    expect(result.record_counts).toMatchObject({ claim_evidence: 1, claim_verifications: 1, knowledge_links: 1, knowledge_entities: 1, knowledge_documents: 1 });
    expect(await count("claim_verifications", "claim_id = $1", [pc])).toBe(0);
    expect(await count("claim_evidence", "claim_id = $1", [pc])).toBe(0);
    expect(await count("knowledge_entities", "entity_id = $1", [pe])).toBe(0);
    expect(await count("knowledge_documents", "knowledge_document_id = $1", [pdoc])).toBe(0);
    expect(await count("claim_verifications", "claim_id = $1", [hc])).toBe(1);
    expect(await count("claim_evidence", "claim_id = $1", [hc])).toBe(1);
    expect(await count("knowledge_entities", "entity_id = $1", [he])).toBe(1);
    expect(await count("knowledge_links", "knowledge_document_id = $1", [hdoc])).toBe(1);
  });
});

describe("D: person-scope tar påstandene personen selv registrerte (med evidens), ikke andres", () => {
  it("claims opprettet av person-other forsvinner sammen med evidensen; person-tobias sine står igjen", async () => {
    const mine = await plantClaim("personal", "påstand fra other", "person-other");
    const theirs = await plantClaim("personal", "påstand fra tobias", "person-tobias");
    await plantEvidence("personal", mine, "https://example.no/o", null, "o");
    await plantEvidence("personal", theirs, "https://example.no/t", null, "t");
    const result = await service.executeErasure({ scope: { type: "person", tenant_id: TENANT, person_id: "person-other" }, requestId: `req-${randomUUID()}`, identity: identity() });
    expect(result.status).toBe("completed");
    expect(result.record_counts).toMatchObject({ claim_verifications: 1, claim_evidence: 1 });
    expect(await count("claim_verifications", "claim_id = $1", [mine])).toBe(0);
    expect(await count("claim_evidence", "claim_id = $1", [mine])).toBe(0);
    expect(await count("claim_verifications", "claim_id = $1", [theirs])).toBe(1);
    expect(await count("claim_evidence", "claim_id = $1", [theirs])).toBe(1);
  });
});

describe("E: gjenoppstandelsesvern (erasure-fingerprint)", () => {
  it("et slettet dokument gjenskapes ikke av neste synk; fingerprintet er tenant-bredt (kjent, konservativ begrensning: det samme dokumentet i et ANNET rom av samme tenant blir også holdt tilbake)", async () => {
    await sync.sync(identity("personal"), "personal", source("er-res", [record("er-res", "r", "dokument som skal slettes")]));
    const id = await docId("er-res", "r", "personal");
    const erased = await service.executeErasure({ scope: { type: "knowledge_document", tenant_id: TENANT, knowledge_document_id: id }, requestId: `req-${randomUUID()}`, identity: identity() });
    expect(erased.status).toBe("completed");
    const again = await sync.sync(identity("personal"), "personal", source("er-res", [record("er-res", "r", "dokument som skal slettes")]));
    expect(again.suppressed).toBe(1);
    expect(again.created).toBe(0);
    const otherSpace = await sync.sync(identity("business"), "business", source("er-res", [record("er-res", "r", "dokument som skal slettes")]));
    expect(otherSpace.suppressed).toBe(1);
    expect(otherSpace.created).toBe(0);
  });
});
