import { describe, expect, it } from "vitest";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { IdentityContext } from "@jarvis/contracts";
import { ExecutiveService } from "../src/service.ts";
import { ExecutiveTransport, executiveToolDefinitions } from "../src/transport.ts";

/** EV-1 (D-412): `executive.get_self_diagnosis` - tjeneste + verktøydefinisjon + transport. DB-uavhengig. */
const gateway = { list: () => [], hasSecret: async () => false, health: new Map() } as unknown as ToolGateway;
const ok = { status: "OK" as const, source: "t", observed_at: "2026-10-07T10:00:00.000Z", detail: "ok" };
const id: IdentityContext = { person_id: "p", tenant_id: "t", memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "active" };

describe("A: ExecutiveService.getSelfDiagnosis", () => {
  it("A1: uten selfModel-lesere er ALT ukjent (overall UNKNOWN) - aldri «frisk»", async () => {
    const d = await new ExecutiveService(gateway).getSelfDiagnosis();
    expect(d.overall).toBe("UNKNOWN");
    expect(d.unknown).toContain("database");
    expect(Object.values(d.observations).every((o) => o.status === "UNKNOWN")).toBe(true);
  });

  it("A2: injiserte lesere gir observasjoner med kilde, og begrensningene avledes fra registerne", async () => {
    const service = new ExecutiveService(gateway, {
      selfModel: {
        readers: { database: async () => ok, providers: async () => [ok], controls: async () => ok },
        limitations: {
          forbiddenModelToolIds: ["docker"], connectors: [{ id: "tiktok", category: "backlog_social" }], modelProfiles: [], allModelCapabilities: []
        }
      }
    });
    const d = await service.getSelfDiagnosis();
    expect(d.observations["database"]).toMatchObject({ status: "OK", source: "t" });
    expect(d.overall).toBe("OK"); // kritiske områder OK; ikke-kritiske ukjente påvirker ikke overall
    expect(d.unknown).toContain("backup");
    expect(d.limitations.map((l) => l.id)).toEqual(expect.arrayContaining(["forbidden_tool:docker", "connector_backlog:tiktok", "self_modification_frozen"]));
  });
});

describe("B: verktøydefinisjon og transport", () => {
  const transport = new ExecutiveTransport(new ExecutiveService(gateway, { selfModel: { readers: { database: async () => ok }, limitations: { forbiddenModelToolIds: [], connectors: [], modelProfiles: [], allModelCapabilities: [] } } }));
  const def = executiveToolDefinitions(transport).find((d) => d.action === "get_self_diagnosis");

  it("B1: verktøyet er registrert som ren lesing (klasse A, executive.read)", () => {
    expect(def).toBeDefined();
    expect(def!.capability_class).toBe("A");
    expect(def!.scopes).toEqual(["executive.read"]);
  });

  it("B2: transporten svarer med selve diagnosen som data", async () => {
    const result = await transport.invoke("get_self_diagnosis", {}, "tok", { identity: id } as never);
    expect((result.data as { observations: Record<string, { status: string }> }).observations["database"]!.status).toBe("OK");
  });
});
