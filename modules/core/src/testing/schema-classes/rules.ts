import type { Catalog, CatalogColumn, CatalogForeignKey, CatalogPolicy, CatalogRole } from "./catalog.ts";
import type { SchemaClass } from "./directives.ts";
import { exceptionKey, type BaselineException } from "./manifest.ts";

/**
 * WP-MC8a: lint-reglene (HF3 §9.2, D-MC-34). Rene funksjoner over et katalog-øyeblikksbilde.
 *
 * Reglene deles i to:
 *  - `catalog`-regler (kan ha et begrunnet baseline-unntak for en EKSISTERENDE tabell, som kan bare krympe),
 *  - `structure`-regler om klassifiseringen/annotasjonene/manifestet selv (kan aldri ha unntak).
 */

export interface RuleInfo {
  readonly id: string;
  readonly kind: "catalog" | "structure";
  /** Kan en baseline-oppføring i manifestet gjøre dette bruddet «kjent»? Kun for tabellspesifikke katalogregler. */
  readonly exceptionEligible: boolean;
  readonly summary: string;
}

const R = (id: string, kind: RuleInfo["kind"], exceptionEligible: boolean, summary: string): RuleInfo => ({ id, kind, exceptionEligible, summary });

export const RULES: readonly RuleInfo[] = [
  // --- struktur: klassifisering, annotasjoner, manifest, migrasjonsfiler (aldri unntak) ---
  R("manifest_invalid", "structure", false, "Manifestfilen er ugyldig (sortering, duplikater, tak, begrunnelser, kjente regler)."),
  R("unclassified_table", "structure", false, "En tabell i skjemaet har ingen klasse (ikke i baseline og ingen `-- jarvis-class:` i en ny migrasjon)."),
  R("class_declared_twice", "structure", false, "En tabell har to klasser (to annotasjoner, eller både baseline og annotasjon)."),
  R("annotation_for_frozen_table", "structure", false, "En annotasjon peker på en tabell fra de frosne migrasjonene (≤ 148): klassen står i baseline."),
  R("annotation_unknown_table", "structure", false, "En annotasjon peker på en tabell som ingen ny migrasjon oppretter."),
  R("baseline_stale_table", "structure", false, "Baseline lister en tabell som ikke lenger finnes (baseline kan bare krympe: fjern den)."),
  R("baseline_grew", "structure", false, "Baseline inneholder en tabell som ikke er opprettet i de frosne migrasjonene (nye tabeller annoteres i migrasjonen)."),
  R("directive_malformed", "structure", false, "En linje ligner `-- jarvis-class:`/`-- jarvis-definer:` men følger ikke grammatikken."),
  R("unsupported_ddl", "structure", false, "DDL klassifiseringen ikke kan spore (RENAME, SET SCHEMA, VIEW, partisjoner, annet skjema)."),
  R("dynamic_create_table", "structure", false, "`CREATE TABLE` via EXECUTE i en DO-blokk kan ikke klassifiseres statisk: skriv vanlig DDL."),
  R("static_db_mismatch", "structure", false, "Tabellene migrasjonsfilene gir (statisk) avviker fra tabellene i databasen."),
  R("frozen_migration_changed", "structure", false, "En frossen migrasjonsfil (≤ 148) er endret (sjekksum avviker fra manifestet)."),
  R("frozen_migration_missing", "structure", false, "En frossen migrasjonsfil som manifestet kjenner mangler."),
  R("frozen_migration_added", "structure", false, "En NY fil med nummer ≤ 148 (innsatt i den frosne rekkefølgen) finnes ikke i manifestet."),
  R("migration_file_name_invalid", "structure", false, "En `.sql`-fil i migrasjonsmappen følger ikke `NNN_navn.sql`."),
  R("migration_prefix_duplicate", "structure", false, "To migrasjonsfiler har samme 3-sifrede prefiks (tvetydig rekkefølge; migratoren avviser det)."),
  R("definer_directive_missing", "structure", false, "En ny migrasjon lager en SECURITY DEFINER-funksjon uten `-- jarvis-definer:`-direktiv."),
  R("definer_directive_unknown", "structure", false, "Et `-- jarvis-definer:`-direktiv peker på en funksjon som ingen ny migrasjon oppretter."),
  R("exception_stale", "structure", false, "Et baseline-unntak som ikke lenger brytes (baseline kan bare krympe: fjern det)."),
  // --- katalog: regler per relasjon/klasse ---
  R("unmanaged_relation", "catalog", true, "Relasjon som ikke er en ordinær tabell i `public` (visning, partisjon, fremmed tabell, annet skjema)."),
  R("app_dangerous_privilege", "catalog", true, "Runtime-rollen har TRUNCATE/REFERENCES/TRIGGER (TRUNCATE omgår RLS; REFERENCES er et eksistensorakel)."),
  R("owner_is_runtime", "catalog", true, "Runtime-rollen er eier av tabellen eller medlem av eierrollen."),
  R("policy_true", "catalog", true, "En policy for en ikke-betrodd rolle har USING/WITH CHECK `true`."),
  R("org_no_tenant_id", "catalog", true, "ORG_OWNED-tabellen har ingen `tenant_id`-kolonne."),
  R("tenant_id_nullable", "catalog", true, "ORG_OWNED: `tenant_id` er ikke NOT NULL."),
  R("tenant_fk_missing", "catalog", true, "ORG_OWNED: `tenant_id` har ingen FK til `tenants` (direkte eller via sammensatt FK til en annen ORG_OWNED-tabell)."),
  R("tenant_index_missing", "catalog", true, "ORG_OWNED: ingen gyldig, ikke-partiell btree-indeks med `tenant_id` som første kolonne."),
  R("rls_not_forced", "catalog", true, "ORG_OWNED/USER_OWNED: RLS er ikke både ENABLE og FORCE."),
  R("policy_coverage_missing", "catalog", true, "ORG_OWNED/USER_OWNED: en kommando (SELECT/INSERT/UPDATE/DELETE) har ingen PERMISSIVE policy for runtime-rollen."),
  R("policy_scope", "catalog", true, "ORG_OWNED: en PERMISSIVE policy for runtime-rollen er ikke strengt tenant-avgrenset (`tenant_id = current_setting('jarvis.tenant_id', ...)`)."),
  R("policy_with_check_missing", "catalog", true, "ORG_OWNED: en INSERT/UPDATE/ALL-policy for runtime-rollen mangler eksplisitt WITH CHECK."),
  R("user_has_tenant_id", "catalog", true, "USER_OWNED-tabellen har en `tenant_id`-kolonne (da er den ORG_OWNED)."),
  R("user_policy_context", "catalog", true, "USER_OWNED: en PERMISSIVE policy for runtime-rollen refererer ikke `jarvis.tenant_id`/`jarvis.person_id`."),
  R("global_tenant_payload", "catalog", true, "GLOBAL-tabellen bærer tenant-nyttelast (tenant_id/person_id/FK til tenants/people) uten `tenant-payload`-flagg."),
  R("global_app_write", "catalog", true, "GLOBAL-tabellen kan skrives av runtime-rollen (en skrivbar global tabell er en kryss-tenant-kanal)."),
  R("platform_app_access", "catalog", true, "PLATFORM-tabellen er tilgjengelig for runtime-rollen (skal ha ingen GRANT)."),
  R("runtime_role_unsafe", "catalog", false, "Runtime-rollen, et medlem av den eller en FORELDER (rolle den er medlem av) er superuser/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION, eller runtime-rollen finnes ikke."),
  R("runtime_parent_not_allowlisted", "catalog", false, "Runtime-rollen (eller et medlem) er medlem av en rolle som ikke står i manifestets `runtime_parent_allowlist` (default deny; en forelder kan gi SET ROLE/arvede rettigheter)."),
  R("runtime_parent_allowlist_stale", "catalog", false, "Manifestets `runtime_parent_allowlist` har en rolle runtime-rollen ikke lenger er medlem av (allowlisten kan bare krympe: fjern oppføringen)."),
  R("runtime_create_in_public", "catalog", false, "Runtime-rollen kan opprette objekter i skjemaet `public` (ville eie dem og omgå FORCE RLS)."),
  R("runtime_create_in_database", "catalog", false, "Runtime-rollen har CREATE på databasen (kan opprette egne skjemaer og objekter utenfor migrasjonenes kontroll)."),
  R("definer_not_allowlisted", "catalog", false, "SECURITY DEFINER-funksjon utenfor allowlisten (default deny)."),
  R("definer_allowlist_stale", "catalog", false, "Allowlisten har en funksjon som ikke finnes som SECURITY DEFINER (allowlisten kan bare krympe)."),
  R("definer_owner_privileged", "catalog", false, "SECURITY DEFINER-funksjon eid av en superuser/BYPASSRLS-rolle."),
  R("definer_owner_unexpected", "catalog", false, "SECURITY DEFINER-funksjon eid av en annen rolle enn `jarvis_definer` (`definer_access` dekker kun den rollens tilgang)."),
  R("definer_access_unlisted", "catalog", false, "`jarvis_definer` har et privilegium eller en policy (`TO jarvis_definer`) på en tabell som ikke står i manifestets `definer_access` (blast radius for DEFINER-funksjonene)."),
  R("definer_access_stale", "catalog", false, "Manifestets `definer_access` lister et privilegium/en policy som `jarvis_definer` ikke lenger har, eller med annen tekst (listen kan bare krympe: fjern/rett oppføringen)."),
  R("definer_search_path", "catalog", false, "SECURITY DEFINER-funksjon uten låst `search_path` (pg_catalog først, pg_temp sist)."),
  R("definer_public_execute", "catalog", false, "SECURITY DEFINER-funksjon med EXECUTE for PUBLIC.")
];

