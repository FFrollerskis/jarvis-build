import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import {
  COMMS_KNOWN_ACTIONS, InvalidCommsConfigError, WEBHOOK_MAX_BYTES, type CommsWebhookProvider, type CommsWebhookService, type OutboundFunnel, type WebhookRequest, type WebhookResponse
} from "@jarvis/comms";
import { buildCommsRuntime } from "../src/comms-wiring.ts";
import { createApiServer, type ApiDeps } from "../src/server.ts";

/**
 * WP-G1 (D-463, P1b/P1d): HTTP-OPPFØRSELEN til kommunikasjonsrutene - uten database (tjenestene er testdobler; selve policyen/journalen/ledgeren er bevist mot ekte Postgres i `modules/comms/test`). Beviset her:
 *  A. DORMANT: uten `deps.comms` finnes INGEN av rutene (404, også med en gyldig signatur) og de er ikke i den strenge per-IP-grensen - flagg AV er identisk med main,
 *  B. webhook-rutene: kun slåtte-på leverandører, rå bytes uendret, størrelsesgrense FØR tjenesten, svar uten innholdsekko, streng per-IP-grense,
 *  C. eier-rutene: grant -> suveren eier -> step-up -> gateway, i den rekkefølgen, med ALLE avslagsformene; ingen identitet fra kroppen; ruten har ingen egen sendevei,
 *  D. oppkoblingen (`buildCommsRuntime`/main.ts): alt AV = ingenting konstrueres, ugyldig konfigurasjon stopper oppstarten, og kildevaktene låser rekkefølgen.
 */
const TENANT = "tenant-g1-routes";
const OWNER = "person-g1-routes-owner";
const GUEST = "person-g1-routes-guest";
const closers: Array<() => Promise<void>> = [];
afterAll(async () => { for (const c of closers) await c(); });

