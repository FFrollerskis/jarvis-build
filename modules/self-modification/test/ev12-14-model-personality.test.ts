import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_FEELING_WORDS, SLIDER_KEYS, TONE_ONLY_KEYS, adjustProfile, appendVersion, auditFallbackChains, decayInferred, decayTowardBase, decidePromotion,
  decideRoute, defaultProfile, deriveExpressionState, presentationIsSafe, rollbackTo,
  type AutopilotPolicy, type RegistryModel
} from "../src/index.ts";

const model = (provider: string, id: string, over: Partial<RegistryModel> = {}): RegistryModel => ({
  provider, model_id: id, status: "active", locality: "cloud", price_ore_per_1k_tokens: 5, latency_p95_ms: 3000, context_tokens: 32_000, tool_use: true, vision: false, region: "eu", ...over
});
const registry = [
  model("gemma_local", "llama3.1:8b", { locality: "local", latency_p95_ms: 8000, price_ore_per_1k_tokens: 0 }),
  model("anthropic", "sonnet", { latency_p95_ms: 2500 }),
  model("openai", "gpt", { latency_p95_ms: 3000 }),
  model("openai", "gpt-new", { status: "shadow" }),
  model("kimi", "k2", { status: "candidate" })
];
const policy: AutopilotPolicy = {
  allowlist: [{ provider: "gemma_local", model_id: "llama3.1:8b" }, { provider: "anthropic", model_id: "sonnet" }, { provider: "openai", model_id: "gpt" }, { provider: "openai", model_id: "gpt-new" }],
  force_local_when: { sensitivities: ["SECRET_RESTRICTED"], spaces: ["health"] },
  critical_workflows: ["chat", "voice"]
};
const task = (over: Record<string, unknown> = {}) => ({ workflow: "chat", space: "personal", sensitivity: "PRIVATE", needs: {}, ...over });

describe("EV-12 modellruting innen eier-godkjent allowlist", () => {
  it("velger raskeste friske aktive allowlist-modell; andre leverandører først i fallback; shadow observeres, aldri valgt", () => {
    const d = decideRoute(task(), registry, policy, {});
    expect(d.choice).toEqual({ provider: "anthropic", model_id: "sonnet" });
    expect(d.fallback[0]?.provider).not.toBe("anthropic");
    expect(d.shadow).toEqual([{ provider: "openai", model_id: "gpt-new" }]);
    expect(d.choice?.model_id).not.toBe("gpt-new");
  });
  it("kandidat utenfor allowlist (kimi) og shadow-modeller velges aldri", () => {
    const only = decideRoute(task(), [model("kimi", "k2", { latency_p95_ms: 1 })], policy, {});
    expect(only.choice).toBeNull();
    expect(only.reasons).toContain("no_eligible_model");
  });
  it("sensitive rom/sensitivitet tvinger lokal; nedetid hopper over leverandør; svekket rangeres sist", () => {
    const local = decideRoute(task({ sensitivity: "SECRET_RESTRICTED" }), registry, policy, {});
    expect(local.choice?.provider).toBe("gemma_local");
    expect(local.reasons).toContain("forced_local");
    expect(decideRoute(task({ space: "health" }), registry, policy, {}).choice?.provider).toBe("gemma_local");
    expect(decideRoute(task(), registry, policy, { anthropic: "down" }).choice?.provider).not.toBe("anthropic");
    expect(decideRoute(task(), registry, policy, { anthropic: "degraded" }).choice?.provider).not.toBe("anthropic");
    expect(decideRoute(task({ sensitivity: "SECRET_RESTRICTED" }), registry, policy, { gemma_local: "down" }).choice).toBeNull();
  });
  it("krav til verktøybruk/vision/kontekst filtrerer; enkelt-leverandør flagges", () => {
    expect(decideRoute(task({ needs: { vision: true } }), registry, policy, {}).choice).toBeNull();
    expect(decideRoute(task({ needs: { min_context_tokens: 100_000 } }), registry, policy, {}).choice).toBeNull();
    const single = decideRoute(task(), [model("anthropic", "sonnet")], policy, {});
    expect(single.reasons).toContain("single_provider_available");
  });
  it("ny modell: candidate -> shadow -> active, ingen hopp; aktivering krever allowlist, eval og shadow-tid; atferdsrelevant er minst E1", () => {
    const cand = model("kimi", "k2", { status: "candidate" });
    expect(decidePromotion({ model: cand, to: "shadow", on_allowlist: false, eval_passed: false, shadow_days: 0, behavior_relevant: true })).toMatchObject({ allowed: true, min_class: "E1" });
    expect(decidePromotion({ model: cand, to: "active", on_allowlist: true, eval_passed: true, shadow_days: 10, behavior_relevant: true }).reasons[0]).toContain("illegal_transition");
    const shadow = model("kimi", "k2", { status: "shadow" });
    expect(decidePromotion({ model: shadow, to: "active", on_allowlist: false, eval_passed: false, shadow_days: 1, behavior_relevant: true }).reasons).toEqual(["not_on_owner_allowlist", "evals_not_passed", "shadow_period_too_short"]);
    expect(decidePromotion({ model: shadow, to: "active", on_allowlist: true, eval_passed: true, shadow_days: 5, behavior_relevant: false })).toMatchObject({ allowed: true, min_class: "E0" });
  });
  it("kritiske arbeidsflyter: én leverandør, aldri testet og gammel test flagges", () => {
    const now = new Date("2026-10-06T00:00:00Z");
    const issues = auditFallbackChains([
      { workflow: "chat", chain: [{ provider: "a" }], last_tested_at: null },
      { workflow: "voice", chain: [{ provider: "a" }, { provider: "b" }], last_tested_at: "2026-08-01T00:00:00Z" },
      { workflow: "ads", chain: [{ provider: "a" }], last_tested_at: null }
    ], policy, now);
    expect(issues).toEqual([{ workflow: "chat", issue: "single_provider" }, { workflow: "chat", issue: "never_tested" }, { workflow: "voice", issue: "test_stale" }]);
  });
});

