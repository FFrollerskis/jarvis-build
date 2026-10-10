import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  CLOUDFLARE_RULE_EXTRA_FIELD_MAX_CHARS, CloudflareTransport, ToolGateway, cloudflareToolDefinitions, type ClassDNotification, type SecretProvider
} from "../src/index.ts";
import { FakeCloudflare, hex32 } from "./support/fake-cloudflare.ts";

/**
 * Gjennomgang av PR #324 (M4): `update_waf_rule` KUNNE STILLE DROPPE UKJENTE REGELFELT OVER 4000 TEGN MENS READBACK SA SUKSESS.
 *
 * Funnet (bekreftet mot fake): `normalizeRule` sluppet ukjente felt over 4000 tegn (JSON) fra `extra` uten et spor; `ruleBody` sender hele regelen (verste tilfelle: serveren erstatter), så en blokkregel med
 * `action_parameters.response.content` på 6000 tegn mistet `action_parameters` ved `update_waf_rule enabled:false`. Etterbetingelsen sjekket kun action/uttrykk/beskrivelse/aktiv, så den meldte SUKSESS.
 * (Forutsetning: fakens «replace»-semantikk, også forfatterens antakelse «ingenting mistes» - ekte Cloudflare-oppførsel er IKKE verifisert.)
 *
 * Rettelsen: (1) feltnavn som ikke kan bevares registreres i `extra_omitted` (aldri verdier) og vises i preflight (`get_ruleset`); (2) endring OG sletting av en slik regel avvises med stabil feilkode - i preflight
 * (`preflight_invalid:rule_has_unroundtrippable_fields`, før noe reserveres) og i transporten (`cloudflare_rule_unroundtrippable_fields`); (3) etter PATCH må det vi sendte finnes igjen i svaret (dyp likhet per felt),
 * ellers `outcome_unknown` (uverifisert + varsling), aldri suksess.
 */
const TENANT = "tenant-e1-m4";
const owner: IdentityContext = { person_id: "person-e1-m4", tenant_id: TENANT, memory_space_id: "business", session_id: "sess-m4", device_id: "dev-m4", channel: "api", auth_strength: "signed" };
const phase = "http_request_firewall_custom";

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let appPool: pg.Pool;
let cf: FakeCloudflare;
let transport: CloudflareTransport;
let n = 0;
const uniq = (p: string): string => `${p}-${(n += 1)}-${hex32().slice(0, 8)}`;
/** Et ukjent felt hvis JSON-lengde er NØYAKTIG `jsonLength` tegn (strengverdi pluss to anførselstegn). */
const fieldOfJsonLength = (jsonLength: number): string => "x".repeat(jsonLength - 2);
const bigActionParameters = { response: { status_code: 403, content_type: "text/html", content: "<html>".padEnd(6000, "x") } };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1-m4-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw", max: 4 });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_test_e1_m4 LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_test_e1_m4;");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','E1','business');
    INSERT INTO people (person_id, display_name) VALUES ('${owner.person_id}','Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${owner.person_id}','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1_m4", password: "pw2" });
  cf = new FakeCloudflare();
  await cf.start();
  transport = new CloudflareTransport({ baseUrl: cf.baseUrl, accountId: async () => cf.accountId, sleep: async () => undefined });
}, 240_000);

