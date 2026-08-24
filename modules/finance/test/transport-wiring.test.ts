import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { FinanceService } from "../src/service.ts";
import { FinanceTransport } from "../src/transport.ts";

/**
 * UA-6 Finance & Spend Integrity Gateway - FØRSTE slice (D-107): rene
 * wiring-/orkestreringstester (INGEN embedded Postgres - `FinanceService`
 * er en fake, samme mønster som growth/agreements transport-wiring.test.ts).
 * Beviser ToolGateway-registrering/risikoklasser - `submit_payment_intent`/
 * `enable_kill_switch`/`disable_kill_switch` er de ENESTE klasse D-
 * handlingene (den ENESTE ekte leverandørmutasjonen + eier-sovereign
 * kritisk kontroll), ALT annet er klasse A (lesing) eller B (ren intern
 * tilstand).
 */
describe("A: finance.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("finner alle 10 finance.*-handlinger og peker til finance-transporten", () => {
    const financeTransport = new FinanceTransport({} as unknown as FinanceService, { getCredentials: async () => null });
    const tools = firstWaveTools({ finance: financeTransport });
    const financeTools = tools.filter((t) => t.tool_id === "finance");
    expect(financeTools.length).toBeGreaterThanOrEqual(10);
    expect(financeTools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "create_payment_intent", "get_payment_intent", "list_payment_intents",
        "submit_payment_intent", "settle_payment_intent", "cancel_payment_intent",
        "reconcile_payment_intent", "enable_kill_switch", "disable_kill_switch", "get_kill_switch"
      ])
    );
    for (const tool of financeTools) expect(tool.transport).toBe(financeTransport);
  });
});

describe("B: risikoklasser - kun ekte leverandørmutasjon/eier-sovereign kontroll er klasse D", () => {
  it("lesing er klasse A, intern tilstand klasse B, submit/kill-switch klasse D", () => {
    const tools = firstWaveTools({ finance: new FinanceTransport({} as unknown as FinanceService, { getCredentials: async () => null }) }).filter((t) => t.tool_id === "finance");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction["get_payment_intent"]).toBe("A");
    expect(byAction["list_payment_intents"]).toBe("A");
    expect(byAction["get_kill_switch"]).toBe("A");
    expect(byAction["create_payment_intent"]).toBe("B");
    expect(byAction["settle_payment_intent"]).toBe("B");
    expect(byAction["cancel_payment_intent"]).toBe("B");
    expect(byAction["reconcile_payment_intent"]).toBe("B");
    // Den ENESTE handlingen som faktisk poster en ekte regnskapspost mot Fiken.
    expect(byAction["submit_payment_intent"]).toBe("D");
    // Eier-sovereign kritisk kontroll (D-41: ingen kunstig godkjenningssperre
    // for eieren selv, men risikoKLASSEN forblir D - preflight/audit uendret).
    expect(byAction["enable_kill_switch"]).toBe("D");
    expect(byAction["disable_kill_switch"]).toBe("D");
  });
  it("ingen finance.*-handling mangler credential_ref (fail-closed konfigurert)", () => {
    const tools = firstWaveTools({ finance: new FinanceTransport({} as unknown as FinanceService, { getCredentials: async () => null }) }).filter((t) => t.tool_id === "finance");
    for (const tool of tools) expect(tool.credential_ref).toBeTruthy();
  });
});

describe("C: FinanceTransport.invoke() dispatch", () => {
  it("kaster en tydelig feil for en ukjent handling (fail-closed, aldri en stille default)", async () => {
    const transport = new FinanceTransport({} as unknown as FinanceService, { getCredentials: async () => null });
    await expect(transport.invoke("does_not_exist", { tenant_id: "t" })).rejects.toThrow("finance_action_not_implemented:does_not_exist");
  });
  it("kaster en tydelig feil når tenant_id mangler", async () => {
    const transport = new FinanceTransport({} as unknown as FinanceService, { getCredentials: async () => null });
    await expect(transport.invoke("get_payment_intent", { payment_intent_id: "x" })).rejects.toThrow("finance_missing_parameter:tenant_id");
  });
});
