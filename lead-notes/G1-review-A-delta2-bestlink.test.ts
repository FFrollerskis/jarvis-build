// REVIEWER A DELTA2 (midlertidig): beste-lenke-valget i resolveRecipientIdentity (mutanten uten preferanse overlevde byggerens tester).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

let chain: Chain;
beforeAll(async () => {
  chain = await startChain("rva3b", { JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "1000" });
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

const p = (recipient: string): Record<string, JsonValue> => ({ channel: "sms", account_ref: "+4791000000", recipient, purpose: "transactional", text: "Hei, timen din er bekreftet." });

describe("beste lenke: relasjonsbevis velges framfor en høyere-confidence lenke som ikke teller", () => {
  it("phone-lenke contact_sync 1,0 + whatsapp-lenke exact_phone_e164 0,9 for SAMME nummer => VARM (ingen basis kreves)", async () => {
    const n = chain.phone();
    const a = await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "phone", channel_identifier: n, confidence: 1, match_method: "contact_sync" });
    await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "whatsapp", channel_identifier: n, confidence: 0.9, match_method: "exact_phone_e164", identity_id: a.identity_id });
    const r = await chain.act("send", p(n), chain.key("bl"));
    expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true);
  });
  it("kontroll: kun contact_sync 1,0 (phone) => KALD", async () => {
    const n = chain.phone();
    await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "phone", channel_identifier: n, confidence: 1, match_method: "contact_sync" });
    expect((await chain.act("send", p(n), chain.key("bl2"))).ok).toBe(false);
  });
});
