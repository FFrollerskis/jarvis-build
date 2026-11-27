import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHANGE_KINDS, KIND_MINIMUM_CLASS, buildConstitution, changeFreeze, classRank, decideRelease, derivedKindsFromPaths, isChangeKind, maxClass, minimumClassForKind,
  proposalToLedgerEntry, validateProposal, type ChangeKind, type ChangeProposal, type EvChangeClass, type ReleaseRequest, type ReleaseStage
} from "../src/index.ts";

/**
 * WP-EV0 (HF2 EV-0, K3): `kind` i endringsforslag med minsteklasse-regler (prompt/personlighet/ruting >= E1; skjema/avhengighet/credential/nettverk/
 * beskyttet-nær >= E2). Klassen kan aldri bli svakere enn gulvet, hevdet klasse eller sti-utledet klasse. Ren logikk.
 */
const constitution = buildConstitution(JSON.parse(readFileSync(new URL("../../../config/evolution/constitution.v1.json", import.meta.url), "utf8")));
const CLASSES: readonly EvChangeClass[] = ["E0", "E1", "E2", "E3"];

const base = (over: Partial<ChangeProposal> = {}): ChangeProposal => ({
  proposal_id: "prop-kind-1",
  problem: { statement: "Chat-ttft p95 er over målet siste døgn.", baseline: { ttft_p95_ms: 41_000 } },
  evidence: [{ kind: "metric", ref: "slo:chat_ttft_p95", trust: "trusted", provenance: "cost_events" }],
  primary_source_verified: { verified: false },
  kind: "personality",
  personality_scope: "internal",
  proposed_change: { component: "personality", paths: ["config/charlie-personality.json"], summary: "Kortere standard svarlengde i chat for lavere ttft." },
  claimed_class: "E1",
  confidence_basis: ["eval_delta", "slo_metric"],
  data_impact: { schema: false, retention: false, delete: false, rls_or_tenant: false },
  test_plan: ["unit", "eval", "security"],
  rollback: { point: "forrige commit", trigger: "eval-regresjon", data_recovery: "ingen data endres" },
  owner_impact: { credentials: false, money: false, legal: false, physical: false, approval: false },
  ...over
});
const withPaths = (paths: string[], over: Partial<ChangeProposal> = {}): ChangeProposal =>
  base({ proposed_change: { component: "x", paths, summary: "Endring for å teste klassifiseringen av en type." }, ...over });

describe("A: typene og gulvet er en lukket, frosset tabell", () => {
  it("A1: nøyaktig de 10 typene, i rekkefølgen planen nevner dem", () => {
    expect([...CHANGE_KINDS]).toEqual(["prompt", "personality", "routing", "config", "code", "schema", "dependency", "credential", "network", "protected-adjacent"]);
  });

  it("A2: gulvet pr. type: prompt/personlighet/ruting E1, kode/konfig E0 (klassen følger stiene), resten E2", () => {
    expect(KIND_MINIMUM_CLASS).toEqual({
      prompt: "E1", personality: "E1", routing: "E1", config: "E0", code: "E0",
      schema: "E2", dependency: "E2", credential: "E2", network: "E2", "protected-adjacent": "E2"
    });
    expect(Object.isFrozen(KIND_MINIMUM_CLASS)).toBe(true);
    for (const k of CHANGE_KINDS) expect(minimumClassForKind(k), k).toBe(KIND_MINIMUM_CLASS[k]);
  });

  it("A3: ukjent type er E3 (fail-closed) - også prototype-navn, feil store/små bokstaver og ikke-strenger", () => {
    for (const bad of ["firmware", "Prompt", "CODE", "", " code", "code ", "constructor", "__proto__", "toString", "hasOwnProperty", undefined, null, 1, {}, ["code"]]) {
      expect(minimumClassForKind(bad), String(bad)).toBe("E3");
      expect(isChangeKind(bad), String(bad)).toBe(false);
    }
    for (const k of CHANGE_KINDS) expect(isChangeKind(k)).toBe(true);
  });
});

