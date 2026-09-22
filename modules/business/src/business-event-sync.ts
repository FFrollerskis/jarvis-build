import type pg from "pg";
import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import { listBusinessTenantIds } from "@jarvis/core";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { BusinessService } from "./service.ts";
import type { OpenLoopService } from "./open-loop-service.ts";

/**
 * UA-3 business-event-linkage (D-57): normaliserer Gmail/Calendar-hendelser
 * fra de EKSISTERENDE UA-0/UA-7-P0-connectorene (`GmailTransport`/
 * `GoogleCalendarTransport`, allerede host-bevist gjennom personlig daily
 * brief) inn i Business OS-tidslinjen ("Hva skjer med kunde X?" -
 * akseptansekriterium 1). Arkitektur (§7 i byggeordren): provider ->
 * eksisterende connector (via ToolGateway, SAMME trusted vei som daily
 * brief) -> deterministisk entitetsgjenkjenning (§9) -> `business_activities`
 * (idempotent via EKSISTERENDE `ON CONFLICT`, §10) -> open-loop-reevaluering
 * (§11, gjenbruker `OpenLoopService.runSweep()` uendret - ingen ny
 * open-loop-mekanisme).
 *
 * Kritisk arkitekturprinsipp (§15/DPIA): body-tekst/beskrivelse/vedlegg
 * flyter KUN gjennom denne funksjonen forbigående (for å finne
 * avsender/deltakere) - ALDRI lagret i `business_activities.summary`, som
 * kun får en kort, sikker, allerede-strukturert tekst (emne/tittel).
 * `canonical_uri` peker TILBAKE til kilden (Gmail-lenke/Calendar
 * `html_link`) - aldri en kopi av innholdet.
 *
 * Entitetsgjenkjenning er BEVISST fullt deterministisk (§9: "do not let an
 * LLM freely decide customer identity where deterministic keys exist") -
 * ingen AI Mesh-bruk i dette sliceet (samme valg som D-53 sin
 * open-loop-deteksjon). Ved 0 eller >1 treff (tvetydig) hoppes hendelsen
 * OVER - aldri en gjettet kobling ("never silently link the wrong
 * company").
 */

export interface GmailSyncStats {
  scanned: number;
  recorded: number;
  unmatched: number;
  ambiguous: number;
  /** Satt KUN ved en providerfeil (§9 i HOST FIX #1-ordren) - en sanitert, kort
   *  feilklasse (samme `result.reason`-tekst ToolGateway allerede gir, ALDRI
   *  et rått credential/token). Fravær betyr vellykket synk (kan fortsatt ha
   *  scanned=0 hvis ingen nye meldinger fantes). */
  error?: string;
}

export interface CalendarSyncStats {
  scanned: number;
  recorded: number;
  unmatched: number;
  ambiguous: number;
  /** Samme som `GmailSyncStats.error` - uavhengig av Gmail sin status. */
  error?: string;
}

export interface BusinessEventSyncResult {
  gmail: GmailSyncStats;
  calendar: CalendarSyncStats;
  open_loops_reevaluated: boolean;
}

interface GmailMessage {
  id?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  at?: string;
}

interface CalendarEvent {
  id?: string;
  title?: string;
  start?: string;
  html_link?: string;
  organizer?: string;
  attendees?: string[];
}

/**
 * Trekker ut e-postadressen fra et RFC 5322 "From"/"To"/"Cc"-headerfelt
 * (f.eks. `"Kari Nordmann" <kari@acme.no>` eller rett og slett
 * `kari@acme.no`). Rent, deterministisk - ingen nettverk/AI.
 */
export function extractEmailAddress(header: string | undefined | null): string | null {
  if (!header) return null;
  const angleMatch = header.match(/<([^<>]+)>/);
  const candidate = (angleMatch?.[1] ?? header).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate.toLowerCase() : null;
}

/**
 * Slår sammen From/To/Cc til et deduplisert sett av MOTPART-adresser (§7:
 * en e-post kan være INN (From=kunde) eller UT (To=kunde) - konto-eierens
 * egen adresse ekskluderes alltid, uansett hvilket felt den står i).
 */
export function extractCounterpartEmails(
  message: { from?: string; to?: string; cc?: string },
  accountEmail: string
): string[] {
  const account = accountEmail.trim().toLowerCase();
  const addresses = new Set<string>();
  for (const header of [message.from, message.to, message.cc]) {
    if (!header) continue;
    for (const part of header.split(",")) {
      const email = extractEmailAddress(part);
      if (email && email !== account) addresses.add(email);
    }
  }
  return [...addresses];
}

