import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Channel, IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  CloudflareTransport, INFRA_GATED_TOOL_IDS, OWNER_STEP_UP_CHANNELS, ToolGateway, cloudControlToolDefinitions, cloudflareToolDefinitions, infisicalToolDefinitions, langfuseToolDefinitions,
  ownerStepUpDenial, parsePostgresOpsConfig, postgresOpsToolDefinitions, type ClassDNotification, type SecretProvider, type ToolDefinition, type ToolTransport
} from "../src/index.ts";
import { FakeCloudflare, hex32 } from "./support/fake-cloudflare.ts";

/**
 * Gjennomgang av PR #324 (M2): INGEN STEP-UP PÅ DE NYE MUTASJONENE. SOVEREIGN-modus var eneste krav, så en stjålet eller svak eier-grant (passiv, tale, Telegram) kunne endre produksjons-DNS/WAF/SSL
 * (`update_zone_setting ssl=off` ga `ok:true, notified:true`; `purge_cache everything` ga `ok:true`), terminere Postgres-økter og rotere Infisical-hemmeligheter. WP-F1 krever allerede signert enhetsøkt for penger
 * via `ToolDefinition.step_up_required` (håndhevet av gatewayen SELV, uavhengig av `classDPipeline.enforce`); nå gjelder det samme ALLE klasse C/D-mutasjoner i `cloudflare`, `postgres_ops` og `infisical`.
 * Dette er en D-41/D-192-avveining: standard er den strengeste, og Tobias kan lempe den per handling med en navngitt D-beslutning.
 *
 * Bevist her (ekte `ToolGateway` + ekte policy mot embedded Postgres): (A) tabell over ALLE mutasjoner - hver har `step_up_required`, og ingen ny C/D-handling kan komme til uten; (B) hver mutasjon nektes for
 * passiv/aktiv/tale/Telegram/klokke/Slack/Discord/Twilio/system/delegert/annen person - UTEN at transporten kalles og uten ledger-rad; (C) en signert eier fra web/desktop/api/mobile passerer porten for hver mutasjon;
 * (D) klasse A er uendret (ingen step-up); (E) reviewerens repro mot fake Cloudflare: innstillingen endres ikke ved svak/tale-identitet.
 */
const TENANT = "tenant-e1-m2";
const owner: IdentityContext = { person_id: "person-e1-m2", tenant_id: TENANT, memory_space_id: "business", session_id: "sess-m2", device_id: "dev-m2", channel: "api", auth_strength: "signed" };
const ZONE = "0123456789abcdef0123456789abcdef";
const RECORD = "fedcba9876543210fedcba9876543210";
const RULE = "aaaabbbbccccddddeeeeffff00001111";
const ROTATION = "3f2b8c1e-9d4a-4f6b-8a1c-2e7d5b9a0c11";
const DB = "jarvis_test";
const TS = "2026-10-09T10:00:00.000000Z";

interface Mutation { tool_id: string; action: string; capability: "C" | "D"; params: Record<string, JsonValue> }
/** ALLE klasse C/D-handlinger i de tre verktøyene, med gyldige parametre (inndata og mål-autorisasjon MÅ passere, ellers ville et annet avslag maskert step-up). */
const MUTATIONS: readonly Mutation[] = [
  { tool_id: "cloudflare", action: "create_dns_record", capability: "D", params: { zone_id: ZONE, type: "A", name: "x.example.org", content: "192.0.2.1" } },
  { tool_id: "cloudflare", action: "update_dns_record", capability: "D", params: { zone_id: ZONE, record_id: RECORD, content: "192.0.2.2" } },
  { tool_id: "cloudflare", action: "delete_dns_record", capability: "D", params: { zone_id: ZONE, record_id: RECORD } },
  { tool_id: "cloudflare", action: "create_waf_rule", capability: "D", params: { zone_id: ZONE, phase: "http_request_firewall_custom", action: "block", expression: "ip.src eq 192.0.2.7" } },
  { tool_id: "cloudflare", action: "update_waf_rule", capability: "D", params: { zone_id: ZONE, phase: "http_request_firewall_custom", rule_id: RULE, enabled: false } },
  { tool_id: "cloudflare", action: "delete_waf_rule", capability: "D", params: { zone_id: ZONE, phase: "http_request_firewall_custom", rule_id: RULE } },
  { tool_id: "cloudflare", action: "update_zone_setting", capability: "D", params: { zone_id: ZONE, setting_id: "ssl", value: "off" } },
  { tool_id: "cloudflare", action: "purge_cache", capability: "C", params: { zone_id: ZONE, mode: "everything" } },
  { tool_id: "postgres_ops", action: "terminate_backend", capability: "D", params: { pid: 4242, database: DB, backend_start: TS } },
  { tool_id: "postgres_ops", action: "cancel_query", capability: "D", params: { pid: 4242, database: DB, backend_start: TS, query_start: TS } },
  { tool_id: "postgres_ops", action: "vacuum_analyze", capability: "D", params: { database: DB, schema: "public", table: "events" } },
  { tool_id: "infisical", action: "rotate_secrets", capability: "D", params: { rotation_id: ROTATION } }
];
const READS: ReadonlyArray<{ tool_id: string; action: string; params: Record<string, JsonValue> }> = [
  { tool_id: "cloudflare", action: "list_zones", params: {} },
  { tool_id: "cloudflare", action: "get_zone_setting", params: { zone_id: ZONE, setting_id: "ssl" } },
  { tool_id: "postgres_ops", action: "get_connections", params: {} },
  { tool_id: "infisical", action: "get_health", params: {} },
  { tool_id: "langfuse", action: "get_health", params: {} }
];

