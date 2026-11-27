/**
 * WP-MC8a: katalog-øyeblikksbilde av et migrert skjema (kun lesing). Alle regler i `rules.ts` er rene funksjoner over denne strukturen, så de
 * kan kjøres både mot en ekte database og mot håndlagde øyeblikksbilder.
 */

/** Minimum av `pg.Pool`/`pg.Client`/`pg.PoolClient` katalogutdraget trenger (strukturelt: ingen `pg`-avhengighet i selve biblioteket). */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export type PolicyCommand = "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";

export interface CatalogRelation {
  readonly schema: string;
  readonly name: string;
  /** `r` ordinær tabell, `p` partisjonert, `v` visning, `m` mat. visning, `f` fremmed tabell. */
  readonly kind: string;
  readonly owner: string;
  readonly ownerIsSuperuser: boolean;
  readonly ownerBypassRls: boolean;
  /** Runtime-rollen er eieren eller medlem av eierrollen (arver eierskapets rettigheter). */
  readonly runtimeIsOwnerMember: boolean;
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
}

export interface CatalogColumn {
  readonly table: string;
  readonly position: number;
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  readonly generated: boolean;
  readonly identity: boolean;
  /** Effektiv kolonnerettighet for runtime-rollen (tabell- eller kolonne-GRANT, inkl. PUBLIC/arvede). */
  readonly runtime: { readonly select: boolean; readonly insert: boolean; readonly update: boolean; readonly references: boolean };
}

export interface CatalogTablePrivileges {
  readonly table: string;
  readonly select: boolean;
  readonly insert: boolean;
  readonly update: boolean;
  readonly delete: boolean;
  readonly truncate: boolean;
  readonly references: boolean;
  readonly trigger: boolean;
}

export interface CatalogPolicy {
  readonly table: string;
  readonly name: string;
  readonly permissive: boolean;
  readonly command: PolicyCommand;
  readonly roles: readonly string[];
  /** Policyen gjelder for runtime-rollen (PUBLIC, rollen selv eller en rolle den er medlem av). */
  readonly appliesToRuntime: boolean;
  readonly using: string | null;
  readonly withCheck: string | null;
}

export interface CatalogForeignKey {
  readonly table: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
}

export interface CatalogIndex {
  readonly table: string;
  readonly name: string;
  readonly unique: boolean;
  readonly primary: boolean;
  readonly valid: boolean;
  readonly partial: boolean;
  readonly hasExpressions: boolean;
  readonly method: string;
  /** Nøkkelkolonner i rekkefølge; en uttrykkskolonne er tom streng. */
  readonly columns: readonly string[];
}

export interface CatalogFunction {
  /** Kanonisk `regprocedure`-tekst, f.eks. `claim_next_task(text,integer,text[])`. */
  readonly signature: string;
  readonly schema: string;
  readonly owner: string;
  readonly ownerIsSuperuser: boolean;
  readonly ownerBypassRls: boolean;
  readonly securityDefiner: boolean;
  readonly config: readonly string[];
  readonly publicExecute: boolean;
  readonly runtimeExecute: boolean;
}

/** Tilgangen DEFINER-rollen (`jarvis_definer`) har til en tabell: kanonisk tekst per privilegium og per policy som lister rollen eksplisitt (se `extractCatalog`). */
export interface CatalogDefinerAccess {
  readonly table: string;
  /** Tabellprivilegier (`SELECT`, `DELETE`, ...) og kolonneprivilegier som ikke er dekket av tabellnivå (`UPDATE(kol1,kol2)`), sortert. */
  readonly privileges: readonly string[];
  /** Policyer med DEFINER-rollen i `TO`-listen: `navn|P|DELETE|using=<uttrykk eller ->|check=<uttrykk eller ->` (P = PERMISSIVE, R = RESTRICTIVE), sortert. */
  readonly policies: readonly string[];
}

export interface CatalogRole {
  readonly name: string;
  readonly canLogin: boolean;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  readonly createDb: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
}

