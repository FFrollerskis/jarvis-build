import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  COMMS_CHANNELS, CommsWebhookService, MeetingService, WEBHOOK_SECRET_REFS, evaluateOutboundPolicy, isQuietHour, optOutHash, parseCommsConfig, parseMetaBody, parseSendParams, previewCommsSend, recipientHash, rateCaps,
  type OutboundPolicyState, type OutboundRequest, type WebhookRequest
} from "../src/index.ts";
import { OWNER, TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1 fiks-runde, LAV-prioritet (billige rettelser og testhull fra begge reviews):
 *  - L2: rom-sjekk i rute-laget (helse-rommet skriver aldri comms-rader), og samme konto i to rom gir en ryddig feilkode (ikke et lekket TypeError),
 *  - L1: de overlevende mutantene (stille-timer-grensen kl. 22, `lastInboundAt` kun for `message`, `findSentMessage` kun `message`+`sent`, `safeError` aldri rå tekst),
 *  - tom hemmelighet (`""`) gir 503 `not_configured` for alle fire leverandører og Metas håndtrykk,
 *  - WhatsApp-knappsvar (STOP-knapp) tolkes, og samtidig møte-ingest av samme innhold gir dedupe (ikke unique-feil).
 */
let chain: Chain;
const NOW = 1_763_380_800;

beforeAll(async () => {
  chain = await startChain("g1low");
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"], ["slack", "T0AAAAAAAA", "slack"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("L2: rom-sjekk i rute-laget og ryddig feil for samme konto i to rom", () => {
  const healthOwner: IdentityContext = { person_id: OWNER, tenant_id: TENANT_A, memory_space_id: "health", session_id: "sess-low-health", device_id: "dev-low", channel: "api", auth_strength: "signed" };

  it("en identitet i rommet `health` (og home/guest) avvises FØR policy/journal/gateway: `comms_space_not_allowed`, ingen rader i noen comms-tabell - heller ikke for tørrkjøring og avslag", async () => {
    const before = ((await chain.db.admin.query("SELECT (SELECT count(*) FROM comms_outbound_log) + (SELECT count(*) FROM comms_authorized_accounts) + (SELECT count(*) FROM comms_recipient_opt_outs) AS n")).rows[0] as { n: string }).n;
    for (const space of ["health", "home", "guest"]) {
      const identity = { ...healthOwner, memory_space_id: space } as IdentityContext;
      const send = await chain.act("send", { channel: "sms", account_ref: "+4791000000", recipient: chain.phone(), purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei" }, chain.key("hs"), identity);
      expect(send, space).toEqual({ ok: false, status: "rejected", reason: "comms_space_not_allowed" });
      expect((await chain.act("list_accounts", {}, undefined, identity)), space).toEqual({ ok: false, status: "rejected", reason: "comms_space_not_allowed" });
      expect((await chain.act("record_opt_out", { channel: "sms", recipient: chain.phone() }, undefined, identity)).ok, space).toBe(false);
      const deps = { gateway: chain.gateway, funnel: chain.funnel, ownerGate: (i: IdentityContext) => i.person_id === OWNER };
      expect(await previewCommsSend(deps, identity, { channel: "sms", account_ref: "+4791000000", recipient: chain.phone(), purpose: "transactional", text: "Hei" }), space).toEqual({ ok: false, status: "rejected", reason: "comms_space_not_allowed" });
    }
    const after = ((await chain.db.admin.query("SELECT (SELECT count(*) FROM comms_outbound_log) + (SELECT count(*) FROM comms_authorized_accounts) + (SELECT count(*) FROM comms_recipient_opt_outs) AS n")).rows[0] as { n: string }).n;
    expect(after).toBe(before);
    expect(((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_outbound_log WHERE memory_space_id = 'health'")).rows[0] as { n: number }).n).toBe(0);
  });

  it("samme konto autorisert i et annet rom gir en fast, ryddig feilkode (`comms_account_authorized_in_another_room`) - aldri «Cannot read properties of undefined»", async () => {
    const personalOwner: IdentityContext = { ...chain.owner, memory_space_id: "personal", session_id: "sess-low-personal" };
    const r = await chain.act("authorize_account", { channel: "sms", account_ref: "+4791000000", provider: "twilio" }, chain.key("sp2"), personalOwner);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("comms_account_authorized_in_another_room");
    expect(JSON.stringify(r)).not.toContain("Cannot read properties");
    // samme rom: fortsatt idempotent
    const again = await chain.act("authorize_account", { channel: "sms", account_ref: "+4791000000", provider: "twilio" }, chain.key("sp3"));
    expect(again.ok && (again.data as { created: boolean }).created).toBe(false);
  });
});

describe("L1: stille-timer-grensen kl. 22 (mutant QH-1)", () => {
  const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: COMMS_CHANNELS.join(",") });
  const warm: OutboundPolicyState = {
    account_authorized: true, recipient_opted_out: false, sends_last_24h_to_recipient: 0, calls_last_24h_to_recipient: 0, sends_last_hour_from_account: 0, last_inbound_at: null,
    recipient_identity: { identity_id: "id-1", confidence: 1, match_method: "exact_phone_e164" }, target: null, marketing: { prior_consent: false, reservation_register: "unverified" }
  };
  const sms: OutboundRequest = { kind: "message", channel: "sms", account_ref: "+4791000000", recipient: "+4790000000", purpose: "transactional", content: { text: "Hei, timen din er bekreftet." } };
  const at = (utc: string) => evaluateOutboundPolicy(sms, warm, config, new Date(utc)).denial_codes;

  it("kl. 22:00 Oslo (21:00Z) er stille (grensen er INKLUSIV), 21:59 er det ikke; 07:59 er stille, 08:00 (07:00Z) er det ikke - på begge sider av begge grensene", () => {
    expect(at("2026-11-17T20:59:59Z")).not.toContain("quiet_hours"); // 21:59:59 Oslo
    expect(at("2026-11-17T21:00:00Z")).toContain("quiet_hours"); // 22:00:00 Oslo
    expect(at("2026-11-18T06:59:59Z")).toContain("quiet_hours"); // 07:59:59 Oslo
    expect(at("2026-11-18T07:00:00Z")).not.toContain("quiet_hours"); // 08:00:00 Oslo
    expect(isQuietHour(22, 22, 8)).toBe(true);
    expect(isQuietHour(21, 22, 8)).toBe(false);
    expect(isQuietHour(7, 22, 8)).toBe(true);
    expect(isQuietHour(8, 22, 8)).toBe(false);
  });
});

describe("L1: lastInboundAt og findSentMessage (mutantene WIN-1 og TGT-2)", () => {
  const inboundInput = (kind: "message" | "status" | "opt_out" | "opt_in" | "other", hash: string, n: number) => ({
    provider: "twilio" as const, channel: "sms" as const, account_ref: "+4791000000", event_key: `evt-low-${kind}-${n}-${Math.random().toString(36).slice(2, 7)}`, kind, sender_hash: hash, sender_hint: "+47•••000", identity_id: null,
    thread_ref: null, content_excerpt: null, content_sha256: null, provider_ts: null, ingest_id: `ingest-low-${n}-abcdefgh`
  });

  it("`lastInboundAt` teller KUN `message`-hendelser: status, opt_out, opt_in og other gir `null` (de åpner ikke kundeservicevinduet eller stille-timer-unntaket)", async () => {
    const num = chain.phone();
    const hash = recipientHash(TENANT_A, "sms", num);
    for (const [i, kind] of (["status", "opt_out", "opt_in", "other"] as const).entries()) await chain.store.recordInbound(TENANT_A, "business", inboundInput(kind, hash, i), 30);
    expect(await chain.store.lastInboundAt(TENANT_A, "business", "sms", "+4791000000", hash)).toBeNull();
    await chain.store.recordInbound(TENANT_A, "business", inboundInput("message", hash, 9), 30);
    expect(await chain.store.lastInboundAt(TENANT_A, "business", "sms", "+4791000000", hash)).toBe(chain.now().toISOString());
  });

  it("`findSentMessage` finner KUN en melding (kind `message`) med status `sent`: reaksjons-/redigeringsrader og meldinger som ikke er sendt kan ikke gjøre en fremmed melding «egen»", async () => {
    const entry = (over: Record<string, unknown>) => ({
      request_id: chain.key("req-low"), kind: "message" as const, channel: "slack" as const, account_ref: "T0AAAAAAAA", provider: "slack" as const, recipient_hash: recipientHash(TENANT_A, "slack", "C0LLLLLLLL"), recipient_hint: "C0LL…LLL",
      purpose: "transactional" as const, rule_evaluation: [], denial_codes: [], recipient_proof: { method: "explicit_param" as const, identity_id: null, confidence: null, last_inbound_age_minutes: null }, content_sha256: null,
      content_length: 3, ai_disclosure_applied: true, source: "tool" as const, ...over
    });
    const open = rateCaps("reaction", true, chain.config); // ingen mottakertak; kontotak 1000
    const settle = async (over: Record<string, unknown>, status: "sent" | "failed" | "outcome_unknown", providerMessageId: string) => {
      const b = await chain.store.beginAttempt(TENANT_A, "business", entry(over) as never, chain.ctx.actor, 30, { ...open, account: { limit: 1_000_000, code: "x" } });
      if (b.kind !== "started") throw new Error("started forventet");
      await chain.store.settleAttempt(TENANT_A, "business", b.log_id, { status, provider_message_id: providerMessageId });
    };
    await settle({ kind: "reaction" }, "sent", "1731840000.000111"); // en REAKSJON med denne meldings-id-en: ikke en sendt melding
    expect(await chain.store.findSentMessage(TENANT_A, "business", "slack", "1731840000.000111")).toBeNull();
    await settle({ kind: "edit" }, "sent", "1731840000.000222");
    expect(await chain.store.findSentMessage(TENANT_A, "business", "slack", "1731840000.000222")).toBeNull();
    await settle({}, "failed", "1731840000.000333"); // en melding som IKKE ble sendt
    expect(await chain.store.findSentMessage(TENANT_A, "business", "slack", "1731840000.000333")).toBeNull();
    await settle({}, "outcome_unknown", "1731840000.000444");
    expect(await chain.store.findSentMessage(TENANT_A, "business", "slack", "1731840000.000444")).toBeNull();
    await settle({}, "sent", "1731840000.000555"); // en ekte sendt melding
    expect(await chain.store.findSentMessage(TENANT_A, "business", "slack", "1731840000.000555")).toMatchObject({ account_ref: "T0AAAAAAAA", recipient_hash: recipientHash(TENANT_A, "slack", "C0LLLLLLLL") });
  });
});

describe("L1: safeError - journalen lagrer aldri rå feiltekst (mutant SAFE-1)", () => {
  it("en adapterfeil med fritekst (kan sitere token/klientdata) lagres som fast kode; en trygg kode beholdes", async () => {
    const saved = chain.twilio.send;
    const run = async (message: string) => {
      chain.twilio.send = async () => { throw new Error(message); };
      const p = { request_id: chain.key("req-se"), channel: "sms", account_ref: "+4791000000", recipient: chain.phone(), purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei, timen din er bekreftet." };
      const parsed = parseSendParams(p);
      if (!parsed.ok) throw new Error(parsed.code);
      await chain.funnel.execute(chain.ctx, parsed.value, "t").catch(() => undefined);
      return ((await chain.db.admin.query("SELECT after_state FROM comms_outbound_log WHERE request_id = $1", [p.request_id])).rows[0] as { after_state: { error: string } }).after_state.error;
    };
    try {
      expect(await run("Bad token xoxb-1234567890-abcdefghij for klient Ola Nordmann +4790000000")).toBe("comms_unspecified_error");
      expect(await run("comms_some_safe_code")).toBe("comms_some_safe_code");
    } finally { chain.twilio.send = saved; }
  });
});

describe("tom hemmelighet er IKKE konfigurert (fail-closed) for alle fire leverandører og Metas håndtrykk", () => {
  it("`secrets.get` som gir tom streng gir 503 `not_configured` - aldri en verifisering mot en tom nøkkel", async () => {
    const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "sms", JARVIS_COMMS_WEBHOOKS: "slack,meta,twilio,telnyx", JARVIS_COMMS_TENANT_ID: TENANT_A, JARVIS_COMMS_PUBLIC_BASE_URL: "https://hooks.example.com" });
    const service = new CommsWebhookService({ store: {} as never, graph: {} as never, config, secrets: { get: async () => "" }, clock: () => new Date(NOW * 1000) });
    const raw = Buffer.from("{}");
    // en signatur beregnet med den TOMME nøkkelen ville vært «gyldig» hvis tom nøkkel ble godtatt
    const empty = (data: Buffer | string) => createHmac("sha256", "").update(data).digest("hex");
    const req = (headers: Record<string, string>): WebhookRequest => ({ method: "POST", headers, rawBody: raw, pathAndQuery: "/", query: new URLSearchParams() });
    const results = [
      await service.handle("slack", req({ "x-slack-request-timestamp": String(NOW), "x-slack-signature": `v0=${empty(Buffer.concat([Buffer.from(`v0:${NOW}:`), raw]))}` })),
      await service.handle("meta", req({ "x-hub-signature-256": `sha256=${empty(raw)}` })),
      await service.handle("twilio", { ...req({ "x-twilio-signature": "x" }), rawBody: Buffer.from("Body=x") }),
      await service.handle("telnyx", req({ "telnyx-signature-ed25519": "x", "telnyx-timestamp": String(NOW) })),
      await service.handle("meta", { method: "GET", headers: {}, rawBody: Buffer.alloc(0), pathAndQuery: "/", query: new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "abc" }) })
    ];
    for (const r of results) expect(r).toEqual({ status: 503, body: { error: "not_configured" } });
    expect(WEBHOOK_SECRET_REFS.meta).toBe("JARVIS_META_APP_SECRET");
  });
});

describe("WhatsApp-knappsvar tolkes (L6: en STOP-knapp ignoreres ikke lenger)", () => {
  const wa = (message: Record<string, unknown>, from = "4790000900", id = "wamid.btn1") => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "109876543210" }, messages: [{ from, id, timestamp: String(NOW), ...message }] } }] }]
  });

  it("parseren leser `button.text`, `interactive.button_reply.title` og `list_reply.title`; ukjente former gir `null` (aldri en feil)", () => {
    const text = (m: Record<string, unknown>) => parseMetaBody(wa(m)).events[0]?.text;
    expect(text({ type: "text", text: { body: "Hei" } })).toBe("Hei");
    expect(text({ type: "button", button: { text: "Stopp", payload: "STOP_PROMO" } })).toBe("Stopp");
    expect(text({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "STOP" } } })).toBe("STOP");
    expect(text({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "l1", title: "Avmeld" } } })).toBe("Avmeld");
    expect(text({ type: "image", image: { id: "x" } })).toBeNull();
    expect(text({ type: "button", button: {} })).toBeNull();
    expect(text({ type: "interactive", interactive: "streng" })).toBeNull();
  });

  it("en STOP-knapp (button/interactive) registrerer avmelding via hele inntaket, tenant-bredt", async () => {
    const META = "fake-meta-app-secret-low";
    const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "whatsapp", JARVIS_COMMS_WEBHOOKS: "meta", JARVIS_COMMS_TENANT_ID: TENANT_A });
    await authorizeAll(chain, [["whatsapp", "109876543210", "meta_whatsapp"]]);
    const service = new CommsWebhookService({ store: chain.store, graph: chain.graph, config, secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.meta ? META : null) }, clock: () => new Date(NOW * 1000) });
    const post = (body: object): Promise<{ status: number; body: unknown }> => {
      const raw = Buffer.from(JSON.stringify(body));
      return service.handle("meta", { method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", META).update(raw).digest("hex")}` }, rawBody: raw, pathAndQuery: "/", query: new URLSearchParams() });
    };
    const r = await post(wa({ type: "button", button: { text: "Stopp", payload: "STOP_PROMO" } }));
    expect(r.body).toMatchObject({ events: { inserted: 1, opt_outs: 1 } });
    expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", "+4790000900"))).toBe(true); // telefon-navnerommet: gjelder også SMS og samtale
    const r2 = await post(wa({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b2", title: "Ja takk" } } }, "4790000901", "wamid.btn2"));
    expect(r2.body).toMatchObject({ events: { inserted: 1, opt_outs: 0 } });
    expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", "+4790000901"))).toBe(false);
  });
});

describe("samtidig møte-ingest av SAMME innhold gir dedupe (ikke unique-feil)", () => {
  it("to samtidige ingestText med lik tekst: ett møte, den andre får `deduplicated: true`", async () => {
    const svc = new MeetingService({ pool: chain.db.app, clock: chain.now, graph: chain.graph, retentionDays: 180 });
    const text = ["Tittel: Samtidighetsmøte", "Dato: 2026-11-16", "Deltakere: Ola Nordmann", `Ola Nordmann: Jeg skal sende tilbudet innen 20. november ${chain.key("m")}.`].join("\n");
    const meetingCtx = { tenantId: TENANT_A, space: "business" as const, actor: { person_id: OWNER, session_id: "sess-low-mt" } };
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => svc.ingestText(meetingCtx, { format: "txt", text, attest_legal_basis: true })));
    expect(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.filter((r) => r.status === "rejected"))).toBe(true);
    const summaries = results.map((r) => (r as PromiseFulfilledResult<{ meeting_id: string; deduplicated: boolean }>).value);
    expect(new Set(summaries.map((s) => s.meeting_id)).size).toBe(1);
    expect(summaries.filter((s) => !s.deduplicated)).toHaveLength(1);
  });
});
