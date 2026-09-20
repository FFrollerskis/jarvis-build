import { describe, expect, it } from "vitest";
import { CONNECTOR_REGISTRY, type ToolGateway } from "@jarvis/tool-gateway";
import { ExecutiveService } from "../src/service.ts";
import { ExecutiveTransport, executiveToolDefinitions } from "../src/transport.ts";
import type { IdentityContext } from "@jarvis/contracts";

/**
 * Task #119 (integrasjons-dashboard, D-211): DB-uavhengige tester for
 * `executive.get_connector_status` - SAMME "zero nøstet gateway.execute()"-
 * disiplin som `get_capability_status` (D-209): en fake med KUN `hasSecret`/
 * `health` er nok til å bevise metoden faktisk leser DERFRA.
 */

function fakeGateway(configured: Set<string> = new Set()): ToolGateway {
  return { hasSecret: async (ref: string) => configured.has(ref), health: new Map() } as unknown as ToolGateway;
}

function identity(): IdentityContext {
  return {
    person_id: "person-conn-test", tenant_id: "tenant-conn-test", memory_space_id: "business",
    session_id: "sess-conn-test", device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

describe("A: ExecutiveService.getConnectorStatus() - grounded i @jarvis/tool-gateway sin egen CONNECTOR_REGISTRY", () => {
  it("returnerer nøyaktig ETT connector-element per CONNECTOR_REGISTRY-oppføring", async () => {
    const service = new ExecutiveService(fakeGateway());
    const report = await service.getConnectorStatus();
    expect(report.connectors.map((c) => c.id)).toEqual(CONNECTOR_REGISTRY.map((c) => c.id));
  });

  it("configured=true reflekterer FAKTISK gateway.hasSecret(), ikke en gjettet verdi", async () => {
    const service = new ExecutiveService(fakeGateway(new Set(["JARVIS_GITHUB_TOKEN"])));
    const report = await service.getConnectorStatus();
    expect(report.connectors.find((c) => c.id === "github")?.configured).toBe(true);
    expect(report.connectors.find((c) => c.id === "gmail")?.configured).toBe(false);
  });

  it("ingen credential-VERDI forekommer NOE sted i den serialiserte responsen", async () => {
    const service = new ExecutiveService(fakeGateway(new Set(["JARVIS_GITHUB_TOKEN", "ANTHROPIC_API_KEY"])));
    const report = await service.getConnectorStatus();
    const serialized = JSON.stringify(report);
    // Eneste strenger som skal forekomme er ref-NAVN (f.eks. "JARVIS_GITHUB_TOKEN"), aldri en verdi -
    // fasit her er at `hasSecret()` selv ALDRI returnerer noe annet enn en boolean, så dette er
    // primært en strukturell sjekk av at ingen fremtidig endring legger til et "value"-felt.
    for (const c of report.connectors) {
      for (const cred of c.credentials) {
        expect(Object.keys(cred).sort()).toEqual(["configured", "ref"]);
      }
    }
    expect(serialized).not.toContain("\"value\"");
  });
});

describe("B: executive.get_connector_status - registrert klasse A (lesing), gjennom SAMME transport-dispatch som resten", () => {
  it("registrert i executiveToolDefinitions() som klasse A", () => {
    const tools = executiveToolDefinitions(new ExecutiveTransport(new ExecutiveService(fakeGateway())));
    const tool = tools.find((t) => t.action === "get_connector_status");
    expect(tool).toBeDefined();
    expect(tool!.capability_class).toBe("A");
    expect(tool!.tool_id).toBe("executive");
  });

  it("transport.invoke('get_connector_status', ...) ruter til service.getConnectorStatus() og returnerer dens data uendret", async () => {
    const service = new ExecutiveService(fakeGateway(new Set(["JARVIS_GITHUB_TOKEN"])));
    const transport = new ExecutiveTransport(service);
    const result = await transport.invoke("get_connector_status", {}, "cred", { identity: identity() });
    expect(result.data).toBeDefined();
    const data = result.data as unknown as { connectors: Array<{ id: string; configured: boolean }> };
    expect(data.connectors.find((c) => c.id === "github")?.configured).toBe(true);
  });

  it("manglende invocation-context feiler lukket, samme disiplin som resten av executive.*", async () => {
    const transport = new ExecutiveTransport(new ExecutiveService(fakeGateway()));
    await expect(transport.invoke("get_connector_status", {}, "cred")).rejects.toThrow("executive_missing_invocation_context");
  });
});
