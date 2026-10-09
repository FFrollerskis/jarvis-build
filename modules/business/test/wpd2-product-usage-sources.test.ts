import { describe, expect, it } from "vitest";
import {
  fileUsageSource, isPseudonymousRef, normalizeUsageEvent, parseCsvRows, parseCsvUsage, parseJsonlUsage, parseWebhookUsagePayload,
  signUsageWebhook, verifyUsageWebhookSignature, webhookUsageSource, USAGE_LIMITS, UsageImportError
} from "../src/index.ts";

/**
 * WP-D2 (UA-3 «churn/product usage»): rene enhetsbevis for kildene (webhook, JSONL, CSV) - ingen database, ingen skjult global tid. Fokus er de adversarielle
 * egenskapene: personidentifiserende referanser, ukjente felt/kolonner, grenser, signatur/replay og at ugyldige enkelthendelser aldri velter resten.
 */
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const REF = "a1b2c3d4e5f6";
const ok = (over: Record<string, unknown> = {}) => ({ event_id: "evt-000001", account_ref: REF, feature: "chat.send", occurred_at: "2026-10-09T10:00:00Z", ...over });
const reasonOf = (raw: unknown): string => {
  const r = normalizeUsageEvent(raw, NOW);
  return r.ok ? "OK" : r.reason;
};

describe("A: pseudonyme referanser - e-post, telefon, IP og mellomrom kommer aldri inn", () => {
  it("godtar hex-/hash-lignende og prefikserte id-er", () => {
    for (const v of [REF, "acct_01HZX9K3", "u:7f3a9c0d11", "a-b.c_d:e12", "A".repeat(128)]) expect(isPseudonymousRef(v), v).toBe(true);
  });
  it("avviser e-post, telefon-/fødselsnummerlignende tall, IPv4, mellomrom, for kort/lang, kontrolltegn og unicode", () => {
    const bad = [
      "tobias@example.com", "ola.nordmann@firma.no", "4791234567", "12345678", "123456789012345", "192.168.1.10", "10.0.0.1",
      "has space", "kort1", "x".repeat(129), "line\nbreak", "tab\there", "æøåæøåæøå", "-leading-dash", ".leading-dot", "", "  "
    ];
    for (const v of bad) expect(isPseudonymousRef(v), JSON.stringify(v)).toBe(false);
  });
  it("kun 8-15 siffer avvises som tall - 16+ siffer eller blandet med bokstaver er en gyldig hash-lignende id", () => {
    expect(isPseudonymousRef("1234567890123456")).toBe(true);
    expect(isPseudonymousRef("1234567a")).toBe(true);
    expect(isPseudonymousRef("1234567")).toBe(true); // 7 siffer: under telefon-/fødselsnummergrensen (6-tegnsminimum oppfylt)
  });
  it("en hendelse med PII-lik account_ref/user_ref avvises med kode (aldri verdien)", () => {
    for (const v of ["tobias@example.com", "4791234567", "192.168.1.10"]) {
      const a = normalizeUsageEvent(ok({ account_ref: v }), NOW);
      expect(a).toEqual({ ok: false, reason: "account_ref_invalid_or_not_pseudonymous" });
      const u = normalizeUsageEvent(ok({ user_ref: v }), NOW);
      expect(u).toEqual({ ok: false, reason: "user_ref_invalid_or_not_pseudonymous" });
      expect(JSON.stringify([a, u])).not.toContain(v);
    }
  });
});

