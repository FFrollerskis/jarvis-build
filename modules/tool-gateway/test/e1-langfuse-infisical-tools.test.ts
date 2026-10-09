import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  FORBIDDEN_MODEL_TOOL_IDS, INFRA_GATED_TOOL_IDS, InfisicalTransport, LangfuseTransport, OWNER_ONLY_NAMESPACES, ToolGateway, assertManifestInvariants, assessClassDPipeline,
  buildToolManifest, cloudControlToolDefinitions, infisicalToolDefinitions, langfuseToolDefinitions,
  type ClassDNotification, type SecretProvider, type ToolDefinition
} from "../src/index.ts";
import { FakeInfisical } from "./support/fake-infisical.ts";
import { FakeLangfuse } from "./support/fake-langfuse.ts";

/**
 * WP-E1: Langfuse- og Infisical-verktøyene gjennom den EKTE `ToolGateway`-pipelinen (embedded Postgres, ekte policy, ekte klasse D-kjede) mot lokale fake-servere. Bevist:
 * sovende uten credential, lesing = klasse A uten innhold/verdier, rotasjon (klasse D) kun for eier-autoriserte rotasjons-id-er med preflight/readback/varsling/infra-gate,
 * og at verdier/nøkler aldri havner i revisjon, ledger, varsler eller utdata.
 */
