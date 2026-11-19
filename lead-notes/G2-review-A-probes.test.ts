// REVIEWER A (WP-G2, D-464) - REPRO-PAKKE. Plasseres midlertidig som `modules/tool-gateway/test/zz-g2-review-a.test.ts` og kjøres som `postgres`:
//   su postgres -s /bin/bash -c 'export HOME=/tmp/pg-home npm_config_manage_package_manager_versions=false PATH=/opt/node22/bin:$PATH; cd <worktree> && pnpm exec vitest run modules/tool-gateway/test/zz-g2-review-a.test.ts --maxWorkers=2'
// Hver test uttrykker ÆNKET atferd. «EXPECT-RED» = rød på HEAD d91d2197 (bekrefter funnet); «CONTROL» = grønn (bekrefter at noe holder). Ikke en del av grenen (slett etter bruk).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import {
  CAR_CRITICAL_OPS, CarTransport, HOME_CRITICAL_OPS, HOME_CRITICAL_READ_ACTION, HomeAssistantCriticalTransport, PersonalActionJournal, ToolGateway, carCriticalToolDefinitions, executePersonalAction,
  homeCriticalToolDefinitions, parseCarTargets, parseHomeTargets, personalActionIndex, type CarAdapter, type CarState, type ClassDNotification, type SecretProvider
} from "../src/index.ts";
import { FakeCarAdapter } from "./support/fake-car-adapter.ts";
import { G2_OTHER_TENANT, G2_TENANT, g2Owner, personalGateway, startPersonalDb, type PersonalDb } from "./support/personal-db-harness.ts";

