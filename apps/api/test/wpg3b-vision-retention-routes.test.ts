import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { DEFAULT_RETENTION_DAYS, DEFAULT_SNAPSHOT_RETENTION_DAYS, MAX_RETENTION_DAYS, MAX_SNAPSHOT_RETENTION_DAYS, MIN_RETENTION_DAYS, VisionService } from "@jarvis/vision";
import { seedTenant, startVisionDb, type VisionDb } from "../../../modules/vision/test/support/harness.ts";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-G3b (D-485), K1: `POST /vision/retention/get` (eier-LES) og `POST /vision/retention/set` (eier-SKRIV) over HTTP mot en ekte Postgres (app-rolle, RLS), gjennom den EKTE serveren:
 * dormant (404), grant -> eier -> step-up-rekkefølgen, stabile feilkoder (aldri frie tekster), typet bekreftelse KUN for forkorting, idempotent gjenspilling, revisjon uten innhold og isolasjon mellom space og tenant.
 */
let db: VisionDb;
let T: Awaited<ReturnType<typeof seedTenant>>;
let T2: Awaited<ReturnType<typeof seedTenant>>;
let vision: VisionService;
let url = "";
let urlNoRetention = "";
let urlDormant = "";
let urlLeaky = "";
const closers: Array<() => Promise<void>> = [];

type Grant = { person_id: string; tenant_id: string; channel: string; auth_strength: string; session_id: string; memory_space: string; device_id: string };
const grants = new Map<string, Grant>();
const OWNER_ID = (identity: IdentityContext): boolean =>
  identity.delegation_id === undefined && ((identity.person_id === T.owner && identity.tenant_id === T.tenant) || (identity.person_id === T2.owner && identity.tenant_id === T2.tenant));
const grant = (over: Partial<Grant> = {}): Grant => ({ person_id: T.owner, tenant_id: T.tenant, channel: "web", auth_strength: "signed", session_id: "s-owner", memory_space: "home", device_id: "web-owner", ...over });

/** En tjeneste hvis visning/endring bærer FLERE felt enn ruten skal gi videre (en fremtidig kolonne, en lekkasje): ruten må bygge svaret eksplisitt. */
const LEAKY_VIEW = { configured: true, retention_days: 12, snapshot_retention_days: 4, effective_snapshot_retention_days: 4, updated_at: "2026-11-20T10:00:00.000Z", tenant_id: "tenant-lekkasje", actor_person_id: "person-lekkasje", memory_space_id: "home-lekkasje", note: "hemmelig-lekkasje" };
const leakyService = {
  getRetentionView: async () => LEAKY_VIEW,
  applyRetentionPolicy: async () => ({ changed: true, shortened: { retention_days: false, snapshot_retention_days: false }, previous: LEAKY_VIEW, current: LEAKY_VIEW })
};

function makeDeps(mode: "full" | "no_retention" | "dormant" | "leaky"): ApiDeps {
  return {
    grants: { verify: async (token: string) => (grants.has(token) ? { ok: true, grant: grants.get(token) } : { ok: false, reason: "grant_invalid" }) },
    identity: { resolveIdentity: async (i: Record<string, string>) => ({ ok: true, identity: { ...i, memory_space_id: i["memory_space"] } }) },
    owner: { tenant_id: T.tenant, person_id: T.owner },
    ownerGate: OWNER_ID,
    ...(mode !== "dormant"
      ? { vision: { cameras: {}, capture: {}, lastSeen: {}, inventory: {}, maxUploadBytes: 64 * 1024, ...(mode === "full" ? { retention: vision } : mode === "leaky" ? { retention: leakyService } : {}) } }
      : {})
  } as unknown as ApiDeps;
}

async function listen(deps: ApiDeps): Promise<string> {
  const server = createApiServer(deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  db = await startVisionDb("g3bretr");
  T = await seedTenant(db, "g3br-t1");
  T2 = await seedTenant(db, "g3br-t2");
  vision = new VisionService(db.app);
  grants.set("owner-signed", grant());
  grants.set("owner-signed-personal", grant({ memory_space: "personal", session_id: "s-owner-p" }));
  grants.set("owner-active", grant({ auth_strength: "active", session_id: "s-active" }));
  grants.set("owner-voice", grant({ channel: "voice", session_id: "s-voice" }));
  grants.set("other-signed", grant({ person_id: T.other, session_id: "s-other", device_id: "web-other" }));
  grants.set("owner2-signed", grant({ person_id: T2.owner, tenant_id: T2.tenant, session_id: "s-owner2", device_id: "web-owner2" }));
  url = await listen(makeDeps("full"));
  urlNoRetention = await listen(makeDeps("no_retention"));
  urlDormant = await listen(makeDeps("dormant"));
  urlLeaky = await listen(makeDeps("leaky"));
}, 240_000);

