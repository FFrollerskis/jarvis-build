import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  FORBIDDEN_MODEL_TOOL_IDS, OWNER_ONLY_NAMESPACES, ToolGateway, assertManifestInvariants, assessClassDPipeline, buildToolManifest, cloudflareToolDefinitions,
  parseCloudflareMutationZones, CloudflareTransport, CONNECTOR_REGISTRY,
  type ClassDNotification, type SecretProvider, type ToolDefinition
} from "../src/index.ts";
import { FakeCloudflare, hex32 } from "./support/fake-cloudflare.ts";

/**
 * WP-E1: Cloudflare-verktøyene gjennom den EKTE `ToolGateway`-pipelinen (embedded Postgres, ekte policy, ekte klasse D-kjede, lokal fake Cloudflare).
 * Bevist: sovende uten credential, mål-autorisasjon FØR transporten, hele klasse D-kjeden (preflight/snapshot/idempotens/readback/varsling/kompensasjon),
 * PARTIAL-utfall når leverandøren ikke faktisk endret noe, InfraExecutionGate (PAUSED/DEGRADED), kill switch, frys, delegert identitet, og at verktøyene
 * aldri kan stå på en modellflate.
 */
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let cf: FakeCloudflare;
const TENANT = "tenant-e1-cf";
const owner: IdentityContext = { person_id: "person-e1-owner", tenant_id: TENANT, memory_space_id: "business", session_id: "sess-e1", device_id: "dev-e1", channel: "api", auth_strength: "signed" };
const delegate: IdentityContext = { ...owner, person_id: "person-e1-delegate", session_id: "sess-e1-d" };

beforeAll(async () => {
  const databaseDir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1-cf-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test_e1_cf LOGIN PASSWORD 'pw2'");
  await adminPool.query("GRANT jarvis_app TO jarvis_test_e1_cf");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','E1','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-e1-owner','Owner'), ('person-e1-delegate','Delegate');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-e1-owner','${TENANT}'), ('person-e1-delegate','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1_cf", password: "pw2" });
  cf = new FakeCloudflare();
  await cf.start();
}, 240_000);

afterAll(async () => {
  await cf?.stop();
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

beforeEach(() => {
  cf.requests.length = 0;
  cf.silentlyIgnoreWrites = false;
  cf.ruleUpdateSemantics = "replace";
});

interface Harness { gateway: ToolGateway; notifications: ClassDNotification[]; infraGate: InfraExecutionGate; controls: OwnerControls; killSwitch: KillSwitch; defs: ToolDefinition[]; setNotifierReady(v: boolean): void }

function harness(opts: { zones?: string[]; withToken?: boolean; classD?: boolean } = {}): Harness {
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const infraGate = new InfraExecutionGate();
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, infraGate, infraToolIds: new Set(["cloudflare"]),
    authority: { owner_person_id: owner.person_id, owner_tenants: [TENANT] }
  });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === "JARVIS_CLOUDFLARE_API_TOKEN" && opts.withToken !== false ? cf.token : null) };
  const notifications: ClassDNotification[] = [];
  let ready = true;
  const gateway = new ToolGateway(appPool, policy, secrets, controls, undefined, {
    ...(opts.classD === false ? {} : { classDPipeline: { enforce: true, notifier: { ready: () => ready, notify: async (n) => { notifications.push(n); } } } }),
    credentialBinding: { owner_person_id: owner.person_id, owner_tenants: [TENANT], internalRefs: new Set() }
  });
  const transport = new CloudflareTransport({ baseUrl: cf.baseUrl, accountId: async () => cf.accountId, sleep: async () => undefined });
  const defs = cloudflareToolDefinitions(transport, { mutationZones: new Set(opts.zones ?? []) });
  for (const d of defs) gateway.register(d);
  return { gateway, notifications, infraGate, controls, killSwitch, defs, setNotifierReady: (v) => { ready = v; } };
}

const run = (h: Harness, tool: string, params: Record<string, unknown>, key?: string, identity: IdentityContext = owner) =>
  h.gateway.execute({ identity, tool_id: "cloudflare", action: tool, parameters: params as never, ...(key ? { idempotency_key: key } : {}) });
