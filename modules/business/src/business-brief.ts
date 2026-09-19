import type pg from "pg";
import { listBusinessTenantIds } from "@jarvis/core";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction } from "@jarvis/memory";
import { deliverChunkedTextViaTelegram, type BriefItem, type BriefSource, type ToolGateway } from "@jarvis/tool-gateway";
import type { OpenLoopService } from "./open-loop-service.ts";
import type { BusinessDomain } from "./open-loop-types.ts";

/**
 * UA-3 next slice (D-53): forretnings-brief. Gjenbruker EKSISTERENDE
 * `DailyBrief`-motoren (`@jarvis/tool-gateway`) uendret for DAGLIG rapport
 * via `businessOpenLoopsSource()` - ingen ny/parallell brief-motor. Motoren
 * sin egen dedupe/prioritering/rendering brukes som den er; denne filen
 * leverer KUN en ny `BriefSource`.
 *
 * UKENTLIG rapport er BEVISST en egen, liten funksjon (`generateWeeklyBrief`)
 * i STEDET for aa presse historikk-vindu-spoerringer inn i `DailyBrief`
 * (som modellerer "naavaerende snapshot", ikke et 7-dagers tilbakeblikk) -
 * dette er en presis utvidelse av SAMME domene (@jarvis/business), ikke en
 * andre urelatert brief-motor (§13 i byggeordren).
 */

/**
 * §15: akseptansekriterium 2 ("kombinerer sales, product, finance, marketing, operations")
 * krever ALLE fem domener. Brief-en MÅ si eksplisitt fra hvilke domener som faktisk er dekket,
 * ALDRI late som et udekket domene er dekket.
 *
 * `status` og `live_provider_connected` er BEVISST to separate felt (D-78 - UA-4 Growth →
 * Business Domain Coverage-integrasjonen), ALDRI slått sammen til én overbelastet boolean:
 * - `status: "available"` betyr KUN at Jarvis har en kanonisk, intern (JARVIS_CANONICAL)
 *   kapabilitet for domenet - f.eks. `sales` via Business Graph/CRM, `marketing` via Native
 *   Jarvis Growth Core (D-74/D-75/D-76/D-77: kampanjeregister/utgiftsledger/attribusjon/
 *   CAC-ROAS/avviksdeteksjon), `finance` via Native Jarvis Finance & Spend Integrity Gateway
 *   (D-107-D-116: UA-6, se under).
 * - `live_provider_connected` betyr at en EKSTERN tredjeparts-annonseplattform faktisk er
 *   tilkoblet og leverer RÅ live-data. Domenekapabilitet og
 *   leverandør-tilkobling er ALDRI det samme - `marketing.status === "available"` med
 *   `marketing.live_provider_connected === false` er en gyldig, ærlig, forventet kombinasjon
 *   (D-74 sin `CAN_RUN_WITHOUT_PROVIDER=true`-beslutning) - IKKE en selvmotsigelse.
 *
 * Fortsatt en ren, statisk kartlegging (INGEN DB-spørring/runtime-avledning) - samme
 * arkitektoniske mønster som `sales` alltid har brukt: dette er en build-time-fakta om HVILKE
 * domenemoduler som faktisk finnes i kodebasen, ikke en per-tenant datasjekk.
 *
 * `finance` flippet til `available` (D-127) fordi PÅSTANDEN var blitt usann, ikke fordi noe
 * nytt ble bygget her: UA-6 Finance & Spend Integrity Gateway sin interne implementasjon/
 * arkitektur var allerede komplett/verifisert (`UA6_IMPLEMENTATION_COMPLETE=true`,
 * `UA6_ARCHITECTURE_ACCEPTANCE_COMPLETE=true`, D-107-D-118) - MEN live leverandørverifisering
 * og D-108-credentials gjenstår fortsatt (`UA6_LIVE_PROVIDER_VERIFICATION_COMPLETE=false`,
 * uendret av D-127). `OpenLoopService` (`open-loop-service.ts`) har SIDEN
 * D-115/D-116 allerede overflatet `finance_spend_records`/`finance_recurring_commitments`/
 * `finance_procurement_items`-avvik som `finance_spend_unexpected`/`finance_spend_amount_
 * deviation`/`finance_spend_correction_conflict`/`finance_recurring_charge_missing`/
 * `finance_recurring_charge_duplicate`/`finance_procurement_missing`-open-loops - som
 * `businessOpenLoopsSource()` (under, SAMME kilde som allerede gir `sales` sin dekning)
 * allerede overflater i DENNE briefen. Datastrømmen fantes altså allerede; kun
 * dekningstabellen løy fortsatt om den. Samme "aktivt usann dokumentasjon er farligere enn
 * manglende dokumentasjon"-lærdom som D-122.
 *
 * `product` flippet til `available` (D-128) - ANNERLEDES mønster enn D-78/D-127: her fantes
 * INGEN eksisterende kapabilitet fra før, en genuint ny JARVIS_CANONICAL Product Core ble bygget
 * for produkt-tilbakemeldinger/feature-requests/bug-reports (egen domenepakke, IKKE importert
 * herfra - denne filen kjenner kun det statiske `BUSINESS_DOMAIN_COVERAGE`-strengfeltet under),
 * med samme rapportør-/OpenLoopService-/erasure-mønster som Support Core (D-66)/Contracts Core
 * (D-71). ZERO ekstern produkt-analytics-/issue-tracker-leverandør - et fremtidig eksternt
 * verktøy er en VALGFRI, senere adapter, aldri domeneeier (D-64) - `live_provider_connected=false`.
 *
 * `operations` flippet til `available` (D-129) - SAMME mønster som `product`/D-128: her fantes
 * INGEN eksisterende kapabilitet fra før (D-64-gaten bekreftet at `finance_vendors`,
 * `modules/incidents`/`modules/watchdog` IKKE dekker business-operations - navnelikhet beviser
 * aldri kapasitet), en genuint ny JARVIS_CANONICAL Operations Core ble bygget for
 * leverandører/driftsoppgaver/runbooks/eskalering (masterplan §13, egen domenepakke, IKKE
 * importert herfra - denne filen kjenner kun det statiske `BUSINESS_DOMAIN_COVERAGE`-
 * strengfeltet under), med samme rapportør-/OpenLoopService-/erasure-mønster som Product Core.
 * ZERO ekstern driftsplattform-leverandør - `live_provider_connected=false`. UA-3
 * akseptansekriterium 2 ("kombinerer sales, product, finance, marketing, operations") har NÅ
 * alle fem domener dekket - se `docs/OPEN_QUESTIONS.md` Q-25 for presis, ikke-overdrevet
 * ordlyd om hva "dekket" betyr (JARVIS_CANONICAL kapabilitet, IKKE live ekstern leverandørdata).
 */
