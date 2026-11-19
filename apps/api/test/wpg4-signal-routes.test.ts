import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { FeedbackService, SignalLogService, SimulationService } from "@jarvis/situations";
import { actorOwner, OTHER, OWNER, startG4Db, TENANT_A, TENANT_B, type G4Db } from "../../../modules/situations/test/support/wpg4-db.ts";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-G4 fiks-runde (D-466, B-MEDIUM-5): `/situations/signals/*` over HTTP mot en ekte Postgres (app-rolle, FORCE RLS): dormant (404), grant/eier/step-up-rekkefølgen, lukket validering, typet bekreftelse for sletting, tenant-isolasjon,
 * tilbakemeldingsrutene bak eget flagg, og at revisjonsraden skrives i SAMME transaksjon som endringen (uten filterinnhold). Uten disse rutene kunne eieren ikke nå `situations.subscribe` i drift (D-41).
 */
let db: G4Db;
let url = "";
let urlDormant = "";
let urlNoFeedback = "";
const closers: Array<() => Promise<void>> = [];

type Grant = { person_id: string; tenant_id: string; channel: string; auth_strength: string; session_id: string; memory_space: string; device_id: string };
const grants = new Map<string, Grant>();
const grant = (over: Partial<Grant> = {}): Grant => ({ person_id: OWNER, tenant_id: TENANT_A, channel: "web", auth_strength: "signed", session_id: "s-owner", memory_space: "home", device_id: "web-owner", ...over });
const OWNER_GATE = (identity: IdentityContext): boolean => identity.person_id === OWNER && identity.delegation_id === undefined;

function makeDeps(mode: "full" | "no_feedback" | "dormant"): ApiDeps {
  const base = {
    grants: { verify: async (token: string) => (grants.has(token) ? { ok: true, grant: grants.get(token) } : { ok: false, reason: "grant_invalid" }) },
    identity: { resolveIdentity: async (i: Record<string, string>) => ({ ok: true, identity: { ...i, memory_space_id: i["memory_space"] } }) },
    owner: { tenant_id: TENANT_A, person_id: OWNER },
    ownerGate: OWNER_GATE
  };
  if (mode === "dormant") return base as unknown as ApiDeps;
  return {
    ...base,
    situationSignals: {
      registry: db.registry, engine: db.engine, logs: new SignalLogService(db.appPool), simulation: new SimulationService(db.appPool),
      runner: { status: () => ({ running: false, tick: 7, last: null }) },
      ...(mode === "full" ? { feedback: new FeedbackService(db.appPool, { owner_person_id: OWNER }, true) } : {})
    }
  } as unknown as ApiDeps;
}

