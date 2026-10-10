import type { IncidentFact } from "../types.ts";
import type { IncidentProducer, ProducerClearing } from "./types.ts";

/**
 * WP-E1 (JARVIS-068): brutte tjenestemål (EV-2/D-417, `apps/api/src/slo-source.ts`) blir hendelser. Strukturell type i stedet for en import fra `@jarvis/executive`: produsenten trenger
 * bare id, merkelapp, status og detaljtekst fra rapporten. Tallene er FORSLAG til mål (ikke eier-godkjente), derfor bærer et brudd alvorlighet `normal` - det er et varsel om at noe ser
 * dårligere ut, ikke et påstått avbrudd. `UNKNOWN` (for lite data) åpner aldri og løser aldri noe.
 */
export interface SloReportLike {
  as_of: string;
  slos: Array<{ id: string; label: string; status: "OK" | "BREACH" | "UNKNOWN"; value: number | null; target: number; samples: number; detail: string }>;
}

export function sloProducer(deps: { report: () => Promise<SloReportLike> }): IncidentProducer {
  return {
    name: "slo",
    async observe() {
      const report = await deps.report();
      const present: IncidentFact[] = [];
      const cleared: ProducerClearing[] = [];
      for (const slo of report.slos) {
        if (slo.status === "BREACH") {
          present.push({
            source_kind: "slo", subject: slo.id, title: `Tjenestemål brutt: ${slo.label}`, severity: "normal", observed_at: report.as_of,
            evidence: { source_type: "slo_breach", source_ref: slo.id, summary: `${slo.label}: ${slo.detail}` }
          });
        } else if (slo.status === "OK") {
          cleared.push({
            subject: slo.id,
            check: {
              source_type: "slo_breach", source_ref: slo.id, summary: `${slo.label}: innfridd igjen (${slo.samples} målinger)`, observed_at: report.as_of,
              verified_by: "source_recheck", basis: `SLO ${slo.id} er OK (${slo.value ?? "?"} mot mål ${slo.target}, ${slo.samples} målinger, rapport ${report.as_of})`
            }
          });
        }
      }
      return { present, cleared };
    }
  };
}

