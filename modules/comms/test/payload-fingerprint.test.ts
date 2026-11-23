import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import {
  COMMS_ADMIN_ACTIONS, COMMS_CONTACT_READ_ACTIONS, COMMS_CONTACT_WRITE_ACTIONS, COMMS_IDEMPOTENCY_KEY_MAX_LENGTH, COMMS_JOURNALLED_ACTIONS, COMMS_KNOWN_ACTIONS, COMMS_MEETING_READ_ACTIONS, COMMS_MEETING_WRITE_ACTIONS,
  COMMS_OUTBOUND_ACTIONS, COMMS_READ_ACTIONS, COMMS_VENDOR_READ_ACTIONS, PAYLOAD_FINGERPRINT_LENGTH, canonicalPayloadJson, commsToolDefinitions, executeCommsOwnerAction, ownerPayloadFingerprint, scopedIdempotencyKey,
  type OutboundFunnel, type ReplayState
} from "../src/index.ts";

/**
 * WP-G1b (JARVIS-112 a + e): REN logikk uten database - kanonisk nyttelast, avtrykkets form, nøkkelbudsjettet, partisjonen journalført/ikke-journalført og hva eier-handlingslaget gir ToolGateway. Den ekte atferden mot Postgres-ledgeren
 * (effekt, gjenspilling, kollisjon) er bevist i `payload-binding.test.ts`; her er det de deterministiske egenskapene som ikke trenger en database - og som mutasjonstestene feller raskt.
 */
const TENANT = "tenant-g1b-pure";
const owner = (space: string = "business", tenant: string = TENANT): IdentityContext => ({ person_id: "person-g1b", tenant_id: tenant, memory_space_id: space as IdentityContext["memory_space_id"], session_id: "sess-g1b", device_id: "dev-g1b", channel: "api", auth_strength: "signed" });
const tag = (tenant: string) => createHash("sha256").update(tenant, "utf8").digest("hex").slice(0, 8);
/** ORAKEL: den skopede nøkkelen slik main-koden (A-N2) bygget den. Brukes til å bevise at journalførte handlinger er uendret. */
const legacyScoped = (tenant: string, action: string, key: string) => `${action}:${tag(tenant)}:${key}`;
const FP = new RegExp(`^[0-9a-f]{${PAYLOAD_FINGERPRINT_LENGTH}}$`);

interface GatewayRequest { identity: IdentityContext; tool_id: string; action: string; parameters: Record<string, JsonValue>; idempotency_key?: string }
function recorder(result: unknown = { ok: true, data: null, output_trust: "internal", deduplicated: false }) {
  const requests: GatewayRequest[] = [];
  const gateway = {
    get: (tool: string, action: string) => (tool === "comms" && COMMS_KNOWN_ACTIONS.includes(action) ? { tool_id: tool, action } : undefined),
    execute: async (req: GatewayRequest) => { requests.push(req); return result; }
  };
  const funnelCalls: string[] = [];
  let replay: ReplayState = "none";
  const funnel = {
    replayState: async () => { funnelCalls.push("replayState"); return replay; },
    evaluate: async () => { funnelCalls.push("evaluate"); return { parsed: { request_id: "x" }, decision: { allowed: true, denial_codes: [], rules: [] } }; },
    recordDenial: async () => { funnelCalls.push("recordDenial"); return "clog_denied_1"; },
    summarize: () => ({ rules: [] })
  } as unknown as OutboundFunnel;
  return { requests, funnelCalls, setReplay: (state: ReplayState) => { replay = state; }, deps: { gateway: gateway as never, funnel, ownerGate: () => true } };
}
type Recorder = ReturnType<typeof recorder>;
const run = (r: Recorder, action: string, parameters: Record<string, JsonValue>, key?: string, identity: IdentityContext = owner()) =>
  executeCommsOwnerAction(r.deps, identity, { action, parameters, ...(key !== undefined ? { idempotency_key: key } : {}) });

// GYLDIGE eksempler (verifisert mot verktøyskjemaene under): ett per handling.
const SAMPLES: Readonly<Record<string, Record<string, JsonValue>>> = {
  send: { channel: "sms", account_ref: "+4791000000", recipient: "+4790001111", purpose: "transactional", text: "Hei, timen din er bekreftet." },
  start_call: { channel: "phone", account_ref: "+4791000000", recipient: "+4790001111", purpose: "transactional", text: "Hei, jeg ringer om timen." },
  edit_message: { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: "1731800000.000100", text: "Rettet tekst" },
  delete_message: { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: "1731800000.000100" },
  add_reaction: { channel: "slack", account_ref: "T0AAAAAAAA", recipient: "C0AAAAAAAA", target_message_id: "1731800000.000100", reaction: "thumbsup" },
  authorize_account: { channel: "sms", account_ref: "+4791000000", provider: "twilio" },
  revoke_account: { account_id: "acct-12345678" },
  record_opt_out: { channel: "sms", recipient: "+4790000001" },
  list_inbound: {}, list_outbound: {}, list_opt_outs: {}, list_accounts: {},
  read_thread: { channel: "slack", account_ref: "T0AAAAAAAA", channel_id: "C012AB3CD45", thread_ts: "1700000000.000100" },
  list_users: { channel: "slack", account_ref: "T0AAAAAAAA" },
  get_message: { channel: "discord", account_ref: "123456789012345678", channel_id: "123456789012345678", message_id: "123456789012345678" },
  list_templates: { channel: "whatsapp", account_ref: "109876543210", waba_id: "123456789" },
  read_message: { channel: "sms", account_ref: "+4791000000", message_sid: `SM${"0".repeat(32)}` },
  contacts_list: {}, contacts_search: { query: "Ola" }, contacts_get: { resource_name: "people/c1" },
  contacts_create: { given_name: "Ola" }, contacts_update: { resource_name: "people/c1", etag: "etag-1", given_name: "Ola" }, contacts_delete: { resource_name: "people/c1" }, contacts_sync: {}, contacts_unlink: { resource_name: "people/c1" },
  meeting_list: {}, meeting_commitments: {}, meeting_get: { meeting_id: "meet-12345678" },
  meeting_ingest_text: { format: "txt", text: "Hei", attest_legal_basis: true }, meeting_decide_commitment: { commitment_id: "mcom-12345678", decision: "accept" },
  meeting_confirm_participant: { meeting_id: "meet-12345678", participant_ref: "p1", identity_id: "conv-id-12345678" }, meeting_delete: { meeting_id: "meet-12345678" }
};
/** En ANNEN, fortsatt gyldig nyttelast for hver journalført handling (til K2: ulik nyttelast skal ikke endre nøkkelen). */
const ALTERNATIVE: Readonly<Record<string, Record<string, JsonValue>>> = {
  send: { text: "En helt annen melding." }, start_call: { text: "Et helt annet manus." }, edit_message: { text: "En annen rettelse" }, delete_message: { target_message_id: "1731800000.000200" }, add_reaction: { reaction: "heart" }
};
const REQUIRED_KEY_ACTIONS: readonly string[] = [...COMMS_JOURNALLED_ACTIONS, "contacts_create", "contacts_update", "contacts_delete", "meeting_delete"];
const NON_JOURNALLED = COMMS_KNOWN_ACTIONS.filter((a) => !COMMS_JOURNALLED_ACTIONS.includes(a));
const sample = (action: string): Record<string, JsonValue> => SAMPLES[action]!;
const keyOfLength = (n: number) => "k".repeat(n);

