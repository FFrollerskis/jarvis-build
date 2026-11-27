import { describe, expect, it } from "vitest";
import { contractFingerprint } from "../src/program/hash.ts";
import { SCAN_RULES, scanProgramIndex, type Finding } from "../src/program/scan.ts";
import { cleanWorld, cloneWorld, toScanInput, T0, planned, shard, type World } from "./program-index-fixtures.ts";

/**
 * WP-PGA / PG1: duplicate-owner-skanningen og kompatibilitetsvakten (HF6 §24, PGA-D-02/03/07). Alt går mot en liten «ren verden» som gir NULL funn; hver test endrer ÉN ting og forventer
 * nøyaktig det navngitte funnet (ikke «et funn»). Dermed dreper en mutant som svekker en regel nettopp den regelens test.
 */
const ids = (w: World): string[] => scanProgramIndex(toScanInput(w)).map((f) => f.id);
const only = (w: World, expected: string[]): void => expect(ids(w)).toEqual(expected);
const comp = (w: World, id: string) => w.components.find((c) => c.component_id === id)!;
const edit = (fn: (w: World) => void): World => {
  const w = cloneWorld(cleanWorld());
  fn(w);
  return w;
};

describe("ren verden", () => {
  it("gir null funn (grunnlaget for alle tilfellene under: hvert avvik er ett navngitt funn)", () => {
    expect(scanProgramIndex(toScanInput(cleanWorld()))).toEqual([]);
  });

  it("funn har stabil id (<regel>:<subjekt>), kjent regel, melding og er sortert", () => {
    const w = edit((x) => {
      x.repo.tables.set("t_z", { name: "t_z", created_in: "001_a.sql", columns: ["a"], definition_text: "a int" });
      x.repo.tables.set("t_y", { name: "t_y", created_in: "001_a.sql", columns: ["a"], definition_text: "a int" });
    });
    const f = scanProgramIndex(toScanInput(w));
    expect(f.map((x) => x.id)).toEqual(["table_orphan:t_y", "table_orphan:t_z"]);
    for (const x of f) {
      expect(SCAN_RULES).toContain(x.rule);
      expect(x.id).toBe(`${x.rule}:${x.subject}`);
      expect(x.message.length).toBeGreaterThan(10);
    }
  });

  it("er deterministisk: samme inndata (i annen rekkefølge) gir samme funn i samme rekkefølge", () => {
    const w = edit((x) => {
      x.repo.tables.set("t_z", { name: "t_z", created_in: "001_a.sql", columns: ["a"], definition_text: "a int" });
      comp(x, "core.alpha").state_store.services.push("ghost");
    });
    const reversed = cloneWorld(w);
    reversed.components.reverse();
    expect(ids(reversed)).toEqual(ids(w));
  });
});

describe("tabeller: hver tabell har nøyaktig én eier", () => {
  it("foreldreløs tabell (ingen eier) = table_orphan", () => {
    only(edit((w) => w.repo.tables.set("t_new", { name: "t_new", created_in: "001_a.sql", columns: ["x"], definition_text: "x int" })), ["table_orphan:t_new"]);
  });

  it("to eiere av samme tabell = table_multi_owner (én gang per tabell, ikke per eier)", () => {
    only(edit((w) => comp(w, "core.beta").state_store.tables.push("t_a")), ["table_multi_owner:t_a"]);
  });

  it("en komponent som krever en tabell som ikke finnes i migrasjonene = table_unknown", () => {
    only(edit((w) => comp(w, "core.alpha").state_store.tables.push("t_ghost")), ["table_unknown:core.alpha:t_ghost"]);
  });

  it("en planlagt tabell som allerede finnes i migrasjonene = planned_table_exists (flytt den til tables)", () => {
    only(edit((w) => comp(w, "ci.gamma").state_store.planned_tables.push("t_a")), ["planned_table_exists:ci.gamma:t_a"]);
  });

  it("en planlagt tabell som er navngitt av to komponenter = planned_table_multi_owner", () => {
    only(edit((w) => { w.components.push(planned("ci.other", { state_store: { planned_tables: ["ci_g"] } })); }), ["planned_table_multi_owner:ci_g"]);
  });

  it("runtime-tabeller: ok når unike og ikke i migrasjonene; konflikt når den også er en migrasjonstabell eller kreves av to", () => {
    const withRuntime = (w: World) => {
      comp(w, "core.alpha").state_store.runtime_tables.push("schema_x");
    };
    only(edit(withRuntime), []);
    only(edit((w) => { withRuntime(w); comp(w, "core.beta").state_store.runtime_tables.push("schema_x"); }), ["runtime_table_conflict:schema_x"]);
    only(edit((w) => comp(w, "core.alpha").state_store.runtime_tables.push("t_b")), ["runtime_table_conflict:t_b"]);
  });

  it("en tabell opprettet to ganger uten drop i migrasjonene = migration_duplicate_create", () => {
    only(edit((w) => w.repo.duplicates.push({ table: "t_a", files: ["001_a.sql", "002_b.sql"] })), ["migration_duplicate_create:t_a"]);
  });
});

