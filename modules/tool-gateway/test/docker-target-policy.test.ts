import { describe, expect, it } from "vitest";
import { authorizeDockerTarget, isSentinelTarget, parseDockerMutationTargets } from "../src/docker-target-policy.ts";

/**
 * D-105 host-fix (D-41-korreksjon): rene, deterministiske enhetstester for
 * mål-autorisasjonsmekanismen som erstattet den permanente `assertSentinel
 * Target()`-forretningsregelen i docker-transport.ts. Se docker-target-
 * policy.ts for full begrunnelse.
 */
describe("D-105 host-fix: authorizeDockerTarget()", () => {
  it("A: sentinel-mål er ALLTID tillatt for redeploy_container (akseptanse-tier)", () => {
    expect(authorizeDockerTarget("redeploy_container", "jarvis-sentinel-x", new Set())).toEqual({
      allowed: true, reason: "acceptance_sentinel_target"
    });
  });
  it("B: sentinel-mål er ALLTID tillatt for stop_container", () => {
    expect(authorizeDockerTarget("stop_container", "jarvis-sentinel-x", new Set()).allowed).toBe(true);
  });
  it("C: sentinel-mål er ALLTID tillatt for start_container", () => {
    expect(authorizeDockerTarget("start_container", "jarvis-sentinel-x", new Set()).allowed).toBe(true);
  });
  it("D: ikke-sentinel + UKONFIGURERT mål -> NEKTET for stop_container (fail-closed)", () => {
    const result = authorizeDockerTarget("stop_container", "jarvis-api-1", new Set());
    expect(result).toEqual({ allowed: false, reason: "docker_target_not_authorized" });
  });
  it("E: ikke-sentinel + KONFIGURERT mål -> TILLATT for stop_container", () => {
    const result = authorizeDockerTarget("stop_container", "jarvis-api-1", new Set(["jarvis-api-1"]));
    expect(result).toEqual({ allowed: true, reason: "owner_configured_production_target" });
  });
  it("F: ikke-sentinel + KONFIGURERT mål -> TILLATT for start_container", () => {
    const result = authorizeDockerTarget("start_container", "jarvis-worker-1", new Set(["jarvis-worker-1"]));
    expect(result.allowed).toBe(true);
  });
  it("G: ikke-sentinel + KONFIGURERT mål -> FORBLIR NEKTET for redeploy_container (DEFERRED for produksjon uansett konfigurasjon - §13 i byggeordren)", () => {
    const result = authorizeDockerTarget("redeploy_container", "jarvis-api-1", new Set(["jarvis-api-1"]));
    expect(result).toEqual({ allowed: false, reason: "action_deferred_for_production_targets" });
  });
  it("H: et KONFIGURERT mål som IKKE står i settet forblir nektet selv om ANDRE mål er konfigurert", () => {
    const result = authorizeDockerTarget("stop_container", "jarvis-other-1", new Set(["jarvis-api-1"]));
    expect(result.allowed).toBe(false);
  });
});

describe("D-105 host-fix: isSentinelTarget()", () => {
  it("I: gjenkjenner jarvis-sentinel-* prefiks", () => {
    expect(isSentinelTarget("jarvis-sentinel-host-run-1")).toBe(true);
    expect(isSentinelTarget("jarvis-api-1")).toBe(false);
  });
});

describe("D-105 host-fix: parseDockerMutationTargets()", () => {
  it("J: parser kommaseparerte EKSAKTE navn", () => {
    const set = parseDockerMutationTargets("jarvis-api-1,jarvis-worker-1");
    expect(set.has("jarvis-api-1")).toBe(true);
    expect(set.has("jarvis-worker-1")).toBe(true);
    expect(set.size).toBe(2);
  });
  it("K: trimmer mellomrom rundt hvert navn", () => {
    const set = parseDockerMutationTargets(" jarvis-api-1 , jarvis-worker-1 ");
    expect(set.has("jarvis-api-1")).toBe(true);
    expect(set.has("jarvis-worker-1")).toBe(true);
  });
  it("L: tomt/manglende -> tomt sett (fail-closed for produksjon)", () => {
    expect(parseDockerMutationTargets(undefined).size).toBe(0);
    expect(parseDockerMutationTargets(null).size).toBe(0);
    expect(parseDockerMutationTargets("").size).toBe(0);
  });
  it("M: et UGYLDIG enkeltnavn (feil tegnsett) HOPPES OVER - resten av listen parses likevel", () => {
    const set = parseDockerMutationTargets("jarvis-api-1,bad name; rm -rf /,jarvis-worker-1");
    expect(set.has("jarvis-api-1")).toBe(true);
    expect(set.has("jarvis-worker-1")).toBe(true);
    expect(set.size).toBe(2);
  });
  it("N: sentinel-navngitte oppføringer i env-variabelen EKSKLUDERES fra produksjonssettet - sentinel er KUN akseptanse-tier, uansett hva som (feilaktig) står her", () => {
    const set = parseDockerMutationTargets("jarvis-sentinel-oops,jarvis-api-1");
    expect(set.has("jarvis-sentinel-oops")).toBe(false);
    expect(set.has("jarvis-api-1")).toBe(true);
  });
  it("O: tomme oppføringer (doble komma) hoppes over", () => {
    const set = parseDockerMutationTargets("jarvis-api-1,,jarvis-worker-1,");
    expect(set.size).toBe(2);
  });
});
