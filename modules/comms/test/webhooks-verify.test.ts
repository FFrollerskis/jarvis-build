import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseOptKeyword, secretsEqual, twilioSignatureBase, verifyMetaSignature, verifySlackSignature, verifyTelnyxSignature, verifyTwilioSignature } from "../src/index.ts";

/**
 * WP-G1 (P1d): signaturverifiseringen for Slack/Meta/Twilio/Telnyx - rene funksjoner, deterministisk klokke. Hver leverandørs kontrakt (hva som signeres, hvilken algoritme, hvilken toleranse) er bevist med
 * uavhengig beregnede signaturer, og alle avvisningsveier er dekket: manipulert kropp, feil hemmelighet, utløpt og framtidig tidsstempel, manglende/misdannede headere, URL-forskjell, ugyldig nøkkel.
 */
const NOW = 1_763_380_800; // 2025-11-17T12:00:00Z i sekunder (vilkårlig, fast)
const SECRET = "fake-signing-secret-for-test";

describe("A: Slack (v0, HMAC-SHA256, tidsstempel)", () => {
  const body = Buffer.from(JSON.stringify({ type: "event_callback", event_id: "Ev1" }));
  const sig = (ts: string, raw: Buffer = body, secret = SECRET) => `v0=${createHmac("sha256", secret).update(`v0:${ts}:`).update(raw).digest("hex")}`;
  const ts = String(NOW);

  it("gyldig signatur aksepteres; kroppen signeres som rå bytes", () => {
    expect(verifySlackSignature({ rawBody: body, timestamp: ts, signature: sig(ts), signingSecret: SECRET, nowSeconds: NOW })).toEqual({ ok: true });
    // en omformatert (JSON-rundtur) kropp med samme innhold men andre bytes feiler: man MÅ verifisere mot rå bytes
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifySlackSignature({ rawBody: reformatted, timestamp: ts, signature: sig(ts), signingSecret: SECRET, nowSeconds: NOW })).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("feil hemmelighet, manipulert kropp, utløpt og framtidig tidsstempel (5 min, symmetrisk), manglende og misdannede headere avvises", () => {
    const base = { rawBody: body, timestamp: ts, signature: sig(ts), signingSecret: SECRET, nowSeconds: NOW };
    expect(verifySlackSignature({ ...base, signingSecret: "annen" })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    expect(verifySlackSignature({ ...base, rawBody: Buffer.from("{}") })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    const old = String(NOW - 301);
    expect(verifySlackSignature({ ...base, timestamp: old, signature: sig(old) })).toMatchObject({ ok: false, reason: "timestamp_outside_tolerance" });
    const future = String(NOW + 301);
    expect(verifySlackSignature({ ...base, timestamp: future, signature: sig(future) })).toMatchObject({ ok: false, reason: "timestamp_outside_tolerance" });
    const edge = String(NOW - 300);
    expect(verifySlackSignature({ ...base, timestamp: edge, signature: sig(edge) })).toEqual({ ok: true });
    expect(verifySlackSignature({ ...base, signature: undefined })).toMatchObject({ ok: false, reason: "missing_header" });
    expect(verifySlackSignature({ ...base, timestamp: undefined })).toMatchObject({ ok: false, reason: "missing_header" });
    for (const bad of ["", "v0=zz", `v1=${"0".repeat(64)}`, `v0=${"0".repeat(63)}`, sig(ts).toUpperCase()]) {
      expect(verifySlackSignature({ ...base, signature: bad }), bad).toMatchObject({ ok: false, reason: "malformed_header" });
    }
    expect(verifySlackSignature({ ...base, timestamp: "abc" })).toMatchObject({ ok: false, reason: "malformed_header" });
  });
});

describe("B: Meta (X-Hub-Signature-256: sha256=<hex>, app-hemmelighet, rå kropp)", () => {
  const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));
  const sig = (raw: Buffer, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

  it("gyldig aksepteres; feil hemmelighet, manipulert kropp, manglende og misdannet header avvises", () => {
    expect(verifyMetaSignature({ rawBody: body, signature: sig(body), appSecret: SECRET })).toEqual({ ok: true });
    expect(verifyMetaSignature({ rawBody: body, signature: sig(body, "annen"), appSecret: SECRET })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    expect(verifyMetaSignature({ rawBody: Buffer.from("{}"), signature: sig(body), appSecret: SECRET })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    expect(verifyMetaSignature({ rawBody: body, signature: undefined, appSecret: SECRET })).toMatchObject({ ok: false, reason: "missing_header" });
    for (const bad of ["", sig(body).replace("sha256=", "sha1="), `sha256=${"0".repeat(63)}`, sig(body).toUpperCase()]) {
      expect(verifyMetaSignature({ rawBody: body, signature: bad, appSecret: SECRET }), bad).toMatchObject({ ok: false, reason: "malformed_header" });
    }
  });

  it("konstant-tid-sammenligning av verifiseringstokenet (GET-håndtrykket)", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
  });
});

describe("C: Twilio (HMAC-SHA1 over URL + sorterte parametre, base64)", () => {
  const url = "https://hooks.example.com/webhooks/comms/twilio";
  const params = new Map<string, string[]>([["To", ["+4791000000"]], ["From", ["+4790000000"]], ["Body", ["Hei"]], ["MessageSid", ["SM1"]]]);
  const sigFor = (u: string, p: Map<string, string[]>, token = SECRET) => createHmac("sha1", token).update(twilioSignatureBase(u, p), "utf8").digest("base64");

  it("signaturbasen er URL + navn/verdi sortert på navn (uavhengig beregnet)", () => {
    expect(twilioSignatureBase(url, params)).toBe(`${url}Body` + "Hei" + "From" + "+4790000000" + "MessageSid" + "SM1" + "To" + "+4791000000");
    const manual = createHmac("sha1", SECRET).update(`${url}BodyHeiFrom+4790000000MessageSidSM1To+4791000000`, "utf8").digest("base64");
    expect(sigFor(url, params)).toBe(manual);
  });

  it("gyldig aksepteres uansett parameterrekkefølge i kroppen; URL-forskjell (proxy-fellen), endret parameter, feil token og misdannet header avvises", () => {
    const shuffled = new Map<string, string[]>([...params].reverse());
    expect(verifyTwilioSignature({ url, params: shuffled, signature: sigFor(url, params), authToken: SECRET })).toEqual({ ok: true });
    expect(verifyTwilioSignature({ url: "http://hooks.example.com/webhooks/comms/twilio", params, signature: sigFor(url, params), authToken: SECRET })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    expect(verifyTwilioSignature({ url: `${url}?x=1`, params, signature: sigFor(url, params), authToken: SECRET })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    const tampered = new Map(params).set("Body", ["STOP"]);
    expect(verifyTwilioSignature({ url, params: tampered, signature: sigFor(url, params), authToken: SECRET })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    expect(verifyTwilioSignature({ url, params, signature: sigFor(url, params, "annen"), authToken: SECRET })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    expect(verifyTwilioSignature({ url, params, signature: undefined, authToken: SECRET })).toMatchObject({ ok: false, reason: "missing_header" });
    expect(verifyTwilioSignature({ url, params, signature: "ikke-base64!", authToken: SECRET })).toMatchObject({ ok: false, reason: "malformed_header" });
  });
});

describe("D: Telnyx (Ed25519 over `<tidsstempel>|<rå kropp>`)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const body = Buffer.from(JSON.stringify({ data: { event_type: "message.received", id: "e1" } }));
  const ts = String(NOW);
  const sigFor = (stamp: string, raw: Buffer = body) => sign(null, Buffer.concat([Buffer.from(`${stamp}|`), raw]), privateKey).toString("base64");

  it("gyldig aksepteres; tidsvinduet er 5 minutter i begge retninger; manipulert kropp og annen nøkkel avvises", () => {
    const base = { rawBody: body, signature: sigFor(ts), timestamp: ts, publicKeyBase64: publicRaw, nowSeconds: NOW };
    expect(verifyTelnyxSignature(base)).toEqual({ ok: true });
    const old = String(NOW - 301);
    expect(verifyTelnyxSignature({ ...base, timestamp: old, signature: sigFor(old) })).toMatchObject({ ok: false, reason: "timestamp_outside_tolerance" });
    const future = String(NOW + 301);
    expect(verifyTelnyxSignature({ ...base, timestamp: future, signature: sigFor(future) })).toMatchObject({ ok: false, reason: "timestamp_outside_tolerance" });
    expect(verifyTelnyxSignature({ ...base, rawBody: Buffer.from("{}") })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    expect(verifyTelnyxSignature({ ...base, publicKeyBase64: other })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    // en signatur over et ANNET tidsstempel kan ikke gjenbrukes med et nytt (replay med ferskt tidsstempel)
    expect(verifyTelnyxSignature({ ...base, timestamp: String(NOW + 10) })).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });

  it("manglende/misdannede headere og ugyldig nøkkellengde avvises uten å kaste", () => {
    const base = { rawBody: body, signature: sigFor(ts), timestamp: ts, publicKeyBase64: publicRaw, nowSeconds: NOW };
    expect(verifyTelnyxSignature({ ...base, signature: undefined })).toMatchObject({ ok: false, reason: "missing_header" });
    expect(verifyTelnyxSignature({ ...base, signature: "kort" })).toMatchObject({ ok: false, reason: "malformed_header" });
    expect(verifyTelnyxSignature({ ...base, timestamp: "x" })).toMatchObject({ ok: false, reason: "malformed_header" });
    expect(verifyTelnyxSignature({ ...base, publicKeyBase64: Buffer.alloc(31).toString("base64") })).toMatchObject({ ok: false, reason: "key_invalid" });
    expect(verifyTelnyxSignature({ ...base, publicKeyBase64: "" })).toMatchObject({ ok: false, reason: "key_invalid" });
  });
});

describe("E: avmeldingsord (STOP/START) tolkes bare som HELE, enkeltords meldinger", () => {
  it("stopp-ord (inkl. norske) og start-ord; alt annet er vanlig tekst", () => {
    for (const w of ["STOP", "stop", " Stop. ", "STOPALL", "unsubscribe", "CANCEL", "END", "REVOKE", "OPTOUT", "QUIT", "STOPP", "avmeld", "Stop!"]) expect(parseOptKeyword(w), w).toBe("stop");
    for (const w of ["START", "unstop", "Start."]) expect(parseOptKeyword(w), w).toBe("start");
    // YES/JA gjenopptar IKKE (et «ja» på et spørsmål skal aldri oppheve en avmelding)
    for (const w of ["YES", "ja", "Y", "OK", "stop sending me this", "please stop", "start nå", "STOP STOP", "", "x".repeat(80)]) expect(parseOptKeyword(w), w).toBeNull();
    expect(parseOptKeyword(null)).toBeNull();
    expect(parseOptKeyword(undefined)).toBeNull();
    // fullbredde-varianter jevnes ut (NFKC)
    expect(parseOptKeyword(String.fromCodePoint(0xff33, 0xff34, 0xff2f, 0xff30))).toBe("stop");
  });
});