describe("B: typer utledet fra stiene (hevder man «code», fanger stiene det)", () => {
  const cases: Array<[string[], ChangeKind[]]> = [
    [["modules/core/src/db/migrations/280_x.sql"], ["schema", "protected-adjacent"]],
    [["db/schema.sql"], ["schema"]],
    [["apps/web/Dockerfile"], ["dependency"]],
    [["apps/web/PACKAGE.JSON"], ["dependency"]],
    [["apps/web/.env.local"], ["credential"]],
    [["apps/web/my-secret-helper.ts"], ["credential"]],
    [["apps/web/nginx.conf"], ["network"]],
    [["infra/local/x.yml"], ["network", "protected-adjacent"]],
    [["apps/api/src/server.ts"], ["protected-adjacent"]],
    [["modules/tool-gateway/src/live-transports.ts"], ["protected-adjacent"]],
    [["README.md"], ["protected-adjacent"]],
    [["apps/web/index.html"], []],
    // WP-EV0 fix1 (L2): personlighetsfilen (zero-review-allowlisten) avslører typen «personality» uansett hva forslaget hevder.
    [["config/charlie-personality.json"], ["personality"]]
  ];

  it("B1: tabell (stier -> utledede typer, sortert i typerekkefølgen)", () => {
    for (const [paths, kinds] of cases) expect(derivedKindsFromPaths(paths), paths.join(",")).toEqual(kinds);
  });

  it("B2: flere stier gir unionen; tom liste gir ingen; ugyldige stier gir protected-adjacent (aldri tomt)", () => {
    expect(derivedKindsFromPaths(["apps/web/Dockerfile", "apps/web/nginx.conf"])).toEqual(["dependency", "network"]);
    expect(derivedKindsFromPaths([])).toEqual([]);
    expect(derivedKindsFromPaths(["../x"])).toEqual(["protected-adjacent"]);
  });
});

