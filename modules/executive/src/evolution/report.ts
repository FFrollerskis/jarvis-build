import type { EvolutionReport, EvolutionSection, EvolutionStatus } from "./types.ts";

const ICON: Record<EvolutionStatus, string> = { OK: "✅", ATTENTION: "⚠️", UNKNOWN: "❔", DORMANT: "💤" };

/** Deterministisk norsk oppsummering. Ukjent sies som ukjent; sovende sies som sovende (ikke «bra»). */
export function renderEvolutionReportNo(r: Omit<EvolutionReport, "summary_no">): string {
  const count = (s: EvolutionStatus) => r.sections.filter((x) => x.status === s).length;
  const lines: string[] = [];
  lines.push(
    `Evolusjonsporter (kun observasjon - jeg endrer ingenting av meg selv): ${count("OK")} OK, ${count("ATTENTION")} trenger oppmerksomhet, ${count("UNKNOWN")} ikke målt, ${count("DORMANT")} sovende.`
  );
  for (const s of r.sections) {
    lines.push(`${ICON[s.status]} ${s.ev} ${s.title_no}: ${s.summary_no}`);
    for (const f of s.findings.slice(0, 4)) lines.push(`   - ${f}`);
    if (s.findings.length > 4) lines.push(`   - … og ${s.findings.length - 4} til`);
  }
  return lines.join("\n");
}

export function composeEvolutionReport(input: { as_of: string; sections: EvolutionSection[] }): EvolutionReport {
  const base = { as_of: input.as_of, acts: false as const, sections: input.sections };
  return { ...base, summary_no: renderEvolutionReportNo(base) };
}

/** Ren hjelper for kildene: en seksjon der målingen feilet er UNKNOWN (aldri en feil som velter hele rapporten, aldri «OK» ved feil). */
export function unknownSection(ev: string, title_no: string, source: string, reason: string): EvolutionSection {
  return { ev, title_no, mode: "observe", status: "UNKNOWN", summary_no: `Ikke målt: ${reason}`, findings: [], source, observed_at: null };
}
