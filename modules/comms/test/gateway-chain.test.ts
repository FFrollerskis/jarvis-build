import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import { ConversationGraphService } from "@jarvis/conversation-graph";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import {
  FORBIDDEN_MODEL_TOOL_IDS, OWNER_ONLY_NAMESPACES, SURFACE_TOOL_GRANTS, ToolGateway, assertManifestInvariants, assessClassDPipeline, buildToolManifest,
  type ClassDNotification, type SecretProvider, type ToolDefinition
} from "@jarvis/tool-gateway";
import { CommsStore, CommsTransport, OutboundFunnel, commsToolDefinitions, parseCommsConfig, type AdapterMap } from "../src/index.ts";
import { OWNER, TENANT_A, scriptedAdapter, startCommsDb, type CommsDb } from "./support/harness.ts";

/**
 * WP-G1 (P1b/P1c): `comms.*` gjennom den EKTE `ToolGateway`-pipelinen (embedded Postgres, ekte policy, ekte klasse D-kjede): preflight-avslag FØR reservasjon, ledger/idempotens, umiddelbart eier-varsel uten
 * meldingstekst, eier-eksklusiv, ingen forfalskningsflate i parametrene, og at verktøyene aldri kan stå på en modellflate.
 */
let db: CommsDb;
let store: CommsStore;
let now = new Date("2026-11-17T11:00:00Z"); // 12:00 Oslo
const clock = () => now;
const sms = scriptedAdapter("twilio");
const slack = scriptedAdapter("slack");
let gateway: ToolGateway;
let defs: ToolDefinition[];
let controls: OwnerControls;
let killSwitch: KillSwitch;
const notifications: ClassDNotification[] = [];
let notifierReady = true;

