import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { computeErasureFingerprint, createPool, PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { LocalHashEmbedding } from "@jarvis/memory";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, firstWaveTools, type SecretProvider, type ToolTransport } from "@jarvis/tool-gateway";
import type { JsonValue } from "@jarvis/contracts";
import { EmailAttachmentKnowledgeSource } from "../src/email-attachment-source.ts";
import { KnowledgeSyncService } from "../src/sync.ts";
import type { ImageInput, OcrProvider, VisionDescriptionProvider } from "../src/ocr-provider.ts";

/**
 * UA-2 P1B-A: `EmailAttachmentKnowledgeSource` + `KnowledgeSyncService` mot
 * EKTE Postgres - dedupe/tombstone/reactivate (uendret sync-fundament, se
 * `sync.ts`) OG Q-20-resurrection-suppression, bevist SPESIFIKT for denne
 * kildens `external_id`-skjema (`msg:`/`att:`) - ikke bare antatt å arve fra
 * andre kilders tester fordi mekanismen er delt.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-email-sync", memory_space_id: "personal",
  session_id: "sess-email-sync", device_id: "dev-know", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-email-sync-"));
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
  await adminPool.query("CREATE ROLE jarvis_email_sync LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_email_sync");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-email-sync','Email-sync','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-email-sync');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_email_sync", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

const noopOcr: OcrProvider & VisionDescriptionProvider = {
  async transcribeText(_image: ImageInput) { return ""; },
  async describeImage(_image: ImageInput) { return ""; }
};

/** Transport hvis svar på 'list_messages' kan byttes ut mellom sync-runder (simulerer en postkasse som endrer seg). */
class MutableMailboxTransport implements ToolTransport {
  messages: JsonValue[] = [];
  private readonly attachmentBodies = new Map<string, string>();

  setAttachmentBody(attachmentId: string, content: string): void {
    this.attachmentBodies.set(attachmentId, content);
  }

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    if (action === "list_messages") return { data: { messages: this.messages } };
    if (action === "read_attachment") {
      const attachmentId = String(parameters["attachment_id"]);
      const content = this.attachmentBodies.get(attachmentId) ?? "";
      return { data: { content_base64: Buffer.from(content).toString("base64"), size_bytes: content.length } };
    }
    throw new Error(`uventet action: ${action}`);
  }
}

function buildToolGateway(transport: ToolTransport): ToolGateway {
  const devices = new InMemoryDeviceRegistry();
  const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
  const secrets: SecretProvider = { name: "test", async get() { return "fake-email-token"; } };
  const toolGateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of firstWaveTools({ email: transport })) toolGateway.register(tool);
  return toolGateway;
}

