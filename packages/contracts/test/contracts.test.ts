import { describe, expect, it } from "vitest";
import {
  EventEnvelopeSchema,
  IdentityContextSchema,
  JobContractSchema,
  SignedApprovalSchema,
  ToolCallSchema,
  approvalSigningBytes,
  canonicalStringify,
  jsonEquals
} from "@jarvis/contracts";

const validIdentity = {
  person_id: "person-tobias",
  tenant_id: "tenant-personal",
  memory_space_id: "personal",
  session_id: "sess-1",
  device_id: "dev-pc-1",
  channel: "web",
  auth_strength: "active"
};

describe("IdentityContext", () => {
  it("godtar gyldig kontekst", () => {
    expect(IdentityContextSchema.parse(validIdentity)).toMatchObject(validIdentity);
  });

  it("avviser ukjent memory space", () => {
    expect(() => IdentityContextSchema.parse({ ...validIdentity, memory_space_id: "secret" })).toThrow();
  });

  it("avviser ukjente felter (strict)", () => {
    expect(() => IdentityContextSchema.parse({ ...validIdentity, admin: true })).toThrow();
  });
});

describe("ToolCall", () => {
  it("godtar gyldig kall og avviser ugyldig klasse", () => {
    const call = { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: {} };
    expect(ToolCallSchema.parse(call).capability_class).toBe("A");
    expect(() => ToolCallSchema.parse({ ...call, capability_class: "E" })).toThrow();
  });
});

describe("SignedApproval", () => {
  const approval = {
    action: "unlock_front_door",
    parameters: { door: "front" },
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    nonce: "nonce-1234567890abcdef",
    approving_device_id: "watch-1",
    signature: "c2lnbmF0dXJl"
  };

  it("godtar gyldig objekt og avviser manglende nonce", () => {
    expect(SignedApprovalSchema.parse(approval).action).toBe("unlock_front_door");
    expect(() => SignedApprovalSchema.parse({ ...approval, nonce: "kort" })).toThrow();
  });

  it("signeringsbytes er stabile uavhengig av nøkkelrekkefølge i parameters", () => {
    const a = approvalSigningBytes({ ...approval, parameters: { a: 1, b: 2 } });
    const b = approvalSigningBytes({ ...approval, parameters: { b: 2, a: 1 } });
    expect(a.equals(b)).toBe(true);
  });
});

describe("JobContract", () => {
  it("krever akseptansekriterier og budsjett", () => {
    const job = {
      task_id: "task-1",
      owner_person_id: "person-tobias",
      tenant_id: "tenant-personal",
      goal: "Testjobb",
      acceptance_criteria: ["tester kjører grønt"],
      input: { data: {}, trust_level: "internal", provenance: "test" },
      allowed_tools: [],
      allowed_memory_spaces: ["project"],
      allowed_network_targets: [],
      agent_profile: "verifier",
      model_budget_ore: 0,
      retry_policy: { max_attempts: 1, backoff_seconds: 0 },
      max_steps: 5
    };
    expect(JobContractSchema.parse(job).task_id).toBe("task-1");
    expect(() => JobContractSchema.parse({ ...job, acceptance_criteria: [] })).toThrow();
  });
});

describe("EventEnvelope", () => {
  it("godtar gyldig konvolutt og avviser ugyldig uuid", () => {
    const event = {
      event_id: "6f1a1c1e-9b2d-4a3f-8c4d-5e6f7a8b9c0d",
      idempotency_key: "key-1",
      occurred_at: new Date().toISOString(),
      source: "core.policy",
      type: "tool_call.denied",
      tenant_id: "tenant-personal",
      trust_level: "internal",
      payload: { reason: "test" }
    };
    expect(EventEnvelopeSchema.parse(event).type).toBe("tool_call.denied");
    expect(() => EventEnvelopeSchema.parse({ ...event, event_id: "ikke-uuid" })).toThrow();
  });
});

describe("canonicalStringify", () => {
  it("sorterer nøkler rekursivt og bevarer arrays", () => {
    expect(canonicalStringify({ b: [{ y: 1, x: 2 }], a: null })).toBe('{"a":null,"b":[{"x":2,"y":1}]}');
    expect(jsonEquals({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
  });
});
