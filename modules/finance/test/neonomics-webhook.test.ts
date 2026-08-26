import { describe, expect, it } from "vitest";
import { parseNeonomicsEventEnvelope, verifyNeonomicsWebhookApiKey } from "../src/neonomics-webhook.ts";
import { decimalToMinorUnits } from "../src/neonomics-transport.ts";

/**
 * D-111 (UA-6 Slice 5): rene enhetstester for Neonomics webhook-API-nøkkel-
 * autentisering, envelope-parsing og eksakt desimal->øre-konvertering -
 * INGEN Postgres nødvendig (samme prinsipp som stripe-/vipps-webhook.test.ts).
 */
// BEVISST lav-entropi, åpenbart falsk verdi (gitleaks-lærdom fra D-109).
const API_KEY = "not-a-real-neonomics-webhook-api-key";

describe("A: API-nøkkel-autentisering", () => {
  it("aksepterer korrekt nøkkel", () => {
    expect(verifyNeonomicsWebhookApiKey(API_KEY, API_KEY).valid).toBe(true);
  });

  it("avviser manglende nøkkel-header", () => {
    const result = verifyNeonomicsWebhookApiKey(undefined, API_KEY);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing_api_key_header");
  });

  it("avviser feil nøkkel (samme lengde - konstant-tid-sammenligningen selv)", () => {
    const wrong = API_KEY.slice(0, -1) + "X";
    const result = verifyNeonomicsWebhookApiKey(wrong, API_KEY);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("api_key_mismatch");
  });

  it("avviser feil nøkkel (annen lengde) uten å kaste", () => {
    expect(() => verifyNeonomicsWebhookApiKey("short", API_KEY)).not.toThrow();
    expect(verifyNeonomicsWebhookApiKey("short", API_KEY).valid).toBe(false);
  });
});

describe("B: envelope-parsing", () => {
  it("trekker ut paymentId/status og bygger deterministisk dedupe-nøkkel", () => {
    const envelope = parseNeonomicsEventEnvelope(Buffer.from(JSON.stringify({ paymentId: "neo-pay-1", status: "ACSC" })));
    expect(envelope.paymentId).toBe("neo-pay-1");
    expect(envelope.status).toBe("ACSC");
    expect(envelope.dedupeKey).toBe("neo-pay-1:ACSC");
  });

  it("faller tilbake til 'id'-feltet når 'paymentId' mangler", () => {
    const envelope = parseNeonomicsEventEnvelope(Buffer.from(JSON.stringify({ id: "neo-pay-2", status: "RJCT" })));
    expect(envelope.paymentId).toBe("neo-pay-2");
  });

  it("kaster deterministisk på malformert envelope (mangler status)", () => {
    expect(() => parseNeonomicsEventEnvelope(Buffer.from(JSON.stringify({ paymentId: "neo-pay-3" })))).toThrow("neonomics_event_envelope_malformed");
  });

  it("kaster deterministisk på malformert envelope (mangler id helt)", () => {
    expect(() => parseNeonomicsEventEnvelope(Buffer.from(JSON.stringify({ status: "ACSC" })))).toThrow("neonomics_event_envelope_malformed");
  });

  it("samme betaling med NY status gir NY dedupe-nøkkel (statusprogresjon dedupes aldri bort)", () => {
    const a = parseNeonomicsEventEnvelope(Buffer.from(JSON.stringify({ paymentId: "neo-pay-4", status: "PDNG" })));
    const b = parseNeonomicsEventEnvelope(Buffer.from(JSON.stringify({ paymentId: "neo-pay-4", status: "ACSC" })));
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });
});

describe("C: eksakt desimal->øre (aldri flyttall-pengearitmetikk)", () => {
  it("konverterer heltall og to desimaler eksakt", () => {
    expect(decimalToMinorUnits("100")).toBe(10_000);
    expect(decimalToMinorUnits("100.50")).toBe(10_050);
    expect(decimalToMinorUnits("0.01")).toBe(1);
  });

  it("håndterer én desimal (padder til øre)", () => {
    expect(decimalToMinorUnits("99.5")).toBe(9_950);
  });

  it("bevarer negativt fortegn (retningsgrunnlaget for debet/kredit)", () => {
    expect(decimalToMinorUnits("-123.45")).toBe(-12_345);
  });

  it("håndterer det klassiske flyttall-fellebeløpet eksakt (19.99 -> 1999, aldri 1998.9999...)", () => {
    expect(decimalToMinorUnits("19.99")).toBe(1_999);
  });

  it("kaster på mer enn 2 desimaler (ingen stille avrunding av penger)", () => {
    expect(() => decimalToMinorUnits("1.234")).toThrow("neonomics_unparseable_amount");
  });

  it("kaster på uparsbar verdi", () => {
    expect(() => decimalToMinorUnits("ikke-et-tall")).toThrow("neonomics_unparseable_amount");
  });
});
