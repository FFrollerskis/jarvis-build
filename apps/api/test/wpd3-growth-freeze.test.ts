import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { GROWTH_WRITE_PROVIDERS, buildGrowthToolDefinitions, growthWriteConfigFromEnv, growthWriteSpecs } from "@jarvis/growth";
import { OwnerControlsTransport, ownerControlsToolDefinitions } from "@jarvis/owner-controls";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import { ToolGateway, type ClassDNotification, type SecretProvider, type ToolTransport } from "@jarvis/tool-gateway";
import { createOwnerControlsService } from "../src/provider-pause.ts";

/**
 * WP-D3 review M5 (D-459): EIERENS FRYS stanser også vekst-skrivingen. Bevist mot den EKTE eier-kontrollflaten (`owner_controls.freeze_connector` med produksjonsfabrikken `createOwnerControlsService`,
 * varig frys i Postgres) og den EKTE `ToolGateway`:
 *  - `growth_*`-id-ene (`growth_ga4`, `growth_googleads` ...) kan fryses via eier-kontrollene (de står ikke i CONNECTOR_REGISTRY, så dashbordet har ingen knapp - API-et/kontrollsenteret aksepterer alle id-er);
 *  - frys av den EKSISTERENDE lese-connectoren (`googleads`/`metaads`) stanser også skrive- og lesehandlingene i det eier-eksklusive navnerommet (`connector_ids_for`);
 *  - opphevet frys virker igjen, og en frys av én plattform rører ikke de andre.
 * Transportene er tellende stubber: avslaget skjer FØR noe når leverandøren.
 */
const TENANT = "tenant-wpd3-freeze";
const OWNER = "person-wpd3-freeze-owner";
const authority = { owner_person_id: OWNER, owner_tenants: [TENANT] };
const owner: IdentityContext = { person_id: OWNER, tenant_id: TENANT, memory_space_id: "business", session_id: "sess-wpd3-freeze", device_id: "dev-wpd3-freeze", channel: "api", auth_strength: "signed" };
const ENV = {
  JARVIS_GROWTH_WRITE_PLATFORMS: GROWTH_WRITE_PROVIDERS.join(","), JARVIS_GROWTH_CREATIVE_URL_HOSTS: "example.test",
  JARVIS_GROWTH_WRITE_TARGETS: "google_ads:123-456-7890,meta_ads:act_1234567890123,ga4:properties/123456789,youtube:UCabcdefghijklmnopqrstuv,tiktok:7001234567890"
};

let stop: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let gateway: ToolGateway;
let freshGateway: () => ToolGateway;
const calls: string[] = [];
const notifications: ClassDNotification[] = [];

const stub: ToolTransport = {
  invoke: async (action: string) => {
    calls.push(action);
    return { data: { property_id: "123456789", campaign_id: "101", ad_account_id: "1234567890123", status: "ENABLED", budget_amount_micros: 500_000_000, key_events: [], finance_kill_switch_active: false } as JsonValue };
  }
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd3-freeze-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_wpd3_freeze LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_wpd3_freeze");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'WPD3 freeze', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd3_freeze", password: "pw2" });
  const secrets: SecretProvider = { name: "fake", get: async () => "fake-credential-for-test" };
  const config = growthWriteConfigFromEnv(ENV);
  const specs = growthWriteSpecs(config);
  // `freshGateway` bygger en HELT ny stack mot samme database (en restart): fryseren er varig og delt, ikke prosess-minne.
  freshGateway = () => {
    const killSwitch = new KillSwitch(appPool, authority);
    const controls = new OwnerControls(killSwitch, appPool, authority);
    const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, authority });
    const g = new ToolGateway(appPool, policy, secrets, controls, undefined, {
      classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (n) => { notifications.push(n); } } },
      credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT], internalRefs: new Set([BUSINESS_INTERNAL_CREDENTIAL_REF]) }
    });
    // PRODUKSJONSFABRIKKEN (med frys-målvalidatoren) - ikke en egen konstruksjon.
    for (const tool of ownerControlsToolDefinitions(new OwnerControlsTransport(createOwnerControlsService(killSwitch, controls)))) g.register(tool);
    for (const provider of GROWTH_WRITE_PROVIDERS) for (const def of buildGrowthToolDefinitions(specs[provider], stub, config)) g.register({ ...def, rate_limit_per_minute: 10_000 });
    return g;
  };
  gateway = freshGateway();
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stop?.();
}, 120_000);

const freeze = (connectorId: string) => gateway.execute({ identity: owner, tool_id: "owner_controls", action: "freeze_connector", parameters: { connector_id: connectorId, reason: "wpd3-test" } });
const unfreeze = (connectorId: string) => gateway.execute({ identity: owner, tool_id: "owner_controls", action: "unfreeze_connector", parameters: { connector_id: connectorId } });
const read = (g: ToolGateway, toolId: string, action: string, parameters: Record<string, JsonValue>) => g.execute({ identity: owner, tool_id: toolId, action, parameters });
const GA4_READ = { property_id: "123456789" };
const ADS_READ = { customer_id: "1234567890", campaign_id: "101" };
const META_READ = { ad_account_id: "act_1234567890123", campaign_id: "50010" };

