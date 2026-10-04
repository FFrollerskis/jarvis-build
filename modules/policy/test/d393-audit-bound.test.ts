import { describe, expect, it } from "vitest";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";

/** D-393 (JARVIS-053): den innebygde minne-journalen er begrenset (ringbuffer), ikke ubegrenset. */
const identity = {
  person_id: "person-tobias", tenant_id: "tenant-personal", memory_space_id: "home", session_id: "sess-1",
  device_id: "dev-pc-1", channel: "web", auth_strength: "active"
} as const;

describe("JARVIS-053: begrenset in-memory audit", () => {
  it("journalen holder aldri mer enn maxInMemoryAudit og teller forkastede hendelser", async () => {
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), maxInMemoryAudit: 10
    });
    for (let i = 0; i < 25; i += 1) {
      await policy.authorize({ identity, toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: { n: i } } });
    }
    expect(policy.auditLog).toHaveLength(10);
    expect(policy.auditDropped).toBe(15);
  });

  it("en koblet auditSink tar over: ingenting samles i minnet", async () => {
    const sunk: unknown[] = [];
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), auditSink: (e) => { sunk.push(e); }
    });
    await policy.authorize({ identity, toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: {} } });
    expect(sunk).toHaveLength(1);
    expect(policy.auditLog).toHaveLength(0);
  });
});
