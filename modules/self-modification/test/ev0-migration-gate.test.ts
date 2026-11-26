import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_CONTRACT_MIN_OBSERVATION_HOURS, MIGRATION_PHASES, buildConstitution, evaluateMigrationStep, migrationStateFromLedger, nextMigrationPhase, validateMigrationState,
  validateProposal, type ChangeProposal, type MigrationFacts, type MigrationGateState, type MigrationPhase, type MigrationStepRecord, type MigrationStepRequest
} from "../src/index.ts";

/**
 * WP-EV0 (HF2 kap. 7, K4): migrasjonsgate-tilstandsmaskin. expand -> kompatibel kode -> backfill -> verify -> switch -> contract (egen E2, etter
 * observasjonsvindu, aldri i samme deploy som kodebyttet). REN logikk: avgjør kun om et trinn FÅR gå videre til eier; ingenting utføres.
 */
const T0 = Date.parse("2026-12-01T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const H = 3_600_000;

/** Fakta som tilfredsstiller HVER fase (gyldige, målte). */
const GOOD: MigrationFacts = {
  destructive: false, compatible_with_both_shapes: true, bounded: true, observability: true, pause_and_rollback_plan: "pause jobben; rull tilbake med forrige kolonne",
  data_quality_ok: true, performance_ok: true, rls_tenant_isolation_ok: true, backup_ok: true, controlled: true, old_path_retained: true, old_shape_unused: true
};
const step = (i: number, over: Partial<MigrationStepRecord> = {}): MigrationStepRecord => ({
  phase: MIGRATION_PHASES[i]!, change_id: `chg-${MIGRATION_PHASES[i]}`, deploy_id: `dep-${i}`, completed_at: iso(T0 + i * 24 * H), ...over
});
const stateAt = (n: number): MigrationGateState => ({ migration_id: "mig-1", steps: Array.from({ length: n }, (_, i) => step(i)) });
const req = (phase: MigrationPhase, over: Partial<MigrationStepRequest> = {}): MigrationStepRequest => ({
  migration_id: "mig-1", phase, change_id: `chg-new-${phase}`, deploy_id: `dep-new-${phase}`, now: iso(T0 + 30 * 24 * H), facts: GOOD, ...over
});
const withFacts = (phase: MigrationPhase, facts: MigrationFacts, over: Partial<MigrationStepRequest> = {}): MigrationStepRequest => req(phase, { facts: { ...GOOD, ...facts }, ...over });

describe("A: faser og konstanter er en lukket, rekkefølgebundet liste", () => {
  it("A1: nøyaktig seks faser i planens rekkefølge, og observasjonsvinduet før contract er minst 7 døgn (168 t)", () => {
    expect([...MIGRATION_PHASES]).toEqual(["expand", "compatible_code", "backfill", "verify", "switch", "contract"]);
    expect(MIGRATION_CONTRACT_MIN_OBSERVATION_HOURS).toBe(168);
  });

  it("A2: neste fase følger antall fullførte trinn; etter contract er migrasjonen ferdig (null)", () => {
    for (let n = 0; n < 6; n++) expect(nextMigrationPhase(stateAt(n)), String(n)).toBe(MIGRATION_PHASES[n]);
    expect(nextMigrationPhase(stateAt(6))).toBeNull();
  });
});

describe("B: hele løpet - hvert trinn er sin egen E2-endring som krever eier; ingenting utføres", () => {
  it("B1: gyldig rekkefølge med gyldige fakta slipper gjennom hvert trinn, og next_phase er neste i rekkefølgen", () => {
    for (let i = 0; i < 6; i++) {
      const v = evaluateMigrationStep(stateAt(i), req(MIGRATION_PHASES[i]!));
      expect(v, MIGRATION_PHASES[i]).toEqual({ allowed: true, change_class: "E2", needs_owner: true, phase: MIGRATION_PHASES[i], next_phase: MIGRATION_PHASES[i + 1] ?? null, reasons: [] });
    }
  });

  it("B2: ingen fase er E0/E1: klassen er E2 og eier kreves også for avviste trinn", () => {
    const v = evaluateMigrationStep(stateAt(0), req("contract"));
    expect(v.allowed).toBe(false);
    expect(v.change_class).toBe("E2");
    expect(v.needs_owner).toBe(true);
    expect(v.next_phase).toBeNull();
  });
});

describe("C: rekkefølge - ingen hopp, ingen gjentakelse, ingen tilbakegang (uttømmende)", () => {
  it("C1: fra hver tilstand (0..6 fullførte) er KUN den neste fasen tillatt; alle andre av de seks avvises med riktig årsak", () => {
    for (let n = 0; n <= 6; n++) {
      for (const phase of MIGRATION_PHASES) {
        const v = evaluateMigrationStep(stateAt(n), req(phase));
        const idx = MIGRATION_PHASES.indexOf(phase);
        const label = `${n} fullførte -> ${phase}`;
        if (idx === n) { expect(v.allowed, label).toBe(true); continue; }
        expect(v.allowed, label).toBe(false);
        if (n === 6) expect(v.reasons, label).toContain("migration_already_complete");
        else if (idx < n) expect(v.reasons, label).toContain(`phase_already_completed:${phase}`);
        else expect(v.reasons, label).toContain(`phase_out_of_order:expected_${MIGRATION_PHASES[n]}`);
      }
    }
  });

  it("C2: uttømmende - av alle forsøk (sekvenser opp til lengde 4 over de seks fasene) godtas kun prefikser av den kanoniske rekkefølgen", () => {
    let accepted = 0;
    const run = (attempt: MigrationPhase[]): number => {
      let state: MigrationGateState = { migration_id: "mig-1", steps: [] };
      let done = 0;
      for (const phase of attempt) {
        const v = evaluateMigrationStep(state, req(phase, { change_id: `c-${done}`, deploy_id: `d-${done}`, now: iso(T0 + 400 * 24 * H) }));
        if (!v.allowed) break;
        state = { ...state, steps: [...state.steps, { phase, change_id: `c-${done}`, deploy_id: `d-${done}`, completed_at: iso(T0 + (done + 1) * 24 * H) }] };
        done++;
      }
      return done;
    };
    const walk = (prefix: MigrationPhase[], depth: number): void => {
      if (prefix.length === depth) {
        const done = run(prefix);
        expect(prefix.slice(0, done), prefix.join(">")).toEqual(MIGRATION_PHASES.slice(0, done));
        // en sekvens som er et kanonisk prefiks godtas fullt ut; ellers stopper den ved første avvik
        const canonical = prefix.every((p, i) => p === MIGRATION_PHASES[i]);
        expect(done, prefix.join(">")).toBe(canonical ? prefix.length : prefix.findIndex((p, i) => p !== MIGRATION_PHASES[i]));
        accepted++;
        return;
      }
      for (const p of MIGRATION_PHASES) walk([...prefix, p], depth);
    };
    for (let depth = 1; depth <= 4; depth++) walk([], depth);
    expect(accepted).toBe(6 + 36 + 216 + 1296);
  });

  it("C3: ukjent fase (utenfor listen) avvises lukket", () => {
    const v = evaluateMigrationStep(stateAt(0), req("drop_everything" as MigrationPhase));
    expect(v).toMatchObject({ allowed: false, phase: null, reasons: ["phase_unknown"] });
  });

  it("C4: migrasjons-id må stemme med tilstanden", () => {
    expect(evaluateMigrationStep(stateAt(0), req("expand", { migration_id: "mig-2" })).reasons).toContain("migration_id_mismatch");
    expect(evaluateMigrationStep({ migration_id: "", steps: [] }, req("expand", { migration_id: "" })).reasons).toContain("migration_id_mismatch");
  });
});

describe("D: fakta pr. fase - hvert påkrevd faktum må være NØYAKTIG true (null/undefined/false/streng/tall er alle «ikke oppfylt»)", () => {
  const REQUIRED: Array<[MigrationPhase, keyof MigrationFacts, string]> = [
    ["expand", "compatible_with_both_shapes", "expand_not_compatible_with_old_code"],
    ["compatible_code", "compatible_with_both_shapes", "compatible_code_not_compatible_with_both_shapes"],
    ["backfill", "bounded", "backfill_not_bounded"],
    ["backfill", "observability", "backfill_observability_missing"],
    ["verify", "data_quality_ok", "verify_data_quality_not_ok"],
    ["verify", "performance_ok", "verify_performance_not_ok"],
    ["verify", "rls_tenant_isolation_ok", "verify_rls_tenant_isolation_not_ok"],
    ["verify", "backup_ok", "verify_backup_not_ok"],
    ["switch", "controlled", "switch_not_controlled"],
    ["switch", "old_path_retained", "switch_old_path_not_retained"],
    ["contract", "backup_ok", "contract_backup_not_fresh"],
    ["contract", "old_shape_unused", "contract_old_shape_still_in_use"]
  ];

  it("D1: hvert krav feiler med sin egen årsak for alle ikke-true-verdier, og andre krav påvirkes ikke", () => {
    for (const [phase, fact, reason] of REQUIRED) {
      const idx = MIGRATION_PHASES.indexOf(phase);
      for (const bad of [false, null, undefined, "true", 1, 0]) {
        const facts = { ...GOOD, [fact]: bad } as MigrationFacts;
        const v = evaluateMigrationStep(stateAt(idx), req(phase, { facts }));
        expect(v.allowed, `${phase}.${fact}=${String(bad)}`).toBe(false);
        expect(v.reasons, `${phase}.${fact}=${String(bad)}`).toEqual([reason]);
      }
    }
  });

  it("D2: manglende fakta-objekt-felt (tomt objekt) gir ALLE påkrevde årsaker for fasen - aldri en stille godkjenning", () => {
    expect(evaluateMigrationStep(stateAt(3), req("verify", { facts: {} })).reasons).toEqual([
      "destructive_unknown", "verify_data_quality_not_ok", "verify_performance_not_ok", "verify_rls_tenant_isolation_not_ok", "verify_backup_not_ok"
    ]);
  });

  it("D3: backfill krever en pause-/tilbakerullingsplan (ikke-tom etter trim)", () => {
    for (const bad of ["", "   ", "\n\t", null, undefined]) {
      expect(evaluateMigrationStep(stateAt(2), withFacts("backfill", { pause_and_rollback_plan: bad as string | null })).reasons, String(bad)).toEqual(["backfill_pause_rollback_plan_missing"]);
    }
    expect(evaluateMigrationStep(stateAt(2), withFacts("backfill", { pause_and_rollback_plan: " x " })).allowed).toBe(true);
  });

  it("D4: krav fra ANDRE faser teller ikke: expand trenger ikke bounded/backup osv.", () => {
    const v = evaluateMigrationStep(stateAt(0), req("expand", { facts: { destructive: false, compatible_with_both_shapes: true } }));
    expect(v.allowed).toBe(true);
  });
});

describe("E: destruktive endringer kun i contract - og aldri i samme deploy som kodebyttet", () => {
  it("E1: destructive=true i en hvilken som helst fase FØR contract avvises; ukjent (null/undefined) også", () => {
    for (let i = 0; i < 5; i++) {
      const phase = MIGRATION_PHASES[i]!;
      expect(evaluateMigrationStep(stateAt(i), withFacts(phase, { destructive: true })).reasons, phase).toEqual(["destructive_before_contract"]);
      expect(evaluateMigrationStep(stateAt(i), withFacts(phase, { destructive: null })).reasons, phase).toEqual(["destructive_unknown"]);
      expect(evaluateMigrationStep(stateAt(i), withFacts(phase, { destructive: undefined })).reasons, phase).toEqual(["destructive_unknown"]);
    }
  });

  it("E2: contract MÅ kunne være destruktiv (true) og ikke-destruktiv (false), men «ukjent» avvises", () => {
    expect(evaluateMigrationStep(stateAt(5), withFacts("contract", { destructive: true })).allowed).toBe(true);
    expect(evaluateMigrationStep(stateAt(5), withFacts("contract", { destructive: false })).allowed).toBe(true);
    expect(evaluateMigrationStep(stateAt(5), withFacts("contract", { destructive: null })).reasons).toEqual(["destructive_unknown"]);
  });

  it("E3: contract i samme deploy som et tidligere trinn (særlig switch/kodebytte) avvises; manglende deploy-id avvises", () => {
    for (let i = 0; i < 5; i++) {
      const sameDeploy = stateAt(5).steps[i]!.deploy_id;
      expect(evaluateMigrationStep(stateAt(5), req("contract", { deploy_id: sameDeploy })).reasons, `deploy ${sameDeploy}`).toEqual(["contract_same_deploy_as_earlier_step"]);
    }
    for (const missing of [null, "", "  "]) {
      expect(evaluateMigrationStep(stateAt(5), req("contract", { deploy_id: missing })).reasons, String(missing)).toEqual(["contract_deploy_missing"]);
    }
    expect(evaluateMigrationStep(stateAt(5), req("contract", { deploy_id: "dep-helt-ny" })).allowed).toBe(true);
  });

  it("E4: en egen endring pr. trinn: gjenbruk av en tidligere change_id avvises (contract kan ikke snike seg inn i switch-endringen)", () => {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < i; j++) {
        const v = evaluateMigrationStep(stateAt(i), req(MIGRATION_PHASES[i]!, { change_id: stateAt(i).steps[j]!.change_id }));
        expect(v.reasons, `${MIGRATION_PHASES[i]} gjenbruker ${MIGRATION_PHASES[j]}`).toEqual(["change_id_reused"]);
      }
    }
    for (const empty of ["", "   "]) expect(evaluateMigrationStep(stateAt(0), req("expand", { change_id: empty })).reasons).toEqual(["change_id_missing"]);
  });
});

