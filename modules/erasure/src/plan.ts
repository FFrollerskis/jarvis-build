import type pg from "pg";
import type { ErasureScope } from "./scope.ts";
import { partitionSpaces, setSpaceContext, setTenantOnlyContext, tenantSpaces } from "./context.ts";

export interface KnowledgeIdentity {
  source_type: string;
  source_instance_id: string;
  external_id: string;
}

export interface ScopePlanResult {
  recordCounts: Record<string, number>;
  knowledgeIdentities: KnowledgeIdentity[];
}

type Mode = "count" | "delete";

function empty(): ScopePlanResult {
  return { recordCounts: {}, knowledgeIdentities: [] };
}

function add(target: ScopePlanResult, table: string, n: number): void {
  target.recordCounts[table] = (target.recordCounts[table] ?? 0) + n;
}

async function run(client: pg.PoolClient, mode: Mode, table: string, where: string, values: unknown[]): Promise<number> {
  if (mode === "count") {
    const r = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values);
    return (r.rows[0] as { n: number }).n;
  }
  const r = await client.query(`DELETE FROM ${table} WHERE ${where}`, values);
  return r.rowCount ?? 0;
}

/** Alle knowledge_documents-identiteter som matcher `where` - trengs FØR sletting for resurrection-protection-fingerprints (§5). */
async function gatherKnowledgeIdentities(client: pg.PoolClient, where: string, values: unknown[]): Promise<KnowledgeIdentity[]> {
  const r = await client.query(`SELECT source_type, source_instance_id, external_id FROM knowledge_documents WHERE ${where}`, values);
  return r.rows as KnowledgeIdentity[];
}

/**
 * WP-D1 (UA-2, migrasjon 087/088): alt som er AVLEDET av et sett kunnskapsdokumenter skal følge dem ut av systemet - ikke bare selve dokumentene:
 *  - `knowledge_links` (dokument <-> entitet),
 *  - `knowledge_entities` som ikke lenger har NOEN lenke igjen (navnene er hentet fra det slettede innholdet - en foreldreløs entitet ville latt et navn overleve sletting),
 *  - `claim_evidence` som peker på dokumentene (utdraget er kopiert fra dokumentet; påstanden selv beholdes, men leses alltid på nytt mot gjenværende evidens).
 * `docsWhere` er et WHERE-uttrykk mot `knowledge_documents` (uten alias). Kalles FØR embeddings/dokumenter slettes, i samme RLS-kontekst som dokumentslettingen.
 */
async function planDocumentDerivedRows(
  client: pg.PoolClient,
  mode: Mode,
  result: ScopePlanResult,
  docsWhere: string,
  values: unknown[]
): Promise<void> {
  const docIds = `SELECT knowledge_document_id FROM knowledge_documents WHERE ${docsWhere}`;
  const tenantAnd = `tenant_id = $1 AND knowledge_document_id IN (${docIds})`;
  if (mode === "count") {
    add(result, "knowledge_links", await run(client, mode, "knowledge_links", tenantAnd, values));
    // Foreldreløse etter slettingen = entiteter som har lenke til settet og ingen lenke utenfor det.
    const orphans = await client.query(
      `SELECT count(DISTINCT l.entity_id)::int AS n FROM knowledge_links l
        WHERE l.tenant_id = $1 AND l.knowledge_document_id IN (${docIds})
          AND NOT EXISTS (SELECT 1 FROM knowledge_links o WHERE o.tenant_id = l.tenant_id AND o.entity_id = l.entity_id
                            AND o.knowledge_document_id NOT IN (${docIds}))`,
      values
    );
    add(result, "knowledge_entities", (orphans.rows[0] as { n: number }).n);
    add(result, "claim_evidence", await run(client, mode, "claim_evidence", tenantAnd, values));
    return;
  }
  const candidates = await client.query(`SELECT DISTINCT entity_id FROM knowledge_links WHERE ${tenantAnd}`, values);
  const entityIds = (candidates.rows as Array<{ entity_id: string }>).map((r) => r.entity_id);
  add(result, "knowledge_links", await run(client, mode, "knowledge_links", tenantAnd, values));
  if (entityIds.length > 0) {
    const gone = await client.query(
      `DELETE FROM knowledge_entities e WHERE e.tenant_id = $1 AND e.entity_id = ANY($2::text[])
         AND NOT EXISTS (SELECT 1 FROM knowledge_links l WHERE l.tenant_id = e.tenant_id AND l.entity_id = e.entity_id)`,
      [values[0], entityIds]
    );
    add(result, "knowledge_entities", gone.rowCount ?? 0);
  }
  add(result, "claim_evidence", await run(client, mode, "claim_evidence", tenantAnd, values));
}