const owner: IdentityContext = { person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "business", session_id: "sess-g1-gw", device_id: "dev-g1", channel: "api", auth_strength: "signed" };
const guest: IdentityContext = { ...owner, person_id: "person-g1-guest", session_id: "sess-g1-guest" };
let n = 0;
const key = (p: string) => `${p}-${++n}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  db = await startCommsDb("g1gw");
  store = new CommsStore(db.app, clock);
  const graph = new ConversationGraphService(db.app);
  const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "sms,slack,whatsapp" });
  const adapters: AdapterMap = { twilio: sms, slack };
  const funnel = new OutboundFunnel({ store, graph, adapters, config, clock });
  killSwitch = new KillSwitch();
  controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A] } });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === BUSINESS_INTERNAL_CREDENTIAL_REF ? "internal-no-external-credential" : ref.startsWith("JARVIS_") ? "fake-token-for-test" : null) };
  gateway = new ToolGateway(db.app, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => notifierReady, notify: async (x) => { notifications.push(x); } } },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT_A], internalRefs: new Set([BUSINESS_INTERNAL_CREDENTIAL_REF]) }
  });
  defs = commsToolDefinitions({ transport: new CommsTransport({ funnel, store }), store, rateLimitPerMinute: 1000 });
  for (const d of defs) gateway.register(d);
  // eierens allowlist, via selve verktøyet (klasse C)
  for (const [channel, account_ref, provider] of [["sms", "+4791000000", "twilio"], ["slack", "T0AAAAAAAA", "slack"]] as const) {
    const r = await gateway.execute({ identity: owner, tool_id: "comms", action: "authorize_account", parameters: { channel, account_ref, provider }, idempotency_key: key("auth") });
    if (!r.ok) throw new Error(`authorize: ${r.reason}`);
  }
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

beforeEach(() => {
  notifications.length = 0;
  notifierReady = true;
  now = new Date("2026-11-17T11:00:00Z");
  sms.calls.length = 0;
  slack.calls.length = 0;
  killSwitch.deactivate();
  controls.unfreezeConnector("slack");
  controls.unfreezeConnector("comms");
});

const sendParams = (over: Record<string, unknown> = {}) => ({ request_id: key("req"), channel: "sms", account_ref: "+4791000000", recipient: "+4790001111", purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei, timen din er bekreftet.", ...over });
const send = (over: Record<string, unknown> = {}, idem?: string, identity: IdentityContext = owner) => {
  const params = sendParams(over);
  return gateway.execute({ identity, tool_id: "comms", action: "send", parameters: params as never, idempotency_key: idem ?? (params.request_id as string) });
};
const ledger = async (k: string) => (await db.admin.query("SELECT status, before_state, after_state, postcondition_reason FROM tool_executions WHERE idempotency_key = $1", [k])).rows[0] as
  { status: string; before_state: Record<string, unknown> | null; after_state: unknown; postcondition_reason: string | null } | undefined;

describe("A: manifest, risikoklasser og klasse D-kjeden (audit som kode)", () => {
  it("alle comms-verktøy står i eier-eksklusivt navnerom og på INGEN modellflate; manifest-invariantene består", () => {
    expect(OWNER_ONLY_NAMESPACES.has("comms")).toBe(true);
    expect(FORBIDDEN_MODEL_TOOL_IDS).toContain("comms");
    for (const grants of Object.values(SURFACE_TOOL_GRANTS)) expect(grants.some((g) => g.tool_id === "comms")).toBe(false);
    const manifest = buildToolManifest(defs);
    expect(() => assertManifestInvariants(manifest, { ignoreUnregisteredGrants: true })).not.toThrow();
    for (const entry of manifest.values()) {
      expect(entry.surfaces, entry.key).toEqual([]);
      expect(entry.sensitivity, entry.key).toBe("private");
    }
    expect(manifest.get("comms.send")).toMatchObject({ risk: "D", effect: "send", cost: "paid", idempotency: "required" });
    expect(manifest.get("comms.delete_message")).toMatchObject({ risk: "D", effect: "delete" });
    expect(manifest.get("comms.edit_message")).toMatchObject({ risk: "C", effect: "write" });
    expect(manifest.get("comms.add_reaction")).toMatchObject({ risk: "B" });
    expect(manifest.get("comms.evaluate_send")).toMatchObject({ risk: "A", effect: "read" });
  });

  it("send og delete oppfyller assessClassDPipeline; alle verktøy er eier-eksklusive; ingen verktøy har identitetsfelt i skjemaet", () => {
    for (const a of ["send", "delete_message"]) expect(assessClassDPipeline(defs.find((d) => d.action === a)!), a).toEqual({ complete: true, missing: [] });
    expect(defs.find((d) => d.action === "send")!.class_d_profile).toBe("outbound_message");
    for (const d of defs) {
      expect(d.owner_only, d.action).toBe(true);
      const shape = (d.input_schema as unknown as { shape: Record<string, unknown> }).shape;
      for (const f of ["tenant_id", "person_id", "actor_person_id", "memory_space", "ai_disclosure", "quiet_hours", "skip_policy"]) expect(Object.keys(shape), `${d.action}.${f}`).not.toContain(f);
    }
  });
});

describe("B: utsendelse gjennom hele kjeden", () => {
  it("vellykket sending: ok + leverandør-id, ledger `succeeded` med policy-evaluering som før-tilstand (uten tekst), journal `sent`, eier-varsel uten meldingstekst", async () => {
    const params = sendParams({ text: "Konfidensiell-tekst-42" });
    const r = await gateway.execute({ identity: owner, tool_id: "comms", action: "send", parameters: params as never, idempotency_key: params.request_id });
    expect(r.ok).toBe(true);
    expect(sms.calls).toHaveLength(1);
    expect(String(sms.calls[0]!.request["text"])).toContain("Konfidensiell-tekst-42");
    expect(sms.calls[0]!.credential).toBe("fake-token-for-test");
    const row = await ledger(params.request_id);
    expect(row?.status).toBe("succeeded");
    expect(row?.before_state).toMatchObject({ v: 1, allowed: true, channel: "sms", kind: "message" });
    expect(JSON.stringify(row)).not.toContain("Konfidensiell-tekst-42");
    expect(JSON.stringify(row)).not.toContain("+4790001111");
    const log = (await db.admin.query("SELECT status, provider_message_id FROM comms_outbound_log WHERE request_id = $1", [params.request_id])).rows;
    expect(log).toEqual([{ status: "sent", provider_message_id: r.ok ? r.external_id : null }]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ tool_id: "comms", action: "send", outcome: "executed" });
    expect(notifications[0]!.summary).toMatch(/via sms til \+47•+111 \(formål: transactional, grunnlag: existing_customer_relationship\)/);
    expect(JSON.stringify(notifications)).not.toContain("Konfidensiell-tekst-42");
  });

  it("preflight avslår FØR reservasjon: stille timer gir `preflight_invalid:quiet_hours`, ingen ledgerrad, ingen leverandørkall, ingen varsel", async () => {
    now = new Date("2026-11-17T22:30:00Z"); // 23:30 Oslo
    const params = sendParams();
    const r = await gateway.execute({ identity: owner, tool_id: "comms", action: "send", parameters: params as never, idempotency_key: params.request_id });
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.reason).toMatch(/^preflight_invalid:quiet_hours/);
    expect(await ledger(params.request_id)).toBeUndefined();
    expect(sms.calls).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });

  it("alle avslagskodene kommer med, aldri bare den første, og modellvalgte parametere kan ikke omgå dem", async () => {
    const r = await send({ purpose: "marketing", text: "Tilbud! Svar STOPP", recipient: "+4790002222" });
    expect(r.ok ? "" : r.reason).toMatch(/^preflight_invalid:marketing_blocked_reservation_register_unverified/);
    // modellen merker reklame som «transactional»: fanges av innholdsregelen
    const promo = await send({ text: "Spesialtilbud: 30% rabatt kun i dag", recipient: "+4790002223" });
    expect(promo.ok ? "" : promo.reason).toMatch(/content_looks_like_marketing/);
    expect(sms.calls).toHaveLength(0);
  });

  it("forfalskningsflater finnes ikke: ukjente felt (AI-opplysning av, tenant, hopp over policy) avvises av det strenge skjemaet", async () => {
    for (const extra of [{ ai_disclosure: false }, { tenant_id: "tenant-annen" }, { skip_policy: true }, { quiet_hours: "off" }, { account_ref_override: "+4799999999" }]) {
      const r = await send(extra);
      expect(r.ok, JSON.stringify(extra)).toBe(false);
    }
    expect(sms.calls).toHaveLength(0);
  });

  it("ikke-allowlistet konto: `credential_ref_unresolved` (ingen credential slås opp, ingenting sendes)", async () => {
    const r = await send({ account_ref: "+4791888888" });
    expect(r.ok ? "" : r.reason).toBe("credential_ref_unresolved");
    expect(sms.calls).toHaveLength(0);
  });

  it("påkrevd idempotensnøkkel, klar varsler og eier-eksklusivt håndheves av gatewayen", async () => {
    const params = sendParams();
    expect((await gateway.execute({ identity: owner, tool_id: "comms", action: "send", parameters: params as never })).ok).toBe(false);
    const noKey = await gateway.execute({ identity: owner, tool_id: "comms", action: "send", parameters: params as never });
    expect(noKey.ok ? "" : noKey.reason).toBe("class_d_idempotency_key_required");
    notifierReady = false;
    const notReady = await send();
    expect(notReady.ok ? "" : notReady.reason).toBe("class_d_notifier_not_ready");
    notifierReady = true;
    const asGuest = await send({}, undefined, guest);
    expect(asGuest.ok ? "" : asGuest.reason).toBe("credential_not_bound_to_identity");
    expect(sms.calls).toHaveLength(0);
  });

  it("samme nøkkel to ganger = deduplisert (ledger), leverandøren kalles ÉN gang, og eieren varsles ikke to ganger", async () => {
    const params = sendParams({ recipient: "+4790003333" });
    const first = await gateway.execute({ identity: owner, tool_id: "comms", action: "send", parameters: params as never, idempotency_key: params.request_id });
    const again = await gateway.execute({ identity: owner, tool_id: "comms", action: "send", parameters: params as never, idempotency_key: params.request_id });
    expect(first.ok && again.ok).toBe(true);
    expect(again.ok && again.deduplicated).toBe(true);
    expect(sms.calls).toHaveLength(1);
  });

  it("kill switch og frys (kanal-connector og comms-navnerommet) stopper utsendelsen FØR leverandørkallet", async () => {
    controls.freezeConnector("slack");
    const frozen = await send({ channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA" });
    expect(frozen.ok ? "" : frozen.reason).toBe("connector_frozen");
    controls.unfreezeConnector("slack");
    controls.freezeConnector("comms");
    expect((await send({ channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0BBBBBBBB" })).ok).toBe(false);
    controls.unfreezeConnector("comms");
    killSwitch.activate("test");
    const killed = await send({ recipient: "+4790004444" });
    expect(killed.ok).toBe(false);
    killSwitch.deactivate();
    expect(sms.calls).toHaveLength(0);
    expect(slack.calls).toHaveLength(0);
  });

  it("leverandørfeil: UKJENT utfall gir `unverified` i ledgeren (aldri retry-bar) og eieren varsles om ukjent utfall; entydig avslag gir `failed`", async () => {
    const unknown = scriptedAdapter("twilio", () => { throw new Error("outcome_unknown:comms_twilio_http_503"); });
    const graph = new ConversationGraphService(db.app);
    const funnel = new OutboundFunnel({ store, graph, adapters: { twilio: unknown }, config: parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "sms" }), clock });
    const gw2 = new ToolGateway(db.app, new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A] } }),
      { name: "fake", get: async (ref) => (ref === BUSINESS_INTERNAL_CREDENTIAL_REF ? "internal-no-external-credential" : "fake-token-for-test") }, controls, undefined, {
        classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (x) => { notifications.push(x); } } },
        credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT_A], internalRefs: new Set([BUSINESS_INTERNAL_CREDENTIAL_REF]) }
      });
    for (const d of commsToolDefinitions({ transport: new CommsTransport({ funnel, store }), store, rateLimitPerMinute: 1000 })) gw2.register(d);
    const params = sendParams({ recipient: "+4790005555" });
    const r = await gw2.execute({ identity: owner, tool_id: "comms", action: "send", parameters: params as never, idempotency_key: params.request_id });
    expect(r.ok).toBe(false);
    expect((await ledger(params.request_id))?.status).toBe("unverified");
    expect(notifications.at(-1)).toMatchObject({ outcome: "unknown" });
    const again = await gw2.execute({ identity: owner, tool_id: "comms", action: "send", parameters: params as never, idempotency_key: params.request_id });
    expect(again.ok).toBe(false);
    expect(unknown.calls).toHaveLength(1);
  });
});

describe("C: redigering, sletting, reaksjon og administrasjon gjennom gatewayen", () => {
  it("send -> rediger (C) -> reager (B) -> slett (D med fersk lesing og readback)", async () => {
    const sent = await send({ channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0DDDDDDDD", text: "Første" });
    expect(sent.ok).toBe(true);
    const id = sent.ok ? (sent.external_id as string) : "";
    const base = { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0DDDDDDDD", target_message_id: id };
    const edit = await gateway.execute({ identity: owner, tool_id: "comms", action: "edit_message", parameters: { request_id: key("req"), ...base, text: "Rettet" } as never, idempotency_key: key("edit") });
    expect(edit.ok).toBe(true);
    const react = await gateway.execute({ identity: owner, tool_id: "comms", action: "add_reaction", parameters: { request_id: key("req"), ...base, reaction: "thumbsup" } as never, idempotency_key: key("react") });
    expect(react.ok).toBe(true);
    // readback: slettingen krever at målet FINNES før og er borte etterpå (fake-adapteren svarer `exists` til slettingen er gjort)
    let deleted = false;
    const original = slack.messageExists!;
    slack.messageExists = async (r, c) => (deleted ? false : original(r, c));
    const delParams = { request_id: key("req"), ...base };
    const origDelete = slack.delete!;
    slack.delete = async (r, c) => { deleted = true; return origDelete(r, c); };
    const del = await gateway.execute({ identity: owner, tool_id: "comms", action: "delete_message", parameters: delParams as never, idempotency_key: delParams.request_id });
    expect(del).toMatchObject({ ok: true });
    expect(notifications.at(-1)).toMatchObject({ action: "delete_message", outcome: "executed" });
    slack.messageExists = original;
    slack.delete = origDelete;
  });

  it("sletting av en fremmed melding avslås i preflight (policy + `target_not_own_sent_message`), uten leverandørkall", async () => {
    slack.calls.length = 0;
    const del = await gateway.execute({
      identity: owner, tool_id: "comms", action: "delete_message",
      parameters: { request_id: key("req"), channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0DDDDDDDD", target_message_id: "9999.0001" } as never, idempotency_key: key("del")
    });
    expect(del.ok ? "" : del.reason).toMatch(/^preflight_invalid:target_not_own_sent_message/);
    expect(slack.calls.filter((c) => c.op === "delete")).toHaveLength(0);
  });

  it("administrasjon: kun eieren (guest nektes), opt-out-registrering, lister er tenant-isolerte og redigerte", async () => {
    const asGuest = await gateway.execute({ identity: guest, tool_id: "comms", action: "list_accounts", parameters: {} as never });
    expect(asGuest.ok ? "" : asGuest.reason).toBe("owner_only");
    const rec = await gateway.execute({ identity: owner, tool_id: "comms", action: "record_opt_out", parameters: { channel: "sms", account_ref: "+4791000000", recipient: "+4790009999" } as never, idempotency_key: key("optout") });
    expect(rec.ok).toBe(true);
    const blocked = await send({ recipient: "+4790009999" });
    expect(blocked.ok ? "" : blocked.reason).toMatch(/recipient_opted_out/);
    const list = await gateway.execute({ identity: owner, tool_id: "comms", action: "list_opt_outs", parameters: {} as never });
    expect(list.ok && JSON.stringify(list.data)).not.toContain("+4790009999");
    const journal = await gateway.execute({ identity: owner, tool_id: "comms", action: "list_outbound", parameters: { limit: 5 } as never });
    expect(journal.ok).toBe(true);
    expect(journal.ok && journal.output_trust).toBe("internal");
    // innkommende meldinger er ubetrodd data
    const inbound = await gateway.execute({ identity: owner, tool_id: "comms", action: "list_inbound", parameters: {} as never });
    expect(inbound.ok && inbound.output_trust).toBe("untrusted");
  });
});
