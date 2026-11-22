import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { INFRA_GATED_TOOL_IDS, InfisicalTransport, ToolGateway, infisicalToolDefinitions, type SecretProvider } from "@jarvis/tool-gateway";
import { FakeInfisical } from "../../tool-gateway/test/support/fake-infisical.ts";
import { attemptRecovery } from "../src/recovery.ts";
import { executeCloudMutation } from "../src/cloud-execution.ts";

/**
 * WP-E1: Infisical-rotasjon gjennom `executeCloudMutation()` (den sammenhengende `infra_executions`-journalen) mot EKTE ToolGateway + embedded Postgres + lokal fake Infisical.
 * Bevist: før-/etter-revisjon av rotasjonens STATUS (aldri verdier), idempotent retry, ærlig «ingen reversering», og at et avslag journalføres som FAILED.
 */
const TENANT = "tenant-e1-infx";
const identity: IdentityContext = { person_id: "person-e1-infx", tenant_id: TENANT, memory_space_id: "business", session_id: "sess-infx", device_id: "dev-infx", channel: "api", auth_strength: "signed" };

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let appPool: pg.Pool;
let fx: FakeInfisical;
let gateway: ToolGateway;
let allowed: string[] = [];
let seq = 0;
const key = (p: string): string => `${p}-${(seq += 1)}-${Date.now().toString(36)}`;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1-infx-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_test_e1_infx LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_test_e1_infx;");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','E1','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-e1-infx','Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-e1-infx','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1_infx", password: "pw2" });
  fx = new FakeInfisical();
  await fx.start();
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), infraToolIds: new Set(INFRA_GATED_TOOL_IDS),
    authority: { owner_person_id: identity.person_id, owner_tenants: [TENANT] }
  });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === "INFISICAL_CLIENT_SECRET" ? fx.clientSecret : null) };
  gateway = new ToolGateway(appPool, policy, secrets, undefined, undefined, { classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async () => undefined } } });
  const transport = new InfisicalTransport({ baseUrl: async () => fx.baseUrl, clientId: async () => fx.clientId, projectId: async () => fx.projectId, environment: async () => fx.environment, sleep: async () => undefined });
  // Autorisasjonslisten leses lazily slik at hver test kan autorisere sin egen rotasjon.
  const defs = infisicalToolDefinitions(transport, { rotationIds: { has: (id: string) => allowed.includes(id) } as ReadonlySet<string> });
  for (const d of defs) gateway.register(d);
}, 240_000);

afterAll(async () => {
  await fx?.stop();
  await appPool?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

const mutate = (rotation_id: string, k: string) =>
  executeCloudMutation({ pool: appPool, gateway }, identity, { tenant_id: TENANT, person_id: identity.person_id, provider: "infisical", action: "rotate_secrets", parameters: { rotation_id }, idempotency_key: k });

describe("Infisical-rotasjon i den sammenhengende infra-journalen", () => {
  it("journalraden bærer aktør, klasse D, mål, status FØR og ETTER (aldri verdier), diff og en ærlig «ingen reversering»; en gjentatt nøkkel gir samme rad", async () => {
    const r = fx.seedRotation({ name: "stripe-main" });
    allowed = [r.id];
    const k = key("rot");
    const ex = await mutate(r.id, k);
    expect(ex).toMatchObject({ provider: "infisical", tool_id: "infisical", action: "rotate_secrets", risk_class: "D", verification_outcome: "SUCCESS", recovery_available: false, target: `infisical:rotation:${r.id}` });
    expect(ex.before_state).toMatchObject({ id: r.id, name: "stripe-main", rotation_status: "success" });
    expect((ex.after_state as { last_rotated_at: string }).last_rotated_at).not.toBe((ex.before_state as { last_rotated_at: string }).last_rotated_at);
    expect(ex.state_diff).toMatchObject({ changed: { last_rotated_at: expect.anything() } });
    expect(ex.recovery_plan).toMatch(/ingen teknisk reversering/);
    expect(JSON.stringify(ex)).not.toContain("secretValue");
    const again = await mutate(r.id, k);
    expect(again.execution_id).toBe(ex.execution_id);
    expect(fx.requestsMatching("POST", /rotate-secrets$/).filter((q) => q.path.includes(r.id))).toHaveLength(1);
    const rec = await attemptRecovery({ pool: appPool, gateway }, identity, { tenant_id: TENANT, tool_id: "infisical", action: "rotate_secrets", idempotency_key: k, parameters: {} });
    expect(rec).toMatchObject({ status: "UNKNOWN", recovery_result: { reason: "no_recovery_strategy_registered" } });
  });

  it("en rotasjon eieren ikke har autorisert journalføres som FAILED uten at noe kalles; leverandørfeil journalføres med årsak", async () => {
    const r = fx.seedRotation();
    allowed = [];
    fx.requests.length = 0;
    const denied = await mutate(r.id, key("deny"));
    expect(denied).toMatchObject({ verification_outcome: "FAILED", recovery_available: false });
    expect(denied.provider_receipt).toMatchObject({ reason: "infisical_rotation_not_authorized" });
    expect(fx.requests).toHaveLength(0);
    allowed = [r.id];
    fx.rotationFails = true;
    const failed = await mutate(r.id, key("fail"));
    fx.rotationFails = false;
    // WP-K (M-1 + delta-review L-1): leverandøren aksepterte POST-en og melder så «failed» - utfallet er UKJENT (ledger `unverified`), og journalen sier det samme (UNKNOWN), ikke FAILED.
    expect(failed.verification_outcome).toBe("UNKNOWN");
    expect((failed.provider_receipt as { reason: string }).reason).toMatch(/^tool_failed:outcome_unknown:infisical_rotation_failed/);
  });

  it("WP-K M-1/L-1: readback som feiler ETTER akseptert rotate-POST journalføres som UNKNOWN (ledger `unverified`), og en gjentatt nøkkel gir samme rad uten en ANDRE rotasjon", async () => {
    const r = fx.seedRotation();
    allowed = [r.id];
    fx.failReadbackAfterRotate(503, { times: 3 });
    const k = key("readback");
    const first = await mutate(r.id, k);
    fx.clearReadbackFailure();
    expect(first).toMatchObject({ verification_outcome: "UNKNOWN", risk_class: "D", target: `infisical:rotation:${r.id}` });
    expect((first.provider_receipt as { reason: string }).reason).toBe("tool_failed:outcome_unknown:infisical_rotation_readback_failed");
    const ledgerRow = (await admin.query("SELECT status FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2", [TENANT, k])).rows[0] as { status: string };
    expect(ledgerRow.status).toBe("unverified");
    const again = await mutate(r.id, k);
    expect(again.execution_id).toBe(first.execution_id);
    expect(fx.requestsMatching("POST", /rotate-secrets$/).filter((q) => q.path.includes(r.id))).toHaveLength(1);
  });
});
