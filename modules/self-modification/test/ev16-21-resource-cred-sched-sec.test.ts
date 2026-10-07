import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_CATALOG, RED_TEAM_CATEGORIES, alertAsUntrustedEvidence, assessCredential, capacityProposal, classifyCredentialChange, corpusIsMonotonic,
  creditRunway, decideAutoRecharge, detectCostAnomalies, detectSecuritySelfChange, dueMaintenance, extendCorpus, forecastBreach, isCredentialRef, judgeRedTeam,
  planCleanup, type CredentialState
} from "../src/index.ts";

const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n)).toISOString();

describe("EV-16 prognose, anomali og kapasitetsforslag", () => {
  it("lineær vekst gir dager til brudd; flat/synkende gir ingen; for lite data gir lav tillit", () => {
    const growing = Array.from({ length: 10 }, (_, i) => ({ at: day(i), value: 50 + i * 2 }));
    const f = forecastBreach(growing, 100);
    expect(f.confidence).toBe("ok");
    expect(f.slope_per_day).toBeCloseTo(2, 2);
    expect(f.days_to_breach).toBeCloseTo((100 - 68) / 2, 0);
    expect(forecastBreach(growing.map((s) => ({ ...s, value: 50 })), 100).days_to_breach).toBeNull();
    expect(forecastBreach(growing.slice(0, 3), 100)).toMatchObject({ confidence: "low", days_to_breach: null });
    expect(forecastBreach(growing, 60).days_to_breach).toBe(0);
    expect(forecastBreach(growing, 10_000, 90).days_to_breach).toBeNull();
  });
  it("kapasitetsforslag krever evidens og er alltid eier-gatet", () => {
    const f = forecastBreach(Array.from({ length: 10 }, (_, i) => ({ at: day(i), value: 50 + i * 2 })), 100);
    const p = capacityProposal("disk", f, 100, "GB", "Utvid lagring", true);
    expect(p).toMatchObject({ requires_owner: true, involves_spend: true });
    expect(capacityProposal("disk", { ...f, confidence: "low" }, 100, "GB", "x", true)).toBeNull();
  });
  it("kostanomali per nøkkel: z-score mot baseline, krever nok dager og minste økning", () => {
    const base = Array.from({ length: 7 }, (_, i) => ({ key: "openai", day: `2026-09-${20 + i}`, ore: 10 + (i % 2) }));
    const spike = detectCostAnomalies([...base, { key: "openai", day: "2026-09-30", ore: 80 }], "2026-09-30");
    expect(spike).toHaveLength(1);
    expect(spike[0]).toMatchObject({ key: "openai", today_ore: 80 });
    expect(detectCostAnomalies([...base, { key: "openai", day: "2026-09-30", ore: 12 }], "2026-09-30")).toEqual([]);
    expect(detectCostAnomalies([{ key: "x", day: "2026-09-29", ore: 1 }, { key: "x", day: "2026-09-30", ore: 500 }], "2026-09-30")).toEqual([]);
    expect(detectCostAnomalies([...base, { key: "openai", day: "2026-09-30", ore: 13 }], "2026-09-30", { min_delta_ore: 1, z_threshold: 1 })).toHaveLength(1);
  });
  it("opprydding kun innen eksplisitte regler og aldri utenfor prefiks/alder; farlige regler ignoreres", () => {
    const artifacts = [
      { path: "var/cache/builds/a.tar", age_days: 40, bytes: 1 },
      { path: "var/cache/builds/b.tar", age_days: 3, bytes: 1 },
      { path: "var/data/important.db", age_days: 400, bytes: 1 },
      { path: "var/cache/builds/../../etc/passwd", age_days: 400, bytes: 1 }
    ];
    expect(planCleanup(artifacts, [{ prefix: "var/cache/builds/", max_age_days: 14 }]).map((a) => a.path)).toEqual(["var/cache/builds/a.tar"]);
    expect(planCleanup(artifacts, [{ prefix: "/", max_age_days: 1 }, { prefix: "var", max_age_days: 1 }, { prefix: "var/cache/../", max_age_days: 1 }])).toEqual([]);
  });
  it("kredittløp og auto-recharge: krever leverandørstøtte, policy og beløp innen Finance-grense", () => {
    expect(creditRunway({ balance_ore: 1000, burn_ore_per_day: 100, warn_days: 14 })).toEqual({ days_left: 10, warn: true });
    expect(creditRunway({ balance_ore: 1000, burn_ore_per_day: 0, warn_days: 14 })).toEqual({ days_left: null, warn: false });
    expect(decideAutoRecharge({ provider_supports_auto_recharge: true, finance_policy_allows: true, amount_ore: 500, finance_remaining_limit_ore: 1000 }).allowed).toBe(true);
    expect(decideAutoRecharge({ provider_supports_auto_recharge: false, finance_policy_allows: false, amount_ore: 5000, finance_remaining_limit_ore: 1000 }).reasons).toEqual(["provider_does_not_support_auto_recharge", "finance_policy_denies", "exceeds_finance_limit"]);
  });
});

