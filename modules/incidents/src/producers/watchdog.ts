import type { IncidentFact, IncidentSeverity } from "../types.ts";
import { subjectOf, type IncidentProducer, type ProducerClearing } from "./types.ts";

/**
 * WP-E1 (JARVIS-068): vakthundens (`@jarvis/watchdog`, D-180/D-395) sjekker blir hendelser. Vakthunden kjører i worker-prosessen og kjører ALLE sjekker hvert tikk; den rapporterer hvert
 * tikks resultater (ok og feil) til denne produsenten via `record()`. Produsenten er dermed ikke en polling-kilde, men en leser av SISTE fullførte tikk:
 *  - en sjekk som feilet i siste tikk -> hendelse (`watchdog:<sjekk>`, alvorlighet fra sjekken: warning->normal, critical->critical),
 *  - en sjekk som lyktes i siste tikk og har en aktiv hendelse -> re-målt som borte (vakthundens egen kjøring ER re-målingen),
 *  - ingen rapport ennå, eller rapporten er eldre enn `maxAgeMs` (vakthunden står) -> `skipped`: INGENTING åpnes og INGENTING løses på gammel informasjon.
 * Strukturell type (`WatchdogReportLike`) i stedet for en import - `@jarvis/watchdog` kjenner ikke denne modulen (ingen sirkulær avhengighet).
 */
export interface WatchdogReportLike {
  at: string;
  results: Array<{ check: string; ok: boolean; severity: "info" | "warning" | "critical"; message: string; runbook: string }>;
}

const SEVERITY: Record<"info" | "warning" | "critical", IncidentSeverity> = { info: "low", warning: "normal", critical: "critical" };

export class WatchdogIncidentProducer implements IncidentProducer {
  readonly name = "watchdog" as const;
  private latest: WatchdogReportLike | null = null;
  constructor(private readonly maxAgeMs = 15 * 60_000) {}

  /** Kalles av vakthundens tikk-observatør. Overskriver kun med et nyere tikk. */
  record(report: WatchdogReportLike): void {
    if (this.latest === null || Date.parse(report.at) >= Date.parse(this.latest.at)) this.latest = report;
  }

  async observe(ctx: Parameters<IncidentProducer["observe"]>[0], active: Parameters<IncidentProducer["observe"]>[1]): ReturnType<IncidentProducer["observe"]> {
    const report = this.latest;
    if (report === null) return { present: [], cleared: [], skipped: "no_watchdog_report_yet" };
    if (ctx.now.getTime() - Date.parse(report.at) > this.maxAgeMs) return { present: [], cleared: [], skipped: "watchdog_report_stale" };
    const present: IncidentFact[] = [];
    const failing = new Set<string>();
    for (const r of report.results) {
      if (r.ok) continue;
      failing.add(r.check);
      present.push({
        source_kind: "watchdog", subject: r.check, title: `Overvåkingssjekk feilet: ${r.check}`, severity: SEVERITY[r.severity], observed_at: report.at,
        evidence: { source_type: "health_check", source_ref: r.check, summary: `${r.message} (${r.runbook})` }
      });
    }
    const okChecks = new Map(report.results.filter((r) => r.ok).map((r) => [r.check, r]));
    const cleared: ProducerClearing[] = [];
    for (const incident of active) {
      const subject = subjectOf("watchdog", incident.dedupe_key);
      if (subject === null || failing.has(subject) || !okChecks.has(subject)) continue;
      cleared.push({
        subject,
        check: {
          source_type: "health_check", source_ref: subject, summary: `vakthundsjekken ${subject} lyktes`, observed_at: report.at,
          verified_by: "source_recheck", basis: `watchdog-tikk ${report.at}: sjekken ${subject} er ok`
        }
      });
    }
    return { present, cleared };
  }
}