afterAll(async () => {
  for (const c of closers) await c();
  await db?.stop();
}, 120_000);

beforeEach(async () => {
  await db.admin.query(`DELETE FROM vision_retention_policies WHERE tenant_id = ANY($1::text[])`, [[T.tenant, T2.tenant]]);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- testens svar-JSON er bevisst løst typet
type Json = Record<string, any>;
const post = (base: string, path: string, body: unknown): Promise<Response> => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const call = async (path: string, token: string, body: Record<string, unknown> = {}, base = url): Promise<{ status: number; body: Json; text: string }> => {
  const res = await post(base, path, { grant_token: token, ...body });
  const text = await res.text();
  let parsed: Json = {};
  try { parsed = JSON.parse(text) as Json; } catch { /* ikke JSON */ }
  return { status: res.status, body: parsed, text };
};
const get = (token = "owner-signed", base = url) => call("/vision/retention/get", token, {}, base);
const set = (body: Record<string, unknown>, token = "owner-signed", base = url) => call("/vision/retention/set", token, body, base);
const row = async (tenant = T.tenant, space = "home"): Promise<Json | undefined> =>
  (await db.admin.query(`SELECT retention_days, snapshot_retention_days, actor_person_id, updated_at FROM vision_retention_policies WHERE tenant_id = $1 AND memory_space_id = $2`, [tenant, space])).rows[0] as Json | undefined;
const auditCount = async (tenant = T.tenant): Promise<number> => ((await db.admin.query(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND type = 'vision.retention_set'`, [tenant])).rows[0] as { n: number }).n;
const DEFAULT_VIEW = { configured: false, retention_days: 30, snapshot_retention_days: null, effective_snapshot_retention_days: 7, updated_at: null };
const STATIC_PART = {
  defaults: { retention_days: 30, snapshot_retention_days: 7 },
  limits: { retention_days: { min: 1, max: 365 }, snapshot_retention_days: { min: 1, max: 90 } },
  applies_to: "new_records"
};

describe("dormant og ikke-koblet: 404 uten deps.vision, 503 uten retensjonstjenesten (aldri en stille standard)", () => {
  it("uten deps.vision finnes ingen av de to rutene (404 selv med gyldig eier-grant) - identisk med main; feil metode gir også 404", async () => {
    for (const path of ["/vision/retention/get", "/vision/retention/set"]) {
      expect((await post(urlDormant, path, { grant_token: "owner-signed", retention_days: 30, snapshot_retention_days: null })).status, path).toBe(404);
      expect((await fetch(`${url}${path}`)).status, `GET ${path}`).toBe(404);
      expect((await fetch(`${url}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status, `PUT ${path}`).toBe(404);
    }
    expect((await post(url, "/vision/retention", { grant_token: "owner-signed" })).status).toBe(404);
    expect((await post(url, "/vision/retention/get/extra", { grant_token: "owner-signed" })).status).toBe(404);
    expect((await post(url, "/vision/retention/delete", { grant_token: "owner-signed" })).status).toBe(404);
  });

  it("deps.vision uten `retention`: begge rutene gir 503 `retention_unavailable` for eieren (etter grant, eier og step-up) - en annen person får 403 før det", async () => {
    expect(await get("owner-signed", urlNoRetention)).toMatchObject({ status: 503, body: { error: "retention_unavailable" } });
    expect(await set({ retention_days: 30, snapshot_retention_days: null }, "owner-signed", urlNoRetention)).toMatchObject({ status: 503, body: { error: "retention_unavailable" } });
    expect((await get("other-signed", urlNoRetention)).status).toBe(403);
    expect((await set({ retention_days: 30, snapshot_retention_days: null }, "other-signed", urlNoRetention)).status).toBe(403);
    expect((await set({ retention_days: 30, snapshot_retention_days: null }, "owner-active", urlNoRetention)).status).toBe(403); // step-up først
  });
});

