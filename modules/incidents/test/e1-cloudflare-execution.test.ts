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
import { attemptRecovery } from "../src/recovery.ts";
import { executeCloudMutation, classifyGatewayOutcome } from "../src/cloud-execution.ts";
import { getInfraExecution } from "../src/infra-execution.ts";

/**
 * WP-E1 (UA-5 kriterium 3): Cloudflare-mutasjoner gjennom `executeCloudMutation()` (journal) og `attemptRecovery()` (kompensasjon) mot EKTE ToolGateway +
 * embedded Postgres + lokal fake Cloudflare. Bevist: full før-/etter-revisjon i `infra_executions`, kompensasjon som faktisk setter tilbake og VERIFISERER,
 * drift-vern (overskriver aldri en endring andre har gjort siden), idempotens, tenant-isolasjon, journal-binding (kallerens mål må samsvare) og at
 * infra-pause også stanser kompensasjonen.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let cf: FakeCloudflare;
const TENANT_A = "tenant-e1-exec-a";
const TENANT_B = "tenant-e1-exec-b";
const idA: IdentityContext = { person_id: "person-e1a", tenant_id: TENANT_A, memory_space_id: "business", session_id: "sess-a", device_id: "dev-a", channel: "api", auth_strength: "signed" };
const idB: IdentityContext = { person_id: "person-e1b", tenant_id: TENANT_B, memory_space_id: "business", session_id: "sess-b", device_id: "dev-b", channel: "api", auth_strength: "signed" };

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1-exec-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_e1_exec LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_e1_exec");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-e1a','A'), ('person-e1b','B');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-e1a','${TENANT_A}'), ('person-e1b','${TENANT_B}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1_exec", password: "pw2" });
  cf = new FakeCloudflare();
  await cf.start();
}, 240_000);

afterAll(async () => {
  await cf?.stop();
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

function build(zones: string[], opts: { infraGate?: InfraExecutionGate } = {}): ToolGateway {
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    ...(opts.infraGate ? { infraGate: opts.infraGate, infraToolIds: INFRA_GATED_TOOL_IDS } : {}),
    authority: { owner_person_id: idA.person_id, owner_tenants: [TENANT_A, TENANT_B] }
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
const mutate = (gateway: ToolGateway, action: string, parameters: Record<string, JsonValue>, k: string = key("k"), identity: IdentityContext = idA) =>
  executeCloudMutation({ pool: appPool, gateway }, identity, { tenant_id: identity.tenant_id, person_id: identity.person_id, provider: "cloudflare", action, parameters, idempotency_key: k });
const recover = (gateway: ToolGateway, action: string, k: string, identity: IdentityContext = idA, extra: { execution_id?: string; parameters?: Record<string, JsonValue>; tool_id?: string } = {}) =>
  attemptRecovery({ pool: appPool, gateway }, identity, {
    tenant_id: identity.tenant_id, tool_id: extra.tool_id ?? "cloudflare", action, idempotency_key: k, parameters: extra.parameters ?? {}, ...(extra.execution_id ? { execution_id: extra.execution_id } : {})
  });
const newZone = () => { const name = `e${hex32().slice(0, 7)}.example.com`; return { id: cf.addZone(name), name }; };

describe("A: DNS - journal og kompensasjon", () => {
  it("create: sammenhengende journalrad (aktør, risikoklasse D, mål, før/etter, diff, utfall SUCCESS) og kompensasjon som sletter posten og VERIFISERER", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const k = key("create");
    const ex = await mutate(gateway, "create_dns_record", { zone_id: z.id, type: "TXT", name: `_verify.${z.name}`, content: "token-123" }, k);
    expect(ex).toMatchObject({ provider: "cloudflare", tool_id: "cloudflare", action: "create_dns_record", risk_class: "D", person_id: idA.person_id, verification_outcome: "SUCCESS", recovery_available: true });
    expect(ex.target).toBe(`cloudflare:${z.id}:dns:TXT:_verify.${z.name}`);
    expect(ex.before_state).toMatchObject({ count: 0, records: [] });
    expect(JSON.stringify(ex.after_state)).toContain("token-123");
    expect(ex.state_diff).toMatchObject({ changed: { count: { before: 0, after: 1 } } });
    expect(ex.recovery_plan).toContain("delete_dns_record");
    const recordId = (ex.provider_receipt as { external_id: string }).external_id;
    expect(cf.dns.get(z.id)!.has(recordId)).toBe(true);

    const rec = await recover(gateway, "create_dns_record", k);
    expect(rec).toMatchObject({ status: "SUCCESS", recovery_of_execution_id: ex.execution_id });
    expect(cf.dns.get(z.id)!.has(recordId)).toBe(false);
    // idempotent: en ny kompensasjon finner posten borte og rører ingenting
    const again = await recover(gateway, "create_dns_record", k);
    expect(again.status).toBe("SUCCESS");
  });

  it("create av en post som ALLEREDE fantes angres ALDRI (kompensasjonen sletter bare det mutasjonen selv opprettet)", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const existing = cf.seedDns(z.id, { type: "A", name: `pre.${z.name}`, content: "192.0.2.5" });
    const k = key("dup");
    const ex = await mutate(gateway, "create_dns_record", { zone_id: z.id, type: "A", name: `pre.${z.name}`, content: "192.0.2.5" }, k);
    expect(ex.verification_outcome).toBe("SUCCESS");
    const rec = await recover(gateway, "create_dns_record", k);
    expect(rec.status).toBe("SUCCESS");
    expect(rec.recovery_result).toMatchObject({ noop: "record_existed_before_execution" });
    expect(cf.dns.get(z.id)!.has(existing)).toBe(true);
  });

  it("update: diff viser nøyaktig det som endret seg; kompensasjon setter tilbake og verifiserer", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const id = cf.seedDns(z.id, { type: "A", name: `app.${z.name}`, content: "192.0.2.1", ttl: 300, comment: "orig" });
    const k = key("update");
    const ex = await mutate(gateway, "update_dns_record", { zone_id: z.id, record_id: id, content: "192.0.2.99", comment: "ny" }, k);
    expect(ex.verification_outcome).toBe("SUCCESS");
    expect(ex.before_state).toMatchObject({ content: "192.0.2.1", comment: "orig" });
    expect(ex.state_diff).toMatchObject({ changed: { content: { before: "192.0.2.1", after: "192.0.2.99" }, comment: { before: "orig", after: "ny" } } });
    expect(cf.dns.get(z.id)!.get(id)).toMatchObject({ content: "192.0.2.99" });
    const rec = await recover(gateway, "update_dns_record", k);
    expect(rec.status).toBe("SUCCESS");
    expect(cf.dns.get(z.id)!.get(id)).toMatchObject({ content: "192.0.2.1", comment: "orig", ttl: 300 });
  });

  it("DRIFT-VERN: er posten endret av andre etter mutasjonen, overskrives den ikke - FAILED med dagens tilstand, ingenting skrives", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const id = cf.seedDns(z.id, { type: "A", name: `d.${z.name}`, content: "192.0.2.1" });
    const k = key("drift");
    await mutate(gateway, "update_dns_record", { zone_id: z.id, record_id: id, content: "192.0.2.2" }, k);
    cf.dns.get(z.id)!.get(id)!.content = "192.0.2.77"; // en annen endret posten i mellomtiden
    cf.requests.length = 0;
    const rec = await recover(gateway, "update_dns_record", k);
    expect(rec.status).toBe("FAILED");
    expect(rec.recovery_result).toMatchObject({ reason: "state_drifted_since_execution", current: { content: "192.0.2.77" } });
    expect(cf.writeRequests()).toHaveLength(0);
    expect(cf.dns.get(z.id)!.get(id)!.content).toBe("192.0.2.77");
  });

  it("delete: før-tilstand bevart; kompensasjon gjenskaper posten (ny id) med samme innhold og er idempotent", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const id = cf.seedDns(z.id, { type: "MX", name: `mail.${z.name}`, content: "mx.example.net", priority: 10, ttl: 3600 });
    const k = key("delete");
    const ex = await mutate(gateway, "delete_dns_record", { zone_id: z.id, record_id: id }, k);
    expect(ex).toMatchObject({ verification_outcome: "SUCCESS", recovery_available: true });
    expect(ex.before_state).toMatchObject({ type: "MX", content: "mx.example.net", priority: 10 });
    expect(ex.after_state).toBeNull();
    expect(cf.dns.get(z.id)!.has(id)).toBe(false);
    const rec = await recover(gateway, "delete_dns_record", k);
    expect(rec.status).toBe("SUCCESS");
    const restored = [...cf.dns.get(z.id)!.values()].find((r) => r.name === `mail.${z.name}`)!;
    expect(restored).toMatchObject({ type: "MX", content: "mx.example.net", priority: 10, ttl: 3600 });
    expect(restored.id).not.toBe(id);
    expect((await recover(gateway, "delete_dns_record", k)).recovery_result).toMatchObject({ noop: "record_already_restored" });
    expect([...cf.dns.get(z.id)!.values()].filter((r) => r.name === `mail.${z.name}`)).toHaveLength(1);
  });
});

describe("B: WAF og sone-innstillinger - journal og kompensasjon", () => {
  const phase = "http_request_firewall_custom";

  it("regel: create -> kompensasjon sletter; update -> kompensasjon setter tilbake; delete -> kompensasjon gjenskaper", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const kc = key("rc");
    const created = await mutate(gateway, "create_waf_rule", { zone_id: z.id, phase, action: "block", expression: "ip.src eq 203.0.113.9", description: "e1" }, kc);
    expect(created).toMatchObject({ verification_outcome: "SUCCESS", risk_class: "D", target: `cloudflare:${z.id}:waf:${phase}` });
    const ruleId = (created.provider_receipt as { external_id: string }).external_id;
    expect((await recover(gateway, "create_waf_rule", kc)).status).toBe("SUCCESS");
    expect(cf.rulesets.get(z.id)!.get(phase)!.rules.some((r) => r.id === ruleId)).toBe(false);

    const seeded = cf.seedRule(z.id, phase, { action: "block", expression: "ip.src eq 198.51.100.1", description: "orig", enabled: true });
    const ku = key("ru");
    const upd = await mutate(gateway, "update_waf_rule", { zone_id: z.id, phase, rule_id: seeded.ruleId, action: "managed_challenge", description: "endret" }, ku);
    expect(upd.verification_outcome).toBe("SUCCESS");
    expect(cf.rulesets.get(z.id)!.get(phase)!.rules.find((r) => r.id === seeded.ruleId)).toMatchObject({ action: "managed_challenge" });
    expect((await recover(gateway, "update_waf_rule", ku)).status).toBe("SUCCESS");
    expect(cf.rulesets.get(z.id)!.get(phase)!.rules.find((r) => r.id === seeded.ruleId)).toMatchObject({ action: "block", description: "orig" });

    const kd = key("rd");
    const del = await mutate(gateway, "delete_waf_rule", { zone_id: z.id, phase, rule_id: seeded.ruleId }, kd);
    expect(del.verification_outcome).toBe("SUCCESS");
    expect((await recover(gateway, "delete_waf_rule", kd)).status).toBe("SUCCESS");
    expect(cf.rulesets.get(z.id)!.get(phase)!.rules.some((r) => r.expression === "ip.src eq 198.51.100.1" && r.action === "block")).toBe(true);
  });

  it("en slettet regel med ukjente felt (action_parameters) kan ikke gjenskapes automatisk - ærlig PARTIAL med snapshotet, ingenting skrives", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const seeded = cf.seedRule(z.id, phase, { action: "block", expression: "ip.src eq 192.0.2.7", action_parameters: { response: { status_code: 451 } } });
    const k = key("rx");
    await mutate(gateway, "delete_waf_rule", { zone_id: z.id, phase, rule_id: seeded.ruleId }, k);
    cf.requests.length = 0;
    const rec = await recover(gateway, "delete_waf_rule", k);
    expect(rec.status).toBe("PARTIAL");
    expect(rec.recovery_result).toMatchObject({ reason: "rule_has_unmodelled_fields_manual_restore_required" });
    expect(JSON.stringify(rec.recovery_result)).toContain("451");
    expect(cf.writeRequests()).toHaveLength(0);
  });

  it("sone-innstilling: kompensasjon setter tilbake; drift stopper den", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const k = key("set");
    await mutate(gateway, "update_zone_setting", { zone_id: z.id, setting_id: "ssl", value: "strict" }, k);
    expect(cf.settings.get(z.id)!.get("ssl")).toBe("strict");
    expect((await recover(gateway, "update_zone_setting", k)).status).toBe("SUCCESS");
    expect(cf.settings.get(z.id)!.get("ssl")).toBe("full");
    const k2 = key("set2");
    await mutate(gateway, "update_zone_setting", { zone_id: z.id, setting_id: "min_tls_version", value: "1.3" }, k2);
    cf.settings.get(z.id)!.set("min_tls_version", "1.1"); // endret av andre
    const rec = await recover(gateway, "update_zone_setting", k2);
    expect(rec.status).toBe("FAILED");
    expect(rec.recovery_result).toMatchObject({ reason: "state_drifted_since_execution" });
    expect(cf.settings.get(z.id)!.get("min_tls_version")).toBe("1.1");
  });
});

describe("C: ærlige utfall - FAILED, PARTIAL, ingen strategi", () => {
  it("sone utenfor eierens liste: FAILED, ingenting utført, recovery_available=false og årsaken journalføres", async () => {
    const z = newZone();
    const other = newZone();
    const gateway = build([other.id]);
    const ex = await mutate(gateway, "create_dns_record", { zone_id: z.id, type: "A", name: `x.${z.name}`, content: "192.0.2.1" });
    expect(ex).toMatchObject({ verification_outcome: "FAILED", recovery_available: false });
    expect(ex.provider_receipt).toMatchObject({ reason: "cloudflare_zone_not_authorized" });
    expect(cf.dns.get(z.id)!.size).toBe(0);
  });

  it("leverandøren svarer 200 uten å endre: PARTIAL (aldri SUCCESS), og kompensasjonen finner ingenting å gjøre", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const id = cf.seedDns(z.id, { type: "A", name: `p.${z.name}`, content: "192.0.2.1" });
    cf.silentlyIgnoreWrites = true;
    const k = key("partial");
    const ex = await mutate(gateway, "update_dns_record", { zone_id: z.id, record_id: id, content: "192.0.2.2" }, k);
    cf.silentlyIgnoreWrites = false;
    expect(ex.verification_outcome).toBe("PARTIAL");
    expect(ex.recovery_available).toBe(true);
    const rec = await recover(gateway, "update_dns_record", k);
    expect(rec).toMatchObject({ status: "SUCCESS" });
    expect(rec.recovery_result).toMatchObject({ noop: "already_at_before_state" });
  });

  it("cache-purge: journalført som klasse C uten verifiserbar tilstand; ingen kompensasjonsstrategi (UNKNOWN, aldri fabrikkert SUCCESS)", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const k = key("purge");
    const ex = await mutate(gateway, "purge_cache", { zone_id: z.id, mode: "everything" }, k);
    expect(ex).toMatchObject({ risk_class: "C", verification_outcome: "SUCCESS", recovery_available: false, before_state: null, after_state: null });
    expect(ex.recovery_plan).toContain("ingen teknisk reversering");
    const rec = await recover(gateway, "purge_cache", k);
    expect(rec).toMatchObject({ status: "UNKNOWN", recovery_result: { reason: "no_recovery_strategy_registered" } });
  });

  it("classifyGatewayOutcome: ok=SUCCESS, postcondition_*=PARTIAL, tidsavbrudd=UNKNOWN, alt annet=FAILED", () => {
    expect(classifyGatewayOutcome({ ok: true, output_trust: "internal", deduplicated: false })).toBe("SUCCESS");
    expect(classifyGatewayOutcome({ ok: false, reason: "postcondition_mismatch" })).toBe("PARTIAL");
    expect(classifyGatewayOutcome({ ok: false, reason: "postcondition_unverified:readback_failed" })).toBe("PARTIAL");
    expect(classifyGatewayOutcome({ ok: false, reason: "postcondition_unverified:tool_timeout_outcome_unknown" })).toBe("UNKNOWN");
    // WP-K (delta-review L-1): det FØRSTE kallets ukjent-utfall-svar (ledgeren står `unverified`) er også UNKNOWN - ikke bare replay-strengen.
    for (const reason of [
      "tool_failed:tool_timeout", "tool_failed:outcome_unknown:transport_reset", "tool_failed:outcome_unknown:transport_redirect", "tool_failed:outcome_unknown:infisical_rotation_readback_failed",
      "tool_failed:outcome_unknown:cloudflare_rule_fields_changed:action_parameters", "execution_in_flight_or_outcome_unknown", "postcondition_unverified:ledger_finalize_failed"
    ]) expect(classifyGatewayOutcome({ ok: false, reason }), reason).toBe("UNKNOWN");
    for (const reason of ["tool_failed:x", "infra_paused", "invalid_parameters", "preflight_target_not_found", "cloudflare_zone_not_authorized"]) expect(classifyGatewayOutcome({ ok: false, reason }), reason).toBe("FAILED");
  });
});

describe("D: idempotens, tenant-isolasjon, journal-binding og infra-pause", () => {
  it("samme nøkkel + samme handling gir samme rad uten ny utførelse; samme nøkkel for noe annet er en eksplisitt konflikt", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const k = key("idem");
    const params = { zone_id: z.id, type: "A", name: `i.${z.name}`, content: "192.0.2.9" };
    const first = await mutate(gateway, "create_dns_record", params, k);
    cf.requests.length = 0;
    const second = await mutate(gateway, "create_dns_record", params, k);
    expect(second.execution_id).toBe(first.execution_id);
    expect(cf.requests).toHaveLength(0);
    await expect(mutate(gateway, "create_dns_record", { ...params, name: `annet.${z.name}` }, k)).rejects.toThrow("infra_idempotency_key_conflict");
    await expect(mutate(gateway, "update_zone_setting", { zone_id: z.id, setting_id: "ssl", value: "strict" }, k)).rejects.toThrow("infra_idempotency_key_conflict");
  });

  it("ukjent leverandør/handling avvises før noe utføres", async () => {
    const gateway = build([]);
    await expect(executeCloudMutation({ pool: appPool, gateway }, idA, { tenant_id: TENANT_A, provider: "aws", action: "x", parameters: {}, idempotency_key: key("u") })).rejects.toThrow(/cloud_mutation_unknown_provider/);
    await expect(mutate(gateway, "delete_zone", { zone_id: hex32() })).rejects.toThrow(/cloud_mutation_unknown_action/);
  });

  it("TENANT-ISOLASJON: tenant B ser ikke A sin journalrad, og kan ikke kompensere A sin nøkkel (execution_journal_missing)", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const k = key("tenant");
    const ex = await mutate(gateway, "create_dns_record", { zone_id: z.id, type: "A", name: `t.${z.name}`, content: "192.0.2.3" }, k);
    expect(await getInfraExecution(appPool, TENANT_A, ex.execution_id)).not.toBeNull();
    expect(await getInfraExecution(appPool, TENANT_B, ex.execution_id)).toBeNull();
    const rec = await recover(gateway, "create_dns_record", k, idB);
    expect(rec).toMatchObject({ status: "UNKNOWN", recovery_result: { reason: "execution_journal_missing" } });
    expect([...cf.dns.get(z.id)!.values()].some((r) => r.name === `t.${z.name}`)).toBe(true);
  });

  it("JOURNAL-BINDING (TSK-033): kallerens verktøy/handling/eksekusjons-id må samsvare med den journalførte eksekusjonen, ellers utføres ingenting", async () => {
    const z = newZone();
    const gateway = build([z.id]);
    const k = key("bind");
    const ex = await mutate(gateway, "create_dns_record", { zone_id: z.id, type: "A", name: `b.${z.name}`, content: "192.0.2.4" }, k);
    cf.requests.length = 0;
    const wrongAction = await recover(gateway, "delete_dns_record", k);
    const wrongExec = await recover(gateway, "create_dns_record", k, idA, { execution_id: "inf-exec-annen" });
    expect(wrongAction).toMatchObject({ status: "FAILED", recovery_result: { reason: "recovery_target_mismatch" } });
    expect(wrongExec).toMatchObject({ status: "FAILED", recovery_result: { reason: "recovery_target_mismatch" } });
    expect(cf.writeRequests()).toHaveLength(0);
    expect((await recover(gateway, "create_dns_record", k, idA, { execution_id: ex.execution_id })).status).toBe("SUCCESS");
  });

  it("infra-PAUSE stanser også kompensasjonen (skriving), mens lesing virker; etter resume lykkes den", async () => {
    const z = newZone();
    const infraGate = new InfraExecutionGate();
    const gateway = build([z.id], { infraGate });
    const k = key("pause");
    await mutate(gateway, "create_dns_record", { zone_id: z.id, type: "A", name: `pz.${z.name}`, content: "192.0.2.6" }, k);
    infraGate.pause("incident");
    const blocked = await recover(gateway, "create_dns_record", k);
    expect(blocked.status).toBe("FAILED");
    expect(blocked.recovery_result).toMatchObject({ reason: "infra_paused" });
    expect([...cf.dns.get(z.id)!.values()].some((r) => r.name === `pz.${z.name}`)).toBe(true);
    infraGate.resume();
    expect((await recover(gateway, "create_dns_record", k)).status).toBe("SUCCESS");
  });
});
