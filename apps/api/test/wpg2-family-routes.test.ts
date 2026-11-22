import { describe, expect, it, vi } from "vitest";
import { FAMILY_ERROR_CODES, FamilyError, type FamilyService } from "@jarvis/context";
import type { IdentityContext } from "@jarvis/contracts";
import { FAMILY_ROUTES, FAMILY_STATUS, handlePersonalRoute, type PersonalRouteContext } from "../src/personal-routes.ts";
import { createPersonalWiring } from "../src/personal-wiring.ts";
import { familySharedDataReaders, startOfLocalDayMs } from "../src/personal-family-readers.ts";
import { FORBIDDEN_IDENTITY_BODY_KEYS } from "../src/http-guard.ts";

/**
 * WP-G2 (D-464) P1c: rutegrensene og wiringen for familie-/delt-rom. Funksjonelle bevis med spioner (ikke kildemønstre):
 *  A. flagg AV = main (ingen `family`-avhengigheter, ingen loggline); flagget uten eier-id registrerer INGENTING (fail closed); wiringen legger IKKE til modellverktøy.
 *  B. hver rute: grant -> (eier) -> step-up -> tjeneste i rekkefølge, identiteten kommer fra grantet, nøkkellisten er lukket og aldri en identitetsnøkkel.
 *  C. feilkoder -> statuskoder, generisk feil lekker ikke, ubetrodd tekst er merket.
 *  D. lesere: minimering (kun sonenavn/aggregater), lokal midnatt inkl. sommertid.
 */
const OWNER_ID = "p-owner";
const adult: IdentityContext = { person_id: "p-adult", tenant_id: "t-circle", memory_space_id: "shared", session_id: "s-1", device_id: "d-1", channel: "api", auth_strength: "signed" };
const ownerIdentity: IdentityContext = { ...adult, person_id: OWNER_ID };

const SERVICE_METHODS = [
  "bootstrapOwner", "topology", "getCircle", "invite", "listInvitations", "revokeInvitation", "acceptInvitation", "declineInvitation", "removeMember", "leave", "setDataTenant", "grantShare", "revokeShare", "listShares",
  "readShared", "grantDelegation", "revokeDelegation", "listDelegations", "createList", "listLists", "addListItem", "listItems", "setItemDone", "createEvent", "listEvents", "cancelEvent"
] as const;