describe("B: normalizeUsageEvent - streng validering, fail-closed", () => {
  it("normaliserer en gyldig bruk-hendelse (standard antall 1, tid til UTC ISO)", () => {
    const r = normalizeUsageEvent(ok({ occurred_at: "2026-10-09T12:00:00+02:00", user_ref: "usr_abcdef12" }), NOW);
    expect(r).toEqual({
      ok: true,
      event: { external_event_id: "evt-000001", kind: "usage", account_ref: REF, user_ref: "usr_abcdef12", feature: "chat.send", quantity: 1, occurred_at: "2026-10-09T10:00:00.000Z" }
    });
  });
  it("billing_status krever antall (0 = ingen forfalte) og tar verken funksjon eller bruker", () => {
    const base = { event_id: "bill-000001", kind: "billing_status", account_ref: REF, occurred_at: "2026-10-09T09:00:00Z" };
    expect(normalizeUsageEvent({ ...base, quantity: 0 }, NOW)).toMatchObject({ ok: true, event: { kind: "billing_status", quantity: 0, feature: null, user_ref: null } });
    expect(normalizeUsageEvent({ ...base, quantity: 3 }, NOW)).toMatchObject({ ok: true, event: { quantity: 3 } });
    expect(reasonOf(base)).toBe("quantity_required_for_billing_status");
    expect(reasonOf({ ...base, quantity: 1001 })).toBe("quantity_out_of_range");
    expect(reasonOf({ ...base, quantity: 1, feature: "chat.send" })).toBe("billing_status_takes_no_feature_or_user");
    expect(reasonOf({ ...base, quantity: 1, user_ref: "usr_abcdef12" })).toBe("billing_status_takes_no_feature_or_user");
  });
  it("ukjente felt avvises - e-post, navn og fritekst kan ikke snike seg inn som ekstra felt", () => {
    for (const field of ["email", "name", "ip", "user_agent", "message", "notes", "__proto__x", "constructor"]) {
      expect(reasonOf(ok({ [field]: "x" })), field).toBe(`unknown_field:${field}`);
    }
    expect(reasonOf(ok({ ["f".repeat(200)]: 1 }))).toBe(`unknown_field:${"f".repeat(40)}`); // feltnavnet kappes i svaret
  });
  it("ikke-objekter avvises", () => {
    for (const raw of [null, undefined, 5, "str", [], [ok()], true]) expect(reasonOf(raw)).toBe("not_an_object");
  });
  it("event_id og funksjonsnøkkel valideres (tegnsett/lengde/typer)", () => {
    for (const id of ["short", "has space", "ny\nlinje", "æøå-event-1", "x".repeat(129), 12345678, null, ""]) expect(reasonOf(ok({ event_id: id })), JSON.stringify(id)).toBe("event_id_invalid");
    for (const f of ["Chat.Send", "has space", "", "x".repeat(65), "-start", 5]) expect(reasonOf(ok({ feature: f })), JSON.stringify(f)).toBe("feature_invalid");
    expect(reasonOf({ event_id: "evt-000001", account_ref: REF, occurred_at: "2026-10-09T10:00:00Z" })).toBe("feature_invalid");
  });
  it("kind må være usage eller billing_status", () => {
    expect(reasonOf(ok({ kind: "purchase" }))).toBe("kind_invalid");
    expect(reasonOf(ok({ kind: 5 }))).toBe("kind_invalid");
    expect(reasonOf(ok({ kind: "usage" }))).toBe("OK");
  });
  it("tid: ugyldig, for langt frem, for gammel - med eksakte grenser", () => {
    expect(reasonOf(ok({ occurred_at: "i går" }))).toBe("occurred_at_invalid");
    expect(reasonOf(ok({ occurred_at: "2026-13-45T00:00:00Z" }))).toBe("occurred_at_invalid");
    expect(reasonOf(ok({ occurred_at: 1760000000 }))).toBe("occurred_at_invalid");
    expect(reasonOf(ok({ occurred_at: "2026-10-09T12:00:00Z".padEnd(41, "0") }))).toBe("occurred_at_invalid");
    const future = (ms: number) => new Date(NOW + ms).toISOString();
    expect(reasonOf(ok({ occurred_at: future(USAGE_LIMITS.max_future_ms) }))).toBe("OK");
    expect(reasonOf(ok({ occurred_at: future(USAGE_LIMITS.max_future_ms + 1) }))).toBe("occurred_at_out_of_range");
    const past = (ms: number) => new Date(NOW - ms).toISOString();
    expect(reasonOf(ok({ occurred_at: past(USAGE_LIMITS.max_age_days * 86_400_000) }))).toBe("OK");
    expect(reasonOf(ok({ occurred_at: past(USAGE_LIMITS.max_age_days * 86_400_000 + 1) }))).toBe("occurred_at_out_of_range");
  });
  it("antall: heltall innenfor grensene; tall som streng godtas, alt annet avvises", () => {
    expect(reasonOf(ok({ quantity: 100_000 }))).toBe("OK");
    for (const q of [0, 100_001, -1, 1.5, "1.5", "1e3", "abc", "12345678", Number.NaN, Number.POSITIVE_INFINITY, true, {}, []]) {
      expect(["quantity_invalid", "quantity_out_of_range"], JSON.stringify(q)).toContain(reasonOf(ok({ quantity: q })));
    }
    expect(normalizeUsageEvent(ok({ quantity: "12" }), NOW)).toMatchObject({ ok: true, event: { quantity: 12 } });
  });
});

