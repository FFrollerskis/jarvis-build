/**
 * UA-7 Communications Hub - foerste slice (D-119): populerer Conversation
 * Graph fra ALLEREDE LIVE kanaler (Gmail/Telegram) - INGEN ny leverandoer,
 * INGEN nye credentials/scopes (D-108 uendret). Gjenbruker BEVISST samme
 * TRUSTED vei og samme deterministiske motpart-e-post-utledning som
 * `@jarvis/business` sin host-bevist `BusinessEventSyncService` (D-57/60)
 * - `extractCounterpartEmails`/`BusinessService.findContactsByEmail` -
 * IKKE en ny/parallell utlednings-logikk. Bygget som en EGEN, tynn
 * synk-tjeneste her (ikke en endring INNI `BusinessEventSyncService`) for
 * å unngå en sirkulaer pakkeavhengighet (`@jarvis/business` avhenger
 * ALDRI av `@jarvis/conversation-graph`) og for å ikke røre allerede
 * host-bevist kode.
 *
 * Sikkerhet (akseptansekriterium 2, "untrusted messages cannot directly
 * exfiltrate..."): meldingsinnhold (emne/brødtekst) leses ALDRI inn her -
 * KUN avsender-/mottaker-ADRESSER (samme Ingestion-Zone-disiplin som
 * `business-event-sync.ts` allerede håndhever, CLAUDE.md regel 7). En
 * kanal-identifikator er en STRUKTURERT identifikator (e-postadresse/
 * chat-id), aldri fritekst fra meldingsinnholdet - en injeksjons-forsøk i
 * selve meldingsteksten kan derfor IKKE påvirke hvilken identitet som
 * kobles (se `conversation-graph-security.test.ts`).
 */

import type pg from "pg";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import { extractCounterpartEmails, type BusinessService } from "@jarvis/business";
import { listBusinessTenantIds } from "@jarvis/core";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { ConversationGraphService } from "./service.ts";

export interface ConversationGraphSyncStats {
  scanned: number;
  linked: number;
  error?: string;
}

interface GmailMessage {
  id?: string;
  from?: string;
  to?: string;
  cc?: string;
}

export class ConversationGraphSyncService {
  constructor(
    private readonly gateway: ToolGateway,
    private readonly business: BusinessService,
    private readonly graph: ConversationGraphService,
    private readonly accountEmail: string = process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com"
  ) {}

  /**
   * Skanner nylige Gmail-meldinger (SAMME `email.list_messages`-verktoey
   * som `BusinessEventSyncService`) og kobler hver deterministisk
   * gjenkjente motpart-adresse til en Conversation Graph-identitet.
   * Trygt aa kalle gjentatte ganger (`linkChannelIdentity` er idempotent).
   */
  async syncGmailIdentities(
    tenantId: string,
    memorySpace: MemorySpace,
    identity: IdentityContext,
    opts: { max?: number; query?: string } = {}
  ): Promise<ConversationGraphSyncStats> {
    const stats: ConversationGraphSyncStats = { scanned: 0, linked: 0 };
    const result = await this.gateway.execute({
      identity, tool_id: "email", action: "list_messages",
      parameters: { max: opts.max ?? 25, ...(opts.query ? { query: opts.query } : {}) }
    });
    if (!result.ok) throw new Error(result.reason);
    const messages = ((result.data as { messages?: JsonValue[] } | undefined)?.messages ?? []) as GmailMessage[];
    for (const message of messages) {
      stats.scanned++;
      if (!message.id) continue;
      const counterparts = extractCounterpartEmails(message, this.accountEmail);
      for (const email of counterparts) {
        const contacts = await this.business.findContactsByEmail(tenantId, memorySpace, email);
        const linkedContactId = contacts.length === 1 ? contacts[0]!.contact_id : undefined;
        await this.graph.linkChannelIdentity(tenantId, memorySpace, {
          channel: "email",
          channel_identifier: email,
          confidence: 1.0,
          match_method: "exact_email",
          source_type: "gmail",
          source_instance_id: this.accountEmail,
          external_id: message.id,
          ...(linkedContactId !== undefined ? { linked_business_contact_id: linkedContactId } : {})
        });
        stats.linked++;
      }
    }
    return stats;
  }

  /**
   * Ett-gangs, idempotent seeding av eierens egen Telegram-kanal-identitet
   * (allerede LIVE+VERIFIED bot, RUNTIME_GATES.md) - `confidence=1.0`,
   * `match_method='owner_configured'` (eieren har selv konfigurert
   * `JARVIS_TELEGRAM_CHAT_ID`, ikke et deterministisk e-post-oppslag).
   */
  async linkOwnerTelegramIdentity(
    tenantId: string,
    memorySpace: MemorySpace,
    chatId: string,
    ownerPersonId?: string
  ) {
    return this.graph.linkChannelIdentity(tenantId, memorySpace, {
      channel: "telegram",
      channel_identifier: chatId,
      confidence: 1.0,
      match_method: "owner_configured",
      source_type: "telegram",
      source_instance_id: chatId,
      ...(ownerPersonId !== undefined ? { linked_person_id: ownerPersonId, created_by_person_id: ownerPersonId } : {})
    });
  }
}

export function createConversationGraphSyncService(
  gateway: ToolGateway,
  business: BusinessService,
  graph: ConversationGraphService
): ConversationGraphSyncService {
  return new ConversationGraphSyncService(gateway, business, graph);
}

/**
 * Periodisk kall-punkt for `DailyScheduler` (SAMME mønster som
 * `runBusinessEventSyncForAllTenants` i `@jarvis/business`, inkl. Q-27 sin
 * RLS-trygge `listBusinessTenantIds()` - ALDRI en rå `pool.query` mot
 * `tenants`). Én tenant sin feil velter aldri resten.
 */
export async function runConversationGraphSyncForAllTenants(
  pool: pg.Pool,
  syncService: ConversationGraphSyncService
): Promise<Record<string, ConversationGraphSyncStats>> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, ConversationGraphSyncStats> = {};
  for (const tenantId of tenantIds) {
    const identity: IdentityContext = {
      person_id: "system", tenant_id: tenantId, memory_space_id: "business",
      session_id: `conversation-graph-sync-${tenantId}`, device_id: "jarvis-core",
      channel: "api", auth_strength: "active"
    };
    try {
      results[tenantId] = await syncService.syncGmailIdentities(tenantId, "business", identity);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results[tenantId] = { scanned: 0, linked: 0, error: message.slice(0, 120) };
    }
  }
  return results;
}
