/**
 * WP-PGA fiks 1 (M4, M5): FROSSEDE vaktregler i kode (samme prinsipp som `BASELINE_ORIGIN`): en endring her er en bevisst, synlig endring i kildekoden som krever en navngitt beslutning, aldri noe en
 * datafil kan gjøre stille. Ren modul (ingen filsystem, ingen kjøretidsimport; ikke eksportert fra `@jarvis/contracts`-barrelen).
 */
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