describe("C: webhook-signatur og replay-vern", () => {
  const secret = "s".repeat(40);
  const body = Buffer.from(JSON.stringify({ events: [ok()] }));
  const t0 = Math.floor(NOW / 1000);

  it("signering og verifisering er symmetriske; header er t=<tid>,v1=<hex>", () => {
    const header = signUsageWebhook(body, secret, t0);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyUsageWebhookSignature(body, header, secret, t0)).toEqual({ valid: true, timestamp: t0 });
    expect(signUsageWebhook(body.toString("utf8"), secret, t0)).toBe(header); // streng og Buffer gir samme signatur
  });
  it("endret kropp (ett tegn), feil hemmelighet eller feil tidsstempel avvises", () => {
    const header = signUsageWebhook(body, secret, t0);
    const tampered = Buffer.from(body.toString("utf8").replace("chat.send", "chat.sent"));
    expect(verifyUsageWebhookSignature(tampered, header, secret, t0)).toMatchObject({ valid: false, reason: "signature_mismatch" });
    expect(verifyUsageWebhookSignature(body, header, "x".repeat(40), t0)).toMatchObject({ valid: false, reason: "signature_mismatch" });
    const replayWithNewTime = header.replace(`t=${t0}`, `t=${t0 + 1}`);
    expect(verifyUsageWebhookSignature(body, replayWithNewTime, secret, t0)).toMatchObject({ valid: false, reason: "signature_mismatch" });
  });
  it("replay-vern: tidsstempel utenfor ±300 s avvises (begge retninger), nøyaktig 300 s godtas", () => {
    const header = signUsageWebhook(body, secret, t0);
    expect(verifyUsageWebhookSignature(body, header, secret, t0 + 300).valid).toBe(true);
    expect(verifyUsageWebhookSignature(body, header, secret, t0 + 301)).toMatchObject({ valid: false, reason: "timestamp_outside_tolerance" });
    expect(verifyUsageWebhookSignature(body, header, secret, t0 - 300).valid).toBe(true);
    expect(verifyUsageWebhookSignature(body, header, secret, t0 - 301)).toMatchObject({ valid: false, reason: "timestamp_outside_tolerance" });
  });
  it("manglende/ødelagt header og tom hemmelighet feiler lukket", () => {
    expect(verifyUsageWebhookSignature(body, undefined, secret, t0)).toMatchObject({ valid: false, reason: "missing_signature_header" });
    expect(verifyUsageWebhookSignature(body, "", secret, t0)).toMatchObject({ valid: false, reason: "missing_signature_header" });
    for (const h of ["garbage", "t=abc,v1=00", `t=${t0}`, `v1=${"0".repeat(64)}`, `t=${"9".repeat(13)},v1=${"0".repeat(64)}`, `t=-5,v1=${"0".repeat(64)}`]) {
      expect(verifyUsageWebhookSignature(body, h, secret, t0), h).toMatchObject({ valid: false, reason: "malformed_signature_header" });
    }
    expect(verifyUsageWebhookSignature(body, signUsageWebhook(body, secret, t0), "", t0)).toMatchObject({ valid: false, reason: "secret_not_configured" });
  });
  it("feil lengde/tegnsett på v1 gir mismatch uten å kaste; hex med store bokstaver godtas; opptil fire v1 (nøkkelrotasjon), ikke fem", () => {
    const good = signUsageWebhook(body, secret, t0).split("v1=")[1] as string;
    for (const c of ["", "abcd", "z".repeat(64), "0".repeat(63), "0".repeat(65), good.slice(0, 62) + "zz"]) {
      expect(verifyUsageWebhookSignature(body, `t=${t0},v1=${c}`, secret, t0), c).toMatchObject({ valid: false, reason: "signature_mismatch" });
    }
    expect(verifyUsageWebhookSignature(body, `t=${t0},v1=${good.toUpperCase()}`, secret, t0).valid).toBe(true);
    const wrong = "0".repeat(64);
    expect(verifyUsageWebhookSignature(body, `t=${t0},v1=${wrong},v1=${wrong},v1=${good}`, secret, t0).valid).toBe(true);
    expect(verifyUsageWebhookSignature(body, `t=${t0},v1=${wrong},v1=${wrong},v1=${wrong},v1=${wrong},v1=${good}`, secret, t0)).toMatchObject({ valid: false, reason: "malformed_signature_header" });
  });
  it("signaturen dekker RÅ kropp: omformattert JSON med samme innhold har en annen signatur", () => {
    const pretty = Buffer.from(JSON.stringify({ events: [ok()] }, null, 2));
    const header = signUsageWebhook(body, secret, t0);
    expect(verifyUsageWebhookSignature(pretty, header, secret, t0).valid).toBe(false);
  });
});

