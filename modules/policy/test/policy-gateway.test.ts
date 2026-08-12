import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { approvalSigningBytes, type ApprovalPayload, type JsonValue, type SignedApproval } from "@jarvis/contracts";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";

// Testnøkler generert i minnet per testkjøring - aldri produksjonsnøkler.
const watchKeys = generateKeyPairSync("ed25519");
const rogueKeys = generateKeyPairSync("ed25519");

const identity = {
  person_id: "person-tobias",
  tenant_id: "tenant-personal",
  memory_space_id: "home",
  session_id: "sess-1",
  device_id: "dev-pc-1",
  channel: "web",
  auth_strength: "active"
} as const;

const unlockDoor = {
  tool_id: "home-assistant",
  action: "unlock_front_door",
  capability_class: "D",
  parameters: { door: "front" } as Record<string, JsonValue>
} as const;

function makeApproval(overrides: Partial<ApprovalPayload> = {}, signWith = watchKeys.privateKey): SignedApproval {
  const payload: ApprovalPayload = {
    action: "unlock_front_door",
    parameters: { door: "front" },
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    nonce: `nonce-${randomUUID()}`,
    approving_device_id: "watch-1",
    ...overrides
  };
  const signature = sign(null, approvalSigningBytes(payload), signWith).toString("base64");
  return { ...payload, signature };
}

let gateway: PolicyGateway;
let killSwitch: KillSwitch;

beforeEach(() => {
  const devices = new InMemoryDeviceRegistry();
  devices.register("watch-1", watchKeys.publicKey);
  killSwitch = new KillSwitch();
  gateway = new PolicyGateway({
    devices,
    nonces: new InMemoryNonceStore(),
    killSwitch,
    mandates: new Set(["github:create_pr"])
  });
});

describe("Klasse A-C (skjelett)", () => {
  it("klasse A (lesing) tillates", () => {
    const result = gateway.authorize({
      identity,
      toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: {} }
    });
    expect(result.decision).toBe("ALLOW");
  });

  it("klasse B nektes ved passiv auth, tillates ved aktiv", () => {
    const toolCall = { tool_id: "tasks", action: "create_note", capability_class: "B", parameters: {} } as const;
    expect(
      gateway.authorize({ identity: { ...identity, auth_strength: "passive" }, toolCall }).decision
    ).toBe("DENY");
    expect(gateway.authorize({ identity, toolCall }).decision).toBe("ALLOW");
  });

  it("klasse C nektes uten mandat, tillates innen mandat", () => {
    const noMandate = { tool_id: "gmail", action: "send_email", capability_class: "C", parameters: {} } as const;
    const withMandate = { tool_id: "github", action: "create_pr", capability_class: "C", parameters: {} } as const;
    expect(gateway.authorize({ identity, toolCall: noMandate }).decision).toBe("DENY");
    expect(gateway.authorize({ identity, toolCall: withMandate }).decision).toBe("ALLOW");
  });
});

