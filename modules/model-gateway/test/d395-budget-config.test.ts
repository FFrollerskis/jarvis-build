import { describe, expect, it } from "vitest";
import { budgetConfigFromEnv, DEFAULT_BUDGET } from "../src/index.ts";

/** D-395 (JARVIS-039): ÉN budsjettkilde for api og worker (tidligere hardkodet i api og DEFAULT_BUDGET i worker). */
describe("budgetConfigFromEnv", () => {
  it("uten miljø = dagens standardgrenser, ingen godkjenning", () => {
    expect(budgetConfigFromEnv({})).toEqual(DEFAULT_BUDGET);
    expect(budgetConfigFromEnv({ JARVIS_COST_WARN_ORE: "", JARVIS_BUDGET_APPROVED: "" })).toEqual(DEFAULT_BUDGET);
  });

  it("grenser og godkjenning leses fra miljøet (samme verdi for api og worker)", () => {
    const cfg = budgetConfigFromEnv({ JARVIS_COST_WARN_ORE: "50000", JARVIS_COST_APPROVAL_ORE: "150000", JARVIS_COST_HARD_LIMIT_ORE: "500000", JARVIS_BUDGET_APPROVED: "TRUE" });
    expect(cfg).toEqual({ warn_ore: 50_000, approval_ore: 150_000, hard_limit_ore: 500_000, spend_approved: true });
  });

  it("å heve hardgrensen alene (eierens overstyring) gir en gyldig konfig", () => {
    expect(budgetConfigFromEnv({ JARVIS_COST_HARD_LIMIT_ORE: "900000" }).hard_limit_ore).toBe(900_000);
  });

  it("ugyldige verdier og feil rekkefølge stopper oppstarten", () => {
    expect(() => budgetConfigFromEnv({ JARVIS_COST_WARN_ORE: "abc" })).toThrow();
    expect(() => budgetConfigFromEnv({ JARVIS_COST_HARD_LIMIT_ORE: "-5" })).toThrow();
    expect(() => budgetConfigFromEnv({ JARVIS_COST_WARN_ORE: "400000" })).toThrow(/krever JARVIS_COST_WARN_ORE/);
    expect(() => budgetConfigFromEnv({ JARVIS_COST_HARD_LIMIT_ORE: "100000" })).toThrow(/krever/);
  });

  it("budget-godkjenning leses kun som eksakt «true»", () => {
    expect(budgetConfigFromEnv({ JARVIS_BUDGET_APPROVED: "yes" }).spend_approved).toBe(false);
    expect(budgetConfigFromEnv({ JARVIS_BUDGET_APPROVED: " true " }).spend_approved).toBe(true);
  });

  it("api og worker bruker samme kilde (strukturelt)", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
    expect(read("../../../apps/api/src/main.ts")).toContain("budget: budgetConfigFromEnv()");
    expect(read("../../../apps/api/src/worker-main.ts")).toContain("budget: budgetConfigFromEnv()");
  });
});
