import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BusinessService } from "@jarvis/business";
import { ConversationGraphService } from "@jarvis/conversation-graph";
import {
  CommsStore, DEFAULT_AI_DISCLOSURE_TEXT, OutboundFunnel, ProviderRejectedError, optOutHash, parseCommsConfig, parseDeleteParams, parseEditParams, parseReactParams, parseSendParams, recipientHash,
  type AdapterMap, type FunnelContext, type MarketingBasisPort, type ParsedOutbound
} from "../src/index.ts";
import { OWNER, TENANT_A, TENANT_B, scriptedAdapter, startCommsDb, type CommsDb, testContentHasher } from "./support/harness.ts";

/**
 * WP-G1 (P1b/P1c): trakten (policy + journal + adapter) mot EKTE Postgres/RLS med falske adaptere. Bevist: journalføring før/etter, hash i stedet for tekst, gjenspillingsvern etter sendt/ukjent/feilet utfall,
 * opt-out som ikke kan omgås, kundeservicevinduet fra verifiserte innkommende hendelser, egen-melding-regelen for redigering/sletting, D-121-tidslinje, tenant-isolasjon og journalens tilstandsmaskin.
 */
let db: CommsDb;
let store: CommsStore;
let graph: ConversationGraphService;
let business: BusinessService;
let now = new Date("2026-11-17T11:00:00Z"); // 12:00 Europe/Oslo
const clock = () => now;
const config = parseCommsConfig({ JARVIS_COMMS_OUTBOUND: "on", JARVIS_COMMS_CHANNELS: "slack,discord,whatsapp,sms,teams,messenger,instagram,phone", JARVIS_COMMS_TEMPLATES_WITH_DISCLOSURE: "ai_hello" });
const sms = scriptedAdapter("twilio");
const slack = scriptedAdapter("slack");
const wa = scriptedAdapter("meta_whatsapp");
let funnel: OutboundFunnel;
const marketing: MarketingBasisPort = { priorConsent: async () => true, reservationRegister: async () => "not_reserved" };

const ctxA: FunnelContext = { tenantId: TENANT_A, space: "business", actor: { person_id: OWNER, session_id: "sess-funnel", task_id: "task-1" }, source: "owner_route" };
const ctxB: FunnelContext = { tenantId: TENANT_B, space: "business", actor: { person_id: OWNER, session_id: "sess-funnel-b" }, source: "owner_route" };