describe("kropp, grant, eier og step-up - alt avvises FØR noe leses eller skrives", () => {
  it("uten grant 401; ugyldig grant 403; identitetsfelt og ukjente felt 400 (også `retention_days` på get, som ikke tar felt)", async () => {
    for (const path of ["/vision/retention/get", "/vision/retention/set"]) {
      expect((await post(url, path, {})).status, path).toBe(401);
      expect((await call(path, "bogus")).status, path).toBe(403);
      for (const field of ["person_id", "tenant_id", "memory_space", "memory_space_id", "device_id", "session_id", "channel", "auth_strength"]) {
        const res = await call(path, "owner-signed", { [field]: "x" });
        expect(res.status, `${path} ${field}`).toBe(400);
        expect(res.body["error"]).toBe("identity_field_forbidden");
      }
      expect((await call(path, "owner-signed", { surprise: 1 })).status, path).toBe(400);
    }
    expect((await call("/vision/retention/get", "owner-signed", { retention_days: 30 })).body).toMatchObject({ error: "malformed_request", reason: "unknown_field" });
    expect((await post(url, "/vision/retention/set", [])).status).toBe(400);
    expect(await row()).toBeUndefined();
    expect(await auditCount()).toBe(0);
  });

  it("en annen person i samme tenant får 403 owner_required på begge, og kan ikke se eller endre noe", async () => {
    for (const [path, body] of [["/vision/retention/get", {}], ["/vision/retention/set", { retention_days: 30, snapshot_retention_days: null }]] as const) {
      const res = await call(path, "other-signed", body);
      expect(res.status, path).toBe(403);
      expect(res.body["error"], path).toBe("owner_required");
    }
    expect(await row()).toBeUndefined();
  });

  it("skriving krever step-up (signert enhetsøkt fra en eier-kanal): active-økt og talekanal -> 403 og ingenting skrives; lesing fungerer med active", async () => {
    const body = { retention_days: 40, snapshot_retention_days: null };
    expect(await set(body, "owner-active")).toMatchObject({ status: 403, body: { error: "step_up_required", reason: "step_up_required:signed_device_session" } });
    expect((await set(body, "owner-voice")).body["reason"]).toBe("step_up_required:channel_voice_not_allowed");
    expect(await row()).toBeUndefined();
    expect(await auditCount()).toBe(0);
    expect((await get("owner-active")).status).toBe(200);
    expect((await get("owner-voice")).status).toBe(200);
    expect((await set(body)).status).toBe(200); // kontroll: med step-up går det igjennom
  });
});

describe("get: gjeldende vinduer (standardene når ingenting er satt)", () => {
  it("uten rad: standardene, `configured: false`, de faste grensene og `applies_to` - og BARE de feltene (ingen tenant, aktør eller rom)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { retention: { ...DEFAULT_VIEW, ...STATIC_PART, memory_space: "home" } } });
    expect(Object.keys(res.body["data"]["retention"]).sort()).toEqual(["applies_to", "configured", "defaults", "effective_snapshot_retention_days", "limits", "memory_space", "retention_days", "snapshot_retention_days", "updated_at"]);
    // grensene i svaret er de samme som koden bruker
    expect(STATIC_PART.defaults).toEqual({ retention_days: DEFAULT_RETENTION_DAYS, snapshot_retention_days: DEFAULT_SNAPSHOT_RETENTION_DAYS });
    expect(STATIC_PART.limits).toEqual({ retention_days: { min: MIN_RETENTION_DAYS, max: MAX_RETENTION_DAYS }, snapshot_retention_days: { min: MIN_RETENTION_DAYS, max: MAX_SNAPSHOT_RETENTION_DAYS } });
  });

  it("med rad (satt utenom ruten, f.eks. via tjenesten): leses uendret, `updated_at` er ISO, og et lengre bildevindu enn hendelsene vises som det EFFEKTIVE", async () => {
    await vision.setRetentionPolicy(T.tenant, "home", { retention_days: 5, snapshot_retention_days: 9, actor_person_id: T.owner }); // direkte i tjenesten: ingen grense, ingen revisjon
    const res = await get();
    expect(res.body["data"]["retention"]).toMatchObject({ configured: true, retention_days: 5, snapshot_retention_days: 9, effective_snapshot_retention_days: 5 });
    expect(new Date(res.body["data"]["retention"]["updated_at"] as string).toISOString()).toBe(res.body["data"]["retention"]["updated_at"]);
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`${T.tenant}|${T.owner}|actor_person_id|tenant_id`));
  });
});

