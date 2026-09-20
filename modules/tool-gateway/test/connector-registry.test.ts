import { describe, expect, it } from "vitest";
import { CONNECTOR_REGISTRY, listConnectorStatus } from "../src/connector-registry.ts";

/**
 * Task #119 (integrasjons-dashboard, D-211): DB-uavhengige tester - en fake
 * `{ hasSecret, health }` (nøyaktig `Pick<ToolGateway, "hasSecret"|"health">`
 * `listConnectorStatus()` selv krever) er nok til å bevise presence-/helse-
 * komposisjonen uten embedded Postgres.
 */
function fakeGateway(configured: Set<string>, health: Array<[string, { state: string; at: string; detail?: string }]> = []) {
  return {
    hasSecret: async (ref: string) => configured.has(ref),
    health: new Map(health)
  };
}

describe("A: CONNECTOR_REGISTRY - ren data, ingen duplikate id-er, live_test peker på kjente tool_id/action", () => {
  it("hver connector har en unik id", () => {
    const ids = CONNECTOR_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("hver connector har minst én credential_ref", () => {
    for (const c of CONNECTOR_REGISTRY) {
      expect(c.credential_refs.length).toBeGreaterThan(0);
    }
  });

  it("live_test er KUN satt for github/google_calendar/gmail i denne sliceen (bevisst avgrenset, D-211)", () => {
    const withLiveTest = CONNECTOR_REGISTRY.filter((c) => c.live_test).map((c) => c.id).sort();
    expect(withLiveTest).toEqual(["gmail", "google_calendar", "github"].sort());
  });

  it("live_test.parameters er en FUNKSJON (bygges friskt ved kalletidspunkt, aldri frosset ved modul-last)", () => {
    for (const c of CONNECTOR_REGISTRY) {
      if (c.live_test) expect(typeof c.live_test.parameters).toBe("function");
    }
  });
});

describe("B: listConnectorStatus() - presence per credential_ref, ALDRI selve verdien", () => {
  it("configured=true KUN når ALLE påkrevde refs for connectoren er tilstede", async () => {
    const gateway = fakeGateway(new Set(["JARVIS_GITHUB_TOKEN"]));
    const statuses = await listConnectorStatus(gateway);
    const github = statuses.find((s) => s.id === "github");
    expect(github?.configured).toBe(true);

    const wallester = statuses.find((s) => s.id === "wallester");
    // wallester krever BÅDE JARVIS_WALLESTER_API_KEY og JARVIS_WALLESTER_PRIVATE_KEY_PEM - ingen konfigurert her.
    expect(wallester?.configured).toBe(false);
    expect(wallester?.credentials).toEqual([
      { ref: "JARVIS_WALLESTER_API_KEY", configured: false },
      { ref: "JARVIS_WALLESTER_PRIVATE_KEY_PEM", configured: false }
    ]);
  });

  it("credentials[] inneholder KUN {ref, configured} - aldri et 'value'-felt eller lignende", async () => {
    const gateway = fakeGateway(new Set(["JARVIS_GITHUB_TOKEN"]));
    const statuses = await listConnectorStatus(gateway);
    for (const status of statuses) {
      for (const cred of status.credentials) {
        expect(Object.keys(cred).sort()).toEqual(["configured", "ref"]);
      }
    }
  });

  it("test_method er 'live' for github/calendar/gmail, 'presence_only' for resten", async () => {
    const gateway = fakeGateway(new Set());
    const statuses = await listConnectorStatus(gateway);
    const byId = new Map(statuses.map((s) => [s.id, s]));
    expect(byId.get("github")?.test_method).toBe("live");
    expect(byId.get("google_calendar")?.test_method).toBe("live");
    expect(byId.get("gmail")?.test_method).toBe("live");
    expect(byId.get("telegram")?.test_method).toBe("presence_only");
    expect(byId.get("anthropic")?.test_method).toBe("presence_only");
  });

  it("health speiler gateway.health for connectorer med live_test (nøkkel = live_test.tool_id), null når intet forsøkt ennå", async () => {
    const gateway = fakeGateway(new Set(), [["github", { state: "healthy", at: "2026-09-20T12:00:00.000Z" }]]);
    const statuses = await listConnectorStatus(gateway);
    const github = statuses.find((s) => s.id === "github");
    expect(github?.health).toEqual({ state: "healthy", at: "2026-09-20T12:00:00.000Z" });
    const telegram = statuses.find((s) => s.id === "telegram");
    expect(telegram?.health).toBeNull();
  });

  it("returnerer nøyaktig ETT element per registeroppføring, i samme rekkefølge", async () => {
    const gateway = fakeGateway(new Set());
    const statuses = await listConnectorStatus(gateway);
    expect(statuses.map((s) => s.id)).toEqual(CONNECTOR_REGISTRY.map((c) => c.id));
  });
});
