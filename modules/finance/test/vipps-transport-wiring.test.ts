import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { FinanceService } from "../src/service.ts";
import { VippsFinanceTransport } from "../src/vipps-tool-transport.ts";

/**
 * D-110 (UA-6 Slice 4): rene wiring-/orkestreringstester (INGEN embedded
 * Postgres - SAMME mønster som `stripe-transport-wiring.test.ts` D-109).
 * Beviser `finance_vipps.*`-registrering/risikoklasser - `submit_capture`/
 * `submit_refund` er de EKTE leverandørmutasjonene som flytter penger
 * (klasse D, kill-switch-gated), `cancel_payment` er klasse C (rører kun
 * en IKKE-oppgjort reservasjon), resten A/B.
 */
describe("A: finance_vipps.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("finner alle 15 finance_vipps.*-handlinger og peker til vipps-transporten", () => {
    const vippsTransport = new VippsFinanceTransport({} as unknown as FinanceService);
    const tools = firstWaveTools({ finance_vipps: vippsTransport });
    const vippsTools = tools.filter((t) => t.tool_id === "finance_vipps");
    expect(vippsTools.length).toBe(15);
    expect(vippsTools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "request_capture", "submit_capture", "get_capture", "list_captures",
        "cancel_payment", "request_refund", "submit_refund", "get_refund", "list_refunds",
        "refresh_payment_state", "get_webhook_event", "run_provider_anomaly_detection",
        // D-242: connector-helsesjekk-probe.
        "check_credentials",
        // WP-F1 (D-453): fersk, read-only tilstandslesing for klasse D-kjeden (preflight + readback for submit_capture/submit_refund).
        "check_submit_capture", "check_submit_refund"
      ])
    );
    for (const tool of vippsTools) expect(tool.transport).toBe(vippsTransport);
  });
});

describe("B: risikoklasser - pengebevegende mutasjoner er klasse D, reservasjons-kansellering C", () => {
  const tools = () => firstWaveTools({ finance_vipps: new VippsFinanceTransport({} as unknown as FinanceService) }).filter((t) => t.tool_id === "finance_vipps");

  it("lesing/oppfrisking er A, drafts/avviksdeteksjon B, cancel C, capture/refund-submit D", () => {
    const byAction = Object.fromEntries(tools().map((t) => [t.action, t.capability_class]));
    expect(byAction["get_capture"]).toBe("A");
    expect(byAction["list_captures"]).toBe("A");
    expect(byAction["get_refund"]).toBe("A");
    expect(byAction["list_refunds"]).toBe("A");
    expect(byAction["refresh_payment_state"]).toBe("A");
    expect(byAction["get_webhook_event"]).toBe("A");
    // D-242: connector-helsesjekk-probe - ren lesing, klasse A.
    expect(byAction["check_credentials"]).toBe("A");
    expect(byAction["request_capture"]).toBe("B");
    expect(byAction["request_refund"]).toBe("B");
    expect(byAction["run_provider_anomaly_detection"]).toBe("B");
    expect(byAction["cancel_payment"]).toBe("C");
    // WP-F1: de ferske tilstandslesingene er ren lesing (klasse A).
    expect(byAction["check_submit_capture"]).toBe("A");
    expect(byAction["check_submit_refund"]).toBe("A");
    expect(byAction["submit_capture"]).toBe("D");
    expect(byAction["submit_refund"]).toBe("D");
  });

  it("provider-mutasjonene bruker JARVIS_VIPPS_CLIENT_SECRET som credential_ref", () => {
    const byAction = Object.fromEntries(tools().map((t) => [t.action, t.credential_ref]));
    expect(byAction["submit_capture"]).toBe("JARVIS_VIPPS_CLIENT_SECRET");
    expect(byAction["submit_refund"]).toBe("JARVIS_VIPPS_CLIENT_SECRET");
    expect(byAction["cancel_payment"]).toBe("JARVIS_VIPPS_CLIENT_SECRET");
    expect(byAction["refresh_payment_state"]).toBe("JARVIS_VIPPS_CLIENT_SECRET");
  });

  it("ingen finance_vipps.*-handling mangler credential_ref (fail-closed konfigurert)", () => {
    for (const tool of tools()) expect(tool.credential_ref).toBeTruthy();
  });
});

describe("C: VippsFinanceTransport.invoke() dispatch", () => {
  it("kaster en tydelig feil for en ukjent handling (fail-closed, aldri en stille default)", async () => {
    const transport = new VippsFinanceTransport({} as unknown as FinanceService);
    await expect(transport.invoke("does_not_exist", { tenant_id: "t" })).rejects.toThrow("finance_vipps_action_not_implemented:does_not_exist");
  });
  it("kaster en tydelig feil når tenant_id mangler", async () => {
    const transport = new VippsFinanceTransport({} as unknown as FinanceService);
    await expect(transport.invoke("get_capture", { capture_id: "x" })).rejects.toThrow("finance_vipps_missing_parameter:tenant_id");
  });
  it("kaster en tydelig feil når et påkrevd tall-parameter mangler (amount_ore)", async () => {
    const transport = new VippsFinanceTransport({} as unknown as FinanceService);
    await expect(
      transport.invoke("request_capture", { tenant_id: "t", idempotency_key: "k", payment_intent_id: "p" })
    ).rejects.toThrow("finance_vipps_missing_parameter:amount_ore");
  });
});

describe("D: finance.create_payment_intent aksepterer provider='vipps'", () => {
  it("finance.*-namespacet sitt create_payment_intent-skjema tillater provider='vipps'", () => {
    const tools = firstWaveTools({});
    const createPaymentIntent = tools.find((t) => t.tool_id === "finance" && t.action === "create_payment_intent");
    expect(createPaymentIntent).toBeDefined();
    const parsed = createPaymentIntent!.input_schema.safeParse({
      tenant_id: "t", idempotency_key: "k", purpose: "p", amount_ore: 100, vendor_name: "v", account_code: "cat", provider: "vipps"
    });
    expect(parsed.success).toBe(true);
  });
});
