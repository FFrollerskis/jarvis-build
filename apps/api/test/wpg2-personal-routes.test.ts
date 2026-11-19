import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  HOME_CRITICAL_OPS, HOME_CRITICAL_READ_ACTION, homeAssistantTools, personalActionIndex, type ExecutePersonalActionResult, type ToolDefinition
} from "@jarvis/tool-gateway";
import { handlePersonalRoute, type PersonalActionsDeps, type PersonalRouteContext } from "../src/personal-routes.ts";
import { createPersonalWiring } from "../src/personal-wiring.ts";
import { createApiServer } from "../src/server.ts";

/**
 * WP-G2 (D-464): rutegrensene for personlig-domenet.
 *  A. FLAGG AV = main: uten `deps.personal` finnes ingen `/personal/*`-rute (404 - ikke 401/403), og wiringen gir tom verktøyliste, identitets-filter og ingen oppstartslogg.
 *  B. rekkefølgen i handlerne (grant -> EIER -> step-up -> domene -> eksekutor), bevist funksjonelt med spioner (ikke kildemønstre): en port som avviser hindrer ALLE senere steg.
 *  C. forhåndsvisning/lesing/liste: kun målet leses, bindeverdier og validering, filtre, feilkoder.
 *  D. main.ts: kun tre kroker, alle betinget (kildevakt).
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MAIN = readFileSync(join(ROOT, "apps/api/src/main.ts"), "utf8");
const SERVER = readFileSync(join(ROOT, "apps/api/src/server.ts"), "utf8");

const owner: IdentityContext = { person_id: "p-owner", tenant_id: "t-owner", memory_space_id: "home", session_id: "s", device_id: "d", channel: "api", auth_strength: "signed" };

describe("A: flagg AV - rutene og wiringen finnes ikke", () => {
  let server: ReturnType<typeof createApiServer>;
  let base = "";
  beforeAll(async () => {
    server = createApiServer({} as never);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it("alle `/personal/*`-ruter svarer 404 uten `deps.personal` (ikke 401/403, som ville røpet at ruten finnes)", async () => {
    for (const path of ["/personal/actions/mutate", "/personal/actions/preview", "/personal/actions/read", "/personal/actions/list", "/personal/health/ingest", "/personal/family/members", "/personal/dav/call", "/personal/finance/read", "/personal/context/now"]) {
      const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domain: "home", action: "critical_lock", parameters: {}, idempotency_key: "route-probe-0001" }) });
      expect(res.status, path).toBe(404);
    }
  });

  it("uten noe flagg: wiringen gir tom verktøyliste, den SAMME listen tilbake (identitet), ingen rute-avhengigheter og ingen oppstartslogg", () => {
    const wiring = createPersonalWiring({ env: {}, pool: {} as never, gateway: {} as never, readSecret: async () => null });
    expect(wiring.tools).toEqual([]);
    expect(wiring.deps).toBeUndefined();
    expect(wiring.describe()).toBeNull();
    const base: ToolDefinition[] = homeAssistantTools();
    expect(wiring.filterTools(base)).toBe(base); // samme referanse: ingenting er fjernet, rekkefølgen er urørt
    for (const value of ["", "true", "1", "ON", "yes"]) {
      const w = createPersonalWiring({ env: { JARVIS_PERSONAL_HOME_CRITICAL: value, JARVIS_PERSONAL_HOME_TARGETS: "lock.a" }, pool: {} as never, gateway: {} as never, readSecret: async () => null });
      expect(w.tools, value).toEqual([]);
      expect(w.deps, value).toBeUndefined();
    }
  });

  it("kun `JARVIS_PERSONAL_HOME_CRITICAL=on`: verktøyene og rute-avhengighetene finnes, de gamle lock_set/alarm_set fjernes, og loggen sier hvor mange mål som er listet (0 = fail-closed)", () => {
    const wiring = createPersonalWiring({ env: { JARVIS_PERSONAL_HOME_CRITICAL: "on" }, pool: {} as never, gateway: {} as never, readSecret: async () => null });
    expect(wiring.tools.map((t) => t.action).sort()).toEqual([HOME_CRITICAL_READ_ACTION, ...HOME_CRITICAL_OPS.map((o) => o.action)].sort());
    expect(wiring.tools.every((t) => t.tool_id === "home-assistant")).toBe(true);
    expect(wiring.deps?.actions?.domains.get("home")).toEqual({ toolId: "home-assistant", readAction: HOME_CRITICAL_READ_ACTION });
    expect([...(wiring.deps?.actions?.domains.keys() ?? [])]).toEqual(["home"]);
    expect(wiring.filterTools(homeAssistantTools()).map((d) => d.action)).toEqual(["list_states", "read_state", "light_set", "climate_set"]);
    expect(wiring.describe()).toEqual({ msg: "personal_twin", home_critical: { targets: 0, settle_ms: 20_000, legacy_lock_alarm_removed: true } });
    const withTargets = createPersonalWiring({ env: { JARVIS_PERSONAL_HOME_CRITICAL: "on", JARVIS_PERSONAL_HOME_TARGETS: "lock.a, cover.b ,bogus", JARVIS_PERSONAL_HOME_SETTLE_MS: "30000" }, pool: {} as never, gateway: {} as never, readSecret: async () => null });
    expect(withTargets.describe()).toEqual({ msg: "personal_twin", home_critical: { targets: 2, settle_ms: 30_000, legacy_lock_alarm_removed: true } });
  });
});

describe("A2: bil-flagget - verktøy og domene finnes KUN med `JARVIS_PERSONAL_CAR=on`, og uten leverandør er adapteren `unconfigured` (live = BLOCKED_EXTERNAL)", () => {
  it("kun bil: `car.*` registreres, hjem-verktøyene og legacy-filteret er urørt, loggen sier `unconfigured`/`BLOCKED_EXTERNAL`", () => {
    const wiring = createPersonalWiring({ env: { JARVIS_PERSONAL_CAR: "on", JARVIS_PERSONAL_CAR_TARGETS: "bil, elbil-1" }, pool: {} as never, gateway: {} as never, readSecret: async () => null });
    expect(wiring.tools.every((t) => t.tool_id === "car")).toBe(true);
    expect(wiring.tools.map((t) => t.action).sort()).toEqual(["charge_set", "climate_set", "lock", "read_vehicle_state", "unlock"]);
    expect([...(wiring.deps?.actions?.domains.keys() ?? [])]).toEqual(["car"]);
    const base = homeAssistantTools();
    expect(wiring.filterTools(base)).toBe(base); // legacy lock_set/alarm_set røres kun av hjem-flagget
    expect(wiring.describe()).toEqual({ msg: "personal_twin", car: { targets: 2, settle_ms: 60_000, adapter: "unconfigured", live: "BLOCKED_EXTERNAL" } });
  });

  it("begge flagg: begge domener, og en injisert adapter vises som konfigurert", () => {
    const adapter = { name: "sandbox-x", capabilities: [], readState: async () => null, command: async () => ({ accepted: true }) };
    const wiring = createPersonalWiring({ env: { JARVIS_PERSONAL_CAR: "on", JARVIS_PERSONAL_HOME_CRITICAL: "on" }, pool: {} as never, gateway: {} as never, readSecret: async () => null, carAdapter: adapter });
    expect([...(wiring.deps?.actions?.domains.keys() ?? [])].sort()).toEqual(["car", "home"]);
    expect(wiring.describe()).toMatchObject({ car: { adapter: "sandbox-x", live: "configured" }, home_critical: { legacy_lock_alarm_removed: true } });
    expect(wiring.tools.filter((t) => t.tool_id === "car").length).toBe(5);
    expect(wiring.tools.filter((t) => t.tool_id === "home-assistant").length).toBe(9);
  });
});

interface Harness {
  ctx: PersonalRouteContext;
  calls: string[];
  responses: Array<{ status: number; body: unknown }>;
  run: ReturnType<typeof vi.fn>;
  gatewayExecute: ReturnType<typeof vi.fn>;
  journalList: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  path: string; body?: Record<string, unknown>; authed?: boolean; owner?: boolean; stepUp?: string | undefined; identity?: IdentityContext; readResult?: unknown; deps?: "none" | "actions";
}): Harness {
  const calls: string[] = [];
  const responses: Array<{ status: number; body: unknown }> = [];
  const run = vi.fn(async (_identity: IdentityContext, input: { action: string }): Promise<ExecutePersonalActionResult> => {
    calls.push("run");
    if (input.action === "boom") throw new Error("personal_action_idempotency_conflict");
    if (input.action === "crash") throw new Error("noe uventet med hemmelighet-123");
    return { action: { action_id: "a1" } as never, outcome: "SUCCESS", reason: null, replayed: false };
  });
  const gatewayExecute = vi.fn(async () => { calls.push("gateway.execute"); return opts.readResult ?? { ok: true, output_trust: "untrusted", data: { entity_id: "lock.a", state: "locked", settled: true, usable: true } }; });
  const journalList = vi.fn(async () => { calls.push("journal.list"); return []; });
  const index = personalActionIndex(HOME_CRITICAL_OPS.map((op) => ({ domain: "home" as const, toolId: "home-assistant", op })));
  const actions: PersonalActionsDeps = {
    executor: { pool: {} as never, gateway: { execute: gatewayExecute, get: () => ({}) } as never, journal: { list: journalList } as never, index },
    domains: new Map([["home", { toolId: "home-assistant", readAction: HOME_CRITICAL_READ_ACTION }]]), run: run as never
  };
  const identity = opts.identity ?? owner;
  const body = opts.body ?? {};
  const ctx: PersonalRouteContext = {
    req: { method: "POST" } as never, res: {} as never, url: new URL(opts.path, "http://localhost"), deps: opts.deps === "none" ? {} : { actions },
    authed: async () => { calls.push("authed"); return opts.authed === false ? null : { identity, body }; },
    requireOwner: async () => { calls.push("requireOwner"); if (opts.owner === false) { responses.push({ status: 403, body: { error: "owner_required" } }); return false; } return true; },
    stepUpDenial: () => { calls.push("stepUp"); return opts.stepUp; },
    json: (status, b) => { responses.push({ status, body: b }); }, requestId: () => "req-1",
    fieldString: (b, k) => { const v = b[k]; if (typeof v !== "string" || v.length === 0) throw new Error(`malformed:${k}`); return v; },
    fieldOptionalString: (b, k) => (typeof b[k] === "string" ? (b[k] as string) : undefined),
    fieldRecord: (b, k) => { const v = b[k]; if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`malformed:${k}`); return v as Record<string, unknown>; },
    fieldOptionalNumber: (b, k) => (typeof b[k] === "number" ? (b[k] as number) : undefined),
    domainFailure: (status, code) => { responses.push({ status, body: { error: code, generic: true } }); }
  };
  return { ctx, calls, responses, run, gatewayExecute, journalList };
}

describe("B: /personal/actions/mutate - rekkefølge og porter (funksjonelt, med spioner)", () => {
  const body = { domain: "home", action: "critical_lock", parameters: { entity: "lock.a", locked: true }, idempotency_key: "key-0001-abcdef" };

  it("grant -> eier -> step-up -> eksekutor: lykkes med eier + signert økt og gir `execution`; identiteten er grantets, kroppen kan ikke sette den", async () => {
    const h = harness({ path: "/personal/actions/mutate", body });
    expect(await handlePersonalRoute(h.ctx)).toBe(true);
    expect(h.calls).toEqual(["authed", "requireOwner", "stepUp", "run"]);
    expect(h.responses).toEqual([{ status: 200, body: { execution: { action: { action_id: "a1" }, outcome: "SUCCESS", reason: null, replayed: false } } }]);
    const [identity, input] = h.run.mock.calls[0] as [IdentityContext, Record<string, unknown>];
    expect(identity).toBe(owner);
    expect(input).toMatchObject({ domain: "home", action: "critical_lock", idempotency_key: "key-0001-abcdef", source: "owner_route", session_id: "s" });
  });

  it("ugyldig grant: ingenting skjer; ikke-eier: step-up og eksekutor nås aldri; manglende step-up: eksekutor nås aldri (403 med årsak)", async () => {
    const noGrant = harness({ path: "/personal/actions/mutate", body, authed: false });
    expect(await handlePersonalRoute(noGrant.ctx)).toBe(true);
    expect(noGrant.calls).toEqual(["authed"]);

    const notOwner = harness({ path: "/personal/actions/mutate", body, owner: false });
    expect(await handlePersonalRoute(notOwner.ctx)).toBe(true);
    expect(notOwner.calls).toEqual(["authed", "requireOwner"]);
    expect(notOwner.responses[0]?.status).toBe(403);

    const weak = harness({ path: "/personal/actions/mutate", body, stepUp: "step_up_required:signed_device_session" });
    expect(await handlePersonalRoute(weak.ctx)).toBe(true);
    expect(weak.calls).toEqual(["authed", "requireOwner", "stepUp"]);
    expect(weak.responses).toEqual([{ status: 403, body: { error: "step_up_required", reason: "step_up_required:signed_device_session", request_id: "req-1" } }]);
    expect(weak.run).not.toHaveBeenCalled();
  });

  it("ukjent/ugyldig domene avvises (400) før eksekutoren; en domene-verdi som ikke er slått på har ingen rute-avhengighet", async () => {
    for (const domain of ["nuke", "CAR", "../home", "car"]) {
      const h = harness({ path: "/personal/actions/mutate", body: { ...body, domain } });
      expect(await handlePersonalRoute(h.ctx)).toBe(true);
      expect(h.responses[0]).toMatchObject({ status: 400, body: { error: "personal_domain_unknown" } });
      expect(h.run).not.toHaveBeenCalled();
    }
  });

  it("kun VÅRE egne feilkoder vises til eieren (400, forkortet); alt annet blir generisk (aldri en uventet feiltekst)", async () => {
    const own = harness({ path: "/personal/actions/mutate", body: { ...body, action: "boom" } });
    await handlePersonalRoute(own.ctx);
    expect(own.responses).toEqual([{ status: 400, body: { error: "personal_action_rejected", reason: "personal_action_idempotency_conflict", request_id: "req-1" } }]);
    const other = harness({ path: "/personal/actions/mutate", body: { ...body, action: "crash" } });
    await handlePersonalRoute(other.ctx);
    expect(other.responses).toEqual([{ status: 400, body: { error: "personal_action_rejected", generic: true } }]);
    expect(JSON.stringify(other.responses)).not.toContain("hemmelighet-123");
  });

  it("ruter uten `deps.actions` håndteres ikke (false -> 404 hos kalleren), og ikke-POST/andre stier likeså", async () => {
    expect(await handlePersonalRoute(harness({ path: "/personal/actions/mutate", body, deps: "none" }).ctx)).toBe(false);
    const get = harness({ path: "/personal/actions/mutate", body });
    (get.ctx.req as { method: string }).method = "GET";
    expect(await handlePersonalRoute(get.ctx)).toBe(false);
    expect(await handlePersonalRoute(harness({ path: "/personal/unknown/x", body }).ctx)).toBe(false);
    expect(await handlePersonalRoute(harness({ path: "/personal/actions/nuke", body }).ctx)).toBe(false);
  });
});

describe("C: preview/read/list - kun lesing, eier-kun, ingen step-up, ingen mutasjon", () => {
  it("preview: leser KUN målet (ingen andre parametre sendt), validerer med handlingens validator og gir bindeverdiene (tilstanden for vanlige handlinger, markøren for scene/skript)", async () => {
    const h = harness({ path: "/personal/actions/preview", body: { domain: "home", action: "critical_lock", parameters: { entity: "lock.a", locked: false, hemmelig: "x" } } });
    await handlePersonalRoute(h.ctx);
    expect(h.calls).toEqual(["authed", "requireOwner", "gateway.execute"]);
    expect(h.gatewayExecute).toHaveBeenCalledWith({ identity: owner, tool_id: "home-assistant", action: HOME_CRITICAL_READ_ACTION, parameters: { entity: "lock.a" } });
    expect(h.responses[0]).toMatchObject({ status: 200, body: { ok: true, domain: "home", action: "critical_lock", direction: "increases", valid: true, reason: null, bind: { expected_state: "locked" } } });
    expect(h.run).not.toHaveBeenCalled();

    const scene = harness({ path: "/personal/actions/preview", body: { domain: "home", action: "critical_scene", parameters: { entity: "scene.s" } }, readResult: { ok: true, output_trust: "untrusted", data: { entity_id: "scene.s", state: "2026-11-18T10:00:00.000Z", last_activated: "2026-11-18T10:00:00.000Z", usable: true, settled: true } } });
    await handlePersonalRoute(scene.ctx);
    expect(scene.responses[0]).toMatchObject({ body: { valid: true, bind: { expected_last_activated: "2026-11-18T10:00:00.000Z" }, direction: "neutral" } });
  });

  it("preview: ugyldig før-tilstand gir `valid: false` med årsak; avvist/ukjent mål gir ok:false; ukjent handling 400 - og ingen step-up kreves for lesing", async () => {
    const jam = harness({ path: "/personal/actions/preview", body: { domain: "home", action: "critical_lock", parameters: { entity: "lock.a", locked: true } }, readResult: { ok: true, output_trust: "untrusted", data: { state: "jammed", settled: true, usable: true } } });
    await handlePersonalRoute(jam.ctx);
    expect(jam.responses[0]).toMatchObject({ body: { ok: true, valid: false, reason: "lock_jammed" } });
    expect(jam.calls).not.toContain("stepUp");
    const denied = harness({ path: "/personal/actions/preview", body: { domain: "home", action: "critical_lock", parameters: { entity: "lock.a", locked: true } }, readResult: { ok: false, reason: "home_target_not_authorized" } });
    await handlePersonalRoute(denied.ctx);
    expect(denied.responses[0]).toEqual({ status: 200, body: { ok: false, reason: "home_target_not_authorized", request_id: "req-1" } });
    const missing = harness({ path: "/personal/actions/preview", body: { domain: "home", action: "critical_lock", parameters: { entity: "lock.a", locked: true } }, readResult: { ok: true, output_trust: "untrusted", data: null } });
    await handlePersonalRoute(missing.ctx);
    expect(missing.responses[0]).toMatchObject({ body: { ok: false, reason: "preflight_target_not_found" } });
    const unknown = harness({ path: "/personal/actions/preview", body: { domain: "home", action: "critical_nuke", parameters: {} } });
    await handlePersonalRoute(unknown.ctx);
    expect(unknown.responses[0]).toMatchObject({ status: 400, body: { error: "personal_action_unknown_action" } });
    expect(unknown.gatewayExecute).not.toHaveBeenCalled();
  });

  it("read: sender parametrene til lese-handlingen (gatewayens strenge skjema og mål-allowlist avgjør), merker utdata som ubetrodd og viser kort årsak ved avslag", async () => {
    const h = harness({ path: "/personal/actions/read", body: { domain: "home", parameters: { entity: "lock.a" } } });
    await handlePersonalRoute(h.ctx);
    expect(h.gatewayExecute).toHaveBeenCalledWith({ identity: owner, tool_id: "home-assistant", action: HOME_CRITICAL_READ_ACTION, parameters: { entity: "lock.a" } });
    expect(h.responses[0]).toMatchObject({ status: 200, body: { ok: true, output_trust: "untrusted", data: { state: "locked" } } });
    const denied = harness({ path: "/personal/actions/read", body: { domain: "home", parameters: { entity: "lock.x" } }, readResult: { ok: false, reason: "home_target_not_authorized".padEnd(400, "x") } });
    await handlePersonalRoute(denied.ctx);
    expect(((denied.responses[0]?.body as { reason: string }).reason).length).toBeLessThanOrEqual(120);
  });

  it("list: eier først, status valideres mot den kjente mengden, filtre og tak sendes til journalen, aldri gateway.execute", async () => {
    const h = harness({ path: "/personal/actions/list", body: { domain: "home", status: "outcome_unknown", target_ref: "lock.a", limit: 5 } });
    await handlePersonalRoute(h.ctx);
    expect(h.calls).toEqual(["authed", "requireOwner", "journal.list"]);
    expect(h.journalList).toHaveBeenCalledWith("t-owner", "home", { domain: "home", status: "outcome_unknown", target_ref: "lock.a", limit: 5 });
    expect(h.responses[0]).toEqual({ status: 200, body: { actions: [] } });
    const bad = harness({ path: "/personal/actions/list", body: { domain: "home", status: "executed" } });
    await handlePersonalRoute(bad.ctx);
    expect(bad.responses[0]).toMatchObject({ status: 400, body: { error: "malformed_request", reason: "status" } });
    expect(bad.journalList).not.toHaveBeenCalled();
    const notOwner = harness({ path: "/personal/actions/list", body: { domain: "home" }, owner: false });
    await handlePersonalRoute(notOwner.ctx);
    expect(notOwner.journalList).not.toHaveBeenCalled();
  });
});

describe("D: server.ts og main.ts - krokene er få og betingede (kildevakt)", () => {
  it("server.ts: ÉN kroklinje som krever `deps.personal` og stien `/personal/`, og identitet/step-up/eier gis fra server.ts sine egne porter (aldri egne kopier)", () => {
    expect(SERVER).toMatch(/if \(deps\.personal !== undefined && url\.pathname\.startsWith\("\/personal\/"\)\)/);
    expect(SERVER.match(/handlePersonalRoute\(/g)).toHaveLength(1);
    const start = SERVER.indexOf("handlePersonalRoute({");
    const hook = SERVER.slice(start, start + 800);
    for (const needle of ["authedRequest(req, res, deps, allowedKeys)", "requireOwner(res, deps, identity, subject)", "stepUpDenial"]) expect(hook, needle).toContain(needle);
    // Kroken står FØR incidents-blokken (ikke avhengig av den) og etter grant-/konfig-sjekkene.
    expect(start).toBeLessThan(SERVER.indexOf("if (deps.incidents) {"));
  });

  it("main.ts: personal opprettes fra miljøet, filtrerer firstWaveTools, legger verktøyene til sist og setter `personal` i ApiDeps KUN når deps finnes; loggen er betinget", () => {
    expect(MAIN).toMatch(/const personal = createPersonalWiring\(\{ env: process\.env, pool, gateway: toolGateway, readSecret: \(ref\) => readSecretProvider\.get\(ref\), ownerPersonId: owner\.owner_person_id \}\);/);
    expect(MAIN).toMatch(/if \(personalLog\) console\.log\(JSON\.stringify\(personalLog\)\);/);
    expect(MAIN).toContain("for (const tool of personal.filterTools(firstWaveTools({");
    expect(MAIN).toMatch(/\.\.\.personal\.tools\s*\]\s*\}\)\)\) toolGateway\.register\(tool\);/);
    expect(MAIN).toMatch(/\.\.\.\(personal\.deps \? \{ personal: personal\.deps \} : \{\}\)/);
    expect(MAIN.match(/createPersonalWiring\(/g)).toHaveLength(1);
  });

  it("ingen rute eller verktøy leser identitet fra kroppen: `/personal/*` bruker `authed` (grant) og aldri `tenant_id`/`person_id` fra kroppen", () => {
    const routes = readFileSync(join(ROOT, "apps/api/src/personal-routes.ts"), "utf8");
    expect(routes).not.toMatch(/body\[["'](tenant_id|person_id|actor_person_id|owner_person_id)["']\]/);
    expect(routes).not.toMatch(/fieldString\([^)]*["'](tenant_id|person_id)["']/);
  });
});

