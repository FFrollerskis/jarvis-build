import { SLO_NOT_MEASURED } from "./definitions.ts";
import type { DataQualityReport, DriftReport, SloReport, SloResult } from "./types.ts";

/** Deterministisk norsk oppsummering av SLO-rapporten. Ukjent sies som ukjent. */
export function renderSloReportNo(r: Omit<SloReport, "summary_no">): string {
  const breaches = r.slos.filter((s) => s.status === "BREACH");
  const unknown = r.slos.filter((s) => s.status === "UNKNOWN");
  const ok = r.slos.filter((s) => s.status === "OK");
  const lines: string[] = [];
  lines.push(
    breaches.length > 0
      ? `${breaches.length} av ${r.slos.length} tjenestemål er brutt.`
      : ok.length === 0
        ? "Ingen tjenestemål kan vurderes ennå (for få målinger)."
        : `Ingen brutte tjenestemål (${ok.length} OK, ${unknown.length} uten nok data).`
  );
  for (const s of breaches) lines.push(`❌ ${s.label}: ${s.detail}`);
  for (const s of ok) lines.push(`✅ ${s.label}: ${s.detail}`);
  if (unknown.length > 0) lines.push(`❔ Ikke nok data: ${unknown.map((s) => s.label).join("; ")}.`);
  if (r.drift) {
    if (r.drift.findings.length > 0) {
      lines.push("Gradvis forverring (siste døgn mot uken før):");
      for (const f of r.drift.findings) lines.push(`⚠️ ${f.series}: ${f.detail}`);
    } else if (r.drift.insufficient.length > 0) {
      lines.push(`Ingen forverring funnet; for lite data til å vurdere: ${r.drift.insufficient.join(", ")}.`);
    } else lines.push("Ingen gradvis forverring funnet.");
  } else lines.push("Forverring (drift) er ikke målt.");
  if (r.data_quality) {
    const bad = r.data_quality.checks.filter((c) => (c.count ?? 0) > 0);
    if (bad.length > 0) lines.push(`Dataskvalitet: ${bad.map((c) => `${c.label}: ${c.count}`).join("; ")}.`);
    else lines.push("Dataskvalitet: ingen funn i det som er målt.");
    const deferred = r.data_quality.checks.filter((c) => c.count === null);
    if (deferred.length > 0) lines.push(`Ikke målt: ${deferred.map((c) => `${c.label}${c.deferred ? ` (${c.deferred})` : ""}`).join("; ")}.`);
  }
  if (r.not_measured.length > 0) lines.push(`Ikke målt ennå: ${r.not_measured.join("; ")}.`);
  return lines.join("\n");
}

export function composeSloReport(input: { as_of: string; slos: SloResult[]; drift: DriftReport | null; data_quality: DataQualityReport | null }): SloReport {
  const base = { ...input, not_measured: [...SLO_NOT_MEASURED] };
  return { ...base, summary_no: renderSloReportNo(base) };
}
