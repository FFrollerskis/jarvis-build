import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withMemoryTransaction } from "@jarvis/memory";
import type { JsonValue } from "@jarvis/contracts";
import {
  PEPPER_MIN_LENGTH, KEY_UNAVAILABLE, createContentHasher, legacyRequestFingerprint, parseSendParams, previewCommsSend, recipientHash, requestFingerprint, scopedIdempotencyKey, sha256Hex
} from "../src/index.ts";
import { OWNER, TENANT_A, TEST_PEPPER } from "./support/harness.ts";
import { authorizeAll, startChain, type Chain } from "./support/chain.ts";

/**
 * WP-G1c K1 (JARVIS-112 b): SALTET innholds-hash. Journalen lagrer aldri meldingsteksten - bare en hash, og den var en usaltet SHA-256 (ordbok-gjettbar for korte meldinger). Nå: HMAC-SHA256 med en server-side pepper fra den eksisterende hemmelighetskjeden
 * (formålsskilte nøkler), `content_hash_version` = 2 på nye rader (1 = gamle usaltede), gamle rader gjenkjennes fortsatt (overgang), og mangler pepperen feiler ALL utsendelse LUKKET - aldri en stille standardverdi, aldri verdien i noe svar eller noen rad.
 */
let pepper: string | null = TEST_PEPPER;
let chain: Chain;
const SMS = "+4791000000";
const BASIS = { purpose_basis: "existing_customer_relationship" } as const;
const TEXT = "Hei!";
const sendP = (recipient: string, text = TEXT): Record<string, JsonValue> => ({ channel: "sms", account_ref: SMS, recipient, purpose: "transactional", text, ...BASIS });
const finalText = (text: string): string => `${text}\n\n${chain.config.ai_disclosure_text}`;
const sends = (): number => chain.twilio.calls.filter((c) => c.op === "send").length;
/** Uavhengig gjenskaping av oppskriften (ikke koden under test): nøkkel per formål = HMAC(pepper, "jarvis-comms-pepper-v1|<formål>"), hash = HMAC(formålsnøkkel, data). */
const recipe = (key: string, purpose: string, data: string): string => createHmac("sha256", createHmac("sha256", key).update(`jarvis-comms-pepper-v1|${purpose}`, "utf8").digest()).update(data, "utf8").digest("hex");
const journalRow = async (requestId: string) => (await chain.db.admin.query("SELECT content_sha256, content_hash_version, before_state, status, content_length FROM comms_outbound_log WHERE tenant_id = $1 AND request_id = $2 ORDER BY created_at DESC LIMIT 1", [TENANT_A, requestId])).rows[0] as
  { content_sha256: string | null; content_hash_version: number; before_state: { v?: number; request_fingerprint?: string } | null; status: string; content_length: number } | undefined;

beforeAll(async () => {
  chain = await startChain("g1c1", {}, { pepper: () => pepper, lenientToolLimits: true });
  await authorizeAll(chain, [["sms", SMS, "twilio"]]);
}, 240_000);
afterAll(async () => { await chain?.stop(); }, 120_000);