interface Case { path: string; body: Record<string, unknown>; method: (typeof SERVICE_METHODS)[number]; args: unknown[]; step: boolean; owner?: true; resultKey: string }
const WINDOW = { from: "2026-11-20T00:00:00Z", to: "2026-11-21T00:00:00Z" };
const CASES: Case[] = [
  { path: "bootstrap", body: { data_tenant_id: "t-own" }, method: "bootstrapOwner", args: [OWNER_ID, { data_tenant_id: "t-own" }], step: true, owner: true, resultKey: "member" },
  { path: "topology", body: {}, method: "topology", args: [], step: false, owner: true, resultKey: "topology" },
  { path: "circle", body: {}, method: "getCircle", args: [], step: false, resultKey: "circle" },
  { path: "invite", body: { invitee_person_id: "p-x", role: "adult", ttl_hours: 24 }, method: "invite", args: [{ invitee_person_id: "p-x", role: "adult", ttl_hours: 24 }], step: true, resultKey: "invitation" },
  { path: "invitations", body: {}, method: "listInvitations", args: [], step: false, resultKey: "invitations" },
  { path: "invitation/revoke", body: { invitation_id: "i-1" }, method: "revokeInvitation", args: ["i-1"], step: true, resultKey: "invitation" },
  { path: "invitation/accept", body: { invitation_id: "i-1", data_tenant_id: "t-own" }, method: "acceptInvitation", args: ["i-1", { data_tenant_id: "t-own" }], step: true, resultKey: "member" },
  { path: "invitation/decline", body: { invitation_id: "i-1" }, method: "declineInvitation", args: ["i-1"], step: true, resultKey: "invitation" },
  { path: "member/remove", body: { member_person_id: "p-x" }, method: "removeMember", args: ["p-x"], step: true, resultKey: "removed" },
  { path: "leave", body: {}, method: "leave", args: [], step: true, resultKey: "left" },
  { path: "data-tenant", body: { data_tenant_id: "t-own" }, method: "setDataTenant", args: ["t-own"], step: true, resultKey: "member" },
  { path: "share/grant", body: { viewer_person_id: "p-x", category: "location", ttl_days: 7 }, method: "grantShare", args: [{ viewer_person_id: "p-x", category: "location", ttl_days: 7 }], step: true, resultKey: "share" },
  { path: "share/revoke", body: { share_id: "s-1" }, method: "revokeShare", args: ["s-1"], step: true, resultKey: "share" },
  { path: "shares", body: {}, method: "listShares", args: [], step: false, resultKey: "shares" },
  { path: "shared/read", body: { subject_person_id: "p-x", category: "health_summary" }, method: "readShared", args: ["p-x", "health_summary"], step: true, resultKey: "view" },
  { path: "delegation/grant", body: { agent_person_id: "p-x", scope: "shared_lists", ttl_days: 10 }, method: "grantDelegation", args: [{ agent_person_id: "p-x", scope: "shared_lists", ttl_days: 10 }], step: true, resultKey: "delegation" },
  { path: "delegation/revoke", body: { family_delegation_id: "d-1" }, method: "revokeDelegation", args: ["d-1"], step: true, resultKey: "delegation" },
  { path: "delegations", body: {}, method: "listDelegations", args: [], step: false, resultKey: "delegations" },
  { path: "list/create", body: { name: "Handleliste" }, method: "createList", args: [{ name: "Handleliste" }], step: false, resultKey: "list" },
  { path: "lists", body: {}, method: "listLists", args: [], step: false, resultKey: "lists" },
  { path: "list/items", body: { list_id: "l-1" }, method: "listItems", args: ["l-1"], step: false, resultKey: "items" },
  { path: "list/item/add", body: { list_id: "l-1", body: "Melk" }, method: "addListItem", args: ["l-1", { body: "Melk" }], step: false, resultKey: "item" },
  { path: "list/item/done", body: { item_id: "it-1", done: true }, method: "setItemDone", args: ["it-1", true], step: false, resultKey: "item" },
  { path: "event/create", body: { title: "Tannlege", starts_at: WINDOW.from, ends_at: WINDOW.to, all_day: true }, method: "createEvent", args: [{ title: "Tannlege", starts_at: WINDOW.from, ends_at: WINDOW.to, all_day: true }], step: false, resultKey: "event" },
  { path: "events", body: WINDOW, method: "listEvents", args: [WINDOW], step: false, resultKey: "events" },
  { path: "event/cancel", body: { event_id: "e-1" }, method: "cancelEvent", args: ["e-1"], step: true, resultKey: "event" }
];

interface Harness {
  ctx: PersonalRouteContext;
  calls: string[];
  responses: Array<{ status: number; body: Record<string, unknown> }>;
  service: Record<string, ReturnType<typeof vi.fn>>;
  authedKeys: Array<readonly string[]>;
  stepUpActions: string[];
}