const cred = (over: Partial<CredentialState> = {}): CredentialState => ({ ref: "JARVIS_GITHUB_TOKEN", kind: "short_lived_token", expires_at: null, last_refresh_ok: true, scopes_granted: ["repo"], scopes_required: ["repo"], revoked: false, ...over });
const NOW = new Date("2026-10-06T12:00:00Z");

describe("EV-17 credentials: fornyelse innen scope er H1, alt annet er eier/ekstern", () => {
  it("friskt token er ok; snart utløpende/utløpt kortlevd token kan fornyes automatisk innen scope", () => {
    expect(assessCredential(cred(), NOW)).toMatchObject({ health: "ok", auto_action: "none", needs: "none" });
    expect(assessCredential(cred({ expires_at: "2026-10-06T20:00:00Z" }), NOW)).toMatchObject({ health: "expiring_soon", auto_action: "refresh_in_scope", needs: "none" });
    expect(assessCredential(cred({ expires_at: "2026-10-05T00:00:00Z" }), NOW)).toMatchObject({ health: "expired", auto_action: "refresh_in_scope" });
  });
  it("api-nøkkel/rot som utløper, tilbakekalt og scope-mangel går til eier/ekstern - aldri auto", () => {
    expect(assessCredential(cred({ kind: "api_key", expires_at: "2026-10-06T20:00:00Z" }), NOW)).toMatchObject({ auto_action: "none", needs: "owner_alert" });
    expect(assessCredential(cred({ revoked: true }), NOW)).toMatchObject({ health: "revoked", needs: "owner_alert", auto_action: "none" });
    expect(assessCredential(cred({ scopes_granted: [] }), NOW)).toMatchObject({ health: "scope_shortfall", needs: "human_external_gate", auto_action: "none" });
    expect(assessCredential(cred({ kind: "oauth", last_refresh_ok: false }), NOW)).toMatchObject({ health: "refresh_failing", needs: "human_external_gate" });
  });
  it("endringsklasser: refresh E0/H1; scope/nettverk E2; rot/samtykke/konto/KYC/vilkår er alltid human_external", () => {
    expect(classifyCredentialChange("refresh_in_scope")).toEqual({ change_class: "E0", gate: "auto_h1" });
    expect(classifyCredentialChange("scope_change")).toEqual({ change_class: "E2", gate: "owner_e2" });
    expect(classifyCredentialChange("network_change")).toEqual({ change_class: "E2", gate: "owner_e2" });
    for (const c of ["new_root_credential", "oauth_consent", "new_provider_account", "kyc", "legal_terms"] as const) expect(classifyCredentialChange(c).gate, c).toBe("human_external");
  });
  it("kun credential-referanser (aldri verdier) kan nå en agent", () => {
    expect(isCredentialRef("JARVIS_GITHUB_TOKEN")).toBe(true);
    for (const v of ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "sk-ant-api03-xxxx", "my secret", "lowercase_ref", ""]) expect(isCredentialRef(v), v).toBe(false);
  });
});