describe("C: validateProposal - klassen er alltid max(sti-klasse, gulv for typen, utledede typer, hevdet klasse)", () => {
  const PATHSETS: Record<string, string[]> = {
    e1_config: ["config/charlie-personality.json"],
    e2_web: ["apps/web/index.html"],
    e2_dockerfile: ["apps/web/Dockerfile"],
    e2_secretish: ["apps/web/my-secret-helper.ts"],
    e2_nginx: ["apps/web/nginx.conf"],
    e3_policy: ["modules/policy/src/policy-gateway.ts"],
    e3_pool: ["modules/core/src/db/pool.ts"],
    e3_invalid: ["a/../modules/policy/x.ts"]
  };
  const PATH_CLASS: Record<string, EvChangeClass> = {
    e1_config: "E1", e2_web: "E2", e2_dockerfile: "E2", e2_secretish: "E2", e2_nginx: "E2", e3_policy: "E3", e3_pool: "E3", e3_invalid: "E3"
  };

  it("C1: ALLE kombinasjoner (10 typer x 4 hevdede klasser x 8 stisett): effektiv klasse = max(alle gulv), og utfallet følger klassen", () => {
    let n = 0;
    for (const kind of CHANGE_KINDS) {
      for (const claimed of CLASSES) {
        for (const [name, paths] of Object.entries(PATHSETS)) {
          const p = withPaths(paths, { kind, claimed_class: claimed, personality_scope: "internal", test_plan: ["unit", "security", "eval"], primary_source_verified: { verified: true, source_ref: "https://example.org/advisory" }, data_impact: { schema: false, retention: false, delete: false, rls_or_tenant: false, migration_plan: "expand først, så kompatibel kode" } });
          const v = validateProposal(p, constitution);
          const label = `${kind}/${claimed}/${name}`;
          // Gulvene (regnet ut uavhengig av koden under test):
          const kindFloor = KIND_MINIMUM_CLASS[kind];
          const derivedFloor = derivedKindsFromPaths(paths).map((k) => KIND_MINIMUM_CLASS[k]).reduce<EvChangeClass>((a, b) => maxClass(a, b), "E0");
          const expected = [claimed, PATH_CLASS[name]!, kindFloor, derivedFloor].reduce<EvChangeClass>((a, b) => maxClass(a, b), "E0");
          expect(classRank(v.effective_class), label).toBeGreaterThanOrEqual(classRank(expected));
          expect(classRank(v.effective_class), label).toBeGreaterThanOrEqual(classRank(claimed));
          expect(classRank(v.effective_class), label).toBeGreaterThanOrEqual(classRank(kindFloor));
          if (expected === "E3") { expect(v.decision, label).toBe("rejected"); expect(v.effective_class, label).toBe("E3"); }
          if (v.decision === "accepted_for_review") expect(classRank(v.effective_class), label).toBeLessThanOrEqual(1);
          if (v.decision === "needs_owner") expect(v.effective_class, label).toBe("E2");
          expect(v.kind, label).toBe(kind);
          expect(v.kind_minimum_class, label).toBe(kindFloor);
          n++;
        }
      }
    }
    expect(n).toBe(10 * 4 * 8);
  });

  it("C2: gulvene alene (E1-sti, ingen hevdet klasse over E0): prompt/personlighet/ruting blir E1, skjema/avhengighet/credential/nettverk/beskyttet-nær blir E2", () => {
    for (const kind of CHANGE_KINDS) {
      const v = validateProposal(base({ kind, claimed_class: "E0", personality_scope: "internal" }), constitution);
      const floor = KIND_MINIMUM_CLASS[kind];
      // sti = personlighets-konfig (E1 etter stiene); gulvet kan bare heve
      expect(v.effective_class, kind).toBe(maxClass("E1", floor));
      expect(v.derived_class, kind).toBe(maxClass("E1", floor));
    }
  });

  it("C3: skjema/avhengighet/credential/nettverk/beskyttet-nær på en ellers E1-sti gir needs_owner (E2) - aldri accepted_for_review", () => {
    for (const kind of ["schema", "dependency", "credential", "network", "protected-adjacent"] as const) {
      const v = validateProposal(base({ kind, claimed_class: "E1", data_impact: { schema: false, retention: false, delete: false, rls_or_tenant: false, migration_plan: "plan" } }), constitution);
      expect(v.effective_class, kind).toBe("E2");
      expect(v.decision, kind).not.toBe("accepted_for_review");
    }
  });

  it("C4: kode og konfig har ingen typebasert heving - E1-stien gir E1 og går til review (ikke production)", () => {
    for (const kind of ["code", "config"] as const) {
      const v = validateProposal(base({ kind }), constitution);
      expect(v.effective_class, kind).toBe("E1");
      expect(v.decision, kind).toBe("accepted_for_review");
    }
  });

  it("C5: personlighet: kun uttrykkelig «internal» holder seg E1; customer_facing, manglende og ukjent omfang gir E2 med forklaring", () => {
    const internal = validateProposal(base({ kind: "personality", personality_scope: "internal" }), constitution);
    expect(internal).toMatchObject({ effective_class: "E1", decision: "accepted_for_review" });
    for (const scope of ["customer_facing", undefined] as const) {
      const p = base({ kind: "personality" });
      if (scope === undefined) delete (p as { personality_scope?: unknown }).personality_scope; else p.personality_scope = scope;
      const v = validateProposal(p, constitution);
      expect(v.effective_class, String(scope)).toBe("E2");
      expect(v.decision, String(scope)).toBe("needs_owner");
      expect(v.reasons, String(scope)).toContain("personality_customer_facing_requires_owner");
    }
    expect(validateProposal({ ...base({ kind: "personality" }), personality_scope: "everyone" }, constitution).decision).toBe("rejected");
    // WP-EV0 fix1 (L2): omfangsregelen kan ikke omgås ved å velge en annen type - personlighetsfilen avslører selv at endringen er personlighet (declared || derived).
    for (const kind of ["code", "config", "prompt", "routing"] as const) {
      for (const scope of ["customer_facing", undefined] as const) {
        const p = base({ kind });
        if (scope === undefined) delete (p as { personality_scope?: unknown }).personality_scope; else p.personality_scope = scope;
        const v = validateProposal(p, constitution);
        expect(v.effective_class, `${kind}/${String(scope)}`).toBe("E2");
        expect(v.decision, `${kind}/${String(scope)}`).toBe("needs_owner");
        expect(v.reasons, `${kind}/${String(scope)}`).toContain("personality_customer_facing_requires_owner");
        expect(v.derived_kinds, `${kind}/${String(scope)}`).toContain("personality");
      }
      // uttrykkelig internt omfang holder seg E1 også på de andre typene
      expect(validateProposal(base({ kind, personality_scope: "internal" }), constitution).effective_class, kind).toBe("E1");
    }
    // omfanget gjelder KUN personlighetsfilen: en annen sti påvirkes ikke av `personality_scope` (E2 etter stien, samme med og uten omfang)
    for (const scope of ["customer_facing", "internal"] as const) {
      expect(validateProposal(withPaths(["apps/web/index.html"], { kind: "code", personality_scope: scope }), constitution).reasons).not.toContain("personality_customer_facing_requires_owner");
    }
  });

  it("C6: typen er PÅKREVD og lukket: manglende/ukjent/feil skrevet type avvises som E3 (invalid_proposal:kind)", () => {
    const missing = base() as unknown as Record<string, unknown>;
    delete missing["kind"];
    for (const bad of [missing, { ...base(), kind: "firmware" }, { ...base(), kind: "Prompt" }, { ...base(), kind: "" }, { ...base(), kind: null }, { ...base(), kind: ["code"] }]) {
      const v = validateProposal(bad, constitution);
      expect(v.decision).toBe("rejected");
      expect(v.effective_class).toBe("E3");
      expect(v.reasons[0]).toMatch(/^invalid_proposal:kind/);
      expect(v.kind).toBeNull();
    }
  });

  it("C7: en undervurdert type avsløres av stiene: «code» på en Dockerfile blir E2 med kind_raised_by_paths (ikke avvist - bare hevet)", () => {
    const v = validateProposal(withPaths(["apps/web/Dockerfile"], { kind: "code", claimed_class: "E1", primary_source_verified: { verified: true, source_ref: "https://example.org/a" } }), constitution);
    expect(v.derived_kinds).toEqual(["dependency"]);
    expect(v.effective_class).toBe("E2");
    expect(v.reasons).toContain("kind_raised_by_paths:code->dependency");
    expect(v.decision).toBe("needs_owner");
  });

  it("C8: en korrekt deklarert type gir ingen kind_raised_by_paths", () => {
    const v = validateProposal(withPaths(["apps/web/Dockerfile"], { kind: "dependency", claimed_class: "E2", primary_source_verified: { verified: true, source_ref: "https://example.org/a" } }), constitution);
    expect(v.reasons.some((r) => r.startsWith("kind_raised_by_paths"))).toBe(false);
    expect(v.effective_class).toBe("E2");
  });

  it("C10: avhengighet/credential/nettverk krever verifisert primærkilde (med kilde-referanse) selv med harmløse stier; andre typer krever det ikke", () => {
    for (const kind of ["dependency", "credential", "network"] as const) {
      const none = validateProposal(base({ kind, claimed_class: "E2" }), constitution);
      expect(none.reasons, kind).toContain("primary_source_not_verified");
      expect(none.decision, kind).toBe("rejected");
      expect(validateProposal(base({ kind, claimed_class: "E2", primary_source_verified: { verified: true } }), constitution).reasons, `${kind} uten ref`).toContain("primary_source_not_verified");
      expect(validateProposal(base({ kind, claimed_class: "E2", primary_source_verified: { verified: true, source_ref: "https://example.org/advisory" } }), constitution).reasons, `${kind} verifisert`).not.toContain("primary_source_not_verified");
    }
    for (const kind of ["code", "config", "prompt", "routing", "personality", "protected-adjacent"] as const) {
      expect(validateProposal(base({ kind, claimed_class: "E2" }), constitution).reasons, kind).not.toContain("primary_source_not_verified");
    }
  });

  it("C9: forslaget i endringsregisteret bærer typen (evidens), uten hemmeligheter", () => {
    const p = base({ kind: "routing" });
    const v = validateProposal(p, constitution);
    const entry = proposalToLedgerEntry(p, v, constitution.digest, "evolution");
    expect(entry.evidence["kind"]).toBe("routing");
    expect(entry.change_class).toBe(v.effective_class);
  });

  it("C11: gulvet for typer utledet fra stiene gjelder UAVHENGIG av stiklassifiseringen (forsvar i dybden: selv om klassifisereren feilaktig sier E1)", () => {
    const lenient = { classify: () => "E1" as const };
    const dep = validateProposal(withPaths(["apps/web/Dockerfile"], { kind: "code", claimed_class: "E0", primary_source_verified: { verified: true, source_ref: "https://example.org/a" } }), lenient);
    expect(dep.derived_kinds).toEqual(["dependency"]);
    expect(dep.effective_class).toBe("E2");
    expect(dep.decision).toBe("needs_owner");
    const adjacent = validateProposal(withPaths(["README.md"], { kind: "code", claimed_class: "E0" }), lenient);
    expect(adjacent.derived_kinds).toEqual(["protected-adjacent"]);
    expect(adjacent.effective_class).toBe("E2");
    const harmless = validateProposal(withPaths(["apps/web/index.html"], { kind: "code", claimed_class: "E0" }), lenient);
    expect(harmless.derived_kinds).toEqual([]);
    expect(harmless.effective_class).toBe("E1");
  });

  it("C12: en ugyldig sti (`..`) teller som berørt sensitiv flate - test_plan må ha security, i tillegg til at forslaget er E3", () => {
    const v = validateProposal(withPaths(["a/../b.ts"], { kind: "code", claimed_class: "E1", test_plan: ["unit", "integration"] }), constitution);
    expect(v.effective_class).toBe("E3");
    expect(v.reasons).toContain("test_plan_needs_security");
    const ok = validateProposal(withPaths(["a/../b.ts"], { kind: "code", claimed_class: "E1", test_plan: ["unit", "integration", "security"] }), constitution);
    expect(ok.reasons).not.toContain("test_plan_needs_security");
    const plain = validateProposal(withPaths(["apps/web/index.html"], { kind: "code", claimed_class: "E1", test_plan: ["unit", "integration"] }), constitution);
    expect(plain.reasons).not.toContain("test_plan_needs_security");
  });
});

