import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1 fiks-runde 2, A-H2 rest: ratetakene ble telt per ROM (RLS): samme kalde mottaker via en konto i `business` OG en i `project` ga to sendinger (delta-review A, bekreftet). LEDER-AVGJØRELSE: per-mottaker-døgntaket gjelder
 * TENANT-BREDT på tvers av rom, i samsvar med tenant-bred STOP (et nummer er ÉN mottaker); kontotaket forblir per konto. Samme rom-synlighet gjelder gjenspillingsvernet (en id brukt i ett rom er brukt i alle).
 */
let chain: Chain;
let projectOwner: IdentityContext;
const BASIS = { purpose_basis: "existing_customer_relationship" } as const;
const sends = () => chain.twilio.calls.filter((c) => c.op === "send").length;
const params = (recipient: string, account_ref: string): Record<string, JsonValue> => ({ channel: "sms", account_ref, recipient, purpose: "transactional", text: "Hei, timen din er bekreftet.", ...BASIS });
const codes = (r: Awaited<ReturnType<Chain["act"]>>): string[] => (!r.ok && r.status === "denied" ? [...r.denial_codes] : []);
/** Autoriser en SMS-konto i `business` og returner kontoens id (trengs for å tilbakekalle den). */
const authorizeOne = async (account_ref: string): Promise<string> => {
  const r = await chain.act("authorize_account", { channel: "sms", account_ref, provider: "twilio" }, chain.key("g1auth"));
  if (!r.ok || typeof r.external_id !== "string") throw new Error(`authorize ${account_ref}: ${JSON.stringify(r)}`);
  return r.external_id;
};

beforeAll(async () => {
  chain = await startChain("g1cr", { JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "4" }, { rateLimitPerMinute: 1_000_000, lenientToolLimits: true });
  projectOwner = { ...chain.owner, memory_space_id: "project", session_id: "sess-g1cr-project" };
  // to par kontoer: ett par for mottakertestene, ett par for kontotaket (så tellerne ikke påvirker hverandre)
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"], ["sms", "+4796000000", "twilio"]]);
  await authorizeAll(chain, [["sms", "+4795000000", "twilio"], ["sms", "+4797000000", "twilio"]], projectOwner);
  await authorizeAll(chain, [["sms", "+4798000000", "twilio"], ["sms", "+4799000000", "twilio"]]); // to kontoer i SAMME rom (A-N4)
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("A-N4: mottakerlåsen (delta-review A): to KONTOER i samme rom mot samme mottaker", () => {
  it("10 samtidige sendinger til SAMME kalde mottaker fra TO ulike kontoer (samme kanal, samme rom) gir ÉN sending - kontolåsene alene serialiserer ikke på tvers av kontoer", async () => {
    const n = chain.phone();
    const before = sends();
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => chain.act("send", params(n, i % 2 === 0 ? "+4798000000" : "+4799000000"), chain.key("n4"))));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(sends() - before).toBe(1);
  });

  it("DETERMINISTISK kappløp: de to første kallene (én per konto) møtes i `beginAttempt` og går inn SAMTIDIG - kun mottakerlåsen (ikke kontolåsene) gir ÉN sending", async () => {
    const n = chain.phone();
    const before = sends();
    const store = chain.store as unknown as { beginAttempt: (...a: unknown[]) => Promise<unknown> };
    const orig = store.beginAttempt.bind(store);
    let waiting: Array<() => void> = [];
    let meetings = 2;
    store.beginAttempt = async (...args) => {
      if (meetings > 0) {
        meetings -= 1;
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 2) { const all = waiting; waiting = []; for (const r of all) r(); } else setTimeout(resolve, 2000); // sikkerhetsventil: aldri vranglås
        });
      }
      return orig(...args);
    };
    try {
      const rs = await Promise.all([chain.act("send", params(n, "+4798000000"), chain.key("n4a")), chain.act("send", params(n, "+4799000000"), chain.key("n4b"))]);
      expect(rs.filter((r) => r.ok), JSON.stringify(rs)).toHaveLength(1);
      expect(sends() - before).toBe(1);
    } finally {
      store.beginAttempt = orig;
    }
  });
});

