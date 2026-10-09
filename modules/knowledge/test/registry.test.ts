import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";
import { KnowledgeSourceRegistry, UnknownSourceInstanceError, type KnowledgeSourceConfig } from "../src/registry.ts";
import { FilesystemKnowledgeSource } from "../src/filesystem-source.ts";
import { GithubKnowledgeSource } from "../src/github-source.ts";
import { ObsidianVaultKnowledgeSource } from "../src/obsidian-source.ts";
import { EmailAttachmentKnowledgeSource } from "../src/email-attachment-source.ts";
import type { ImageInput, OcrProvider, VisionDescriptionProvider } from "../src/ocr-provider.ts";

/**
 * UA-2 P1A §17: registry-modellen - typet, flere-instans, tenant/space-bundet,
 * INGEN cross-tenant default, INGEN implisitt/global kilde.
 */
describe("KnowledgeSourceRegistry - config/tenant-binding (ingen DB nødvendig)", () => {
  it("forTenant() returnerer KUN instanser for eksakt (tenant, space) - aldri en annen tenants konfig", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "jarvis-reg-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "jarvis-reg-b-"));
    const configs: KnowledgeSourceConfig[] = [
      { source_type: "filesystem", tenant_id: "tenant-a", memory_space_id: "personal", source_instance_id: "docs", root_path: rootA },
      { source_type: "filesystem", tenant_id: "tenant-b", memory_space_id: "personal", source_instance_id: "docs", root_path: rootB },
      { source_type: "filesystem", tenant_id: "tenant-a", memory_space_id: "business", source_instance_id: "docs", root_path: rootA }
    ];
    const registry = new KnowledgeSourceRegistry(configs);

    const forA = registry.forTenant("tenant-a", "personal");
    expect(forA).toHaveLength(1);
    expect(forA[0]?.tenant_id).toBe("tenant-a");
    expect(forA[0]?.memory_space_id).toBe("personal");

    const forB = registry.forTenant("tenant-b", "personal");
    expect(forB).toHaveLength(1);
    expect(forB[0]?.tenant_id).toBe("tenant-b");

    // Samme tenant, annet space - egen liste, ikke slått sammen med "personal":
    expect(registry.forTenant("tenant-a", "business")).toHaveLength(1);

    // Ukonfigurert kombinasjon - alltid tom, ALDRI en implisitt/global kilde:
    expect(registry.forTenant("tenant-c", "personal")).toHaveLength(0);
  });

  it("to tenants kan begge ha en instans med SAMME source_instance_id uten kollisjon", () => {
    const configs: KnowledgeSourceConfig[] = [
      { source_type: "github", tenant_id: "tenant-a", memory_space_id: "project", source_instance_id: "gh-main", repo: "org/a" },
      { source_type: "github", tenant_id: "tenant-b", memory_space_id: "project", source_instance_id: "gh-main", repo: "org/b" }
    ];
    const registry = new KnowledgeSourceRegistry(configs);
    const a = registry.forTenant("tenant-a", "project")[0];
    const b = registry.forTenant("tenant-b", "project")[0];
    expect(a?.source_type === "github" && a.repo).toBe("org/a");
    expect(b?.source_type === "github" && b.repo).toBe("org/b");
  });

  it("flere instanser av SAMME kildetype for én tenant/space bygges som distinkte kilder", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "jarvis-reg-multi-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "jarvis-reg-multi-b-"));
    await writeFile(join(rootA, "fil-a.md"), "innhold a");
    await writeFile(join(rootB, "fil-b.md"), "innhold b");
    const configs: KnowledgeSourceConfig[] = [
      { source_type: "filesystem", tenant_id: "tenant-a", memory_space_id: "personal", source_instance_id: "root-a", root_path: rootA },
      { source_type: "filesystem", tenant_id: "tenant-a", memory_space_id: "personal", source_instance_id: "root-b", root_path: rootB }
    ];
    const registry = new KnowledgeSourceRegistry(configs);
    expect(registry.forTenant("tenant-a", "personal")).toHaveLength(2);

    const sourceA = registry.build("tenant-a", "personal", "root-a");
    const sourceB = registry.build("tenant-a", "personal", "root-b");
    expect(sourceA.source_instance_id).toBe("root-a");
    expect(sourceB.source_instance_id).toBe("root-b");
    const { records: recordsA } = await sourceA.list();
    const { records: recordsB } = await sourceB.list();
    expect(recordsA[0]?.content).toBe("innhold a");
    expect(recordsB[0]?.content).toBe("innhold b");
  });

  it("build() for en ukonfigurert (tenant, space, instans) kaster UnknownSourceInstanceError - ikke en stille no-op-kilde", () => {
    const registry = new KnowledgeSourceRegistry([]);
    expect(() => registry.build("tenant-x", "personal", "ghost")).toThrow(UnknownSourceInstanceError);
  });

  it("build() av filesystem-config gir en fungerende FilesystemKnowledgeSource", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-reg-fs-"));
    await writeFile(join(root, "a.md"), "hei");
    const registry = new KnowledgeSourceRegistry([
      { source_type: "filesystem", tenant_id: "t1", memory_space_id: "personal", source_instance_id: "fs1", root_path: root }
    ]);
    const source = registry.build("t1", "personal", "fs1");
    expect(source).toBeInstanceOf(FilesystemKnowledgeSource);
    const { records } = await source.list();
    expect(records).toHaveLength(1);
  });

  it("build() av github-config UTEN injisert ToolGateway+identity kaster eksplisitt (aldri en stille tom kilde)", () => {
    const registry = new KnowledgeSourceRegistry([
      { source_type: "github", tenant_id: "t1", memory_space_id: "project", source_instance_id: "gh1", repo: "org/repo" }
    ]);
    expect(() => registry.build("t1", "project", "gh1")).toThrow("github_source_requires_tool_gateway_and_identity");
  });

  it("build() av obsidian-config gir en fungerende ObsidianVaultKnowledgeSource", () => {
    const registry = new KnowledgeSourceRegistry([
      { source_type: "obsidian", tenant_id: "t1", memory_space_id: "personal", source_instance_id: "vault1", vault_root: "/tmp/vault" }
    ]);
    const source = registry.build("t1", "personal", "vault1");
    expect(source).toBeInstanceOf(ObsidianVaultKnowledgeSource);
    expect(source.source_instance_id).toBe("vault1");
  });

  it("build() av google_drive-config UTEN injisert ToolGateway+identity kaster eksplisitt", () => {
    const registry = new KnowledgeSourceRegistry([
      { source_type: "google_drive", tenant_id: "t1", memory_space_id: "personal", source_instance_id: "drive1", scope: { kind: "whole_drive" }, account: "acc" }
    ]);
    expect(() => registry.build("t1", "personal", "drive1")).toThrow("google_drive_source_requires_tool_gateway_and_identity");
  });

  it("build() av email_attachment-config UTEN injisert ToolGateway/identity/ocr kaster eksplisitt (UA-2 P1B-A - 'ocr' er et TREDJE påkrevd avhengighet, ikke bare to som Drive/GitHub)", () => {
    const registry = new KnowledgeSourceRegistry([
      { source_type: "email_attachment", tenant_id: "t1", memory_space_id: "personal", source_instance_id: "email1", account: "post@tsworkflow.com" }
    ]);
    expect(() => registry.build("t1", "personal", "email1")).toThrow("email_attachment_source_requires_tool_gateway_identity_and_ocr");
  });
});