const uniq = (p: string) => `${p}-${hex32().slice(0, 10)}`;
async function ledger(key: string) {
  return (await adminPool.query("SELECT status, before_state, after_state, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as
    { status: string; before_state: unknown; after_state: unknown; postcondition_reason: string | null } | undefined;
}

describe("A: klasse D-kjeden er komplett for hver skrivehandling (audit som kode)", () => {
  const defs = cloudflareToolDefinitions({ invoke: async () => ({}) }, {});
  const decisions: Record<string, { requires_target: boolean; specific_target_check?: boolean; readback: "predicate" | "absent" }> = {
    create_dns_record: { requires_target: true, readback: "predicate" },
    update_dns_record: { requires_target: true, readback: "predicate" },
    delete_dns_record: { requires_target: true, readback: "absent" },
    create_waf_rule: { requires_target: true, readback: "predicate" },
    update_waf_rule: { requires_target: true, specific_target_check: true, readback: "predicate" },
    delete_waf_rule: { requires_target: true, specific_target_check: true, readback: "predicate" },
    update_zone_setting: { requires_target: true, readback: "predicate" }
  };

  it("hver klasse D-handling har et eksplisitt, revidert valg (ny D-handling uten oppføring feiler her) og oppfyller assessClassDPipeline", () => {
    const dActions = defs.filter((d) => d.capability_class === "D").map((d) => d.action).sort();
    expect(dActions).toEqual(Object.keys(decisions).sort());
    for (const def of defs.filter((d) => d.capability_class === "D")) {
      const choice = decisions[def.action]!;
      expect(assessClassDPipeline(def), def.action).toEqual({ complete: true, missing: [] });
      expect(def.preflight_requires_target, def.action).toBe(choice.requires_target);
      expect(typeof def.preflight_target_check === "function", def.action).toBe(choice.specific_target_check === true);
      expect(def.postcondition_target_absent === true, def.action).toBe(choice.readback === "absent");
      expect(def.postcondition_predicate !== undefined, def.action).toBe(choice.readback === "predicate");
      expect(def.rollback_procedure.length, def.action).toBeGreaterThan(20);
      expect(def.parameterAuthorizer, def.action).toBeDefined();
    }
  });

  it("lesehandlinger er klasse A/ubetrodd, purge er klasse C uten påstått reversering, og ingenting er klasse B", () => {
    for (const d of defs.filter((x) => x.capability_class === "A")) {
      expect(d.output_trust, d.action).toBe("untrusted");
      expect(d.parameterAuthorizer, d.action).toBeUndefined();
    }
    const purge = defs.find((d) => d.action === "purge_cache")!;
    expect(purge.capability_class).toBe("C");
    expect(purge.reversible).toBe(false);
    expect(defs.some((d) => d.capability_class === "B")).toBe(false);
  });

  it("manifest-invariantene holder, og ingen Cloudflare-handling står på en modellflate (eier-eksklusivt navnerom, forbudt for modellen)", () => {
    const manifest = buildToolManifest(defs);
    expect(() => assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true })).not.toThrow();
    for (const e of manifest.values()) expect(e.surfaces, e.key).toEqual([]);
    expect(OWNER_ONLY_NAMESPACES.has("cloudflare")).toBe(true);
    expect(FORBIDDEN_MODEL_TOOL_IDS).toContain("cloudflare");
    expect(manifest.get("cloudflare.purge_cache")).toMatchObject({ risk: "C", effect: "delete" });
    expect(manifest.get("cloudflare.create_dns_record")).toMatchObject({ risk: "D", effect: "write", idempotency: "required", preflight: true, postcondition: true });
  });

  it("connectoren er registrert i dashbord-registeret med live_test = side-effektfri check_token, og mutasjonssonene er IKKE dashbord-redigerbare", () => {
    const entry = CONNECTOR_REGISTRY.find((c) => c.id === "cloudflare")!;
    expect(entry.credential_refs).toEqual(["JARVIS_CLOUDFLARE_API_TOKEN", "JARVIS_CLOUDFLARE_ACCOUNT_ID"]);
    expect(entry.live_test).toMatchObject({ tool_id: "cloudflare", action: "check_token" });
    expect(entry.credential_refs).not.toContain("JARVIS_CLOUDFLARE_MUTATION_ZONES");
    expect(defs.find((d) => d.action === entry.live_test!.action)!.capability_class).toBe("A");
  });
});