/** Teller ALLE transportkall (preflight, mutasjon, readback). Et avvist step-up skal gi NULL kall. */
function counting(): ToolTransport & { calls: string[] } {
  const calls: string[] = [];
  return { calls, invoke: async (action) => { calls.push(action); return { data: null }; } };
}

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let appPool: pg.Pool;
let n = 0;
const uniq = (p: string): string => `${p}-${(n += 1)}-${hex32().slice(0, 8)}`;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1-m2-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw", max: 4 });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_test_e1_m2 LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_test_e1_m2;");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','E1','business');
    INSERT INTO people (person_id, display_name) VALUES ('${owner.person_id}','Owner'), ('person-annen','Annen');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${owner.person_id}','${TENANT}'), ('person-annen','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1_m2", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

function build(transport: ToolTransport, secretFor: (ref: string) => string | null = () => "x"): { gateway: ToolGateway; defs: ToolDefinition[]; notifications: ClassDNotification[] } {
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, infraGate: new InfraExecutionGate(), infraToolIds: new Set(INFRA_GATED_TOOL_IDS),
    authority: { owner_person_id: owner.person_id, owner_tenants: [TENANT] }
  });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => secretFor(ref) };
  const notifications: ClassDNotification[] = [];
  const gateway = new ToolGateway(appPool, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (nt) => { notifications.push(nt); } } },
    credentialBinding: { owner_person_id: owner.person_id, owner_tenants: [TENANT], internalRefs: new Set() }
  });
  const defs = [
    ...cloudflareToolDefinitions(transport, { mutationZones: new Set([ZONE]) }),
    ...postgresOpsToolDefinitions(transport, { ops: parsePostgresOpsConfig({ databases: DB }) }),
    ...infisicalToolDefinitions(transport, { rotationIds: new Set([ROTATION]) }),
    ...langfuseToolDefinitions(transport)
  ];
  for (const d of defs) gateway.register(d);
  return { gateway, defs, notifications };
}

const ledgerRows = async (key: string): Promise<number> => (await admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0].n as number;

describe("A: tabell - ALLE klasse C/D-mutasjoner i cloudflare, postgres_ops og infisical har step_up_required (ingen kan komme til uten)", () => {
  const defs = cloudControlToolDefinitions({}, {});

  it("settet av C/D-handlinger i de tre verktøyene er NØYAKTIG tabellen over, og hver har step_up_required: true", () => {
    const actual = defs.filter((d) => ["cloudflare", "postgres_ops", "infisical"].includes(d.tool_id) && (d.capability_class === "C" || d.capability_class === "D"));
    expect(actual.map((d) => `${d.tool_id}.${d.action}:${d.capability_class}`).sort()).toEqual(MUTATIONS.map((m) => `${m.tool_id}.${m.action}:${m.capability}`).sort());
    for (const d of actual) expect(d.step_up_required, `${d.tool_id}.${d.action}`).toBe(true);
    expect(MUTATIONS).toHaveLength(12);
  });

  it("klasse A (lesing) har aldri step_up_required - helse, diagnostikk og metadata må virke også fra tale/chat", () => {
    for (const d of defs.filter((x) => x.capability_class === "A")) expect(d.step_up_required, `${d.tool_id}.${d.action}`).not.toBe(true);
    expect(defs.filter((x) => x.capability_class === "A").length).toBeGreaterThan(20);
  });

  it("reglen er den delte ownerStepUpDenial (signert enhet + web/desktop/api/mobile) - ikke en egen kopi", () => {
    expect([...OWNER_STEP_UP_CHANNELS].sort()).toEqual(["api", "desktop", "mobile", "web"]);
    expect(ownerStepUpDenial({ auth_strength: "signed", channel: "api" })).toBeUndefined();
    expect(ownerStepUpDenial({ auth_strength: "active", channel: "api" })).toBe("step_up_required:signed_device_session");
    expect(ownerStepUpDenial({ auth_strength: "signed", channel: "voice" })).toBe("step_up_required:channel_voice_not_allowed");
  });
});