async function listen(deps: ApiDeps): Promise<string> {
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  db = await startG4Db("g4routes");
  grants.set("owner-signed", grant());
  grants.set("owner-active", grant({ auth_strength: "active", session_id: "s-active" }));
  grants.set("owner-voice", grant({ channel: "voice", session_id: "s-voice" }));
  grants.set("other-signed", grant({ person_id: OTHER, session_id: "s-other", device_id: "web-other" }));
  grants.set("owner-health", grant({ memory_space: "health", session_id: "s-health" }));
  grants.set("owner-b", grant({ tenant_id: TENANT_B, session_id: "s-b" }));
  url = await listen(makeDeps("full"));
  urlNoFeedback = await listen(makeDeps("no_feedback"));
  urlDormant = await listen(makeDeps("dormant"));
}, 240_000);
afterAll(async () => {
  for (const c of closers) await c();
  await db?.stop();
}, 120_000);
/** `audit_events` er append-only (DELETE forbudt): hver test leser kun rader skrevet ETTER testens start. */
let auditBaseline = 0;
beforeEach(async () => {
  await db.reset();
  auditBaseline = Number((await db.adminPool.query(`SELECT coalesce(max(audit_id), 0) AS id FROM audit_events`)).rows[0].id);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- testens svar-JSON er bevisst løst typet
type Json = Record<string, any>;
const post = (base: string, path: string, body: unknown): Promise<Response> => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const call = async (path: string, token: string, body: Record<string, unknown> = {}, base = url): Promise<{ status: number; body: Json }> => {
  const res = await post(base, path, { grant_token: token, ...body });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
};
const DOOR = { source: "home_assistant", event_type: "door_open_too_long", filter: { entities: [{ entity_id: "binary_sensor.inngang", role: "door" }] } };
const auditTypes = async () => (await db.adminPool.query(`SELECT type, person_id, session_id, payload FROM audit_events WHERE tenant_id = $1 AND type LIKE 'situation.%' AND audit_id > $2 ORDER BY audit_id`, [TENANT_A, auditBaseline])).rows as Array<{ type: string; person_id: string; session_id: string | null; payload: Json }>;

const READ_ROUTES: Array<[string, Record<string, unknown>]> = [
  ["/situations/signals/subscriptions/list", {}], ["/situations/signals/status", {}], ["/situations/signals/log", {}], ["/situations/signals/assessments", { situation_id: "sit-x" }], ["/situations/signals/simulate", { situation_id: "sit-x" }], ["/situations/signals/rule-tuning", {}]
];
const WRITE_ROUTES: Array<[string, Record<string, unknown>]> = [
  ["/situations/signals/subscriptions/subscribe", DOOR], ["/situations/signals/subscriptions/set-enabled", { subscription_id: "sub-x", enabled: false }],
  ["/situations/signals/subscriptions/remove", { subscription_id: "sub-x", confirm: true, confirm_subscription_id: "sub-x" }], ["/situations/signals/quiet-bypass", { enabled: true }],
  ["/situations/signals/feedback", { situation_id: "sit-x", verdict: "noise" }], ["/situations/signals/rule-tuning/reset", { rule_key: "home_assistant:door_open_too_long" }]
];

describe("dormant: uten deps.situationSignals finnes ingen rute (identisk med main)", () => {
  it("alle ruter gir 404 selv med gyldig eier-grant; med deps gir feil metode/ukjent sti også 404; tilbakemeldingsrutene finnes ikke uten eget flagg", async () => {
    for (const [path, body] of [...READ_ROUTES, ...WRITE_ROUTES]) expect((await call(path, "owner-signed", body, urlDormant)).status, path).toBe(404);
    expect((await fetch(`${url}/situations/signals/status`)).status).toBe(404); // GET
    expect((await post(url, "/situations/signals/unknown", { grant_token: "owner-signed" })).status).toBe(404);
    expect((await post(url, "/situations/signals/status/extra", { grant_token: "owner-signed" })).status).toBe(404);
    for (const [path, body] of [["/situations/signals/rule-tuning", {}], ["/situations/signals/feedback", { situation_id: "s", verdict: "noise" }], ["/situations/signals/rule-tuning/reset", { rule_key: "a:b_c" }]] as Array<[string, Record<string, unknown>]>) {
      expect((await call(path, "owner-signed", body, urlNoFeedback)).status, path).toBe(404);
    }
    expect((await call("/situations/signals/status", "owner-signed", {}, urlNoFeedback)).status).toBe(200); // resten finnes
  });
});

describe("kropp, grant, eier og step-up - alt avvises FØR noe skrives", () => {
  it("uten grant 401; ugyldig grant 403; identitetsfelt og ukjente felt 400", async () => {
    expect((await post(url, "/situations/signals/status", {})).status).toBe(401);
    expect((await call("/situations/signals/status", "bogus")).status).toBe(403);
    for (const field of ["person_id", "tenant_id", "memory_space", "memory_space_id", "device_id", "session_id", "channel", "auth_strength"]) {
      const res = await call("/situations/signals/status", "owner-signed", { [field]: "x" });
      expect(res.status, field).toBe(400);
      expect(res.body["error"]).toBe("identity_field_forbidden");
    }
    expect((await call("/situations/signals/status", "owner-signed", { surprise: 1 })).status).toBe(400);
    expect((await call("/situations/signals/subscriptions/subscribe", "owner-signed", { ...DOOR, tenant_id: "x" })).status).toBe(400);
    expect(await auditTypes()).toEqual([]);
  });

  it("en annen person i samme tenant får 403 owner_required på ALLE ruter (ingenting skrives)", async () => {
    for (const [path, body] of [...READ_ROUTES, ...WRITE_ROUTES]) {
      const res = await call(path, "other-signed", body);
      expect(res.status, path).toBe(403);
      expect(res.body["error"], path).toBe("owner_required");
    }
    expect(await db.registry.list(TENANT_A, "home")).toEqual([]);
    expect(await auditTypes()).toEqual([]);
  });

  it("skriving krever step-up (signert enhetsøkt fra en eier-kanal): active-økt og talekanal -> 403 FØR noe skrives; lesing fungerer med active", async () => {
    for (const [path, body] of WRITE_ROUTES) {
      const active = await call(path, "owner-active", body);
      expect(active.status, path).toBe(403);
      expect(active.body, path).toMatchObject({ error: "step_up_required", reason: "step_up_required:signed_device_session" });
    }
    expect((await call("/situations/signals/subscriptions/subscribe", "owner-voice", DOOR)).body["reason"]).toBe("step_up_required:channel_voice_not_allowed");
    expect((await call("/situations/signals/subscriptions/list", "owner-active")).status).toBe(200);
    expect((await call("/situations/signals/status", "owner-active")).status).toBe(200);
    expect(await db.registry.list(TENANT_A, "home")).toEqual([]);
    expect((await db.engine.getNotificationPolicy(TENANT_A, "home"))?.critical_bypass_quiet ?? false).toBe(false);
    expect(await auditTypes()).toEqual([]);
  });
});

describe("abonnementer: subscribe/list/set-enabled/remove med lukket validering, typet bekreftelse og revisjon i samme transaksjon", () => {
  it("lukket validering: ukjent kilde/hendelse, feil rom, ugyldig filter og feiltyper gir 400 og skriver ingenting", async () => {
    const sub = (body: Record<string, unknown>, token = "owner-signed") => call("/situations/signals/subscriptions/subscribe", token, body);
    expect((await sub({ ...DOOR, source: "kafka" })).body).toMatchObject({ error: "subscription_invalid", code: "source_unknown" });
    expect((await sub({ ...DOOR, event_type: "reboot" })).body).toMatchObject({ error: "subscription_invalid", code: "event_type_unknown" });
    expect((await sub(DOOR, "owner-health")).body).toMatchObject({ error: "subscription_invalid", code: "space_not_allowed_for_source" });
    expect((await sub({ ...DOOR, filter: { entities: [{ entity_id: "*", role: "door" }] } })).body["error"]).toBe("subscription_invalid");
    expect((await sub({ source: "health", event_type: "activity_deviation", filter: { person_id: OTHER } }, "owner-health")).body).toMatchObject({ code: "health_self_only" });
    for (const bad of [{ source: 5 }, { event_type: "" }, { filter: [] }, { filter: "x" }, { enabled: "ja" }, { filter: null }]) {
      const res = await sub({ ...DOOR, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body["error"], JSON.stringify(bad)).toBe("malformed_request");
    }
    expect(await db.registry.list(TENANT_A, "home")).toEqual([]);
    expect(await auditTypes()).toEqual([]);
  });

  it("subscribe er idempotent (samme rad), list viser den, set-enabled slår av/på, remove krever TYPET bekreftelse (409 uten/feil id) og gir 404 når den er borte", async () => {
    const created = await call("/situations/signals/subscriptions/subscribe", "owner-signed", DOOR);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body["data"]["subscription_id"] as string;
    expect(created.body["data"]).toMatchObject({ source: "home_assistant", event_type: "door_open_too_long", domain: "home", enabled: true, created_by_person_id: OWNER, memory_space_id: "home", tenant_id: TENANT_A });
    expect((await call("/situations/signals/subscriptions/subscribe", "owner-signed", DOOR)).body["data"]["subscription_id"]).toBe(id);
    const list = await call("/situations/signals/subscriptions/list", "owner-signed");
    expect(list.body["data"]["subscriptions"]).toHaveLength(1);
    expect((await call("/situations/signals/subscriptions/set-enabled", "owner-signed", { subscription_id: id, enabled: false })).body["data"]).toMatchObject({ subscription_id: id, enabled: false });
    expect((await db.registry.listEnabled(TENANT_A, "home"))).toHaveLength(0);
    expect((await call("/situations/signals/subscriptions/set-enabled", "owner-signed", { subscription_id: id, enabled: true })).body["data"]["enabled"]).toBe(true);
    expect((await call("/situations/signals/subscriptions/set-enabled", "owner-signed", { subscription_id: "sub-finnes-ikke", enabled: true })).status).toBe(404);
    expect((await call("/situations/signals/subscriptions/set-enabled", "owner-signed", { subscription_id: id, enabled: "ja" })).status).toBe(400);
    // typet bekreftelse
    for (const body of [{ subscription_id: id }, { subscription_id: id, confirm: true }, { subscription_id: id, confirm: true, confirm_subscription_id: "annen" }, { subscription_id: id, confirm: "true", confirm_subscription_id: id }]) {
      const res = await call("/situations/signals/subscriptions/remove", "owner-signed", body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.body).toMatchObject({ error: "confirmation_required", confirm_subscription_id_required: id });
    }
    expect(await db.registry.list(TENANT_A, "home")).toHaveLength(1);
    expect((await call("/situations/signals/subscriptions/remove", "owner-signed", { subscription_id: id, confirm: true, confirm_subscription_id: id })).body).toMatchObject({ ok: true, data: { removed: true, subscription_id: id } });
    expect((await call("/situations/signals/subscriptions/remove", "owner-signed", { subscription_id: id, confirm: true, confirm_subscription_id: id })).status).toBe(404);
    expect(await db.registry.list(TENANT_A, "home")).toEqual([]);
  });

  it("revisjonsraden skrives i SAMME transaksjon som endringen: riktig type/aktør/økt, kun id/kilde/type/domene/rom (aldri filteret), og ingen rad for en mislykket/avvist endring", async () => {
    const created = await call("/situations/signals/subscriptions/subscribe", "owner-signed", DOOR);
    const id = created.body["data"]["subscription_id"] as string;
    await call("/situations/signals/subscriptions/set-enabled", "owner-signed", { subscription_id: id, enabled: false });
    await call("/situations/signals/subscriptions/set-enabled", "owner-signed", { subscription_id: id, enabled: true });
    await call("/situations/signals/subscriptions/remove", "owner-signed", { subscription_id: id, confirm: true, confirm_subscription_id: id });
    await call("/situations/signals/subscriptions/set-enabled", "owner-signed", { subscription_id: "sub-finnes-ikke", enabled: true }); // 404: ingen rad
    await call("/situations/signals/subscriptions/remove", "owner-signed", { subscription_id: id, confirm: true, confirm_subscription_id: id }); // allerede borte: ingen rad
    await call("/situations/signals/subscriptions/subscribe", "owner-signed", { ...DOOR, source: "kafka" }); // avvist: ingen rad
    const rows = await auditTypes();
    expect(rows.map((r) => r.type)).toEqual(["situation.subscription_set", "situation.subscription_disabled", "situation.subscription_enabled", "situation.subscription_removed"]);
    expect(rows.every((r) => r.person_id === OWNER && r.session_id === "s-owner")).toBe(true);
    expect(rows[0]!.payload).toMatchObject({ subscription_id: id, source: "home_assistant", event_type: "door_open_too_long", domain: "home", memory_space: "home", enabled: true });
    expect(JSON.stringify(rows)).not.toMatch(/binary_sensor|inngang|entities/); // aldri filterinnhold
  });

  it("revisjon og endring er ÉN transaksjon: feiler revisjonsskrivingen, rulles abonnementet tilbake (ingen abonnement uten revisjon)", async () => {
    await db.adminPool.query(`CREATE OR REPLACE FUNCTION g4_fail_sub_audit() RETURNS trigger AS $$ BEGIN IF NEW.type = 'situation.subscription_set' THEN RAISE EXCEPTION 'revisjon feilet'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await db.adminPool.query(`CREATE TRIGGER g4_fail_sub_audit_trg BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION g4_fail_sub_audit()`);
    try {
      const res = await call("/situations/signals/subscriptions/subscribe", "owner-signed", DOOR);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await db.registry.list(TENANT_A, "home")).toEqual([]);
    } finally {
      await db.adminPool.query(`DROP TRIGGER g4_fail_sub_audit_trg ON audit_events`);
      await db.adminPool.query(`DROP FUNCTION g4_fail_sub_audit()`);
    }
  });

  it("tenant- og space-isolasjon: en annen tenant ser og påvirker aldri abonnementet (RLS), og et annet rom viser ingenting", async () => {
    const created = await call("/situations/signals/subscriptions/subscribe", "owner-signed", DOOR);
    const id = created.body["data"]["subscription_id"] as string;
    expect((await call("/situations/signals/subscriptions/list", "owner-b")).body["data"]["subscriptions"]).toEqual([]);
    expect((await call("/situations/signals/subscriptions/list", "owner-health")).body["data"]["subscriptions"]).toEqual([]);
    expect((await call("/situations/signals/subscriptions/set-enabled", "owner-b", { subscription_id: id, enabled: false })).status).toBe(404);
    expect((await call("/situations/signals/subscriptions/remove", "owner-b", { subscription_id: id, confirm: true, confirm_subscription_id: id })).status).toBe(404);
    expect(await db.registry.list(TENANT_A, "home")).toHaveLength(1);
    expect((await db.registry.list(TENANT_A, "home"))[0]).toMatchObject({ enabled: true });
  });
});

describe("status, logg, vurderinger, simulering, stille timer og tilbakemelding", () => {
  async function situation(key: string): Promise<string> {
    return (await db.engine.evaluateCandidate(TENANT_A, "home", { domain: "home", detection_key: key, priority: "normal", reason: "Dør åpen" }, Date.parse("2026-11-19T12:00:00.000Z"))).situation.situation_id;
  }

  it("status viser løperens tikk uten innhold; logg og vurderinger er lesbare med validerte filtre (vurderinger er merket untrusted)", async () => {
    expect((await call("/situations/signals/status", "owner-signed")).body).toEqual({ ok: true, data: { enabled: true, running: false, tick: 7, last: null } });
    const id = await situation("home:opening:binary_sensor.inngang@2026-11-19T11:40:00.000Z");
    expect((await call("/situations/signals/log", "owner-signed", { situation_id: id, limit: 5 })).body).toEqual({ ok: true, data: { signals: [] } });
    for (const bad of [{ source: "kafka" }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { situation_id: "" }]) expect((await call("/situations/signals/log", "owner-signed", bad)).status, JSON.stringify(bad)).toBe(400);
    const assessments = await call("/situations/signals/assessments", "owner-signed", { situation_id: id });
    expect(assessments.body).toMatchObject({ ok: true, untrusted: true, data: { assessments: [] } });
    expect((await call("/situations/signals/assessments", "owner-signed", {})).status).toBe(400);
    const sim = await call("/situations/signals/simulate", "owner-signed", { situation_id: id });
    expect(sim.status).toBe(200);
    expect(sim.body["ok"]).toBe(true);
  });

  it("stille-timer-valget (`quiet-bypass`): step-up, boolean, revisjon i samme transaksjon, og reversibelt", async () => {
    expect((await call("/situations/signals/quiet-bypass", "owner-signed", { enabled: "ja" })).status).toBe(400);
    expect((await call("/situations/signals/quiet-bypass", "owner-signed", {})).status).toBe(400);
    expect((await call("/situations/signals/quiet-bypass", "owner-signed", { enabled: true })).body["data"]).toMatchObject({ critical_bypass_quiet: true });
    expect((await db.engine.getNotificationPolicy(TENANT_A, "home"))?.critical_bypass_quiet).toBe(true);
    expect((await call("/situations/signals/quiet-bypass", "owner-signed", { enabled: false })).body["data"]).toMatchObject({ critical_bypass_quiet: false });
    const rows = await auditTypes();
    expect(rows.map((r) => r.type)).toEqual(["situation.critical_bypass_set", "situation.critical_bypass_set"]);
    expect(rows.map((r) => r.payload["enabled"])).toEqual([true, false]);
  });

  it("tilbakemelding (kun med eget flagg): `useful`/`noise` på en situasjon, ugyldig verdikt/ukjent situasjon avvises, regeltuning kan leses og tilbakestilles", async () => {
    const id = await situation("home:opening:binary_sensor.inngang@2026-11-19T11:41:00.000Z");
    const first = await call("/situations/signals/feedback", "owner-signed", { situation_id: id, verdict: "noise" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body["data"]).toMatchObject({ rule_key: expect.any(String) });
    const badVerdict = await call("/situations/signals/feedback", "owner-signed", { situation_id: id, verdict: "maybe" });
    expect(badVerdict.status).toBe(400);
    expect(badVerdict.body).toMatchObject({ error: "malformed_request", reason: "verdict" }); // avvist av RUTEN, før tjenesten
    expect((await call("/situations/signals/feedback", "owner-signed", { verdict: "noise" })).body).toMatchObject({ error: "malformed_request", reason: "situation_id" });
    const unknown = await call("/situations/signals/feedback", "owner-signed", { situation_id: "sit-finnes-ikke", verdict: "noise" });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: "feedback_invalid", code: "situation_not_found" }); // avvist av TJENESTEN (egen feilkode)
    expect((await call("/situations/signals/rule-tuning", "owner-signed")).body["data"]["rules"]).toBeInstanceOf(Array);
    expect((await call("/situations/signals/rule-tuning/reset", "owner-signed", { rule_key: "home_assistant:door_open_too_long" })).body["data"]).toHaveProperty("reset");
    expect((await call("/situations/signals/rule-tuning/reset", "owner-signed", {})).status).toBe(400);
    expect((await db.adminPool.query(`SELECT count(*)::int AS n FROM situation_feedback WHERE tenant_id = $1`, [TENANT_A])).rows[0].n).toBe(1);
  });
});

describe("registeret har sin EGEN sovereign-eier-sjekk (uavhengig andre port)", () => {
  it("selv om eier-porten slipper en person gjennom, nekter registeret en annen enn den konfigurerte eieren (403 owner_required, ingenting skrives)", async () => {
    const open = await listen({
      ...makeDeps("full"), ownerGate: () => true
    } as unknown as ApiDeps);
    const res = await call("/situations/signals/subscriptions/subscribe", "other-signed", DOOR, open);
    expect(res.status).toBe(403);
    expect(res.body["error"]).toBe("owner_required");
    expect(await db.registry.list(TENANT_A, "home")).toEqual([]);
    expect(actorOwner.person_id).toBe(OWNER);
  });
});