describe("B: sovende uten credential, og mål-autorisasjon FØR transporten", () => {
  it("uten token er ALLE handlinger credential_unavailable og leverandøren får ingen forespørsel", async () => {
    const zone = cf.addZone(`dormant-${hex32().slice(0, 6)}.example.com`);
    const h = harness({ withToken: false, zones: [zone] });
    for (const [tool, params] of [["check_token", {}], ["list_zones", {}], ["get_zone", { zone_id: zone }], ["purge_cache", { zone_id: zone, mode: "everything" }]] as const) {
      const r = await run(h, tool, params, uniq("k"));
      expect(r, tool).toEqual({ ok: false, reason: "credential_unavailable" });
    }
    expect(cf.requests).toHaveLength(0);
  });

  it("sone utenfor eierens mutasjonsliste nektes av parameterAuthorizer uten at leverandøren kalles; tom liste nekter alt", async () => {
    const zone = cf.addZone(`z-${hex32().slice(0, 6)}.example.com`);
    const other = cf.addZone(`o-${hex32().slice(0, 6)}.example.com`);
    const h = harness({ zones: [other] });
    const r = await run(h, "create_dns_record", { zone_id: zone, type: "A", name: `a.${(cf.zones.get(zone)!).name}`, content: "192.0.2.1" }, uniq("k"));
    expect(r).toEqual({ ok: false, reason: "cloudflare_zone_not_authorized" });
    expect(cf.requests).toHaveLength(0);
    const empty = harness({ zones: [] });
    expect(await run(empty, "purge_cache", { zone_id: other, mode: "everything" }, uniq("k"))).toEqual({ ok: false, reason: "cloudflare_zone_not_authorized" });
    expect(cf.requests).toHaveLength(0);
    expect(parseCloudflareMutationZones(`${other}, ${other.toUpperCase()}, ikke-en-id, ${"a".repeat(31)}, `)).toEqual(new Set([other]));
  });

  it("skjemaet er strengt: ukjente felt og ugyldige id-er gir invalid_parameters (ingen sti-injeksjon når så langt)", async () => {
    const zone = cf.addZone(`s-${hex32().slice(0, 6)}.example.com`);
    const h = harness({ zones: [zone] });
    const base = { zone_id: zone, type: "A", name: `a.s.example.com`, content: "192.0.2.1" };
    expect(await run(h, "create_dns_record", { ...base, evil: 1 }, uniq("k"))).toEqual({ ok: false, reason: "invalid_parameters" });
    expect(await run(h, "create_dns_record", { ...base, zone_id: "../../accounts" }, uniq("k"))).toEqual({ ok: false, reason: "invalid_parameters" });
    expect(await run(h, "update_dns_record", { zone_id: zone, record_id: zone, tenant_id: "annen" }, uniq("k"))).toEqual({ ok: false, reason: "invalid_parameters" });
    expect(await run(h, "get_zone", { zone_id: zone.toUpperCase() })).toEqual({ ok: false, reason: "invalid_parameters" });
    expect(cf.requests).toHaveLength(0);
  });

  it("delegert identitet får ikke bruke eierens Cloudflare-credential (credential-binding)", async () => {
    const zone = cf.addZone(`d-${hex32().slice(0, 6)}.example.com`);
    const h = harness({ zones: [zone] });
    expect(await run(h, "list_zones", {}, undefined, delegate)).toEqual({ ok: false, reason: "credential_not_bound_to_identity" });
    expect(cf.requests).toHaveLength(0);
  });
});