describe("createContentHasher: HMAC med formålsskilte nøkler; ingen pepper eller en for kort pepper gir INGEN hasher (fail-closed)", () => {
  it("manglende, ikke-streng og for kort pepper (< 32 tegn) gir null; nøyaktig minstelengde godtas; pepperen trimmes", () => {
    for (const bad of [null, undefined, "", "   ", "x".repeat(PEPPER_MIN_LENGTH - 1), 42 as unknown as string, `  ${"x".repeat(PEPPER_MIN_LENGTH - 1)}  `]) expect(createContentHasher(bad), String(bad)).toBeNull();
    expect(PEPPER_MIN_LENGTH).toBe(32);
    expect(createContentHasher("p".repeat(32))).not.toBeNull();
    expect(createContentHasher(`  ${"p".repeat(32)}\n`)!.hmac("content", "a")).toBe(createContentHasher("p".repeat(32))!.hmac("content", "a"));
  });

  it("hashen er en ekte HMAC-SHA256 (uavhengig gjenskapt oppskrift), formålsskilt, pepper-avhengig, deterministisk - og IKKE den usaltede SHA-256 (ordbok-gjettbarhet)", () => {
    const hasher = createContentHasher(TEST_PEPPER)!;
    expect(hasher.version).toBe(2);
    for (const data of ["Hei!", "", "ja", "x".repeat(10_000), "æøå ✓"]) {
      expect(hasher.hmac("content", data)).toBe(recipe(TEST_PEPPER, "content", data));
      expect(hasher.hmac("content", data)).toMatch(/^[0-9a-f]{64}$/);
      expect(hasher.hmac("content", data), "ikke den usaltede SHA-256").not.toBe(createHash("sha256").update(data, "utf8").digest("hex"));
      expect(hasher.hmac("content", data)).toBe(hasher.hmac("content", data));
    }
    expect(hasher.hmac("content", "Hei!"), "samme data, ulikt formål gir ulik hash (en hash for ett formål kan ikke gjenbrukes for et annet)").not.toBe(hasher.hmac("request", "Hei!"));
    expect(createContentHasher(`${TEST_PEPPER}-annen`)!.hmac("content", "Hei!"), "ulik pepper gir ulik hash").not.toBe(hasher.hmac("content", "Hei!"));
    expect(JSON.stringify(hasher), "hasheren bærer ikke pepperen").not.toContain(TEST_PEPPER);
    expect(Object.keys(hasher).sort()).toEqual(["hmac", "version"]);
  });

  it("forespørselens fingeravtrykk (v2) er en HMAC (uavhengig av request_id) og skiller seg fra det gamle usaltede (v1)", () => {
    const hasher = createContentHasher(TEST_PEPPER)!;
    const parsed = parseSendParams({ request_id: "req-ch-00001", channel: "sms", account_ref: SMS, recipient: "+4790000001", purpose: "transactional", text: "Hei", ...BASIS });
    if (!parsed.ok) throw new Error(parsed.code);
    const v2 = requestFingerprint(parsed.value.request, hasher);
    const v1 = legacyRequestFingerprint(parsed.value.request);
    expect(v2).toMatch(/^[0-9a-f]{64}$/);
    expect(v1).toBe(sha256Hex(JSON.stringify(["comms-request-v1", ...legacyParts(parsed.value.request)])));
    expect(v2).not.toBe(v1);
    expect(v2).toBe(requestFingerprint(parsed.value.request, hasher));
  });
});

/** Delene som går inn i avtrykket (uavhengig kopi av rekkefølgen: ikke koden under test). */
function legacyParts(r: { kind: string; channel: string; account_ref: string; recipient: string; purpose: string; purpose_basis?: string; purpose_basis_note?: string; content: { text?: string; template?: unknown; media?: unknown; reaction?: string; recording?: boolean }; thread_ref?: string; target_message_id?: string }): unknown[] {
  const c = r.content;
  return [r.kind, r.channel, r.account_ref, r.recipient, r.purpose, r.purpose_basis ?? null, r.purpose_basis_note ?? null, c.text ?? null, c.template ?? null, c.media ?? null, c.reaction ?? null, c.recording ?? null, r.thread_ref ?? null, r.target_message_id ?? null];
}

