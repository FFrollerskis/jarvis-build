import type { SelfDiagnosis, SelfStatus } from "./types.ts";

/**
 * EV-1: deterministisk norsk gjengivelse av selvdiagnosen - ingen LLM. Hver linje har kilde og tidspunkt. Ukjent vises som ukjent.
 */
const WORD: Record<SelfStatus, string> = { OK: "frisk", DEGRADED: "delvis svekket", DOWN: "nede", UNKNOWN: "ukjent" };
const ICON = { critical: "❌", warning: "⚠️", info: "❔" } as const;

export function renderSelfDiagnosisNo(d: SelfDiagnosis, opts: { maxFindings?: number; includeLimitations?: boolean } = {}): string {
  const max = opts.maxFindings ?? 8;
  const time = d.as_of.slice(11, 16);
  const head = d.overall === "OK" && d.findings.length === 0
    ? `Jeg er frisk (målt ${time} UTC).`
    : `Status: ${WORD[d.overall]} (målt ${time} UTC).`;
  const lines = [head];
  const shown = d.findings.slice(0, max);
  for (const f of shown) lines.push(`${ICON[f.severity]} ${f.message} [${f.source}${f.observed_at ? ` ${f.observed_at.slice(11, 16)}` : ""}]`);
  if (d.findings.length > shown.length) lines.push(`… og ${d.findings.length - shown.length} til.`);
  if (d.unknown.length > 0) lines.push(`Jeg kan ikke måle: ${d.unknown.join(", ")}. Ukjent er ikke det samme som bra.`);
  if (opts.includeLimitations === true) {
    lines.push("Det jeg vet at jeg ikke kan:");
    for (const l of d.limitations.slice(0, 10)) lines.push(`- ${l.statement}`);
  }
  return lines.join("\n");
}