describe("F: observasjonsvinduet før contract måles fra SWITCH (ikke fra et annet trinn)", () => {
  const switchAt = (ms: number): MigrationGateState => {
    const s = stateAt(5);
    return { ...s, steps: s.steps.map((r, i) => (i === 4 ? { ...r, completed_at: iso(ms) } : r)) };
  };

  it("F1: akkurat 168 t etter switch er tillatt; ett millisekund under avvises; 0 t avvises", () => {
    const sw = T0 + 10 * 24 * H;
    expect(evaluateMigrationStep(switchAt(sw), req("contract", { now: iso(sw + 168 * H) })).allowed).toBe(true);
    const under = evaluateMigrationStep(switchAt(sw), req("contract", { now: iso(sw + 168 * H - 1) }));
    expect(under.allowed).toBe(false);
    expect(under.reasons).toEqual(["contract_observation_window_open:167/168"]);
    expect(evaluateMigrationStep(switchAt(sw), req("contract", { now: iso(sw) })).reasons).toEqual(["contract_observation_window_open:0/168"]);
  });

  it("F2: vinduet regnes fra switch - tidligere trinn (verify osv.) som ligger langt tilbake hjelper ikke", () => {
    const sw = T0 + 100 * 24 * H;
    const s = switchAt(sw);
    expect(s.steps[3]!.completed_at < s.steps[4]!.completed_at).toBe(true);
    expect(evaluateMigrationStep(s, req("contract", { now: iso(sw + 24 * H) })).reasons).toEqual(["contract_observation_window_open:24/168"]);
  });

  it("F3: ugyldige tidsstempler avvises lukket (now, og trinn i historikken)", () => {
    expect(evaluateMigrationStep(stateAt(5), req("contract", { now: "ikke-en-dato" })).reasons).toContain("time_invalid");
    expect(evaluateMigrationStep(stateAt(0), req("expand", { now: "" })).reasons).toContain("time_invalid");
    const broken = { ...stateAt(5), steps: stateAt(5).steps.map((r, i) => (i === 4 ? { ...r, completed_at: "ugyldig" } : r)) };
    const v = evaluateMigrationStep(broken, req("contract"));
    expect(v.allowed).toBe(false);
    expect(v.reasons.some((r) => r.startsWith("state_inconsistent:"))).toBe(true);
  });

  it("F4: klokka kan ikke gå bakover: now før siste fullførte trinn avvises", () => {
    expect(evaluateMigrationStep(stateAt(3), req("switch", { now: iso(T0) })).reasons).toContain("clock_before_last_step");
  });
});

