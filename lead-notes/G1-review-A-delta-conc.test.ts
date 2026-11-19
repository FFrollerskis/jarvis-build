// REVIEWER A DELTA (midlertidig): samtidighet på tvers av KONTI (samme kanal, samme kalde mottaker) - krever mottakerlåsen, ikke bare kontolåsen.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

let chain: Chain;
beforeAll(async () => {
  chain = await startChain("rva2c", { JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "1000" });
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"], ["sms", "+4792000000", "telnyx"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

const p = (recipient: string, account_ref: string): Record<string, JsonValue> => ({ channel: "sms", account_ref, recipient, purpose: "transactional", purpose_basis: "existing_customer_relationship", text: "Hei, timen din er bekreftet." });
const sends = () => chain.twilio.calls.filter((c) => c.op === "send").length + chain.telnyx.calls.filter((c) => c.op === "send").length;

describe("A-H2 på tvers av konti", () => {
  it("10 samtidige sendinger til SAMME kalde mottaker fra TO ulike kontoer (samme kanal, samme rom) gir ÉN sending", async () => {
    const n = chain.phone();
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => chain.act("send", p(n, i % 2 === 0 ? "+4791000000" : "+4792000000"), chain.key("x"))));
    expect(sends()).toBe(1);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("kontrolltall: ulike mottakere fra de to kontoene sendes alle", async () => {
    const before = sends();
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => chain.act("send", p(chain.phone(), i % 2 === 0 ? "+4791000000" : "+4792000000"), chain.key("y"))));
    expect(rs.filter((r) => r.ok)).toHaveLength(10);
    expect(sends() - before).toBe(10);
  });
});
