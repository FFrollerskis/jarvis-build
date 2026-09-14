import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";
import { LocalHashEmbedding } from "@jarvis/memory";
import { GoogleDriveKnowledgeSource } from "../src/drive-source.ts";
import { ObsidianVaultKnowledgeSource } from "../src/obsidian-source.ts";
import { KnowledgeSyncService } from "../src/sync.ts";
import { KnowledgeRetriever } from "../src/retriever.ts";

/**
 * UA-2 P1A §27/§29: kryssgående krav som IKKE er spesifikke for én kilde -
 * tenant/space-isolasjon, retrieval (FTS/vector/hybrid) og observability-
 * redaksjon skal gjelde for Drive/Obsidian PRESIS som for filesystem/GitHub
 * (samme knowledge_documents/knowledge_embeddings-tabeller, samme RLS,
 * samme retriever - INGEN egen vei per kildetype).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const tenantA: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-p1a-cross-a", memory_space_id: "personal",
  session_id: "sess-a", device_id: "dev-a", channel: "api", auth_strength: "active"
};
const tenantB: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-p1a-cross-b", memory_space_id: "personal",
  session_id: "sess-b", device_id: "dev-b", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-p1a-cross-"));
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
  // Q-21: samme ikke-superbruker-rolle-mønster som ALLE andre P0/P1A-tester -
  // NOSUPERUSER/NOBYPASSRLS, kun medlem av jarvis_app. Ingen av testene under
  // bruker adminPool for annet enn direkte oppsett/verifikasjon utenfor RLS.
  await adminPool.query("CREATE ROLE jarvis_p1a_cross LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_p1a_cross");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-p1a-cross-a','A','person'), ('tenant-p1a-cross-b','B','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-p1a-cross-a'), ('person-tobias','tenant-p1a-cross-b');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_p1a_cross", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

interface FakeDriveDoc {
  id: string;
  name: string;
  mimeType: string;
  content: string;
}

/** Bygger en ekte ToolGateway med en FakeTransport som svarer med de gitte Drive-dokumentene (fast innhold, ingen paginering nødvendig for disse kryssgående testene). */
function driveGateway(files: readonly FakeDriveDoc[]): ToolGateway {
  const devices = new InMemoryDeviceRegistry();
  const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
  const secrets: SecretProvider = { name: "test", async get() { return "fake-google-token"; } };
  const toolGateway = new ToolGateway(appPool, policy, secrets);
  const transport = new FakeTransport((action, parameters) => {
    if (action === "list_files") {
      return { data: { files: files.map((f) => ({ id: f.id, name: f.name, mime_type: f.mimeType, modified_at: null, size_bytes: null })), next_page_token: null } };
    }
    if (action === "read_document") {
      const id = parameters["document_id"] as string;
      const file = files.find((f) => f.id === id);
      return { data: { content: file?.content ?? "", content_type: file?.mimeType ?? "text/plain" } };
    }
    throw new Error(`uventet action: ${action}`);
  });
  for (const tool of firstWaveTools({ drive: transport })) toolGateway.register(tool);
  return toolGateway;
}

describe("UA-2 P1A kryssgående: tenant-isolasjon med nye kildetyper", () => {
  it("§29.t Drive-dokumenter respekterer tenant-isolasjon EKSAKT som filesystem/GitHub - ingen egen RLS-vei", async () => {
    const secretWordA = `DriveTenantA${randomUUID().replace(/-/g, "")}`;
    const secretWordB = `DriveTenantB${randomUUID().replace(/-/g, "")}`;
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);

    const gwA = driveGateway([{ id: "doc-a", name: "a.txt", mimeType: "text/plain", content: secretWordA }]);
    await sync.sync(tenantA, "personal", new GoogleDriveKnowledgeSource(gwA, tenantA, { kind: "whole_drive" }, "drive:isolation-a"));

    const gwB = driveGateway([{ id: "doc-b", name: "b.txt", mimeType: "text/plain", content: secretWordB }]);
    await sync.sync(tenantB, "personal", new GoogleDriveKnowledgeSource(gwB, tenantB, { kind: "whole_drive" }, "drive:isolation-b"));

    const retriever = new KnowledgeRetriever(appPool, embedding);
    const aSeesOwn = await retriever.search(tenantA, { query: secretWordA, spaces: ["personal"] });
    const aSeesB = await retriever.search(tenantA, { query: secretWordB, spaces: ["personal"] });
    const bSeesOwn = await retriever.search(tenantB, { query: secretWordB, spaces: ["personal"] });
    const bSeesA = await retriever.search(tenantB, { query: secretWordA, spaces: ["personal"] });

    // Vektor-halvparten av hybrid-søket kan returnere tenantens EGNE, urelaterte
    // dokumenter med lav score selv ved et "fremmed" søkeord (normal ranking-
    // oppførsel, se §7.R/§7.G-presedens i knowledge-fundament.test.ts) - det
    // som faktisk beviser isolasjon er at INGEN treff inneholder den andre
    // tenantens hemmelige ord, uansett antall rå treff.
    expect(aSeesOwn.some((r) => r.content.includes(secretWordA))).toBe(true);
    expect(aSeesB.some((r) => r.content.includes(secretWordB))).toBe(false);
    expect(bSeesOwn.some((r) => r.content.includes(secretWordB))).toBe(true);
    expect(bSeesA.some((r) => r.content.includes(secretWordA))).toBe(false);
  }, 30_000);

  it("§29.u Obsidian-dokumenter respekterer tenant-isolasjon EKSAKT som filesystem/GitHub", async () => {
    const secretWordA = `ObsTenantA${randomUUID().replace(/-/g, "")}`;
    const secretWordB = `ObsTenantB${randomUUID().replace(/-/g, "")}`;
    const vaultA = await mkdtemp(join(tmpdir(), "jarvis-p1a-vault-a-"));
    const vaultB = await mkdtemp(join(tmpdir(), "jarvis-p1a-vault-b-"));
    await writeFile(join(vaultA, "notat.md"), secretWordA);
    await writeFile(join(vaultB, "notat.md"), secretWordB);

    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    await sync.sync(tenantA, "personal", new ObsidianVaultKnowledgeSource(vaultA, "obsidian:isolation-a"));
    await sync.sync(tenantB, "personal", new ObsidianVaultKnowledgeSource(vaultB, "obsidian:isolation-b"));

    const retriever = new KnowledgeRetriever(appPool, embedding);
    const aSeesB = await retriever.search(tenantA, { query: secretWordB, spaces: ["personal"] });
    const bSeesA = await retriever.search(tenantB, { query: secretWordA, spaces: ["personal"] });
    // Se kommentaren i §29.t - vektor-halvparten kan gi lav-score treff på
    // tenantens EGNE dokumenter; det som beviser isolasjon er fravær av den
    // andre tenantens hemmelige ord i innholdet, ikke et rått treff-antall.
    expect(aSeesB.some((r) => r.content.includes(secretWordB))).toBe(false);
    expect(bSeesA.some((r) => r.content.includes(secretWordA))).toBe(false);
  }, 30_000);
});