export const RULE_IDS: ReadonlySet<string> = new Set(RULES.map((r) => r.id));
export const EXCEPTION_ELIGIBLE_RULES: ReadonlySet<string> = new Set(RULES.filter((r) => r.exceptionEligible).map((r) => r.id));

export interface Violation {
  readonly rule: string;
  /** Tabellen bruddet gjelder (null for skjemaomfattende brudd). */
  readonly table: string | null;
  /** Presis detalj (matches nøyaktig av baseline-unntak); tom streng hvis regelen ikke har detalj. */
  readonly detail: string;
  readonly message: string;
}

export function violationKey(v: Pick<Violation, "rule" | "table" | "detail">): string {
  return `${v.rule}|${v.table ?? ""}|${v.detail}`;
}

export interface ClassInfo {
  readonly class: SchemaClass;
  /** GLOBAL-tabell som eksplisitt har tillatelse til å bære tenant-nyttelast (begrunnelsen), ellers null. */
  readonly tenantPayload: string | null;
}

export interface LintConfig {
  readonly runtimeRole: string;
  /** Rollen som skal eie alle SECURITY DEFINER-funksjoner; dens tilgang er frosset i manifestets `definer_access`. */
  readonly definerRole: string;
  /** Roller en `true`-policy kan være rettet mot (SECURITY DEFINER-eieren; ikke runtime). */
  readonly trustedPolicyRoles: ReadonlySet<string>;
  readonly tenantSetting: string;
}