describe("D: webhook-kropp", () => {
  const buf = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v));
  it("godtar én hendelse eller {events:[...]}; duplikat-id i samme batch telles én gang; ugyldige enkelthendelser rapporteres med posisjon", () => {
    expect(parseWebhookUsagePayload(buf(ok()), NOW).accepted).toHaveLength(1);
    const batch = parseWebhookUsagePayload(buf({ events: [ok(), ok(), ok({ event_id: "evt-000002" }), ok({ event_id: "x" }), { email: "a@b.no" }] }), NOW);
    expect(batch.accepted.map((e) => e.external_event_id)).toEqual(["evt-000001", "evt-000002"]);
    expect(batch.rejected).toEqual([{ position: 4, reason: "event_id_invalid" }, { position: 5, reason: "unknown_field:email" }]);
  });
  it("ugyldig HELE kropp kaster UsageImportError med kode", () => {
    const code = (b: Buffer) => { try { parseWebhookUsagePayload(b, NOW); return "OK"; } catch (e) { return (e as UsageImportError).code; } };
    expect(code(Buffer.alloc(0))).toBe("payload_size_invalid");
    expect(code(Buffer.alloc(USAGE_LIMITS.webhook_max_bytes + 1, 32))).toBe("payload_size_invalid");
    expect(code(buf("{not json"))).toBe("payload_not_json");
    expect(code(buf("[1,2]"))).toBe("payload_not_an_object");
    expect(code(buf("null"))).toBe("payload_not_an_object");
    expect(code(buf({ events: "no" }))).toBe("payload_events_invalid");
    expect(code(buf({ events: [ok()], extra: 1 }))).toBe("payload_events_invalid");
    expect(code(buf({ events: [] }))).toBe("payload_event_count_invalid");
    expect(code(buf({ events: Array.from({ length: USAGE_LIMITS.webhook_max_events + 1 }, (_, i) => ok({ event_id: `evt-${String(i).padStart(8, "0")}` })) }))).toBe("payload_event_count_invalid");
    expect(code(buf({ events: Array.from({ length: USAGE_LIMITS.webhook_max_events }, (_, i) => ok({ event_id: `evt-${String(i).padStart(8, "0")}` })) }))).toBe("OK");
  });
  it("webhook-kilden har source_id «webhook» og bruker samme parser", () => {
    expect(webhookUsageSource.source_id).toBe("webhook");
    expect(webhookUsageSource.parse(buf(ok()), NOW).accepted).toHaveLength(1);
  });
});

describe("E: JSONL-import", () => {
  const line = (over: Record<string, unknown> = {}) => JSON.stringify(ok(over));
  it("leser linje for linje (BOM og tomme linjer tolereres), rapporterer linjenummer for ugyldige", () => {
    const text = `\uFEFF${line()}\n\n${line({ event_id: "evt-000002" })}\r\nikke json\n${line({ event_id: "bad" })}\n${JSON.stringify({ ...ok({ event_id: "evt-000003" }), email: "x@y.no" })}`;
    const batch = parseJsonlUsage(text, NOW);
    expect(batch.accepted.map((e) => e.external_event_id)).toEqual(["evt-000001", "evt-000002"]);
    expect(batch.rejected).toEqual([
      { position: 4, reason: "line_not_json" }, { position: 5, reason: "event_id_invalid" }, { position: 6, reason: "unknown_field:email" }
    ]);
  });
  it("for lang linje avvises uten å parses; hele filen avvises når den er for stor eller har for mange hendelser", () => {
    const long = JSON.stringify(ok({ feature: "a".repeat(9000) }));
    expect(parseJsonlUsage(`${long}\n${line()}`, NOW)).toMatchObject({ accepted: [{ external_event_id: "evt-000001" }], rejected: [{ position: 1, reason: "line_too_long" }] });
    expect(() => parseJsonlUsage("x".repeat(USAGE_LIMITS.import_max_bytes + 1), NOW)).toThrowError(/file_too_large/);
    const many = Array.from({ length: USAGE_LIMITS.import_max_events + 1 }, (_, i) => `{"e":${i}}`).join("\n");
    expect(() => parseJsonlUsage(many, NOW)).toThrowError(/too_many_events/);
  });
});

