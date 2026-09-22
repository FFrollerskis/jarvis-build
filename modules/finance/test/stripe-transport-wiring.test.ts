import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { FinanceService } from "../src/service.ts";
import { StripeFinanceTransport } from "../src/stripe-tool-transport.ts";

/**
 * D-109 (UA-6 Slice 3): rene wiring-/orkestreringstester (INGEN embedded
 * Postgres - `FinanceService` er en fake, SAMME mønster som
 * `transport-wiring.test.ts` D-107). Beviser `finance_stripe.*`-
 * registrering/risikoklasser - `submit_refund` er den ENESTE ekte
 * leverandørmutasjonen (klasse D, kill-switch-gated), ALT annet er
 * klasse A (lesing/oppfrisking) eller B (ren intern draft-tilstand/
 * avviksdeteksjon).
 */
describe("A: finance_stripe.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("finner alle 8 finance_stripe.*-handlinger og peker til stripe-transporten", () => {
    const stripeTransport = new StripeFinanceTransport({} as unknown as FinanceService);
    const tools = firstWaveTools({ finance_stripe: stripeTransport });
    const stripeTools = tools.filter((t) => t.tool_id === "finance_stripe");
    expect(stripeTools.length).toBe(8);
    expect(stripeTools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "request_refund", "submit_refund", "get_refund", "list_refunds",
        "refresh_payment_state", "get_webhook_event", "run_provider_anomaly_detection",
        // D-242: connector-helsesjekk-probe.
        "get_balance"
      ])
    );
    for (const tool of stripeTools) expect(tool.transport).toBe(stripeTransport);
  });
});

describe("B: risikoklasser - kun ekte leverandørmutasjon er klasse D", () => {
  it("lesing/oppfrisking er klasse A, draft/avviksdeteksjon klasse B, submit_refund klasse D", () => {
    const tools = firstWaveTools({ finance_stripe: new StripeFinanceTransport({} as unknown as FinanceService) }).filter((t) => t.tool_id === "finance_stripe");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction["get_refund"]).toBe("A");
    expect(byAction["list_refunds"]).toBe("A");
    expect(byAction["refresh_payment_state"]).toBe("A");
    expect(byAction["get_webhook_event"]).toBe("A");
    // D-242: connector-helsesjekk-probe - ren lesing, klasse A.
    expect(byAction["get_balance"]).toBe("A");
    expect(byAction["request_refund"]).toBe("B");
    expect(byAction["run_provider_anomaly_detection"]).toBe("B");
    // Den ENESTE handlingen som faktisk sender en refusjon til Stripe.
    expect(byAction["submit_refund"]).toBe("D");
  });

  it("submit_refund bruker JARVIS_STRIPE_SECRET_KEY som credential_ref (IKKE den generiske interne sentinel-tokenen)", () => {
    const tools = firstWaveTools({ finance_stripe: new StripeFinanceTransport({} as unknown as FinanceService) }).filter((t) => t.tool_id === "finance_stripe");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.credential_ref]));
    expect(byAction["submit_refund"]).toBe("JARVIS_STRIPE_SECRET_KEY");
    expect(byAction["refresh_payment_state"]).toBe("JARVIS_STRIPE_SECRET_KEY");
  });

  it("ingen finance_stripe.*-handling mangler credential_ref (fail-closed konfigurert)", () => {
    const tools = firstWaveTools({ finance_stripe: new StripeFinanceTransport({} as unknown as FinanceService) }).filter((t) => t.tool_id === "finance_stripe");
    for (const tool of tools) expect(tool.credential_ref).toBeTruthy();
  });
});

describe("C: StripeFinanceTransport.invoke() dispatch", () => {
  it("kaster en tydelig feil for en ukjent handling (fail-closed, aldri en stille default)", async () => {
    const transport = new StripeFinanceTransport({} as unknown as FinanceService);
    await expect(transport.invoke("does_not_exist", { tenant_id: "t" })).rejects.toThrow("finance_stripe_action_not_implemented:does_not_exist");
  });
  it("kaster en tydelig feil når tenant_id mangler", async () => {
    const transport = new StripeFinanceTransport({} as unknown as FinanceService);
    await expect(transport.invoke("get_refund", { refund_id: "x" })).rejects.toThrow("finance_stripe_missing_parameter:tenant_id");
  });
  it("kaster en tydelig feil når et påkrevd tall-parameter mangler (amount_ore)", async () => {
    const transport = new StripeFinanceTransport({} as unknown as FinanceService);
    await expect(
      transport.invoke("request_refund", { tenant_id: "t", idempotency_key: "k", payment_intent_id: "p" })
    ).rejects.toThrow("finance_stripe_missing_parameter:amount_ore");
  });
});

describe("D: finance.create_payment_intent aksepterer et valgfritt provider-felt uten å bryte eksisterende Fiken-kallere", () => {
  it("finance.*-namespacet sitt create_payment_intent-skjema tillater provider='stripe'", () => {
    const tools = firstWaveTools({});
    const createPaymentIntent = tools.find((t) => t.tool_id === "finance" && t.action === "create_payment_intent");
    expect(createPaymentIntent).toBeDefined();
    const parsed = createPaymentIntent!.input_schema.safeParse({
      tenant_id: "t", idempotency_key: "k", purpose: "p", amount_ore: 100, vendor_name: "v", account_code: "cat", provider: "stripe"
    });
    expect(parsed.success).toBe(true);
  });
  it("avviser en ugyldig provider-verdi (fail-closed, ikke stille ignorert)", () => {
    const tools = firstWaveTools({});
    const createPaymentIntent = tools.find((t) => t.tool_id === "finance" && t.action === "create_payment_intent");
    // D-110: 'vipps' er nå en EKTE bygget provider (Slice 4) og aksepteres -
    // en genuint ustøttet verdi brukes i stedet for å bevise fail-closed.
    const parsed = createPaymentIntent!.input_schema.safeParse({
      tenant_id: "t", idempotency_key: "k", purpose: "p", amount_ore: 100, vendor_name: "v", account_code: "cat", provider: "paypal"
    });
    expect(parsed.success).toBe(false);
  });
});