describe("EV-13 personlighet: tone-lag adskilt fra safety/tillatelser", () => {
  it("eksplisitt tilbakemelding endrer tone med delta-grense og versjon økes (ny profil, ingen mutasjon)", () => {
    const p = defaultProfile("internal");
    const r = adjustProfile(p, { source: "explicit_feedback", changes: { humor: 90 } });
    expect(r.applied.humor).toBe(70);
    expect(r.rejected.some((x) => x.reason === "clamped_by_delta_or_range")).toBe(true);
    expect(r.profile.version).toBe(2);
    expect(p.sliders.humor).toBe(40);
  });
  it("ukjente nøkler (safety/sannferdighet/tillatelser) avvises; ingenting endres", () => {
    const p = defaultProfile("internal");
    const r = adjustProfile(p, { source: "explicit_feedback", changes: { truthfulness: 0, safety_level: 0, can_send_email: 1 } as never });
    expect(r.rejected.map((x) => x.reason)).toEqual(["unknown_key_not_tone", "unknown_key_not_tone", "unknown_key_not_tone"]);
    expect(r.profile).toBe(p);
  });
  it("avledede preferanser trenger tillit og flere observasjoner, og har lavere delta-grense", () => {
    const p = defaultProfile("internal");
    expect(adjustProfile(p, { source: "inferred", changes: { directness: 80 }, confidence: 0.5, observations: 5 }).applied).toEqual({});
    expect(adjustProfile(p, { source: "inferred", changes: { directness: 80 }, confidence: 0.9, observations: 2 }).applied).toEqual({});
    const ok = adjustProfile(p, { source: "inferred", changes: { directness: 80 }, confidence: 0.9, observations: 4 });
    expect(ok.applied.directness).toBe(70);
  });
  it("A/B-eksperimenter kan kun påvirke tone - ikke initiativ/nysgjerrighet/motargumentering", () => {
    const p = defaultProfile("internal");
    const r = adjustProfile(p, { source: "experiment", changes: { initiative: 80, curiosity: 80, counterargument: 80, humor: 50 } });
    expect(r.applied).toEqual({ humor: 50 });
    expect(r.rejected.map((x) => x.reason)).toEqual(["experiment_tone_only", "experiment_tone_only", "experiment_tone_only"]);
    expect(TONE_ONLY_KEYS).not.toContain("initiative");
  });
  it("kundevendt/profesjonell/sensitiv er eier-låst: kun eier endrer; edge og banning av", () => {
    for (const mode of ["customer_facing", "professional", "sensitive"] as const) {
      const p = defaultProfile(mode);
      expect(p.owner_accepted_live).toBe(false);
      expect(SLIDER_KEYS.every((k) => p.locks[k] === true)).toBe(true);
      const r = adjustProfile(p, { source: "explicit_feedback", changes: { humor: 60 } });
      expect(r.rejected[0]?.reason).toBe("locked_mode_owner_only");
      expect(r.profile).toBe(p);
      expect(adjustProfile(p, { source: "owner", changes: { edge: 50 } }).rejected[0]?.reason).toBe("edge_disabled_in_locked_modes");
      expect(adjustProfile(p, { source: "owner", changes: { swearing: "high" } }).rejected[0]?.reason).toBe("swearing_off_in_locked_modes");
    }
  });
  it("banning kun ved eksplisitt eier-setting i internt modus", () => {
    const p = defaultProfile("internal");
    expect(adjustProfile(p, { source: "explicit_feedback", changes: { swearing: "low" } }).rejected[0]?.reason).toBe("swearing_requires_explicit_owner_setting");
    expect(adjustProfile(p, { source: "owner", changes: { swearing: "low" } }).applied.swearing).toBe("low");
  });
  it("eierens lås og intervall håndheves for ikke-eier-kilder", () => {
    const p = { ...defaultProfile("internal"), locks: { humor: true as const }, owner_ranges: { energy: [30, 60] as const } };
    expect(adjustProfile(p, { source: "explicit_feedback", changes: { humor: 50 } }).rejected[0]?.reason).toBe("locked");
    expect(adjustProfile(p, { source: "owner", changes: { humor: 50 } }).applied.humor).toBe(50);
    expect(adjustProfile(p, { source: "explicit_feedback", changes: { energy: 100 } }).applied.energy).toBe(60);
    expect(adjustProfile(p, { source: "explicit_feedback", changes: { energy: 120 } }).rejected[0]?.reason).toBe("out_of_range");
  });
  it("decay mot basis; versjonshistorikk er append-only og tilbakerulling lager ny versjon", () => {
    expect(decayInferred(80, 40, 0)).toBe(80);
    expect(decayInferred(80, 40, 14)).toBe(60);
    expect(decayInferred(80, 40, 140)).toBe(40);
    let h = appendVersion({ versions: [] }, defaultProfile("internal"));
    const changed = adjustProfile(h.versions[0]!, { source: "owner", changes: { humor: 90 } }).profile;
    h = appendVersion(h, changed);
    const rolled = rollbackTo(h, 1);
    expect(rolled.versions).toHaveLength(3);
    expect(rolled.versions[2]).toMatchObject({ version: 3 });
    expect(rolled.versions[2]!.sliders.humor).toBe(40);
    expect(h.versions).toHaveLength(2);
    expect(() => rollbackTo(h, 99)).toThrow("personality_version_not_found");
  });
});