afterAll(async () => {
  await cf?.stop();
  await appPool?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

beforeEach(() => {
  cf.requests.length = 0;
  cf.ruleUpdateSemantics = "replace";
  cf.patchDropsFields = [];
  cf.patchAddsFields = {};
});

const freshZone = (name = `m4-${hex32().slice(0, 6)}.example.org`): string => cf.addZone(name);
const call = (action: string, params: Record<string, unknown>) => transport.invoke(action, params as Record<string, JsonValue>, cf.token);
const dataOf = <T,>(r: { data?: JsonValue }): T => r.data as unknown as T;

function harness(zone: string): { gateway: ToolGateway; notifications: ClassDNotification[] } {
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, infraGate: new InfraExecutionGate(), infraToolIds: new Set(["cloudflare"]),
    authority: { owner_person_id: owner.person_id, owner_tenants: [TENANT] }
  });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === "JARVIS_CLOUDFLARE_API_TOKEN" ? cf.token : null) };
  const notifications: ClassDNotification[] = [];
  const gateway = new ToolGateway(appPool, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (nt) => { notifications.push(nt); } } },
    credentialBinding: { owner_person_id: owner.person_id, owner_tenants: [TENANT], internalRefs: new Set() }
  });
  for (const d of cloudflareToolDefinitions(transport, { mutationZones: new Set([zone]) })) gateway.register(d);
  return { gateway, notifications };
}
const ruleOnFake = (zone: string, ruleId: string): Record<string, unknown> | undefined => cf.rulesets.get(zone)!.get(phase)!.rules.find((r) => r.id === ruleId);

describe("A: normalisering - utelatte felt registreres (navn, aldri verdier) og vises i preflight", () => {
  it("taket er NØYAKTIG 4000 tegn JSON: 4000 bevares i `extra`, 4001 utelates og står i `extra_omitted`", async () => {
    expect(CLOUDFLARE_RULE_EXTRA_FIELD_MAX_CHARS).toBe(4000);
    const zone = freshZone();
    cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.1", exactly_at_cap: fieldOfJsonLength(4000), just_over_cap: fieldOfJsonLength(4001), small: { a: 1 } });
    const rule = dataOf<{ rules: Array<{ extra: Record<string, unknown>; extra_omitted: string[] }> }>(await call("get_ruleset", { zone_id: zone, phase })).rules[0]!;
    expect(Object.keys(rule.extra).sort()).toEqual(["exactly_at_cap", "small"]);
    expect(rule.extra_omitted).toEqual(["just_over_cap"]);
  });

  it("reviewerens regel: `action_parameters` på 6000 tegn -> extra_omitted = [action_parameters], og verdien lekker ikke ut i svaret", async () => {
    const zone = freshZone();
    cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.2", description: "med egen blokkside", action_parameters: bigActionParameters });
    const out = dataOf<{ rules: Array<{ extra: Record<string, unknown>; extra_omitted: string[] }> }>(await call("get_ruleset", { zone_id: zone, phase }));
    expect(out.rules[0]!.extra).toEqual({});
    expect(out.rules[0]!.extra_omitted).toEqual(["action_parameters"]);
    expect(JSON.stringify(out)).not.toContain("<html>");
  });

  it("en regel uten store felt har `extra_omitted: []`", async () => {
    const zone = freshZone();
    cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.3", action_parameters: { response: { status_code: 451 } } });
    expect(dataOf<{ rules: Array<{ extra_omitted: string[] }> }>(await call("get_ruleset", { zone_id: zone, phase })).rules[0]!.extra_omitted).toEqual([]);
  });
});

