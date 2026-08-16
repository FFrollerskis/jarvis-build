import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { PgApprovalStore, createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";
import { GoogleDriveKnowledgeSource } from "../src/drive-source.ts";
import { KnowledgeSourceError } from "../src/source.ts";
import { KnowledgeSyncService } from "../src/sync.ts";
import { LocalHashEmbedding } from "@jarvis/memory";

/**
 * UA-2 P1A §25/§29: Google Drive som kunnskapskilde - via EKTE ToolGateway
 * (samme policy/audit-vei som GithubKnowledgeSource), FakeTransport (ingen
 * live Google-credential i dette testmiljøet - se sluttrapporten for hva som
 * IKKE er live-verifisert).
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-drive-know", memory_space_id: "project",
  session_id: "sess-drive-know", device_id: "dev-know", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-drive-know-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_drive_know LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_drive_know");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-drive-know','Drive-know','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-drive-know');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_drive_know", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  parent?: string | undefined; // undefined = rot-mappen som ble spurt om
}

/** Bygger en FakeTransport som simulerer en Drive-fil/mappe-struktur, med paginering (maxPageSize filer per side). */
function buildDriveTransport(files: FakeDriveFile[], opts: { maxPageSize?: number; failOn?: (action: string, params: Record<string, JsonValue>) => string | undefined } = {}) {
  const maxPageSize = opts.maxPageSize ?? 100;
  return new FakeTransport((action, parameters) => {
    if (opts.failOn) {
      const failure = opts.failOn(action, parameters ?? {});
      if (failure) throw new Error(failure);
    }
    if (action === "list_files") {
      const folderId = parameters?.["folder_id"] as string | undefined;
      const pageToken = parameters?.["page_token"] as string | undefined;
      const matching = files.filter((f) => f.parent === folderId);
      const offset = pageToken ? Number(pageToken) : 0;
      const page = matching.slice(offset, offset + maxPageSize);
      const nextOffset = offset + maxPageSize;
      return {
        data: {
          files: page.map((f) => ({ id: f.id, name: f.name, mime_type: f.mimeType, modified_at: f.modifiedTime ?? null, size_bytes: null })),
          next_page_token: nextOffset < matching.length ? String(nextOffset) : null
        }
      };
    }
    if (action === "read_document") {
      const documentId = parameters?.["document_id"] as string;
      const file = files.find((f) => f.id === documentId);
      if (!file) throw new Error("drive_not_found_" + documentId);
      // Innhold følger den stabile fil-id-en, IKKE navnet - en omdøpning i ekte
      // Drive endrer aldri filens eksporterte innhold, kun metadata (§29.g).
      return { data: { content: `innhold-for-${file.id}`, content_type: file.mimeType } };
    }
    throw new Error(`uventet action: ${action}`);
  });
}

function makeGateway(transport: FakeTransport) {
  const devices = new InMemoryDeviceRegistry();
  const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
  const secrets: SecretProvider = { name: "test", async get() { return "fake-google-token"; } };
  const toolGateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of firstWaveTools({ drive: transport })) toolGateway.register(tool);
  return toolGateway;
}

