import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { CloudflareTransport, INFRA_GATED_TOOL_IDS, ToolGateway, cloudflareToolDefinitions, type SecretProvider } from "@jarvis/tool-gateway";
import { FakeCloudflare, hex32 } from "../../tool-gateway/test/support/fake-cloudflare.ts";
import { CLOUDFLARE_PROVIDER, executeCloudMutation } from "../src/cloud-execution.ts";
import { CLOUDFLARE_RECOVERY_STRATEGIES } from "../src/cloudflare-recovery.ts";
import { attemptRecovery } from "../src/recovery.ts";

/**
 * Gjennomgang av PR #324 (L7): KOMPENSASJONEN SKAL ALDRI SLETTE EN RESSURS JARVIS IKKE OPPRETTET.
 *
 * Funnet: `create_dns_record`/`create_waf_rule` mot en IDENTISK, eksisterende ressurs returnerte den eksisterende id-en som `external_id`. Fantes ressursen fra før preflight, sto den i før-tilstanden og
 * recovery lot den være. Men oppsto den MELLOM preflight og kallet (en tredjepart la inn en identisk post/regel), sto den IKKE i før-tilstanden, journalen sa «Jarvis opprettet denne» - og recovery slettet den.
 *
 * Rettelsen (to lag): transporten returnerer `already_existed: true` UTEN `external_id`; journalen bærer `provider_receipt.already_existed`; strategiene gjør SUCCESS/noop uten noen sletting når flagget står.
 * Her: (A) race-scenarioene mot EKTE ToolGateway + embedded Postgres + fake Cloudflare (en `beforeNext`-krok legger tredjepartsressursen inn akkurat mellom preflight og transportens eget kall) - det
 * finnes INGEN DELETE, ressursen består; (B) strategiene alene (også mot en journalrad der en ekstern id OG flagget står, og før-tilstanden er tom); (C) planteksten for leverandøren.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let cf: FakeCloudflare;
const TENANT = "tenant-e1-l7";
const identity: IdentityContext = { person_id: "person-e1-l7", tenant_id: TENANT, memory_space_id: "business", session_id: "sess-l7", device_id: "dev-l7", channel: "api", auth_strength: "signed" };
const PHASE = "http_request_firewall_custom";

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1-l7-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_e1_l7 LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_e1_l7");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','L7','business');
    INSERT INTO people (person_id, display_name) VALUES ('${identity.person_id}','L7');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${identity.person_id}','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1_l7", password: "pw2" });
  cf = new FakeCloudflare();
  await cf.start();
}, 240_000);

afterAll(async () => {
  await cf?.stop();
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

function build(zones: string[]): ToolGateway {
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    infraGate: new InfraExecutionGate(), infraToolIds: INFRA_GATED_TOOL_IDS,
    authority: { owner_person_id: identity.person_id, owner_tenants: [TENANT] }
  });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === "JARVIS_CLOUDFLARE_API_TOKEN" ? cf.token : null) };
  const gateway = new ToolGateway(appPool, policy, secrets, undefined, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async () => undefined } }
  });
  const transport = new CloudflareTransport({ baseUrl: cf.baseUrl, accountId: async () => cf.accountId, sleep: async () => undefined });
  for (const d of cloudflareToolDefinitions(transport, { mutationZones: new Set(zones) })) gateway.register(d);
  return gateway;
}
const key = (p: string) => `${p}-${hex32().slice(0, 10)}`;
const mutate = (gateway: ToolGateway, action: string, parameters: Record<string, JsonValue>, k: string) =>
  executeCloudMutation({ pool: appPool, gateway }, identity, { tenant_id: TENANT, person_id: identity.person_id, provider: "cloudflare", action, parameters, idempotency_key: k });
const recover = (gateway: ToolGateway, action: string, k: string) =>
  attemptRecovery({ pool: appPool, gateway }, identity, { tenant_id: TENANT, tool_id: "cloudflare", action, idempotency_key: k, parameters: {} });
const newZone = () => { const name = `l7${hex32().slice(0, 7)}.example.com`; return { id: cf.addZone(name), name }; };

describe("A: løpet mellom preflight og kallet - en tredjeparts identiske ressurs slettes ALDRI av recovery", () => {
  it("DNS: tredjeparten legger inn en identisk post etter preflight -> journalen sier `already_existed` uten ekstern id, og recovery er en SUCCESS/noop uten DELETE", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const name = `race.${z.name}`;
    let thirdParty = "";
    // GET #1 er preflight (ser ingenting); kroken kjører rett FØR GET #2 = transportens egen duplikat-sjekk.
    cf.beforeNext(new RegExp(`^GET /zones/${z.id}/dns_records$`), () => { thirdParty = cf.seedDns(z.id, { type: "A", name, content: "192.0.2.50" }); }, 1);
    const k = key("race-dns");
    const ex = await mutate(gateway, "create_dns_record", { zone_id: z.id, type: "A", name, content: "192.0.2.50" }, k);
    expect(thirdParty).toMatch(/^[0-9a-f]{32}$/);
    expect(ex.verification_outcome).toBe("SUCCESS");
    expect(ex.before_state).toMatchObject({ count: 0 }); // posten sto IKKE i før-tilstanden - derfor hjalp ikke «finnes i før-tilstanden»-sjekken
    expect(ex.provider_receipt).toMatchObject({ external_id: null, already_existed: true });
    expect(ex.recovery_available).toBe(false);
    expect(ex.recovery_plan).toContain("ingenting å reversere");

    cf.requests.length = 0;
    const rec = await recover(gateway, "create_dns_record", k);
    expect(rec.status).toBe("SUCCESS");
    expect(rec.recovery_result).toMatchObject({ noop: "record_existed_before_execution", reason: "record_not_created_by_jarvis" });
    expect(cf.requestsMatching("DELETE", /dns_records/)).toHaveLength(0);
    expect(cf.writeRequests()).toHaveLength(0);
    expect(cf.dns.get(z.id)!.has(thirdParty)).toBe(true);
  });

  it("WAF: tredjeparten legger inn en identisk regel etter preflight -> `already_existed` uten ekstern id, recovery sletter ikke regelen", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    let thirdParty = "";
    cf.beforeNext(new RegExp(`^GET /zones/${z.id}/rulesets/phases/${PHASE}/entrypoint$`),
      () => { thirdParty = cf.seedRule(z.id, PHASE, { action: "block", expression: "ip.src eq 203.0.113.77", description: "tredjepart" }).ruleId; }, 1);
    const k = key("race-waf");
    const ex = await mutate(gateway, "create_waf_rule", { zone_id: z.id, phase: PHASE, action: "block", expression: "ip.src eq 203.0.113.77", description: "tredjepart" }, k);
    expect(thirdParty).toMatch(/^[0-9a-f]{32}$/);
    expect(ex.verification_outcome).toBe("SUCCESS");
    expect(ex.before_state).toMatchObject({ rules: [] });
    expect(ex.provider_receipt).toMatchObject({ external_id: null, already_existed: true });
    expect(ex.recovery_available).toBe(false);

    cf.requests.length = 0;
    const rec = await recover(gateway, "create_waf_rule", k);
    expect(rec.status).toBe("SUCCESS");
    expect(rec.recovery_result).toMatchObject({ noop: "rule_existed_before_execution", reason: "rule_not_created_by_jarvis" });
    expect(cf.requestsMatching("DELETE", /rulesets/)).toHaveLength(0);
    expect(cf.writeRequests()).toHaveLength(0);
    expect(cf.rulesets.get(z.id)!.get(PHASE)!.rules.some((r) => r.id === thirdParty)).toBe(true);
  });

  it("kontroll: en post/regel Jarvis FAKTISK opprettet har ekstern id og ingen `already_existed`, og recovery sletter den (kompensasjonen er ikke slått av)", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const kd = key("own-dns");
    const dns = await mutate(gateway, "create_dns_record", { zone_id: z.id, type: "A", name: `egen.${z.name}`, content: "192.0.2.60" }, kd);
    const recordId = (dns.provider_receipt as { external_id: string; already_existed?: boolean }).external_id;
    expect(recordId).toMatch(/^[0-9a-f]{32}$/);
    expect((dns.provider_receipt as Record<string, unknown>)["already_existed"]).toBeUndefined();
    expect(dns.recovery_available).toBe(true);
    expect((await recover(gateway, "create_dns_record", kd)).status).toBe("SUCCESS");
    expect(cf.dns.get(z.id)!.has(recordId)).toBe(false);

    const kr = key("own-waf");
    const waf = await mutate(gateway, "create_waf_rule", { zone_id: z.id, phase: PHASE, action: "block", expression: "ip.src eq 203.0.113.78", description: "egen" }, kr);
    const ruleId = (waf.provider_receipt as { external_id: string }).external_id;
    expect(ruleId).toMatch(/^[0-9a-f]{32}$/);
    expect((await recover(gateway, "create_waf_rule", kr)).status).toBe("SUCCESS");
    expect(cf.rulesets.get(z.id)!.get(PHASE)!.rules.some((r) => r.id === ruleId)).toBe(false);
  });
});

describe("B: strategiene alene - `already_existed` i journalen betyr alltid ingen sletting", () => {
  const gateway = { execute: async () => { throw new Error("gatewayen skal ikke kalles"); } } as never;
  const ZONE = "0123456789abcdef0123456789abcdef";
  const execution = (receipt: Record<string, unknown>) => ({
    requested_state: { zone_id: ZONE, phase: PHASE }, provider_receipt: receipt, before_state: { records: [], rules: [] }, after_state: { records: [], rules: [] }
  }) as never;
  const ctx = (receipt: Record<string, unknown>) => ({ gateway, identity, idempotencyKey: "k", execution: execution(receipt) });

  it("selv MED en ekstern id (eldre journalrad) og tom før-tilstand: SUCCESS/noop, gatewayen kalles aldri", async () => {
    const dns = await CLOUDFLARE_RECOVERY_STRATEGIES["cloudflare:create_dns_record"]!(ctx({ external_id: "rec-1", already_existed: true }));
    expect(dns).toMatchObject({ status: "SUCCESS", result: { noop: "record_existed_before_execution" } });
    const waf = await CLOUDFLARE_RECOVERY_STRATEGIES["cloudflare:create_waf_rule"]!(ctx({ external_id: "rule-1", already_existed: true }));
    expect(waf).toMatchObject({ status: "SUCCESS", result: { noop: "rule_existed_before_execution" } });
  });

  it("KONTROLL: samme journalrad UTEN flagget går videre til å lese og slette (gatewayen kalles) - flagget er det som stopper slettingen", async () => {
    await expect(CLOUDFLARE_RECOVERY_STRATEGIES["cloudflare:create_dns_record"]!(ctx({ external_id: "rec-1" }))).rejects.toThrow("gatewayen skal ikke kalles");
    await expect(CLOUDFLARE_RECOVERY_STRATEGIES["cloudflare:create_waf_rule"]!(ctx({ external_id: "rule-1" }))).rejects.toThrow("gatewayen skal ikke kalles");
  });

  it("kun et ekte `true` teller: `already_existed: \"true\"`/1/false behandles ikke som flagget", async () => {
    for (const value of ["true", 1, false, null]) {
      await expect(CLOUDFLARE_RECOVERY_STRATEGIES["cloudflare:create_dns_record"]!(ctx({ external_id: "rec-1", already_existed: value })), String(value)).rejects.toThrow("gatewayen skal ikke kalles");
    }
  });
});

describe("C: leverandørens plan - ingen automatisk kompensasjon for det Jarvis ikke opprettet", () => {
  it("`recovery()` med `already_existed` gir `available: false` for create_dns_record/create_waf_rule; uten flagget er den tilgjengelig; andre handlinger påvirkes ikke", () => {
    const p = { zone_id: "0123456789abcdef0123456789abcdef", phase: PHASE };
    for (const action of ["create_dns_record", "create_waf_rule"]) {
      expect(CLOUDFLARE_PROVIDER.recovery(action, null, p, "abc", { already_existed: true }), action).toMatchObject({ available: false });
      expect(CLOUDFLARE_PROVIDER.recovery(action, null, p, "abc", { already_existed: false }), action).toMatchObject({ available: true });
      expect(CLOUDFLARE_PROVIDER.recovery(action, null, p, "abc"), action).toMatchObject({ available: true });
    }
    expect(CLOUDFLARE_PROVIDER.recovery("update_zone_setting", { value: "full" }, { ...p, setting_id: "ssl" }, undefined, { already_existed: true })).toMatchObject({ available: true });
  });
});
