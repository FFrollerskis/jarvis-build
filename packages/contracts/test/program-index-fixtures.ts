import { contractFingerprint } from "../src/program/hash.ts";
import type { RepoFacts, ScanInput } from "../src/program/scan.ts";
import type { ComponentShard, Manifest } from "../src/program/schema.ts";

/**
 * WP-PGA / PG1: delte testbyggere for programindeksen. Alt er syntetisk (ingen ekte komponenter, ingen hemmelighetsformede verdier). `shard()` gir et GYLDIG, bygd komponent-skjerv;
 * `planned()` gir et gyldig «planlagt». Tester endrer ett felt om gangen for å vise at nettopp det feltet feller.
 */
export const T0 = "2026-11-26T12:00:00.000Z";

type Deep<T> = { [K in keyof T]?: T[K] extends readonly (infer U)[] ? U[] | T[K] : T[K] extends object ? Deep<T[K]> : T[K] };

export function shard(id: string, overrides: Deep<ComponentShard> = {}): ComponentShard {
  const base: ComponentShard = {
    schema_version: "1.0.0",
    component_id: id,
    title: `Komponent ${id}`,
    summary: "En syntetisk komponent som brukes i tester av programindeksen.",
    kind: "module",
    canonical_owner: { plan: "HF1", subsystem: "Testsystem", d_refs: [] },
    runtime_state: "dormant",
    verification: "NOT_VERIFIED",
    last_verified: null,
    evidence_ref: null,
    contract: { version: "0.1.0", schema_version: null, files: [], fingerprint: null, changed_at: T0 },
    code_paths: [`modules/${id.split(".")[1] ?? "x"}`],
    state_store: { tables: [], planned_tables: [], runtime_tables: [], migrations: [], services: [], files: [] },
    events_out: [],
    events_in: [],
    dependencies: [],
    risk: { data_sensitivity: "PRIVATE", memory_spaces: ["personal"], max_action_class: "none", authority_domain: "none" },
    owner: { role: "owner", escalation: "eier", runbook: null },
    pending_work: [],
    notes: []
  };
  return {
    ...base,
    ...(overrides as Partial<ComponentShard>),
    contract: { ...base.contract, ...((overrides.contract as object | undefined) ?? {}) },
    state_store: { ...base.state_store, ...((overrides.state_store as object | undefined) ?? {}) },
    canonical_owner: { ...base.canonical_owner, ...((overrides.canonical_owner as object | undefined) ?? {}) },
    risk: { ...base.risk, ...((overrides.risk as object | undefined) ?? {}) },
    owner: { ...base.owner, ...((overrides.owner as object | undefined) ?? {}) }
  } as ComponentShard;
}

export function planned(id: string, overrides: Deep<ComponentShard> = {}): ComponentShard {
  return shard(id, {
    kind: "planned",
    runtime_state: "planned",
    code_paths: [],
    contract: { version: null, schema_version: null, files: [], fingerprint: null, changed_at: null },
    ...overrides
  });
}

export function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schema_version: "1.0.0",
    guard: { mode: "report" },
    plans: [
      { plan: "HF1", domain: "autonomy", version: "v4.0", status: "ACKNOWLEDGED_NOT_ADOPTED", decision_ref: null },
      { plan: "HF6", domain: "continuous-intelligence", version: "v1.2", status: "NOT_ADOPTED", decision_ref: null }
    ],
    coverage: { workspace_roots: ["apps", "modules", "packages"], migrations_dir: "modules/core/src/db/migrations", compose_file: "infra/local/docker-compose.yml", contract_roots: ["packages/contracts/src"] },
    exclusive_names: [
      { id: "single-capability-registry", pattern: "(^|_)(skill|capability)_registry($|_)", allowed_owner_patterns: ["^ev\\.capability-registry$"], reason: "Ett register for lærte evner." },
      { id: "jx-truth-stores", pattern: "^(commitment|impact|knowledge_gap|workspace)_", allowed_owner_patterns: ["^jx\\."], reason: "JX eier sannheten." }
    ],
    reserved_prefixes: [{ prefix: "ci_", owner_patterns: ["^ci\\."], reason: "Læringsevidens eies av læringskomponentene." }],
    no_active_state: { table_prefix: "ci_", forbidden_literal_pattern: "active", forbidden_column_pattern: "^(active|is_active|activated|activated_at|activation[a-z_]*)$", reason: "Ingen ACTIVE i læringstabeller." },
    ...overrides
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// «Ren verden»: en liten, konsistent verden som gir NULL funn. Hver skanningstest endrer ÉN ting og forventer nøyaktig ett (navngitt) funn.
// ---------------------------------------------------------------------------------------------------------------------

