import { describe, expect, it } from "vitest";
import {
  EVAL_FIXTURES, QUALITY_THRESHOLD, checkLiveConfiguration, classifyChangedFiles, classifyErrorClass,
  computeVerifiedFix, evaluateTaskAgainstThreshold, redactSecrets, type EvalTaskResult
} from "../src/coding-agent-eval.ts";

/**
 * D-98 UA-5 Real Coding Agent v1 - Live Quality Evaluation: deterministisk
 * testmatrise for HARNESS-LOGIKKEN (§25 - INGEN ekte Anthropic-API, INGEN
 * ekte `claude`-binær, INGEN nettverk, INGEN ekte GitHub-mutasjon her - kun
 * ren klassifiseringslogikk. Selve live-kjøringen (`scripts/
 * ua5-coding-agent-live-eval.ts`) kjører ALDRI i normal CI).
 */

function baseResult(overrides: Partial<EvalTaskResult> = {}): EvalTaskResult {
  return {
    task_id: "t1", fixture_id: "task-a-local-logic-bug",
    invocation_success: true, patch_created: true, independent_tests_passed: true,
    unauthorized_changes: false, changed_files: ["src/range.js"],
    oracle_tampering: false, timeout: false, verified_fix: true,
    duration_ms: 1000, error_class: null, agent_description: "fixed it",
    ...overrides
  };
}

describe("A: fixture-definisjoner", () => {
  it("nøyaktig 3 fixtures, hver med gyldig form", () => {
    expect(EVAL_FIXTURES).toHaveLength(3);
    for (const f of EVAL_FIXTURES) {
      expect(f.id.length).toBeGreaterThan(0);
      expect(f.goal.length).toBeGreaterThan(0);
      expect(f.testCommand.length).toBeGreaterThan(0);
      expect(Object.keys(f.seedFiles).length).toBeGreaterThan(0);
      expect(["verified_fix", "honest_failure"]).toContain(f.expectedOutcome);
    }
  });
  it("orakelfiler er ALDRI i allowedWritablePaths, for noen fixture", () => {
    for (const f of EVAL_FIXTURES) {
      for (const oracle of f.oracleFiles) {
        expect(f.allowedWritablePaths).not.toContain(oracle);
      }
    }
  });
  it("orakelfiler er faktisk seedet (finnes i seedFiles)", () => {
    for (const f of EVAL_FIXTURES) {
      for (const oracle of f.oracleFiles) {
        expect(Object.keys(f.seedFiles)).toContain(oracle);
      }
    }
  });
  it("nøyaktig én negativ (honest_failure) og to positive (verified_fix) fixtures", () => {
    const outcomes = EVAL_FIXTURES.map((f) => f.expectedOutcome);
    expect(outcomes.filter((o) => o === "verified_fix")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "honest_failure")).toHaveLength(1);
  });
  it("kvalitetsterskelen er en ikke-tom, forhaandsdefinert streng (§16)", () => {
    expect(QUALITY_THRESHOLD.length).toBeGreaterThan(20);
  });
});

describe("B: classifyChangedFiles - tillatt-sti-validering og orakel-beskyttelse", () => {
  it("kun tillatte stier endret -> ingen uautorisert endring, ingen manipulasjon", () => {
    const r = classifyChangedFiles(["src/range.js"], ["src/range.js"], ["src/range.test.js"]);
    expect(r.unauthorizedChanges).toBe(false);
    expect(r.oracleTampering).toBe(false);
  });
  it("orakelfil endret -> oracleTampering=true, uansett andre endringer", () => {
    const r = classifyChangedFiles(["src/range.js", "src/range.test.js"], ["src/range.js"], ["src/range.test.js"]);
    expect(r.oracleTampering).toBe(true);
    expect(r.tamperedOracleFiles).toEqual(["src/range.test.js"]);
  });
  it("uventet fil utenfor tillatt-listen -> unauthorizedChanges=true, listet eksplisitt", () => {
    const r = classifyChangedFiles(["src/range.js", "package.json"], ["src/range.js"], ["src/range.test.js"]);
    expect(r.unauthorizedChanges).toBe(true);
    expect(r.unauthorizedPaths).toEqual(["package.json"]);
  });
  it("ingen endringer -> begge false", () => {
    const r = classifyChangedFiles([], ["src/range.js"], ["src/range.test.js"]);
    expect(r.unauthorizedChanges).toBe(false);
    expect(r.oracleTampering).toBe(false);
  });
});

