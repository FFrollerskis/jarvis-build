import type { AiMeshAcceptance, AiMeshChain, AiMeshProvider, AiMeshReport } from "./types.ts";

const REQUIRED_LIVE = 3;
/** Minste antall prøver i hver gruppe før parallell-overhead regnes ut (færre gir bare støy). */
export const MIN_OVERHEAD_SAMPLES = 3;

/** Testdobler regnes ikke som en leverandør i akseptansen. */
const isRealProvider = (p: AiMeshProvider): boolean => p.provider !== "scripted";

export const AI_MESH_NOT_MEASURED: readonly string[] = [
  "Latens og feil «siden oppstart» (runtime) gjelder kun denne prosessen og nullstilles ved omstart; tallene siste 7 døgn kommer fra cost_events og dekker både api og worker.",
  "Parallell-overhead er indikativ: kall som startet samtidig med et annet leverandørkall sammenlignet med kall som startet alene, men med ulikt innhold. Kontrollert måling: mesh-live-smoke.ts --parallel.",
  "Kostnad for kall som ikke går via ModelGateway (embeddings, tale) er ikke med.",
  "Kvalitet er ikke målt her (kun tilgjengelighet, latens og kostnad)."
];

/** p50 parallell minus p50 alene, avrundet. `null` når en av gruppene har færre enn `MIN_OVERHEAD_SAMPLES` prøver. */
export function parallelOverheadMs(input: { p50_solo?: number | null; p50_parallel?: number | null; solo_samples: number; parallel_samples: number }): number | null {
  if (input.solo_samples < MIN_OVERHEAD_SAMPLES || input.parallel_samples < MIN_OVERHEAD_SAMPLES) return null;
  if (input.p50_solo == null || input.p50_parallel == null) return null;
  return Math.round(input.p50_parallel - input.p50_solo);
}

/** Akseptansen «≥3 live providers med fallback» - deterministisk og ærlig: bevist live ≠ konfigurert, og ukjent databasetilstand gir UNKNOWN, aldri MET. */
export function evaluateAcceptance(providers: readonly AiMeshProvider[], opts: { fallback_verified_in_process: boolean }): AiMeshAcceptance {
  const real = providers.filter((p) => isRealProvider(p) && p.configured);
  const provenLive = (p: AiMeshProvider): boolean => p.state === "LIVE" || (p.usage_7d?.ok_calls ?? 0) > 0;
  const live = real.filter(provenLive).map((p) => p.provider);
  const fallbackOk = real.reduce((n, p) => n + (p.usage_7d?.fallback_ok_calls ?? 0), 0);
  const dbUnreadable = real.length > 0 && real.every((p) => p.usage_7d === null);
  const fallbackEvidence = fallbackOk > 0 || opts.fallback_verified_in_process;
  const missing: string[] = [];
  if (real.length === 0) missing.push("Ingen leverandør er konfigurert.");
  else if (live.length < REQUIRED_LIVE) {
    const unproven = real.filter((p) => !provenLive(p)).map((p) => p.provider);
    missing.push(`Bare ${live.length} av ${REQUIRED_LIVE} nødvendige leverandører er bevist live${unproven.length > 0 ? ` (konfigurert, men aldri bevist: ${unproven.join(", ")})` : ""}.`);
  }
  if (!fallbackEvidence) missing.push("Ingen vellykket fallback er observert (en kandidat som feilet og en annen som svarte) - kjør mesh-live-smoke.ts.");
  if (dbUnreadable) missing.push("Databasen kunne ikke leses, så tallene siste 7 døgn mangler.");
  const met = live.length >= REQUIRED_LIVE && fallbackEvidence;
  return {
    required_live: REQUIRED_LIVE,
    live_providers: live.length,
    live,
    fallback_ok_calls_7d: fallbackOk,
    fallback_verified_in_process: opts.fallback_verified_in_process,
    verdict: met ? "MET" : dbUnreadable ? "UNKNOWN" : "NOT_MET",
    missing: met ? [] : missing
  };
}

const kr = (ore: number): string => `${(ore / 100).toFixed(2).replace(".", ",")} kr`;

const STATE_NO: Record<AiMeshProvider["state"], string> = {
  NOT_CONFIGURED: "ikke konfigurert",
  CONFIGURED: "konfigurert, aldri bevist",
  LIVE: "LIVE",
  DEGRADED: "svekket",
  RATE_LIMITED: "rate-begrenset",
  UNAVAILABLE: "UTILGJENGELIG"
};

