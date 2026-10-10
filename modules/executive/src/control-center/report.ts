import type { JsonValue } from "@jarvis/contracts";
import {
  CONTROL_ACTION_ALLOWED, CONTROL_ACTION_BODY_KEYS, CONTROL_ACTION_ENDPOINTS, CONTROL_CENTER_IDS,
  type ControlAction, type ControlCenterDefinition, type ControlCenterId, type ControlCenterOverview, type ControlCenterParts, type ControlCenterReport,
  type ControlCenterSummary, type ControlFactValue, type ControlItem, type ControlRiskClass, type ControlSection, type ControlStatus
} from "./types.ts";

/**
 * WP-H0: rene hjelpere for kontrollsentrene - statusrangering, bygging av seksjoner/elementer/handlinger med innebygde invarianter, sammensetning av rapporten og deterministisk norsk forklaring.
 * Alt her er ren funksjon (ingen I/O, ingen LLM). Byggere SKAL bruke `controlSection`/`controlItem`/`controlAction` i stedet for å lage objektene for hånd: det er der invariantene bor.
 */

/** Visningsnavn for de ti sentrene (brukes også for sentre som ikke er koblet inn ennå). */
export const CONTROL_CENTER_TITLES_NO: Readonly<Record<ControlCenterId, string>> = {
  integration: "Integrasjoner", authority: "Autoritet", ai: "AI", finance: "Finans", memory: "Minne",
  agent: "Agenter", operations: "Drift", value: "Verdi", privacy: "Personvern", security: "Sikkerhet"
};

const STATUS_RANK: Readonly<Record<ControlStatus, number>> = { OK: 0, UNKNOWN: 1, WARN: 2, FAIL: 3 };

/** Verste status i listen (FAIL > WARN > UNKNOWN > OK). Tom liste = `UNKNOWN` (ingenting er målt). */
export function worstStatus(statuses: Iterable<ControlStatus>): ControlStatus {
  let worst: ControlStatus | undefined;
  for (const s of statuses) if (worst === undefined || STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  return worst ?? "UNKNOWN";
}

const STATUS_LABEL_NO: Readonly<Record<ControlStatus, string>> = { OK: "i orden", WARN: "advarsel", FAIL: "feil", UNKNOWN: "ikke målt" };
export function statusLabelNo(status: ControlStatus): string {
  return STATUS_LABEL_NO[status];
}

const MAX_ITEMS_PER_SECTION = 200;
const MAX_FACTS_PER_ITEM = 24;
const MAX_ACTIONS_PER_REPORT = 400;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`invalid_control_${field}`);
  return clip(value, max);
}

export interface ControlItemInput {
  id: string;
  label: string;
  status: ControlStatus;
  detail_no?: string;
  facts?: Record<string, ControlFactValue | undefined>;
  observed_at?: string | null;
}

/** Bygger ett element. Fakta er kun skalarer (alt annet utelates, så ingenting nøstet kan smugle innhold med); ikke-endelige tall utelates. */
export function controlItem(input: ControlItemInput): ControlItem {
  const facts: Record<string, ControlFactValue> = {};
  for (const [key, value] of Object.entries(input.facts ?? {}).slice(0, MAX_FACTS_PER_ITEM)) {
    if (value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      facts[clip(key, 60)] = typeof value === "string" ? clip(value, 300) : value;
    }
  }
  return {
    id: requireText(input.id, "item_id", 160),
    label: requireText(input.label, "item_label", 200),
    status: input.status,
    ...(input.detail_no !== undefined ? { detail_no: clip(input.detail_no, 400) } : {}),
    ...(Object.keys(facts).length > 0 ? { facts } : {}),
    ...(input.observed_at !== undefined ? { observed_at: input.observed_at } : {})
  };
}

export interface ControlSectionInput {
  id: string;
  title_no: string;
  source: string;
  summary_no: string;
  observed_at?: string | null;
  /** Standard `true`. `false` = kilden kunne ikke leses: status blir `UNKNOWN` uansett hva bygger sier. */
  measured?: boolean;
  /** Byggerens egen vurdering (gulv). Sluttstatus = verste av denne og elementene - en bygger kan ikke skjule et feilende element. Standard `OK`. */
  status?: ControlStatus;
  items?: ControlItem[];
}

