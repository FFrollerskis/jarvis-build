import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { SpendService } from "../src/spend-service.ts";
import { SpendTransport } from "../src/spend-transport.ts";

/**
 * UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2): rene
 * wiring-/orkestreringstester (INGEN embedded Postgres - `SpendService` er
 * en fake, SAMME mønster som `transport-wiring.test.ts`). Beviser
 * ToolGateway-registrering/risikoklasser - `finance_spend.*` er et SEPARAT
 * namespace fra `finance.*`, og INGEN handling her er klasse C/D (ingen
 * provider-kall i det hele tatt - kun interne DB-operasjoner).
 */
describe("A: finance_spend.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("finner alle 18 finance_spend.*-handlinger og peker til finance_spend-transporten", () => {
    const spendTransport = new SpendTransport({} as unknown as SpendService);
    const tools = firstWaveTools({ finance_spend: spendTransport });
    const spendTools = tools.filter((t) => t.tool_id === "finance_spend");
    expect(spendTools.length).toBeGreaterThanOrEqual(18);
    expect(spendTools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "create_recurring_commitment", "get_recurring_commitment", "list_recurring_commitments",
        "update_recurring_commitment", "pause_recurring_commitment", "resume_recurring_commitment", "cancel_recurring_commitment",
        "create_procurement_item", "get_procurement_item", "list_procurement_items", "update_procurement_item", "cancel_procurement_item",
        "list_spend_records", "get_spend_record", "list_unresolved_spend_anomalies",
        "sync_internal_spend", "run_spend_reconciliation", "run_spend_anomaly_detection"
      ])
    );
    for (const tool of spendTools) expect(tool.transport).toBe(spendTransport);
  });
});

describe("B: risikoklasser - INGEN klasse C/D i dette namespacet (ingen provider-kall i det hele tatt)", () => {
  it("lesing er klasse A, ALT annet (skriving/trigger) er klasse B - aldri C/D", () => {
    const tools = firstWaveTools({ finance_spend: new SpendTransport({} as unknown as SpendService) }).filter((t) => t.tool_id === "finance_spend");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction["get_recurring_commitment"]).toBe("A");
    expect(byAction["list_recurring_commitments"]).toBe("A");
    expect(byAction["get_procurement_item"]).toBe("A");
    expect(byAction["list_procurement_items"]).toBe("A");
    expect(byAction["list_spend_records"]).toBe("A");
    expect(byAction["get_spend_record"]).toBe("A");
    expect(byAction["list_unresolved_spend_anomalies"]).toBe("A");
    expect(byAction["create_recurring_commitment"]).toBe("B");
    expect(byAction["cancel_recurring_commitment"]).toBe("B");
    expect(byAction["sync_internal_spend"]).toBe("B");
    expect(byAction["run_spend_reconciliation"]).toBe("B");
    expect(byAction["run_spend_anomaly_detection"]).toBe("B");
    for (const tool of tools) expect(["A", "B"]).toContain(tool.capability_class);
  });
  it("ingen finance_spend.*-handling mangler credential_ref (fail-closed konfigurert, samme sentinel-mønster som finance.*)", () => {
    const tools = firstWaveTools({ finance_spend: new SpendTransport({} as unknown as SpendService) }).filter((t) => t.tool_id === "finance_spend");
    for (const tool of tools) expect(tool.credential_ref).toBe("JARVIS_BUSINESS_INTERNAL_TOKEN");
  });
});

describe("C: SpendTransport.invoke() dispatch", () => {
  it("kaster en tydelig feil for en ukjent handling (fail-closed, aldri en stille default)", async () => {
    const transport = new SpendTransport({} as unknown as SpendService);
    await expect(transport.invoke("does_not_exist", { tenant_id: "t" })).rejects.toThrow("finance_spend_action_not_implemented:does_not_exist");
  });
  it("kaster en tydelig feil når tenant_id mangler", async () => {
    const transport = new SpendTransport({} as unknown as SpendService);
    await expect(transport.invoke("get_spend_record", { spend_record_id: "x" })).rejects.toThrow("finance_spend_missing_parameter:tenant_id");
  });
  it("dispatcher create_recurring_commitment til service.createCommitment() med parsede parametre", async () => {
    let captured: unknown;
    const fakeService = {
      createCommitment: async (tenantId: string, memorySpace: string, input: unknown) => {
        captured = { tenantId, memorySpace, input };
        return { commitment_id: "fin-rc-fake" };
      }
    } as unknown as SpendService;
    const transport = new SpendTransport(fakeService);
    const result = await transport.invoke("create_recurring_commitment", {
      tenant_id: "t1", vendor_name: "V", description: "D", cadence: "monthly", expected_amount_ore: 1000, start_date: "2026-01-01"
    });
    expect(result.external_id).toBe("fin-rc-fake");
    expect((captured as { tenantId: string }).tenantId).toBe("t1");
    expect((captured as { memorySpace: string }).memorySpace).toBe("business");
  });
});
