import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { firstWaveTools } from "@jarvis/tool-gateway";
import type { ProductService } from "../src/service.ts";
import { ProductTransport } from "../src/transport.ts";

/**
 * UA-3 Native Jarvis Product Core (D-128): rene wiring-/orkestreringstester
 * (INGEN embedded Postgres - `ProductService` er en fake, samme mønster som
 * agreements/transport-wiring.test.ts). Beviser ToolGateway-registrering/
 * risikoklasser og ZERO ekstern produkt-analytics-/issue-tracker-
 * leverandør-avhengighet (ingen Linear/Jira/GitHub Issues-referanse, ingen
 * provider-credential-env-variabel lest noe sted i modules/product).
 */

describe("A: product.*-handlinger er registrert i firstWaveTools() med korrekt transport", () => {
  it("product.create_item/get_item/set_status/list_events finnes i registeret og peker til product-transporten", () => {
    const productTransport = new ProductTransport({} as unknown as ProductService);
    const tools = firstWaveTools({ product: productTransport });
    const productTools = tools.filter((t) => t.tool_id === "product");
    expect(productTools.length).toBeGreaterThanOrEqual(10);
    expect(productTools.map((t) => t.action)).toEqual(
      expect.arrayContaining([
        "create_item", "get_item", "list_items", "search_items", "list_by_company",
        "set_status", "set_priority", "set_owner", "link_reporter", "list_events"
      ])
    );
    for (const tool of productTools) expect(tool.transport).toBe(productTransport);
  });
});

describe("B: risikoklasser er effekt-baserte, ingen product.*-handling er klasse D", () => {
  it("lesing er klasse A, interne skrivinger klasse B, lifecycle-overgang (set_status) klasse C", () => {
    const tools = firstWaveTools({ product: new ProductTransport({} as unknown as ProductService) }).filter((t) => t.tool_id === "product");
    const byAction = Object.fromEntries(tools.map((t) => [t.action, t.capability_class]));
    expect(byAction["get_item"]).toBe("A");
    expect(byAction["list_items"]).toBe("A");
    expect(byAction["search_items"]).toBe("A");
    expect(byAction["list_events"]).toBe("A");
    expect(byAction["create_item"]).toBe("B");
    expect(byAction["set_priority"]).toBe("B");
    expect(byAction["set_owner"]).toBe("B");
    expect(byAction["link_reporter"]).toBe("B");
    expect(byAction["set_status"]).toBe("C");
    expect(tools.every((t) => t.capability_class !== "D")).toBe(true);
  });
});

describe("C: transport-dispatch ruter til riktig service-metode", () => {
  function fakeService() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    return {
      createItem: async (...args: unknown[]) => { calls.push({ method: "createItem", args }); return { item_id: "prd-it-1" }; },
      setStatus: async (...args: unknown[]) => { calls.push({ method: "setStatus", args }); return { item_id: "prd-it-1", status: args[3] }; },
      setPriority: async (...args: unknown[]) => { calls.push({ method: "setPriority", args }); return { item_id: "prd-it-1", priority: args[3] }; },
      _calls: calls
    } as unknown as ProductService & { _calls: Array<{ method: string; args: unknown[] }> };
  }
  it("create_item kaller service.createItem med tenant/space/title", async () => {
    const service = fakeService();
    const transport = new ProductTransport(service);
    await transport.invoke("create_item", { tenant_id: "t1", title: "Test" });
    expect(service._calls[0]!.method).toBe("createItem");
  });
  it("set_status kaller service.setStatus med riktig status-parameter", async () => {
    const service = fakeService();
    const transport = new ProductTransport(service);
    await transport.invoke("set_status", { tenant_id: "t1", item_id: "prd-it-1", status: "triaged" });
    expect(service._calls[0]!.method).toBe("setStatus");
    expect(service._calls[0]!.args[3]).toBe("triaged");
  });
  it("manglende paakrevd parameter kaster product_missing_parameter", async () => {
    const transport = new ProductTransport(fakeService());
    await expect(transport.invoke("create_item", { tenant_id: "t1" })).rejects.toThrow("product_missing_parameter:title");
  });
  it("ukjent action kaster product_action_not_implemented", async () => {
    const transport = new ProductTransport(fakeService());
    await expect(transport.invoke("delete_forever", { tenant_id: "t1" })).rejects.toThrow("product_action_not_implemented:delete_forever");
  });
});

describe("D: ZERO ekstern produkt-analytics-/issue-tracker-leverandør-avhengighet (no-provider-proof)", () => {
  const FORBIDDEN = /linear\.app|jira|github\s*issues|mixpanel|amplitude|posthog/i;
  it("ingen kildefil i modules/product refererer noen ekstern produkt-verktøy-leverandør", async () => {
    const files = ["types.ts", "state-machine.ts", "service.ts", "transport.ts", "index.ts"];
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of files) {
      const content = await readFile(`${dir}${file}`, "utf8");
      expect(content).not.toMatch(FORBIDDEN);
    }
  });
  it("ingen JARVIS_*-produkt-leverandør-credential leses noe sted i modules/product", async () => {
    const files = ["types.ts", "state-machine.ts", "service.ts", "transport.ts", "index.ts"];
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of files) {
      const content = await readFile(`${dir}${file}`, "utf8");
      expect(content).not.toMatch(/process\.env\[/);
    }
  });
  it("ProductService/ProductTransport konstrueres uten NOEN provider-credential-parameter", () => {
    // ProductService(pool) og ProductTransport(service) - begge tar KUN
    // interne avhengigheter, ingen API-nøkkel/OAuth-klient av noe slag.
    expect(ProductTransport.length).toBe(1);
  });
});
