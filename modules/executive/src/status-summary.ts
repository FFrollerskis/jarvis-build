import type { CapabilityStatus } from "./types.ts";
import type { SelfDiagnosis } from "./self-model/types.ts";
import { renderSelfDiagnosisNo } from "./self-model/render.ts";

/**
 * D-415: deterministisk, ferdig norsk oppsummering (`summary_no`) av statusverktøyene. En liten lokal modell (llama3.1:8b) klarer ikke å
 * lese rå JSON-envelope pålitelig - den beskrev formatet eller skrev kode. Med en ferdig tekst trenger modellen bare å videreformidle den.
 * Ingen LLM, ingen hemmeligheter: kun tool_id, antall og tilstand.
 */
const STATE_NO: Record<string, string> = { healthy: "ok", ok: "ok", degraded: "svekket", down: "nede", unknown: "ukjent" };

export function summarizeCapabilityStatusNo(s: CapabilityStatus): string {
  const configured = s.chat_accessible_tools.filter((t) => t.configured);
  const missing = s.chat_accessible_tools.filter((t) => !t.configured);
  const lines: string[] = [];
  lines.push(
    s.serving_model ? `Denne samtalen kjører på ${s.serving_model.model} (${s.serving_model.provider}).` : "Hvilken modell som svarer nå er ukjent."
  );
  lines.push(`Verktøy jeg kan bruke i chat: ${configured.length} tilkoblet${missing.length > 0 ? `, ${missing.length} mangler oppsett` : ""}.`);
  if (configured.length > 0) lines.push(`Tilkoblet: ${configured.map((t) => `${t.tool_id} (${t.actions.length})`).join(", ")}.`);
  if (missing.length > 0) lines.push(`Mangler oppsett: ${missing.map((t) => t.tool_id).join(", ")}.`);
  const bad = s.connector_health.filter((h) => h.state !== "healthy" && h.state !== "ok");
  if (bad.length > 0) lines.push(`Helseproblemer: ${bad.map((h) => `${h.tool_id} ${STATE_NO[h.state] ?? h.state}`).join(", ")}.`);
  // D-437: små lokale modeller videreformidler KUN denne teksten (D-415) - forbeholdet må stå her, ellers får eieren høre at connectorer «mangler oppsett» som API-et faktisk har.
  if (s.evaluation_caveat) lines.push(`Forbehold: ${s.evaluation_caveat}`);
  return lines.join("\n");
}

export function summarizeConnectorStatusNo(
  connectors: ReadonlyArray<{ id: string; display_name: string; configured: boolean; health: { state: string } | null }>
): string {
  const ok = connectors.filter((c) => c.configured);
  const missing = connectors.filter((c) => !c.configured);
  const lines = [`${ok.length} av ${connectors.length} tilkoblinger er satt opp.`];
  if (ok.length > 0) {
    lines.push(`Satt opp: ${ok.map((c) => `${c.display_name}${c.health ? ` (${STATE_NO[c.health.state] ?? c.health.state})` : ""}`).join(", ")}.`);
  }
  if (missing.length > 0) lines.push(`Ikke satt opp: ${missing.map((c) => c.display_name).join(", ")}.`);
  return lines.join("\n");
}

export function summarizeSelfDiagnosisNo(d: SelfDiagnosis): string {
  return renderSelfDiagnosisNo(d, { maxFindings: 8, includeLimitations: false });
}
