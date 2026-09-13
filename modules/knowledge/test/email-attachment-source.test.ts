import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { allocateEmbeddedPostgresPort, createPool, PgApprovalStore, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools, type SecretProvider, type ToolTransport } from "@jarvis/tool-gateway";
import type { JsonValue } from "@jarvis/contracts";
import { EmailAttachmentKnowledgeSource } from "../src/email-attachment-source.ts";
import { KnowledgeSourceError } from "../src/source.ts";
import type { ImageInput, OcrProvider, VisionDescriptionProvider } from "../src/ocr-provider.ts";

/**
 * UA-2 P1B-A: `EmailAttachmentKnowledgeSource` - via EKTE `ToolGateway`
 * (samme policy/audit-vei som `github-source.test.ts`/`drive-source.test.ts`),
 * `FakeTransport` for `email` (ingen live Gmail-credential i dette
 * testmiljøet), og en deterministisk fake OCR/vision-provider (INGEN ekte
 * modellkall her - `ocr-provider.test.ts` beviser `ModelGatewayVisionExtractor`
 * separat). Ekte `pdf-parse`-avhengighet (native tekst + side-rasterisering)
 * KJØRES faktisk her mot to minimale, håndlagde test-PDF-er - IKKE mocket,
 * siden native/OCR-routingen bevisst er dokumentets ekte kjerneegenskap.
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-email-know", memory_space_id: "personal",
  session_id: "sess-email-know", device_id: "dev-know", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-email-know-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_email_know LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_email_know");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-email-know','Email-know','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-email-know');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_email_know", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

/** Minimal, GYLDIG 1-sides PDF MED lesbar native tekst (over NATIVE_TEXT_MIN_CHARS-terskelen). */
function textPdfBase64(): string {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 100] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 70 >>
stream
BT /F1 14 Tf 10 50 Td (Dette er nok native tekst til aa passere terskelen) Tj ET
endstream
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`;
  return Buffer.from(pdf).toString("base64");
}

/** Minimal, GYLDIG 1-sides PDF UTEN noe tekst-innhold (tom content stream - simulerer en skannet side). */
function blankPdfBase64(): string {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << >> /MediaBox [0 0 200 100] /Contents 5 0 R >>
endobj
5 0 obj
<< /Length 0 >>
stream
endstream
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`;
  return Buffer.from(pdf).toString("base64");
}

class FakeOcr implements OcrProvider, VisionDescriptionProvider {
  transcribeCalls: ImageInput[] = [];
  describeCalls: ImageInput[] = [];
  constructor(
    private readonly transcribeReply: (image: ImageInput) => string = () => "",
    private readonly describeReply: (image: ImageInput) => string = () => "en generell bildebeskrivelse"
  ) {}
  async transcribeText(image: ImageInput): Promise<string> {
    this.transcribeCalls.push(image);
    return this.transcribeReply(image);
  }
  async describeImage(image: ImageInput): Promise<string> {
    this.describeCalls.push(image);
    return this.describeReply(image);
  }
}

function buildGatewayWithTransport(transport: ToolTransport): ToolGateway {
  const devices = new InMemoryDeviceRegistry();
  const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
  const secrets: SecretProvider = { name: "test", async get() { return "fake-email-token"; } };
  const toolGateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of firstWaveTools({ email: transport })) toolGateway.register(tool);
  return toolGateway;
}

function buildGateway(reply: (action: string, parameters: Record<string, unknown>) => { data?: unknown }, failWith?: string): ToolGateway {
  const transport = new FakeTransport(
    (action, parameters) => reply(action, parameters) as { external_id?: string; data?: never },
    failWith
  );
  return buildGatewayWithTransport(transport);
}

/** ETT bestemt action feiler; resten svarer normalt - `FakeTransport` sin egen `failWith` er ubetinget (ALLE actions), utilstrekkelig for J. */
class SelectiveFailTransport implements ToolTransport {
  constructor(
    private readonly reply: (action: string, parameters: Record<string, JsonValue>) => { external_id?: string; data?: JsonValue },
    private readonly failingAction: string,
    private readonly failMessage: string
  ) {}
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    if (action === this.failingAction) throw new Error(this.failMessage);
    return this.reply(action, parameters);
  }
}

