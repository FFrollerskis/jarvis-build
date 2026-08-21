import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { InMemoryDeviceRegistry, InMemoryNonceStore, InfraExecutionGate, KillSwitch, PolicyGateway } from "../src/index.ts";

/**
 * D-104 (UA-5 Production Operations Control Plane v1): `InfraExecutionGate`
 * er en NY, SNEVRERE bryter enn `KillSwitch` (uendret, forblir strengest -
 * blokkerer ALT). Testene under beviser (1) den rene gate-logikken isolert,
 * OG (2) at gaten FAKTISK håndheves gjennom `PolicyGateway.authorize()` -
 * IKKE bare at klassen finnes, men at et reelt policy-kall faktisk blokkeres/
 * slipper gjennom identisk med `check()`s kontrakt. §9/§13 i byggeordren:
 * "no silent bypass through direct adapter invocation" - siden ALLE
 * ToolGateway-kall MÅ gjennom `policy.authorize()` (ingen unntak i
 * gateway.ts), er DENNE testen beviset for at det ikke finnes en vei rundt.
 */

const identity: IdentityContext = {
  person_id: "person-x", tenant_id: "tenant-x", memory_space_id: "business",
  session_id: "sess-1", device_id: "dev-1", channel: "api", auth_strength: "active"
};

function githubToolCall(capability_class: "A" | "B" | "C" | "D") {
  return { tool_id: "github", action: "whatever", capability_class, parameters: {} };
}

describe("D-104: InfraExecutionGate - ren logikk", () => {
  it("A: NORMAL (default) blokkerer ingenting", () => {
    const gate = new InfraExecutionGate();
    expect(gate.current().mode).toBe("NORMAL");
    for (const c of ["A", "B", "C", "D"] as const) expect(gate.check(c)).toBeNull();
  });

  it("B: PAUSED blokkerer B/C/D, ALDRI A (diagnostikk/lesing forblir alltid tilgjengelig)", () => {
    const gate = new InfraExecutionGate();
    gate.pause("owner_requested");
    expect(gate.check("A")).toBeNull();
    expect(gate.check("B")).toBe("infra_paused");
    expect(gate.check("C")).toBe("infra_paused");
    expect(gate.check("D")).toBe("infra_paused");
  });

  it("C: DEGRADED blokkerer KUN klasse D - B/C fortsetter, A uendret", () => {
    const gate = new InfraExecutionGate();
    gate.degrade("partial_outage");
    expect(gate.check("A")).toBeNull();
    expect(gate.check("B")).toBeNull();
    expect(gate.check("C")).toBeNull();
    expect(gate.check("D")).toBe("infra_degraded_blocks_class_d");
  });

  it("D: resume() går tilbake til NORMAL fra BÅDE PAUSED og DEGRADED", () => {
    const gate = new InfraExecutionGate();
    gate.pause("x");
    gate.resume();
    expect(gate.current().mode).toBe("NORMAL");
    gate.degrade("y");
    gate.resume();
    expect(gate.current().mode).toBe("NORMAL");
  });

  it("E: current() eksponerer reason/at for pause/degrade, ikke for resume", () => {
    const gate = new InfraExecutionGate();
    gate.pause("planned maintenance");
    expect(gate.current().reason).toBe("planned maintenance");
    expect(gate.current().at).toBeTruthy();
    gate.resume();
    expect(gate.current().reason).toBeUndefined();
  });
});

