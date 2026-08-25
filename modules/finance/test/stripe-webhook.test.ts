import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseStripeEventEnvelope, verifyStripeWebhookSignature } from "../src/stripe-webhook.ts";

/**
 * D-109 (UA-6 Slice 3): rene enhetstester for signaturverifisering/envelope-
 * parsing - INGEN Postgres nødvendig (ren `node:crypto`-logikk, samme
 * "unit test det som kan enhetstestes"-prinsipp som `state-machine.test.ts`).
 */
const SECRET = "whsec_test_secret_1234567890";

function sign(payload: string, timestamp: number, secret = SECRET): string {
  const signedPayload = `${timestamp}.${payload}`;
  const sig = createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

describe("A: gyldig signatur", () => {
  it("aksepterer en korrekt signert nyttelast innenfor toleransevinduet", () => {
    const now = 1_700_000_000;
    const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", created: now }));
    const header = sign(body.toString("utf8"), now);
    const result = verifyStripeWebhookSignature(body, header, SECRET, now);
    expect(result.valid).toBe(true);
    expect(result.timestamp).toBe(now);
  });

  it("aksepterer NÅR minst én av flere v1-verdier matcher (nøkkel-rotasjon)", () => {
    const now = 1_700_000_000;
    const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "x", created: now }));
    const validSig = sign(body.toString("utf8"), now).split(",")[1];
    const header = `t=${now},v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,${validSig}`;
    const result = verifyStripeWebhookSignature(body, header, SECRET, now);
    expect(result.valid).toBe(true);
  });
});

describe("B: ugyldig signatur/manglende header", () => {
  it("avviser når Stripe-Signature-headeren mangler helt", () => {
    const result = verifyStripeWebhookSignature(Buffer.from("{}"), undefined, SECRET, 1_700_000_000);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing_signature_header");
  });

  it("avviser en malformert header (ingen t=/v1=-par)", () => {
    const result = verifyStripeWebhookSignature(Buffer.from("{}"), "garbage-no-equals", SECRET, 1_700_000_000);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("malformed_signature_header");
  });

  it("avviser når signaturen ikke matcher den faktiske kroppen (feil hemmelighet)", () => {
    const now = 1_700_000_000;
    const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "x", created: now }));
    const header = sign(body.toString("utf8"), now, "whsec_WRONG_secret");
    const result = verifyStripeWebhookSignature(body, header, SECRET, now);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("avviser når kroppen er endret ETTER signering (manipulert nyttelast)", () => {
    const now = 1_700_000_000;
    const original = JSON.stringify({ id: "evt_1", type: "x", created: now, amount: 1000 });
    const header = sign(original, now);
    const tampered = Buffer.from(JSON.stringify({ id: "evt_1", type: "x", created: now, amount: 999999 }));
    const result = verifyStripeWebhookSignature(tampered, header, SECRET, now);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("avviser en signatur med ugyldig hex-koding uten å kaste", () => {
    const now = 1_700_000_000;
    const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "x", created: now }));
    const header = `t=${now},v1=not-valid-hex-zzzz`;
    expect(() => verifyStripeWebhookSignature(body, header, SECRET, now)).not.toThrow();
    expect(verifyStripeWebhookSignature(body, header, SECRET, now).valid).toBe(false);
  });
});

describe("C: replay-/toleransevindu", () => {
  it("avviser et tidsstempel eldre enn toleransevinduet (replay-forsvar)", () => {
    const eventTime = 1_700_000_000;
    const now = eventTime + 301; // > 300s default-toleranse
    const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "x", created: eventTime }));
    const header = sign(body.toString("utf8"), eventTime);
    const result = verifyStripeWebhookSignature(body, header, SECRET, now);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timestamp_outside_tolerance");
  });

  it("aksepterer nøyaktig på toleransegrensen (300s)", () => {
    const eventTime = 1_700_000_000;
    const now = eventTime + 300;
    const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "x", created: eventTime }));
    const header = sign(body.toString("utf8"), eventTime);
    const result = verifyStripeWebhookSignature(body, header, SECRET, now);
    expect(result.valid).toBe(true);
  });

  it("respekterer en eksplisitt overstyrt toleranse-parameter", () => {
    const eventTime = 1_700_000_000;
    const now = eventTime + 10;
    const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "x", created: eventTime }));
    const header = sign(body.toString("utf8"), eventTime);
    const result = verifyStripeWebhookSignature(body, header, SECRET, now, 5);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("timestamp_outside_tolerance");
  });
});