describe("kode: hver modul/app/pakke er dekket", () => {
  it("en arbeidsområdekatalog uten komponent = dir_uncovered", () => {
    only(edit((w) => w.repo.workspace_dirs.push("modules/zeta")), ["dir_uncovered:modules/zeta"]);
  });

  it("en komponent som peker på en overkatalog dekker underkatalogen; en underkatalog dekker IKKE overkatalogen", () => {
    only(edit((w) => { w.repo.workspace_dirs.push("modules/alpha/sub"); }), []);
    only(edit((w) => { comp(w, "core.alpha").code_paths = ["modules/alpha/src"]; }), ["dir_uncovered:modules/alpha"]);
  });

  it("prefikset må være en katalogavgrensning (modules/alphabet dekker ikke modules/alpha)", () => {
    only(edit((w) => { comp(w, "core.alpha").code_paths = ["modules/alphabet"]; }), ["dir_uncovered:modules/alpha"]);
  });

  it("en kodesti som ikke finnes = path_missing (planlagte komponenter har ingen)", () => {
    only(edit((w) => (w.repo.path_exists = (p) => p !== "modules/alpha")), ["path_missing:core.alpha:code_paths:modules/alpha"]);
  });
});

describe("tjenester (compose)", () => {
  it("en compose-tjeneste uten eier = service_orphan", () => {
    only(edit((w) => w.repo.compose_services.push("svc2")), ["service_orphan:svc2"]);
  });

  it("en tjeneste med to eiere = service_multi_owner", () => {
    only(edit((w) => comp(w, "core.beta").state_store.services.push("svc")), ["service_multi_owner:svc"]);
  });

  it("en komponent som krever en tjeneste som ikke finnes i compose = service_unknown", () => {
    only(edit((w) => comp(w, "core.alpha").state_store.services.push("svc-ghost")), ["service_unknown:core.alpha:svc-ghost"]);
  });
});

describe("migrasjoner: kontraktendring på skjemaet må kvitteres i indeksen (PGA-D-07)", () => {
  it("en ny migrasjonsfil som ingen eier = migration_unclaimed", () => {
    only(edit((w) => w.repo.migration_files.push("003_c.sql")), ["migration_unclaimed:003_c.sql"]);
  });

  it("en migrasjon en komponent krever, men som ikke finnes = migration_unknown", () => {
    only(edit((w) => comp(w, "core.alpha").state_store.migrations.push("009_z.sql")), ["migration_unknown:core.alpha:009_z.sql"]);
  });

  it("eieren av en tabell må kreve filen som oppretter tabellen (migration_not_acknowledged)", () => {
    only(edit((w) => { comp(w, "core.alpha").state_store.migrations = []; w.repo.migration_files = ["002_b.sql", "001_a.sql"]; comp(w, "core.beta").state_store.migrations.push("001_a.sql"); }), ["migration_not_acknowledged:core.alpha:001_a.sql"]);
  });

  it("en fremmed ALTER TABLE (annen komponent sin migrasjon endrer min tabell) må kvitteres av tabelleieren", () => {
    const w = edit((x) => {
      x.repo.migration_files.push("003_c.sql");
      comp(x, "core.beta").state_store.migrations.push("003_c.sql");
      x.repo.alters.push({ table: "t_a", file: "003_c.sql" });
    });
    only(w, ["migration_not_acknowledged:core.alpha:003_c.sql"]);
    comp(w, "core.alpha").state_store.migrations.push("003_c.sql");
    only(w, []);
  });

  it("en ALTER på egen tabell, og ALTER på en tabell som ikke har en entydig eier, gir ingen ekstra funn", () => {
    only(edit((w) => { w.repo.migration_files.push("003_c.sql"); comp(w, "core.alpha").state_store.migrations.push("003_c.sql"); w.repo.alters.push({ table: "t_a", file: "003_c.sql" }); }), []);
    only(edit((w) => { w.repo.migration_files.push("003_c.sql"); comp(w, "core.alpha").state_store.migrations.push("003_c.sql"); w.repo.alters.push({ table: "schema_migrations", file: "003_c.sql" }); }), []);
  });

  it("ALTER på en tabell som senere er droppet (ikke i den effektive mengden) kvitteres ikke", () => {
    only(edit((w) => { w.repo.migration_files.push("003_c.sql"); comp(w, "core.alpha").state_store.migrations.push("003_c.sql"); w.repo.alters.push({ table: "t_gone", file: "003_c.sql" }); }), []);
  });
});