const TENANT = "tenant-e1-lfi";
const VALUE = "SUPER-HEMMELIG-VERDI-4711";
const owner: IdentityContext = { person_id: "person-e1-lfi", tenant_id: TENANT, memory_space_id: "business", session_id: "sess-lfi", device_id: "dev-lfi", channel: "api", auth_strength: "active" };
const delegate: IdentityContext = { ...owner, person_id: "person-e1-lfi-d", session_id: "sess-lfi-d" };

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let appPool: pg.Pool;
let lf: FakeLangfuse;
let inf: FakeInfisical;
let n = 0;
const uniq = (p: string): string => `${p}-${(n += 1)}-${Date.now().toString(36)}`;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-e1-lfi-"));
  const leased = await startLeasedEmbeddedPostgres((p) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: p, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw", max: 4 });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_test_e1_lfi LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_test_e1_lfi;");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','E1','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-e1-lfi','Owner'), ('person-e1-lfi-d','Delegate');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-e1-lfi','${TENANT}'), ('person-e1-lfi-d','${TENANT}');
  `);
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_test_e1_lfi", password: "pw2" });
  lf = new FakeLangfuse();
  inf = new FakeInfisical();
  await lf.start();
  await inf.start();
}, 240_000);

afterAll(async () => {
  await lf?.stop();
  await inf?.stop();
  await appPool?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

interface Harness { gateway: ToolGateway; notifications: ClassDNotification[]; infraGate: InfraExecutionGate; controls: OwnerControls; killSwitch: KillSwitch; defs: ToolDefinition[] }

function harness(opts: { withCredentials?: boolean; rotationIds?: string[] } = {}): Harness {
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const infraGate = new InfraExecutionGate();
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, infraGate, infraToolIds: new Set(INFRA_GATED_TOOL_IDS),
    authority: { owner_person_id: owner.person_id, owner_tenants: [TENANT] }
  });
  const creds: Record<string, string> = { LANGFUSE_SECRET_KEY: lf.secretKey, INFISICAL_CLIENT_SECRET: inf.clientSecret };
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (opts.withCredentials === false ? null : creds[ref] ?? null) };
  const notifications: ClassDNotification[] = [];
  const gateway = new ToolGateway(appPool, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (nt) => { notifications.push(nt); } } },
    credentialBinding: { owner_person_id: owner.person_id, owner_tenants: [TENANT], internalRefs: new Set() }
  });
  const lfT = new LangfuseTransport({ baseUrl: async () => lf.baseUrl, publicKey: async () => lf.publicKey, sleep: async () => undefined });
  const infT = new InfisicalTransport({ baseUrl: async () => inf.baseUrl, clientId: async () => inf.clientId, projectId: async () => inf.projectId, environment: async () => inf.environment, sleep: async () => undefined });
  const defs = [...langfuseToolDefinitions(lfT), ...infisicalToolDefinitions(infT, { rotationIds: new Set(opts.rotationIds ?? []) })];
  for (const d of defs) gateway.register(d);
  return { gateway, notifications, infraGate, controls, killSwitch, defs };
}

const run = (h: Harness, tool: "langfuse" | "infisical", action: string, parameters: Record<string, unknown>, key?: string, identity: IdentityContext = owner) =>
  h.gateway.execute({ identity, tool_id: tool, action, parameters: parameters as never, ...(key ? { idempotency_key: key } : {}) });
async function ledger(key: string) {
  return (await admin.query("SELECT status, before_state, after_state, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0] as
    { status: string; before_state: unknown; after_state: unknown; postcondition_reason: string | null } | undefined;
}

describe("A: klasse-/manifest-invariantene", () => {
  let h: Harness;
  beforeAll(() => { h = harness(); });

  it("Langfuse er ren lesing (klasse A); Infisical har nøyaktig én klasse D-handling (rotate_secrets) med komplett kjede og ærlig «ingen reversering»", () => {
    expect(h.defs.filter((d) => d.tool_id === "langfuse").every((d) => d.capability_class === "A")).toBe(true);
    const d = h.defs.filter((x) => x.capability_class === "D");
    expect(d.map((x) => `${x.tool_id}.${x.action}`)).toEqual(["infisical.rotate_secrets"]);
    expect(assessClassDPipeline(d[0]!)).toEqual({ complete: true, missing: [] });
    expect(d[0]!.preflight_requires_target).toBe(true);
    expect(d[0]!.rollback_procedure).toMatch(/ingen teknisk reversering/);
    expect(d[0]!.parameterAuthorizer).toBeDefined();
    for (const x of h.defs.filter((y) => y.capability_class === "A")) {
      expect(x.output_trust, x.action).toBe("untrusted");
      expect(x.parameterAuthorizer, x.action).toBeUndefined();
    }
  });

  it("manifest-invariantene holder, ingenting står på en modellflate, og navnerommene er eier-eksklusive og styrt av infra-gaten", () => {
    const manifest = buildToolManifest(h.defs);
    expect(() => assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true })).not.toThrow();
    for (const e of manifest.values()) expect(e.surfaces, e.key).toEqual([]);
    for (const id of ["langfuse", "infisical"]) {
      expect(OWNER_ONLY_NAMESPACES.has(id), id).toBe(true);
      expect(FORBIDDEN_MODEL_TOOL_IDS, id).toContain(id);
      expect(INFRA_GATED_TOOL_IDS.has(id), id).toBe(true);
    }
    expect(manifest.get("infisical.rotate_secrets")).toMatchObject({ risk: "D", idempotency: "required", preflight: true, postcondition: true });
  });

  it("sammensetningen (cloudControlToolDefinitions) gir alle fire skymål; uten transport faller verktøyet gjennom til «<id>_not_configured» (sovende)", async () => {
    const all = cloudControlToolDefinitions();
    expect([...new Set(all.map((d) => d.tool_id))].sort()).toEqual(["cloudflare", "infisical", "langfuse", "postgres_ops"]);
    const h2 = harness();
    const unconfigured = all.find((d) => d.tool_id === "langfuse" && d.action === "get_health")!;
    await expect(unconfigured.transport.invoke("get_health", {}, "x", { identity: owner })).rejects.toThrow("langfuse_not_configured");
    expect(h2.defs.length).toBeGreaterThan(5);
  });
});

describe("B: sovende uten credential - ingen I/O", () => {
  it("uten Langfuse-/Infisical-credential er alt credential_unavailable og fake-serverne får ingen forespørsel", async () => {
    lf.requests.length = 0;
    inf.requests.length = 0;
    const h = harness({ withCredentials: false, rotationIds: ["3f2b8c1e-9d4a-4f6b-8a1c-2e7d5b9a0c11"] });
    for (const [tool, action, params] of [["langfuse", "get_health", {}], ["langfuse", "get_trace_counts", {}], ["infisical", "get_health", {}], ["infisical", "list_secret_metadata", {}], ["infisical", "rotate_secrets", { rotation_id: "3f2b8c1e-9d4a-4f6b-8a1c-2e7d5b9a0c11" }]] as const) {
      expect(await run(h, tool, action, params, uniq("k")), `${tool}.${action}`).toEqual({ ok: false, reason: "credential_unavailable" });
    }
    expect(lf.requests).toHaveLength(0);
    expect(inf.requests).toHaveLength(0);
  });

  it("delegert identitet får ikke bruke eierens credentials (credential-binding)", async () => {
    const h = harness();
    expect(await run(h, "langfuse", "get_health", {}, undefined, delegate)).toEqual({ ok: false, reason: "credential_not_bound_to_identity" });
    expect(await run(h, "infisical", "list_secret_metadata", {}, undefined, delegate)).toEqual({ ok: false, reason: "credential_not_bound_to_identity" });
  });
});

describe("C: Langfuse gjennom gatewayen - helse, nøkkel-metadata og telling uten innhold", () => {
  it("get_health, get_project og get_trace_counts virker som klasse A; utdata er ubetrodd og uten nøkler/trace-innhold; PAUSED/DEGRADED stanser ikke lesing", async () => {
    const h = harness();
    h.infraGate.pause("test");
    const health = await run(h, "langfuse", "get_health", {});
    const project = await run(h, "langfuse", "get_project", {});
    lf.dailyMetricsAvailable = false;
    const counts = await run(h, "langfuse", "get_trace_counts", { window_days: 7 });
    lf.dailyMetricsAvailable = true;
    expect(health).toMatchObject({ ok: true, output_trust: "untrusted" });
    expect(project.ok && counts.ok).toBe(true);
    const text = JSON.stringify([health, project, counts]);
    for (const leak of [lf.secretKey, lf.publicKey, "HEMMELIG-PROMPT-INNHOLD", "bruker-42"]) expect(text).not.toContain(leak);
    h.infraGate.resume();
    h.infraGate.degrade("nedgradert");
    expect((await run(h, "langfuse", "get_health", {})).ok).toBe(true);
  });

  it("strenge skjema: ukjente felt og ugyldig vindu avvises (invalid_parameters) uten I/O", async () => {
    lf.requests.length = 0;
    const h = harness();
    expect(await run(h, "langfuse", "get_trace_counts", { window_days: 99 })).toEqual({ ok: false, reason: "invalid_parameters" });
    expect(await run(h, "langfuse", "get_health", { delete: true })).toEqual({ ok: false, reason: "invalid_parameters" });
    expect(lf.requests).toHaveLength(0);
  });
});

describe("D: Infisical gjennom gatewayen - metadata uten verdier, og rotasjon bak klasse D-kjeden", () => {
  it("list_secret_metadata gjennom gatewayen: ingen verdi i utdata, revisjon eller ledger (selv om serveren lekker)", async () => {
    inf.leakValues = true;
    inf.secrets.clear();
    inf.seedSecret("CONNECTOR_TOKEN", VALUE, { ageDays: 120 });
    const h = harness();
    const r = await run(h, "infisical", "list_secret_metadata", { max_age_days: 90 });
    inf.leakValues = false;
    expect(r).toMatchObject({ ok: true, output_trust: "untrusted" });
    expect(JSON.stringify(r)).not.toContain(VALUE);
    expect(r.ok && (r.data as unknown as { stale_count: number }).stale_count).toBe(1);
    const audit = await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE payload::text LIKE $1 OR reason LIKE $1", [`%${VALUE}%`]);
    expect((audit.rows[0] as { n: number }).n).toBe(0);
  });

  it("rotasjon kun for eier-autoriserte id-er: uautorisert id nektes UTEN I/O; tom liste nekter all rotasjon", async () => {
    const r = inf.seedRotation();
    inf.requests.length = 0;
    const h = harness({ rotationIds: [] });
    expect(await run(h, "infisical", "rotate_secrets", { rotation_id: r.id }, uniq("k"))).toEqual({ ok: false, reason: "infisical_rotation_not_authorized" });
    expect(await run(h, "infisical", "rotate_secrets", { rotation_id: "../x" }, uniq("k"))).toEqual({ ok: false, reason: "invalid_parameters" });
    expect(inf.requests).toHaveLength(0);
  });

  it("rotasjon gjennom hele kjeden: preflight (finnes), snapshot uten verdier, idempotens-nøkkel, readback (ny rotasjon), varsling - og en gjentatt nøkkel roterer ikke på nytt", async () => {
    const r = inf.seedRotation({ name: "supabase-main" });
    const h = harness({ rotationIds: [r.id] });
    inf.requests.length = 0;
    expect(await run(h, "infisical", "rotate_secrets", { rotation_id: r.id })).toEqual({ ok: false, reason: "class_d_idempotency_key_required" });
    const key = uniq("rot");
    const res = await run(h, "infisical", "rotate_secrets", { rotation_id: r.id }, key);
    expect(res).toMatchObject({ ok: true, external_id: `rotation:${r.id}`, notified: true, deduplicated: false });
    const l = await ledger(key);
    expect(l?.status).toBe("succeeded");
    expect(l?.before_state).toMatchObject({ id: r.id, name: "supabase-main", rotation_status: "success" });
    expect((l?.after_state as { last_rotated_at: string }).last_rotated_at).not.toBe((l?.before_state as { last_rotated_at: string }).last_rotated_at);
    expect(h.notifications).toEqual([expect.objectContaining({ tool_id: "infisical", action: "rotate_secrets", outcome: "executed", idempotency_key: key })]);
    expect(h.notifications[0]!.recovery).toMatch(/ingen teknisk reversering/);
    const second = await run(h, "infisical", "rotate_secrets", { rotation_id: r.id }, key);
    expect(second.ok && second.deduplicated).toBe(true);
    expect(inf.requestsMatching("POST", /rotate-secrets$/)).toHaveLength(1);
    expect(JSON.stringify([res, h.notifications, l])).not.toContain("secretValue");
  });

  it("preflight: en autorisert, men ikke-eksisterende rotasjon -> preflight_target_not_found uten POST; utilgjengelig funksjon gir det samme", async () => {
    const ghost = "3f2b8c1e-9d4a-4f6b-8a1c-2e7d5b9a0c11";
    const h = harness({ rotationIds: [ghost] });
    inf.requests.length = 0;
    expect(await run(h, "infisical", "rotate_secrets", { rotation_id: ghost }, uniq("k"))).toEqual({ ok: false, reason: "preflight_target_not_found" });
    inf.rotationsStatus = 403;
    expect(await run(h, "infisical", "rotate_secrets", { rotation_id: ghost }, uniq("k"))).toEqual({ ok: false, reason: "preflight_target_not_found" });
    inf.rotationsStatus = 200;
    expect(inf.requestsMatching("POST", /rotate-secrets/)).toHaveLength(0);
  });

  it("leverandøren svarer ok men roterer ikke: utfallet er IKKE ok (postcondition_mismatch), raden står som unverified og eieren varsles om det", async () => {
    const r = inf.seedRotation({ lastRotatedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
    const h = harness({ rotationIds: [r.id] });
    inf.silentlyIgnoreRotate = true;
    const key = uniq("silent");
    const res = await run(h, "infisical", "rotate_secrets", { rotation_id: r.id }, key);
    inf.silentlyIgnoreRotate = false;
    expect(res).toEqual({ ok: false, reason: "postcondition_mismatch" });
    expect((await ledger(key))?.status).toBe("unverified");
    expect(h.notifications).toEqual([expect.objectContaining({ outcome: "unverified" })]);
  });

  it("feilet rotasjon hos leverandøren -> tool_failed (ikke ok), journalført som failed, ingen varsel om «utført»", async () => {
    const r = inf.seedRotation();
    const h = harness({ rotationIds: [r.id] });
    inf.rotationFails = true;
    const key = uniq("fail");
    const res = await run(h, "infisical", "rotate_secrets", { rotation_id: r.id }, key);
    inf.rotationFails = false;
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/^tool_failed:infisical_rotation_failed:failed/);
    expect((await ledger(key))?.status).toBe("failed");
    expect(h.notifications.filter((x) => x.outcome === "executed")).toHaveLength(0);
  });

  it("PAUSED stanser rotasjon men aldri lesing; DEGRADED stanser rotasjon (klasse D); kill switch/frys stanser alt", async () => {
    const r = inf.seedRotation();
    const h = harness({ rotationIds: [r.id] });
    h.infraGate.pause("incident");
    expect(await run(h, "infisical", "rotate_secrets", { rotation_id: r.id }, uniq("k"))).toEqual({ ok: false, reason: "infra_paused" });
    expect((await run(h, "infisical", "list_secret_rotations", {})).ok).toBe(true);
    expect((await run(h, "infisical", "get_health", {})).ok).toBe(true);
    h.infraGate.resume();
    h.infraGate.degrade("nedgradert");
    expect(await run(h, "infisical", "rotate_secrets", { rotation_id: r.id }, uniq("k"))).toEqual({ ok: false, reason: "infra_degraded_blocks_class_d" });
    expect((await run(h, "infisical", "list_secret_metadata", {})).ok).toBe(true);
    h.infraGate.resume();
    h.controls.freezeConnector("infisical");
    expect(await run(h, "infisical", "get_health", {})).toEqual({ ok: false, reason: "connector_frozen" });
    h.controls.unfreezeConnector("infisical");
    h.killSwitch.activate("test");
    expect((await run(h, "infisical", "get_health", {})).ok).toBe(false);
  });
});