describe("C: DNS gjennom hele klasse D-kjeden (snapshot, readback, varsling, kompensasjon)", () => {
  it("create -> update -> delete: før-/etter-tilstand journalføres, hver D-utførelse varsles, sletting verifiseres som borte", async () => {
    const name = `c-${hex32().slice(0, 6)}.example.com`;
    const zone = cf.addZone(name);
    const h = harness({ zones: [zone] });
    const fqdn = `www.${name}`;

    const createKey = uniq("create");
    const created = await run(h, "create_dns_record", { zone_id: zone, type: "TXT", name: fqdn, content: "v=spf1 -all", comment: "e1" }, createKey);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created).toMatchObject({ deduplicated: false, notified: true, output_trust: "internal" });
    const recordId = created.external_id!;
    const createLedger = await ledger(createKey);
    expect(createLedger?.status).toBe("succeeded");
    expect(createLedger?.before_state).toMatchObject({ count: 0, records: [] });
    expect(JSON.stringify(createLedger?.after_state)).toContain(recordId);

    const updateKey = uniq("update");
    const updated = await run(h, "update_dns_record", { zone_id: zone, record_id: recordId, content: "v=spf1 include:_spf.example.net -all" }, updateKey);
    expect(updated.ok).toBe(true);
    const upLedger = await ledger(updateKey);
    expect(upLedger?.status).toBe("succeeded");
    expect(JSON.stringify(upLedger?.before_state)).toContain("v=spf1 -all"); // snapshot av eksisterende post FØR endringen
    expect(JSON.stringify(upLedger?.after_state)).toContain("_spf.example.net");

    const deleteKey = uniq("delete");
    const deleted = await run(h, "delete_dns_record", { zone_id: zone, record_id: recordId }, deleteKey);
    expect(deleted.ok).toBe(true);
    expect(cf.dns.get(zone)!.has(recordId)).toBe(false);
    const delLedger = await ledger(deleteKey);
    expect(delLedger?.status).toBe("succeeded");
    expect(JSON.stringify(delLedger?.before_state)).toContain("_spf.example.net"); // posten er bevart i snapshotet slik at den kan gjenskapes
    expect(delLedger?.after_state).toBeNull();

    expect(h.notifications.map((n) => `${n.action}:${n.outcome}`)).toEqual(["create_dns_record:executed", "update_dns_record:executed", "delete_dns_record:executed"]);
    expect(h.notifications.every((n) => n.recovery.length > 20 && n.tenant_id === TENANT)).toBe(true);
  });

  it("idempotens-nøkkel er PÅKREVD for klasse D, og en gjentatt nøkkel utfører ikke mutasjonen på nytt", async () => {
    const name = `i-${hex32().slice(0, 6)}.example.com`;
    const zone = cf.addZone(name);
    const h = harness({ zones: [zone] });
    const params = { zone_id: zone, type: "A", name: `a.${name}`, content: "192.0.2.77" };
    expect(await run(h, "create_dns_record", params)).toEqual({ ok: false, reason: "class_d_idempotency_key_required" });
    expect(cf.writeRequests()).toHaveLength(0);
    const key = uniq("idem");
    const first = await run(h, "create_dns_record", params, key);
    const again = await run(h, "create_dns_record", params, key);
    expect(first.ok && again.ok && again.deduplicated).toBe(true);
    expect(cf.requestsMatching("POST", /dns_records$/)).toHaveLength(1);
    expect(h.notifications).toHaveLength(1);
  });

  it("uten klar varsler er klasse D utilgjengelig (fail-closed) - og lesing virker fortsatt", async () => {
    const name = `n-${hex32().slice(0, 6)}.example.com`;
    const zone = cf.addZone(name);
    const h = harness({ zones: [zone] });
    h.setNotifierReady(false);
    expect(await run(h, "create_dns_record", { zone_id: zone, type: "A", name: `a.${name}`, content: "192.0.2.1" }, uniq("k"))).toEqual({ ok: false, reason: "class_d_notifier_not_ready" });
    expect(cf.writeRequests()).toHaveLength(0);
    expect((await run(h, "list_dns_records", { zone_id: zone })).ok).toBe(true);
  });

  it("preflight: endring/sletting av en post som ikke finnes nektes (preflight_target_not_found) uten at noe skrives", async () => {
    const name = `p-${hex32().slice(0, 6)}.example.com`;
    const zone = cf.addZone(name);
    const h = harness({ zones: [zone] });
    expect(await run(h, "update_dns_record", { zone_id: zone, record_id: hex32(), content: "192.0.2.1" }, uniq("k"))).toEqual({ ok: false, reason: "preflight_target_not_found" });
    expect(await run(h, "delete_dns_record", { zone_id: zone, record_id: hex32() }, uniq("k"))).toEqual({ ok: false, reason: "preflight_target_not_found" });
    expect(cf.writeRequests()).toHaveLength(0);
  });

  it("leverandøren svarer 200 men endrer ingenting: utfallet er IKKE ok (postcondition_mismatch), raden står som unverified og eieren varsles om det", async () => {
    const name = `u-${hex32().slice(0, 6)}.example.com`;
    const zone = cf.addZone(name);
    const id = cf.seedDns(zone, { type: "A", name: `a.${name}`, content: "192.0.2.1" });
    const h = harness({ zones: [zone] });
    cf.silentlyIgnoreWrites = true;
    const key = uniq("silent");
    const r = await run(h, "update_dns_record", { zone_id: zone, record_id: id, content: "192.0.2.2" }, key);
    expect(r).toEqual({ ok: false, reason: "postcondition_mismatch" });
    expect((await ledger(key))?.status).toBe("unverified");
    expect(h.notifications).toEqual([expect.objectContaining({ action: "update_dns_record", outcome: "unverified" })]);
    // en retry med samme nøkkel utfører ALDRI mutasjonen på nytt
    cf.requests.length = 0;
    const replay = await run(h, "update_dns_record", { zone_id: zone, record_id: id, content: "192.0.2.2" }, key);
    expect(replay.ok).toBe(false);
    expect(cf.writeRequests()).toHaveLength(0);
  });

  it("sone fra en annen konto avvises av transporten selv om den står i eierens liste (sone->konto-binding)", async () => {
    const foreign = cf.addZone(`f-${hex32().slice(0, 6)}.example.org`, hex32());
    const h = harness({ zones: [foreign] });
    const r = await run(h, "create_dns_record", { zone_id: foreign, type: "A", name: `a.${cf.zones.get(foreign)!.name}`, content: "192.0.2.1" }, uniq("k"));
    expect(r).toMatchObject({ ok: false });
    expect((r as { reason: string }).reason).toContain("cloudflare_zone_not_in_account");
    expect(cf.writeRequests()).toHaveLength(0);
  });
});

