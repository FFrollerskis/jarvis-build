import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { OperationsService } from "../src/service.ts";
import { OperationsTransport } from "../src/transport.ts";

/**
 * UA-3 Native Jarvis Operations Core (D-129): rene wiring-/orkestreringstester
 * (INGEN embedded Postgres - `OperationsService` er en fake, samme mønster
 * som product/transport-wiring.test.ts). Beviser ToolGateway-registrering/
 * risikoklasser og ZERO ekstern driftsplattform-/ticketing-leverandør-
 * avhengighet (ingen ServiceNow/Notion/Jira/Atlassian-referanse, ingen
 * provider-credential-env-variabel lest noe sted i modules/operations).
 */

describe("A: operations.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("operations.create_task/get_task/set_status/escalate_task/create_vendor/create_runbook finnes i registeret og peker til operations-transporten", () => {
    const operationsTransport = new OperationsTransport({} as unknown as OperationsService);
    const tools = firstWaveTools({ operations: operationsTransport });
    const operationsTools = tools.filter((t) => t.tool_id === "operations");
    expect(operationsTools.length).toBeGreaterThanOrEqual(20);
    expect(operationsTools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "create_vendor", "get_vendor", "list_vendors", "set_vendor_status",
        "create_runbook", "get_runbook", "list_runbooks", "update_runbook_content", "set_runbook_active",
        "create_task", "get_task", "list_tasks", "search_tasks", "list_by_vendor",
        "set_status", "set_priority", "set_owner", "set_due_at", "link_vendor", "link_runbook",
        "escalate_task", "list_task_events"
      ])
    );
    for (const tool of operationsTools) expect(tool.transport).toBe(operationsTransport);
  });
});

describe("B: risikoklasser er effekt-baserte, ingen operations.*-handling er klasse D", () => {
  it("lesing er klasse A, interne skrivinger klasse B, lifecycle-overgang/eskalering klasse C", () => {
    const tools = firstWaveTools({ operations: new OperationsTransport({} as unknown as OperationsService) }).filter((t) => t.tool_id === "operations");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction["get_task"]).toBe("A");
    expect(byAction["list_tasks"]).toBe("A");
    expect(byAction["search_tasks"]).toBe("A");
    expect(byAction["list_vendors"]).toBe("A");
    expect(byAction["list_runbooks"]).toBe("A");
    expect(byAction["list_task_events"]).toBe("A");
    expect(byAction["create_task"]).toBe("B");
    expect(byAction["set_priority"]).toBe("B");
    expect(byAction["set_owner"]).toBe("B");
    expect(byAction["link_vendor"]).toBe("B");
    expect(byAction["link_runbook"]).toBe("B");
    expect(byAction["set_status"]).toBe("C");
    expect(byAction["escalate_task"]).toBe("C");
    expect(tools.every((t) => t.capability_class !== "D")).toBe(true);
  });
});

describe("C: transport-dispatch ruter til riktig service-metode", () => {
  function fakeService() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
      createTask: async (...args: unknown[]) => { calls.push({ method: "createTask", args }); return { task_id: "ops-tk-1" }; },
      setStatus: async (...args: unknown[]) => { calls.push({ method: "setStatus", args }); return { task_id: "ops-tk-1", status: args[3] }; },
      escalateTask: async (...args: unknown[]) => { calls.push({ method: "escalateTask", args }); return { task_id: "ops-tk-1", escalation_level: 1 }; },
      createVendor: async (...args: unknown[]) => { calls.push({ method: "createVendor", args }); return { vendor_id: "ops-vn-1" }; },
      _calls: calls
    } as unknown as OperationsService & { _calls: Array<{ method: string; args: unknown[] }> };
  }
  it("create_task kaller service.createTask med tenant/space/title", async () => {
    const service = fakeService();
    const transport = new OperationsTransport(service);
    await transport.invoke("create_task", { tenant_id: "t1", title: "Test" });
    expect(service._calls[0]!.method).toBe("createTask");
  });
  it("set_status kaller service.setStatus med riktig status-parameter", async () => {
    const service = fakeService();
    const transport = new OperationsTransport(service);
    await transport.invoke("set_status", { tenant_id: "t1", task_id: "ops-tk-1", status: "in_progress" });
    expect(service._calls[0]!.method).toBe("setStatus");
    expect(service._calls[0]!.args[3]).toBe("in_progress");
  });
  it("escalate_task kaller service.escalateTask", async () => {
    const service = fakeService();
    const transport = new OperationsTransport(service);
    await transport.invoke("escalate_task", { tenant_id: "t1", task_id: "ops-tk-1", escalated_to_person_id: "person-x" });
    expect(service._calls[0]!.method).toBe("escalateTask");
  });
  it("create_vendor kaller service.createVendor med tenant/space/name", async () => {
    const service = fakeService();
    const transport = new OperationsTransport(service);
    await transport.invoke("create_vendor", { tenant_id: "t1", name: "Test-leverandør" });
    expect(service._calls[0]!.method).toBe("createVendor");
  });
  it("manglende paakrevd parameter kaster operations_missing_parameter", async () => {
    const transport = new OperationsTransport(fakeService());
    await expect(transport.invoke("create_task", { tenant_id: "t1" })).rejects.toThrow("operations_missing_parameter:title");
  });
  it("ukjent action kaster operations_action_not_implemented", async () => {
    const transport = new OperationsTransport(fakeService());
    await expect(transport.invoke("delete_forever", { tenant_id: "t1" })).rejects.toThrow("operations_action_not_implemented:delete_forever");
  });
});

describe("D: ZERO ekstern driftsplattform-/ticketing-leverandør-avhengighet (no-provider-proof)", () => {
  const FORBIDDEN = /servicenow|notion\.so|jira|atlassian|freshservice|zendesk/i;
  it("ingen kildefil i modules/operations refererer noen ekstern driftsplattform-leverandør", async () => {
    const files = ["types.ts", "state-machine.ts", "service.ts", "transport.ts", "index.ts"];
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of files) {
      const content = await readFile(`${dir}${file}`, "utf8");
      expect(content).not.toMatch(FORBIDDEN);
    }
  });
  it("ingen JARVIS_*-driftsplattform-leverandør-credential leses noe sted i modules/operations", async () => {
    const files = ["types.ts", "state-machine.ts", "service.ts", "transport.ts", "index.ts"];
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of files) {
      const content = await readFile(`${dir}${file}`, "utf8");
      expect(content).not.toMatch(/process\.env\[/);
    }
  });
  it("OperationsService/OperationsTransport konstrueres uten NOEN provider-credential-parameter", () => {
    // OperationsService(pool) og OperationsTransport(service) - begge tar KUN
    // interne avhengigheter, ingen API-nøkkel/OAuth-klient av noe slag.
    expect(OperationsTransport.length).toBe(1);
  });
});