export const DEFAULT_LINT_CONFIG: LintConfig = {
  runtimeRole: "jarvis_app",
  definerRole: "jarvis_definer",
  trustedPolicyRoles: new Set(["jarvis_definer"]),
  tenantSetting: "jarvis.tenant_id"
};

export interface LintInput {
  readonly catalog: Catalog;
  readonly classes: ReadonlyMap<string, ClassInfo>;
  /** Normaliserte signaturer (`navn(typer)`) som er lov som SECURITY DEFINER. */
  readonly definerAllowlist: ReadonlySet<string>;
  /** Roller runtime-rollen (eller et medlem) har lov til å være medlem av (manifestets `runtime_parent_allowlist`; tom = ingen). */
  readonly runtimeParentAllowlist?: ReadonlySet<string>;
  /** Frosset tilgang for DEFINER-rollen per tabell (manifestets `definer_access`; tom = ingen tilgang). */
  readonly definerAccess?: Readonly<Record<string, { readonly privileges: readonly string[]; readonly policies: readonly string[] }>>;
  readonly config?: Partial<LintConfig>;
}

// --- uttrykksanalyse -------------------------------------------------------------------------------------------------------------------

function normalizeExpr(expr: string): string {
  return expr.replace(/\s+/g, " ").trim();
}

function outerParensWrapAll(s: string): boolean {
  if (!s.startsWith("(") || !s.endsWith(")")) return false;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "'") inString = !inString;
    if (inString) continue;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0 && i < s.length - 1) return false;
    }
  }
  return depth === 0;
}

