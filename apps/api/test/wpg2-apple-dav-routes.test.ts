import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { AppleDavClient, DavError, parseDavCollections, type DavTransport } from "@jarvis/tool-gateway";
import { FakeDavServer, ics } from "../../../modules/tool-gateway/test/support/fake-dav-server.ts";
import { FORBIDDEN_IDENTITY_BODY_KEYS } from "../src/http-guard.ts";
import { DAV_ERROR_STATUS, DAV_ROUTES, type DavAuditEntry, type PersonalDavDeps } from "../src/personal-dav.ts";
import { handlePersonalRoute, type PersonalRouteContext } from "../src/personal-routes.ts";
import { createPersonalWiring } from "../src/personal-wiring.ts";

/**
 * WP-G2 (D-464) P2e: Apple-DAV-rutene. Funksjonelle bevis med spioner og en falsk DAV-server (ingen nettverk): eier-kun, step-up for hver mutasjon, revisjon FØR mutasjon, typet slettebekreftelse, utfall fra readback, og at samtalen ikke har noe verktøy.
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const owner: IdentityContext = { person_id: "p-owner", tenant_id: "t-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const CAL = "https://caldav.example.com/u1/cal/";
const { collections } = parseDavCollections(`calendar:privat=${CAL}`);

const openControls = { killSwitch: { isActiveDurable: async () => false }, ownerControls: { isRevokedDurable: async () => false } };

describe("A: flagg og wiring", () => {
  const base = { pool: {} as never, gateway: {} as never, controls: openControls };
  it("uten flagg finnes ingen DAV-avhengighet; kun `on` registrerer rutene, aldri et verktøy; ugyldige samlinger forkastes og telles; uten passord sendes ingenting (fail closed)", async () => {
    for (const value of [undefined, "", "true", "1", "ON"]) {
      const w = createPersonalWiring({ ...base, readSecret: async () => null, env: value === undefined ? {} : { JARVIS_PERSONAL_APPLE_DAV: value } });
      expect(w.deps?.dav, String(value)).toBeUndefined();
    }
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const w = createPersonalWiring({ ...base, readSecret: async () => null, env: { JARVIS_PERSONAL_APPLE_DAV: "on", JARVIS_PERSONAL_APPLE_DAV_ACCOUNTS: `calendar:privat=${CAL} calendar:ond=http://127.0.0.1/c/` } });
    expect(w.tools).toEqual([]);
    expect(w.describe()).toEqual({ msg: "personal_twin", apple_dav: { registered: true, collections: 1, rejected_entries: 1, live: "BLOCKED_EXTERNAL" } });
    expect(w.deps?.dav?.client.listCollections()).toEqual([{ name: "privat", kind: "calendar" }]);
    await expect(w.deps?.dav?.client.list("privat")).rejects.toMatchObject({ code: "dav_credentials_unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled(); // ingen nettkall uten credentials
    fetchSpy.mockRestore();
    expect(JSON.stringify(w.describe())).not.toContain("caldav.example.com"); // URL-er logges ikke
  });

  it("revisjonen skrives i grantets tenant med type `dav.mutation`, samling/UID/utfall og ALDRI innhold", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = { query: vi.fn(async (text: string, values: unknown[] = []) => { queries.push({ text, values }); return { rows: [], rowCount: 0 }; }), release: vi.fn() };
    const pool = { connect: async () => client } as never;
    const w = createPersonalWiring({ pool, gateway: {} as never, controls: openControls, readSecret: async () => null, env: { JARVIS_PERSONAL_APPLE_DAV: "on", JARVIS_PERSONAL_APPLE_DAV_ACCOUNTS: `calendar:privat=${CAL}` } });
    await w.deps?.dav?.audit(owner, { action: "create", collection: "privat", uid: "jarvis-abc", outcome: "SUCCESS" });
    const insert = queries.find((q) => q.text.includes("INSERT INTO audit_events"));
    expect(insert?.values).toEqual(expect.arrayContaining(["t-owner", "p-owner", "dav.mutation", "apple_dav", "create"]));
    const payload = JSON.parse(insert?.values.find((v) => typeof v === "string" && v.startsWith("{")) as string);
    expect(payload).toEqual({ collection: "privat", uid: "jarvis-abc", outcome: "SUCCESS", channel: "web" });
    expect(queries.some((q) => q.text.includes("set_config"))).toBe(true);
  });

  it("fiks-runde 2 (NY-4): en DENY-rad (forsøket stoppet av stoppkontrollene) skrives som `tool.denied` med årsaken og uten innhold; mutasjonssporet er uendret `dav.mutation`/ALLOW uten årsak", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = { query: vi.fn(async (text: string, values: unknown[] = []) => { queries.push({ text, values }); return { rows: [], rowCount: 0 }; }), release: vi.fn() };
    const pool = { connect: async () => client } as never;
    const w = createPersonalWiring({ pool, gateway: {} as never, controls: openControls, readSecret: async () => null, env: { JARVIS_PERSONAL_APPLE_DAV: "on", JARVIS_PERSONAL_APPLE_DAV_ACCOUNTS: `calendar:privat=${CAL}` } });
    const insertOf = () => queries.filter((q) => q.text.includes("INSERT INTO audit_events")).at(-1);
    const payloadOf = (q: { values: unknown[] } | undefined) => JSON.parse(q?.values.find((v) => typeof v === "string" && v.startsWith("{")) as string) as Record<string, unknown>;
    await w.deps?.dav?.audit(owner, { action: "update", collection: "privat", outcome: "blocked", decision: "DENY", reason: "kill_switch_active" });
    const denied = insertOf();
    expect(denied?.values).toEqual(expect.arrayContaining(["t-owner", "p-owner", "tool.denied", "DENY", "kill_switch_active", "apple_dav", "update"]));
    expect(denied?.values).not.toContain("dav.mutation");
    expect(payloadOf(denied)).toEqual({ collection: "privat", outcome: "blocked", channel: "web" }); // aldri innhold
    await w.deps?.dav?.audit(owner, { action: "create", collection: "privat", uid: "jarvis-abc", outcome: "SUCCESS" });
    const plain = insertOf();
    expect(plain?.values).toEqual(expect.arrayContaining(["dav.mutation", "ALLOW"]));
    expect(plain?.values).not.toContain("DENY");
    expect(plain?.values).not.toContain("tool.denied");
  });
});

describe("A2: stoppvakten - kill switch og credential-revokering stopper DAV (review B MEDIUM-1: rutene går utenom ToolGateway)", () => {
  const env = { JARVIS_PERSONAL_APPLE_DAV: "on", JARVIS_PERSONAL_APPLE_DAV_ACCOUNTS: `calendar:privat=${CAL}` };
  const wire = (controls: Parameters<typeof createPersonalWiring>[0]["controls"], readSecret: (ref: string) => Promise<string | null> = async () => "fake-secret") =>
    createPersonalWiring({ pool: {} as never, gateway: {} as never, readSecret, env, ...(controls ? { controls } : {}) });

  it("uten stoppkontroller registreres IKKE DAV-rutene (fail closed): eieren ville ikke kunnet stoppe dem", () => {
    const w = wire(undefined);
    expect(w.deps?.dav).toBeUndefined();
    expect(w.describe()).toEqual({ msg: "personal_twin", apple_dav: { registered: false, reason: "controls_missing" } });
  });

  it("kill switch aktiv: ingen nettkall og credentials leses ikke engang - for lesing, opprettelse, endring og sletting", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const secret = vi.fn(async () => "fake-secret");
    const w = wire({ killSwitch: { isActiveDurable: async () => true }, ownerControls: { isRevokedDurable: async () => false } }, secret);
    const client = w.deps!.dav!.client;
    const fields = { summary: "x", start: "2026-12-01T08:00:00Z" };
    for (const call of [() => client.list("privat"), () => client.get("privat", "uid-123456"), () => client.create("privat", "idem-key-0001", fields), () => client.update("privat", "uid-123456", '"e1"', { summary: "y" }), () => client.remove("privat", "uid-123456", '"e1"')]) {
      await expect(call()).rejects.toMatchObject({ code: "dav_kill_switch_active" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(secret).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("tilbakekalt credential (bruker ELLER app-passord): ingen nettkall; kun den tilbakekalte referansen stopper, og alle andre ref-er er upåvirket", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const ref of ["JARVIS_PERSONAL_APPLE_DAV_USER", "JARVIS_PERSONAL_APPLE_DAV_APP_PASSWORD"]) {
      const w = wire({ killSwitch: { isActiveDurable: async () => false }, ownerControls: { isRevokedDurable: async (r: string) => r === ref } });
      await expect(w.deps!.dav!.client.list("privat"), ref).rejects.toMatchObject({ code: "dav_credential_revoked" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("en vakt som feiler (database nede) er fail-closed `dav_guard_unavailable`: aldri «fortsett»", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const w = wire({ killSwitch: { isActiveDurable: async () => { throw new Error("db nede"); } }, ownerControls: { isRevokedDurable: async () => false } });
    await expect(w.deps!.dav!.client.list("privat")).rejects.toMatchObject({ code: "dav_guard_unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  const ALL_BODY = { collection: "privat", idempotency_key: "idem-key-0001", fields: { summary: "Hemmelig tittel", start: "2026-12-01T08:00:00Z" }, uid: "uid-123456", expected_etag: '"e1"', confirm_uid: "uid-123456" };
  const noContent = (v: unknown): void => { expect(JSON.stringify(v)).not.toMatch(/Hemmelig|idem-key|expected_etag|uid-123456|fields|summary/); };

  it("ruten: vakten FØR klienten (503 `dav_blocked`, ingen klientkall, ingen `requested`-rad) og nøyaktig ÉN DENY-rad med årsaken og uten innhold - for lesing, opprettelse og sletting og for alle tre årsakene; `collections` er lokal og påvirkes ikke", async () => {
    const cases: Array<[string, NonNullable<PersonalDavDeps["guard"]>]> = [
      ["kill_switch_active", async () => "kill_switch_active"], ["credential_revoked", async () => "credential_revoked"], ["dav_guard_unavailable", async () => { throw new Error("db nede"); }]
    ];
    for (const [reason, guard] of cases) {
      for (const path of ["/personal/dav/list", "/personal/dav/create", "/personal/dav/delete"]) {
        const h = harness({ path, body: ALL_BODY, guard });
        await handlePersonalRoute(h.ctx);
        expect(h.responses.at(-1), `${reason} ${path}`).toEqual({ status: 503, body: { error: "dav_blocked", reason, request_id: "req-1" } });
        expect(h.calls.filter((c) => ["list", "get", "create", "update", "remove"].includes(c)), `${reason} ${path}`).toEqual([]);
        expect(h.audits, `${reason} ${path}`).toEqual([{ action: path.slice("/personal/dav/".length), collection: "privat", outcome: "blocked", decision: "DENY", reason }]);
        noContent(h.audits);
      }
    }
    const local = harness({ path: "/personal/dav/collections", body: {}, guard: async () => "kill_switch_active" });
    await handlePersonalRoute(local.ctx);
    expect(local.responses.at(-1)?.status).toBe(200);
    expect(local.audits).toEqual([]); // `collections` sender ingenting og revideres ikke
  });

  it("DENY-raden er best effort: en revisjon som feiler (avvist ELLER kastet synkront) endrer ikke stoppen - fortsatt 503 `dav_blocked`, ingen klientkall", async () => {
    for (const mode of ["rejects", "throws"] as const) {
      const h = harness({ path: "/personal/dav/update", body: ALL_BODY, guard: async () => "credential_revoked" });
      (h.ctx.deps.dav as { audit: unknown }).audit = mode === "rejects" ? async () => { throw new Error("db nede"); } : () => { throw new Error("db nede"); };
      await handlePersonalRoute(h.ctx);
      expect(h.responses.at(-1), mode).toEqual({ status: 503, body: { error: "dav_blocked", reason: "credential_revoked", request_id: "req-1" } });
      expect(h.calls.filter((c) => ["list", "get", "create", "update", "remove"].includes(c)), mode).toEqual([]);
    }
  });

  it("stopp MIDT i en operasjon (transportens vakt, mellom to forespørsler): ÉN DENY-rad i stedet for `rejected:` - for mutasjon (etter `requested`) og for lesing; en annen avvisning revideres som før", async () => {
    for (const [code, reason] of [["dav_kill_switch_active", "kill_switch_active"], ["dav_credential_revoked", "credential_revoked"], ["dav_guard_unavailable", "dav_guard_unavailable"]] as const) {
      const update = harness({ path: "/personal/dav/update", body: ALL_BODY, fail: new DavError(code) });
      await handlePersonalRoute(update.ctx);
      expect(update.responses.at(-1), code).toEqual({ status: 503, body: { error: "dav_rejected", reason: code, request_id: "req-1" } });
      expect(update.audits, code).toEqual([{ action: "update", collection: "privat", uid: "uid-123456", outcome: "requested" }, { action: "update", collection: "privat", outcome: "blocked", decision: "DENY", reason }]);
      const read = harness({ path: "/personal/dav/get", body: ALL_BODY, fail: new DavError(code) });
      await handlePersonalRoute(read.ctx);
      expect(read.audits, code).toEqual([{ action: "get", collection: "privat", outcome: "blocked", decision: "DENY", reason }]);
      noContent([update.audits.at(-1), read.audits]);
    }
    const other = harness({ path: "/personal/dav/update", body: ALL_BODY, fail: new DavError("etag_mismatch") });
    await handlePersonalRoute(other.ctx);
    expect(other.audits.map((a) => [a.outcome, a.decision])).toEqual([["requested", undefined], ["rejected:etag_mismatch", undefined]]);
    const otherRead = harness({ path: "/personal/dav/get", body: ALL_BODY, fail: new DavError("not_found") });
    await handlePersonalRoute(otherRead.ctx);
    expect(otherRead.audits).toEqual([]); // en vanlig avvisning av lesing revideres ikke (som før)
  });

  it("ende-til-ende med ekte klient: kill switch slås på mellom GET og PUT i en endring - PUT sendes aldri, ressursen er uendret, og sporet er `requested` + ÉN DENY", async () => {
    const server = new FakeDavServer();
    const etag = server.seed(`${CAL}stop-uid-0001.ics`, ics("stop-uid-0001", "Gammel", "20261201T080000Z"));
    const stopAfterRead: DavTransport = { request: async (req) => { if (req.method === "PUT") throw new DavError("dav_kill_switch_active"); return server.request(req); } };
    const real = new AppleDavClient({ transport: stopAfterRead, collections, now: () => new Date("2026-11-18T10:00:00Z") });
    const h = harness({ path: "/personal/dav/update", body: { collection: "privat", uid: "stop-uid-0001", expected_etag: etag, fields: { summary: "Ny" } }, real });
    await handlePersonalRoute(h.ctx);
    expect(h.responses.at(-1)).toEqual({ status: 503, body: { error: "dav_rejected", reason: "dav_kill_switch_active", request_id: "req-1" } });
    expect(server.requests.map((r) => r.method)).toEqual(["GET"]);
    expect(server.store.get(`${CAL}stop-uid-0001.ics`)?.body).toContain("SUMMARY:Gammel");
    expect(h.audits.map((a) => [a.outcome, a.decision, a.reason])).toEqual([["requested", undefined, undefined], ["blocked", "DENY", "kill_switch_active"]]);
  });

  it("vakten er PÅKREVD (NY-4): typen krever den (`@ts-expect-error` feiler typesjekken hvis den blir valgfri igjen), og en kaller uten typesjekk som glemmer den får fail-closed 503 `dav_guard_unavailable` + ÉN DENY-rad, aldri en klient uten stopp", async () => {
    // @ts-expect-error `guard` er påkrevd i PersonalDavDeps: en wiring som glemmer den kompilerer ikke
    const forgotten: PersonalDavDeps = { client: {} as never, audit: async () => undefined };
    expect(forgotten.guard).toBeUndefined();
    for (const path of ["/personal/dav/list", "/personal/dav/delete"]) {
      const h = harness({ path, body: ALL_BODY });
      delete (h.ctx.deps.dav as unknown as { guard?: unknown }).guard; // omgår typene
      await handlePersonalRoute(h.ctx);
      expect(h.responses.at(-1), path).toEqual({ status: 503, body: { error: "dav_blocked", reason: "dav_guard_unavailable", request_id: "req-1" } });
      expect(h.calls.filter((c) => ["list", "get", "create", "update", "remove"].includes(c)), path).toEqual([]);
      expect(h.audits, path).toEqual([{ action: path.slice("/personal/dav/".length), collection: "privat", outcome: "blocked", decision: "DENY", reason: "dav_guard_unavailable" }]);
    }
  });

  it("hver DavError-kode fra vakten har en statuskode (503)", () => {
    for (const code of ["dav_kill_switch_active", "dav_credential_revoked", "dav_guard_unavailable"] as const) expect(DAV_ERROR_STATUS[code], code).toBe(503);
  });
});

interface Harness { ctx: PersonalRouteContext; calls: string[]; responses: Array<{ status: number; body: Record<string, unknown> }>; audits: DavAuditEntry[]; client: Record<string, ReturnType<typeof vi.fn>> }

function harness(opts: { path: string; body?: Record<string, unknown>; owner?: boolean; stepUp?: string; auditFails?: boolean; fail?: unknown; dav?: false; method?: string; real?: AppleDavClient; guard?: PersonalDavDeps["guard"] }): Harness {
  const calls: string[] = [];
  const audits: DavAuditEntry[] = [];
  const responses: Harness["responses"] = [];
  const client: Record<string, ReturnType<typeof vi.fn>> = {
    listCollections: vi.fn(() => { calls.push("listCollections"); return [{ name: "privat", kind: "calendar" }]; })
  };
  for (const name of ["list", "get", "create", "update", "remove"]) client[name] = vi.fn(async () => { calls.push(name); if (opts.fail !== undefined) throw opts.fail; return name === "list" ? [] : name === "get" ? null : { outcome: "SUCCESS", uid: "jarvis-1", etag: '"e"' }; });
  const dav: PersonalDavDeps = {
    client: (opts.real ?? client) as unknown as PersonalDavDeps["client"],
    audit: async (_i, entry) => { calls.push(`audit:${entry.outcome}`); if (opts.auditFails === true && entry.outcome === "requested") throw new Error("db nede"); audits.push(entry); },
    guard: opts.guard ?? (async () => null), // påkrevd (fiks-runde 2, NY-4): testene som ikke handler om stopp sier «ingen stopp» eksplisitt
    rateLimit: { check: () => ({ ok: true }) } // påkrevd (WP-G2c, JARVIS-113 e/6): disse testene handler ikke om grenser (se `wpg2c-dav-hardening.test.ts`)
  };
  const ctx: PersonalRouteContext = {
    req: { method: opts.method ?? "POST" } as never, res: {} as never, url: new URL(opts.path, "http://localhost"), deps: opts.dav === false ? {} : { dav },
    authed: async () => { calls.push("authed"); return { identity: owner, body: opts.body ?? {} }; },
    requireOwner: async () => { calls.push("requireOwner"); if (opts.owner === false) { responses.push({ status: 403, body: { error: "owner_required" } }); return false; } return true; },
    stepUpDenial: () => { calls.push("stepUp"); return opts.stepUp; },
    json: (status, b) => { responses.push({ status, body: b as Record<string, unknown> }); }, requestId: () => "req-1",
    fieldString: (b, k) => { const v = b[k]; if (typeof v !== "string" || v.length === 0) throw new DavError("invalid_input", k); return v; },
    fieldOptionalString: (b, k) => (typeof b[k] === "string" ? (b[k] as string) : undefined), fieldRecord: (b, k) => { const v = b[k]; if (typeof v !== "object" || v === null || Array.isArray(v)) throw new DavError("invalid_input", k); return v as Record<string, unknown>; },
    fieldOptionalNumber: (b, k) => (typeof b[k] === "number" ? (b[k] as number) : undefined),
    domainFailure: (status, code, err) => { responses.push({ status, body: { error: code, generic: true, message: (err as Error).message } }); }
  };
  return { ctx, calls, responses, audits, client };
}

describe("B: porter og rekkefølge", () => {
  it("lesing: grant -> eier -> klient; ingen step-up; innholdet merkes ubetrodd", async () => {
    for (const [path, body, method] of [["/personal/dav/collections", {}, "listCollections"], ["/personal/dav/list", { collection: "privat", from: "2026-12-01", to: "2026-12-02", limit: 5 }, "list"], ["/personal/dav/get", { collection: "privat", uid: "abcdef-1" }, "get"]] as const) {
      const h = harness({ path, body });
      expect(await handlePersonalRoute(h.ctx)).toBe(true);
      expect(h.calls, path).toEqual(["authed", "requireOwner", method]);
      expect(h.responses[0]?.status).toBe(200);
      if (method !== "listCollections") expect(h.responses[0]?.body["content_trust"]).toBe("untrusted_external_content");
    }
    const list = harness({ path: "/personal/dav/list", body: { collection: "privat", from: "2026-12-01", to: "2026-12-02", limit: 5 } });
    await handlePersonalRoute(list.ctx);
    expect(list.client["list"]).toHaveBeenCalledWith("privat", { from: "2026-12-01", to: "2026-12-02", limit: 5 });
  });

  it("mutasjon: grant -> eier -> step-up -> revisjon `requested` -> klient -> revisjon av utfallet; identitet fra grantet", async () => {
    const cases = [
      { path: "/personal/dav/create", body: { collection: "privat", idempotency_key: "idem-key-0001", fields: { summary: "x" } }, method: "create" },
      { path: "/personal/dav/update", body: { collection: "privat", uid: "abcdef-1", expected_etag: '"e1"', fields: { summary: "y" } }, method: "update" },
      { path: "/personal/dav/delete", body: { collection: "privat", uid: "abcdef-1", expected_etag: '"e1"', confirm_uid: "abcdef-1" }, method: "remove" }
    ];
    for (const c of cases) {
      const h = harness({ path: c.path, body: c.body });
      await handlePersonalRoute(h.ctx);
      expect(h.calls, c.path).toEqual(["authed", "requireOwner", "stepUp", "audit:requested", c.method, "audit:SUCCESS"]);
      expect(h.audits.map((a) => a.collection)).toEqual(["privat", "privat"]);
      expect(JSON.stringify(h.audits)).not.toMatch(/summary|expected_etag|fields/); // aldri innhold
      expect(h.responses[0]).toMatchObject({ status: 200, body: { result: { outcome: "SUCCESS" }, content_trust: "untrusted_external_content" } });
    }
  });

  it("ikke-eier, manglende step-up og feilende revisjon: klienten nås ALDRI; sletting uten typet bekreftelse avvises (400) og revideres", async () => {
    const body = { collection: "privat", uid: "abcdef-1", expected_etag: '"e1"', confirm_uid: "abcdef-1" };
    const notOwner = harness({ path: "/personal/dav/delete", body, owner: false });
    await handlePersonalRoute(notOwner.ctx);
    expect(notOwner.calls).toEqual(["authed", "requireOwner"]);
    const weak = harness({ path: "/personal/dav/delete", body, stepUp: "step_up_required:signed_device_session" });
    await handlePersonalRoute(weak.ctx);
    expect(weak.calls).toEqual(["authed", "requireOwner", "stepUp"]);
    expect(weak.responses).toEqual([{ status: 403, body: { error: "step_up_required", reason: "step_up_required:signed_device_session", request_id: "req-1" } }]);
    const noAudit = harness({ path: "/personal/dav/delete", body, auditFails: true });
    await handlePersonalRoute(noAudit.ctx);
    expect(noAudit.calls).toEqual(["authed", "requireOwner", "stepUp", "audit:requested"]);
    expect(noAudit.responses[0]).toMatchObject({ status: 500, body: { error: "dav_audit_unavailable" } });
    const unconfirmed = harness({ path: "/personal/dav/delete", body: { ...body, confirm_uid: "noe-annet" } });
    await handlePersonalRoute(unconfirmed.ctx);
    expect(unconfirmed.client["remove"]).not.toHaveBeenCalled();
    expect(unconfirmed.responses[0]).toEqual({ status: 400, body: { error: "dav_rejected", reason: "invalid_input", request_id: "req-1" } });
    expect(unconfirmed.audits.map((a) => a.outcome)).toEqual(["requested", "rejected:invalid_input"]);
  });

  it("feilkoder: hver DavError-kode har en statuskode, kun koden vises; alt annet er generisk uten feiltekst; ruten finnes ikke uten `deps.dav`/for GET/ukjent sti", async () => {
    for (const [code, status] of Object.entries(DAV_ERROR_STATUS)) {
      const h = harness({ path: "/personal/dav/list", body: { collection: "privat" }, fail: new DavError(code as never, "detalj-som-ikke-skal-vises") });
      await handlePersonalRoute(h.ctx);
      expect(h.responses).toEqual([{ status, body: { error: "dav_rejected", reason: code, request_id: "req-1" } }]);
      expect(JSON.stringify(h.responses)).not.toContain("detalj");
    }
    expect(DAV_ERROR_STATUS.dav_credentials_unavailable).toBe(503);
    expect(DAV_ERROR_STATUS.etag_mismatch).toBe(409);
    const boom = harness({ path: "/personal/dav/get", body: { collection: "privat", uid: "abcdef-1" }, fail: Object.assign(new Error("https://caldav.example.com app-passord-123"), { name: "TypeError" }) });
    await handlePersonalRoute(boom.ctx);
    expect(boom.responses).toEqual([{ status: 500, body: { error: "dav_failed", generic: true, message: "TypeError" } }]);
    expect(await handlePersonalRoute(harness({ path: "/personal/dav/list", dav: false }).ctx)).toBe(false);
    expect(await handlePersonalRoute(harness({ path: "/personal/dav/list", method: "GET" }).ctx)).toBe(false);
    expect(await handlePersonalRoute(harness({ path: "/personal/dav/nuke" }).ctx)).toBe(false);
  });

  it("nøkkellistene er lukkede og inneholder aldri en forbudt identitetsnøkkel; rutene bruker aldri tenant/person fra kroppen", () => {
    expect(Object.keys(DAV_ROUTES).sort()).toEqual(["collections", "create", "delete", "get", "list", "update"].map((n) => `/personal/dav/${n}`));
    for (const [path, route] of Object.entries(DAV_ROUTES)) for (const key of route.keys) expect(FORBIDDEN_IDENTITY_BODY_KEYS, `${path}:${key}`).not.toContain(key);
    const source = readFileSync(join(ROOT, "apps/api/src/personal-dav.ts"), "utf8");
    expect(source).not.toMatch(/body\[["'](tenant_id|person_id|actor_person_id|owner_person_id)["']\]/);
    expect(source).not.toMatch(/console\./);
  });
});

describe("C: ende-til-ende med ekte klient mot en falsk DAV-server", () => {
  it("opprett -> liste -> endre -> slett via rutene: readback-utfall i svaret, revisjon i riktig rekkefølge, og et uavklart utfall rapporteres som UNKNOWN (ikke en feil)", async () => {
    const server = new FakeDavServer();
    const real = new AppleDavClient({ transport: server, collections, now: () => new Date("2026-11-18T10:00:00Z") });
    const run = async (path: string, body: Record<string, unknown>, extra: Partial<Parameters<typeof harness>[0]> = {}) => {
      const h = harness({ path, body, real, ...extra });
      await handlePersonalRoute(h.ctx);
      return h;
    };
    const created = await run("/personal/dav/create", { collection: "privat", idempotency_key: "idem-e2e-0001", fields: { summary: "Tannlege", start: "2026-12-01T08:00:00Z" } });
    const result = created.responses[0]?.body["result"] as { outcome: string; uid: string; etag: string };
    expect(result.outcome).toBe("SUCCESS");
    expect(created.audits.map((a) => a.outcome)).toEqual(["requested", "SUCCESS"]);
    const listed = await run("/personal/dav/list", { collection: "privat", from: "2026-12-01", to: "2026-12-02" });
    expect((listed.responses[0]?.body["items"] as Array<{ summary: string }>).map((i) => i.summary)).toEqual(["Tannlege"]);
    const updated = await run("/personal/dav/update", { collection: "privat", uid: result.uid, expected_etag: result.etag, fields: { summary: "Tannlege (flyttet)" } });
    expect((updated.responses[0]?.body["result"] as { outcome: string }).outcome).toBe("SUCCESS");
    const stale = await run("/personal/dav/update", { collection: "privat", uid: result.uid, expected_etag: result.etag, fields: { summary: "Utdatert" } });
    expect(stale.responses[0]).toEqual({ status: 409, body: { error: "dav_rejected", reason: "etag_mismatch", request_id: "req-1" } });
    expect(stale.audits.map((a) => a.outcome)).toEqual(["requested", "rejected:etag_mismatch"]);
    const etag = (updated.responses[0]?.body["result"] as { etag: string }).etag;
    server.fail("DELETE", "throw");
    const unknown = await run("/personal/dav/delete", { collection: "privat", uid: result.uid, expected_etag: etag, confirm_uid: result.uid });
    expect(unknown.responses[0]).toMatchObject({ status: 200, body: { result: { outcome: "UNKNOWN", reason: "transport_error_after_send" } } });
    expect(unknown.audits.map((a) => a.outcome)).toEqual(["requested", "UNKNOWN"]);
    expect(server.store.size).toBe(1); // ikke slettet: eieren må lese på nytt, ikke gjenta blindt
    const deleted = await run("/personal/dav/delete", { collection: "privat", uid: result.uid, expected_etag: etag, confirm_uid: result.uid });
    expect((deleted.responses[0]?.body["result"] as { outcome: string }).outcome).toBe("SUCCESS");
    expect(server.store.size).toBe(0);
  });
});

describe("D: deltakere - bekreftelsen fra eieren (review B LOW-7: endring/sletting kan sende e-post til andre)", () => {
  it("`allow_attendee_notification` finnes KUN på update/delete; utelatt = false, `true` sendes videre, en ikke-boolsk verdi avvises (400) uten at klienten nås", async () => {
    for (const [path, route] of Object.entries(DAV_ROUTES)) expect(route.keys.includes("allow_attendee_notification"), path).toBe(path.endsWith("/update") || path.endsWith("/delete"));
    const upd = { collection: "privat", uid: "abcdef-1", expected_etag: '"e1"', fields: { summary: "y" } };
    const del = { collection: "privat", uid: "abcdef-1", expected_etag: '"e1"', confirm_uid: "abcdef-1" };
    for (const [path, base, method] of [["/personal/dav/update", upd, "update"], ["/personal/dav/delete", del, "remove"]] as const) {
      const off = harness({ path, body: base });
      await handlePersonalRoute(off.ctx);
      expect(off.client[method]?.mock.calls[0]?.at(-1), path).toEqual({ allowAttendeeNotification: false });
      const on = harness({ path, body: { ...base, allow_attendee_notification: true } });
      await handlePersonalRoute(on.ctx);
      expect(on.client[method]?.mock.calls[0]?.at(-1), path).toEqual({ allowAttendeeNotification: true });
      for (const bad of ["true", 1, null, {}]) {
        const h = harness({ path, body: { ...base, allow_attendee_notification: bad } });
        await handlePersonalRoute(h.ctx);
        expect(h.client[method], `${path} ${JSON.stringify(bad)}`).not.toHaveBeenCalled();
        expect(h.responses[0], path).toEqual({ status: 400, body: { error: "dav_rejected", reason: "invalid_input", request_id: "req-1" } });
      }
    }
    expect(DAV_ERROR_STATUS.attendees_confirmation_required).toBe(409);
  });

  it("ende-til-ende: en hendelse med deltakere gir 409 `attendees_confirmation_required` (revidert som avvist, ingen PUT/DELETE sendt) uten bekreftelsen, og går gjennom med den", async () => {
    const server = new FakeDavServer();
    const real = new AppleDavClient({ transport: server, collections, now: () => new Date("2026-11-18T10:00:00Z") });
    const etag = server.seed(`${CAL}att-uid-0001.ics`, ics("att-uid-0001", "Møte", "20261201T080000Z", ["ORGANIZER:mailto:meg@example.com", "ATTENDEE;CN=Ola:mailto:ola@example.com"]));
    const run = async (path: string, body: Record<string, unknown>) => { const h = harness({ path, body, real }); await handlePersonalRoute(h.ctx); return h; };
    const denied = await run("/personal/dav/update", { collection: "privat", uid: "att-uid-0001", expected_etag: etag, fields: { summary: "Ny" } });
    expect(denied.responses[0]).toEqual({ status: 409, body: { error: "dav_rejected", reason: "attendees_confirmation_required", request_id: "req-1" } });
    expect(denied.audits.map((a) => a.outcome)).toEqual(["requested", "rejected:attendees_confirmation_required"]);
    const deniedDelete = await run("/personal/dav/delete", { collection: "privat", uid: "att-uid-0001", expected_etag: etag, confirm_uid: "att-uid-0001" });
    expect(deniedDelete.responses[0]).toMatchObject({ status: 409, body: { reason: "attendees_confirmation_required" } });
    expect(server.requests.filter((r) => r.method === "PUT" || r.method === "DELETE")).toHaveLength(0);
    const ok = await run("/personal/dav/update", { collection: "privat", uid: "att-uid-0001", expected_etag: etag, fields: { summary: "Ny" }, allow_attendee_notification: true });
    expect(ok.responses[0]).toMatchObject({ status: 200, body: { result: { outcome: "SUCCESS" } } });
    const newEtag = (ok.responses[0]?.body["result"] as { etag: string }).etag;
    const gone = await run("/personal/dav/delete", { collection: "privat", uid: "att-uid-0001", expected_etag: newEtag, confirm_uid: "att-uid-0001", allow_attendee_notification: true });
    expect(gone.responses[0]).toMatchObject({ status: 200, body: { result: { outcome: "SUCCESS" } } });
  });
});
