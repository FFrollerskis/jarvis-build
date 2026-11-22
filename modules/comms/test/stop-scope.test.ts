import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import {
  CommsWebhookService, ProviderRejectedError, WEBHOOK_SECRET_REFS, optOutHash, optOutNamespace, parseCallParams, parseSendParams, recipientHash, twilioSignatureBase, type ParsedOutbound, type WebhookRequest
} from "../src/index.ts";
import { TENANT_A, TENANT_B } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1 fiks-runde A-M3 + A-M7: mottakerens STOP er TENANT-bred (LEDER-AVGJØRELSE). Før gjaldt den kun (tenant, kanal, avsender|'*', ROM): en STOP til konto A stoppet ikke konto B, ikke WhatsApp og ikke AI-ringing til samme
 * nummer, og `*` i rom `business` gjaldt ikke fra rom `project`. En STOP til en ikke-autorisert/tilbakekalt konto ble droppet, og `record_opt_out` med feilskrevet `account_ref` ga `ok:true` uten effekt (stille no-op).
 * Nå: avmeldingen nøkles på (tenant, navnerom, normalisert identifikator) - telefon = SMS + WhatsApp + samtale - og leses uavhengig av avsenderkonto og rom ved HVER sending og samtale.
 */
const NOW = 1_763_380_800; // = 2025-11-17T12:00:00Z i sekunder
let chain: Chain;
let webhooks: CommsWebhookService;
const TWILIO_TOKEN = "fake-twilio-auth-token";
const BASE = "https://hooks.example.com";