function stripOuterParens(expr: string): string {
  let s = normalizeExpr(expr);
  while (outerParensWrapAll(s)) s = normalizeExpr(s.slice(1, -1));
  return s;
}

function splitTopLevel(expr: string, keyword: "AND" | "OR"): string[] {
  const parts: string[] = [];
  const token = ` ${keyword} `;
  let depth = 0;
  let inString = false;
  let last = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (ch === "'") inString = !inString;
    if (inString) continue;
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && expr.startsWith(token, i)) {
      parts.push(expr.slice(last, i));
      last = i + token.length;
      i = last - 1;
    }
  }
  parts.push(expr.slice(last));
  return parts;
}

function settingAtom(setting: string): RegExp[] {
  const s = setting.replace(/\./g, "\\.");
  const call = String.raw`current_setting\('${s}'(?:::text)?(?:, (?:true|false))?\)`;
  return [new RegExp(String.raw`^tenant_id = ${call}$`), new RegExp(String.raw`^${call} = tenant_id$`)];
}

/**
 * Er uttrykket STRENGT tenant-avgrenset? En konjunksjon (AND) er avgrenset hvis minst ett ledd er `tenant_id = current_setting('jarvis.tenant_id', ...)`;
 * en disjunksjon (OR) er kun avgrenset hvis ALLE grenene er det (`tenant_id = ... OR true` er derfor aldri avgrenset). Parenteser pakkes ut først.
 */
export function isTenantScoped(expr: string | null, setting: string = DEFAULT_LINT_CONFIG.tenantSetting): boolean {
  if (expr === null) return false;
  const atoms = settingAtom(setting);
  const check = (e: string): boolean => {
    const s = stripOuterParens(e);
    if (s === "") return false;
    const ors = splitTopLevel(s, "OR");
    if (ors.length > 1) return ors.every(check);
    const ands = splitTopLevel(s, "AND");
    return ands.some((term) => {
      const t = stripOuterParens(term);
      return atoms.some((a) => a.test(t));
    });
  };
  return check(expr);
}

export function referencesSetting(expr: string | null, settings: readonly string[]): boolean {
  return expr !== null && settings.some((s) => expr.includes(`current_setting('${s}'`));
}

export function isLiteralTrue(expr: string | null): boolean {
  return expr !== null && stripOuterParens(expr).toLowerCase() === "true";
}

// --- reglene -----------------------------------------------------------------------------------------------------------------------------

const COMMANDS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

function covers(p: CatalogPolicy, cmd: (typeof COMMANDS)[number]): boolean {
  return p.command === "ALL" || p.command === cmd;
}

