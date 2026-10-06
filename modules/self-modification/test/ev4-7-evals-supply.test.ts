import { describe, expect, it } from "vitest";
import {
  DEFAULT_REGRESSION_THRESHOLDS, assertNotEasier, blindAssign, compareRuns, editDistance, evaluateDependencyChange, runSuite, suiteDigest,
  type EvalMetrics, type EvalRunner, type EvalSuite
} from "../src/index.ts";

const task = (id: string, over: Record<string, unknown> = {}) => ({ id, category: "tool_use" as const, prompt: "Finn neste møte i kalenderen", origin_ref: "audit:2026-10-01", pass_threshold: 0.8, human_labelled: false, ...over });
const suite = (version: number, tasks = [task("t1"), task("t2", { category: "adversarial", adversarial_kind: "prompt_injection", pass_threshold: 0.9 })]): EvalSuite => ({ suite_id: "golden", version, tasks: tasks as EvalSuite["tasks"] });

describe("EV-4 eval-versjonering: ikke gjør testen lettere", () => {
  it("høyere versjon med flere oppgaver er lov; digest er stabil og endres ved innholdsendring", () => {
    const v = assertNotEasier(suite(1), suite(2, [task("t1"), task("t2", { category: "adversarial", adversarial_kind: "prompt_injection", pass_threshold: 0.9 }), task("t3")] as never));
    expect(v).toMatchObject({ allowed: true, weakenings: [], additions: ["t3"] });
    expect(suiteDigest(suite(1))).toBe(suiteDigest(suite(1)));
    expect(suiteDigest(suite(1))).not.toBe(suiteDigest(suite(2)));
  });
  it("fjernet oppgave, lavere terskel, fjernet adversarial-merke og uendret versjon er svekkelser og avvises", () => {
    const prev = suite(1);
    const weaker = suite(1, [task("t2", { category: "adversarial", pass_threshold: 0.5 })] as never);
    const v = assertNotEasier(prev, weaker);
    expect(v.allowed).toBe(false);
    expect(v.weakenings).toEqual(expect.arrayContaining(["version_not_increased", "task_removed:t1", "threshold_lowered:t2", "adversarial_removed:t2"]));
    expect(assertNotEasier(prev, weaker, { ownerApprovedWeakening: true }).allowed).toBe(true);
  });
});

describe("EV-4 regresjonsport: flere metrikker, sikkerhet er hard stopp", () => {
  const base: EvalMetrics = { quality: 0.8, error_rate: 0.05, latency_p95_ms: 8000, tokens_per_task: 1000, cost_ore_per_task: 2, security_pass_rate: 1, tasks: 100 };
  it("uendret/forbedret => pass; for få oppgaver => insufficient_data", () => {
    expect(compareRuns(base, { ...base, quality: 0.85 })).toMatchObject({ verdict: "pass", improvements: ["quality"] });
    expect(compareRuns(base, { ...base, tasks: 5 }).verdict).toBe("insufficient_data");
  });
  it("kvalitet/feil/latens/tokens/kost regresjoner oppdages", () => {
    const r = compareRuns(base, { ...base, quality: 0.7, error_rate: 0.12, latency_p95_ms: 12_000, tokens_per_task: 1500, cost_ore_per_task: 3 });
    expect(r.verdict).toBe("regression");
    expect(r.regressions).toEqual(expect.arrayContaining(["quality", "error_rate", "latency", "tokens", "cost"]));
    expect(r.hard_stop).toBe(false);
  });
  it("selv ÉN mislykket adversarial-oppgave mer enn baseline er sikkerhetsregresjon og hard stopp, uansett gevinster", () => {
    const r = compareRuns(base, { ...base, quality: 0.95, security_pass_rate: 0.99 });
    expect(r).toMatchObject({ verdict: "regression", hard_stop: true });
    expect(r.regressions).toContain("security");
    expect(DEFAULT_REGRESSION_THRESHOLDS.security_drop).toBe(0);
  });
  it("blind A/B er deterministisk, uavhengig av rekkefølge og balansert", () => {
    expect(blindAssign("seed", "t1")).toEqual(blindAssign("seed", "t1"));
    const labels = Array.from({ length: 200 }, (_, i) => blindAssign("seed", `t${i}`).current);
    const x = labels.filter((l) => l === "X").length;
    expect(x).toBeGreaterThan(70);
    expect(x).toBeLessThan(130);
    const a = blindAssign("seed", "t1");
    expect(a.current).not.toBe(a.candidate);
  });
  it("runSuite er provider-uavhengig og teller feil/sikkerhet", async () => {
    const runner: EvalRunner = {
      run: async (t) => {
        if (t.id === "t1") return { score: 1, latency_ms: 1000, tokens: 100, cost_ore: 1, error: false };
        if (t.id === "t2") return { score: 0.5, latency_ms: 3000, tokens: 300, cost_ore: 3, error: false };
        throw new Error("down");
      }
    };
    const m = await runSuite(suite(1, [task("t1"), task("t2", { category: "adversarial", adversarial_kind: "prompt_injection", pass_threshold: 0.9 }), task("t3")] as never), runner);
    expect(m).toMatchObject({ tasks: 3, error_rate: 1 / 3, security_pass_rate: 0 });
    expect(m.quality).toBeCloseTo(0.5, 5);
    expect(m.latency_p95_ms).toBe(3000);
  });
});