describe("get/set oppgir hvilket space svaret gjelder (grantets eget space - aldri tenant eller person)", () => {
  it("`memory_space` er grantets space på get og set, og et annet space-grant får sitt eget; en tjeneste hvis rad bærer et annet rom (`memory_space_id`) kan ikke endre det ruten sier", async () => {
    expect((await get()).body["data"]["retention"]["memory_space"]).toBe("home");
    expect((await get("owner-signed-personal")).body["data"]["retention"]["memory_space"]).toBe("personal");
    const written = await set({ retention_days: 40, snapshot_retention_days: null }, "owner-signed-personal");
    expect(written.status, written.text).toBe(200);
    expect(written.body["data"]["retention"]["memory_space"]).toBe("personal");
    expect(await row(T.tenant, "personal")).toMatchObject({ retention_days: 40 }); // raden ligger i det spacet svaret sier
    expect(await row(T.tenant, "home")).toBeUndefined();
    expect((await get("owner-signed", urlLeaky)).body["data"]["retention"]["memory_space"]).toBe("home"); // LEAKY_VIEW.memory_space_id = "home-lekkasje"
    const leaky = await set({ retention_days: 12, snapshot_retention_days: 4 }, "owner-signed", urlLeaky);
    expect(leaky.body["data"]["retention"]["memory_space"]).toBe("home");
    expect(leaky.text).not.toMatch(/lekkasje/);
  });
});

describe("set: eierens setting (PUT med absolutte verdier)", () => {
  it("happy path: 200 med den nye tilstanden; aktør kommer fra GRANTET (aldri kroppen), get gir det samme, og tjenestens egen lesing (den G4 leser) ser verdien", async () => {
    const res = await set({ retention_days: 60, snapshot_retention_days: 14 });
    expect(res.status, res.text).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["data"]).toMatchObject({ changed: true, shortened: [], retention: { configured: true, retention_days: 60, snapshot_retention_days: 14, effective_snapshot_retention_days: 14, ...STATIC_PART } });
    expect((await get()).body["data"]["retention"]).toEqual(res.body["data"]["retention"]);
    expect(await row()).toMatchObject({ retention_days: 60, snapshot_retention_days: 14, actor_person_id: T.owner });
    expect((await vision.getRetentionPolicy(T.tenant, "home"))?.retention_days).toBe(60);
  });

  it("revisjon: nøyaktig én rad med aktør, sesjon og enhet fra grantet, `task_id` og kun tall/enums i nyttelasten (ingen tenant- eller personnavn, ingen innhold)", async () => {
    const before = await auditCount();
    await set({ retention_days: 90, snapshot_retention_days: null });
    expect(await auditCount()).toBe(before + 1);
    const audit = (await db.admin.query(`SELECT person_id, session_id, device_id, decision, tool_id, action, task_id, payload FROM audit_events WHERE tenant_id = $1 AND type = 'vision.retention_set' ORDER BY audit_id DESC LIMIT 1`, [T.tenant])).rows[0] as Json;
    expect(audit).toMatchObject({ person_id: T.owner, session_id: "s-owner", device_id: "web-owner", decision: "ALLOW", tool_id: "vision", action: "retention_set", task_id: "vision-api:retention_set" });
    expect(audit["payload"]).toEqual({
      memory_space: "home", previous_configured: false, previous_retention_days: 30, previous_snapshot_retention_days: null,
      retention_days: 90, snapshot_retention_days: null, effective_snapshot_retention_days: 7, shortened: [], confirmed: false
    });
    expect(JSON.stringify(audit["payload"])).not.toContain(T.tenant);
    expect(JSON.stringify(audit["payload"])).not.toContain(T.owner);
  });

  it("idempotent gjenspilling: samme forespørsel to ganger gir `changed: false` uten ny skriving, uten ny revisjonsrad og med uendret `updated_at`", async () => {
    const first = await set({ retention_days: 45, snapshot_retention_days: 10 });
    expect(first.body["data"]["changed"]).toBe(true);
    const rowBefore = await row();
    const auditBefore = await auditCount();
    for (let i = 0; i < 3; i += 1) {
      const again = await set({ retention_days: 45, snapshot_retention_days: 10 });
      expect(again.status).toBe(200);
      expect(again.body["data"]).toMatchObject({ changed: false, shortened: [] });
      expect(again.body["data"]["retention"]).toEqual(first.body["data"]["retention"]);
    }
    expect(await row()).toEqual(rowBefore);
    expect(await auditCount()).toBe(auditBefore);
    // en annen nyttelast er en ny forespørsel (ingen nøkkel som kan kollidere): den utføres
    expect((await set({ retention_days: 46, snapshot_retention_days: 10 })).body["data"]["changed"]).toBe(true);
  });

  it("`snapshot_retention_days: null` betyr eksplisitt standard (7); begge feltene må oppgis - et utelatt felt nullstiller aldri noe stille", async () => {
    await set({ retention_days: 100, snapshot_retention_days: 20 });
    const missing = await set({ retention_days: 100 });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: "vision_validation", field: "snapshot_retention_days", detail: "required" });
    expect(await row()).toMatchObject({ retention_days: 100, snapshot_retention_days: 20 }); // urørt
    const reset = await set({ retention_days: 100, snapshot_retention_days: null, confirm: true, confirm_memory_space: "home" }); // 20 -> standard 7 forkorter bildene
    expect(reset.status).toBe(200);
    expect(reset.body["data"]["retention"]).toMatchObject({ snapshot_retention_days: null, effective_snapshot_retention_days: 7 });
  });
});

