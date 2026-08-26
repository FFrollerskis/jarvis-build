import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { CardService } from "../src/card-service.ts";
import { WallesterFinanceTransport } from "../src/wallester-tool-transport.ts";

/**
 * D-112 (UA-6 Slice 6): rene wiring-/orkestreringstester (INGEN embedded
 * Postgres - SAMME mønster som stripe-/vipps-/neonomics-transport-wiring).
 * Ingen egen klasse D: selve pengetrekket skjer hos brukersteder besluttet
 * av WALLESTER mot provider-anvendte grenser - de spend-MULIGGJØRENDE
 * handlingene (submit_card/unfreeze_card/update_spend_policy/close_card)
 * er C og kill-switch-/tilstands-gated i CardService.
 */
function wallesterTransport(): WallesterFinanceTransport {
  return new WallesterFinanceTransport({} as unknown as CardService);
}

describe("A: finance_wallester.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("finner alle 18 finance_wallester.*-handlinger og peker til wallester-transporten", () => {
    const transport = wallesterTransport();
    const tools = firstWaveTools({ finance_wallester: transport });
    const wTools = tools.filter((t) => t.tool_id === "finance_wallester");
    expect(wTools.length).toBe(18);
    expect(wTools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "create_card", "submit_card", "get_card", "list_cards",
        "activate_card", "freeze_card", "unfreeze_card", "close_card",
        "get_spend_policy", "update_spend_policy",
        "sync_card_state", "sync_authorizations", "sync_transactions",
        "list_authorizations", "list_card_transactions",
        "reconcile_card_transactions", "run_card_anomaly_detection", "get_provider_balance"
      ])
    );
    for (const tool of wTools) expect(tool.transport).toBe(transport);
  });
});

describe("B: risikoklasser speiler reell økonomisk risiko", () => {
  const tools = () => firstWaveTools({ finance_wallester: wallesterTransport() }).filter((t) => t.tool_id === "finance_wallester");

  it("rene lesinger er A, lokale mutasjoner/synk B, spend-muliggjørende handlinger C - ingen egen D", () => {
    const byAction = Object.fromEntries(tools().map((t) => [t.action, t.capability_class]));
    expect(byAction["get_card"]).toBe("A");
    expect(byAction["list_cards"]).toBe("A");
    expect(byAction["get_spend_policy"]).toBe("A");
    expect(byAction["list_authorizations"]).toBe("A");
    expect(byAction["list_card_transactions"]).toBe("A");
    expect(byAction["get_provider_balance"]).toBe("A");
    expect(byAction["create_card"]).toBe("B");
    expect(byAction["activate_card"]).toBe("B");
    expect(byAction["freeze_card"]).toBe("B");
    expect(byAction["sync_card_state"]).toBe("B");
    expect(byAction["sync_authorizations"]).toBe("B");
    expect(byAction["sync_transactions"]).toBe("B");
    expect(byAction["reconcile_card_transactions"]).toBe("B");
    expect(byAction["run_card_anomaly_detection"]).toBe("B");
    expect(byAction["submit_card"]).toBe("C");
    expect(byAction["unfreeze_card"]).toBe("C");
    expect(byAction["close_card"]).toBe("C");
    expect(byAction["update_spend_policy"]).toBe("C");
    expect(tools().some((t) => t.capability_class === "D")).toBe(false);
  });

  it("provider-berørende handlinger bruker JARVIS_WALLESTER_PRIVATE_KEY_PEM som credential_ref; ingen handling mangler credential_ref", () => {
    const byAction = Object.fromEntries(tools().map((t) => [t.action, t.credential_ref]));
    expect(byAction["submit_card"]).toBe("JARVIS_WALLESTER_PRIVATE_KEY_PEM");
    expect(byAction["unfreeze_card"]).toBe("JARVIS_WALLESTER_PRIVATE_KEY_PEM");
    expect(byAction["update_spend_policy"]).toBe("JARVIS_WALLESTER_PRIVATE_KEY_PEM");
    expect(byAction["sync_transactions"]).toBe("JARVIS_WALLESTER_PRIVATE_KEY_PEM");
    expect(byAction["get_provider_balance"]).toBe("JARVIS_WALLESTER_PRIVATE_KEY_PEM");
    for (const tool of tools()) expect(tool.credential_ref).toBeTruthy();
  });
});

describe("C: WallesterFinanceTransport.invoke() dispatch", () => {
  it("kaster en tydelig feil for en ukjent handling (fail-closed, aldri en stille default)", async () => {
    await expect(wallesterTransport().invoke("does_not_exist", { tenant_id: "t" })).rejects.toThrow("finance_wallester_action_not_implemented:does_not_exist");
  });
  it("kaster en tydelig feil når tenant_id mangler", async () => {
    await expect(wallesterTransport().invoke("get_card", { card_id: "x" })).rejects.toThrow("finance_wallester_missing_parameter:tenant_id");
  });
  it("kaster en tydelig feil når et påkrevd parameter mangler (card_id)", async () => {
    await expect(wallesterTransport().invoke("submit_card", { tenant_id: "t" })).rejects.toThrow("finance_wallester_missing_parameter:card_id");
  });
});
