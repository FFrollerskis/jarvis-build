import { describe, expect, it } from "vitest";
import {
  checkRequiredEnv,
  computeHardFail,
  evaluateSecretSafety,
  isLiveWriteOptedIn,
  HARD_REQUIRED_MARKERS,
  REQUIRED_ENV_VARS,
  type Verdict
} from "../scripts/lib/fiken-live-lib.ts";

describe("A: checkRequiredEnv", () => {
  it("configured=true når alle fire er tilstede", () => {
    const env = Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, "x"]));
    expect(checkRequiredEnv(env)).toEqual({ configured: true, missing: [] });
  });
  it("rapporterer NAVNET på manglende variabler, ALDRI en verdi", () => {
    const result = checkRequiredEnv({ JARVIS_FIKEN_CLIENT_ID: "x" });
    expect(result.configured).toBe(false);
    expect(result.missing).toContain("JARVIS_FIKEN_CLIENT_SECRET");
    expect(result.missing).toContain("JARVIS_FIKEN_REFRESH_TOKEN");
    expect(result.missing).toContain("JARVIS_FIKEN_COMPANY_SLUG");
    expect(result.missing).not.toContain("JARVIS_FIKEN_CLIENT_ID");
  });
});

describe("B: isLiveWriteOptedIn - fail-closed default", () => {
  it("false når variabelen mangler", () => {
    expect(isLiveWriteOptedIn({})).toBe(false);
  });
  it("false for enhver verdi ANNET enn den eksakte strengen 'true'", () => {
    expect(isLiveWriteOptedIn({ JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE: "1" })).toBe(false);
    expect(isLiveWriteOptedIn({ JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE: "TRUE" })).toBe(false);
    expect(isLiveWriteOptedIn({ JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE: "yes" })).toBe(false);
  });
  it("true KUN for den eksakte strengen 'true'", () => {
    expect(isLiveWriteOptedIn({ JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE: "true" })).toBe(true);
  });
});

describe("C: evaluateSecretSafety", () => {
  it("NO_DATA når ingen faktiske hemmeligheter er konfigurert (ingenting å bevise)", () => {
    expect(evaluateSecretSafety(["log line one", "log line two"], ["", undefined as unknown as string].filter(Boolean))).toBe("NO_DATA");
  });
  it("PASS når ingen logglinje inneholder en av hemmelighetene", () => {
    expect(evaluateSecretSafety(["safe line", "another safe line"], ["super-secret-token-123"])).toBe("PASS");
  });
  it("FAIL dersom EN logglinje inneholder hemmeligheten - selv delvis", () => {
    expect(evaluateSecretSafety(["prefix super-secret-token-123 suffix"], ["super-secret-token-123"])).toBe("FAIL");
  });
});

describe("D: computeHardFail", () => {
  it("false når alle HARD_REQUIRED_MARKERS er PASS", () => {
    const results = Object.fromEntries(HARD_REQUIRED_MARKERS.map((m) => [m, "PASS" as Verdict]));
    expect(computeHardFail(results)).toBe(false);
  });
  it("true dersom ETT hard-required-markør ikke er PASS", () => {
    const results = Object.fromEntries(HARD_REQUIRED_MARKERS.map((m) => [m, "PASS" as Verdict]));
    results[HARD_REQUIRED_MARKERS[0]] = "FAIL";
    expect(computeHardFail(results)).toBe(true);
  });
  it("true dersom et hard-required-markør ALDRI kjørte (NOT_RUN)", () => {
    const results = Object.fromEntries(HARD_REQUIRED_MARKERS.map((m) => [m, "PASS" as Verdict]));
    results[HARD_REQUIRED_MARKERS[0]] = "NOT_RUN";
    expect(computeHardFail(results)).toBe(true);
  });
});
