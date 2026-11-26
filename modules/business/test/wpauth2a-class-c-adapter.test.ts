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
import {
  BusinessInternalSecretProvider, BusinessPipelineService, BusinessService, BusinessTransport, LEAD_STATUSES, LEAD_TERMINAL, OpenLoopService, ScoringService,
  businessClassCAdapters, businessUpdateLeadStatusAdapter
} from "../src/index.ts";

/**
 * WP-AUTH2a (K3): klasse C-adapteren for `business.update_lead_status` mot den EKTE domenekoden (BusinessPipelineService + BusinessTransport + `inspect_lead`) og ekte Postgres som app-rolle (RLS), gjennom den ekte ToolGateway.
 */
const BIZ = "tenant-biz-auth2a";
const OWNER = "person-biz-owner";
const identity: IdentityContext = { person_id: OWNER, tenant_id: BIZ, memory_space_id: "business", session_id: "sess-auth2a", device_id: "dev-auth2a", channel: "api", auth_strength: "active" };

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let pipeline: BusinessPipelineService;
let counter = 0;
let transport: BusinessTransport;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-business-auth2a-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_biz_auth2a LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_biz_auth2a");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${BIZ}', 'Forretning', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${BIZ}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES ('ms-auth2a-biz', '${BIZ}', 'business');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_biz_auth2a", password: "pw2" });
  pipeline = new BusinessPipelineService(app);
  const business = new BusinessService(app);
  // transporten trenger en gateway kun for nøstede kall (ikke i denne handlingen); en separat, tom gateway holder konstruktøren fornøyd
  const inner = new ToolGateway(app, new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch() }), new FallbackSecretProvider({ name: "none", get: async () => null }, new BusinessInternalSecretProvider()));
  transport = new BusinessTransport(business, new OpenLoopService(app), app, inner, new ScoringService(app));
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

function rig(mode: ClassCMode): { run(params: Record<string, string>, key?: string): Promise<ToolResult> } {
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), authority: { owner_person_id: OWNER, owner_tenants: [BIZ] } });
  const gw = new ToolGateway(app, policy, new FallbackSecretProvider({ name: "none", get: async () => null }, new BusinessInternalSecretProvider()), undefined, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async () => undefined } },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [BIZ], internalRefs: new Set(["JARVIS_BUSINESS_INTERNAL_TOKEN"]) },
    classCPipeline: createClassCPipeline({ mode, adapters: businessClassCAdapters() })
  });
  for (const tool of firstWaveTools({ business: transport })) gw.register(tool);
  return { run: (params, key = `auth2a-biz-${(counter += 1)}`) => gw.execute({ identity, tool_id: "business", action: "update_lead_status", parameters: { tenant_id: BIZ, ...params }, idempotency_key: key }) };
}