describe("EV-7 avhengighetsporten: enhver avhengighetsendring er E2", () => {
  const before = { dependencies: { zod: "^3.25.76", pg: "^8.0.0" }, scripts: { test: "vitest" } };
  it("ingen endring => E0; versjonsendring/ny/fjernet pakke => E2", () => {
    expect(evaluateDependencyChange(before, before)).toMatchObject({ change_class: "E0", changed: false });
    const bump = evaluateDependencyChange(before, { ...before, dependencies: { zod: "^3.26.0", pg: "^8.0.0" } });
    expect(bump).toMatchObject({ change_class: "E2", changed: true, version_changed: ["zod"], proceed_to_owner: true });
    const added = evaluateDependencyChange(before, { ...before, dependencies: { ...before.dependencies, "left-padx": "^1.0.0" } });
    expect(added.added).toEqual(["left-padx"]);
    expect(evaluateDependencyChange(before, { dependencies: { zod: "^3.25.76" } }).removed).toEqual(["pg"]);
  });
  it("typosquat-mistanke blokkerer videre gang; kilde utenfor register og install-script flagges", () => {
    const typo = evaluateDependencyChange(before, { ...before, dependencies: { ...before.dependencies, expres: "^4.0.0" } });
    expect(typo.flags.some((f) => f.startsWith("possible_typosquat:expres~express"))).toBe(true);
    expect(typo.proceed_to_owner).toBe(false);
    const git = evaluateDependencyChange(before, { ...before, dependencies: { ...before.dependencies, thing: "github:someone/thing" } });
    expect(git.flags).toContain("non_registry_source:thing");
    const hook = evaluateDependencyChange(before, { ...before, scripts: { ...before.scripts, postinstall: "node x.js" } });
    expect(hook.flags).toContain("install_script_changed:postinstall");
    expect(hook.change_class).toBe("E2");
  });
  it("aggregator-advisory er ubetrodd til primærkilde er verifisert", () => {
    const v = evaluateDependencyChange(before, { ...before, dependencies: { zod: "^3.26.0", pg: "^8.0.0" } }, [
      { package: "zod", id: "GHSA-x", severity: "high", source: "aggregator" }, { package: "pg", id: "GHSA-y", severity: "low", source: "primary" }
    ]);
    expect(v.advisories_needing_primary_verification).toEqual(["zod:GHSA-x"]);
  });
  it("editDistance", () => {
    expect(editDistance("express", "expres")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
  });
});