describe("validering: 400 `vision_validation` med feltnavn og stabil kode (aldri en fri feiltekst), og ingenting skrives", () => {
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ["begge mangler", {}, "retention_days", "required"],
    ["hendelsesvindu mangler", { snapshot_retention_days: null }, "retention_days", "required"],
    ["bildevindu mangler", { retention_days: 30 }, "snapshot_retention_days", "required"],
    ["streng", { retention_days: "30", snapshot_retention_days: null }, "retention_days", "not_integer"],
    ["flyttall", { retention_days: 30.5, snapshot_retention_days: null }, "retention_days", "not_integer"],
    ["null som hendelsesvindu", { retention_days: null, snapshot_retention_days: null }, "retention_days", "not_integer"],
    ["boolsk", { retention_days: true, snapshot_retention_days: null }, "retention_days", "not_integer"],
    ["objekt", { retention_days: { days: 30 }, snapshot_retention_days: null }, "retention_days", "not_integer"],
    ["null-dager", { retention_days: 0, snapshot_retention_days: null }, "retention_days", "below_min"],
    ["negativ", { retention_days: -5, snapshot_retention_days: null }, "retention_days", "below_min"],
    ["366 dager", { retention_days: 366, snapshot_retention_days: null }, "retention_days", "above_max"],
    ["urimelig stort", { retention_days: 1e15, snapshot_retention_days: null }, "retention_days", "above_max"],
    ["bildevindu streng", { retention_days: 30, snapshot_retention_days: "7" }, "snapshot_retention_days", "not_integer"],
    ["bildevindu 0", { retention_days: 30, snapshot_retention_days: 0 }, "snapshot_retention_days", "below_min"],
    ["bildevindu 91", { retention_days: 365, snapshot_retention_days: 91 }, "snapshot_retention_days", "above_max"],
    ["bildevindu lengre enn hendelsene", { retention_days: 10, snapshot_retention_days: 11 }, "snapshot_retention_days", "exceeds_retention_days"]
  ];
  for (const [name, body, field, detail] of cases) {
    it(name, async () => {
      const before = await auditCount();
      const res = await set(body);
      expect(res.status, res.text).toBe(400);
      expect(res.body).toMatchObject({ error: "vision_validation", field, detail });
      expect(typeof res.body["request_id"]).toBe("string");
      expect(Object.keys(res.body).sort()).toEqual(["detail", "error", "field", "request_id"]);
      // bekreftelse redder ikke en ugyldig forespørsel
      expect((await set({ ...body, confirm: true, confirm_memory_space: "home" })).status).toBe(400);
      expect(await row()).toBeUndefined();
      expect(await auditCount()).toBe(before);
    });
  }

  it("grensene er skarpe: 1/1 og 365/90 godtas", async () => {
    expect((await set({ retention_days: 365, snapshot_retention_days: 90 })).status).toBe(200);
    expect((await set({ retention_days: 1, snapshot_retention_days: 1, confirm: true, confirm_memory_space: "home" })).status).toBe(200);
    expect(await row()).toMatchObject({ retention_days: 1, snapshot_retention_days: 1 });
  });
});

