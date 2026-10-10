import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { registrableDomain } from "./claim-verification.ts";
import {
  ENTITY_KINDS,
  emailEntityKey,
  normalizeEntityName,
  type EntityKind,
  type EntityMethod,
  type ExtractedEntity
} from "./entity-extractor.ts";
import { neutralizeUntrustedText, truncateText } from "./knowledge-hits.ts";

/**
 * WP-D1 (UA-2): persistens og spørring for kunnskapsgrafen (`knowledge_entities`/`knowledge_links`, migrasjon 087). Alle funksjoner kjører i kallerens transaksjon (RLS-konteksten for tenant og
 * rom er allerede satt av `withMemoryTransaction`) og er i tillegg eksplisitt skopet til (tenant, rom). Entiteter er AVLEDET, ubetrodd data - aldri autoritativt minne.
 *
 * Co-mention-kanter («hva henger sammen med Y») materialiseres ikke: de utledes ved spørring fra lenkene (to entiteter i samme IKKE-slettede dokument), så de alltid er konsistente med
 * tombstones og erasure uten en vedlikeholdsløkke.
 */
export interface ReplaceLinksInput {
  tenant_id: string;
  memory_space_id: MemorySpace;
  knowledge_document_id: string;
  /** Hvilke lenker som erstattes: en ny deterministisk indeksering sletter aldri modellassisterte lenker, og omvendt. */
  method: EntityMethod;
  entities: readonly ExtractedEntity[];
}

export interface ReplaceLinksResult {
  linked: number;
  /** Entiteter som ikke lenger har noen lenke og derfor ble fjernet (navn hentet fra innhold som er endret/borte). */
  pruned: number;
}

const MAX_LINK_BATCH = 200;

/**
 * Sletter dokumentets lenker av `method`, upserter entitetene og skriver lenkene på nytt, og fjerner entiteter som ble foreldreløse. Idempotent: samme input to ganger gir samme tilstand.
 * Et dokument som nevner samme entitet både deterministisk og modellassistert beholder den første lenkens `method` (en lenke per (dokument, entitet)).
 */
export async function replaceDocumentLinks(client: pg.PoolClient, input: ReplaceLinksInput): Promise<ReplaceLinksResult> {
  const { tenant_id: tenantId, memory_space_id: space, knowledge_document_id: documentId, method } = input;
  // Én rad per (art, nøkkel): to like nøkler i samme INSERT ... ON CONFLICT ville feilet («cannot affect row a second time»).
  const unique = new Map<string, ExtractedEntity>();
  for (const e of input.entities) {
    const id = `${e.kind}\u0000${e.canonical_key}`;
    const seen = unique.get(id);
    if (seen === undefined) unique.set(id, e);
    else unique.set(id, { ...seen, mention_count: seen.mention_count + e.mention_count });
  }
  const entities = [...unique.values()].slice(0, MAX_LINK_BATCH);
  const previous = await client.query(
    "DELETE FROM knowledge_links WHERE tenant_id = $1 AND memory_space_id = $2 AND knowledge_document_id = $3 AND method = $4 RETURNING entity_id",
    [tenantId, space, documentId, method]
  );
  const previousIds = (previous.rows as Array<{ entity_id: string }>).map((r) => r.entity_id);
  let linkedIds: string[] = [];
  if (entities.length > 0) {
    const upserted = await client.query(
      `INSERT INTO knowledge_entities (entity_id, tenant_id, memory_space_id, kind, canonical_key, display_name, memory_entity_id, method)
       SELECT t.entity_id, $1, $2, t.kind, t.canonical_key, t.display_name, t.memory_entity_id, $3
         FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS t(entity_id, kind, canonical_key, display_name, memory_entity_id)
       ON CONFLICT (tenant_id, memory_space_id, kind, canonical_key)
       DO UPDATE SET last_seen_at = now(), memory_entity_id = COALESCE(knowledge_entities.memory_entity_id, EXCLUDED.memory_entity_id)
       RETURNING entity_id, kind, canonical_key`,
      [
        tenantId, space, method,
        entities.map(() => `ke-${randomUUID()}`), entities.map((e) => e.kind), entities.map((e) => e.canonical_key), entities.map((e) => e.display_name), entities.map((e) => e.memory_entity_id ?? null)
      ]
    );
    const idByKey = new Map((upserted.rows as Array<{ entity_id: string; kind: string; canonical_key: string }>).map((r) => [`${r.kind}\u0000${r.canonical_key}`, r.entity_id]));
    const rows = entities.flatMap((e) => {
      const entityId = idByKey.get(`${e.kind}\u0000${e.canonical_key}`);
      return entityId === undefined ? [] : [{ entityId, count: Math.min(Math.max(Math.floor(e.mention_count), 1), 1_000_000) }];
    });
    linkedIds = rows.map((r) => r.entityId);
    if (rows.length > 0) {
      await client.query(
        `INSERT INTO knowledge_links (tenant_id, memory_space_id, knowledge_document_id, entity_id, link_kind, mention_count, method)
         SELECT $1, $2, $3, t.entity_id, 'mentions', t.mention_count, $4 FROM unnest($5::text[], $6::int[]) AS t(entity_id, mention_count)
         ON CONFLICT (knowledge_document_id, entity_id, link_kind) DO UPDATE SET mention_count = GREATEST(knowledge_links.mention_count, EXCLUDED.mention_count)`,
        [tenantId, space, documentId, method, rows.map((r) => r.entityId), rows.map((r) => r.count)]
      );
    }
  }
  const stale = previousIds.filter((id) => !linkedIds.includes(id));
  const pruned = await pruneOrphanEntities(client, tenantId, space, stale);
  return { linked: linkedIds.length, pruned };
}