export interface DomainCoverage {
  status: "available" | "not_integrated";
  /** Hvilken Jarvis-native kapabilitet som faktisk gir denne dekningen - aldri en generisk/kopiert forklaring. */
  source: string;
  /** Eksplisitt SEPARAT fra `status` - se filkommentaren over. */
  live_provider_connected: boolean;
}

export const BUSINESS_DOMAIN_COVERAGE: Record<BusinessDomain, DomainCoverage> = {
  sales: { status: "available", source: "Business Graph/CRM", live_provider_connected: false },
  product: {
    status: "available",
    source: "Native Jarvis Product Core (produkt-tilbakemeldinger/feature-requests/bug-reports overflatert som open loops, D-128)",
    live_provider_connected: false
  },
  finance: {
    status: "available",
    source: "Native Jarvis Finance & Spend Integrity Gateway (utgifts-/forpliktelses-/anskaffelses-avviksdeteksjon overflatert som open loops, D-107-D-116)",
    live_provider_connected: false
  },
  marketing: {
    status: "available",
    source: "Native Jarvis Growth Core (kampanjeregister/utgiftsledger/attribusjon/CAC-ROAS/avviksdeteksjon, D-74)",
    live_provider_connected: false
  },
  operations: {
    status: "available",
    source: "Native Jarvis Operations Core (leverandørregister/driftsoppgaver/runbooks/eskalering overflatert som open loops, D-129)",
    live_provider_connected: false
  }
};

