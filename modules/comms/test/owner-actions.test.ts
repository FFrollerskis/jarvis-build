import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { BUSINESS_INTERNAL_CREDENTIAL_REF } from "@jarvis/business";
import { ConversationGraphService } from "@jarvis/conversation-graph";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, OwnerControls, PolicyGateway } from "@jarvis/policy";
import { ToolGateway, type ClassDNotification, type SecretProvider } from "@jarvis/tool-gateway";
import {
  COMMS_ADMIN_ACTIONS, COMMS_OUTBOUND_ACTIONS, COMMS_OWNER_ACTIONS, COMMS_READ_ACTIONS, CommsStore, CommsTransport, OutboundFunnel, commsToolDefinitions, executeCommsOwnerAction, parseCommsConfig,
  previewCommsSend, type AdapterMap
} from "../src/index.ts";
import { OWNER, TENANT_A, scriptedAdapter, startCommsDb, type CommsDb } from "./support/harness.ts";

/**
 * WP-G1 (P1b): eierens handlingsflate (`executeCommsOwnerAction` / `previewCommsSend` - logikken bak `POST /comms/action` og `/comms/preview`) mot den EKSAKTE kjeden i produksjon: ekte ToolGateway (klasse D-pipeline påslått),
 * ekte policy, ekte journal (embedded Postgres, RLS som app-rolle) og skriptede adaptere (ingen nettkall). Beviser: forespørsels-id = idempotensnøkkel, avslag gir ALLE kodene + journalbevis, gjenspilling etter ukjent utfall,
 * tørrkjøring skriver ingenting og ekkoer aldri tekst, og at en ikke-eier aldri kommer gjennom.
 */
let db: CommsDb;
let store: CommsStore;
let now = new Date("2026-11-17T11:00:00Z"); // 12:00 Oslo (vintertid)
const clock = () => now;
const sms = scriptedAdapter("twilio");
const slack = scriptedAdapter("slack");
let gateway: ToolGateway;
let funnel: OutboundFunnel;
const notifications: ClassDNotification[] = [];

const owner: IdentityContext = { person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "business", session_id: "sess-g1-oa", device_id: "dev-g1", channel: "api", auth_strength: "signed" };
const guest: IdentityContext = { ...owner, person_id: "person-g1-guest", session_id: "sess-g1-oa-guest" };
let n = 0;
const key = (p: string) => `${p}-${++n}-${Math.random().toString(36).slice(2, 8)}`;
// Hvert testtilfelle bruker sitt EGET mottakernummer (kald mottaker: maks 1 per døgn) - unike 8-sifrede numre.
const phone = () => `+4790${String(100000 + ++n).padStart(6, "0").slice(-6)}`;
const ownerGate = (identity: IdentityContext): boolean => identity.person_id === OWNER && identity.tenant_id === TENANT_A;
const deps = () => ({ gateway, funnel, ownerGate });
/** Porten åpen for ALLE - viser at gatewayens egen `owner_only`-binding er en selvstendig forsvarslinje. */
const openGateDeps = () => ({ gateway, funnel, ownerGate: (_identity: IdentityContext) => true });

