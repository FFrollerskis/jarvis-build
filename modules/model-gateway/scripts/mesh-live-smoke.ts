/**
 * WP-D4 (JARVIS-033/036/078) - EIERENS akseptanse for UA-1 AI Mesh: «≥3 live providers med fallback og kost-synlighet». Kjøres MANUELT av eieren med egne nøkler (samme presedens som
 * `d106-live-verify.ts`/`model-bakeoff-live.ts`) - aldri i CI, og aldri av Jarvis selv. Se `docs/runbooks/AI_MESH_ACCEPTANCE.md` for kommandoer og forventet utskrift.
 *
 * Hva den gjør (alt med ÉN liten forespørsel per kall, kostnadstak `--max-cost-ore`, standard 100 øre):
 *  1. ETT kall per konfigurert leverandør, direkte mot adapteren. `LIVE` krever synlig tekst (transportsuksess uten innhold er `EMPTY_OUTPUT`).
 *  2. FALLBACK: sperrer ÉN live leverandør (en wrapper som alltid feiler uten å røre nettet) og kjører ett kall gjennom den ekte `ModelGateway` med kjeden `[sperret, …øvrige live]` -
 *     en annen leverandør må svare, merket som fallback.
 *  3. SENSITIVITETSPORTEN (frakoblet, ingen nettkall): SECRET_RESTRICTED mot en kjede der skyleverandørene står først skal aldri nå en skyleverandør (D-378).
 *  4. `--tools`: verktøykall, rundtur med verktøyresultat og streaming for live leverandører som oppgir tool_calling (beviser kimi/hermes-påstandene i registeret live).
 *  5. `--parallel`: kontrollert måling av parallell-delegerings-overhead (samme forespørsel alene mot samtidig).
 *
 * Nøkler: leses av adapterne selv fra miljøet (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, GEMMA_API_KEY, KIMI_API_KEY/MOONSHOT_API_KEY, HERMES_API_KEY/NOUS_API_KEY,
 * JARVIS_GEMMA_LOCAL_URL, LOCAL_LLM_BASE_URL, JARVIS_OLLAMA_URL) - i api-containeren er de allerede satt. Skriptet skriver dem aldri; evidensfilen avvises om den inneholder noe som ligner
 * en hemmelighet eller en verdi fra en hemmelighetsliknende miljøvariabel.
 *
 * Evidens: `var/mesh-smoke/mesh-smoke-<tid>.json` (git-ignorert). Avslutningskode 0 = PASS, 1 = FAIL, 2 = INCOMPLETE/ugyldige flagg.
 *
 * Kjør: node --experimental-transform-types modules/model-gateway/scripts/mesh-live-smoke.ts [--tools] [--parallel] [--db] [--block <leverandør>] [--max-cost-ore N]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFromEnv, createPool, withTenantTransaction } from "@jarvis/core";
import {
  AnthropicAdapter, GeminiAdapter, GemmaHostedAdapter, HermesAdapter, KimiAdapter, LocalOpenAiCompatibleAdapter, OllamaAdapter, OpenAiAdapter, type ModelProviderAdapter
} from "@jarvis/provider-adapters";
import {
  BlockedAdapter, CapabilityRegistry, MemoryTraceSink, ModelGateway, SKIPPED_FALLBACK, SMOKE_PROVIDER_ORDER, SMOKE_USAGE_NO, SmokeCostMeter,
  assertEvidenceHasNoSecrets, defaultBlocked, evaluateSmoke, fallbackChain, inMemoryCostPool, measureParallel, parseSmokeArgs, pricingFromEnv, probeProvider, probeTools,
  renderSmokeSummaryNo, runFallbackCheck, runSensitivityGateCheck,
  type SmokeEvidence, type SmokeFallbackCheck, type SmokeParallelRecord, type SmokeProbeRecord, type SmokeToolRecord
} from "../src/index.ts";

const parsed = parseSmokeArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`mesh-live-smoke: ${parsed.error}\n\n${SMOKE_USAGE_NO}`);
  process.exit(2);
}
const opt = parsed.options;
if (opt.help) {
  console.log(SMOKE_USAGE_NO);
  process.exit(0);
}

// Adapterne leser JARVIS_MODEL_TIMEOUT_MS i konstruktøren - må settes FØR de bygges.
process.env["JARVIS_MODEL_TIMEOUT_MS"] = String(opt.timeoutMs);

// Samme leverandørsett og konstruktørargumenter som apps/api/src/main.ts (nøkler/URL-er leses av adapterne fra miljøet). ScriptedAdapter registreres aldri.
const all: ModelProviderAdapter[] = [
  new OpenAiAdapter(),
  new AnthropicAdapter(),
  new GeminiAdapter(),
  new GemmaHostedAdapter(),
  new LocalOpenAiCompatibleAdapter(),
  new LocalOpenAiCompatibleAdapter(process.env["JARVIS_GEMMA_LOCAL_URL"], process.env["JARVIS_GEMMA_LOCAL_MODEL"] || "gemma-local", undefined, "gemma_local"),
  new KimiAdapter(),
  new HermesAdapter(),
  new OllamaAdapter()
];
const rank = (name: string): number => SMOKE_PROVIDER_ORDER.indexOf(name);
const selected = all.filter((a) => opt.providers === null || opt.providers.includes(a.name)).sort((a, b) => rank(a.name) - rank(b.name));
const byName = new Map(selected.map((a) => [a.name, a]));

const registry = new CapabilityRegistry();
const pricing = pricingFromEnv();
const meter = new SmokeCostMeter(opt.maxCostOre);
const startedAt = new Date();
const runId = `smoke-${startedAt.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;

let dbPool: ReturnType<typeof createPool> | null = null;
if (opt.db) {
  try {
    dbPool = createPool(configFromEnv());
  } catch (err) {
    console.error(`mesh-live-smoke: --db krever databasekonfigurasjon i miljøet (${err instanceof Error ? err.message.slice(0, 120) : "ukjent feil"})`);
    process.exit(2);
  }
}
const db = dbPool;
const pool = db ?? inMemoryCostPool().pool;

try {
  // -------------------------------------------------------------------------------------------------------------------------------------------------------
  console.log(`Fase 1: ett lite kall per konfigurert leverandør (tak ${opt.maxCostOre} øre, tidsavbrudd ${opt.timeoutMs} ms)…`);
  const probes: SmokeProbeRecord[] = [];
  for (const adapter of selected) probes.push(await probeProvider(adapter, { pricing, registry, meter }));
  const liveNames = probes.filter((p) => p.status === "LIVE").map((p) => p.provider);

  // -------------------------------------------------------------------------------------------------------------------------------------------------------
  console.log("Fase 2: tvungen fallback (én live leverandør sperres) og sensitivitetsporten…");
  let fallback: SmokeFallbackCheck = SKIPPED_FALLBACK;
  const blocked = opt.block ?? defaultBlocked(liveNames);
  if (liveNames.length >= 2 && blocked !== null) {
    if (!liveNames.includes(blocked)) {
      fallback = { ...SKIPPED_FALLBACK, blocked, reason: `--block ${blocked}: leverandøren er ikke live, så den kan ikke brukes som sperret primær` };
    } else {
      const chain = fallbackChain(liveNames, blocked);
      const blockedAdapter = new BlockedAdapter(byName.get(blocked) as ModelProviderAdapter);
      const providers = chain.map((n) => (n === blocked ? blockedAdapter : (byName.get(n) as ModelProviderAdapter)));
      const gateway = new ModelGateway({ pool, trace: new MemoryTraceSink(), providers, pricing });
      fallback = await runFallbackCheck({
        gateway, blocked, chain, blockedAdapter, tenantId: opt.tenant, taskId: runId,
        ...(db
          ? {
              readCostRowFallback: async () => {
                const rows = (await withTenantTransaction(db, opt.tenant, (c) => c.query("SELECT fallback FROM cost_events WHERE tenant_id = $1 AND task_id = $2 AND success ORDER BY at DESC LIMIT 1", [opt.tenant, runId]))).rows as Array<{ fallback: boolean }>;
                return rows[0] ? Boolean(rows[0].fallback) : null;
              }
            }
          : {})
      });
    }
  }
  const gate = await runSensitivityGateCheck({
    adapters: selected, registry, tenantId: opt.tenant,
    // Alltid minnebasert pool: stubbene skal aldri skrive kostrader.
    makeGateway: (providers) => new ModelGateway({ pool: inMemoryCostPool().pool, trace: new MemoryTraceSink(), providers, pricing })
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------------------
  let tools: SmokeToolRecord[] | null = null;
  if (opt.tools) {
    console.log("Fase 3: verktøykall (kall, rundtur, streaming) for live leverandører som oppgir tool_calling…");
    tools = [];
    for (const name of liveNames) {
      const adapter = byName.get(name) as ModelProviderAdapter;
      const profile = registry.profileOrGeneric(adapter.name, adapter.model ?? "ukjent");
      if (!profile.capabilities.includes("tool_calling")) continue;
      tools.push(await probeTools(adapter, { pricing, meter, streaming: profile.capabilities.includes("streaming") }));
    }
  }

  let parallel: SmokeParallelRecord[] | null = null;
  if (opt.parallel) {
    console.log(`Fase 4: parallell-delegerings-overhead (${opt.soloCalls} alene, ${opt.parallelCalls} samtidig per leverandør)…`);
    parallel = [];
    for (const name of liveNames) parallel.push(await measureParallel(byName.get(name) as ModelProviderAdapter, { pricing, meter, soloCalls: opt.soloCalls, parallelCalls: opt.parallelCalls }));
  }

  // -------------------------------------------------------------------------------------------------------------------------------------------------------
  const evaluation = evaluateSmoke({ probes, fallback, gate, costCapHit: meter.capHit || meter.exhausted });
  const evidence: SmokeEvidence = {
    schema: "jarvis.mesh-smoke/1",
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    node: process.version,
    mode: opt.db ? "db" : "no_db",
    options: { providers: opt.providers, block: opt.block, tools: opt.tools, parallel: opt.parallel, max_cost_ore: opt.maxCostOre, timeout_ms: opt.timeoutMs, tenant: opt.db ? opt.tenant : null },
    providers: probes,
    fallback,
    sensitivity_gate: gate,
    tools,
    parallel,
    cost: { spent_ore: meter.spent, cap_ore: meter.cap, cap_hit: meter.capHit },
    live_providers: evaluation.live,
    verdict: evaluation.verdict,
    reasons: evaluation.reasons,
    notes: evaluation.notes
  };

  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  assertEvidenceHasNoSecrets(text, process.env); // kaster FØR noe skrives hvis evidensen skulle inneholde en hemmelighet
  const out = opt.out ?? `var/mesh-smoke/mesh-smoke-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text, { mode: 0o600 });

  console.log(`\n${renderSmokeSummaryNo(evidence)}\n\nEvidens skrevet: ${out}`);
  if (db) console.log(`Kostrader ligger i cost_events (task_id ${runId}); executive.get_ai_mesh_status viser dem som fallback_ok_calls siste 7 døgn.`);
  process.exitCode = evaluation.verdict === "PASS" ? 0 : evaluation.verdict === "FAIL" ? 1 : 2;
} catch (err) {
  // Aldri skriv ut miljø eller forespørselsinnhold - kun klassen og en kort melding.
  console.error(`mesh-live-smoke avbrutt: ${err instanceof Error ? err.message.slice(0, 200) : "ukjent feil"}`);
  process.exitCode = 2;
} finally {
  await db?.end();
}