export function renderDomainCoverage(): string {
  const availableCount = Object.values(BUSINESS_DOMAIN_COVERAGE).filter((d) => d.status === "available").length;
  const totalCount = Object.keys(BUSINESS_DOMAIN_COVERAGE).length;
  const lines = Object.entries(BUSINESS_DOMAIN_COVERAGE).map(([domain, d]) => {
    if (d.status !== "available") return `- ${domain}: IKKE integrert`;
    const providerNote = d.live_provider_connected ? "" : " - ingen live ekstern leverandør tilkoblet";
    return `- ${domain}: tilgjengelig (${d.source}${providerNote})`;
  });
  // §15: `availableCount === totalCount` betyr KUN at Jarvis har en JARVIS_CANONICAL kapabilitet
  // for alle domener - IKKE at live eksterne leverandører er tilkoblet noe sted (se
  // `live_provider_connected`-notatene per domene under). Overskriften MÅ derfor være
  // beregnet, aldri en hardkodet "IKKE fullt oppfylt"-påstand som ville blitt usann i det
  // øyeblikket det femte domenet ble dekket (samme "aktivt usann dokumentasjon er farligere
  // enn manglende dokumentasjon"-lærdom som D-122).
  const headline =
    availableCount === totalCount
      ? `akseptansekriterium 2 er dekket for alle ${availableCount}/${totalCount} domener (JARVIS_CANONICAL kapabilitet - ikke nødvendigvis live ekstern leverandørdata, se per-domene-notat)`
      : `akseptansekriterium 2 er IKKE fullt oppfylt - ${availableCount}/${totalCount} domener dekket`;
  return `DATA COVERAGE (${headline})\n${lines.join("\n")}`;
}

/** Ny BriefSource for eksisterende DailyBrief-motor - aapne loops som brief-punkter. */
export function businessOpenLoopsSource(openLoops: OpenLoopService, memorySpace: MemorySpace = "business"): BriefSource {
  return {
    name: "business-open-loops",
    async collect(identity: IdentityContext): Promise<BriefItem[]> {
      const loops = await openLoops.listOpenLoops(identity.tenant_id, memorySpace, "open");
      return loops.map((loop) => {
        const overdue = loop.due_at !== null && new Date(loop.due_at).getTime() < Date.now();
        return {
          source: "business-open-loops", ref: loop.open_loop_id,
          title: `${overdue ? "OVERDUE" : loop.loop_type}: ${loop.reason}`,
          ...(loop.due_at ? { at: loop.due_at } : {}),
          score: loop.priority === "high" ? 85 : overdue ? 70 : 55,
          why: loop.reason,
          ...(loop.next_action ? { action: loop.next_action } : {})
        };
      });
    }
  };
}

export interface WeeklyBriefArtifact {
  generated_at: string;
  tenant_id: string;
  period_start: string;
  period_end: string;
  opened_loops: number;
  resolved_loops: number;
  by_type: Record<string, { opened: number; resolved: number }>;
  opportunities_moved: Array<{ opportunity_id: string; title: string; stage: string }>;
  still_open: number;
  data_coverage: typeof BUSINESS_DOMAIN_COVERAGE;
}

/** §13 UKENTLIG: hovedendringer/pipeline-bevegelse/uloeste-og-loeste loops/gjentatte problemer -
 * ALT kilde-/state-forankret, aldri LLM-oppfunnet. */
export async function generateWeeklyBrief(pool: pg.Pool, tenantId: string, memorySpace: MemorySpace = "business"): Promise<WeeklyBriefArtifact> {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 86_400_000);
  return withMemoryTransaction(pool, tenantId, [memorySpace], async (client) => {
    const opened = await client.query(
      `SELECT loop_type, count(*)::int AS n FROM business_open_loops
       WHERE tenant_id = $1 AND opened_at >= $2 GROUP BY loop_type`,
      [tenantId, periodStart.toISOString()]
    );
    const resolved = await client.query(
      `SELECT loop_type, count(*)::int AS n FROM business_open_loops
       WHERE tenant_id = $1 AND resolved_at >= $2 GROUP BY loop_type`,
      [tenantId, periodStart.toISOString()]
    );
    const stillOpen = await client.query(
      `SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND status = 'open'`,
      [tenantId]
    );
    const moved = await client.query(
      `SELECT opportunity_id, title, stage FROM business_opportunities
       WHERE tenant_id = $1 AND updated_at >= $2 ORDER BY updated_at DESC LIMIT 20`,
      [tenantId, periodStart.toISOString()]
    );
    const byType: Record<string, { opened: number; resolved: number }> = {};
    for (const row of opened.rows as Array<{ loop_type: string; n: number }>) {
      byType[row.loop_type] = { opened: row.n, resolved: byType[row.loop_type]?.resolved ?? 0 };
    }
    for (const row of resolved.rows as Array<{ loop_type: string; n: number }>) {
      byType[row.loop_type] = { opened: byType[row.loop_type]?.opened ?? 0, resolved: row.n };
    }
    return {
      generated_at: new Date().toISOString(),
      tenant_id: tenantId,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      opened_loops: Object.values(byType).reduce((sum, t) => sum + t.opened, 0),
      resolved_loops: Object.values(byType).reduce((sum, t) => sum + t.resolved, 0),
      by_type: byType,
      opportunities_moved: moved.rows as Array<{ opportunity_id: string; title: string; stage: string }>,
      still_open: (stillOpen.rows[0] as { n: number }).n,
      data_coverage: BUSINESS_DOMAIN_COVERAGE
    };
  });
}

