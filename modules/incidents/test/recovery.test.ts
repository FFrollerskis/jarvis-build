import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations, withTenantTransaction } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider, type ToolDefinition, type ToolTransport } from "@jarvis/tool-gateway";
import { attemptRecovery, supportedRecoveryStrategies } from "../src/recovery.ts";

/**
 * D-104 Part D (before/after/recovery-konvolutt): EKTE embedded-Postgres +
 * EN EKTE `ToolGateway` (INGEN mock av selve gateway-laget) wired mot en
 * fake GitHub-transport (aldri en ekte HTTP-daemon - samme presedens som
 * `sandbox-docker-extra-env.test.ts`/`git-credential-isolation.test.ts` sin
 * "ekte mekanisme, fake ytterste transport"-stil). Beviser Part I-item
 * 5/6/7/8: recovery utføres UTELUKKENDE via `gateway.execute()`, before/
 * after-snapshot kommer fra DEN EKSISTERENDE D-pipelinen (`tool_executions.
 * before_state/after_state`, uendret), og et mislykket/ukjent recovery-
 * forsøk forblir eksplisitt FAILED/UNKNOWN - ALDRI en fabrikkert SUCCESS.
 */

const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
const TENANT = "tenant-recovery";

const identity: IdentityContext = {
  person_id: "person-owner", tenant_id: TENANT, memory_space_id: "business",
  session_id: "sess-recovery", device_id: "dev-1", channel: "api", auth_strength: "active"
};

/** In-memory "GitHub" - branches keyed by name, kan slettes/gjenopprettes. En egen boolsk styrer om create_branch skal feile (item 8). */
class FakeGithubTransport implements ToolTransport {
  readonly branches = new Map<string, { sha: string; protected: boolean }>([["feature/to-delete", { sha: "sha-original-123", protected: false }]]);
  failCreateBranch = false;

  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    if (action === "get_branch") {
      const branch = this.branches.get(parameters["branch"] as string);
      if (!branch) throw new Error("branch_not_found");
      return { data: { name: parameters["branch"] as string, sha: branch.sha, protected: branch.protected } };
    }
    if (action === "delete_branch") {
      this.branches.delete(parameters["branch"] as string);
      return { data: { branch: parameters["branch"] as string, deleted: true } };
    }
    if (action === "create_branch") {
      if (this.failCreateBranch) throw new Error("simulated_github_outage");
      const branch = parameters["branch"] as string;
      const sha = parameters["from_sha"] as string;
      this.branches.set(branch, { sha, protected: false });
      return { external_id: sha, data: { branch, sha, created: true } };
    }
    throw new Error(`unsupported_fake_action:${action}`);
  }
}

function githubToolDefinitions(transport: ToolTransport): ToolDefinition[] {
  const record = (fields: Record<string, z.ZodTypeAny>) => z.object(fields).passthrough() as unknown as ToolDefinition["input_schema"];
  return [
    {
      tool_id: "github", action: "get_branch", description: "test", input_schema: record({ repo: z.string(), branch: z.string() }),
      capability_class: "A", scopes: [], reversible: true, rollback_procedure: "n/a", idempotent_external: true,
      timeout_ms: 5_000, rate_limit_per_minute: 60, credential_ref: "FAKE_GITHUB_TOKEN", output_trust: "untrusted", transport
    },
    {
      tool_id: "github", action: "create_branch", description: "test", input_schema: record({ repo: z.string(), branch: z.string(), from_sha: z.string() }),
      capability_class: "B", scopes: [], reversible: true, rollback_procedure: "github.delete_branch", idempotent_external: true,
      timeout_ms: 5_000, rate_limit_per_minute: 60, credential_ref: "FAKE_GITHUB_TOKEN", output_trust: "internal", transport
    },
    {
      tool_id: "github", action: "delete_branch", description: "test", input_schema: record({ repo: z.string(), branch: z.string() }),
      capability_class: "D", scopes: [], reversible: true, rollback_procedure: "gjenopprett fra preflight-sha via create_branch",
      idempotent_external: false, timeout_ms: 5_000, rate_limit_per_minute: 60, credential_ref: "FAKE_GITHUB_TOKEN",
      output_trust: "internal", transport, preflight_action: "get_branch"
    }
  ];
}

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-recovery-"));
  epg = new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_recovery LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_recovery");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','Recovery','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-owner','Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-owner','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test_recovery", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

