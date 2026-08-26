import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWallesterEventEnvelope, verifyWallesterWebhookBasicAuth } from "../src/wallester-webhook.ts";
import { buildWallesterJwt, computeRequestBodyHash } from "../src/wallester-transport.ts";

/**
 * D-112 (UA-6 Slice 6): rene enhetstester for Wallester webhook-Basic-
 * autentisering, envelope-parsing og JWT/rbh-forespørselskontrakten -
 * INGEN Postgres nødvendig (samme prinsipp som stripe-/vipps-/neonomics-
 * webhook.test.ts).
 */
// BEVISST lav-entropi, åpenbart falske verdier (gitleaks-lærdom fra D-109).
const USERNAME = "not-a-real-wallester-webhook-user";
const PASSWORD = "not-a-real-wallester-webhook-password";

function basicHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

describe("A: HTTP-Basic-autentisering", () => {
  it("aksepterer korrekt brukernavn/passord", () => {
    expect(verifyWallesterWebhookBasicAuth(basicHeader(USERNAME, PASSWORD), USERNAME, PASSWORD).valid).toBe(true);
  });

  it("avviser manglende Authorization-header", () => {
    const result = verifyWallesterWebhookBasicAuth(undefined, USERNAME, PASSWORD);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing_authorization_header");
  });

  it("avviser feil skjema (Bearer)", () => {
    const result = verifyWallesterWebhookBasicAuth("Bearer abc123", USERNAME, PASSWORD);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("not_basic_scheme");
  });

  it("avviser feil passord (samme lengde - konstant-tid-sammenligningen selv)", () => {
    const wrong = PASSWORD.slice(0, -1) + "X";
    const result = verifyWallesterWebhookBasicAuth(basicHeader(USERNAME, wrong), USERNAME, PASSWORD);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("credential_mismatch");
  });

  it("avviser feil credentials (annen lengde) uten å kaste", () => {
    expect(() => verifyWallesterWebhookBasicAuth(basicHeader("x", "y"), USERNAME, PASSWORD)).not.toThrow();
    expect(verifyWallesterWebhookBasicAuth(basicHeader("x", "y"), USERNAME, PASSWORD).valid).toBe(false);
  });
});

describe("B: envelope-parsing", () => {
  it("klassifiserer autorisasjonshendelse + bygger dedupe-nøkkel fra event_id når til stede", () => {
    const envelope = parseWallesterEventEnvelope(Buffer.from(JSON.stringify({
      type: "authorization.approved", event_id: "evt-1",
      data: { id: "wauth-1", card_id: "wcard-1", status: "approved", amount: 5000, currency: "EUR" }
    })));
    expect(envelope.kind).toBe("authorization");
    expect(envelope.providerObjectId).toBe("wauth-1");
    expect(envelope.providerCardId).toBe("wcard-1");
    expect(envelope.dedupeKey).toBe("evt-1");
  });

  it("uten event_id: deterministisk Jarvis-utledet dedupe-nøkkel (type:objekt-id:status)", () => {
    const envelope = parseWallesterEventEnvelope(Buffer.from(JSON.stringify({
      type: "transaction.settled", data: { id: "wtx-1", card_id: "wcard-1", status: "settled" }
    })));
    expect(envelope.kind).toBe("transaction");
    expect(envelope.dedupeKey).toBe("transaction.settled:wtx-1:settled");
  });

  it("samme objekt med NY status gir NY dedupe-nøkkel (statusprogresjon dedupes aldri bort)", () => {
    const a = parseWallesterEventEnvelope(Buffer.from(JSON.stringify({ type: "card.status", data: { id: "wcard-2", status: "active" } })));
    const b = parseWallesterEventEnvelope(Buffer.from(JSON.stringify({ type: "card.status", data: { id: "wcard-2", status: "blocked" } })));
    expect(a.kind).toBe("card");
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it("kaster deterministisk på malformert envelope (mangler type / mangler objekt-id / ugyldig JSON)", () => {
    expect(() => parseWallesterEventEnvelope(Buffer.from(JSON.stringify({ data: { id: "x" } })))).toThrow("wallester_event_envelope_malformed:missing_type");
    expect(() => parseWallesterEventEnvelope(Buffer.from(JSON.stringify({ type: "card.status", data: {} })))).toThrow("wallester_event_envelope_malformed:missing_object_id");
    expect(() => parseWallesterEventEnvelope(Buffer.from("ikke-json"))).toThrow("wallester_event_envelope_malformed:invalid_json");
  });
});

describe("C: JWT/rbh-forespørselskontrakten (RS256)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });

  it("rbh er base64 av BINÆR sha256 av kroppen (eksplisitt IKKE hex)", () => {
    const body = JSON.stringify({ name: "Testkort" });
    expect(computeRequestBodyHash(body)).toBe(createHash("sha256").update(body, "utf8").digest("base64"));
    expect(computeRequestBodyHash(body)).not.toBe(createHash("sha256").update(body, "utf8").digest("hex"));
  });

  it("bygger et strukturelt gyldig RS256-JWT med iss/aud/sub/exp/rbh-claims", () => {
    const body = JSON.stringify({ type: "virtual" });
    const jwt = buildWallesterJwt({ issuer: "fake-issuer", audience: "wallester", privateKeyPem: privateKey, body, nowEpochSeconds: 1_700_000_000 });
    const [header, payload, signature] = jwt.split(".");
    expect(signature).toBeTruthy();
    expect(JSON.parse(Buffer.from(header!, "base64url").toString("utf8"))).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims["iss"]).toBe("fake-issuer");
    expect(claims["aud"]).toBe("wallester");
    expect(claims["sub"]).toBe("fake-issuer");
    expect(claims["exp"]).toBe(1_700_000_060);
    expect(claims["rbh"]).toBe(computeRequestBodyHash(body));
  });

  it("signaturen verifiserer mot den tilhørende OFFENTLIGE nøkkelen (og avviser en annen kropp)", () => {
    const body = "";
    const jwt = buildWallesterJwt({ issuer: "fake-issuer", audience: "wallester", privateKeyPem: privateKey, body, nowEpochSeconds: 1_700_000_000 });
    const [header, payload, signature] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256").update(`${header}.${payload}`, "utf8");
    expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    const tampered = createVerify("RSA-SHA256").update(`${header}.${Buffer.from("{}").toString("base64url")}`, "utf8");
    expect(tampered.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(false);
  });
});