// ---------------------------------------------------------------------------------------------- K3: kanonisk nyttelast
describe("K3: canonicalPayloadJson - deterministisk, nøkkelrekkefølge-uavhengig og uten kollisjoner mellom typer", () => {
  it("fast utseende (frosset: avtrykket er lagret i ledger-nøkler): sorterte nøkler på alle nivåer, ingen blanke, arrayer i opprinnelig rekkefølge", () => {
    expect(() => canonicalPayloadJson({ b: [1, { d: null, c: "x" }], a: true }), "gyldig JSON skal aldri kaste").not.toThrow();
    expect(canonicalPayloadJson({ b: [1, { d: null, c: "x" }], a: true })).toBe('{"a":true,"b":[1,{"c":"x","d":null}]}');
    expect(canonicalPayloadJson({})).toBe("{}");
    expect(canonicalPayloadJson([])).toBe("[]");
    expect(() => canonicalPayloadJson(null)).not.toThrow();
    expect(canonicalPayloadJson(null)).toBe("null");
    expect(canonicalPayloadJson({ z: 1, a: { y: 2, b: [3, 2, 1] } })).toBe('{"a":{"b":[3,2,1],"y":2},"z":1}');
    expect(canonicalPayloadJson("a\"b\\c\n")).toBe('"a\\"b\\\\c\\n"');
    expect(canonicalPayloadJson({ "a:b": 1, 'q"k': 2 })).toBe('{"a:b":1,"q\\"k":2}');
  });

  it("`{a:1,b:2}` og `{b:2,a:1}` gir SAMME avtrykk og samme tekst - også nøstet og i arrayer av objekter", () => {
    expect(canonicalPayloadJson({ a: 1, b: 2 })).toBe(canonicalPayloadJson({ b: 2, a: 1 }));
    expect(ownerPayloadFingerprint("business", { a: 1, b: 2 })).toBe(ownerPayloadFingerprint("business", { b: 2, a: 1 }));
    const x = { outer: { p: 1, q: { r: [{ s: 1, t: 2 }, { u: 3, v: 4 }], w: "w" } }, top: true };
    const y = { top: true, outer: { q: { w: "w", r: [{ t: 2, s: 1 }, { v: 4, u: 3 }] }, p: 1 } };
    expect(canonicalPayloadJson(x)).toBe(canonicalPayloadJson(y));
    expect(ownerPayloadFingerprint("business", x)).toBe(ownerPayloadFingerprint("business", y));
  });

  it("rekkefølgen i en array ER nyttelast: `[1,2]` er ikke `[2,1]`", () => {
    expect(canonicalPayloadJson([1, 2])).not.toBe(canonicalPayloadJson([2, 1]));
    expect(ownerPayloadFingerprint("business", { list: ["a", "b"] })).not.toBe(ownerPayloadFingerprint("business", { list: ["b", "a"] }));
  });

  it("tall/strenger/null/tomme verdier kolliderer aldri: `1` mot `\"1\"`, `null` mot fraværende, `[]` mot `{}`, `true` mot `\"true\"` m.fl. - både i teksten og i avtrykket", () => {
    const corpus: JsonValue[] = [
      1, "1", 0, "0", false, "false", true, "true", null, "null", "", [], {}, [[]], [{}], [null], { a: null }, { a: [] }, { a: {} }, { a: "" }, { a: 0 }, { a: false }, { a: "null" }, { a: 1 }, { a: "1" },
      [1], ["1"], [1, 2], [12], ["1", "2"], ["12"], { a: 1, b: 2 }, { a: 1, b: "2" }, { a: "1,b:2" }, 1.5, "1.5", -1, "-1", " ", "\n", "é", "é", "\ud800", "�"
    ];
    const texts = corpus.map((v) => canonicalPayloadJson(v));
    expect(new Set(texts).size).toBe(corpus.length);
    const prints = corpus.map((v) => ownerPayloadFingerprint("business", { v }));
    expect(new Set(prints).size).toBe(corpus.length);
    // `null` er IKKE en fraværende nøkkel
    expect(ownerPayloadFingerprint("business", { a: 1, b: null })).not.toBe(ownerPayloadFingerprint("business", { a: 1 }));
    expect(canonicalPayloadJson({ a: 1, b: null })).not.toBe(canonicalPayloadJson({ a: 1 }));
  });

  it("`undefined` som objektverdi er fraværende (som i JSON); `-0` er `0`", () => {
    expect(() => canonicalPayloadJson({ a: 1, b: undefined })).not.toThrow();
    expect(canonicalPayloadJson({ a: 1, b: undefined })).toBe(canonicalPayloadJson({ a: 1 }));
    expect(canonicalPayloadJson({ b: undefined })).toBe("{}");
    expect(canonicalPayloadJson(-0)).toBe(canonicalPayloadJson(0));
    expect(canonicalPayloadJson(1e21)).toBe("1e+21");
    expect(canonicalPayloadJson(0.1 + 0.2)).toBe("0.30000000000000004");
  });

  it("alt som ikke er JSON KASTER (aldri en stille omskriving til `null` som kunne latt to nyttelaster dele avtrykk)", () => {
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    class Thing { readonly x = 1; }
    const bad: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, [undefined], { a: [undefined] }, () => 1, Symbol("s"), 10n, new Date(0), new Map(), new Set(), new Thing(), sparse, { a: Number.NaN }, /x/];
    for (const value of bad) expect(() => canonicalPayloadJson(value), String(typeof value)).toThrow();
    expect(() => ownerPayloadFingerprint("business", { a: Number.NaN })).toThrow("canonical_payload_non_finite_number");
    expect(() => canonicalPayloadJson(undefined)).toThrow("canonical_payload_unsupported_type:undefined");
    expect(() => canonicalPayloadJson(10n)).toThrow("canonical_payload_unsupported_type:bigint");
    expect(() => canonicalPayloadJson(new Date(0))).toThrow("canonical_payload_not_plain_object");
    expect(() => canonicalPayloadJson(Number.POSITIVE_INFINITY)).toThrow("canonical_payload_non_finite_number");
  });

  it("nesting: 16 nivåer er greit, 17 kaster `canonical_payload_too_deep`; en syklisk struktur gir samme feil (aldri stakkoverflyt)", () => {
    const nest = (levels: number): JsonValue => { let v: JsonValue = "løv"; for (let i = 0; i < levels; i += 1) v = [v]; return v; };
    expect(() => canonicalPayloadJson(nest(16)), "16 nivåer skal være greit").not.toThrow();
    expect(canonicalPayloadJson(nest(16))).toBe(`${"[".repeat(16)}"løv"${"]".repeat(16)}`);
    expect(() => canonicalPayloadJson(nest(17))).toThrow("canonical_payload_too_deep");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => canonicalPayloadJson(cyclic)).toThrow("canonical_payload_too_deep");
    const objNest = (levels: number): Record<string, JsonValue> => { let v: Record<string, JsonValue> = { leaf: 1 }; for (let i = 0; i < levels; i += 1) v = { k: v }; return v; };
    expect(() => canonicalPayloadJson(objNest(15))).not.toThrow();
    expect(() => canonicalPayloadJson(objNest(16))).toThrow("canonical_payload_too_deep");
  });

  it("nøkler med skilletegn, tom nøkkel og `__proto__` (egen egenskap fra JSON.parse) holdes adskilt og påvirker ikke prototypen", () => {
    const proto = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as Record<string, JsonValue>;
    expect(canonicalPayloadJson(proto)).toBe('{"__proto__":{"polluted":true},"a":1}');
    expect(canonicalPayloadJson({ "": 1 })).toBe('{"":1}');
    expect(canonicalPayloadJson({ "a,b": 1 })).not.toBe(canonicalPayloadJson({ a: 1, b: 1 }));
    expect(canonicalPayloadJson({ "a\":1,\"b": 1 })).not.toBe(canonicalPayloadJson({ a: 1, b: 1 }));
    expect(ownerPayloadFingerprint("business", proto)).not.toBe(ownerPayloadFingerprint("business", { a: 1 }));
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("EGENSKAP (3000 tilfeldige verdier, fast frø): lik tekst <=> dypt like verdier; teksten er gyldig JSON som gir verdien tilbake; blanding av nøkkelrekkefølge endrer ingenting", () => {
    let state = 0x9e3779b9;
    const rng = () => { state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
    const scalars: JsonValue[] = [null, true, false, 0, 1, 2, -1, 0.5, "", "0", "1", "a", "null", "true", "[]", "{}", "é"];
    const keys = ["a", "b", "c", "", "1"];
    const gen = (depth: number): JsonValue => {
      const roll = rng();
      if (depth >= 3 || roll < 0.45) return pick(scalars);
      if (roll < 0.7) return Array.from({ length: Math.floor(rng() * 4) }, () => gen(depth + 1));
      const o: Record<string, JsonValue> = {};
      for (let i = Math.floor(rng() * 4); i > 0; i -= 1) o[pick(keys)] = gen(depth + 1);
      return o;
    };
    const reorder = (v: JsonValue): JsonValue => {
      if (Array.isArray(v)) return v.map(reorder);
      if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)]));
      return v;
    };
    const seen = new Map<string, JsonValue>();
    let duplicates = 0;
    for (let i = 0; i < 3000; i += 1) {
      const v = gen(0);
      const text = canonicalPayloadJson(v);
      expect(isDeepStrictEqual(JSON.parse(text), v)).toBe(true);
      expect(canonicalPayloadJson(reorder(v))).toBe(text);
      const prior = seen.get(text);
      if (prior === undefined) seen.set(text, v);
      else { duplicates += 1; expect(isDeepStrictEqual(prior, v), `lik tekst ${text} for ulike verdier`).toBe(true); }
    }
    expect(duplicates).toBeGreaterThan(50); // småt alfabet: begge retninger er faktisk utprøvd
    expect(seen.size).toBeGreaterThan(500);
  });
});

