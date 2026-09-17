/**
 * UA-10 P1 host-akseptanse (D-160 I): REN, importerbar vurdering av
 * `schema_migrations`-tilstanden mot det UA-10 faktisk trenger.
 *
 * Host-funn run_id `2105bb7d` (2026-09-17): den opprinnelige harnessen feilet
 * `ua10_migration_057_applied` fordi den krevde at INGEN prefiks i HELE
 * `schema_migrations` hadde count > 1. Migratoren (`modules/core/src/db/
 * migrator.ts`) nøkler på EKSAKT filnavn - aldri prefiks - og hopper over
 * rader den ikke kjenner. Historiske rader fra filnavn som ikke lenger finnes
 * i repoet (f.eks. `014_pgvector_embeddings.sql`, lagt til og fjernet samme
 * dag 2026-08-13; `023_zendesk_support.sql` fra den ikke-mergede Zendesk-
 * branchen 2026-08-18) er derfor LEGITIM, migrator-støttet tilstand - ikke en
 * kollisjon. En EKTE kollisjon er kun når to filer i repoets migrasjonsmappe
 * deler prefiks (migratoren ville anvendt begge), eller når 055/056/057 selv
 * har mer enn én rad / manglende rad / feil rekkefølge.
 *
 * Kun Node-builtins/ingen avhengigheter - kan enhetstestes uten database.
 */
export interface SchemaMigrationRow {
  name: string;
  applied_at: string | Date;
}

export interface MigrationEvidence {
  /** 055/056/057 finnes nøyaktig én gang hver, i anvendt rekkefølge - og repoets mappe har unike prefikser. */
  ok: boolean;
  required_present: string[];
  required_missing: string[];
  /** Rader i `schema_migrations` med prefiks 055/056/057 som IKKE er de tre forventede navnene (ekte UA-10-kollisjon). */
  required_prefix_collisions: string[];
  applied_in_order: boolean;
  /** Prefikser i repoets migrasjonsmappe som deles av >1 fil (migratoren ville anvendt begge - ekte kollisjon). */
  repo_prefix_collisions: string[];
  /** Historiske prefiks-duplikater i `schema_migrations` (observabilitet - ikke en UA-10-feil). `prefix:name1,name2`. */
  historical_prefix_duplicates: string[];
  /** Rader i `schema_migrations` hvis navn ikke finnes i repoets mappe (migratoren ignorerer dem). */
  orphan_rows: string[];
}

export const UA10_REQUIRED_MIGRATIONS = ["055_vision.sql", "056_situations.sql", "057_situations_activation.sql"] as const;

const prefixOf = (name: string): string => name.slice(0, 3);

export function evaluateMigrationEvidence(rows: SchemaMigrationRow[], repoFiles: string[]): MigrationEvidence {
  const byName = new Map(rows.map((r) => [r.name, r] as const));
  const required_present = UA10_REQUIRED_MIGRATIONS.filter((n) => byName.has(n));
  const required_missing = UA10_REQUIRED_MIGRATIONS.filter((n) => !byName.has(n));
  const requiredPrefixes = new Set(UA10_REQUIRED_MIGRATIONS.map(prefixOf));
  const required_prefix_collisions = rows
    .map((r) => r.name)
    .filter((n) => requiredPrefixes.has(prefixOf(n)) && !(UA10_REQUIRED_MIGRATIONS as readonly string[]).includes(n))
    .sort();
  const times = UA10_REQUIRED_MIGRATIONS.map((n) => {
    const row = byName.get(n);
    return row ? new Date(row.applied_at).getTime() : Number.NaN;
  });
  const applied_in_order =
    required_missing.length === 0 && times.every((t) => Number.isFinite(t)) && times[0]! <= times[1]! && times[1]! <= times[2]!;

  const repoByPrefix = new Map<string, string[]>();
  for (const f of repoFiles) repoByPrefix.set(prefixOf(f), [...(repoByPrefix.get(prefixOf(f)) ?? []), f]);
  const repo_prefix_collisions = [...repoByPrefix.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([p, files]) => `${p}:${[...files].sort().join(",")}`)
    .sort();

  const rowsByPrefix = new Map<string, string[]>();
  for (const r of rows) rowsByPrefix.set(prefixOf(r.name), [...(rowsByPrefix.get(prefixOf(r.name)) ?? []), r.name]);
  const historical_prefix_duplicates = [...rowsByPrefix.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([p, names]) => `${p}:${[...names].sort().join(",")}`)
    .sort();

  const repoSet = new Set(repoFiles);
  const orphan_rows = rows.map((r) => r.name).filter((n) => !repoSet.has(n)).sort();

  const ok =
    required_missing.length === 0 &&
    required_prefix_collisions.length === 0 &&
    applied_in_order &&
    repo_prefix_collisions.length === 0;
  return {
    ok,
    required_present: [...required_present],
    required_missing: [...required_missing],
    required_prefix_collisions,
    applied_in_order,
    repo_prefix_collisions,
    historical_prefix_duplicates,
    orphan_rows
  };
}