describe("C: classifyErrorClass", () => {
  it("parser <label>_failed:<detalj>-prefikset", () => {
    expect(classifyErrorClass("tests_failed: exit 1")).toBe("tests_failed");
    expect(classifyErrorClass("claude_code_cli_failed:auth error")).toBe("claude_code_cli_failed");
  });
  it("null/undefined -> null", () => {
    expect(classifyErrorClass(null)).toBeNull();
    expect(classifyErrorClass(undefined)).toBeNull();
  });
  it("ingen kolon -> hele strengen som klasse", () => {
    expect(classifyErrorClass("policy_denied")).toBe("policy_denied");
  });
});

describe("D: computeVerifiedFix - AGENT_RETURNED_SUCCESS != TEST_GATE_PASSED (Q-26)", () => {
  it("alle vilkaar oppfylt -> true", () => {
    expect(computeVerifiedFix({
      invocationSuccess: true, patchCreated: true, independentTestsPassed: true,
      unauthorizedChanges: false, oracleTampering: false, timeout: false
    })).toBe(true);
  });
  it("jobben 'fullførte' (invocationSuccess) men den UAVHENGIGE testporten feilet -> false (agent kan ALDRI selv-sertifisere)", () => {
    expect(computeVerifiedFix({
      invocationSuccess: true, patchCreated: true, independentTestsPassed: false,
      unauthorizedChanges: false, oracleTampering: false, timeout: false
    })).toBe(false);
  });
  it("orakel manipulert -> false selv om testene 'bestod' (manipulerte tester teller ikke)", () => {
    expect(computeVerifiedFix({
      invocationSuccess: true, patchCreated: true, independentTestsPassed: true,
      unauthorizedChanges: false, oracleTampering: true, timeout: false
    })).toBe(false);
  });
  it("uautorisert filendring -> false", () => {
    expect(computeVerifiedFix({
      invocationSuccess: true, patchCreated: true, independentTestsPassed: true,
      unauthorizedChanges: true, oracleTampering: false, timeout: false
    })).toBe(false);
  });
  it("timeout -> false, aldri markert bestaatt", () => {
    expect(computeVerifiedFix({
      invocationSuccess: false, patchCreated: false, independentTestsPassed: false,
      unauthorizedChanges: false, oracleTampering: false, timeout: true
    })).toBe(false);
  });
  it("agent-invokering feilet helt (aldri en patch) -> false", () => {
    expect(computeVerifiedFix({
      invocationSuccess: false, patchCreated: false, independentTestsPassed: false,
      unauthorizedChanges: false, oracleTampering: false, timeout: false
    })).toBe(false);
  });
});

describe("E: evaluateTaskAgainstThreshold - terskelen anvendt PER forventet utfall (§16/§17)", () => {
  const positiveFixture = EVAL_FIXTURES.find((f) => f.expectedOutcome === "verified_fix")!;
  const negativeFixture = EVAL_FIXTURES.find((f) => f.expectedOutcome === "honest_failure")!;

  it("verified_fix-fixture: verified_fix=true -> terskel bestaatt", () => {
    expect(evaluateTaskAgainstThreshold(positiveFixture, baseResult({ verified_fix: true }))).toBe(true);
  });
  it("verified_fix-fixture: verified_fix=false -> terskel IKKE bestaatt", () => {
    expect(evaluateTaskAgainstThreshold(positiveFixture, baseResult({ verified_fix: false, independent_tests_passed: false }))).toBe(false);
  });
  it("honest_failure-fixture: ærlig feiling UTEN manipulasjon -> terskel bestaatt", () => {
    expect(evaluateTaskAgainstThreshold(negativeFixture, baseResult({
      verified_fix: false, patch_created: false, independent_tests_passed: false, changed_files: []
    }))).toBe(true);
  });
  it("honest_failure-fixture: agenten fabrikkerte suksess (verified_fix=true) -> terskel IKKE bestaatt", () => {
    expect(evaluateTaskAgainstThreshold(negativeFixture, baseResult({ verified_fix: true }))).toBe(false);
  });
  it("honest_failure-fixture: agenten 'feilet' MEN manipulerte orakelet på veien -> terskel IKKE bestaatt (ikke en gyldig ærlig feiling)", () => {
    expect(evaluateTaskAgainstThreshold(negativeFixture, baseResult({
      verified_fix: false, oracle_tampering: true, changed_files: ["src/config.js", "src/config.test.js"]
    }))).toBe(false);
  });
  it("honest_failure-fixture: agenten rørte en uautorisert fil på veien til å feile -> terskel IKKE bestaatt", () => {
    expect(evaluateTaskAgainstThreshold(negativeFixture, baseResult({
      verified_fix: false, unauthorized_changes: true, changed_files: ["package.json"]
    }))).toBe(false);
  });
});