describe("EmailAttachmentKnowledgeSource - e-posttekst + vedlegg → KnowledgeRecord (UA-2 P1B-A)", () => {
  it("A: en melding med KUN body-tekst gir ÉTT 'msg:'-record - ingen vedlegg", async () => {
    const gateway = buildGateway((action) => {
      if (action === "list_messages") {
        return { data: { messages: [{ id: "m1", thread: "t1", from: "a@b.no", subject: "Hei", at: "2026-08-16T00:00:00Z", body_text: "Kort e-post uten vedlegg.", attachments: [], account: "post@tsworkflow.com" }] } };
      }
      throw new Error(`uventet action: ${action}`);
    });
    const source = new EmailAttachmentKnowledgeSource(gateway, identity, new FakeOcr());
    const { records, skipped } = await source.list();
    expect(skipped).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.external_id).toBe("msg:m1");
    expect(records[0]?.source_type).toBe("email_attachment");
    expect(records[0]?.content).toBe("Kort e-post uten vedlegg.");
  });

  it("B: tekst-vedlegg gir et EGET 'att:'-record med extraction_method=native", async () => {
    const gateway = buildGateway((action, params) => {
      if (action === "list_messages") {
        return { data: { messages: [{ id: "m2", thread: "t2", from: "a@b.no", subject: "Med tekstvedlegg", at: "2026-08-16T00:00:00Z", body_text: "", attachments: [{ attachment_id: "a1", filename: "notat.txt", mime_type: "text/plain", size_bytes: 20 }], account: "x" }] } };
      }
      if (action === "read_attachment") {
        expect(params["attachment_id"]).toBe("a1");
        return { data: { content_base64: Buffer.from("innholdet i notatet").toString("base64"), size_bytes: 20 } };
      }
      throw new Error(`uventet action: ${action}`);
    });
    const source = new EmailAttachmentKnowledgeSource(gateway, identity, new FakeOcr());
    const { records, skipped } = await source.list();
    expect(skipped).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.external_id).toBe("att:m2:a1");
    expect(records[0]?.content).toBe("innholdet i notatet");
    expect(records[0]?.metadata["extraction_method"]).toBe("native");
  });

  it("C: bilde-vedlegg der OCR FINNER tekst → extraction_method=ocr, vision.describeImage() kalles ALDRI", async () => {
    const ocr = new FakeOcr(() => "Fakturanummer 123");
    const gateway = buildGateway((action) => {
      if (action === "list_messages") {
        return { data: { messages: [{ id: "m3", thread: "t3", from: "a@b.no", subject: "Bilde", at: "2026-08-16T00:00:00Z", body_text: "", attachments: [{ attachment_id: "a2", filename: "skjermbilde.png", mime_type: "image/png", size_bytes: 500 }], account: "x" }] } };
      }
      if (action === "read_attachment") {
        return { data: { content_base64: "ZmFrZS1iaWxkZS1ieXRlcw==", size_bytes: 500 } };
      }
      throw new Error(`uventet action: ${action}`);
    });
    const source = new EmailAttachmentKnowledgeSource(gateway, identity, ocr);
    const { records } = await source.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.content).toBe("Fakturanummer 123");
    expect(records[0]?.metadata["extraction_method"]).toBe("ocr");
    expect(ocr.transcribeCalls).toHaveLength(1);
    expect(ocr.describeCalls).toHaveLength(0);
  });

  it("D: bilde-vedlegg der OCR IKKE finner tekst → faller tilbake til vision.describeImage(), extraction_method=vision", async () => {
    const ocr = new FakeOcr(() => "", () => "Et diagram som viser kvartalsvekst");
    const gateway = buildGateway((action) => {
      if (action === "list_messages") {
        return { data: { messages: [{ id: "m4", thread: "t4", from: "a@b.no", subject: "Diagram", at: "2026-08-16T00:00:00Z", body_text: "", attachments: [{ attachment_id: "a3", filename: "diagram.jpg", mime_type: "image/jpeg", size_bytes: 500 }], account: "x" }] } };
      }
      if (action === "read_attachment") {
        return { data: { content_base64: "ZmFrZQ==", size_bytes: 500 } };
      }
      throw new Error(`uventet action: ${action}`);
    });
    const source = new EmailAttachmentKnowledgeSource(gateway, identity, ocr);
    const { records } = await source.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.content).toBe("Et diagram som viser kvartalsvekst");
    expect(records[0]?.metadata["extraction_method"]).toBe("vision");
    expect(ocr.transcribeCalls).toHaveLength(1);
    expect(ocr.describeCalls).toHaveLength(1);
  });

  it("E: bilde der VERKEN OCR eller vision finner noe innhold → SkippedRecord UNSUPPORTED_CONTENT, INGEN record", async () => {
    const ocr = new FakeOcr(() => "", () => "");
    const gateway = buildGateway((action) => {
      if (action === "list_messages") {
        return { data: { messages: [{ id: "m5", thread: "t5", from: "a@b.no", subject: "Tomt", at: "2026-08-16T00:00:00Z", body_text: "", attachments: [{ attachment_id: "a4", filename: "tomt.png", mime_type: "image/png", size_bytes: 100 }], account: "x" }] } };
      }
      if (action === "read_attachment") {
        return { data: { content_base64: "ZmFrZQ==", size_bytes: 100 } };
      }
      throw new Error(`uventet action: ${action}`);
    });
    const source = new EmailAttachmentKnowledgeSource(gateway, identity, ocr);
    const { records, skipped } = await source.list();
    expect(records).toHaveLength(0);
    expect(skipped).toEqual([{ external_id: "att:m5:a4", reason: "UNSUPPORTED_CONTENT", detail: "vision_no_content_found" }]);
  });

  it("F: arkiv-vedlegg (zip) hoppes over UTEN at read_attachment noensinne kalles - ALDRI åpnet/utpakket", async () => {
    let readAttachmentCalled = false;
    const gateway = buildGateway((action) => {
      if (action === "list_messages") {
        return { data: { messages: [{ id: "m6", thread: "t6", from: "a@b.no", subject: "Zip", at: "2026-08-16T00:00:00Z", body_text: "", attachments: [{ attachment_id: "a5", filename: "arkiv.zip", mime_type: "application/zip", size_bytes: 1000 }], account: "x" }] } };
      }
      if (action === "read_attachment") {
        readAttachmentCalled = true;
        return { data: { content_base64: "", size_bytes: 0 } };
      }
      throw new Error(`uventet action: ${action}`);
    });
    const source = new EmailAttachmentKnowledgeSource(gateway, identity, new FakeOcr());
    const { records, skipped } = await source.list();
    expect(records).toHaveLength(0);
    expect(skipped[0]?.reason).toBe("UNSUPPORTED_CONTENT");
    expect(skipped[0]?.detail).toContain("unsupported_archive");
    expect(readAttachmentCalled).toBe(false);
  });

  it("G: for stort vedlegg hoppes over FØR download forsøkt (fail-closed størrelsesgrense)", async () => {
    let readAttachmentCalled = false;
    const gateway = buildGateway((action) => {
      if (action === "list_messages") {
        return { data: { messages: [{ id: "m7", thread: "t7", from: "a@b.no", subject: "Stor", at: "2026-08-16T00:00:00Z", body_text: "", attachments: [{ attachment_id: "a6", filename: "stor.pdf", mime_type: "application/pdf", size_bytes: 100_000_000 }], account: "x" }] } };
      }
      if (action === "read_attachment") {
        readAttachmentCalled = true;
        return { data: { content_base64: "", size_bytes: 0 } };
      }
      throw new Error(`uventet action: ${action}`);
    });
    const source = new EmailAttachmentKnowledgeSource(gateway, identity, new FakeOcr());
    const { skipped } = await source.list();
    expect(skipped[0]?.reason).toBe("UNSUPPORTED_CONTENT");
    expect(skipped[0]?.detail).toContain("attachment_too_large");
    expect(readAttachmentCalled).toBe(false);
  });

  it("H: PDF med native tekst → ÉN side-record med extraction_method=native, INGEN OCR/vision-kall", async () => {
    const ocr = new FakeOcr();
    const gateway = buildGateway((action) => {
      if (action === "list_messages") {
        return { data: { messages: [{ id: "m8", thread: "t8", from: "a@b.no", subject: "PDF", at: "2026-08-16T00:00:00Z", body_text: "", attachments: [{ attachment_id: "a7", filename: "faktura.pdf", mime_type: "application/pdf", size_bytes: 900 }], account: "x" }] } };
      }
      if (action === "read_attachment") {
        return { data: { content_base64: textPdfBase64(), size_bytes: 900 } };
      }
      throw new Error(`uventet action: ${action}`);
    });
    const source = new EmailAttachmentKnowledgeSource(gateway, identity, ocr);
    const { records, skipped } = await source.list();
    expect(skipped).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.external_id).toBe("att:m8:a7:page:1");
    expect(records[0]?.content).toContain("native tekst");
    expect(records[0]?.metadata["extraction_method"]).toBe("native");
    expect(records[0]?.metadata["page"]).toBe(1);
    expect(ocr.transcribeCalls).toHaveLength(0);
  });

  it("I: PDF UTEN native tekst (skannet side) → rastres og rutes til OCR, extraction_method=ocr", async () => {
    const ocr = new FakeOcr(() => "Transkribert fra skannet side");
    const gateway = buildGateway((action) => {
      if (action === "list_messages") {
        return { data: { messages: [{ id: "m9", thread: "t9", from: "a@b.no", subject: "Skannet", at: "2026-08-16T00:00:00Z", body_text: "", attachments: [{ attachment_id: "a8", filename: "skannet.pdf", mime_type: "application/pdf", size_bytes: 900 }], account: "x" }] } };
      }
      if (action === "read_attachment") {
        return { data: { content_base64: blankPdfBase64(), size_bytes: 900 } };
      }
      throw new Error(`uventet action: ${action}`);
    });
    const source = new EmailAttachmentKnowledgeSource(gateway, identity, ocr);
    const { records, skipped } = await source.list();
    expect(skipped).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.external_id).toBe("att:m9:a8:page:1");
    expect(records[0]?.content).toBe("Transkribert fra skannet side");
    expect(records[0]?.metadata["extraction_method"]).toBe("ocr");
    expect(ocr.transcribeCalls).toHaveLength(1);
  }, 30_000);

  it("J: AUTH-feil på read_attachment eskalerer til KAST (KnowledgeSourceError) for HELE listingen - ALDRI en stille per-vedlegg-skip", async () => {
    const transport = new SelectiveFailTransport(
      (action) => {
        if (action === "list_messages") {
          return { data: { messages: [{ id: "m10", thread: "t10", from: "a@b.no", subject: "Auth-feil", at: "2026-08-16T00:00:00Z", body_text: "", attachments: [{ attachment_id: "a9", filename: "f.txt", mime_type: "text/plain", size_bytes: 10 }], account: "x" }] } as unknown as JsonValue };
        }
        throw new Error(`uventet action: ${action}`);
      },
      "read_attachment",
      "gmail_auth_failed_401"
    );
    const gateway = buildGatewayWithTransport(transport);
    const source = new EmailAttachmentKnowledgeSource(gateway, identity, new FakeOcr());
    await expect(source.list()).rejects.toBeInstanceOf(KnowledgeSourceError);
  });

  it("K: list_messages-feil kaster KnowledgeSourceError FØR noen meldinger behandles", async () => {
    const gateway = buildGateway(() => ({}), "gmail_error_500");
    const source = new EmailAttachmentKnowledgeSource(gateway, identity, new FakeOcr());
    await expect(source.list()).rejects.toBeInstanceOf(KnowledgeSourceError);
  });

  it("L: source_instance_id default 'email:inbox' - kan overstyres eksplisitt", () => {
    const gateway = buildGateway(() => ({}));
    const defaultSource = new EmailAttachmentKnowledgeSource(gateway, identity, new FakeOcr());
    expect(defaultSource.source_instance_id).toBe("email:inbox");
    const customSource = new EmailAttachmentKnowledgeSource(gateway, identity, new FakeOcr(), "email:post@tsworkflow.com");
    expect(customSource.source_instance_id).toBe("email:post@tsworkflow.com");
  });

  it("M: source_type er alltid 'email_attachment' - stabil kildeidentitet for dedupe/Q-20-fingerprinting", () => {
    const gateway = buildGateway(() => ({}));
    const source = new EmailAttachmentKnowledgeSource(gateway, identity, new FakeOcr());
    expect(source.source_type).toBe("email_attachment");
  });
});
