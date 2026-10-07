import type { ToolExchange, ToolResultMessage } from "@jarvis/provider-adapters";

/**
 * D-430: ærlighet ved verktøyfeil. En liten lokal modell oppfinner et svar når verktøykallet feilet (observert: «du har 123,45 kr på
 * kontoen» etter at bankkallet ble avvist; «ingen åpne pull requests» etter et avvist GitHub-kall). Dette er deterministisk kode
 * uten LLM: har INGEN verktøykall i turen lykkes (og ingen venter på eierens bekreftelse), erstattes modellens tekst med en fast,
 * ærlig melding; lykkes noen og andre feilet, legges en fast merknad til. Tekstene er skrevet for eieren (ikke for modellen).
 */
export interface ToolFailureNote {
  label: string;
  reason: string;
}

export interface ToolOutcomeSummary {
  successes: number;
  failures: ToolFailureNote[];
  confirmationPending: boolean;
}

const isConfirmation = (r: ToolResultMessage): boolean => {
  const o = r.output as { confirmation_required?: unknown } | null;
  return typeof o === "object" && o !== null && o.confirmation_required === true;
};

function reasonFor(category: string): string {
  const c = category.trim();
  if (/^INVALID_ARGUMENTS|^invalid_parameters$/i.test(c)) return "kallet hadde ugyldige eller manglende felt";
  if (/^TOOL_NOT_FOUND$|^unknown_tool$/i.test(c)) return "verktøyet finnes ikke i denne samtalen";
  if (/^TOOL_NOT_ON_SURFACE$/i.test(c)) return "ikke tilgjengelig i denne kanalen";
  if (/^TOOL_CALL_LIMIT$/i.test(c)) return "grensen for verktøykall i meldingen er nådd";
  if (/^credential_/i.test(c)) return "tjenesten er ikke koblet til (nøkkel mangler eller er tilbakekalt)";
  if (/^connector_frozen$/i.test(c)) return "tjenesten er fryst i eierkontrollene";
  if (/approval|^class_d/i.test(c)) return "krever eierens signerte godkjenning (kritisk handling)";
  if (/^rate_limited$/i.test(c) || /(^|\D)429(\D|$)/.test(c)) return "tjenesten er midlertidig begrenset (for mange kall)";
  if (/timeout|timed out|econn|enotfound|network|unavailable/i.test(c)) return "tjenesten svarte ikke";
  const status = /(?:^|\D)([45]\d\d)(?:\D|$)/.exec(c);
  if (status) return `tjenesten svarte med feil (kode ${status[1]})`;
  return c.length > 0 ? `feilet (${c.replace(/[^\p{L}\p{N}_:.\- ]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60)})` : "feilet";
}

export function summarizeToolOutcomes(exchanges: ReadonlyArray<ToolExchange>): ToolOutcomeSummary {
  let successes = 0;
  let confirmationPending = false;
  const seen = new Set<string>();
  const failures: ToolFailureNote[] = [];
  for (const exchange of exchanges) {
    for (const r of exchange.results) {
      if (r.success) { successes += 1; continue; }
      if (isConfirmation(r)) { confirmationPending = true; continue; }
      const label = (r.source ?? r.tool_name).replace(/__/g, ".");
      const reason = reasonFor(r.error_category ?? "");
      const key = `${label}|${reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push({ label, reason });
    }
  }
  return { successes, failures, confirmationPending };
}

const bullet = (f: ToolFailureNote) => `- ${f.label}: ${f.reason}`;

/** Ingen vellykkede kall og ingen ventende bekreftelse → modellens tekst erstattes (den ville vært gjetting). */
export function mustReplaceWithFailureText(s: ToolOutcomeSummary): boolean {
  return s.failures.length > 0 && s.successes === 0 && !s.confirmationPending;
}

export function allFailedText(s: ToolOutcomeSummary): string {
  return `Jeg fikk ikke utført dette, så jeg har ingen data å svare med - og jeg gjetter ikke:\n${s.failures.slice(0, 4).map(bullet).join("\n")}`;
}

/** Noen kall lyktes, andre feilet → fast merknad etter modellens svar. Tom streng når alt gikk bra. */
export function partialFailureNote(s: ToolOutcomeSummary): string {
  if (s.failures.length === 0 || s.successes === 0) return "";
  return `\n\nMerk: dette feilet og er ikke med i svaret:\n${s.failures.slice(0, 4).map(bullet).join("\n")}`;
}