async function listen(deps: Record<string, unknown>): Promise<string> {
  const server = createApiServer(deps as unknown as ApiDeps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type Grant = { person_id: string; tenant_id: string; memory_space: string; session_id: string; device_id: string; channel: string; auth_strength: string };
const grantOf = (person_id: string, over: Partial<Grant> = {}): Grant => ({ person_id, tenant_id: TENANT, memory_space: "business", session_id: `s-${person_id}`, device_id: `d-${person_id}`, channel: "web", auth_strength: "signed", ...over });
const GRANTS: Record<string, Grant> = {
  "owner-signed": grantOf(OWNER),
  "owner-active": grantOf(OWNER, { auth_strength: "active", session_id: "s-own-act" }),
  "owner-telegram": grantOf(OWNER, { channel: "telegram", session_id: "s-own-tg" }),
  "owner-voice": grantOf(OWNER, { channel: "voice", session_id: "s-own-vo" }),
  "guest-signed": grantOf(GUEST),
  "other-tenant-owner": grantOf(OWNER, { tenant_id: "tenant-g1-other", session_id: "s-other" })
};
const authDeps = {
  grants: { verify: async (token: string) => (GRANTS[token] ? { ok: true, grant: GRANTS[token] } : { ok: false, reason: "grant_invalid" }) },
  identity: {
    resolveIdentity: async (i: Record<string, string>) => ({
      ok: true,
      identity: { person_id: i["person_id"], tenant_id: i["tenant_id"], memory_space_id: i["memory_space"], session_id: i["session_id"], device_id: i["device_id"], channel: i["channel"], auth_strength: i["auth_strength"] }
    })
  },
  ownerGate: (identity: IdentityContext) => identity.person_id === OWNER && identity.tenant_id === TENANT
};

// ------------------------------------------------------------------------------------------------ testdobler
interface WebhookCall { provider: CommsWebhookProvider; req: WebhookRequest }
function stubWebhookService(respond: (provider: CommsWebhookProvider, req: WebhookRequest) => WebhookResponse | Promise<WebhookResponse> = () => ({ status: 200, body: { received: true, events: { received: 1, inserted: 1 } } })) {
  const calls: WebhookCall[] = [];
  const service = { handle: async (provider: CommsWebhookProvider, req: WebhookRequest) => { calls.push({ provider, req }); return respond(provider, req); } } as unknown as CommsWebhookService;
  return { service, calls };
}

interface GatewayCall { identity: IdentityContext; tool_id: string; action: string; parameters: Record<string, JsonValue>; idempotency_key?: string }
function stubOutbound(opts: { allowed?: boolean; gatewayResult?: unknown; replay?: boolean } = {}) {
  const gatewayCalls: GatewayCall[] = [];
  const funnelCalls: string[] = [];
  const gateway = {
    get: (tool: string, action: string) => (tool === "comms" && COMMS_KNOWN_ACTIONS.includes(action) ? { tool_id: tool, action } : undefined),
    execute: async (req: GatewayCall) => {
      gatewayCalls.push(req);
      return opts.gatewayResult ?? { ok: true, external_id: "msg-1", data: { sent: true }, output_trust: "internal", deduplicated: false };
    }
  };
  const evaluation = (allowed: boolean) => ({ parsed: { request_id: "x" }, decision: { allowed, denial_codes: allowed ? [] : ["quiet_hours", "recipient_opted_out"], rules: [] } });
  const funnel = {
    hasPriorAttempt: async () => { funnelCalls.push("hasPriorAttempt"); return opts.replay === true; },
    evaluate: async () => { funnelCalls.push("evaluate"); return evaluation(opts.allowed !== false); },
    recordDenial: async () => { funnelCalls.push("recordDenial"); return "clog_denied_1"; },
    summarize: (ev: { decision: { allowed: boolean; denial_codes: string[] } }) => ({ v: 1, allowed: ev.decision.allowed, denial_codes: ev.decision.denial_codes, rules: [{ rule: "quiet_hours", outcome: "deny", code: "quiet_hours" }], content: { sha256: "0".repeat(64), length: 12 } })
  } as unknown as OutboundFunnel;
  return { outbound: { gateway: gateway as never, funnel }, gatewayCalls, funnelCalls };
}

const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" || Buffer.isBuffer(body) ? (body as never) : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> | undefined;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = undefined; }
  return { status: res.status, text, json, headers: res.headers };
};

// ------------------------------------------------------------------------------------------------ A: dormant
describe("A: DORMANT - uten `deps.comms` finnes ingen kommunikasjonsrute (flagg AV = identisk med main)", () => {
  it("alle fire webhook-stier og begge eier-rutene er 404 - også med gyldig grant/signatur - og GET finnes ikke", async () => {
    const base = await listen({ ...authDeps });
    for (const path of ["/webhooks/comms/slack", "/webhooks/comms/meta", "/webhooks/comms/twilio", "/webhooks/comms/telnyx"]) {
      expect((await post(base, path, "{}", { "x-slack-signature": "v0=aa", "x-hub-signature-256": "sha256=aa", "x-twilio-signature": "aa" })).status, path).toBe(404);
      expect((await fetch(`${base}${path}?hub.mode=subscribe&hub.challenge=1`)).status, `GET ${path}`).toBe(404);
    }
    expect((await post(base, "/comms/action", { grant_token: "owner-signed", action: "list_accounts", parameters: {} })).status).toBe(404);
    expect((await post(base, "/comms/preview", { grant_token: "owner-signed", parameters: {} })).status).toBe(404);
  });

  it("stiene er IKKE i den strenge per-IP-grensen uten flagg: mange kall gir fortsatt 404 (aldri 429) - rate limits er identiske med main", async () => {
    const base = await listen({ ...authDeps, rateLimits: { authPerIpPerMinute: 2 } });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) statuses.push((await post(base, "/webhooks/comms/slack", "{}")).status);
    expect(new Set(statuses)).toEqual(new Set([404]));
  });

  it("med BARE utgående slått på finnes ingen webhook-rute, og med BARE webhooks finnes ingen eier-rute", async () => {
    const { outbound } = stubOutbound();
    const onlyOutbound = await listen({ ...authDeps, comms: { outbound } });
    expect((await post(onlyOutbound, "/webhooks/comms/slack", "{}")).status).toBe(404);
    expect((await post(onlyOutbound, "/comms/preview", { grant_token: "owner-signed", parameters: {} })).status).not.toBe(404);
    const { service } = stubWebhookService();
    const onlyHooks = await listen({ ...authDeps, comms: { webhooks: { service, providers: new Set<CommsWebhookProvider>(["slack"]) } } });
    expect((await post(onlyHooks, "/comms/action", { grant_token: "owner-signed", action: "list_accounts", parameters: {} })).status).toBe(404);
    expect((await post(onlyHooks, "/comms/preview", { grant_token: "owner-signed", parameters: {} })).status).toBe(404);
  });
});