/** Bygger en seksjon med invariantene: `measured: false` ⇒ `UNKNOWN`; ellers verste av byggerens vurdering og elementene. */
export function controlSection(input: ControlSectionInput): ControlSection {
  const measured = input.measured !== false;
  const all = input.items ?? [];
  const shown = all.slice(0, MAX_ITEMS_PER_SECTION);
  const status = measured ? worstStatus([input.status ?? "OK", ...shown.map((i) => i.status)]) : "UNKNOWN";
  const hidden = all.length - shown.length;
  return {
    id: requireText(input.id, "section_id", 80),
    title_no: requireText(input.title_no, "section_title", 160),
    status,
    measured,
    summary_no: clip(`${input.summary_no}${hidden > 0 ? ` (${hidden} flere vises ikke)` : ""}`, 600),
    items: shown,
    source: requireText(input.source, "section_source", 300),
    observed_at: measured ? (input.observed_at ?? null) : null
  };
}

/** Ren hjelper for byggerne: en seksjon der målingen feilet er UNKNOWN (aldri en feil som velter hele rapporten, aldri «OK» ved feil). */
export function unknownControlSection(id: string, title_no: string, source: string, reason: string): ControlSection {
  return controlSection({ id, title_no, source, summary_no: `Ikke målt: ${reason}`, measured: false });
}

/**
 * Feilkategori for «målingen feilet» - ALDRI feilmeldingen selv (den kan inneholde SQL, stier eller verdier). Klassenavn, pluss SQLSTATE-koden når pg oppgir en.
 */
export function failureCategory(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return `${err.name}:${code}`;
    return err.name || "Error";
  }
  return "ukjent feil";
}

const RISK_CLASSES: readonly ControlRiskClass[] = ["A", "B", "C", "D"];

export interface ControlActionInput {
  id: string;
  label: string;
  endpoint: string;
  body: Record<string, JsonValue>;
  risk_class: ControlRiskClass;
  requires_step_up: boolean;
  reversible: boolean;
  description_no: string;
  rollback_no?: string;
  section_id?: string;
  item_id?: string;
}

/**
 * Bygger en handling og AVVISER (kaster) alt som ikke peker på en eksisterende rute med en tillatt kropp: endepunktet må stå i `CONTROL_ACTION_ENDPOINTS`, kroppen kan bare ha de nøklene ruten
 * kjenner (aldri `grant_token` eller identitetsfelt), og risikoklassen må være A-D. Et kontrollsenter kan derfor ikke oppfinne en skrivevei.
 */
export function controlAction(input: ControlActionInput): ControlAction {
  if (!(CONTROL_ACTION_ENDPOINTS as readonly string[]).includes(input.endpoint)) throw new Error("invalid_control_action_endpoint");
  const endpoint = input.endpoint as keyof typeof CONTROL_ACTION_BODY_KEYS;
  const allowedKeys = CONTROL_ACTION_BODY_KEYS[endpoint] as readonly string[];
  if (typeof input.body !== "object" || input.body === null || Array.isArray(input.body)) throw new Error("invalid_control_action_body");
  for (const key of Object.keys(input.body)) {
    if (!allowedKeys.includes(key)) throw new Error("invalid_control_action_body_key");
  }
  // Handlingsnavnet må stå på rutens egen allowlist (speilet i `CONTROL_ACTION_ALLOWED`) - en knapp skal aldri peke på noe ruten ville avvist, og aldri på `set_connector_credential` (hemmeligheter).
  const allowedActions = CONTROL_ACTION_ALLOWED[endpoint];
  if (allowedActions !== null) {
    const name = (input.body as Record<string, unknown>)["action"];
    if (typeof name !== "string" || !allowedActions.includes(name)) throw new Error("invalid_control_action_name");
    const params = (input.body as Record<string, unknown>)["parameters"];
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) throw new Error("invalid_control_action_parameters");
  } else if ("action" in input.body) {
    throw new Error("invalid_control_action_body_key");
  }
  if (!RISK_CLASSES.includes(input.risk_class)) throw new Error("invalid_control_action_risk_class");
  if (typeof input.requires_step_up !== "boolean" || typeof input.reversible !== "boolean") throw new Error("invalid_control_action_flags");
  return {
    id: requireText(input.id, "action_id", 200),
    label: requireText(input.label, "action_label", 120),
    endpoint: input.endpoint as ControlAction["endpoint"],
    body: JSON.parse(JSON.stringify(input.body)) as Record<string, JsonValue>,
    risk_class: input.risk_class,
    requires_step_up: input.requires_step_up,
    reversible: input.reversible,
    description_no: requireText(input.description_no, "action_description", 400),
    ...(input.rollback_no !== undefined ? { rollback_no: clip(input.rollback_no, 300) } : {}),
    ...(input.section_id !== undefined ? { section_id: input.section_id } : {}),
    ...(input.item_id !== undefined ? { item_id: input.item_id } : {})
  };
}