beforeAll(async () => {
  db = await startCommsDb("g1oa");
  store = new CommsStore(db.app, clock);
  const graph = new ConversationGraphService(db.app);
  const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "sms,slack" });
  const adapters: AdapterMap = { twilio: sms, slack };
  funnel = new OutboundFunnel({ store, graph, adapters, config, clock });
  const killSwitch = new KillSwitch();
  const controls = new OwnerControls(killSwitch);
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, controls, authority: { owner_person_id: OWNER, owner_tenants: [TENANT_A] } });
  const secrets: SecretProvider = { name: "fake", get: async (ref) => (ref === BUSINESS_INTERNAL_CREDENTIAL_REF ? "internal-no-external-credential" : ref.startsWith("JARVIS_") ? "fake-token-for-test" : null) };
  gateway = new ToolGateway(db.app, policy, secrets, controls, undefined, {
    classDPipeline: { enforce: true, notifier: { ready: () => true, notify: async (x) => { notifications.push(x); } } },
    credentialBinding: { owner_person_id: OWNER, owner_tenants: [TENANT_A], internalRefs: new Set([BUSINESS_INTERNAL_CREDENTIAL_REF]) }
  });
  for (const d of commsToolDefinitions({ transport: new CommsTransport({ funnel, store }), store, rateLimitPerMinute: 1000 })) gateway.register(d);
  // Eierens allowlist, via den EKSAKTE eier-handlingen (ikke direkte i basen).
  for (const [channel, account_ref, provider] of [["sms", "+4791000000", "twilio"], ["slack", "T0AAAAAAAA", "slack"]] as const) {
    const r = await executeCommsOwnerAction(deps(), owner, { action: "authorize_account", parameters: { channel, account_ref, provider }, idempotency_key: key("auth") });
    if (!r.ok) throw new Error(`authorize: ${JSON.stringify(r)}`);
  }
}, 240_000);

afterAll(async () => { await db?.stop(); }, 120_000);

beforeEach(() => {
  now = new Date("2026-11-17T11:00:00Z");
  sms.calls.length = 0;
  slack.calls.length = 0;
  notifications.length = 0;
});

const sendParams = (over: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({ channel: "sms", account_ref: "+4791000000", recipient: phone(), purpose: "transactional", text: "Hei, timen din er bekreftet.", ...over });
const journal = async (requestId: string) => (await db.admin.query("SELECT status, denial_codes, rule_evaluation, content_sha256, content_length, recipient_hint, request_id FROM comms_outbound_log WHERE request_id = $1 ORDER BY created_at", [requestId])).rows as
  Array<{ status: string; denial_codes: string[]; rule_evaluation: unknown; content_sha256: string; content_length: number; recipient_hint: string; request_id: string }>;
const journalCount = async () => ((await db.admin.query("SELECT count(*)::int AS n FROM comms_outbound_log")).rows[0] as { n: number }).n;

describe("A: handlingslisten og forespørselens form", () => {
  it("handlingsmengdene er disjunkte og dekker nøyaktig det verktøyene tilbyr eieren (ingen skjult flate)", () => {
    const all = [...COMMS_OUTBOUND_ACTIONS, ...COMMS_ADMIN_ACTIONS, ...COMMS_READ_ACTIONS];
    expect(new Set(all).size).toBe(all.length);
    expect([...COMMS_OWNER_ACTIONS].sort()).toEqual([...all].sort());
    for (const action of COMMS_OWNER_ACTIONS) expect(gateway.get("comms", action), action).toBeDefined();
  });

  it("ukjent handling og verktøy-interne hjelpehandlinger (evaluate_send, check_message_target) avvises FØR gatewayen er nådd", async () => {
    for (const action of ["", "nope", "evaluate_send", "check_message_target", "send ", "SEND", "__proto__", "constructor", "toString"]) {
      const r = await executeCommsOwnerAction(deps(), owner, { action, parameters: {}, idempotency_key: key("x") });
      expect(r, action).toEqual({ ok: false, status: "rejected", reason: "comms_unknown_action" });
    }
    expect(sms.calls).toEqual([]);
  });

  it("sending/redigering/sletting/reaksjon krever idempotensnøkkel av en gyldig form - ellers avvises forespørselen uten journal og uten kall", async () => {
    const before = await journalCount();
    for (const action of COMMS_OUTBOUND_ACTIONS) {
      for (const bad of [undefined, "", "short", "has space in it", "x".repeat(201), "ok-ok-ok\nnewline"]) {
        const r = await executeCommsOwnerAction(deps(), owner, { action, parameters: sendParams(), ...(bad !== undefined ? { idempotency_key: bad } : {}) });
        expect(r, `${action}:${String(bad)}`).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_required" });
      }
    }
    expect(await journalCount()).toBe(before);
    expect(sms.calls).toEqual([]);
  });

  it("en innsendt request_id som avviker fra idempotensnøkkelen avvises (journal og ledger kan aldri komme ut av takt); lik verdi er OK", async () => {
    const idem = key("rid");
    const mismatch = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: sendParams({ request_id: "annen-id-00000001" }), idempotency_key: idem });
    expect(mismatch).toEqual({ ok: false, status: "rejected", reason: "comms_request_id_mismatch" });
    const same = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: sendParams({ request_id: idem }), idempotency_key: idem });
    expect(same.ok).toBe(true);
    expect((await journal(idem)).map((r) => r.status)).toEqual(["sent"]);
  });

  it("parametre utenfor skjemaet (ekstra felt, identitetsfelt, feil typer) avvises som `invalid_parameters` før noe skjer", async () => {
    const before = await journalCount();
    for (const extra of [{ tenant_id: "tenant-g1-b" }, { memory_space: "personal" }, { person_id: "x" }, { force: true }, { ai_disclosure: false }, { skip_policy: true }, { quiet_hours: "off" }]) {
      const r = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: sendParams(extra as Record<string, JsonValue>), idempotency_key: key("ex") });
      expect(r, JSON.stringify(extra)).toEqual({ ok: false, status: "rejected", reason: "invalid_parameters" });
    }
    expect(await journalCount()).toBe(before);
    expect(sms.calls).toEqual([]);
  });
});