// ------------------------------------------------------------------------------------------------ B: webhook-rutene
describe("B: signerte webhook-ruter", () => {
  it("kun leverandørene som er slått på finnes; resten er 404 og når aldri tjenesten", async () => {
    const { service, calls } = stubWebhookService();
    const base = await listen({ comms: { webhooks: { service, providers: new Set<CommsWebhookProvider>(["slack", "twilio"]) } } });
    expect((await post(base, "/webhooks/comms/slack", "{}")).status).toBe(200);
    expect((await post(base, "/webhooks/comms/twilio", "a=b")).status).toBe(200);
    expect((await post(base, "/webhooks/comms/meta", "{}")).status).toBe(404);
    expect((await post(base, "/webhooks/comms/telnyx", "{}")).status).toBe(404);
    expect((await post(base, "/webhooks/comms/unknown", "{}")).status).toBe(404);
    expect(calls.map((c) => c.provider)).toEqual(["slack", "twilio"]);
  });

  it("rå kropp leveres BYTE-FOR-BYTE (signaturen gjelder de eksakte bytene), headere i små bokstaver, sti+query slik leverandøren kalte", async () => {
    const { service, calls } = stubWebhookService();
    const base = await listen({ comms: { webhooks: { service, providers: new Set<CommsWebhookProvider>(["slack", "meta", "twilio", "telnyx"]) } } });
    const exact = Buffer.from(`{ "a" :1,\n\t"ø": "å${String.fromCodePoint(0)}b" ,  "z":[1 , 2]}  \n`, "utf8");
    const res = await post(base, "/webhooks/comms/slack?x=1&y=%C3%B8", exact, { "X-Slack-Signature": "v0=abc", "X-Slack-Request-Timestamp": "1700000000", "X-Custom": "Verdi" });
    expect(res.status).toBe(200);
    const call = calls[0];
    expect(call?.provider).toBe("slack");
    expect(Buffer.compare(call?.req.rawBody ?? Buffer.alloc(0), exact)).toBe(0);
    expect(call?.req.method).toBe("POST");
    expect(call?.req.headers["x-slack-signature"]).toBe("v0=abc");
    expect(call?.req.headers["x-slack-request-timestamp"]).toBe("1700000000");
    expect(call?.req.headers["x-custom"]).toBe("Verdi");
    expect(Object.keys(call?.req.headers ?? {}).every((k) => k === k.toLowerCase())).toBe(true);
    expect(call?.req.pathAndQuery).toBe("/webhooks/comms/slack?x=1&y=%C3%B8");
    expect(call?.req.query.get("y")).toBe("ø");
  });

  it("Meta-håndtrykket (GET) leveres uten kropp og svares som ren tekst; andre metoder overlates til tjenesten (405), aldri en tilfeldig 200", async () => {
    const { service, calls } = stubWebhookService((provider, req) => {
      if (provider === "meta" && req.method === "GET") return { status: 200, body: req.query.get("hub.challenge") ?? "" };
      return { status: 405, body: { error: "method_not_allowed" } };
    });
    const base = await listen({ comms: { webhooks: { service, providers: new Set<CommsWebhookProvider>(["meta", "slack"]) } } });
    const handshake = await fetch(`${base}/webhooks/comms/meta?hub.mode=subscribe&hub.verify_token=fake-verify&hub.challenge=424242`);
    expect(handshake.status).toBe(200);
    expect(handshake.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await handshake.text()).toBe("424242");
    expect(calls[0]?.req.rawBody.length).toBe(0);
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`${base}/webhooks/comms/slack`, { method });
      expect(res.status, method).toBe(405);
    }
  });

  it("for stor kropp gir 413 FØR tjenesten kalles (også uten gyldig signatur); akkurat på grensen slippes gjennom", async () => {
    const { service, calls } = stubWebhookService();
    const base = await listen({ comms: { webhooks: { service, providers: new Set<CommsWebhookProvider>(["slack"]) } } });
    expect((await post(base, "/webhooks/comms/slack", Buffer.alloc(WEBHOOK_MAX_BYTES + 1, 0x61))).status).toBe(413);
    expect(calls).toHaveLength(0);
    expect((await post(base, "/webhooks/comms/slack", Buffer.alloc(WEBHOOK_MAX_BYTES, 0x20))).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("Twilio-suksess besvares med tom TwiML (ingen auto-svar), feil beholder tjenestens status og svarer aldri med innhold; ukjent feil gir generisk 500 uten lekkasje", async () => {
    const secretText = "hemmelig-melding-som-ikke-skal-ekkoes";
    let mode: "ok" | "bad" | "boom" = "ok";
    const { service } = stubWebhookService(() => {
      if (mode === "boom") throw new Error(`db password=hunter2 ${secretText}`);
      return mode === "ok" ? { status: 200, body: { received: true, events: { received: 1, inserted: 1 } } } : { status: 403, body: { error: "invalid_signature" } };
    });
    const base = await listen({ comms: { webhooks: { service, providers: new Set<CommsWebhookProvider>(["twilio"]) } } });
    const ok = await post(base, "/webhooks/comms/twilio", `Body=${encodeURIComponent(secretText)}`, { "content-type": "application/x-www-form-urlencoded" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/^text\/xml/);
    expect(ok.text).toBe("<Response></Response>");
    mode = "bad";
    const bad = await post(base, "/webhooks/comms/twilio", `Body=${encodeURIComponent(secretText)}`);
    expect(bad.status).toBe(403);
    expect(bad.json).toEqual({ error: "invalid_signature" });
    expect(bad.text).not.toContain(secretText);
    mode = "boom";
    const boom = await post(base, "/webhooks/comms/twilio", "Body=x");
    expect(boom.status).toBe(500);
    expect(boom.json).toMatchObject({ error: "internal_error" });
    expect(boom.text).not.toMatch(/hunter2|password|hemmelig/);
  });

  it("flommen stoppes av den strenge per-IP-grensen KUN på slåtte-på stier (de øvrige er 404 uten telling)", async () => {
    const { service } = stubWebhookService();
    const base = await listen({ comms: { webhooks: { service, providers: new Set<CommsWebhookProvider>(["slack"]) } }, rateLimits: { authPerIpPerMinute: 3 } });
    const slack: number[] = [];
    for (let i = 0; i < 6; i += 1) slack.push((await post(base, "/webhooks/comms/slack", "{}")).status);
    expect(slack).toEqual([200, 200, 200, 429, 429, 429]);
    const meta: number[] = [];
    for (let i = 0; i < 6; i += 1) meta.push((await post(base, "/webhooks/comms/telnyx", "{}")).status);
    expect(new Set(meta)).toEqual(new Set([404]));
  });
});

// ------------------------------------------------------------------------------------------------ C: eier-rutene
describe("C: `/comms/action` og `/comms/preview` - grant -> suveren eier -> step-up -> gateway", () => {
  const sendBody = (over: Record<string, unknown> = {}) => ({
    grant_token: "owner-signed", action: "send", idempotency_key: "idem-route-0001",
    parameters: { channel: "sms", account_ref: "+4791000000", recipient: "+4790001111", purpose: "transactional", text: "Hei, timen din er bekreftet." }, ...over
  });

  it("forespørselens form: ingen grant 401, ekstra felt/identitetsfelt 400, ukjent handling 400 FØR grant, feilformede parametre/nøkkel 400", async () => {
    const { outbound, gatewayCalls } = stubOutbound();
    const base = await listen({ ...authDeps, comms: { outbound } });
    expect((await post(base, "/comms/action", { action: "list_accounts" })).status).toBe(401);
    expect((await post(base, "/comms/action", { ...sendBody(), extra: 1 })).status).toBe(400);
    for (const field of ["tenant_id", "person_id", "memory_space", "memory_space_id", "session_id", "device_id", "channel", "auth_strength", "owner_person_id"]) {
      const r = await post(base, "/comms/action", { ...sendBody(), [field]: "x" });
      expect(r.status, field).toBe(400);
      expect(r.json?.["error"], field).toBe("identity_field_forbidden");
    }
    // ukjent handling avvises før grantet løses - selv med et ugyldig grant er svaret 400, ikke 403
    for (const action of ["nope", "evaluate_send", "check_message_target", "send_everything"]) {
      const r = await post(base, "/comms/action", sendBody({ action, grant_token: "ugyldig-grant" }));
      expect(r.status, action).toBe(400);
      expect(r.json).toMatchObject({ error: "malformed_request", reason: "action_not_allowed" });
    }
    expect((await post(base, "/comms/action", sendBody({ action: 5 }))).status).toBe(400);
    expect((await post(base, "/comms/action", sendBody({ parameters: [1] }))).json).toMatchObject({ reason: "parameters_malformed" });
    expect((await post(base, "/comms/action", sendBody({ parameters: "tekst" }))).json).toMatchObject({ reason: "parameters_malformed" });
    expect((await post(base, "/comms/action", sendBody({ idempotency_key: 12345 }))).json).toMatchObject({ reason: "idempotency_key_malformed" });
    expect((await post(base, "/comms/action", sendBody({ grant_token: "ugyldig-grant" }))).status).toBe(403);
    expect(gatewayCalls).toEqual([]);
  });

  it("KUN den suverene eieren: gjest i samme tenant og eier i en annen tenant får 403 owner_required - gatewayen nås aldri, ingenting evalueres", async () => {
    const { outbound, gatewayCalls, funnelCalls } = stubOutbound();
    const base = await listen({ ...authDeps, comms: { outbound } });
    for (const token of ["guest-signed", "other-tenant-owner"]) {
      for (const [path, body] of [["/comms/action", sendBody({ grant_token: token })], ["/comms/action", { grant_token: token, action: "list_accounts", parameters: {} }], ["/comms/preview", { grant_token: token, parameters: sendBody().parameters }]] as const) {
        const r = await post(base, path, body);
        expect(r.status, `${token} ${path}`).toBe(403);
        expect(r.json?.["error"], `${token} ${path}`).toBe("owner_required");
      }
    }
    expect(gatewayCalls).toEqual([]);
    expect(funnelCalls).toEqual([]);
    // uten konfigurert eier-port nektes også eieren (fail-closed)
    const noGate = await listen({ ...authDeps, ownerGate: undefined, comms: { outbound } });
    const r = await post(noGate, "/comms/action", sendBody());
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: "owner_required", reason: "owner_gate_not_configured" });
    expect(gatewayCalls).toEqual([]);
  });

  it("step-up: sending/redigering/sletting/reaksjon og konto-administrasjon krever signert enhet fra en eier-kanal; lesing og avmeldingsregistrering krever ikke det", async () => {
    const { outbound, gatewayCalls } = stubOutbound();
    const base = await listen({ ...authDeps, comms: { outbound } });
    for (const token of ["owner-active", "owner-telegram", "owner-voice"]) {
      for (const action of ["send", "edit_message", "delete_message", "add_reaction", "authorize_account", "revoke_account", "start_call", "contacts_create", "contacts_update", "contacts_delete", "contacts_sync",
        "meeting_ingest_text", "meeting_decide_commitment", "meeting_confirm_participant", "meeting_delete"]) {
        const r = await post(base, "/comms/action", sendBody({ grant_token: token, action, parameters: {} }));
        expect(r.status, `${token} ${action}`).toBe(403);
        expect(r.json?.["error"], `${token} ${action}`).toBe("step_up_required");
      }
    }
    expect(gatewayCalls).toEqual([]);
    // ikke-step-up-handlinger: lesing + avmelding når gatewayen også fra en svakere økt
    const exempt = ["list_inbound", "list_outbound", "list_opt_outs", "list_accounts", "record_opt_out", "read_thread", "list_users", "get_message", "list_templates", "read_message", "contacts_list", "contacts_search", "contacts_get", "meeting_list", "meeting_commitments"];
    for (const action of exempt) {
      const r = await post(base, "/comms/action", { grant_token: "owner-active", action, parameters: {} });
      expect(r.status, action).toBe(200);
    }
    expect(gatewayCalls.map((c) => c.action)).toEqual(exempt);
  });

  it("gyldig sending: gatewayen får NØYAKTIG tool `comms`/`send`, identiteten fra GRANTET, idempotensnøkkelen og request_id = nøkkelen; svaret bærer ekstern id og aldri tekst", async () => {
    const { outbound, gatewayCalls, funnelCalls } = stubOutbound();
    const base = await listen({ ...authDeps, comms: { outbound } });
    const r = await post(base, "/comms/action", sendBody());
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, external_id: "msg-1", output_trust: "internal", deduplicated: false, session_id: `s-${OWNER}` });
    expect(gatewayCalls).toHaveLength(1);
    const call = gatewayCalls[0];
    expect(call).toMatchObject({ tool_id: "comms", action: "send", idempotency_key: "idem-route-0001" });
    expect(call?.parameters["request_id"]).toBe("idem-route-0001");
    expect(call?.identity).toMatchObject({ person_id: OWNER, tenant_id: TENANT, memory_space_id: "business", channel: "web", auth_strength: "signed" });
    expect(funnelCalls).toEqual(["hasPriorAttempt", "evaluate"]);
    expect(r.text).not.toContain("timen din");
  });

  it("send uten (eller med ugyldig) idempotensnøkkel avvises 400 `idempotency_key_required` før policy og gateway; avvikende request_id avvises", async () => {
    const { outbound, gatewayCalls, funnelCalls } = stubOutbound();
    const base = await listen({ ...authDeps, comms: { outbound } });
    for (const bad of [undefined, "kort", "har mellomrom i seg", "x".repeat(201)]) {
      const body = sendBody();
      if (bad === undefined) delete (body as Record<string, unknown>)["idempotency_key"]; else body.idempotency_key = bad;
      const r = await post(base, "/comms/action", body);
      expect(r.status, String(bad)).toBe(400);
      expect(r.json).toMatchObject({ error: "malformed_request", reason: "idempotency_key_required" });
    }
    const mismatch = await post(base, "/comms/action", sendBody({ parameters: { ...sendBody().parameters, request_id: "en-annen-id-0001" } }));
    expect(mismatch.status).toBe(400);
    expect(mismatch.json).toMatchObject({ reason: "comms_request_id_mismatch" });
    expect(gatewayCalls).toEqual([]);
    expect(funnelCalls).toEqual([]);
  });

  it("policyavslag: 403 `comms_policy_denied` med ALLE kodene, regelutfall og journal-id (bevis), uten tekst - gatewayen nås ikke; journalen skrives av trakten", async () => {
    const { outbound, gatewayCalls, funnelCalls } = stubOutbound({ allowed: false });
    const base = await listen({ ...authDeps, comms: { outbound } });
    const r = await post(base, "/comms/action", sendBody());
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: "comms_policy_denied", denial_codes: ["quiet_hours", "recipient_opted_out"], journal_id: "clog_denied_1" });
    expect(Array.isArray(r.json?.["rules"])).toBe(true);
    expect(r.text).not.toContain("timen din");
    expect(gatewayCalls).toEqual([]);
    expect(funnelCalls).toEqual(["hasPriorAttempt", "evaluate", "recordDenial"]);
  });

  it("gjenspilling (id-en har et tidligere forsøk) går rett til gatewayen uten ny evaluering; gatewayfeil gir 403 `tool_denied` med kort årsak", async () => {
    const replay = stubOutbound({ replay: true });
    const base = await listen({ ...authDeps, comms: { outbound: replay.outbound } });
    expect((await post(base, "/comms/action", sendBody())).status).toBe(200);
    expect(replay.funnelCalls).toEqual(["hasPriorAttempt"]);
    expect(replay.gatewayCalls).toHaveLength(1);
    const failing = stubOutbound({ gatewayResult: { ok: false, reason: "class_d_notifier_not_ready" } });
    const base2 = await listen({ ...authDeps, comms: { outbound: failing.outbound } });
    const r = await post(base2, "/comms/action", sendBody());
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: "tool_denied", reason: "class_d_notifier_not_ready" });
  });

  it("`/comms/preview`: tørrkjøring uten gateway-kall, ingen step-up nødvendig (ren lesing), aldri tekst i svaret, kun eier", async () => {
    const { outbound, gatewayCalls, funnelCalls } = stubOutbound({ allowed: false });
    const base = await listen({ ...authDeps, comms: { outbound } });
    const r = await post(base, "/comms/preview", { grant_token: "owner-active", parameters: sendBody().parameters });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, data: { allowed: false, denial_codes: ["quiet_hours", "recipient_opted_out"] } });
    expect(r.text).not.toContain("timen din");
    expect(gatewayCalls).toEqual([]);
    expect(funnelCalls).toEqual(["evaluate"]);
    expect((await post(base, "/comms/preview", { grant_token: "owner-active", parameters: [] })).status).toBe(400);
    expect((await post(base, "/comms/preview", { grant_token: "owner-active", parameters: {}, action: "send" })).status).toBe(400);
    expect((await post(base, "/comms/preview", { parameters: {} })).status).toBe(401);
  });

  it("kun POST: GET mot eier-rutene er 404", async () => {
    const { outbound } = stubOutbound();
    const base = await listen({ ...authDeps, comms: { outbound } });
    expect((await fetch(`${base}/comms/action`)).status).toBe(404);
    expect((await fetch(`${base}/comms/preview`)).status).toBe(404);
  });
});

