import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { MemoryTraceSink, ModelGateway } from "@jarvis/model-gateway";
import { ScriptedAdapter } from "@jarvis/provider-adapters";
import {
  DailyBrief, FakeTransport, ToolGateway, buildStatusSource, calendarSource, emailSource,
  firstWaveTools, homeAssistantTools, tasksSource, type SecretProvider
} from "@jarvis/tool-gateway";

const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let gateway: ToolGateway;
let policy: PolicyGateway;
let controls: OwnerControls;
let killSwitch: KillSwitch;
let ha: FakeTransport;

const owner: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "home",
  session_id: "s", device_id: "d", channel: "voice", auth_strength: "active"
};
const secrets: SecretProvider = { name: "t", async get() { return "tok"; } };
const lockParams = { site_id: "hus", room_id: "gang", entity: "lock.dor", locked: false };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pgua0-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise(); await epg.start(); await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  // Teardown-race (embedded-PG): server-terminert klient skal aldri bli uncaught.
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_test LOGIN PASSWORD 'pw2'; GRANT jarvis_app TO jarvis_test;");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('tenant-a','T','person'), ('tenant-b','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','tenant-a'), ('person-tobias','tenant-b');
    INSERT INTO tasks (task_id, tenant_id, owner_person_id, goal, contract, status)
      VALUES ('task-open','tenant-a','person-tobias','skriv tilbud til Dennis','{}'::jsonb,'created'),
             ('task-fail','tenant-a','person-tobias','deploy nettside','{}'::jsonb,'failed'),
             ('task-b','tenant-b','person-tobias','B-hemmelig oppgave','{}'::jsonb,'created');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_test", password: "pw2" });

  killSwitch = new KillSwitch();
  controls = new OwnerControls(killSwitch);
  policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls,
    authority: { owner_person_id: "person-tobias", owner_tenants: ["tenant-a"] }
  });
  // Stateful HA-fake: readback etter lock_set viser FAKTISK endret tilstand.
  let locked = true;
  ha = {
    calls: [],
    async invoke(action: string, parameters: Record<string, JsonValue>) {
      (this as FakeTransport).calls.push({ action, parameters });
      if (action === "read_state") return { data: { locked } };
      if (action === "lock_set") { locked = Boolean(parameters["locked"]); }
      return { external_id: "ha-1" };
    }
  } as unknown as FakeTransport;
  gateway = new ToolGateway(appPool, policy, secrets, controls);
  for (const t of [...homeAssistantTools(ha), ...firstWaveTools({
    email: new FakeTransport(() => ({ data: { messages: [
      { id: "m1", from: "dennis@kunde.no", subject: "Tilbud?", unanswered: "true", important: "true", at: "2026-08-13T08:00:00Z" },
      { id: "m1", from: "dennis@kunde.no", subject: "Tilbud?", unanswered: "true", important: "true", at: "2026-08-13T08:00:00Z" },
      { id: "m2", from: "nyhetsbrev@x.no", subject: "Ukens nytt", at: "2026-08-13T07:00:00Z" }
    ] } })),
    calendar: new FakeTransport(() => ({ data: { events: [
      { id: "e1", title: "Styremøte", start: "2026-08-13T10:00", needs_prep: "true" }
    ] } })),
    github: new FakeTransport(() => ({ data: { issues: [{ id: "i1", title: "Fix CI", ci_failing: "true" }] } }))
  })]) gateway.register(t);
}, 240_000);

afterAll(async () => { await appPool?.end(); await adminPool?.end(); await epg?.stop(); }, 120_000);

