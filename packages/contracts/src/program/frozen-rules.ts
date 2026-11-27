/**
 * WP-PGA fiks 1 (M4, M5): FROSSEDE vaktregler i kode (samme prinsipp som `BASELINE_ORIGIN`): en endring her er en bevisst, synlig endring i kildekoden som krever en navngitt beslutning, aldri noe en
 * datafil kan gjøre stille. Ren modul (ingen filsystem, ingen kjøretidsimport; ikke eksportert fra `@jarvis/contracts`-barrelen).
 */
import type { Manifest } from "./schema.ts";

export interface DynamicDdlAllowance {
  /** Migrasjonsfilen (NNN_navn.sql) som har dynamisk tabell-DDL. */
  file: string;
  /** Hvorfor den er dynamisk og hva den gjør med tabellene (kort, ærlig). */
  reason: string;
}

const allow = (file: string, reason: string): DynamicDdlAllowance => Object.freeze({ file, reason });

/**
 * ALLOWLIST for `migration_dynamic_ddl` (M4): filer med `EXECUTE` mot en streng med CREATE/ALTER/DROP TABLE som skanningen ikke kan se inni. RLS-hjelperne
 * (`EXECUTE format('ALTER TABLE %I ENABLE|FORCE ROW LEVEL SECURITY', t)`, repoets standardmønster for tenant-tabeller i 25 migrasjoner) er unntatt som EKSAKT mønster i `sql-schema.ts` og står ikke her.
 * Alt under er eksisterende, uforanderlige migrasjoner (append-only): listen er lukket. En NY migrasjon med dynamisk tabell-DDL gir et funn til den bevisst føres hit med en begrunnelse (og testen
 * `program-index-fix1-sql` krever at hver oppføring faktisk har slik DDL i repoet, så listen ikke råtner). Alle er endringer av begrensninger/kolonner på EKSISTERENDE tabeller; ingen oppretter eller
 * dropper en tabell, så tabellmengden (182) og eierskapet påvirkes ikke. Eiernes kvittering av disse filene er en kjent blindsone (dokumentert i runbooken).
 */
export const DYNAMIC_DDL_ALLOWLIST: readonly DynamicDdlAllowance[] = Object.freeze([
  allow("078_tenant_scope_fk_identity.sql", "Tenant-scope-FK: legger til UNIQUE- og FOREIGN KEY-begrensninger og dropper de gamle, dynamisk over en liste av (barn, forelder)-tabellpar. Endrer begrensninger, ikke tabellsettet."),
  allow("086_knowledge_space_aware.sql", "Dropper en eksisterende begrensning på knowledge_documents og knowledge_embeddings; navnet slås opp i pg_constraint ved kjøring. Endrer ikke tabellsettet."),
  allow("090_business_product_usage_churn.sql", "Erstatter CHECK-begrensningen på business_open_loops med en verdiliste bygd ved kjøring (string_agg). Ingen ny tabell."),
  allow("102_governance_provenance.sql", "Legger proveniens-kolonnene prov_* og tilhørende CHECK-begrensninger på en liste av eksisterende tabeller (flere eiere) via en løkke. Kjent blindsone: eierne har ikke kvittert filen."),
  allow("117_conversation_channels_expand.sql", "Dropper to eksisterende CHECK-begrensninger på conversation_channel_links; navnene slås opp ved kjøring. Endrer ikke tabellsettet."),
  allow("128_health_intake.sql", "Dropper en eksisterende begrensning på health_metric_observations; navnet slås opp i pg_constraint ved kjøring. Endrer ikke tabellsettet."),
  allow("135_vision_embeddings_inventory.sql", "Dropper en eksisterende begrensning på memory_vectors; navnet slås opp i pg_constraint ved kjøring. Endrer ikke tabellsettet."),
  allow("137_vision_opening_event.sql", "Dropper en eksisterende begrensning på vision_event_observations; navnet slås opp i pg_constraint ved kjøring. Endrer ikke tabellsettet."),
  allow("142_comms_journal_integrity.sql", "Dropper, legger til og validerer en CHECK-begrensning på memory_space_id over en liste av comms-tabeller via en løkke. Endrer begrensninger, ikke tabellsettet.")
]);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// M5: MINIMUMSREGLENE for manifestet (`config/program/manifest.json`). Manifestet er en datafil som hvem som helst kan redigere stille; uten et gulv kunne en regel slås av (mønsteret byttet ut, prefikset
// fjernet, dekningsroten krympet) uten at noen test ble rød (reviewerens data-mutanter D1-D5). `manifestWeakenings` sammenligner manifestet med dette gulvet: å STRAMME inn (ekstra regler, prefikser, røtter)
// er fritt, å SVEKKE (fjerne, endre mønster, gjøre mer tillatende, legge til unntak) gir en melding. Gulvet endres bare i kildekoden, med en navngitt beslutning.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface MinimumException {
  table: string;
  owner: string;
}
export interface MinimumExclusiveRule {
  id: string;
  pattern: string;
  allowed_owner_patterns: readonly string[];
  exceptions: readonly MinimumException[];
}
export interface MinimumReservedPrefix {
  prefix: string;
  owner_patterns: readonly string[];
}