describe("A-H2 rest: per-mottaker-døgntaket gjelder på tvers av rom", () => {
  it("10 SAMTIDIGE sendinger til samme kalde mottaker - 5 via konto i `business` og 5 via konto i `project` - gir ÉN sending og ÉN journalrad", async () => {
    const n = chain.phone();
    const before = sends();
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 === 0
      ? chain.act("send", params(n, "+4791000000"), chain.key("cr"))
      : chain.act("send", params(n, "+4795000000"), chain.key("cr"), projectOwner))));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(sends() - before).toBe(1);
    const rows = (await chain.db.admin.query(
      "SELECT memory_space_id FROM comms_outbound_log WHERE tenant_id = 'tenant-g1-a' AND kind = 'message' AND status <> 'denied' AND recipient_hash = (SELECT recipient_hash FROM comms_outbound_log WHERE status = 'sent' ORDER BY created_at DESC, log_id DESC LIMIT 1)"
    )).rows;
    expect(rows).toHaveLength(1);
  });

  it("etter hverandre: sendt fra `business`, så avslås `project` allerede av policyens tørrkjøring (samme tall som håndhevelsen); en ANNEN mottaker er upåvirket", async () => {
    const n = chain.phone();
    expect((await chain.act("send", params(n, "+4791000000"), chain.key("cr1"))).ok).toBe(true);
    const second = await chain.act("send", params(n, "+4795000000"), chain.key("cr2"), projectOwner);
    expect(codes(second), JSON.stringify(second)).toContain("rate_limit_cold_recipient_day");
    const other = await chain.act("send", params(chain.phone(), "+4795000000"), chain.key("cr3"), projectOwner);
    expect(other.ok).toBe(true);
  });

  it("kontotaket forblir PER KONTO: konto i `business` stoppes ved 4/time, kontoen i `project` har sin egen teller", async () => {
    for (let i = 0; i < 4; i++) expect((await chain.act("send", params(chain.phone(), "+4796000000"), chain.key("ca"))).ok, `A ${i}`).toBe(true);
    const fifth = await chain.act("send", params(chain.phone(), "+4796000000"), chain.key("ca5"));
    expect(codes(fifth)).toContain("rate_limit_account_hour");
    for (let i = 0; i < 3; i++) expect((await chain.act("send", params(chain.phone(), "+4797000000"), chain.key("cb"), projectOwner)).ok, `B ${i}`).toBe(true);
  });

  it("WP-G1c g1: kontotaket teller PER KONTO på tvers av rom - en konto som tilbakekalles i `business` og autoriseres på nytt i `project` beholder telleren (ingen ny blankett)", async () => {
    const acct = "+4780000000";
    const accountId = await authorizeOne(acct);
    for (let i = 0; i < 3; i++) expect((await chain.act("send", params(chain.phone(), acct), chain.key("g1a"))).ok, `business ${i}`).toBe(true);
    // tilbakekall i `business`, autoriser i `project`: samme (kanal, konto) i et annet rom
    const revoked = await chain.act("revoke_account", { account_id: accountId }, chain.key("g1r"));
    expect(revoked.ok, JSON.stringify(revoked)).toBe(true);
    await authorizeAll(chain, [["sms", acct, "twilio"]], projectOwner);
    // grensen er 4/time (testoppsettet): tre er brukt i `business`, så EN til i `project`, og den femte avslås - uavhengig av rommet
    expect((await chain.act("send", params(chain.phone(), acct), chain.key("g1b"), projectOwner)).ok).toBe(true);
    const fifth = await chain.act("send", params(chain.phone(), acct), chain.key("g1c"), projectOwner);
    expect(codes(fifth), JSON.stringify(fifth)).toContain("rate_limit_account_hour");
    // policyens tørrkjøring (samme tall som håndhevelsen) ser det også, og telleren er DEN SAMME fra begge rom
    expect(await chain.store.countAccountHour("tenant-g1-a", "business", "sms", acct)).toBe(4);
    expect(await chain.store.countAccountHour("tenant-g1-a", "project", "sms", acct)).toBe(4);
  });

  it("WP-G1c g1: 10 SAMTIDIGE sendinger fra den omautoriserte kontoen i `project` gir aldri flere enn taket totalt (kontolåsen er ikke per rom)", async () => {
    const acct = "+4780000001";
    const accountId = await authorizeOne(acct);
    for (let i = 0; i < 2; i++) expect((await chain.act("send", params(chain.phone(), acct), chain.key("g1d"))).ok).toBe(true);
    expect((await chain.act("revoke_account", { account_id: accountId }, chain.key("g1e"))).ok).toBe(true);
    await authorizeAll(chain, [["sms", acct, "twilio"]], projectOwner);
    const before = sends();
    const rs = await Promise.all(Array.from({ length: 10 }, () => chain.act("send", params(chain.phone(), acct), chain.key("g1f"), projectOwner)));
    expect(rs.filter((r) => r.ok)).toHaveLength(2); // 4 i alt (taket) - 2 allerede brukt i `business`
    expect(sends() - before).toBe(2);
  });

  it("gjenspillingsvernet er tenant-bredt: samme brukernøkkel i et ANNET rom med en annen konto er en kollisjon (ingen sending, aldri `ok + deduplicated` uten effekt)", async () => {
    const k = chain.key("rep");
    const n = chain.phone();
    const sent = await chain.act("send", params(n, "+4795000000"), k, projectOwner);
    expect(sent.ok).toBe(true);
    const before = sends();
    const other = await chain.act("send", params(n, "+4791000000"), k);
    expect(other, JSON.stringify(other)).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_collision" });
    expect(sends()).toBe(before);
  });
});