function buildGateway(transport: FakeGithubTransport): ToolGateway {
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
  });
  const secrets: SecretProvider = { name: "fake", get: async () => "fake-token" };
  const gateway = new ToolGateway(appPool, policy, secrets);
  for (const def of githubToolDefinitions(transport)) gateway.register(def);
  return gateway;
}

describe("D-104 Part D: before/after-snapshot + representativ recovery-case (EKTE ToolGateway, fake GitHub-transport)", () => {
  it("A: delete_branch skriver before_state (fra preflight get_branch) TIL tool_executions FØR sletting skjer", async () => {
    const transport = new FakeGithubTransport();
    const gateway = buildGateway(transport);
    const key = "recovery-test-key-a";
    const result = await gateway.execute({
      identity, tool_id: "github", action: "delete_branch",
      parameters: { repo: "org/repo", branch: "feature/to-delete" }, idempotency_key: key
    });
    expect(result.ok).toBe(true);
    expect(transport.branches.has("feature/to-delete")).toBe(false); // faktisk slettet
    const rows = await withTenantTransaction(appPool, TENANT, (client) =>
      client.query("SELECT before_state, after_state FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2", [TENANT, key]).then((r) => r.rows)
    );
    expect(rows[0].before_state).toEqual({ name: "feature/to-delete", sha: "sha-original-123", protected: false });
  });

  it("B: after-snapshot forsøkes ALLTID (readback), og en KORREKT null (branchen finnes ikke lenger) er et gyldig, ikke-fabrikkert resultat - ALDRI stille utelatt", async () => {
    const rows = await withTenantTransaction(appPool, TENANT, (client) =>
      client.query(
        "SELECT before_state, after_state FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2", [TENANT, "recovery-test-key-a"]
      ).then((r) => r.rows)
    );
    // Readback av get_branch FEILER korrekt (branchen finnes strukturelt ikke lenger) -
    // ToolGateway.execute() setter da after_state=null (gateway.ts:293-295) i stedet for
    // å skjule at handlingen skjedde. Dette ER det korrekte, EKTE etter-bildet for en
    // vellykket sletting, ikke en feil i mekanismen.
    expect(rows[0].after_state).toBeNull();
    expect(rows[0].before_state).not.toBeNull();
  });

  it("C: attemptRecovery() for github:delete_branch LYKTES i en representativ, EKTE recovery-case - branchen faktisk gjenopprettet fra before_state, KUN via gateway.execute() (ALDRI et direkte transport-kall)", async () => {
    const transport = new FakeGithubTransport();
    const gateway = buildGateway(transport);
    const key = "recovery-test-key-c";
    await gateway.execute({ identity, tool_id: "github", action: "delete_branch", parameters: { repo: "org/repo", branch: "feature/to-delete" }, idempotency_key: key });
    expect(transport.branches.has("feature/to-delete")).toBe(false);

    const recovery = await attemptRecovery({ pool: appPool, gateway }, identity, {
      tenant_id: TENANT, tool_id: "github", action: "delete_branch", idempotency_key: key,
      parameters: { repo: "org/repo", branch: "feature/to-delete" }
    });
    expect(recovery.status).toBe("SUCCESS");
    expect(transport.branches.get("feature/to-delete")?.sha).toBe("sha-original-123"); // gjenopprettet fra DEN FAKTISKE before_state, ikke gjettet
    // Persistert i infra_recovery_actions - reconstructable audit-linkage (item 15).
    const rows = await withTenantTransaction(appPool, TENANT, (client) =>
      client.query("SELECT status, recovery_strategy FROM infra_recovery_actions WHERE recovery_id = $1", [recovery.recovery_id]).then((r) => r.rows)
    );
    expect(rows[0].status).toBe("SUCCESS");
    expect(rows[0].recovery_strategy).toBe("github:delete_branch");
  });

  it("D: mislykket underliggende recovery-kall forblir EKSPLISITT FAILED - ALDRI fabrikkert SUCCESS (item 8)", async () => {
    const transport = new FakeGithubTransport();
    transport.failCreateBranch = true;
    const gateway = buildGateway(transport);
    const key = "recovery-test-key-d";
    await gateway.execute({ identity, tool_id: "github", action: "delete_branch", parameters: { repo: "org/repo", branch: "feature/to-delete" }, idempotency_key: key });

    const recovery = await attemptRecovery({ pool: appPool, gateway }, identity, {
      tenant_id: TENANT, tool_id: "github", action: "delete_branch", idempotency_key: key,
      parameters: { repo: "org/repo", branch: "feature/to-delete" }
    });
    expect(recovery.status).toBe("FAILED");
    expect(transport.branches.has("feature/to-delete")).toBe(false); // faktisk IKKE gjenopprettet - status matcher virkeligheten
  });

  it("E: en UKJENT tool_id:action-kombinasjon gir eksplisitt UNKNOWN, ALDRI en fabrikkert SUCCESS (item 8, ingen registrert strategi)", async () => {
    const transport = new FakeGithubTransport();
    const gateway = buildGateway(transport);
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identity, {
      tenant_id: TENANT, tool_id: "vercel", action: "rollback_deployment", idempotency_key: "no-such-key", parameters: {}
    });
    expect(recovery.status).toBe("UNKNOWN");
    expect(supportedRecoveryStrategies()).not.toContain("vercel:rollback_deployment");
    expect(supportedRecoveryStrategies()).toContain("github:delete_branch");
  });

  it("F0 (item 11): et FROSSET connector (EKSISTERENDE OwnerControls.freezeConnector(), ikke ny kode) blokkerer recovery-forsøket identisk med enhver annen mutasjon på det tool_id-et", async () => {
    const { OwnerControls, KillSwitch: KS } = await import("@jarvis/policy");
    const transport = new FakeGithubTransport();
    const killSwitch = new KS();
    const controls = new OwnerControls(killSwitch);
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls,
      authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
    });
    const secrets: SecretProvider = { name: "fake", get: async () => "fake-token" };
    const gateway = new ToolGateway(appPool, policy, secrets, controls);
    for (const def of githubToolDefinitions(transport)) gateway.register(def);

    const key = "recovery-test-key-f0";
    await gateway.execute({ identity, tool_id: "github", action: "delete_branch", parameters: { repo: "org/repo", branch: "feature/to-delete" }, idempotency_key: key });
    controls.freezeConnector("github");

    const recovery = await attemptRecovery({ pool: appPool, gateway }, identity, {
      tenant_id: TENANT, tool_id: "github", action: "delete_branch", idempotency_key: key,
      parameters: { repo: "org/repo", branch: "feature/to-delete" }
    });
    expect(recovery.status).toBe("FAILED");
    expect(transport.branches.has("feature/to-delete")).toBe(false); // ingen stille bypass gjennom recovery-veien
  });

  it("F: manglende before_state (idempotency_key finnes ikke i tool_executions) gir UNKNOWN, ALDRI et gjettet gjenopprettingsforsøk", async () => {
    const transport = new FakeGithubTransport();
    const gateway = buildGateway(transport);
    const recovery = await attemptRecovery({ pool: appPool, gateway }, identity, {
      tenant_id: TENANT, tool_id: "github", action: "delete_branch", idempotency_key: "never-executed-key",
      parameters: { repo: "org/repo", branch: "feature/to-delete" }
    });
    expect(recovery.status).toBe("UNKNOWN");
  });

  it("G: recovery skjer via ToolGateway.execute() - InfraExecutionGate PAUSED blokkerer derfor recovery-forsøket identisk med enhver annen mutasjon (ingen bypass gjennom recovery-veien)", async () => {
    const { InfraExecutionGate } = await import("@jarvis/policy");
    const transport = new FakeGithubTransport();
    const infraGate = new InfraExecutionGate();
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      infraGate, infraToolIds: new Set(["github"]),
      authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
    });
    const secrets: SecretProvider = { name: "fake", get: async () => "fake-token" };
    const gateway = new ToolGateway(appPool, policy, secrets);
    for (const def of githubToolDefinitions(transport)) gateway.register(def);

    const key = "recovery-test-key-g";
    await gateway.execute({ identity, tool_id: "github", action: "delete_branch", parameters: { repo: "org/repo", branch: "feature/to-delete" }, idempotency_key: key });
    infraGate.pause("incident response in progress");

    const recovery = await attemptRecovery({ pool: appPool, gateway }, identity, {
      tenant_id: TENANT, tool_id: "github", action: "delete_branch", idempotency_key: key,
      parameters: { repo: "org/repo", branch: "feature/to-delete" }
    });
    expect(recovery.status).toBe("FAILED");
    expect(transport.branches.has("feature/to-delete")).toBe(false); // ingen stille bypass - branchen forblir slettet
  });
});