describe("B: transporten avviser endring og sletting av en regel som ikke kan round-trippes - ingenting sendes", () => {
  it("reviewerens repro: `update_waf_rule enabled:false` på regelen med 6000-tegns action_parameters avvises, regelen er urørt og ingen PATCH er sendt", async () => {
    const zone = freshZone();
    const { ruleId } = cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.4", description: "blokkside", action_parameters: bigActionParameters });
    cf.requests.length = 0;
    await expect(call("update_waf_rule", { zone_id: zone, phase, rule_id: ruleId, enabled: false })).rejects.toThrow("cloudflare_rule_unroundtrippable_fields:action_parameters");
    expect(cf.writeRequests()).toEqual([]);
    expect(ruleOnFake(zone, ruleId)).toMatchObject({ enabled: true, action_parameters: bigActionParameters });
  });

  it("sletting avvises på samme måte (snapshotet kunne ikke gjenopprettet feltet); også en endring som ikke ville endret noe avvises (forutsigbar regel)", async () => {
    const zone = freshZone();
    const { ruleId } = cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.5", description: "d", action_parameters: bigActionParameters });
    cf.requests.length = 0;
    await expect(call("delete_waf_rule", { zone_id: zone, phase, rule_id: ruleId })).rejects.toThrow("cloudflare_rule_unroundtrippable_fields:action_parameters");
    await expect(call("update_waf_rule", { zone_id: zone, phase, rule_id: ruleId, description: "d" })).rejects.toThrow("cloudflare_rule_unroundtrippable_fields:action_parameters");
    expect(cf.writeRequests()).toEqual([]);
    expect(ruleOnFake(zone, ruleId)).toBeDefined();
  });

  it("feilkoden er stabil og feltnavnene er vasket (maks fem navn, kun trygge tegn)", async () => {
    const zone = freshZone();
    const fields = Object.fromEntries(["a_big", "b_big", "c_big", "d_big", "e_big", "f_big", "g_big"].map((k) => [k, fieldOfJsonLength(4500)]));
    const { ruleId } = cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.6", ...fields });
    await expect(call("update_waf_rule", { zone_id: zone, phase, rule_id: ruleId, enabled: false })).rejects.toThrow(/^cloudflare_rule_unroundtrippable_fields:a_big,b_big,c_big,d_big,e_big$/);
  });

  it("andre regler i samme ruleset er upåvirket: en vanlig regel kan fortsatt endres og slettes", async () => {
    const zone = freshZone();
    cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.7", action_parameters: bigActionParameters });
    const normal = cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.8", description: "vanlig", action_parameters: { response: { status_code: 451 } } });
    const updated = dataOf<{ rule: { enabled: boolean; extra: Record<string, unknown> } }>(await call("update_waf_rule", { zone_id: zone, phase, rule_id: normal.ruleId, enabled: false }));
    expect(updated.rule.enabled).toBe(false);
    expect(updated.rule.extra).toEqual({ action_parameters: { response: { status_code: 451 } } });
    await call("delete_waf_rule", { zone_id: zone, phase, rule_id: normal.ruleId });
    expect(ruleOnFake(zone, normal.ruleId)).toBeUndefined();
  });
});