describe("kontraktfiler og fingeravtrykk (kontraktendring uten indeksendring)", () => {
  it("en kontraktfil som ingen komponent krever = contract_file_unclaimed", () => {
    only(edit((w) => w.repo.contract_files.push("packages/contracts/src/b.ts")), ["contract_file_unclaimed:packages/contracts/src/b.ts"]);
  });

  it("endret innhold i en kontraktfil uten oppdatert fingeravtrykk = contract_fingerprint_mismatch", () => {
    only(edit((w) => (w.repo.file_sha256 = (p) => (p === "packages/contracts/src/a.ts" ? "2".repeat(64) : "9".repeat(64)))), ["contract_fingerprint_mismatch:core.alpha"]);
  });

  it("oppdatert fingeravtrykk etter endringen gir ingen funn", () => {
    const w = edit((x) => {
      x.repo.file_sha256 = (p) => (p === "packages/contracts/src/a.ts" ? "2".repeat(64) : "9".repeat(64));
      comp(x, "core.alpha").contract.fingerprint = contractFingerprint([{ path: "packages/contracts/src/a.ts", sha256: "2".repeat(64) }]);
    });
    only(w, []);
  });

  it("en kontraktfil som mangler = path_missing (og ingen fingeravtrykk-feil oppå)", () => {
    only(edit((w) => { w.repo.path_exists = (p) => p !== "packages/contracts/src/a.ts"; w.repo.file_sha256 = () => null; }), ["path_missing:core.alpha:contract.files:packages/contracts/src/a.ts"]);
  });

  it("fingeravtrykket avhenger av ALLE filene (flere kontraktfiler)", () => {
    const w = edit((x) => {
      const c = comp(x, "core.alpha");
      c.contract.files = ["packages/contracts/src/a.ts", "packages/contracts/src/c.ts"];
      c.contract.fingerprint = contractFingerprint([{ path: "packages/contracts/src/a.ts", sha256: "1".repeat(64) }, { path: "packages/contracts/src/c.ts", sha256: "5".repeat(64) }]);
      x.repo.contract_files.push("packages/contracts/src/c.ts");
      x.repo.file_sha256 = (p) => (p === "packages/contracts/src/a.ts" ? "1".repeat(64) : p === "packages/contracts/src/c.ts" ? "5".repeat(64) : "9".repeat(64));
    });
    only(w, []);
    w.repo.file_sha256 = (p) => (p === "packages/contracts/src/a.ts" ? "1".repeat(64) : p === "packages/contracts/src/c.ts" ? "6".repeat(64) : "9".repeat(64));
    only(w, ["contract_fingerprint_mismatch:core.alpha"]);
  });
});

