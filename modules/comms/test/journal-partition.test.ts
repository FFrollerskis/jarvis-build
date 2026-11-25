import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { COMMS_JOURNALLED_ACTIONS, COMMS_KNOWN_ACTIONS, type OwnerActionResult } from "../src/index.ts";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1b (reviewer A, funn 3 og 5): (1) DRIFT-VAKT for partisjonen `COMMS_JOURNALLED_ACTIONS`: for ALLE 17 skrivehandlinger mot ekte ToolGateway-ledger og Postgres skrives det en journalrad (`comms_outbound_log`) for NØYAKTIG de fem journalførte,
 * og alle skrivinger har en ledgerrad; (2) nøkkellengdene 159/160/161 for ALLE 17 skrivehandlinger mot ekte ledger (uavkortet nøkkel, ledger høyst 230 og journalens request_id høyst 200 tegn, 161 gir `idempotency_key_too_long` uten ledgerrad).
 * Testen bruker egne, ferske nyttelaster per handling (`FRESH`) og kun atferd, ingen eksporter som kom med fiksen utover partisjonslisten den vokter.
 */
let chain: Chain;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${++seq}`;
const BASIS = { purpose_basis: "existing_customer_relationship" } as const;
const SMS = "+4791000000";
const SLACK = "T0AAAAAAAA";
const smsRef = () => `+4793${String(++seq).padStart(6, "0")}`;
const slackId = () => `C0${String(100000000 + ++seq)}`;
const scalar = async (sql: string, params: unknown[]): Promise<number> => ((await chain.db.admin.query(sql, params)).rows[0] as { n: number }).n;
const ledgerRows = async (action: string, suffix: string) => (await chain.db.admin.query("SELECT idempotency_key, status FROM tool_executions WHERE tenant_id = $1 AND tool_id = 'comms' AND action = $2 AND right(idempotency_key, $3) = $4", [TENANT_A, action, suffix.length, suffix])).rows as Array<{ idempotency_key: string; status: string }>;
const ok = (r: OwnerActionResult) => { if (!r.ok) throw new Error(`forventet ok: ${JSON.stringify(r)}`); return r; };

interface Call { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[] = [];
let handler: (call: Call) => Response = () => new Response("{}", { status: 404 });
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const person = (id: string, over: Record<string, unknown> = {}) => ({
  resourceName: `people/c${id}`, etag: `etag-${id}`, metadata: { sources: [{ type: "CONTACT", id, etag: `src-etag-${id}` }] }, names: [{ displayName: `Kontakt ${id}`, givenName: "Kontakt", familyName: id }],
  emailAddresses: [{ value: `kontakt${id}@example.com` }], phoneNumbers: [{ value: `+47 900 0${id.padStart(4, "0").slice(-4)}` }], organizations: [{ name: "Firma AS" }], ...over
});
const transcript = (marker: string) => [`Tittel: Ukesmøte ${marker}`, "Dato: 2026-11-16", "Deltakere: Ola Nordmann, Kari Hansen", "Ola Nordmann: Hei alle sammen. Jeg skal sende tilbudet til kunden innen 20. november.",
  "Kari Hansen: Greit. Vi må ordne avtalen innen 2026-11-25. Været er fint i dag.", `Ola Nordmann: Action: oppdater kontrakten ${marker}. Neste uke er det ferie.`].join("\n");

beforeAll(async () => {
  chain = await startChain("revaledg", { JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "1000", JARVIS_COMMS_CONTACTS: "on", JARVIS_COMMS_MEETINGS: "on" }, { rateLimitPerMinute: 1_000_000, lenientToolLimits: true, deps: { contacts: true, meetings: true } });
  await authorizeAll(chain, [["sms", SMS, "twilio"], ["phone", SMS, "twilio"], ["slack", SLACK, "slack"]]);
  const deleted = new Set<string>();
  const origDelete = chain.slack.delete!.bind(chain.slack);
  const origExists = chain.slack.messageExists!.bind(chain.slack);
  chain.slack.delete = async (req, cred) => { await origDelete(req, cred); deleted.add(req.target_message_id); };
  chain.slack.messageExists = async (req, cred) => (deleted.has(req.target_message_id) ? false : origExists(req, cred));
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);
beforeEach(() => {
  calls = []; handler = () => new Response("{}", { status: 404 });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { const call: Call = { url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null }; calls.push(call); return handler(call); });
});
afterEach(() => vi.unstubAllGlobals());

/** En FERSK, gyldig nyttelast per handling (kan kalles flere ganger: hver gang en ny nyttelast). */
const FRESH: Record<string, () => Promise<Record<string, JsonValue>>> = {
  send: async () => ({ channel: "sms", account_ref: SMS, recipient: chain.phone(), purpose: "transactional", text: "Hei, timen din er bekreftet.", ...BASIS }),
  start_call: async () => ({ channel: "phone", account_ref: SMS, recipient: chain.phone(), purpose: "transactional", text: "Hei, jeg ringer om timen.", ...BASIS }),
  edit_message: async () => { const recipient = slackId(); const r = ok(await chain.act("send", { channel: "slack", account_ref: SLACK, recipient, purpose: "transactional", text: "Hei", ...BASIS }, chain.key("own"))); return { channel: "slack", account_ref: SLACK, recipient, target_message_id: String(r.external_id), text: `Rettet ${uniq()}` }; },
  add_reaction: async () => { const recipient = slackId(); const r = ok(await chain.act("send", { channel: "slack", account_ref: SLACK, recipient, purpose: "transactional", text: "Hei", ...BASIS }, chain.key("own"))); return { channel: "slack", account_ref: SLACK, recipient, target_message_id: String(r.external_id), reaction: "thumbsup" }; },
  delete_message: async () => { const recipient = slackId(); const r = ok(await chain.act("send", { channel: "slack", account_ref: SLACK, recipient, purpose: "transactional", text: "Hei", ...BASIS }, chain.key("own"))); return { channel: "slack", account_ref: SLACK, recipient, target_message_id: String(r.external_id) }; },
  authorize_account: async () => ({ channel: "sms", account_ref: smsRef(), provider: "twilio" }),
  revoke_account: async () => ({ account_id: String(ok(await chain.act("authorize_account", { channel: "sms", account_ref: smsRef(), provider: "twilio" }, chain.key("pre"))).external_id) }),
  record_opt_out: async () => ({ channel: "sms", recipient: chain.phone() }),
  contacts_create: async () => { handler = (c) => (c.method === "POST" ? jsonRes(person(String(400 + seq++))) : new Response("{}", { status: 404 })); return { given_name: "Ola", family_name: `F${uniq()}` }; },
  contacts_update: async () => { handler = () => jsonRes(person("41")); return { resource_name: "people/c41", etag: "etag-41", organization: `Org-${uniq()}` }; },
  contacts_delete: async () => { const id = `5${++seq}1`; const gone = new Set<string>(); handler = (c) => { const name = c.url.match(/people\/(c\d+)/)?.[1] ?? ""; if (c.method === "DELETE") { gone.add(name); return new Response(null, { status: 204 }); } return gone.has(name) ? jsonRes({ error: { code: 404, status: "NOT_FOUND" } }, 404) : jsonRes(person(name.slice(1))); }; return { resource_name: `people/c${id}` }; },
  contacts_sync: async () => { handler = () => jsonRes({ connections: [] }); return { page_size: 10 + (++seq % 80) }; },
  contacts_unlink: async () => ({ resource_name: `people/c7${++seq}` }),
  meeting_ingest_text: async () => ({ format: "txt", text: transcript(`m${uniq()}`), attest_legal_basis: true }),
  meeting_decide_commitment: async () => {
    const m = ok(await chain.act("meeting_ingest_text", { format: "txt", text: transcript(`mc${uniq()}`), attest_legal_basis: true }));
    const listed = ok(await chain.act("meeting_commitments", { meeting_id: String(m.external_id), limit: 50 })).data as { commitments: Array<{ commitment_id: string }> };
    return { commitment_id: listed.commitments[0]!.commitment_id, decision: "accept" };
  },
  meeting_confirm_participant: async () => {
    const m = ok(await chain.act("meeting_ingest_text", { format: "txt", text: transcript(`mp${uniq()}`), attest_legal_basis: true }));
    const parts = (await chain.db.admin.query("SELECT participant_ref, display_name FROM comms_meeting_participants WHERE meeting_id = $1 ORDER BY display_name", [m.external_id])).rows as Array<{ participant_ref: string; display_name: string }>;
    const id = (await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "email", channel_identifier: `p-${uniq()}@confirm.example.com`, confidence: 1, match_method: "exact_email", display_name: parts[0]!.display_name })).identity_id;
    return { meeting_id: String(m.external_id), participant_ref: parts[0]!.participant_ref, identity_id: id };
  },
  meeting_delete: async () => ({ meeting_id: String(ok(await chain.act("meeting_ingest_text", { format: "txt", text: transcript(`md${uniq()}`), attest_legal_basis: true })).external_id) })
};
const WRITES = Object.keys(FRESH);

describe("partisjonen journalført/ikke-journalført er den FAKTISKE (journalrad skrevet <=> i COMMS_JOURNALLED_ACTIONS)", () => {
  it("alle 17 skrivehandlinger: journalrad skrives for NØYAKTIG de fem journalførte; gateway-klasse, nøkkelkrav og ledger-nøkkel tabelleres", async () => {
    for (const action of WRITES) {
      const payload = await FRESH[action]!();
      const key = chain.key(`part-${action}`);
      const r = await chain.act(action, payload, key);
      expect(r.ok, `${action}: ${JSON.stringify(r)}`).toBe(true);
      const journalled = COMMS_JOURNALLED_ACTIONS.includes(action);
      // send gir også journalrader for forberedelsene (egne sendinger i FRESH) - vurder kun raden for SELVE handlingen (request_id = skopet nøkkel)
      const own = await scalar("SELECT count(*)::int AS n FROM comms_outbound_log WHERE tenant_id = $1 AND request_id LIKE $2", [TENANT_A, `${action}:%:${key}`]);
      expect(own, `${action}: journalrad for selve handlingen`).toBe(journalled ? 1 : 0);
      const ledger = await ledgerRows(action, key);
      expect(ledger, `${action}: ledger`).toHaveLength(1);
    }
    // lesehandlinger: ingen ledgerrad (klasse A), ingen journalrad
    for (const action of COMMS_KNOWN_ACTIONS.filter((a) => !WRITES.includes(a))) expect(chain.gateway.get("comms", action)?.capability_class ?? "A", `${action} er klasse A`).toBe("A");
    expect(COMMS_KNOWN_ACTIONS.length).toBe(32);
    expect(WRITES.length).toBe(17);
  });
});

describe("159/160/161 mot EKTE ledger for alle 17 skrivehandlinger (ingen unntak, ingen avkorting, ingen rad ved 161)", () => {
  for (const action of WRITES) {
    it(`${action}`, async () => {
      for (const length of [159, 160]) {
        const key = `${chain.key("len")}-`.padEnd(length, "z").slice(0, length);
        expect(key).toHaveLength(length);
        const payload = await FRESH[action]!();
        const r = await chain.act(action, payload, key);
        expect(r.ok, `${action} ${length}: ${JSON.stringify(r)}`).toBe(true);
        const rows = await ledgerRows(action, key);
        expect(rows, `${action} ${length}: ledgerrad med HELE nøkkelen`).toHaveLength(1);
        expect(rows[0]!.idempotency_key.length).toBeLessThanOrEqual(230);
        if (COMMS_JOURNALLED_ACTIONS.includes(action)) {
          const j = (await chain.db.admin.query("SELECT request_id FROM comms_outbound_log WHERE tenant_id = $1 AND right(request_id, $2) = $3", [TENANT_A, length, key])).rows as Array<{ request_id: string }>;
          expect(j).toHaveLength(1);
          expect(j[0]!.request_id.length).toBeLessThanOrEqual(200);
        }
      }
      const tooLong = `${chain.key("len")}-`.padEnd(161, "z").slice(0, 161);
      const r161 = await chain.act(action, await FRESH[action]!(), tooLong);
      expect(r161).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_too_long" });
      expect(await ledgerRows(action, tooLong), `${action} 161: ingen ledgerrad`).toHaveLength(0);
    });
  }
});
