import type { LoopState, ValueGroup, ValueMetric, ValueReport, ValueUnit } from "./types.ts";

/**
 * WP-C4: deterministisk norsk gjengivelse av Value Center-rapporten (ingen LLM). Kun faste etiketter og tall. En metrikk uten grunnlag vises som «–» (aldri 0), og en som ikke kan måles står med årsak.
 * Rapporten gjengir aldri innhold fra kildene - selv ikke tittelen på en oppfølging.
 */
const GROUP_TITLE: Record<ValueGroup, string> = {
  V1: "V1 Daily Brief",
  V2: "V2 Oppfølging",
  tasks: "Jobber",
  chat: "Samtaler",
  approvals: "Bekreftelser og godkjenninger",
  cost: "Kost",
  ops: "Drift"
};
const GROUP_ORDER: readonly ValueGroup[] = ["V1", "V2", "tasks", "chat", "approvals", "cost", "ops"];
const LOOP_STATE_NO: Record<LoopState, string> = { wired: "i drift", dormant: "sovende", built_unwired: "bygget, ikke koblet til kjøretiden", not_built: "ikke bygget", unknown: "ukjent" };

const comma = (n: number, decimals: number): string => n.toFixed(decimals).replace(".", ",");

export function formatValue(unit: ValueUnit, v: number | null): string {
  if (v === null) return "–";
  switch (unit) {
    case "count":
      return String(Math.round(v));
    case "days":
      return Number.isInteger(v) ? String(v) : comma(v, 1);
    case "ratio":
      return `${Math.round(v * 100)} %`;
    case "seconds":
      return v < 90 ? `${Math.round(v)} s` : v < 5400 ? `${Math.round(v / 60)} min` : `${comma(v / 3600, 1)} t`;
    case "ore":
      return `${comma(v / 100, 2)} kr`;
  }
}

function metricLine(m: ValueMetric): string {
  if (m.state === "not_measurable") return `- ${m.label_no}: ikke målbart (${m.reason_no ?? "ukjent årsak"})`;
  if (m.shape === "snapshot") return m.now === null ? `- ${m.label_no}: ingen grunnlag ennå` : `- ${m.label_no}: ${formatValue(m.unit, m.now)} nå`;
  if (m.last_7d === null && m.last_30d === null) return `- ${m.label_no}: ingen grunnlag ennå`;
  return `- ${m.label_no}: ${formatValue(m.unit, m.last_7d)} / ${formatValue(m.unit, m.last_30d)}`;
}

/** `09.10.2026 kl. 12:00` i Europe/Oslo. Ugyldig tidspunkt gjengis ikke (kun «ukjent tidspunkt»). */
export function formatOsloTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "ukjent tidspunkt";
  const parts = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")} kl. ${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}`;
}

function formatOsloDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "ukjent dato";
  const parts = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")}`;
}

export function renderValueReportNo(r: Omit<ValueReport, "summary_no">): string {
  const lines: string[] = [];
  lines.push(`Verdi-rapport for Jarvis, målt ${formatOsloTime(r.as_of)} (Europe/Oslo). Kun tall - ingen innhold fra samtaler, e-post eller oppgaver. Tall uten grunnlag vises som «–», aldri som 0.`);
  lines.push(
    r.windows === null
      ? "Vinduene (siste 7 og 30 døgn) kunne ikke fastslås fordi kilden ikke svarte."
      : `Vinduer: siste 7 døgn fra ${formatOsloDate(r.windows.d7.from)} / siste 30 døgn fra ${formatOsloDate(r.windows.d30.from)} (hele lokale døgn, i dag inkludert). Tallpar under er 7 døgn / 30 døgn.`
  );
  lines.push("");
  lines.push("Verdiløkker:");
  for (const l of r.loops) lines.push(`- ${l.id} ${l.title_no}: ${LOOP_STATE_NO[l.state]} - ${l.detail_no}`);

  for (const group of GROUP_ORDER) {
    const inGroup = r.metrics.filter((m) => m.group === group);
    if (inGroup.length === 0) continue;
    lines.push("");
    lines.push(`${GROUP_TITLE[group]}:`);
    for (const m of inGroup) lines.push(metricLine(m));
  }

  const b = r.builder_loop;
  const technical = b.requirements.filter((x) => x.kind === "technical");
  lines.push("");
  lines.push(
    `V3 Builder Loop (sovende): ${technical.filter((x) => x.met).length} av ${technical.length} tekniske krav er oppfylt` +
      (b.missing.length > 0 ? `. Mangler: ${b.missing.map((x) => x.label_no + (x.unknown ? " (ukjent)" : "")).join("; ")}.` : ".") +
      " Aktivering krever en navngitt D-beslutning fra deg - ingen kode kan aktivere løkken eller starte selvmodifikasjon."
  );

  const ops = r.ops_proposals;
  if (!ops.enabled) {
    lines.push("V5 Autonome operasjoner (forslagslogikk, ikke koblet til kjøretiden): forslag er AV (JARVIS_V5_PROPOSALS_ENABLED). Ingenting utføres uansett.");
  } else if (ops.proposals.length === 0) {
    lines.push(`V5 Autonome operasjoner: ingen forslag nå${ops.skipped_no.length > 0 ? ` (${ops.skipped_no.join("; ")})` : ""}. Ingenting utføres uten din bekreftelse.`);
  } else {
    lines.push("V5 Autonome operasjoner - FORSLAG (ingenting er utført; hvert forslag krever din bekreftelse, klasse D krever signert godkjenning):");
    for (const p of ops.proposals) lines.push(`- [klasse ${p.risk_class}] ${p.title_no}: ${p.rationale_no}`);
    if (ops.skipped_no.length > 0) lines.push(`  Ikke vurdert: ${ops.skipped_no.join("; ")}`);
  }

  if (r.not_measured.length > 0) {
    lines.push("");
    lines.push("Ikke målt:");
    for (const n of r.not_measured) lines.push(`- ${n}`);
  }
  return lines.join("\n");
}