describe("EV-19 vedlikeholdsplan", () => {
  const caps = { radar: 8, eval: 4, red_team: 2, shadow: 2 };
  const base = { now: NOW, last_run: {}, change_freeze: false, cap_usage: {}, caps };
  it("alt som aldri er kjørt forfaller; nylig kjørte gjør ikke; event-oppgaver kun ved hendelse", () => {
    const first = dueMaintenance(base);
    expect(first.run).toContain("health_check");
    expect(first.run).not.toContain("cve_response");
    const lastRun = Object.fromEntries(MAINTENANCE_CATALOG.filter((t) => t.cadence !== "event").map((t) => [t.id, "2026-10-06T06:00:00Z"]));
    expect(dueMaintenance({ ...base, last_run: lastRun }).run).toEqual([]);
    expect(dueMaintenance({ ...base, last_run: { ...lastRun, health_check: "2026-10-04T00:00:00Z" } }).run).toEqual(["health_check"]);
    expect(dueMaintenance({ ...base, last_run: lastRun, events: ["cve", "cost_spike"] }).run).toEqual(["cve_response", "cost_spike_review"]);
  });
  it("change freeze stopper muterende oppgaver, men ikke ren deteksjon", () => {
    const d = dueMaintenance({ ...base, change_freeze: true });
    expect(d.blocked.map((b) => b.id)).toEqual(expect.arrayContaining(["disaster_recovery_sample_restore", "full_provider_failover", "cold_start_drill"]));
    expect(d.blocked.every((b) => b.reason === "change_freeze" || b.reason === "monthly_cap_reached")).toBe(true);
    expect(d.run).toContain("health_check");
    expect(d.run).not.toContain("cold_start_drill");
  });
  it("månedlige tak for radar/eval/red-team/shadow respekteres", () => {
    const d = dueMaintenance({ ...base, cap_usage: { radar: 8, eval: 4, red_team: 2, shadow: 2 } });
    expect(d.blocked.map((b) => b.id)).toEqual(expect.arrayContaining(["model_candidates", "eval_drift", "red_team_run", "full_provider_failover"]));
    expect(d.run).not.toContain("model_candidates");
    expect(d.run).toContain("health_check");
  });
});

describe("EV-21 sikkerhetstilpasning: regresjon er hard stopp", () => {
  it("ett gjennombrudd i én kategori er hard stopp; kategorier uten kjøring er udekket (aldri bestått)", () => {
    const v = judgeRedTeam([{ category: "exfiltration", attempts: 10, breaches: 0 }, { category: "approval_bypass", attempts: 5, breaches: 1 }]);
    expect(v).toMatchObject({ hard_stop: true, breached: ["approval_bypass"] });
    expect(v.uncovered).toEqual(["confused_deputy", "cross_space_leakage", "radar_injection"]);
    const clean = judgeRedTeam(RED_TEAM_CATEGORIES.map((category) => ({ category, attempts: 3, breaches: 0 })));
    expect(clean).toEqual({ hard_stop: false, breached: [], uncovered: [] });
    expect(judgeRedTeam([{ category: "exfiltration", attempts: 0, breaches: 0 }]).uncovered).toContain("exfiltration");
  });
  it("sikkerhetsvarsler er ubetrodd evidens; injection-korpus er kun-tillegg", () => {
    expect(alertAsUntrustedEvidence({ source: "dependabot", id: "GHSA-1", summary: "x" })).toEqual({ kind: "cve", ref: "GHSA-1", trust: "untrusted", provenance: "dependabot" });
    const v1 = { version: 1, patterns: ["ignore previous"] };
    const v2 = extendCorpus(v1, ["act as system", " ", "ignore previous"]);
    expect(v2).toEqual({ version: 2, patterns: ["ignore previous", "act as system"] });
    expect(extendCorpus(v2, ["act as system"])).toBe(v2);
    expect(corpusIsMonotonic(v1, v2)).toBe(true);
    expect(corpusIsMonotonic(v2, { version: 3, patterns: ["act as system"] })).toBe(false);
  });
  it("forsøk på å svekke alarm/sikkerhetskontroll => freeze + eier-varsel; vanlig endring => ingen", () => {
    expect(detectSecuritySelfChange({ paths: ["modules/watchdog/src/watchdog.ts"], summary: "Disable the watchdog alert because it is noisy" })).toMatchObject({ suspicious: true, freeze: true, owner_alert: true });
    expect(detectSecuritySelfChange({ paths: ["apps/api/src/x.ts"], summary: "Senk terskelen for audit-varsel og demp støy" }).suspicious).toBe(true);
    expect(detectSecuritySelfChange({ paths: [".github/workflows/ci.yml"], summary: "Oppdater node-versjon" }).reasons).toEqual(["touches_protected_security_path"]);
    expect(detectSecuritySelfChange({ paths: ["apps/web/index.html"], summary: "Juster farger på jobbkort" })).toMatchObject({ suspicious: false, freeze: false });
  });
});