describe("D: WAF, innstillinger og cache", () => {
  it("WAF: create -> update -> delete med readback; update/delete av ukjent regel nektes i preflight", async () => {
    const name = `w-${hex32().slice(0, 6)}.example.com`;
    const zone = cf.addZone(name);
    const h = harness({ zones: [zone] });
    const phase = "http_request_firewall_custom";
    const created = await run(h, "create_waf_rule", { zone_id: zone, phase, action: "block", expression: "ip.src eq 203.0.113.9", description: "e1" }, uniq("c"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const ruleId = created.external_id!;
    expect(await run(h, "update_waf_rule", { zone_id: zone, phase, rule_id: hex32(), description: "x" }, uniq("u"))).toEqual({ ok: false, reason: "preflight_target_not_found" });
    const updKey = uniq("u");
    expect((await run(h, "update_waf_rule", { zone_id: zone, phase, rule_id: ruleId, action: "managed_challenge" }, updKey)).ok).toBe(true);
    expect(JSON.stringify((await ledger(updKey))?.before_state)).toContain('"block"');
    const delKey = uniq("d");
    expect((await run(h, "delete_waf_rule", { zone_id: zone, phase, rule_id: ruleId }, delKey)).ok).toBe(true);
    expect(cf.rulesets.get(zone)!.get(phase)!.rules).toHaveLength(0);
    expect(JSON.stringify((await ledger(delKey))?.before_state)).toContain("managed_challenge");
    expect(await run(h, "delete_waf_rule", { zone_id: zone, phase, rule_id: ruleId }, uniq("d"))).toEqual({ ok: false, reason: "preflight_target_not_found" });
  });

  it("sone-innstilling: readback bekrefter ny verdi, snapshot har den gamle; leverandør som ignorerer endringen gir postcondition_mismatch", async () => {
    const zone = cf.addZone(`s-${hex32().slice(0, 6)}.example.com`);
    const h = harness({ zones: [zone] });
    const key = uniq("s");
    expect((await run(h, "update_zone_setting", { zone_id: zone, setting_id: "ssl", value: "strict" }, key)).ok).toBe(true);
    expect(JSON.stringify((await ledger(key))?.before_state)).toContain('"full"');
    cf.silentlyIgnoreWrites = true;
    expect(await run(h, "update_zone_setting", { zone_id: zone, setting_id: "ssl", value: "off" }, uniq("s"))).toEqual({ ok: false, reason: "postcondition_mismatch" });
  });

  it("purge_cache er klasse C: ingen D-kjede, men mål-autorisasjon og eier-bundet; innhold utenfor sonen avvises i transporten", async () => {
    const name = `p-${hex32().slice(0, 6)}.example.com`;
    const zone = cf.addZone(name);
    const h = harness({ zones: [zone] });
    const ok = await run(h, "purge_cache", { zone_id: zone, mode: "files", items: [`https://${name}/a.css`] }, uniq("p"));
    expect(ok.ok).toBe(true);
    expect(cf.purges.at(-1)?.body).toEqual({ files: [`https://${name}/a.css`] });
    expect(h.notifications).toHaveLength(0); // klasse C varsles ikke via D-varsleren
    const bad = await run(h, "purge_cache", { zone_id: zone, mode: "files", items: ["https://evil.example.org/a"] }, uniq("p"));
    expect(bad.ok).toBe(false);
    expect((bad as { reason: string }).reason).toContain("cloudflare_invalid_purge_item");
  });
});

describe("E: InfraExecutionGate, kill switch og frys gjelder Cloudflare uniformt", () => {
  it("PAUSED stanser all skriving (B/C/D) men aldri lesing; DEGRADED stanser kun klasse D (purge er C og går gjennom)", async () => {
    const name = `g-${hex32().slice(0, 6)}.example.com`;
    const zone = cf.addZone(name);
    const h = harness({ zones: [zone] });
    h.infraGate.pause("incident response");
    expect(await run(h, "create_dns_record", { zone_id: zone, type: "A", name: `a.${name}`, content: "192.0.2.1" }, uniq("k"))).toEqual({ ok: false, reason: "infra_paused" });
    expect(await run(h, "purge_cache", { zone_id: zone, mode: "everything" }, uniq("k"))).toEqual({ ok: false, reason: "infra_paused" });
    expect((await run(h, "list_zones", {})).ok).toBe(true);
    expect(cf.writeRequests()).toHaveLength(0);
    h.infraGate.resume();
    h.infraGate.degrade("nedgradert");
    expect(await run(h, "update_zone_setting", { zone_id: zone, setting_id: "ssl", value: "strict" }, uniq("k"))).toEqual({ ok: false, reason: "infra_degraded_blocks_class_d" });
    expect((await run(h, "purge_cache", { zone_id: zone, mode: "everything" }, uniq("k"))).ok).toBe(true);
  });

  it("kill switch stanser alt (også lesing); frosset connector stanser alle Cloudflare-kall", async () => {
    const zone = cf.addZone(`k-${hex32().slice(0, 6)}.example.com`);
    const h = harness({ zones: [zone] });
    h.controls.freezeConnector("cloudflare");
    expect(await run(h, "list_zones", {})).toEqual({ ok: false, reason: "connector_frozen" });
    expect(await run(h, "purge_cache", { zone_id: zone, mode: "everything" }, uniq("k"))).toEqual({ ok: false, reason: "connector_frozen" });
    h.controls.unfreezeConnector("cloudflare");
    expect((await run(h, "list_zones", {})).ok).toBe(true);
    h.killSwitch.activate("test");
    const killed = await run(h, "list_zones", {});
    expect(killed.ok).toBe(false);
  });
});
