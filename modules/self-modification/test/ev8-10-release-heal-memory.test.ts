import { describe, expect, it } from "vitest";
import {
  FREEZE_UNKNOWN_REASONS, changeFreeze, decideHeal, decideRelease, detectPoisoning, freshnessScore, levelOfAction, needsReverification, nextIncidentStep, proposeDedupe,
  shouldRollback, sourceQualityScore, type HealContext, type MemoryFact, type ReleaseRequest
} from "../src/index.ts";

const okSignals = { incident_open: false, observability_ok: true, slo_breaches: 0, kill_switch_active: false };
const rel = (over: Partial<ReleaseRequest> = {}): ReleaseRequest => ({
  change_class: "E1", kind: "personality", stage: "shadow", owner_approved: false, last_known_good_stored: true, signals: okSignals,
  usage: { deploys_today: 0, deploys_this_hour: 0, auto_merges_today: 0 }, budget: { max_deploys_per_day: 3, max_deploys_per_hour: 1, max_auto_merges_per_day: 5 }, evals_passed: true, independent_review: true, ...over
});

describe("EV-8 utrullingsport", () => {
  it("friskt system, bestått eval og review: neste trinn i rekkefølgen shadow->staging->canary->full", () => {
    expect(decideRelease(rel())).toMatchObject({ allowed: true, next_stage: "staging", needs_canary: true });
    expect(decideRelease(rel({ stage: "staging" })).next_stage).toBe("canary");
    expect(decideRelease(rel({ stage: "canary" })).next_stage).toBe("full");
    expect(decideRelease(rel({ stage: "full" })).next_stage).toBeNull();
  });
  it("change freeze: hendelse, manglende observerbarhet, SLO-brudd og kill switch stopper alt", () => {
    expect(changeFreeze({ ...okSignals, incident_open: true }).reasons).toEqual(["incident_open"]);
    for (const s of [{ incident_open: true }, { observability_ok: false }, { slo_breaches: 1 }, { kill_switch_active: true }]) {
      const v = decideRelease(rel({ signals: { ...okSignals, ...s } }));
      expect(v.allowed).toBe(false);
      expect(v.reasons.some((r) => r.startsWith("freeze:"))).toBe(true);
    }
  });
  it("budsjett, eval, review, LKG og eier-godkjenning håndheves; E3 aldri", () => {
    expect(decideRelease(rel({ usage: { deploys_today: 3, deploys_this_hour: 0, auto_merges_today: 0 } })).reasons).toContain("deploy_budget_exhausted");
    expect(decideRelease(rel({ usage: { deploys_today: 0, deploys_this_hour: 0, auto_merges_today: 5 } })).reasons).toContain("auto_merge_budget_exhausted");
    expect(decideRelease(rel({ evals_passed: false })).reasons).toContain("evals_not_passed");
    expect(decideRelease(rel({ independent_review: false })).reasons).toContain("independent_review_missing");
    expect(decideRelease(rel({ last_known_good_stored: false })).reasons).toContain("last_known_good_missing");
    expect(decideRelease(rel({ change_class: "E2" })).reasons).toContain("owner_approval_missing");
    expect(decideRelease(rel({ change_class: "E2", owner_approved: true })).allowed).toBe(true);
    expect(decideRelease(rel({ change_class: "E3", owner_approved: true })).reasons).toContain("e3_forbidden");
  });
  it("prompt/personlighet/ruting kan aldri være E0 og går alltid via canary", () => {
    expect(decideRelease(rel({ change_class: "E0", kind: "routing" })).reasons).toContain("kind_requires_at_least_e1");
    expect(decideRelease(rel({ kind: "prompt" })).needs_canary).toBe(true);
    expect(decideRelease(rel({ change_class: "E0", kind: "config" })).needs_canary).toBe(false);
  });
  it("automatisk tilbakerulling på hvert av de seks signalene", () => {
    const calm = { eval_regression: false, error_rate: 0.02, baseline_error_rate: 0.02, latency_p95_ms: 8000, baseline_latency_p95_ms: 8000, cost_per_task_ore: 2, baseline_cost_per_task_ore: 2, data_quality_breach: false, security_alarm: false };
    expect(shouldRollback(calm).rollback).toBe(false);
    expect(shouldRollback({ ...calm, eval_regression: true }).reasons).toEqual(["eval_regression"]);
    expect(shouldRollback({ ...calm, error_rate: 0.2 }).reasons).toEqual(["error_spike"]);
    expect(shouldRollback({ ...calm, latency_p95_ms: 13_000 }).reasons).toEqual(["latency_breach"]);
    expect(shouldRollback({ ...calm, cost_per_task_ore: 5 }).reasons).toEqual(["cost_spike"]);
    expect(shouldRollback({ ...calm, data_quality_breach: true }).reasons).toEqual(["data_quality_breach"]);
    expect(shouldRollback({ ...calm, security_alarm: true }).reasons).toEqual(["security_alarm"]);
  });
});

