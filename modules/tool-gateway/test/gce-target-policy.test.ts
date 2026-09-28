import { describe, expect, it } from "vitest";
import { authorizeGceTarget, isGceSentinelTarget, parseGceMutationTargets } from "../src/gce-target-policy.ts";

/**
 * D-337 (Google Cloud "servere"-sliceen): rene, deterministiske enhetstester
 * for GCE sin mål-autorisasjonsmekanisme - SAMME mønster som `docker-target-
 * policy.test.ts`, tilpasset det sammensatte `zone/instance`-målformatet.
 */
describe("D-337: authorizeGceTarget()", () => {
  it("A: sentinel-instans er ALLTID tillatt for start_instance (akseptanse-tier)", () => {
    expect(authorizeGceTarget("start_instance", "europe-west1-b", "jarvis-sentinel-x", new Set())).toEqual({
      allowed: true, reason: "acceptance_sentinel_target"
    });
  });
  it("B: sentinel-instans er ALLTID tillatt for stop_instance", () => {
    expect(authorizeGceTarget("stop_instance", "europe-west1-b", "jarvis-sentinel-x", new Set()).allowed).toBe(true);
  });
  it("C: sentinel-instans er ALLTID tillatt for reset_instance", () => {
    expect(authorizeGceTarget("reset_instance", "europe-west1-b", "jarvis-sentinel-x", new Set()).allowed).toBe(true);
  });
  it("D: ikke-sentinel + UKONFIGURERT mål -> NEKTET for stop_instance (fail-closed)", () => {
    const result = authorizeGceTarget("stop_instance", "europe-west1-b", "jarvis-api-1", new Set());
    expect(result).toEqual({ allowed: false, reason: "gce_target_not_authorized" });
  });
  it("E: ikke-sentinel + KONFIGURERT mål -> TILLATT for stop_instance", () => {
    const result = authorizeGceTarget("stop_instance", "europe-west1-b", "jarvis-api-1", new Set(["europe-west1-b/jarvis-api-1"]));
    expect(result).toEqual({ allowed: true, reason: "owner_configured_production_target" });
  });
  it("F: ikke-sentinel + KONFIGURERT mål -> TILLATT for start_instance", () => {
    const result = authorizeGceTarget("start_instance", "europe-west1-b", "jarvis-worker-1", new Set(["europe-west1-b/jarvis-worker-1"]));
    expect(result.allowed).toBe(true);
  });
  it("G: ikke-sentinel + KONFIGURERT mål -> FORBLIR NEKTET for reset_instance (DEFERRED for produksjon uansett konfigurasjon - hard reboot, ikke bevist trygg)", () => {
    const result = authorizeGceTarget("reset_instance", "europe-west1-b", "jarvis-api-1", new Set(["europe-west1-b/jarvis-api-1"]));
    expect(result).toEqual({ allowed: false, reason: "action_deferred_for_production_targets" });
  });
  it("H: et KONFIGURERT mål som IKKE står i settet forblir nektet selv om ANDRE mål er konfigurert", () => {
    const result = authorizeGceTarget("stop_instance", "europe-west1-b", "jarvis-other-1", new Set(["europe-west1-b/jarvis-api-1"]));
    expect(result.allowed).toBe(false);
  });
  it("I: SAMME instansnavn i en ANNEN sone er et ANNET mål - konfigurert kun for én sone gjelder IKKE for en annen", () => {
    const result = authorizeGceTarget("stop_instance", "europe-west1-c", "jarvis-api-1", new Set(["europe-west1-b/jarvis-api-1"]));
    expect(result.allowed).toBe(false);
  });
});

describe("D-337: isGceSentinelTarget()", () => {
  it("J: gjenkjenner jarvis-sentinel-* prefiks", () => {
    expect(isGceSentinelTarget("jarvis-sentinel-host-run-1")).toBe(true);
    expect(isGceSentinelTarget("jarvis-api-1")).toBe(false);
  });
});

describe("D-337: parseGceMutationTargets()", () => {
  it("K: parser kommaseparerte EKSAKTE zone/instance-par", () => {
    const set = parseGceMutationTargets("europe-west1-b/jarvis-api-1,us-central1-a/jarvis-worker-1");
    expect(set.has("europe-west1-b/jarvis-api-1")).toBe(true);
    expect(set.has("us-central1-a/jarvis-worker-1")).toBe(true);
    expect(set.size).toBe(2);
  });
  it("L: trimmer mellomrom rundt hvert par", () => {
    const set = parseGceMutationTargets(" europe-west1-b/jarvis-api-1 , us-central1-a/jarvis-worker-1 ");
    expect(set.has("europe-west1-b/jarvis-api-1")).toBe(true);
    expect(set.has("us-central1-a/jarvis-worker-1")).toBe(true);
  });
  it("M: tomt/manglende -> tomt sett (fail-closed for produksjon)", () => {
    expect(parseGceMutationTargets(undefined).size).toBe(0);
    expect(parseGceMutationTargets(null).size).toBe(0);
    expect(parseGceMutationTargets("").size).toBe(0);
  });
  it("N: et par UTEN skråstrek HOPPES OVER - resten av listen parses likevel", () => {
    const set = parseGceMutationTargets("europe-west1-b/jarvis-api-1,no-slash-here,us-central1-a/jarvis-worker-1");
    expect(set.has("europe-west1-b/jarvis-api-1")).toBe(true);
    expect(set.has("us-central1-a/jarvis-worker-1")).toBe(true);
    expect(set.size).toBe(2);
  });
  it("O: et par med UGYLDIG tegnsett i zone ELLER instance HOPPES OVER", () => {
    const set = parseGceMutationTargets("europe-west1-b/jarvis-api-1,BAD_ZONE!/jarvis-x,europe-west1-b/bad_instance!");
    expect(set.size).toBe(1);
    expect(set.has("europe-west1-b/jarvis-api-1")).toBe(true);
  });
  it("P: sentinel-instansnavn i env-variabelen EKSKLUDERES fra produksjonssettet - sentinel er KUN akseptanse-tier", () => {
    const set = parseGceMutationTargets("europe-west1-b/jarvis-sentinel-oops,europe-west1-b/jarvis-api-1");
    expect(set.has("europe-west1-b/jarvis-sentinel-oops")).toBe(false);
    expect(set.has("europe-west1-b/jarvis-api-1")).toBe(true);
  });
  it("Q: tomme oppføringer (doble komma) hoppes over", () => {
    const set = parseGceMutationTargets("europe-west1-b/jarvis-api-1,,us-central1-a/jarvis-worker-1,");
    expect(set.size).toBe(2);
  });
  it("R: en trailing skråstrek (tom instansdel) HOPPES OVER", () => {
    const set = parseGceMutationTargets("europe-west1-b/jarvis-api-1,europe-west1-b/");
    expect(set.size).toBe(1);
  });
});
