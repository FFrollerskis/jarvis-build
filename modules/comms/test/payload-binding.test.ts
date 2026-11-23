import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { COMMS_KNOWN_ACTIONS, optOutHash, type OwnerActionResult } from "../src/index.ts";
import { TENANT_A } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1b (JARVIS-112 a, Q-72): samme handling + samme brukernøkkel + ULIK nyttelast ga `ok + deduplicated` UTEN effekt for ikke-journalførte handlinger (ToolGateway-ledgeren slår opp på (tenant, nøkkel) alene, kjent JARVIS-102):
 * `record_opt_out(K, A)` så `(K, B)` registrerte ikke B; `authorize_account(K, X)` så `(K, Y)` autoriserte ikke Y. Journalførte utgående handlinger er bundet av journalens fingeravtrykk (A-M5) og er uendret.
 *
 * Alt her går gjennom den EKSAKTE eierkjeden (embedded Postgres med RLS som app-rolle, ekte ToolGateway med klasse D-pipeline, ekte eier-handlingslag); kun leverandørene er falske (skriptede adaptere og en stubbet People API).
 * Testen bruker KUN atferd (ingen eksporter som kom med fiksen), så den kan kjøres mot main-koden og da feile av riktig grunn.
 */
let chain: Chain;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${++seq}`;
const BASIS = { purpose_basis: "existing_customer_relationship" } as const;
/** De fem JOURNALFØRTE utgående handlingene (A-M5). Egen liste, uavhengig av implementasjonen. */
const JOURNALLED = ["send", "start_call", "edit_message", "delete_message", "add_reaction"] as const;
const SMS_ACCOUNT = "+4791000000";
const SLACK_ACCOUNT = "T0AAAAAAAA";
const smsRef = () => `+4793${String(++seq).padStart(6, "0")}`;
const slackId = () => `C0${String(++seq).padStart(9, "0")}`;
const count = (adapter: { calls: Array<{ op: string }> }, op: string) => adapter.calls.filter((c) => c.op === op).length;
const scalar = async (sql: string, params: unknown[]): Promise<number> => ((await chain.db.admin.query(sql, params)).rows[0] as { n: number }).n;
const inSpace = (space: string): IdentityContext => ({ ...chain.owner, memory_space_id: space as IdentityContext["memory_space_id"], session_id: `sess-${space}` });

// ---------------------------------------------------------------------------------------------- falsk People API
interface Call { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[] = [];
let handler: (call: Call) => Response = () => new Response("{}", { status: 404 });
const jsonRes = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const person = (id: string, over: Record<string, unknown> = {}) => ({
  resourceName: `people/c${id}`, etag: `etag-${id}`, metadata: { sources: [{ type: "CONTACT", id, etag: `src-etag-${id}` }] },
  names: [{ displayName: `Kontakt ${id}`, givenName: "Kontakt", familyName: id }], emailAddresses: [{ value: `kontakt${id}@example.com` }], phoneNumbers: [{ value: `+47 900 0${id.padStart(4, "0").slice(-4)}` }],
  organizations: [{ name: "Firma AS" }], ...over
});
const transcript = (marker: string) => [
  `Tittel: Ukesmøte ${marker}`, "Dato: 2026-11-16", "Deltakere: Ola Nordmann, Kari Hansen",
  "Ola Nordmann: Hei alle sammen. Jeg skal sende tilbudet til kunden innen 20. november.",
  "Kari Hansen: Greit. Vi må ordne avtalen innen 2026-11-25. Været er fint i dag.",
  `Ola Nordmann: Action: oppdater kontrakten ${marker}. Neste uke er det ferie.`
].join("\n");

beforeAll(async () => {
  chain = await startChain("g1b", { JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR: "1000", JARVIS_COMMS_CONTACTS: "on", JARVIS_COMMS_MEETINGS: "on" }, { rateLimitPerMinute: 1_000_000, lenientToolLimits: true, deps: { contacts: true, meetings: true } });
  await authorizeAll(chain, [["sms", SMS_ACCOUNT, "twilio"], ["phone", SMS_ACCOUNT, "twilio"], ["slack", SLACK_ACCOUNT, "slack"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);
beforeEach(() => {
  calls = [];
  handler = () => new Response("{}", { status: 404 });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(call);
    return handler(call);
  });
});
afterEach(() => vi.unstubAllGlobals());

const ok = (r: OwnerActionResult): { external_id?: string; data: JsonValue; deduplicated: boolean } => {
  if (!r.ok) throw new Error(`forventet ok: ${JSON.stringify(r)}`);
  return r;
};

// ---------------------------------------------------------------------------------------------- A: reproduksjonen
describe("A: JARVIS-112 (a) - reviewerens to repro-tilfeller (rød på main)", () => {
  it("`record_opt_out(K, A)` så `record_opt_out(K, B)`: BEGGE registreres - B er ikke en stille ikke-handling", async () => {
    const k = chain.key("repro-oo");
    const a = chain.phone();
    const b = chain.phone();
    expect(await chain.act("record_opt_out", { channel: "sms", recipient: a }, k)).toMatchObject({ ok: true, deduplicated: false });
    const second = await chain.act("record_opt_out", { channel: "sms", recipient: b }, k);
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true, deduplicated: false });
    expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", a))).toBe(true);
    expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", b)), "STOP for B ble aldri registrert").toBe(true);
  });

  it("`authorize_account(K, X)` så `authorize_account(K, Y)`: BEGGE kontoene autoriseres", async () => {
    const k = chain.key("repro-auth");
    const x = smsRef();
    const y = smsRef();
    expect(await chain.act("authorize_account", { channel: "sms", account_ref: x, provider: "twilio" }, k)).toMatchObject({ ok: true, deduplicated: false });
    const second = await chain.act("authorize_account", { channel: "sms", account_ref: y, provider: "twilio" }, k);
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true, deduplicated: false });
    expect(await chain.store.findActiveAccount(TENANT_A, "business", "sms", x)).not.toBeNull();
    expect(await chain.store.findActiveAccount(TENANT_A, "business", "sms", y), "konto Y ble aldri autorisert").not.toBeNull();
  });

  it("kontroll: SAMME handling + SAMME nøkkel + SAMME nyttelast er fortsatt en ekte gjenspilling (`deduplicated`, ingen ny rad)", async () => {
    const k = chain.key("repro-same");
    const n = chain.phone();
    const hash = optOutHash(TENANT_A, "sms", n);
    const rows = () => scalar("SELECT count(*)::int AS n FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, hash]);
    expect(await chain.act("record_opt_out", { channel: "sms", recipient: n }, k)).toMatchObject({ ok: true, deduplicated: false });
    expect(await rows()).toBe(1);
    expect(await chain.act("record_opt_out", { channel: "sms", recipient: n }, k)).toMatchObject({ ok: true, deduplicated: true });
    expect(await rows()).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------- B: matrisen
interface Prepared {
  readonly a: Record<string, JsonValue>;
  readonly b: Record<string, JsonValue>;
  /** Har nyttelasten (a eller b) HATT effekt? */
  took(which: "a" | "b"): Promise<boolean>;
  /** Antall av de to nyttelastene som har hatt effekt (0, 1 eller 2). */
  effects(): Promise<number>;
}
interface Scenario {
  readonly action: string;
  /** `deduplicated`: gjenspilling gir lagret resultat. `target_gone`: klasse D med `preflight_requires_target` - målet er borte, så gjenspillingen avslås av preflighten (aldri en ny sletting). */
  readonly replay: "deduplicated" | "target_gone";
  prepare(): Promise<Prepared>;
}

const revokedLinks = (externalIds: string[]) => scalar("SELECT count(*)::int AS n FROM conversation_channel_links WHERE tenant_id = $1 AND external_id = ANY($2) AND status = 'revoked'", [TENANT_A, externalIds]);
const meetingIdOf = async (marker: string): Promise<string> => {
  const r = await chain.act("meeting_ingest_text", { format: "txt", text: transcript(marker), attest_legal_basis: true });
  return String((ok(r).data as { meeting_id: string }).meeting_id);
};

const SCENARIOS: readonly Scenario[] = [
  {
    action: "authorize_account", replay: "deduplicated",
    async prepare() {
      const x = smsRef();
      const y = smsRef();
      const has = async (ref: string) => (await chain.store.findActiveAccount(TENANT_A, "business", "sms", ref)) !== null;
      return {
        a: { channel: "sms", account_ref: x, provider: "twilio" }, b: { channel: "sms", account_ref: y, provider: "twilio" },
        took: async (w) => has(w === "a" ? x : y), effects: async () => Number(await has(x)) + Number(await has(y))
      };
    }
  },
  {
    action: "revoke_account", replay: "deduplicated",
    async prepare() {
      const refs = [smsRef(), smsRef()] as const;
      const ids: string[] = [];
      for (const ref of refs) ids.push(String(ok(await chain.act("authorize_account", { channel: "sms", account_ref: ref, provider: "twilio" }, chain.key("pre-rv"))).external_id));
      const gone = async (ref: string) => (await chain.store.findActiveAccount(TENANT_A, "business", "sms", ref)) === null;
      return {
        a: { account_id: ids[0]! }, b: { account_id: ids[1]! },
        took: async (w) => gone(w === "a" ? refs[0] : refs[1]), effects: async () => Number(await gone(refs[0])) + Number(await gone(refs[1]))
      };
    }
  },
  {
    action: "record_opt_out", replay: "deduplicated",
    async prepare() {
      const n1 = chain.phone();
      const n2 = chain.phone();
      const hashes = [optOutHash(TENANT_A, "sms", n1), optOutHash(TENANT_A, "sms", n2)];
      return {
        a: { channel: "sms", recipient: n1 }, b: { channel: "sms", recipient: n2 },
        took: async (w) => chain.store.isOptedOut(TENANT_A, hashes[w === "a" ? 0 : 1]!),
        effects: () => scalar("SELECT count(*)::int AS n FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = ANY($2) AND status = 'active'", [TENANT_A, hashes])
      };
    }
  },
  {
    action: "contacts_create", replay: "deduplicated",
    async prepare() {
      const m = uniq();
      handler = (c) => (c.method === "POST" ? jsonRes(person(String(400 + seq++))) : new Response("{}", { status: 404 }));
      const posts = () => calls.filter((c) => c.method === "POST");
      return {
        a: { given_name: "Ola", family_name: `Aa${m}` }, b: { given_name: "Kari", family_name: `Bb${m}` },
        took: async (w) => posts().some((c) => JSON.stringify(c.body).includes(`${w === "a" ? "Aa" : "Bb"}${m}`)), effects: async () => posts().length
      };
    }
  },
  {
    action: "contacts_update", replay: "deduplicated",
    async prepare() {
      const m = uniq();
      handler = (c) => (c.method === "GET" ? jsonRes(person("41")) : jsonRes(person("41")));
      const patches = () => calls.filter((c) => c.method === "PATCH");
      return {
        a: { resource_name: "people/c41", etag: "etag-41", organization: `Org-A-${m}` }, b: { resource_name: "people/c41", etag: "etag-41", organization: `Org-B-${m}` },
        took: async (w) => patches().some((c) => JSON.stringify(c.body).includes(`Org-${w === "a" ? "A" : "B"}-${m}`)), effects: async () => patches().length
      };
    }
  },
  {
    action: "contacts_delete", replay: "target_gone",
    async prepare() {
      const ids = [`5${++seq}1`, `5${seq}2`];
      const deleted = new Set<string>();
      handler = (c) => {
        const name = c.url.match(/people\/(c\d+)/)?.[1] ?? "";
        if (c.method === "DELETE") { deleted.add(name); return new Response(null, { status: 204 }); }
        return deleted.has(name) ? jsonRes({ error: { code: 404, status: "NOT_FOUND" } }, 404) : jsonRes(person(name.slice(1)));
      };
      return {
        a: { resource_name: `people/c${ids[0]}` }, b: { resource_name: `people/c${ids[1]}` },
        took: async (w) => deleted.has(`c${ids[w === "a" ? 0 : 1]}`), effects: async () => deleted.size
      };
    }
  },
  {
    action: "contacts_sync", replay: "deduplicated",
    async prepare() {
      handler = () => jsonRes({ connections: [] });
      const lists = (size: number) => calls.filter((c) => c.method === "GET" && c.url.endsWith(`pageSize=${size}`));
      return { a: { page_size: 10 }, b: { page_size: 11 }, took: async (w) => lists(w === "a" ? 10 : 11).length > 0, effects: async () => lists(10).length + lists(11).length };
    }
  },
  {
    action: "contacts_unlink", replay: "deduplicated",
    async prepare() {
      const n = ++seq;
      const ids = [`6${n}1`, `6${n}2`];
      handler = () => jsonRes({ connections: ids.map((id, i) => person(id, { phoneNumbers: [{ value: `+4795${String(n).padStart(3, "0")}${i}00` }], emailAddresses: [{ value: `u${id}@unlink.example.com` }] })) });
      expect(ok(await chain.act("contacts_sync", {})).data).toMatchObject({ linked_identifiers: 4, contacts_conflict: 0 });
      const externals = ids.map((id) => `people/c${id}`);
      return {
        a: { resource_name: externals[0]! }, b: { resource_name: externals[1]! },
        took: async (w) => (await revokedLinks([externals[w === "a" ? 0 : 1]!])) > 0, effects: async () => Number((await revokedLinks([externals[0]!])) > 0) + Number((await revokedLinks([externals[1]!])) > 0)
      };
    }
  },
  {
    action: "meeting_ingest_text", replay: "deduplicated",
    async prepare() {
      const ma = `ma${uniq()}`;
      const mb = `mb${uniq()}`;
      const has = async (m: string) => (await scalar("SELECT count(*)::int AS n FROM comms_meetings WHERE tenant_id = $1 AND title = $2", [TENANT_A, `Ukesmøte ${m}`])) > 0;
      return {
        a: { format: "txt", text: transcript(ma), attest_legal_basis: true }, b: { format: "txt", text: transcript(mb), attest_legal_basis: true },
        took: async (w) => has(w === "a" ? ma : mb), effects: async () => Number(await has(ma)) + Number(await has(mb))
      };
    }
  },
  {
    action: "meeting_decide_commitment", replay: "deduplicated",
    async prepare() {
      const meetingId = await meetingIdOf(`mc${uniq()}`);
      const listed = ok(await chain.act("meeting_commitments", { meeting_id: meetingId, limit: 50 })).data as { commitments: Array<{ commitment_id: string; segment_index: number }> };
      const [c1, c2] = [...listed.commitments].sort((x, y) => x.segment_index - y.segment_index);
      const accepted = async (id: string) => (await scalar("SELECT count(*)::int AS n FROM comms_meeting_commitments WHERE commitment_id = $1 AND status = 'accepted'", [id])) > 0;
      return {
        a: { commitment_id: c1!.commitment_id, decision: "accept" }, b: { commitment_id: c2!.commitment_id, decision: "accept" },
        took: async (w) => accepted((w === "a" ? c1 : c2)!.commitment_id), effects: async () => Number(await accepted(c1!.commitment_id)) + Number(await accepted(c2!.commitment_id))
      };
    }
  },
  {
    action: "meeting_confirm_participant", replay: "deduplicated",
    async prepare() {
      const meetingId = await meetingIdOf(`mp${uniq()}`);
      const parts = (await chain.db.admin.query("SELECT participant_ref, display_name FROM comms_meeting_participants WHERE meeting_id = $1 ORDER BY display_name", [meetingId])).rows as Array<{ participant_ref: string; display_name: string }>;
      expect(parts).toHaveLength(2);
      const ids: string[] = [];
      for (const [i, p] of parts.entries()) ids.push((await chain.graph.linkChannelIdentity(TENANT_A, "business", { channel: "email", channel_identifier: `p${i}-${uniq()}@confirm.example.com`, confidence: 1, match_method: "exact_email", display_name: p.display_name })).identity_id);
      const confirmed = async (ref: string) => (await scalar("SELECT count(*)::int AS n FROM comms_meeting_participants WHERE meeting_id = $1 AND participant_ref = $2 AND resolution = 'owner_confirmed'", [meetingId, ref])) > 0;
      return {
        a: { meeting_id: meetingId, participant_ref: parts[0]!.participant_ref, identity_id: ids[0]! }, b: { meeting_id: meetingId, participant_ref: parts[1]!.participant_ref, identity_id: ids[1]! },
        took: async (w) => confirmed(parts[w === "a" ? 0 : 1]!.participant_ref), effects: async () => Number(await confirmed(parts[0]!.participant_ref)) + Number(await confirmed(parts[1]!.participant_ref))
      };
    }
  },
  {
    action: "meeting_delete", replay: "target_gone",
    async prepare() {
      const m1 = await meetingIdOf(`md1${uniq()}`);
      const m2 = await meetingIdOf(`md2${uniq()}`);
      const gone = async (id: string) => (await scalar("SELECT count(*)::int AS n FROM comms_meetings WHERE meeting_id = $1", [id])) === 0;
      return { a: { meeting_id: m1 }, b: { meeting_id: m2 }, took: async (w) => gone(w === "a" ? m1 : m2), effects: async () => Number(await gone(m1)) + Number(await gone(m2)) };
    }
  }
];

describe("B: alle 12 ikke-journalførte skrivehandlinger - gjenspilling er `deduplicated` uten ny effekt; ulik nyttelast med samme nøkkel UTFØRES med synlig effekt", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.action}: (K, A) utføres, (K, A) igjen = ingen ny effekt, (K, B) utføres på ekte`, async () => {
      const p = await scenario.prepare();
      calls = [];
      const k = chain.key(`m-${scenario.action}`);
      const first = await chain.act(scenario.action, p.a, k);
      expect(first, `første kall: ${JSON.stringify(first)}`).toMatchObject({ ok: true, deduplicated: false });
      expect(await p.took("a"), "A skal ha effekt").toBe(true);
      expect(await p.took("b"), "B skal ikke ha effekt ennå").toBe(false);
      expect(await p.effects()).toBe(1);
      // (b) gjenspilling med LIK nyttelast: ingen ny effekt
      const replay = await chain.act(scenario.action, p.a, k);
      if (scenario.replay === "deduplicated") expect(replay, `gjenspilling: ${JSON.stringify(replay)}`).toMatchObject({ ok: true, deduplicated: true });
      else expect(replay).toEqual({ ok: false, status: "failed", reason: "preflight_target_not_found" });
      expect(await p.effects(), "gjenspillingen skal ikke gi ny effekt").toBe(1);
      // (c) ULIK nyttelast, samme nøkkel: en uavhengig forespørsel som UTFØRES (aldri en stille ikke-handling)
      const second = await chain.act(scenario.action, p.b, k);
      expect(second, `ulik nyttelast: ${JSON.stringify(second)}`).toMatchObject({ ok: true, deduplicated: false });
      expect(await p.took("b"), "B ble aldri utført (stille ikke-handling)").toBe(true);
      expect(await p.effects()).toBe(2);
      // og B er nå selv en ekte gjenspilling
      const again = await chain.act(scenario.action, p.b, k);
      if (scenario.replay === "deduplicated") expect(again).toMatchObject({ ok: true, deduplicated: true });
      expect(await p.effects()).toBe(2);
    });
  }

  it("tabellen er FULLSTENDIG: nøyaktig de registrerte, ikke-journalførte handlingene som ikke er lesing (klasse B/C/D) - ingen handling med nøkkel glipper", () => {
    const mutating = COMMS_KNOWN_ACTIONS.filter((a) => chain.gateway.get("comms", a) !== undefined && !(JOURNALLED as readonly string[]).includes(a) && chain.gateway.get("comms", a)!.capability_class !== "A");
    expect(mutating.length).toBe(12);
    expect(SCENARIOS.map((s) => s.action).sort()).toEqual([...mutating].sort());
  });

  it("samme nyttelast med ANNEN nøkkelrekkefølge er den samme forespørselen: en ekte gjenspilling (`deduplicated`), ingen ny konto", async () => {
    const ref = smsRef();
    const k = chain.key("order");
    const first = await chain.act("authorize_account", { channel: "sms", account_ref: ref, provider: "twilio" }, k);
    expect(first).toMatchObject({ ok: true, deduplicated: false });
    const reordered = await chain.act("authorize_account", { provider: "twilio", account_ref: ref, channel: "sms" }, k);
    expect(reordered).toMatchObject({ ok: true, deduplicated: true });
    expect(await scalar("SELECT count(*)::int AS n FROM comms_authorized_accounts WHERE tenant_id = $1 AND account_ref = $2", [TENANT_A, ref])).toBe(1);
  });

  it("samme nøkkel + samme nyttelast i et ANNET memory space er en uavhengig forespørsel (virkningen er per rom): `project` får sitt eget møte i stedet for en stille deduplisering mot `business`", async () => {
    const params = { format: "txt", text: transcript(`sp${uniq()}`), attest_legal_basis: true };
    const k = chain.key("space-mt");
    const business = ok(await chain.act("meeting_ingest_text", params, k));
    expect(business.deduplicated).toBe(false);
    const project = ok(await chain.act("meeting_ingest_text", params, k, inSpace("project")));
    expect(project.deduplicated, "møtet i project ble aldri behandlet (stille deduplisering mot business)").toBe(false);
    expect(project.external_id).not.toBe(business.external_id);
    expect(await scalar("SELECT count(*)::int AS n FROM comms_meetings WHERE meeting_id = $1 AND memory_space_id = 'project'", [project.external_id])).toBe(1);
    expect(await scalar("SELECT count(*)::int AS n FROM comms_meetings WHERE meeting_id = $1 AND memory_space_id = 'business'", [business.external_id])).toBe(1);
    // og hvert rom har sin egen ekte gjenspilling
    expect(ok(await chain.act("meeting_ingest_text", params, k, inSpace("project")))).toMatchObject({ deduplicated: true, external_id: project.external_id });
    expect(ok(await chain.act("meeting_ingest_text", params, k))).toMatchObject({ deduplicated: true, external_id: business.external_id });
  });

  it("Google-kontaktboken er ÉN per utrulling: `contacts_create` K/P fra `project` etter K/P fra `business` er en ekte gjenspilling (`deduplicated`, ÉN opprettelse), ikke en dobbel opprettelse (reviewer A funn 2); ulik nyttelast med samme nøkkel utføres fortsatt", async () => {
    const p = { given_name: "Rom", family_name: `Rom${uniq()}` };
    const k = chain.key("space-cc");
    handler = (c) => (c.method === "POST" ? jsonRes(person(String(700 + seq++))) : new Response("{}", { status: 404 }));
    const posts = () => calls.filter((c) => c.method === "POST").length;
    expect(await chain.act("contacts_create", p, k)).toMatchObject({ ok: true, deduplicated: false });
    expect(await chain.act("contacts_create", p, k, inSpace("project"))).toMatchObject({ ok: true, deduplicated: true });
    expect(await chain.act("contacts_create", p, k, inSpace("personal"))).toMatchObject({ ok: true, deduplicated: true });
    expect(posts(), "People API skal kun ha fått ÉN opprettelse").toBe(1);
    expect(await chain.act("contacts_create", { ...p, family_name: `${p.family_name}-B` }, k, inSpace("project"))).toMatchObject({ ok: true, deduplicated: false });
    expect(posts()).toBe(2);
  });

  it("samme konto i et annet rom: lagret tillater kun ÉN aktiv autorisasjon per konto, så en (K, X) fra `project` gir en TYDELIG feil - aldri et falskt `ok + deduplicated` (som på main) om at kontoen nå er autorisert der", async () => {
    const ref = smsRef();
    const k = chain.key("space-acct");
    const params = { channel: "sms", account_ref: ref, provider: "twilio" };
    expect(await chain.act("authorize_account", params, k)).toMatchObject({ ok: true, deduplicated: false });
    const project = await chain.act("authorize_account", params, k, inSpace("project"));
    expect(project, JSON.stringify(project)).toEqual({ ok: false, status: "failed", reason: "tool_failed:comms_account_authorized_in_another_room" });
    expect(await chain.store.findActiveAccount(TENANT_A, "business", "sms", ref)).not.toBeNull();
    expect(await chain.store.findActiveAccount(TENANT_A, "project", "sms", ref)).toBeNull();
  });

  it("en gjenspilling fra en NY sesjon/enhet (klienten logget inn på nytt) er fortsatt samme forespørsel: `deduplicated`, ingen ny effekt - person, sesjon og enhet er ikke del av nøkkelen", async () => {
    const n = chain.phone();
    const k = chain.key("session");
    const hash = optOutHash(TENANT_A, "sms", n);
    expect(await chain.act("record_opt_out", { channel: "sms", recipient: n }, k)).toMatchObject({ ok: true, deduplicated: false, data: { created: true } });
    const reconnected: IdentityContext = { ...chain.owner, session_id: "sess-etter-ny-innlogging", device_id: "dev-ny-enhet", channel: "web" };
    expect(await chain.act("record_opt_out", { channel: "sms", recipient: n }, k, reconnected)).toMatchObject({ ok: true, deduplicated: true });
    expect(await scalar("SELECT count(*)::int AS n FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, hash])).toBe(1);
  });

  it("SAMTIDIGE forespørsler: (K, A) og (K, B) i parallell (12 runder med ekte `Promise.all`) utføres BEGGE; (K, A) to ganger i parallell gir høyst ÉN utføring (aldri to effekter)", async () => {
    for (let round = 0; round < 12; round += 1) {
      const k = chain.key(`race-${round}`);
      const [a, b] = [chain.phone(), chain.phone()];
      const results = await Promise.all([chain.act("record_opt_out", { channel: "sms", recipient: a }, k), chain.act("record_opt_out", { channel: "sms", recipient: b }, k)]);
      for (const r of results) expect(r, `runde ${round}: ${JSON.stringify(r)}`).toMatchObject({ ok: true, deduplicated: false });
      expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", a)), `runde ${round}: A`).toBe(true);
      expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", b)), `runde ${round}: B`).toBe(true);
      const same = chain.phone();
      const pair = await Promise.all([chain.act("authorize_account", { channel: "sms", account_ref: same, provider: "twilio" }, k), chain.act("authorize_account", { channel: "sms", account_ref: same, provider: "twilio" }, k)]);
      expect(pair.filter((r) => r.ok && !r.deduplicated), `runde ${round}: ${JSON.stringify(pair)}`).toHaveLength(1);
      expect(await scalar("SELECT count(*)::int AS n FROM comms_authorized_accounts WHERE tenant_id = $1 AND account_ref = $2 AND status = 'active'", [TENANT_A, same])).toBe(1);
    }
  });

  it("`record_opt_out` er tenant-bred: samme nøkkel og nyttelast fra et annet rom utføres på ny og er harmløs (`created: false` - raden finnes), men er aldri en stille ikke-handling", async () => {
    const n = chain.phone();
    const k = chain.key("space-oo");
    const first = ok(await chain.act("record_opt_out", { channel: "sms", recipient: n }, k));
    expect(first).toMatchObject({ deduplicated: false, data: { created: true } });
    const other = ok(await chain.act("record_opt_out", { channel: "sms", recipient: n }, k, inSpace("project")));
    expect(other).toMatchObject({ deduplicated: false, data: { created: false } });
    expect(await scalar("SELECT count(*)::int AS n FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2", [TENANT_A, optOutHash(TENANT_A, "sms", n)])).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------- C: A-M5 uendret
describe("C: A-M5 er uendret for de fem journalførte utgående handlingene - samme nøkkel + annen forespørsel = `idempotency_key_collision`, aldri en uavhengig utføring", () => {
  const deletedMessages = new Set<string>();
  let origDelete: NonNullable<Chain["slack"]["delete"]>;
  let origExists: NonNullable<Chain["slack"]["messageExists"]>;
  beforeAll(() => {
    origDelete = chain.slack.delete!.bind(chain.slack);
    origExists = chain.slack.messageExists!.bind(chain.slack);
    chain.slack.delete = async (req, cred) => { await origDelete(req, cred); deletedMessages.add(req.target_message_id); };
    chain.slack.messageExists = async (req, cred) => (deletedMessages.has(req.target_message_id) ? false : origExists(req, cred));
  });
  const ownSlackMessage = async (): Promise<{ recipient: string; target: string }> => {
    const recipient = slackId();
    const sent = await chain.act("send", { channel: "slack", account_ref: SLACK_ACCOUNT, recipient, purpose: "transactional", text: "Hei", ...BASIS }, chain.key("own"));
    return { recipient, target: String(ok(sent).external_id) };
  };
  const slackTarget = (recipient: string, target: string) => ({ channel: "slack", account_ref: SLACK_ACCOUNT, recipient, target_message_id: target });
  const journalRows = (action: string) => scalar("SELECT count(*)::int AS n FROM comms_outbound_log WHERE tenant_id = $1 AND request_id LIKE $2", [TENANT_A, `${action}:%`]);

  interface Journalled { readonly action: (typeof JOURNALLED)[number]; make(): Promise<{ a: Record<string, JsonValue>; b: Record<string, JsonValue>; providerCalls(): number; replayDedupes: boolean }> }
  const CASES: readonly Journalled[] = [
    { action: "send", async make() { const n = chain.phone(); const p = (text: string) => ({ channel: "sms", account_ref: SMS_ACCOUNT, recipient: n, purpose: "transactional", text, ...BASIS }); return { a: p("Første melding."), b: p("Helt annen melding."), providerCalls: () => count(chain.twilio, "send"), replayDedupes: true }; } },
    { action: "start_call", async make() { const n = chain.phone(); const p = (text: string) => ({ channel: "phone", account_ref: SMS_ACCOUNT, recipient: n, purpose: "transactional", text, ...BASIS }); return { a: p("Første manus."), b: p("Annet manus."), providerCalls: () => count(chain.twilio, "call"), replayDedupes: true }; } },
    { action: "edit_message", async make() { const { recipient, target } = await ownSlackMessage(); return { a: { ...slackTarget(recipient, target), text: "Rettet A" }, b: { ...slackTarget(recipient, target), text: "Rettet B" }, providerCalls: () => count(chain.slack, "edit"), replayDedupes: true }; } },
    { action: "add_reaction", async make() { const { recipient, target } = await ownSlackMessage(); return { a: { ...slackTarget(recipient, target), reaction: "thumbsup" }, b: { ...slackTarget(recipient, target), reaction: "heart" }, providerCalls: () => count(chain.slack, "react"), replayDedupes: true }; } },
    { action: "delete_message", async make() { const one = await ownSlackMessage(); const two = await ownSlackMessage(); return { a: slackTarget(one.recipient, one.target), b: slackTarget(two.recipient, two.target), providerCalls: () => count(chain.slack, "delete"), replayDedupes: false }; } }
  ];

  for (const c of CASES) {
    it(`${c.action}: (K, A) utføres, (K, A) igjen er gjenspilling, (K, B) er \`idempotency_key_collision\` UTEN leverandørkall og uten ny journalrad`, async () => {
      const made = await c.make();
      const k = chain.key(`am5-${c.action}`);
      const before = made.providerCalls();
      const first = await chain.act(c.action, made.a, k);
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true, deduplicated: false });
      expect(made.providerCalls()).toBe(before + 1);
      const rows = await journalRows(c.action);
      const replay = await chain.act(c.action, made.a, k);
      if (made.replayDedupes) expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true, deduplicated: true });
      expect(made.providerCalls(), "gjenspillingen skal ikke gi nytt leverandørkall").toBe(before + 1);
      const collision = await chain.act(c.action, made.b, k);
      expect(collision, JSON.stringify(collision)).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_collision" });
      expect(made.providerCalls(), "kollisjonen skal ikke gi leverandørkall").toBe(before + 1);
      expect(await journalRows(c.action), "kollisjonen skal ikke skrive journalrader").toBe(rows);
    });
  }

  it("journalens request_id er fortsatt EXACT den skopede nøkkelen `<handling>:<tenant-merke>:<nøkkel>` (ingen nyttelast-del for journalførte handlinger)", async () => {
    const k = chain.key("rid");
    const n = chain.phone();
    expect(ok(await chain.act("send", { channel: "sms", account_ref: SMS_ACCOUNT, recipient: n, purpose: "transactional", text: "Hei, timen din er bekreftet.", ...BASIS }, k)).deduplicated).toBe(false);
    const row = (await chain.db.admin.query("SELECT request_id FROM comms_outbound_log WHERE tenant_id = $1 AND request_id LIKE $2", [TENANT_A, `send:%:${k}`])).rows as Array<{ request_id: string }>;
    expect(row).toHaveLength(1);
    expect(row[0]!.request_id).toMatch(new RegExp(`^send:[0-9a-f]{8}:${k}$`));
    const ledger = (await chain.db.admin.query("SELECT idempotency_key FROM tool_executions WHERE tenant_id = $1 AND idempotency_key = $2", [TENANT_A, row[0]!.request_id])).rows;
    expect(ledger).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------- D: nøkkellengde (K4)
describe("D: nøkkellengde - 159/160 virker uavkortet, 161 gir `idempotency_key_too_long` (aldri avkortet, aldri den misvisende `idempotency_key_required`)", () => {
  const ofLength = (prefix: string, length: number) => `${chain.key(prefix)}-`.padEnd(length, "z").slice(0, length);
  const sendP = () => ({ channel: "sms", account_ref: SMS_ACCOUNT, recipient: chain.phone(), purpose: "transactional", text: "Hei, timen din er bekreftet.", ...BASIS });
  const optOutP = () => ({ channel: "sms", recipient: chain.phone() });

  it("ikke-journalført (`record_opt_out`): 159 og 160 tegn virker og ledger-nøkkelen ender med HELE brukernøkkelen; 161 gir `idempotency_key_too_long` uten ledgerrad", async () => {
    for (const length of [159, 160]) {
      const k = ofLength("len-oo", length);
      expect(k).toHaveLength(length);
      expect(await chain.act("record_opt_out", optOutP(), k), `${length} tegn`).toMatchObject({ ok: true, deduplicated: false });
      const rows = (await chain.db.admin.query("SELECT idempotency_key FROM tool_executions WHERE tenant_id = $1 AND tool_id = 'comms' AND action = 'record_opt_out' AND right(idempotency_key, $2) = $3", [TENANT_A, length, k])).rows as Array<{ idempotency_key: string }>;
      expect(rows, `${length} tegn: nøkkelen skal være lagret uavkortet`).toHaveLength(1);
      expect(rows[0]!.idempotency_key.startsWith("record_opt_out:")).toBe(true);
    }
    const tooLong = ofLength("len-oo", 161);
    expect(await chain.act("record_opt_out", optOutP(), tooLong)).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_too_long" });
    expect(await scalar("SELECT count(*)::int AS n FROM tool_executions WHERE tenant_id = $1 AND idempotency_key LIKE $2", [TENANT_A, `%${tooLong.slice(0, 161)}`])).toBe(0);
    // også en svært lang nøkkel (tidligere: ledger-/indeksfeil dypt nede) gir den tydelige feilen
    expect(await chain.act("record_opt_out", optOutP(), "k".repeat(5000))).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_too_long" });
  });

  it("journalført (`send`): 159 og 160 tegn virker (journalens request_id <= 200), 161 og 201 gir `idempotency_key_too_long` uten journalrad og uten leverandørkall", async () => {
    for (const length of [159, 160]) {
      const k = ofLength("len-send", length);
      const before = count(chain.twilio, "send");
      expect(await chain.act("send", sendP(), k), `${length} tegn`).toMatchObject({ ok: true, deduplicated: false });
      expect(count(chain.twilio, "send")).toBe(before + 1);
      const rows = (await chain.db.admin.query("SELECT request_id FROM comms_outbound_log WHERE tenant_id = $1 AND right(request_id, $2) = $3", [TENANT_A, length, k])).rows as Array<{ request_id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.request_id.length).toBeLessThanOrEqual(200);
      expect(rows[0]!.request_id.endsWith(k)).toBe(true);
    }
    const journalBefore = await scalar("SELECT count(*)::int AS n FROM comms_outbound_log WHERE tenant_id = $1", [TENANT_A]);
    const sendsBefore = count(chain.twilio, "send");
    for (const length of [161, 200, 201]) expect(await chain.act("send", sendP(), ofLength("len-send", length)), `${length} tegn`).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_too_long" });
    expect(await scalar("SELECT count(*)::int AS n FROM comms_outbound_log WHERE tenant_id = $1", [TENANT_A])).toBe(journalBefore);
    expect(count(chain.twilio, "send")).toBe(sendsBefore);
  });

  it("en OPPGITT, ugyldig nøkkel til en handling der nøkkelen er valgfri gir `idempotency_key_invalid` uten ledgerrad og uten effekt (tom streng ga før en stille `deduplicated`, NUL en ubehandlet databasefeil; reviewer A funn 1, B F2); ingen nøkkel virker som før", async () => {
    const before = await scalar("SELECT count(*)::int AS n FROM tool_executions WHERE tenant_id = $1 AND tool_id = 'comms' AND action = 'record_opt_out'", [TENANT_A]);
    const n = chain.phone();
    for (const bad of ["", "   ", "abc", "nul\u0000-nul-nul", "abc\ud800defgh", "med mellomrom i seg", "\u00e6".repeat(100)]) {
      expect(await chain.act("record_opt_out", { channel: "sms", recipient: n }, bad), JSON.stringify(bad)).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_invalid" });
    }
    expect(await scalar("SELECT count(*)::int AS n FROM tool_executions WHERE tenant_id = $1 AND tool_id = 'comms' AND action = 'record_opt_out'", [TENANT_A])).toBe(before);
    expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", n))).toBe(false);
    // uten nøkkel: ingen idempotens, uendret
    expect(await chain.act("record_opt_out", { channel: "sms", recipient: n })).toMatchObject({ ok: true, deduplicated: false });
    expect(await chain.store.isOptedOut(TENANT_A, optOutHash(TENANT_A, "sms", n))).toBe(true);
  });

  it("manglende eller for kort nøkkel er fortsatt `idempotency_key_required` (kun lengde over 160 har egen kode)", async () => {
    expect(await chain.act("send", sendP())).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_required" });
    expect(await chain.act("send", sendP(), "x".repeat(7))).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_required" });
    expect(await chain.act("send", sendP(), "har mellomrom i seg")).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_required" });
    expect(await chain.act("send", sendP(), "x".repeat(8))).toMatchObject({ ok: true });
  });
});