/** Deterministisk norsk sammendrag av ett senter - samme tekst i verktøy, oversikt og webflate. */
export function renderControlCenterSummaryNo(input: { title_no: string; status: ControlStatus; sections: ControlSection[]; action_count: number }): string {
  const { sections } = input;
  if (sections.length === 0) return `${input.title_no}: ${statusLabelNo(input.status)} - ingen seksjoner er målt.`;
  const count = (s: ControlStatus) => sections.filter((x) => x.status === s).length;
  const parts = [
    count("FAIL") > 0 ? `${count("FAIL")} feiler` : "",
    count("WARN") > 0 ? `${count("WARN")} med advarsel` : "",
    count("UNKNOWN") > 0 ? `${count("UNKNOWN")} ikke målt` : "",
    count("OK") > 0 ? `${count("OK")} i orden` : ""
  ].filter((p) => p !== "");
  const actions = input.action_count > 0 ? ` ${input.action_count} handling${input.action_count === 1 ? "" : "er"} tilgjengelig.` : "";
  return `${input.title_no}: ${statusLabelNo(input.status)} - ${sections.length} seksjon${sections.length === 1 ? "" : "er"} (${parts.join(", ")}).${actions}`;
}

/**
 * Setter sammen rapporten for ett senter. Statusen utledes HER (verste av seksjonene; ingen seksjoner = UNKNOWN) - byggeren kan ikke påstå en bedre status. Duplikate seksjons-/handlings-id-er og
 * handlinger som peker på en seksjon/rad som ikke finnes er byggerfeil og kaster (registeret gjør det til en UNKNOWN-rapport; testene til byggeren fanger det).
 */
export function composeControlCenterReport(center: Pick<ControlCenterDefinition, "id" | "title_no">, parts: ControlCenterParts, now: Date): ControlCenterReport {
  const sectionIds = new Set<string>();
  const itemsBySection = new Map<string, Set<string>>();
  for (const section of parts.sections) {
    if (sectionIds.has(section.id)) throw new Error("duplicate_control_section_id");
    sectionIds.add(section.id);
    const itemIds = new Set<string>();
    for (const item of section.items) {
      if (itemIds.has(item.id)) throw new Error("duplicate_control_item_id");
      itemIds.add(item.id);
    }
    itemsBySection.set(section.id, itemIds);
  }
  if (parts.actions.length > MAX_ACTIONS_PER_REPORT) throw new Error("too_many_control_actions");
  const actionIds = new Set<string>();
  for (const action of parts.actions) {
    if (actionIds.has(action.id)) throw new Error("duplicate_control_action_id");
    actionIds.add(action.id);
    if (action.section_id !== undefined && !sectionIds.has(action.section_id)) throw new Error("control_action_unknown_section");
    if (action.item_id !== undefined && !(action.section_id !== undefined && itemsBySection.get(action.section_id)?.has(action.item_id))) throw new Error("control_action_unknown_item");
  }
  const status = parts.sections.length === 0 ? "UNKNOWN" : worstStatus(parts.sections.map((s) => s.status));
  return {
    center: center.id,
    title_no: center.title_no,
    generated_at: now.toISOString(),
    status,
    sensitivity: "PRIVATE",
    sections: parts.sections,
    actions: parts.actions,
    summary_no: renderControlCenterSummaryNo({ title_no: center.title_no, status, sections: parts.sections, action_count: parts.actions.length })
  };
}

/** En rapport for et senter der bygging feilet eller tok for lang tid: én UNKNOWN-seksjon med feilkategorien (aldri meldingen). */
export function unknownCenterReport(center: Pick<ControlCenterDefinition, "id" | "title_no">, reason: string, now: Date): ControlCenterReport {
  return composeControlCenterReport(center, { sections: [unknownControlSection("center", center.title_no, "kontrollsenter-registeret", reason)], actions: [] }, now);
}