// ---------------------------------------------------------------------------------------------- avtrykket
describe("ownerPayloadFingerprint - form, frosset oppskrift og hva som teller med", () => {
  it("er 32 små hex-tegn (128 bit); lengden og oppskriften er FROSSET (avtrykket ligger i ledger-nøkler: en endring ville brutt gjenspilling over en utrulling)", () => {
    expect(PAYLOAD_FINGERPRINT_LENGTH).toBe(32);
    const fp = ownerPayloadFingerprint("business", { channel: "sms", recipient: "+4790000001" });
    expect(fp).toMatch(FP);
    // oppskriften, uavhengig gjenskapt: SHA-256 over JSON-arrayen [versjon, rom, kanonisk nyttelast], de første 32 hex-tegnene
    const recipe = createHash("sha256").update(JSON.stringify(["comms-owner-payload-v1", "business", '{"channel":"sms","recipient":"+4790000001"}']), "utf8").digest("hex").slice(0, 32);
    expect(fp).toBe(recipe);
    // gullvektorer (beregnet uavhengig av koden med ren Node): en utilsiktet endring av oppskriften, rekkefølgen eller kuttet feller her
    expect(fp).toBe("fc287d9f0f634c9591d6a10398692317");
    expect(ownerPayloadFingerprint("project", { provider: "twilio", channel: "sms", account_ref: "+4791000000" })).toBe("f57b09473b286a980334da742881dce4");
    expect(ownerPayloadFingerprint("business", {})).toBe("847b2161697615e17171fe06933e6531");
  });

  it("memory space er med; request_id og idempotency_key (forespørselens identitet) er IKKE med; alle andre felt er det", () => {
    const base = { channel: "sms", recipient: "+4790000001" };
    const fp = ownerPayloadFingerprint("business", base);
    expect(ownerPayloadFingerprint("project", base)).not.toBe(fp);
    expect(ownerPayloadFingerprint("business", { ...base, request_id: "hvilken-som-helst-id-1" })).toBe(fp);
    expect(ownerPayloadFingerprint("business", { ...base, idempotency_key: "en-annen-nokkel-1" })).toBe(fp);
    expect(ownerPayloadFingerprint("business", { ...base, request_id: "a-aaaaaaaa", idempotency_key: "b-bbbbbbbb" })).toBe(fp);
    for (const extra of [{ source: "owner_recorded" }, { account_ref: "*" }, { Request_Id: "x" }, { requestId: "x" }, { idempotency_keys: "x" }, { "request_id ": "x" }]) {
      expect(ownerPayloadFingerprint("business", { ...base, ...extra }), JSON.stringify(extra)).not.toBe(fp);
    }
    expect(ownerPayloadFingerprint("business", { ...base, recipient: "+4790000002" })).not.toBe(fp);
    expect(ownerPayloadFingerprint("business", { ...base, channel: "whatsapp" })).not.toBe(fp);
    // kun nivå 1 av nøkkelfeltene hoppes over: et nøstet felt med samme navn er nyttelast
    expect(ownerPayloadFingerprint("business", { nested: { request_id: "x" } })).not.toBe(ownerPayloadFingerprint("business", { nested: {} }));
  });

  it("parametre som ikke er et vanlig objekt avvises (array og null ville ellers delt avtrykk med et objekt)", () => {
    for (const bad of [[], [1], null, "tekst", 5, undefined]) expect(() => ownerPayloadFingerprint("business", bad as never), String(bad)).toThrow("canonical_payload_parameters_not_an_object");
  });

  it("skillet mellom rom og nyttelast er entydig (rom `a` + nyttelast `b` er ikke rom `ab`...), og tenant/sesjon er ikke en del av avtrykket", () => {
    expect(ownerPayloadFingerprint("a", { x: 1 })).not.toBe(ownerPayloadFingerprint("a\u0000", { x: 1 }));
    expect(ownerPayloadFingerprint('b","{}', {})).not.toBe(ownerPayloadFingerprint("b", {}));
    expect(ownerPayloadFingerprint.length).toBe(2); // kun (rom, parametre): ingen skjult tilstand
  });
});