export function lintCatalog(input: LintInput): Violation[] {
  const cfg: LintConfig = { ...DEFAULT_LINT_CONFIG, ...(input.config ?? {}) };
  const { catalog, classes } = input;
  const out: Violation[] = [];
  const add = (rule: string, table: string | null, detail: string, message: string): void => {
    out.push({ rule, table, detail, message });
  };

  // Rollen appen kjører som: aldri superuser/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION, ikke eier, kan ikke lage objekter i public.
  const role = catalog.runtimeRoleRecord;
  const flagsOf = (r: CatalogRole): string[] =>
    [r.superuser ? "SUPERUSER" : "", r.bypassRls ? "BYPASSRLS" : "", r.createDb ? "CREATEDB" : "", r.createRole ? "CREATEROLE" : "", r.replication ? "REPLICATION" : ""].filter((f) => f !== "");
  if (role === null) {
    add("runtime_role_unsafe", null, `${cfg.runtimeRole}:missing`, `Runtime-rollen ${cfg.runtimeRole} finnes ikke i databasen (005_rls.sql skal opprette den).`);
  } else {
    for (const r of [role, ...catalog.runtimeMembers]) {
      const flags = flagsOf(r);
      if (flags.length > 0) add("runtime_role_unsafe", null, `${r.name}:${flags.join(",")}`, `Runtime-rollen ${r.name} har ${flags.join("/")} - RLS omgås eller rollen kan utvide egne rettigheter.`);
    }
    // FORELDRE (K2 «ingen BYPASSRLS som runtime»): en sesjon som er medlem av en BYPASSRLS-/superuser-rolle kan `SET ROLE` til den (også ved NOINHERIT) og omgå RLS.
    // I tillegg default deny: hver forelder må stå i manifestets allowlist (tom i dag) - predefinerte roller (pg_read_all_data, pg_execute_server_program, ...) er også foreldre.
    const allowedParents = input.runtimeParentAllowlist ?? new Set<string>();
    for (const parent of catalog.runtimeParents) {
      const flags = flagsOf(parent);
      if (flags.length > 0) add("runtime_role_unsafe", null, `parent:${parent.name}:${flags.join(",")}`, `Runtime-rollen ${cfg.runtimeRole} (eller et medlem) er medlem av ${parent.name}, som har ${flags.join("/")}: en sesjon kan SET ROLE til den og omgå RLS.`);
      if (!allowedParents.has(parent.name)) add("runtime_parent_not_allowlisted", null, parent.name, `Runtime-rollen ${cfg.runtimeRole} (eller et medlem) er medlem av ${parent.name}, som ikke står i manifestets runtime_parent_allowlist (default deny): en forelder gir SET ROLE og arvede rettigheter.`);
    }
    for (const name of [...allowedParents].sort()) {
      if (!catalog.runtimeParents.some((p) => p.name === name)) add("runtime_parent_allowlist_stale", null, name, `runtime_parent_allowlist har ${name}, men runtime-rollen er ikke (lenger) medlem av den (allowlisten kan bare krympe: fjern oppføringen).`);
    }
  }
  if (catalog.runtimeCanCreateInPublic) add("runtime_create_in_public", null, cfg.runtimeRole, `${cfg.runtimeRole} kan opprette objekter i skjemaet public (eide objekter omgår FORCE RLS).`);
  if (catalog.runtimeCanCreateInDatabase) add("runtime_create_in_database", null, cfg.runtimeRole, `${cfg.runtimeRole} har CREATE på databasen (kan opprette egne skjemaer og objekter utenfor migrasjonenes kontroll).`);

  const columnsOf = new Map<string, CatalogColumn[]>();
  for (const c of catalog.columns) {
    const list = columnsOf.get(c.table) ?? [];
    list.push(c);
    columnsOf.set(c.table, list);
  }
  const privOf = new Map(catalog.tablePrivileges.map((p) => [p.table, p]));
  const policiesOf = new Map<string, CatalogPolicy[]>();
  for (const p of catalog.policies) {
    const list = policiesOf.get(p.table) ?? [];
    list.push(p);
    policiesOf.set(p.table, list);
  }
  const fksOf = new Map<string, CatalogForeignKey[]>();
  for (const fk of catalog.foreignKeys) {
    const list = fksOf.get(fk.table) ?? [];
    list.push(fk);
    fksOf.set(fk.table, list);
  }

  // `tenant_id` er forankret til `tenants` direkte, eller via en sammensatt FK (med `tenant_id` på samme posisjon) til en annen forankret tabell.
  const anchored = new Map<string, boolean>();
  const isAnchored = (table: string, seen: Set<string> = new Set()): boolean => {
    const known = anchored.get(table);
    if (known !== undefined) return known;
    if (seen.has(table)) return false;
    seen.add(table);
    let ok = false;
    for (const fk of fksOf.get(table) ?? []) {
      const at = fk.columns.indexOf("tenant_id");
      if (at === -1 || fk.refColumns[at] !== "tenant_id") continue;
      if (fk.refTable === "tenants" && fk.columns.length === 1) ok = true;
      else if (fk.refTable !== table && classes.get(fk.refTable)?.class === "ORG_OWNED" && isAnchored(fk.refTable, seen)) ok = true;
      if (ok) break;
    }
    anchored.set(table, ok);
    return ok;
  };

  for (const rel of catalog.relations) {
    const table = rel.name;
    if (rel.schema !== "public" || rel.kind !== "r") {
      add("unmanaged_relation", table, `${rel.schema}.${rel.name}:${rel.kind}`, `${rel.schema}.${rel.name} (relkind ${rel.kind}) er ikke en ordinær tabell i public - klassifiseringen har ingen modell for den (en visning eid av en superbruker omgår RLS).`);
      continue;
    }
    const info = classes.get(table);
    const priv = privOf.get(table);
    const cols = columnsOf.get(table) ?? [];
    const policies = policiesOf.get(table) ?? [];
    const hasTenantColumn = cols.some((c) => c.name === "tenant_id");

    if (rel.runtimeIsOwnerMember || rel.owner === cfg.runtimeRole) {
      add("owner_is_runtime", table, rel.owner, `${table} eies av ${rel.owner}, som runtime-rollen ${cfg.runtimeRole} er (medlem av): eieren omgår RLS uten FORCE og kan endre tabellen.`);
    }
    if (priv !== undefined) {
      const dangerous = [priv.truncate ? "TRUNCATE" : "", priv.trigger ? "TRIGGER" : "", priv.references || cols.some((c) => c.runtime.references) ? "REFERENCES" : ""].filter((p) => p !== "");
      if (dangerous.length > 0) add("app_dangerous_privilege", table, dangerous.join(","), `${cfg.runtimeRole} har ${dangerous.join("/")} på ${table}: TRUNCATE omgår RLS, REFERENCES gir et eksistensorakel på tvers av tenants, TRIGGER lar appen legge inn kode på tabellen.`);
    }
    for (const p of policies) {
      if (p.roles.every((r) => cfg.trustedPolicyRoles.has(r))) continue;
      for (const [where, expr] of [["using", p.using], ["check", p.withCheck]] as const) {
        if (isLiteralTrue(expr)) add("policy_true", table, `${p.name}:${where}`, `Policy ${table}.${p.name} (${p.command}, roller ${p.roles.join(",")}) har ${where === "using" ? "USING" : "WITH CHECK"} (true): ingen radavgrensning.`);
      }
    }
    if (info === undefined) continue;

    const runtimePermissive = policies.filter((p) => p.appliesToRuntime && p.permissive);
    const checkCommon = (): void => {
      if (!(rel.rlsEnabled && rel.rlsForced)) {
        add("rls_not_forced", table, `${rel.rlsEnabled ? "enabled" : "disabled"},${rel.rlsForced ? "forced" : "not-forced"}`, `${info.class}-tabellen ${table} må ha både ENABLE og FORCE ROW LEVEL SECURITY (nå ${rel.rlsEnabled ? "enabled" : "disabled"}/${rel.rlsForced ? "forced" : "ikke forced"}).`);
      }
      const missing = COMMANDS.filter((cmd) => !runtimePermissive.some((p) => covers(p, cmd)));
      if (missing.length > 0) add("policy_coverage_missing", table, missing.join(","), `${table} har ingen PERMISSIVE policy for ${cfg.runtimeRole} som dekker ${missing.join("/")} (SELECT/INSERT/UPDATE/DELETE kreves; en FOR ALL-policy dekker alle fire).`);
    };

    switch (info.class) {
      case "ORG_OWNED": {
        const tenantCol = cols.find((c) => c.name === "tenant_id");
        if (tenantCol === undefined) {
          add("org_no_tenant_id", table, "", `ORG_OWNED-tabellen ${table} har ingen tenant_id-kolonne.`);
        } else {
          if (!tenantCol.notNull) add("tenant_id_nullable", table, "", `${table}.tenant_id er ikke NOT NULL: en rad uten tenant er usynlig for alle policyer men kan likevel eksistere.`);
          if (table !== "tenants" && !isAnchored(table)) add("tenant_fk_missing", table, "", `${table}.tenant_id har ingen FK til tenants (direkte eller via sammensatt FK til en forankret ORG_OWNED-tabell).`);
          const indexed = catalog.indexes.some((i) => i.table === table && i.valid && !i.partial && !i.hasExpressions && i.method === "btree" && i.columns[0] === "tenant_id");
          if (!indexed) add("tenant_index_missing", table, "", `${table} har ingen gyldig btree-indeks med tenant_id som første kolonne (RLS-filteret gir seq-scan).`);
        }
        checkCommon();
        for (const p of runtimePermissive) {
          if (p.command !== "INSERT" && !isTenantScoped(p.using, cfg.tenantSetting)) add("policy_scope", table, `${p.name}:using`, `Policy ${table}.${p.name} (${p.command}): USING er ikke strengt tenant_id = current_setting('${cfg.tenantSetting}', ...): ${p.using ?? "(mangler)"}`);
          if (p.command === "ALL" || p.command === "INSERT" || p.command === "UPDATE") {
            if (p.withCheck === null) add("policy_with_check_missing", table, p.name, `Policy ${table}.${p.name} (${p.command}) mangler eksplisitt WITH CHECK.`);
            else if (!isTenantScoped(p.withCheck, cfg.tenantSetting)) add("policy_scope", table, `${p.name}:check`, `Policy ${table}.${p.name} (${p.command}): WITH CHECK er ikke strengt tenant_id = current_setting('${cfg.tenantSetting}', ...): ${p.withCheck}`);
          }
        }
        break;
      }
      case "USER_OWNED": {
        if (hasTenantColumn) add("user_has_tenant_id", table, "", `USER_OWNED-tabellen ${table} har en tenant_id-kolonne: en tenant-eid tabell er ORG_OWNED.`);
        checkCommon();
        for (const p of runtimePermissive) {
          if (p.command !== "INSERT" && !referencesSetting(p.using, [cfg.tenantSetting, "jarvis.person_id"])) add("user_policy_context", table, p.name, `Policy ${table}.${p.name}: USING refererer verken ${cfg.tenantSetting} eller jarvis.person_id.`);
        }
        break;
      }
      case "GLOBAL": {
        if (info.tenantPayload === null) {
          const markers = [
            ...cols.filter((c) => c.name === "tenant_id" || c.name === "person_id").map((c) => `column:${c.name}`),
            ...(fksOf.get(table) ?? []).filter((fk) => fk.refTable === "tenants" || fk.refTable === "people").map((fk) => `fk:${fk.refTable}`)
          ];
          const unique = [...new Set(markers)].sort();
          if (unique.length > 0) add("global_tenant_payload", table, unique.join(","), `GLOBAL-tabellen ${table} bærer tenant-nyttelast (${unique.join(", ")}). Bruk class ORG_OWNED/USER_OWNED, eller legg til tenant-payload="<begrunnelse>" (HF3 §17.2).`);
        }
        if (priv !== undefined) {
          const writes = [cols.some((c) => c.runtime.insert) || priv.insert ? "INSERT" : "", cols.some((c) => c.runtime.update) || priv.update ? "UPDATE" : "", priv.delete ? "DELETE" : ""].filter((p) => p !== "");
          if (writes.length > 0) add("global_app_write", table, writes.join(","), `GLOBAL-tabellen ${table} kan skrives av ${cfg.runtimeRole} (${writes.join("/")}): en skrivbar global tabell er en kryss-tenant-kanal; GLOBAL skal være skrivebeskyttet for appen.`);
        }
        break;
      }
      case "PLATFORM": {
        if (priv !== undefined) {
          const access = [
            priv.select || cols.some((c) => c.runtime.select) ? "SELECT" : "",
            priv.insert || cols.some((c) => c.runtime.insert) ? "INSERT" : "",
            priv.update || cols.some((c) => c.runtime.update) ? "UPDATE" : "",
            priv.delete ? "DELETE" : ""
          ].filter((p) => p !== "");
          if (access.length > 0) add("platform_app_access", table, access.join(","), `PLATFORM-tabellen ${table} er tilgjengelig for ${cfg.runtimeRole} (${access.join("/")}): en PLATFORM-tabell skal ikke kunne leses eller skrives av tenant-appen.`);
        }
        break;
      }
    }
  }

  // SECURITY DEFINER: default deny + eksplisitt allowlist, og de samme minste-privilegium-invariantene som A-testen i remediation-2.
  const seenDefiners = new Set<string>();
  for (const fn of catalog.functions) {
    if (!fn.securityDefiner) continue;
    seenDefiners.add(fn.signature);
    if (!input.definerAllowlist.has(fn.signature)) add("definer_not_allowlisted", null, fn.signature, `SECURITY DEFINER-funksjonen ${fn.signature} står ikke på allowlisten (default deny). Legg til \`-- jarvis-definer: ${fn.signature} reason="..."\` i migrasjonen som lager den.`);
    if (fn.owner !== cfg.definerRole) add("definer_owner_unexpected", null, fn.signature, `${fn.signature} eies av ${fn.owner}, ikke ${cfg.definerRole}: definer_access i manifestet beskriver kun ${cfg.definerRole} sin tilgang, så en annen eier ville hatt ulintede rettigheter.`);
    if (fn.ownerIsSuperuser || fn.ownerBypassRls) add("definer_owner_privileged", null, fn.signature, `${fn.signature} eies av ${fn.owner} (superuser/BYPASSRLS): en DEFINER-funksjon må eies av en rolle med minst mulig rettigheter.`);
    const sp = fn.config.find((c) => c.startsWith("search_path="));
    const parts = sp === undefined ? [] : sp.slice("search_path=".length).split(",").map((s) => s.trim());
    if (parts[0] !== "pg_catalog" || parts[parts.length - 1] !== "pg_temp") add("definer_search_path", null, fn.signature, `${fn.signature} har ikke låst search_path (forventet pg_catalog først og pg_temp sist, fant ${sp ?? "ingen"}).`);
    if (fn.publicExecute) add("definer_public_execute", null, fn.signature, `${fn.signature} har EXECUTE for PUBLIC: REVOKE ALL ... FROM PUBLIC og GRANT kun til nødvendige roller.`);
  }
  // DEFINER-rollens tilgang: alt jarvis_definer har (GRANT og policyer `TO jarvis_definer`) må stå i den frosne listen, og listen kan bare krympe (foreldede oppføringer feiler).
  const listedAccess = input.definerAccess ?? {};
  const actualAccess = new Map(catalog.definerAccess.map((a) => [a.table, a] as const));
  const accessItems = (a: { readonly privileges: readonly string[]; readonly policies: readonly string[] } | undefined): Set<string> =>
    new Set([...(a?.privileges ?? []).map((x) => `priv:${x}`), ...(a?.policies ?? []).map((x) => `policy:${x}`)]);
  for (const table of [...new Set([...Object.keys(listedAccess), ...actualAccess.keys()])].sort()) {
    const have = accessItems(actualAccess.get(table));
    const want = accessItems(listedAccess[table]);
    for (const item of [...have].sort()) {
      if (!want.has(item)) add("definer_access_unlisted", table, item, `${cfg.definerRole} har ${item} på ${table}, men det står ikke i manifestets definer_access (nye GRANT/policyer til ${cfg.definerRole} utvider blast radius for DEFINER-funksjonene og krever en eksplisitt, pinned endring).`);
    }
    for (const item of [...want].sort()) {
      if (!have.has(item)) add("definer_access_stale", table, item, `definer_access lister ${item} på ${table}, men ${cfg.definerRole} har ikke (lenger) akkurat det (listen kan bare krympe: fjern eller rett oppføringen).`);
    }
  }
  for (const sig of input.definerAllowlist) {
    if (!seenDefiners.has(sig)) add("definer_allowlist_stale", null, sig, `Allowlisten har ${sig}, men databasen har ingen SECURITY DEFINER-funksjon med den signaturen (allowlisten kan bare krympe: fjern oppføringen).`);
  }
  return out;
}

