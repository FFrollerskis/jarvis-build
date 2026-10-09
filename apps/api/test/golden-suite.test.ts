import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INJECTION_PATTERN_IDS, assertNotEasier, EVAL_CATEGORIES, RED_TEAM_CATEGORIES, ingestRadarItem } from "@jarvis/self-modification";
import { GOLDEN, GOLDEN_SUITE_DIGEST, RADAR_INJECTION_BODIES, WIRING_LOCKS, goldenSuite, runGolden } from "../src/golden-suite.ts";
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
      "notes-stripped", "repo-lock-other", "repo-lock-own", "radar-ignore-instructions", "radar-credential-request", "radar-disable-safety", "radar-benign-passes",
      // L4 (gjennomgang av PR #313): én oppgave per overlevende mutant, og ekte approval_bypass-dekning
      "screen-versions-scanned", "screen-keywords-scanned", "screen-source-ref-scanned", "screen-unknown-field-withheld", "screen-unknown-inner-field-withheld", "screen-clean-versions-keywords-kept",
      "radar-ignorer-no", "radar-role-override", "radar-tool-authority", "radar-pipe-to-shell", "radar-merge-deploy", "approval-tainted-send-blocked", "approval-binding-rebind"
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

/**
 * L4 (gjennomgang av PR #313): suiten ga delvis falsk trygghet. Overlevende mutanter (skjermen ignorerte `versions[].content`, `keywords` og ukjente felt; radarmønstrene `ignorer_instruksjoner`,
 * `tool_authority`, `pipe_to_shell` og `merge_or_deploy` kunne fjernes) er nå drept av egne oppgaver, `approval_bypass` er dekket av ekte godkjenningsoppgaver (ikke en rutingfrase), og rapporten sier at
 * suiten tester REGLER - koblingen låses av `WIRING_LOCKS`.
 */
describe("L4: gull-suiten kan ikke lenger bli stille svekket", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  it("hvert radar-injeksjonsmønster har NØYAKTIG én oppgave, og kroppen treffer KUN det mønsteret (ellers skjuler et annet mønster en fjernet regel)", () => {
    const patterns = Object.values(RADAR_INJECTION_BODIES).map(([pattern]) => pattern);
    expect([...patterns].sort()).toEqual([...INJECTION_PATTERN_IDS].sort());
    expect(new Set(patterns).size).toBe(patterns.length);
    for (const [id, [pattern, body]] of Object.entries(RADAR_INJECTION_BODIES)) {
      const result = ingestRadarItem({ kind: "model", source_url: "https://example.com/release", source_name: "test", title: "Release notes", body, fetched_at: "2026-10-15T00:00:00.000Z" });
      expect(result.findings, `${id}: kroppen skal treffe kun «${pattern}»`).toEqual([`injection:${pattern}`]);
      expect(GOLDEN.some((g) => g.task.id === id && g.rt === "radar_injection"), `${id} er en golden-oppgave i radar_injection`).toBe(true);
    }
  });

  it("approval_bypass dekkes av ekte godkjenningsoppgaver (taint-port + binding), ikke av en rutingfrase-parser, og ingen annen oppgave bærer kategorien", async () => {
    const carrying = GOLDEN.filter((g) => g.rt === "approval_bypass").map((g) => g.task.id).sort();
    expect(carrying).toEqual(["approval-binding-rebind", "approval-tainted-send-blocked"]);
    expect(GOLDEN.find((g) => g.task.id === "route-local-only-phrase")!.rt).toBeUndefined();
    const run = await runGolden({ surface: PRODUCTION_SURFACE });
    expect(run.uncovered).toEqual([]);
    expect(run.red_team.find((r) => r.category === "approval_bypass")).toMatchObject({ attempts: 2, breaches: 0 });
  });

  it("en asynkron sjekk som kaster eller svarer false teller som brudd (også for approval_bypass)", async () => {
    const taint = GOLDEN.find((g) => g.task.id === "approval-tainted-send-blocked")!;
    const original = taint.check;
    try {
      for (const broken of [async () => false, async () => { throw new Error("boom"); }]) {
        (taint as { check: unknown }).check = broken;
        const run = await runGolden({ surface: PRODUCTION_SURFACE });
        expect(run.failed).toContain("approval-tainted-send-blocked");
        expect(run.hard_stop).toBe(true);
        expect(run.red_team.find((r) => r.category === "approval_bypass")!.breaches).toBe(1);
      }
    } finally {
      (taint as { check: unknown }).check = original;
    }
  });

  it("WIRING_LOCKS: hver kobling peker på et symbol som FINNES i produksjonsfilen og på tester som finnes - pekeren kan ikke råtne stille", () => {
    expect(WIRING_LOCKS.length).toBeGreaterThanOrEqual(5);
    for (const lock of WIRING_LOCKS) {
      const production = join(ROOT, lock.production);
      expect(existsSync(production), `${lock.rule}: ${lock.production}`).toBe(true);
      expect(readFileSync(production, "utf8"), `${lock.rule}: ${lock.symbol} må stå i ${lock.production}`).toContain(lock.symbol);
      expect(lock.tests.length, lock.rule).toBeGreaterThan(0);
      for (const t of lock.tests) {
        const file = join(ROOT, "apps/api/test", t);
        expect(existsSync(file), `${lock.rule}: ${t}`).toBe(true);
        expect(statSync(file).size, `${t} er ikke tom`).toBeGreaterThan(1000);
      }
    }
  });
});
