import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { z } from "zod";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import { createPool, PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type SecretProvider, type ToolTransport } from "@jarvis/tool-gateway";
import { DomainPauseRegistry } from "../../src/domain-pause.ts";
import { SituationEngine } from "../../src/service.ts";
import { SubscriptionRegistry } from "../../src/subscriptions.ts";
import { SituationsTransport, situationsToolDefinitions } from "../../src/transport.ts";

/**
 * WP-G4: delt oppsett for DB-testene (ekte embedded Postgres, NOSUPERUSER/NOBYPASSRLS-rolle, FORCE RLS, ekte `SituationEngine`/`ToolGateway`/`PolicyGateway`). Hver testfil starter sin EGEN klynge via `startG4Db()`.
 */
export const TENANT_A = "tenant-g4-a";
export const TENANT_B = "tenant-g4-b";
export const OWNER = "person-g4-owner";
export const OTHER = "person-g4-other";
export const NOW = Date.parse("2026-11-19T12:00:00.000Z");
export const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

export const identity = (tenant: string, space: MemorySpace, person = OWNER): IdentityContext => ({
  person_id: person, tenant_id: tenant, memory_space_id: space, session_id: "sess-g4", device_id: "jarvis-core", channel: "api", auth_strength: "active"
});
export const actorOwner = { person_id: OWNER, session_id: "sess-g4" };

const secrets: SecretProvider = { name: "test", async get() { return "test-token"; } };
export const record = (shape: z.ZodRawShape) => z.object(shape).strict() as unknown as z.ZodType<Record<string, JsonValue>>;

export class TelegramSpy implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push({ action, parameters });
    return { external_id: `tg-${this.calls.length}` };
  }
  get messages(): string[] { return this.calls.map((c) => String(c.parameters["message"])); }
}

export class ActuatorSpy implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  private done = false;
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push({ action, parameters });
    if (action === "read_state") return { data: { done: this.done } };
    this.done = true;
    return { external_id: "close-1", data: { done: true } };
  }
}

export interface G4Db {
  adminPool: pg.Pool;
  appPool: pg.Pool;
  policy: PolicyGateway;
  engine: SituationEngine;
  domainPauses: DomainPauseRegistry;
  registry: SubscriptionRegistry;
  /** Ny gateway per test (telegram-/aktuator-spion registrert + `situations`-verktøyet). */
  newGateway(): { gateway: ToolGateway; telegram: TelegramSpy; actuator: ActuatorSpy };
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startG4Db(label: string): Promise<G4Db> {
  const dir = await mkdtemp(join(tmpdir(), `jarvis-pg-g4-${label}-`));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  await leased.postgres.createDatabase("jarvis_test");
  const adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  const role = `jarvis_g4_${label}_test`;
  await adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS`);
  await adminPool.query(`GRANT jarvis_app TO ${role}`);
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','G4 A','person'), ('${TENANT_B}','G4 B','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Tobias'), ('${OTHER}','Other');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT_A}'), ('${OWNER}','${TENANT_B}'), ('${OTHER}','${TENANT_A}');
  `);
  const appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: role, password: "pw2" });
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(appPool), killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A, TENANT_B] }
  });
  const domainPauses = new DomainPauseRegistry(appPool, { owner_person_id: OWNER });
  await domainPauses.restore();
  const engine = new SituationEngine(appPool, domainPauses, { owner_person_id: OWNER });
  const registry = new SubscriptionRegistry(appPool, { owner_person_id: OWNER });

  const db: G4Db = {
    adminPool, appPool, policy, engine, domainPauses, registry,
    newGateway() {
      const telegram = new TelegramSpy();
      const actuator = new ActuatorSpy();
      const gateway = new ToolGateway(appPool, policy, secrets);
      gateway.register({
        tool_id: "telegram", action: "notify", description: "test", input_schema: record({ message: z.string() }), capability_class: "B", scopes: [], reversible: true,
        rollback_procedure: "send correction", idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_TELEGRAM_TOKEN", output_trust: "internal", transport: telegram
      });
      gateway.register({
        tool_id: "test_actuator", action: "close", description: "test", input_schema: record({ situation_id: z.string() }), capability_class: "D", scopes: [], reversible: true,
        rollback_procedure: "open", idempotent_external: false, timeout_ms: 5000, rate_limit_per_minute: 1000, credential_ref: "TEST_ACTUATOR_TOKEN", output_trust: "internal", transport: actuator,
        preflight_action: "read_state", postcondition_predicate: (after) => (after as { done: boolean } | null)?.done === true
      });
      for (const tool of situationsToolDefinitions(new SituationsTransport(engine, domainPauses))) gateway.register(tool);
      return { gateway, telegram, actuator };
    },
    async reset() {
      const tenants = `'${TENANT_A}','${TENANT_B}'`;
      for (const table of ["situation_signal_log", "situation_assessments", "situation_feedback", "situation_rule_tuning", "situation_subscriptions", "situations", "situation_autonomy_policies", "situation_notification_policies", "tool_executions"]) {
        await adminPool.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenants})`);
      }
      await adminPool.query(`DELETE FROM situation_domain_pauses`);
      await domainPauses.restore();
    },
    async stop() {
      await appPool.end();
      await adminPool.end();
      await leased.stop();
    }
  };
  return db;
}