/**
 * Bounded, kort feilklasse for `syncTenant()` sin per-provider `error`-felt
 * (§9/§17 i HOST FIX #1-ordren) - ALDRI credential/token/authorization-
 * header-innhold. `err.message` her kommer UTELUKKENDE fra
 * `ToolGateway.execute()` sin egen `result.reason` (en kort, allerede
 * kontrollert klassifiseringsstreng som ToolGateway selv aldri fyller med
 * rå secret-verdier - se `gateway.ts` sin `deny()`/catch-håndtering), men
 * lengden begrenses likevel her som ekstra forsvar i dybden (samme
 * `.slice(0, N)`-presedens som ToolGateway selv bruker på tool-feilmeldinger).
 */
function sanitizeSyncError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 120);
}

export class BusinessEventSyncService {
  constructor(
    private readonly gateway: ToolGateway,
    private readonly business: BusinessService,
    private readonly openLoops: OpenLoopService,
    private readonly accountEmail: string = process.env["JARVIS_GOOGLE_ACCOUNT"] ?? "post@tsworkflow.com"
  ) {}

  async syncGmailActivities(
    tenantId: string,
    memorySpace: MemorySpace,
    identity: IdentityContext,
    opts: { max?: number; query?: string } = {}
  ): Promise<GmailSyncStats> {
    const stats: GmailSyncStats = { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 };
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
      const matched = await this.resolveUniqueContact(tenantId, memorySpace, counterparts);
      if (matched === "ambiguous") { stats.ambiguous++; continue; }
      if (!matched) { stats.unmatched++; continue; }
      await this.business.recordActivity(tenantId, memorySpace, {
        activity_type: "email",
        summary: `E-post: ${message.subject || "(uten emne)"}`,
        ...(matched.company_id !== null ? { company_id: matched.company_id } : {}),
        contact_id: matched.contact_id,
        source_type: "gmail",
        source_instance_id: this.accountEmail,
        external_id: message.id,
        canonical_uri: `https://mail.google.com/mail/u/0/#all/${message.id}`,
        ...(message.at !== undefined ? { occurred_at: message.at } : {})
      });
      stats.recorded++;
    }
    return stats;
  }

  async syncCalendarActivities(
    tenantId: string,
    memorySpace: MemorySpace,
    identity: IdentityContext,
    opts: { fromIso?: string; toIso?: string; max?: number } = {}
  ): Promise<CalendarSyncStats> {
    const stats: CalendarSyncStats = { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 };
    const now = new Date();
    const fromIso = opts.fromIso ?? new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const toIso = opts.toIso ?? new Date(now.getTime() + 7 * 86_400_000).toISOString();
    const result = await this.gateway.execute({
      identity, tool_id: "calendar", action: "list_events",
      parameters: { from: fromIso, to: toIso, max: opts.max ?? 25 }
    });
    if (!result.ok) throw new Error(result.reason);
    const events = ((result.data as { events?: JsonValue[] } | undefined)?.events ?? []) as CalendarEvent[];
    for (const event of events) {
      stats.scanned++;
      if (!event.id) continue;
      const counterparts = [
        ...(event.attendees ?? []),
        ...(event.organizer ? [event.organizer] : [])
      ].filter((email) => email.trim().toLowerCase() !== this.accountEmail.trim().toLowerCase());
      const matched = await this.resolveUniqueContact(tenantId, memorySpace, counterparts);
      if (matched === "ambiguous") { stats.ambiguous++; continue; }
      if (!matched) { stats.unmatched++; continue; }
      await this.business.recordActivity(tenantId, memorySpace, {
        activity_type: "meeting",
        summary: `Møte: ${event.title || "(uten tittel)"}`,
        ...(matched.company_id !== null ? { company_id: matched.company_id } : {}),
        contact_id: matched.contact_id,
        source_type: "calendar",
        source_instance_id: this.accountEmail,
        external_id: event.id,
        canonical_uri: event.html_link || `calendar:${this.accountEmail}:${event.id}`,
        ...(event.start !== undefined ? { occurred_at: event.start } : {})
      });
      stats.recorded++;
    }
    return stats;
  }

  /**
   * Full synkronisering for ÉN tenant: Gmail + Calendar, deretter en
   * målrettet open-loop-reevaluering (§11 - gjenbruker `OpenLoopService`
   * UENDRET, ingen ny mekanisme). Trygt å kalle gjentatte ganger
   * (idempotent via `recordActivity`s eksisterende `ON CONFLICT`).
   *
   * HOST FIX #1 (§9 i byggeordren, ekte host-funn run_id `7c5a5289`): Gmail
   * OG Calendar synkroniseres UAVHENGIG av hverandre - en feil i den ene
   * (f.eks. et midlertidig credential-/rate-limit-problem hos KUN én
   * provider) skal ALDRI skjule eller blokkere den andre. Feilen fanges her
   * (IKKE i selve `syncGmailActivities()`/`syncCalendarActivities()`, som
   * fortsatt kaster for direkte kallere som ønsker fail-fast) og
   * rapporteres som en sanitert `error`-streng PÅ DEN AKTUELLE providerens
   * stats-objekt - `result.reason` fra `ToolGateway.execute()` er allerede
   * en kort, kontrollert klassifiseringsstreng (f.eks.
   * "credential_unavailable"), ALDRI et rått credential/token (ToolGateway
   * logger/returnerer aldri selve secret-verdien).
   */
  async syncTenant(tenantId: string, memorySpace: MemorySpace, identity: IdentityContext): Promise<BusinessEventSyncResult> {
    const [gmail, calendar] = await Promise.all([
      this.syncGmailActivities(tenantId, memorySpace, identity).catch(
        (err: unknown): GmailSyncStats => ({ scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0, error: sanitizeSyncError(err) })
      ),
      this.syncCalendarActivities(tenantId, memorySpace, identity).catch(
        (err: unknown): CalendarSyncStats => ({ scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0, error: sanitizeSyncError(err) })
      )
    ]);
    await this.openLoops.runSweep(tenantId, memorySpace);
    return { gmail, calendar, open_loops_reevaluated: true };
  }

  /**
   * §9: eksakt ETT deterministisk kontakt-treff blant kandidat-adressene ->
   * matched; 0 treff -> `null` (unmatched); >1 DISTINKT selskap blant
   * treffene -> `"ambiguous"` (aldri gjett hvilket selskap som er riktig).
   */
  private async resolveUniqueContact(
    tenantId: string,
    memorySpace: MemorySpace,
    candidateEmails: string[]
  ): Promise<{ contact_id: string; company_id: string | null } | "ambiguous" | null> {
    let firstMatch: { contact_id: string; company_id: string | null } | null = null;
    const distinctCompanyIds = new Set<string | null>();
    for (const email of candidateEmails) {
      const contacts = await this.business.findContactsByEmail(tenantId, memorySpace, email);
      if (contacts.length > 1) return "ambiguous";
      if (contacts.length === 1) {
        const contact = contacts[0]!;
        firstMatch ??= { contact_id: contact.contact_id, company_id: contact.company_id };
        distinctCompanyIds.add(contact.company_id);
      }
    }
    if (!firstMatch) return null;
    if (distinctCompanyIds.size > 1) return "ambiguous";
    return firstMatch;
  }
}