const heal = (action: string, over: Partial<HealContext> = {}): HealContext => ({
  action, attempts: 0, max_attempts: 2, preapproved_failover: false, ua_gate_live: false, repair_class: null, owner_approved: false, kill_switch_active: false, ...over
});

describe("EV-9 selvhelbredelse: nivåer H0-H4", () => {
  it("H0 deteksjon alltid auto, også under kill switch", () => {
    expect(decideHeal(heal("detect_stuck_lease", { kill_switch_active: true }))).toMatchObject({ level: "H0", allowed: true, mode: "auto" });
  });
  it("H1 trygg reparasjon auto med forsøksgrense; kill switch stopper", () => {
    expect(decideHeal(heal("restart_container")).allowed).toBe(true);
    expect(decideHeal(heal("restart_container", { attempts: 2 }))).toMatchObject({ allowed: false, mode: "owner", reasons: ["attempt_limit_reached"] });
    expect(decideHeal(heal("restart_container", { kill_switch_active: true })).allowed).toBe(false);
  });
  it("H2 failover kun hvis forhåndsgodkjent OG UA-port live", () => {
    expect(decideHeal(heal("switch_provider")).reasons).toEqual(["failover_not_preapproved", "ua_gate_not_live"]);
    expect(decideHeal(heal("switch_provider", { preapproved_failover: true, ua_gate_live: true })).allowed).toBe(true);
    expect(decideHeal(heal("switch_provider", { preapproved_failover: true })).allowed).toBe(false);
  });
  it("H3 kodereparasjon følger E-klassen: E1 auto, E2 eier, E3 aldri, ukjent klasse aldri", () => {
    expect(decideHeal(heal("code_repair", { repair_class: "E1" })).mode).toBe("auto");
    expect(decideHeal(heal("code_repair", { repair_class: "E2" }))).toMatchObject({ allowed: false, mode: "owner" });
    expect(decideHeal(heal("code_repair", { repair_class: "E2", owner_approved: true })).allowed).toBe(true);
    expect(decideHeal(heal("code_repair", { repair_class: "E3", owner_approved: true })).allowed).toBe(false);
    expect(decideHeal(heal("code_repair")).reasons).toEqual(["repair_class_unknown"]);
  });
  it("H4 destruktivt og UKJENT handling krever eier", () => {
    expect(levelOfAction("delete_data")).toBe("H4");
    expect(levelOfAction("noe_helt_nytt")).toBe("H4");
    expect(decideHeal(heal("restore_db_over_prod")).allowed).toBe(false);
    expect(decideHeal(heal("restore_db_over_prod", { owner_approved: true })).allowed).toBe(true);
  });
  it("hendelsesløkken: rekkefølge, verifisering fra måling og regresjonstest før lukking", () => {
    const s = { correlation_id: "inc-1", completed: [] as never[], slo_recovered: null, business_outcome_recovered: null, regression_test_added: false };
    expect(nextIncidentStep(s).next).toBe("detect");
    expect(nextIncidentStep({ ...s, completed: ["detect", "stabilize"] as never }).next).toBe("diagnose");
    expect(nextIncidentStep({ ...s, completed: ["repair"] as never }).blockers).toContain("out_of_order:repair");
    const verified = { ...s, completed: ["detect", "stabilize", "diagnose", "repair", "verify"] as never };
    expect(nextIncidentStep(verified).blockers).toContain("verification_not_proven");
    const done = { ...verified, completed: [...verified.completed, "postmortem"] as never, slo_recovered: true, business_outcome_recovered: true };
    expect(nextIncidentStep(done).blockers).toEqual(["regression_test_missing"]);
    expect(nextIncidentStep({ ...done, regression_test_added: true })).toMatchObject({ can_close: true, next: null, blockers: [] });
    expect(nextIncidentStep({ ...s, correlation_id: " " }).blockers).toContain("correlation_id_missing");
  });
});

