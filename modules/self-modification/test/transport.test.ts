import { describe, expect, it } from "vitest";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import { SelfModificationTransport, selfModificationToolDefinitions } from "../src/transport.ts";
import type { SelfModificationService } from "../src/service.ts";

/**
 * Task #121 (D-214): rene wiring-/dispatch-tester (INGEN embedded Postgres -
 * `SelfModificationService` er en fake, SAMME mønster som
 * `modules/governance/test/transport-wiring.test.ts`). Ekte Postgres-bevis
 * for selve tjenestelogikken ligger i `service.test.ts`.
 */
function identity(overrides: Partial<IdentityContext> = {}): IdentityContext {
  return {
    person_id: "person-selfmod-test", tenant_id: "tenant-selfmod-test", memory_space_id: "personal",
    session_id: "sess-selfmod-test", device_id: "jarvis-core", channel: "api", auth_strength: "active",
    ...overrides
  };
}

function fakeService() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    proposePersonalityChange: async (...args: unknown[]) => {
      calls.push({ method: "proposePersonalityChange", args });
      return { request_id: "selfmod-1", pr_number: "42", pr_url: "https://github.com/x/y/pull/42", branch: "jarvis/self-mod/personality-1", risk: "zero_review" };
    },
    _calls: calls
  } as unknown as SelfModificationService & { _calls: Array<{ method: string; args: unknown[] }> };
}

describe("A: selfModificationToolDefinitions() - registrert med korrekt transport, ÉN handling i denne sliceen", () => {
  it("A1: returnerer nøyaktig ÉN handling (propose_personality_change), tool_id='self_modification'", () => {
    const transport = new SelfModificationTransport({} as unknown as SelfModificationService);
    const tools = selfModificationToolDefinitions(transport);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.tool_id).toBe("self_modification");
    expect(tools[0]?.action).toBe("propose_personality_change");
    expect(tools[0]?.transport).toBe(transport);
  });

  it("A2: klasse B, reversibel - ALDRI klasse D, ALDRI irreversibel (merge/godkjenning er BEVISST ikke chat-kallbar)", () => {
    const tools = selfModificationToolDefinitions(new SelfModificationTransport({} as unknown as SelfModificationService));
    expect(tools[0]?.capability_class).toBe("B");
    expect(tools[0]?.reversible).toBe(true);
  });
});

describe("B: manglende invocation-context feiler lukket", () => {
  it("B1: self_modification_missing_invocation_context kastes uten context", async () => {
    const transport = new SelfModificationTransport(fakeService());
    await expect(
      transport.invoke("propose_personality_change", { tone_descriptors: ["varm"], style_notes: "x" }, "cred")
    ).rejects.toThrow("self_modification_missing_invocation_context");
  });
});

describe("C: dispatch - propose_personality_change ruter til service med identity + parametre", () => {
  it("C1: identity FRA context, ALDRI fra parametre, gis videre til service.proposePersonalityChange", async () => {
    const service = fakeService();
    const transport = new SelfModificationTransport(service);
    const ctx = { identity: identity({ person_id: "person-actor" }) };
    await transport.invoke(
      "propose_personality_change",
      { tone_descriptors: ["varm", "leken"], style_notes: "Litt mer avslappet." },
      "cred",
      ctx
    );
    expect(service._calls).toHaveLength(1);
    expect(service._calls[0]?.method).toBe("proposePersonalityChange");
    expect((service._calls[0]?.args[0] as IdentityContext).person_id).toBe("person-actor");
    expect(service._calls[0]?.args[1]).toEqual({ tone_descriptors: ["varm", "leken"], style_notes: "Litt mer avslappet." });
  });

  it("C2: resultatet fra service returneres som external_id + data", async () => {
    const transport = new SelfModificationTransport(fakeService());
    const ctx = { identity: identity() };
    const result = await transport.invoke(
      "propose_personality_change",
      { tone_descriptors: ["varm"], style_notes: "x" },
      "cred",
      ctx
    );
    expect(result.external_id).toBe("selfmod-1");
    expect((result.data as { risk: string }).risk).toBe("zero_review");
  });

  it("C3: manglende tone_descriptors kaster missing_parameter:tone_descriptors", async () => {
    const transport = new SelfModificationTransport(fakeService());
    const ctx = { identity: identity() };
    await expect(
      transport.invoke("propose_personality_change", { style_notes: "x" }, "cred", ctx)
    ).rejects.toThrow("missing_parameter:tone_descriptors");
  });

  it("C4: tomt tone_descriptors-array kaster missing_parameter:tone_descriptors (min 1 element)", async () => {
    const transport = new SelfModificationTransport(fakeService());
    const ctx = { identity: identity() };
    await expect(
      transport.invoke("propose_personality_change", { tone_descriptors: [], style_notes: "x" }, "cred", ctx)
    ).rejects.toThrow("missing_parameter:tone_descriptors");
  });

  it("C5: manglende style_notes kaster missing_parameter:style_notes", async () => {
    const transport = new SelfModificationTransport(fakeService());
    const ctx = { identity: identity() };
    await expect(
      transport.invoke("propose_personality_change", { tone_descriptors: ["varm"] }, "cred", ctx)
    ).rejects.toThrow("missing_parameter:style_notes");
  });

  it("C6: en tone_descriptors-verdi som IKKE er en streng-array kaster missing_parameter", async () => {
    const transport = new SelfModificationTransport(fakeService());
    const ctx = { identity: identity() };
    await expect(
      transport.invoke("propose_personality_change", { tone_descriptors: "varm" as unknown as JsonValue, style_notes: "x" }, "cred", ctx)
    ).rejects.toThrow("missing_parameter:tone_descriptors");
  });

  it("C7: ukjent action kaster unknown_self_modification_action:<action>", async () => {
    const transport = new SelfModificationTransport(fakeService());
    const ctx = { identity: identity() };
    await expect(transport.invoke("merge_everything", {}, "cred", ctx)).rejects.toThrow(
      "unknown_self_modification_action:merge_everything"
    );
  });
});
