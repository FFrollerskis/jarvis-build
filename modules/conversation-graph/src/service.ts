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
 * 'ai_assisted' som en gyldig utfoerer av selve handlingen.
 *
 * D-119 SECURITY HARDENING (pre-merge, PR #67): denne SERVICE-en er den
 * TILTRODDE interne API-en (`mergeIdentities()`/`splitMerge()` forblir
 * fullt implementert og testet), MEN den er IKKE lenger nådd via
 * ToolGateway (se `transport.ts`) - ekstern final-review fant at
 * `ConversationGraphTransport` tidligere aksepterte `performed_by` UKRITISK
 * fra kallerparametre, som ville latt ETHVERT tool/model-kall skrive
 * `performed_by: "owner"` og dermed FORFALSKE eier-proveniens (§4/§5C i
 * herdingsordren - "owner identity is executing a Jarvis conversation" er
 * IKKE det samme som "Tobias manually asserted this specific identity
 * merge is correct"). Fremfor å bygge en helt ny, uprøvd signert
 * godkjenningsvei INN i denne PR-en (høyere risiko enn selve funnet),
 * fjernes `merge_identities`/`split_merge` fra det modell-/kall-synlige
 * verktøyoverflaten helt til en ekte, tiltrodd eier-godkjenningsvei
 * finnes (§6: "Correct architecture > test-count preservation") - selve
 * metodene her forblir klare for (a) en fremtidig deterministisk
 * auto-lenke-sveip (`performed_by='deterministic_rule'`, kalt DIREKTE fra
 * tiltrodd internkode, ALDRI via ToolGateway) eller (b) en fremtidig
 * eier-only administrasjonsvei.
 *
 * Multi-hop reversibilitet (§13/§14 i herdingsordren): en flertrinns
 * merge-kjede (A->B, deretter B->C) krever at `splitMerge()` ALDRI
 * overskriver tilstand en SENERE, fortsatt aktiv merge har skapt.
 * `splitMerge()` sjekker derfor at merge-hendelsens `target_identity_id`
 * fortsatt er `status='active'` FØR reversering - er target selv siden
 * slått sammen videre (B->C), avvises splitten eksplisitt
 * (`conversation_split_blocked_by_later_merge`) og kalleren må reversere i
 * omvendt avhengighetsrekkefølge (B->C FØR A->B) - ALDRI en stille,
 * korrupt tilstandsoverskriving. `resolveEffectiveIdentity()` gir en
 * deterministisk "hvem er den nåværende eieren" langs kjeden UTEN å endre
 * selve tombstone-/peker-mekanikken (Case 3).
 *
 * Samtidighet (§15/§17): `splitMerge()` låser merge-raden (`FOR UPDATE`)
 * FØR allerede-reversert-sjekken (hindrer to samtidige splitter av SAMME
 * merge - forsterket av en delvis unik DB-indeks som andre lag, se
 * migrasjonen); `mergeIdentities()` låser de to identitetsradene i
 * DETERMINISTISK (sortert identity_id-) rekkefølge, ALDRI kilde-så-mål,
 * for å unngå en unngåelig lock-order-inversjons-deadlock mellom to
 * motsatte samtidige merge-forsøk (A->B og B->A); `linkChannelIdentity()`
 * tar en Postgres advisory-transaksjonslås på
 * `(tenant_id, channel, channel_identifier)` FØR den sjekker/oppretter en
 * ny identitet naar `identity_id` ikke oppgis - lukker den tidligere
 * dokumenterte "harmløse" samtidig-foerste-lenke-race-en strukturelt i
 * stedet for å godta et fantom-identitets-utfall (§16).
 *
 * Kryss-tenant-pekere (§11/§12): Postgres sine FOREIGN KEY-sjekker
 * respekterer IKKE Row Level Security (bevist empirisk mot ekte embedded
 * Postgres under denne herdingsrunden - en FK-referanse til en rad i en
 * ANNEN tenant lykkes selv om RLS ville skjult raden for en vanlig
 * SELECT). `linkChannelIdentity()` verifiserer derfor EKSPLISITT, i SAMME
 * transaksjon, at et oppgitt `identity_id` tilhører DENNE tenanten (og er
 * aktiv), at `linked_business_contact_id` tilhører DENNE tenanten
 * (`business_contacts.tenant_id`), og at `linked_person_id` faktisk er
 * medlem av DENNE tenanten (`person_tenants`) - FØR noen INSERT/UPDATE.
 * `mergeIdentities()` gjorde dette allerede korrekt (eksplisitt
 * `WHERE tenant_id = $1`-oppslag, ikke bare FK-tillit).
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

  /**
   * Følger `merged_into_identity_id`-pekeren transitivt til den nåværende
   * AKTIVE identiteten (§13 Case 3: "there must be a deterministic
   * definition of current/effective identity - no caller should need to
   * guess"). Rent additivt lese-oppslag - endrer ALDRI selve
   * tombstone-/peker-mekanikken `mergeIdentities()`/`splitMerge()`
   * vedlikeholder. Sirkel-trygg (begrenset antall hopp); returnerer `null`
   * hvis kjeden er brutt (peker til en slettet/ukjent rad - skal aldri
   * skje under normal drift, men fail-safe fremfor en uendelig løkke).
   */
  async resolveEffectiveIdentity(
    tenantId: string,
    memorySpace: MemorySpace,
    identityId: string
  ): Promise<ConversationIdentity | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      let currentId: string | null = identityId;
      const seen = new Set<string>();
      for (let hop = 0; hop < 50 && currentId !== null; hop++) {
        if (seen.has(currentId)) return null; // defensiv sirkel-vakt, skal aldri inntreffe
        seen.add(currentId);
        const { rows } = await client.query(
          `SELECT * FROM conversation_identities WHERE tenant_id = $1 AND identity_id = $2`,
          [tenantId, currentId]
        );
        const row = rows[0] as ConversationIdentity | undefined;
        if (!row) return null;
        if (row.status === "active") return row;
        currentId = row.merged_into_identity_id;
      }
      return null;
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
   * D-119 SECURITY HARDENING: advisory-lås på `(tenant_id, channel,
   * channel_identifier)` FØR eksistenssjekken lukker den TIDLIGERE
   * dokumenterte samtidig-foerste-lenke-racen strukturelt (§16) - to
   * samtidige kall for SAMME nye identifikator serialiseres nå, den andre
   * finner og gjenbruker identiteten den første opprettet, ALDRI to
   * separate identitetsrader. Eksplisitt tenant-eierskapsvalidering av
   * `identity_id`/`linked_business_contact_id`/`linked_person_id` (§11/§12
   * - Postgres FK-sjekker respekterer IKKE RLS, bevist empirisk under
   * denne herdingsrunden) hindrer en kryss-tenant-pekerkorrupsjon.
   */
  async linkChannelIdentity(
    tenantId: string,
    memorySpace: MemorySpace,
    input: LinkChannelIdentityInput
  ): Promise<ConversationChannelLink> {
    const normalized = normalizeChannelIdentifier(input.channel, input.channel_identifier);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      let identityId = input.identity_id;
      if (identityId) {
        // §11/§12: et oppgitt identity_id MÅ tilhøre DENNE tenanten og være aktivt -
        // FK alene beviser IKKE tenant-eierskap (RLS-blind FK-sjekk, se filhode).
        const owned = await client.query(
          `SELECT 1 FROM conversation_identities WHERE tenant_id = $1 AND identity_id = $2 AND status = 'active'`,
          [tenantId, identityId]
        );
        if ((owned.rowCount ?? 0) === 0) throw new Error("conversation_identity_not_found");
      } else {
        // §16: serialiser samtidige foerste-lenke-forsoek for SAMME identifikator -
        // en transaksjonsskopet advisory-laas, frigitt automatisk ved COMMIT/ROLLBACK.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
          `conv:${tenantId}:${input.channel}`,
          normalized
        ]);
        const existing = await client.query(
          `SELECT identity_id FROM conversation_channel_links
           WHERE tenant_id = $1 AND channel = $2 AND channel_identifier = $3 AND status = 'active'`,
          [tenantId, input.channel, normalized]
        );
        if (existing.rows.length === 1) {
          identityId = (existing.rows[0] as { identity_id: string }).identity_id;
        }
      }
      if (input.linked_business_contact_id !== undefined) {
        const owned = await client.query(
          `SELECT 1 FROM business_contacts WHERE tenant_id = $1 AND contact_id = $2`,
          [tenantId, input.linked_business_contact_id]
        );
        if ((owned.rowCount ?? 0) === 0) throw new Error("conversation_linked_contact_not_found");
      }
      if (input.linked_person_id !== undefined) {
        const owned = await client.query(
          `SELECT 1 FROM person_tenants WHERE tenant_id = $1 AND person_id = $2`,
          [tenantId, input.linked_person_id]
        );
        if ((owned.rowCount ?? 0) === 0) throw new Error("conversation_linked_person_not_found");
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
   * types.ts. IKKE nådd via ToolGateway (se filhode, D-119 SECURITY
   * HARDENING) - kun tiltrodd internkode kaller denne metoden direkte.
   *
   * D-119 SECURITY HARDENING (§17): de to identitetsradene låses i
   * DETERMINISTISK (sortert identity_id-streng-) rekkefølge, ALDRI
   * ubetinget kilde-så-mål - to motsatte samtidige merge-forsøk (A->B og
   * B->A) laaser da ALLTID i SAMME rekkefoelge og kan derfor ikke
   * deadlocke hverandre (Postgres sin egen deadlock-detector ville uansett
   * til slutt avbrutt en av dem, men en UNNGAAELIG deadlock er en
   * kvalitetsfeil, ikke en aksepert risiko naar den er triviell å unngå).
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
      const lockOrder = [input.source_identity_id, input.target_identity_id].sort();
      for (const id of lockOrder) {
        await client.query(`SELECT 1 FROM conversation_identities WHERE tenant_id = $1 AND identity_id = $2 FOR UPDATE`, [tenantId, id]);
      }
      const sourceRes = await client.query(
        `SELECT * FROM conversation_identities WHERE tenant_id = $1 AND identity_id = $2`,
        [tenantId, input.source_identity_id]
      );
      const targetRes = await client.query(
        `SELECT * FROM conversation_identities WHERE tenant_id = $1 AND identity_id = $2`,
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
   * already_reversed`) - hindrer en dobbel-split fra å kollidere. IKKE
   * nådd via ToolGateway (se filhode).
   *
   * D-119 SECURITY HARDENING: merge-raden låses (`FOR UPDATE`) FØR
   * allerede-reversert-sjekken (§15 - to samtidige `splitMerge()`-kall for
   * SAMME merge serialiseres nå: den andre transaksjonen venter til den
   * første er ferdig, ser deretter `already_reversed=true` og avviser
   * korrekt - forsterket av en delvis unik DB-indeks i migrasjonen som
   * SISTE forsvarslinje). Multi-hop-vakt (§13/§14): reverserer ALDRI en
   * merge hvis maal-identiteten siden er slaatt sammen videre (en SENERE
   * aktiv merge) - avviser eksplisitt fremfor aa risikere aa flytte lenker
   * ut fra under en fortsatt aktiv senere sammenslaaing.
   */
  async splitMerge(
    tenantId: string,
    memorySpace: MemorySpace,
    input: SplitMergeInput
  ): Promise<ConversationIdentityMerge> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const mergeRes = await client.query(
        `SELECT * FROM conversation_identity_merges WHERE tenant_id = $1 AND merge_id = $2 AND action = 'merge' FOR UPDATE`,
        [tenantId, input.merge_id]
      );
      const mergeRow = mergeRes.rows[0] as (ConversationIdentityMerge & { affected_link_ids: string[] }) | undefined;
      if (!mergeRow) throw new Error("conversation_merge_not_found");

      const alreadyReversed = await client.query(
        `SELECT 1 FROM conversation_identity_merges WHERE tenant_id = $1 AND reverses_merge_id = $2`,
        [tenantId, input.merge_id]
      );
      if ((alreadyReversed.rowCount ?? 0) > 0) throw new Error("conversation_merge_already_reversed");

      const targetRes = await client.query(
        `SELECT status FROM conversation_identities WHERE tenant_id = $1 AND identity_id = $2`,
        [tenantId, mergeRow.target_identity_id]
      );
      const targetStatus = (targetRes.rows[0] as { status: string } | undefined)?.status;
      if (targetStatus === undefined) throw new Error("conversation_merge_target_not_found");
      if (targetStatus !== "active") {
        throw new Error("conversation_split_blocked_by_later_merge");
      }

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