describe("B: svak/passiv/tale/delegert identitet nektes for HVER mutasjon - uten at transporten kalles og uten ledger-rad", () => {
  const WEAK: ReadonlyArray<readonly [string, IdentityContext]> = [
    ["passiv / api", { ...owner, auth_strength: "passive" }],
    ["aktiv / api", { ...owner, auth_strength: "active" }],
    ["passiv / tale (reviewerens repro)", { ...owner, auth_strength: "passive", channel: "voice" }],
    ["aktiv / web (ikke enhetssignert)", { ...owner, auth_strength: "active", channel: "web" }],
    ["signert / tale", { ...owner, channel: "voice" }],
    ...(["telegram", "watch", "slack", "discord", "twilio", "system"] as Channel[]).map((c) => [`signert / ${c}`, { ...owner, channel: c }] as const)
  ];

  it("hver mutasjon × hver svak identitet gir `step_up_required:*` - ingen transport-I/O, ingen ledger-rad, ingen varsling", async () => {
    const t = counting();
    const { gateway, notifications } = build(t);
    for (const m of MUTATIONS) {
      for (const [label, identity] of WEAK) {
        const key = uniq("m2-weak");
        const res = await gateway.execute({ identity, tool_id: m.tool_id, action: m.action, parameters: m.params, idempotency_key: key });
        expect(res.ok, `${m.tool_id}.${m.action} / ${label}`).toBe(false);
        expect(res.ok ? "" : res.reason, `${m.tool_id}.${m.action} / ${label}`).toMatch(/^step_up_required:(signed_device_session|channel_[a-z]+_not_allowed)$/);
        expect(await ledgerRows(key), `${m.action} / ${label}: ledger`).toBe(0);
      }
    }
    expect(t.calls, "transporten skal aldri være kalt").toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("delegert identitet (eierens person MED delegation_id) og annen person i eierens tenant nektes også - signert på web, uten at transporten kalles", async () => {
    const t = counting();
    const { gateway } = build(t);
    for (const m of MUTATIONS) {
      for (const identity of [{ ...owner, channel: "web" as const, delegation_id: "deleg-1" }, { ...owner, channel: "web" as const, person_id: "person-annen" }]) {
        const res = await gateway.execute({ identity, tool_id: m.tool_id, action: m.action, parameters: m.params, idempotency_key: uniq("m2-deleg") });
        expect(res.ok, `${m.action}`).toBe(false);
        expect(res.ok ? "" : res.reason, `${m.action}`).toBe("credential_not_bound_to_identity");
      }
    }
    expect(t.calls).toEqual([]);
  });

  it("step-up håndheves av gatewayen SELV: også uten klasse D-kjede (`classDPipeline` av) og for klasse C (`purge_cache`)", async () => {
    const t = counting();
    const killSwitch = new KillSwitch();
    const controls = new OwnerControls(killSwitch);
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, infraGate: new InfraExecutionGate(), infraToolIds: new Set(INFRA_GATED_TOOL_IDS),
      authority: { owner_person_id: owner.person_id, owner_tenants: [TENANT] }
    });
    const bare = new ToolGateway(appPool, policy, { name: "fake", get: async () => "x" }, controls, undefined, { credentialBinding: { owner_person_id: owner.person_id, owner_tenants: [TENANT], internalRefs: new Set() } });
    for (const d of [...cloudflareToolDefinitions(t, { mutationZones: new Set([ZONE]) }), ...postgresOpsToolDefinitions(t, { ops: parsePostgresOpsConfig({ databases: DB }) }), ...infisicalToolDefinitions(t, { rotationIds: new Set([ROTATION]) })]) bare.register(d);
    for (const m of MUTATIONS) {
      const res = await bare.execute({ identity: { ...owner, auth_strength: "passive", channel: "voice" }, tool_id: m.tool_id, action: m.action, parameters: m.params, idempotency_key: uniq("m2-bare") });
      expect(res, `${m.action}`).toEqual({ ok: false, reason: "step_up_required:signed_device_session" });
    }
    expect(t.calls).toEqual([]);
  });
});

