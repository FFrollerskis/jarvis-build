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

/** Ét memory_space (allerede satt som RLS-kontekst av kalleren) - alle tabeller filtrert direkte på (tenant_id, space). */
async function planMemorySpaceInContext(client: pg.PoolClient, mode: Mode, tenantId: string, space: string): Promise<ScopePlanResult> {
  const result = empty();
  const tv = [tenantId, space];
  const spaceCol = "space = $2";
  for (const table of ["memory_versions", "memory_item_entities", "embeddings", "relations", "entities", "summaries", "decisions", "commitments", "deadlines", "memory_items"]) {
    add(result, table, await run(client, mode, table, `tenant_id = $1 AND ${spaceCol}`, tv));
  }
  if (mode === "delete") {
    result.knowledgeIdentities.push(
      ...(await gatherKnowledgeIdentities(client, "tenant_id = $1 AND memory_space_id = $2", tv))
    );
  }
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
  add(result, "finance_recurring_commitments", await run(client, mode, "finance_recurring_commitments", "tenant_id = $1 AND memory_space_id = $2", tv));
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
  // D-109 (UA-6 Slice 3, 040_stripe.sql): `stripe_webhook_events` og
  // `stripe_refunds` har BEGGE en FK -> `payment_intents` (payment_intent_id)
  // - SAMME "barn-FK FØR forelder"-regel som `payment_intent_events` over,
  // MÅ derfor også slettes FØR `payment_intents`. Ingen FK MELLOM de to
  // Stripe-tabellene selv, rekkefølgen dem imellom er derfor vilkårlig.
  add(result, "stripe_webhook_events", await run(client, mode, "stripe_webhook_events", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "stripe_refunds", await run(client, mode, "stripe_refunds", "tenant_id = $1 AND memory_space_id = $2", tv));
  add(result, "payment_intents", await run(client, mode, "payment_intents", "tenant_id = $1 AND memory_space_id = $2", tv));
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
