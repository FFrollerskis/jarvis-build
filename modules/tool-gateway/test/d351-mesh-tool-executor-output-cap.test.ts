import { describe, expect, it } from "vitest";
import type { ToolCallRequest } from "@jarvis/provider-adapters";
import { MeshToolExecutor, type ToolGateway } from "../src/index.ts";
import { listConnectorStatus, CONNECTOR_REGISTRY } from "../src/connector-registry.ts";

/**
 * D-351 (Tobias direkte i chat, live: "ER MANGE FLERE EN DE" - Charlie
 * rapporterte kun ~16 connectorer fra `executive.get_connector_status`, mens
 * `CONNECTOR_REGISTRY` faktisk har 56+). Rotårsak: `MeshToolExecutor` sin
 * `maxOutputChars` var en FLAT 4000-tegns-grense brukt UNIFORMT for ALLE
 * meshverktøy - host-målt (denne testen, DIREKTE mot det ekte registeret):
 * full, uforkortet `listConnectorStatus()`-serialisering er 12 472+ tegn ved
 * dagens registerstørrelse, godt over den forrige grensen. Grensen kappet
 * derfor JSON-arrayet midt i, uten noe tydelig varsel til brukeren.
 * `maxOutputChars` er nå 20_000 (>60 % headroom over dagens fulle
 * størrelse). Denne suiten beviser BÅDE selve trunkeringsmekanismen
 * (uendret oppførsel for genuint store payloads) OG at den EKTE
 * connector-status-payloaden nå overlever et fullt round-trip UTEN
 * trunkering - en "audit-as-code"-test (samme presedens som D-310a) som
 * FEILER dersom registeret vokser forbi den nye grensen igjen, i stedet for
 * å stille gjenta feilen.
 *
 * Kun `MeshToolExecutor.execute()` sin egen trunkeringslogikk testes her -
 * `ToolGateway.execute()` sin fulle policy-/DB-autorisasjon er UENDRET og
 * allerede dekket andre steder (`ua1-p1a-dclass-mesh.test.ts` m.fl.). En
 * MINIMAL fake `ToolGateway` (kun `execute()`, returnerer et ferdig
 * `ToolResult`) brukes derfor - SAMME isolasjonspresedens som
 * `noopTransport`/`noopSecrets` i `d289-full-capability-mesh.test.ts`, kun
 * ett lag lenger inn (gateway-resultatet selv, ikke transporten).
 */

function fakeGatewayReturning(data: unknown): ToolGateway {
  return { execute: async () => ({ ok: true, data }) } as unknown as ToolGateway;
}

function callRequest(toolName: string): ToolCallRequest {
  return { tool_call_id: "call-1", tool_name: toolName, arguments: {}, provider: "test", model: "test" };
}

const ctx = { tenant_id: "tenant-test", idempotency_key: "idem-1" };

describe("D-351: MeshToolExecutor sin output-grense", () => {
  it("payload UNDER grensen returneres UENDRET, ingen trunkering", async () => {
    const smallPayload = { items: ["a", "b", "c"] };
    const executor = new MeshToolExecutor(fakeGatewayReturning(smallPayload), {}, 20_000, [
      { def: { name: "small_tool__read", description: "x", input_schema: {} }, tool_id: "small_tool", action: "read" }
    ]);
    const result = await executor.execute(callRequest("small_tool__read"), ctx);
    expect(result.success).toBe(true);
    expect(result.output).toEqual(smallPayload);
  });

  it("payload OVER grensen kappes til {truncated:true, preview:<de første N tegnene>}", async () => {
    const bigPayload = { blob: "x".repeat(30_000) };
    const executor = new MeshToolExecutor(fakeGatewayReturning(bigPayload), {}, 20_000, [
      { def: { name: "big_tool__read", description: "x", input_schema: {} }, tool_id: "big_tool", action: "read" }
    ]);
    const result = await executor.execute(callRequest("big_tool__read"), ctx);
    expect(result.success).toBe(true);
    const output = result.output as { truncated: boolean; preview: string };
    expect(output.truncated).toBe(true);
    expect(output.preview.length).toBe(20_000);
    expect(JSON.stringify(bigPayload).startsWith(output.preview)).toBe(true);
  });

  it("konstruktørens DEFAULT er 20_000 (parameteren utelatt helt) - samme grense som eksplisitt satt", async () => {
    const justUnderDefault = { blob: "x".repeat(19_900) };
    const executor = new MeshToolExecutor(fakeGatewayReturning(justUnderDefault), {}, undefined, [
      { def: { name: "default_tool__read", description: "x", input_schema: {} }, tool_id: "default_tool", action: "read" }
    ]);
    const result = await executor.execute(callRequest("default_tool__read"), ctx);
    expect(result.output).toEqual(justUnderDefault);
  });

  /**
   * Selve regresjonsbeviset for D-351 sitt funn: den EKTE
   * `listConnectorStatus()`-payloaden (hele `CONNECTOR_REGISTRY`, ikke en
   * håndlaget test-fiksjon) må overleve et fullt round-trip gjennom
   * `MeshToolExecutor` UTEN trunkering, akkurat slik `executive`-transporten
   * faktisk returnerer den for `get_connector_status` i produksjon.
   */
  it("REGRESJON: den EKTE connector-status-payloaden (hele CONNECTOR_REGISTRY) overlever UTEN trunkering", async () => {
    const connectorStatus = await listConnectorStatus({ hasSecret: async () => false, health: new Map() });
    expect(connectorStatus).toHaveLength(CONNECTOR_REGISTRY.length);
    const executor = new MeshToolExecutor(fakeGatewayReturning(connectorStatus), {}, undefined, [
      { def: { name: "executive__get_connector_status", description: "x", input_schema: {} }, tool_id: "executive", action: "get_connector_status" }
    ]);
    const result = await executor.execute(callRequest("executive__get_connector_status"), ctx);
    expect(result.success).toBe(true);
    // Ingen `truncated`-felt betyr HELE listen kom gjennom - ALLE 56+ connectorer, ikke et utvalg.
    expect((result.output as { truncated?: boolean }).truncated).toBeUndefined();
    expect(result.output).toEqual(connectorStatus);
  });
});