describe("C: signert eier fra web/desktop/api/mobile passerer step-up-porten for HVER mutasjon", () => {
  it("transporten nås (preflight/mutasjon) og avslaget er aldri `step_up_required:*`", async () => {
    for (const channel of ["web", "desktop", "api", "mobile"] as Channel[]) {
      const t = counting();
      const { gateway } = build(t);
      for (const m of MUTATIONS) {
        const before = t.calls.length;
        const res = await gateway.execute({ identity: { ...owner, channel }, tool_id: m.tool_id, action: m.action, parameters: m.params, idempotency_key: uniq("m2-ok") });
        expect(res.ok ? "" : res.reason, `${m.action} / ${channel}`).not.toMatch(/^step_up_required/);
        expect(t.calls.length, `${m.action} / ${channel}: transporten nådd`).toBeGreaterThan(before);
      }
    }
  });
});

describe("D: klasse A er uendret - lesing krever aldri step-up (tale/chat/passiv virker som før)", () => {
  it("passiv tale-identitet slipper gjennom til transporten for lesing", async () => {
    const t = counting();
    const { gateway } = build(t);
    for (const r of READS) {
      const before = t.calls.length;
      const res = await gateway.execute({ identity: { ...owner, auth_strength: "passive", channel: "voice" }, tool_id: r.tool_id, action: r.action, parameters: r.params });
      expect(res.ok ? "" : res.reason, `${r.tool_id}.${r.action}`).not.toMatch(/^step_up_required/);
      expect(t.calls.length, `${r.tool_id}.${r.action}`).toBeGreaterThan(before);
    }
  });
});

describe("E: reviewerens repro mot fake Cloudflare - `update_zone_setting ssl=off` og `purge_cache everything` med passiv tale-identitet", () => {
  it("nektes: innstillingen er uendret, ingen skriveforespørsel er sendt, ingen varsling; en signert eier får gjennom", async () => {
    const cf = new FakeCloudflare();
    await cf.start();
    try {
      const zone = cf.addZone("example.org");
      const transport = new CloudflareTransport({ baseUrl: cf.baseUrl, accountId: async () => cf.accountId, sleep: async () => undefined });
      const killSwitch = new KillSwitch();
      const controls = new OwnerControls(killSwitch);
      const policy = new PolicyGateway({
        devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, infraGate: new InfraExecutionGate(), infraToolIds: new Set(INFRA_GATED_TOOL_IDS),
        authority: { owner_person_id: owner.person_id, owner_tenants: [TENANT] }
      });
      const notifications: ClassDNotification[] = [];
      const gateway = new ToolGateway(appPool, policy, { name: "fake", get: async () => cf.token }, controls, undefined, {
        classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (nt) => { notifications.push(nt); } } },
        credentialBinding: { owner_person_id: owner.person_id, owner_tenants: [TENANT], internalRefs: new Set() }
      });
      for (const d of cloudflareToolDefinitions(transport, { mutationZones: new Set([zone]) })) gateway.register(d);
      const weak: IdentityContext = { ...owner, auth_strength: "passive", channel: "voice" };

      const ssl = await gateway.execute({ identity: weak, tool_id: "cloudflare", action: "update_zone_setting", parameters: { zone_id: zone, setting_id: "ssl", value: "off" }, idempotency_key: uniq("m2-ssl") });
      expect(ssl).toEqual({ ok: false, reason: "step_up_required:signed_device_session" });
      const purge = await gateway.execute({ identity: weak, tool_id: "cloudflare", action: "purge_cache", parameters: { zone_id: zone, mode: "everything" }, idempotency_key: uniq("m2-purge") });
      expect(purge).toEqual({ ok: false, reason: "step_up_required:signed_device_session" });
      expect(cf.settings.get(zone)!.get("ssl")).toBe("full");
      expect(cf.purges).toEqual([]);
      expect(cf.writeRequests()).toEqual([]);
      expect(notifications).toEqual([]);

      const ok = await gateway.execute({ identity: owner, tool_id: "cloudflare", action: "update_zone_setting", parameters: { zone_id: zone, setting_id: "ssl", value: "strict" }, idempotency_key: uniq("m2-ssl-ok") });
      expect(ok.ok).toBe(true);
      expect(cf.settings.get(zone)!.get("ssl")).toBe("strict");
      expect(notifications).toHaveLength(1);
    } finally {
      await cf.stop();
    }
  });
});
