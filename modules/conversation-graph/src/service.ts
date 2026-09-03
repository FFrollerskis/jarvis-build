/**
 * UA-7 Communications Hub - foerste slice (D-119): `ConversationGraphService`.
 * Se `046_conversation_graph.sql` for full skjema-/arkitekturbegrunnelse.
 *
 * Reversibilitet (akseptansekriterium 3, "identity merges are reversible
 * and confidence-tracked"): `mergeIdentities()` sletter ALDRI en rad -
 * kilde-identiteten tombstones (`status='merged'`), berørte kanal-lenker
 * omdirigeres, og EKSAKT hvilke lenker som ble omdirigert lagres i
 * `conversation_identity_merges.affected_link_ids` - `splitMerge()` bruker
 * DENNE presise listen til å gjenopprette akkurat de samme lenkene, aldri
 * en gjetning. `MergePerformedBy` (types.ts) UTELATER strukturelt
 * 'ai_assisted' som en gyldig utfoerer av selve handlingen - en modell kan
 * KUN foreslå en merge, aldri utføre den selv (CLAUDE.md regel 8 +
 * byggeordrens "never LLM-alone permanent merge"), håndhevet BÅDE i
 * TypeScript-typen her OG i databasens CHECK-constraint (forsvar i
 * dybden, ikke bare én lagvakt).
 *
 * Kjent, dokumentert forenkling (IKKE stille utelatt): ved en
 * FLERTRINNS merge-kjede (A slås sammen til B, B slås SIDEN sammen til C)
 * peker A sin `merged_into_identity_id` fortsatt til B, ikke transitivt
 * til C - selve lenke-omdirigeringen ER korrekt transitiv (se
 * `mergeIdentities()`), men "hvem er den GJELDENDE eieren av A" krever i
 * dette tilfellet å følge merge-loggen ett steg videre. Full transitiv
 * "effective identity"-oppslag er utenfor scope for dette FOERSTE sliceet
 * (akseptansekriteriet krever reversibel+confidence-sporet, ikke
 * n-nivå-transitiv oppslag) - se D-119 for begrunnelse.
 */

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { normalizeChannelIdentifier } from "./normalize.ts";
import type {
  ConversationChannel,
  ConversationChannelLink,
  ConversationIdentity,
  ConversationIdentityMerge,
  CrossChannelCommitment,
  IdentityTimelineEntry,
  LinkChannelIdentityInput,
  MergeIdentitiesInput,
  SplitMergeInput
} from "./types.ts";