function harness(opts: { path: string; body?: Record<string, unknown>; identity?: IdentityContext; stepUp?: string; authed?: boolean; family?: boolean; method?: string; fail?: unknown }): Harness {
  const calls: string[] = [];
  const responses: Harness["responses"] = [];
  const authedKeys: Array<readonly string[]> = [];
  const stepUpActions: string[] = [];
  const service: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of SERVICE_METHODS) {
    service[name] = vi.fn(async () => {
      calls.push(name);
      if (opts.fail !== undefined) throw opts.fail;
      return { ok: name };
    });
  }
  const identity = opts.identity ?? adult;
  const body = opts.body ?? {};
  const ctx: PersonalRouteContext = {
    req: { method: opts.method ?? "POST" } as never, res: {} as never, url: new URL(`/personal/family/${opts.path}`, "http://localhost"),
    deps: opts.family === false ? {} : { family: { service: service as unknown as FamilyService, ownerPersonId: OWNER_ID } },
    authed: async (keys) => { calls.push("authed"); authedKeys.push(keys); return opts.authed === false ? null : { identity, body }; },
    requireOwner: async () => { throw new Error("familie-rutene bruker aldri requireOwner (rollen avgjøres av tjenesten, eier-kun av konfigurert person-id)"); },
    stepUpDenial: (_i, action) => { calls.push("stepUp"); stepUpActions.push(action); return opts.stepUp; },
    json: (status, b) => { responses.push({ status, body: b as Record<string, unknown> }); }, requestId: () => "req-1",
    fieldString: (b, k) => { const v = b[k]; if (typeof v !== "string" || v.length === 0) throw new Error(`malformed:${k}`); return v; },
    fieldOptionalString: (b, k) => (typeof b[k] === "string" ? (b[k] as string) : undefined),
    fieldRecord: (b, k) => b[k] as Record<string, unknown>,
    fieldOptionalNumber: (b, k) => (typeof b[k] === "number" ? (b[k] as number) : undefined),
    domainFailure: (status, code) => { responses.push({ status, body: { error: code, generic: true } }); }
  };
  return { ctx, calls, responses, service, authedKeys, stepUpActions };
}

describe("A: flagg og wiring", () => {
  const base = { pool: {} as never, gateway: {} as never, readSecret: async () => null };
  it("uten flagg: ingen family-avhengigheter, tom verktøyliste og ingen oppstartslogg (identisk med main), selv med eier-id", () => {
    for (const value of [undefined, "", "true", "1", "ON", "yes"]) {
      const w = createPersonalWiring({ ...base, env: value === undefined ? {} : { JARVIS_PERSONAL_FAMILY: value }, ownerPersonId: OWNER_ID });
      expect(w.deps, String(value)).toBeUndefined();
      expect(w.tools).toEqual([]);
      expect(w.describe()).toBeNull();
    }
  });

  it("flagget på uten eier-id registrerer INGENTING (fail closed) og sier hvorfor; med eier-id finnes kun `family`, aldri verktøy eller handlings-avhengigheter", () => {
    const noOwner = createPersonalWiring({ ...base, env: { JARVIS_PERSONAL_FAMILY: "on" } });
    expect(noOwner.deps).toBeUndefined();
    expect(noOwner.describe()).toEqual({ msg: "personal_twin", family: { registered: false, reason: "owner_person_id_missing" } });
    const w = createPersonalWiring({ ...base, env: { JARVIS_PERSONAL_FAMILY: "on" }, ownerPersonId: OWNER_ID });
    expect(w.deps?.family?.ownerPersonId).toBe(OWNER_ID);
    expect(w.deps?.family?.service).toBeDefined();
    expect(w.deps?.actions).toBeUndefined();
    expect(w.tools).toEqual([]); // ingen modellflate: familiedata kan aldri nå en modell via verktøy
    expect(w.describe()).toEqual({ msg: "personal_twin", family: { registered: true, shared_categories: ["location", "health_summary"], time_zone: "Europe/Oslo" } });
    expect(JSON.stringify(w.describe())).not.toContain(OWNER_ID); // person-id logges aldri
  });

  it("sammen med hjem/bil: alle rutefamiliene finnes, og eksekutorens handlingsindeks inneholder BÅDE hjem- og bil-handlinger (regresjon: indeksen ble tidligere bygd før bil-handlingene var registrert)", () => {
    const w = createPersonalWiring({ ...base, env: { JARVIS_PERSONAL_FAMILY: "on", JARVIS_PERSONAL_HOME_CRITICAL: "on", JARVIS_PERSONAL_CAR: "on" }, ownerPersonId: OWNER_ID });
    expect(w.deps?.family).toBeDefined();
    const index = w.deps?.actions?.executor.index;
    expect(index?.has("home.critical_lock")).toBe(true);
    expect(index?.has("car.lock")).toBe(true);
    expect(index?.has("car.charge_set")).toBe(true);
    const carOnly = createPersonalWiring({ ...base, env: { JARVIS_PERSONAL_CAR: "on" } });
    expect(carOnly.deps?.actions?.executor.index.has("car.unlock")).toBe(true);
    expect(carOnly.deps?.family).toBeUndefined();
  });
});

