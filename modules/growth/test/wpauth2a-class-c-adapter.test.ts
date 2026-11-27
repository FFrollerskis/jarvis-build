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
import { FallbackSecretProvider, ToolGateway, createClassCPipeline, firstWaveTools, type ClassCMode, type ToolResult } from "@jarvis/tool-gateway";
import { CAMPAIGN_TRANSITIONS, GrowthService, GrowthTransport, growthClassCAdapters, growthSetCampaignStatusAdapter } from "../src/index.ts";

/**
 * WP-AUTH2a (K3): klasse C-adapteren for `growth.set_campaign_status` mot den EKTE domenekoden (GrowthService + GrowthTransport + tilstandsmaskinen) og ekte Postgres som app-rolle (RLS), gjennom den ekte
 * ToolGateway. Beviser at adapteren bruker tilstandsmaskinens egen tabell (ingen kopi), blokkerer en ulovlig overgang FØR noe skjer, leser tilbake den faktiske statusen og lager en rollback-plan som tilstandsmaskinen tillater.
 */
const TENANT = "tenant-grw-auth2a";
const OWNER = "person-grw-owner";
const identity: IdentityContext = { person_id: OWNER, tenant_id: TENANT, memory_space_id: "business", session_id: "sess-auth2a", device_id: "dev-auth2a", channel: "api", auth_strength: "active" };

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let service: GrowthService;
let counter = 0;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-growth-auth2a-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_grw_auth2a LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_grw_auth2a");
  await admin.query(`INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}', 'Vekst', 'business')`);
  await admin.query(`INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier')`);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_grw_auth2a", password: "pw2" });
  service = new GrowthService(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

function rig(mode: ClassCMode): { run(params: Record<string, string>, key?: string): Promise<ToolResult> } {
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [TENANT] } });
  const gw = new ToolGateway(app, policy, new FallbackSecretProvider({ name: "none", get: async () => null }, { name: "internal", get: async () => "internal" }), undefined, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async () => undefined } },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT], internalRefs: new Set(["JARVIS_BUSINESS_INTERNAL_TOKEN"]) },
    classCPipeline: createClassCPipeline({ mode, adapters: growthClassCAdapters() })
  });
  for (const tool of firstWaveTools({ growth: new GrowthTransport(service) })) gw.register(tool);
  return { run: (params, key = `auth2a-grw-${(counter += 1)}`) => gw.execute({ identity, tool_id: "growth", action: "set_campaign_status", parameters: { tenant_id: TENANT, ...params }, idempotency_key: key }) };
}