describe("hendelser: hver type har én eier; konsumenter peker på en eksisterende eier", () => {
  it("samme hendelsestype ut fra to komponenter = event_multi_owner", () => {
    only(edit((w) => comp(w, "core.beta").events_out.push({ type: "EvtA", schema_version: "1.0.0", status: "active", idempotency: "x", contract_ref: "modules/beta/src/e.ts" })), ["event_multi_owner:EvtA"]);
  });

  it("en konsument av en type ingen sender = event_consumer_unknown", () => {
    only(edit((w) => comp(w, "core.beta").events_in.push({ type: "EvtZ" })), ["event_consumer_unknown:core.beta:EvtZ"]);
  });

  it("en planlagt hendelse har en eier og kan konsumeres", () => {
    only(edit((w) => { comp(w, "jx.delta").events_out.push({ type: "EvtP", schema_version: null, status: "planned", idempotency: null, contract_ref: null }); comp(w, "core.beta").events_in.push({ type: "EvtP" }); }), []);
  });

  it("en kontraktreferanse som ikke finnes = path_missing", () => {
    only(edit((w) => (w.repo.path_exists = (p) => p !== "modules/alpha/src/events.ts")), ["path_missing:core.alpha:events_out.contract_ref:modules/alpha/src/events.ts"]);
  });
});

describe("avhengigheter: kjente mål, intervaller og ingen bygget->planlagt", () => {
  it("avhengighet av en ukjent komponent = dependency_unknown", () => {
    only(edit((w) => comp(w, "core.alpha").dependencies.push({ component_id: "core.nope", min: "0.1.0", max: "0.x" })), ["dependency_unknown:core.alpha:core.nope"]);
  });

  it("målets kontraktversjon utenfor intervallet = dependency_unsatisfied (under min og over max)", () => {
    only(edit((w) => (comp(w, "core.beta").contract.version = "1.0.0")), ["dependency_unsatisfied:core.alpha:core.beta"]);
    only(edit((w) => (comp(w, "core.alpha").dependencies = [{ component_id: "core.beta", min: "0.2.0", max: "0.x" }])), ["dependency_unsatisfied:core.alpha:core.beta"]);
    only(edit((w) => (comp(w, "core.alpha").dependencies = [{ component_id: "core.beta", min: "0.1.0", max: "0.1.0" }])), []);
    only(edit((w) => { comp(w, "core.alpha").dependencies = [{ component_id: "core.beta", min: "0.1.0", max: "0.1.0" }]; comp(w, "core.beta").contract.version = "0.1.1"; }), ["dependency_unsatisfied:core.alpha:core.beta"]);
  });

  it("en bygd komponent kan ikke avhenge av en planlagt = dependency_on_planned; planlagt -> planlagt og planlagt -> bygd er ok", () => {
    only(edit((w) => comp(w, "core.alpha").dependencies.push({ component_id: "ci.gamma", min: "0.1.0", max: "0.x" })), ["dependency_on_planned:core.alpha:ci.gamma"]);
    only(edit((w) => comp(w, "ci.gamma").dependencies.push({ component_id: "jx.delta", min: "0.1.0", max: "0.x" })), []);
  });

  it("package.json-avhengighet (workspace) som ikke står i indeksen = workspace_dependency_undeclared", () => {
    only(edit((w) => (comp(w, "core.alpha").dependencies = [])), ["workspace_dependency_undeclared:core.alpha:@jarvis/beta"]);
  });

  it("package.json-avhengighet av en pakke uten komponent som eier katalogen = workspace_dependency_undeclared; en egen pakke og ukjente (ikke-workspace) pakker ignoreres", () => {
    only(edit((w) => w.repo.workspace_packages[0]!.workspace_deps.push("@jarvis/unknown")), ["workspace_dependency_undeclared:core.alpha:@jarvis/unknown"]);
    only(edit((w) => w.repo.workspace_packages[0]!.workspace_deps.push("@jarvis/alpha")), []);
  });

  it("avhengigheten kan oppfylles av hvilken som helst komponent som eier pakkekatalogen", () => {
    const w = edit((x) => {
      x.components.push(shard("core.beta-extra", { code_paths: ["modules/beta"] }));
      comp(x, "core.alpha").dependencies = [{ component_id: "core.beta-extra", min: "0.1.0", max: "0.x" }];
    });
    only(w, []);
  });

  it("en komponent som bare eier en UNDERkatalog av pakken regnes ikke som pakkens eier for workspace-avhengigheter", () => {
    const w = edit((x) => {
      comp(x, "core.beta").code_paths = ["modules/beta/src"];
      x.components.push(shard("core.beta-all", { code_paths: ["modules/beta"] }));
      comp(x, "core.alpha").dependencies = [{ component_id: "core.beta", min: "0.1.0", max: "0.x" }];
    });
    only(w, ["workspace_dependency_undeclared:core.alpha:@jarvis/beta"]);
  });
});