describe("B: ruter - rekkefølge, identitet og lukkede nøkkellister", () => {
  it("tabellen dekker NØYAKTIG rutene som finnes (en ny rute uten test feiler her), og ingen nøkkel er en forbudt identitetsnøkkel", () => {
    expect(Object.keys(FAMILY_ROUTES).sort()).toEqual(CASES.map((c) => `/personal/family/${c.path}`).sort());
    for (const [path, route] of Object.entries(FAMILY_ROUTES)) {
      for (const key of route.keys) expect(FORBIDDEN_IDENTITY_BODY_KEYS, `${path}:${key}`).not.toContain(key);
    }
  });

  it.each(CASES)("$path: grant -> $method, identiteten fra grantet, riktige argumenter", async (c) => {
    const identity = c.owner ? ownerIdentity : adult;
    const h = harness({ path: c.path, body: c.body, identity });
    expect(await handlePersonalRoute(h.ctx)).toBe(true);
    expect(h.calls).toEqual(c.step ? ["authed", "stepUp", c.method] : ["authed", c.method]);
    expect(h.authedKeys).toEqual([FAMILY_ROUTES[`/personal/family/${c.path}`]?.keys]);
    const spy = h.service[c.method]!;
    expect(spy).toHaveBeenCalledTimes(1);
    const [actor, ...args] = spy.mock.calls[0] as [Record<string, unknown>, ...unknown[]];
    expect(actor).toEqual({ tenant_id: "t-circle", person_id: identity.person_id, memory_space_id: "shared", session_id: "s-1", device_id: "d-1", channel: "api", auth_strength: "signed" });
    expect(args).toEqual(c.args);
    expect(h.responses).toHaveLength(1);
    expect(h.responses[0]?.status).toBe(200);
    expect(h.responses[0]?.body).toHaveProperty(c.resultKey);
    if (c.step) expect(h.stepUpActions[0]).toMatch(/^personal_family_[a-z_-]+$/);
  });

  it("step-up: uten signert enhetsøkt nås tjenesten ALDRI på noen ruter som endrer autoritet eller leser andres data; rene lesinger spør ikke om step-up", async () => {
    for (const c of CASES) {
      const h = harness({ path: c.path, body: c.body, identity: c.owner ? ownerIdentity : adult, stepUp: "step_up_required:signed_device_session" });
      expect(await handlePersonalRoute(h.ctx)).toBe(true);
      if (c.step) {
        expect(h.calls, c.path).toEqual(["authed", "stepUp"]);
        expect(h.responses).toEqual([{ status: 403, body: { error: "step_up_required", reason: "step_up_required:signed_device_session", request_id: "req-1" } }]);
      } else {
        expect(h.calls, c.path).toEqual(["authed", c.method]);
        expect(h.responses[0]?.status).toBe(200);
      }
    }
  });

  it("eier-kun (bootstrap, topologi): en annen person får owner_required FØR step-up og tjeneste - og kroppen kan ikke gi eier-id", async () => {
    for (const path of ["bootstrap", "topology"]) {
      const h = harness({ path, body: {}, identity: adult });
      expect(await handlePersonalRoute(h.ctx)).toBe(true);
      expect(h.calls).toEqual(["authed"]);
      expect(h.responses).toEqual([{ status: 403, body: { error: "family_rejected", reason: "owner_required", request_id: "req-1" } }]);
    }
    const boot = harness({ path: "bootstrap", body: {}, identity: ownerIdentity });
    await handlePersonalRoute(boot.ctx);
    expect(boot.service["bootstrapOwner"]!.mock.calls[0]?.[1]).toBe(OWNER_ID); // konfigurasjonens eier, aldri en kropp
  });

  it("«på vegne av»: signert økt kreves KUN når on_behalf_of er satt (liste, element, hendelse), og uten den nås tjenesten ikke", async () => {
    const cases: Array<{ path: string; body: Record<string, unknown>; method: string }> = [
      { path: "list/create", body: { name: "L" }, method: "createList" },
      { path: "list/item/add", body: { list_id: "l-1", body: "x" }, method: "addListItem" },
      { path: "event/create", body: { title: "T", starts_at: WINDOW.from, ends_at: WINDOW.to }, method: "createEvent" }
    ];
    for (const c of cases) {
      const plain = harness({ path: c.path, body: c.body, stepUp: "step_up_required:signed_device_session" });
      await handlePersonalRoute(plain.ctx);
      expect(plain.calls, c.path).toEqual(["authed", c.method]); // eget navn: ingen step-up
      const delegated = harness({ path: c.path, body: { ...c.body, on_behalf_of: "p-principal" }, stepUp: "step_up_required:signed_device_session" });
      await handlePersonalRoute(delegated.ctx);
      expect(delegated.calls, c.path).toEqual(["authed", "stepUp"]);
      expect(delegated.responses[0]?.status).toBe(403);
      const signed = harness({ path: c.path, body: { ...c.body, on_behalf_of: "p-principal" } });
      await handlePersonalRoute(signed.ctx);
      expect(signed.calls, c.path).toEqual(["authed", "stepUp", c.method]);
      expect((signed.service[c.method]!.mock.calls[0]?.[c.method === "addListItem" ? 2 : 1] as Record<string, unknown>)["on_behalf_of"]).toBe("p-principal");
    }
  });

  it("ugyldig grant: ingenting skjer; ikke-boolsk `all_day` avvises (invalid_input) før tjenesten", async () => {
    const noGrant = harness({ path: "circle", authed: false });
    expect(await handlePersonalRoute(noGrant.ctx)).toBe(true);
    expect(noGrant.calls).toEqual(["authed"]);
    expect(noGrant.responses).toEqual([]);
    const bad = harness({ path: "event/create", body: { title: "T", starts_at: WINDOW.from, ends_at: WINDOW.to, all_day: "yes" } });
    await handlePersonalRoute(bad.ctx);
    expect(bad.service["createEvent"]).not.toHaveBeenCalled();
    expect(bad.responses).toEqual([{ status: 400, body: { error: "family_rejected", reason: "invalid_input", request_id: "req-1" } }]);
  });

  it("rutene finnes ikke uten `deps.family`, for andre metoder eller andre stier (-> false = 404 hos kalleren)", async () => {
    expect(await handlePersonalRoute(harness({ path: "circle", family: false }).ctx)).toBe(false);
    const get = harness({ path: "circle", method: "GET" });
    expect(await handlePersonalRoute(get.ctx)).toBe(false);
    expect(get.calls).toEqual([]);
    expect(await handlePersonalRoute(harness({ path: "nuke" }).ctx)).toBe(false);
    expect(await handlePersonalRoute(harness({ path: "circle/extra" }).ctx)).toBe(false);
  });
});