describe("typet bekreftelse KUN for forkorting (effektivt kortere hendelses- eller bildevindu)", () => {
  beforeEach(async () => {
    expect((await set({ retention_days: 60, snapshot_retention_days: 14 })).status).toBe(200);
  });

  it("forkorting uten bekreftelse: 409 `confirmation_required` med hvilke vinduer det gjelder og ekkoet som kreves - ingenting skrives, ingen revisjonsrad", async () => {
    const before = { row: await row(), audit: await auditCount() };
    const res = await set({ retention_days: 20, snapshot_retention_days: 14 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "confirmation_required", reason: "confirm_true_and_confirm_memory_space_required", shortened: ["retention_days"], confirm_memory_space_required: "home" });
    expect(typeof res.body["request_id"]).toBe("string");
    expect((await set({ retention_days: 60, snapshot_retention_days: 3 })).body["shortened"]).toEqual(["snapshot_retention_days"]);
    expect((await set({ retention_days: 5, snapshot_retention_days: null })).body["shortened"]).toEqual(["retention_days", "snapshot_retention_days"]);
    expect(await row()).toEqual(before.row);
    expect(await auditCount()).toBe(before.audit);
  });

  it("halv eller feil bekreftelse godtas ikke: bare `confirm`, bare ekko, feil ekko (annet space, annen tekst), `confirm` som streng/tall, ekko som ikke er en streng", async () => {
    const body = { retention_days: 20, snapshot_retention_days: 14 };
    for (const extra of [
      { confirm: true }, { confirm_memory_space: "home" }, { confirm: true, confirm_memory_space: "personal" }, { confirm: true, confirm_memory_space: "HOME" }, { confirm: true, confirm_memory_space: " home" },
      { confirm: "true", confirm_memory_space: "home" }, { confirm: 1, confirm_memory_space: "home" }, { confirm: false, confirm_memory_space: "home" }, { confirm: true, confirm_memory_space: ["home"] }, { confirm: true, confirm_memory_space: null }
    ]) {
      expect((await set({ ...body, ...extra })).status, JSON.stringify(extra)).toBe(409);
    }
    expect(await row()).toMatchObject({ retention_days: 60 });
  });

  it("riktig bekreftelse (`confirm: true` + `confirm_memory_space` = grantets space): forkortingen utføres, svaret sier hva som ble kortere, og revisjonen bærer `shortened` og `confirmed`", async () => {
    const res = await set({ retention_days: 20, snapshot_retention_days: 14, confirm: true, confirm_memory_space: "home" });
    expect(res.status, res.text).toBe(200);
    expect(res.body["data"]).toMatchObject({ changed: true, shortened: ["retention_days"], retention: { retention_days: 20, snapshot_retention_days: 14 } });
    const audit = (await db.admin.query(`SELECT payload FROM audit_events WHERE tenant_id = $1 AND type = 'vision.retention_set' ORDER BY audit_id DESC LIMIT 1`, [T.tenant])).rows[0] as { payload: Json };
    expect(audit.payload).toMatchObject({ previous_retention_days: 60, retention_days: 20, shortened: ["retention_days"], confirmed: true });
    // hendelsesvinduet 20 -> 5 klemmer også bildevinduet (effektivt 14 -> 5): begge navnene, i samme form som i 409-svaret og revisjonen
    const both = await set({ retention_days: 5, snapshot_retention_days: null, confirm: true, confirm_memory_space: "home" });
    expect(both.body["data"]).toMatchObject({ changed: true, shortened: ["retention_days", "snapshot_retention_days"], retention: { retention_days: 5, snapshot_retention_days: null, effective_snapshot_retention_days: 5 } });
  });

  it("ekkoet er grantets space: en eier-økt i et ANNET space må ekko sitt eget, og kan ikke bruke et annet space sin bekreftelse", async () => {
    expect((await set({ retention_days: 60, snapshot_retention_days: 14 }, "owner-signed-personal")).status).toBe(200);
    const denied = await set({ retention_days: 20, snapshot_retention_days: 14, confirm: true, confirm_memory_space: "home" }, "owner-signed-personal");
    expect(denied.status).toBe(409);
    expect(denied.body["confirm_memory_space_required"]).toBe("personal");
    expect((await set({ retention_days: 20, snapshot_retention_days: 14, confirm: true, confirm_memory_space: "personal" }, "owner-signed-personal")).status).toBe(200);
    expect(await row(T.tenant, "home")).toMatchObject({ retention_days: 60 }); // home er uberørt
  });

  it("forlengelse og uendret krever ingen bekreftelse, og en overflødig bekreftelse er ufarlig", async () => {
    expect((await set({ retention_days: 120, snapshot_retention_days: 14 })).status).toBe(200);
    expect((await set({ retention_days: 120, snapshot_retention_days: 30 })).status).toBe(200);
    expect((await set({ retention_days: 200, snapshot_retention_days: 30, confirm: true, confirm_memory_space: "home" })).body["data"]).toMatchObject({ changed: true, shortened: [] });
    const audit = (await db.admin.query(`SELECT payload FROM audit_events WHERE tenant_id = $1 AND type = 'vision.retention_set' ORDER BY audit_id DESC LIMIT 1`, [T.tenant])).rows[0] as { payload: Json };
    expect(audit.payload).toMatchObject({ shortened: [], confirmed: false }); // `confirmed` betyr «en forkorting ble bekreftet», ikke «klienten sendte confirm»
  });

  it("gjenspilling av en BEKREFTET forkorting er en no-op (raden er allerede kortere, ingen ny bekreftelse trengs); en gammel forespørsel etter en forlengelse er en ny forkorting og krever bekreftelse på nytt", async () => {
    const body = { retention_days: 20, snapshot_retention_days: 14, confirm: true, confirm_memory_space: "home" };
    expect((await set(body)).body["data"]["changed"]).toBe(true);
    expect((await set({ retention_days: 20, snapshot_retention_days: 14 })).body["data"]["changed"]).toBe(false); // også uten bekreftelse: ikke lenger en forkorting
    expect((await set(body)).body["data"]["changed"]).toBe(false);
    expect((await set({ retention_days: 80, snapshot_retention_days: 14 })).status).toBe(200); // forlenget
    expect((await set({ retention_days: 20, snapshot_retention_days: 14 })).status).toBe(409); // samme gamle nyttelast uten bekreftelse
  });
});