const audit = async (watermark: number) => (await admin.query("SELECT type, reason, payload FROM audit_events WHERE audit_id > $1 AND tenant_id = $2 AND tool_id = 'growth' ORDER BY audit_id", [watermark, TENANT])).rows as Array<{ type: string; reason: string | null; payload: Record<string, any> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
const mark = async () => Number((await admin.query("SELECT COALESCE(MAX(audit_id), 0) AS m FROM audit_events")).rows[0].m);
const newCampaign = async (status: "draft" | "active" | "paused" | "ended" = "draft") => {
  const c = await service.createCampaign(TENANT, "business", { channel: "google_ads", name: `Kampanje ${(counter += 1)}` });
  const path: Record<string, Array<"active" | "paused" | "ended">> = { draft: [], active: ["active"], paused: ["active", "paused"], ended: ["active", "ended"] };
  for (const step of path[status]!) await service.setStatus(TENANT, "business", c.campaign_id, step);
  return c.campaign_id;
};

describe("growth.set_campaign_status: klasse C-adapter mot den ekte tjenesten", () => {
  it("adapteren dekker nøyaktig denne handlingen, og alle statuser den godtar kommer fra den ekte tilstandsmaskinen", () => {
    expect(growthClassCAdapters().map((a) => a.key)).toEqual(["growth.set_campaign_status"]);
    expect(Object.keys(CAMPAIGN_TRANSITIONS).sort()).toEqual(["active", "draft", "ended", "paused"]);
    for (const status of Object.keys(CAMPAIGN_TRANSITIONS)) expect(growthSetCampaignStatusAdapter.validate({ tenant_id: "t", campaign_id: "c", status })).toBeNull();
    for (const status of ["ACTIVE", "", "running", undefined as never]) expect(growthSetCampaignStatusAdapter.validate({ tenant_id: "t", campaign_id: "c", status })).toBe("status_unknown");
    expect(growthSetCampaignStatusAdapter.validate({ tenant_id: "", campaign_id: "c", status: "active" })).toBe("tenant_id_missing");
    expect(growthSetCampaignStatusAdapter.validate({ tenant_id: "t", campaign_id: " ", status: "active" })).toBe("campaign_id_missing");
  });

  it("enforce: lovlig overgang (active -> paused): endres i databasen, bekreftes av readback, rollback = active (lovlig tilbake)", async () => {
    const id = await newCampaign("active");
    const w = await mark();
    const key = "auth2a-grw-ok";
    expect(await rig("enforce").run({ campaign_id: id, status: "paused" }, key)).toMatchObject({ ok: true, external_id: id });
    expect((await service.getCampaign(TENANT, "business", id))?.status).toBe("paused");
    const executed = (await audit(w)).find((a) => a.type === "tool.executed")!;
    expect(executed.payload["class_c"]).toMatchObject({
      mode: "enforce", adapter: "growth.set_campaign_status", verdict: "verified", diff: [{ path: "status", before: "active", after: "paused" }], violations: [],
      rollback: { kind: "compensating_action", complete: true, registered: [true], steps: [{ tool_id: "growth", action: "set_campaign_status", parameters: { tenant_id: TENANT, campaign_id: id, status: "active" } }] }
    });
    expect((await admin.query("SELECT status, before_state, after_state FROM tool_executions WHERE idempotency_key = $1", [key])).rows[0]).toMatchObject({ status: "succeeded", before_state: { state: { status: "active" } }, after_state: { state: { status: "paused" } } });
  });

  it("enforce: ulovlig overgang (draft -> paused) avvises av preflight FØR noe reserveres - samme sluttilstand som tjenesten, men uten kall, med bevis", async () => {
    const id = await newCampaign("draft");
    const w = await mark();
    const key = "auth2a-grw-bad";
    expect(await rig("enforce").run({ campaign_id: id, status: "paused" }, key)).toEqual({ ok: false, reason: "class_c_preflight_invalid:invalid_transition:draft_to_paused" });
    expect((await service.getCampaign(TENANT, "business", id))?.status).toBe("draft");
    expect((await admin.query("SELECT 1 FROM tool_executions WHERE idempotency_key = $1", [key])).rowCount).toBe(0);
    expect((await audit(w)).find((a) => a.type === "tool.denied")!.payload["class_c"]).toMatchObject({ preflight: { outcome: "blocked" }, before: { state: { status: "draft" } } });
  });

  it("flagg AV: samme ulovlige overgang feiler i tjenesten (tool_failed) - uendret oppførsel; observe utfører også kallet (og tjenesten avviser det)", async () => {
    const id = await newCampaign("draft");
    expect(await rig("off").run({ campaign_id: id, status: "paused" })).toMatchObject({ ok: false, reason: expect.stringContaining("tool_failed:invalid_campaign_transition:draft->paused") });
    const w = await mark();
    expect(await rig("observe").run({ campaign_id: id, status: "paused" })).toMatchObject({ ok: false, reason: expect.stringContaining("tool_failed:invalid_campaign_transition") });
    const failed = (await audit(w)).find((a) => a.type === "tool.failed")!;
    expect(failed.payload["class_c"]).toMatchObject({ mode: "observe", would_block: ["preflight:preflight_invalid:invalid_transition:draft_to_paused"] });
  });

  it("kampanje som ikke finnes, ukjent status og manglende felt avvises deterministisk", async () => {
    const r = rig("enforce");
    expect(await r.run({ campaign_id: "camp-finnes-ikke", status: "active" })).toEqual({ ok: false, reason: "class_c_preflight_invalid:campaign_not_found" });
    expect(await r.run({ campaign_id: "x", status: "kjører" })).toEqual({ ok: false, reason: "class_c_target_invalid:status_unknown" });
  });

  it("rollback fra en status som tilstandsmaskinen ikke lar deg forlate (active -> ended): manuell prosedyre med lovlige overganger, ikke en kompenserende handling som ville feilet", async () => {
    const id = await newCampaign("active");
    const w = await mark();
    expect((await rig("enforce").run({ campaign_id: id, status: "ended" })).ok).toBe(true);
    const plan = (await audit(w)).find((a) => a.type === "tool.executed")!.payload["class_c"]["rollback"];
    expect(plan).toMatchObject({ kind: "manual", steps: [] });
    expect(plan.note).toContain("draft");
  });

  it("uendret status (no-op) er lovlig: ok, advarsel i preflight og rollback `none`", async () => {
    const id = await newCampaign("active");
    const w = await mark();
    expect((await rig("enforce").run({ campaign_id: id, status: "active" })).ok).toBe(true);
    expect((await audit(w)).find((a) => a.type === "tool.executed")!.payload["class_c"]).toMatchObject({ verdict: "verified", diff: [], preflight: { warnings: ["status_unchanged"] }, rollback: { kind: "none" } });
  });

  it("kompenserende rollback-trinn kan utføres av gatewayen og gjenoppretter forrige status", async () => {
    const id = await newCampaign("paused");
    const w = await mark();
    const r = rig("enforce");
    expect((await r.run({ campaign_id: id, status: "active" })).ok).toBe(true);
    const step = (await audit(w)).find((a) => a.type === "tool.executed")!.payload["class_c"]["rollback"].steps[0];
    expect((await r.run(step.parameters)).ok).toBe(true);
    expect((await service.getCampaign(TENANT, "business", id))?.status).toBe("paused");
  });
});

describe("adapteren uten database: forventet diff og dom", () => {
  const P = { tenant_id: "t", campaign_id: "c", status: "active" };
  const campaign = (status: string) => ({ data: { status, started_at: null, ended_at: null, budget_amount_ore: null } as never });

  it("forventet diff krever NØYAKTIG den ønskede statusen (ikke bare at en status finnes)", () => {
    expect(growthSetCampaignStatusAdapter.expect(P, { external_id: null, data: null }, { state: { status: "draft" }, context: {} })).toEqual([{ path: "status", op: "equals", value: "active" }]);
  });

  it("en kampanje som etterpå står i en ANNEN status enn bedt om er mismatch (aldri verifisert)", async () => {
    const replies = [campaign("draft"), campaign("paused")];
    const read = async (): Promise<{ data: never }> => replies.shift()!;
    const run = createClassCPipeline({ mode: "enforce", adapters: [growthSetCampaignStatusAdapter] }).begin({ tool_id: "growth", action: "set_campaign_status", capability_class: "C" })!;
    expect((await run.preflight(P, read, { replay: false })).block).toBeNull();
    expect((await run.verify(P, { external_id: null, data: null }, read)).postconditionReason).toBe("postcondition_mismatch");
  });
});