describe("UA0-AUTHORITY: Sovereign owner-modus", () => {
  it("owner-tenant: klasse D utføres autonomt UTEN approval, med preflight + before/after-evidens", async () => {
    const result = await gateway.execute({
      identity: owner, tool_id: "home-assistant", action: "lock_set", parameters: lockParams, idempotency_key: "lock-1"
    });
    expect(result.ok).toBe(true);
    const audit = await adminPool.query(
      `SELECT payload FROM audit_events WHERE type='tool.executed' AND action='lock_set' ORDER BY audit_id DESC LIMIT 1`);
    const payload = audit.rows[0].payload as Record<string, unknown>;
    expect(payload["before_state"]).toEqual({ locked: true });
    expect(payload["after_state"]).toEqual({ locked: false });
    expect((payload["recovery"] as { snapshot: unknown }).snapshot).toEqual({ locked: true });
    const exec = await adminPool.query("SELECT before_state FROM tool_executions WHERE idempotency_key='lock-1'");
    expect(exec.rows[0].before_state).toEqual({ locked: true });
  });

  it("feil tenant er SCOPED: klasse D uten approval → DENY; delegat arver ikke sovereign", async () => {
    const wrongTenant = await policy.authorize({
      identity: { ...owner, tenant_id: "tenant-b" },
      toolCall: { tool_id: "home-assistant", action: "lock_set", capability_class: "D", parameters: {} }
    });
    expect(wrongTenant.reason).toBe("class_d_missing_approval");
    const delegate = await policy.authorize({
      identity: { ...owner, delegation_id: "agent-1" },
      toolCall: { tool_id: "home-assistant", action: "lock_set", capability_class: "D", parameters: {} }
    });
    expect(delegate.reason).toBe("class_d_missing_approval");
  });

  it("preflight-feil på klasse D er fail-closed", async () => {
    const failing = new FakeTransport(undefined, "ha_unreachable");
    const g2 = new ToolGateway(appPool, policy, secrets, controls);
    for (const t of homeAssistantTools(failing)) g2.register(t);
    const result = await g2.execute({ identity: owner, tool_id: "home-assistant", action: "lock_set", parameters: lockParams });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("preflight_failed");
  });

  it("owner-kontroller håndheves: freeze/revoke/pause stopper nye handlinger", async () => {
    controls.freezeConnector("home-assistant");
    let r = await gateway.execute({ identity: owner, tool_id: "home-assistant", action: "light_set",
      parameters: { site_id: "hus", room_id: "stue", on: true } });
    expect((r as { reason: string }).reason).toBe("connector_frozen");
    controls.unfreezeConnector("home-assistant");

    controls.revokeCredential("JARVIS_HA_TOKEN");
    r = await gateway.execute({ identity: owner, tool_id: "home-assistant", action: "light_set",
      parameters: { site_id: "hus", room_id: "stue", on: true } });
    expect((r as { reason: string }).reason).toBe("credential_revoked");
    controls.restoreCredential("JARVIS_HA_TOKEN");

    controls.pauseAll("test");
    r = await gateway.execute({ identity: owner, tool_id: "home-assistant", action: "light_set",
      parameters: { site_id: "hus", room_id: "stue", on: true } });
    expect((r as { reason: string }).reason).toBe("kill_switch_active");
    controls.resumeAll();
  });
});

describe("UA0-RUNRATE", () => {
  it("modellkall registrerer provider/model/tokens i cost_events", async () => {
    const mg = new ModelGateway({ pool: appPool, trace: new MemoryTraceSink(), providers: [new ScriptedAdapter()] });
    await mg.complete({ tenant_id: "tenant-a", task_id: "task-open", request: { messages: [{ role: "user", content: "hei" }] } });
    const row = await adminPool.query(
      "SELECT provider, model, input_tokens, output_tokens FROM cost_events WHERE task_id='task-open' ORDER BY cost_id DESC LIMIT 1");
    expect(row.rows[0]).toEqual({ provider: "scripted", model: "scripted-1", input_tokens: 100, output_tokens: 50 });
  });
});

