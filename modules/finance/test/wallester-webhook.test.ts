import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWallesterEventEnvelope, verifyWallesterWebhookBasicAuth } from "../src/wallester-webhook.ts";
import { WallesterApiError, buildWallesterBusinessJwt, createRsaJwtSigner, WallesterTransport } from "../src/wallester-transport.ts";
import type { CreateWallesterCardInput } from "../src/wallester-transport.ts";

/**
 * D-112 (UA-6 Slice 6), korrigert owner-provided primary-source-audit
 * (PR #62 runde 4): rene enhetstester for Wallester webhook-Basic-
 * autentisering, envelope-parsing og den korrigerte Wallester Business
 * api_key/ts-JWT-forespørselskontrakten - INGEN Postgres nødvendig (samme
 * prinsipp som stripe-/vipps-/neonomics-webhook.test.ts).
 *
 * PRIMARY_SOURCE_EVIDENCE_MODE=OWNER_PROVIDED_PRIMARY_SOURCE_AUDIT for
 * envelope-/auth-kontrakten under (seksjon B/C/D) - se wallester-
 * transport.ts filhode for full sourcing-forklaring. Seksjon A (HTTP Basic)
 * er UENDRET og fortsatt korrekt.
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

describe("B: envelope-parsing (owner-provided Business-konvolutt: event/type-skillet)", () => {
  it("klassifiserer autorisasjonshendelse + bygger dedupe-nøkkel fra event_id når til stede", () => {
    const envelope = parseWallesterEventEnvelope(Buffer.from(JSON.stringify({
      event: "notification", type: "authorization", event_id: "evt-1",
      data: { id: "wauth-1", card_id: "wcard-1", status: "approved", amount: 5000, currency: "EUR" }
    })));
    expect(envelope.kind).toBe("authorization");
    expect(envelope.providerObjectId).toBe("wauth-1");
    expect(envelope.providerCardId).toBe("wcard-1");
    expect(envelope.dedupeKey).toBe("evt-1");
  });

  it("klassifiserer authorization_release DISTINKT fra authorization", () => {
    const envelope = parseWallesterEventEnvelope(Buffer.from(JSON.stringify({
      event: "notification", type: "authorization_release", event_id: "evt-release-1",
      data: { id: "wauth-1", card_id: "wcard-1", status: "reversed" }
    })));
    expect(envelope.kind).toBe("authorization_release");
  });

  it("uten event_id: deterministisk Jarvis-utledet dedupe-nøkkel (type:objekt-id:status)", () => {
    const envelope = parseWallesterEventEnvelope(Buffer.from(JSON.stringify({
      event: "notification", type: "transaction", data: { id: "wtx-1", card_id: "wcard-1", status: "settled" }
    })));
    expect(envelope.kind).toBe("transaction");
    expect(envelope.dedupeKey).toBe("transaction:wtx-1:settled");
  });

  it("samme objekt med NY status gir NY dedupe-nøkkel (statusprogresjon dedupes aldri bort)", () => {
    const a = parseWallesterEventEnvelope(Buffer.from(JSON.stringify({ event: "notification", type: "card", data: { id: "wcard-2", status: "active" } })));
    const b = parseWallesterEventEnvelope(Buffer.from(JSON.stringify({ event: "notification", type: "card", data: { id: "wcard-2", status: "blocked" } })));
    expect(a.kind).toBe("card");
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it("ukjent `type`-verdi klassifiseres 'unknown' - fail-safe, aldri gjettet til en kjent klasse", () => {
    const envelope = parseWallesterEventEnvelope(Buffer.from(JSON.stringify({
      event: "notification", type: "noe_helt_ukjent", data: { id: "x-1", status: "?" }
    })));
    expect(envelope.kind).toBe("unknown");
  });

  it("avviser en uventet `event`-konvoluttmarkør (IKKE 'notification') - fail-safe", () => {
    expect(() => parseWallesterEventEnvelope(Buffer.from(JSON.stringify({
      event: "something_else", type: "authorization", data: { id: "x-1" }
    })))).toThrow("wallester_event_envelope_malformed:unexpected_envelope_event");
  });

  it("kaster deterministisk på malformert envelope (mangler event / mangler type / mangler objekt-id / ugyldig JSON)", () => {
    expect(() => parseWallesterEventEnvelope(Buffer.from(JSON.stringify({ type: "card", data: { id: "x" } })))).toThrow("wallester_event_envelope_malformed:unexpected_envelope_event");
    expect(() => parseWallesterEventEnvelope(Buffer.from(JSON.stringify({ event: "notification", data: { id: "x" } })))).toThrow("wallester_event_envelope_malformed:missing_type");
    expect(() => parseWallesterEventEnvelope(Buffer.from(JSON.stringify({ event: "notification", type: "card", data: {} })))).toThrow("wallester_event_envelope_malformed:missing_object_id");
    expect(() => parseWallesterEventEnvelope(Buffer.from("ikke-json"))).toThrow("wallester_event_envelope_malformed:invalid_json");
  });
});

describe("C: Wallester Business api_key/ts-JWT-forespørselskontrakten (RS256) - owner-provided primary-source-audit, PR #62 runde 4", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const sign = createRsaJwtSigner(privateKey);

  it("bygger et strukturelt gyldig RS256-JWT med KUN api_key/ts-claims - IKKE iss/aud/sub/exp/rbh (Wallester Card API-modellen gjaldt en ANNEN produkt-grense)", () => {
    const jwt = buildWallesterBusinessJwt({ apiKey: "wba-fake-key", sign, nowEpochSeconds: 1_700_000_000 });
    const [header, payload, signature] = jwt.split(".");
    expect(signature).toBeTruthy();
    expect(JSON.parse(Buffer.from(header!, "base64url").toString("utf8"))).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims["api_key"]).toBe("wba-fake-key");
    expect(claims["ts"]).toBe(1_700_000_000);
    expect(claims).not.toHaveProperty("iss");
    expect(claims).not.toHaveProperty("aud");
    expect(claims).not.toHaveProperty("sub");
    expect(claims).not.toHaveProperty("exp");
    expect(claims).not.toHaveProperty("rbh");
  });

  it("bruker den injiserte `sign`-funksjonen (signeringsmekanismen er BEVISST injiserbar - BUSINESS_AUTH_SIGNING_MATERIAL=PRIMARY_SOURCE_PUBLIC_DOC_GAP)", () => {
    let signCalls = 0;
    const spySign = (input: string) => {
      signCalls++;
      return sign(input);
    };
    buildWallesterBusinessJwt({ apiKey: "wba-fake-key", sign: spySign, nowEpochSeconds: 1_700_000_000 });
    expect(signCalls).toBe(1);
  });
});

describe("D: WallesterTransport - api_key/ts-tråd-kontrakten (owner-provided primary-source-audit, PR #62 runde 4)", () => {
  const { privateKey: transportPrivateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const transportSign = createRsaJwtSigner(transportPrivateKey);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sender 'Authorization: Bearer <jwt>' med api_key/ts-claims - INGEN X-Product-Code (den headeren gjaldt Wallester Card API, en ANNEN produkt-grense)", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        capturedHeaders = init.headers;
        return new Response(JSON.stringify({ id: "wcard-1", status: "active" }), { status: 200 });
      })
    );
    const transport = new WallesterTransport("https://sandbox.example", "wba-fake-key", transportSign, "wacc-1");
    await transport.getCard("wcard-1");
    expect(capturedHeaders?.["authorization"]).toMatch(/^Bearer eyJ/);
    expect(capturedHeaders).not.toHaveProperty("x-product-code");
    expect(capturedHeaders).not.toHaveProperty("X-Product-Code");
    const rawJwt = capturedHeaders!["authorization"]!.slice("Bearer ".length);
    const [, payload] = rawJwt.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims["api_key"]).toBe("wba-fake-key");
    expect(typeof claims["ts"]).toBe("number");
  });

  it("bygger en FERSK JWT per kall (ts reflekterer kalltidspunktet, ikke en gjenbrukt token)", async () => {
    const capturedTimestamps: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        const rawJwt = init.headers["authorization"]!.slice("Bearer ".length);
        const [, payload] = rawJwt.split(".");
        const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
        capturedTimestamps.push(claims["ts"] as number);
        return new Response(JSON.stringify({ id: "wcard-1", status: "active" }), { status: 200 });
      })
    );
    const transport = new WallesterTransport("https://sandbox.example", "wba-fake-key", transportSign, "wacc-1");
    await transport.getCard("wcard-1");
    await transport.getCard("wcard-1");
    expect(capturedTimestamps).toHaveLength(2);
    expect(capturedTimestamps.every((ts) => Number.isInteger(ts) && ts > 0)).toBe(true);
  });
});

describe("E: WallesterTransport - kort-/grense-/sikkerhets-wire-kontrakten (owner-provided primary-source-audit, PR #62 runde 4)", () => {
  const { privateKey: e2ePrivateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const e2eSign = createRsaJwtSigner(e2ePrivateKey);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fysisk kort (ChipAndPin) er FAIL-CLOSED - INGEN HTTP-kall (Jarvis samler ikke inn utleverings-/embossing-felt i denne sliceen)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const transport = new WallesterTransport("https://sandbox.example", "wba-fake-key", e2eSign, "wacc-1");
    const input: CreateWallesterCardInput = {
      externalReference: "card-1", name: "Fysisk", type: "physical", currency: "EUR", cardholderName: null,
      limits: { transactionLimitOre: null, dailyLimitOre: null, weeklyLimitOre: null, monthlyLimitOre: null, atmEnabled: false, onlineEnabled: true, contactlessEnabled: true }
    };
    await expect(transport.createCard(input)).rejects.toThrow(WallesterApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("virtuelt kort sendes med type=Virtual/is_disposable - INGEN X-Product-Code/X-Audit-*-headere (Wallester Card API-headere, annen produkt-grense)", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
        capturedHeaders = init.headers;
        return new Response(JSON.stringify({ id: "wcard-1", status: "active" }), { status: 200 });
      })
    );
    const transport = new WallesterTransport("https://sandbox.example", "wba-fake-key", e2eSign, "wacc-1");
    const input: CreateWallesterCardInput = {
      externalReference: "card-1", name: "Virtuelt", type: "virtual", currency: "EUR", cardholderName: null,
      limits: { transactionLimitOre: null, dailyLimitOre: null, weeklyLimitOre: null, monthlyLimitOre: null, atmEnabled: false, onlineEnabled: true, contactlessEnabled: true }
    };
    await transport.createCard(input);
    expect(capturedBody?.["type"]).toBe("Virtual");
    expect(capturedBody?.["is_disposable"]).toBe(false);
    expect(capturedBody?.["account_id"]).toBe("wacc-1");
    expect(capturedHeaders).not.toHaveProperty("x-product-code");
    expect(capturedHeaders).not.toHaveProperty("x-audit-source-type");
    expect(capturedHeaders).not.toHaveProperty("x-audit-user-id");
  });

  it("aktiver/blokker/lukk bruker PATCH - IKKE POST", async () => {
    const capturedMethods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { method: string }) => {
        capturedMethods.push(init.method);
        return new Response(JSON.stringify({ id: "wcard-1", status: "active" }), { status: 200 });
      })
    );
    const transport = new WallesterTransport("https://sandbox.example", "wba-fake-key", e2eSign, "wacc-1");
    await transport.activateCard("wcard-1");
    await transport.blockCard("wcard-1");
    await transport.unblockCard("wcard-1");
    await transport.closeCard("wcard-1");
    expect(capturedMethods).toEqual(["PATCH", "PATCH", "PATCH", "PATCH"]);
  });

  it("updateCardLimits gjør TO PATCH-kall (limits + security) - separate endepunkter (owner-provided Business-kontrakt)", async () => {
    const capturedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrls.push(url);
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );
    const transport = new WallesterTransport("https://sandbox.example", "wba-fake-key", e2eSign, "wacc-1");
    await transport.updateCardLimits("wcard-1", { transactionLimitOre: 10_000, dailyLimitOre: null, weeklyLimitOre: null, monthlyLimitOre: null, atmEnabled: false, onlineEnabled: true, contactlessEnabled: true });
    expect(capturedUrls.some((u) => u.includes("/limits"))).toBe(true);
    expect(capturedUrls.some((u) => u.includes("/security"))).toBe(true);
    expect(capturedUrls).toHaveLength(2);
  });

  it("kontosaldo hentes fra GET /v1/accounts/{account_id} - IKKE et globalt /v1/accounts/balance-endepunkt", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ available_amount: 12_345, currency: "EUR" }), { status: 200 });
      })
    );
    const transport = new WallesterTransport("https://sandbox.example", "wba-fake-key", e2eSign, "wacc-42");
    const balance = await transport.getAccountBalance();
    expect(capturedUrl).toContain("/v1/accounts/wacc-42");
    expect(capturedUrl).not.toContain("/v1/accounts/balance");
    expect(balance.accountId).toBe("wacc-42");
  });

  it("paginering bruker from_record/records_count - IKKE en page-token-parameter", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = url;
        // WP-FIN2 (K7): en manglende `transactions`-liste er et ugyldig svar (ikke en stille tom side) - fiksturen bærer en tom liste.
        return new Response(JSON.stringify({ transactions: [] }), { status: 200 });
      })
    );
    const transport = new WallesterTransport("https://sandbox.example", "wba-fake-key", e2eSign, "wacc-1");
    await transport.listTransactions("wcard-1", "50");
    expect(capturedUrl).toContain("from_record=50");
    expect(capturedUrl).toContain("records_count=");
    expect(capturedUrl).not.toContain("page=");
  });

  it("ukjent autorisasjonsstatus/transaksjonstype mappes 'unknown' ved wire-mapping - ALDRI stille 'approved'/'purchase' (fail-safe)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("authorizations")) {
          return new Response(JSON.stringify({ authorizations: [{ id: "wauth-1", card_id: "wcard-1", status: "en_helt_ukjent_status", amount: 100, currency: "EUR" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ transactions: [{ id: "wtx-1", card_id: "wcard-1", type: "en_helt_ukjent_type", amount: 100, currency: "EUR" }] }), { status: 200 });
      })
    );
    const transport = new WallesterTransport("https://sandbox.example", "wba-fake-key", e2eSign, "wacc-1");
    const auths = await transport.listAuthorizations("wcard-1", null);
    const txs = await transport.listTransactions("wcard-1", null);
    expect(auths.items[0]!.status).toBe("unknown");
    expect(txs.items[0]!.type).toBe("unknown");
  });
});
