import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore, createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { FakeTransport, ToolGateway, firstWaveTools, type SecretProvider } from "@jarvis/tool-gateway";
import { GithubKnowledgeSource } from "../src/github-source.ts";
import { KnowledgeSyncService } from "../src/sync.ts";
import { LocalHashEmbedding } from "@jarvis/memory";

/**
 * UA-2 P0 §7.N: GitHub som kunnskapskilde - via EKTE ToolGateway (samme
 * policy/audit-vei som daily-brief.ts), fake transport (ingen live GitHub-
 * credential i dette testmiljøet - se sluttrapport for hva som IKKE er
 * live-verifisert).
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-gh-know", memory_space_id: "project",
  session_id: "sess-gh-know", device_id: "dev-know", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-gh-know-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_gh_know LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_gh_know");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-gh-know','GH-know','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-gh-know');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_gh_know", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("GithubKnowledgeSource + KnowledgeSyncService (§7.N)", () => {
  it("lister repo-metadata + issues som KnowledgeRecords, og synkroniserer dem via samme sync-fundament", async () => {
    const devices = new InMemoryDeviceRegistry();
    const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
    const secrets: SecretProvider = { name: "test", async get() { return "fake-github-pat"; } };
    const toolGateway = new ToolGateway(appPool, policy, secrets);
    let repoMetaCalls = 0;
    let issuesCalls = 0;
    const githubTransport = new FakeTransport((action) => {
      if (action === "read_repo_meta") {
        repoMetaCalls += 1;
        return { data: { full_name: "tsworkflow/jarvisbuild", description: "Jarvis", updated_at: "2026-08-14T00:00:00Z", default_branch: "main" } };
      }
      if (action === "read_issues") {
        issuesCalls += 1;
        return { data: { issues: [{ id: "42", title: "Legg til UA-2 knowledge layer", at: "2026-08-14T00:00:00Z", is_pr: "false", ci_failing: "false" }] } };
      }
      throw new Error(`uventet action: ${action}`);
    });
    for (const tool of firstWaveTools({ github: githubTransport })) toolGateway.register(tool);

    const source = new GithubKnowledgeSource(toolGateway, identity, "tsworkflow/jarvisbuild");
    const records = await source.list();

    expect(repoMetaCalls).toBe(1);
    expect(issuesCalls).toBe(1);
    expect(records).toHaveLength(2);
    const repoRecord = records.find((r) => r.metadata["kind"] === "repo_meta");
    expect(repoRecord?.external_id).toBe("repo:tsworkflow/jarvisbuild");
    expect(repoRecord?.source_type).toBe("github");
    const issueRecord = records.find((r) => r.metadata["kind"] === "issue");
    expect(issueRecord?.external_id).toBe("issue:42");
    expect(issueRecord?.title).toContain("UA-2 knowledge layer");

    // Går gjennom SAMME sync-fundament som filesystem-kilden (§9: idempotent).
    const embedding = new LocalHashEmbedding();
    const sync = new KnowledgeSyncService(appPool, embedding);
    const report = await sync.sync(identity, "project", source);
    expect(report).toMatchObject({ scanned: 2, created: 2, failed: 0 });

    const resync = await sync.sync(identity, "project", source);
    expect(resync).toMatchObject({ scanned: 2, created: 0, unchanged: 2, failed: 0 }); // §9: no-op ved uendret kilde
  }, 30_000);

  it("ukjent verktøy/policy-avslag rapporteres som 'failed' i sync, ikke en krasjet hel kjøring", async () => {
    const devices = new InMemoryDeviceRegistry();
    const policy = new PolicyGateway({ devices, nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch() });
    // Ingen github-transport registrert -> ToolGateway.execute() gir unknown_tool/DENY, ikke throw:
    const toolGateway = new ToolGateway(appPool, policy, { name: "test", async get() { return "x"; } });
    const source = new GithubKnowledgeSource(toolGateway, identity, "tsworkflow/jarvisbuild");
    const records = await source.list();
    // GithubKnowledgeSource behandler ok:false som "ingen record fra denne handlingen" - ikke en kastet feil:
    expect(records).toHaveLength(0);
  });
});