/**
 * Fjerner de oppgitte entitetene som ikke har noen lenke igjen. To setninger med vilje: raden LÅSES først (venter på en samtidig transaksjon som nettopp har lenket til den), og først ETTER at låsen er
 * tatt sjekkes lenkene med et ferskt øyeblikksbilde. Én enkelt `DELETE ... WHERE NOT EXISTS (...)` kunne slettet en entitet som samtidig fikk en ny lenke (FK-kaskaden ville da stille slettet lenken).
 */
export async function pruneOrphanEntities(client: pg.PoolClient, tenantId: string, space: MemorySpace, entityIds: readonly string[]): Promise<number> {
  if (entityIds.length === 0) return 0;
  const ids = [...new Set(entityIds)];
  await client.query("SELECT entity_id FROM knowledge_entities WHERE tenant_id = $1 AND memory_space_id = $2 AND entity_id = ANY($3::text[]) ORDER BY entity_id FOR UPDATE", [tenantId, space, ids]);
  const gone = await client.query(
    `DELETE FROM knowledge_entities e WHERE e.tenant_id = $1 AND e.memory_space_id = $2 AND e.entity_id = ANY($3::text[])
       AND NOT EXISTS (SELECT 1 FROM knowledge_links l WHERE l.tenant_id = e.tenant_id AND l.memory_space_id = e.memory_space_id AND l.entity_id = e.entity_id)`,
    [tenantId, space, ids]
  );
  return gone.rowCount ?? 0;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Spørring
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface MentionTarget {
  kind: EntityKind;
  key: string;
}

const NAME_KINDS: readonly EntityKind[] = ["known_entity", "person", "organization", "place", "topic"];
const EMAIL_FULL = /^[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,8}$/u;
const URL_HOST = /^https?:\/\/([a-z0-9][a-z0-9.-]{0,252})(?:[/:?#]|$)/i;
const BARE_DOMAIN = /^(?:www\.)?([a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63}){0,4}\.[a-z]{2,24})$/i;
const REPO = /^(?:https?:\/\/github\.com\/)?([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9._-]{1,100})$/i;
const PROJECT_KEY = /^([A-Za-z]{2}[A-Za-z0-9]{0,8})(?:-\d{1,6})?$/;

/**
 * Hvilke entiteter en spørring («mentions») kan bety: samme normalisering som uttrekket, så en e-postadresse hashes (aldri sammenlignet i klartekst), et domene/URL blir registrerbart domene, `eier/repo`
 * blir repo, `ABC`/`ABC-123` blir prosjektnøkkel, og alt blir i tillegg et normalisert navn (kjent entitet/person/organisasjon/sted/tema). Tom/for lang input gir ingen kandidater.
 */
export function mentionTargets(raw: string): MentionTarget[] {
  const text = raw.normalize("NFKC").trim().slice(0, 200);
  if (text.length === 0) return [];
  const out = new Map<string, MentionTarget>();
  const add = (kind: EntityKind, key: string): void => {
    if (key.length > 0 && key.length <= 200) out.set(`${kind}\u0000${key}`, { kind, key });
  };
  if (EMAIL_FULL.test(text)) add("email_address", emailEntityKey(text));
  const url = URL_HOST.exec(text);
  if (url) add("domain", registrableDomain((url[1] as string).toLowerCase().replace(/\.+$/, "")));
  const bare = BARE_DOMAIN.exec(text);
  if (bare) add("domain", registrableDomain((bare[1] as string).toLowerCase()));
  const repo = REPO.exec(text);
  if (repo) add("repo", `${(repo[1] as string).toLowerCase()}/${(repo[2] as string).toLowerCase().replace(/\.git$/, "")}`);
  const project = PROJECT_KEY.exec(text);
  if (project) add("project_key", (project[1] as string).toUpperCase());
  const name = normalizeEntityName(text);
  if (name.length >= 2) for (const kind of NAME_KINDS) add(kind, name);
  return [...out.values()];
}

export interface MentionedDocument {
  knowledge_document_id: string;
  mention_count: number;
}

/** Ikke-slettede dokumenter som nevner en av kandidatene, mest nevnt først (maks 500). RLS og eksplisitt skoping til (tenant, rom). */
export async function documentsMentioning(client: pg.PoolClient, tenantId: string, spaces: readonly MemorySpace[], targets: readonly MentionTarget[]): Promise<MentionedDocument[]> {
  if (targets.length === 0) return [];
  const result = await client.query(
    `SELECT l.knowledge_document_id, max(l.mention_count)::int AS mention_count
       FROM knowledge_links l
       JOIN knowledge_entities e ON e.tenant_id = l.tenant_id AND e.memory_space_id = l.memory_space_id AND e.entity_id = l.entity_id
       JOIN unnest($1::text[], $2::text[]) AS t(kind, canonical_key) ON t.kind = e.kind AND t.canonical_key = e.canonical_key
       JOIN knowledge_documents d ON d.tenant_id = l.tenant_id AND d.memory_space_id = l.memory_space_id AND d.knowledge_document_id = l.knowledge_document_id AND d.deleted = false
      WHERE l.tenant_id = $3 AND l.memory_space_id = ANY($4::text[])
      GROUP BY l.knowledge_document_id
      ORDER BY max(l.mention_count) DESC, l.knowledge_document_id
      LIMIT 500`,
    [targets.map((t) => t.kind), targets.map((t) => t.key), tenantId, [...spaces]]
  );
  return result.rows as MentionedDocument[];
}

const HIT_ENTITIES_MAX = 10;
const ENTITY_NAME_MAX = 80;

/** Entitetene (art + navn) for en liste dokumenter, de mest nevnte først (maks 10 per dokument). Navnene er nøytralisert og avkortet; e-postadresser er allerede maskert i lagret visningsnavn. */
export async function loadEntitiesForDocuments(
  client: pg.PoolClient,
  tenantId: string,
  spaces: readonly MemorySpace[],
  documentIds: readonly string[]
): Promise<Map<string, Array<{ kind: string; name: string }>>> {
  const out = new Map<string, Array<{ kind: string; name: string }>>();
  if (documentIds.length === 0) return out;
  const rows = await client.query(
    `SELECT l.knowledge_document_id, e.kind, e.display_name
       FROM knowledge_links l
       JOIN knowledge_entities e ON e.tenant_id = l.tenant_id AND e.memory_space_id = l.memory_space_id AND e.entity_id = l.entity_id
      WHERE l.tenant_id = $1 AND l.memory_space_id = ANY($2::text[]) AND l.knowledge_document_id = ANY($3::text[])
      ORDER BY l.knowledge_document_id, l.mention_count DESC, e.kind, e.display_name`,
    [tenantId, [...spaces], [...documentIds]]
  );
  for (const row of rows.rows as Array<{ knowledge_document_id: string; kind: string; display_name: string }>) {
    if (!(ENTITY_KINDS as readonly string[]).includes(row.kind)) continue;
    const list = out.get(row.knowledge_document_id) ?? [];
    if (list.length >= HIT_ENTITIES_MAX) continue;
    const name = truncateText(neutralizeUntrustedText(row.display_name), ENTITY_NAME_MAX);
    if (name.length > 0) list.push({ kind: row.kind, name });
    out.set(row.knowledge_document_id, list);
  }
  return out;
}