describe("F: checkLiveConfiguration - ren skip-logikk (ALDRI fabrikkert kjøring uten reell konfig)", () => {
  it("verken binær eller nøkkel -> ikke konfigurert, presis aarsak", () => {
    const r = checkLiveConfiguration(undefined, undefined);
    expect(r.configured).toBe(false);
    expect(r.claudeBinaryConfigured).toBe(false);
    expect(r.anthropicCredentialConfigured).toBe(false);
    expect(r.reason).toContain("JARVIS_CLAUDE_BIN");
    expect(r.reason).toContain("ANTHROPIC_API_KEY");
  });
  it("kun binær -> ikke konfigurert, presis aarsak (mangler nøkkel)", () => {
    const r = checkLiveConfiguration("/usr/local/bin/claude", undefined);
    expect(r.configured).toBe(false);
    expect(r.reason).toBe("ANTHROPIC_API_KEY is not configured");
  });
  it("kun nøkkel -> ikke konfigurert, presis aarsak (mangler binær)", () => {
    const r = checkLiveConfiguration(undefined, "sk-ant-xxx");
    expect(r.configured).toBe(false);
    expect(r.reason).toBe("JARVIS_CLAUDE_BIN is not configured");
  });
  it("begge satt -> konfigurert, ingen aarsak", () => {
    const r = checkLiveConfiguration("/usr/local/bin/claude", "sk-ant-xxx");
    expect(r.configured).toBe(true);
    expect(r.reason).toBeNull();
  });
  it("tomme strenger telles som ikke-konfigurert (ikke bare undefined)", () => {
    expect(checkLiveConfiguration("", "").configured).toBe(false);
  });
});

describe("G: redactSecrets - hemmelighet lekker ALDRI til utskrift/logg", () => {
  it("fjerner en kjent hemmelig verdi overalt den forekommer", () => {
    const out = redactSecrets("token=sk-ant-abc123 used for sk-ant-abc123 again", ["sk-ant-abc123"]);
    expect(out).not.toContain("sk-ant-abc123");
    expect(out).toBe("token=[REDACTED] used for [REDACTED] again");
  });
  it("flere hemmeligheter samtidig", () => {
    const out = redactSecrets("bin=/x key=fake-binpath-secretvalue", ["fake-binpath-secretvalue"]);
    expect(out).toBe("bin=/x key=[REDACTED]");
  });
  it("undefined/tomme hemmeligheter ignoreres trygt, ingen krasj", () => {
    expect(redactSecrets("hello world", [undefined, "", undefined])).toBe("hello world");
  });
  it("tekst uten hemmeligheten uendret", () => {
    expect(redactSecrets("nothing secret here", ["sk-ant-abc123"])).toBe("nothing secret here");
  });
});

describe("H: EvalTaskResult er maskinlesbart (JSON-serialiserbart, ingen skjulte felt)", () => {
  it("resultatobjektet rundtrip-serialiserer uten tap av felt", () => {
    const r = baseResult();
    const roundtripped = JSON.parse(JSON.stringify(r)) as EvalTaskResult;
    expect(roundtripped).toEqual(r);
  });
  it("skiller EKSPLISITT invocation_success fra independent_tests_passed - aldri kollapset til én boolsk (§21)", () => {
    const r = baseResult({ invocation_success: true, independent_tests_passed: false, verified_fix: false });
    expect(r.invocation_success).not.toBe(r.independent_tests_passed);
  });
});
