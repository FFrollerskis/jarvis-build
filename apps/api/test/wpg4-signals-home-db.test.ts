import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import { createPool, PgApprovalStore, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { homeAssistantSituationReadTools, ToolGateway, type ToolTransport } from "@jarvis/tool-gateway";
import { createHomeReader } from "../src/situation-signals-wiring.ts";

/**
 * WP-G4 (D-466) FIKS-RUNDE, B-MEDIUM-4/A-LOW-11 (revisjonsvolum): hver Home Assistant-lesing gikk via ToolGateway og skrev EN `tool.executed`-rad i den append-only revisjonstabellen (uten retensjon):
 * 50 entiteter x 60 s = 72 000 rader/døgn. Målt her mot den EKTE gatewayen og en ekte Postgres: hjem-leseren gjør nå ÉN gateway-kjøring per tikk uansett antall entiteter (= ÉN revisjonsrad), uten å endre gatewayens delte atferd.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let gateway: ToolGateway;

const TENANT = "t-g4-home";
const OWNER = "p-g4-home";
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const identityFor = (tenant: string, space: MemorySpace): IdentityContext => ({ person_id: OWNER, tenant_id: tenant, memory_space_id: space, session_id: "sess-g4-home", device_id: "jarvis-core", channel: "api", auth_strength: "active" });

class FakeHa implements ToolTransport {
  calls: Array<{ action: string; parameters: Record<string, JsonValue> }> = [];
  async invoke(action: string, parameters: Record<string, JsonValue>): Promise<{ external_id?: string; data?: JsonValue }> {
    this.calls.push({ action, parameters });
    if (action === "read_states_detail") {
      const ids = parameters["entities"] as string[];
      return { data: { states: ids.map((id) => (id.endsWith("ukjent") ? null : { entity_id: id, state: id.startsWith("sensor.") ? "1.2" : "on", last_changed: "2026-11-19T11:00:00+00:00", unit: id.startsWith("sensor.") ? "kW" : null })) } };
    }
    return { data: null };
  }
}
const ha = new FakeHa();
const auditRows = async () => (await admin.query(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND type = 'tool.executed' AND tool_id = 'home-assistant'`, [TENANT])).rows[0].n as number;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-g4-home-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_g4_home_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_g4_home_test");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','G4 home','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_g4_home_test", password: "pw2" });
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new PgApprovalStore(app), killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [TENANT] } });
  gateway = new ToolGateway(app, policy, { name: "test", async get() { return "ha-token"; } });
  for (const tool of homeAssistantSituationReadTools(ha)) gateway.register(tool);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

describe("hjem-leseren mot den ekte gatewayen: ÉN revisjonsrad per tikk", () => {
  const entities = Array.from({ length: 15 }, (_, i) => ({ entity_id: `binary_sensor.d${i}`, role: "door" as const }));

  it("15 entiteter i ett tikk = ÉN `tool.executed`-rad og ÉN transportkall (før: 15 rader), og tre tikk = tre rader", async () => {
    const warnings: string[] = [];
    const read = createHomeReader({ gateway, identityFor });
    const out = await read({ tenant_id: TENANT, memory_space: "home", now: NOW, warnings }, entities);
    expect(out).toHaveLength(15);
    expect(ha.calls).toHaveLength(1);
    expect(ha.calls[0]).toMatchObject({ action: "read_states_detail" });
    expect(await auditRows()).toBe(1);
    await read({ tenant_id: TENANT, memory_space: "home", now: NOW + 60_000 }, entities);
    await read({ tenant_id: TENANT, memory_space: "home", now: NOW + 120_000 }, entities);
    expect(await auditRows()).toBe(3);
    expect(warnings).toEqual([]);
  });

  it("maks 50 entiteter går gjennom gatewayens skjema; ukjent entitet gir advarsel og kW-enhet omregnes (ende til ende gjennom gatewayen)", async () => {
    const warnings: string[] = [];
    const read = createHomeReader({ gateway, identityFor });
    const mixed = [{ entity_id: "binary_sensor.ukjent", role: "door" as const }, { entity_id: "sensor.ovn", role: "power" as const, limit_w: 2000 }, { entity_id: "binary_sensor.inngang", role: "door" as const }];
    const out = await read({ tenant_id: TENANT, memory_space: "home", now: NOW, warnings }, mixed);
    expect(warnings).toEqual(["home_entities_unknown:1"]);
    expect(out.map((o) => o.entity_id)).toEqual(["sensor.ovn", "binary_sensor.inngang"]);
    expect(out[0]).toMatchObject({ over_limit_ticks: 0, limit_w: 2000 }); // 1,2 kW = 1200 W < 2000 W
    const fifty = Array.from({ length: 50 }, (_, i) => ({ entity_id: `binary_sensor.f${i}`, role: "door" as const }));
    expect(await read({ tenant_id: TENANT, memory_space: "home", now: NOW }, fifty)).toHaveLength(50);
    // 51 avvises av gatewayens strenge skjema -> kildefeil (løperen avkorter til 50 FØR og varsler)
    await expect(read({ tenant_id: TENANT, memory_space: "home", now: NOW }, [...fifty, { entity_id: "binary_sensor.f50", role: "door" as const }])).rejects.toThrow("home_source_unavailable");
  });
});