describe("C: readback - det vi sendte må finnes igjen i svaret (dyp likhet), ellers `outcome_unknown`, aldri suksess", () => {
  it("en leverandør som SILENT dropper et ukjent felt ved PATCH: transporten kaster outcome_unknown:cloudflare_rule_fields_changed med feltnavnet", async () => {
    const zone = freshZone();
    const { ruleId } = cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.9", action_parameters: { response: { status_code: 451 } } });
    cf.patchDropsFields = ["action_parameters"];
    await expect(call("update_waf_rule", { zone_id: zone, phase, rule_id: ruleId, enabled: false })).rejects.toThrow("outcome_unknown:cloudflare_rule_fields_changed:action_parameters");
    expect(cf.requestsMatching("PATCH", /\/rules\//)).toHaveLength(1);
  });

  it("felt leverandøren selv LEGGER TIL ved PATCH (standardverdier) er ikke et tap - ingen falsk alarm; endret verdi i et sendt felt ER et tap", async () => {
    const zone = freshZone();
    const { ruleId } = cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.10", action_parameters: { response: { status_code: 451 } } });
    cf.patchAddsFields = { logging: { enabled: true } };
    const ok = dataOf<{ rule: { enabled: boolean; extra: Record<string, unknown> } }>(await call("update_waf_rule", { zone_id: zone, phase, rule_id: ruleId, enabled: false }));
    expect(ok.rule.enabled).toBe(false);
    expect(ok.rule.extra).toMatchObject({ action_parameters: { response: { status_code: 451 } }, logging: { enabled: true } });
    cf.patchAddsFields = { action_parameters: { response: { status_code: 200 } } };
    await expect(call("update_waf_rule", { zone_id: zone, phase, rule_id: ruleId, enabled: true })).rejects.toThrow("outcome_unknown:cloudflare_rule_fields_changed:action_parameters");
  });

  it("nøkkelrekkefølge i et sendt felt gir ikke falsk alarm (kanonisk sammenligning)", async () => {
    const zone = freshZone();
    const { ruleId } = cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.11", action_parameters: { response: { status_code: 451, content_type: "text/plain" } } });
    cf.patchAddsFields = { action_parameters: { response: { content_type: "text/plain", status_code: 451 } } };
    expect(dataOf<{ rule: { enabled: boolean } }>(await call("update_waf_rule", { zone_id: zone, phase, rule_id: ruleId, enabled: false })).rule.enabled).toBe(false);
  });
});

describe("D: gjennom ekte ToolGateway - preflight avviser FØR noe reserveres, og tapt felt gir uverifisert utfall + varsling", () => {
  it("update/delete av regelen med store felt: `preflight_invalid:rule_has_unroundtrippable_fields` - ingen ledger-rad, ingen skriving, ingen varsling; regelen er intakt", async () => {
    const zone = freshZone();
    const { ruleId } = cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.12", description: "blokkside", action_parameters: bigActionParameters });
    const { gateway, notifications } = harness(zone);
    cf.requests.length = 0;
    for (const [action, params] of [["update_waf_rule", { enabled: false }], ["delete_waf_rule", {}]] as const) {
      const key = uniq(`m4-${action}`);
      const res = await gateway.execute({ identity: owner, tool_id: "cloudflare", action, parameters: { zone_id: zone, phase, rule_id: ruleId, ...params }, idempotency_key: key });
      expect(res, action).toEqual({ ok: false, reason: "preflight_invalid:rule_has_unroundtrippable_fields" });
      expect((await admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0].n, action).toBe(0);
    }
    expect(cf.writeRequests()).toEqual([]);
    expect(notifications).toEqual([]);
    expect(ruleOnFake(zone, ruleId)).toMatchObject({ enabled: true, action_parameters: bigActionParameters });
  });

  it("preflight-lesingen (`get_ruleset`) viser tydelig at regelen har felt som ikke kan round-trippes", async () => {
    const zone = freshZone();
    cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.13", action_parameters: bigActionParameters });
    const { gateway } = harness(zone);
    const res = await gateway.execute({ identity: owner, tool_id: "cloudflare", action: "get_ruleset", parameters: { zone_id: zone, phase } });
    expect(res.ok && (res.data as { rules: Array<{ extra_omitted: string[] }> }).rules[0]!.extra_omitted).toEqual(["action_parameters"]);
  });

  it("etterbetingelsen alene (readback-predikatet) avviser også en regel som etter endringen har utelatte felt, selv om de fire kjente feltene stemmer", () => {
    const update = cloudflareToolDefinitions({ invoke: async () => ({}) }, {}).find((d) => d.action === "update_waf_rule")!;
    const rule = { id: "r1", action: "block", expression: "ip.src eq 1.1.1.1", description: "d", enabled: false, extra_omitted: [] as string[] };
    expect(update.postcondition_predicate!({ rules: [rule] }, { rule_id: "r1", enabled: false })).toBe(true);
    expect(update.postcondition_predicate!({ rules: [{ ...rule, extra_omitted: ["action_parameters"] }] }, { rule_id: "r1", enabled: false })).toBe(false);
  });

  it("en leverandør som mister feltet ved PATCH: utfallet er IKKE suksess - `tool_failed:outcome_unknown:…`, ledger `unverified`, eieren varsles om ukjent utfall", async () => {
    const zone = freshZone();
    const { ruleId } = cf.seedRule(zone, phase, { action: "block", expression: "ip.src eq 203.0.113.14", description: "d", action_parameters: { response: { status_code: 451 } } });
    cf.patchDropsFields = ["action_parameters"];
    const { gateway, notifications } = harness(zone);
    const key = uniq("m4-lost");
    const res = await gateway.execute({ identity: owner, tool_id: "cloudflare", action: "update_waf_rule", parameters: { zone_id: zone, phase, rule_id: ruleId, enabled: false }, idempotency_key: key });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.reason).toMatch(/^tool_failed:outcome_unknown:cloudflare_rule_fields_changed:action_parameters/);
    expect((await admin.query("SELECT status FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0].status).toBe("unverified");
    expect(notifications.map((x) => x.outcome)).toEqual(["unknown"]);
  });
});