/**
 * §19/§20 i byggeordren: periodisk kall-punkt for `DailyScheduler` (SAMME
 * reboot-durable, tenant-uavhengige claim-mekanisme som `business-open-loop-
 * sweep`/personlig daily brief - ingen ny kø). Itererer alle bedrifts-
 * tenants og synker hver uavhengig (bounded, LIMIT 200, samme mønster som
 * `runOpenLoopSweepForAllTenants`), tenant-scoped, trygt å kalle flere
 * ganger (selve synkroniseringen er idempotent). Én tenant sin feil (f.eks.
 * midlertidig Gmail-rate-limit) velter ALDRI resten.
 *
 * Q-27 (2026-08-18, D-65): tenant-katalogen leses via den DELTE, RLS-trygge
 * `listBusinessTenantIds()` (@jarvis/core) - ALDRI en rå `pool.query`
 * direkte mot `tenants` (som var strukturelt RLS-blind, se D-65).
 *
 * Kjent, dokumentert forenkling (ikke stille utelatt): alle bedrifts-
 * tenants deler i dag SAMME ene tilkoblede Google-konto
 * (`JARVIS_GOOGLE_ACCOUNT`) - deterministisk kontakt-e-post-gjenkjenning
 * sikrer likevel korrekt tenant-attribusjon selv fra én delt innboks (§7 i
 * DPIA-notatet). Per-tenant Gmail/Calendar-kall er heller ikke slått sammen
 * til ett felles hent-kall - akseptabelt for dagens fåtalls-tenant-skala,
 * en fremtidig optimalisering hvis tenant-antallet vokser (se Q-25).
 */
export async function runBusinessEventSyncForAllTenants(
  pool: pg.Pool,
  syncService: BusinessEventSyncService
): Promise<Record<string, BusinessEventSyncResult>> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const results: Record<string, BusinessEventSyncResult> = {};
  for (const tenantId of tenantIds) {
    const identity: IdentityContext = {
      person_id: "system", tenant_id: tenantId, memory_space_id: "business",
      session_id: `business-events-sync-${tenantId}`, device_id: "jarvis-core",
      channel: "api", auth_strength: "active"
    };
    try {
      results[tenantId] = await syncService.syncTenant(tenantId, "business", identity);
    } catch (err) {
      // Én tenant sin synk-feil skal aldri velte hele sveipet for andre tenants -
      // isolasjonen er UENDRET, kun stillheten var feilen (D-227, samme anti-mønster-klasse som D-218-222).
      console.error(JSON.stringify({
        msg: "business_event_sync_tenant_failed", tenant_id: tenantId,
        error: err instanceof Error ? err.message : String(err)
      }));
      results[tenantId] = {
        gmail: { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 },
        calendar: { scanned: 0, recorded: 0, unmatched: 0, ambiguous: 0 },
        open_loops_reevaluated: false
      };
    }
  }
  return results;
}
