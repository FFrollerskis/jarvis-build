import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction } from "@jarvis/memory";
import type { BriefItem, BriefSource } from "@jarvis/tool-gateway";
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

/** §15: akseptansekriterium 2 ("kombinerer sales, product, finance, marketing, operations")
 * krever ALLE fem domener - denne sliceen dekker KUN sales (Business Graph/CRM). Brief-en MÅ
 * si det eksplisitt, ALDRI late som de andre domenene er dekket. */
export const BUSINESS_DOMAIN_COVERAGE: Record<BusinessDomain, "available" | "not_integrated"> = {
  sales: "available",
  product: "not_integrated",
  finance: "not_integrated",
  marketing: "not_integrated",
  operations: "not_integrated"
};

export function renderDomainCoverage(): string {
  const lines = Object.entries(BUSINESS_DOMAIN_COVERAGE).map(
    ([domain, status]) => `- ${domain}: ${status === "available" ? "tilgjengelig (Business Graph/CRM)" : "IKKE integrert"}`
  );
  return `DATA COVERAGE (akseptansekriterium 2 er IKKE fullt oppfylt - kun sales/CRM)\n${lines.join("\n")}`;
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