export interface World {
  manifest: Manifest;
  components: ComponentShard[];
  repo: RepoFacts;
}

const H = (c: string): string => c.repeat(64);

export function cleanWorld(): World {
  const aHash = H("1");
  const alpha = shard("core.alpha", {
    code_paths: ["modules/alpha"],
    contract: { version: "0.1.0", schema_version: "0.1.0", files: ["packages/contracts/src/a.ts"], fingerprint: contractFingerprint([{ path: "packages/contracts/src/a.ts", sha256: aHash }]), changed_at: T0 },
    state_store: { tables: ["t_a"], migrations: ["001_a.sql"], services: ["svc"] },
    events_out: [{ type: "EvtA", schema_version: "1.0.0", status: "active", idempotency: "per hendelse", contract_ref: "modules/alpha/src/events.ts" }],
    dependencies: [{ component_id: "core.beta", min: "0.1.0", max: "0.x" }]
  });
  const beta = shard("core.beta", {
    code_paths: ["modules/beta"],
    contract: { version: "0.1.0", schema_version: "0.1.0", files: [], fingerprint: null, changed_at: T0 },
    state_store: { tables: ["t_b"], migrations: ["002_b.sql"] },
    events_in: [{ type: "EvtA" }]
  });
  const gamma = planned("ci.gamma", { state_store: { planned_tables: ["ci_g"] }, dependencies: [{ component_id: "core.alpha", min: "0.1.0", max: "0.x" }] });
  const delta = planned("jx.delta", { canonical_owner: { plan: "HF6" } });
  const repo: RepoFacts = {
    tables: new Map([
      ["t_a", { name: "t_a", created_in: "001_a.sql", columns: ["tenant_id", "name"], definition_text: "tenant_id text, name text" }],
      ["t_b", { name: "t_b", created_in: "002_b.sql", columns: ["tenant_id", "label"], definition_text: "tenant_id text, label text" }]
    ]),
    created: [
      { name: "t_a", file: "001_a.sql" },
      { name: "t_b", file: "002_b.sql" }
    ],
    alters: [],
    duplicates: [],
    migration_files: ["001_a.sql", "002_b.sql"],
    workspace_dirs: ["modules/alpha", "modules/beta"],
    compose_services: ["svc"],
    contract_files: ["packages/contracts/src/a.ts"],
    workspace_packages: [
      { dir: "modules/alpha", name: "@jarvis/alpha", workspace_deps: ["@jarvis/beta"] },
      { dir: "modules/beta", name: "@jarvis/beta", workspace_deps: [] }
    ],
    path_exists: () => true,
    file_sha256: (p) => (p === "packages/contracts/src/a.ts" ? aHash : H("9")),
    decision_exists: () => true
  };
  return { manifest: manifest(), components: [alpha, beta, gamma, delta], repo };
}

export const toScanInput = (w: World): ScanInput => ({ manifest: w.manifest, components: w.components, repo: w.repo });

/** Dyp kopi av en verden som beholder funksjonene i `repo` (JSON klarer ikke funksjoner/Map). */
export function cloneWorld(w: World): World {
  return {
    manifest: JSON.parse(JSON.stringify(w.manifest)) as Manifest,
    components: JSON.parse(JSON.stringify(w.components)) as ComponentShard[],
    repo: {
      ...w.repo,
      tables: new Map([...w.repo.tables].map(([k, v]) => [k, { ...v, columns: [...v.columns] }])),
      created: w.repo.created.map((c) => ({ ...c })),
      alters: w.repo.alters.map((a) => ({ ...a })),
      duplicates: w.repo.duplicates.map((d) => ({ ...d, files: [...d.files] })),
      migration_files: [...w.repo.migration_files],
      workspace_dirs: [...w.repo.workspace_dirs],
      compose_services: [...w.repo.compose_services],
      contract_files: [...w.repo.contract_files],
      workspace_packages: w.repo.workspace_packages.map((p) => ({ ...p, workspace_deps: [...p.workspace_deps] }))
    }
  };
}