describe("D-104: InfraExecutionGate faktisk håndhevet i PolicyGateway.authorize()", () => {
  function buildPolicy(infraGate?: InfraExecutionGate, infraToolIds?: ReadonlySet<string>) {
    return new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      ...(infraGate !== undefined ? { infraGate } : {}), ...(infraToolIds !== undefined ? { infraToolIds } : {})
    });
  }

  it("F: uten infraGate/infraToolIds konfigurert er oppførselen 100% uendret (bakoverkompatibelt)", async () => {
    const policy = buildPolicy();
    const decision = await policy.authorize({ identity, toolCall: githubToolCall("B") });
    expect(decision.decision).toBe("ALLOW");
  });

  it("G: PAUSED blokkerer et EKTE class-B github-kall gjennom policy.authorize()", async () => {
    const gate = new InfraExecutionGate();
    gate.pause("incident response");
    const policy = buildPolicy(gate, new Set(["github"]));
    const decision = await policy.authorize({ identity, toolCall: githubToolCall("B") });
    expect(decision.decision).toBe("DENY");
    expect(decision.reason).toBe("infra_paused");
  });

  it("H: PAUSED tillater FORTSATT et class-A github-kall (diagnostikk aldri stanset)", async () => {
    const gate = new InfraExecutionGate();
    gate.pause("incident response");
    const policy = buildPolicy(gate, new Set(["github"]));
    const decision = await policy.authorize({ identity, toolCall: githubToolCall("A") });
    expect(decision.decision).toBe("ALLOW");
  });

  it("I: PAUSED påvirker IKKE et tool_id UTENFOR infraToolIds (kun registrerte infra-verktøy gates)", async () => {
    const gate = new InfraExecutionGate();
    gate.pause("incident response");
    const policy = buildPolicy(gate, new Set(["github"]));
    const decision = await policy.authorize({
      identity, toolCall: { tool_id: "email", action: "send", capability_class: "B", parameters: {} }
    });
    expect(decision.decision).toBe("ALLOW");
  });

  it("J: DEGRADED blokkerer KUN et class-D github-kall gjennom policy.authorize(), class-B slipper gjennom", async () => {
    const gate = new InfraExecutionGate();
    gate.degrade("partial_outage");
    const policy = buildPolicy(gate, new Set(["github"]));
    const b = await policy.authorize({ identity, toolCall: githubToolCall("B") });
    expect(b.decision).toBe("ALLOW");
    const d = await policy.authorize({ identity, toolCall: githubToolCall("D") });
    expect(d.decision).toBe("DENY");
    expect(d.reason).toBe("infra_degraded_blocks_class_d");
  });

  it("K: KillSwitch forblir STRENGERE enn InfraExecutionGate - aktiv kill switch blokkerer selv når infraGate er NORMAL, OG blokkerer klasse A (i motsetning til infraGate)", async () => {
    const killSwitch = new KillSwitch();
    const gate = new InfraExecutionGate(); // NORMAL - ville IKKE blokkert alene
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, infraGate: gate, infraToolIds: new Set(["github"])
    });
    killSwitch.activate("emergency");
    const decision = await policy.authorize({ identity, toolCall: githubToolCall("A") });
    expect(decision.decision).toBe("DENY");
    expect(decision.reason).toBe("kill_switch_active");
  });

  it("L: ingen bypass via et ANNET registrert infra-tool_id (f.eks. et fremtidig 'vercel') - PAUSED gjelder ALLE infraToolIds-medlemmer identisk", async () => {
    const gate = new InfraExecutionGate();
    gate.pause("x");
    const policy = buildPolicy(gate, new Set(["github", "vercel"]));
    const decision = await policy.authorize({
      identity, toolCall: { tool_id: "vercel", action: "deploy", capability_class: "C", parameters: {} }
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.reason).toBe("infra_paused");
  });

  it("M: direkte gate.check()-kall og et EKTE policy.authorize()-kall gir IDENTISK resultat for samme (mode, capability_class) - ingen skjult avvik mellom de to lagene (SOVEREIGN-identitet brukt slik at KUN infraGate avgjør class C/D-utfallet, aldri mandat-/approval-logikken)", async () => {
    const gate = new InfraExecutionGate();
    gate.degrade("x");
    const policy = new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      infraGate: gate, infraToolIds: new Set(["github"]),
      authority: { owner_person_id: identity.person_id, owner_tenants: [identity.tenant_id] }
    });
    for (const c of ["A", "B", "C", "D"] as const) {
      const direct = gate.check(c);
      const viaPolicy = await policy.authorize({ identity, toolCall: githubToolCall(c) });
      if (direct === null) expect(viaPolicy.decision).toBe("ALLOW");
      else {
        expect(viaPolicy.decision).toBe("DENY");
        expect(viaPolicy.reason).toBe(direct);
      }
    }
  });
});