const NOW = new Date("2026-10-06T12:00:00Z");
const fact = (id: string, over: Partial<MemoryFact> = {}): MemoryFact => ({ id, space: "personal", subject: "s", content: "c", source_kind: "owner_statement", trust: "trusted", observed_at: "2026-10-01T00:00:00Z", valid_to: null, ...over });

describe("EV-10 minne-vedlikehold", () => {
  it("ferskhet halveres per halveringstid; utløpt er 0; eksterne faller raskere enn eierens", () => {
    expect(freshnessScore(fact("a", { observed_at: "2026-10-06T12:00:00Z" }), NOW)).toBe(1);
    expect(freshnessScore(fact("a", { valid_to: "2026-10-01T00:00:00Z" }), NOW)).toBe(0);
    const ext = freshnessScore(fact("a", { source_kind: "external", observed_at: "2026-09-06T12:00:00Z" }), NOW);
    expect(ext).toBeCloseTo(0.5, 2);
    expect(freshnessScore(fact("a", { observed_at: "2026-09-06T12:00:00Z" }), NOW)).toBeGreaterThan(ext);
  });
  it("kildekvalitet: eierens rettelse > utsagn > inferens; ubetrodd demper; bekreftelser løfter", () => {
    expect(sourceQualityScore(fact("a", { source_kind: "owner_correction" }))).toBeGreaterThan(sourceQualityScore(fact("a", { source_kind: "owner_statement" })));
    expect(sourceQualityScore(fact("a", { source_kind: "inference" }))).toBeLessThan(sourceQualityScore(fact("a", { source_kind: "owner_statement" })));
    expect(sourceQualityScore(fact("a", { source_kind: "external", trust: "untrusted" }))).toBeLessThan(sourceQualityScore(fact("a", { source_kind: "external", trust: "trusted" })));
    expect(sourceQualityScore(fact("a", { source_kind: "external", independent_confirmations: 2 }))).toBeGreaterThan(sourceQualityScore(fact("a", { source_kind: "external" })));
  });
  it("re-verifisering: utløpt, gamle eksterne og gamle lavkvalitets-inferenser - ikke eierens egne utsagn", () => {
    const facts = [
      fact("expired", { valid_to: "2026-09-01T00:00:00Z" }),
      fact("old-ext", { source_kind: "external", observed_at: "2026-07-01T00:00:00Z" }),
      fact("old-inf", { source_kind: "inference", observed_at: "2026-05-01T00:00:00Z" }),
      fact("old-owner", { observed_at: "2025-12-01T00:00:00Z" }),
      fact("new-ext", { source_kind: "external", observed_at: "2026-10-05T00:00:00Z" })
    ];
    expect(needsReverification(facts, NOW).map((d) => `${d.id}:${d.reason}`).sort()).toEqual(["expired:expired", "old-ext:stale_external", "old-inf:stale_low_quality"]);
  });
  it("poisoning: gjentatt ubetrodd innhold uten bekreftelse flagges; ubetrodd som motsier eierens ord flagges", () => {
    const facts = [
      fact("rep", { trust: "untrusted", source_kind: "external", untrusted_repeats: 5, subject: "x", content: "A" }),
      fact("rep-ok", { trust: "untrusted", source_kind: "external", untrusted_repeats: 5, independent_confirmations: 1, subject: "y", content: "B" }),
      fact("owner", { subject: "bosted", content: "Oslo" }),
      fact("override", { trust: "untrusted", source_kind: "external", subject: "bosted", content: "Bergen" }),
      fact("other-space", { trust: "untrusted", source_kind: "external", space: "business", subject: "bosted", content: "Bergen" })
    ];
    const found = detectPoisoning(facts).map((f) => `${f.id}:${f.reason}`).sort();
    expect(found).toEqual(["override:untrusted_claims_to_override_owner", "rep:repeated_untrusted_content"]);
  });
  it("dedupe-forslag: samme rom og innhold; høyest kvalitet beholdes; aldri irreversibelt", () => {
    const facts = [
      fact("a", { content: "Tobias liker kaffe", source_kind: "inference" }),
      fact("b", { content: " tobias  liker KAFFE ", source_kind: "owner_correction" }),
      fact("c", { content: "Tobias liker kaffe", space: "business" }),
      fact("d", { content: "annet" })
    ];
    expect(proposeDedupe(facts)).toEqual([{ keep: "b", merge: ["a"], space: "personal", reason: "identical_content", irreversible: false }]);
    expect(proposeDedupe([])).toEqual([]);
  });
});