export interface Catalog {
  readonly runtimeRole: string;
  /** Alle relasjoner utenfor systemskjemaene (ordinære tabeller, visninger, partisjoner, ...). */
  readonly relations: readonly CatalogRelation[];
  readonly columns: readonly CatalogColumn[];
  readonly tablePrivileges: readonly CatalogTablePrivileges[];
  readonly policies: readonly CatalogPolicy[];
  readonly foreignKeys: readonly CatalogForeignKey[];
  readonly indexes: readonly CatalogIndex[];
  readonly functions: readonly CatalogFunction[];
  /** Runtime-rollen (null hvis den ikke finnes) og alle roller som er medlem av den (transitivt). */
  readonly runtimeRoleRecord: CatalogRole | null;
  readonly runtimeMembers: readonly CatalogRole[];
  /**
   * FORELDRE: roller en runtime-sesjon kan nå OPPOVER (`pg_auth_members.member = runtime` eller et medlem av runtime, rekursivt, uavhengig av INHERIT/SET-valg):
   * en sesjon som er medlem av en BYPASSRLS-rolle kan `SET ROLE` til den og omgå RLS. Selve runtime-rollen og dens medlemmer er ikke med (de sjekkes for seg).
   */
  readonly runtimeParents: readonly CatalogRole[];
  readonly runtimeCanCreateInPublic: boolean;
  /** Runtime-rollen har CREATE på databasen (kan opprette egne skjemaer/objekter). */
  readonly runtimeCanCreateInDatabase: boolean;
  /** DEFINER-rollens (`jarvis_definer`) faktiske tilgang per tabell (kun tabeller der den har minst ett privilegium eller en policy). Blast radius for SECURITY DEFINER-funksjonene. */
  readonly definerRole: string;
  readonly definerAccess: readonly CatalogDefinerAccess[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const bool = (v: unknown): boolean => v === true;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x)) : []);