describe("Klasse D - obligatoriske akseptansetester", () => {
  it("Test 1: klasse D uten godkjenning => DENY", () => {
    const result = gateway.authorize({ identity, toolCall: unlockDoor });
    expect(result.decision).toBe("DENY");
    expect(result.reason).toBe("class_d_missing_approval");
  });

  it("Test 2: ugyldig signatur (feil nøkkel) => DENY", () => {
    const result = gateway.authorize({
      identity,
      toolCall: unlockDoor,
      approval: makeApproval({}, rogueKeys.privateKey)
    });
    expect(result.decision).toBe("DENY");
    expect(result.reason).toBe("class_d_invalid_signature");
  });

  it("Test 2b: manipulert innhold etter signering => DENY", () => {
    const approval = makeApproval();
    const tampered = { ...approval, parameters: { door: "garage" } };
    const result = gateway.authorize({ identity, toolCall: unlockDoor, approval: tampered });
    expect(result.decision).toBe("DENY");
    expect(result.reason).toBe("class_d_invalid_signature");
  });

  it("Test 3: godkjenning for annen handling => DENY", () => {
    const approval = makeApproval({ action: "disarm_alarm" });
    const result = gateway.authorize({ identity, toolCall: unlockDoor, approval });
    expect(result.decision).toBe("DENY");
    expect(result.reason).toBe("class_d_action_mismatch");
  });

  it("Test 4: godkjenning med andre parametere => DENY", () => {
    const approval = makeApproval({ parameters: { door: "back" } });
    const result = gateway.authorize({ identity, toolCall: unlockDoor, approval });
    expect(result.decision).toBe("DENY");
    expect(result.reason).toBe("class_d_parameters_mismatch");
  });

  it("Test 5: utløpt godkjenning => DENY", () => {
    const approval = makeApproval({ expires_at: new Date(Date.now() - 1_000).toISOString() });
    const result = gateway.authorize({ identity, toolCall: unlockDoor, approval });
    expect(result.decision).toBe("DENY");
    expect(result.reason).toBe("class_d_expired");
  });

  it("Test 6: nonce er engangs - første ALLOW, andre DENY (replay-vern)", () => {
    const approval = makeApproval();
    const first = gateway.authorize({ identity, toolCall: unlockDoor, approval });
    expect(first.decision).toBe("ALLOW");
    const replay = gateway.authorize({ identity, toolCall: unlockDoor, approval });
    expect(replay.decision).toBe("DENY");
    expect(replay.reason).toBe("class_d_nonce_already_used");
  });

  it("Test 8: gyldig signert godkjenning => ALLOW", () => {
    const result = gateway.authorize({ identity, toolCall: unlockDoor, approval: makeApproval() });
    expect(result.decision).toBe("ALLOW");
    expect(result.reason).toBe("class_d_valid_signed_approval");
  });

  it("ukjent godkjenningsenhet => DENY", () => {
    const approval = makeApproval({ approving_device_id: "ukjent-enhet" });
    const result = gateway.authorize({ identity, toolCall: unlockDoor, approval });
    expect(result.decision).toBe("DENY");
    expect(result.reason).toBe("class_d_unknown_device");
  });

  it("feilet kontroll brenner ikke nonce - gyldig forsøk etterpå fungerer", () => {
    const approval = makeApproval();
    // Først: samme nonce men feil handling => DENY uten nonce-forbruk
    gateway.authorize({
      identity,
      toolCall: { ...unlockDoor, action: "disarm_alarm" },
      approval
    });
    const valid = gateway.authorize({ identity, toolCall: unlockDoor, approval });
    expect(valid.decision).toBe("ALLOW");
  });
});

describe("Test 7: kill switch", () => {
  it("aktiv kill switch => DENY for alle klasser, også med gyldig godkjenning", () => {
    killSwitch.activate("test");
    const classA = { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: {} } as const;
    const classB = { tool_id: "tasks", action: "create_note", capability_class: "B", parameters: {} } as const;
    const classC = { tool_id: "github", action: "create_pr", capability_class: "C", parameters: {} } as const;
    for (const toolCall of [classA, classB, classC]) {
      const result = gateway.authorize({ identity, toolCall });
      expect(result.decision).toBe("DENY");
      expect(result.reason).toBe("kill_switch_active");
    }
    const classD = gateway.authorize({ identity, toolCall: unlockDoor, approval: makeApproval() });
    expect(classD.decision).toBe("DENY");
    expect(classD.reason).toBe("kill_switch_active");
  });

  it("deaktivert kill switch gjenoppretter normal autorisasjon", () => {
    killSwitch.activate("test");
    killSwitch.deactivate();
    const result = gateway.authorize({
      identity,
      toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: {} }
    });
    expect(result.decision).toBe("ALLOW");
  });
});

describe("Audit", () => {
  it("alle beslutninger logges med identitet og årsak", () => {
    gateway.authorize({ identity, toolCall: unlockDoor });
    gateway.authorize({
      identity,
      toolCall: { tool_id: "calendar", action: "read_events", capability_class: "A", parameters: {} }
    });
    expect(gateway.auditLog).toHaveLength(2);
    expect(gateway.auditLog[0]).toMatchObject({
      decision: "DENY",
      reason: "class_d_missing_approval",
      person_id: "person-tobias",
      tenant_id: "tenant-personal",
      capability_class: "D"
    });
  });

  it("ugyldig identitetskontekst => DENY og logges", () => {
    const bad = { ...identity, memory_space_id: "hemmelig" } as unknown as typeof identity;
    const result = gateway.authorize({ identity: bad, toolCall: unlockDoor });
    expect(result.decision).toBe("DENY");
    expect(result.reason).toBe("invalid_identity_context");
  });
});