// --- baseline-unntak ----------------------------------------------------------------------------------------------------------------------

export interface ReconcileResult {
  /** Brudd som ikke dekkes av et baseline-unntak. */
  readonly unexpected: Violation[];
  /** Baseline-unntak som ikke lenger har et brudd (skal fjernes: baseline kan bare krympe). */
  readonly stale: BaselineException[];
  /** Kjente brudd (med unntak). */
  readonly known: Array<{ violation: Violation; exception: BaselineException }>;
}

/** Matcher faktiske brudd mot manifestets unntak (eksakt regel + tabell + detalj). Kun tabellspesifikke katalogregler kan ha unntak. */
export function reconcileExceptions(violations: readonly Violation[], exceptions: readonly BaselineException[]): ReconcileResult {
  const byKey = new Map(exceptions.map((e) => [exceptionKey(e.rule, e.table, e.detail), e] as const));
  const used = new Set<string>();
  const unexpected: Violation[] = [];
  const known: ReconcileResult["known"] = [];
  for (const v of violations) {
    const key = exceptionKey(v.rule, v.table ?? "", v.detail === "" ? undefined : v.detail);
    const ex = v.table !== null && EXCEPTION_ELIGIBLE_RULES.has(v.rule) ? byKey.get(key) : undefined;
    if (ex === undefined) {
      unexpected.push(v);
    } else {
      used.add(key);
      known.push({ violation: v, exception: ex });
    }
  }
  const stale = exceptions.filter((e) => !used.has(exceptionKey(e.rule, e.table, e.detail)));
  return { unexpected, stale, known };
}