const POLICY_COMMANDS: Record<string, PolicyCommand> = { "*": "ALL", r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE" };

export interface ExtractOptions {
  readonly runtimeRole?: string;
  /** Rollen som eier SECURITY DEFINER-funksjonene (default `jarvis_definer`). */
  readonly definerRole?: string;
}

const squash = (expr: string | null): string => (expr === null ? "-" : expr.replace(/\s+/g, " ").trim());

/**
 * Leser katalogen. Utenfor `pg_catalog`/`information_schema`/toast/temp. Kun SELECT.
 * Utvidelses-eide RELASJONER er med (en utvidelse kan legge en visning/tabell i `public` som runtime-rollen får lese; reviewer T20): de lintes som alt annet.
 * Utvidelses-eide FUNKSJONER utelates (utvidelsens egen kode er ikke migrasjonenes SECURITY DEFINER-flate).
 */
export async function extractCatalog(db: Queryable, options: ExtractOptions = {}): Promise<Catalog> {
  const runtime = options.runtimeRole ?? "jarvis_app";
  const sysSchemas = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;
  const roleExists = (await db.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [runtime])).rows.length > 0;
  // Uten runtime-rolle kan has_*_privilege($1, ...) ikke kalles (feiler på ukjent rolle): bruk en rolle som aldri har rettigheter.
  const params: unknown[] = roleExists ? [runtime] : [];

  const relationRows = (
    await db.query(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, o.rolname::text AS owner, o.rolsuper AS owner_super, o.rolbypassrls AS owner_bypass,
              ${roleExists ? "pg_has_role($1::name, c.relowner, 'MEMBER')" : "false"} AS runtime_is_owner_member, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles o ON o.oid = c.relowner
        WHERE c.relkind IN ('r','p','v','m','f') AND ${sysSchemas}
        ORDER BY 1, 2`,
      params
    )
  ).rows;
  const relations: CatalogRelation[] = relationRows.map((r) => ({
    schema: str(r["schema"]),
    name: str(r["name"]),
    kind: str(r["kind"]),
    owner: str(r["owner"]),
    ownerIsSuperuser: bool(r["owner_super"]),
    ownerBypassRls: bool(r["owner_bypass"]),
    runtimeIsOwnerMember: bool(r["runtime_is_owner_member"]),
    rlsEnabled: bool(r["rls"]),
    rlsForced: bool(r["forced"])
  }));

  const priv = (fn: string, priv: string, col = false): string => (roleExists ? `${fn}($1::name, ${col ? "c.oid, a.attnum" : "c.oid"}, '${priv}')` : "false");
  const columnRows = (
    await db.query(
      `SELECT c.relname AS tbl, a.attnum AS position, a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, a.atthasdef AS has_default,
              (a.attgenerated <> '') AS generated, (a.attidentity <> '') AS identity,
              ${priv("has_column_privilege", "SELECT", true)} AS p_select, ${priv("has_column_privilege", "INSERT", true)} AS p_insert,
              ${priv("has_column_privilege", "UPDATE", true)} AS p_update, ${priv("has_column_privilege", "REFERENCES", true)} AS p_references
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped AND ${sysSchemas}
        ORDER BY 1, 2`,
      params
    )
  ).rows;
  const columns: CatalogColumn[] = columnRows.map((r) => ({
    table: str(r["tbl"]),
    position: num(r["position"]),
    name: str(r["name"]),
    type: str(r["type"]),
    notNull: bool(r["not_null"]),
    hasDefault: bool(r["has_default"]),
    generated: bool(r["generated"]),
    identity: bool(r["identity"]),
    runtime: { select: bool(r["p_select"]), insert: bool(r["p_insert"]), update: bool(r["p_update"]), references: bool(r["p_references"]) }
  }));

  const tablePrivRows = (
    await db.query(
      `SELECT c.relname AS tbl, ${priv("has_table_privilege", "SELECT")} AS sel, ${priv("has_table_privilege", "INSERT")} AS ins, ${priv("has_table_privilege", "UPDATE")} AS upd,
              ${priv("has_table_privilege", "DELETE")} AS del, ${priv("has_table_privilege", "TRUNCATE")} AS trunc, ${priv("has_table_privilege", "REFERENCES")} AS refs,
              ${priv("has_table_privilege", "TRIGGER")} AS trig
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND ${sysSchemas} ORDER BY 1`,
      params
    )
  ).rows;
  const tablePrivileges: CatalogTablePrivileges[] = tablePrivRows.map((r) => ({
    table: str(r["tbl"]),
    select: bool(r["sel"]),
    insert: bool(r["ins"]),
    update: bool(r["upd"]),
    delete: bool(r["del"]),
    truncate: bool(r["trunc"]),
    references: bool(r["refs"]),
    trigger: bool(r["trig"])
  }));

  const policyRows = (
    await db.query(
      `SELECT c.relname AS tbl, p.polname::text AS name, p.polpermissive AS permissive, p.polcmd::text AS cmd,
              ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE (SELECT rolname::text FROM pg_roles WHERE oid = r) END FROM unnest(p.polroles) r ORDER BY 1)::text[] AS roles,
              ${roleExists ? "(0 = ANY (p.polroles) OR EXISTS (SELECT 1 FROM unnest(p.polroles) r WHERE r <> 0 AND pg_has_role($1::name, r, 'MEMBER')))" : "(0 = ANY (p.polroles))"} AS applies,
              pg_get_expr(p.polqual, p.polrelid) AS using_expr, pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE ${sysSchemas} ORDER BY 1, 2`,
      params
    )
  ).rows;
  const policies: CatalogPolicy[] = policyRows.map((r) => ({
    table: str(r["tbl"]),
    name: str(r["name"]),
    permissive: bool(r["permissive"]),
    command: POLICY_COMMANDS[str(r["cmd"])] ?? "ALL",
    roles: strArray(r["roles"]),
    appliesToRuntime: bool(r["applies"]),
    using: r["using_expr"] === null ? null : str(r["using_expr"]),
    withCheck: r["check_expr"] === null ? null : str(r["check_expr"])
  }));

  // DEFINER-rollens tilgang (blast radius for SECURITY DEFINER-funksjonene): tabell- og kolonneprivilegier og policyer som lister rollen. Tomt hvis rollen ikke finnes.
  const definer = options.definerRole ?? "jarvis_definer";
  const definerExists = (await db.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [definer])).rows.length > 0;
  const access = new Map<string, { privileges: Set<string>; policies: Set<string> }>();
  const accessOf = (table: string): { privileges: Set<string>; policies: Set<string> } => {
    const have = access.get(table) ?? { privileges: new Set<string>(), policies: new Set<string>() };
    access.set(table, have);
    return have;
  };
  if (definerExists) {
    const tablePrivs = (
      await db.query(
        `SELECT c.relname AS tbl, p.priv AS priv FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
          WHERE c.relkind IN ('r','p') AND ${sysSchemas} AND has_table_privilege($1::name, c.oid, p.priv) ORDER BY 1, 2`,
        [definer]
      )
    ).rows;
    const tableLevel = new Set(tablePrivs.map((r) => `${str(r["tbl"])}|${str(r["priv"])}`));
    for (const r of tablePrivs) accessOf(str(r["tbl"])).privileges.add(str(r["priv"]));
    const columnPrivs = (
      await db.query(
        `SELECT c.relname AS tbl, p.priv AS priv, a.attname::text AS col FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(priv)
          WHERE c.relkind IN ('r','p') AND ${sysSchemas} AND has_column_privilege($1::name, c.oid, a.attnum, p.priv) AND NOT has_table_privilege($1::name, c.oid, p.priv)
          ORDER BY 1, 2, 3`,
        [definer]
      )
    ).rows;
    const byColumnGrant = new Map<string, string[]>();
    for (const r of columnPrivs) {
      const key = `${str(r["tbl"])}|${str(r["priv"])}`;
      if (tableLevel.has(key)) continue;
      byColumnGrant.set(key, [...(byColumnGrant.get(key) ?? []), str(r["col"])]);
    }
    for (const [key, cols] of byColumnGrant) {
      const [tbl, priv] = key.split("|") as [string, string];
      accessOf(tbl).privileges.add(`${priv}(${[...cols].sort().join(",")})`);
    }
  }
  for (const p of policies) {
    if (p.roles.includes(definer)) accessOf(p.table).policies.add(`${p.name}|${p.permissive ? "P" : "R"}|${p.command}|using=${squash(p.using)}|check=${squash(p.withCheck)}`);
  }
  const definerAccess: CatalogDefinerAccess[] = [...access]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([table, have]) => ({ table, privileges: [...have.privileges].sort(), policies: [...have.policies].sort() }));

  const fkRows = (
    await db.query(
      `SELECT t.relname AS tbl, c.conname::text AS name, rt.relname AS ref_tbl,
              ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS cols,
              ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS ref_cols
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_class rt ON rt.oid = c.confrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'f' AND ${sysSchemas} ORDER BY 1, 2`
    )
  ).rows;
  const foreignKeys: CatalogForeignKey[] = fkRows.map((r) => ({
    table: str(r["tbl"]),
    name: str(r["name"]),
    columns: strArray(r["cols"]),
    refTable: str(r["ref_tbl"]),
    refColumns: strArray(r["ref_cols"])
  }));

  const indexRows = (
    await db.query(
      `SELECT t.relname AS tbl, i.relname::text AS name, x.indisunique AS is_unique, x.indisprimary AS is_primary, x.indisvalid AS is_valid, (x.indpred IS NOT NULL) AS is_partial,
              (x.indexprs IS NOT NULL) AS has_expr, am.amname::text AS method,
              ARRAY(SELECT COALESCE(a.attname::text, '') FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord) LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
                     WHERE k.ord <= x.indnkeyatts ORDER BY k.ord)::text[] AS cols
         FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_am am ON am.oid = i.relam JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE ${sysSchemas} ORDER BY 1, 2`
    )
  ).rows;
  const indexes: CatalogIndex[] = indexRows.map((r) => ({
    table: str(r["tbl"]),
    name: str(r["name"]),
    unique: bool(r["is_unique"]),
    primary: bool(r["is_primary"]),
    valid: bool(r["is_valid"]),
    partial: bool(r["is_partial"]),
    hasExpressions: bool(r["has_expr"]),
    method: str(r["method"]),
    columns: strArray(r["cols"])
  }));

  const functionRows = (
    await db.query(
      `SELECT p.oid::regprocedure::text AS signature, n.nspname::text AS schema, o.rolname::text AS owner, o.rolsuper AS owner_super, o.rolbypassrls AS owner_bypass, p.prosecdef AS secdef,
              COALESCE(p.proconfig, '{}'::text[]) AS config, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              ${roleExists ? "has_function_privilege($1::name, p.oid, 'EXECUTE')" : "false"} AS runtime_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner
        WHERE ${sysSchemas} AND p.prokind IN ('f','p')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        ORDER BY 1`,
      params
    )
  ).rows;
  const functions: CatalogFunction[] = functionRows.map((r) => ({
    signature: str(r["signature"]),
    schema: str(r["schema"]),
    owner: str(r["owner"]),
    ownerIsSuperuser: bool(r["owner_super"]),
    ownerBypassRls: bool(r["owner_bypass"]),
    securityDefiner: bool(r["secdef"]),
    config: strArray(r["config"]),
    publicExecute: bool(r["public_exec"]),
    runtimeExecute: bool(r["runtime_exec"])
  }));

  const roleCols = "r.rolname::text AS name, r.rolcanlogin AS can_login, r.rolsuper AS super, r.rolbypassrls AS bypass, r.rolcreatedb AS create_db, r.rolcreaterole AS create_role, r.rolreplication AS repl";
  const toRole = (r: Record<string, unknown>): CatalogRole => ({
    name: str(r["name"]),
    canLogin: bool(r["can_login"]),
    superuser: bool(r["super"]),
    bypassRls: bool(r["bypass"]),
    createDb: bool(r["create_db"]),
    createRole: bool(r["create_role"]),
    replication: bool(r["repl"])
  });
  let runtimeRoleRecord: CatalogRole | null = null;
  let runtimeMembers: CatalogRole[] = [];
  let runtimeParents: CatalogRole[] = [];
  let runtimeCanCreateInPublic = false;
  let runtimeCanCreateInDatabase = false;
  if (roleExists) {
    const roleRows = (await db.query(`SELECT ${roleCols} FROM pg_roles r WHERE r.rolname = $1`, [runtime])).rows;
    runtimeRoleRecord = roleRows[0] === undefined ? null : toRole(roleRows[0]);
    // Rekursiv medlemsliste over pg_auth_members: `pg_has_role(superbruker, ...)` er alltid sant og ville gitt falske treff for `postgres`.
    const memberRows = (
      await db.query(
        `WITH RECURSIVE m(member) AS (
           SELECT am.member FROM pg_auth_members am WHERE am.roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
           UNION
           SELECT am.member FROM pg_auth_members am JOIN m ON am.roleid = m.member
         )
         SELECT ${roleCols} FROM pg_roles r WHERE r.oid IN (SELECT member FROM m) ORDER BY 1`,
        [runtime]
      )
    ).rows;
    runtimeMembers = memberRows.map(toRole);
    // Foreldre: oppover fra runtime-rollen OG fra alle medlemmene (innloggingsrollen er et medlem; den kan være medlem av en BYPASSRLS-rolle i tillegg).
    // Leser kun `member`/`roleid` (finnes i alle PG-versjoner): `inherit_option`/`set_option` (PG 16+) ignoreres med vilje - NOINHERIT og SET-only medlemskap teller også.
    const parentRows = (
      await db.query(
        `WITH RECURSIVE down(oid) AS (
           SELECT oid FROM pg_roles WHERE rolname = $1
           UNION
           SELECT am.member FROM pg_auth_members am JOIN down ON am.roleid = down.oid
         ), up(oid) AS (
           SELECT am.roleid FROM pg_auth_members am WHERE am.member IN (SELECT oid FROM down)
           UNION
           SELECT am.roleid FROM pg_auth_members am JOIN up ON am.member = up.oid
         )
         SELECT ${roleCols} FROM pg_roles r WHERE r.oid IN (SELECT oid FROM up) AND r.oid NOT IN (SELECT oid FROM down) ORDER BY 1`,
        [runtime]
      )
    ).rows;
    runtimeParents = parentRows.map(toRole);
    const schemaRows = (await db.query("SELECT has_schema_privilege($1::name, 'public', 'CREATE') AS can_create", [runtime])).rows;
    runtimeCanCreateInPublic = bool(schemaRows[0]?.["can_create"]);
    const databaseRows = (await db.query("SELECT has_database_privilege($1::name, current_database(), 'CREATE') AS can_create", [runtime])).rows;
    runtimeCanCreateInDatabase = bool(databaseRows[0]?.["can_create"]);
  }

  return { runtimeRole: runtime, relations, columns, tablePrivileges, policies, foreignKeys, indexes, functions, runtimeRoleRecord, runtimeMembers, runtimeParents, runtimeCanCreateInPublic, runtimeCanCreateInDatabase, definerRole: definer, definerAccess };
}