const twilioReq = (fields: Record<string, string>): WebhookRequest => {
  const params = new Map(Object.entries(fields).map(([k, v]) => [k, [v]] as [string, string[]]));
  const sig = createHmac("sha1", TWILIO_TOKEN).update(twilioSignatureBase(`${BASE}/webhooks/comms/twilio`, params), "utf8").digest("base64");
  return { method: "POST", headers: { "x-twilio-signature": sig }, rawBody: Buffer.from(new URLSearchParams(fields).toString()), pathAndQuery: "/webhooks/comms/twilio", query: new URLSearchParams() };
};
let sid = 0;
const inboundStop = (from: string, to: string, text = "STOP") => twilioReq({ MessageSid: `SM${String(++sid).padStart(32, "0")}`, From: from, To: to, Body: text, AccountSid: "AC1234567890abcdef" });
const must = (r: ReturnType<typeof parseSendParams>): ParsedOutbound => { if (!r.ok) throw new Error(r.code); return r.value; };
const sendOf = (over: Record<string, unknown>): ParsedOutbound => must(parseSendParams({ request_id: chain.key("req"), channel: "sms", account_ref: "+4791000000", recipient: "+4790000000", purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei, timen din er bekreftet.", ...over }));
const callOf = (over: Record<string, unknown>): ParsedOutbound => must(parseCallParams({ request_id: chain.key("req"), channel: "phone", account_ref: "+4791000000", recipient: "+4790000000", purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei, jeg ringer om timen.", ...over }));
const denies = async (parsed: ParsedOutbound, ctx = chain.ctx) => (await chain.funnel.evaluate(ctx, parsed)).decision.denial_codes;
const optRows = async (hash: string) => (await chain.db.admin.query("SELECT channel, account_ref, status, source, memory_space_id FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2 ORDER BY created_at", [TENANT_A, hash])).rows as Array<Record<string, string>>;

beforeAll(async () => {
  chain = await startChain("g1stps", { JARVIS_COMMS_WEBHOOKS: "twilio", JARVIS_COMMS_TENANT_ID: TENANT_A, JARVIS_COMMS_PUBLIC_BASE_URL: BASE });
  chain.setNow(new Date(NOW * 1000));
  webhooks = new CommsWebhookService({ store: chain.store, graph: chain.graph, config: chain.config, secrets: { get: async (ref) => (ref === WEBHOOK_SECRET_REFS.twilio ? TWILIO_TOKEN : null) }, clock: chain.now });
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"], ["sms", "+4792000000", "telnyx"], ["phone", "+4791000000", "twilio"], ["whatsapp", "109876543210", "meta_whatsapp"], ["slack", "T0AAAAAAAA", "slack"]]);
  // et eget rom (project) med egen avsender - samme konto kan ikke være aktiv i to rom
  const projectOwner: IdentityContext = { ...chain.owner, memory_space_id: "project", session_id: "sess-stps-project" };
  await authorizeAll(chain, [["sms", "+4795000000", "twilio"]], projectOwner);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("optOutHash: navnerommet avmeldingen gjelder i", () => {
  it("telefon = SMS + WhatsApp + samtale deler hash; tenant, navnerom og nummer skiller; journalens kanalspesifikke recipientHash er uendret", () => {
    const n = "+4790000123";
    expect(optOutNamespace("sms")).toBe("tel");
    expect(new Set([optOutHash(TENANT_A, "sms", n), optOutHash(TENANT_A, "whatsapp", n), optOutHash(TENANT_A, "phone", n)]).size).toBe(1);
    expect(optOutHash(TENANT_B, "sms", n)).not.toBe(optOutHash(TENANT_A, "sms", n));
    expect(optOutHash(TENANT_A, "sms", "+4790000124")).not.toBe(optOutHash(TENANT_A, "sms", n));
    expect(optOutHash(TENANT_A, "slack", "U0AAAAAAAA")).not.toBe(optOutHash(TENANT_A, "discord", "U0AAAAAAAA"));
    expect(optOutHash(TENANT_A, "slack", "C0AAAAAAAA")).toMatch(/^[0-9a-f]{64}$/);
    expect(recipientHash(TENANT_A, "sms", n)).not.toBe(recipientHash(TENANT_A, "whatsapp", n)); // journal/ratetak/vindu er fortsatt per kanal
  });
});

describe("A-M3: STOP gjelder mottakeren, ikke én avsenderkonto/ett rom/én kanal", () => {
  it("innkommende STOP til konto A (Twilio) stopper sending fra konto B (Telnyx), WhatsApp og AI-ringing til SAMME nummer - men ikke et annet nummer", async () => {
    const num = chain.phone();
    const other = chain.phone();
    const r = await webhooks.handle("twilio", inboundStop(num, "+4791000000"));
    expect(r.body).toMatchObject({ events: { inserted: 1, opt_outs: 1 } });
    expect(await denies(sendOf({ recipient: num, account_ref: "+4791000000" }))).toContain("recipient_opted_out");
    expect(await denies(sendOf({ recipient: num, account_ref: "+4792000000" }))).toContain("recipient_opted_out"); // en annen konto
    expect(await denies(sendOf({ channel: "whatsapp", account_ref: "109876543210", recipient: num }))).toContain("recipient_opted_out"); // en annen kanal
    expect(await denies(callOf({ recipient: num }))).toContain("recipient_opted_out"); // AI-ringing
    expect(await denies(sendOf({ recipient: other }))).not.toContain("recipient_opted_out"); // et annet nummer er upåvirket
    // og via den EKTE eier-kjeden: ingenting når leverandøren
    chain.telnyx.calls.length = 0;
    const viaB = await chain.act("send", { channel: "sms", account_ref: "+4792000000", recipient: num, purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei, timen din er bekreftet." }, chain.key("ob"));
    expect(viaB.ok).toBe(false);
    expect(chain.telnyx.calls).toEqual([]);
    const call = await chain.act("start_call", { channel: "phone", account_ref: "+4791000000", recipient: num, purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei, jeg ringer om timen." }, chain.key("oc"));
    expect(call.ok).toBe(false);
    expect(chain.twilio.calls.filter((c) => c.op === "call")).toEqual([]);
  });

  it("STOP registrert i ett rom (business) gjelder også fra et annet rom (project) - avmeldingen leses uavhengig av rom", async () => {
    const num = chain.phone();
    const rec = await chain.act("record_opt_out", { channel: "sms", recipient: num });
    expect(rec.ok && (rec.data as { scope: string }).scope).toBe("tenant");
    const projectCtx = { ...chain.ctx, space: "project" as const };
    expect(await denies(sendOf({ recipient: num, account_ref: "+4795000000" }), projectCtx)).toContain("recipient_opted_out");
    // og omvendt: en avmelding skrevet fra project-rommet stopper business
    const num2 = chain.phone();
    const projectOwner: IdentityContext = { ...chain.owner, memory_space_id: "project", session_id: "sess-stps-project" };
    expect((await chain.act("record_opt_out", { channel: "sms", recipient: num2 }, undefined, projectOwner)).ok).toBe(true);
    expect(await denies(sendOf({ recipient: num2 }))).toContain("recipient_opted_out");
    // listen over avmeldinger er også tenant-bred
    const listed = await chain.act("list_opt_outs", {});
    expect(listed.ok && (listed.data as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("samme STOP en gang til (samme kanal og kilde, også fra et annet rom) gir ÉN aktiv avmelding; en STOP på en annen KANAL får sin egen rad (N1: aldri absorbert)", async () => {
    const num = chain.phone();
    const hash = optOutHash(TENANT_A, "sms", num);
    expect((await chain.store.recordOptOut(TENANT_A, "business", { channel: "sms", recipient_hash: hash, recipient_hint: "+47•••000", source: "inbound_stop_keyword", recorded_by: "system" })).created).toBe(true);
    expect((await chain.store.recordOptOut(TENANT_A, "project", { channel: "sms", recipient_hash: hash, recipient_hint: "+47•••000", source: "inbound_stop_keyword", recorded_by: "system" })).created).toBe(false);
    expect(await optRows(hash)).toHaveLength(1);
    expect((await chain.store.recordOptOut(TENANT_A, "project", { channel: "whatsapp", recipient_hash: optOutHash(TENANT_A, "whatsapp", num), recipient_hint: "+47•••000", source: "inbound_stop_keyword", recorded_by: "system" })).created).toBe(true);
    expect((await optRows(hash)).map((r) => r.channel).sort()).toEqual(["sms", "whatsapp"]);
    // samtidige registreringer fra to rom gir fortsatt én rad
    const num2 = chain.phone();
    const h2 = optOutHash(TENANT_A, "sms", num2);
    await Promise.all(["business", "project", "business", "project"].map((space) => chain.store.recordOptOut(TENANT_A, space as "business" | "project", { channel: "sms", recipient_hash: h2, recipient_hint: "+47•••000", source: "owner_recorded", recorded_by: "x" })));
    expect(await optRows(h2)).toHaveLength(1);
  });

  it("START opphever kun en stopp-ord-avmelding og kun på SAMME kanal; en eierregistrert avmelding oppheves aldri", async () => {
    const num = chain.phone();
    const hash = optOutHash(TENANT_A, "sms", num);
    await webhooks.handle("twilio", inboundStop(num, "+4791000000"));
    expect(await chain.store.liftByStartKeyword(TENANT_A, { channel: "whatsapp", recipient_hash: hash })).toBe(0); // START på en annen kanal løfter ikke
    expect(await chain.store.isOptedOut(TENANT_A, hash)).toBe(true);
    const start = await webhooks.handle("twilio", inboundStop(num, "+4791000000", "START"));
    expect(start.body).toMatchObject({ events: { opt_ins: 1 } });
    expect(await chain.store.isOptedOut(TENANT_A, hash)).toBe(false);
    const ownerNum = chain.phone();
    await chain.act("record_opt_out", { channel: "sms", recipient: ownerNum });
    await webhooks.handle("twilio", inboundStop(ownerNum, "+4791000000", "START"));
    expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", ownerNum))).toBe(true);
  });

  it("Twilio 21610 (leverandørens STOP) registreres tenant-bredt: neste forsøk fra en ANNEN konto avslås av vår egen policy", async () => {
    const num = chain.phone();
    const saved = chain.twilio.send;
    chain.twilio.send = async () => { throw new ProviderRejectedError("twilio", "21610"); };
    try {
      await expect(chain.funnel.execute(chain.ctx, sendOf({ recipient: num }), "t")).rejects.toThrow("21610");
    } finally {
      chain.twilio.send = saved;
    }
    expect(await denies(sendOf({ recipient: num, account_ref: "+4792000000" }))).toContain("recipient_opted_out");
    expect((await optRows(optOutHash(TENANT_A, "sms", num)))[0]).toMatchObject({ source: "provider_error", account_ref: "*provider" });
  });
});

describe("A-M7: STOP registreres alltid; record_opt_out er aldri en stille no-op", () => {
  it("innkommende STOP til en IKKE-autorisert konto registreres likevel (og lagrer ingen tekst); en vanlig melding til samme konto ignoreres", async () => {
    const num = chain.phone();
    const r = await webhooks.handle("twilio", inboundStop(num, "+4799999999"));
    expect(r.body).toMatchObject({ events: { received: 1, inserted: 1, opt_outs: 1, ignored: 0 } });
    expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", num))).toBe(true);
    const evt = (await chain.db.admin.query("SELECT kind, content_excerpt FROM comms_inbound_events WHERE tenant_id = $1 AND account_ref = '+4799999999' AND sender_hash = $2", [TENANT_A, recipientHash(TENANT_A, "sms", num)])).rows;
    expect(evt).toEqual([{ kind: "opt_out", content_excerpt: null }]);
    const chat = await webhooks.handle("twilio", inboundStop(chain.phone(), "+4799999999", "Hei, har dere åpent?"));
    expect(chat.body).toMatchObject({ events: { received: 1, inserted: 0, ignored: 1 } });
    const start = await webhooks.handle("twilio", inboundStop(num, "+4799999999", "START"));
    expect(start.body).toMatchObject({ events: { inserted: 0, ignored: 1 } }); // START til en ikke-autorisert konto løfter ingenting
    expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", num))).toBe(true);
  });

  it("STOP til en TILBAKEKALT konto registreres også", async () => {
    const acct = await chain.store.authorizeAccount(TENANT_A, "business", { channel: "sms", account_ref: "+4796000000", provider: "twilio", source: "owner_route" }, chain.ctx.actor);
    await chain.store.revokeAccount(TENANT_A, "business", acct.account.account_id);
    const num = chain.phone();
    expect((await webhooks.handle("twilio", inboundStop(num, "+4796000000"))).body).toMatchObject({ events: { inserted: 1, opt_outs: 1 } });
    expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", num))).toBe(true);
  });

  it("record_opt_out med ugyldig/feilskrevet account_ref avvises HØYT (ingen rad); utelatt, `*` og en gyldig kontoreferanse gir tenant-bred avmelding", async () => {
    const before = ((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_recipient_opt_outs")).rows[0] as { n: number }).n;
    const num = chain.phone();
    for (const bad of ["+47 91 00 00 00", "typo", "+4791", "T0AAAAAAAA"]) {
      const r = await chain.act("record_opt_out", { channel: "sms", account_ref: bad, recipient: num });
      expect(r.ok, bad).toBe(false);
      expect(JSON.stringify(r), bad).toContain("account_ref_invalid");
    }
    expect(((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_recipient_opt_outs")).rows[0] as { n: number }).n).toBe(before);
    expect(await denies(sendOf({ recipient: num }))).not.toContain("recipient_opted_out");
    // en gyldig, men ANNEN konto enn den vi sender fra: avmeldingen gjelder likevel (tenant-bred)
    expect((await chain.act("record_opt_out", { channel: "sms", account_ref: "+4792000000", recipient: num })).ok).toBe(true);
    expect(await denies(sendOf({ recipient: num, account_ref: "+4791000000" }))).toContain("recipient_opted_out");
    const n2 = chain.phone();
    expect((await chain.act("record_opt_out", { channel: "sms", account_ref: "*", recipient: n2 })).ok).toBe(true);
    expect(await denies(sendOf({ recipient: n2 }))).toContain("recipient_opted_out");
  });
});