/**
 * M2 (gjennomgang av PR #313): KJENT-IKKE-LIK-OK. Et innsignal som ikke kunne måles (`null`/`undefined`/feil type) er UKJENT, og ukjent utelukker aldri en freeze. Før rettelsen ble ukjent kill switch og ukjent
 * hendelsestall fabrikkert til `false`/`0` av kalleren, og `if (s.kill_switch_active)` leste `undefined` som «av».
 */
describe("EV-8 change freeze og EV-9 selvhelbredelse: ukjent er aldri «nei»", () => {
  it("ukjent kill switch, hendelsestall og observerbarhet gir hver sin årsak og frozen: true", () => {
    expect(changeFreeze({ ...okSignals, kill_switch_active: null })).toEqual({ frozen: true, reasons: ["kill_switch_unknown"] });
    expect(changeFreeze({ ...okSignals, incident_open: null })).toEqual({ frozen: true, reasons: ["incident_state_unknown"] });
    expect(changeFreeze({ ...okSignals, observability_ok: false })).toEqual({ frozen: true, reasons: ["observability_missing"] });
    expect(changeFreeze({ incident_open: null, observability_ok: false, slo_breaches: 0, kill_switch_active: null }).reasons).toEqual(["kill_switch_unknown", "incident_state_unknown", "observability_missing"]);
    // Kjent PÅ og ukjent kan forekomme sammen: begge sies.
    expect(changeFreeze({ ...okSignals, kill_switch_active: true, incident_open: null }).reasons).toEqual(["kill_switch_active", "incident_state_unknown"]);
  });

  it("verdier som ikke er ekte svar (undefined, tekst, tall) er ukjente - aldri «av»; ugyldig SLO-tall er manglende observerbarhet", () => {
    for (const bad of [undefined, "false", "", 0, 1, Number.NaN]) {
      const v = changeFreeze({ ...okSignals, kill_switch_active: bad as never, incident_open: bad as never });
      expect(v, String(bad)).toEqual({ frozen: true, reasons: ["kill_switch_unknown", "incident_state_unknown"] });
    }
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, undefined, "3"]) {
      expect(changeFreeze({ ...okSignals, slo_breaches: bad as never }), String(bad)).toEqual({ frozen: true, reasons: ["observability_missing"] });
    }
  });

  it("kun når ALT er målt og friskt er freeze av", () => {
    expect(changeFreeze(okSignals)).toEqual({ frozen: false, reasons: [] });
  });

  it("utrullingsporten stopper på ukjent (freeze:*_unknown), og FREEZE_UNKNOWN_REASONS navngir nøyaktig de «kunne ikke måles»-årsakene", () => {
    for (const s of [{ kill_switch_active: null }, { incident_open: null }]) {
      const v = decideRelease(rel({ signals: { ...okSignals, ...s } }));
      expect(v.allowed).toBe(false);
      expect(v.reasons.some((r) => /^freeze:.*_unknown$/.test(r))).toBe(true);
    }
    expect([...FREEZE_UNKNOWN_REASONS].sort()).toEqual(["incident_state_unknown", "kill_switch_unknown", "observability_missing"]);
  });

  it("selvhelbredelse: ukjent kill switch behandles som PÅ med egen årsak (alt unntatt deteksjon stoppes), aldri som av", () => {
    for (const action of ["reconnect", "restart_container", "switch_provider", "code_repair", "restore_db_over_prod"]) {
      for (const unknownKill of [null, undefined as never]) {
        expect(decideHeal(heal(action, { kill_switch_active: unknownKill, owner_approved: true, preapproved_failover: true, ua_gate_live: true, repair_class: "E0" })), action).toEqual({
          level: levelOfAction(action), allowed: false, mode: "none", reasons: ["kill_switch_unknown"]
        });
      }
    }
    expect(decideHeal(heal("detect_stuck_lease", { kill_switch_active: null }))).toMatchObject({ level: "H0", allowed: true, mode: "auto" });
    expect(decideHeal(heal("reconnect", { kill_switch_active: true })).reasons).toEqual(["kill_switch_active"]);
    expect(decideHeal(heal("reconnect", { kill_switch_active: false })).allowed).toBe(true);
  });
});