describe("EV-14 uttrykkstilstand: stil, aldri følelser", () => {
  const base = defaultProfile("internal");
  it("hendelse = alvorlig/ingen humor/kort; kundesamtale = profesjonell; dyp research = mer nysgjerrig/utfordrende", () => {
    expect(deriveExpressionState("incident", base)).toMatchObject({ seriousness: 100, humor: 0, verbosity: "low" });
    expect(deriveExpressionState("customer_call", base)).toMatchObject({ verbosity: "low" });
    expect(deriveExpressionState("customer_call", base).humor).toBeLessThanOrEqual(10);
    const research = deriveExpressionState("deep_research", base);
    expect(research.curiosity).toBeGreaterThan(base.sliders.curiosity);
    expect(research.challenge).toBeGreaterThan(base.sliders.counterargument);
  });
  it("avslappet privat kontekst gir mer humor internt, men aldri i låst profil", () => {
    expect(deriveExpressionState("casual_private", base).humor).toBeGreaterThan(base.sliders.humor);
    const locked = defaultProfile("customer_facing");
    expect(deriveExpressionState("casual_private", locked).humor).toBe(locked.sliders.humor);
  });
  it("tilstanden avtar mot basis og forsvinner etter lang tid", () => {
    const s = deriveExpressionState("incident", base);
    const half = decayTowardBase(s, base, 30);
    expect(half.humor).toBe(Math.round(base.sliders.humor + (0 - base.sliders.humor) * 0.5));
    expect(half.seriousness).toBe(75);
    const done = decayTowardBase(s, base, 600);
    expect(done).toMatchObject({ verbosity: "normal", label_no: "stil: vanlig", seriousness: 50 });
  });
  it("alle stilbeskrivelser er fri for følelsesord", () => {
    for (const c of ["incident", "casual_private", "customer_call", "deep_research", "default"] as const) {
      expect(presentationIsSafe(deriveExpressionState(c, base).label_no), c).toBe(true);
      expect(presentationIsSafe(deriveExpressionState(c, defaultProfile("customer_facing")).label_no), c).toBe(true);
    }
    expect(presentationIsSafe("jeg er glad i dag")).toBe(false);
    expect(FORBIDDEN_FEELING_WORDS).toContain("føler");
  });
});