/** Ét memory_space (allerede satt som RLS-kontekst av kalleren) - alle tabeller filtrert direkte på (tenant_id, space). */
async function planMemorySpaceInContext(client: pg.PoolClient, mode: Mode, tenantId: string, space: string): Promise<ScopePlanResult> {
  const result = empty();
  const tv = [tenantId, space];
  const spaceCol = "space = $2";
  // D-386 Minne v2: memory_links (FK-kaskade fra memory_items, slettes likevel eksplisitt først), memory_vectors (polymorf,
  // ingen FK), memory_episodes (verbatim ytringer) og memory_profiles (kompilert profil) - alle (tenant_id, space)-skopet.
  for (const table of [
    "memory_links", "memory_vectors", "memory_episodes", "memory_profiles",
    "memory_versions", "memory_item_entities", "embeddings", "relations", "entities", "summaries", "decisions", "commitments", "deadlines", "memory_items"
  ]) {
    add(result, table, await run(client, mode, table, `tenant_id = $1 AND ${spaceCol}`, tv));
  }
  if (mode === "delete") {
    result.knowledgeIdentities.push(
      ...(await gatherKnowledgeIdentities(client, "tenant_id = $1 AND memory_space_id = $2", tv))
    );
  }
  // WP-D1 (087/088): påstandsverifisering (evidens FØR påstand) og entitetsgrafen (lenker FØR entiteter og dokumenter) - alt (tenant_id, memory_space_id)-skopet.
  add(result, "claim_evidence", await run(client, mode, "claim_evidence", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "claim_verifications", await run(client, mode, "claim_verifications", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "knowledge_links", await run(client, mode, "knowledge_links", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "knowledge_entities", await run(client, mode, "knowledge_entities", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "knowledge_embeddings", await run(client, mode, "knowledge_embeddings", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "knowledge_documents", await run(client, mode, "knowledge_documents", "tenant_id = $1 AND memory_space_id = $2", tv));
  // UA-3 Native Jarvis Support Core (D-66) §21 i byggeordren: registrer
  // support-tabellene i erasure-planen (samme mønster som knowledge_*
  // over). Kjent, dokumentert begrensning (ikke stille utelatt - se
  // OPEN_QUESTIONS.md Q-25 punkt 9/D-66): øvrige `business_*`-tabeller
  // (companies/contacts/leads/opportunities/activities/followups) er
  // FORTSATT ikke registrert i erasure-planen i det hele tatt - dette er en
  // PRE-EKSISTERENDE gap fra P0 (uendret av denne sliceen), IKKE noe denne
  // ordren introduserer eller utvider.
  //
  // HOST FIX #1 (D-67, ekte host-funn run_id 60f0d682/5457c59a):
  // `business_open_loops.ticket_id` (024_support.sql) peker til
  // `support_tickets` - en support-tilknyttet open-loop-rad blokkerte
  // FAKTISK sletting av ticketen med
  // "business_open_loops_ticket_id_fkey"-FK-brudd. Løsning (§8 i
  // byggeordren): en support-tilknyttet open-loop er REN DERIVERT
  // operasjonell state (auto-gjenkjennes/auto-resolves hver sveip, se
  // OpenLoopService.runSweep()) - Jarvis skal ALDRI beholde en
  // "hengende" derivert rad som peker til en ticket som ikke lenger
  // finnes. Slettes derfor FØRST, SNEVERT avgrenset til
  // `ticket_id IS NOT NULL` (rører ALDRI andre loop_type-er som
  // `overdue_followup`/`stalled_opportunity` - generell
  // business_open_loops-erasure er FORTSATT IKKE registrert her, samme
  // pre-eksisterende gap som over). Ny, snever `GRANT DELETE ON
  // business_open_loops` lagt til i `025_business_open_loops_ticket_grant.sql`
  // (egen migrasjon - IKKE en redigering av allerede kjørte 020/024, som
  // ville latt Tobias sin eksisterende host-database mangle GRANTen
  // permanent siden `schema_migrations` aldri kjører en anvendt fil om
  // igjen).
  add(
    result,
    "business_open_loops",
    await run(client, mode, "business_open_loops", "tenant_id = $1 AND memory_space_id = $2 AND ticket_id IS NOT NULL", tv)
  );
  // `support_ticket_events` FØR `support_tickets` (FK -> support_tickets).
  add(result, "support_ticket_events", await run(client, mode, "support_ticket_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "support_tickets", await run(client, mode, "support_tickets", "tenant_id = $1 AND memory_space_id = $2", tv));
  // UA-3 Native Jarvis Contracts Core (D-71, 026_contracts.sql): registrer
  // kontrakt-tabellene i erasure-planen (SAMME mønster/begrunnelse som
  // support_* over - Q-28). En kontrakt-tilknyttet open-loop (samme
  // FK-lærdom som HOST FIX #1/D-67 for `ticket_id`) slettes FØRST, SNEVERT
  // avgrenset til `contract_id IS NOT NULL` (rører aldri andre loop_type-er).
  add(
    result,
    "business_open_loops",
    await run(client, mode, "business_open_loops", "tenant_id = $1 AND memory_space_id = $2 AND contract_id IS NOT NULL", tv)
  );
  // `contract_events`/`contract_obligations`/`contract_versions` FØR
  // `contracts` (alle tre har en direkte FK -> contracts, ingen FK seg imellom).
  add(result, "contract_events", await run(client, mode, "contract_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "contract_obligations", await run(client, mode, "contract_obligations", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "contract_versions", await run(client, mode, "contract_versions", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "contracts", await run(client, mode, "contracts", "tenant_id = $1 AND memory_space_id = $2", tv));
  // UA-3 Native Jarvis Product Core (D-128, 047_product.sql): registrer
  // produkt-tabellene i erasure-planen (SAMME mønster/begrunnelse som
  // support_*/contract_* over). En produkt-tilknyttet open-loop slettes
  // FØRST, SNEVERT avgrenset til `product_item_id IS NOT NULL` (rører
  // aldri andre loop_type-er).
  add(
    result,
    "business_open_loops",
    await run(client, mode, "business_open_loops", "tenant_id = $1 AND memory_space_id = $2 AND product_item_id IS NOT NULL", tv)
  );
  // `product_item_events` FØR `product_items` (FK -> product_items).
  add(result, "product_item_events", await run(client, mode, "product_item_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "product_items", await run(client, mode, "product_items", "tenant_id = $1 AND memory_space_id = $2", tv));
  // WP-D2 (089_business_pipeline_writes.sql): før/etter-loggen for lead-/opportunity-endringer holder KOPIER av pipeline-radene (tittel, neste handling, lukkegrunn)
  // og er derfor KUNDEDATA som følger memory-space-slettingen (ikke append-only systemrevisjon som `audit_events`, som aldri får fritekst - se pipeline-service.ts
  // `inspect()`). Ingen FK inn eller ut (løs entity_id-peker) - rekkefølgen er likegyldig. `jarvis_app` har DELETE kun for dette (089).
  add(result, "business_change_log", await run(client, mode, "business_change_log", "tenant_id = $1 AND memory_space_id = $2", tv));
  // UA-4 Native Jarvis Growth Core (D-74, 027_growth.sql): registrer
  // vekst-tabellene i erasure-planen (SAMME mønster/begrunnelse som
  // support_*/contract_* over).
  // D-87 (030_growth_execution_commands.sql): kommando-tabellen har en FK ->
  // BÅDE marketing_campaigns OG marketing_campaign_action_recommendations -
  // MÅ derfor slettes FØRST av HELE denne blokken (før BEGGE FK-målene under).
  add(
    result,
    "marketing_campaign_execution_commands",
    await run(client, mode, "marketing_campaign_execution_commands", "tenant_id = $1 AND memory_space_id = $2", tv)
  );
  // D-85 (029_growth_action_recommendations.sql): anbefaling-tabellen har en
  // FK -> business_open_loops.open_loop_id (nullable, men HÅNDHEVET når
  // satt) - MÅ derfor slettes FØR business_open_loops-raden under (motsatt
  // rekkefølge av HOST FIX #1/D-67 sitt "open-loop FØR eier"-mønster, fordi
  // her er retningen omvendt: business_open_loops er FK-MÅLET, ikke kilden).
  // Verifisert av en ekte FK-brudd-regresjon i growth-erasure.test.ts FØR
  // denne rekkefølgen ble rettet.
  add(
    result,
    "marketing_campaign_action_recommendations",
    await run(client, mode, "marketing_campaign_action_recommendations", "tenant_id = $1 AND memory_space_id = $2", tv)
  );
  // En kampanje-tilknyttet open-loop (samme FK-lærdom som HOST FIX #1/D-67
  // for `ticket_id`) slettes FØRST, SNEVERT avgrenset til `campaign_id IS
  // NOT NULL` (rører aldri andre loop_type-er).
  add(
    result,
    "business_open_loops",
    await run(client, mode, "business_open_loops", "tenant_id = $1 AND memory_space_id = $2 AND campaign_id IS NOT NULL", tv)
  );
  // `marketing_attributions`/`marketing_spend_events`/`marketing_campaign_events`/
  // `marketing_campaign_tracking_tags` (D-82) FØR `marketing_campaigns` (alle
  // fire har en direkte FK -> marketing_campaigns).
  // `marketing_experiments.campaign_id` er NULLABLE (et eksperiment kan stå
  // uten kampanje) - ingen FK-blokkering fra den siden, men slettes likevel
  // FØR marketing_campaigns for konsistens med de andre barnetabellene.
  add(result, "marketing_attributions", await run(client, mode, "marketing_attributions", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "marketing_spend_events", await run(client, mode, "marketing_spend_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "marketing_campaign_events", await run(client, mode, "marketing_campaign_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "marketing_campaign_tracking_tags", await run(client, mode, "marketing_campaign_tracking_tags", "tenant_id = $1 AND memory_space_id = $2", tv));
  // D-89 (031_growth_marketing_observations.sql): observasjon-tabellen har
  // KUN en FK -> marketing_campaigns (INGEN FK mot anbefalinger/kommandoer -
  // evidence.recommendation_ids/command_ids er LØSE jsonb-pekere, ALDRI en
  // hard FK) - samme barnetabell-tier som marketing_attributions/
  // marketing_spend_events over, slettes FØR marketing_campaigns.
  add(result, "marketing_campaign_observations", await run(client, mode, "marketing_campaign_observations", "tenant_id = $1 AND memory_space_id = $2", tv));
  // WP-D3 (D-459, 112-114): plattform-skrivejournalen (komposittnøkkel -> marketing_campaigns; `marketing_campaign_execution_commands.execution_write_id` peker på den, og kommandoene er
  // slettet ALLEREDE først i denne blokken). Så eksperimentregisteret: utfall -> observasjoner -> varianter (komposittnøkler til eksperimentet og til kampanjen) -> planer, alle FØR
  // `marketing_experiments` og `marketing_campaigns`. Kundedata (ikke append-only systemrevisjon), samme klassifisering som resten av marketing_*.
  add(result, "growth_write_journal", await run(client, mode, "growth_write_journal", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "marketing_experiment_outcomes", await run(client, mode, "marketing_experiment_outcomes", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "marketing_experiment_observations", await run(client, mode, "marketing_experiment_observations", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "marketing_experiment_variants", await run(client, mode, "marketing_experiment_variants", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "marketing_experiment_plans", await run(client, mode, "marketing_experiment_plans", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "marketing_experiments", await run(client, mode, "marketing_experiments", "tenant_id = $1 AND memory_space_id = $2", tv));
  // UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2,
  // 039_finance_spend_integrity.sql): `finance_spend_records` har en FK ->
  // `marketing_campaigns` (valgfri kampanje-kobling for kildefamilien
  // 'marketing') - MÅ DERFOR slettes FØR `marketing_campaigns` under, IKKE
  // etter (i motsetning til `payment_intents`-blokken, som IKKE har noen FK
  // mot marketing_campaigns og derfor trygt kan stå etter). To nye utgifts-
  // tilknyttede open-loop-typer slettes FØRST, SNEVERT avgrenset til hver
  // sin nullable FK (rører aldri andre loop_type-er). `finance_spend_records`
  // har OGSÅ FK -> BÅDE `finance_recurring_commitments` OG
  // `finance_procurement_items` - MÅ derfor slettes FØR begge (motsatt
  // retning: `finance_procurement_items` har INGEN FK tilbake til
  // `finance_spend_records` - se migrasjonens toppkommentar for
  // begrunnelsen om å unngå en sirkulær FK). Denne rekkefølgen ble
  // OPPRINNELIG plassert FEIL (etter marketing_campaigns) - fanget av
  // `growth-erasure.test.ts` sin schema-drevne FK-audit (ekte
  // `information_schema`-spørring, ikke antatt), IKKE antatt riktig.
  add(
    result,
    "business_open_loops",
    await run(client, mode, "business_open_loops", "tenant_id = $1 AND memory_space_id = $2 AND finance_spend_record_id IS NOT NULL", tv)
  );
  add(
    result,
    "business_open_loops",
    await run(client, mode, "business_open_loops", "tenant_id = $1 AND memory_space_id = $2 AND finance_recurring_commitment_id IS NOT NULL", tv)
  );
  add(result, "finance_spend_records", await run(client, mode, "finance_spend_records", "tenant_id = $1 AND memory_space_id = $2", tv));
  // D-112 (UA-6 Slice 6, 043_wallester.sql): kortdomenet. MÅ slettes FØR
  // BÅDE `finance_recurring_commitments` OG `marketing_campaigns` under -
  // `provider_cards.commitment_id`/`campaign_id` og
  // `card_transactions.matched_commitment_id` har alle en direkte FK mot
  // dem (fanget av `growth-erasure.test.ts` sin schema-drevne FK-audit,
  // IKKE antatt riktig - samme lærdom som `finance_spend_records`-
  // kommentaren over allerede dokumenterer for søsken-tabellen). Intern
  // avhengighets-rekkefølge: webhook_events/transactions -> authorizations
  // -> events/policies -> provider_cards (FK-kjede). §24-distinksjonen
  // (slettbar bruker-metadata vs finansielt revisjonsbevis): en TENANT-
  // SLETTING (Q-20, hele tenants livssyklus avsluttes) fjerner ALT -
  // retensjon av finansbevis for en LEVENDE tenant håndteres ved at
  // ingenting annet enn full tenant-erasure sletter
  // korttransaksjoner/hendelser.
  add(result, "wallester_webhook_events", await run(client, mode, "wallester_webhook_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "card_transactions", await run(client, mode, "card_transactions", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "card_authorizations", await run(client, mode, "card_authorizations", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "card_events", await run(client, mode, "card_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "card_spend_policies", await run(client, mode, "card_spend_policies", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "provider_cards", await run(client, mode, "provider_cards", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "finance_recurring_commitments", await run(client, mode, "finance_recurring_commitments", "tenant_id = $1 AND memory_space_id = $2", tv));
  // UA-6 closeout (D-115, 044_finance_procurement_openloop.sql):
  // `business_open_loops.finance_procurement_item_id` er en NY FK ->
  // `finance_procurement_items` - MÅ derfor slettes FØR, SAMME "barn-FK FØR
  // forelder"-regel/SNEVER avgrensning (rører aldri andre loop_type-er) som
  // `finance_recurring_commitment_id`-blokken over.
  add(
    result,
    "business_open_loops",
    await run(client, mode, "business_open_loops", "tenant_id = $1 AND memory_space_id = $2 AND finance_procurement_item_id IS NOT NULL", tv)
  );
  add(result, "finance_procurement_items", await run(client, mode, "finance_procurement_items", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "marketing_campaigns", await run(client, mode, "marketing_campaigns", "tenant_id = $1 AND memory_space_id = $2", tv));
  // UA-6 Finance & Spend Integrity Gateway (D-107, 038_finance.sql):
  // finans-domenet er KUNDEDATA (samme klasse som contracts/marketing_*),
  // registreres her - SAMME FK-lærdom som growth-blokken over. En
  // betalings-tilknyttet open-loop slettes FØRST, SNEVERT avgrenset til
  // `payment_intent_id IS NOT NULL` (rører aldri andre loop_type-er).
  add(
    result,
    "business_open_loops",
    await run(client, mode, "business_open_loops", "tenant_id = $1 AND memory_space_id = $2 AND payment_intent_id IS NOT NULL", tv)
  );
  // `payment_intent_events` har en FK -> payment_intents - MÅ slettes FØR.
  add(result, "payment_intent_events", await run(client, mode, "payment_intent_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  // WP-F1 (D-462, 100_finance_reconciliation.sql): avstemmingsfunn har en FK -> payment_intents OG -> finance_reconciliation_runs -
  // funnene MÅ slettes FØR både kjøringene og `payment_intents` ("barn-FK FØR forelder").
  add(result, "finance_reconciliation_findings", await run(client, mode, "finance_reconciliation_findings", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "finance_reconciliation_runs", await run(client, mode, "finance_reconciliation_runs", "tenant_id = $1 AND memory_space_id = $2", tv));
  // D-109 (UA-6 Slice 3, 040_stripe.sql): `stripe_webhook_events` og
  // `stripe_refunds` har BEGGE en FK -> `payment_intents` (payment_intent_id)
  // - SAMME "barn-FK FØR forelder"-regel som `payment_intent_events` over,
  // MÅ derfor også slettes FØR `payment_intents`. Ingen FK MELLOM de to
  // Stripe-tabellene selv, rekkefølgen dem imellom er derfor vilkårlig.
  add(result, "stripe_webhook_events", await run(client, mode, "stripe_webhook_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "stripe_refunds", await run(client, mode, "stripe_refunds", "tenant_id = $1 AND memory_space_id = $2", tv));
  // D-110 (UA-6 Slice 4, 041_vipps.sql): `vipps_webhook_events`/
  // `vipps_captures`/`vipps_refunds` har ALLE en FK -> `payment_intents` -
  // SAMME "barn-FK FØR forelder"-regel, MÅ slettes FØR `payment_intents`.
  // Ingen FK MELLOM de tre Vipps-tabellene selv.
  add(result, "vipps_webhook_events", await run(client, mode, "vipps_webhook_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "vipps_captures", await run(client, mode, "vipps_captures", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "vipps_refunds", await run(client, mode, "vipps_refunds", "tenant_id = $1 AND memory_space_id = $2", tv));
  // D-111 (UA-6 Slice 5, 042_neonomics.sql): bankdomenet. Avhengighets-
  // rekkefølge: balances/transactions -> accounts -> consents (FK-kjede);
  // neonomics_webhook_events har kun payment_intents-FK og slettes før
  // payment_intents (som allerede står SENERE i denne planen).
  add(result, "neonomics_webhook_events", await run(client, mode, "neonomics_webhook_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "bank_account_balances", await run(client, mode, "bank_account_balances", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "bank_transactions", await run(client, mode, "bank_transactions", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "bank_accounts", await run(client, mode, "bank_accounts", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "bank_consents", await run(client, mode, "bank_consents", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "payment_intents", await run(client, mode, "payment_intents", "tenant_id = $1 AND memory_space_id = $2", tv));
  // D-116 (UA-6 HARDENING, 045_finance_vendor_registry.sql): vendor-
  // identitetsregisteret. `payment_intents.vendor_id` er en FK ->
  // `finance_vendors` - `payment_intents` slettes derfor allerede FØR
  // (linjen over) `finance_vendors` kan slettes. `finance_vendor_provider_
  // bindings` har SIN EGEN FK -> `finance_vendors` (vendor_id) - SAMME
  // "barn-FK FØR forelder"-regel, MÅ derfor slettes FØR `finance_vendors`
  // her under. Ingen FK fra business_open_loops eller andre tabeller inn
  // til vendor-registeret (ingen forhåndsslettet open-loop-blokk nødvendig).
  add(result, "finance_vendor_provider_bindings", await run(client, mode, "finance_vendor_provider_bindings", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "finance_vendors", await run(client, mode, "finance_vendors", "tenant_id = $1 AND memory_space_id = $2", tv));
  // D-119 (UA-7 Communications Hub - foerste slice, 046_conversation_graph.sql):
  // `conversation_identity_merges` har FK -> `conversation_identities` (BÅDE
  // source_identity_id OG target_identity_id) - MÅ derfor slettes FØR
  // `conversation_identities` under. `conversation_channel_links` har SIN
  // EGEN FK -> `conversation_identities` (identity_id) - SAMME "barn-FK
  // FØR forelder"-regel, MÅ derfor OGSÅ slettes FØR `conversation_identities`.
  // Ingen FK MELLOM merges og links selv (`affected_link_ids` er en JSONB-
  // array, ALDRI en ekte fremmednøkkel - bevisst, se 046_conversation_
  // graph.sql sitt filhode), rekkefølgen dem imellom er derfor vilkårlig.
  // `conversation_identities.linked_business_contact_id`/`linked_person_id`
  // peker til `business_contacts`/`people` - SAMME pre-eksisterende gap som
  // consent_decisions-kommentaren under dokumenterer (`business_contacts`
  // er FORTSATT IKKE registrert i denne planen) - INGEN ordringskonflikt
  // i dag, men MÅ slettes FØR `business_contacts` dersom den noen gang
  // legges til.
  // WP-G1 (UA-7 resterende deler, D-463, 118_comms_outbound_policy.sql): kommunikasjonstabellene. `comms_inbound_events.identity_id` er en (tenant-sammensatt) FK -> `conversation_identities` -
  // `comms_inbound_events` MÅ derfor slettes FØR `conversation_identities` (under). Mottakers avmelding (`comms_recipient_opt_outs`) slettes også her: en full tenant-/rom-sletting fjerner ALT, også undertrykkelseslisten
  // (en eier som sletter hele rommet har ikke lenger noen avsender som kan sende dit). Øvrige comms_*-tabeller har ingen FK mellom seg.
  // Møtetranskripsjon (119_comms_meetings.sql): forpliktelser og deltakere (deltakerne har FK -> `conversation_identities`, så de MÅ slettes FØR identitetene) slettes før møtene.
  add(result, "comms_meeting_commitments", await run(client, mode, "comms_meeting_commitments", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "comms_meeting_participants", await run(client, mode, "comms_meeting_participants", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "comms_meetings", await run(client, mode, "comms_meetings", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "comms_inbound_events", await run(client, mode, "comms_inbound_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "comms_outbound_log", await run(client, mode, "comms_outbound_log", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "comms_recipient_opt_outs", await run(client, mode, "comms_recipient_opt_outs", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "comms_authorized_accounts", await run(client, mode, "comms_authorized_accounts", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "conversation_identity_merges", await run(client, mode, "conversation_identity_merges", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "conversation_channel_links", await run(client, mode, "conversation_channel_links", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "conversation_identities", await run(client, mode, "conversation_identities", "tenant_id = $1 AND memory_space_id = $2", tv));
  // D-91 (UA-4 NESTE SLICE, 032_consent_governance.sql): samtykke-
  // beslutnings-loggen har en FK -> business_contacts.contact_id - MEN
  // `business_contacts` er FORTSATT IKKE registrert i denne erasure-planen
  // i det hele tatt (samme PRE-EKSISTERENDE gap som business_open_loops-
  // kommentaren over dokumenterer, se Q-25 punkt 9). `consent_decisions`
  // slettes derfor her UAVHENGIG av kontakt-tabellen (INGEN FK-ordrings-
  // konflikt MED denne planen slik den er i dag) - MEN hvis
  // `business_contacts` noen gang legges til i denne planen, MÅ
  // `consent_decisions` slettes FØR den (FK-retningen krever det).
  add(result, "consent_decisions", await run(client, mode, "consent_decisions", "tenant_id = $1 AND memory_space_id = $2", tv));
  // D-92 (UA-4 NESTE SLICE, 033_consent_enforcement.sql): `consent_
  // enforcement_events` har SAMME FK-egenskap mot business_contacts som
  // consent_decisions over (samme pre-eksisterende business_contacts-gap,
  // ingen ordringskonflikt i dag). `consent_enforcement_policies` har
  // INGEN kontakt-FK i det hele tatt (ren tenant/space/formål-konfigurasjon,
  // ikke persondata) - registreres likevel her for konsistens: en HEL
  // memory-space-erasure fjerner ALT growth-/consent-relatert domene for
  // den space-en, og en gjenværende rollout-policy-rad for en nå-tom
  // space ville vært et meningsløst dinglende konfigurasjonsobjekt.
  add(result, "consent_enforcement_events", await run(client, mode, "consent_enforcement_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "consent_enforcement_policies", await run(client, mode, "consent_enforcement_policies", "tenant_id = $1 AND memory_space_id = $2", tv));
  // D-104 (UA-5 Production Operations Control Plane v1, 036_incidents.sql):
  // registrer hendelses-tabellene i erasure-planen (SAMME mønster/
  // begrunnelse som support_*/contract_* over). `incident_evidence` FØR
  // `incidents` (FK -> incidents). `incident_repair_tasks` er BEVISST IKKE
  // registrert her - den har `ON DELETE CASCADE` mot `incidents` (den bærer
  // INGEN eget innhold utover to id-er, se 036_incidents.sql) og har heller
  // INGEN `memory_space_id`-kolonne å filtrere denne spørringen på i det
  // hele tatt - sletting av `incidents` under fjerner lenkeraden automatisk.
  // `deployments`/`infra_recovery_actions` er REN infra-audit (tenant-scoped,
  // ingen memory_space_id, samme klasse som `tool_executions`/`audit_events`)
  // - BEVISST utenfor denne memory-space-erasure-planen, samme presedens.
  // D-105 (037_infra_ops_v2.sql): `incident_diagnoses` FØR BEGGE
  // `incident_evidence` OG `incidents` (FK -> incidents; `incident_diagnosis_
  // evidence` FK -> BÅDE incident_diagnoses OG incident_evidence - uten denne
  // rekkefølgen ville en gjenværende diagnose-bevis-lenke blokkert
  // `incident_evidence`-slettingen under med en fremmednøkkel-feil).
  // `incident_diagnosis_evidence` er BEVISST IKKE registrert selv - `ON
  // DELETE CASCADE` mot `incident_diagnoses` (samme "bærer intet eget
  // innhold"-begrunnelse som `incident_repair_tasks`).
  add(result, "incident_diagnoses", await run(client, mode, "incident_diagnoses", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "incident_evidence", await run(client, mode, "incident_evidence", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "incidents", await run(client, mode, "incidents", "tenant_id = $1 AND memory_space_id = $2", tv));
  // UA-3 Native Jarvis Operations Core (D-129, 048_operations.sql): registrer
  // driftsdomene-tabellene i erasure-planen (SAMME mønster/begrunnelse som
  // support_*/contract_*/product_* over). En driftsoppgave-tilknyttet
  // open-loop (samme FK-lærdom som HOST FIX #1/D-67 for `ticket_id`) slettes
  // FØRST, SNEVERT avgrenset til `operations_task_id IS NOT NULL` (rører
  // aldri andre loop_type-er).
  add(
    result,
    "business_open_loops",
    await run(client, mode, "business_open_loops", "tenant_id = $1 AND memory_space_id = $2 AND operations_task_id IS NOT NULL", tv)
  );
  // `operations_task_events` FØR `operations_tasks` (FK -> operations_tasks).
  // `operations_tasks` har FK -> BÅDE `operations_vendors` OG
  // `operations_runbooks` - MÅ derfor slettes FØR begge under (samme "barn-FK
  // FØR forelder"-regel som resten av denne planen). `operations_runbooks`
  // har SIN EGEN FK -> `operations_vendors` - MÅ derfor slettes FØR
  // `operations_vendors` (etter `operations_tasks`, som selv kan peke til
  // et runbook).
  add(result, "operations_task_events", await run(client, mode, "operations_task_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "operations_tasks", await run(client, mode, "operations_tasks", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "operations_runbooks", await run(client, mode, "operations_runbooks", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "operations_vendors", await run(client, mode, "operations_vendors", "tenant_id = $1 AND memory_space_id = $2", tv));
  // UA-8 Personal Digital Twin (D-130, 049_context_engine.sql): Personal
  // Context Engine. `context_observations` har INGEN FK mot noen annen
  // tabell i denne planen (person_id er en enkel FK -> people, en GLOBAL,
  // tenant-uavhengig identitet - samme presedens som owner_person_id
  // andre steder i denne filen dokumenterer som utenfor denne feilklassen).
  add(result, "context_observations", await run(client, mode, "context_observations", "tenant_id = $1 AND memory_space_id = $2", tv));
  // UA-8 (D-130, 050_location.sql): provider-nøytral lokasjon/geofencing.
  // `location_zone_visits` har sammensatte FK-er -> BÅDE `location_zones`
  // OG `location_observations` - MÅ derfor slettes FØRST av denne blokken
  // (barn-FK FØR forelder). `location_retention_policies` er ren
  // eier-konfigurert retensjonspolicy uten FK til noen av de tre andre -
  // slettes sist for konsistens (samme "ingen dinglende konfigurasjonsrad"-
  // begrunnelse som consent_enforcement_policies over).
  add(result, "location_zone_visits", await run(client, mode, "location_zone_visits", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "location_observations", await run(client, mode, "location_observations", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "location_zones", await run(client, mode, "location_zones", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "location_retention_policies", await run(client, mode, "location_retention_policies", "tenant_id = $1 AND memory_space_id = $2", tv));
  // UA-8 (D-130, 051_health.sql): provider-nøytral helse-ingestion.
  // `health_metric_observations` er strukturelt låst til `memory_space_id
  // = 'health'` (database-CHECK) - denne spørringen er likevel den SAMME
  // generiske (tenant_id, memory_space_id)-formen som resten av planen;
  // den treffer naturlig kun rader når `space = 'health'` selv slettes.
  // Ingen FK mellom de to helse-tabellene.
  add(result, "health_metric_observations", await run(client, mode, "health_metric_observations", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "health_retention_policies", await run(client, mode, "health_retention_policies", "tenant_id = $1 AND memory_space_id = $2", tv));
  // UA-9 (D-153, 055_vision.sql): provider-nøytral vision-hendelses-kjerne.
  // MULTI-SPACE (location-stil, IKKE health-stil enkelt-låst space) - denne
  // spørringen er den SAMME generiske (tenant_id, memory_space_id)-formen
  // som resten av planen. `vision_event_observations` FKer mot
  // `vision_rooms` (composite, NULLABLE `room_id`) - slettes derfor FØRST
  // (barn-FK FØR forelder, samme "sammensatt FK er ikke en autorisasjons-
  // grense"-disiplin som `location_zone_visits`/`location_zones`).
  // `vision_retention_policies` er ren eier-konfigurert retensjonspolicy
  // uten FK til noen av de to andre - slettes sist for konsistens (samme
  // "ingen dinglende konfigurasjonsrad"-begrunnelse som
  // `health_retention_policies` over).
  // WP-G3 (D-465, 133-137): kameraregister, øyeblikksbilder, inventar og opptaksforespørsler. Rekkefølge (barn før forelder): opptaksforespørsler (peker på kamera og bilde), så hendelsene
  // (en AFTER DELETE-trigger sletter bildet når siste hendelse som peker på det forsvinner, og en annen fjerner hendelsens vektor i `memory_vectors`), så gjenværende bilder (pending/uten
  // hendelse), inventaret (peker på rom), kameraene (bilder kaskaderer) og til slutt rommene. BEFORE DELETE-triggeren på `vision_snapshots` skriver en gravstein per slettet bilde, så
  // bildeobjektet også slettes (reaperen i modules/vision/src/snapshots.ts) - `vision_snapshot_tombstones` er BEVISST IKKE med her (arbeidskø uten personopplysninger, se d395-baselinen).
  add(result, "vision_capture_requests", await run(client, mode, "vision_capture_requests", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "vision_event_observations", await run(client, mode, "vision_event_observations", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "vision_snapshots", await run(client, mode, "vision_snapshots", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "vision_inventory_items", await run(client, mode, "vision_inventory_items", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "vision_cameras", await run(client, mode, "vision_cameras", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "vision_rooms", await run(client, mode, "vision_rooms", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "vision_retention_policies", await run(client, mode, "vision_retention_policies", "tenant_id = $1 AND memory_space_id = $2", tv));
  // WP-G2 (D-464, UA-8, migrasjon 125): handlingsjournalen for kritiske hjem-/bilhandlinger. Eneste FK er sammensatt mot `person_tenants` (medlemskap) - ingen barnetabeller, rekkefølgen er likegyldig.
  add(result, "personal_action_journal", await run(client, mode, "personal_action_journal", "tenant_id = $1 AND memory_space_id = $2", tv));
  // WP-G2 (D-464, UA-8, migrasjon 126/127): familie-/delt-rom-autoritet. Alt bor i `shared`-rommet (CHECK). Rekkefølge etter FK-ene: elementer FØR lister (sammensatt FK), delinger og delegasjoner FØR medlemmer (sammensatte FK-er mot family_members);
  // invitasjoner og hendelser har ingen FK seg imellom eller mot de andre.
  add(result, "family_list_items", await run(client, mode, "family_list_items", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "family_lists", await run(client, mode, "family_lists", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "family_events", await run(client, mode, "family_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "family_shares", await run(client, mode, "family_shares", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "family_delegations", await run(client, mode, "family_delegations", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "family_invitations", await run(client, mode, "family_invitations", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "family_members", await run(client, mode, "family_members", "tenant_id = $1 AND memory_space_id = $2", tv));
  // Rekonsiliering PR #83 mot main (D163/D164): vision-blokken over (055) og
  // situations-blokken under (056) har INGEN FK seg imellom (055 refererer
  // kun tenants/people/person_tenants/vision_rooms; 056 refererer kun
  // tenants/people/person_tenants/business_open_loops) - rekkefølgen dem
  // imellom er derfor vilkårlig; begge beholdes uendret fra hver sin side.
  // UA-10 (056_situations.sql): Proactive Situation Engine. Samme tenant+
  // space-scoped registrering som `business_open_loops` (dens egen
  // nærmeste presedens - se der). `situation_notification_policies`
  // BEVISST utelatt (tenant/space-nivå eier-konfigurert varslingspolicy,
  // IKKE hendelses-/personeid data - samme "ingen dinglende
  // konfigurasjonsrad, men ALDRI heller feilaktig fjernet policy for
  // gjenværende data"-prinsipp som `location_retention_policies`/
  // `health_retention_policies` over). UA-10 P1 (D-160, 057_situations_
  // activation.sql): `situation_autonomy_policies` er OGSÅ eier-konfigurert
  // policy (auto-ACT-binding per domene), IKKE hendelsesdata - BEVISST
  // utelatt på samme grunnlag. De nye `situations.inform_*`-kolonnene
  // slettes sammen med raden under.
  // UA-11 Executive Mode "K2" (D-64, 059_governance.sql): registrer de fire
  // nye governance-tabellene (SAMME "tenant+space-scoped journalpost"-mønster
  // som `situations`/`business_open_loops` over). `goal_key_results` FØR
  // `goals` (bærer EGET innhold - tittel/fremdrift, IKKE en tom lenkerad som
  // `incident_repair_tasks` - registreres derfor EKSPLISITT selv om
  // `ON DELETE CASCADE` uansett ville fjernet den, SAMME presedens som
  // `incident_evidence` FØR `incidents` over). `decision_log` MÅ slettes FØR
  // `situations` under - `decision_log_related_situation_scope_fk` er en
  // vanlig (ikke-kaskaderende) fremmednøkkel, en gjenværende
  // `related_situation_id`-peker ville ellers blokkert `situations`-
  // slettingen med et fremmednøkkelbrudd.
  add(result, "goal_key_results", await run(client, mode, "goal_key_results", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "goals", await run(client, mode, "goals", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "risks", await run(client, mode, "risks", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "scenarios", await run(client, mode, "scenarios", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "decision_log", await run(client, mode, "decision_log", "tenant_id = $1 AND memory_space_id = $2", tv));
  // WP-G4 (D-466, migrasjon 139): signallogg, tilbakemelding og modellvurderinger peker (sammensatt FK, ON DELETE CASCADE) på `situations` og er avledet av eierens egne data; abonnementer og regeltuning er eierens
  // konfigurasjon for rommet (et helseabonnement bærer personens id, et hjemabonnement eierens entitets-id-er). Alle fem er tenant+space-skopet og slettes sammen med rommet. Registrert FØR `situations` (barna eksplisitt, selv om kaskaden
  // uansett ville tatt dem) så tellingene i erasure-resultatet er ærlige.
  add(result, "situation_signal_log", await run(client, mode, "situation_signal_log", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "situation_feedback", await run(client, mode, "situation_feedback", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "situation_assessments", await run(client, mode, "situation_assessments", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "situation_subscriptions", await run(client, mode, "situation_subscriptions", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "situation_rule_tuning", await run(client, mode, "situation_rule_tuning", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "situations", await run(client, mode, "situations", "tenant_id = $1 AND memory_space_id = $2", tv));
  // WP-D2 (UA-3 «churn/product usage», 090): produktbruk + churn-vurderinger. Churn-loopen er REN DERIVERT state av bruksdataene (detection_key bærer konto-pseudonymet,
  // reason bærer tall utledet av dem) og slettes sammen med dem - snevert avgrenset til loop_type = 'customer_churn_risk' (rører aldri andre loops). Plassert ETTER
  // `situations`: `situations.source_open_loop_id` peker (sammensatt FK, 056) til loopen og ville ellers blokkert slettingen. Vurderinger og hendelser har FK -> kontoer
  // (ON DELETE CASCADE) men registreres eksplisitt FØR kontoene; kontoene (pseudonym -> selskap-koblingen) slettes sist.
  add(
    result,
    "business_open_loops",
    await run(client, mode, "business_open_loops", "tenant_id = $1 AND memory_space_id = $2 AND loop_type = 'customer_churn_risk'", tv)
  );
  add(result, "business_churn_assessments", await run(client, mode, "business_churn_assessments", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "product_usage_events", await run(client, mode, "product_usage_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "product_usage_accounts", await run(client, mode, "product_usage_accounts", "tenant_id = $1 AND memory_space_id = $2", tv));
  return result;
}

export async function planMemorySpace(client: pg.PoolClient, mode: Mode, tenantId: string, space: string): Promise<ScopePlanResult> {
  await setSpaceContext(client, tenantId, [space]);
  return planMemorySpaceInContext(client, mode, tenantId, space);
}

export async function planConversation(client: pg.PoolClient, mode: Mode, tenantId: string, sessionId: string): Promise<ScopePlanResult> {
  await setTenantOnlyContext(client, tenantId);
  const result = empty();
  const tv = [tenantId, sessionId];
  add(result, "messages", await run(client, mode, "messages", "tenant_id = $1 AND session_id = $2", tv));
  add(result, "sessions", await run(client, mode, "sessions", "tenant_id = $1 AND session_id = $2", tv));
  return result;
}

/**
 * Kjører `fn` én gang per RLS-space-gruppe (ikke-health samlet, health for
 * seg) - trengs når scopet IKKE selv oppgir hvilket space målet ligger i
 * (knowledge_document/knowledge_source/person). RLS gjør uskyldige forsøk
 * i feil gruppe til et harmløst no-op (0 rader), aldri feil resultat.
 */
async function forEachSpaceGroup(
  client: pg.PoolClient,
  tenantId: string,
  fn: (spacesInContext: readonly string[]) => Promise<ScopePlanResult>
): Promise<ScopePlanResult> {
  const all = await tenantSpaces(client, tenantId);
  const { rest, health } = partitionSpaces(all);
  const combined = empty();
  for (const group of [rest, health]) {
    if (group.length === 0) continue;
    await setSpaceContext(client, tenantId, group);
    const partial = await fn(group);
    for (const [table, n] of Object.entries(partial.recordCounts)) add(combined, table, n);
    combined.knowledgeIdentities.push(...partial.knowledgeIdentities);
  }
  return combined;
}

export async function planKnowledgeDocument(client: pg.PoolClient, mode: Mode, tenantId: string, documentId: string): Promise<ScopePlanResult> {
  return forEachSpaceGroup(client, tenantId, async () => {
    const result = empty();
    const tv = [tenantId, documentId];
    if (mode === "delete") {
      result.knowledgeIdentities.push(...(await gatherKnowledgeIdentities(client, "tenant_id = $1 AND knowledge_document_id = $2", tv)));
    }
    await planDocumentDerivedRows(client, mode, result, "tenant_id = $1 AND knowledge_document_id = $2", tv);
    add(result, "knowledge_embeddings", await run(client, mode, "knowledge_embeddings", "tenant_id = $1 AND knowledge_document_id = $2", tv));
    add(result, "knowledge_documents", await run(client, mode, "knowledge_documents", "tenant_id = $1 AND knowledge_document_id = $2", tv));
    return result;
  });
}

export async function planKnowledgeSource(
  client: pg.PoolClient,
  mode: Mode,
  tenantId: string,
  sourceType: string,
  sourceInstanceId: string
): Promise<ScopePlanResult> {
  return forEachSpaceGroup(client, tenantId, async () => {
    const result = empty();
    const tv = [tenantId, sourceType, sourceInstanceId];
    const docsWhere = "tenant_id = $1 AND source_type = $2 AND source_instance_id = $3";
    if (mode === "delete") {
      result.knowledgeIdentities.push(...(await gatherKnowledgeIdentities(client, docsWhere, tv)));
    }
    await planDocumentDerivedRows(client, mode, result, docsWhere, tv);
    add(
      result,
      "knowledge_embeddings",
      await run(
        client,
        mode,
        "knowledge_embeddings",
        `tenant_id = $1 AND knowledge_document_id IN (SELECT knowledge_document_id FROM knowledge_documents WHERE ${docsWhere})`,
        tv
      )
    );
    add(result, "knowledge_documents", await run(client, mode, "knowledge_documents", docsWhere, tv));
    return result;
  });
}

export async function planPerson(client: pg.PoolClient, mode: Mode, tenantId: string, personId: string): Promise<ScopePlanResult> {
  const memory = await forEachSpaceGroup(client, tenantId, async () => {
    const result = empty();
    const ownedSubquery = "SELECT memory_item_id FROM memory_items WHERE tenant_id = $1 AND owner_person_id = $2";
    const ownedValues = [tenantId, personId];
    for (const table of ["memory_versions", "memory_item_entities", "embeddings"]) {
      add(result, table, await run(client, mode, table, `memory_item_id IN (${ownedSubquery})`, ownedValues));
    }
    add(result, "memory_items", await run(client, mode, "memory_items", "tenant_id = $1 AND owner_person_id = $2", ownedValues));
    // WP-D1 (088): påstander personen selv har registrert (påstandsteksten kan inneholde personopplysninger). Evidensen FØR påstanden. Kunnskapsdokumenter har fortsatt ingen person-kolonne
    // (kjent gap, jf. docs/DATA_ERASURE.md) - men det de gir opphav til i grafen følger dokumentene (se `planDocumentDerivedRows`).
    add(
      result,
      "claim_evidence",
      await run(client, mode, "claim_evidence", "tenant_id = $1 AND claim_id IN (SELECT claim_id FROM claim_verifications WHERE tenant_id = $1 AND created_by_person_id = $2)", ownedValues)
    );
    add(result, "claim_verifications", await run(client, mode, "claim_verifications", "tenant_id = $1 AND created_by_person_id = $2", ownedValues));
    // UA-8 Personal Digital Twin (D-130, 049_context_engine.sql):
    // `context_observations` HAR en RESTRICTIVE `jarvis.memory_spaces`-RLS-
    // policy (samme mønster som `consent_decisions`) - i MOTSETNING til
    // `messages`/`sessions` under, som ikke har noen `memory_space_id` i det
    // hele tatt og derfor er trygge under `setTenantOnlyContext` alene. Et
    // forsøk på å slette denne tabellen etter `setTenantOnlyContext` (uten
    // `jarvis.memory_spaces` satt) ville stille funnet null rader - RLS
    // ville filtrert bort ALT, IKKE kastet en feil - nøyaktig samme
    // RLS-blind-spørrings-feilklasse som Q-27/D-54 fanget tidligere i dette
    // prosjektet. Slettes derfor HER, INNENFOR `forEachSpaceGroup`, der
    // riktig `jarvis.memory_spaces`-kontekst allerede er satt.
    add(result, "context_observations", await run(client, mode, "context_observations", "tenant_id = $1 AND person_id = $2", ownedValues));
    // MERGE BLOCKER-fiks (ekte arkitekt-review av PR #79, D-130): person-scope
    // erasure lot TIDLIGERE `location_zone_visits`/`location_observations`/
    // `location_zones`/`health_metric_observations` stå UBERØRT - en
    // person-scope Q-20-erasure fjernet dermed IKKE personens faktiske
    // Personal Digital Twin-data (posisjonshistorikk, helsedata), et reelt
    // personvern-/compliance-hull. SAMME RLS-blind-spørrings-feilklasse som
    // `context_observations`-kommentaren over allerede dokumenterer (Q-27/
    // D-54): alle fire tabellene har en RESTRICTIVE `jarvis.memory_spaces`-
    // RLS-policy (se `050_location.sql`/`051_health.sql`) - `setTenantOnlyContext`
    // under (linje ~491) setter ALDRI den session-variabelen, saa et forsøk
    // paa aa slette disse etter den ville stille funnet null rader (RLS ville
    // filtrert bort ALT, IKKE kastet en feil) - IKKE en ekte sletting, bare en
    // usynlig no-op. Slettes derfor HER, INNENFOR `forEachSpaceGroup`, der
    // riktig `jarvis.memory_spaces`-kontekst allerede er satt (SAMME sted som
    // `context_observations`).
    //
    // Rekkefølge (barn-FK FØR forelder, samme "sammensatt FK er ikke en
    // autorisasjonsgrense uten (tenant_id, memory_space_id, ...)"-lærdom som
    // `050_location.sql` sin migrasjons-kommentar dokumenterer):
    //  1. `location_zone_visits` FØRST - har sammensatte FK-er -> BÅDE
    //     `location_zones` OG `location_observations` (begge inkluderer
    //     `person_id` implisitt via visit-raden selv, siden visits alltid
    //     tilhører SAMME person som sonen/observasjonen de peker til i denne
    //     sliceen).
    //  2. `location_observations` - etter visits (visits FK-refererer den).
    //  3. `location_zones` - etter visits (visits FK-refererer den); rekkefølge
    //     relativt til (2) er vilkårlig, INGEN FK mellom `location_observations`
    //     og `location_zones` selv.
    //  4. `health_metric_observations` - ingen dependents, INGEN FK-ordrings-
    //     krav mot noen av de tre location-tabellene (helt separat domene).
    //
    // BEVISST IKKE med her: `location_retention_policies`/
    // `health_retention_policies` - dette er tenant/space-nivå POLICY-
    // KONFIGURASJON (eierens retensjonsvindu-valg), IKKE person-eid data -
    // sletting av ÉN person sitt Digital Twin-innhold skal ALDRI fjerne den
    // konfigurasjonen som fortsatt gjelder resten av tenanten/space-en (samme
    // "ingen dinglende konfigurasjonsrad, men ALDRI heller feilaktig fjernet
    // policy for gjenværende data"-prinsipp som `consent_enforcement_policies`
    // andre steder i denne filen).
    add(result, "location_zone_visits", await run(client, mode, "location_zone_visits", "tenant_id = $1 AND person_id = $2", ownedValues));
    add(result, "location_observations", await run(client, mode, "location_observations", "tenant_id = $1 AND person_id = $2", ownedValues));
    add(result, "location_zones", await run(client, mode, "location_zones", "tenant_id = $1 AND person_id = $2", ownedValues));
    add(
      result,
      "health_metric_observations",
      await run(client, mode, "health_metric_observations", "tenant_id = $1 AND person_id = $2", ownedValues)
    );
    // UA-9 (D-153, 055_vision.sql): SAMME RLS-blind-spørrings-feilklasse som
    // `location_*`/`health_metric_observations` over - `vision_rooms`/
    // `vision_event_observations` har en RESTRICTIVE `jarvis.memory_spaces`-
    // RLS-policy, slettes derfor HER, INNENFOR `forEachSpaceGroup`. `vision_
    // event_observations` FØRST (barn-FK -> `vision_rooms`, samme "barn FØR
    // forelder"-rekkefølge som `location_zone_visits` -> `location_zones`).
    // `vision_retention_policies` BEVISST IKKE med her (tenant/space-nivå
    // POLICY-KONFIGURASJON, ikke person-eid data - samme begrunnelse som
    // `location_retention_policies`/`health_retention_policies` over).
    // WP-G3 (D-465): samme rekkefølge som space-scope over (opptaksforespørsler, hendelser [trigger: bilde + vektor], gjenværende bilder, inventar, kameraer, rom).
    add(result, "vision_capture_requests", await run(client, mode, "vision_capture_requests", "tenant_id = $1 AND person_id = $2", ownedValues));
    add(result, "vision_event_observations", await run(client, mode, "vision_event_observations", "tenant_id = $1 AND person_id = $2", ownedValues));
    add(result, "vision_snapshots", await run(client, mode, "vision_snapshots", "tenant_id = $1 AND person_id = $2", ownedValues));
    add(result, "vision_inventory_items", await run(client, mode, "vision_inventory_items", "tenant_id = $1 AND person_id = $2", ownedValues));
    add(result, "vision_cameras", await run(client, mode, "vision_cameras", "tenant_id = $1 AND person_id = $2", ownedValues));
    add(result, "vision_rooms", await run(client, mode, "vision_rooms", "tenant_id = $1 AND person_id = $2", ownedValues));
    // WP-G2 (D-464, UA-8): handlingsjournalen er person-eid via `actor_person_id` (RESTRICTIVE memory-space-RLS, derfor HER innenfor `forEachSpaceGroup`).
    add(result, "personal_action_journal", await run(client, mode, "personal_action_journal", "tenant_id = $1 AND actor_person_id = $2", ownedValues));
    // WP-G2 (D-464, UA-8, 126/127): alt om personen i familiesirkelen. Delinger og delegasjoner der personen er subjekt/seer/prinsipal/agent slettes FØR medlemskapet (FK). Felles innhold (lister, elementer, hendelser) som personen har
    // opprettet, utført eller som gjelder personen («på vegne av») slettes; en liste personen opprettet tar sine elementer med (sammensatt FK) - bevisst konservativt: sletting skal ikke etterlate pekere til en slettet person.
    // Invitasjoner knyttet til personen slettes. Gjenværende `added_by_person_id`/`invited_by_person_id` hos ANDRE medlemmer peker kun på sirkelens eier og fjernes først når sirkel-tenanten selv slettes (tenant-scope).
    add(result, "family_shares", await run(client, mode, "family_shares", "tenant_id = $1 AND (subject_person_id = $2 OR viewer_person_id = $2)", ownedValues));
    add(result, "family_delegations", await run(client, mode, "family_delegations", "tenant_id = $1 AND (principal_person_id = $2 OR agent_person_id = $2)", ownedValues));
    add(
      result,
      "family_list_items",
      await run(
        client, mode, "family_list_items",
        "tenant_id = $1 AND (added_by_person_id = $2 OR on_behalf_of_person_id = $2 OR done_by_person_id = $2 OR list_id IN (SELECT list_id FROM family_lists WHERE tenant_id = $1 AND (created_by_person_id = $2 OR on_behalf_of_person_id = $2)))",
        ownedValues
      )
    );
    add(result, "family_lists", await run(client, mode, "family_lists", "tenant_id = $1 AND (created_by_person_id = $2 OR on_behalf_of_person_id = $2)", ownedValues));
    add(result, "family_events", await run(client, mode, "family_events", "tenant_id = $1 AND (created_by_person_id = $2 OR on_behalf_of_person_id = $2 OR cancelled_by_person_id = $2)", ownedValues));
    add(result, "family_invitations", await run(client, mode, "family_invitations", "tenant_id = $1 AND (invitee_person_id = $2 OR invited_by_person_id = $2 OR decided_by_person_id = $2)", ownedValues));
    add(result, "family_members", await run(client, mode, "family_members", "tenant_id = $1 AND person_id = $2", ownedValues));
    return result;
  });

  await setTenantOnlyContext(client, tenantId);
  const cv = [tenantId, personId];
  add(
    memory,
    "messages",
    await run(client, mode, "messages", "tenant_id = $1 AND session_id IN (SELECT session_id FROM sessions WHERE tenant_id = $1 AND person_id = $2)", cv)
  );
  add(memory, "sessions", await run(client, mode, "sessions", "tenant_id = $1 AND person_id = $2", cv));
  return memory;
}

export async function planTenant(client: pg.PoolClient, mode: Mode, tenantId: string): Promise<ScopePlanResult> {
  const spaces = await tenantSpaces(client, tenantId);
  const combined = empty();
  for (const space of spaces) {
    await setSpaceContext(client, tenantId, [space]);
    const partial = await planMemorySpaceInContext(client, mode, tenantId, space);
    for (const [table, n] of Object.entries(partial.recordCounts)) add(combined, table, n);
    combined.knowledgeIdentities.push(...partial.knowledgeIdentities);
  }
  await setTenantOnlyContext(client, tenantId);
  add(combined, "messages", await run(client, mode, "messages", "tenant_id = $1", [tenantId]));
  add(combined, "sessions", await run(client, mode, "sessions", "tenant_id = $1", [tenantId]));
  add(combined, "artifacts", await run(client, mode, "artifacts", "tenant_id = $1", [tenantId]));
  // UA-6 Finance & Spend Integrity Gateway (D-107): `finance_kill_switch`
  // er IKKE space-skopet (ETT rad per tenant, samme prinsipp som
  // `messages`/`sessions`/`artifacts` over) - registreres derfor her, ikke
  // i `planMemorySpaceInContext()`.
  add(combined, "finance_kill_switch", await run(client, mode, "finance_kill_switch", "tenant_id = $1", [tenantId]));
  // UA-6 Finance & Spend Integrity Gateway - ANDRE slice (Slice 2):
  // `finance_spend_sync_cursors` er OGSÅ IKKE space-skopet (ETT rad per
  // (tenant, kildefamilie), SAMME prinsipp som `finance_kill_switch` over)
  // - registreres derfor her.
  add(combined, "finance_spend_sync_cursors", await run(client, mode, "finance_spend_sync_cursors", "tenant_id = $1", [tenantId]));
  return combined;
}

export async function planScope(client: pg.PoolClient, mode: Mode, scope: ErasureScope): Promise<ScopePlanResult> {
  switch (scope.type) {
    case "memory_space":
      return planMemorySpace(client, mode, scope.tenant_id, scope.memory_space_id);
    case "conversation":
      return planConversation(client, mode, scope.tenant_id, scope.session_id);
    case "knowledge_document":
      return planKnowledgeDocument(client, mode, scope.tenant_id, scope.knowledge_document_id);
    case "knowledge_source":
      return planKnowledgeSource(client, mode, scope.tenant_id, scope.source_type, scope.source_instance_id);
    case "person":
      return planPerson(client, mode, scope.tenant_id, scope.person_id);
    case "tenant":
      return planTenant(client, mode, scope.tenant_id);
  }
}
