// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import {
  controlItem, controlSection, unknownControlSection,
  type ControlCenterBuildContext, type ControlCenterDefinition, type ControlCenterParts, type ControlItem, type ControlSection, type ControlStatus,
  type ValueLoopId, type ValueLoopStatus, type ValueMetric, type ValueReport
} from "@jarvis/executive";
import { bySeverityThenLabel, countsNo, safeCategory, settle, type Settled } from "./shared.ts";

/**
 * WP-H2 (UA-11 Admin Control Center, masterplan v4.0 kap. 21 og Value Track kap. 9) - VALUE CENTER: verdiløkkene V1-V5, bruksfrekvens, lukkede jobber, spart tid og eierens korrigeringer.
 *
 * Kun LESING av EKSISTERENDE `ValueReport` (WP-C4: `ExecutiveService.getValueReport` → `executive.get_value_report`) - ingen egne spørringer, ingen nye kilder, ingen handlinger. Rapporten bærer kun tall,
 * tellinger og tidsstempler; denne composeren legger til status, kilde og ærlighet, ikke nye målinger.
 *
 * ÆRLIGHET: en måling som ikke kan gjøres er `not_measurable` med årsak og står som `ikke målt` (UNKNOWN) - aldri som 0. Det gjelder SPART TID og EIERENS KORRIGERINGER, som ikke registreres noe sted i dag
 * (`tasks.time_saved`, `chat.owner_corrections`) - senteret er derfor UKJENT til de får en kilde, og sier det rett ut. Løkkenes tilstandsord (WIRED/DORMANT/BUILT_UNWIRED/NOT_BUILT) vises som FAKTA og løfter aldri
 * en status over «i orden»; kun en ukjent løkke (kjøretidsfakta mangler) er UKJENT. Ingen løkke aktiveres herfra (V3 er frosset, D-397; V5 utfører aldri noe).
 */

const LOOP_STATE_NO: Readonly<Record<ValueLoopStatus["state"], string>> = {
  wired: "WIRED (koblet inn og i drift)", dormant: "DORMANT (bygget, men av)", built_unwired: "BUILT_UNWIRED (bygget, ikke koblet)", not_built: "NOT_BUILT (ikke bygget)", unknown: "ukjent (kjøretidsfakta mangler)"
};
const LOOP_SECTIONS: ReadonlyArray<{ id: ValueLoopId; section: string; title: string; group?: string; source: string }> = [
  { id: "V1", section: "v1", title: "V1 Daily Executive Brief", group: "V1", source: "cost_events (brief:generation) + tool_executions (telegram.notify) + scheduler_state (daily-brief)" },
  { id: "V2", section: "v2", title: "V2 Unified Follow-up", group: "V2", source: "business_followups + business_open_loops + audit_events (followup.push_sent)" },
  { id: "V3", section: "v3", title: "V3 Jarvis Builder Loop", source: "beredskapslogikk (modules/executive/src/value/builder-loop.ts) - aktiverer aldri noe (D-397)" },
  { id: "V4", section: "v4", title: "V4 Business Operating Loop", source: "ingen kilde - løkken er ikke bygget (venter Business-tenant, Q-48)" },
  { id: "V5", section: "v5", title: "V5 Autonomous Operations", source: "forslagslogikk (modules/executive/src/value/ops-proposals.ts) - utfører aldri noe" }
];

/** Terskel for «lav fullføringsandel» og minste antall avsluttede jobber før andelen sier noe. */
export const COMPLETION_RATE_WARN = 0.7;
export const COMPLETION_RATE_MIN_FINISHED = 5;

const num = (v: number | null): string => (v === null ? "ingen grunnlag" : String(Math.round(v * 100) / 100));
const percent = (v: number | null): string => (v === null ? "ingen grunnlag" : `${Math.round(v * 100)} %`);

function valueText(m: ValueMetric): string {
  const fmt = (v: number | null): string => (m.unit === "ratio" ? percent(v) : num(v));
  const unit = m.unit === "days" ? " døgn" : m.unit === "seconds" ? " s" : m.unit === "ore" ? " øre" : "";
  if (m.state === "not_measurable") return `IKKE MÅLT: ${safeReason(m.reason_no)}`;
  return m.shape === "snapshot" ? `nå ${fmt(m.now)}${m.now === null ? "" : unit}` : `siste 7 døgn ${fmt(m.last_7d)}${m.last_7d === null ? "" : unit}, siste 30 døgn ${fmt(m.last_30d)}${m.last_30d === null ? "" : unit}`;
}