export function summarizeControlCenter(report: ControlCenterReport, description_no: string): ControlCenterSummary {
  return {
    center: report.center,
    title_no: report.title_no,
    description_no,
    status: report.status,
    generated_at: report.generated_at,
    sections: report.sections.map((s) => ({ id: s.id, title_no: s.title_no, status: s.status, measured: s.measured, summary_no: s.summary_no })),
    action_count: report.actions.length,
    summary_no: report.summary_no
  };
}

/** Oversikten over alle ti sentre. Sentre uten registrering listes som `unregistered` (ikke som «OK»). */
export function composeControlCenterOverview(summaries: ControlCenterSummary[], now: Date): ControlCenterOverview {
  const registered = new Set(summaries.map((s) => s.center));
  const unregistered = CONTROL_CENTER_IDS.filter((id) => !registered.has(id));
  const status = summaries.length === 0 ? "UNKNOWN" : worstStatus(summaries.map((s) => s.status));
  const lines = [
    summaries.length === 0
      ? "Ingen kontrollsentre er koblet inn, så ingenting kan vurderes."
      : `Kontrollsentre: ${summaries.length} av ${CONTROL_CENTER_IDS.length} er koblet inn. Samlet: ${statusLabelNo(status)}.`,
    ...summaries.map((s) => `- ${s.summary_no}`),
    ...(unregistered.length > 0 && summaries.length > 0 ? [`Ikke koblet inn ennå: ${unregistered.map((id) => CONTROL_CENTER_TITLES_NO[id]).join(", ")}.`] : [])
  ];
  return { generated_at: now.toISOString(), status, sensitivity: "PRIVATE", centers: summaries, unregistered, summary_no: lines.join("\n") };
}

const EXPLAIN_MAX_ITEMS_PER_SECTION = 5;

/**
 * «Hvorfor?»: deterministisk norsk forklaring av hvorfor et senter er WARN/FAIL/UNKNOWN - bygget kun fra rapportens egne felt (seksjonenes sammendrag, elementenes detaljer, kilde og målt-tidspunkt).
 * Ingen LLM, ingen ny måling. Er alt målt og i orden, sier forklaringen det og nevner hva som er målt.
 */
export function explainControlCenterNo(report: ControlCenterReport): string {
  const lines: string[] = [];
  const bad = report.sections.filter((s) => s.status !== "OK");
  if (report.sections.length === 0) {
    lines.push(`${report.title_no} er ${statusLabelNo(report.status)} fordi ingen seksjoner kunne måles.`);
  } else if (bad.length === 0) {
    lines.push(`${report.title_no} er i orden: alle ${report.sections.length} seksjoner er målt og uten funn.`);
    for (const s of report.sections) lines.push(`- ${s.title_no}: ${s.summary_no} (kilde: ${s.source}${s.observed_at ? `, målt ${s.observed_at}` : ""})`);
  } else {
    lines.push(`${report.title_no} er ${statusLabelNo(report.status)} fordi:`);
    for (const s of bad) {
      lines.push(`- ${s.title_no} (${statusLabelNo(s.status)}): ${s.summary_no}`);
      const badItems = s.items.filter((i) => i.status !== "OK");
      for (const i of badItems.slice(0, EXPLAIN_MAX_ITEMS_PER_SECTION)) lines.push(`    · ${i.label} (${statusLabelNo(i.status)})${i.detail_no ? `: ${i.detail_no}` : ""}`);
      if (badItems.length > EXPLAIN_MAX_ITEMS_PER_SECTION) lines.push(`    · … og ${badItems.length - EXPLAIN_MAX_ITEMS_PER_SECTION} til`);
      lines.push(`    Kilde: ${s.source}${s.measured && s.observed_at ? `, målt ${s.observed_at}` : s.measured ? "" : " - kunne ikke måles, så dette er ukjent og ikke «i orden»"}.`);
    }
  }
  if (report.actions.length > 0) {
    const stepUp = report.actions.filter((a) => a.requires_step_up).length;
    lines.push(`Handlinger eieren kan ta herfra: ${report.actions.length}${stepUp > 0 ? ` (${stepUp} krever signert enhetsøkt)` : ""}. Kontrollsenteret utfører ingenting selv - handlingene bruker de eksisterende kontrollrutene.`);
  }
  return lines.join("\n");
}
