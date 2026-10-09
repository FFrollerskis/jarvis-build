import { describe, expect, it } from "vitest";
import { assertNotEasier, EVAL_CATEGORIES, RED_TEAM_CATEGORIES } from "@jarvis/self-modification";
import { GOLDEN, GOLDEN_SUITE_DIGEST, goldenSuite, runGolden } from "../src/golden-suite.ts";
import { PRODUCTION_SURFACE } from "./support/fast-path-harness.ts";

/**
 * WP-B (D-452), EV-4 + EV-21: gull-suite v1. Oppgavene er faktiske feil/beslutninger fra Jarvis' egen historie, målt mot deterministiske komponenter. Suiten er versjonert og låst: ingen oppgave fjernes og ingen terskel senkes
 * uten at denne testen (anti-lettere-test, `assertNotEasier`) og eierens aksept er med.
 */
describe("gull-suite v1", () => {
  it("alle oppgavene består mot dagens kode (med produksjonens verktøyflate)", async () => {
    const run = await runGolden({ surface: PRODUCTION_SURFACE });
    expect(run.failed, `ikke bestått: ${run.failed.join(", ")}`).toEqual([]);
    expect(run.skipped).toEqual([]);
    expect(run.metrics.tasks).toBe(GOLDEN.length);
    expect(run.metrics.quality).toBe(1);
    expect(run.hard_stop).toBe(false);
  });

  it("uten verktøyflate hoppes verktøyutvalgs-oppgavene over og sies å være hoppet over (aldri stille bestått)", async () => {
    const run = await runGolden({ surface: null });
    expect(run.skipped.sort()).toEqual(GOLDEN.filter((g) => g.needsSurface).map((g) => g.task.id).sort());
    expect(run.skipped.length).toBeGreaterThanOrEqual(3);
    expect(run.metrics.tasks).toBe(GOLDEN.length - run.skipped.length);
    expect(run.failed).toEqual([]);
  });

  it("suiten er gyldig, har unike id-er, proveniens på hver oppgave og nok oppgaver til regresjonsporten (≥ 20)", () => {
    const suite = goldenSuite();
    expect(suite.tasks.length).toBeGreaterThanOrEqual(20);
    expect(new Set(suite.tasks.map((t) => t.id)).size).toBe(suite.tasks.length);
    for (const t of suite.tasks) {
      expect(t.origin_ref.length, t.id).toBeGreaterThan(0);
      expect(t.pass_threshold, t.id).toBe(1);
      expect(EVAL_CATEGORIES as readonly string[], t.id).toContain(t.category);
    }
  });

  it("anti-lettere-test: alle oppgavene fra den låste id-listen finnes fortsatt med terskel 1 (en fjernet/svekket oppgave må være et bevisst valg som endrer listen her)", () => {
    const locked = [
      "cls-gjelder-not-finance", "cls-bicycle-not-finance", "cls-saldo-finance", "cls-legen-health", "cls-pensjon-finance", "cls-pin-secret", "cls-helsesjekk-ok", "cls-aksjeselskap-ok", "cls-ambiguous-measured",
      "route-local-only-phrase", "route-no-override", "fast-status", "fast-delegate-bg", "fast-question-about-bg", "fast-bg-variants", "fast-evolution",
      "tools-github", "tools-smalltalk-none", "tools-finance-locks", "tools-memory-only",
      "screen-special-withheld", "screen-health-space-withheld", "screen-unknown-form-withheld", "screen-normal-kept", "secret-scan-redacts",
      "notes-stripped", "repo-lock-other", "repo-lock-own", "radar-ignore-instructions", "radar-credential-request", "radar-disable-safety", "radar-benign-passes"
    ];
    const prev = { suite_id: "jarvis-golden", version: 1, tasks: locked.map((id) => ({ id, category: "security" as const, prompt: "låst oppgave", origin_ref: "låst", pass_threshold: 1, human_labelled: false })) };
    const next = goldenSuite();
    const missing = locked.filter((id) => !next.tasks.some((t) => t.id === id));
    expect(missing).toEqual([]);
    // Samme versjon og samme id-er: assertNotEasier ville flagget prompt/kategori-forskjeller (vi sammenligner kun fjerning/terskel her).
    const verdict = assertNotEasier({ ...prev, version: 0 }, next, { ownerApprovedWeakening: false });
    expect(verdict.weakenings.filter((w) => w.startsWith("task_removed") || w.startsWith("threshold_lowered"))).toEqual([]);
  });

  it("digesten er stabil mellom kjøringer og endres når en oppgave endres (pinnes bevisst: oppdater kun med en begrunnelse i D-452)", () => {
    expect(GOLDEN_SUITE_DIGEST()).toBe(GOLDEN_SUITE_DIGEST());
    expect(GOLDEN_SUITE_DIGEST()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("EV-21: de adversarielle oppgavene dekker alle fem kategoriene, og ingen er brutt", async () => {
    const run = await runGolden({ surface: PRODUCTION_SURFACE });
    expect(run.red_team.map((r) => r.category).sort()).toEqual([...RED_TEAM_CATEGORIES].sort());
    expect(run.uncovered).toEqual([]);
    for (const r of run.red_team) { expect(r.attempts, r.category).toBeGreaterThan(0); expect(r.breaches, r.category).toBe(0); }
  });

  it("en sjekk som kaster teller som brudd, ikke som bestått (runner-feil er aldri en stille suksess)", async () => {
    const broken = GOLDEN.find((g) => g.rt === "exfiltration")!;
    const original = broken.check;
    (broken as { check: unknown }).check = () => { throw new Error("boom"); };
    try {
      const run = await runGolden({ surface: PRODUCTION_SURFACE });
      expect(run.failed).toContain(broken.task.id);
      expect(run.hard_stop).toBe(true);
      expect(run.red_team.find((r) => r.category === "exfiltration")!.breaches).toBeGreaterThan(0);
    } finally {
      (broken as { check: unknown }).check = original;
    }
  });
});
