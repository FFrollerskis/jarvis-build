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
