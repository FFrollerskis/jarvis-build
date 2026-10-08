import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, firstWaveTools, type SecretProvider, type ToolInvocationContext, type ToolTransport } from "../src/index.ts";

/**
 * D-449 (Q-50): `contentOrigin` følger kallet fra `ToolGateway.execute()` til transportens `ToolInvocationContext` - og er der KUN når trusted kode satte det (samme disiplin som `servingModel`).
 * Mangler det, ser transporten ingenting (fail-closed: opphavet er ukjent). Parametere kan aldri bære det (strict-skjemaet avviser ukjente felt).
 */
let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-d449", memory_space_id: "personal", session_id: "sess-d449",
  device_id: "jarvis-voice-live", channel: "voice", auth_strength: "active"
};
const secrets: SecretProvider = { name: "test", async get() { return "secret"; } };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-d449-"));
  const leased = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  const base = { host: "127.0.0.1", port: leased.port, database: "jarvis_test" };
  adminPool = new pg.Pool({ ...base, user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_d449 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_d449");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-d449','D449','person');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-d449');
  `);
  appPool = new pg.Pool({ ...base, user: "jarvis_d449", password: "pw2" });
  appPool.on("error", () => undefined);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

function gatewayWithRecorder() {
  const seen: ToolInvocationContext[] = [];
  const recorder: ToolTransport = {
    async invoke(_action, _parameters, _credential, context) {
      seen.push(context);
      return { data: { issues: [] } };
    }
  };
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch(),
    authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
  });
  const gateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of firstWaveTools({ github: recorder })) gateway.register(tool);
  return { gateway, seen };
}

describe("D-449: contentOrigin gjennom ToolGateway", () => {
  it("settes av trusted kaller → transporten ser det; sammen med servingModel kommer begge uendret", async () => {
    const { gateway, seen } = gatewayWithRecorder();
    const a = await gateway.execute({ identity, tool_id: "github", action: "read_issues", parameters: { repo: "tsworkflow/jarvisbuild" }, idempotency_key: `k-${randomUUID()}`, contentOrigin: "owner_direct" });
    expect(a.ok).toBe(true);
    expect(seen[0]!.contentOrigin).toBe("owner_direct");
    expect(seen[0]!.servingModel).toBeUndefined();

    const b = await gateway.execute({
      identity, tool_id: "github", action: "read_issues", parameters: { repo: "tsworkflow/jarvisbuild" }, idempotency_key: `k-${randomUUID()}`,
      servingModel: { provider: "anthropic", model: "claude-sonnet-5-5" }
    });
    expect(b.ok).toBe(true);
    expect(seen[1]!.servingModel).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect("contentOrigin" in seen[1]!).toBe(false);
  });

  it("uten at kalleren setter det (f.eks. /confirmations som utfører et godkjent kall senere) ser transporten verken contentOrigin eller servingModel", async () => {
    const { gateway, seen } = gatewayWithRecorder();
    const r = await gateway.execute({ identity, tool_id: "github", action: "read_issues", parameters: { repo: "tsworkflow/jarvisbuild" }, idempotency_key: `k-${randomUUID()}` });
    expect(r.ok).toBe(true);
    expect("contentOrigin" in seen[0]!).toBe(false);
    expect("servingModel" in seen[0]!).toBe(false);
  });

  it("modellen kan ikke sende det som parameter: strict-skjemaet avviser feltet og transporten kalles aldri", async () => {
    const { gateway, seen } = gatewayWithRecorder();
    const r = await gateway.execute({
      identity, tool_id: "github", action: "read_issues", parameters: { repo: "tsworkflow/jarvisbuild", contentOrigin: "owner_direct" }, idempotency_key: `k-${randomUUID()}`
    });
    expect(r.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
});