describe("isolasjon: space og tenant", () => {
  it("(tenant, space) er nøkkelen: en setting i `home` rører ikke `personal` eller en annen tenant, og hver eier ser kun sitt eget", async () => {
    expect((await set({ retention_days: 45, snapshot_retention_days: 10 })).status).toBe(200); // 7 -> 10 er en forlengelse (5 ville forkortet bildene)
    expect((await get("owner-signed-personal")).body["data"]["retention"]).toMatchObject({ configured: false, retention_days: 30 });
    expect((await get("owner2-signed")).body["data"]["retention"]).toMatchObject({ configured: false, retention_days: 30 });
    expect((await set({ retention_days: 200, snapshot_retention_days: 50 }, "owner2-signed")).status).toBe(200);
    expect((await get()).body["data"]["retention"]).toMatchObject({ retention_days: 45, snapshot_retention_days: 10 });
    expect((await get("owner2-signed")).body["data"]["retention"]).toMatchObject({ retention_days: 200, snapshot_retention_days: 50 });
    expect(await row(T.tenant, "home")).toMatchObject({ retention_days: 45, actor_person_id: T.owner });
    expect(await row(T2.tenant, "home")).toMatchObject({ retention_days: 200, actor_person_id: T2.owner });
    expect(await row(T.tenant, "personal")).toBeUndefined();
    expect(await auditCount(T2.tenant)).toBe(1);
  });

  it("ingen svar inneholder tenant-, person- eller aktørnavn", async () => {
    const texts = [(await get()).text, (await set({ retention_days: 33, snapshot_retention_days: 3 })).text, (await set({ retention_days: 1, snapshot_retention_days: 1 })).text, (await set({ retention_days: 0, snapshot_retention_days: 1 })).text];
    for (const text of texts) expect(text).not.toMatch(new RegExp(`${T.tenant}|${T.owner}|${T2.tenant}|actor_person_id|tenant_id|person_id`));
  });
});

describe("svaret bygges eksplisitt: kun de fem feltene + faste standarder/grenser, selv om tjenesten gir mer", () => {
  it("en tjeneste som returnerer ekstra felt (tenant, aktør, rom, notat) lekker ingenting gjennom get eller set", async () => {
    const WHITELIST = ["applies_to", "configured", "defaults", "effective_snapshot_retention_days", "limits", "memory_space", "retention_days", "snapshot_retention_days", "updated_at"];
    const read = await get("owner-signed", urlLeaky);
    expect(read.status).toBe(200);
    expect(Object.keys(read.body["data"]["retention"]).sort()).toEqual(WHITELIST);
    const written = await set({ retention_days: 12, snapshot_retention_days: 4 }, "owner-signed", urlLeaky);
    expect(written.status, written.text).toBe(200);
    expect(Object.keys(written.body["data"]).sort()).toEqual(["changed", "retention", "shortened"]);
    expect(Object.keys(written.body["data"]["retention"]).sort()).toEqual(WHITELIST);
    for (const text of [read.text, written.text]) expect(text).not.toMatch(/lekkasje|actor_person_id|tenant_id|memory_space_id|note/);
  });
});

