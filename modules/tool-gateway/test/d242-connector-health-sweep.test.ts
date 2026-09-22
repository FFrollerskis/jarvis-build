import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { CONNECTOR_REGISTRY } from "../src/connector-registry.ts";
import { runConnectorHealthSweep } from "../src/connector-health-sweep.ts";
import type { ToolResult } from "../src/gateway.ts";

/**
 * D-242 (Tobias direkte chat-instruks: "du skal bygge det for absolutt alle
 * som tester en gang om dagen så vi vet om credentials fungerer eller ikke
 * hele tiden"). Tester mot DEN EKTE `CONNECTOR_REGISTRY` (SAMME presedens
 * som `connector-registry.test.ts` selv), IKKE en injisert fake-registry -
 * sveipen har bevisst INGEN egen dependency-injection for selve registeret,
 * SAMME "ett sted eier connector-listen"-disiplin som `listConnectorStatus()`.
 */
const IDENTITY: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-personal", memory_space_id: "personal",
  session_id: "sess-connector-health-sweep-test", device_id: "jarvis-core", channel: "api", auth_strength: "active"
};

const LIVE_TEST_IDS = CONNECTOR_REGISTRY.filter((c) => c.live_test).map((c) => c.id).sort();
const NO_LIVE_TEST_IDS = CONNECTOR_REGISTRY.filter((c) => !c.live_test).map((c) => c.id).sort();

function allConfiguredGateway(execute: (request: { tool_id: string; action: string }) => Promise<ToolResult>) {
  const executeCalls: Array<{ tool_id: string; action: string }> = [];
  return {
    gateway: {
      hasSecret: async () => true,
      execute: async (request: { tool_id: string; action: string }) => {
        executeCalls.push({ tool_id: request.tool_id, action: request.action });
        return execute(request);
      }
    },
    executeCalls
  };
}

describe("A: runConnectorHealthSweep() - kun konfigurerte live_test-connectorer testes", () => {
  it("alle 11 live_test-connectorer sjekkes når ALLE credentials er konfigurert og hvert kall lykkes", async () => {
    const { gateway, executeCalls } = allConfiguredGateway(async () => ({ ok: true, data: null, output_trust: "untrusted", deduplicated: false }));
    const result = await runConnectorHealthSweep(gateway, IDENTITY);
    expect(result.checked.slice().sort()).toEqual(LIVE_TEST_IDS);
    expect(result.failed).toEqual([]);
    expect(result.skipped_not_configured).toEqual([]);
    expect(result.skipped_no_live_test.slice().sort()).toEqual(NO_LIVE_TEST_IDS);
    expect(executeCalls).toHaveLength(LIVE_TEST_IDS.length);
  });

  it("en connector UTEN live_test blir ALDRI kalt (gateway.execute() ser den aldri)", async () => {
    const { gateway, executeCalls } = allConfiguredGateway(async () => ({ ok: true, data: null, output_trust: "untrusted", deduplicated: false }));
    await runConnectorHealthSweep(gateway, IDENTITY);
    expect(executeCalls.some((c) => c.tool_id === "notion" || c.tool_id === "anthropic")).toBe(false);
  });

  it("en ikke-konfigurert live_test-connector hoppes over FØR noe gateway.execute()-kall - havner i skipped_not_configured", async () => {
    const { gateway, executeCalls } = {
      gateway: {
        hasSecret: async (ref: string) => ref !== "JARVIS_GITHUB_TOKEN",
        execute: async (): Promise<ToolResult> => ({ ok: true, data: null, output_trust: "untrusted", deduplicated: false })
      },
      executeCalls: [] as Array<{ tool_id: string }>
    };
    const result = await runConnectorHealthSweep(gateway, IDENTITY);
    expect(result.skipped_not_configured).toContain("github");
    expect(result.checked).not.toContain("github");
    expect(result.failed.find((f) => f.connector_id === "github")).toBeUndefined();
    expect(executeCalls).toEqual([]);
  });
});

describe("B: per-connector isolasjon - én feilende/kastende connector stopper ALDRI resten av sveipen (D-227-disiplin)", () => {
  it("gateway.execute() som returnerer {ok:false} registreres i failed OG checked - resten av connectorene sjekkes uendret", async () => {
    const { gateway } = allConfiguredGateway(async (request) =>
      request.tool_id === "vercel"
        ? { ok: false, reason: "vercel_error_401" }
        : { ok: true, data: null, output_trust: "untrusted", deduplicated: false }
    );
    const result = await runConnectorHealthSweep(gateway, IDENTITY);
    expect(result.checked.slice().sort()).toEqual(LIVE_TEST_IDS);
    expect(result.failed).toEqual([{ connector_id: "vercel", reason: "vercel_error_401" }]);
  });

  it("gateway.execute() som KASTER (uventet programmeringsfeil) fanges - havner i failed, IKKE checked, resten kjører uendret", async () => {
    const { gateway } = allConfiguredGateway(async (request) => {
      if (request.tool_id === "github") throw new Error("unexpected_boom");
      return { ok: true, data: null, output_trust: "untrusted", deduplicated: false };
    });
    const result = await runConnectorHealthSweep(gateway, IDENTITY);
    expect(result.checked).not.toContain("github");
    expect(result.checked.slice().sort()).toEqual(LIVE_TEST_IDS.filter((id) => id !== "github").sort());
    expect(result.failed).toEqual([{ connector_id: "github", reason: "unexpected_boom" }]);
  });

  it("FLERE samtidige feil (ulike connectorer) blir ALLE registrert - ingen tapt feil, ingen tidlig avbrudd", async () => {
    const { gateway } = allConfiguredGateway(async (request) => {
      if (request.tool_id === "github") throw new Error("boom_a");
      if (request.tool_id === "vercel") return { ok: false, reason: "boom_b" };
      return { ok: true, data: null, output_trust: "untrusted", deduplicated: false };
    });
    const result = await runConnectorHealthSweep(gateway, IDENTITY);
    expect(result.failed.map((f) => f.connector_id).sort()).toEqual(["github", "vercel"]);
    expect(result.checked.length).toBe(LIVE_TEST_IDS.length - 1); // github aldri "checked" (kastet FØR push)
  });
});

describe("C: kaller live_test.parameters(identity) korrekt og videreformidler tool_id/action uendret", () => {
  it("Neonomics/Wallester (tenant-scopet) sitt live_test kalles med identity.tenant_id i parameters", async () => {
    const seenParameters: Array<{ tool_id: string; parameters: unknown }> = [];
    const gateway = {
      hasSecret: async () => true,
      execute: async (request: { tool_id: string; action: string; parameters: Record<string, unknown> }): Promise<ToolResult> => {
        seenParameters.push({ tool_id: request.tool_id, parameters: request.parameters });
        return { ok: true, data: null, output_trust: "untrusted", deduplicated: false };
      }
    };
    await runConnectorHealthSweep(gateway, IDENTITY);
    const neonomicsCall = seenParameters.find((c) => c.tool_id === "finance_neonomics");
    expect(neonomicsCall?.parameters).toEqual({ tenant_id: IDENTITY.tenant_id });
  });
});