describe("UA-2 P1A kryssgående: retrieval (FTS/vector/hybrid) via SAMME retriever - ingen egen vei per kildetype", () => {
  it("§29.v et Drive-sourced dokument er søkbart via KnowledgeRetriever helt som ethvert annet dokument", async () => {
    const sentinel = `DriveRetrieval${randomUUID().replace(/-/g, "")}`;
    const gateway = driveGateway([{ id: "retr-1", name: "r.txt", mimeType: "text/plain", content: `Jarvis bruker ${sentinel} i produksjon.` }]);

    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    await sync.sync(tenantA, "personal", new GoogleDriveKnowledgeSource(gateway, tenantA, { kind: "whole_drive" }, "drive:retrieval-test"));

    const retriever = new KnowledgeRetriever(appPool, embedding);
    const found = await retriever.search(tenantA, { query: sentinel, spaces: ["personal"] });
    expect(found.some((r) => r.content.includes(sentinel) && r.provenance.source_type === "google_drive")).toBe(true);
  }, 30_000);
});

describe("UA-2 P1A kryssgående: observability - INGEN full dokument-body i audit_events", () => {
  it("§29.w Drive-innhold havner ALDRI i audit_events.payload - kun identifiers/scopes/credential_ref", async () => {
    const sentinel = `AuditRedactionSentinel${randomUUID().replace(/-/g, "")}`;
    const gateway = driveGateway([{ id: "audit-1", name: "a.txt", mimeType: "text/plain", content: sentinel }]);

    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    await sync.sync(tenantA, "personal", new GoogleDriveKnowledgeSource(gateway, tenantA, { kind: "whole_drive" }, "drive:audit-test"));

    const rows = await adminPool.query(
      "SELECT payload::text AS payload_text FROM audit_events WHERE tenant_id=$1 AND tool_id='drive'",
      [tenantA.tenant_id]
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows as Array<{ payload_text: string }>) {
      expect(row.payload_text.includes(sentinel)).toBe(false);
    }
  }, 30_000);
});

describe("UA-2 P1A kryssgående: Drive restore/reactivation", () => {
  it("§29.x en Drive-fil som forsvinner (trashed) og SENERE dukker opp igjen (untrashed) reaktiveres deterministisk", async () => {
    const files: FakeDriveDoc[] = [{ id: "restore-1", name: "r.txt", mimeType: "text/plain", content: "stabilt-innhold" }];

    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const source = () => new GoogleDriveKnowledgeSource(driveGateway(files), tenantA, { kind: "whole_drive" }, "drive:restore-test");

    const first = await sync.sync(tenantA, "personal", source());
    expect(first).toMatchObject({ created: 1 });

    files.length = 0; // trashed=true i ekte Drive -> forsvinner fra neste vellykkede listing
    const gone = await sync.sync(tenantA, "personal", source());
    expect(gone.tombstoned).toBe(1);

    files.push({ id: "restore-1", name: "r.txt", mimeType: "text/plain", content: "stabilt-innhold" }); // untrashed - SAMME fil-id
    const restored = await sync.sync(tenantA, "personal", source());
    expect(restored.reactivated).toBe(1);

    const row = await adminPool.query(
      "SELECT deleted FROM knowledge_documents WHERE tenant_id=$1 AND source_type='google_drive' AND external_id='restore-1'",
      [tenantA.tenant_id]
    );
    expect((row.rows[0] as { deleted: boolean }).deleted).toBe(false);
  }, 30_000);
});