describe("D: envelope-parsing", () => {
  it("trekker ut minimal-felt for en payment_intent-hendelse", () => {
    const raw = Buffer.from(JSON.stringify({
      id: "evt_abc", type: "payment_intent.succeeded", created: 1_700_000_000, api_version: "2024-06-20",
      data: { object: { id: "pi_123", object: "payment_intent", amount: 5000, currency: "nok", status: "succeeded" } }
    }));
    const envelope = parseStripeEventEnvelope(raw);
    expect(envelope.id).toBe("evt_abc");
    expect(envelope.object_id).toBe("pi_123");
    expect(envelope.payment_intent_ref).toBe("pi_123"); // selve PaymentIntent-objektet peker til seg selv
    expect(envelope.amount_ore).toBe(5000);
    expect(envelope.currency).toBe("NOK"); // store bokstaver, uansett Stripe sin små-bokstav-konvensjon
    expect(envelope.status).toBe("succeeded");
  });

  it("trekker ut foreldre-payment_intent-referansen for et refund-objekt (peker IKKE til seg selv)", () => {
    const raw = Buffer.from(JSON.stringify({
      id: "evt_ref", type: "refund.updated", created: 1_700_000_000,
      data: { object: { id: "re_123", object: "refund", payment_intent: "pi_parent", status: "succeeded" } }
    }));
    const envelope = parseStripeEventEnvelope(raw);
    expect(envelope.object_id).toBe("re_123");
    expect(envelope.object_type).toBe("refund");
    expect(envelope.payment_intent_ref).toBe("pi_parent");
  });

  it("henter ut last_payment_error_message og trunkerer til 500 tegn", () => {
    const longMessage = "x".repeat(600);
    const raw = Buffer.from(JSON.stringify({
      id: "evt_fail", type: "payment_intent.payment_failed", created: 1_700_000_000,
      data: { object: { id: "pi_1", object: "payment_intent", last_payment_error: { message: longMessage } } }
    }));
    const envelope = parseStripeEventEnvelope(raw);
    expect(envelope.last_payment_error_message).toHaveLength(500);
  });

  it("kaster deterministisk på en malformert envelope (mangler id/type/created) - ALDRI en gjettet form", () => {
    expect(() => parseStripeEventEnvelope(Buffer.from(JSON.stringify({ foo: "bar" })))).toThrow("stripe_event_envelope_malformed");
  });

  it("håndterer et objekt uten noen data.object gracefully (alle felt null, ingen kast)", () => {
    const raw = Buffer.from(JSON.stringify({ id: "evt_empty", type: "some.event", created: 1_700_000_000 }));
    const envelope = parseStripeEventEnvelope(raw);
    expect(envelope.object_id).toBeNull();
    expect(envelope.amount_ore).toBeNull();
    expect(envelope.payment_intent_ref).toBeNull();
  });

  it("ALDRI lagrer sensitiv betalingsmetode-data - kun det dokumenterte trygge feltutvalget overlever parsing", () => {
    const raw = Buffer.from(JSON.stringify({
      id: "evt_pm", type: "payment_intent.succeeded", created: 1_700_000_000,
      data: { object: { id: "pi_1", object: "payment_intent", amount: 100, currency: "nok", status: "succeeded", payment_method: { card: { number: "4242424242424242" } } } }
    }));
    const envelope = parseStripeEventEnvelope(raw);
    expect(JSON.stringify(envelope)).not.toContain("4242424242424242");
  });
});