describe("G: tilstanden selv må være konsistent - ellers blokkeres ALT (fail-closed)", () => {
  const issues = (steps: MigrationStepRecord[], id = "mig-1"): string[] => validateMigrationState({ migration_id: id, steps });

  it("G1: en gyldig tilstand har ingen funn", () => {
    for (let n = 0; n <= 6; n++) expect(issues([...stateAt(n).steps]), String(n)).toEqual([]);
  });

  it("G2: hull/dublett/omkastet rekkefølge i historikken", () => {
    const s = stateAt(4).steps;
    expect(issues([s[0]!, s[2]!])[0]).toBe("state_inconsistent:phase_order:1:backfill");
    expect(issues([s[0]!, s[0]!])[0]).toBe("state_inconsistent:phase_order:1:expand");
    expect(issues([s[1]!, s[0]!])[0]).toBe("state_inconsistent:phase_order:0:compatible_code");
    expect(issues([step(5)])[0]).toBe("state_inconsistent:phase_order:0:contract"); // contract uten forutgående trinn
  });

  it("G3: gjenbrukt change_id, tid som går bakover og delt deploy for contract", () => {
    const s = stateAt(6).steps;
    expect(issues([s[0]!, { ...s[1]!, change_id: s[0]!.change_id }])).toContain(`state_inconsistent:change_id_reused:${s[0]!.change_id}`);
    expect(issues([s[0]!, { ...s[1]!, completed_at: iso(T0 - H) }])).toContain("state_inconsistent:time_order:1");
    expect(issues([...s.slice(0, 5), { ...s[5]!, deploy_id: s[4]!.deploy_id }])).toContain("state_inconsistent:contract_shares_deploy");
    expect(issues([...s.slice(0, 5), { ...s[5]!, deploy_id: null }])).toContain("state_inconsistent:contract_deploy_missing");
  });

  it("G4: tom id og mer enn seks trinn", () => {
    expect(issues([], "")).toContain("state_inconsistent:migration_id_empty");
    expect(issues([...stateAt(6).steps, step(0)])).toContain("state_inconsistent:too_many_steps");
    expect(issues([{ ...step(0), change_id: "" }])).toContain("state_inconsistent:change_id_empty:0");
  });

  it("G5: en inkonsistent tilstand blokkerer også et ellers gyldig neste trinn (og viser årsaken)", () => {
    const s = stateAt(3).steps;
    const v = evaluateMigrationStep({ migration_id: "mig-1", steps: [s[0]!, s[2]!] }, req("backfill"));
    expect(v.allowed).toBe(false);
    expect(v.reasons[0]).toBe("state_inconsistent:phase_order:1:backfill");
  });
});