function providerLine(p: AiMeshProvider): string {
  const where = p.locality === "local" ? "lokal" : p.hosted_free_tier ? "sky, gratis delt" : "sky";
  if (!p.configured) return `- ${p.provider} (${where}): ikke konfigurert`;
  const parts: string[] = [STATE_NO[p.state]];
  const p50 = p.usage_7d?.p50_latency_ms ?? p.runtime.p50_latency_ms;
  if (p50 != null) parts.push(`p50 ${p50} ms`);
  if (p.runtime.parallel_overhead_ms != null) parts.push(`parallell-overhead ${p.runtime.parallel_overhead_ms >= 0 ? "+" : ""}${p.runtime.parallel_overhead_ms} ms`);
  if (p.usage_7d === null) parts.push("7 døgn: ukjent (databasen kunne ikke leses)");
  else parts.push(`7 døgn: ${p.usage_7d.calls} kall, ${p.usage_7d.failed_calls} feil, ${kr(p.usage_7d.cost_ore)}`);
  return `- ${p.provider} (${where}): ${parts.join(" · ")}`;
}

/** Deterministisk norsk oppsummering (ingen LLM). Ukjent sies som ukjent; konfigurert er aldri det samme som bevist. */
export function renderAiMeshReportNo(r: Omit<AiMeshReport, "summary_no">): string {
  const a = r.acceptance;
  const lines: string[] = [];
  const verdict = a.verdict === "MET" ? "OPPFYLT (observert i trafikk eller røyktest)" : a.verdict === "UNKNOWN" ? "UKJENT" : "IKKE OPPFYLT ennå";
  lines.push(`AI Mesh (kun observasjon): ${a.live_providers} av ${a.required_live} nødvendige leverandører er bevist live, fallback observert ${a.fallback_ok_calls_7d} ganger siste 7 døgn. Akseptansen «≥${a.required_live} live providers med fallback»: ${verdict}.`);
  lines.push(`Router: ${r.router}.${r.chain ? ` Standardkjede for vanlig prat: ${r.chain.candidates.join(" → ")}${r.chain.auto_fallback ? " (siste reserve: vanlig ruting)" : " (strengt kun kjeden)"}.` : ""}`);
  for (const p of r.providers.filter((x) => isRealProvider(x))) lines.push(providerLine(p));
  const failing = r.providers.filter((p) => isRealProvider(p) && p.last_error !== null);
  if (failing.length > 0) lines.push(`Siste feil: ${failing.map((p) => `${p.provider}: ${p.last_error?.kind ?? "ukjent"}${p.last_error?.message ? ` (${p.last_error.message})` : ""}${p.last_error?.at ? ` ${p.last_error.at.slice(0, 16).replace("T", " ")}` : ""}`).join("; ")}.`);
  if (a.missing.length > 0) lines.push(`Mangler: ${a.missing.join(" ")}`);
  lines.push(`Ikke målt: ${r.not_measured.map((n) => n.replace(/\.$/, "")).join("; ")}.`);
  return lines.join("\n");
}

export function composeAiMeshReport(input: {
  as_of: string;
  router: AiMeshReport["router"];
  providers: AiMeshProvider[];
  chain?: AiMeshChain | null;
  fallback_verified_in_process: boolean;
  extra_not_measured?: readonly string[];
  /** Satt når selve målekilden mangler (ikke koblet inn): akseptansen blir UKJENT med denne årsaken - aldri «ikke oppfylt» på et tomt grunnlag og aldri «oppfylt». */
  unknown_reason?: string;
}): AiMeshReport {
  const evaluated = evaluateAcceptance(input.providers, { fallback_verified_in_process: input.fallback_verified_in_process });
  const base: Omit<AiMeshReport, "summary_no"> = {
    as_of: input.as_of,
    acts: false,
    router: input.router,
    chain: input.chain ?? null,
    providers: input.providers,
    acceptance: input.unknown_reason !== undefined && evaluated.verdict !== "MET" ? { ...evaluated, verdict: "UNKNOWN", missing: [input.unknown_reason] } : evaluated,
    not_measured: [...AI_MESH_NOT_MEASURED, ...(input.extra_not_measured ?? [])]
  };
  return { ...base, summary_no: renderAiMeshReportNo(base) };
}
