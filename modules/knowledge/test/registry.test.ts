import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore, createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";
import { KnowledgeSourceRegistry, UnknownSourceInstanceError, type KnowledgeSourceConfig } from "../src/registry.ts";
import { FilesystemKnowledgeSource } from "../src/filesystem-source.ts";
import { GithubKnowledgeSource } from "../src/github-source.ts";
import { ObsidianVaultKnowledgeSource } from "../src/obsidian-source.ts";

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
});

describe("KnowledgeSourceRegistry - github-fabrikk med ekte ToolGateway (Postgres nødvendig)", () => {
  const PORT = 30000 + Math.floor(Math.random() * 20000);
  let epg: InstanceType<typeof EmbeddedPostgres>;
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  const identity: IdentityContext = {
    person_id: "person-1", tenant_id: "tenant-reg-gh", memory_space_id: "project",
    session_id: "s1", device_id: "d1", channel: "api", auth_strength: "active"
  };

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-reg-gh-"));
    epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
    await epg.initialise();
    await epg.start();
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
    await epg?.stop();
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
    expect(source.source_instance_id).toBe("github:org/repo");
    const { records } = await source.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.external_id).toBe("repo:org/repo");
  }, 30_000);
});