describe("H: tilstanden utledes av endringsregisteret (aldri av forslaget)", () => {
  const row = (seq: number, change_id: string, decision: string, evidence: unknown, at = "2026-12-01T10:00:00.123456Z") => ({
    seq: String(seq), change_id, decision, evidence: typeof evidence === "string" ? evidence : JSON.stringify(evidence), at_text: at
  });
  const m = (phase: string, deploy: string | null = "d-1", id = "mig-1") => ({ migration: { migration_id: id, phase, deploy_id: deploy } });

  it("H1: kun `deployed`-rader med migrasjonsevidens for riktig id teller; rekkefølgen følger seq (tallmessig, ikke tekstlig)", () => {
    const rows = [
      row(10, "c-compat", "deployed", m("compatible_code", "d-2"), "2026-12-02T00:00:00.000000Z"),
      row(2, "c-expand", "deployed", m("expand", "d-1")),
      row(3, "c-other", "deployed", m("expand", "d-9", "mig-ANDRE")),
      row(4, "c-prop", "proposed", m("backfill")),
      row(5, "c-noise", "deployed", { tests: "ok" }),
      row(6, "c-bad", "deployed", "{ikke json"),
      row(7, "c-badphase", "deployed", m("noe_annet"))
    ];
    const state = migrationStateFromLedger(rows, "mig-1");
    expect(state.migration_id).toBe("mig-1");
    expect(state.steps).toEqual([
      { phase: "expand", change_id: "c-expand", deploy_id: "d-1", completed_at: "2026-12-01T10:00:00.123Z" },
      { phase: "compatible_code", change_id: "c-compat", deploy_id: "d-2", completed_at: "2026-12-02T00:00:00.000Z" }
    ]);
  });

  it("H2: en tilbakerulling fjerner trinnet (og dermed neste trinn blir «ute av rekkefølge» hvis senere trinn finnes)", () => {
    const rows = [
      row(1, "c-expand", "deployed", m("expand")),
      row(2, "c-compat", "deployed", m("compatible_code", "d-2")),
      row(3, "c-expand", "rolled_back", m("expand"))
    ];
    const state = migrationStateFromLedger(rows, "mig-1");
    expect(state.steps.map((s) => s.phase)).toEqual(["compatible_code"]);
    expect(validateMigrationState(state)[0]).toBe("state_inconsistent:phase_order:0:compatible_code");
  });

  it("H3: ingen rader gir en tom (ny) migrasjon der expand er eneste lovlige første trinn", () => {
    const state = migrationStateFromLedger([], "mig-1");
    expect(nextMigrationPhase(state)).toBe("expand");
    expect(evaluateMigrationStep(state, req("expand")).allowed).toBe(true);
    expect(evaluateMigrationStep(state, req("contract")).allowed).toBe(false);
  });

  it("H4: deploy_id uten verdi i evidensen blir null (ukjent), og contract uten deploy kan ikke registreres som konsistent", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, `c-${i}`, "deployed", m(MIGRATION_PHASES[i - 1]!, `d-${i}`)));
    rows.push(row(6, "c-6", "deployed", { migration: { migration_id: "mig-1", phase: "contract" } }));
    const state = migrationStateFromLedger(rows, "mig-1");
    expect(state.steps[5]!.deploy_id).toBeNull();
    expect(validateMigrationState(state)).toContain("state_inconsistent:contract_deploy_missing");
  });
});

