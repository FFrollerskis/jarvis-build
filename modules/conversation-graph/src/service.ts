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
// D-121: DEN delte prioriteringsregelen fra `@jarvis/business` - aldri en
// nesten-lik kopi (se `classifyAttentionBucket` i open-loop-types.ts).
import { classifyAttentionBucket } from "@jarvis/business";
import { normalizeChannelIdentifier } from "./normalize.ts";
import type {
  AttentionIdentityReach,
  ChannelReach,
  ConversationChannel,
  ConversationChannelLink,
  ConversationIdentity,
  ConversationIdentityMerge,
  CrossChannelAttentionEntry,
  CrossChannelCommitment,
  CrossChannelCommitmentEntry,
  CrossChannelCommitmentView,
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
    // D-121: selve traverseringen bor i `resolveEffectiveIdentityIn()` slik at
    // de sammensatte tverr-kanal-oppslagene kan gjenbruke NOEYAKTIG samme
    // kjede-logikk INNENFOR sin egen transaksjon - aldri to kopier som kan
    // divergere. Atferden her er UENDRET fra D-119.
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], (client) =>
      this.resolveEffectiveIdentityIn(client, tenantId, identityId)
    );
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
   *
   * D-121: `linkedContactId()` foelger nå merge-kjeden (se den metodens
   * kommentar) - denne handlingens RETURFORM er UENDRET (kun aapne
   * `business_followups`), den er den smale, bakoverkompatible visningen.
   * Den FULLSTENDIGE visningen (neste handlinger fra `business_open_loops`
   * + kanal-naabarhet + eksplisitt resolusjonstilstand) er
   * `crossChannelCommitmentView()`.
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

  /**
   * UA-7 slice 2 (D-121), akseptansekriterium 1 FULLT UT: "Open commitments
   * AND NEXT ACTIONS visible ACROSS CHANNELS".
   *
   * Tre ting D-119 sin `crossChannelCommitments()` manglet, alle uten noen
   * ny tabell og uten noen ny leverandoer:
   *
   * 1. **Neste handlinger.** `business_followups` er KUN de eksplisitt
   *    opprettede oppfoelgingene. Den deterministisk detekterte
   *    "neste handling"-kolonnen er `business_open_loops.next_action` - et
   *    SEPARAT, allerede eksisterende system-of-record (020_business_open_
   *    loops.sql) som dekker forfalte oppfoelginger, stagnerte muligheter,
   *    support-tickets, kontraktsfrister og finans-avvik. Unionen av de to
   *    er det akseptansekriteriet ordrett ber om. INGEN tredje
   *    forpliktelses-tabell opprettes (D-64 system-of-record-audit).
   * 2. **Merge-korrekthet.** Se `linkedContactId()`.
   * 3. **Kanal-naabarhet.** "Across channels" krever at kalleren faktisk kan
   *    SE hvilke kanaler motparten er naabar paa - unionen av de AKTIVE
   *    kanal-lenkene til den EFFEKTIVE identiteten (etter merge), hver med
   *    sin confidence/match_method-proveniens.
   *
   * `resolution` skiller EKSPLISITT mellom "ingenting aapent",
   * "identiteten finnes ikke" og "vi vet ikke hvem dette er" - en tom
   * `commitments`-liste er ellers tvetydig. Proveniensen til hver rad
   * (`explicit`/`deterministic`/`ai_assisted`) gjengis UENDRET fra kilden -
   * en ai_assisted-detektert neste handling blir ALDRI stille presentert som
   * deterministisk bevist (byggeordrens promoterings-regel).
   *
   * Rent lese-oppslag: ingen INSERT/UPDATE/DELETE noe sted i denne metoden.
   */
  async crossChannelCommitmentView(
    tenantId: string,
    memorySpace: MemorySpace,
    identityId: string,
    now: number = Date.now()
  ): Promise<CrossChannelCommitmentView> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const effective = await this.resolveEffectiveIdentityIn(client, tenantId, identityId);
      if (!effective) {
        return {
          requested_identity_id: identityId, effective_identity_id: null,
          resolution: "identity_not_found", display_name: null,
          linked_business_contact_id: null, channels: [], commitments: []
        };
      }
      const channels = await this.activeChannelReach(client, tenantId, effective.identity_id);
      const base = {
        requested_identity_id: identityId,
        effective_identity_id: effective.identity_id,
        display_name: effective.display_name,
        linked_business_contact_id: effective.linked_business_contact_id,
        channels
      };
      if (!effective.linked_business_contact_id) {
        return { ...base, resolution: "no_linked_contact" as const, commitments: [] };
      }
      const commitments = await this.commitmentsForContacts(
        client, tenantId, [effective.linked_business_contact_id], now
      );
      return { ...base, resolution: "resolved" as const, commitments: commitments.map((c) => c.entry) };
    });
  }

  /**
   * D-121: tenant-bred "hva er aapent paa tvers av kanaler NAA?". Samme to
   * systems-of-record, samme prioriteringsregel som
   * `OpenLoopService.attentionQueue()` - forskjellen er at HVER rad her
   * baerer sin kanal-naabarhet, og at forpliktelser UTEN noen
   * kommunikasjonsidentitet rapporteres EKSPLISITT
   * (`channel_reachable: false`) i stedet for aa forsvinne stille. Det er
   * nettopp den aerlige halvparten akseptansekriteriet trenger: en
   * forpliktelse ingen kanal naar er et REELT gap, ikke en tom liste.
   *
   * Sortert paa forfall (nullbare frister sist), deretter kilde-id for en
   * deterministisk, stabil rekkefoelge.
   *
   * D-121 REVIEW-FIKS ("across channels" var ikke sant naar EN kontakt har
   * FLERE aktive identiteter): den foerste implementasjonen valgte den
   * eldste aktive identiteten per kontakt og leste kanaler KUN fra den.
   * `046_conversation_graph.sql:94` har ingen unikhets-skranke paa
   * `(tenant_id, linked_business_contact_id)` for aktive identiteter, saa
   * flere aktive identiteter kan lovlig peke paa samme kanoniske kontakt
   * (to uavhengig opprettede kanal-identiteter lenket til samme kontakt uten
   * en eksplisitt `mergeIdentities()`). Konsekvensen var reell og todelt:
   * aktive kanaler paa en SENERE identitet ble stille utelatt, og en
   * kontakt hvis eldste identitet kun hadde REVOKERTE lenker ble rapportert
   * `channel_reachable=false` selv om en annen aktiv identitet var fullt
   * naabar - altsaa et FALSKT "vi naar ikke denne". Naa aggregeres
   * rekkevidden over ALLE aktive identiteter for kontakten, og
   * returformen baerer `identities[]` slik at hver kanal fortsatt kan
   * attribueres eksakt til identiteten som eier den - aldri merket som om
   * den tilhoerte EN vilkaarlig valgt identitet. Ingen identitet og ingen
   * kanal droppes. Merge-mekanikken er UROERT: en tombstonet identitet er
   * fortsatt ekskludert av `status = 'active'`, og `splitMerge()` gir
   * uendret det reaktiverte bildet tilbake.
   */
  async crossChannelAttention(
    tenantId: string,
    memorySpace: MemorySpace,
    now: number = Date.now()
  ): Promise<CrossChannelAttentionEntry[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const commitments = await this.commitmentsForContacts(client, tenantId, null, now);
      const contactIds = [...new Set(commitments.map((c) => c.contact_id).filter((id): id is string => id !== null))];

      // Kun AKTIVE identiteter: en tombstonet (sammenslaatt) identitet skal
      // aldri dukke opp som en egen rad - dens kanaler tilhoerer naa
      // maal-identiteten (som selv er aktiv og staar for kontakten).
      //
      // D-121 REVIEW-FIKS: ALLE aktive identiteter for kontakten samles, ikke
      // bare den eldste. Se `AttentionIdentityReach` i types.ts for hvorfor
      // flere aktive identiteter per kontakt er en LOVLIG skjematilstand.
      const identitiesByContact = new Map<string, ConversationIdentity[]>();
      if (contactIds.length > 0) {
        const { rows } = await client.query(
          `SELECT * FROM conversation_identities
           WHERE tenant_id = $1 AND status = 'active' AND linked_business_contact_id = ANY($2::text[])
           ORDER BY created_at ASC, identity_id ASC`,
          [tenantId, contactIds]
        );
        for (const row of rows as ConversationIdentity[]) {
          if (!row.linked_business_contact_id) continue;
          const existing = identitiesByContact.get(row.linked_business_contact_id);
          if (existing) existing.push(row);
          else identitiesByContact.set(row.linked_business_contact_id, [row]);
        }
      }

      // Kanal-oppslag EN gang per kontakt (ikke per forpliktelse) - flere
      // forpliktelser deler typisk kontakt, og oppslaget er rent lesende.
      const reachByContact = new Map<string, { identities: AttentionIdentityReach[]; channels: ChannelReach[] }>();
      for (const [contactId, identities] of identitiesByContact) {
        const perIdentity: AttentionIdentityReach[] = [];
        for (const identity of identities) {
          perIdentity.push({
            identity_id: identity.identity_id,
            display_name: identity.display_name,
            channels: await this.activeChannelReach(client, tenantId, identity.identity_id)
          });
        }
        // Unionen kan IKKE inneholde duplikater: `conversation_channel_links_
        // active_unique_idx` (046:124-126) er unik paa (tenant_id, channel,
        // channel_identifier) WHERE status='active', saa den samme naabare
        // adressen kan aldri vaere aktiv paa to identiteter samtidig. Derfor
        // flates listene sammen UTEN aa droppe noe - kun deterministisk
        // sortert med SAMME regel som `activeChannelReach()` bruker internt.
        const channels = perIdentity
          .flatMap((i) => i.channels)
          .sort((a, b) =>
            a.channel === b.channel
              ? a.channel_identifier < b.channel_identifier ? -1 : a.channel_identifier > b.channel_identifier ? 1 : 0
              : a.channel < b.channel ? -1 : 1
          );
        reachByContact.set(contactId, { identities: perIdentity, channels });
      }

      const entries: CrossChannelAttentionEntry[] = [];
      for (const { contact_id, entry } of commitments) {
        const reach = contact_id !== null ? reachByContact.get(contact_id) : undefined;
        const identities = reach?.identities ?? [];
        const channels = reach?.channels ?? [];
        entries.push({
          identities,
          contact_id,
          channels,
          // Naabar hvis MINST EN identitet naar frem - en eldste identitet
          // med kun revokerte lenker skal ALDRI overstyre en senere,
          // faktisk naabar identitet for samme kontakt.
          channel_reachable: channels.length > 0,
          commitment: entry
        });
      }
      return entries;
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

  /**
   * D-121 KORREKTHETSFIKS: slaar opp kontakten via den EFFEKTIVE identiteten
   * (`resolveEffectiveIdentity`-kjeden), ikke via den forespurte raden
   * direkte.
   *
   * FOER denne fiksen leste `crossChannelCommitments()`/`identityTimeline()`
   * `linked_business_contact_id` rett fra den forespurte raden. En
   * TOMBSTONET (`status='merged'`) identitet beholder sin EGEN, naa
   * historiske `linked_business_contact_id` - som per D-119 sin merge-
   * mekanikk kan vaere `NULL` eller en ANNEN kontakt enn maal-identitetens.
   * En kaller som slo opp via en kanal-identifikator som SIDEN ble slaatt
   * sammen fikk derfor enten en tom liste eller kontaktens FOER-merge-bilde -
   * altsaa nettopp det tverr-kanal-bildet merge-en fantes for aa skape.
   * Aa foelge kjeden er additivt og endrer ALDRI selve tombstone-/peker-
   * mekanikken `mergeIdentities()`/`splitMerge()` vedlikeholder; en
   * etterfoelgende `splitMerge()` reaktiverer kilden og oppslaget gaar
   * automatisk tilbake til foer-merge-bildet (reversibilitet bevart).
   */
  private async linkedContactId(client: pg.PoolClient, tenantId: string, identityId: string): Promise<string | null> {
    const effective = await this.resolveEffectiveIdentityIn(client, tenantId, identityId);
    return effective?.linked_business_contact_id ?? null;
  }

  /**
   * Samme deterministiske merge-kjede-traversering som
   * `resolveEffectiveIdentity()`, men INNENFOR en allerede aapen
   * RLS-transaksjon - slik at et sammensatt oppslag ser ETT konsistent
   * snapshot i stedet for aa aapne en ny transaksjon per ledd.
   */
  private async resolveEffectiveIdentityIn(
    client: pg.PoolClient,
    tenantId: string,
    identityId: string
  ): Promise<ConversationIdentity | null> {
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
  }

  /** Kun AKTIVE kanal-lenker: en revokert lenke er historikk, ALDRI en kanal noen kan naas paa naa. */
  private async activeChannelReach(
    client: pg.PoolClient,
    tenantId: string,
    identityId: string
  ): Promise<ChannelReach[]> {
    const { rows } = await client.query(
      `SELECT channel, channel_identifier, confidence, match_method
       FROM conversation_channel_links
       WHERE tenant_id = $1 AND identity_id = $2 AND status = 'active'
       ORDER BY channel ASC, channel_identifier ASC`,
      [tenantId, identityId]
    );
    return rows as ChannelReach[];
  }

  /**
   * Unionen av de to EKSISTERENDE forpliktelses-systems-of-record, uten aa
   * endre noen av dem. `contactIds === null` betyr "hele tenanten"
   * (tenant-bred visning); en liste betyr "kun disse kontaktene".
   *
   * `business_open_loops` filtreres bevisst IKKE paa `contact_id IS NOT NULL`
   * i tenant-bred modus - en finans-/kontrakt-loop uten motpart er en helt
   * reell aapen neste handling, den er bare ikke kanal-naabar (og merkes
   * saann). I identitets-modus filtreres den derimot naturlig bort av
   * kontakt-filteret.
   */
  private async commitmentsForContacts(
    client: pg.PoolClient,
    tenantId: string,
    contactIds: string[] | null,
    now: number
  ): Promise<Array<{ contact_id: string | null; entry: CrossChannelCommitmentEntry }>> {
    const scoped = contactIds !== null;
    if (scoped && contactIds.length === 0) return [];

    const followups = await client.query(
      `SELECT followup_id, contact_id, title, reason, next_action, due_at, priority
       FROM business_followups
       WHERE tenant_id = $1 AND status = 'open'
         AND ($2::boolean = false OR contact_id = ANY($3::text[]))`,
      [tenantId, scoped, contactIds ?? []]
    );
    const openLoops = await client.query(
      `SELECT open_loop_id, contact_id, loop_type, reason, next_action, due_at, priority,
              detection_method, canonical_uri
       FROM business_open_loops
       WHERE tenant_id = $1 AND status = 'open'
         AND ($2::boolean = false OR contact_id = ANY($3::text[]))`,
      [tenantId, scoped, contactIds ?? []]
    );

    const toIso = (value: Date | string | null): string | null =>
      value === null ? null : value instanceof Date ? value.toISOString() : value;

    const entries: Array<{ contact_id: string | null; entry: CrossChannelCommitmentEntry }> = [];
    for (const row of followups.rows as Array<{
      followup_id: string; contact_id: string | null; title: string; reason: string | null;
      next_action: string | null; due_at: Date | string; priority: "low" | "normal" | "high";
    }>) {
      const dueAt = toIso(row.due_at);
      entries.push({
        contact_id: row.contact_id,
        entry: {
          source_kind: "business_followup", source_id: row.followup_id,
          title: row.title, reason: row.reason, next_action: row.next_action, due_at: dueAt,
          priority: row.priority, provenance: "explicit", canonical_uri: null,
          bucket: classifyAttentionBucket(row.priority, dueAt, now)
        }
      });
    }
    for (const row of openLoops.rows as Array<{
      open_loop_id: string; contact_id: string | null; loop_type: string; reason: string;
      next_action: string | null; due_at: Date | string | null; priority: "low" | "normal" | "high";
      detection_method: "deterministic" | "ai_assisted"; canonical_uri: string | null;
    }>) {
      const dueAt = toIso(row.due_at);
      entries.push({
        contact_id: row.contact_id,
        entry: {
          source_kind: "business_open_loop", source_id: row.open_loop_id,
          // `business_open_loops` har ingen `title`-kolonne - `loop_type` ER den
          // deterministiske, oversettbare tittelen (aldri en LLM-generert tekst).
          title: row.loop_type, reason: row.reason, next_action: row.next_action, due_at: dueAt,
          priority: row.priority, provenance: row.detection_method, canonical_uri: row.canonical_uri,
          bucket: classifyAttentionBucket(row.priority, dueAt, now)
        }
      });
    }

    // Deterministisk, stabil rekkefoelge: forfall foerst (uten frist sist),
    // deretter kilde-id - ALDRI en databasens tilfeldige radrekkefoelge.
    entries.sort((a, b) => {
      if (a.entry.due_at === b.entry.due_at) {
        return a.entry.source_id < b.entry.source_id ? -1 : a.entry.source_id > b.entry.source_id ? 1 : 0;
      }
      if (a.entry.due_at === null) return 1;
      if (b.entry.due_at === null) return -1;
      return a.entry.due_at < b.entry.due_at ? -1 : 1;
    });
    return entries;
  }
}
