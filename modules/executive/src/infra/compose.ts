import { INFRA_TARGETS, type InfraIncidentItem, type InfraMeasurements, type InfraProducerStatus, type InfraStatusReport, type InfraTargetState, type InfraTargetStatus } from "./types.ts";

/** Fakta om ett mål slik tjenesten leser dem fra registeret/gatewayen (uten databasen). */
export interface InfraTargetFacts {
  tool_id: string;
  registered: boolean;
  configured: boolean | null;
  health: { state: string; at: string } | null;
}

export interface ComposeInfraInput {
  as_of: Date;
  targets: readonly InfraTargetFacts[];
  measurements: InfraMeasurements | { error: string };
  producers_enabled: boolean;
  /** Forventet intervall mellom produsentkjøringer (ms); en produsent er `stale` etter 3x dette. */
  producers_interval_ms: number;
  producer_names: readonly string[];
  infra_mode: string | null;
}

const MAX_ITEMS = 20;
const SEVERITY_NO: Record<InfraIncidentItem["severity"], string> = { critical: "kritisk", high: "høy", normal: "normal", low: "lav" };
const OUTCOME_NO: Record<string, string> = { SUCCESS: "vellykket", PARTIAL: "delvis", FAILED: "feilet", UNKNOWN: "ukjent utfall" };
const STATE_NO: Record<InfraTargetState, string> = { ok: "ok", degraded: "redusert", down: "nede", dormant: "sovende", unknown: "ukjent" };

function targetState(f: InfraTargetFacts): { state: InfraTargetState; note: string } {
  if (!f.registered) return { state: "dormant", note: "verktøyet er ikke registrert i denne prosessen" };
  if (f.configured === false) return { state: "dormant", note: "ikke konfigurert (sovende til credential er satt)" };
  if (f.configured === null) return { state: "unknown", note: "kunne ikke avgjøre om credential er satt" };
  if (f.health === null) return { state: "unknown", note: "ingen helsemåling ennå (ikke kalt siden oppstart)" };
  switch (f.health.state) {
    case "healthy": return { state: "ok", note: `helse målt ${f.health.at}` };
    case "degraded":
    case "rate_limited": return { state: "degraded", note: `${f.health.state} ved ${f.health.at}` };
    case "unavailable":
    case "auth_failed": return { state: "down", note: `${f.health.state} ved ${f.health.at}` };
    default: return { state: "unknown", note: `ukjent helsestatus (${f.health.state.slice(0, 40)})` };
  }
}

function producerStatuses(input: ComposeInfraInput, runs: InfraMeasurements["producer_runs"]): InfraProducerStatus[] {
  if (!input.producers_enabled) {
    return input.producer_names.map((producer) => ({ producer, state: "disabled", last_started_at: null, age_s: null, consecutive_failures: 0, opened: 0, resolved: 0, last_error: null }));
  }
  const byName = new Map((runs ?? []).map((r) => [r.producer, r]));
  return input.producer_names.map((producer) => {
    const run = byName.get(producer);
    if (!run) return { producer, state: "never_ran", last_started_at: null, age_s: null, consecutive_failures: 0, opened: 0, resolved: 0, last_error: null };
    const started = new Date(run.last_started_at).getTime();
    const ageMs = input.as_of.getTime() - started;
    const stale = ageMs > 3 * input.producers_interval_ms;
    const state: InfraProducerStatus["state"] = stale ? "stale" : run.last_status === "failed" ? "failed" : run.last_status === "skipped" ? "skipped" : "ok";
    return {
      producer, state, last_started_at: new Date(run.last_started_at).toISOString(), age_s: Math.max(0, Math.round(ageMs / 1000)), consecutive_failures: run.consecutive_failures,
      opened: run.opened, resolved: run.resolved, last_error: run.last_error
    };
  });
}

