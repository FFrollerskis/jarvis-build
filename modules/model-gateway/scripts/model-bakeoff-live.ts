/**
 * D-439 - LIVE modellmåling (bake-off) på eierens egne meldinger. Fart + tydelige svar + at alt virker er viktigst, deretter lavest kostnad
 * (Tobias, 2026-10-07). Skriptet måler deterministiske tall (latens, tokens, kostnad, riktig verktøyvalg) og skriver BLINDE svar (A/B/C, ulik
 * rekkefølge per prompt) til manuell vurdering - aldri en automatisk «vinner». `--judge` legger til en LLM-dom som tydelig merkes «ikke fasit».
 *
 * Kjøring (lokalt eller i api-containeren på NAS; leser nøkler fra miljøet, skriver aldri nøkler):
 *   node --experimental-transform-types modules/model-gateway/scripts/model-bakeoff-live.ts \
 *     --candidates "anthropic:claude-sonnet-5-5,anthropic:claude-haiku-4-5-20251001,gemma_local:gemma3:4b" \
 *     [--prompts var/model-bakeoff/prompts.jsonl] [--max-cost-ore 300] [--judge anthropic:claude-sonnet-5-5] [--turns-per-day 100] [--seed 1]
 *
 * Egne meldinger (valgfritt, PERSONVERN): lag en lokal JSONL med linjer som {"id":"m1","text":"…","expect_tool":"none"|"github__list_pull_requests"|…}.
 * Filen og rapporten ligger i `var/` (git-ignorert) - del dem aldri, og legg aldri ekte meldinger i repoet. Uten --prompts brukes et innebygd norsk sett.
 * Kostnadstak: kjøringen stanser når summen (inkl. dom) når --max-cost-ore (standard 300 øre = 3 kr). Kandidater uten nøkkel/endepunkt rapporteres
 * NOT_CONFIGURED (aldri falsk måling).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AnthropicAdapter, GeminiAdapter, LocalOpenAiCompatibleAdapter, OllamaAdapter, OpenAiAdapter, type ModelProviderAdapter, type ToolDefinition } from "@jarvis/provider-adapters";
import {
  blindLabels, costOre, parseCandidates, parsePromptsJsonl, pricingFromEnv, projectMonthlyKr, summarize,
  type BakeoffPrompt, type CandidateSpec, type RunRecord
} from "../src/index.ts";

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const SYSTEM = "Du er Jarvis, Tobias sin personlige assistent. Svar kort og tydelig på norsk. Bruk et verktøy bare når spørsmålet krever data du ikke har; ellers svar direkte.";

const TOOLS: ToolDefinition[] = [
  { name: "github__list_pull_requests", description: "List åpne pull requests i prosjektets GitHub-repo", input_schema: { type: "object", properties: { state: { type: "string" } } } },
  { name: "email__read_inbox", description: "Les siste e-poster i innboksen", input_schema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "calendar__read_events", description: "Les kommende kalenderhendelser", input_schema: { type: "object", properties: { days: { type: "number" } } } },
  { name: "memory__search", description: "Søk i det Jarvis husker om Tobias", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }
];

const BUILTIN: BakeoffPrompt[] = [
  { id: "chat1", text: "hei, hvordan går det?", expect_tool: "none", category: "småprat" },
  { id: "chat2", text: "kan du forklare forskjellen på en LLC og et AS kort?", expect_tool: "none", category: "kunnskap" },
  { id: "chat3", text: "skriv en kort, høflig melding der jeg utsetter møtet til i morgen", expect_tool: "none", category: "skriving" },
  { id: "chat4", text: "du svarte feil i sted, prøv igjen og vær mer presis", expect_tool: "none", category: "klage uten forespørsel" },
  { id: "tool1", text: "sjekk github og list åpne PR-er", expect_tool: "github__list_pull_requests", category: "verktøy" },
  { id: "tool2", text: "har jeg fått noen nye e-poster i dag?", expect_tool: "email__read_inbox", category: "verktøy" },
  { id: "tool3", text: "hva har jeg i kalenderen de neste dagene?", expect_tool: "calendar__read_events", category: "verktøy" },
  { id: "tool4", text: "hva sa jeg at jeg liker å drikke om morgenen?", expect_tool: "memory__search", category: "minne" },
  { id: "tool5", text: "du svarte feil, sjekk github igjen og list PR-ene", expect_tool: "github__list_pull_requests", category: "klage + forespørsel" },
  { id: "tool6", text: "hva står det i den siste mailen fra Dennis?", expect_tool: "email__read_inbox", category: "verktøy" },
  { id: "chat5", text: "takk, det var alt", expect_tool: "none", category: "småprat" },
  { id: "chat6", text: "hva er 15 prosent av 2 480?", expect_tool: "none", category: "regning" }
];

function buildAdapter(c: CandidateSpec): ModelProviderAdapter | null {
  switch (c.provider) {
    case "anthropic": return new AnthropicAdapter(undefined, c.model || undefined);
    case "openai": return new OpenAiAdapter(undefined, c.model || undefined);
    case "gemini": return new GeminiAdapter(undefined, c.model || undefined);
    case "ollama": return new OllamaAdapter(undefined, c.model || undefined);
    case "gemma_local":
      return new LocalOpenAiCompatibleAdapter(process.env["JARVIS_GEMMA_LOCAL_URL"], c.model || process.env["JARVIS_GEMMA_LOCAL_MODEL"] || "gemma-local", undefined, "gemma_local");
    default: return null;
  }
}

const candidates = parseCandidates(arg("candidates", "anthropic:claude-sonnet-5-5,gemma_local:gemma3:4b")!);
const prompts = (() => {
  const file = arg("prompts");
  return file ? parsePromptsJsonl(readFileSync(file, "utf8")) : BUILTIN;
})();
const maxCost = Number(arg("max-cost-ore", "300"));
const seed = Number(arg("seed", "1"));
const turnsPerDay = Number(arg("turns-per-day", "100"));
const judgeSpec = arg("judge");
const pricing = pricingFromEnv();

const adapters = new Map<string, ModelProviderAdapter>();
const notConfigured: string[] = [];
for (const c of candidates) {
  const a = buildAdapter(c);
  if (!a || !a.available()) notConfigured.push(c.label);
  else adapters.set(c.label, a);
}

let spent = 0;
const records: RunRecord[] = [];

async function runOne(c: CandidateSpec, p: BakeoffPrompt): Promise<RunRecord> {
  const adapter = adapters.get(c.label)!;
  const started = Date.now();
  try {
    const r = await adapter.complete({ system: SYSTEM, messages: [{ role: "user", content: p.text }], tools: TOOLS, max_tokens: 400, temperature: 0 });
    const cost = costOre(pricing, r.provider, r.model, r.usage);
    spent += cost;
    return {
      prompt_id: p.id, candidate: c.label, ok: true, text: r.text, latency_ms: r.latency_ms ?? Date.now() - started,
      input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, cost_ore: cost,
      ...(r.tool_calls?.[0] ? { tool_call: r.tool_calls[0].tool_name } : {})
    };
  } catch (err) {
    return { prompt_id: p.id, candidate: c.label, ok: false, error: (err as Error).message.slice(0, 200), text: "", latency_ms: Date.now() - started, input_tokens: 0, output_tokens: 0, cost_ore: 0 };
  }
}

let aborted: string | null = null;
for (const p of prompts) {
  for (const c of candidates) {
    if (!adapters.has(c.label)) continue;
    if (spent >= maxCost) { aborted = `kostnadstak ${maxCost} øre nådd etter ${records.length} kall`; break; }
    records.push(await runOne(c, p));
  }
  if (aborted) break;
}

const summary = summarize(records, prompts);

// Valgfri LLM-dom (blind, ikke fasit): ber dommeren score 1-5 på riktighet/tydelighet/norsk for tekstsvarene (uten verktøykall).
const judgeScores = new Map<string, number[]>();
if (judgeSpec && !aborted) {
  const [spec] = parseCandidates(judgeSpec);
  const judge = spec ? buildAdapter(spec) : null;
  if (judge?.available()) {
    for (const [i, p] of prompts.entries()) {
      const rs = records.filter((r) => r.prompt_id === p.id && r.ok && r.text.trim().length > 0 && !r.tool_call);
      if (rs.length < 2 || spent >= maxCost) continue;
      const labels = blindLabels(rs.map((r) => r.candidate), i, seed);
      const body = rs.map((r) => `Svar ${labels.get(r.candidate)}:\n${r.text}`).join("\n\n");
      try {
        const out = await judge.complete({
          system: "Du vurderer svar fra ulike assistenter. Svar KUN med JSON: {\"A\":n,\"B\":n,...} der n er 1-5 (riktighet, tydelighet og korrekt, naturlig norsk samlet). Vær streng.",
          messages: [{ role: "user", content: `Spørsmål: ${p.text}\n\n${body}` }], max_tokens: 100, temperature: 0
        });
        spent += costOre(pricing, out.provider, out.model, out.usage);
        const m = /\{[^}]*\}/.exec(out.text);
        const scores = m ? (JSON.parse(m[0]) as Record<string, number>) : {};
        for (const r of rs) {
          const v = scores[labels.get(r.candidate)!];
          if (typeof v === "number") judgeScores.set(r.candidate, [...(judgeScores.get(r.candidate) ?? []), v]);
        }
      } catch { /* dommen er best-effort */ }
    }
  }
}

