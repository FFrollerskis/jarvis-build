import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { CONNECTOR_REGISTRY, type ConnectorAuthInfo, type ToolGateway } from "@jarvis/tool-gateway";
import { ExecutiveService } from "../src/service.ts";
import { ExecutiveTransport } from "../src/transport.ts";

/**
 * WP-C3 (Q-45 b): `executive.get_connector_status` rapporterer autentiseringsmetode (GitHub: pat/app, installasjons-id, utløp, repo-scope,
 * rettigheter) fra en injisert, nettverksfri kilde - uten å endre eksisterende felt, og uten at kilden er påkrevd.
 */

const fakeGateway = (configured: Set<string> = new Set()): ToolGateway =>
  ({ hasSecret: async (ref: string) => configured.has(ref), health: new Map() }) as unknown as ToolGateway;

const identity: IdentityContext = {
  person_id: "p", tenant_id: "t", memory_space_id: "business", session_id: "s", device_id: "jarvis-core", channel: "api", auth_strength: "active"
};

const appInfo: ConnectorAuthInfo = {
  method: "app", short_lived: true, scoped: true,
  detail: { installation_id: "9876543", repositories: ["tsworkflow/jarvisbuild"], token_expires_at: "2026-10-09T13:00:00.000Z", permissions: { contents: "write" }, hardened: true }
};

describe("WP-C3: ExecutiveService.getConnectorStatus() med connectorAuth", () => {
  it("A: uten kilde er svaret UENDRET (ingen auth-felt, ingen endring i credentials[])", async () => {
    const report = await new ExecutiveService(fakeGateway(new Set(["JARVIS_GITHUB_TOKEN"]))).getConnectorStatus();
    expect(report.connectors.map((c) => c.id)).toEqual(CONNECTOR_REGISTRY.map((c) => c.id));
    for (const c of report.connectors) expect(c.auth, c.id).toBeUndefined();
    const github = report.connectors.find((c) => c.id === "github");
    expect(github?.configured).toBe(true);
    expect(github?.credentials).toEqual([{ ref: "JARVIS_GITHUB_TOKEN", configured: true }]);
  });

  it("B: med kilde får github `auth` (kortlevd + repo-scopet), alle andre connectorer ingen", async () => {
    const service = new ExecutiveService(fakeGateway(), { connectorAuth: (id) => (id === "github" ? appInfo : undefined) });
    const report = await service.getConnectorStatus();
    expect(report.connectors.find((c) => c.id === "github")?.auth).toEqual(appInfo);
    expect(report.connectors.filter((c) => c.auth !== undefined).map((c) => c.id)).toEqual(["github"]);
  });

  it("C: gjennom transporten (executive.get_connector_status) når `auth` fram uendret, og ingen credential-verdi finnes i svaret", async () => {
    const service = new ExecutiveService(fakeGateway(new Set(["JARVIS_GITHUB_TOKEN"])), { connectorAuth: (id) => (id === "github" ? appInfo : undefined) });
    const result = await new ExecutiveTransport(service).invoke("get_connector_status", {}, "cred", { identity });
    const data = result.data as unknown as { connectors: Array<{ id: string; auth?: ConnectorAuthInfo }> };
    expect(data.connectors.find((c) => c.id === "github")?.auth?.method).toBe("app");
    expect(JSON.stringify(result.data)).not.toMatch(/ghs_[A-Za-z0-9]{10,}/);
  });
});