/** Dyp frysing (objekter og lister), så en importerende modul ikke kan svekke gulvet i kjøretid. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export const MANIFEST_MINIMUMS = deepFreeze({
  workspace_roots: ["apps", "modules", "packages"],
  migrations_dir: "modules/core/src/db/migrations",
  compose_file: "infra/local/docker-compose.yml",
  contract_roots: ["packages/contracts/src"],
  exclusive_names: [
    {
      id: "single-capability-registry",
      pattern: "(^|_)(skills?|capabilit(y|ies))_(registry|registries|register)($|_)",
      allowed_owner_patterns: ["^ev\\.capability-registry$"],
      exceptions: []
    },
    {
      id: "jx-truth-stores",
      pattern: "^(commitments?|impacts?|knowledge_gaps?|workspaces?)(_|$)",
      allowed_owner_patterns: ["^jx\\."],
      // Den ene eksisterende «commitment»-tabellen (Q til eier: absorbere, omdøpe eller akseptere med en D-begrunnelse før JX bygges).
      exceptions: [{ table: "commitments", owner: "core.memory" }]
    }
  ] as MinimumExclusiveRule[],
  reserved_prefixes: [
    { prefix: "ci_", owner_patterns: ["^ci\\."] },
    { prefix: "program_", owner_patterns: ["^program\\."] },
    { prefix: "diagnostic_", owner_patterns: ["^dx\\."] },
    { prefix: "fault_", owner_patterns: ["^dx\\."] },
    { prefix: "known_fault", owner_patterns: ["^dx\\."] },
    { prefix: "runtime_baseline", owner_patterns: ["^dx\\."] },
    { prefix: "incident_edge", owner_patterns: ["^dx\\."] }
  ] as MinimumReservedPrefix[],
  no_active_state: {
    table_prefix: "ci_",
    forbidden_literal_pattern: "active",
    forbidden_column_pattern: "^(active|is_active|activated|activated_at|activation[a-z_]*)$"
  }
});

const sameSet = (a: readonly string[], b: readonly string[]): boolean => [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

/**
 * Hva i manifestet som SVEKKER minimumsreglene (tom liste = ok). Å legge til regler, prefikser og røtter er å stramme inn og er fritt; å fjerne en minimumsregel, endre mønsteret eller de tillatte eierne,
 * legge til et unntak eller krympe dekningsrotene er en svekkelse. Brukes av repo-testen og de rene enhetstestene (data-mutantene D1-D5).
 */
export function manifestWeakenings(manifest: Manifest): string[] {
  const out: string[] = [];
  const cov = manifest.coverage;
  for (const root of MANIFEST_MINIMUMS.workspace_roots) if (!cov.workspace_roots.includes(root)) out.push(`coverage.workspace_roots mangler «${root}»`);
  for (const root of MANIFEST_MINIMUMS.contract_roots) if (!cov.contract_roots.includes(root)) out.push(`coverage.contract_roots mangler «${root}»`);
  if (cov.migrations_dir !== MANIFEST_MINIMUMS.migrations_dir) out.push(`coverage.migrations_dir er endret (skal være ${MANIFEST_MINIMUMS.migrations_dir})`);
  if (cov.compose_file !== MANIFEST_MINIMUMS.compose_file) out.push(`coverage.compose_file er endret (skal være ${MANIFEST_MINIMUMS.compose_file})`);
  for (const min of MANIFEST_MINIMUMS.exclusive_names) {
    const rule = manifest.exclusive_names.find((r) => r.id === min.id);
    if (rule === undefined) {
      out.push(`exclusive_names «${min.id}» mangler`);
      continue;
    }
    if (rule.pattern !== min.pattern) out.push(`exclusive_names «${min.id}»: mønsteret er endret (skal være ${min.pattern})`);
    if (!sameSet(rule.allowed_owner_patterns, min.allowed_owner_patterns)) out.push(`exclusive_names «${min.id}»: de tillatte eiere (allowed_owner_patterns) er endret`);
    const extra = (rule.exceptions ?? []).filter((e) => !min.exceptions.some((m) => m.table === e.table && m.owner === e.owner));
    if (extra.length > 0) out.push(`exclusive_names «${min.id}»: nye unntak (${extra.map((e) => `${e.table} hos ${e.owner}`).join(", ")}) er ikke tillatt uten at minimumsreglene endres i kildekoden`);
  }
  for (const min of MANIFEST_MINIMUMS.reserved_prefixes) {
    const rule = manifest.reserved_prefixes.find((r) => r.prefix === min.prefix);
    if (rule === undefined) out.push(`reserved_prefixes «${min.prefix}» mangler`);
    else if (!sameSet(rule.owner_patterns, min.owner_patterns)) out.push(`reserved_prefixes «${min.prefix}»: de tillatte eiere (owner_patterns) er endret`);
  }
  for (const key of ["table_prefix", "forbidden_literal_pattern", "forbidden_column_pattern"] as const) {
    if (manifest.no_active_state[key] !== MANIFEST_MINIMUMS.no_active_state[key]) out.push(`no_active_state.${key} er endret (skal være ${MANIFEST_MINIMUMS.no_active_state[key]})`);
  }
  return out;
}
