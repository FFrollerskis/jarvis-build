import { compareFindings, type Finding } from "./findings.ts";
import { contractFingerprint } from "./hash.ts";
import { LOG_D_REF } from "./ids.ts";
import type { ComponentShard, Manifest } from "./schema.ts";
import { satisfiesRange } from "./semver.ts";
import { DYNAMIC_DDL_ALLOWLIST } from "./frozen-rules.ts";
import type { CreatedRecord, EffectiveTable, TouchKind } from "./sql-schema.ts";

/**
 * WP-PGA / PG1 (HF6 §24, PGA-D-02/03/07): DUPLICATE-OWNER-SKANNINGEN og kompatibilitetsvakten. Ren funksjon over (manifest, komponentskjerver, repo-fakta): ingen filsystem, ingen kjøretid.
 * Fakta om repoet (tabeller fra migrasjonene, kataloger, compose-tjenester, filhasher) leveres av `fs-loader.ts`; skanningen kan derfor testes med syntetiske verdener.
 *
 * Hvert funn har en STABIL id `<regel>:<subjekt>` som baselinen (`config/program/baseline.json`) refererer. Funnene er sortert og dedupliserte (samme inndata gir samme utdata).
 * I `report`-modus feiler funn ikke bygget; i `enforce`-modus feiler alle funn utenfor baselinen (se `baseline.ts`).
 *
 * HVA SKANNINGEN IKKE GJØR (ærlig): den leser ikke kodens oppførsel. Den sjekker at påstandene i indeksen (eierskap, filer, versjoner, avhengigheter) er innbyrdes konsistente og stemmer med repoets
 * filer; om en komponents beskrivelse er sann er ikke maskinsjekkbart.
 */

export const SCAN_RULES = [
  "plan_unknown",
  "plan_active_conflict",
  "decision_ref_missing",
  "path_missing",
  "table_orphan",
  "table_multi_owner",
  "table_unknown",
  "planned_table_exists",
  "planned_table_multi_owner",
  "runtime_table_conflict",
  "migration_duplicate_create",
  "dir_uncovered",
  "service_orphan",
  "service_multi_owner",
  "service_unknown",
  "migration_unclaimed",
  "migration_unknown",
  "migration_not_acknowledged",
  "migration_dynamic_ddl",
  "contract_file_unclaimed",
  "contract_fingerprint_mismatch",
  "event_multi_owner",
  "event_consumer_unknown",
  "dependency_unknown",
  "dependency_unsatisfied",
  "dependency_on_planned",
  "workspace_dependency_undeclared",
  "exclusive_name_violation",
  "reserved_prefix_violation",
  "active_state_in_learning_table",
  "evidence_invalid"
] as const;
export type ScanRule = (typeof SCAN_RULES)[number];

export type { Finding } from "./findings.ts";

export interface WorkspacePackage {
  /** Repo-relativ katalog (`modules/core`). */
  dir: string;
  name: string | null;
  /** Avhengigheter i package.json som er arbeidsområdepakker (`@jarvis/*`). */
  workspace_deps: string[];
}

/** Fakta om repoet som skanningen trenger. Funksjonene er injisert: skanningen selv rører aldri filsystemet. */
export interface RepoFacts {
  /** Effektive tabeller etter alle migrasjoner (DROP/RENAME anvendt). */
  tables: Map<string, EffectiveTable>;
  created: CreatedRecord[];
  /** Endringer av tabeller per fil: ALTER (uten `via`) og indeks/policy/trigger/insert (med `via`). Eieren må kvittere filen. */
  alters: Array<{ table: string; file: string; via?: TouchKind }>;
  duplicates: Array<{ table: string; files: string[] }>;
  /** Dynamisk tabell-DDL (`EXECUTE` mot en streng med CREATE/ALTER/DROP TABLE) som ikke er en RLS-hjelper: den kan ingen statisk skanning se. */
  dynamic_ddl: Array<{ file: string; statement: string }>;
  migration_files: string[];
  workspace_dirs: string[];
  compose_services: string[];
  /** `.ts`-filer rett under kontraktrotene (repo-relative). */
  contract_files: string[];
  workspace_packages: WorkspacePackage[];
  /** Finnes denne repo-relative stien (fil ELLER katalog)? */
  path_exists: (path: string) => boolean;
  /** sha256 (hex) av filens LF-normaliserte innhold, eller null hvis den ikke finnes/kan leses. */
  file_sha256: (path: string) => string | null;
  /** Finnes beslutningen (`D-109`) som en rad i beslutningsloggen? */
  decision_exists: (id: string) => boolean;
}

