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
import {
  CAR_CRITICAL_OPS, CarTransport, HOME_CRITICAL_OPS, HomeAssistantCriticalTransport, ToolGateway, UnconfiguredCarAdapter, autonomyBindingBlocker, carCriticalToolDefinitions, homeCriticalToolDefinitions, parseCarTargets, parseHomeTargets,
  type ClassDNotification, type SecretProvider
} from "@jarvis/tool-gateway";
import { DomainPauseRegistry } from "../src/domain-pause.ts";
import { SituationEngine } from "../src/service.ts";
import { FakeHomeAssistant } from "../../tool-gateway/test/support/fake-home-assistant.ts";

/**
 * WP-G2 fiks-runde (review A, LOW-4): `set_autonomy_policy` (D-160) godtok en binding til `home-assistant.critical_*`/`car.*` selv om den ALDRI kan lykkes (sveipens identitet `api`/`active` har ikke den enhetssignerte
 * eier-økten step-up krever). Nå avvises den ved BINDING. Auto-ACT med sveipens identitet nektes fortsatt av step-up (forsvar i dybden): en rad som likevel finnes gir 0 kall mot utstyret (reviewer A sin probe).
 * Autonom kjøring av kritiske fysiske handlinger er et eierspørsmål (Q-G2-1) og lempes ikke på.
 */
const TENANT = "tenant-g2-auto";
const OWNER = "person-g2-auto";
// SAMME form som produksjonens sveip-identitet: `systemIdentity(owner, "brief", { channel: "api" })` => channel api, auth_strength active.
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

describe("A: bindingen avvises ved bind-tid (LOW-4)", () => {
  it("alle 8 kritiske HA-handlinger og alle 4 bil-handlinger kan ikke bindes: `SituationAutonomyUnbindableError` og INGEN rad", async () => {
    const targets: Array<[string, string]> = [...HOME_CRITICAL_OPS.map((o): [string, string] => ["home-assistant", o.action]), ...CAR_CRITICAL_OPS.map((o): [string, string] => ["car", o.action])];
    expect(targets).toHaveLength(12);
    for (const [tool_id, action] of targets) {
      const attempt = engine.setAutonomyPolicy(TENANT, "business", { domain: "infra", tool_id, action, parameters: {} }, OWNER);
      // Integrasjon med WP-G4: G4 sin fail-closed allowlist (`autonomyActionBlocker`) står FØRST i `setAutonomyPolicy()` og avviser alle fysiske/kritiske handlinger med `SituationActActionForbiddenError`;
      // G2 sin `autonomyBindingBlocker` (`SituationAutonomyUnbindableError`, `step_up_required`) er beholdt som andre lag og er enhetstestet under. Begge feil er fail-closed og lagrer ingenting.
      await expect(attempt, `${tool_id}.${action}`).rejects.toThrow(/situation_autonomy_(action_forbidden:physical_action_not_bindable|binding_never_succeeds:.*:step_up_required)/);
      expect(autonomyBindingBlocker(tool_id, action), `${tool_id}.${action}`).toBe("step_up_required");
    }
    expect((await admin.query("SELECT count(*)::int AS n FROM situation_autonomy_policies WHERE tenant_id = $1", [TENANT])).rows[0]).toEqual({ n: 0 });
  });

  it("andre verktøy kan fortsatt bindes (kun de kritiske fysiske handlingene er stengt); lese-handlingene er ikke «kritiske» og avvises ikke av denne regelen", async () => {
    const ok = await engine.setAutonomyPolicy(TENANT, "business", { domain: "ops", tool_id: "telegram", action: "notify", parameters: { message: "{{situation_id}}" } }, OWNER);
    expect(ok.tool_id).toBe("telegram");
    expect(autonomyBindingBlocker("home-assistant", "read_critical_state")).toBeNull();
    expect(autonomyBindingBlocker("car", "read_vehicle_state")).toBeNull();
    expect(autonomyBindingBlocker("home-assistant", "lock_set")).toBeNull(); // den gamle handlingen fjernes av flagget og har sin egen vei
    await engine.clearAutonomyPolicy(TENANT, "business", "ops", OWNER);
  });

  it("drift-vakt: regelen følger de REGISTRERTE definisjonene - hver step-up-handling i hjem/bil-familiene er stengt, hver lesing er ikke", () => {
    const car = carCriticalToolDefinitions(new CarTransport({ adapter: new UnconfiguredCarAdapter(), settleMs: 5_000, pollMs: 1_000 }), { targets: parseCarTargets("bil"), settleMs: 5_000, pollMs: 1_000 });
    const home = homeCriticalToolDefinitions(new HomeAssistantCriticalTransport({ baseUrl: async () => null, settleMs: 5_000, pollMs: 500 }), { targets: parseHomeTargets("lock.a"), settleMs: 5_000, pollMs: 500 });
    for (const d of [...home, ...car]) {
      expect(autonomyBindingBlocker(d.tool_id, d.action) !== null, `${d.tool_id}.${d.action}`).toBe(d.step_up_required === true);
    }
  });
});

