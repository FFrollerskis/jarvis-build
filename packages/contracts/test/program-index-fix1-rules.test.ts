import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectRepoFacts, loadProgramData, makeFileReader, parseComposeServiceNames, ProgramDataError } from "../src/program/fs-loader.ts";
import { MANIFEST_MINIMUMS, manifestWeakenings } from "../src/program/frozen-rules.ts";
import { scanGates, type Gate, type GateContext } from "../src/program/gates.ts";
import { GUARD_MODE_ENV, parseModeValue, resolveGuardMode } from "../src/program/mode.ts";
import { runProgramIndex } from "../src/program/run.ts";
import { scanProgramIndex } from "../src/program/scan.ts";
import { ComponentShardSchema, ManifestSchema, type Manifest } from "../src/program/schema.ts";
import { cleanWorld, cloneWorld, planned, shard, T0, toScanInput, type World } from "./program-index-fixtures.ts";
import { main } from "../scripts/program-index.ts";
import { miniRepo, put, tmp } from "./program-index-minirepo.ts";

/**
 * WP-PGA fiks 1: M5 (vaktreglene festet: flertallsmønstre, frosne minimumsregler, ACTIVE krever en beslutning i loggen), L4 (skannerhull), L5 (gate-bundet komponent må ha contract.files) og testhullene
 * M03, M11, M15, M17, M30 og M56 fra mutantsettet. Mot den VIRKELIGE manifestfilen der det gjelder (reviewerens prober `N:*` og data-mutantene D1-D5, D7).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const realManifest = (): Manifest => ManifestSchema.parse(JSON.parse(readFileSync(resolve(ROOT, "config/program/manifest.json"), "utf8")));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ids = (w: World): string[] => scanProgramIndex(toScanInput(w)).map((f) => f.id);
const comp = (w: World, id: string) => w.components.find((c) => c.component_id === id)!;
const edit = (fn: (w: World) => void, real = false): World => {
  const w = cloneWorld(cleanWorld());
  if (real) w.manifest = realManifest();
  fn(w);
  return w;
};
const addTable = (w: World, name: string, owner: string | null, body = "tenant_id text"): void => {
  w.repo.tables.set(name, { name, created_in: "002_b.sql", columns: ["tenant_id"], definition_text: body });
  w.repo.created.push({ name, file: "002_b.sql" });
  if (owner !== null) comp(w, owner).state_store.tables.push(name);
};

describe("M5: navnereglene i den virkelige manifestfilen tåler flertall (reviewerens N:*-prober)", () => {
  const violation = (name: string, owner = "core.beta"): string[] => ids(edit((w) => addTable(w, name, owner), true)).filter((i) => i.startsWith("exclusive_name_violation:"));

  it("konkurrerende skill-/capability-registre i ALLE former flagges: entall, flertall, registries, register og midt i et navn", () => {
    for (const n of ["skill_registry", "capability_registry", "skills_registry", "capabilities_registry", "skill_registries", "capability_register", "capabilities_registries", "agent_skill_registry_v2", "x_skills_registry_y", "x_capabilities_register"]) {
      expect(violation(n), n).toEqual([`exclusive_name_violation:single-capability-registry:${n}`]);
    }
  });

  it("men ikke navn som bare ligner: skillregistry (uten understrek), skill_catalog, capabilities, skills_registered", () => {
    for (const n of ["skillregistry", "skill_catalog", "capabilities", "skills_registered", "capabilityregistry"]) expect(violation(n), n).toEqual([]);
  });

  it("JX-sannhetskildene flagges i entall og flertall, som hel tabell og som prefiks: commitment(s), impact(s), knowledge_gap(s), workspace(s)", () => {
    for (const n of ["commitment", "commitments_log", "commitment_items", "impact", "impacts", "impact_events", "knowledge_gap", "knowledge_gaps", "knowledge_gap_items", "workspace", "workspaces", "workspace_x"]) {
      expect(violation(n, "ci.gamma"), n).toEqual([`exclusive_name_violation:jx-truth-stores:${n}`]);
    }
  });

  it("men ikke navn som bare inneholder ordet: impactful_x, my_workspaces, comms_meeting_commitments, finance_recurring_commitments (de to siste eksisterer i dag)", () => {
    for (const n of ["impactful_x", "my_workspaces", "workspace_", "comms_meeting_commitments", "finance_recurring_commitments", "knowledge_gapped"]) {
      const v = violation(n, "ci.gamma");
      expect(v, n).toEqual(n === "workspace_" ? [`exclusive_name_violation:jx-truth-stores:${n}`] : []);
    }
  });

  it("det ene eksisterende unntaket: `commitments` eid av core.memory går; samme tabell hos en annen eier, eller et nytt navn med samme form, flagges", () => {
    const w = edit((x) => {
      x.components.push(shard("core.memory", { code_paths: ["modules/memory"], contract: { schema_version: "0.1.0" }, state_store: { migrations: ["001_a.sql"] } }));
      x.repo.workspace_dirs.push("modules/memory");
      addTable(x, "commitments", "core.memory");
    }, true);
    expect(ids(w).filter((i) => i.startsWith("exclusive_name_violation"))).toEqual([]);
    expect(violation("commitments", "core.beta")).toEqual(["exclusive_name_violation:jx-truth-stores:commitments"]);
    const v2 = edit((x) => {
      x.components.push(shard("core.memory", { code_paths: ["modules/memory"], contract: { schema_version: "0.1.0" } }));
      x.repo.workspace_dirs.push("modules/memory");
      addTable(x, "commitments_v2", "core.memory");
    }, true);
    expect(ids(v2).filter((i) => i.startsWith("exclusive_name_violation:"))).toEqual(["exclusive_name_violation:jx-truth-stores:commitments_v2"]);
  });

  it("reglenes `reason` påstår ikke lenger at kolonner sjekkes (D-PROG-09 -> PGA-D-09: kun tabellnavn)", () => {
    for (const r of realManifest().exclusive_names) {
      expect(r.reason).not.toMatch(/eller kolonner/);
      expect(r.reason).toMatch(/kolonnenavn sjekkes ikke/);
    }
  });
});

describe("M5: de frosne minimumsreglene (reviewerens data-mutanter D1-D5)", () => {
  const mutate = (fn: (m: Manifest) => void): string[] => {
    const m = realManifest();
    fn(m);
    return manifestWeakenings(m);
  };

  it("den virkelige manifestfilen oppfyller minimumsreglene", () => {
    expect(manifestWeakenings(realManifest())).toEqual([]);
  });

  it("D1/D2: eksklusive navn som er slått av (mønsteret byttet ut), fjernet eller gjort mer tillatende, eller med et ekstra unntak", () => {
    expect(mutate((m) => (m.exclusive_names[1]!.pattern = "^zz_never_matches$"))).toEqual([expect.stringContaining("jx-truth-stores")]);
    expect(mutate((m) => (m.exclusive_names[0]!.pattern = "^zz_never_matches$"))).toEqual([expect.stringContaining("single-capability-registry")]);
    expect(mutate((m) => m.exclusive_names.splice(0, 1))).toEqual([expect.stringContaining("single-capability-registry")]);
    expect(mutate((m) => (m.exclusive_names = []))).toHaveLength(2);
    expect(mutate((m) => m.exclusive_names[0]!.allowed_owner_patterns.push(".*"))).toEqual([expect.stringContaining("tillatte eiere")]);
    expect(mutate((m) => (m.exclusive_names[1]!.allowed_owner_patterns = ["^jx\\.", "^core\\."]))).toEqual([expect.stringContaining("tillatte eiere")]);
    expect(mutate((m) => (m.exclusive_names[1]!.exceptions = [...(m.exclusive_names[1]!.exceptions ?? []), { table: "workspaces", owner: "ci.gamma", reason: "et nytt unntak uten beslutning" }]))).toEqual([expect.stringContaining("unntak")]);
    expect(mutate((m) => (m.exclusive_names[0]!.exceptions = [{ table: "skill_registry", owner: "core.alpha", reason: "et unntak i feil regel" }]))).toEqual([expect.stringContaining("unntak")]);
  });

  it("D3: et reservert prefiks som er slått av (prefikset byttet), fjernet eller gitt tillatende eiere", () => {
    expect(mutate((m) => (m.reserved_prefixes[0]!.prefix = "zz_never_"))).toEqual([expect.stringContaining("ci_")]);
    expect(mutate((m) => m.reserved_prefixes.splice(0, 1))).toEqual([expect.stringContaining("ci_")]);
    expect(mutate((m) => (m.reserved_prefixes[1]!.owner_patterns = [".*"]))).toEqual([expect.stringContaining("program_")]);
    expect(mutate((m) => (m.reserved_prefixes = []))).toHaveLength(MANIFEST_MINIMUMS.reserved_prefixes.length);
  });

  it("D4: ACTIVE-regelen i læringstabeller slått av (literal, kolonnemønster, prefiks)", () => {
    expect(mutate((m) => (m.no_active_state.forbidden_literal_pattern = "zzzneverzzz"))).toEqual([expect.stringContaining("no_active_state")]);
    expect(mutate((m) => (m.no_active_state.forbidden_column_pattern = "^zzz$"))).toEqual([expect.stringContaining("no_active_state")]);
    expect(mutate((m) => (m.no_active_state.table_prefix = "zz_"))).toEqual([expect.stringContaining("no_active_state")]);
  });

  it("D5/D6: dekningsrotene krympet (contract_roots tømt, modules fjernet fra workspace_roots) eller kilde-stiene byttet", () => {
    expect(mutate((m) => (m.coverage.contract_roots = []))).toEqual([expect.stringContaining("contract_roots")]);
    expect(mutate((m) => (m.coverage.workspace_roots = ["apps", "packages"]))).toEqual([expect.stringContaining("workspace_roots")]);
    expect(mutate((m) => (m.coverage.migrations_dir = "db"))).toEqual([expect.stringContaining("migrations_dir")]);
    expect(mutate((m) => (m.coverage.compose_file = "compose.yml"))).toEqual([expect.stringContaining("compose_file")]);
  });

  it("å STRAMME inn er tillatt: ekstra regel, ekstra prefiks, ekstra dekningsrot, ekstra tillatt-fritt felt endres ikke", () => {
    expect(mutate((m) => m.exclusive_names.push({ id: "ny-regel", pattern: "^ny_", allowed_owner_patterns: ["^ny\\."], reason: "En ekstra, strengere regel." }))).toEqual([]);
    expect(mutate((m) => m.reserved_prefixes.push({ prefix: "ny_", owner_patterns: ["^ny\\."], reason: "Et ekstra reservert prefiks." }))).toEqual([]);
    expect(mutate((m) => m.coverage.workspace_roots.push("tools"))).toEqual([]);
    expect(mutate((m) => m.coverage.contract_roots.push("packages/other/src"))).toEqual([]);
    expect(mutate((m) => (m.exclusive_names[0]!.reason = "En annen forklaring som fortsatt er lang nok."))).toEqual([]);
  });

  it("minimumsreglene er dypt frosne (en importerende modul kan ikke svekke dem)", () => {
    expect(Object.isFrozen(MANIFEST_MINIMUMS)).toBe(true);
    expect(Object.isFrozen(MANIFEST_MINIMUMS.exclusive_names)).toBe(true);
    expect(Object.isFrozen(MANIFEST_MINIMUMS.exclusive_names[0])).toBe(true);
    expect(Object.isFrozen(MANIFEST_MINIMUMS.exclusive_names[1]!.exceptions)).toBe(true);
    expect(Object.isFrozen(MANIFEST_MINIMUMS.reserved_prefixes)).toBe(true);
    expect(Object.isFrozen(MANIFEST_MINIMUMS.no_active_state)).toBe(true);
    expect(Object.isFrozen(MANIFEST_MINIMUMS.workspace_roots)).toBe(true);
    expect(MANIFEST_MINIMUMS.reserved_prefixes).toHaveLength(7);
    expect(MANIFEST_MINIMUMS.exclusive_names.map((r) => r.id)).toEqual(["single-capability-registry", "jx-truth-stores"]);
  });
});

describe("M5 (D7): ACTIVE krever en beslutning i loggen (D-nnn), ikke et vilkårlig dokument", () => {
  const plan = (status: string, decision_ref: string | null) => ({ plan: "HF6", domain: "continuous-intelligence", version: "v1.2", status, decision_ref });
  const parse = (p: unknown): boolean => ManifestSchema.safeParse({ ...clone(realManifest()), plans: [p] }).success;

  it("ACTIVE med en D-nnn er gyldig; med et dokument, en plan-intern id eller uten beslutning er den ugyldig", () => {
    expect(parse(plan("ACTIVE", "D-500"))).toBe(true);
    expect(parse(plan("ACTIVE", "docs/remediation/ADR-001-dokumenthierarki.md"))).toBe(false);
    expect(parse(plan("ACTIVE", "D-PROG-07"))).toBe(false);
    expect(parse(plan("ACTIVE", "D-12345"))).toBe(false);
    expect(parse(plan("ACTIVE", null))).toBe(false);
  });

  it("andre statuser kan fortsatt peke på et dokument eller ingenting (kun ACTIVE styrer)", () => {
    for (const status of ["ACKNOWLEDGED_NOT_ADOPTED", "NOT_ADOPTED", "SUPERSEDED"]) {
      expect(parse(plan(status, "docs/remediation/ADR-001-dokumenthierarki.md")), status).toBe(true);
      expect(parse(plan(status, null)), status).toBe(true);
    }
  });

  it("skanningen: en ACTIVE-plan med en D-nnn som ikke står i loggen gir decision_ref_missing", () => {
    const w = edit((x) => {
      x.manifest.plans = [{ plan: "HF1", domain: "autonomy", version: "v4.0", status: "ACTIVE", decision_ref: "D-998" }, { plan: "HF6", domain: "continuous-intelligence", version: "v1.2", status: "NOT_ADOPTED", decision_ref: null }];
      x.repo.decision_exists = (id) => id !== "D-998";
    });
    expect(ids(w)).toEqual(["decision_ref_missing:manifest:HF1:D-998"]);
  });

  it("det virkelige repoet: hver ACTIVE-plan i manifestet har en D-nnn som finnes som rad i beslutningsloggen (i dag ingen)", () => {
    const reader = makeFileReader(ROOT);
    const active = realManifest().plans.filter((p) => p.status === "ACTIVE");
    for (const p of active) {
      expect(p.decision_ref, p.plan).toMatch(/^D-\d{1,4}$/);
      expect(reader.decision_exists(p.decision_ref as string), p.plan).toBe(true);
    }
  });
});

describe("L4: skannerhull som er trivielle å lukke", () => {
  it("S04: hendelsesvarianter (store/små bokstaver, understrek, punktum) av samme navn = event_name_variant, også innen én komponent", () => {
    const ev = (type: string) => ({ type, schema_version: "1.0.0", status: "active" as const, idempotency: null, contract_ref: "modules/beta/src/e.ts" });
    expect(ids(edit((w) => comp(w, "core.beta").events_out.push(ev("evta"))))).toEqual(["event_name_variant:evta"]);
    expect(ids(edit((w) => comp(w, "core.beta").events_out.push(ev("evt_a"))))).toEqual(["event_name_variant:evta"]);
    expect(ids(edit((w) => comp(w, "core.beta").events_out.push(ev("Evt.A"))))).toEqual(["event_name_variant:evta"]);
    expect(ids(edit((w) => comp(w, "core.alpha").events_out.push(ev("EVT_A"))))).toEqual(["event_name_variant:evta"]);
    const f = scanProgramIndex(toScanInput(edit((w) => comp(w, "core.beta").events_out.push(ev("evt_a")))));
    expect(f[0]?.message).toContain("EvtA");
    expect(f[0]?.message).toContain("evt_a");
  });

  it("samme navn fra to komponenter er fortsatt event_multi_owner (ikke variant), og ulike navn er ok", () => {
    const ev = (type: string) => ({ type, schema_version: "1.0.0", status: "active" as const, idempotency: null, contract_ref: "modules/beta/src/e.ts" });
    expect(ids(edit((w) => comp(w, "core.beta").events_out.push(ev("EvtA"))))).toEqual(["event_multi_owner:EvtA"]);
    expect(ids(edit((w) => comp(w, "core.beta").events_out.push(ev("EvtB"))))).toEqual([]);
  });

  it("S05: en planlagt tabell hos A og en runtime-tabell med samme navn hos B = runtime_table_conflict", () => {
    const w = edit((x) => {
      comp(x, "ci.gamma").state_store.planned_tables.push("shared_t");
      comp(x, "core.beta").state_store.runtime_tables.push("shared_t");
    });
    expect(ids(w)).toEqual(["runtime_table_conflict:shared_t"]);
  });

  it("S06: en planlagt komponent kan bare ha planlagte hendelser (ingen kode ennå), så en `active`-hendelse med en ikke-eksisterende kontrakt kan ikke gjemme seg", () => {
    const ev = (status: "planned" | "contract_only" | "active") => ({ type: "GhostEvent", schema_version: status === "planned" ? null : "1.0.0", status, idempotency: null, contract_ref: status === "planned" ? null : "no/such/file.ts" });
    for (const status of ["contract_only", "active"] as const) {
      const r = ComponentShardSchema.safeParse(planned("ci.ghost", { events_out: [ev(status)] }));
      expect(r.success, status).toBe(false);
      expect(r.success ? [] : r.error.issues.map((i) => i.message)).toContain("en planlagt komponent har kun planlagte hendelser (ingen kode ennå)");
    }
    expect(ComponentShardSchema.safeParse(planned("ci.ghost", { events_out: [ev("planned")] })).success).toBe(true);
    expect(ComponentShardSchema.safeParse(shard("core.real", { events_out: [ev("active")] })).success).toBe(true);
  });

  it("S07: en kodesti som er selve arbeidsområderoten (apps, modules, packages) eller prosjektroten dekker alt og slår av dir_uncovered = code_path_too_broad", () => {
    for (const broad of ["modules", "apps", "packages", "modules/", "packages//", ".", "./"]) {
      const w = edit((x) => {
        x.components.push(shard("core.catchall", { code_paths: [broad] }));
        x.repo.workspace_dirs.push("modules/brandnew");
      });
      expect(ids(w), broad).toContain("code_path_too_broad:core.catchall:" + broad);
    }
    expect(ids(edit((x) => x.components.push(shard("core.catchall", { code_paths: ["modules/alpha/src"] }))))).toEqual([]);
    expect(ids(edit((x) => x.components.push(shard("core.catchall", { code_paths: ["infra/local"] }))))).toEqual([]);
  });

  it("S08b: samme kontraktfil eller samme autoritative fil hos to komponenter = file_multi_owner", () => {
    const w = edit((x) => {
      comp(x, "core.beta").contract.files = ["packages/contracts/src/a.ts"];
      comp(x, "core.beta").contract.fingerprint = comp(x, "core.alpha").contract.fingerprint;
    });
    expect(ids(w)).toEqual(["file_multi_owner:contract:packages/contracts/src/a.ts"]);
    const s = edit((x) => {
      comp(x, "core.alpha").state_store.files = ["config/x.json"];
      comp(x, "core.beta").state_store.files = ["config/x.json"];
    });
    expect(ids(s)).toEqual(["file_multi_owner:state:config/x.json"]);
    expect(ids(edit((x) => { comp(x, "core.alpha").state_store.files = ["config/x.json"]; comp(x, "core.beta").state_store.files = ["config/y.json"]; }))).toEqual([]);
  });

  it("S19: avhengighetssykler (to, tre) = dependency_cycle, ett funn per syklus; en rett avhengighetskjede er ok", () => {
    const dep = (id: string) => ({ component_id: id, min: "0.1.0", max: "0.x" });
    expect(ids(edit((x) => comp(x, "core.beta").dependencies.push(dep("core.alpha"))))).toEqual(["dependency_cycle:core.alpha:core.beta"]);
    const three = edit((x) => {
      x.components.push(shard("core.gamma3", { code_paths: ["modules/gamma3"], dependencies: [dep("core.alpha")] }));
      x.repo.workspace_dirs.push("modules/gamma3");
      comp(x, "core.beta").dependencies.push(dep("core.gamma3"));
    });
    expect(ids(three)).toEqual(["dependency_cycle:core.alpha:core.beta:core.gamma3"]);
    const chain = edit((x) => {
      x.components.push(shard("core.leaf", { code_paths: ["modules/leaf"], dependencies: [dep("core.beta")] }));
      x.repo.workspace_dirs.push("modules/leaf");
    });
    expect(ids(chain)).toEqual([]);
    const f = scanProgramIndex(toScanInput(edit((x) => comp(x, "core.beta").dependencies.push(dep("core.alpha")))));
    expect(f[0]?.message).toContain("core.alpha");
    expect(f[0]?.message).toContain("core.beta");
  });

  it("to uavhengige sykler gir to funn; en komponent utenfor syklene påvirkes ikke", () => {
    const dep = (id: string) => ({ component_id: id, min: "0.1.0", max: "0.x" });
    const w = edit((x) => {
      x.components.push(shard("core.p1", { code_paths: ["modules/p1"], dependencies: [dep("core.p2")] }), shard("core.p2", { code_paths: ["modules/p2"], dependencies: [dep("core.p1")] }));
      x.repo.workspace_dirs.push("modules/p1", "modules/p2");
      comp(x, "core.beta").dependencies.push(dep("core.alpha"));
    });
    expect(ids(w)).toEqual(["dependency_cycle:core.alpha:core.beta", "dependency_cycle:core.p1:core.p2"]);
  });

  it("contract_roots: .ts, .mts, .cts og .tsx rett under rota leses, men ikke .d.ts, .d.mts, .d.cts, undermapper eller andre filtyper (undermapper er DEFERRED: se runbooken)", () => {
    const { root } = miniRepo();
    for (const f of ["a2.ts", "b.mts", "c.cts", "d.tsx"]) put(root, `contracts/${f}`, "export {};\n");
    for (const f of ["x.d.ts", "x.d.mts", "x.d.cts", "readme.md", "y.js", "z.json"]) put(root, `contracts/${f}`, "x\n");
    put(root, "contracts/sub/nested.ts", "export {};\n");
    expect(collectRepoFacts(root, loadProgramData(root).manifest).contract_files).toEqual(["contracts/a.ts", "contracts/a2.ts", "contracts/b.mts", "contracts/c.cts", "contracts/d.tsx"]);
  });
});

describe("L5: en port bundet til en BYGD komponent uten contract.files er et funn (staleness er blind for den)", () => {
  const gate = (id: string, bound: string[]): Gate => ({ schema_version: "1.0.0", kind: "program_gate", id, number: Number(id.slice(1)), title: `Port ${id}`, pass_criterion: "Kriterium i egne ord for testen.", bound_components: bound, external: false, status: "OPEN", evidence_ref: null, history: [] });
  const ctx: GateContext = { component: () => ({ contract_fingerprint: null, changed_at: null }), evidence_sha256: () => null, evidence_facts: () => null };
  const scan = (bound: string[], untracked: string[] | undefined) =>
    scanGates({ gates: [gate("G01", bound)], orls: [], component_ids: new Set(["core.a", "core.b", "ci.p"]), ctx, ...(untracked === undefined ? {} : { untracked_components: new Set(untracked) }) })
      .filter((f) => f.rule !== "gate_set_incomplete")
      .map((f) => f.id);

  it("bundet til en sporet komponent, en planlagt komponent eller uten oppgitt liste: ingen funn; bundet til en usporet bygd komponent: funn per (port, komponent)", () => {
    expect(scan(["core.a"], ["core.b"])).toEqual([]);
    expect(scan(["ci.p"], ["core.b"])).toEqual([]);
    expect(scan(["core.b"], undefined)).toEqual([]);
    expect(scan(["core.a", "core.b"], ["core.b"])).toEqual(["gate_bound_untracked_component:G01:core.b"]);
    expect(scan(["core.a", "core.b"], ["core.a", "core.b"])).toEqual(["gate_bound_untracked_component:G01:core.a", "gate_bound_untracked_component:G01:core.b"]);
  });

  it("en ukjent komponent gir bare gate_unknown_component (ikke også usporet)", () => {
    expect(scan(["core.nope"], ["core.nope"])).toEqual(["gate_unknown_component:G01:core.nope"]);
  });

  it("gjennom orkestratoren: porten er bundet til en bygd komponent uten kontraktfiler (miniRepo: core.beta)", () => {
    const { root } = miniRepo();
    const g = JSON.parse(readFileSync(join(root, "config/program/gates/G01.json"), "utf8")) as Record<string, unknown>;
    put(root, "config/program/gates/G01.json", `${JSON.stringify({ ...g, bound_components: ["core.alpha", "core.beta"] }, null, 2)}\n`);
    expect(runProgramIndex({ root, env: undefined, origin: [] }).findings.map((f) => f.id)).toEqual(["gate_bound_untracked_component:G01:core.beta"]);
  });

  it("det virkelige repoet: hver bygde komponent som en port eller et ORL-nivå er bundet til har contract.files (de fem gate-bundne uten er fylt inn)", () => {
    const data = loadProgramData(ROOT);
    const byId = new Map(data.components.map((c) => [c.component_id, c]));
    const bound = new Set([...data.gates, ...data.orls].flatMap((g) => g.bound_components));
    const blind = [...bound].filter((id) => byId.get(id)?.runtime_state !== "planned" && (byId.get(id)?.contract.files.length ?? 0) === 0);
    expect(blind).toEqual([]);
    for (const id of ["core.identity", "core.ledgers", "ev.evolution-gates", "ev.eval-lab", "ev.self-model"]) {
      expect(byId.get(id)?.contract.files.length, id).toBeGreaterThan(0);
      expect(byId.get(id)?.contract.fingerprint, id).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});

describe("L8: testhull fra mutantsettet (produksjonskoden var riktig; ingen test festet den)", () => {
  it("M03: en tabell med flere eiere har ingen entydig eier: et eksklusivt navn slipper ikke unna fordi den FØRSTE eieren er tillatt", () => {
    const w = edit((x) => {
      // jx.real står FØRST i komponentlisten, så en mutant som velger «første eier» ville valgt den tillatte.
      x.components.unshift(shard("jx.real", { code_paths: ["modules/jxreal"], contract: { schema_version: "0.1.0" } }));
      x.repo.workspace_dirs.push("modules/jxreal");
      addTable(x, "commitment_log", "jx.real");
      comp(x, "core.beta").state_store.tables.push("commitment_log");
    });
    expect(ids(w)).toEqual(["exclusive_name_violation:jx-truth-stores:commitment_log", "table_multi_owner:commitment_log"]);
  });

  it("M03b: en tabell med flere eiere kvitteres ikke av noen av dem (ingen entydig eier)", () => {
    const w = edit((x) => {
      x.repo.migration_files.push("003_c.sql");
      comp(x, "core.beta").state_store.tables.push("t_a");
      x.repo.alters.push({ table: "t_a", file: "003_c.sql" });
      comp(x, "core.alpha").state_store.migrations.push("003_c.sql");
    });
    expect(ids(w)).toEqual(["table_multi_owner:t_a"]);
  });

  it("M11: en kodesti dekker bare underkataloger, ikke søsken med samme prefiks (modules/alpha dekker ikke modules/alphabet)", () => {
    expect(ids(edit((w) => w.repo.workspace_dirs.push("modules/alphabet")))).toEqual(["dir_uncovered:modules/alphabet"]);
    expect(ids(edit((w) => w.repo.workspace_dirs.push("modules/alpha/sub", "modules/alpha-x")))).toEqual(["dir_uncovered:modules/alpha-x"]);
  });

  it("M15: en komponent som selv eier pakkekatalogen den avhenger av trenger ingen avhengighet til seg selv", () => {
    const w = edit((x) => {
      comp(x, "core.alpha").code_paths = ["modules/alpha", "modules/beta"];
      comp(x, "core.alpha").dependencies = [];
      comp(x, "core.beta").code_paths = ["modules/elsewhere"];
    });
    expect(ids(w)).toEqual([]);
  });

  it("M17: planned_table_exists også når tabellen finnes i migrasjonene uten eier, og når en annen komponent krever den som eksisterende (hver for seg)", () => {
    const orphan = edit((w) => {
      addTable(w, "t_orphan", null);
      comp(w, "ci.gamma").state_store.planned_tables.push("t_orphan");
    });
    expect(ids(orphan)).toEqual(["planned_table_exists:ci.gamma:t_orphan", "table_orphan:t_orphan"]);
    const claimedOnly = edit((w) => {
      comp(w, "core.beta").state_store.tables.push("t_claimed");
      comp(w, "ci.gamma").state_store.planned_tables.push("t_claimed");
    });
    expect(ids(claimedOnly)).toEqual(["planned_table_exists:ci.gamma:t_claimed", "table_unknown:core.beta:t_claimed"]);
  });

  it("M30: en blank eller bare-mellomrom-verdi i miljøet er ugyldig (kaster), mens tom streng og undefined er «ikke satt»", () => {
    expect(parseModeValue("", GUARD_MODE_ENV)).toBeNull();
    expect(parseModeValue(undefined, GUARD_MODE_ENV)).toBeNull();
    for (const blank of [" ", "  ", "\t", "\n", " \t "]) {
      expect(() => parseModeValue(blank, GUARD_MODE_ENV), JSON.stringify(blank)).toThrow();
      expect(() => resolveGuardMode("report", blank), JSON.stringify(blank)).toThrow();
    }
  });

  it("M56: decision_exists er forankret: D-4 finnes ikke fordi D-41 gjør det, og en omtale i løpende tekst er ikke en rad", () => {
    const root = tmp();
    put(root, "docs/DECISIONS_AND_ASSUMPTIONS.md", "| D-41 | beslutning |\n| D-4x | ikke et tall |\nsee also | D-7 | i løpende tekst, men ikke i begynnelsen av linjen\n| D-9 | beslutning |\n");
    const r = makeFileReader(root);
    expect(r.decision_exists("D-41")).toBe(true);
    expect(r.decision_exists("D-9")).toBe(true);
    expect(r.decision_exists("D-4")).toBe(false);
    expect(r.decision_exists("D-1")).toBe(false);
    expect(r.decision_exists("D-7")).toBe(false);
    expect(r.decision_exists("D-")).toBe(false);
  });
});

void T0;

describe("L3: compose-parseren leser tjenestene uansett innrykk, siterte navn og flow-stil, og FEILER høylytt i stedet for å gi «ingen tjenester»", () => {
  const names = (text: string): string[] => parseComposeServiceNames(text);
  const fails = (text: string, part: string): void => {
    let caught: unknown;
    try {
      parseComposeServiceNames(text);
    } catch (e) {
      caught = e;
    }
    expect(caught, text).toBeInstanceOf(ProgramDataError);
    expect((caught as ProgramDataError).code).toBe("compose_invalid");
    expect((caught as ProgramDataError).detail).toContain(part);
  };

  it("2-, 3- og 4-mellomroms innrykk gir de samme tjenestene (før: 4 mellomrom ga ingen)", () => {
    expect(names("services:\n  a:\n    image: x\n  b:\n    image: y\n")).toEqual(["a", "b"]);
    expect(names("services:\n    a:\n        image: x\n    b:\n        image: y\n")).toEqual(["a", "b"]);
    expect(names("services:\n   a:\n      image: x\n   b:\n      image: y\n")).toEqual(["a", "b"]);
  });

  it("siterte tjenestenavn (dobbel og enkel apostrof) og navn med punktum, bindestrek og understrek", () => {
    expect(names('services:\n  "a":\n    image: x\n  \'b\':\n    image: y\n  c.d-e_f:\n    image: z\n')).toEqual(["a", "b", "c.d-e_f"]);
  });

  it("flow-stil på tjenestens kropp, anker/merge og etterstilte kommentarer", () => {
    expect(names("services:\n  a: { image: x }\n  b:\n    image: y\n  c: *base # kommentar\n  d: # note\n    <<: *base\n")).toEqual(["a", "b", "c", "d"]);
  });

  it("kommentarer og blanke linjer midt i blokken, andre toppnøkler før og etter, CRLF, dokumentstart og `services:` med etterkommentar", () => {
    expect(names("---\nx-common: &common\n  restart: always\nservices: # tjenestene\n\n  # først\n  a:\n    image: x\n\n  b:\n    image: y\nvolumes:\n  data: {}\n")).toEqual(["a", "b"]);
    expect(names("services:\r\n  a:\r\n    image: x\r\n")).toEqual(["a"]);
  });

  it("ingen `services:` (eller en tom blokk) er fortsatt ingen tjenester, ikke en feil", () => {
    expect(names("name: x\n")).toEqual([]);
    expect(names("")).toEqual([]);
    expect(names("services:\nvolumes:\n  v: {}\n")).toEqual([]);
  });

  it("tab-innrykk (ugyldig YAML), flow-stil på services selv og inkonsistent innrykk gir en tydelig feil", () => {
    fails("services:\n\ta:\n\t\timage: x\n", "tab");
    fails("services:\n  a:\n    image: x\n \tb:\n", "tab");
    fails("services: { a: { image: x } }\n", "flow-stil");
    fails("services: [a, b]\n", "flow-stil");
    fails("services:\n    a:\n      image: x\n  b:\n    image: y\n", "innrykk");
  });

  it("innhold som ikke er tjenestenøkler (liste, kompleks nøkkel, nøkkel med mellomrom) gir en feil som sier hvilken linje", () => {
    fails("services:\n  - a\n  - b\n", "linje 2");
    fails("services:\n  ? a\n  : b\n", "linje 2");
    fails("services:\n  a:\n    image: x\n  b c:\n    image: y\n", "linje 4");
  });

  it("gjennom lasteren: et mini-repo med 4-mellomroms compose gir tjenestene; med tab-innrykk stopper hele kjøringen (ProgramDataError) og CLI-en gir DATAFEIL", () => {
    const { root } = miniRepo();
    put(root, "compose.yml", "services:\n    svc:\n        image: x\n");
    expect(collectRepoFacts(root, loadProgramData(root).manifest).compose_services).toEqual(["svc"]);
    expect(runProgramIndex({ root, env: undefined, origin: [] }).findings).toEqual([]);
    put(root, "compose.yml", "services:\n\tsvc:\n\t\timage: x\n");
    expect(() => runProgramIndex({ root, env: undefined, origin: [] })).toThrow(ProgramDataError);
    const err: string[] = [];
    const code = main(["report", "--root", root], {}, () => undefined, (l) => err.push(l));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("DATAFEIL (compose_invalid)");
  });

  it("det virkelige compose-filen gir fortsatt de 10 tjenestene", () => {
    const real = parseComposeServiceNames(readFileSync(resolve(ROOT, "infra/local/docker-compose.yml"), "utf8"));
    expect(real).toHaveLength(10);
    expect(real).toContain("postgres");
    expect(new Set(real).size).toBe(real.length);
  });
});