describe("C: feilkoder, generisk feil og merking av ubetrodd innhold", () => {
  it("hver FamilyErrorCode har en statuskode (400/403/404/409/503), og ruten viser KUN koden som `reason`", async () => {
    expect(Object.keys(FAMILY_STATUS).sort()).toEqual([...FAMILY_ERROR_CODES].sort());
    for (const code of FAMILY_ERROR_CODES) {
      const h = harness({ path: "circle", fail: new FamilyError(code, "detalj-som-ikke-skal-vises") });
      await handlePersonalRoute(h.ctx);
      expect(h.responses).toEqual([{ status: FAMILY_STATUS[code], body: { error: "family_rejected", reason: code, request_id: "req-1" } }]);
      expect([400, 403, 404, 409, 503]).toContain(FAMILY_STATUS[code]);
      expect(JSON.stringify(h.responses)).not.toContain("detalj");
    }
    expect(FAMILY_STATUS.share_required).toBe(403); // alle deling-avslag er samme svar
  });

  it("alt annet er generisk (500 `family_failed`), uten feiltekst", async () => {
    const h = harness({ path: "circle", fail: new Error("pg: password authentication failed for hemmelig-bruker") });
    await handlePersonalRoute(h.ctx);
    expect(h.responses).toEqual([{ status: 500, body: { error: "family_failed", generic: true } }]);
    expect(JSON.stringify(h.responses)).not.toContain("hemmelig");
  });

  it("tekst skrevet av mennesker (lister, elementer, hendelser) leveres merket ubetrodd; en annens delte data merkes avledet - aldri som instruks", async () => {
    for (const path of ["lists", "list/items", "list/create", "list/item/add", "list/item/done", "events", "event/create", "event/cancel"]) {
      const c = CASES.find((x) => x.path === path)!;
      const h = harness({ path, body: c.body });
      await handlePersonalRoute(h.ctx);
      expect(h.responses[0]?.body["content_trust"], path).toBe("untrusted_user_content");
    }
    const c = CASES.find((x) => x.path === "shared/read")!;
    const h = harness({ path: "shared/read", body: c.body });
    await handlePersonalRoute(h.ctx);
    expect(h.responses[0]?.body["output_trust"]).toBe("derived_personal_data");
  });
});

