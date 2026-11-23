import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { COMMS_KNOWN_ACTIONS, optOutHash, scopedIdempotencyKey, type OwnerActionResult } from "../src/index.ts";
import { TENANT_A, TENANT_B } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1 fiks-runde 2, A-N2 (A-M5 var DELVIS): ToolGateway-ledgeren slår opp på (tenant, idempotensnøkkel) ALENE (kjent JARVIS-102), så samme brukervalgte nøkkel til to ULIKE handlinger ga `ok + deduplicated` på den andre uten at noe
 * ble utført: `authorize_account(K)` så `send(K)` = ingen sending; `send(K)` så `record_opt_out(K)` = ingen STOP registrert. LEDER-AVGJØRELSE: eier-handlingslaget skoper nøkkelen med handling + tenant-merke (den delte gatewayen er uendret).
 * Testen kjører ALLE ordnede par av handlinger med SAMME nøkkel og krever at begge utføres på ekte og uavhengig.
 */
let chain: Chain;
let seq = 0;
const deleted = new Set<string>();
let origDelete: NonNullable<Chain["slack"]["delete"]>;
let origExists: NonNullable<Chain["slack"]["messageExists"]>;
const BASIS = { purpose_basis: "existing_customer_relationship" } as const;
const count = (adapter: { calls: Array<{ op: string }> }, op: string) => adapter.calls.filter((c) => c.op === op).length;
const slackId = () => `C0${String(++seq).padStart(9, "0")}`;
const smsRef = () => `+4793${String(++seq).padStart(6, "0")}`;

interface Case {
  readonly action: string;
  /** Forbereder en fersk forespørsel (egne mål/mottakere) og returnerer hvordan den kjøres og om den fikk effekt. */
  make(): Promise<{ run(key: string): Promise<OwnerActionResult>; effect(): Promise<boolean> }>;
}

/** En fersk Slack-melding vi selv har sendt (eget mål for rediger/slett/reaksjon). */
async function ownSlackMessage(): Promise<{ recipient: string; target: string }> {
  const recipient = slackId();
  const sent = await chain.act("send", { channel: "slack", account_ref: "T0AAAAAAAA", recipient, purpose: "transactional", text: "Hei", ...BASIS }, chain.key("tg"));
  if (!sent.ok) throw new Error(`oppsett feilet: ${JSON.stringify(sent)}`);
  return { recipient, target: String(sent.external_id) };
}
const slackTarget = (recipient: string, target: string) => ({ channel: "slack", account_ref: "T0AAAAAAAA", recipient, target_message_id: target });