// ---------------------------------------------------------------------------------------------- nøkkelformen
describe("scopedIdempotencyKey - formen for journalførte (UENDRET) og ikke-journalførte handlinger", () => {
  it("uten avtrykk er formen EXACT som på main: `<handling>:<tenant-merke>:<nøkkel>`", () => {
    expect(scopedIdempotencyKey(TENANT, "send", "abc-12345")).toBe(legacyScoped(TENANT, "send", "abc-12345"));
    expect(scopedIdempotencyKey(TENANT, "send", "abc-12345")).toMatch(/^send:[0-9a-f]{8}:abc-12345$/);
    expect(scopedIdempotencyKey(TENANT, "send", "abc-12345")).toBe(`send:${tag(TENANT)}:abc-12345`);
  });

  it("med avtrykk er formen `<handling>:<tenant-merke>:<avtrykk>:<nøkkel>`; tenant-merket og avtrykket skiller", () => {
    const fp = ownerPayloadFingerprint("business", { channel: "sms", recipient: "+4790000001" });
    const key = scopedIdempotencyKey(TENANT, "record_opt_out", "abc-12345", fp);
    expect(key).toBe(`record_opt_out:${tag(TENANT)}:${fp}:abc-12345`);
    expect(key).toMatch(/^record_opt_out:[0-9a-f]{8}:[0-9a-f]{32}:abc-12345$/);
    expect(scopedIdempotencyKey("tenant-annen", "record_opt_out", "abc-12345", fp)).not.toBe(key);
    expect(scopedIdempotencyKey(TENANT, "authorize_account", "abc-12345", fp)).not.toBe(key);
    expect(scopedIdempotencyKey(TENANT, "record_opt_out", "abc-12346", fp)).not.toBe(key);
    expect(scopedIdempotencyKey(TENANT, "record_opt_out", "abc-12345", ownerPayloadFingerprint("business", { channel: "sms", recipient: "+4790000002" }))).not.toBe(key);
    expect(scopedIdempotencyKey(TENANT, "record_opt_out", "abc-12345", fp)).not.toBe(scopedIdempotencyKey(TENANT, "record_opt_out", "abc-12345"));
  });

  it("injektiv også med en nøkkel som selv ligner på `<avtrykk>:<rest>` (avtrykket har fast lengde, så skillet er entydig)", () => {
    const a = ownerPayloadFingerprint("business", { x: 1 });
    const b = ownerPayloadFingerprint("business", { x: 2 });
    const keys = new Set<string>();
    for (const [fp, k] of [[a, "nøkkel-1:ekstra"], [b, "nøkkel-1:ekstra"], [a, `${b}:nøkkel-1`], [b, `${a}:nøkkel-1`], [a, "nøkkel-1"], [b, "nøkkel-1"], [a, ""], [b, ""]] as const) keys.add(scopedIdempotencyKey(TENANT, "contacts_create", k, fp));
    expect(keys.size).toBe(8);
  });

  it("budsjettet: journalførte <= 197 (journalens request_id <= 200), ikke-journalførte <= 230 med en 160-tegns nøkkel; lengste handlingsnavn er 27 tegn", () => {
    const key = keyOfLength(COMMS_IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(COMMS_IDEMPOTENCY_KEY_MAX_LENGTH).toBe(160);
    expect(Math.max(...COMMS_KNOWN_ACTIONS.map((a) => a.length))).toBe(27);
    const fp = ownerPayloadFingerprint("business", {});
    for (const action of COMMS_JOURNALLED_ACTIONS) {
      const k = scopedIdempotencyKey(TENANT, action, key);
      expect(k.length, action).toBeLessThanOrEqual(197);
      expect(k, action).toMatch(/^[A-Za-z0-9._:-]{8,200}$/); // journalens request_id: CHECK 8-200 og RequestId-skjemaet
    }
    for (const action of NON_JOURNALLED) {
      const k = scopedIdempotencyKey(TENANT, action, key, fp);
      expect(k.length, action).toBeLessThanOrEqual(230);
      expect(k.endsWith(key), action).toBe(true);
    }
    expect(scopedIdempotencyKey(TENANT, "meeting_confirm_participant", key, fp)).toHaveLength(27 + 1 + 8 + 1 + PAYLOAD_FINGERPRINT_LENGTH + 1 + 160);
  });
});

// ---------------------------------------------------------------------------------------------- partisjonen og tabellen
describe("partisjonen journalført / ikke-journalført og tabelltest over ALLE handlinger (ingen handling med nøkkel glipper)", () => {
  it("de journalførte er NØYAKTIG send, start_call, edit_message, delete_message, add_reaction; resten av de kjente handlingene er ikke-journalført (27: 15 lesinger + 12 skrivinger)", () => {
    expect([...COMMS_JOURNALLED_ACTIONS].sort()).toEqual(["add_reaction", "delete_message", "edit_message", "send", "start_call"]);
    expect([...COMMS_JOURNALLED_ACTIONS].sort()).toEqual([...COMMS_OUTBOUND_ACTIONS, "start_call"].sort());
    expect(COMMS_KNOWN_ACTIONS).toHaveLength(32);
    expect(NON_JOURNALLED).toHaveLength(27);
    const writes = [...COMMS_ADMIN_ACTIONS, ...COMMS_CONTACT_WRITE_ACTIONS, ...COMMS_MEETING_WRITE_ACTIONS];
    const reads = [...COMMS_READ_ACTIONS, ...COMMS_VENDOR_READ_ACTIONS, ...COMMS_CONTACT_READ_ACTIONS, ...COMMS_MEETING_READ_ACTIONS];
    expect(writes).toHaveLength(12);
    expect(reads).toHaveLength(15);
    expect([...writes, ...reads].sort()).toEqual([...NON_JOURNALLED].sort());
    expect(new Set([...COMMS_JOURNALLED_ACTIONS, ...writes, ...reads]).size).toBe(32);
  });

  it("tabellen SAMPLES dekker nøyaktig de kjente handlingene, og hvert eksempel er GYLDIG mot verktøyskjemaet (så testene under bruker ekte nyttelaster)", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...COMMS_KNOWN_ACTIONS].sort());
    const defs = commsToolDefinitions({ transport: {} as never, store: {} as never, calls: true, vendorReads: true, contacts: true, meetings: true });
    for (const action of COMMS_KNOWN_ACTIONS) {
      const def = defs.find((d) => d.action === action);
      expect(def, action).toBeDefined();
      // journalførte handlinger får `request_id` av eier-handlingslaget; de øvrige har ingen slik parameter
      const params = COMMS_JOURNALLED_ACTIONS.includes(action) ? { ...sample(action), request_id: "journal-id-00000001" } : sample(action);
      const parsed = def!.input_schema.safeParse(params);
      expect(parsed.success, `${action}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });

  it("LÅS: ingen ikke-journalført handlings skjema godtar `request_id` eller `idempotency_key` som nyttelast (de to feltene er holdt utenfor avtrykket - et skjema som tok dem måtte få dem med)", () => {
    const defs = commsToolDefinitions({ transport: {} as never, store: {} as never, calls: true, vendorReads: true, contacts: true, meetings: true });
    for (const action of NON_JOURNALLED) {
      const def = defs.find((d) => d.action === action)!;
      for (const name of ["request_id", "idempotency_key"]) {
        expect(def.input_schema.safeParse({ ...sample(action), [name]: "journal-id-00000001" }).success, `${action} godtar ${name}`).toBe(false);
      }
    }
  });

  it("ALLE 27 ikke-journalførte handlinger: gatewayen får den skopede nøkkelen MED avtrykk (aldri uten), parametrene uendret (ingen request_id), og trakten/journalen røres ikke", async () => {
    for (const action of NON_JOURNALLED) {
      const r = recorder();
      const key = `tabell-${action}-0001`;
      expect(await run(r, action, sample(action), key), action).toMatchObject({ ok: true, deduplicated: false });
      expect(r.requests).toHaveLength(1);
      const req = r.requests[0]!;
      const expectedFp = ownerPayloadFingerprint("business", sample(action));
      expect(req.idempotency_key, action).toBe(scopedIdempotencyKey(TENANT, action, key, expectedFp));
      expect(req.idempotency_key, action).toMatch(new RegExp(`^${action}:[0-9a-f]{8}:[0-9a-f]{32}:${key}$`));
      expect(req.parameters, action).toEqual(sample(action));
      expect(Object.keys(req.parameters).includes("request_id"), action).toBe(false);
      expect(req).toMatchObject({ tool_id: "comms", action });
      expect(r.funnelCalls, `${action}: trakten skal ikke kalles for ikke-journalførte`).toEqual([]);
    }
  });

  it("ALLE 27: samme (nøkkel, nyttelast) gir samme gateway-nøkkel; ulik nyttelast, ulik nøkkel, annen tenant eller annet rom gir en ANNEN - og ingenting endrer seg ved ny nøkkelrekkefølge", async () => {
    for (const action of NON_JOURNALLED) {
      const keyFor = async (params: Record<string, JsonValue>, key = "tabell-nokkel-0001", identity: IdentityContext = owner()): Promise<string> => {
        const r = recorder();
        await run(r, action, params, key, identity);
        return r.requests[0]!.idempotency_key!;
      };
      const base = await keyFor(sample(action));
      expect(await keyFor({ ...sample(action) }), `${action}: gjenspilling`).toBe(base);
      expect(await keyFor(Object.fromEntries(Object.entries(sample(action)).reverse())), `${action}: nøkkelrekkefølge`).toBe(base);
      expect(await keyFor({ ...sample(action), ekstra_felt: 1 }), `${action}: ulik nyttelast (felt lagt til)`).not.toBe(base);
      expect(await keyFor({ ...sample(action), ekstra_felt: 2 }), `${action}: ulik nyttelast (verdi)`).not.toBe(await keyFor({ ...sample(action), ekstra_felt: 1 }));
      expect(await keyFor(sample(action), "tabell-nokkel-0002"), `${action}: annen nøkkel`).not.toBe(base);
      expect(await keyFor(sample(action), "tabell-nokkel-0001", owner("business", "tenant-annen")), `${action}: annen tenant`).not.toBe(base);
      expect(await keyFor(sample(action), "tabell-nokkel-0001", owner("project")), `${action}: annet rom`).not.toBe(base);
      // person/sesjon/enhet er IKKE del av forespørselen: en gjenspilling etter ny innlogging er samme forespørsel
      expect(await keyFor(sample(action), "tabell-nokkel-0001", { ...owner(), session_id: "ny-sesjon", device_id: "ny-enhet", person_id: "annen-person", channel: "web" }), `${action}: sesjon/enhet/person`).toBe(base);
    }
  });

  it("ULIKE verdier i hvert eneste felt gir ulikt avtrykk (hvert felt i hvert eksempel er bundet - ingen felt kan endres uten at nøkkelen endres)", async () => {
    for (const action of NON_JOURNALLED) {
      const base = ownerPayloadFingerprint("business", sample(action));
      for (const field of Object.keys(sample(action))) {
        const changed = { ...sample(action), [field]: `${JSON.stringify(sample(action)[field])}-endret` };
        expect(ownerPayloadFingerprint("business", changed), `${action}.${field}`).not.toBe(base);
        const without = Object.fromEntries(Object.entries(sample(action)).filter(([name]) => name !== field));
        expect(ownerPayloadFingerprint("business", without), `${action} uten ${field}`).not.toBe(base);
      }
    }
  });

  it("uten nøkkel: ingen `idempotency_key` til gatewayen for noen av de ikke-journalførte handlingene som ikke krever den (ingen dedupe å binde)", async () => {
    for (const action of NON_JOURNALLED.filter((a) => !REQUIRED_KEY_ACTIONS.includes(a))) {
      const r = recorder();
      expect(await run(r, action, sample(action)), action).toMatchObject({ ok: true });
      expect(Object.keys(r.requests[0]!), action).not.toContain("idempotency_key");
      expect(r.requests[0]!.parameters, action).toEqual(sample(action));
    }
  });

  it("ikke-JSON-nyttelast (NaN, syklisk, for dyp) gir `invalid_parameters` FØR gatewayen - en stille omskriving ville latt to nyttelaster dele nøkkel", async () => {
    const cyclic: Record<string, JsonValue> = {};
    (cyclic as Record<string, unknown>)["self"] = cyclic;
    for (const action of ["record_opt_out", "authorize_account", "contacts_create", "meeting_delete"]) {
      for (const bad of [{ ...sample(action), x: Number.NaN }, { ...sample(action), x: Number.POSITIVE_INFINITY }, cyclic, { ...sample(action), x: [undefined as never] }]) {
        const r = recorder();
        expect(await run(r, action, bad, "ugyldig-nyttelast-0001"), `${action}`).toEqual({ ok: false, status: "rejected", reason: "invalid_parameters" });
        expect(r.requests, action).toEqual([]);
      }
      // uten nøkkel er det ingen dedupe å binde: nyttelasten når gatewayen som før (skjemaet avviser den der). Handlinger som KREVER nøkkel avvises uten.
      const keyless = recorder();
      const result = await run(keyless, action, { ...sample(action), x: Number.NaN });
      if (REQUIRED_KEY_ACTIONS.includes(action)) expect(result).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_required" });
      else expect(keyless.requests, action).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------------------------- journalførte: uendret
describe("K2: de fem journalførte handlingene er UENDRET - nøkkelen er `<handling>:<tenant-merke>:<nøkkel>` uten avtrykk, request_id = nøkkelen, avvik avvises av journalen", () => {
  it("gateway-forespørselen er identisk med main: skopet nøkkel uten avtrykk, `request_id` = den skopede nøkkelen, nyttelasten ellers uendret", async () => {
    for (const action of COMMS_JOURNALLED_ACTIONS) {
      const r = recorder();
      const key = `journalfort-${action}-01`;
      await run(r, action, sample(action), key);
      const req = r.requests[0]!;
      const legacy = legacyScoped(TENANT, action, key);
      expect(req.idempotency_key, action).toBe(legacy);
      expect(req.parameters, action).toEqual({ ...sample(action), request_id: legacy });
      expect(req.idempotency_key!.length, action).toBeLessThanOrEqual(200);
      // ulik (men gyldig) nyttelast endrer IKKE nøkkelen: det er journalens fingeravtrykk som binder forespørselen, ikke nøkkelen
      const other = recorder();
      await run(other, action, { ...sample(action), ...ALTERNATIVE[action] }, key);
      expect(other.requests[0]?.idempotency_key, action).toBe(legacy);
      expect(other.requests[0]?.parameters["request_id"], action).toBe(legacy);
    }
  });

  it("journalens tilstand styrer: `collision` avvises FØR gatewayen, `replay` og `none` går videre; nyttelast-avtrykket er aldri i spill", async () => {
    for (const action of COMMS_JOURNALLED_ACTIONS) {
      const collision = recorder();
      collision.setReplay("collision");
      expect(await run(collision, action, sample(action), "journalfort-kollisjon-1"), action).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_collision" });
      expect(collision.requests, action).toEqual([]);
      expect(collision.funnelCalls, action).toEqual(["replayState"]);
      const replay = recorder();
      replay.setReplay("replay");
      expect(await run(replay, action, sample(action), "journalfort-replay-01"), action).toMatchObject({ ok: true });
      expect(replay.requests, action).toHaveLength(1);
      expect(replay.funnelCalls, action).toEqual(["replayState"]); // gjenspilling: ingen ny policyevaluering
      const fresh = recorder();
      expect(await run(fresh, action, sample(action), "journalfort-fersk-001"), action).toMatchObject({ ok: true });
      expect(fresh.funnelCalls, action).toEqual(action === "send" || action === "start_call" ? ["replayState", "evaluate"] : ["replayState"]);
    }
  });

  it("en innsendt request_id som avviker fra brukerens nøkkel avvises; lik verdi er OK (uendret)", async () => {
    const r = recorder();
    expect(await run(r, "send", { ...sample("send"), request_id: "annen-id-00000001" }, "journalfort-rid-001")).toEqual({ ok: false, status: "rejected", reason: "comms_request_id_mismatch" });
    expect(r.requests).toEqual([]);
    expect(await run(r, "send", { ...sample("send"), request_id: "journalfort-rid-001" }, "journalfort-rid-001")).toMatchObject({ ok: true });
    expect(r.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------- K4: nøkkellengde
describe("K4: nøkkellengde - 159/160 virker, 161 og over gir `idempotency_key_too_long` for HVER handling; manglende/for kort er fortsatt `idempotency_key_required`", () => {
  it("159 og 160 tegn når gatewayen UAVKORTET for alle 32 handlinger; 161, 200, 201 og 5000 avvises med `idempotency_key_too_long` uten at gateway eller trakt røres", async () => {
    for (const action of COMMS_KNOWN_ACTIONS) {
      for (const length of [159, 160]) {
        const r = recorder();
        const key = keyOfLength(length);
        expect(await run(r, action, sample(action), key), `${action} ${length}`).toMatchObject({ ok: true });
        expect(r.requests, `${action} ${length}`).toHaveLength(1);
        expect(r.requests[0]!.idempotency_key!.endsWith(`:${key}`), `${action} ${length}: nøkkelen er avkortet`).toBe(true);
        expect(r.requests[0]!.idempotency_key!.length, `${action} ${length}`).toBeGreaterThan(length);
      }
      for (const length of [161, 162, 200, 201, 5000]) {
        const r = recorder();
        expect(await run(r, action, sample(action), keyOfLength(length)), `${action} ${length}`).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_too_long" });
        expect(r.requests, `${action} ${length}`).toEqual([]);
        expect(r.funnelCalls, `${action} ${length}`).toEqual([]);
      }
    }
  });

  it("lengden sjekkes FØRST: en 161-tegns nøkkel med ugyldige tegn er likevel `too_long` (ikke `required`), og en gyldig kort nøkkel er uberørt", async () => {
    const r = recorder();
    expect(await run(r, "send", sample("send"), `${"a b ".repeat(41)}`)).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_too_long" });
    expect(await run(r, "contacts_create", sample("contacts_create"), `æ${"x".repeat(160)}`)).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_too_long" });
    expect(await run(r, "record_opt_out", sample("record_opt_out"), "ø".repeat(161))).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_too_long" });
    expect(r.requests).toEqual([]);
  });

  it("manglende nøkkel, for kort (7 tegn) eller ugyldig tegnsett er `idempotency_key_required` for handlinger som krever nøkkel; 8 tegn er nok", async () => {
    for (const action of REQUIRED_KEY_ACTIONS) {
      for (const bad of [undefined, "", "x".repeat(7), "har mellomrom i seg", "ok-ok-ok\nnewline", "æøå-æøå-æøå"]) {
        const r = recorder();
        expect(await run(r, action, sample(action), bad), `${action}:${String(bad)}`).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_required" });
        expect(r.requests, action).toEqual([]);
      }
      const r = recorder();
      expect(await run(r, action, sample(action), "x".repeat(8)), action).toMatchObject({ ok: true });
    }
  });

  it("handlinger der nøkkelen er VALGFRI godtar fortsatt hvilken som helst kort nøkkel (uendret for allerede-gyldige kall), men aldri en over 160 tegn", async () => {
    for (const action of NON_JOURNALLED.filter((a) => !REQUIRED_KEY_ACTIONS.includes(a))) {
      for (const key of ["a", "kort", "", "med mellomrom", "x".repeat(160)]) {
        const r = recorder();
        expect(await run(r, action, sample(action), key), `${action}:${key}`).toMatchObject({ ok: true });
        expect(r.requests, `${action}:${key}`).toHaveLength(1);
        expect(r.requests[0]!.idempotency_key!.endsWith(`:${key}`), `${action}:${key}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------- K6 h: differensial
describe("K6 h: differensial mot main - allerede-gyldige kall endrer seg IKKE (unntatt nøkkelens nye ledd for ikke-journalførte)", () => {
  const validKeys = ["abcdefgh", "min-nokkel-12345", "a.b_c:d-e-f-g-h", "N".repeat(40), "z".repeat(160), "0123456789:0123456789"];

  it("journalførte handlinger: forespørselen til gatewayen er byte-for-byte som på main for alle gyldige nøkler", async () => {
    for (const action of COMMS_JOURNALLED_ACTIONS) {
      for (const key of validKeys) {
        const r = recorder();
        const result = await run(r, action, sample(action), key);
        expect(result, action).toMatchObject({ ok: true, deduplicated: false });
        const legacy = legacyScoped(TENANT, action, key);
        expect(r.requests, `${action}:${key}`).toEqual([{ identity: owner(), tool_id: "comms", action, parameters: { ...sample(action), request_id: legacy }, idempotency_key: legacy }]);
      }
    }
  });

  it("alle ikke-journalførte handlinger MED nøkkel: som på main, bortsett fra at avtrykket er satt inn rett etter tenant-merket (fjernes det, er nøkkelen den fra main)", async () => {
    for (const action of NON_JOURNALLED) {
      for (const key of validKeys) {
        const r = recorder();
        await run(r, action, sample(action), key);
        const req = r.requests[0]!;
        const fp = ownerPayloadFingerprint("business", sample(action));
        expect(req.idempotency_key!.replace(`:${fp}:`, ":"), `${action}:${key}`).toBe(legacyScoped(TENANT, action, key));
        expect({ ...req, idempotency_key: undefined }, `${action}:${key}`).toEqual({ identity: owner(), tool_id: "comms", action, parameters: sample(action), idempotency_key: undefined });
      }
    }
  });

  it("uten nøkkel (alle handlinger som ikke krever den): forespørselen er identisk med main - ingen `idempotency_key`, ingen `request_id`", async () => {
    for (const action of NON_JOURNALLED.filter((a) => !REQUIRED_KEY_ACTIONS.includes(a))) {
      const r = recorder();
      await run(r, action, sample(action));
      expect(r.requests, action).toEqual([{ identity: owner(), tool_id: "comms", action, parameters: sample(action) }]);
    }
  });

  it("resultatet fra gatewayen sendes uendret videre (ok/deduplicated/external_id/data/output_trust, og feil kortes til 120 tegn)", async () => {
    const okResult = { ok: true, external_id: "ext-1", data: { a: 1 }, output_trust: "untrusted", deduplicated: true };
    const r = recorder(okResult);
    expect(await run(r, "record_opt_out", sample("record_opt_out"), "differensial-0001")).toEqual({ ok: true, external_id: "ext-1", data: { a: 1 }, output_trust: "untrusted", deduplicated: true });
    const failing = recorder({ ok: false, reason: "r".repeat(300) });
    expect(await run(failing, "record_opt_out", sample("record_opt_out"), "differensial-0002")).toEqual({ ok: false, status: "failed", reason: "r".repeat(120) });
  });

  it("avvisningene FØR gatewayen er uendret: ikke-eier, ugyldig rom og ukjent handling (også med en for lang nøkkel er det eier-/rom-/handlingsfeilen som vinner)", async () => {
    const deny = recorder();
    const denied = { ...deny.deps, ownerGate: () => false };
    expect(await executeCommsOwnerAction(denied, owner(), { action: "record_opt_out", parameters: sample("record_opt_out"), idempotency_key: keyOfLength(500) })).toEqual({ ok: false, status: "rejected", reason: "owner_required" });
    const r = recorder();
    expect(await run(r, "record_opt_out", sample("record_opt_out"), keyOfLength(500), owner("health"))).toEqual({ ok: false, status: "rejected", reason: "comms_space_not_allowed" });
    expect(await run(r, "nope", {}, keyOfLength(500))).toEqual({ ok: false, status: "rejected", reason: "comms_unknown_action" });
    expect(r.requests).toEqual([]);
  });
});