export class ConversationGraphService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Finn den kanoniske identiteten for en kjent kanal-identifikator (§9:
   * eksakt, deterministisk oppslag - aldri fuzzy). `null` betyr "ukjent
   * forblir ukjent" (Q-26), ALDRI en gjettet identitet.
   */
  async resolveIdentityByChannel(
    tenantId: string,
    memorySpace: MemorySpace,
    channel: ConversationChannel,
    rawIdentifier: string
  ): Promise<ConversationIdentity | null> {
    const normalized = normalizeChannelIdentifier(channel, rawIdentifier);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT ci.* FROM conversation_identities ci
         JOIN conversation_channel_links l ON l.identity_id = ci.identity_id
         WHERE l.tenant_id = $1 AND l.channel = $2 AND l.channel_identifier = $3 AND l.status = 'active'`,
        [tenantId, channel, normalized]
      );
      return rows.length === 1 ? (rows[0] as ConversationIdentity) : null;
    });
  }

  async readIdentity(tenantId: string, memorySpace: MemorySpace, identityId: string): Promise<ConversationIdentity | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM conversation_identities WHERE tenant_id = $1 AND identity_id = $2`,
        [tenantId, identityId]
      );
      return rows.length === 1 ? (rows[0] as ConversationIdentity) : null;
    });
  }

  async listChannelLinks(tenantId: string, memorySpace: MemorySpace, identityId: string): Promise<ConversationChannelLink[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM conversation_channel_links WHERE tenant_id = $1 AND identity_id = $2 ORDER BY created_at ASC`,
        [tenantId, identityId]
      );
      return rows as ConversationChannelLink[];
    });
  }

  /**
   * Koble en kanal-identifikator til en kanonisk identitet - oppretter en
   * ny identitet hvis ingen `identity_id` oppgis og ingen aktiv lenke
   * finnes fra før. Idempotent (samme kanal-identifikator gjenbruker
   * eksisterende aktiv lenke, ALDRI en duplikat-rad) via
   * `ON CONFLICT ... WHERE status = 'active'` mot den delvise unike
   * indeksen - repointer ALDRI en eksisterende aktiv lenke sin
   * `identity_id` (det ville vært en implisitt, ubekreftet merge - en
   * ekte identitetskonflikt MÅ løses eksplisitt via `mergeIdentities()`,
   * aldri stille overskrives her).
   *
   * Kjent, dokumentert race (ufarlig): dersom `identity_id` IKKE oppgis
   * OG to samtidige kall linker SAMME nye kanal-identifikator, kan begge
   * rekke å opprette en ny `conversation_identities`-rad før
   * lenke-INSERT-en kolliderer for den ene - resultatet er én ekstra,
   * lenkefri (harmløs) identitetsrad, ALDRI et datakvalitetsbrudd. Aksepert
   * for dette FOERSTE sliceet (samme presedens-nivå som andre
   * lav-samtidighets-idempotens-forenklinger i denne kodebasen).
   */
  async linkChannelIdentity(
    tenantId: string,
    memorySpace: MemorySpace,
    input: LinkChannelIdentityInput
  ): Promise<ConversationChannelLink> {
    const normalized = normalizeChannelIdentifier(input.channel, input.channel_identifier);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      let identityId = input.identity_id;
      if (!identityId) {
        const existing = await client.query(
          `SELECT identity_id FROM conversation_channel_links
           WHERE tenant_id = $1 AND channel = $2 AND channel_identifier = $3 AND status = 'active'`,
          [tenantId, input.channel, normalized]
        );
        if (existing.rows.length === 1) {
          identityId = (existing.rows[0] as { identity_id: string }).identity_id;
        }
      }
      if (!identityId) {
        identityId = `conv-id-${randomUUID()}`;
        await client.query(
          `INSERT INTO conversation_identities
             (identity_id, tenant_id, memory_space_id, display_name, linked_business_contact_id, linked_person_id, created_by_person_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            identityId, tenantId, memorySpace,
            input.display_name ?? null,
            input.linked_business_contact_id ?? null,
            input.linked_person_id ?? null,
            input.created_by_person_id ?? null
          ]
        );
      }
      const linkId = `conv-link-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO conversation_channel_links
           (link_id, tenant_id, memory_space_id, identity_id, channel, channel_identifier, confidence, match_method, source_type, source_instance_id, external_id, created_by_person_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, channel, channel_identifier) WHERE status = 'active'
         DO UPDATE SET confidence = GREATEST(conversation_channel_links.confidence, EXCLUDED.confidence), updated_at = now()
         RETURNING *`,
        [
          linkId, tenantId, memorySpace, identityId, input.channel, normalized, input.confidence, input.match_method,
          input.source_type ?? null, input.source_instance_id ?? null, input.external_id ?? null,
          input.created_by_person_id ?? null
        ]
      );
      return rows[0] as ConversationChannelLink;
    });
  }

  /**
   * Reversibel sammenslåing: kilde-identiteten tombstones
   * (`status='merged'`), aktive kanal-lenker omdirigeres til
   * mål-identiteten, og EKSAKT hvilke lenker som ble omdirigert lagres i
   * revisjonsloggen (se filhode). `performed_by` er strukturelt begrenset
   * til `'owner' | 'deterministic_rule'` - se `MergePerformedBy` i
   * types.ts.
   */
  async mergeIdentities(
    tenantId: string,
    memorySpace: MemorySpace,
    input: MergeIdentitiesInput
  ): Promise<ConversationIdentityMerge> {
    if (input.source_identity_id === input.target_identity_id) {
      throw new Error("conversation_merge_source_equals_target");
    }
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const sourceRes = await client.query(
        `SELECT * FROM conversation_identities WHERE tenant_id = $1 AND identity_id = $2 FOR UPDATE`,
        [tenantId, input.source_identity_id]
      );
      const targetRes = await client.query(
        `SELECT * FROM conversation_identities WHERE tenant_id = $1 AND identity_id = $2 FOR UPDATE`,
        [tenantId, input.target_identity_id]
      );
      const source = sourceRes.rows[0] as ConversationIdentity | undefined;
      const target = targetRes.rows[0] as ConversationIdentity | undefined;
      if (!source) throw new Error("conversation_merge_source_not_found");
      if (!target) throw new Error("conversation_merge_target_not_found");
      if (source.status !== "active") throw new Error("conversation_merge_source_not_active");
      if (target.status !== "active") throw new Error("conversation_merge_target_not_active");

      const linksRes = await client.query(
        `SELECT link_id FROM conversation_channel_links WHERE tenant_id = $1 AND identity_id = $2 AND status = 'active'`,
        [tenantId, input.source_identity_id]
      );
      const affectedLinkIds = linksRes.rows.map((r) => (r as { link_id: string }).link_id);

      if (affectedLinkIds.length > 0) {
        await client.query(
          `UPDATE conversation_channel_links SET identity_id = $1, updated_at = now()
           WHERE tenant_id = $2 AND link_id = ANY($3::text[])`,
          [input.target_identity_id, tenantId, affectedLinkIds]
        );
      }
      await client.query(
        `UPDATE conversation_identities SET status = 'merged', merged_into_identity_id = $1, updated_at = now()
         WHERE tenant_id = $2 AND identity_id = $3`,
        [input.target_identity_id, tenantId, input.source_identity_id]
      );

      const mergeId = `conv-merge-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO conversation_identity_merges
           (merge_id, tenant_id, memory_space_id, action, source_identity_id, target_identity_id, affected_link_ids, confidence, reason, performed_by, created_by_person_id)
         VALUES ($1, $2, $3, 'merge', $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          mergeId, tenantId, memorySpace, input.source_identity_id, input.target_identity_id,
          JSON.stringify(affectedLinkIds), input.confidence, input.reason, input.performed_by,
          input.created_by_person_id ?? null
        ]
      );
      return rows[0] as ConversationIdentityMerge;
    });
  }

  /**
   * Reverserer EN spesifikk, tidligere merge-hendelse (aldri en generisk
   * "angre siste merge"): kilde-identiteten reaktiveres, og EKSAKT de
   * lenkene `merge_id`-hendelsen omdirigerte flyttes tilbake. En allerede
   * reversert merge kan ikke reverseres på nytt (`conversation_merge_
   * already_reversed`) - hindrer en dobbel-split fra å kollidere.
   */
  async splitMerge(
    tenantId: string,
    memorySpace: MemorySpace,
    input: SplitMergeInput
  ): Promise<ConversationIdentityMerge> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const mergeRes = await client.query(
        `SELECT * FROM conversation_identity_merges WHERE tenant_id = $1 AND merge_id = $2 AND action = 'merge'`,
        [tenantId, input.merge_id]
      );
      const mergeRow = mergeRes.rows[0] as (ConversationIdentityMerge & { affected_link_ids: string[] }) | undefined;
      if (!mergeRow) throw new Error("conversation_merge_not_found");

      const alreadyReversed = await client.query(
        `SELECT 1 FROM conversation_identity_merges WHERE tenant_id = $1 AND reverses_merge_id = $2`,
        [tenantId, input.merge_id]
      );
      if ((alreadyReversed.rowCount ?? 0) > 0) throw new Error("conversation_merge_already_reversed");

      const affectedLinkIds = mergeRow.affected_link_ids;
      if (affectedLinkIds.length > 0) {
        await client.query(
          `UPDATE conversation_channel_links SET identity_id = $1, updated_at = now()
           WHERE tenant_id = $2 AND link_id = ANY($3::text[])`,
          [mergeRow.source_identity_id, tenantId, affectedLinkIds]
        );
      }
      await client.query(
        `UPDATE conversation_identities SET status = 'active', merged_into_identity_id = NULL, updated_at = now()
         WHERE tenant_id = $1 AND identity_id = $2`,
        [tenantId, mergeRow.source_identity_id]
      );

      const splitId = `conv-merge-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO conversation_identity_merges
           (merge_id, tenant_id, memory_space_id, action, source_identity_id, target_identity_id, reverses_merge_id, affected_link_ids, confidence, reason, performed_by, created_by_person_id)
         VALUES ($1, $2, $3, 'split', $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          splitId, tenantId, memorySpace, mergeRow.source_identity_id, mergeRow.target_identity_id, input.merge_id,
          JSON.stringify(affectedLinkIds), mergeRow.confidence, input.reason, input.performed_by,
          input.created_by_person_id ?? null
        ]
      );
      return rows[0] as ConversationIdentityMerge;
    });
  }

  /**
   * Akseptansekriterium 1 ("Open commitments and next actions visible
   * across channels") - GJENBRUKER `business_followups` UENDRET via den
   * allerede lenkede `business_contact_id`en (D-64: ingen ny
   * forpliktelse-silo). Identitet uten lenket kontakt gir tom liste
   * (ukjent forblir ukjent), aldri en gjettet kobling.
   */
  async crossChannelCommitments(
    tenantId: string,
    memorySpace: MemorySpace,
    identityId: string
  ): Promise<CrossChannelCommitment[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const contactId = await this.linkedContactId(client, tenantId, identityId);
      if (!contactId) return [];
      const { rows } = await client.query(
        `SELECT followup_id, title, reason, next_action, due_at, priority, status
         FROM business_followups WHERE tenant_id = $1 AND contact_id = $2 AND status = 'open'
         ORDER BY due_at ASC`,
        [tenantId, contactId]
      );
      return rows as CrossChannelCommitment[];
    });
  }

  /** "Hva har skjedd med denne motparten, på tvers av kanaler?" - gjenbruker `business_activities` (§7). */
  async identityTimeline(
    tenantId: string,
    memorySpace: MemorySpace,
    identityId: string
  ): Promise<IdentityTimelineEntry[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const contactId = await this.linkedContactId(client, tenantId, identityId);
      if (!contactId) return [];
      const { rows } = await client.query(
        `SELECT activity_id, activity_type, summary, canonical_uri, occurred_at
         FROM business_activities WHERE tenant_id = $1 AND contact_id = $2
         ORDER BY occurred_at DESC`,
        [tenantId, contactId]
      );
      return rows as IdentityTimelineEntry[];
    });
  }

  private async linkedContactId(client: pg.PoolClient, tenantId: string, identityId: string): Promise<string | null> {
    const { rows } = await client.query(
      `SELECT linked_business_contact_id FROM conversation_identities WHERE tenant_id = $1 AND identity_id = $2`,
      [tenantId, identityId]
    );
    const contactId = (rows[0] as { linked_business_contact_id: string | null } | undefined)?.linked_business_contact_id;
    return contactId ?? null;
  }
}