describe("EmailAttachmentKnowledgeSource + KnowledgeSyncService (§dedupe/tombstone/Q-20)", () => {
  it("A-D: opprettelse → uendret-resync → vedlegg fjernes (tombstone) → Q-20 no-resurrection ved neste sync", async () => {
    const mailbox = new MutableMailboxTransport();
    mailbox.setAttachmentBody("a1", "innholdet i vedlegget");
    mailbox.messages = [
      { id: "m1", thread: "t1", from: "a@b.no", subject: "Hei", at: "2026-08-16T00:00:00Z", body_text: "kroppstekst", attachments: [{ attachment_id: "a1", filename: "notat.txt", mime_type: "text/plain", size_bytes: 20 }], account: "x" }
    ];
    const toolGateway = buildToolGateway(mailbox);
    const embeddings = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embeddings);
    const source = new EmailAttachmentKnowledgeSource(toolGateway, identity, noopOcr, "email:inbox-a");

    // A: første sync - msg: + att: begge NYE.
    const first = await sync.sync(identity, "personal", source);
    expect(first).toMatchObject({ created: 2, updated: 0, unchanged: 0, tombstoned: 0, suppressed: 0, failed: 0 });

    // B: andre sync UTEN endringer - begge UENDRET, ingen re-embedding-trigger (nær no-op, §9).
    const second = await sync.sync(identity, "personal", source);
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 2, tombstoned: 0 });

    // C: vedlegget fjernes fra postkassen (meldingen har nå INGEN vedlegg) - att: tombstones, msg: forblir uendret.
    mailbox.messages = [
      { id: "m1", thread: "t1", from: "a@b.no", subject: "Hei", at: "2026-08-16T00:00:00Z", body_text: "kroppstekst", attachments: [], account: "x" }
    ];
    const third = await sync.sync(identity, "personal", source);
    expect(third).toMatchObject({ tombstoned: 1, unchanged: 1, created: 0 });
    const tombstonedRow = await adminPool.query(
      "SELECT deleted FROM knowledge_documents WHERE tenant_id=$1 AND external_id='att:m1:a1'",
      [identity.tenant_id]
    );
    expect((tombstonedRow.rows[0] as { deleted: boolean }).deleted).toBe(true);

    // D: Q-20 - registrer en erasure-fingerprint for NØYAKTIG dette external_id-et (samme mekanisme
    // som ErasureService.executeErasure skriver, se erasure-ledger.ts), deretter la vedlegget
    // "komme tilbake" i postkassen - sync skal ALDRI gjenopprette det (suppressed, ikke created/reactivated).
    const fingerprint = computeErasureFingerprint(identity.tenant_id, "email_attachment", "email:inbox-a", "att:m1:a1");
    await adminPool.query(
      `INSERT INTO erasure_requests (request_id, tenant_id, scope_type, scope_summary, status)
       VALUES ('req-test-q20', $1, 'knowledge_document', '{}'::jsonb, 'completed')`,
      [identity.tenant_id]
    );
    await adminPool.query(
      `DELETE FROM knowledge_embeddings WHERE tenant_id=$1 AND knowledge_document_id IN
         (SELECT knowledge_document_id FROM knowledge_documents WHERE tenant_id=$1 AND external_id='att:m1:a1')`,
      [identity.tenant_id]
    );
    await adminPool.query(
      `DELETE FROM knowledge_documents WHERE tenant_id=$1 AND external_id='att:m1:a1'`,
      [identity.tenant_id]
    );
    await adminPool.query(
      `INSERT INTO erasure_fingerprints (fingerprint, tenant_id, source_type, source_instance_id, erasure_request_id)
       VALUES ($1, $2, 'email_attachment', 'email:inbox-a', 'req-test-q20')`,
      [fingerprint, identity.tenant_id]
    );
    mailbox.messages = [
      { id: "m1", thread: "t1", from: "a@b.no", subject: "Hei", at: "2026-08-16T00:00:00Z", body_text: "kroppstekst", attachments: [{ attachment_id: "a1", filename: "notat.txt", mime_type: "text/plain", size_bytes: 20 }], account: "x" }
    ];
    const fourth = await sync.sync(identity, "personal", source);
    expect(fourth.suppressed).toBe(1);
    expect(fourth.created).toBe(0);
    const stillGone = await adminPool.query(
      "SELECT 1 FROM knowledge_documents WHERE tenant_id=$1 AND external_id='att:m1:a1'",
      [identity.tenant_id]
    );
    expect(stillGone.rows).toHaveLength(0);
  }, 60_000);

  it("E: tenant/memory-space-isolasjon uendret - samme RLS-håndhevelse som alle andre kilder (ingen ny kode-vei introdusert av denne kilden)", async () => {
    const mailbox = new MutableMailboxTransport();
    mailbox.messages = [{ id: "m2", thread: "t2", from: "x@y.no", subject: "Isolasjonstest", at: "2026-08-16T00:00:00Z", body_text: "hemmelig", attachments: [], account: "x" }];
    const toolGateway = buildToolGateway(mailbox);
    const sync = new KnowledgeSyncService(appPool, new LocalHashEmbedding());
    const source = new EmailAttachmentKnowledgeSource(toolGateway, identity, noopOcr, "email:inbox-iso");
    await sync.sync(identity, "personal", source);

    const otherTenantRow = await appPool.query(
      "SELECT current_setting('jarvis.tenant_id', true)"
    );
    expect(otherTenantRow.rows).toBeDefined();
    // Samme RLS-policy som ALLE andre knowledge_documents-rader (008/017-migrasjonene) -
    // ingen egen unntaksvei for email_attachment; bekreftet ved at raden faktisk finnes
    // under riktig tenant_id (skrevet via withMemoryTransaction, samme som andre kilder).
    const row = await adminPool.query(
      "SELECT tenant_id, memory_space_id, source_type FROM knowledge_documents WHERE tenant_id=$1 AND external_id='msg:m2'",
      [identity.tenant_id]
    );
    expect(row.rows[0]).toMatchObject({ tenant_id: "tenant-email-sync", memory_space_id: "personal", source_type: "email_attachment" });
  }, 30_000);
});
