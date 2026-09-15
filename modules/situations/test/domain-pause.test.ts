import { describe, expect, it } from "vitest";
import { ALL_DOMAINS, DomainPauseRegistry } from "../src/domain-pause.ts";

/**
 * UA-10 akseptansekriterium: "Owner can pause a domain or entire Situation
 * Engine instantly". Rent enhets-nivå-bevis (ingen embedded Postgres
 * nødvendig - in-memory, deterministisk, samme "instantly"-disiplin som
 * `KillSwitch`, se domain-pause.ts sitt filhode).
 */
describe("A: domene-scoped pause - kun det navngitte domenet paavirkes", () => {
  it("et paused domene er paused; et annet domene er upaavirket", () => {
    const registry = new DomainPauseRegistry();
    registry.pause("spend", "manuell pause - undersoeker et avvik");
    expect(registry.isPaused("spend")).toBe(true);
    expect(registry.isPaused("pipeline")).toBe(false);
    expect(registry.pauseReason("spend")).toBe("manuell pause - undersoeker et avvik");
  });

  it("unpause fjerner pausen for akkurat det domenet", () => {
    const registry = new DomainPauseRegistry();
    registry.pause("spend", "test");
    registry.unpause("spend");
    expect(registry.isPaused("spend")).toBe(false);
  });

  it("et domene som aldri ble paused er alltid upaused", () => {
    const registry = new DomainPauseRegistry();
    expect(registry.isPaused("infra")).toBe(false);
    expect(registry.pauseReason("infra")).toBeUndefined();
  });
});

describe("B: pauseAll - hele Situation Engine, vinner over enkelt-domene-tilstand", () => {
  it("pauseAll paaviker ETHVERT domenenavn, inkl. ett som aldri ble eksplisitt registrert", () => {
    const registry = new DomainPauseRegistry();
    registry.pauseAll("owner freezet alt midlertidig");
    expect(registry.isPaused("spend")).toBe(true);
    expect(registry.isPaused("a-helt-nytt-domene-ingen-har-hoert-om")).toBe(true);
    expect(registry.pausedDomains()).toContain(ALL_DOMAINS);
  });

  it("unpauseAll gjenoppretter individuelle domene-pauser (som IKKE ble fjernet av pauseAll)", () => {
    const registry = new DomainPauseRegistry();
    registry.pause("spend", "spesifikk grunn");
    registry.pauseAll("global grunn");
    registry.unpauseAll();
    expect(registry.isPaused("spend")).toBe(true); // domene-spesifikk pause overlevde alt-pausen sin fjerning.
    expect(registry.isPaused("pipeline")).toBe(false);
  });

  it("alt-domene-grunnen foretrekkes i pauseReason() naar BEGGE er satt for samme domene", () => {
    const registry = new DomainPauseRegistry();
    registry.pause("spend", "domene-spesifikk grunn");
    registry.pauseAll("bredere, mer relevant grunn");
    expect(registry.pauseReason("spend")).toBe("bredere, mer relevant grunn");
  });
});