describe("B: sending - policy, journal, idempotens og gjenspilling", () => {
  it("gyldig sending: ett adapterkall med riktig credential, journal `sent` med request_id = idempotensnøkkel, innhold kun som hash+lengde, eier-varsel uten tekst", async () => {
    const idem = key("ok");
    const text = "Hei, timen din er bekreftet fredag.";
    const r = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: sendParams({ text }), idempotency_key: idem });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.external_id).toBe("msg-1");
    expect(r.deduplicated).toBe(false);
    expect(sms.calls).toHaveLength(1);
    expect(sms.calls[0]?.credential).toBe("fake-token-for-test");
    const rows = await journal(idem);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.content_length).toBeGreaterThan(text.length); // AI-opplysningen er lagt til av koden
    expect(JSON.stringify(rows)).not.toContain("timen din");
    expect(notifications.length).toBeGreaterThan(0);
    expect(JSON.stringify(notifications)).not.toContain("timen din");
  });

  it("gjenspilling med SAMME nøkkel (f.eks. etter at klienten ikke så svaret) sender ALDRI to ganger - gatewayens ledger gir det første resultatet tilbake", async () => {
    const idem = key("replay");
    const params = sendParams();
    const first = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: params, idempotency_key: idem });
    const again = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: params, idempotency_key: idem });
    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.external_id).toBe(first.external_id);
    expect(again.deduplicated).toBe(true);
    expect(sms.calls).toHaveLength(1);
    expect((await journal(idem)).map((x) => x.status)).toEqual(["sent"]);
  });

  it("en NY nøkkel er alltid et nytt forsøk: samme mottaker igjen samme døgn stoppes av policyen (kald mottaker maks 1 per døgn) - ikke av nøkkelen", async () => {
    const recipient = phone();
    const a = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: sendParams({ recipient }), idempotency_key: key("n1") });
    expect(a.ok).toBe(true);
    const b = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: sendParams({ recipient }), idempotency_key: key("n2") });
    expect(b.ok).toBe(false);
    if (b.ok || b.status !== "denied") throw new Error(`forventet avslag: ${JSON.stringify(b)}`);
    expect(b.denial_codes).toContain("rate_limit_cold_recipient_day");
    expect(sms.calls).toHaveLength(1);
  });

  it("avslag gir ALLE avslagskodene samtidig (ingen kortslutning), journalfører beviset (`denied`, regelutfall, hash - aldri tekst) og sender ingenting", async () => {
    now = new Date("2026-11-17T22:30:00Z"); // 23:30 Oslo = stille timer
    const idem = key("deny");
    const text = "KJØP NÅ! Tilbud med 50% rabatt - bestill i dag";
    const r = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: sendParams({ text, purpose: "marketing" }), idempotency_key: idem });
    expect(r.ok).toBe(false);
    if (r.ok || r.status !== "denied") throw new Error(`forventet avslag: ${JSON.stringify(r)}`);
    expect(r.denial_codes).toEqual(expect.arrayContaining(["quiet_hours", "marketing_blocked_reservation_register_unverified"]));
    expect(r.denial_codes.length).toBeGreaterThanOrEqual(2);
    expect(typeof r.journal_id).toBe("string");
    expect(sms.calls).toEqual([]);
    const rows = await journal(idem);
    expect(rows.map((x) => x.status)).toEqual(["denied"]);
    expect(rows[0]?.denial_codes).toEqual(expect.arrayContaining(["quiet_hours"]));
    expect(JSON.stringify(rows)).not.toMatch(/rabatt|KJØP/);
    expect(JSON.stringify(r)).not.toMatch(/rabatt|KJØP/);
  });

  it("et avslag kan prøves igjen med SAMME nøkkel når tilstanden er endret (journalens unike nøkkel gjelder kun ikke-avslåtte rader)", async () => {
    now = new Date("2026-11-17T22:30:00Z");
    const idem = key("retry");
    const params = sendParams();
    const denied = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: params, idempotency_key: idem });
    expect(denied.ok).toBe(false);
    now = new Date("2026-11-18T10:00:00Z"); // 11:00 Oslo
    const ok = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: params, idempotency_key: idem });
    expect(ok.ok).toBe(true);
    expect((await journal(idem)).map((x) => x.status).sort()).toEqual(["denied", "sent"]);
  });

  it("modellvalgte/eier-skrevne parametre kan ikke omgå opt-out, stille timer eller AI-opplysning: en registrert avmelding stopper selv en `agreed`-melding", async () => {
    const recipient = phone();
    const optOut = await executeCommsOwnerAction(deps(), owner, { action: "record_opt_out", parameters: { channel: "sms", account_ref: "+4791000000", recipient } });
    expect(optOut.ok).toBe(true);
    const r = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: sendParams({ recipient, purpose: "agreed" }), idempotency_key: key("oo") });
    expect(r.ok).toBe(false);
    if (r.ok || r.status !== "denied") throw new Error(`forventet avslag: ${JSON.stringify(r)}`);
    expect(r.denial_codes).toContain("recipient_opted_out");
    expect(sms.calls).toEqual([]);
  });

  it("en ukjent/ikke-allowlistet konto avvises av policyen med journalført bevis (ingen sending fra en konto eieren ikke har autorisert)", async () => {
    const idem = key("acct");
    const r = await executeCommsOwnerAction(deps(), owner, { action: "send", parameters: sendParams({ account_ref: "+4799999999" }), idempotency_key: idem });
    expect(r.ok).toBe(false);
    if (r.ok || r.status !== "denied") throw new Error(`forventet avslag: ${JSON.stringify(r)}`);
    expect(r.denial_codes).toContain("account_not_authorized");
    expect((await journal(idem)).map((x) => x.status)).toEqual(["denied"]);
    expect(sms.calls).toEqual([]);
  });
});