const f = (n: number, d = 1): string => n.toFixed(d);
const lines: string[] = [];
lines.push(`# Modellmåling ${new Date().toISOString()}`, "", `Prompter: ${prompts.length} · kandidater: ${candidates.length} · brukt: ${spent} øre${aborted ? ` · AVBRUTT: ${aborted}` : ""}`);
if (notConfigured.length) lines.push(`NOT_CONFIGURED (ikke målt): ${notConfigured.join(", ")}`);
lines.push("", "## Tall (deterministiske)", "", "| Kandidat | Kall | Feil | Median ms | P95 ms | Snitt øre/kall | Riktig verktøyvalg | Kr/mnd ved " + turnsPerDay + " turer/dag | LLM-dom (snitt 1-5, ikke fasit) |", "|---|---|---|---|---|---|---|---|---|");
for (const s of summary) {
  const j = judgeScores.get(s.candidate);
  lines.push(`| ${s.candidate} | ${s.runs} | ${s.failures} | ${f(s.median_latency_ms, 0)} | ${f(s.p95_latency_ms, 0)} | ${f(s.avg_cost_ore, 2)} | ${s.tool_choice_accuracy === null ? "–" : `${f(s.tool_choice_accuracy * 100, 0)} %`} | ${f(projectMonthlyKr(s.avg_cost_ore, turnsPerDay), 0)} | ${j && j.length ? f(j.reduce((a, b) => a + b, 0) / j.length) : "–"} |`);
}
lines.push("", "Merk: månedskostnaden er snittet fra DENNE kjøringen × turer × 30 dager - en grov forenkling (ingen cache-effekt, ingen lange verktøyturer).", "", "## Blinde svar (vurder selv; nøkkel nederst)", "");
const keyLines: string[] = [];
for (const [i, p] of prompts.entries()) {
  const rs = records.filter((r) => r.prompt_id === p.id);
  if (rs.length === 0) continue;
  const labels = blindLabels(rs.map((r) => r.candidate), i, seed);
  lines.push(`### ${p.id} (${p.category ?? "–"}) – forventet verktøy: ${p.expect_tool}`, "", `> ${p.text.replace(/\n/g, " ")}`, "");
  for (const r of [...rs].sort((a, b) => labels.get(a.candidate)!.localeCompare(labels.get(b.candidate)!))) {
    const l = labels.get(r.candidate)!;
    lines.push(`**${l}** (${r.ok ? `${r.latency_ms} ms, ${r.cost_ore} øre` : `FEIL: ${r.error}`})${r.tool_call ? ` – kalte verktøy \`${r.tool_call}\`` : ""}`, "", r.text ? r.text.replace(/\n/g, "\n> ").replace(/^/, "> ") : "> (ingen tekst)", "");
    keyLines.push(`${p.id} ${l} = ${r.candidate}`);
  }
}
lines.push("## Nøkkel (åpne først etter at du har vurdert)", "", ...keyLines.map((k) => `- ${k}`));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync("var/model-bakeoff", { recursive: true });
writeFileSync(`var/model-bakeoff/bakeoff-${stamp}.md`, lines.join("\n"), "utf8");
writeFileSync(`var/model-bakeoff/bakeoff-${stamp}.json`, JSON.stringify({ summary, records }, null, 2), "utf8");
console.log(lines.slice(0, 4 + (notConfigured.length ? 1 : 0) + summary.length + 6).join("\n"));
console.log(`\nRapport: var/model-bakeoff/bakeoff-${stamp}.md (inneholder promptene dine - del den ikke)`);