describe("F: CSV-import", () => {
  const header = "event_id,account_ref,feature,occurred_at,quantity";
  it("parser anførselstegn, doble anførselstegn, komma og linjeskift i felt (RFC 4180) og CRLF/BOM", () => {
    expect(parseCsvRows('a,"b,c","d ""q"" e","x\ny"\r\n1,2,3,4')).toEqual([["a", "b,c", 'd "q" e', "x\ny"], ["1", "2", "3", "4"]]);
    // tomme linjer hoppes over; en rad av tomme celler beholdes (og avvises senere som ugyldig hendelse)
    expect(parseCsvRows("\uFEFFa,b\n\n,\nc,d\n")).toEqual([["a", "b"], ["", ""], ["c", "d"]]);
    expect(() => parseCsvRows('a,"ulukket')).toThrowError(/csv_unterminated_quote/);
  });
  it("leser hendelser med header (rekkefølge og store bokstaver fritt), tomme celler utelates, posisjon = linjenummer", () => {
    const text = `Occurred_At,EVENT_ID,Account_Ref,feature,quantity\n2026-10-09T10:00:00Z,evt-000001,${REF},chat.send,3\n2026-10-09T10:05:00Z,evt-000002,${REF},chat.send,\n2026-10-09T10:06:00Z,bad,${REF},chat.send,1\n`;
    const batch = parseCsvUsage(text, NOW);
    expect(batch.accepted.map((e) => [e.external_event_id, e.quantity])).toEqual([["evt-000001", 3], ["evt-000002", 1]]);
    expect(batch.rejected).toEqual([{ position: 4, reason: "event_id_invalid" }]);
  });
  it("ukjent kolonne (email, navn, ip ...) avviser HELE filen - personopplysninger kan ikke snike seg inn via en ekstra kolonne", () => {
    for (const col of ["email", "name", "ip", "phone", "user_agent"]) {
      expect(() => parseCsvUsage(`${header},${col}\nevt-000001,${REF},chat.send,2026-10-09T10:00:00Z,1,x\n`, NOW)).toThrowError(new RegExp(`unknown_column: ${col}`));
    }
  });
  it("manglende obligatorisk kolonne, duplisert kolonne, tom fil og for mange celler", () => {
    expect(() => parseCsvUsage("event_id,feature\nevt-000001,chat.send\n", NOW)).toThrowError(/missing_column: account_ref/);
    expect(() => parseCsvUsage(`${header},quantity\nx`, NOW)).toThrowError(/duplicate_column/);
    expect(() => parseCsvUsage("", NOW)).toThrowError(/csv_empty/);
    const extra = parseCsvUsage(`${header}\nevt-000001,${REF},chat.send,2026-10-09T10:00:00Z,1,SURPLUS\n`, NOW);
    expect(extra.accepted).toHaveLength(0);
    expect(extra.rejected).toEqual([{ position: 2, reason: "unknown_field:__too_many_cells" }]);
  });
  it("for stor fil avvises", () => {
    expect(() => parseCsvUsage("x".repeat(USAGE_LIMITS.import_max_bytes + 1), NOW)).toThrowError(/file_too_large/);
  });
  it("fileUsageSource: kilde-id import:<etikett>, etiketten valideres, og velger riktig parser", () => {
    const csv = fileUsageSource("csv", "2026-10.batch_1");
    expect(csv.source_id).toBe("import:2026-10.batch_1");
    expect(csv.parse(`${header}\nevt-000001,${REF},chat.send,2026-10-09T10:00:00Z,2\n`, NOW).accepted).toHaveLength(1);
    expect(fileUsageSource("jsonl", "x").parse(JSON.stringify(ok()), NOW).accepted).toHaveLength(1);
    for (const label of ["Upper", "has space", "", "-lead", "x".repeat(41), "æøå", "a/b", "a:b"]) expect(() => fileUsageSource("csv", label), JSON.stringify(label)).toThrowError(/source_label_invalid/);
  });
});