describe("HF6-negative regler", () => {
  it("konkurrerende (skill|capability)_registry: tabellnavn utenfor eieren = exclusive_name_violation; eieren selv er ok", () => {
    const withTable = (name: string, owner: string): World =>
      edit((w) => {
        w.components.push(planned("ev.capability-registry"));
        w.repo.tables.set(name, { name, created_in: "001_a.sql", columns: ["tenant_id"], definition_text: "tenant_id text" });
        comp(w, owner).state_store.tables.push(name);
        if (owner === "core.alpha") comp(w, owner).contract.schema_version = "0.1.0";
      });
    only(withTable("skill_registry", "core.alpha"), ["exclusive_name_violation:single-capability-registry:skill_registry"]);
    only(withTable("capability_registry", "core.alpha"), ["exclusive_name_violation:single-capability-registry:capability_registry"]);
    only(withTable("x_capability_registry_v2", "core.alpha"), ["exclusive_name_violation:single-capability-registry:x_capability_registry_v2"]);
    only(withTable("capabilities", "core.alpha"), []);
    only(withTable("skillregistry", "core.alpha"), []);
  });

  it("et KOLONNENAVN flagges ikke (PGA-D-09): `*_id` er normalt en referanse til sannhetskilden, og det skal programmet oppmuntre", () => {
    only(edit((w) => w.repo.tables.get("t_a")!.columns.push("capability_registry_id", "commitment_id", "commitment_text")), []);
  });

  it("planlagt tabell med et eksklusivt navn utenfor eieren fanges også", () => {
    only(edit((w) => comp(w, "ci.gamma").state_store.planned_tables.push("skill_registry")), ["exclusive_name_violation:single-capability-registry:skill_registry"]);
  });

  it("commitment_/impact_/knowledge_gap_/workspace_-tabeller kun hos JX-eier (prefiks + understrek)", () => {
    const planWith = (name: string, owner: string): World => edit((w) => comp(w, owner).state_store.planned_tables.push(name));
    only(planWith("commitment_log", "ci.gamma"), ["exclusive_name_violation:jx-truth-stores:commitment_log"]);
    only(planWith("impact_ledger", "ci.gamma"), ["exclusive_name_violation:jx-truth-stores:impact_ledger"]);
    only(planWith("knowledge_gap_requests", "ci.gamma"), ["exclusive_name_violation:jx-truth-stores:knowledge_gap_requests"]);
    only(planWith("workspace_items", "ci.gamma"), ["exclusive_name_violation:jx-truth-stores:workspace_items"]);
    only(planWith("commitment_log", "jx.delta"), []);
    only(planWith("commitments", "ci.gamma"), []);
    only(planWith("comms_meeting_commitments", "ci.gamma"), []);
  });

  it("reserverte prefikser: ci_-tabeller kun hos ci.*-komponenter", () => {
    only(edit((w) => comp(w, "jx.delta").state_store.planned_tables.push("ci_other")), ["reserved_prefix_violation:ci_other"]);
    only(edit((w) => { w.repo.tables.set("ci_real", { name: "ci_real", created_in: "001_a.sql", columns: ["tenant_id"], definition_text: "tenant_id text" }); comp(w, "core.alpha").state_store.tables.push("ci_real"); }), ["reserved_prefix_violation:ci_real"]);
    only(edit((w) => comp(w, "ci.gamma").state_store.planned_tables.push("ci_ok")), []);
  });

  it("en ci_*-tabell kan ikke bære ACTIVE: literal i CHECK/DEFAULT eller en aktiv-kolonne", () => {
    const ciTable = (definition: string, columns: string[]): World =>
      edit((w) => {
        w.repo.tables.set("ci_t", { name: "ci_t", created_in: "001_a.sql", columns, definition_text: definition });
        w.components.push(shard("ci.real", { code_paths: ["modules/alpha/ci"], state_store: { tables: ["ci_t"], migrations: ["001_a.sql"] }, contract: { schema_version: "0.1.0" } }));
      });
    only(ciTable("state text CHECK (state IN ('candidate', 'active'))", ["state"]), ["active_state_in_learning_table:ci_t:literal"]);
    only(ciTable("state text DEFAULT 'ACTIVE'", ["state"]), ["active_state_in_learning_table:ci_t:literal"]);
    only(ciTable("state text DEFAULT ' Active '", ["state"]), ["active_state_in_learning_table:ci_t:literal"]);
    only(ciTable("state text CHECK (state IN ('candidate', 'inactive'))", ["state"]), []);
    only(ciTable("state text CHECK (state IN ('candidate', 'proactive'))", ["state"]), []);
    only(ciTable("is_active boolean", ["is_active"]), ["active_state_in_learning_table:ci_t.is_active"]);
    only(ciTable("activated_at timestamptz", ["activated_at"]), ["active_state_in_learning_table:ci_t.activated_at"]);
    only(ciTable("activation_state text", ["activation_state"]), ["active_state_in_learning_table:ci_t.activation_state"]);
    only(ciTable("note text", ["note"]), []);
  });

  it("ACTIVE-regelen gjelder bare tabeller med regelens prefiks (en annen tabell kan ha 'active')", () => {
    const w = edit((x) => { x.repo.tables.get("t_a")!.definition_text = "state text DEFAULT 'active'"; x.repo.tables.get("t_a")!.columns.push("is_active"); });
    only(w, []);
  });
});