export function renderWeeklyBrief(brief: WeeklyBriefArtifact): string {
  const typeLines = Object.entries(brief.by_type).map(([type, counts]) => `- ${type}: ${counts.opened} aapnet, ${counts.resolved} loest`);
  const movedLines = brief.opportunities_moved.map((o) => `- ${o.title} (${o.opportunity_id}) -> ${o.stage}`);
  return (
    `JARVIS BUSINESS WEEKLY BRIEF (${brief.period_start} - ${brief.period_end})\n\n` +
    `OPEN LOOPS\n${typeLines.length ? typeLines.join("\n") : "(ingen endringer denne perioden)"}\n` +
    `Fortsatt aapne: ${brief.still_open}\n\n` +
    `PIPELINE-BEVEGELSE\n${movedLines.length ? movedLines.join("\n") : "(ingen oppdaterte opportunities)"}\n\n` +
    `${renderDomainCoverage()}\n`
  );
}

/**
 * D-198 (V4-revisjon, direkte chat-oppdrag under D-192): masterplanens V4
 * "Business Operating Loop" navngir eksplisitt en DAGLIG/UKENTLIG business-
 * health-leveranse - `generateWeeklyBrief()`/`renderWeeklyBrief()` (over)
 * fantes allerede (D-53), men ble ALDRI faktisk schedulert/pushet (kun
 * on-demand via `business.get_business_brief`-verktøyet). BEVISST valg: KUN
 * den UKENTLIGE varianten wires til en scheduled push her, ALDRI en daglig
 * push av samme innhold - `business_open_loops` sine individuelle hendelser
 * blir ALLEREDE pushet daglig/i sanntid via `situations`-broen
 * (`open-loop-bridge.ts`, D-160), en daglig FULL business-brief-push ville
 * vært REDUNDANT/duplikat-varsling av det samme innholdet gjennom to
 * kanaler. Den ukentlige rollup-en er DERIMOT et genuint annet
 * innholdsformat (aggregert 7-dagers tilbakeblikk, ikke individuelle
 * hendelser) og dupliserer derfor ikke.
 *
 * Leveransen gjenbruker DEN ene `deliverChunkedTextViaTelegram()`-
 * mekanismen (SAMME som `DailyBrief.deliverViaTelegram()`) - idempotency-
 * nøkkelen er prefikset med `tenantId` (flere tenants' ukentlige briefer
 * samme dag må ALDRI kollidere i samme nøkkelrom).
 */
export interface BusinessWeeklyBriefDeliveryResult {
  attempted: number;
  delivered: number;
  /** `tenantId:feilbeskrivelse` - aldri hemmeligheter/rådata. */
  errors: string[];
}

export async function runBusinessWeeklyBriefForAllTenants(
  pool: pg.Pool,
  gateway: ToolGateway,
  identityFor: (tenantId: string) => IdentityContext,
  memorySpace: MemorySpace = "business"
): Promise<BusinessWeeklyBriefDeliveryResult> {
  const tenantIds = await listBusinessTenantIds(pool, 200);
  const result: BusinessWeeklyBriefDeliveryResult = { attempted: 0, delivered: 0, errors: [] };
  for (const tenantId of tenantIds) {
    result.attempted += 1;
    try {
      const brief = await generateWeeklyBrief(pool, tenantId, memorySpace);
      const delivered = await deliverChunkedTextViaTelegram(
        gateway,
        identityFor(tenantId),
        renderWeeklyBrief(brief),
        `business-weekly-brief-${tenantId}-${brief.generated_at}`
      );
      if (delivered) result.delivered += 1;
      else result.errors.push(`${tenantId}:delivery_failed`);
    } catch (err) {
      // Én tenant sin feil skal aldri velte hele sveipet for andre tenants (samme disiplin som open-loop-sweep.ts).
      result.errors.push(`${tenantId}:${err instanceof Error ? `${err.name}:${err.message.slice(0, 120)}` : "unknown_error"}`);
    }
  }
  return result;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Ren, testbar dag-i-uken-sjekk i en GITT tidssone (aldri serverens/UTC-lokale dag - en scheduled jobb som kjører nær midnatt ville ellers kunne treffe feil dag). */
export function isWeeklyBriefDay(now: Date, timeZone: string, targetWeekday: number): boolean {
  const weekdayName = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  return WEEKDAY_INDEX[weekdayName] === targetWeekday;
}
