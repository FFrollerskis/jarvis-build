// REVIEWER A (WP-G2, D-464) - autonomi-vei-probe. Plasseres midlertidig som `modules/situations/test/zz-g2-review-a-autonomy.test.ts` og kjøres som `postgres` (se G2-review-A-probes.test.ts for kommandoen).
// Spørsmål: kan en eier-bundet autonomi-binding (D-160, `situation_autonomy_policies`) utføre en kritisk hjemmehandling (opplåsing) uten step-up?
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { HomeAssistantCriticalTransport, ToolGateway, homeCriticalToolDefinitions, parseHomeTargets, type ClassDNotification, type SecretProvider } from "@jarvis/tool-gateway";
import { DomainPauseRegistry } from "../src/domain-pause.ts";
import { SituationEngine } from "../src/service.ts";
import { FakeHomeAssistant } from "../../tool-gateway/test/support/fake-home-assistant.ts";

const TENANT = "tenant-g2-auto";
const OWNER = "person-g2-auto";
// SAMME form som produksjonens sveip-identitet: `systemIdentity(owner, "brief", { channel: "api" })` => channel api, auth_strength active, memory_space personal (her business, som sveipen bruker).
const sweepIdentity: IdentityContext = { person_id: OWNER, tenant_id: TENANT, memory_space_id: "business", session_id: "sess-sys-brief-xxxx", device_id: "jarvis-core", channel: "api", auth_strength: "active" };

let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let ha: FakeHomeAssistant;
let gateway: ToolGateway;
let engine: SituationEngine;
const notes: ClassDNotification[] = [];

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-g2-auto-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_g2_auto LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_g2_auto");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT}','G2 auto','person');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}','Owner');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}','${TENANT}');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_g2_auto", password: "pw2" });
  ha = new FakeHomeAssistant();
  await ha.start();
  const ks = new KillSwitch();
  const controls = new OwnerControls(ks);
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: ks, controls, authority: { owner_person_id: OWNER, owner_tenants: [TENANT] } });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === "JARVIS_HA_TOKEN" ? ha.token : null) };
  gateway = new ToolGateway(app, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (n) => { notes.push(n); } } },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT], internalRefs: new Set() }
  });
  const transport = new HomeAssistantCriticalTransport({ baseUrl: async () => ha.baseUrl, settleMs: 5_000, pollMs: 500 });
  for (const d of homeCriticalToolDefinitions(transport, { targets: parseHomeTargets("lock.front_door,alarm_control_panel.home"), settleMs: 5_000, pollMs: 500 })) gateway.register(d);
  engine = new SituationEngine(app, new DomainPauseRegistry(app, { owner_person_id: OWNER }), { owner_person_id: OWNER });
}, 240_000);

afterAll(async () => { await ha?.stop(); await app?.end(); await admin?.end(); await stop?.(); }, 120_000);

describe("autonomi-binding til en kritisk hjemmehandling", () => {
  it("OBSERVASJON: `set_autonomy_policy` godtar å binde home-assistant.critical_lock (ingen bind-tids-validering mot step-up/eier-krav)", async () => {
    const policy = await engine.setAutonomyPolicy(TENANT, "business", { domain: "infra", tool_id: "home-assistant", action: "critical_lock", parameters: { entity: "lock.front_door", locked: false } }, OWNER);
    expect(policy.tool_id).toBe("home-assistant");
  });

  it("CONTROL: auto-ACT med sveipens identitet (api/active) NEKTES av step-up - ingen HA-forespørsel, ingen opplåsing, situasjonen eskaleres", async () => {
    ha.reset();
    ha.set("lock.front_door", { state: "locked" });
    const { situation } = await engine.evaluateCandidate(TENANT, "business", { domain: "infra", detection_key: "infra:g2:auto:1", priority: "high", confidence: 0.9, reason: "autonomi-probe" });
    // eslint-disable-next-line no-console
    console.log("situasjonens stadium før auto-ACT:", situation.stage);
    const before = ha.requests.length;
    const result = await engine.autoActPending(TENANT, "business", gateway, sweepIdentity);
    // eslint-disable-next-line no-console
    console.log("autoActPending:", JSON.stringify(result));
    const row = (await admin.query("SELECT stage, act_result, reason FROM situations WHERE situation_id = $1", [situation.situation_id])).rows[0] as { stage: string; act_result: string | null; reason: string };
    // eslint-disable-next-line no-console
    console.log("situasjon etter:", JSON.stringify(row));
    expect(ha.requests.length).toBe(before); // ingen preflight, ingen kommando
    expect(ha.serviceCalls()).toHaveLength(0);
    expect(notes).toHaveLength(0);
    expect(row.act_result === "succeeded").toBe(false);
  });

  it("CONTROL: direkte actOn() med samme identitet gir samme resultat (step_up_required:signed_device_session)", async () => {
    ha.reset();
    ha.set("lock.front_door", { state: "locked" });
    const { situation } = await engine.evaluateCandidate(TENANT, "business", { domain: "infra", detection_key: "infra:g2:auto:2", priority: "high", confidence: 0.9, reason: "autonomi-probe 2" });
    const r = await engine.actOn(TENANT, "business", situation.situation_id, { tool_id: "home-assistant", action: "critical_lock", parameters: { entity: "lock.front_door", locked: false }, idempotency_key: "g2-auto-direct-0001" }, gateway, sweepIdentity);
    expect(r.tool_result).toEqual({ ok: false, reason: "step_up_required:signed_device_session" });
    expect(ha.requests).toHaveLength(0);
  });
});