describe("C: tørrkjøring (`/comms/preview`)", () => {
  it("skriver ingenting (ingen journal, ingen adapterkall, ingen ledger), viser alle regelutfall og ekkoer aldri meldingsteksten", async () => {
    const before = await journalCount();
    const text = "Hemmelig innhold som ikke skal vises i forhåndsvisningen";
    const r = await previewCommsSend(deps(), owner, sendParams({ text }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = JSON.stringify(r.data);
    expect(out).not.toContain("Hemmelig");
    expect(r.data).toMatchObject({ allowed: true, channel: "sms", provider: "twilio" });
    expect(await journalCount()).toBe(before);
    expect(sms.calls).toEqual([]);
  });

  it("viser avslag med alle koder uten å journalføre; ugyldige parametre gir fast kode", async () => {
    now = new Date("2026-11-17T22:30:00Z");
    const denied = await previewCommsSend(deps(), owner, sendParams({ purpose: "marketing", text: "Rabatt!" }));
    expect(denied.ok).toBe(true);
    if (!denied.ok) return;
    expect(denied.data).toMatchObject({ allowed: false });
    expect((denied.data as { denial_codes: string[] }).denial_codes.length).toBeGreaterThanOrEqual(2);
    const bad = await previewCommsSend(deps(), owner, { channel: "sms" });
    expect(bad).toEqual({ ok: false, status: "rejected", reason: "invalid_parameters" });
  });
});

describe("D: eier-binding og administrasjon", () => {
  const guestParams = (action: string): Record<string, JsonValue> => (action === "send" ? sendParams() : { channel: "sms", account_ref: "+4791000000", recipient: "+4790009999", provider: "twilio" });

  it("en ikke-eier (selv i samme tenant) nektes av eier-porten FØR policy, journal og gateway - heller ikke et avslag kan skrives i journalen", async () => {
    const before = await journalCount();
    for (const action of [...COMMS_OWNER_ACTIONS, "nope"]) {
      const r = await executeCommsOwnerAction(deps(), guest, { action, parameters: guestParams(action), idempotency_key: key("g") });
      expect(r, action).toEqual({ ok: false, status: "rejected", reason: "owner_required" });
    }
    // også en forespørsel som policyen ville avslått (stille timer) skriver ingen rad for en ikke-eier
    now = new Date("2026-11-17T22:30:00Z");
    const quiet = await executeCommsOwnerAction(deps(), guest, { action: "send", parameters: sendParams(), idempotency_key: key("g") });
    expect(quiet).toEqual({ ok: false, status: "rejected", reason: "owner_required" });
    expect(await previewCommsSend(deps(), guest, sendParams())).toEqual({ ok: false, status: "rejected", reason: "owner_required" });
    expect(await journalCount()).toBe(before);
    expect(sms.calls).toEqual([]);
  });

  it("fail-closed: uten eier-port, med en port som kaster, eller med en port som svarer noe annet enn `true` nektes alt", async () => {
    const identityParams = { action: "list_accounts", parameters: {} };
    for (const gate of [undefined, () => { throw new Error("boom"); }, () => "yes" as unknown as boolean, () => 1 as unknown as boolean, () => false]) {
      const r = await executeCommsOwnerAction({ gateway, funnel, ownerGate: gate as never }, owner, identityParams);
      expect(r).toEqual({ ok: false, status: "rejected", reason: "owner_required" });
    }
  });

  it("dyp forsvarslinje: selv med eier-porten åpen for alle avviser gatewayens egen eier-binding en ikke-eier (ingenting sendes eller journalføres)", async () => {
    const before = await journalCount();
    for (const action of ["send", "authorize_account", "record_opt_out", "list_outbound"]) {
      const r = await executeCommsOwnerAction(openGateDeps(), guest, { action, parameters: guestParams(action), idempotency_key: key("g2") });
      expect(r.ok, action).toBe(false);
    }
    expect(await journalCount()).toBe(before);
    expect(sms.calls).toEqual([]);
  });

  it("lesehandlingene viser journal uten tekst, kontoer og avmeldinger (maskert mottaker)", async () => {
    const outbound = await executeCommsOwnerAction(deps(), owner, { action: "list_outbound", parameters: { limit: 5 } });
    expect(outbound.ok).toBe(true);
    if (!outbound.ok) return;
    expect(JSON.stringify(outbound.data)).not.toMatch(/timen din|Hei,/);
    const accounts = await executeCommsOwnerAction(deps(), owner, { action: "list_accounts", parameters: {} });
    expect(accounts.ok).toBe(true);
    if (!accounts.ok) return;
    expect(JSON.stringify(accounts.data)).toContain("+4791000000");
    const optOuts = await executeCommsOwnerAction(deps(), owner, { action: "list_opt_outs", parameters: {} });
    expect(optOuts.ok).toBe(true);
    if (!optOuts.ok) return;
    expect(JSON.stringify(optOuts.data)).not.toMatch(/\+4790\d{6}(?!\d)/); // aldri et fullt nummer
  });
});