const mark = async () => Number((await admin.query("SELECT COALESCE(MAX(audit_id), 0) AS m FROM audit_events")).rows[0].m);
const audit = async (watermark: number) => (await admin.query("SELECT type, reason, payload FROM audit_events WHERE audit_id > $1 AND tenant_id = $2 AND tool_id = 'business' ORDER BY audit_id", [watermark, BIZ])).rows as Array<{ type: string; reason: string | null; payload: Record<string, any> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
const newLead = async (): Promise<string> => ((await pipeline.createLead(BIZ, "business", { title: `Lead ${(counter += 1)} med fritekst som ikke skal i audit` }, { actor_person_id: OWNER })).entity as unknown as { lead_id: string }).lead_id;
const leadRow = async (id: string) => (await admin.query("SELECT status, closed_at FROM business_leads WHERE lead_id = $1", [id])).rows[0] as { status: string; closed_at: Date | null };

describe("business.update_lead_status: klasse C-adapter mot den ekte tjenesten", () => {
  it("adapteren dekker nøyaktig denne handlingen og bruker tjenestens egne konstanter", () => {
    expect(businessClassCAdapters().map((a) => a.key)).toEqual(["business.update_lead_status"]);
    for (const status of LEAD_STATUSES) expect(businessUpdateLeadStatusAdapter.validate({ tenant_id: "t", lead_id: "l", status })).toBeNull();
    for (const status of ["Qualified", "", "won", undefined as never]) expect(businessUpdateLeadStatusAdapter.validate({ tenant_id: "t", lead_id: "l", status })).toBe("status_unknown");
    expect(businessUpdateLeadStatusAdapter.validate({ tenant_id: "t", lead_id: "", status: "new" })).toBe("lead_id_missing");
    expect([...LEAD_TERMINAL].sort()).toEqual(["converted", "disqualified"]);
  });

  it("enforce: ikke-terminal status (new -> qualified): endres, bekreftes, ikke lukket; før-snapshot har ingen fritekst; rollback = new", async () => {
    const id = await newLead();
    const w = await mark();
    expect(await rig("enforce").run({ lead_id: id, status: "qualified" })).toMatchObject({ ok: true, external_id: id });
    expect((await leadRow(id)).status).toBe("qualified");
    const block = (await audit(w)).find((a) => a.type === "tool.executed")!.payload["class_c"];
    expect(block).toMatchObject({
      verdict: "verified", before: { state: { status: "new", closed: false } }, after: { state: { status: "qualified", closed: false } }, diff: [{ path: "status", before: "new", after: "qualified" }],
      rollback: { kind: "compensating_action", complete: true, registered: [true], steps: [{ tool_id: "business", action: "update_lead_status", parameters: { tenant_id: BIZ, lead_id: id, status: "new" } }] }
    });
    expect(JSON.stringify(block)).not.toContain("fritekst");
  });

  it("enforce: terminal status (-> converted) setter lukketidspunkt (closed=true) og det er en del av den forventede diffen; gjenåpning nullstiller det", async () => {
    const id = await newLead();
    const w = await mark();
    const r = rig("enforce");
    expect((await r.run({ lead_id: id, status: "converted" })).ok).toBe(true);
    expect((await leadRow(id)).closed_at).not.toBeNull();
    expect((await audit(w)).find((a) => a.type === "tool.executed")!.payload["class_c"]).toMatchObject({ verdict: "verified", diff: [{ path: "closed", before: false, after: true }, { path: "status", before: "new", after: "converted" }] });
    const w2 = await mark();
    expect((await r.run({ lead_id: id, status: "contacted" })).ok).toBe(true);
    expect((await leadRow(id)).closed_at).toBeNull();
    expect((await audit(w2)).find((a) => a.type === "tool.executed")!.payload["class_c"]).toMatchObject({ verdict: "verified", diff: [{ path: "closed", before: true, after: false }, { path: "status", before: "converted", after: "contacted" }] });
  });

  it("enforce: lead som ikke finnes og ukjent status blokkeres deterministisk FØR noe skrives", async () => {
    const r = rig("enforce");
    expect(await r.run({ lead_id: "biz-ld-finnes-ikke", status: "qualified" })).toEqual({ ok: false, reason: "class_c_preflight_invalid:lead_not_found" });
    expect(await r.run({ lead_id: "biz-ld-x", status: "vunnet" })).toEqual({ ok: false, reason: "class_c_target_invalid:status_unknown" });
  });

  it("uendret status er lovlig (no-op): ok med advarsel og rollback `none`; replay av samme nøkkel gir deduplicated uten nye lesinger", async () => {
    const id = await newLead();
    const w = await mark();
    const key = "auth2a-biz-noop";
    const r = rig("enforce");
    expect((await r.run({ lead_id: id, status: "new" }, key)).ok).toBe(true);
    expect((await audit(w)).find((a) => a.type === "tool.executed")!.payload["class_c"]).toMatchObject({ verdict: "verified", diff: [], preflight: { warnings: ["status_unchanged"] }, rollback: { kind: "none" } });
    const w2 = await mark();
    expect(await r.run({ lead_id: id, status: "new" }, key)).toMatchObject({ ok: true, deduplicated: true });
    expect((await audit(w2)).map((a) => a.type)).toEqual(["tool.deduplicated"]);
  });

  it("observe og AV: samme utfall som før (ingen ekstra bevis uten modus); AV bevarer den gamle inspect-evidensen", async () => {
    const id = await newLead();
    const w = await mark();
    expect((await rig("off").run({ lead_id: id, status: "contacted" })).ok).toBe(true);
    const off = (await audit(w)).find((a) => a.type === "tool.executed")!.payload;
    expect(off["class_c"]).toBeUndefined();
    expect(off["before_state"]).toMatchObject({ status: "new" });
    const w2 = await mark();
    expect((await rig("observe").run({ lead_id: id, status: "qualified" })).ok).toBe(true);
    expect((await audit(w2)).find((a) => a.type === "tool.executed")!.payload["class_c"]).toMatchObject({ mode: "observe", verdict: "verified" });
  });
});
