import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseVippsEventEnvelope, verifyVippsWebhookSignature, type VippsWebhookRequestHeaders } from "../src/vipps-webhook.ts";

/**
 * D-110 (UA-6 Slice 4): rene enhetstester for Vipps sin Azure-stil HMAC-
 * forespørselsautentisering/envelope-parsing - INGEN Postgres nødvendig
 * (SAMME "unit test det som kan enhetstestes"-prinsipp som
 * `stripe-webhook.test.ts`).
 */
// BEVISST lav-entropi, åpenbart falsk verdi (SAMME gitleaks-lærdom som
// stripe-webhook.test.ts sin fixture - aldri en ekte credential-form).
const SECRET = "not-a-real-vipps-webhook-secret-fixture";
const HOST = "jarvis.example.test";
const PATH = "/webhooks/vipps";

function buildSignedHeaders(rawBody: Buffer, options: { secret?: string; method?: string; path?: string; host?: string; date?: string; tamperContentHash?: string } = {}): VippsWebhookRequestHeaders {
  const secret = options.secret ?? SECRET;
  const method = options.method ?? "POST";
  const path = options.path ?? PATH;
  const host = options.host ?? HOST;
  const date = options.date ?? "Tue, 25 Aug 2026 12:00:00 GMT";
  const contentHash = options.tamperContentHash ?? createHash("sha256").update(rawBody).digest("base64");
  const signedPayload = `${method}\n${path}\n${date};${host};${contentHash}`;
  const signature = createHmac("sha256", secret).update(signedPayload, "utf8").digest("base64");
  return {
    host,
    xMsDate: date,
    xMsContentSha256: contentHash,
    authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`
  };
}

describe("A: gyldig autentisering", () => {
  it("aksepterer en korrekt signert forespørsel", () => {
    const body = Buffer.from(JSON.stringify({ reference: "fin-pi-1", name: "AUTHORIZED" }));
    const result = verifyVippsWebhookSignature(body, "POST", PATH, buildSignedHeaders(body), SECRET);
    expect(result.valid).toBe(true);
  });

  it("metode-casing normaliseres (post == POST i den signerte strengen)", () => {
    const body = Buffer.from(JSON.stringify({ reference: "fin-pi-1", name: "AUTHORIZED" }));
    const result = verifyVippsWebhookSignature(body, "post", PATH, buildSignedHeaders(body), SECRET);
    expect(result.valid).toBe(true);
  });
});

describe("B: ugyldig autentisering/manglende headere", () => {
  const body = Buffer.from(JSON.stringify({ reference: "fin-pi-1", name: "AUTHORIZED" }));

  it("avviser når Authorization-headeren mangler helt", () => {
    const headers = { ...buildSignedHeaders(body), authorization: undefined };
    const result = verifyVippsWebhookSignature(body, "POST", PATH, headers, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing_authorization_header");
  });

  it("avviser når X-Ms-Date mangler", () => {
    const headers = { ...buildSignedHeaders(body), xMsDate: undefined };
    expect(verifyVippsWebhookSignature(body, "POST", PATH, headers, SECRET).reason).toBe("missing_date_header");
  });

  it("avviser når Host mangler", () => {
    const headers = { ...buildSignedHeaders(body), host: undefined };
    expect(verifyVippsWebhookSignature(body, "POST", PATH, headers, SECRET).reason).toBe("missing_host_header");
  });

  it("avviser når X-Ms-Content-Sha256 mangler", () => {
    const headers = { ...buildSignedHeaders(body), xMsContentSha256: undefined };
    expect(verifyVippsWebhookSignature(body, "POST", PATH, headers, SECRET).reason).toBe("missing_content_hash_header");
  });

  it("avviser en malformert Authorization-header (ikke HMAC-SHA256-formen)", () => {
    const headers = { ...buildSignedHeaders(body), authorization: "Bearer garbage" };
    expect(verifyVippsWebhookSignature(body, "POST", PATH, headers, SECRET).reason).toBe("malformed_authorization_header");
  });

  it("avviser når innholds-hashen ikke matcher den faktiske kroppen (manipulert nyttelast)", () => {
    const original = Buffer.from(JSON.stringify({ reference: "fin-pi-1", name: "AUTHORIZED", amount: { value: 1000, currency: "NOK" } }));
    const tampered = Buffer.from(JSON.stringify({ reference: "fin-pi-1", name: "AUTHORIZED", amount: { value: 999_999, currency: "NOK" } }));
    const headers = buildSignedHeaders(original);
    const result = verifyVippsWebhookSignature(tampered, "POST", PATH, headers, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("content_hash_mismatch");
  });

  it("avviser når signaturen er laget med feil hemmelighet", () => {
    const headers = buildSignedHeaders(body, { secret: "some-other-wrong-secret" });
    const result = verifyVippsWebhookSignature(body, "POST", PATH, headers, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("avviser når path i den signerte strengen ikke matcher den faktiske forespørselens path", () => {
    const headers = buildSignedHeaders(body, { path: "/webhooks/other" });
    const result = verifyVippsWebhookSignature(body, "POST", PATH, headers, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("avviser når host-headeren er endret etter signering", () => {
    const headers = { ...buildSignedHeaders(body), host: "evil.example" };
    const result = verifyVippsWebhookSignature(body, "POST", PATH, headers, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("avviser ugyldig base64 i signaturen uten å kaste", () => {
    const headers = { ...buildSignedHeaders(body), authorization: "HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=!!!not-base64!!!" };
    expect(() => verifyVippsWebhookSignature(body, "POST", PATH, headers, SECRET)).not.toThrow();
    expect(verifyVippsWebhookSignature(body, "POST", PATH, headers, SECRET).valid).toBe(false);
  });
});

describe("C: envelope-parsing", () => {
  it("trekker ut minimal-felt for en betalingshendelse", () => {
    const raw = Buffer.from(JSON.stringify({
      reference: "fin-pi-abc", name: "AUTHORIZED", amount: { value: 5000, currency: "nok" },
      timestamp: "2026-08-25T12:00:00.000Z", idempotencyKey: "idem-key-1", msn: "123456", success: true
    }));
    const envelope = parseVippsEventEnvelope(raw);
    expect(envelope.reference).toBe("fin-pi-abc");
    expect(envelope.name).toBe("AUTHORIZED");
    expect(envelope.amount_ore).toBe(5000);
    expect(envelope.currency).toBe("NOK"); // alltid store bokstaver ut
    expect(envelope.msn).toBe("123456");
    expect(envelope.success).toBe(true);
    expect(envelope.dedupeKey).toBe("idem-key-1"); // idempotencyKey vinner som dedup-nøkkel når til stede
  });

  it("faller tilbake til en deterministisk sammensatt dedup-nøkkel uten idempotencyKey", () => {
    const raw = Buffer.from(JSON.stringify({ reference: "fin-pi-abc", name: "CAPTURED", timestamp: "2026-08-25T12:00:00.000Z" }));
    const envelope = parseVippsEventEnvelope(raw);
    expect(envelope.dedupeKey).toBe("fin-pi-abc:CAPTURED:2026-08-25T12:00:00.000Z");
  });

  it("faller tilbake deterministisk også helt uten timestamp", () => {
    const raw = Buffer.from(JSON.stringify({ reference: "fin-pi-abc", name: "CAPTURED" }));
    expect(parseVippsEventEnvelope(raw).dedupeKey).toBe("fin-pi-abc:CAPTURED:no-timestamp");
  });

  it("kaster deterministisk på en malformert envelope (mangler reference/name)", () => {
    expect(() => parseVippsEventEnvelope(Buffer.from(JSON.stringify({ foo: "bar" })))).toThrow("vipps_event_envelope_malformed");
  });

  it("håndterer manglende amount gracefully (null, ingen kast)", () => {
    const raw = Buffer.from(JSON.stringify({ reference: "fin-pi-abc", name: "CANCELLED" }));
    const envelope = parseVippsEventEnvelope(raw);
    expect(envelope.amount_ore).toBeNull();
    expect(envelope.currency).toBeNull();
    expect(envelope.success).toBeNull();
  });

  it("ALDRI lekker ukjente/sensitive nyttelast-felt gjennom parsingen - kun det dokumenterte trygge feltutvalget overlever", () => {
    const raw = Buffer.from(JSON.stringify({
      reference: "fin-pi-abc", name: "AUTHORIZED", amount: { value: 100, currency: "NOK" },
      userDetails: { firstName: "Kari", lastName: "Nordmann", mobileNumber: "4712345678" }
    }));
    const envelope = parseVippsEventEnvelope(raw);
    expect(JSON.stringify(envelope)).not.toContain("Nordmann");
    expect(JSON.stringify(envelope)).not.toContain("4712345678");
  });
});