const CASES: readonly Case[] = [
  {
    action: "authorize_account",
    async make() {
      const ref = smsRef();
      return { run: (k) => chain.act("authorize_account", { channel: "sms", account_ref: ref, provider: "twilio" }, k), effect: async () => (await chain.store.findActiveAccount(TENANT_A, "business", "sms", ref)) !== null };
    }
  },
  {
    action: "revoke_account",
    async make() {
      const ref = smsRef();
      const auth = await chain.act("authorize_account", { channel: "sms", account_ref: ref, provider: "twilio" }, chain.key("ra"));
      if (!auth.ok) throw new Error(`oppsett feilet: ${JSON.stringify(auth)}`);
      return { run: (k) => chain.act("revoke_account", { account_id: String(auth.external_id) }, k), effect: async () => (await chain.store.findActiveAccount(TENANT_A, "business", "sms", ref)) === null };
    }
  },
  {
    action: "record_opt_out",
    async make() {
      const n = chain.phone();
      return { run: (k) => chain.act("record_opt_out", { channel: "sms", recipient: n }, k), effect: () => chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", n)) };
    }
  },
  {
    action: "send",
    async make() {
      const n = chain.phone();
      let before = 0;
      return {
        run: (k) => { before = count(chain.twilio, "send"); return chain.act("send", { channel: "sms", account_ref: "+4791000000", recipient: n, purpose: "transactional", text: "Hei, timen din er bekreftet.", ...BASIS }, k); },
        effect: async () => count(chain.twilio, "send") === before + 1
      };
    }
  },
  {
    action: "start_call",
    async make() {
      const n = chain.phone();
      let before = 0;
      return {
        run: (k) => { before = count(chain.twilio, "call"); return chain.act("start_call", { channel: "phone", account_ref: "+4791000000", recipient: n, purpose: "transactional", text: "Hei, jeg ringer om timen.", ...BASIS }, k); },
        effect: async () => count(chain.twilio, "call") === before + 1
      };
    }
  },
  {
    action: "add_reaction",
    async make() {
      const { recipient, target } = await ownSlackMessage();
      let before = 0;
      return {
        run: (k) => { before = count(chain.slack, "react"); return chain.act("add_reaction", { ...slackTarget(recipient, target), reaction: "thumbsup" }, k); },
        effect: async () => count(chain.slack, "react") === before + 1
      };
    }
  },
  {
    action: "edit_message",
    async make() {
      const { recipient, target } = await ownSlackMessage();
      let before = 0;
      return {
        run: (k) => { before = count(chain.slack, "edit"); return chain.act("edit_message", { ...slackTarget(recipient, target), text: "Rettet tekst" }, k); },
        effect: async () => count(chain.slack, "edit") === before + 1
      };
    }
  },
  {
    action: "delete_message",
    async make() {
      const { recipient, target } = await ownSlackMessage();
      let before = 0;
      return {
        run: (k) => { before = count(chain.slack, "delete"); return chain.act("delete_message", slackTarget(recipient, target), k); },
        effect: async () => count(chain.slack, "delete") === before + 1
      };
    }
  }
];

beforeAll(async () => {
  chain = await startChain("g1ks", { JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "1000" }, { rateLimitPerMinute: 1_000_000, lenientToolLimits: true });
  await authorizeAll(chain, [["sms", "+4791000000", "twilio"], ["phone", "+4791000000", "twilio"], ["slack", "T0AAAAAAAA", "slack"]]);
  // readback av sletting: meldingen er borte etter at slettingen er kjørt
  origDelete = chain.slack.delete!.bind(chain.slack);
  origExists = chain.slack.messageExists!.bind(chain.slack);
  chain.slack.delete = async (req, cred) => { await origDelete(req, cred); deleted.add(req.target_message_id); };
  chain.slack.messageExists = async (req, cred) => (deleted.has(req.target_message_id) ? false : origExists(req, cred));
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("A-N2: nøkkelen er skopet med handling og tenant", () => {
  it("reviewerens to repro-tilfeller: `authorize_account(K)` så `send(K)` SENDER; `send(K)` så `record_opt_out(K)` REGISTRERER STOP", async () => {
    const k = chain.key("repro");
    const auth = await chain.act("authorize_account", { channel: "sms", account_ref: "+4793999999", provider: "twilio" }, k);
    expect(auth.ok).toBe(true);
    const before = count(chain.twilio, "send");
    const sent = await chain.act("send", { channel: "sms", account_ref: "+4791000000", recipient: chain.phone(), purpose: "transactional", text: "Hei, timen din er bekreftet.", ...BASIS }, k);
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, deduplicated: false });
    expect(count(chain.twilio, "send")).toBe(before + 1);
    const n = chain.phone();
    const stop = await chain.act("record_opt_out", { channel: "sms", recipient: n }, k);
    expect(stop, JSON.stringify(stop)).toMatchObject({ ok: true, deduplicated: false });
    expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", n))).toBe(true);
  });

  it(`ALLE ordnede par av handlinger (${CASES.length} x ${CASES.length - 1}) med SAMME nøkkel utføres uavhengig - aldri \`ok + deduplicated\` uten effekt`, async () => {
    const failures: string[] = [];
    for (const first of CASES) {
      for (const second of CASES) {
        if (first === second) continue;
        const k = chain.key("pair");
        const a = await first.make();
        const b = await second.make();
        const ra = await a.run(k);
        if (!(ra.ok && !ra.deduplicated && (await a.effect()))) { failures.push(`${first.action}(K) som FØRSTE: ${JSON.stringify(ra).slice(0, 160)}`); continue; }
        const rb = await b.run(k);
        if (!(rb.ok && !rb.deduplicated && (await b.effect()))) failures.push(`${first.action}(K) så ${second.action}(K): ${JSON.stringify(rb).slice(0, 160)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 240_000);

  it("kontroll: SAMME handling med SAMME forespørsel og nøkkel er fortsatt en ekte gjenspilling (`deduplicated`, ingen ekstra leverandørkall)", async () => {
    for (const name of ["send", "start_call", "authorize_account", "record_opt_out"]) {
      const c = CASES.find((x) => x.action === name)!;
      const made = await c.make();
      const k = chain.key("same");
      const first = await made.run(k);
      expect(first.ok && !first.deduplicated, name).toBe(true);
      expect(await made.effect(), name).toBe(true);
      const sendsBefore = count(chain.twilio, "send") + count(chain.twilio, "call");
      const again = await made.run(k);
      expect(again, name).toMatchObject({ ok: true, deduplicated: true });
      expect(count(chain.twilio, "send") + count(chain.twilio, "call"), `${name}: ingen ekstra leverandørkall`).toBe(sendsBefore);
    }
  });

  it("nøkkelfunksjonen: ulike handlinger gir ulike nøkler (for ALLE kjente handlinger), tenant-merket skiller tenants, formen er gyldig for journalen (<= 200 tegn, tillatt tegnsett) også for en 160-tegns brukernøkkel", () => {
    const key = "k".repeat(160);
    const keys = COMMS_KNOWN_ACTIONS.map((a) => scopedIdempotencyKey(TENANT_A, a, key));
    expect(new Set(keys).size).toBe(COMMS_KNOWN_ACTIONS.length);
    for (const k of keys) {
      expect(k.length).toBeLessThanOrEqual(200);
      expect(k).toMatch(/^[A-Za-z0-9._:-]{8,200}$/);
    }
    expect(scopedIdempotencyKey(TENANT_A, "send", "abc-12345")).not.toBe(scopedIdempotencyKey(TENANT_B, "send", "abc-12345"));
    expect(scopedIdempotencyKey(TENANT_A, "send", "abc-12345")).toBe(scopedIdempotencyKey(TENANT_A, "send", "abc-12345"));
    expect(scopedIdempotencyKey(TENANT_A, "send", "abc-12345")).toMatch(/^send:[0-9a-f]{8}:abc-12345$/);
  });

  it("en brukernøkkel på 161 tegn avvises (den skopede nøkkelen måtte ellers sprengt journalens 200 tegn) med den TYDELIGE feilen `idempotency_key_too_long` (WP-G1b, JARVIS-112 e: tidligere den misvisende `idempotency_key_required`); 160 tegn virker", async () => {
    const params = (): Record<string, JsonValue> => ({ channel: "sms", account_ref: "+4791000000", recipient: chain.phone(), purpose: "transactional", text: "Hei, timen din er bekreftet.", ...BASIS });
    const tooLong = await chain.act("send", params(), "x".repeat(161));
    expect(tooLong).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_too_long" });
    const max = await chain.act("send", params(), "y".repeat(160));
    expect(max.ok).toBe(true);
  });
});