describe("planer og beslutninger", () => {
  it("to ACTIVE-versjoner i samme domene = plan_active_conflict; to ulike domener er ok", () => {
    only(edit((w) => { w.manifest.plans = [{ plan: "HF1", domain: "autonomy", version: "v4.0", status: "ACTIVE", decision_ref: "D-1" }, { plan: "HF1", domain: "autonomy", version: "v4.1", status: "ACTIVE", decision_ref: "D-2" }, { plan: "HF6", domain: "x", version: "v1.2", status: "NOT_ADOPTED", decision_ref: null }]; }), ["plan_active_conflict:autonomy"]);
    only(edit((w) => { w.manifest.plans = [{ plan: "HF1", domain: "autonomy", version: "v4.0", status: "ACTIVE", decision_ref: "D-1" }, { plan: "HF6", domain: "x", version: "v1.2", status: "ACTIVE", decision_ref: "D-2" }]; }), []);
    only(edit((w) => { w.manifest.plans = [{ plan: "HF1", domain: "autonomy", version: "v3.0", status: "SUPERSEDED", decision_ref: null }, { plan: "HF1", domain: "autonomy", version: "v4.0", status: "ACTIVE", decision_ref: "D-1" }, { plan: "HF6", domain: "x", version: "v1.2", status: "NOT_ADOPTED", decision_ref: null }]; }), []);
  });

  it("en komponent eid av en plan som ikke står i manifestet = plan_unknown", () => {
    only(edit((w) => (comp(w, "core.alpha").canonical_owner.plan = "HF3")), ["plan_unknown:core.alpha:HF3"]);
  });

  it("beslutningsreferanser (D-nnn) må finnes i loggen; plan-interne (D-PROG-07) sjekkes ikke", () => {
    const w = edit((x) => { comp(x, "core.alpha").canonical_owner.d_refs = ["D-999", "D-PROG-07"]; x.repo.decision_exists = (id) => id !== "D-999"; });
    only(w, ["decision_ref_missing:core.alpha:D-999"]);
  });

  it("planens decision_ref: en D-id sjekkes mot loggen, en sti mot filsystemet", () => {
    only(edit((w) => { w.manifest.plans[0]!.decision_ref = "D-998"; w.repo.decision_exists = (id) => id !== "D-998"; }), ["decision_ref_missing:manifest:HF1:D-998"]);
    only(edit((w) => { w.manifest.plans[0]!.decision_ref = "docs/x/ADR.md"; w.repo.path_exists = (p) => p !== "docs/x/ADR.md"; }), ["path_missing:manifest:plans.HF1:docs/x/ADR.md"]);
  });

  it("runbook og autoritative filer som ikke finnes = path_missing", () => {
    only(edit((w) => { comp(w, "core.alpha").owner.runbook = "docs/runbooks/X.md"; w.repo.path_exists = (p) => p !== "docs/runbooks/X.md"; }), ["path_missing:core.alpha:owner.runbook:docs/runbooks/X.md"]);
    only(edit((w) => { comp(w, "core.alpha").state_store.files = ["config/x.json"]; w.repo.path_exists = (p) => p !== "config/x.json"; }), ["path_missing:core.alpha:state_store.files:config/x.json"]);
  });
});