describe("aldri et modellverktøy: eier-ruten er eneste vei til skriving av vinduene", () => {
  const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const sources = (): Array<{ file: string; code: string }> => {
    const out: Array<{ file: string; code: string }> = [];
    for (const base of ["apps/api/src", ...readdirSync(`${ROOT}modules`).map((m) => `modules/${m}/src`), ...readdirSync(`${ROOT}packages`).map((p) => `packages/${p}/src`)]) {
      let entries: string[] = [];
      try { entries = readdirSync(`${ROOT}${base}`, { recursive: true }) as string[]; } catch { continue; }
      for (const entry of entries) if (entry.endsWith(".ts")) out.push({ file: `${base}/${entry}`, code: strip(readFileSync(`${ROOT}${base}/${entry}`, "utf8")) });
    }
    return out;
  };

  it("`applyRetentionPolicy` er definert i tjenesten og kalt KUN fra eier-ruten; ingen verktøy, intent, transport eller annen kode skriver vinduene, og ruten finnes ikke utenfor vision-routes", () => {
    const all = sources();
    expect(all.length).toBeGreaterThan(300); // skanningen er ikke tom
    expect(all.filter((f) => f.code.includes("applyRetentionPolicy")).map((f) => f.file).sort()).toEqual(["apps/api/src/vision-routes.ts", "modules/vision/src/service.ts"]);
    expect(all.filter((f) => f.code.includes("vision.retention_set")).map((f) => f.file)).toEqual(["modules/vision/src/service.ts"]);
    expect(all.filter((f) => /\/vision\/retention\//.test(f.code)).map((f) => f.file)).toEqual(["apps/api/src/vision-routes.ts"]);
    expect(all.filter((f) => /setRetentionPolicy\(/.test(f.code) && /tool|intent|transport/i.test(f.file)).map((f) => f.file)).toEqual([]);
    // ingen modellvendt verktøydefinisjon nevner retensjonsruten eller de to tjenestemetodene
    expect(all.filter((f) => /(tool|intent|surface|capabilit)/i.test(f.file) && /(retention_set|retention_get|applyRetentionPolicy|getRetentionView)/.test(f.code)).map((f) => f.file)).toEqual([]);
  });

  it("den gamle `setRetentionPolicy` er merket `@internal` (omgår advisory-lås, typet bekreftelse, grenser og revisjon), og INGEN produksjonskode som bruker `@jarvis/vision` kaller den - `applyRetentionPolicy` via eier-ruten er eneste vei", () => {
    const raw = readFileSync(`${ROOT}modules/vision/src/service.ts`, "utf8");
    expect(raw.match(/async setRetentionPolicy\(/g)).toHaveLength(1);
    expect(raw).toMatch(/@internal(?:(?!\*\/)[\s\S])*\*\/\s*async setRetentionPolicy\(/); // @internal står i doc-kommentaren rett over metoden
    expect(raw).toMatch(/@internal(?:(?!\*\/)[\s\S])*omgår(?:(?!\*\/)[\s\S])*\*\/\s*async setRetentionPolicy\(/);
    const callers = sources().filter((f) => /\bsetRetentionPolicy\(/.test(f.code) && f.file !== "modules/vision/src/service.ts" && (/@jarvis\/vision/.test(f.code) || f.file.startsWith("modules/vision/src/")));
    expect(callers.map((f) => f.file)).toEqual([]);
  });

  it("ruten er `owner_write`/`owner_read` i rutetabellen (aldri `device`), og `confirm`-nøklene finnes bare på `set`", () => {
    const code = strip(readFileSync(`${ROOT}apps/api/src/vision-routes.ts`, "utf8"));
    expect(code).toContain('"/vision/retention/get": { access: "owner_read", action: "retention_get", keys: [] }');
    expect(code).toContain('"/vision/retention/set": { access: "owner_write", action: "retention_set", keys: ["retention_days", "snapshot_retention_days", "confirm", "confirm_memory_space"] }');
    expect(code.match(/confirm_memory_space/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