describe("GoogleDriveKnowledgeSource (§25/§29)", () => {
  it("§29.a whole_drive-scope lister filer uten folder_id-filter", async () => {
    const files: FakeDriveFile[] = [
      { id: "f1", name: "a.txt", mimeType: "text/plain", parent: undefined },
      { id: "f2", name: "b.md", mimeType: "text/markdown", parent: undefined }
    ];
    const gateway = makeGateway(buildDriveTransport(files));
    const source = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "whole_drive" });
    expect(source.source_instance_id).toBe("drive:whole_drive");
    const { records, skipped } = await source.list();
    expect(records).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });

  it("§29.b folder-scope spør KUN med det konfigurerte folder_id - importerer ALDRI hele driven", async () => {
    const files: FakeDriveFile[] = [
      { id: "in-scope", name: "inne.txt", mimeType: "text/plain", parent: "folder-1" },
      { id: "out-of-scope", name: "utenfor.txt", mimeType: "text/plain", parent: undefined } // rot, IKKE i folder-1
    ];
    const gateway = makeGateway(buildDriveTransport(files));
    const source = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "folder", folder_id: "folder-1" });
    expect(source.source_instance_id).toBe("drive:folder-1");
    const { records } = await source.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.external_id).toBe("in-scope");
  });

  it("§29.c folder-scope er REKURSIV - finner filer i undermapper av den konfigurerte roten", async () => {
    const files: FakeDriveFile[] = [
      { id: "sub-folder", name: "Undermappe", mimeType: "application/vnd.google-apps.folder", parent: "root-folder" },
      { id: "top-file", name: "topp.txt", mimeType: "text/plain", parent: "root-folder" },
      { id: "nested-file", name: "dyp.txt", mimeType: "text/plain", parent: "sub-folder" }
    ];
    const gateway = makeGateway(buildDriveTransport(files));
    const source = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "folder", folder_id: "root-folder" });
    const { records } = await source.list();
    const ids = records.map((r) => r.external_id).sort();
    expect(ids).toEqual(["nested-file", "top-file"]);
  });

  it("§29.d paginering aggregeres INTERNT - list() returnerer alle sider som ett komplett resultat", async () => {
    const files: FakeDriveFile[] = Array.from({ length: 5 }, (_, i) => ({
      id: `page-file-${i}`, name: `fil-${i}.txt`, mimeType: "text/plain", parent: undefined
    }));
    const gateway = makeGateway(buildDriveTransport(files, { maxPageSize: 2 }));
    const source = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "whole_drive" });
    const { records } = await source.list();
    expect(records).toHaveLength(5);
  });

  it("§29.e Google Docs eksporteres til text/plain, ustøttede Google-native typer (Sheets) hoppes over trygt", async () => {
    const files: FakeDriveFile[] = [
      { id: "doc-1", name: "Dokument", mimeType: "application/vnd.google-apps.document", parent: undefined },
      { id: "sheet-1", name: "Regneark", mimeType: "application/vnd.google-apps.spreadsheet", parent: undefined }
    ];
    const gateway = makeGateway(buildDriveTransport(files));
    const source = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "whole_drive" });
    const { records, skipped } = await source.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.external_id).toBe("doc-1");
    expect(records[0]?.content_type).toBe("text/plain");
    expect(skipped).toEqual([{ external_id: "sheet-1", reason: "UNSUPPORTED_CONTENT", detail: "application/vnd.google-apps.spreadsheet" }]);
  });

  it("§29.f binærfiler/bilder (ukjent MIME) hoppes over trygt - ALDRI lest som søppel-tekst", async () => {
    const files: FakeDriveFile[] = [
      { id: "img-1", name: "bilde.png", mimeType: "image/png", parent: undefined },
      { id: "pdf-1", name: "dok.pdf", mimeType: "application/pdf", parent: undefined },
      { id: "ok-1", name: "ok.txt", mimeType: "text/plain", parent: undefined }
    ];
    const gateway = makeGateway(buildDriveTransport(files));
    const source = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "whole_drive" });
    const { records, skipped } = await source.list();
    expect(records).toHaveLength(1);
    expect(skipped.map((s) => s.external_id).sort()).toEqual(["img-1", "pdf-1"]);
    expect(skipped.every((s) => s.reason === "UNSUPPORTED_CONTENT")).toBe(true);
  });

  it("§29.g rename-stable-identity: samme external_id (Drive file id) overlever en tittelendring - sync ser IKKE slett+ny", async () => {
    const files: FakeDriveFile[] = [{ id: "stable-1", name: "gammelt-navn.txt", mimeType: "text/plain", parent: undefined }];
    const gateway = makeGateway(buildDriveTransport(files));
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);

    const source1 = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "whole_drive" }, "drive-rename-test");
    const first = await sync.sync(identity, "project", source1);
    expect(first).toMatchObject({ created: 1, updated: 0, tombstoned: 0 });

    const file = files[0];
    if (!file) throw new Error("test setup: files[0] mangler");
    file.name = "nytt-navn.txt"; // omdøpt i Drive - SAMME id
    const source2 = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "whole_drive" }, "drive-rename-test");
    const second = await sync.sync(identity, "project", source2);
    // Innhold uendret (samme fil-id, samme fake-innhold) -> "unchanged", IKKE created/tombstoned:
    expect(second).toMatchObject({ created: 0, unchanged: 1, tombstoned: 0 });

    const row = await adminPool.query(
      "SELECT title FROM knowledge_documents WHERE tenant_id=$1 AND source_type='google_drive' AND external_id='stable-1'",
      [identity.tenant_id]
    );
    expect((row.rows[0] as { title: string }).title).toBe("nytt-navn.txt"); // tittelen ble likevel oppdatert
  }, 30_000);

  it("§29.h transient nettverksfeil på ÉN fil-lesing skipper KUN den filen - tombstoner IKKE et tidligere synkronisert dokument", async () => {
    const files: FakeDriveFile[] = [
      { id: "stable-a", name: "a.txt", mimeType: "text/plain", parent: undefined },
      { id: "flaky-b", name: "b.txt", mimeType: "text/plain", parent: undefined }
    ];
    let failNext = false;
    const gateway = makeGateway(
      buildDriveTransport(files, {
        failOn: (action, params) => {
          if (failNext && action === "read_document" && params["document_id"] === "flaky-b") return "drive_rate_limited";
          return undefined;
        }
      })
    );
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const source = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "whole_drive" }, "drive-transient-test");

    const first = await sync.sync(identity, "project", source);
    expect(first).toMatchObject({ created: 2, tombstoned: 0 });

    failNext = true; // neste runde: "flaky-b" feiler forbigående ved lesing
    const second = await sync.sync(identity, "project", source);
    expect(second.skipped).toBe(1);
    expect(second.tombstoned).toBe(0); // §15: IKKE tolket som slettet

    const row = await adminPool.query(
      "SELECT deleted FROM knowledge_documents WHERE tenant_id=$1 AND source_type='google_drive' AND external_id='flaky-b'",
      [identity.tenant_id]
    );
    expect((row.rows[0] as { deleted: boolean }).deleted).toBe(false); // fortsatt aktivt, ikke tombstonet
  }, 30_000);

  it("§29.i deletion-tombstone: en fil som FAKTISK forsvinner fra en vellykket listing (trashed) tombstones normalt", async () => {
    const files: FakeDriveFile[] = [{ id: "will-vanish", name: "vanish.txt", mimeType: "text/plain", parent: undefined }];
    const gateway = makeGateway(buildDriveTransport(files));
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const source1 = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "whole_drive" }, "drive-tombstone-test");
    await sync.sync(identity, "project", source1);

    files.length = 0; // fila er nå trashed=true (transporten filtrerer alltid trashed=false server-side i ekte Drive)
    const source2 = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "whole_drive" }, "drive-tombstone-test");
    const report = await sync.sync(identity, "project", source2);
    expect(report.tombstoned).toBe(1);
  }, 30_000);

  it("§29.j en AUTH-feil på fil-lesing eskaleres til TOTAL svikt (KnowledgeSourceError) - ALDRI feiltolket som at filer er slettet", async () => {
    const files: FakeDriveFile[] = [{ id: "a", name: "a.txt", mimeType: "text/plain", parent: undefined }];
    const gateway = makeGateway(
      buildDriveTransport(files, { failOn: (action) => (action === "read_document" ? "drive_auth_error_401" : undefined) })
    );
    const source = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "whole_drive" });
    await expect(source.list()).rejects.toThrow(KnowledgeSourceError);

    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const report = await sync.sync(identity, "project", source);
    expect(report.failed).toBe(1);
    expect(report.tombstoned).toBe(0);
    expect(report.error_class).toBe("AUTH");
  }, 30_000);

  it("§29.k en feilende listing (ikke enkeltfil) kaster KnowledgeSourceError - hele kilden feiler synlig, ingen partiell tombstoning", async () => {
    const files: FakeDriveFile[] = [{ id: "a", name: "a.txt", mimeType: "text/plain", parent: undefined }];
    const gateway = makeGateway(
      buildDriveTransport(files, { failOn: (action) => (action === "list_files" ? "drive_list_error_500" : undefined) })
    );
    const source = new GoogleDriveKnowledgeSource(gateway, identity, { kind: "whole_drive" });
    await expect(source.list()).rejects.toThrow(KnowledgeSourceError);
  });
});