describe("B: forsvar i dybden - auto-ACT med sveipens identitet nektes av step-up (reviewer A sin probe)", () => {
  it("en binding som likevel finnes (satt direkte i databasen): 0 HA-forespørsler, ingen opplåsing, situasjonen eskaleres", async () => {
    await admin.query(
      `INSERT INTO situation_autonomy_policies (tenant_id, memory_space_id, domain, tool_id, action, parameters, enabled, actor_person_id)
       VALUES ($1, 'business', 'infra', 'home-assistant', 'critical_lock', '{"entity":"lock.front_door","locked":false}'::jsonb, true, $2)`, [TENANT, OWNER]
    );
    ha.reset();
    ha.set("lock.front_door", { state: "locked" });
    const { situation } = await engine.evaluateCandidate(TENANT, "business", { domain: "infra", detection_key: "infra:g2:auto:1", priority: "high", confidence: 0.9, reason: "autonomi-probe" });
    await engine.autoActPending(TENANT, "business", gateway, sweepIdentity);
    const row = (await admin.query("SELECT act_result FROM situations WHERE situation_id = $1", [situation.situation_id])).rows[0] as { act_result: string | null };
    expect(ha.requests).toHaveLength(0);
    expect(ha.serviceCalls()).toHaveLength(0);
    expect(notes).toHaveLength(0);
    expect(row.act_result === "succeeded").toBe(false);
  });

  it("direkte actOn() med samme identitet nektes (integrasjon med WP-G4: G4 sin allowlist nekter FØR gatewayen), og gatewayens step-up gir `step_up_required:signed_device_session` når den kalles direkte", async () => {
    ha.reset();
    ha.set("lock.front_door", { state: "locked" });
    const { situation } = await engine.evaluateCandidate(TENANT, "business", { domain: "infra", detection_key: "infra:g2:auto:2", priority: "high", confidence: 0.9, reason: "autonomi-probe 2" });
    // Lag 1 (WP-G4, A-HIGH-1): fysiske/kritiske handlinger nektes av actOn() FØR pause/lås/claim og FØR gatewayen.
    await expect(engine.actOn(TENANT, "business", situation.situation_id, { tool_id: "home-assistant", action: "critical_lock", parameters: { entity: "lock.front_door", locked: false }, idempotency_key: "g2-auto-direct-0001" }, gateway, sweepIdentity))
      .rejects.toThrow(/situation_autonomy_action_forbidden/);
    expect(ha.requests).toHaveLength(0);
    // Lag 2 (WP-G2, forsvar i dybden): gatewayens egen step-up nekter sveipens identitet når gatewayen kalles direkte.
    const direct = await gateway.execute({ identity: sweepIdentity, tool_id: "home-assistant", action: "critical_lock", parameters: { entity: "lock.front_door", locked: false }, idempotency_key: "g2-auto-direct-0002" });
    expect(direct).toEqual({ ok: false, reason: "step_up_required:signed_device_session" });
    expect(ha.requests).toHaveLength(0);
  });
});