/** En skriptbar HA: `onService` bestemmer hva GET-ene viser ETTER en kommando (kø av tilstander; siste tilstand blir stående). */
class ScriptedHa {
  readonly token = "scripted-ha-token";
  readonly states = new Map<string, { state: string; attributes?: Record<string, unknown> }>();
  readonly queues = new Map<string, string[]>();
  readonly posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  readonly gets: string[] = [];
  readonly spoof = new Map<string, string>();
  onService: (key: string, body: Record<string, unknown>, ha: ScriptedHa) => void = () => undefined;
  baseUrl = "";
  private server!: Server;
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const send = (status: number, value: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
        if (req.headers["authorization"] !== `Bearer ${this.token}`) return send(401, {});
        const m = /^\/api\/states\/([^/]+)$/.exec(url.pathname);
        if (req.method === "GET" && m) {
          const id = decodeURIComponent(m[1]!);
          this.gets.push(id);
          const q = this.queues.get(id);
          if (q && q.length > 0) { const next = q.shift()!; const cur = this.states.get(id); if (cur) cur.state = next; }
          const cur = this.states.get(id);
          return cur ? send(200, { entity_id: this.spoof.get(id) ?? id, state: cur.state, attributes: cur.attributes ?? {} }) : send(404, {});
        }
        const s = /^\/api\/services\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (req.method === "POST" && s) {
          const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
          this.posts.push({ path: url.pathname, body });
          this.onService(`${s[1]}/${s[2]}`, body, this);
          return send(200, []);
        }
        send(404, {});
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> { await new Promise<void>((r) => this.server.close(() => r())); }
  reset(): void { this.spoof.clear(); this.states.clear(); this.queues.clear(); this.posts.length = 0; this.gets.length = 0; this.onService = () => undefined; }
}

let db: PersonalDb;
let ha: ScriptedHa;
beforeAll(async () => { db = await startPersonalDb("jarvis_test_g2_review_a"); ha = new ScriptedHa(); await ha.start(); }, 240_000);
afterAll(async () => { await ha?.stop(); await db?.stop(); }, 120_000);
beforeEach(() => ha.reset());

const owner: IdentityContext = { ...g2Owner, memory_space_id: "personal" };
let seq = 0;
const key = (p: string): string => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;
const secrets = (): SecretProvider => ({ name: "fake", get: async (ref) => (ref === "JARVIS_HA_TOKEN" ? ha.token : ref === "JARVIS_PERSONAL_CAR_CREDENTIAL" ? "car-cred" : null) });

function homeHarness(targets = "lock.front_door,cover.garage,alarm_control_panel.home,valve.main_water,switch.hot_water,script.leaving,scene.good_night,climate.living") {
  const h = personalGateway(db.appPool, secrets());
  let t = 0;
  const transport = new HomeAssistantCriticalTransport({ baseUrl: async () => ha.baseUrl, settleMs: 5_000, pollMs: 500, now: () => t, sleep: async (ms) => { t += ms; } });
  for (const d of homeCriticalToolDefinitions(transport, { targets: parseHomeTargets(targets), settleMs: 5_000, pollMs: 500 })) h.gateway.register(d);
  const journal = new PersonalActionJournal(db.appPool);
  const index = personalActionIndex(HOME_CRITICAL_OPS.map((op) => ({ domain: "home" as const, toolId: "home-assistant", op })));
  return { ...h, journal, executor: { pool: db.appPool, gateway: h.gateway, journal, index } };
}
const run = (h: ReturnType<typeof homeHarness>, action: string, parameters: Record<string, JsonValue>, k?: string, identity: IdentityContext = owner) =>
  h.gateway.execute({ identity, tool_id: "home-assistant", action, parameters, ...(k ? { idempotency_key: k } : {}) });

// ---------------------------------------------------------------------------------------------------------------------
describe("CONTROL A1: vei-inn-matrisen - ingen identitet utenom den enhetssignerte eier-økten når noen av de 12 mutasjonene", () => {
  const homeParams: Record<string, Record<string, JsonValue>> = {
    critical_lock: { entity: "lock.front_door", locked: false }, critical_alarm: { entity: "alarm_control_panel.home", armed: false }, critical_cover: { entity: "cover.garage", target: "open" },
    critical_valve: { entity: "valve.main_water", target: "open" }, critical_switch: { entity: "switch.hot_water", on: true }, critical_scene: { entity: "scene.good_night", expected_last_activated: null },
    critical_script: { entity: "script.leaving", expected_last_triggered: null }, critical_climate_mode: { entity: "climate.living", hvac_mode: "off" }
  };
  it("alle 8 HA-handlinger + lesing: svak økt, tale, telegram, watch, system, delegat, fremmed tenant -> ingen HA-forespørsel i det hele tatt", async () => {
    const h = homeHarness();
    for (const e of ["lock.front_door", "alarm_control_panel.home", "cover.garage", "valve.main_water", "switch.hot_water", "script.leaving", "scene.good_night", "climate.living"]) ha.states.set(e, { state: "unknown" });
    const variants: Array<[string, IdentityContext]> = [
      ["active/api (sveipens/arbeiderens identitet)", { ...owner, auth_strength: "active" }], ["passive", { ...owner, auth_strength: "passive" }],
      ["signed/voice", { ...owner, channel: "voice" }], ["signed/telegram", { ...owner, channel: "telegram" }], ["signed/watch", { ...owner, channel: "watch" }], ["signed/system", { ...owner, channel: "system" }],
      ["delegat (signed/api)", { ...owner, person_id: "person-g2-p-delegate" }], ["fremmed tenant", { ...owner, tenant_id: G2_OTHER_TENANT, person_id: "person-g2-p-other" }],
      ["delegation_id satt (eier m/ delegasjon)", { ...owner, delegation_id: "deleg-x" } as IdentityContext]
    ];
    for (const [name, identity] of variants) {
      for (const [action, params] of Object.entries(homeParams)) {
        const r = await run(h, action, params, key("a1"), identity);
        expect(r.ok, `${name} ${action}`).toBe(false);
      }
      expect((await run(h, HOME_CRITICAL_READ_ACTION, { entity: "lock.front_door" }, undefined, identity)).ok, `${name} read`).toBe(name.startsWith("active") || name.startsWith("passive") || name.includes("voice") || name.includes("telegram") || name.includes("watch") || name.includes("system"));
    }
    expect(ha.posts).toHaveLength(0);
  });
  it("de 4 bil-handlingene: samme matrise -> adapteren når aldri", async () => {
    const h = personalGateway(db.appPool, secrets());
    const adapter = new FakeCarAdapter();
    adapter.set("bil", { lock: "locked", climate: "off", charging: "stopped" });
    let clockA = 0;
    for (const d of carCriticalToolDefinitions(new CarTransport({ adapter, settleMs: 5_000, pollMs: 1_000, now: () => clockA, sleep: async (ms) => { clockA += ms; } }), { targets: parseCarTargets("bil"), settleMs: 5_000, pollMs: 1_000 })) h.gateway.register(d);
    const params: Record<string, Record<string, JsonValue>> = { lock: { vehicle_id: "bil" }, unlock: { vehicle_id: "bil" }, climate_set: { vehicle_id: "bil", on: true }, charge_set: { vehicle_id: "bil", charging: true } };
    for (const identity of [{ ...owner, auth_strength: "active" }, { ...owner, channel: "voice" }, { ...owner, channel: "telegram" }, { ...owner, channel: "system" }, { ...owner, person_id: "person-g2-p-delegate" }] as IdentityContext[]) {
      for (const [action, p] of Object.entries(params)) expect((await h.gateway.execute({ identity, tool_id: "car", action, parameters: p, idempotency_key: key("a1c") })).ok, `${identity.channel}/${identity.auth_strength} ${action}`).toBe(false);
    }
    expect(adapter.commandCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("EXPECT-RED B1: sluttilstand som ikke er «overgang» men heller ikke ønsket - om HA viser GAMMEL tilstand en stund (typisk MQTT/Zigbee-lås/port som venter på enhetsrapport)", () => {
  it("lås: HA viser `unlocked` i tre lesinger ETTER lock-kommandoen og så `locked` -> ønsket: SUCCESS; faktisk: transporten gir opp ved første ikke-transitive tilstand (MISMATCH) selv om fristen er 5 s", async () => {
    const h = homeHarness();
    ha.states.set("lock.front_door", { state: "unlocked" });
    ha.onService = (k, body, s) => { if (k === "lock/lock") s.queues.set(String(body["entity_id"]), ["unlocked", "unlocked", "unlocked", "locked"]); };
    const result = await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("b1"));
    // eslint-disable-next-line no-console
    console.log("B1 resultat", JSON.stringify(result), "GET-er:", ha.gets.length);
    expect(result, "forventet at transporten venter på sluttilstanden innen fristen").toMatchObject({ ok: true });
  });
  it("CONTROL: samme lås som viser `locking` først (overgang) -> SUCCESS", async () => {
    const h = homeHarness();
    ha.states.set("lock.front_door", { state: "unlocked" });
    ha.onService = (k, body, s) => { if (k === "lock/lock") s.queues.set(String(body["entity_id"]), ["locking", "locking", "locked"]); };
    expect(await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("b1c"))).toMatchObject({ ok: true });
  });
  it("CONTROL: `unavailable` / ukjent ord etter kommandoen er aldri SUCCESS", async () => {
    const h = homeHarness();
    for (const final of ["unavailable", "unknown", "garbage-state"]) {
      ha.states.set("lock.front_door", { state: "unlocked" });
      ha.onService = (k, body, s) => { if (k === "lock/lock") s.queues.set(String(body["entity_id"]), [final]); };
      const r = await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("b1u"));
      expect(r, final).toEqual({ ok: false, reason: "postcondition_mismatch" });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("OBSERVASJON B2: to samtidige, motstridende kommandoer (ulike nøkler) mot SAMME lås", () => {
  it("begge når HA (ingen serialisering per mål) - sluttilstanden er den som kom sist, hver rapporterer sin egen lesing", async () => {
    const h = homeHarness();
    ha.states.set("lock.front_door", { state: "unlocked" });
    ha.onService = (k, body, s) => { s.states.get(String(body["entity_id"]))!.state = k === "lock/lock" ? "locked" : "unlocked"; };
    const [a, b] = await Promise.all([run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("b2a")), run(h, "critical_lock", { entity: "lock.front_door", locked: false }, key("b2b"))]);
    // eslint-disable-next-line no-console
    console.log("B2 resultat", JSON.stringify({ a, b, posts: ha.posts.map((p) => p.path), final: ha.states.get("lock.front_door")?.state }));
    expect(ha.posts.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("OBSERVASJON D2: dobbeltsendt forespørsel (samme nøkkel, samtidig) gjennom eksekutoren", () => {
  it("ett HA-kall; ingen kastet feil hos taperen; journalraden ender i en konsistent status", async () => {
    const h = homeHarness();
    ha.states.set("lock.front_door", { state: "unlocked" });
    ha.onService = (k, body, s) => { s.queues.set(String(body["entity_id"]), ["locking", "locked"]); };
    const k = key("d2");
    const settled = await Promise.allSettled([
      executePersonalAction(h.executor, owner, { domain: "home", action: "critical_lock", parameters: { entity: "lock.front_door", locked: true }, idempotency_key: k }),
      executePersonalAction(h.executor, owner, { domain: "home", action: "critical_lock", parameters: { entity: "lock.front_door", locked: true }, idempotency_key: k })
    ]);
    // eslint-disable-next-line no-console
    console.log("D2 utfall", JSON.stringify(settled.map((s) => (s.status === "fulfilled" ? { outcome: s.value.outcome, replayed: s.value.replayed, status: s.value.action.status, reason: s.value.reason } : { rejected: String(s.reason).slice(0, 120) }))));
    const row = await h.journal.findByKey(G2_TENANT, "personal", k);
    // eslint-disable-next-line no-console
    console.log("D2 rad", JSON.stringify({ status: row?.status, failure: row?.failure_code }));
    expect(ha.posts).toHaveLength(1);
    expect(settled.every((s) => s.status === "fulfilled"), "ingen av de to kall skal kaste").toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("OBSERVASJON B4: varsleren feiler ETTER handlingen (Telegram nede mens token+chat-id finnes)", () => {
  it("handlingen står, resultatet er ok men `notified:false`; journalen har ingen sporbar varsel-status", async () => {
    // bygg en gateway med en varsler som kaster
    const { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } = await import("@jarvis/policy");
    const ks = new KillSwitch(); const controls = new OwnerControls(ks);
    const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: ks, controls, authority: { owner_person_id: g2Owner.person_id, owner_tenants: [G2_TENANT] } });
    const notes: ClassDNotification[] = [];
    const gateway = new ToolGateway(db.appPool, policy, secrets(), controls, undefined, {
      classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (n) => { notes.push(n); throw new Error("telegram_down"); } } },
      credentialBinding: { owner_person_id: g2Owner.person_id, owner_tenants: [G2_TENANT], internalRefs: new Set() }
    });
    let t = 0;
    const transport = new HomeAssistantCriticalTransport({ baseUrl: async () => ha.baseUrl, settleMs: 5_000, pollMs: 500, now: () => t, sleep: async (ms) => { t += ms; } });
    for (const d of homeCriticalToolDefinitions(transport, { targets: parseHomeTargets("lock.front_door"), settleMs: 5_000, pollMs: 500 })) gateway.register(d);
    const journal = new PersonalActionJournal(db.appPool);
    const index = personalActionIndex(HOME_CRITICAL_OPS.map((op) => ({ domain: "home" as const, toolId: "home-assistant", op })));
    ha.states.set("lock.front_door", { state: "locked" });
    ha.onService = (k, body, s) => { s.states.get(String(body["entity_id"]))!.state = "unlocked"; };
    const k = key("b4");
    const res = await executePersonalAction({ pool: db.appPool, gateway, journal, index }, owner, { domain: "home", action: "critical_lock", parameters: { entity: "lock.front_door", locked: false }, idempotency_key: k });
    const audit = (await db.adminPool.query("SELECT type FROM audit_events WHERE tool_id = 'home-assistant' AND type = 'tool.class_d_notification_failed'")).rows;
    // eslint-disable-next-line no-console
    console.log("B4", JSON.stringify({ outcome: res.outcome, status: res.action.status, keys: Object.keys(res), journalCols: Object.keys(res.action).filter((c) => /notif|alert/i.test(c)), audit: audit.length }));
    expect(res.outcome).toBe("SUCCESS");
    expect(notes).toHaveLength(1);
    expect(audit.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("EXPECT-RED L1: utstyrets tilstandsord er ubetrodd tekst og når eier-varsel/ledger/audit (påstand i koden: «kun enumererte tilstander»)", () => {
  it("en lås som rapporterer et vilkårlig tilstandsord får det ordet (<=64 tegn) inn i varselsammendraget", async () => {
    const h = homeHarness();
    ha.states.set("lock.front_door", { state: "SYSTEM ALERT: ring 555-1234 now or lose access" });
    ha.onService = (k, body, s) => { s.states.get(String(body["entity_id"]))!.state = "locked"; };
    const r = await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("l1"));
    expect(r.ok).toBe(true);
    const summary = h.notifications.at(-1)?.summary ?? "";
    // eslint-disable-next-line no-console
    console.log("L1 sammendrag:", summary);
    expect(summary, "sammendraget skal kun inneholde enumererte tilstandsord").not.toMatch(/SYSTEM ALERT/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("EXPECT-RED J1: journalens proveniens (task_id/session_id/trace_id/completed_at) kan endres etter at raden er terminal", () => {
  it("UPDATE av task_id/session_id/trace_id på en `applied`-rad avvises av databasevakten", async () => {
    const h = homeHarness();
    ha.states.set("lock.front_door", { state: "locked" });
    ha.onService = (k, body, s) => { s.states.get(String(body["entity_id"]))!.state = "unlocked"; };
    const r = await executePersonalAction(h.executor, owner, { domain: "home", action: "critical_lock", parameters: { entity: "lock.front_door", locked: false }, idempotency_key: key("j1"), task_id: "task-orig", trace_id: "trace-orig" });
    expect(r.action.status).toBe("applied");
    await expect(db.adminPool.query("UPDATE personal_action_journal SET task_id = 'task-FORGED', session_id = 'sess-FORGED', trace_id = 'trace-FORGED' WHERE action_id = $1", [r.action.action_id])).rejects.toThrow();
  });
  it("CONTROL: appens DB-rolle kan SLETTE journalrader (DELETE er gitt for erasure; ingen trigger) - dokumentert, ikke et brudd på det som er påstått", async () => {
    const h = homeHarness();
    ha.states.set("lock.front_door", { state: "locked" });
    ha.onService = (k, body, s) => { s.states.get(String(body["entity_id"]))!.state = "unlocked"; };
    const k = key("j1d");
    await executePersonalAction(h.executor, owner, { domain: "home", action: "critical_lock", parameters: { entity: "lock.front_door", locked: false }, idempotency_key: k });
    const client = await db.appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', 'personal', true)", [G2_TENANT]);
      const del = await client.query("DELETE FROM personal_action_journal WHERE idempotency_key = $1", [k]);
      await client.query("ROLLBACK");
      expect(del.rowCount).toBe(1);
    } finally { client.release(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("EXPECT-RED C1/C2: bil - readback bygget på en observasjon som er ELDRE enn kommandoen, og en adapter som svarer for FEIL kjøretøy", () => {
  function carHarness(adapter: CarAdapter, wallClock?: () => number) {
    const h = personalGateway(db.appPool, secrets());
    let clock = 0;
    const transport = new CarTransport({ adapter, settleMs: 5_000, pollMs: 1_000, now: () => clock, sleep: async (ms) => { clock += ms; }, ...(wallClock ? { wallClock } : {}) });
    for (const d of carCriticalToolDefinitions(transport, { targets: parseCarTargets("bil,elbil-2"), settleMs: 5_000, pollMs: 1_000 })) h.gateway.register(d);
    return h;
  }
  it("C1: bufret observasjon (20 min gammel, `fresh:true` fordi alderstaket er 30 min) som viser ønsket låsetilstand gir SUCCESS selv om kommandoen aldri ble utført", async () => {
    const adapter = new FakeCarAdapter();
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    adapter.set("bil", { lock: "locked", climate: "off", charging: "stopped", observed_at: old, mode: "ineffective" });
    const h = carHarness(adapter);
    const r = await h.gateway.execute({ identity: owner, tool_id: "car", action: "lock", parameters: { vehicle_id: "bil" }, idempotency_key: key("c1") });
    // ønsket: en observasjon eldre enn kommandoen kan aldri bekrefte den
    const ledger = (await db.adminPool.query("SELECT after_state FROM tool_executions ORDER BY executed_at DESC LIMIT 1")).rows[0] as { after_state: { observed_at: string } };
    // eslint-disable-next-line no-console
    console.log("C1", JSON.stringify({ r, observed_at_in_after_state: ledger.after_state.observed_at, command_calls: adapter.commandCalls().length }));
    expect(r.ok, "readback bygget på en 20 min gammel observasjon er ikke en bekreftelse").toBe(false);
  });
  it("C2: adapteren returnerer et ANNET kjøretøys tilstand for det spurte aliaset -> transporten skal avvise (som HA-transporten gjør for entity_id), ikke verifisere mot feil bil", async () => {
    const lying: CarAdapter = {
      name: "lying", capabilities: [],
      readState: async (): Promise<CarState> => ({ vehicle_id: "elbil-2", reachable: true, lock: "unlocked", climate: "off", charging: "stopped", charge_percent: 50, fresh: true, observed_at: new Date().toISOString() }),
      command: async () => ({ accepted: true })
    };
    const h = carHarness(lying);
    const r = await h.gateway.execute({ identity: owner, tool_id: "car", action: "unlock", parameters: { vehicle_id: "bil" }, idempotency_key: key("c2") });
    expect(r.ok, "unlock av «bil» ble verifisert mot elbil-2 sin tilstand").toBe(false);
  });
  it("CONTROL: contract-kitets `stale_after_command` (fresh:false) verifiserer aldri", async () => {
    const adapter = new FakeCarAdapter();
    adapter.set("bil", { lock: "locked", climate: "off", charging: "stopped", mode: "stale_after_command", applyAfterReads: 0 });
    const h = carHarness(adapter);
    const r = await h.gateway.execute({ identity: owner, tool_id: "car", action: "unlock", parameters: { vehicle_id: "bil" }, idempotency_key: key("c3") });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("CONTROL F1/F2: HA-svar som ikke er det vi spurte om, og token/vert i feilkoder", () => {
  it("HA svarer med en ANNEN entitets id enn den vi spurte om: feil (state_malformed), aldri SUCCESS, ingen kommando sendt", async () => {
    const h = homeHarness();
    ha.states.set("lock.front_door", { state: "unlocked" });
    ha.spoof.set("lock.front_door", "lock.other");
    const r = await run(h, "critical_lock", { entity: "lock.front_door", locked: true }, key("f1"));
    expect(r).toEqual({ ok: false, reason: "preflight_failed:home_assistant_state_malformed" });
    expect(ha.posts).toHaveLength(0);
  });
  it("feilkoder fra transporten inneholder verken token eller vert", async () => {
    const h = personalGateway(db.appPool, secrets());
    const transport = new HomeAssistantCriticalTransport({ baseUrl: async () => "http://127.0.0.1:1", settleMs: 5_000, pollMs: 500 });
    for (const d of homeCriticalToolDefinitions(transport, { targets: parseHomeTargets("lock.front_door"), settleMs: 5_000, pollMs: 500 })) h.gateway.register(d);
    const r = await h.gateway.execute({ identity: owner, tool_id: "home-assistant", action: "critical_lock", parameters: { entity: "lock.front_door", locked: true }, idempotency_key: key("f2") });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/scripted-ha-token|127\.0\.0\.1/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("EXPECT-RED B5: alarm med utgangsforsinkelse (30 s) og STANDARD ventetid (20 s)", () => {
  it("armering som viser `arming` i 30 lesinger og så `armed_away`: ønsket SUCCESS (eller ventende), faktisk MISMATCH + journal `outcome_unknown` som aldri avstemmes", async () => {
    const h = personalGateway(db.appPool, secrets());
    let t = 0;
    const transport = new HomeAssistantCriticalTransport({ baseUrl: async () => ha.baseUrl, settleMs: 20_000, pollMs: 1_000, now: () => t, sleep: async (ms) => { t += ms; } });
    for (const d of homeCriticalToolDefinitions(transport, { targets: parseHomeTargets("alarm_control_panel.home"), settleMs: 20_000, pollMs: 1_000 })) h.gateway.register(d);
    const journal = new PersonalActionJournal(db.appPool);
    const index = personalActionIndex(HOME_CRITICAL_OPS.map((op) => ({ domain: "home" as const, toolId: "home-assistant", op })));
    ha.states.set("alarm_control_panel.home", { state: "disarmed" });
    ha.onService = (k, body, s) => { if (k === "alarm_control_panel/alarm_arm_away") s.queues.set(String(body["entity_id"]), [...Array(30).fill("arming"), "armed_away"]); };
    const k = key("b5");
    const res = await executePersonalAction({ pool: db.appPool, gateway: h.gateway, journal, index }, owner, { domain: "home", action: "critical_alarm", parameters: { entity: "alarm_control_panel.home", armed: true }, idempotency_key: k });
    // eslint-disable-next-line no-console
    console.log("B5", JSON.stringify({ outcome: res.outcome, status: res.action.status, reason: res.reason, after: res.action.after_state }));
    // ønsket: en legitim utgangsforsinkelse skal ikke ende som varig `outcome_unknown`
    expect(res.outcome).toBe("SUCCESS");
    // og ingen avstemming finnes: replay gir fortsatt MISMATCH/UNKNOWN, aldri en oppdatering til applied
    const again = await executePersonalAction({ pool: db.appPool, gateway: h.gateway, journal, index }, owner, { domain: "home", action: "critical_alarm", parameters: { entity: "alarm_control_panel.home", armed: true }, idempotency_key: k });
    // eslint-disable-next-line no-console
    console.log("B5 replay", JSON.stringify({ outcome: again.outcome, status: again.action.status }));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("CONTROL A2: mål-injeksjon - store/små bokstaver, Unicode (Kelvin-tegn), whitespace, sti-/spørringstegn, domene-bytte, tomme mål", () => {
  it("ingen variant når HA, verken som mutasjon eller lesing (skjema FØR allowlist; transporten sjekker på nytt)", async () => {
    const h = homeHarness("lock.front_door,switch.hot_water");
    ha.states.set("lock.front_door", { state: "unlocked" });
    ha.states.set("switch.hot_water", { state: "off" });
    const kelvin = String.fromCodePoint(0x212a);
    const dotlessI = String.fromCodePoint(0x131);
    const bad = [
      "LOCK.front_door", "Lock.Front_Door", "lock.FRONT_DOOR", "lock.front_door\n", " lock.front_door", "lock.front_door ", "lock.front_door%0a", "lock.front_door/../x", "lock.front_door?x=1", "lock.front_door#x",
      `loc${kelvin}.front_door`, `lock.front_door${kelvin}`, `lock.front${dotlessI}_door`, "lock.front\u0000door", "switch.front_door", "lock.hot_water", "lock.", "lock", "", "lock.front_door,switch.hot_water", "lock.*", "*", "lock.front_door\r\nX-Injected: 1"
    ];
    for (const entity of bad) {
      const m = await run(h, "critical_lock", { entity, locked: true }, key("a2"));
      expect(m.ok, `mutasjon ${JSON.stringify(entity)}`).toBe(false);
      const r = await run(h, HOME_CRITICAL_READ_ACTION, { entity });
      expect(r.ok, `lesing ${JSON.stringify(entity)}`).toBe(false);
    }
    for (const v of [null, 5, true, ["lock.front_door"], { entity: "lock.front_door" }] as JsonValue[]) {
      expect((await run(h, "critical_lock", { entity: v, locked: true }, key("a2t"))).ok).toBe(false);
      expect((await run(h, "critical_lock", { locked: true }, key("a2m"))).ok).toBe(false);
    }
    expect(ha.posts).toHaveLength(0);
    expect(ha.gets).toHaveLength(0);
  });
  it("bil: samme for kjøretøy-alias", async () => {
    const adapter = new FakeCarAdapter();
    adapter.set("bil", { lock: "locked", climate: "off", charging: "stopped" });
    const h = personalGateway(db.appPool, secrets());
    let clockC = 0;
    for (const d of carCriticalToolDefinitions(new CarTransport({ adapter, settleMs: 5_000, pollMs: 1_000, now: () => clockC, sleep: async (ms) => { clockC += ms; } }), { targets: parseCarTargets("bil"), settleMs: 5_000, pollMs: 1_000 })) h.gateway.register(d);
    const kelvin = String.fromCodePoint(0x212a);
    for (const vehicle_id of ["BIL", "Bil", "bil\n", " bil", "bil ", `bi${kelvin}`, "bil/../x", "elbil-1", "b", "", "bil,elbil-1", "*", "bil%00"]) {
      expect((await h.gateway.execute({ identity: owner, tool_id: "car", action: "unlock", parameters: { vehicle_id }, idempotency_key: key("a2c") })).ok, JSON.stringify(vehicle_id)).toBe(false);
      expect((await h.gateway.execute({ identity: owner, tool_id: "car", action: "read_vehicle_state", parameters: { vehicle_id } })).ok, `lesing ${JSON.stringify(vehicle_id)}`).toBe(false);
    }
    expect(adapter.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("CONTROL F3: redirect fra HA/proxy", () => {
  it("POST som svares med 307 følges ALDRI; utfallet er ukjent (`home_service_transport_redirect`) og replay sender ingenting", async () => {
    const h = homeHarness();
    ha.states.set("lock.front_door", { state: "unlocked" });
    // egen server som svarer 307 på tjenestekall (GET som vanlig)
    const redirecting = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ entity_id: "lock.front_door", state: "unlocked", attributes: {} })); return; }
      redirectHits.push(url.pathname);
      res.writeHead(307, { location: "/api/services/lock/unlock" }); res.end();
    });
    const redirectHits: string[] = [];
    await new Promise<void>((r) => redirecting.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`;
    const hh = personalGateway(db.appPool, secrets());
    let t = 0;
    const transport = new HomeAssistantCriticalTransport({ baseUrl: async () => base, settleMs: 5_000, pollMs: 500, now: () => t, sleep: async (ms) => { t += ms; } });
    for (const d of homeCriticalToolDefinitions(transport, { targets: parseHomeTargets("lock.front_door"), settleMs: 5_000, pollMs: 500 })) hh.gateway.register(d);
    const k = key("f3");
    const first = await hh.gateway.execute({ identity: owner, tool_id: "home-assistant", action: "critical_lock", parameters: { entity: "lock.front_door", locked: true }, idempotency_key: k });
    const second = await hh.gateway.execute({ identity: owner, tool_id: "home-assistant", action: "critical_lock", parameters: { entity: "lock.front_door", locked: true }, idempotency_key: k });
    await new Promise<void>((r) => redirecting.close(() => r()));
    void h;
    // eslint-disable-next-line no-console
    console.log("F3", JSON.stringify({ first, second, redirectHits }));
    expect(first).toEqual({ ok: false, reason: "tool_failed:outcome_unknown:home_service_transport_redirect" });
    expect(redirectHits).toEqual(["/api/services/lock/lock"]);
  });
});
