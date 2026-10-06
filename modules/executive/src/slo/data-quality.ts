import { DATA_QUALITY_THRESHOLDS as Q } from "./definitions.ts";
import type { DataQualityCheck, DataQualityReport } from "./types.ts";

/** Kilde: smale, lesende tellinger (injiseres; ingen innhold, kun antall). `null` = ikke målt. */
export interface DataQualityCounts {
  contradictory(): Promise<number>;
  duplicate(): Promise<number>;
  expiredButActive(): Promise<number>;
  staleQuarantine(days: number): Promise<number>;
}

/**
 * EV-2: dataskvalitetsalarmer for minne (stale, duplicate, contradictory, orphaned/expired). Kun antall - aldri innholdet. «Corrupted» har ingen
 * deterministisk detektor ennå og står som DEFERRED (aldri stille utelatt); `orphaned` dekkes av fremmednøkler i databasen (kan ikke oppstå).
 */
export async function computeDataQuality(counts: DataQualityCounts, now: Date): Promise<DataQualityReport> {
  const run = async (kind: DataQualityCheck["kind"], label: string, source: string, fn: () => Promise<number>): Promise<DataQualityCheck> => {
    try {
      return { kind, label, count: await fn(), source };
    } catch {
      return { kind, label, count: null, deferred: "måling feilet", source };
    }
  };
  const checks = await Promise.all([
    run("contradictory", "motstridende minner", "memory_items (has_conflict)", () => counts.contradictory()),
    run("duplicate", "duplikate minner", "memory_items (samme innhold i samme rom)", () => counts.duplicate()),
    run("expired_but_active", "utløpte men aktive minner", "memory_items (valid_to passert)", () => counts.expiredButActive()),
    run("stale_quarantine", `forslag i karantene eldre enn ${Q.stale_quarantine_days} dager`, "memory_items (quarantined)", () => counts.staleQuarantine(Q.stale_quarantine_days))
  ]);
  checks.push({ kind: "corrupted", label: "korrupte data", count: null, deferred: "ingen deterministisk detektor ennå (DEFERRED)", source: "-" });
  return { checks, observed_at: now.toISOString() };
}