describe("KnowledgeSourceRegistry - github-fabrikk med ekte ToolGateway (Postgres nødvendig)", () => {
  let PORT = 0;
  let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
  let epg: InstanceType<typeof EmbeddedPostgres>;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  const identity: IdentityContext = {
    person_id: "person-1", tenant_id: "tenant-reg-gh", memory_space_id: "project",
    session_id: "s1", device_id: "d1", channel: "api", auth_strength: "active"
  };

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-reg-gh-"));
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
    await adminPool.query("CREATE ROLE jarvis_reg_gh LOGIN PASSWORD 'pw2'");
    await adminPool.query("GRANT jarvis_app TO jarvis_reg_gh");
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-reg-gh','Reg-GH','person');
      INSERT INTO people (person_id, display_name) VALUES ('person-1','Tobias');
      INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-1','tenant-reg-gh');
    `);
    appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_reg_gh", password: "pw2" });
  }, 240_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    await stopEmbeddedPostgres?.();
  }, 120_000);

  it("build() av github-config MED injiserte avhengigheter gir en fungerende GithubKnowledgeSource", async () => {
    const devices = new InMemoryDeviceRegistry();
    const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
    const secrets: SecretProvider = { name: "test", async get() { return "fake-pat"; } };
    const toolGateway = new ToolGateway(appPool, policy, secrets);
    const githubTransport = new FakeTransport((action) => {
      if (action === "read_repo_meta") {
        return { data: { full_name: "org/repo", description: "desc", updated_at: "2026-08-16T00:00:00Z", default_branch: "main" } };
      }
      if (action === "read_issues") return { data: { issues: [] } };
      throw new Error(`uventet action: ${action}`);
    });
    for (const tool of firstWaveTools({ github: githubTransport })) toolGateway.register(tool);

    const registry = new KnowledgeSourceRegistry([
      { source_type: "github", tenant_id: "tenant-reg-gh", memory_space_id: "project", source_instance_id: "gh1", repo: "org/repo" }
    ]);
    const source = registry.build("tenant-reg-gh", "project", "gh1", { toolGateway, identity });
    expect(source).toBeInstanceOf(GithubKnowledgeSource);
    // WP-D1: en konfigurert kilde (`JARVIS_KNOWLEDGE_SOURCES`) har sin EGEN instans-id for alle kildetyper (tidligere ble den stille ignorert for GitHub og erstattet av `github:<repo>`).
    expect(source.source_instance_id).toBe("gh1");
    // Direkte konstruksjon uten id beholder den gamle avledede identiteten.
    expect(new GithubKnowledgeSource(toolGateway, identity, "org/repo").source_instance_id).toBe("github:org/repo");
    const { records } = await source.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.external_id).toBe("repo:org/repo");
  }, 30_000);

  it("build() av email_attachment-config MED injiserte avhengigheter (inkl. ocr) gir en fungerende EmailAttachmentKnowledgeSource, max/query fra config sendes videre", async () => {
    const devices = new InMemoryDeviceRegistry();
    const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
    const secrets: SecretProvider = { name: "test", async get() { return "fake-email-token"; } };
    const toolGateway = new ToolGateway(appPool, policy, secrets);
    let capturedMax: unknown;
    const emailTransport = new FakeTransport((action, parameters) => {
      if (action === "list_messages") {
        capturedMax = parameters["max"];
        return { data: { messages: [{ id: "m1", thread: "t1", from: "a@b.no", subject: "Hei", at: "2026-08-16T00:00:00Z", body_text: "innhold", attachments: [], account: "post@tsworkflow.com" }] } };
      }
      throw new Error(`uventet action: ${action}`);
    });
    for (const tool of firstWaveTools({ email: emailTransport })) toolGateway.register(tool);
    const noopOcr: OcrProvider & VisionDescriptionProvider = {
      async transcribeText(_image: ImageInput) { return ""; },
      async describeImage(_image: ImageInput) { return ""; }
    };

    const registry = new KnowledgeSourceRegistry([
      { source_type: "email_attachment", tenant_id: "tenant-reg-gh", memory_space_id: "project", source_instance_id: "email1", account: "post@tsworkflow.com", max: 7 }
    ]);
    const source = registry.build("tenant-reg-gh", "project", "email1", { toolGateway, identity, ocr: noopOcr });
    expect(source).toBeInstanceOf(EmailAttachmentKnowledgeSource);
    expect(source.source_instance_id).toBe("email1");
    const { records } = await source.list();
    expect(records).toHaveLength(1);
    expect(capturedMax).toBe(7);
  }, 30_000);
});