describe("DAILY EXECUTIVE BRIEF", () => {
  it("samler kilder, prioriterer deterministisk, dedupliserer og beholder provenance", async () => {
    const brief = await new DailyBrief([
      tasksSource(appPool), emailSource(gateway), calendarSource(gateway),
      buildStatusSource(gateway)
    ]).generate(owner);
    const text = DailyBrief.render(brief);
    expect(brief.top_priorities.length).toBe(3);
    expect(text).toContain("TOP PRIORITIES");
    expect(text).toContain("UBESVART");           // e-post-oppfølging
    expect(text).toContain("Styremøte");           // møte m/forberedelse
    expect(text).toContain("FEILET: deploy");      // feilet jobb trenger oppmerksomhet
    expect(text).toContain("[gmail:m1");           // provenance source:ref
    expect(text).toContain("runtime-porter");      // build-status
    expect(text).toContain("Fix CI");              // github
    // dedupe: duplikat-e-posten m1 finnes nøyaktig én gang per seksjon
    expect(brief.follow_ups.filter((i) => i.ref === "m1")).toHaveLength(1);
    expect(brief.needs_attention.filter((i) => i.ref === "m1")).toHaveLength(1);
    // ingen kryss-tenant-lekkasje: tenant-b-oppgave er usynlig
    expect(text).not.toContain("B-hemmelig");
  });

  it("seen-suppression (persistent) + run-rate: gammel lavverdisak gjentas ikke; brief-rad i cost_events", async () => {
    const brief = new DailyBrief([tasksSource(appPool), emailSource(gateway)], appPool);
    const first = await brief.generate(owner);
    expect(first.fyi.some((i) => i.ref === "m2")).toBe(true); // lavverdipunkt vises første gang
    // Simuler at forrige presentasjon var i går:
    await adminPool.query(
      "UPDATE brief_seen SET last_presented = now() - interval '1 day' WHERE item_key = 'gmail:m2'");
    const second = await brief.generate(owner);
    expect(second.fyi.some((i) => i.ref === "m2")).toBe(false); // stale lavverdi undertrykkes
    expect(second.top_priorities.length).toBeGreaterThan(0);    // høyverdi består
    const cost = await adminPool.query(
      "SELECT count(*)::int AS n FROM cost_events WHERE kind = 'brief:generation' AND tenant_id = 'tenant-a'");
    expect(cost.rows[0].n).toBeGreaterThanOrEqual(2); // cost_per_daily_brief kan beregnes
  });

  it("manglende connector velter ikke briefen (graceful degradation)", async () => {
    const broken = new ToolGateway(appPool, policy, { name: "none", async get() { return null; } }, controls);
    for (const t of firstWaveTools()) broken.register(t);
    const brief = await new DailyBrief([tasksSource(appPool), emailSource(broken)]).generate(owner);
    expect(brief.source_errors.some((e) => e.source === "gmail")).toBe(true);
    expect(DailyBrief.render(brief)).toContain("Connector utilgjengelig: gmail");
    expect(brief.top_priorities.length).toBeGreaterThan(0); // tasks-kilden leverer fortsatt
  });
});

describe("BO-05: reboot-durabel scheduler med multi-instans-laas", () => {
  it("to instanser: nøyaktig én vinner dagens claim; restart gir aldri duplikat", async () => {
    const { DailyScheduler } = await import("../src/scheduler.ts");
    const a = new DailyScheduler(adminPool, "test-brief", 0); // hour 0 => alltid etter planlagt tid
    const b = new DailyScheduler(adminPool, "test-brief", 0);
    const [ra, rb] = await Promise.all([a.claimToday(), b.claimToday()]);
    expect([ra, rb].filter(Boolean)).toHaveLength(1); // multi-instans: én vinner
    // "Restart": ny instans samme dag => claim avvises (persistent tilstand i DB)
    const restarted = new DailyScheduler(adminPool, "test-brief", 0);
    expect(await restarted.claimToday()).toBe(false);
    await (ra ? a : b).markCompleted();
    const state = await adminPool.query("SELECT completed_at FROM scheduler_state WHERE job_name='test-brief'");
    expect(state.rows[0].completed_at).not.toBeNull();
    // Før planlagt time claimes ikke (hour 25 kan aldri nås)
    const early = new DailyScheduler(adminPool, "test-brief-2", 25);
    expect(await early.claimToday()).toBe(false);
  });
});