/** Årsaken er fast tekst fra katalogen (aldri data), men renses likevel til en kort, trygg linje. */
function safeReason(reason: string | undefined): string {
  const text = (reason ?? "ukjent årsak").replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function metricItem(m: ValueMetric): ControlItem {
  const measured = m.state === "measured";
  return controlItem({
    id: `metric:${safeCategory(m.id)}`, label: m.label_no, status: measured ? "OK" : "UNKNOWN",
    detail_no: `${valueText(m)}${m.note_no && measured ? ` - ${m.note_no}` : ""}`,
    facts: { metric: safeCategory(m.id), unit: m.unit, shape: m.shape, measured, now: m.now, last_7d: m.last_7d, last_30d: m.last_30d, source: m.source }
  });
}

/** Statusen for en måling som har en terskel (resten er kun fakta og står som i orden når de er målt). */
function withStatus(item: ControlItem, status: ControlStatus, extra?: string): ControlItem {
  return controlItem({ id: item.id, label: item.label, status, ...(item.detail_no !== undefined ? { detail_no: `${item.detail_no}${extra ? ` - ${extra}` : ""}` } : {}), ...(item.facts ? { facts: item.facts } : {}) });
}

export interface ValueCenterDeps {
  /** `ExecutiveService.getValueReport` (lat). Kaster aldri for en enkeltkilde (en feilet måling er `not_measurable`); kaster tjenesten likevel, blir alle seksjonene ukjente. */
  valueReport: (tenantId: string) => Promise<ValueReport>;
}

export function createValueCenter(deps: ValueCenterDeps): ControlCenterDefinition {
  return {
    id: "value",
    title_no: "Verdi",
    description_no: "Verdiløkkene V1-V5, bruksfrekvens, lukkede jobber, spart tid og dine korrigeringer - kun tall fra eksisterende målinger; det som ikke måles står som ikke målt",
    async build(ctx: ControlCenterBuildContext): Promise<ControlCenterParts> {
      const reportR: Settled<ValueReport> = await settle(() => deps.valueReport(ctx.identity.tenant_id));
      const sections: ControlSection[] = [];

      if (!reportR.ok) {
        const reason = `kunne ikke leses (${reportR.category})`;
        for (const l of LOOP_SECTIONS) sections.push(unknownControlSection(l.section, l.title, l.source, reason));
        for (const [id, title] of [["usage", "Bruksfrekvens"], ["tasks_closed", "Jobber lukket"], ["time_saved", "Spart tid"], ["owner_corrections", "Eierens korrigeringer"]] as const) {
          sections.push(unknownControlSection(id, title, "ExecutiveService.getValueReport (WP-C4)", reason));
        }
        return { sections, actions: [] };
      }

      const report = reportR.value;
      const measuredAt = report.as_of;
      const byId = new Map<string, ValueMetric>(report.metrics.map((m) => [m.id, m]));
      const metricsIn = (group: string): ValueMetric[] => report.metrics.filter((m) => m.group === group);
      const sourceNote = report.windows === null ? "kilden kunne ikke levere vinduene (ikke målt)" : `vindu ${report.windows.d7.from} til ${report.windows.d7.to} (7 d) og ${report.windows.d30.from} til ${report.windows.d30.to} (30 d), Europe/Oslo`;

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // V1-V5: én seksjon per verdiløkke
      // -------------------------------------------------------------------------------------------------------------------------------------------
      for (const loop of LOOP_SECTIONS) {
        const status = report.loops.find((l) => l.id === loop.id);
        const items: ControlItem[] = [];
        items.push(controlItem({
          id: "loop_state", label: `Løkkens tilstand (${loop.id})`, status: status === undefined || status.state === "unknown" ? "UNKNOWN" : "OK",
          detail_no: status === undefined ? "Løkken finnes ikke i rapporten (ikke målt)." : `${LOOP_STATE_NO[status.state]}: ${safeReason(status.detail_no)}`,
          facts: { loop: loop.id, state: status?.state ?? "unknown" }
        }));
        if (loop.group !== undefined) {
          for (const m of metricsIn(loop.group)) {
            let item = metricItem(m);
            if (m.id === "v1.runner_days_lost" && m.state === "measured" && (m.last_7d ?? 0) > 0) item = withStatus(item, "WARN", "den daglige løperen har tapt døgn");
            if (m.id === "v2.followups_overdue_now" && m.state === "measured" && (m.now ?? 0) > 0) item = withStatus(item, "WARN", "forfalte oppfølginger venter på deg");
            items.push(item);
          }
        }
        if (loop.id === "V3") {
          const b = report.builder_loop;
          items.push(controlItem({
            id: "readiness", label: "Beredskap for en eier-beslutning", status: "OK",
            detail_no: `${b.met.length} krav oppfylt, ${b.missing.length} mangler (${b.missing.filter((x) => x.unknown).length} ikke målbare). ${b.ready_for_owner_decision ? "Alle tekniske krav er oppfylt - det er et sjekklistesvar, ikke en bryter." : "Ikke klar for en eier-beslutning."} Ingen kodevei kan aktivere løkken (D-397).`,
            facts: { met: b.met.length, missing: b.missing.length, missing_unknown: b.missing.filter((x) => x.unknown).length, ready_for_owner_decision: b.ready_for_owner_decision, activation_decision: b.activation_decision }
          }));
        }
        if (loop.id === "V5") {
          const o = report.ops_proposals;
          items.push(controlItem({
            id: "proposals", label: "Driftsforslag (kun forslag)", status: "OK",
            detail_no: o.enabled
              ? `${o.proposals.length} forslag nå (${o.proposals.filter((p) => p.execution_path === "host_runbook").length} utføres på verten, ${o.proposals.filter((p) => p.execution_path === "tool_gateway").length} via bekreftelse); ${o.skipped_no.length} regler kunne ikke vurderes. Ingenting utføres av dette laget.`
              : "Forslag er AV (JARVIS_V5_PROPOSALS_ENABLED). Ingenting utføres av dette laget uansett.",
            facts: { enabled: o.enabled, proposals: o.proposals.length, skipped_rules: o.skipped_no.length, executes: false }
          }));
        }
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: loop.section, title_no: loop.title, observed_at: measuredAt, items, source: `${loop.source}; ${sourceNote}`,
          summary_no: `${loop.id}: ${status === undefined ? "ukjent" : LOOP_STATE_NO[status.state]}. ${countsNo(items)}.`
        }));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // Bruksfrekvens (samtaler) og bekreftelser
      // -------------------------------------------------------------------------------------------------------------------------------------------
      {
        const items: ControlItem[] = [...metricsIn("chat"), ...metricsIn("approvals")].filter((m) => m.id !== "chat.owner_corrections").map(metricItem);
        items.sort(bySeverityThenLabel);
        const messages = byId.get("chat.user_messages");
        const days = byId.get("chat.active_days");
        sections.push(controlSection({
          id: "usage", title_no: "Bruksfrekvens", observed_at: measuredAt, items,
          source: `messages + cost_events (purpose=CHAT) + action_confirmations + approvals (kun antall, aldri meldingstekst); ${sourceNote}`,
          summary_no: messages?.state === "measured"
            ? `${num(messages.last_7d)} meldinger fra deg siste 7 døgn på ${days?.state === "measured" ? num(days.last_7d) : "ukjent antall"} døgn med bruk. ${countsNo(items)}.`
            : `Bruken kunne ikke måles. ${countsNo(items)}.`
        }));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // Jobber lukket
      // -------------------------------------------------------------------------------------------------------------------------------------------
      {
        const tasks = metricsIn("tasks").filter((m) => m.id !== "tasks.time_saved");
        const completed = byId.get("tasks.completed");
        const failedM = byId.get("tasks.failed");
        const rate = byId.get("tasks.completion_rate");
        const finished = (completed?.last_7d ?? 0) + (failedM?.last_7d ?? 0);
        const items: ControlItem[] = tasks.map((m) => {
          const item = metricItem(m);
          if (m.id === "tasks.completion_rate" && m.state === "measured" && m.last_7d !== null && finished >= COMPLETION_RATE_MIN_FINISHED && m.last_7d < COMPLETION_RATE_WARN) {
            return withStatus(item, "WARN", `under ${Math.round(COMPLETION_RATE_WARN * 100)} % av ${finished} avsluttede jobber`);
          }
          return item;
        });
        items.sort(bySeverityThenLabel);
        sections.push(controlSection({
          id: "tasks_closed", title_no: "Jobber lukket", observed_at: measuredAt, items,
          source: `tasks (status, finished_at; kun antall) + cost_events (task_id satt); ${sourceNote}`,
          summary_no: completed?.state === "measured"
            ? `${num(completed.last_7d)} jobber fullført siste 7 døgn (${num(failedM?.last_7d ?? null)} feilet; fullføringsandel ${rate?.state === "measured" ? percent(rate.last_7d) : "ikke målt"}). ${countsNo(items)}.`
            : `Jobber kunne ikke måles. ${countsNo(items)}.`
        }));
      }

      // -------------------------------------------------------------------------------------------------------------------------------------------
      // Spart tid og eierens korrigeringer: ikke målt noe sted i dag
      // -------------------------------------------------------------------------------------------------------------------------------------------
      for (const [section, title, id] of [["time_saved", "Spart tid", "tasks.time_saved"], ["owner_corrections", "Eierens korrigeringer", "chat.owner_corrections"]] as const) {
        const m = byId.get(id);
        const items: ControlItem[] = [m !== undefined
          ? metricItem(m)
          : controlItem({ id: `metric:${safeCategory(id)}`, label: title, status: "UNKNOWN", detail_no: "IKKE MÅLT: målingen finnes ikke i rapporten.", facts: { metric: safeCategory(id), measured: false } })];
        sections.push(controlSection({
          id: section, title_no: title, observed_at: measuredAt, items,
          source: `${m?.source ?? "-"} (katalogen oppgir ingen kilde) - tallet er aldri 0, det er ikke målt`,
          summary_no: m !== undefined && m.state === "measured" ? `${valueText(m)}.` : `${title} er IKKE målt: ${safeReason(m?.reason_no)}.`
        }));
      }

      return { sections, actions: [] };
    }
  };
}
