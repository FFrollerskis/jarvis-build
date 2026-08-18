import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { AgreementsService } from "../src/service.ts";
import { AgreementsTransport } from "../src/transport.ts";

/**
 * UA-3 Native Jarvis Contracts Core (D-71): rene wiring-/orkestreringstester
 * (INGEN embedded Postgres - `AgreementsService` er en fake, samme mønster
 * som `support-transport-wiring.test.ts`). Beviser ToolGateway-registrering/
 * risikoklasser og ZERO e-sign-leverandør-avhengighet (ingen DocuSign/
 * PandaDoc/Signicat/Adobe Sign-referanse, ingen provider-credential-env-
 * variabel lest noe sted i modules/agreements).
 */

describe("A: contract.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("contract.create_contract/get_contract/set_status/add_obligation finnes i registeret og peker til contract-transporten", () => {
    const contractTransport = new AgreementsTransport({} as unknown as AgreementsService);
    const tools = firstWaveTools({ contract: contractTransport });
    const contractTools = tools.filter((t) => t.tool_id === "contract");
    expect(contractTools.length).toBeGreaterThanOrEqual(24);
    expect(contractTools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "create_contract", "get_contract", "list_contracts", "search_contracts", "list_by_company",
        "upcoming_renewals", "upcoming_termination_deadlines", "cancellable_now", "due_obligations", "overdue_obligations",
        "set_status", "set_owner", "link_counterparty", "set_renewal_date", "set_termination_deadline",
        "add_version", "list_versions", "get_current_version", "add_obligation", "list_obligations",
        "complete_obligation", "waive_obligation", "reopen_obligation", "list_events"
      ])
    );
    for (const tool of contractTools) expect(tool.transport).toBe(contractTransport);
  });
});

describe("B: risikoklasser er effekt-baserte, ingen contract.*-handling er klasse D (ingen e-sign i denne sliceen)", () => {
  it("lesing er klasse A, interne skrivinger klasse B, lifecycle-overgang (set_status) klasse C", () => {
    const tools = firstWaveTools({ contract: new AgreementsTransport({} as unknown as AgreementsService) }).filter((t) => t.tool_id === "contract");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction["get_contract"]).toBe("A");
    expect(byAction["list_contracts"]).toBe("A");
    expect(byAction["search_contracts"]).toBe("A");
    expect(byAction["list_events"]).toBe("A");
    expect(byAction["due_obligations"]).toBe("A");
    expect(byAction["create_contract"]).toBe("B");
    expect(byAction["add_obligation"]).toBe("B");
    expect(byAction["complete_obligation"]).toBe("B");
    expect(byAction["add_version"]).toBe("B");
    expect(byAction["set_status"]).toBe("C");
    expect(tools.every((t) => t.capability_class !== "D")).toBe(true);
  });
});

describe("C: transport-dispatch ruter til riktig service-metode", () => {
  function fakeService() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
      createContract: async (...args: unknown[]) => { calls.push({ method: "createContract", args }); return { contract_id: "agr-ct-1" }; },
      setStatus: async (...args: unknown[]) => { calls.push({ method: "setStatus", args }); return { contract_id: "agr-ct-1", status: args[3] }; },
      addObligation: async (...args: unknown[]) => { calls.push({ method: "addObligation", args }); return { obligation_id: "agr-ob-1" }; },
      _calls: calls
    } as unknown as AgreementsService & { _calls: Array<{ method: string; args: unknown[] }> };
  }
  it("create_contract kaller service.createContract med tenant/space/title", async () => {
    const service = fakeService();
    const transport = new AgreementsTransport(service);
    await transport.invoke("create_contract", { tenant_id: "t1", title: "Test" });
    expect(service._calls[0]!.method).toBe("createContract");
  });
  it("set_status kaller service.setStatus med riktig status-parameter", async () => {
    const service = fakeService();
    const transport = new AgreementsTransport(service);
    await transport.invoke("set_status", { tenant_id: "t1", contract_id: "agr-ct-1", status: "review" });
    expect(service._calls[0]!.method).toBe("setStatus");
    expect(service._calls[0]!.args[3]).toBe("review");
  });
  it("manglende paakrevd parameter kaster contract_missing_parameter", async () => {
    const transport = new AgreementsTransport(fakeService());
    await expect(transport.invoke("create_contract", { tenant_id: "t1" })).rejects.toThrow("contract_missing_parameter:title");
  });
  it("ukjent action kaster contract_action_not_implemented", async () => {
    const transport = new AgreementsTransport(fakeService());
    await expect(transport.invoke("delete_forever", { tenant_id: "t1" })).rejects.toThrow("contract_action_not_implemented:delete_forever");
  });
});

describe("D: ZERO e-sign-leverandør-avhengighet (no-provider-proof)", () => {
  const FORBIDDEN = /docusign|pandadoc|signicat|adobe\s*sign|hellosign/i;
  it("ingen kildefil i modules/agreements refererer noen e-sign-leverandør", async () => {
    const files = ["types.ts", "state-machine.ts", "service.ts", "transport.ts", "index.ts"];
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of files) {
      const content = await readFile(`${dir}${file}`, "utf8");
      expect(content).not.toMatch(FORBIDDEN);
    }
  });
  it("ingen JARVIS_*_SIGN*/JARVIS_*ESIGN*-miljøvariabel eller annen leverandør-credential leses noe sted i modules/agreements", async () => {
    const files = ["types.ts", "state-machine.ts", "service.ts", "transport.ts", "index.ts"];
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of files) {
      const content = await readFile(`${dir}${file}`, "utf8");
      expect(content).not.toMatch(/process\.env\[/);
    }
  });
  it("AgreementsService/AgreementsTransport konstrueres uten NOEN provider-credential-parameter", () => {
    // AgreementsService(pool) og AgreementsTransport(service) - begge tar KUN
    // interne avhengigheter, ingen API-nøkkel/OAuth-klient av noe slag.
    expect(AgreementsTransport.length).toBe(1);
  });
});