describe("eier-frys og vekst-skriving (review M5)", () => {
  it("`growth_ga4` (ingen lese-connector, ikke i CONNECTOR_REGISTRY) kan fryses via eier-kontrollene: lesing og skriving avvises FØR leverandøren, andre plattformer er urørt, og frysen er varig (ny stack ser den)", async () => {
    calls.length = 0;
    expect((await read(gateway, "growth_ga4", "list_key_events", GA4_READ)).ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    const frozen = await freeze("growth_ga4");
    expect(frozen.ok).toBe(true);
    expect(JSON.stringify(frozen)).toContain("growth_ga4");
    calls.length = 0;
    expect(await read(gateway, "growth_ga4", "list_key_events", GA4_READ)).toEqual({ ok: false, reason: "connector_frozen" });
    const write = await gateway.execute({ identity: owner, tool_id: "growth_ga4", action: "create_key_event", parameters: { property_id: "123456789", event_name: "lead_form" }, idempotency_key: "freeze-ga4-write-001" });
    expect(write).toEqual({ ok: false, reason: "connector_frozen" });
    expect(calls).toEqual([]);
    expect((await read(gateway, "growth_googleads", "get_campaign_state", ADS_READ)).ok).toBe(true); // en annen plattform er urørt
    expect(await read(freshGateway(), "growth_ga4", "list_key_events", GA4_READ)).toEqual({ ok: false, reason: "connector_frozen" }); // varig, delt
    expect((await unfreeze("growth_ga4")).ok).toBe(true);
    expect((await read(gateway, "growth_ga4", "list_key_events", GA4_READ)).ok).toBe(true);
  });

  it("frys av den EKSISTERENDE lese-connectoren `googleads` stanser også `growth_googleads` (skriving klasse C og D, og lesing); `metaads` -> `growth_metaads`; ingen kryss-effekt", async () => {
    for (const [connector, toolId, readAction, readParams, writes] of [
      ["googleads", "growth_googleads", "get_campaign_state", ADS_READ, [["pause_campaign", { customer_id: "1234567890", campaign_id: "101" }], ["set_campaign_budget", { customer_id: "1234567890", campaign_id: "101", amount_ore: 40_000 }]]],
      ["metaads", "growth_metaads", "get_campaign_state", META_READ, [["pause_campaign", { ad_account_id: "act_1234567890123", campaign_id: "50010" }], ["set_ad_set_budget", { ad_account_id: "act_1234567890123", ad_set_id: "60010", daily_budget_ore: 40_000 }]]]
    ] as const) {
      expect((await read(gateway, toolId, readAction, readParams)).ok, `${toolId} før frys`).toBe(true);
      expect((await freeze(connector)).ok).toBe(true);
      calls.length = 0;
      expect(await read(gateway, toolId, readAction, readParams), `${toolId} lesing`).toEqual({ ok: false, reason: "connector_frozen" });
      for (const [action, parameters] of writes) {
        expect(await gateway.execute({ identity: owner, tool_id: toolId, action, parameters: parameters as Record<string, JsonValue>, idempotency_key: `freeze-${connector}-${action}-0001` }), `${toolId}.${action}`).toEqual({ ok: false, reason: "connector_frozen" });
      }
      expect(calls, toolId).toEqual([]);
      // en frys av ÉN lese-connector rører ikke den andre
      const other = connector === "googleads" ? ["growth_metaads", "get_campaign_state", META_READ] as const : ["growth_googleads", "get_campaign_state", ADS_READ] as const;
      expect((await read(gateway, other[0], other[1], other[2])).ok, `${other[0]} uberørt`).toBe(true);
      expect((await unfreeze(connector)).ok).toBe(true);
      expect((await read(gateway, toolId, readAction, readParams)).ok, `${toolId} etter opphevet frys`).toBe(true);
    }
  });

  it("frys-målet `growth_*` passerer produksjonens målvalidering (kun `model:`-mål valideres) og kan hentes frem igjen i kontrolltilstanden", async () => {
    for (const id of ["growth_youtube", "growth_tiktok", "growth_gbp"]) {
      expect((await freeze(id)).ok, id).toBe(true);
    }
    const state = await gateway.execute({ identity: owner, tool_id: "owner_controls", action: "get_control_state", parameters: {} });
    expect(state.ok).toBe(true);
    const listed = JSON.stringify(state.ok ? state.data : null);
    for (const id of ["growth_youtube", "growth_tiktok", "growth_gbp"]) expect(listed, id).toContain(id);
    for (const id of ["growth_youtube", "growth_tiktok", "growth_gbp"]) expect((await unfreeze(id)).ok, id).toBe(true);
  });
});