describe("I: forslagsvalideringen kjører porten for ALLE skjemaendringer (fail-closed uten registertilstand)", () => {
  const constitution = buildConstitution(JSON.parse(readFileSync(new URL("../../../config/evolution/constitution.v1.json", import.meta.url), "utf8")));
  const proposal = (over: Partial<ChangeProposal> = {}): ChangeProposal => ({
    proposal_id: "chg-prop-1",
    problem: { statement: "Ny kolonne trengs for å lagre en måling.", baseline: { rader: 0 } },
    evidence: [{ kind: "metric", ref: "slo:x", trust: "trusted", provenance: "cost_events" }],
    primary_source_verified: { verified: false },
    kind: "schema",
    proposed_change: { component: "db", paths: ["db/add-measure.sql"], summary: "Legg til en nullable kolonne for målingen." },
    claimed_class: "E2",
    confidence_basis: ["eval_delta"],
    data_impact: { schema: true, retention: false, delete: false, rls_or_tenant: false, migration_plan: "expand først" },
    test_plan: ["unit", "integration", "security"],
    rollback: { point: "forrige commit", trigger: "feilrate", data_recovery: "kolonnen er nullable; slett den i contract" },
    owner_impact: { credentials: false, money: false, legal: false, physical: false, approval: false },
    migration: { migration_id: "mig-1", phase: "expand", deploy_id: "dep-1", facts: { ...GOOD } },
    ...over
  });
  const ctx = (state: MigrationGateState | (() => MigrationGateState)) => ({ migration: { stateOf: () => (typeof state === "function" ? state() : state), now: () => new Date(T0 + 30 * 24 * H) } });
  const fresh: MigrationGateState = { migration_id: "mig-1", steps: [] };

  it("I1: gyldig expand mot en tom (ny) migrasjon går til eier som E2", () => {
    const v = validateProposal(proposal(), constitution, ctx(fresh));
    expect(v).toMatchObject({ decision: "needs_owner", effective_class: "E2", kind: "schema" });
    expect(v.reasons.filter((r) => r.startsWith("migration"))).toEqual([]);
  });

  it("I2: en skjemaendring UTEN migrasjonstrinn avvises (kind schema, data_impact.schema og .sql-sti utløser hver for seg kravet)", () => {
    for (const over of [
      { migration: undefined },
      { kind: "code" as const, migration: undefined, data_impact: { schema: true, retention: false, delete: false, rls_or_tenant: false, migration_plan: "x" } },
      { kind: "schema" as const, migration: undefined, data_impact: { schema: false, retention: false, delete: false, rls_or_tenant: false, migration_plan: "x" }, proposed_change: { component: "db", paths: ["apps/web/x.html"], summary: "Skjema uten data_impact." } },
      { kind: "code" as const, migration: undefined, data_impact: { schema: false, retention: false, delete: false, rls_or_tenant: false, migration_plan: "x" }, proposed_change: { component: "db", paths: ["db/x.sql"], summary: "Kun en sql-fil i stien." } }
    ]) {
      const p = proposal(over as Partial<ChangeProposal>);
      if (over.migration === undefined) delete (p as { migration?: unknown }).migration;
      const v = validateProposal(p, constitution, ctx(fresh));
      expect(v.decision, JSON.stringify(Object.keys(over))).toBe("rejected");
      expect(v.reasons, JSON.stringify(Object.keys(over))).toContain("migration_gate_step_required");
    }
  });

  it("I3: uten registertilstand (ingen kontekst, eller stateOf kaster) kan trinnet ikke verifiseres - avvises lukket", () => {
    expect(validateProposal(proposal(), constitution).reasons).toContain("migration_state_unavailable");
    const thrown = validateProposal(proposal(), constitution, ctx(() => { throw new Error("db nede"); }));
    expect(thrown.decision).toBe("rejected");
    expect(thrown.reasons).toContain("migration_state_unavailable");
  });

  it("I4: trinn ute av rekkefølge / for tidlig contract avvises med portens årsak (prefiks migration_gate:)", () => {
    const v = validateProposal(proposal({ migration: { migration_id: "mig-1", phase: "contract", deploy_id: "dep-9", facts: { ...GOOD } } }), constitution, ctx(fresh));
    expect(v.decision).toBe("rejected");
    expect(v.reasons).toContain("migration_gate:phase_out_of_order:expected_expand");
    const early = validateProposal(proposal({ migration: { migration_id: "mig-1", phase: "contract", deploy_id: "dep-9", facts: { ...GOOD } } }), constitution, ctx({ ...stateAt(5), steps: stateAt(5).steps.map((r, i) => (i === 4 ? { ...r, completed_at: iso(T0 + 29 * 24 * H) } : r)) }));
    expect(early.reasons.some((r) => r.startsWith("migration_gate:contract_observation_window_open"))).toBe(true);
  });

  it("I5: forslagets fakta er PÅSTANDER - uoppfylte fakta avvises (ukjent regnes som ikke oppfylt)", () => {
    const v = validateProposal(proposal({ migration: { migration_id: "mig-1", phase: "expand", deploy_id: null, facts: { destructive: false } } }), constitution, ctx(fresh));
    expect(v.decision).toBe("rejected");
    expect(v.reasons).toContain("migration_gate:expand_not_compatible_with_old_code");
  });

  it("I6: en destruktiv påstand i ikke-contract-fase avvises; migrasjonstrinn ugyldig skjema (ukjent fase) avvises som E3", () => {
    const v = validateProposal(proposal({ migration: { migration_id: "mig-1", phase: "expand", deploy_id: "dep-1", facts: { ...GOOD, destructive: true } } }), constitution, ctx(fresh));
    expect(v.reasons).toContain("migration_gate:destructive_before_contract");
    const bad = validateProposal({ ...proposal(), migration: { migration_id: "mig-1", phase: "fusk", deploy_id: null, facts: {} } }, constitution, ctx(fresh));
    expect(bad).toMatchObject({ decision: "rejected", effective_class: "E3" });
    expect(bad.reasons[0]).toMatch(/^invalid_proposal:migration\.phase/);
  });

  it("I7: forslag som ikke er skjemaendringer trenger ikke migrasjonstrinn (og kjører ikke porten)", () => {
    const p = proposal({ kind: "code", data_impact: { schema: false, retention: false, delete: false, rls_or_tenant: false }, proposed_change: { component: "web", paths: ["apps/web/index.html"], summary: "Liten tekstendring i nettsiden." } });
    delete (p as { migration?: unknown }).migration;
    const v = validateProposal(p, constitution);
    expect(v.reasons.some((r) => r.startsWith("migration"))).toBe(false);
    expect(v.decision).toBe("needs_owner");
  });

  it("I8: contract som egen E2 etter vinduet og med ny deploy går til eier (E2) - og klassen kan aldri bli lavere enn E2", () => {
    const ok = validateProposal(proposal({ claimed_class: "E0", migration: { migration_id: "mig-1", phase: "contract", deploy_id: "dep-ny", facts: { ...GOOD, destructive: true } } }), constitution, ctx(stateAt(5)));
    expect(ok.decision).toBe("needs_owner");
    expect(ok.effective_class).toBe("E2");
  });
});