describe("D: utrullingsporten (decideRelease) deler samme gulv - og er uendret for de fem gamle typene", () => {
  const ok = { incident_open: false, observability_ok: true, slo_breaches: 0, kill_switch_active: false };
  const rel = (over: Partial<ReleaseRequest> = {}): ReleaseRequest => ({
    change_class: "E1", kind: "personality", stage: "shadow", owner_approved: false, last_known_good_stored: true, signals: ok,
    usage: { deploys_today: 0, deploys_this_hour: 0, auto_merges_today: 0 }, budget: { max_deploys_per_day: 3, max_deploys_per_hour: 1, max_auto_merges_per_day: 5 },
    evals_passed: true, independent_review: true, ...over
  });

  /** Den GAMLE logikken (main før WP-EV0), skrevet på nytt som referanse for differensialtesten. */
  const legacyReasons = (r: ReleaseRequest): string[] => {
    const reasons: string[] = [];
    if (r.change_class === "E3") reasons.push("e3_forbidden");
    const freeze = changeFreeze(r.signals);
    if (freeze.frozen) reasons.push(...freeze.reasons.map((x) => `freeze:${x}`));
    if (r.usage.deploys_today >= r.budget.max_deploys_per_day) reasons.push("deploy_budget_exhausted");
    if (r.change_class === "E1" && r.usage.auto_merges_today >= r.budget.max_auto_merges_per_day) reasons.push("auto_merge_budget_exhausted");
    if (!r.evals_passed) reasons.push("evals_not_passed");
    if (r.change_class !== "E0" && !r.independent_review) reasons.push("independent_review_missing");
    if (classRank(r.change_class) >= classRank("E2") && !r.owner_approved) reasons.push("owner_approval_missing");
    if (!r.last_known_good_stored) reasons.push("last_known_good_missing");
    if (r.kind !== "code" && r.kind !== "config" && r.change_class === "E0") reasons.push("kind_requires_at_least_e1");
    return reasons;
  };

  it("D1: differensial - for de 5 gamle typene er årsakslisten byte-lik forrige logikk i hele kombinasjonsrommet (timebudsjettet ikke bindende)", () => {
    let n = 0;
    const signalSets = [ok, { ...ok, incident_open: true }, { ...ok, kill_switch_active: null }, { ...ok, observability_ok: false, slo_breaches: 2 }];
    const usages = [
      { deploys_today: 0, deploys_this_hour: 0, auto_merges_today: 0 }, { deploys_today: 3, deploys_this_hour: 0, auto_merges_today: 0 },
      { deploys_today: 0, deploys_this_hour: 0, auto_merges_today: 5 }, { deploys_today: 9, deploys_this_hour: 0, auto_merges_today: 9 }
    ];
    for (const kind of ["code", "prompt", "personality", "routing", "config"] as const) {
      for (const change_class of CLASSES) {
        for (const stage of ["shadow", "staging", "canary", "full"] as ReleaseStage[]) {
          for (const owner_approved of [false, true]) for (const lkg of [false, true]) for (const evals of [false, true]) for (const review of [false, true]) {
            for (const signals of signalSets) for (const usage of usages) {
              const r = rel({ kind, change_class, stage, owner_approved, last_known_good_stored: lkg, evals_passed: evals, independent_review: review, signals, usage });
              const v = decideRelease(r);
              expect(v.reasons, JSON.stringify({ kind, change_class, stage })).toEqual(legacyReasons(r));
              n++;
            }
          }
        }
      }
    }
    expect(n).toBe(5 * 4 * 4 * 2 * 2 * 2 * 2 * 4 * 4);
  });

  it("D2: de nye typene krever minst E2: E0/E1 gir kind_requires_at_least_e2, E2 med eier-godkjenning slipper gjennom", () => {
    for (const kind of ["schema", "dependency", "credential", "network", "protected-adjacent"] as const) {
      for (const change_class of ["E0", "E1"] as const) {
        expect(decideRelease(rel({ kind, change_class })).reasons, `${kind}/${change_class}`).toContain("kind_requires_at_least_e2");
      }
      expect(decideRelease(rel({ kind, change_class: "E2", owner_approved: true })).allowed, kind).toBe(true);
      expect(decideRelease(rel({ kind, change_class: "E2" })).reasons, kind).not.toContain("kind_requires_at_least_e2");
    }
  });

  it("D3: ukjent type i utrullingsporten blokkerer alltid (fail-closed)", () => {
    for (const change_class of CLASSES) {
      const v = decideRelease(rel({ kind: "firmware" as ChangeKind, change_class, owner_approved: true }));
      expect(v.allowed, change_class).toBe(false);
      expect(v.reasons.some((x) => x.startsWith("kind_requires_at_least_")) || change_class === "E3", change_class).toBe(true);
    }
  });

  it("D4: deploys pr TIME: nådd/over grensen stopper; under slipper; ugyldige tall (NaN, negativ, manglende, uendelig) stopper (fail-closed)", () => {
    expect(decideRelease(rel({ usage: { deploys_today: 0, deploys_this_hour: 0, auto_merges_today: 0 } })).allowed).toBe(true);
    expect(decideRelease(rel({ usage: { deploys_today: 0, deploys_this_hour: 1, auto_merges_today: 0 } })).reasons).toEqual(["deploy_hour_budget_exhausted"]);
    expect(decideRelease(rel({ usage: { deploys_today: 0, deploys_this_hour: 5, auto_merges_today: 0 } })).reasons).toContain("deploy_hour_budget_exhausted");
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      expect(decideRelease(rel({ usage: { deploys_today: 0, deploys_this_hour: bad, auto_merges_today: 0 } })).reasons, String(bad)).toContain("deploy_hour_budget_exhausted");
      expect(decideRelease(rel({ usage: { deploys_today: bad, deploys_this_hour: 0, auto_merges_today: 0 } })).reasons, String(bad)).toContain("deploy_budget_exhausted");
      expect(decideRelease(rel({ change_class: "E1", usage: { deploys_today: 0, deploys_this_hour: 0, auto_merges_today: bad } })).reasons, String(bad)).toContain("auto_merge_budget_exhausted");
    }
    expect(decideRelease(rel({ budget: { max_deploys_per_day: 3, max_deploys_per_hour: 0, max_auto_merges_per_day: 5 } })).reasons).toContain("deploy_hour_budget_exhausted");
    expect(decideRelease(rel({ budget: { max_deploys_per_day: 3, max_deploys_per_hour: Number.NaN, max_auto_merges_per_day: 5 } })).reasons).toContain("deploy_hour_budget_exhausted");
  });
});