export interface ScanInput {
  manifest: Manifest;
  components: ComponentShard[];
  repo: RepoFacts;
}

function multimap<K>(entries: Iterable<readonly [K, string]>): Map<K, string[]> {
  const m = new Map<K, string[]>();
  for (const [k, v] of entries) {
    const list = m.get(k);
    if (list === undefined) m.set(k, [v]);
    else if (!list.includes(v)) list.push(v);
  }
  return m;
}

const claimsPath = (claim: string, dir: string): boolean => claim === dir || dir.startsWith(`${claim}/`);

/** Hva en indeks/policy/trigger/insert gjør med en tabell, til meldingen om manglende kvittering. */
const TOUCH_TEXT: Readonly<Record<TouchKind, string>> = { index: "oppretter en indeks på", policy: "oppretter en policy på", trigger: "oppretter en trigger på", insert: "setter inn rader i" };

export function scanProgramIndex(input: ScanInput): Finding[] {
  const { manifest, components, repo } = input;
  const found = new Map<string, Finding>();
  const add = (rule: ScanRule, component_id: string | null, subject: string, message: string): void => {
    const id = `${rule}:${subject}`;
    if (!found.has(id)) found.set(id, { rule, component_id, subject, id, message });
  };
  const byId = new Map(components.map((c) => [c.component_id, c]));

  // ------------------------------------------------------------------ planer og beslutninger
  const planIds = new Set(manifest.plans.map((p) => p.plan));
  for (const c of components) {
    if (!planIds.has(c.canonical_owner.plan)) add("plan_unknown", c.component_id, `${c.component_id}:${c.canonical_owner.plan}`, `komponenten eies av ${c.canonical_owner.plan}, som ikke står i manifestet (config/program/manifest.json)`);
    for (const ref of c.canonical_owner.d_refs) {
      if (LOG_D_REF.test(ref) && !repo.decision_exists(ref)) add("decision_ref_missing", c.component_id, `${c.component_id}:${ref}`, `beslutningen ${ref} finnes ikke som rad i beslutningsloggen`);
    }
  }
  const activePerDomain = multimap(manifest.plans.filter((p) => p.status === "ACTIVE").map((p) => [p.domain, p.version] as const));
  for (const [domain, versions] of activePerDomain) {
    if (versions.length > 1) add("plan_active_conflict", null, domain, `mer enn én ACTIVE planversjon i domenet «${domain}» (${versions.join(", ")}): bare én kan styre`);
  }
  for (const p of manifest.plans) {
    const ref = p.decision_ref;
    if (ref === null) continue;
    if (LOG_D_REF.test(ref)) {
      if (!repo.decision_exists(ref)) add("decision_ref_missing", null, `manifest:${p.plan}:${ref}`, `planens beslutning ${ref} finnes ikke i beslutningsloggen`);
    } else if (!repo.path_exists(ref)) add("path_missing", null, `manifest:plans.${p.plan}:${ref}`, `planens beslutningsdokument finnes ikke: ${ref}`);
  }

  // ------------------------------------------------------------------ stier som skjervene påstår finnes
  for (const c of components) {
    const check = (field: string, paths: readonly string[]): void => {
      for (const p of paths) if (!repo.path_exists(p)) add("path_missing", c.component_id, `${c.component_id}:${field}:${p}`, `${field} peker på en sti som ikke finnes: ${p}`);
    };
    if (c.runtime_state !== "planned") {
      check("code_paths", c.code_paths);
      check("contract.files", c.contract.files);
      check("state_store.files", c.state_store.files);
      check("events_out.contract_ref", c.events_out.flatMap((e) => (e.contract_ref === null ? [] : [e.contract_ref])));
    }
    if (c.owner.runbook !== null) check("owner.runbook", [c.owner.runbook]);
  }

  // ------------------------------------------------------------------ tabeller: ett eierskap
  const tableOwners = multimap(components.flatMap((c) => c.state_store.tables.map((t) => [t, c.component_id] as const)));
  const ownerOfTable = (t: string): string | null => {
    const o = tableOwners.get(t);
    return o !== undefined && o.length === 1 ? (o[0] as string) : null;
  };
  for (const table of repo.tables.keys()) {
    const owners = tableOwners.get(table) ?? [];
    if (owners.length === 0) add("table_orphan", null, table, `tabellen ${table} (${repo.tables.get(table)?.created_in}) har ingen eier: legg den i state_store.tables hos nøyaktig én komponent`);
    else if (owners.length > 1) add("table_multi_owner", null, table, `tabellen ${table} er eid av flere komponenter (${owners.join(", ")}): én funksjon har én eier`);
  }
  for (const c of components) {
    for (const t of c.state_store.tables) if (!repo.tables.has(t)) add("table_unknown", c.component_id, `${c.component_id}:${t}`, `tabellen ${t} finnes ikke i migrasjonene (er den droppet, omdøpt eller bare planlagt?)`);
  }
  const plannedOwners = multimap(components.flatMap((c) => c.state_store.planned_tables.map((t) => [t, c.component_id] as const)));
  for (const c of components) {
    for (const t of c.state_store.planned_tables) {
      if (repo.tables.has(t) || tableOwners.has(t)) add("planned_table_exists", c.component_id, `${c.component_id}:${t}`, `den planlagte tabellen ${t} finnes allerede: flytt den fra planned_tables til tables`);
    }
  }
  for (const [t, owners] of plannedOwners) if (owners.length > 1) add("planned_table_multi_owner", null, t, `den planlagte tabellen ${t} er navngitt av flere komponenter (${owners.join(", ")})`);
  const runtimeOwners = multimap(components.flatMap((c) => c.state_store.runtime_tables.map((t) => [t, c.component_id] as const)));
  for (const [t, owners] of runtimeOwners) {
    if (repo.tables.has(t) || tableOwners.has(t) || owners.length > 1) add("runtime_table_conflict", null, t, `runtime-tabellen ${t} kolliderer med en migrasjonstabell eller en annen komponents runtime-tabell`);
  }
  for (const d of repo.duplicates) add("migration_duplicate_create", null, d.table, `tabellen ${d.table} opprettes to ganger uten DROP imellom (${d.files.join(", ")})`);

  // ------------------------------------------------------------------ kode: hver arbeidsområdekatalog dekket
  const claimedPaths = components.flatMap((c) => c.code_paths);
  for (const dir of repo.workspace_dirs) {
    if (!claimedPaths.some((p) => claimsPath(p, dir))) add("dir_uncovered", null, dir, `katalogen ${dir} er ikke dekket av noen komponents code_paths (hver modul/app/pakke må tilhøre minst én komponent)`);
  }

  // ------------------------------------------------------------------ compose-tjenester
  const serviceOwners = multimap(components.flatMap((c) => c.state_store.services.map((s) => [s, c.component_id] as const)));
  for (const s of repo.compose_services) {
    const owners = serviceOwners.get(s) ?? [];
    if (owners.length === 0) add("service_orphan", null, s, `compose-tjenesten ${s} har ingen eier`);
    else if (owners.length > 1) add("service_multi_owner", null, s, `compose-tjenesten ${s} er eid av flere komponenter (${owners.join(", ")})`);
  }
  const composeSet = new Set(repo.compose_services);
  for (const c of components) for (const s of c.state_store.services) if (!composeSet.has(s)) add("service_unknown", c.component_id, `${c.component_id}:${s}`, `compose-tjenesten ${s} finnes ikke i ${manifest.coverage.compose_file}`);

  // ------------------------------------------------------------------ migrasjoner: skjemaendring må kvitteres av eieren (PGA-D-07)
  const migrationClaims = multimap(components.flatMap((c) => c.state_store.migrations.map((f) => [f, c.component_id] as const)));
  const migrationSet = new Set(repo.migration_files);
  for (const f of repo.migration_files) if (!migrationClaims.has(f)) add("migration_unclaimed", null, f, `migrasjonen ${f} er ikke krevd av noen komponent: legg den i state_store.migrations hos eieren av tabellene den berører`);
  for (const c of components) for (const f of c.state_store.migrations) if (!migrationSet.has(f)) add("migration_unknown", c.component_id, `${c.component_id}:${f}`, `migrasjonen ${f} finnes ikke i ${manifest.coverage.migrations_dir}`);
  const claimsMigration = (owner: string, file: string): boolean => (migrationClaims.get(file) ?? []).includes(owner);
  const needAck = (table: string, file: string, what: string): void => {
    if (!repo.tables.has(table)) return;
    const owner = ownerOfTable(table);
    if (owner !== null && !claimsMigration(owner, file)) add("migration_not_acknowledged", owner, `${owner}:${file}`, `${file} ${what} ${table}, som ${owner} eier, men ${owner} har ikke kvittert filen i state_store.migrations (kontraktendring uten indeksendring)`);
  };
  for (const rec of repo.created) needAck(rec.name, rec.file, "oppretter");
  for (const a of repo.alters) needAck(a.table, a.file, a.via === undefined ? "endrer" : TOUCH_TEXT[a.via]);

  // Dynamisk tabell-DDL (EXECUTE) er usynlig for den statiske lesingen: hver fil utenfor den eksplisitte, begrunnede allowlisten (frozen-rules.ts) er et funn. Ett funn per fil.
  const dynamicByFile = multimap(repo.dynamic_ddl.map((d) => [d.file, d.statement] as const));
  const allowedDynamic = new Set(DYNAMIC_DDL_ALLOWLIST.map((e) => e.file));
  for (const [file, statements] of dynamicByFile) {
    if (allowedDynamic.has(file)) continue;
    add("migration_dynamic_ddl", null, file, `${file} har ${statements.length} ${statements.length === 1 ? "setning" : "setninger"} med dynamisk tabell-DDL (EXECUTE) som skanningen ikke kan se, f.eks. «${(statements[0] as string).slice(0, 90)}»: bruk statisk DDL, eller føre filen i allowlisten (frozen-rules.ts) med en begrunnelse`);
  }

  // ------------------------------------------------------------------ kontraktfiler og fingeravtrykk
  const claimedContract = new Set(components.flatMap((c) => c.contract.files));
  for (const f of repo.contract_files) if (!claimedContract.has(f)) add("contract_file_unclaimed", null, f, `kontraktfilen ${f} er ikke krevd i contract.files av noen komponent`);
  for (const c of components) {
    if (c.contract.fingerprint === null || c.contract.files.length === 0) continue;
    const hashes = c.contract.files.map((path) => ({ path, sha256: repo.file_sha256(path) }));
    const unreadable = hashes.filter((h) => h.sha256 === null);
    if (unreadable.length > 0) {
      // Manglende filer er allerede `path_missing`; en fil som finnes men ikke kan leses gir et eget mismatch-funn (vi kan ikke bevise fingeravtrykket).
      if (unreadable.some((h) => repo.path_exists(h.path))) add("contract_fingerprint_mismatch", c.component_id, c.component_id, `kontraktfiler kunne ikke leses, så fingeravtrykket kan ikke bevises (${unreadable.map((h) => h.path).join(", ")})`);
      continue;
    }
    const actual = contractFingerprint(hashes.map((h) => ({ path: h.path, sha256: h.sha256 as string })));
    if (actual !== c.contract.fingerprint) add("contract_fingerprint_mismatch", c.component_id, c.component_id, `kontraktfilene til ${c.component_id} er endret uten at fingeravtrykket er oppdatert (kjør «fingerprint --write», øk contract.version og beskriv endringen)`);
  }

  // ------------------------------------------------------------------ hendelser
  const eventOwners = multimap(components.flatMap((c) => c.events_out.map((e) => [e.type, c.component_id] as const)));
  for (const [type, owners] of eventOwners) if (owners.length > 1) add("event_multi_owner", null, type, `hendelsestypen ${type} sendes ut av flere komponenter (${owners.join(", ")}): én type har én eier`);
  for (const c of components) for (const e of c.events_in) if (!eventOwners.has(e.type)) add("event_consumer_unknown", c.component_id, `${c.component_id}:${e.type}`, `${c.component_id} konsumerer ${e.type}, men ingen komponent har den i events_out`);

  // ------------------------------------------------------------------ avhengigheter
  for (const c of components) {
    for (const d of c.dependencies) {
      const target = byId.get(d.component_id);
      const subject = `${c.component_id}:${d.component_id}`;
      if (target === undefined) {
        add("dependency_unknown", c.component_id, subject, `${c.component_id} avhenger av ${d.component_id}, som ikke finnes i indeksen`);
      } else if (target.runtime_state === "planned") {
        if (c.runtime_state !== "planned") add("dependency_on_planned", c.component_id, subject, `den bygde komponenten ${c.component_id} avhenger av den planlagte ${d.component_id} (finnes ikke ennå)`);
      } else if (!satisfiesRange(target.contract.version ?? "", { min: d.min, max: d.max })) {
        add("dependency_unsatisfied", c.component_id, subject, `${d.component_id} har kontraktversjon ${target.contract.version ?? "(ingen)"}, utenfor ${c.component_id} sitt intervall [${d.min}, ${d.max}]`);
      }
    }
  }
  const packageByDir = new Map(repo.workspace_packages.map((p) => [p.dir, p]));
  const dirByName = new Map(repo.workspace_packages.flatMap((p) => (p.name === null ? [] : [[p.name, p.dir] as const])));
  const primaries = (dir: string): string[] => components.filter((c) => c.code_paths.includes(dir)).map((c) => c.component_id);
  for (const c of components) {
    if (c.runtime_state === "planned") continue;
    for (const dir of c.code_paths) {
      const pkg = packageByDir.get(dir);
      if (pkg === undefined) continue;
      for (const dep of pkg.workspace_deps) {
        const depDir = dirByName.get(dep);
        if (depDir === dir) continue;
        const targets = depDir === undefined ? [] : primaries(depDir);
        if (targets.includes(c.component_id)) continue;
        if (!c.dependencies.some((x) => targets.includes(x.component_id))) {
          add("workspace_dependency_undeclared", c.component_id, `${c.component_id}:${dep}`, `${dir}/package.json avhenger av ${dep}, men ${c.component_id} har ingen avhengighet til komponenten som eier pakken`);
        }
      }
    }
  }

  // ------------------------------------------------------------------ HF6-negative regler
  for (const rule of manifest.exclusive_names) {
    const re = new RegExp(rule.pattern);
    const allowed = rule.allowed_owner_patterns.map((p) => new RegExp(p));
    const ownerAllowed = (owner: string | null): boolean => owner !== null && allowed.some((r) => r.test(owner));
    for (const table of repo.tables.keys()) {
      const owner = ownerOfTable(table);
      if (ownerAllowed(owner)) continue;
      // Kun TABELLNAVN (og planlagte tabeller under): et `*_id`-felt i en annen tabell er normalt en REFERANSE til sannhetskilden, og det skal programmet oppmuntre, ikke flagge (PGA-D-09).
      if (re.test(table)) add("exclusive_name_violation", owner, `${rule.id}:${table}`, `${table} bærer et eksklusivt navn (${rule.id}) men eies ikke av en tillatt komponent: ${rule.reason}`);
    }
    for (const c of components) {
      if (ownerAllowed(c.component_id)) continue;
      for (const t of c.state_store.planned_tables) if (re.test(t)) add("exclusive_name_violation", c.component_id, `${rule.id}:${t}`, `den planlagte tabellen ${t} bærer et eksklusivt navn (${rule.id}) men ${c.component_id} er ikke en tillatt eier: ${rule.reason}`);
    }
  }
  for (const rule of manifest.reserved_prefixes) {
    const allowed = rule.owner_patterns.map((p) => new RegExp(p));
    const ownerAllowed = (owner: string | null): boolean => owner !== null && allowed.some((r) => r.test(owner));
    for (const table of repo.tables.keys()) {
      const owner = ownerOfTable(table);
      if (table.startsWith(rule.prefix) && !ownerAllowed(owner)) add("reserved_prefix_violation", owner, table, `${table} bruker det reserverte prefikset «${rule.prefix}» men eies ikke av en tillatt komponent: ${rule.reason}`);
    }
    for (const c of components) {
      for (const t of [...c.state_store.planned_tables, ...c.state_store.runtime_tables]) {
        if (t.startsWith(rule.prefix) && !ownerAllowed(c.component_id)) add("reserved_prefix_violation", c.component_id, t, `${t} bruker det reserverte prefikset «${rule.prefix}» men ${c.component_id} er ikke en tillatt eier: ${rule.reason}`);
      }
    }
  }
  const na = manifest.no_active_state;
  const literalRe = new RegExp(`^(?:${na.forbidden_literal_pattern})$`, "i");
  const columnRe = new RegExp(na.forbidden_column_pattern, "i");
  for (const [table, info] of repo.tables) {
    if (!table.startsWith(na.table_prefix)) continue;
    const owner = ownerOfTable(table);
    const literals = [...info.definition_text.matchAll(/'((?:[^']|'')*)'/g)].map((m) => (m[1] as string).replace(/''/g, "'").trim());
    if (literals.some((l) => literalRe.test(l))) add("active_state_in_learning_table", owner, `${table}:literal`, `${table} har en literal som kan bære en ACTIVE-tilstand: ${na.reason}`);
    for (const col of info.columns) if (columnRe.test(col)) add("active_state_in_learning_table", owner, `${table}.${col}`, `${table}.${col} ser ut som en aktiveringstilstand: ${na.reason}`);
  }

  // ------------------------------------------------------------------ komponentenes egen evidens
  for (const c of components) {
    const e = c.evidence_ref;
    if (e === null) continue;
    const actual = repo.file_sha256(e.path);
    if (actual === null || actual !== e.sha256) add("evidence_invalid", c.component_id, c.component_id, `evidensen ${e.path} finnes ikke eller har en annen hash enn registrert: den kan ikke gjenverifiseres`);
  }

  return [...found.values()].sort(compareFindings);
}