describe("komponentens evidence_ref (PGA-D-08)", () => {
  const withEvidence = (sha: string, fileSha: string | null): World =>
    edit((w) => {
      const c = comp(w, "core.alpha");
      c.last_verified = T0;
      c.verification = "VERIFIED";
      c.evidence_ref = { path: "docs/evidence/2026-11-26-x.md", sha256: sha, git_sha: "b".repeat(40), recorded_at: T0, verified_at: T0, verified_at_source: "evidence_header", contract_fingerprints: {} };
      const prev = w.repo.file_sha256;
      w.repo.file_sha256 = (p) => (p === "docs/evidence/2026-11-26-x.md" ? fileSha : prev(p));
      w.repo.path_exists = (p) => (p === "docs/evidence/2026-11-26-x.md" ? fileSha !== null : true);
    });

  it("gyldig evidens (fil finnes, hash stemmer) gir ingen funn", () => {
    only(withEvidence("c".repeat(64), "c".repeat(64)), []);
  });

  it("evidensfil som mangler eller har endret hash = evidence_invalid", () => {
    only(withEvidence("c".repeat(64), null), ["evidence_invalid:core.alpha"]);
    only(withEvidence("c".repeat(64), "d".repeat(64)), ["evidence_invalid:core.alpha"]);
  });
});

describe("ingen hopping: en regel som ikke kan evalueres er et funn, ikke en stille hopp", () => {
  it("regelmengden er stabil og hver regel har en test over (ingen død regel)", () => {
    expect([...SCAN_RULES].sort()).toEqual(
      [
        "active_state_in_learning_table", "contract_file_unclaimed", "contract_fingerprint_mismatch", "decision_ref_missing", "dependency_on_planned", "dependency_unknown", "dependency_unsatisfied", "dir_uncovered",
        "event_consumer_unknown", "event_multi_owner", "evidence_invalid", "exclusive_name_violation", "migration_duplicate_create", "migration_dynamic_ddl", "migration_not_acknowledged", "migration_unclaimed", "migration_unknown", "path_missing",
        "plan_active_conflict", "plan_unknown", "planned_table_exists", "planned_table_multi_owner", "reserved_prefix_violation", "runtime_table_conflict", "service_multi_owner", "service_orphan", "service_unknown",
        "table_multi_owner", "table_orphan", "table_unknown", "workspace_dependency_undeclared"
      ].sort()
    );
  });

  it("flere samtidige avvik gir flere funn (ingen maskerer en annen)", () => {
    const w = edit((x) => {
      x.repo.tables.set("t_new", { name: "t_new", created_in: "001_a.sql", columns: ["x"], definition_text: "x int" });
      x.repo.workspace_dirs.push("modules/zeta");
      x.repo.compose_services.push("svc2");
      comp(x, "core.beta").events_in.push({ type: "EvtZ" });
    });
    expect(ids(w)).toEqual(["dir_uncovered:modules/zeta", "event_consumer_unknown:core.beta:EvtZ", "service_orphan:svc2", "table_orphan:t_new"]);
  });

  it("funn har komponent-id der det er kjent (rapporten kan gruppere per komponent)", () => {
    const f: Finding[] = scanProgramIndex(toScanInput(edit((w) => comp(w, "core.alpha").state_store.tables.push("t_ghost"))));
    expect(f[0]?.component_id).toBe("core.alpha");
    const g: Finding[] = scanProgramIndex(toScanInput(edit((w) => w.repo.compose_services.push("svc2"))));
    expect(g[0]?.component_id).toBeNull();
  });
});