let counter = 0;
const key = (p: string) => `${p}-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
const parsedSend = (over: Record<string, unknown>): ParsedOutbound => {
  const r = parseSendParams({ request_id: key("req"), channel: "sms", account_ref: "+4791000000", recipient: "+4790000000", purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei, møtet er flyttet.", ...over });
  if (!r.ok) throw new Error(`parse: ${r.code}`);
  return r.value;
};
const must = (r: ReturnType<typeof parseSendParams>): ParsedOutbound => { if (!r.ok) throw new Error(r.code); return r.value; };
const journal = async (tenant: string, requestId: string) =>
  (await db.admin.query("SELECT * FROM comms_outbound_log WHERE tenant_id = $1 AND request_id = $2 ORDER BY created_at", [tenant, requestId])).rows as Array<Record<string, unknown>>;

beforeAll(async () => {
  db = await startCommsDb("g1fun");
  store = new CommsStore(db.app, clock);
  graph = new ConversationGraphService(db.app);
  business = new BusinessService(db.app);
  const adapters: AdapterMap = { twilio: sms, slack, meta_whatsapp: wa };
  funnel = new OutboundFunnel({ contentHasher: testContentHasher, store, graph, adapters, config, clock, business, marketing });
  for (const [channel, ref, provider] of [["sms", "+4791000000", "twilio"], ["slack", "T0AAAAAAAA", "slack"], ["whatsapp", "109876543210", "meta_whatsapp"]] as const) {
    await store.authorizeAccount(TENANT_A, "business", { channel, account_ref: ref, provider, source: "owner_route" }, ctxA.actor);
  }
  const company = await business.createCompany(TENANT_A, "business", { name: "Kjent AS" });
  contactId = (await business.createContact(TENANT_A, "business", { name: "Kari Kjent", company_id: company.company_id, email: "kari@kjent.no" })).contact_id;
}, 240_000);

let contactId = "";
/** En KJENT mottaker (løst identitet, evt. lenket til en CRM-kontakt) - ikke «kald». Hver test bruker sitt eget nummer så ratetellerne ikke smitter. */
const known = async (number: string, withContact = false): Promise<string> => {
  await graph.linkChannelIdentity(TENANT_A, "business", {
    channel: "sms", channel_identifier: number, confidence: 1, match_method: "exact_phone_e164", ...(withContact ? { linked_business_contact_id: contactId } : {})
  });
  return number;
};

afterAll(async () => { await db?.stop(); }, 120_000);

describe("A: konto-allowlist (eierens egen) er tenant-isolert og validert", () => {
  it("ugyldig kontoreferanse/leverandør avvises; idempotent autorisering; tenant B ser ingenting; tilbakekalling stopper sending", async () => {
    await expect(store.authorizeAccount(TENANT_A, "business", { channel: "sms", account_ref: "ikke-et-nummer", provider: "twilio", source: "owner_route" }, ctxA.actor)).rejects.toThrow("comms_invalid_account_ref");
    await expect(store.authorizeAccount(TENANT_A, "business", { channel: "slack", account_ref: "T0AAAAAAAA", provider: "twilio", source: "owner_route" }, ctxA.actor)).rejects.toThrow("comms_provider_not_valid_for_channel");
    const again = await store.authorizeAccount(TENANT_A, "business", { channel: "sms", account_ref: "+4791000000", provider: "twilio", source: "owner_route" }, ctxA.actor);
    expect(again.created).toBe(false);
    expect(await store.listAccounts(TENANT_B, "business")).toEqual([]);
    expect(await store.findActiveAccount(TENANT_B, "business", "sms", "+4791000000")).toBeNull();
    // en annen konto, tilbakekalt: ingen sending
    const extra = await store.authorizeAccount(TENANT_A, "business", { channel: "sms", account_ref: "+4791999999", provider: "twilio", source: "owner_route" }, ctxA.actor);
    const before = await funnel.evaluate(ctxA, parsedSend({ account_ref: "+4791999999" }));
    expect(before.decision.allowed).toBe(true);
    expect(await store.revokeAccount(TENANT_A, "business", extra.account.account_id)).toBe(true);
    const after = await funnel.evaluate(ctxA, parsedSend({ account_ref: "+4791999999" }));
    expect(after.decision.denial_codes).toContain("account_not_authorized");
    // tenant B kan ikke bruke A sin konto
    expect((await funnel.evaluate(ctxB, parsedSend({}))).decision.denial_codes).toContain("account_not_authorized");
  });
});

describe("B: utsendelse - journal før/etter, hash i stedet for tekst, AI-opplysning, gjenspillingsvern", () => {
  it("sendt melding: adapteren får teksten med AI-opplysning, journalen har hash/lengde/regelutfall/mottakerbevis og ALDRI selve teksten eller hele nummeret", async () => {
    sms.calls.length = 0;
    const parsed = parsedSend({ recipient: await known("+4790000001", true), text: "Hemmelig-tekst-123: timen din er bekreftet" });
    const result = await funnel.send(ctxA, parsed, "fake-token-for-test");
    expect(result.external_id).toMatch(/^msg-/);
    expect(sms.calls).toHaveLength(1);
    expect(String(sms.calls[0]!.request["text"])).toBe(`Hemmelig-tekst-123: timen din er bekreftet\n\n${DEFAULT_AI_DISCLOSURE_TEXT}`);
    expect(sms.calls[0]!.credential).toBe("fake-token-for-test");
    const rows = await journal(TENANT_A, parsed.request_id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row["status"]).toBe("sent");
    expect(row["provider_message_id"]).toBe(result.external_id);
    expect(row["content_sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(row["ai_disclosure_applied"]).toBe(true);
    expect(row["person_id"]).toBe(OWNER);
    expect(row["session_id"]).toBe("sess-funnel");
    expect(row["task_id"]).toBe("task-1");
    expect(row["source"]).toBe("owner_route");
    expect((row["recipient_proof"] as { method: string }).method).toBe("identity_link");
    expect((row["rule_evaluation"] as Array<{ rule: string; outcome: string }>).some((r) => r.rule === "ai_disclosure" && r.outcome === "pass")).toBe(true);
    const dump = JSON.stringify(row);
    expect(dump).not.toContain("Hemmelig-tekst-123");
    expect(dump).not.toContain("+4790000001");
    expect(String(row["recipient_hint"])).toMatch(/^\+47•+001$/);
    expect(row["recipient_hash"]).toBe(recipientHash(TENANT_A, "sms", "+4790000001"));
    // D-121: en pekerrad i tidslinjen (fast tekst, aldri innhold) fordi mottakeren er en løst identitet med lenket kontakt
    const { rows: acts } = await db.admin.query("SELECT summary, source_type, canonical_uri FROM business_activities WHERE tenant_id = $1 AND external_id = $2", [TENANT_A, row["log_id"]]);
    expect(acts).toHaveLength(1);
    expect((acts[0] as { summary: string }).summary).toBe("Melding sendt (sms)");
    expect((acts[0] as { source_type: string }).source_type).toBe("comms_sms");
    expect(JSON.stringify(acts)).not.toContain("Hemmelig-tekst-123");
  });

  it("samme request_id etter sendt = deduplisert (adapteren kalles ikke igjen)", async () => {
    sms.calls.length = 0;
    const parsed = parsedSend({ recipient: await known("+4790000002") });
    const first = await funnel.send(ctxA, parsed, "t");
    const again = await funnel.send(ctxA, parsed, "t");
    expect(sms.calls).toHaveLength(1);
    expect(again.external_id).toBe(first.external_id);
    expect(again.data["deduplicated"]).toBe(true);
    expect(await journal(TENANT_A, parsed.request_id)).toHaveLength(1);
  });

  it("ukjent utfall: journalen står `outcome_unknown`, feilen kastes videre som outcome_unknown:, og et replay sender ALDRI en ny melding", async () => {
    sms.calls.length = 0;
    const flaky = scriptedAdapter("twilio", () => { throw new Error("outcome_unknown:comms_twilio_http_503"); });
    const f = new OutboundFunnel({ contentHasher: testContentHasher, store, graph, adapters: { twilio: flaky }, config, clock, marketing });
    const parsed = parsedSend({ recipient: await known("+4790000003") });
    await expect(f.send(ctxA, parsed, "t")).rejects.toThrow("outcome_unknown:comms_twilio_http_503");
    expect((await journal(TENANT_A, parsed.request_id))[0]!["status"]).toBe("outcome_unknown");
    await expect(f.send(ctxA, parsed, "t")).rejects.toThrow("outcome_unknown:comms_request_in_flight_or_unknown");
    expect(flaky.calls).toHaveLength(1);
    // heller ikke en ANNEN innfallsvei med samme forespørsel (annen trakt-instans, samme database) kan sende på nytt
    await expect(funnel.send(ctxA, parsed, "t")).rejects.toThrow("outcome_unknown:comms_request_in_flight_or_unknown");
    expect(sms.calls).toHaveLength(0);
  });

  it("råe transportfeil etter sending (nullstilt socket) blir også ukjent utfall - aldri `failed`", async () => {
    const reset = scriptedAdapter("twilio", () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }); });
    const f = new OutboundFunnel({ contentHasher: testContentHasher, store, graph, adapters: { twilio: reset }, config, clock, marketing });
    const parsed = parsedSend({ recipient: await known("+4790000004") });
    await expect(f.send(ctxA, parsed, "t")).rejects.toThrow(/^outcome_unknown:/);
    expect((await journal(TENANT_A, parsed.request_id))[0]!["status"]).toBe("outcome_unknown");
  });

  it("entydig avslag: journalen står `failed`, forespørsels-id-en er brent (ny nøkkel kreves), og en ny nøkkel virker", async () => {
    const rejecting = scriptedAdapter("twilio", () => { throw new ProviderRejectedError("twilio", "21211"); });
    const f = new OutboundFunnel({ contentHasher: testContentHasher, store, graph, adapters: { twilio: rejecting }, config, clock, marketing });
    const failedNumber = await known("+4790000005");
    const parsed = parsedSend({ recipient: failedNumber });
    await expect(f.send(ctxA, parsed, "t")).rejects.toThrow("comms_provider_rejected:twilio:21211");
    const row = (await journal(TENANT_A, parsed.request_id))[0]!;
    expect(row["status"]).toBe("failed");
    expect(JSON.stringify(row["after_state"])).toContain("comms_provider_rejected:twilio:21211");
    await expect(f.send(ctxA, parsed, "t")).rejects.toThrow("comms_request_id_burned_use_a_new_key");
    expect(rejecting.calls).toHaveLength(1);
    await expect(funnel.send(ctxA, parsedSend({ recipient: failedNumber }), "t")).resolves.toBeDefined();
  });

  it("avslått av policyen (transportnivå): `denied`-rad som bevis, INGEN adapterkall, og id-en er ikke brent", async () => {
    sms.calls.length = 0;
    const parsed = parsedSend({ recipient: await known("+4790000006"), purpose: "marketing", text: "Tilbud! Svar STOPP." });
    const strict = new OutboundFunnel({ contentHasher: testContentHasher, store, graph, adapters: { twilio: sms }, config, clock }); // standard markedsføringsport: uverifisert
    await expect(strict.send(ctxA, parsed, "t")).rejects.toThrow("comms_policy_denied:marketing_blocked_reservation_register_unverified");
    expect(sms.calls).toHaveLength(0);
    const rows = await journal(TENANT_A, parsed.request_id);
    expect(rows.map((r) => r["status"])).toEqual(["denied"]);
    expect(rows[0]!["denial_codes"]).toEqual(["marketing_blocked_reservation_register_unverified"]);
    // samme id kan brukes av en lovlig sending etterpå (denied er bevis, ikke et forsøk)
    const lawful = { ...parsed, request: { ...parsed.request, purpose: "transactional" as const, content: { text: "Timen din er bekreftet." } } };
    await expect(funnel.send(ctxA, lawful, "t")).resolves.toBeDefined();
  });

  it("ratebegrensning leses fra journalen: kald mottaker 1 per døgn, kjent mottaker 3 per døgn - og vinduet ruller", async () => {
    const cold = "+4790000777";
    await funnel.send(ctxA, parsedSend({ recipient: cold }), "t");
    await expect(funnel.send(ctxA, parsedSend({ recipient: cold }), "t")).rejects.toThrow("rate_limit_cold_recipient_day");
    const friend = await known("+4790000007");
    for (let i = 0; i < 3; i++) await funnel.send(ctxA, parsedSend({ recipient: friend }), "t");
    await expect(funnel.send(ctxA, parsedSend({ recipient: friend }), "t")).rejects.toThrow("rate_limit_recipient_day");
    const saved = now;
    now = new Date(now.getTime() + 25 * 3_600_000);
    await expect(funnel.send(ctxA, parsedSend({ recipient: cold }), "t")).resolves.toBeDefined();
    now = saved;
  });
});

describe("C: mottakerens avmelding (STOP) kan ikke omgås", () => {
  it("registrert avmelding stopper alt; eierregistrert avmelding oppheves aldri av START; stopp-ord-avmelding oppheves av START på samme avsender", async () => {
    const number = "+4790000100";
    const hash = optOutHash(TENANT_A, "sms", number);
    await store.recordOptOut(TENANT_A, "business", { channel: "sms", recipient_hash: hash, recipient_hint: "+47•••100", source: "inbound_stop_keyword", recorded_by: "system" });
    await expect(funnel.send(ctxA, parsedSend({ recipient: number }), "t")).rejects.toThrow("recipient_opted_out");
    // idempotent registrering
    const dup = await store.recordOptOut(TENANT_A, "business", { channel: "sms", recipient_hash: hash, recipient_hint: "+47•••100", source: "inbound_stop_keyword", recorded_by: "system" });
    expect(dup.created).toBe(false);
    // START på en ANNEN kanal enn avmeldingen kom på løfter ikke (konservativt); START på samme kanal løfter
    expect(await store.liftByStartKeyword(TENANT_A, { channel: "whatsapp", recipient_hash: hash })).toBe(0);
    expect(await store.liftByStartKeyword(TENANT_A, { channel: "sms", recipient_hash: hash })).toBe(1);
    await expect(funnel.send(ctxA, parsedSend({ recipient: number }), "t")).resolves.toBeDefined();
    // eierregistrert («alle avsendere») løftes ALDRI av en tekst-START
    const ownerNumber = "+4790000101";
    const ownerHash = optOutHash(TENANT_A, "sms", ownerNumber);
    await store.recordOptOut(TENANT_A, "business", { channel: "sms", recipient_hash: ownerHash, recipient_hint: "+47•••101", source: "owner_recorded", recorded_by: OWNER });
    expect(await store.liftByStartKeyword(TENANT_A, { channel: "sms", recipient_hash: ownerHash })).toBe(0);
    await expect(funnel.send(ctxA, parsedSend({ recipient: ownerNumber }), "t")).rejects.toThrow("recipient_opted_out");
    // en opphevet avmelding kan ikke endres, og kan ikke «gjenopplives» ved å sette status tilbake
    await expect(db.admin.query("UPDATE comms_recipient_opt_outs SET status = 'active', lifted_at = NULL, lifted_by = NULL WHERE recipient_hash = $1 AND status = 'lifted'", [hash])).rejects.toThrow();
  });

  it("Twilio 21610 fra leverandøren registrerer avmeldingen hos OSS også - neste forsøk avslås av vår egen policy før noe sendes", async () => {
    const unsub = scriptedAdapter("twilio", () => { throw new ProviderRejectedError("twilio", "21610"); });
    const f = new OutboundFunnel({ contentHasher: testContentHasher, store, graph, adapters: { twilio: unsub }, config, clock, marketing });
    const number = "+4790000102";
    await expect(f.send(ctxA, parsedSend({ recipient: number }), "t")).rejects.toThrow("21610");
    expect(await store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", number))).toBe(true);
    await expect(f.send(ctxA, parsedSend({ recipient: number }), "t")).rejects.toThrow("recipient_opted_out");
    expect(unsub.calls).toHaveLength(1);
    const rows = await store.listOptOuts(TENANT_A, "business");
    expect(rows.find((r) => r.source === "provider_error")?.recipient_hint).toMatch(/\+47•+102/);
  });

  it("avmelding er tenant-isolert (samme nummer hos tenant B er IKKE avmeldt)", async () => {
    const number = "+4790000100";
    expect(await store.isOptedOut(TENANT_B, optOutHash(TENANT_B, "sms", number))).toBe(false);
    // tenant-bred avmelding i A er likevel ikke synlig for B (hashen inneholder tenanten, og RLS gjelder)
    expect(await store.isOptedOut(TENANT_B, optOutHash(TENANT_A, "sms", number))).toBe(false);
    expect(await store.listOptOuts(TENANT_B, "business")).toEqual([]);
  });
});

describe("D: kundeservicevinduet kommer fra VERIFISERTE innkommende hendelser (server-tid)", () => {
  it("WhatsApp: fritekst uten innkommende melding avslås, etter en innkommende er det OK i 24 timer, deretter kreves mal", async () => {
    const number = "+4790000200";
    const hash = recipientHash(TENANT_A, "whatsapp", number);
    const text = { channel: "whatsapp", account_ref: "109876543210", recipient: number, text: "Takk for meldingen!" };
    await expect(funnel.send(ctxA, parsedSend(text), "t")).rejects.toThrow("outside_window_use_approved_template");
    await store.recordInbound(TENANT_A, "business", {
      provider: "meta", channel: "whatsapp", account_ref: "109876543210", event_key: key("wamid"), kind: "message", sender_hash: hash, sender_hint: "+47•••200", identity_id: null, thread_ref: null,
      content_excerpt: "Hei, kan dere hjelpe meg?", content_sha256: null, provider_ts: null, ingest_id: "ingest-test-0001"
    }, 30);
    wa.calls.length = 0;
    await expect(funnel.send(ctxA, parsedSend(text), "t")).resolves.toBeDefined();
    expect(wa.calls).toHaveLength(1);
    const saved = now;
    now = new Date(now.getTime() + 25 * 3_600_000);
    await expect(funnel.send(ctxA, parsedSend({ ...text, text: "Hei igjen" }), "t")).rejects.toThrow("outside_window_use_approved_template");
    const template = must(parseSendParams({ request_id: key("req"), channel: "whatsapp", account_ref: "109876543210", recipient: number, purpose: "transactional", purpose_basis: "existing_customer_relationship", template: { name: "ai_hello", language: "nb", params: ["Kari"] } }));
    await expect(funnel.send(ctxA, template, "t")).resolves.toBeDefined();
    expect(wa.calls[1]!.request["template"]).toMatchObject({ name: "ai_hello" });
    now = saved;
  });

  it("samme hendelse en gang til (gjenspilling) skrives ikke to ganger; innkommende hendelser er uforanderlige og tenant-isolerte", async () => {
    const k = key("evt");
    const input = {
      provider: "slack" as const, channel: "slack" as const, account_ref: "T0AAAAAAAA", event_key: k, kind: "message" as const, sender_hash: null, sender_hint: null, identity_id: null, thread_ref: null,
      content_excerpt: "hei", content_sha256: null, provider_ts: null, ingest_id: "ingest-test-0002"
    };
    expect((await store.recordInbound(TENANT_A, "business", input, 30)).inserted).toBe(true);
    expect((await store.recordInbound(TENANT_A, "business", input, 30)).inserted).toBe(false);
    expect((await store.recordInbound(TENANT_B, "business", input, 30)).inserted).toBe(true); // samme nøkkel i en annen tenant er en annen hendelse
    await expect(db.admin.query("UPDATE comms_inbound_events SET content_excerpt = 'x' WHERE event_key = $1", [k])).resolves.toBeDefined(); // admin kan, men appen har ikke UPDATE:
    await expect(db.app.query("UPDATE comms_inbound_events SET content_excerpt = 'x'")).rejects.toThrow();
    // ubetrodd og signaturverifisert er låst av CHECK
    await expect(db.admin.query(`INSERT INTO comms_inbound_events (tenant_id, event_id, provider, channel, event_key, kind, trust_level, signature_verified, retention_until, source, ingest_id)
      VALUES ($1, 'cin-x-0001', 'slack', 'slack', 'k-x', 'message', 'trusted', true, now(), 'webhook:slack', 'ingest-test-0003')`, [TENANT_A])).rejects.toThrow();
    await expect(db.admin.query(`INSERT INTO comms_inbound_events (tenant_id, event_id, provider, channel, event_key, kind, signature_verified, retention_until, source, ingest_id)
      VALUES ($1, 'cin-x-0002', 'slack', 'slack', 'k-y', 'message', false, now(), 'webhook:slack', 'ingest-test-0003')`, [TENANT_A])).rejects.toThrow();
  });
});

describe("E: redigering, sletting og reaksjon - kun egen melding fra samme konto", () => {
  it("send -> rediger -> reager -> slett virker; en fremmed meldings-id, annen kanal og annen mottaker avslås før noe sendes", async () => {
    slack.calls.length = 0;
    const sent = await funnel.send(ctxA, parsedSend({ channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", text: "Første" }), "t");
    const ts = sent.external_id;
    const base = { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: ts };
    const edit = must(parseEditParams({ request_id: key("req"), ...base, text: "Rettet" }));
    const edited = await funnel.execute(ctxA, edit, "t");
    expect(edited.data["kind"]).toBe("edit");
    expect(String(slack.calls.at(-1)!.request["text"])).toContain(DEFAULT_AI_DISCLOSURE_TEXT);
    await funnel.execute(ctxA, must(parseReactParams({ request_id: key("req"), ...base, reaction: "thumbsup" })), "t");
    expect(slack.calls.at(-1)!.op).toBe("react");
    const foreign = must(parseDeleteParams({ request_id: key("req"), ...base, target_message_id: "9999.0001" }));
    await expect(funnel.execute(ctxA, foreign, "t")).rejects.toThrow("target_not_own_sent_message");
    const otherChannel = must(parseDeleteParams({ request_id: key("req"), ...base, recipient: "C0BBBBBBBB" }));
    await expect(funnel.execute(ctxA, otherChannel, "t")).rejects.toThrow("target_not_own_sent_message");
    const calls = slack.calls.length;
    const del = must(parseDeleteParams({ request_id: key("req"), ...base }));
    expect((await funnel.execute(ctxA, del, "t")).data["status"]).toBe("sent");
    expect(slack.calls.length).toBe(calls + 1);
    expect(slack.calls.at(-1)!.op).toBe("delete");
    // tenant B kan ikke slette A sin melding (journalen er tenant-isolert)
    await expect(funnel.execute(ctxB, must(parseDeleteParams({ request_id: key("req"), ...base })), "t")).rejects.toThrow(/account_not_authorized|target_not_own_sent_message/);
  });

  it("fersk lesing av målet: finnes meldingen hos leverandøren? `null` når den er borte", async () => {
    const sent = await funnel.send(ctxA, parsedSend({ channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0CCCCCCCC", text: "Skal leses" }), "t");
    const target = must(parseDeleteParams({ request_id: key("req"), channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0CCCCCCCC", target_message_id: sent.external_id }));
    const present = await funnel.checkTarget(ctxA, target, "t");
    expect(present).toMatchObject({ exists: true, allowed: true });
    const gone = scriptedAdapter("slack", (op) => (op === "exists" ? { exists: false } : {}));
    const f = new OutboundFunnel({ contentHasher: testContentHasher, store, graph, adapters: { slack: gone }, config, clock });
    expect(await f.checkTarget(ctxA, target, "t")).toBeNull();
  });
});

describe("F: tenant-isolasjon, minnerom og journalens tilstandsmaskin", () => {
  it("RLS: runtime-rollen ser kun egen tenant; journalens kjernekolonner er uforanderlige og terminale rader kan ikke endres", async () => {
    const asB = await db.app.connect();
    try {
      await asB.query("BEGIN");
      await asB.query("SELECT set_config('jarvis.tenant_id', $1, true), set_config('jarvis.memory_spaces', 'business', true)", [TENANT_B]);
      for (const t of ["comms_outbound_log", "comms_recipient_opt_outs", "comms_authorized_accounts"]) {
        // tenant B ser ALDRI en rad som tilhører A (B har egne rader, f.eks. et `denied`-bevis fra forsøket over)
        expect((await asB.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [TENANT_A])).rows[0], t).toEqual({ n: 0 });
        expect((await asB.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id <> $1`, [TENANT_B])).rows[0], t).toEqual({ n: 0 });
      }
      await expect(asB.query(`INSERT INTO comms_authorized_accounts (tenant_id, account_id, channel, account_ref, provider, source) VALUES ('${TENANT_A}', 'acct-cross-tenant', 'sms', '+4790', 'twilio', 'tool')`)).rejects.toThrow();
      await asB.query("ROLLBACK");
    } finally {
      asB.release();
    }
    const { rows } = await db.admin.query("SELECT log_id FROM comms_outbound_log WHERE tenant_id = $1 AND status = 'sent' LIMIT 1", [TENANT_A]);
    const logId = (rows[0] as { log_id: string }).log_id;
    await expect(db.admin.query("UPDATE comms_outbound_log SET status = 'failed' WHERE log_id = $1", [logId])).rejects.toThrow(/terminal/);
    await expect(db.admin.query("UPDATE comms_outbound_log SET recipient_hash = repeat('a', 64) WHERE log_id = $1", [logId])).rejects.toThrow(/uforanderlige/);
  });

  it("minnerom: en konto i ett rom er usynlig fra et annet rom (RLS på memory space)", async () => {
    await expect(db.admin.query(`INSERT INTO comms_authorized_accounts (tenant_id, account_id, memory_space_id, channel, account_ref, provider, source) VALUES ('${TENANT_A}', 'acct-space-1', 'personal', 'sms', '+4790', 'twilio', 'tool')`)).resolves.toBeDefined();
    expect(await store.findActiveAccount(TENANT_A, "personal", "sms", "+4790")).not.toBeNull();
    expect(await store.findActiveAccount(TENANT_A, "business", "sms", "+4790")).toBeNull();
  });

  it("retensjonssveipet sletter kun utløpte rader (og kun for angitt tenant)", async () => {
    const saved = now;
    now = new Date(now.getTime() + 500 * 86_400_000);
    // WP-G1c K1 (142): databasen avviser sletting av en JOURNALRAD før `retention_until` har gått ut på DATABASENS klokke - en injisert fremtidig appklokke er ikke nok, og sveipet hopper over slike rader i stedet for å feile.
    const first = await store.purgeExpired(TENANT_A, "business");
    expect(first.inbound).toBeGreaterThan(0);
    expect(first.journal, "journalrader som ikke er utløpt på databasens klokke slettes ikke").toBe(0);
    expect(((await db.admin.query("SELECT count(*)::int AS n FROM comms_outbound_log WHERE tenant_id = $1", [TENANT_A])).rows[0] as { n: number }).n).toBeGreaterThan(0);
    // frista flyttes tilbake som superbruker (replica-rolle omgår triggerne - appen kan aldri det): NÅ er radene utløpt også for databasen
    const admin = await db.admin.connect();
    try {
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query("UPDATE comms_outbound_log SET retention_until = now() - interval '1 day' WHERE tenant_id = $1", [TENANT_A]);
      await admin.query("COMMIT");
    } finally {
      admin.release();
    }
    const purged = await store.purgeExpired(TENANT_A, "business");
    expect(purged.journal).toBeGreaterThan(0);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM comms_inbound_events WHERE tenant_id = $1", [TENANT_B])).rows[0]).toEqual({ n: 1 });
    now = saved;
  });
});