describe("journalen: nye rader har HMAC-hash (versjon 2); den usaltede hashen finnes ingen steder", () => {
  it("en kort melding («Hei!» + AI-opplysning): journalens content_sha256 = HMAC, versjon 2, før-bildet v2; den usaltede SHA-256 av teksten finnes IKKE i journal, ledger eller audit", async () => {
    pepper = TEST_PEPPER;
    const n = chain.phone();
    const key = chain.key("ch");
    const r = await chain.act("send", sendP(n), key);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const row = (await journalRow(scopedIdempotencyKey(TENANT_A, "send", key)))!;
    const expected = recipe(TEST_PEPPER, "content", finalText(TEXT));
    expect(row).toMatchObject({ content_sha256: expected, content_hash_version: 2, status: "sent" });
    expect(row.before_state).toMatchObject({ v: 2 });
    expect(row.before_state!.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const unsalted = createHash("sha256").update(finalText(TEXT), "utf8").digest("hex");
    expect(row.content_sha256).not.toBe(unsalted);
    for (const table of ["comms_outbound_log", "tool_executions", "audit_events"]) {
      expect(((await chain.db.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${table}::text LIKE $1`, [`%${unsalted}%`])).rows[0] as { n: number }).n, `${table} skal ikke ha den usaltede hashen`).toBe(0);
    }
    // meldingsteksten lagres fortsatt ingen steder (kun hash og lengde)
    expect(((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_outbound_log WHERE comms_outbound_log::text LIKE '%Hei!%'")).rows[0] as { n: number }).n).toBe(0);
    const listed = await chain.act("list_outbound", { limit: 100 });
    const entry = (listed.ok ? (listed.data as unknown as Array<Record<string, unknown>>) : []).find((x) => x["content_sha256"] === expected);
    expect(entry).toMatchObject({ content_hash_version: 2 });
  });

  it("et AVSLÅTT forsøk (avmeldt mottaker) journalføres også med HMAC-hash og versjon 2 - avslåtte rader er like ordbok-gjettbare som sendte, så de får samme vern", async () => {
    pepper = TEST_PEPPER;
    const n = chain.phone();
    expect((await chain.act("record_opt_out", { channel: "sms", recipient: n })).ok).toBe(true);
    const key = chain.key("chden");
    const r = await chain.act("send", sendP(n, "Takk!"), key);
    expect(r.ok === false && r.status === "denied" ? r.denial_codes : []).toContain("recipient_opted_out");
    const row = (await journalRow(scopedIdempotencyKey(TENANT_A, "send", key)))!;
    expect(row).toMatchObject({ status: "denied", content_sha256: recipe(TEST_PEPPER, "content", finalText("Takk!")), content_hash_version: 2 });
  });

  it("to like meldinger gir samme hash (kjent, og uten pepperen ikke gjettbar), begge i versjon 2", async () => {
    pepper = TEST_PEPPER;
    const ka = chain.key("same-a");
    const kb = chain.key("same-b");
    expect((await chain.act("send", sendP(chain.phone(), "Samme tekst"), ka)).ok).toBe(true);
    expect((await chain.act("send", sendP(chain.phone(), "Samme tekst"), kb)).ok).toBe(true);
    const a = (await journalRow(scopedIdempotencyKey(TENANT_A, "send", ka)))!;
    const b = (await journalRow(scopedIdempotencyKey(TENANT_A, "send", kb)))!;
    expect(a.content_sha256).toBe(b.content_sha256);
    expect(a.content_sha256).toBe(recipe(TEST_PEPPER, "content", finalText("Samme tekst")));
    expect([a.content_hash_version, b.content_hash_version]).toEqual([2, 2]);
    expect(a.before_state!.request_fingerprint, "fingeravtrykket skiller mottakerne").not.toBe(b.before_state!.request_fingerprint);
  });
});

describe("fail-closed: ingen pepper (eller en for kort) = ingen utsendelse - aldri en stille usaltet hash", () => {
  for (const [label, value] of [["manglende (null)", null], ["for kort (31 tegn)", "x".repeat(31)]] as const) {
    it(`${label}: send avslås med \`${KEY_UNAVAILABLE}\`, ingenting sendes, avslaget journalføres uten hash, og verdien lekker ikke`, async () => {
      pepper = value;
      const before = sends();
      const key = chain.key("nopep");
      const r = await chain.act("send", sendP(chain.phone()), key);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.status === "denied" ? r.denial_codes : []).toContain(KEY_UNAVAILABLE);
      expect(sends(), "ingen sending uten pepper").toBe(before);
      const denied = (await chain.db.admin.query("SELECT content_sha256, content_hash_version, status, denial_codes FROM comms_outbound_log WHERE tenant_id = $1 AND status = 'denied' AND request_id = $2", [TENANT_A, scopedIdempotencyKey(TENANT_A, "send", key)])).rows[0] as { content_sha256: string | null; content_hash_version: number; denial_codes: string[] };
      expect(denied.content_sha256).toBeNull();
      expect(denied.denial_codes).toContain(KEY_UNAVAILABLE);
      expect(JSON.stringify(r)).not.toContain(value ?? "@@");
      // tørrkjøring (/comms/preview) viser det samme avslaget
      const preview = await previewCommsSend({ gateway: chain.gateway, funnel: chain.funnel, ownerGate: () => true }, chain.owner, { channel: "sms", account_ref: SMS, recipient: chain.phone(), purpose: "transactional", text: TEXT, ...BASIS });
      expect(preview.ok && (preview.data as { allowed: boolean }).allowed).toBe(false);
      expect(JSON.stringify(preview)).toContain(KEY_UNAVAILABLE);
      pepper = TEST_PEPPER;
    });
  }

  it("en feil ved oppslag av pepperen er samme fail-closed utfall (aldri en utsendelse, aldri en feilmelding med verdien)", async () => {
    const bad = await startChain("g1c1x", {}, { pepper: () => { throw new Error("vault nede: hemmelig-verdi-123456"); } });
    try {
      await authorizeAll(bad, [["sms", SMS, "twilio"]]);
      const r = await bad.act("send", sendP(bad.phone()), bad.key("vaultdown"));
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.status === "denied" ? r.denial_codes : []).toContain(KEY_UNAVAILABLE);
      expect(JSON.stringify(r)).not.toContain("hemmelig-verdi");
      expect(bad.twilio.calls.filter((c) => c.op === "send")).toHaveLength(0);
    } finally {
      await bad.stop();
    }
  });

  it("gjenspilling uten pepper: en tidligere HMAC-forespørsel kan ikke sammenlignes - avvises (`content_hash_key_unavailable`), ingen ny sending; med pepperen tilbake er det en vanlig gjenspilling", async () => {
    pepper = TEST_PEPPER;
    const n = chain.phone();
    const key = chain.key("rp");
    const first = await chain.act("send", sendP(n), key);
    expect(first.ok).toBe(true);
    const before = sends();
    pepper = null;
    expect(await chain.act("send", sendP(n), key)).toEqual({ ok: false, status: "rejected", reason: KEY_UNAVAILABLE });
    expect(sends()).toBe(before);
    pepper = TEST_PEPPER;
    const again = await chain.act("send", sendP(n), key);
    expect(again.ok && again.deduplicated).toBe(true);
    expect(sends()).toBe(before);
  });
});

describe("overgang: rader skrevet FØR HMAC (versjon 1, usaltet) gjenkjennes fortsatt; rotasjon er fail-closed", () => {
  async function legacyRow(requestId: string, request: Parameters<typeof legacyRequestFingerprint>[0]): Promise<void> {
    await chain.db.admin.query(
      `INSERT INTO comms_outbound_log (tenant_id, log_id, memory_space_id, request_id, kind, channel, account_ref, provider, recipient_hash, purpose, status, rule_evaluation, recipient_proof, content_sha256, content_length, person_id, session_id, source, before_state, provider_message_id, retention_until)
       VALUES ($1, $2, 'business', $3, 'message', 'sms', $4, 'twilio', $5, 'transactional', 'sent', '[]', '{}', $6, 20, $7, 'sess-legacy', 'owner_route', $8, 'msg-legacy-1', now() + interval '400 days')`,
      [TENANT_A, `clog-legacy-${requestId.length}-${Math.random().toString(36).slice(2, 8)}`, requestId, SMS, recipientHash(TENANT_A, "sms", request.recipient), sha256Hex(finalText(TEXT)), OWNER, JSON.stringify({ v: 1, request_fingerprint: legacyRequestFingerprint(request) })]
    );
  }

  it("en gammel (v1) rad: samme forespørsel er en gjenspilling uten ny sending (trakten gjenkjenner den); en ANNEN forespørsel med samme nøkkel er en kollisjon; raden beholder versjon 1", async () => {
    pepper = TEST_PEPPER;
    const n = chain.phone();
    const key = chain.key("legacy");
    const scoped = scopedIdempotencyKey(TENANT_A, "send", key);
    const same = parseSendParams({ request_id: scoped, ...sendP(n) });
    const other = parseSendParams({ request_id: scoped, ...sendP(n, "En annen tekst") });
    if (!same.ok || !other.ok) throw new Error("parse");
    await legacyRow(scoped, same.value.request);
    const before = sends();
    expect(await chain.funnel.replayState(chain.ctx, same.value)).toBe("replay");
    expect(await chain.funnel.replayState(chain.ctx, other.value)).toBe("collision");
    const replayed = await chain.funnel.execute(chain.ctx, same.value, "fake-token-for-test");
    expect(replayed.data).toMatchObject({ status: "sent", deduplicated: true });
    await expect(chain.funnel.execute(chain.ctx, other.value, "fake-token-for-test")).rejects.toThrow("idempotency_key_collision");
    expect(await chain.act("send", sendP(n, "En annen tekst"), key)).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_collision" });
    expect(sends(), "ingen ny sending for en gammel rad").toBe(before);
    expect((await journalRow(scoped))!).toMatchObject({ content_hash_version: 1, content_sha256: sha256Hex(finalText(TEXT)) });
  });

  it("rotasjon: en ny pepper gir en ny hash for samme tekst; en gjenspilling av en forespørsel laget med den gamle avvises som kollisjon (feil retning: ingen sending); en NY nøkkel virker", async () => {
    pepper = TEST_PEPPER;
    const n = chain.phone();
    const key = chain.key("rot");
    expect((await chain.act("send", sendP(n), key)).ok).toBe(true);
    const oldHash = (await journalRow(scopedIdempotencyKey(TENANT_A, "send", key)))!.content_sha256;
    pepper = `${TEST_PEPPER}-rotated`;
    const before = sends();
    expect(await chain.act("send", sendP(n), key)).toEqual({ ok: false, status: "rejected", reason: "idempotency_key_collision" });
    expect(sends()).toBe(before);
    const key2 = chain.key("rot2");
    expect((await chain.act("send", sendP(chain.phone()), key2)).ok).toBe(true);
    const newHash = (await journalRow(scopedIdempotencyKey(TENANT_A, "send", key2)))!.content_sha256;
    expect(newHash).toBe(recipe(`${TEST_PEPPER}-rotated`, "content", finalText(TEXT)));
    expect(newHash).not.toBe(oldHash);
    pepper = TEST_PEPPER;
  });
});

describe("databasen: journalens `retention_until` og `content_hash_version` er uforanderlige; sletting krever utløpt frist eller erasure", () => {
  const asApp = <T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> => withMemoryTransaction(chain.db.app, TENANT_A, ["business", "personal", "project", "shared"], fn);

  async function requestedRow(): Promise<string> {
    const id = `clog-ret-${Math.random().toString(36).slice(2, 10)}`;
    await chain.db.admin.query(
      `INSERT INTO comms_outbound_log (tenant_id, log_id, memory_space_id, request_id, kind, channel, account_ref, provider, recipient_hash, purpose, status, rule_evaluation, recipient_proof, person_id, session_id, source, retention_until)
       VALUES ($1, $2, 'business', $3, 'message', 'sms', $4, 'twilio', $5, 'transactional', 'requested', '[]', '{}', $6, 'sess-ret', 'owner_route', now() + interval '400 days')`,
      [TENANT_A, id, `req-${id}`, SMS, "a".repeat(64), OWNER]
    );
    return id;
  }

  it("appen kan ikke flytte `retention_until` tilbake (og så slette) eller endre `content_hash_version` på en åpen rad", async () => {
    const id = await requestedRow();
    await expect(asApp((c) => c.query("UPDATE comms_outbound_log SET retention_until = now() - interval '1 day' WHERE tenant_id = $1 AND log_id = $2", [TENANT_A, id]))).rejects.toThrow(/kjernekolonnene er uforanderlige/);
    await expect(asApp((c) => c.query("UPDATE comms_outbound_log SET content_hash_version = 2 WHERE tenant_id = $1 AND log_id = $2", [TENANT_A, id]))).rejects.toThrow(/kjernekolonnene er uforanderlige/);
    await expect(asApp((c) => c.query("UPDATE comms_outbound_log SET status = 'failed' WHERE tenant_id = $1 AND log_id = $2", [TENANT_A, id]))).resolves.toBeDefined(); // lovlig overgang er uendret
  });

  it("en fersk journalrad kan IKKE slettes av appen (23514); erasure-transaksjonen kan (rullet tilbake her); en utløpt rad kan slettes; `jarvis.erasure_in_progress` = 'on' er ikke nok", async () => {
    const id = await requestedRow();
    const del = (c: import("pg").PoolClient) => c.query("DELETE FROM comms_outbound_log WHERE tenant_id = $1 AND log_id = $2", [TENANT_A, id]);
    await expect(asApp(del)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("comms_row_delete_forbidden:comms_outbound_log") });
    await expect(asApp(async (c) => { await c.query("SELECT set_config('jarvis.erasure_in_progress', 'on', true)"); return del(c); })).rejects.toMatchObject({ code: "23514" });
    const erasure = withMemoryTransaction(chain.db.app, TENANT_A, ["business"], async (c) => {
      await c.query("SELECT set_config('jarvis.erasure_in_progress', 'true', true)");
      expect((await del(c)).rowCount).toBe(1);
      throw new Error("rollback-markør");
    });
    await expect(erasure).rejects.toThrow("rollback-markør");
    // utløpt (databasens klokke): frista flyttes tilbake som superbruker (replica omgår triggerne; appen kan aldri det)
    const admin = await chain.db.admin.connect();
    try {
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query("UPDATE comms_outbound_log SET retention_until = now() - interval '1 day' WHERE log_id = $1", [id]);
      await admin.query("COMMIT");
    } finally {
      admin.release();
    }
    await expect(asApp(del)).resolves.toBeDefined();
    expect(((await chain.db.admin.query("SELECT count(*)::int AS n FROM comms_outbound_log WHERE log_id = $1", [id])).rows[0] as { n: number }).n).toBe(0);
  });
});