export function composeInfraStatus(input: ComposeInfraInput): InfraStatusReport {
  const measured = "error" in input.measurements ? null : input.measurements;
  const not_measured: string[] = [];
  if (measured === null) not_measured.push(`hendelser, siste endringer og produsentenes helse: kilden feilet (${(input.measurements as { error: string }).error.slice(0, 80)})`);
  else for (const e of measured.errors) not_measured.push(e.slice(0, 120));

  const targets: InfraTargetStatus[] = INFRA_TARGETS.map((def) => {
    const facts = input.targets.find((t) => t.tool_id === def.tool_id) ?? { tool_id: def.tool_id, registered: false, configured: null, health: null };
    const { state, note } = targetState(facts);
    const change = measured?.last_changes?.[def.tool_id] ?? null;
    return { id: def.id, label: def.label, state, registered: facts.registered, configured: facts.configured, health: facts.health, last_change: change, note_no: note };
  });
  if (measured !== null && measured.last_changes === null) not_measured.push("siste endring per skymål: journalen kunne ikke leses");

  const incidents = measured?.incidents
    ? { active: measured.incidents.active.slice(0, MAX_ITEMS), active_total: measured.incidents.active_total, truncated: measured.incidents.active_total > Math.min(measured.incidents.active.length, MAX_ITEMS), by_phase: measured.incidents.by_phase, resolved_last_7d: measured.incidents.resolved_last_7d }
    : null;
  if (measured !== null && measured.incidents === null) not_measured.push("åpne hendelser: kunne ikke leses");
  const producers = producerStatuses(input, measured?.producer_runs ?? null);
  if (input.producers_enabled && measured !== null && measured.producer_runs === null) not_measured.push("produsentenes helse: kunne ikke leses");
  not_measured.push("Sentry-/oppetids-tilstand utover det produsentene registrerer: ikke målt direkte her");

  const report: Omit<InfraStatusReport, "summary_no"> = {
    as_of: input.as_of.toISOString(), auto_detection: input.producers_enabled, infra_mode: input.infra_mode, incidents, targets, producers, not_measured
  };
  return { ...report, summary_no: renderInfraStatusNo(report) };
}

export function renderInfraStatusNo(r: Omit<InfraStatusReport, "summary_no">): string {
  const lines: string[] = [];
  if (r.infra_mode !== null && r.infra_mode !== "NORMAL") lines.push(`Infrastrukturmodus: ${r.infra_mode} (skriving er begrenset).`);
  if (r.incidents === null) lines.push("Åpne hendelser: kunne ikke leses.");
  else if (r.incidents.active_total === 0) {
    lines.push(r.auto_detection ? "Ingen åpne hendelser." : "Ingen åpne hendelser registrert - men automatisk oppdagelse er AV, så dette betyr kun at ingen er registrert manuelt.");
  } else {
    lines.push(`${r.incidents.active_total} åpne hendelser:`);
    for (const i of r.incidents.active.slice(0, 5)) {
      const change = i.last_change ? `, siste endring ${i.last_change.at} (${i.last_change.to_phase_no})` : "";
      const truth = `bekreftet ${i.evidence.verified}/observert ${i.evidence.observed}/påstått ${i.evidence.claimed}`;
      lines.push(`- [${SEVERITY_NO[i.severity]}] ${i.title} - ${i.phase_no}, sett ${i.occurrence_count} ganger, bevis: ${truth}${change}`);
    }
    if (r.incidents.active_total > 5) lines.push(`- ... og ${r.incidents.active_total - 5} til.`);
  }
  if (r.incidents) lines.push(`Løst siste 7 døgn: ${r.incidents.resolved_last_7d}.`);
  lines.push("Skymål:");
  for (const t of r.targets) {
    const change = t.last_change ? `; siste endring ${t.last_change.at} (${t.last_change.action}, ${OUTCOME_NO[t.last_change.outcome] ?? t.last_change.outcome})` : "";
    lines.push(`- ${t.label}: ${STATE_NO[t.state]} (${t.note_no})${change}`);
  }
  if (r.auto_detection) {
    const bad = r.producers.filter((p) => p.state === "failed" || p.state === "stale" || p.state === "never_ran");
    lines.push(bad.length === 0 ? "Hendelsesprodusentene kjører." : `Produsenter med problem: ${bad.map((p) => `${p.producer} (${p.state === "failed" ? `feilet ${p.consecutive_failures} på rad` : p.state === "stale" ? "har stått stille" : "har ikke kjørt"})`).join(", ")}.`);
  } else {
    lines.push("Hendelsesprodusentene er AV (JARVIS_INCIDENT_PRODUCERS_ENABLED=true slår dem på).");
  }
  if (r.not_measured.length > 0) lines.push(`Ikke målt: ${r.not_measured.join("; ")}.`);
  return lines.join("\n");
}