describe("D: lesere - minimering og lokal midnatt", () => {
  it("startOfLocalDayMs: vinter, sommer og de to sommertid-skiftedagene (forskyvningen måles ved midnatt, ikke «nå»)", () => {
    const at = (iso: string) => new Date(startOfLocalDayMs(new Date(iso), "Europe/Oslo")).toISOString();
    expect(at("2026-11-18T10:30:00Z")).toBe("2026-11-17T23:00:00.000Z"); // UTC+1
    expect(at("2026-07-15T10:00:00Z")).toBe("2026-07-14T22:00:00.000Z"); // UTC+2
    expect(at("2026-03-29T12:00:00Z")).toBe("2026-03-28T23:00:00.000Z"); // sommertid begynner 02:00 -> midnatt var fortsatt UTC+1
    expect(at("2026-10-25T12:00:00Z")).toBe("2026-10-24T22:00:00.000Z"); // sommertid slutter 03:00 -> midnatt var UTC+2
    expect(at("2026-11-18T23:30:00Z")).toBe("2026-11-18T23:00:00.000Z"); // 00:30 lokal tid neste dag
    expect(new Date(startOfLocalDayMs(new Date("2026-06-01T05:00:00Z"), "UTC")).toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  const location = (visits: Array<{ zone_id: string; entered_at: unknown }>, zones: Record<string, string>) => ({
    listZoneVisits: vi.fn(async () => visits),
    getZone: vi.fn(async (_t: string, _s: "personal", id: string) => (zones[id] === undefined ? null : ({ name: zones[id] as string, center_lat: 59.9, center_lon: 10.7 } as { name: string })))
  });
  const NOW = new Date("2026-11-18T10:30:00Z");

  it("lokasjon: KUN sonenavn og innreisetidspunkt (aldri koordinater); ingen åpen sone eller ukjent sone = null; leser kun åpne besøk i personlig rom", async () => {
    const loc = location([{ zone_id: "z-1", entered_at: new Date("2026-11-18T08:00:00Z") }], { "z-1": "Hjemme" });
    const readers = familySharedDataReaders({ location: loc, health: { getRecentMetrics: async () => [] }, now: () => NOW });
    expect(await readers.currentPlace("t-data", "p-adult")).toEqual({ zone_name: "Hjemme", observed_at: "2026-11-18T08:00:00.000Z" });
    expect(loc.listZoneVisits).toHaveBeenCalledWith("t-data", "personal", "p-adult", { open_only: true });
    expect(JSON.stringify(await readers.currentPlace("t-data", "p-adult"))).not.toMatch(/59\.9|10\.7|lat|lon/);
    expect(await familySharedDataReaders({ location: location([], {}), health: { getRecentMetrics: async () => [] } }).currentPlace("t", "p")).toBeNull();
    expect(await familySharedDataReaders({ location: location([{ zone_id: "z-x", entered_at: "2026-11-18T08:00:00Z" }], {}), health: { getRecentMetrics: async () => [] } }).currentPlace("t", "p")).toBeNull();
  });

  it("helse: skritt i dag = sum siden lokal midnatt, søvn = nyeste måling siste 36 t, ingen data = null (aldri 0), råverdier som puls/vekt leses ikke engang", async () => {
    const getRecentMetrics = vi.fn(async (_t: string, _p: string, metric?: string) => {
      if (metric === "steps") return [{ metric_type: "steps", value: 1200, observed_at: "2026-11-18T07:00:00Z" }, { metric_type: "steps", value: 3000.4, observed_at: new Date("2026-11-18T09:00:00Z") }];
      return [{ metric_type: "sleep_duration_minutes", value: 400, observed_at: "2026-11-17T06:30:00Z" }, { metric_type: "sleep_duration_minutes", value: 431.6, observed_at: "2026-11-18T05:45:00Z" }];
    });
    const readers = familySharedDataReaders({ location: location([], {}), health: { getRecentMetrics }, now: () => NOW });
    expect(await readers.healthSummary("t-data", "p-adult")).toEqual({ steps_today: 4200, sleep_minutes_last_night: 432, observed_at: "2026-11-18T09:00:00.000Z" });
    expect(getRecentMetrics).toHaveBeenCalledWith("t-data", "p-adult", "steps", Date.parse("2026-11-17T23:00:00Z"));
    expect(getRecentMetrics).toHaveBeenCalledWith("t-data", "p-adult", "sleep_duration_minutes", NOW.getTime() - 36 * 3_600_000);
    expect(getRecentMetrics.mock.calls.map((c) => c[2]).sort()).toEqual(["sleep_duration_minutes", "steps"]); // aldri heart_rate/weight_kg

    expect(await familySharedDataReaders({ location: location([], {}), health: { getRecentMetrics: async () => [] }, now: () => NOW }).healthSummary("t", "p")).toBeNull();
    const onlySleep = familySharedDataReaders({ location: location([], {}), health: { getRecentMetrics: async (_t, _p, m) => (m === "sleep_duration_minutes" ? [{ metric_type: m, value: 300, observed_at: "2026-11-18T05:00:00Z" }] : []) }, now: () => NOW });
    expect(await onlySleep.healthSummary("t", "p")).toEqual({ steps_today: null, sleep_minutes_last_night: 300, observed_at: "2026-11-18T05:00:00.000Z" });
    // `numeric`-kolonner kommer som strenger fra pg: rene desimalstrenger godtas, alt annet forkastes.
    const strings = familySharedDataReaders({
      location: location([], {}), now: () => NOW,
      health: { getRecentMetrics: async (_t, _p, m) => (m === "steps" ? [{ metric_type: "steps", value: "1200", observed_at: "2026-11-18T07:00:00Z" }, { metric_type: "steps", value: "3000.5", observed_at: "2026-11-18T08:00:00Z" }, { metric_type: "steps", value: "1e3", observed_at: "2026-11-18T08:30:00Z" }] : []) }
    });
    expect(await strings.healthSummary("t", "p")).toEqual({ steps_today: 4201, sleep_minutes_last_night: null, observed_at: "2026-11-18T08:00:00.000Z" });
    const junk = familySharedDataReaders({ location: location([], {}), health: { getRecentMetrics: async () => [{ metric_type: "steps", value: "mange", observed_at: "i går" }] }, now: () => NOW });
    expect(await junk.healthSummary("t", "p")).toBeNull();
  });
});
