import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { FinanceService } from "../src/service.ts";
import type { BankingService } from "../src/banking-service.ts";
import { NeonomicsFinanceTransport } from "../src/neonomics-tool-transport.ts";

/**
 * D-111 (UA-6 Slice 5): rene wiring-/orkestreringstester (INGEN embedded
 * Postgres - SAMME mønster som stripe-/vipps-transport-wiring.test.ts).
 * Selve pengebevegelsen (PIS-innsending) bor i `finance.submit_payment_intent`
 * (provider-dispatchet, allerede klasse C + kill-switch-gated) - derfor har
 * `finance_neonomics.*` INGEN egen klasse D-handling; `revoke_consent` er C
 * (fjerner reell banktilgang), resten A/B.
 */
function neonomicsTransport(): NeonomicsFinanceTransport {
  return new NeonomicsFinanceTransport({} as unknown as BankingService, {} as unknown as FinanceService);
}

describe("A: finance_neonomics.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("finner alle 19 finance_neonomics.*-handlinger og peker til neonomics-transporten", () => {
    const transport = neonomicsTransport();
    const tools = firstWaveTools({ finance_neonomics: transport });
    const neoTools = tools.filter((t) => t.tool_id === "finance_neonomics");
    expect(neoTools.length).toBe(19);
    expect(neoTools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "list_banks", "create_consent", "get_consent_authorization_url", "complete_consent_callback",
        "get_consent", "list_consents", "verify_consent", "revoke_consent",
        "sync_accounts", "list_bank_accounts", "sync_balances", "list_balances",
        "sync_transactions", "list_bank_transactions", "reconcile_bank_transactions", "run_bank_anomaly_detection",
        "refresh_payment_state", "get_payment_authorization_url", "run_provider_anomaly_detection"
      ])
    );
    for (const tool of neoTools) expect(tool.transport).toBe(transport);
  });
});

describe("B: risikoklasser speiler reell økonomisk risiko", () => {
  const tools = () => firstWaveTools({ finance_neonomics: neonomicsTransport() }).filter((t) => t.tool_id === "finance_neonomics");

  it("rene lesinger er A, Jarvis-tilstandsmutasjoner B, samtykke-tilbakekalling C - ingen egen D (PIS-submit bor i finance.*)", () => {
    const byAction = Object.fromEntries(tools().map((t) => [t.action, t.capability_class]));
    expect(byAction["list_banks"]).toBe("A");
    expect(byAction["get_consent"]).toBe("A");
    expect(byAction["list_consents"]).toBe("A");
    expect(byAction["list_bank_accounts"]).toBe("A");
    expect(byAction["list_balances"]).toBe("A");
    expect(byAction["list_bank_transactions"]).toBe("A");
    expect(byAction["create_consent"]).toBe("B");
    expect(byAction["sync_accounts"]).toBe("B");
    expect(byAction["sync_transactions"]).toBe("B");
    expect(byAction["reconcile_bank_transactions"]).toBe("B");
    expect(byAction["refresh_payment_state"]).toBe("B");
    expect(byAction["get_payment_authorization_url"]).toBe("B");
    expect(byAction["revoke_consent"]).toBe("C");
    expect(tools().some((t) => t.capability_class === "D")).toBe(false);
  });

  it("provider-berørende handlinger bruker JARVIS_NEONOMICS_CLIENT_SECRET som credential_ref; ingen handling mangler credential_ref", () => {
    const byAction = Object.fromEntries(tools().map((t) => [t.action, t.credential_ref]));
    expect(byAction["create_consent"]).toBe("JARVIS_NEONOMICS_CLIENT_SECRET");
    expect(byAction["sync_accounts"]).toBe("JARVIS_NEONOMICS_CLIENT_SECRET");
    expect(byAction["sync_transactions"]).toBe("JARVIS_NEONOMICS_CLIENT_SECRET");
    expect(byAction["refresh_payment_state"]).toBe("JARVIS_NEONOMICS_CLIENT_SECRET");
    for (const tool of tools()) expect(tool.credential_ref).toBeTruthy();
  });
});

describe("C: NeonomicsFinanceTransport.invoke() dispatch", () => {
  it("kaster en tydelig feil for en ukjent handling (fail-closed, aldri en stille default)", async () => {
    await expect(neonomicsTransport().invoke("does_not_exist", { tenant_id: "t" })).rejects.toThrow("finance_neonomics_action_not_implemented:does_not_exist");
  });
  it("kaster en tydelig feil når tenant_id mangler", async () => {
    await expect(neonomicsTransport().invoke("get_consent", { consent_id: "x" })).rejects.toThrow("finance_neonomics_missing_parameter:tenant_id");
  });
  it("kaster en tydelig feil når et påkrevd parameter mangler (consent_id)", async () => {
    await expect(neonomicsTransport().invoke("sync_accounts", { tenant_id: "t" })).rejects.toThrow("finance_neonomics_missing_parameter:consent_id");
  });
});

describe("D: finance.create_payment_intent aksepterer provider='neonomics'", () => {
  it("finance.*-namespacet sitt create_payment_intent-skjema tillater provider='neonomics' og avviser en ukjent provider", () => {
    const tools = firstWaveTools({});
    const createPaymentIntent = tools.find((t) => t.tool_id === "finance" && t.action === "create_payment_intent");
    expect(createPaymentIntent).toBeDefined();
    expect(createPaymentIntent!.input_schema.safeParse({
      tenant_id: "t", idempotency_key: "k", purpose: "p", amount_ore: 100, vendor_name: "v", account_code: "cat", provider: "neonomics"
    }).success).toBe(true);
    expect(createPaymentIntent!.input_schema.safeParse({
      tenant_id: "t", idempotency_key: "k", purpose: "p", amount_ore: 100, vendor_name: "v", account_code: "cat", provider: "paypal"
    }).success).toBe(false);
  });
});