// ------------------------------------------------------------------------------------------------ D: oppkobling og kildevakter
describe("D: oppkoblingen (`buildCommsRuntime`) og kildevakter", () => {
  const pool = {} as never; // tomt: ingenting rører basen ved konstruksjon
  const graph = {} as never;
  const business = {} as never;
  const secrets = { get: async () => null };
  const build = (env: Record<string, string>) => buildCommsRuntime({ env, pool, graph, business, secrets });

  it("alt AV: ingen verktøy, ingen API-deps og ingen oppstartslogg - strukturelt identisk med main", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      for (const env of [{}, { JARVIS_COMMS_OUTBOUND: "" }, { JARVIS_COMMS_OUTBOUND: "true" }, { JARVIS_COMMS_OUTBOUND: "1" }, { JARVIS_COMMS_OUTBOUND: "ON" }, { JARVIS_COMMS_OUTBOUND: "yes" }]) {
        const runtime = build(env);
        expect(runtime.tools, JSON.stringify(env)).toEqual([]);
        expect(runtime.apiDeps({} as never), JSON.stringify(env)).toBeUndefined();
      }
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it("kun den EKSAKTE verdien `on` slår på: utgående gir verktøy + eier-deps, webhooks alene gir kun webhook-deps (ingen verktøy)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const outbound = build({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "sms,slack" });
      expect(outbound.tools.length).toBeGreaterThan(8);
      expect(new Set(outbound.tools.map((t) => t.tool_id))).toEqual(new Set(["comms"]));
      const gw = {} as never;
      const deps = outbound.apiDeps(gw);
      expect(deps?.outbound?.gateway).toBe(gw);
      expect(deps?.webhooks).toBeUndefined();

      const hooks = build({ JARVIS_COMMS_WEBHOOKS: "slack,twilio", JARVIS_COMMS_TENANT_ID: "tenant-hemmelig-id" });
      expect(hooks.tools).toEqual([]);
      const hookDeps = hooks.apiDeps(gw);
      expect(hookDeps?.outbound).toBeUndefined();
      expect([...(hookDeps?.webhooks?.providers ?? [])].sort()).toEqual(["slack", "twilio"]);
      // oppstartsloggen bærer kun navn/flagg - aldri tenant-id, URL-er eller hemmeligheter
      const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("comms_enabled");
      expect(logged).toContain("NOT_VERIFIED");
      expect(logged).not.toContain("tenant-hemmelig-id");
    } finally { log.mockRestore(); }
  });

  it("ugyldig konfigurasjon STOPPER oppstarten (aldri en stille tom konfigurasjon)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      for (const env of [{ JARVIS_COMMS_CHANNELS: "fax" }, { JARVIS_COMMS_WEBHOOKS: "mailgun" }, { JARVIS_COMMS_MEMORY_SPACE: "health" }, { JARVIS_COMMS_PUBLIC_BASE_URL: "http://uten-tls.example.com" }, { JARVIS_COMMS_PUBLIC_BASE_URL: "https://x.example.com/" }]) {
        expect(() => build(env), JSON.stringify(env)).toThrow(InvalidCommsConfigError);
      }
    } finally { log.mockRestore(); }
  });

  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("main.ts: kun fabrikken leser konfigurasjonen; verktøyene går i den ene register-løkken; deps settes kun når fabrikken gir noe", () => {
    const main = read("../src/main.ts");
    expect(main).toMatch(/const commsRuntime = buildCommsRuntime\(\{\s*env: process\.env, pool, graph: conversationGraphService, business: businessService, secrets: readSecretProvider,/);
    expect(main).toMatch(/\.\.\.commsRuntime\.tools\s*\n\s*\]\s*\n\s*\}\)\) toolGateway\.register\(tool\);/);
    expect(main).toContain("const commsApiDeps = commsRuntime.apiDeps(toolGateway);");
    expect(main).toMatch(/\.\.\.\(commsApiDeps \? \{ comms: commsApiDeps \} : \{\}\)/);
    expect(/process\.env\[\s*["']JARVIS_(COMMS|META_GRAPH)/.test(main), "ingen direkte flaggavlesing utenfor parseCommsConfig").toBe(false);
    expect(main.indexOf("const commsRuntime")).toBeLessThan(main.indexOf("for (const tool of firstWaveTools("));
  });

  it("comms-wiring.ts: utgående bygges KUN når flagget er på, webhook-tjenesten KUN med minst én leverandør, og alt-AV returnerer før noe konstrueres", () => {
    const wiring = read("../src/comms-wiring.ts");
    expect(wiring).toMatch(/if \(!commsAnyEnabled\(config\)\) return \{ config, tools: \[\], apiDeps: \(\) => undefined, startSweeps: \(\) => undefined \};/);
    expect(wiring.indexOf("if (!commsAnyEnabled(config))")).toBeLessThan(wiring.indexOf("new CommsStore("));
    expect(wiring).toMatch(/const funnel = config\.outbound\s*\n\s*\? new OutboundFunnel\(/);
    expect(wiring).toMatch(/const webhookService = config\.webhooks\.size > 0\s*\n\s*\? new CommsWebhookService\(/);
    expect(wiring).toMatch(/const tools = funnel \? commsToolDefinitions\(/);
    expect(wiring).not.toMatch(/process\.env/);
    expect(wiring).not.toMatch(/console\.(log|error)\([^)]*(secret|token|tenant)/i);
  });

  it("server.ts: AUTH_ROUTES er uendret (flagg AV = identisk med main), webhook-stiene finnes kun i `COMMS_WEBHOOK_ROUTES`, og eier-ruten kaller gatewayen etter eier- og step-up-portene", () => {
    const server = read("../src/server.ts");
    expect(server).toMatch(/"\/webhooks\/product-usage"\s*\n\]\)/);
    const authRoutes = /const AUTH_ROUTES: ReadonlySet<string> = new Set\(\[[\s\S]*?\n\]\);/.exec(server)?.[0] ?? "";
    expect(authRoutes).not.toContain("/webhooks/comms");
    expect(server.match(/"\/webhooks\/comms\/[a-z]+"/g)).toHaveLength(4);
    const action = server.slice(server.indexOf('url.pathname === "/comms/action"'));
    const iGrant = action.indexOf("resolveFromGrant(");
    const iOwner = action.indexOf("requireOwner(");
    const iStep = action.indexOf("ownerStepUpDenial(");
    const iExec = action.indexOf("executeCommsOwnerAction(");
    expect(iGrant).toBeGreaterThan(0);
    expect(iOwner).toBeGreaterThan(iGrant);
    expect(iStep).toBeGreaterThan(iOwner);
    expect(iExec).toBeGreaterThan(iStep);
    // ruten har ingen egen sendevei: ingen adapter-/leverandørimport, ingen fetch
    expect(server).not.toMatch(/SlackAdapter|DiscordAdapter|WhatsAppAdapter|TwilioSmsAdapter|TelnyxSmsAdapter|guardedFetch/);
    // handlingene som ikke krever step-up er nøyaktig lesing + avmeldingsregistrering
    const exempt = /const COMMS_STEP_UP_EXEMPT: ReadonlySet<string> = new Set\(\[([^\]]*)\]\);/.exec(server)?.[1] ?? "";
    expect(exempt.split(",").map((x) => x.trim()).sort()).toEqual(['"record_opt_out"', "...COMMS_CONTACT_READ_ACTIONS", "...COMMS_MEETING_READ_ACTIONS", "...COMMS_READ_ACTIONS", "...COMMS_VENDOR_READ_ACTIONS"]);
  });
});
