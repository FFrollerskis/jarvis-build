import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding, withMemoryTransaction } from "@jarvis/memory";
import { FilesystemKnowledgeSource } from "../src/filesystem-source.ts";
import { KnowledgeRetriever } from "../src/retriever.ts";
import { KnowledgeSyncService } from "../src/sync.ts";

/**
 * UA-2 P0 HOST BLOCKER regresjon (§5 A-K i BO-en): host-harnesset (ua2-p0-live.ts)
 * beviste opprinnelig isolasjon via `pool` (JARVIS_DB_USER) UTEN å noensinne
 * verifisere at rollen faktisk er non-bypass - en superbruker/BYPASSRLS-rolle
 * gjør enhver RLS-policy usynlig uansett hvor korrekt policyen er. Denne suiten
 * beviser to ting samtidig: (1) isolasjon FUNGERER korrekt via en garantert
 * non-bypass rolle (identisk mønster som resten av suiten - `jarvis_rls_iso`
 * er medlem av `jarvis_app`, ALDRI superuser), og (2) HVORFOR admin/bypass-
 * tilkoblinger ALDRI kan brukes som bevis for RLS (§5.K).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const tenantA: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-rls-iso-a", memory_space_id: "personal",
  session_id: "sess-rls-a", device_id: "dev-rls", channel: "api", auth_strength: "active"
};
const tenantB: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-rls-iso-b", memory_space_id: "personal",
  session_id: "sess-rls-b", device_id: "dev-rls", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-rls-iso-"));
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
  // KRITISK: garantert non-bypass rolle, eksplisitt NOSUPERUSER NOBYPASSRLS, medlem av
  // jarvis_app - IKKE bare "en login-rolle" (det alene beviser ingenting om bypass-status).
  await adminPool.query("CREATE ROLE jarvis_rls_iso LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_rls_iso");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-rls-iso-a','A','person'), ('tenant-rls-iso-b','B','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-rls-iso-a'), ('person-tobias','tenant-rls-iso-b');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_rls_iso", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("§5.A-D: tenant isolation via non-bypass rolle + KnowledgeRetriever", () => {
  it("tenant A finner aldri tenant B og omvendt; hver finner sin egen", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "jarvis-rls-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "jarvis-rls-b-"));
    await writeFile(join(rootA, "a.md"), "RlsIsoUniktA");
    await writeFile(join(rootB, "b.md"), "RlsIsoUniktB");
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const retriever = new KnowledgeRetriever(appPool, embedding);

    await sync.sync(tenantA, "personal", new FilesystemKnowledgeSource(rootA, "fs:rls-a"));
    await sync.sync(tenantB, "personal", new FilesystemKnowledgeSource(rootB, "fs:rls-b"));

    const aSeesB = await retriever.search(tenantA, { query: "RlsIsoUniktB", spaces: ["personal"] });
    const bSeesA = await retriever.search(tenantB, { query: "RlsIsoUniktA", spaces: ["personal"] });
    const aFindsOwn = await retriever.search(tenantA, { query: "RlsIsoUniktA", spaces: ["personal"] });
    const bFindsOwn = await retriever.search(tenantB, { query: "RlsIsoUniktB", spaces: ["personal"] });
    // Merk: vektorleddet kan legitimt returnere tenant A sitt EGET nesten-like
    // dokument som en (svak) treffkandidat på en fjern-lik spørring (LocalHashEmbedding
    // er en enkel trigram-hash - korte, nesten-identiske strenger kan gi høy cosine-
    // likhet) - RLS skal likevel ALDRI la B sitt FAKTISKE innhold dukke opp i A sine
    // resultater. Derfor sjekkes innhold, ikke bare listelengde (samme mønster som
    // §7.G/§7.H i knowledge-fundament.test.ts).
    expect(aSeesB.some((r) => r.content.includes("RlsIsoUniktB"))).toBe(false);
    expect(bSeesA.some((r) => r.content.includes("RlsIsoUniktA"))).toBe(false);
    expect(aFindsOwn.some((r) => r.content.includes("RlsIsoUniktA"))).toBe(true);
    expect(bFindsOwn.some((r) => r.content.includes("RlsIsoUniktB"))).toBe(true);
  }, 30_000);
});

describe("§5.E-F/I: memory-space isolation innen samme tenant (personal vs business)", () => {
  it("personal ser aldri business og omvendt, begge finner egen", async () => {
    const rootP = await mkdtemp(join(tmpdir(), "jarvis-rls-space-p-"));
    const rootB = await mkdtemp(join(tmpdir(), "jarvis-rls-space-b-"));
    await writeFile(join(rootP, "p.md"), "RlsSpacePersonalOrd");
    await writeFile(join(rootB, "b.md"), "RlsSpaceBusinessOrd");
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const retriever = new KnowledgeRetriever(appPool, embedding);

    await sync.sync(tenantA, "personal", new FilesystemKnowledgeSource(rootP, "fs:rls-space-p"));
    await sync.sync(tenantA, "business", new FilesystemKnowledgeSource(rootB, "fs:rls-space-b"));

    const personalSeesBusiness = await retriever.search(tenantA, { query: "RlsSpaceBusinessOrd", spaces: ["personal"] });
    const businessSeesPersonal = await retriever.search(tenantA, { query: "RlsSpacePersonalOrd", spaces: ["business"] });
    const personalFindsOwn = await retriever.search(tenantA, { query: "RlsSpacePersonalOrd", spaces: ["personal"] });
    const businessFindsOwn = await retriever.search(tenantA, { query: "RlsSpaceBusinessOrd", spaces: ["business"] });
    expect(personalSeesBusiness).toHaveLength(0);
    expect(businessSeesPersonal).toHaveLength(0);
    expect(personalFindsOwn.length).toBeGreaterThan(0);
    expect(businessFindsOwn.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("§5.G-H: FTS og vektor-spørringene alene (ikke bare den kombinerte hybriden) respekterer memory-space", () => {
  it("G: FTS-spørringen (samme SQL-form som retriever.ts) finner aldri en annen space enn den gyldige", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-rls-fts-"));
    await writeFile(join(root, "biz.md"), "RlsFtsBusinessOnlyOrd");
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    await sync.sync(tenantA, "business", new FilesystemKnowledgeSource(root, "fs:rls-fts"));

    const wrongSpace = await withMemoryTransaction(appPool, tenantA.tenant_id, ["personal"], (client) =>
      client.query(
        `SELECT knowledge_document_id FROM knowledge_documents
         WHERE deleted = false AND fts @@ plainto_tsquery('norwegian', $1)`,
        ["RlsFtsBusinessOnlyOrd"]
      )
    );
    const rightSpace = await withMemoryTransaction(appPool, tenantA.tenant_id, ["business"], (client) =>
      client.query(
        `SELECT knowledge_document_id FROM knowledge_documents
         WHERE deleted = false AND fts @@ plainto_tsquery('norwegian', $1)`,
        ["RlsFtsBusinessOnlyOrd"]
      )
    );
    expect(wrongSpace.rowCount).toBe(0);
    expect(rightSpace.rowCount).toBeGreaterThan(0);
  }, 30_000);

  it("H: vektor-spørringen (cosine_sim real[]-grenen) finner aldri en annen space enn den gyldige", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-rls-vec-"));
    await writeFile(join(root, "biz.md"), "RlsVectorBusinessOnlyOrd unikt innhold for vektorlikhet");
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    await sync.sync(tenantA, "business", new FilesystemKnowledgeSource(root, "fs:rls-vec"));
    const queryVector = await embedding.embed("RlsVectorBusinessOnlyOrd unikt innhold for vektorlikhet");

    const wrongSpace = await withMemoryTransaction(appPool, tenantA.tenant_id, ["personal"], (client) =>
      client.query(
        `SELECT e.knowledge_document_id FROM knowledge_embeddings e
         JOIN knowledge_documents d ON d.knowledge_document_id = e.knowledge_document_id
         WHERE d.deleted = false AND cosine_sim(e.embedding, $1::real[]) >= 0.4`,
        [queryVector]
      )
    );
    const rightSpace = await withMemoryTransaction(appPool, tenantA.tenant_id, ["business"], (client) =>
      client.query(
        `SELECT e.knowledge_document_id FROM knowledge_embeddings e
         JOIN knowledge_documents d ON d.knowledge_document_id = e.knowledge_document_id
         WHERE d.deleted = false AND cosine_sim(e.embedding, $1::real[]) >= 0.4`,
        [queryVector]
      )
    );
    expect(wrongSpace.rowCount).toBe(0);
    expect(rightSpace.rowCount).toBeGreaterThan(0);
  }, 30_000);
});

describe("§5.J: tombstone + isolasjon samtidig", () => {
  it("et tombstonet dokument i tenant A lekker aldri til tenant B, og isolasjon holder for øvrige dokumenter", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "jarvis-rls-tomb-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "jarvis-rls-tomb-b-"));
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const retriever = new KnowledgeRetriever(appPool, embedding);
    const filePathA = join(rootA, "tomb.md");
    await writeFile(filePathA, "RlsTombstoneUniktOrd");
    await writeFile(join(rootB, "b.md"), "RlsTombstoneOtherTenantOrd");

    await sync.sync(tenantA, "personal", new FilesystemKnowledgeSource(rootA, "fs:rls-tomb-a"));
    await sync.sync(tenantB, "personal", new FilesystemKnowledgeSource(rootB, "fs:rls-tomb-b"));
    // Tombstone tenant A sitt dokument (kilden er nå tom).
    await rm(filePathA);
    await sync.sync(tenantA, "personal", new FilesystemKnowledgeSource(rootA, "fs:rls-tomb-a"));

    const bSearchesTombstoned = await retriever.search(tenantB, { query: "RlsTombstoneUniktOrd", spaces: ["personal"] });
    const aSearchesOwnTombstoned = await retriever.search(tenantA, { query: "RlsTombstoneUniktOrd", spaces: ["personal"] });
    const bFindsOwn = await retriever.search(tenantB, { query: "RlsTombstoneOtherTenantOrd", spaces: ["personal"] });
    // Samme merknad som §5.A-D: sjekk INNHOLD, ikke bare listelengde - vektorleddet kan
    // legitimt gi B sitt eget (ikke-tombstonede) dokument som treffkandidat på en
    // trigram-lik spørring uten at det er en isolasjons- eller tombstone-lekkasje.
    expect(bSearchesTombstoned.some((r) => r.content.includes("RlsTombstoneUniktOrd"))).toBe(false); // aldri lekket til B i utgangspunktet
    expect(aSearchesOwnTombstoned.some((r) => r.content.includes("RlsTombstoneUniktOrd"))).toBe(false); // tombstonet - usynlig for normal retrieval selv for eier
    expect(bFindsOwn.some((r) => r.content.includes("RlsTombstoneOtherTenantOrd"))).toBe(true); // B sitt eget (ikke-tombstonede) dokument fortsatt normalt synlig
  }, 30_000);
});

describe("§5.K: admin/bypass-tilkobling er ALDRI gyldig bevis for RLS - dokumenterer eksakt live-blocker-bug-klassen", () => {
  it("samme spørring gir cross-tenant-lekkasje via superbruker, men korrekt isolasjon via non-bypass-rollen", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "jarvis-rls-k-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "jarvis-rls-k-b-"));
    await writeFile(join(rootA, "a.md"), "RlsBypassProofUniktA");
    await writeFile(join(rootB, "b.md"), "RlsBypassProofUniktB");
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    await sync.sync(tenantA, "personal", new FilesystemKnowledgeSource(rootA, "fs:rls-k-a"));
    await sync.sync(tenantB, "personal", new FilesystemKnowledgeSource(rootB, "fs:rls-k-b"));

    // Superbrukeren (adminPool) bypasser RLS PER DEFINISJON - en spørring uten
    // eksplisitt tenant_id-filter i SELECT-teksten (nøyaktig slik retriever.ts sine
    // spørringer er skrevet - de stoler UTELUKKENDE på RLS, ikke på en WHERE tenant_id=)
    // ser BEGGE tenants sine rader samtidig. Dette er GRUNNEN til at host-blockeren
    // oppsto: harnesset brukte tidligere en tilkobling med uverifisert bypass-status
    // for nøyaktig denne typen spørring.
    const viaAdminBypass = await adminPool.query(
      `SELECT tenant_id FROM knowledge_documents WHERE fts @@ plainto_tsquery('norwegian', $1)`,
      ["RlsBypassProofUniktA"]
    );
    const adminSeesOtherTenantsToo = await adminPool.query(
      `SELECT DISTINCT tenant_id FROM knowledge_documents WHERE tenant_id IN ('tenant-rls-iso-a','tenant-rls-iso-b')`
    );
    expect(viaAdminBypass.rowCount).toBeGreaterThan(0); // admin ser dataene uten noen tenant-kontekst satt i det hele tatt
    expect(adminSeesOtherTenantsToo.rowCount).toBe(2); // BEGGE tenants synlige samtidig via samme superbruker-tilkobling

    // Kontrast: samme logiske spørring via den non-bypass-rollen, med korrekt
    // tenant-kontekst satt, ser KUN sin egen tenant - nøyaktig slik det skal være.
    const viaRestrictedRole = await withMemoryTransaction(appPool, tenantA.tenant_id, ["personal"], (client) =>
      client.query(`SELECT tenant_id FROM knowledge_documents WHERE fts @@ plainto_tsquery('norwegian', $1)`, [
        "RlsBypassProofUniktB"
      ])
    );
    expect(viaRestrictedRole.rowCount).toBe(0); // tenant A ser aldri tenant B, selv med identisk spørringstekst som admin brukte
  }, 30_000);
});
