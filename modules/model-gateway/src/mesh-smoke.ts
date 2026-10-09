/**
 * WP-D4 (JARVIS-033/036/078): ren logikk bak eierens akseptansescript `scripts/mesh-live-smoke.ts` - «≥3 live providers med fallback og kost-synlighet». Alt her er testbart mot fake
 * adaptere/gateway uten nett; selve skriptet kobler på ekte adaptere (eierens egne nøkler fra miljøet), gjør kallene og skriver evidensfilen.
 *
 * Prinsipper (samme som D-439-måleverktøyet og `d106-live-verify.ts`):
 *  - ETT lite kall per konfigurert leverandør direkte mot adapteren (ingen ruting): `LIVE` krever synlig tekst - transportsuksess uten innhold er `EMPTY_OUTPUT`, ikke live (D-106).
 *  - Fallback bevises mot den ekte `ModelGateway` ved at ÉN leverandør SPERRES (en wrapper som alltid feiler uten å røre nettet) og kjeden `preferenceFailover` må la en annen svare.
 *  - Sensitivitetsporten bevises frakoblet: SECRET_RESTRICTED mot en kjede der skyleverandørene står FØRST skal aldri kalle en skyleverandør (tripwire-adaptere, ingen nettkall).
 *  - Evidensen er hemmelighetsfri: kun tilstander, tall og redigerte feilkoder; før skriving avvises teksten hvis den inneholder noe `scanForSecrets` finner eller en verdi fra miljøet
 *    som ser ut som en nøkkel (se `assertEvidenceHasNoSecrets`). Nøkler leses av adapterne selv; skriptet ser dem aldri.
 *  - Kostnadstak (`--max-cost-ore`): kjøringen stanser og sier fra, og verdiktet blir `INCOMPLETE` (aldri en falsk PASS).
 */
import type pg from "pg";
import { scanForSecrets } from "@jarvis/core";
import { ProviderError, type ModelProviderAdapter, type ModelRequest, type ModelResult, type StreamEvent, type ToolCallRequest, type ToolDefinition, type ToolExchange } from "@jarvis/provider-adapters";
import { CapabilityRegistry } from "./capability-registry.ts";
import type { ModelGateway } from "./model-gateway.ts";
import { costOre, type PricingTable } from "./pricing.ts";
import { medianOf } from "./provider-health.ts";
import { NoEligibleProviderError } from "./router.ts";

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Konstanter og kommandolinje
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
/** Kanonisk rekkefølge (lokale først). Styrer hvilken leverandør som sperres først og kjedens rekkefølge i fallback-testen. */
export const SMOKE_PROVIDER_ORDER: readonly string[] = ["gemma_local", "local_llm", "ollama", "gemma_hosted", "kimi", "hermes", "anthropic", "openai", "gemini"];
export const SMOKE_PROMPT = "Svar med nøyaktig ett ord: OK";
/** Romslig nok til at tenkemodeller (Kimi k3) ikke bruker hele budsjettet på skjult resonnering (D-106: `finish_reason=length` med tom tekst ved 200). Kostnaden er likevel brøkdeler av en øre. */
export const SMOKE_MAX_TOKENS = 256;
export const SMOKE_TOOL: ToolDefinition = {
  name: "smoke_get_time",
  description: "Returnerer klokkeslettet akkurat nå. Brukes kun av akseptansetesten.",
  input_schema: { type: "object", properties: { timezone: { type: "string" } }, additionalProperties: false }
};
const TOOL_SYSTEM = "Du er en test. Når brukeren spør om klokka, SKAL du kalle verktøyet smoke_get_time. Ikke svar med tekst før du har kalt verktøyet.";
const TOOL_PROMPT = "Hva er klokka akkurat nå? Bruk verktøyet.";
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const TENANT = /^[A-Za-z0-9_.-]{1,64}$/;
/** Kun den lille, kjente mengden; en skrivefeil i `--providers`/`--block` skal avvises, ikke gi en stille tom kjøring. */
const KNOWN = new Set(SMOKE_PROVIDER_ORDER);

export interface SmokeOptions {
  /** `null` = alle konfigurerte. */
  providers: string[] | null;
  /** `null` = første live leverandør i kanonisk rekkefølge. */
  block: string | null;
  tools: boolean;
  parallel: boolean;
  /** Antall sekvensielle (alene-)kall per leverandør i `--parallel`. */
  soloCalls: number;
  /** Antall samtidige kall per leverandør i `--parallel`. */
  parallelCalls: number;
  maxCostOre: number;
  timeoutMs: number;
  out: string | null;
  db: boolean;
  tenant: string;
  help: boolean;
}
export type ParsedSmokeArgs = { ok: true; options: SmokeOptions } | { ok: false; error: string };

const BOOLEAN_FLAGS = new Set(["tools", "parallel", "db", "help"]);
const VALUE_FLAGS = new Set(["providers", "block", "solo-calls", "parallel-calls", "max-cost-ore", "timeout-ms", "out", "tenant"]);

function intIn(name: string, raw: string, min: number, max: number): number | string {
  if (!/^\d{1,9}$/.test(raw)) return `--${name} må være et heltall (fikk «${raw.slice(0, 20)}»)`;
  const n = Number(raw);
  return n < min || n > max ? `--${name} må være mellom ${min} og ${max}` : n;
}

/** Streng parsing: ukjent flagg, manglende verdi, ugyldig tall eller navn gir en feil (aldri en stille standard). */
export function parseSmokeArgs(argv: readonly string[]): ParsedSmokeArgs {
  const o: SmokeOptions = { providers: null, block: null, tools: false, parallel: false, soloCalls: 3, parallelCalls: 3, maxCostOre: 100, timeoutMs: 30_000, out: null, db: false, tenant: "tenant-personal", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) return { ok: false, error: `uventet argument «${token.slice(0, 30)}»` };
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      (o as unknown as Record<string, boolean>)[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) return { ok: false, error: `ukjent flagg --${name.slice(0, 30)}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `--${name} trenger en verdi` };
    i += 1;
    switch (name) {
      case "providers": {
        const names = value.split(",").map((n) => n.trim());
        const bad = names.find((n) => !NAME.test(n) || !KNOWN.has(n));
        if (bad !== undefined) return { ok: false, error: `ukjent leverandør «${bad.slice(0, 30)}» i --providers (kjente: ${SMOKE_PROVIDER_ORDER.join(", ")})` };
        o.providers = [...new Set(names)];
        break;
      }
      case "block":
        if (!NAME.test(value) || !KNOWN.has(value)) return { ok: false, error: `ukjent leverandør «${value.slice(0, 30)}» i --block` };
        o.block = value;
        break;
      case "solo-calls": case "parallel-calls": case "max-cost-ore": case "timeout-ms": {
        const bounds = { "solo-calls": [2, 10], "parallel-calls": [2, 6], "max-cost-ore": [1, 10_000], "timeout-ms": [1_000, 120_000] }[name] as [number, number];
        const n = intIn(name, value, bounds[0], bounds[1]);
        if (typeof n === "string") return { ok: false, error: n };
        if (name === "solo-calls") o.soloCalls = n;
        else if (name === "parallel-calls") o.parallelCalls = n;
        else if (name === "max-cost-ore") o.maxCostOre = n;
        else o.timeoutMs = n;
        break;
      }
      case "out":
        if (value.includes("\0") || !value.endsWith(".json")) return { ok: false, error: "--out må være en filsti som ender på .json" };
        o.out = value;
        break;
      case "tenant":
        if (!TENANT.test(value)) return { ok: false, error: "--tenant har ugyldig format" };
        o.tenant = value;
        break;
    }
  }
  return { ok: true, options: o };
}

export const SMOKE_USAGE_NO = [
  "mesh-live-smoke - eierens akseptanse for AI Mesh («≥3 live providers med fallback»). Leser nøkler fra miljøet (aldri skrevet ut).",
  "",
  "  node --experimental-transform-types modules/model-gateway/scripts/mesh-live-smoke.ts [flagg]",
  "",
  "  --providers a,b      begrens til disse leverandørene (standard: alle konfigurerte)",
  "  --block <navn>       leverandøren som sperres i fallback-testen (standard: første live i rekkefølgen lokale → sky)",
  "  --tools              test verktøykall (kall, rundtur med resultat, streaming) for live leverandører som oppgir tool_calling",
  "  --parallel           mål parallell-delegerings-overhead (alene-kall mot samtidige kall) per live leverandør",
  "  --solo-calls N       alene-kall per leverandør i --parallel (2-10, standard 3)",
  "  --parallel-calls N   samtidige kall per leverandør i --parallel (2-6, standard 3)",
  "  --max-cost-ore N     kostnadstak for hele kjøringen i øre (1-10000, standard 100); stanser og gir INCOMPLETE",
  "  --timeout-ms N       tidsavbrudd per modellkall (1000-120000, standard 30000)",
  "  --out fil.json       evidensfil (standard var/mesh-smoke/mesh-smoke-<tid>.json, git-ignorert)",
  "  --db                 bruk ekte database (kostrader skrives for --tenant, standard tenant-personal) slik at executive.get_ai_mesh_status viser beviset",
  "  --tenant id          tenant for --db",
  "",
  "Avslutningskode: 0 = PASS, 1 = FAIL, 2 = INCOMPLETE (for få konfigurerte leverandører, kostnadstak) eller ugyldige flagg."
].join("\n");

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Redigering og hemmelighetsvern
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const ERROR_TEXT_MAX = 120;

/** Kort, redigert feiltekst: hemmeligheter og URL-er fjernes, linjeskift flates ut, lengden kappes. En leverandørs frie tekst slipper aldri ut uredigert. `null` for tom. */
export function redactErrorText(raw: string | undefined, max: number = ERROR_TEXT_MAX): string | null {
  if (raw === undefined) return null;
  const cleaned = scanForSecrets(raw).text.replace(/https?:\/\/\S+/gi, "[url]").replace(/\s+/g, " ").trim();
  if (cleaned === "") return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

const SECRET_ENV_NAME = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIAL)/i;

/** Navnene (aldri verdiene) på miljøvariabler som ser ut som hemmeligheter og har en verdi på minst 8 tegn - brukes til å sjekke at evidensen ikke inneholder dem. */
export function secretEnvNames(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env).filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string" && value.length >= 8).map(([name]) => name);
}

/**
 * Evidens skal være hemmelighetsfri. Kaster hvis teksten inneholder (a) noe `scanForSecrets` gjenkjenner eller (b) verdien av en hemmelighetsliknende miljøvariabel. Feilmeldingen nevner kun
 * kategori/variabelnavn - aldri selve verdien.
 */
export function assertEvidenceHasNoSecrets(text: string, env: Readonly<Record<string, string | undefined>>): void {
  const scan = scanForSecrets(text);
  if (scan.findings.length > 0) throw new Error(`evidence_contains_secret:${scan.findings.map((f) => f.kind).join(",")}`);
  for (const name of secretEnvNames(env)) {
    if (text.includes(env[name] as string)) throw new Error(`evidence_contains_env_value:${name}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Testdobler: sperret og tripwire-adaptere, og en minnebasert pool (for kjøring uten database)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
/** Simulerer at leverandøren er nede: hvert kall feiler som `network` (transient - gatewayen prøver én gang til og går deretter videre). Rører aldri nettet. */
export class BlockedAdapter implements ModelProviderAdapter {
  attempts = 0;
  readonly name: string;
  readonly model: string;
  constructor(private readonly inner: ModelProviderAdapter) {
    this.name = inner.name;
    this.model = inner.model ?? "ukjent";
  }
  available(): boolean {
    return this.inner.available();
  }
  async complete(): Promise<ModelResult> {
    this.attempts += 1;
    throw new ProviderError(this.name, "network", `${this.name}_blocked_by_smoke`);
  }
  async stream(): Promise<ModelResult> {
    this.attempts += 1;
    throw new ProviderError(this.name, "network", `${this.name}_blocked_by_smoke`);
  }
}

/**
 * Sensitivitetsporten uten nettkall: samme navn/modell/tilgjengelighet som den ekte adapteren, men lokale svarer med et fast stubbesvar og SKYLEVERANDØRER feiler og telles. Gatewayen skal aldri kalle
 * en sky-tripwire for SECRET_RESTRICTED - da er porten brutt.
 */
export class TripwireAdapter implements ModelProviderAdapter {
  calls = 0;
  readonly name: string;
  readonly model: string;
  constructor(private readonly inner: ModelProviderAdapter, readonly locality: "local" | "cloud") {
    this.name = inner.name;
    this.model = inner.model ?? "ukjent";
  }
  available(): boolean {
    return this.inner.available();
  }
  async complete(): Promise<ModelResult> {
    this.calls += 1;
    if (this.locality === "cloud") throw new ProviderError(this.name, "server", `${this.name}_tripwire`);
    return { text: "OK", usage: { input_tokens: 1, output_tokens: 1 }, provider: this.name, model: this.model, finish_reason: "stop" };
  }
}

/** Minnebasert `pg.Pool` til `BudgetGuard`/kostbokføring når skriptet kjøres uten `--db`: ingen database, ingen sideeffekter. `inserts` er parameterlistene som ville blitt skrevet til `cost_events`. */
export function inMemoryCostPool(): { pool: pg.Pool; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.includes("FROM cost_events")) return { rows: [{ spent: 0 }] };
      if (typeof sql === "string" && sql.includes("INSERT INTO cost_events")) inserts.push(params ?? []);
      return { rows: [] };
    },
    release: () => undefined
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, inserts };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Kostnadsmåler
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export class SmokeCostMeter {
  spent = 0;
  capHit = false;
  constructor(readonly cap: number) {}
  /** Sant når taket er nådd - da gjøres ingen flere betalte kall (og `capHit` huskes til verdiktet). */
  get exhausted(): boolean {
    if (this.spent >= this.cap) this.capHit = true;
    return this.capHit;
  }
  add(ore: number): void {
    this.spent += ore;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Fase 1: ett lite kall per konfigurert leverandør
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export type SmokeProbeStatus = "LIVE" | "EMPTY_OUTPUT" | "FAILED" | "NOT_CONFIGURED" | "SKIPPED_COST_CAP";

export interface SmokeProbeRecord {
  provider: string;
  model: string;
  locality: "local" | "cloud";
  /** Nøkkel/URL er satt (presence - aldri verdien). */
  configured: boolean;
  status: SmokeProbeStatus;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_ore: number | null;
  finish_reason: string | null;
  error_kind: string | null;
  error_code: string | null;
}

interface CallOutcome {
  ok: boolean;
  result: ModelResult | null;
  latency_ms: number;
  cost_ore: number;
  error_kind: string | null;
  error_code: string | null;
}

const errorKindOf = (err: unknown): string => (err instanceof ProviderError ? err.kind : "unknown");
const errorCodeOf = (err: unknown): string | null => redactErrorText(err instanceof Error ? err.message : String(err));

/** Ett kall direkte mot adapteren (ingen ruting). Kaster aldri: feil blir `ok: false` med klasse og redigert kode. */
async function callOnce(adapter: ModelProviderAdapter, request: ModelRequest, pricing: PricingTable, meter: SmokeCostMeter): Promise<CallOutcome> {
  const started = Date.now();
  try {
    const result = await adapter.complete(request);
    const cost = costOre(pricing, result.provider, result.model, result.usage);
    meter.add(cost);
    return { ok: true, result, latency_ms: result.latency_ms ?? Date.now() - started, cost_ore: cost, error_kind: null, error_code: null };
  } catch (err) {
    return { ok: false, result: null, latency_ms: Date.now() - started, cost_ore: 0, error_kind: errorKindOf(err), error_code: errorCodeOf(err) };
  }
}

const smokeRequest = (): ModelRequest => ({ messages: [{ role: "user", content: SMOKE_PROMPT }], max_tokens: SMOKE_MAX_TOKENS, temperature: 0 });

export function localityOf(registry: CapabilityRegistry, adapter: ModelProviderAdapter): "local" | "cloud" {
  return registry.profileOrGeneric(adapter.name, adapter.model ?? "ukjent").locality;
}

export async function probeProvider(adapter: ModelProviderAdapter, deps: { pricing: PricingTable; registry: CapabilityRegistry; meter: SmokeCostMeter }): Promise<SmokeProbeRecord> {
  const base = { provider: adapter.name, model: adapter.model ?? "ukjent", locality: localityOf(deps.registry, adapter), configured: adapter.available() };
  const empty = { latency_ms: null, input_tokens: null, output_tokens: null, cost_ore: null, finish_reason: null, error_kind: null, error_code: null };
  if (!base.configured) return { ...base, ...empty, status: "NOT_CONFIGURED" };
  if (deps.meter.exhausted) return { ...base, ...empty, status: "SKIPPED_COST_CAP" };
  const out = await callOnce(adapter, smokeRequest(), deps.pricing, deps.meter);
  if (!out.ok || out.result === null) return { ...base, ...empty, status: "FAILED", latency_ms: out.latency_ms, error_kind: out.error_kind, error_code: out.error_code };
  const r = out.result;
  return {
    ...base,
    status: r.text.trim().length > 0 ? "LIVE" : "EMPTY_OUTPUT",
    latency_ms: out.latency_ms,
    input_tokens: r.usage.input_tokens,
    output_tokens: r.usage.output_tokens,
    cost_ore: out.cost_ore,
    finish_reason: r.finish_reason ?? null,
    error_kind: null,
    error_code: null
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Fase 2: tvungen fallback mot den ekte gatewayen (én leverandør sperret)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export type SmokeFallbackStatus = "PROVEN" | "NOT_PROVEN" | "SKIPPED";

export interface SmokeFallbackCheck {
  status: SmokeFallbackStatus;
  blocked: string | null;
  chain: string[];
  served_by: string | null;
  fallback_from: string[];
  /** Antall kall som nådde den sperrede adapteren (0 = den ble aldri forsøkt). */
  blocked_attempts: number;
  /** `meshStatus().fallback` etter kallet (VERIFIED = gatewayen har observert en vellykket fallback i denne prosessen). */
  gateway_state: "VERIFIED" | "READY" | "LOGIC_ONLY" | null;
  /** Kun med `--db`: raden i `cost_events` har `fallback = true` (beviset `get_ai_mesh_status` leser). `null` = ikke sjekket. */
  cost_row_fallback: boolean | null;
  reason: string | null;
}

/** Kjeden for fallback-testen: den sperrede først, så de øvrige live leverandørene i kanonisk rekkefølge. */
export function fallbackChain(live: readonly string[], blocked: string): string[] {
  const rest = SMOKE_PROVIDER_ORDER.filter((p) => live.includes(p) && p !== blocked);
  return [blocked, ...rest];
}

/** Standard å sperre: den første live leverandøren i kanonisk rekkefølge (lokal modell først - det er den reelle «Gemma først»-feilsituasjonen). */
export function defaultBlocked(live: readonly string[]): string | null {
  return SMOKE_PROVIDER_ORDER.find((p) => live.includes(p)) ?? null;
}

export async function runFallbackCheck(input: {
  gateway: Pick<ModelGateway, "complete" | "meshStatus">;
  blocked: string;
  chain: string[];
  blockedAdapter: BlockedAdapter;
  tenantId: string;
  taskId: string;
  /** `--db`: leser tilbake kostraden for kallet (true/false), ellers `null`. */
  readCostRowFallback?: () => Promise<boolean | null>;
}): Promise<SmokeFallbackCheck> {
  const base = { blocked: input.blocked, chain: input.chain };
  const fail = (reason: string, extra: Partial<SmokeFallbackCheck> = {}): SmokeFallbackCheck => ({
    status: "NOT_PROVEN", ...base, served_by: null, fallback_from: [], blocked_attempts: input.blockedAdapter.attempts, gateway_state: null, cost_row_fallback: null, reason, ...extra
  });
  try {
    const result = await input.gateway.complete({
      tenant_id: input.tenantId,
      task_id: input.taskId,
      session_id: input.taskId,
      purpose: "QUICK_CLASSIFICATION",
      sensitivity: "PUBLIC_OR_LOW_SENSITIVITY",
      providerPreference: input.chain,
      preferenceFailover: true,
      request: smokeRequest()
    });
    const router = result.metadata?.["router"] as { fallback_from?: unknown } | undefined;
    const from = Array.isArray(router?.fallback_from) ? router.fallback_from.filter((x): x is string => typeof x === "string") : [];
    const state = input.gateway.meshStatus().fallback;
    const costRow = input.readCostRowFallback ? await input.readCostRowFallback() : null;
    // Med `--db` SKAL kostraden finnes (bokføringen er allerede ventet på når `complete()` returnerer). Mangler den, ser `get_ai_mesh_status` ingenting - ikke et bevis.
    const costRowMissing = input.readCostRowFallback !== undefined && costRow === null;
    const detail = { served_by: result.provider, fallback_from: from, blocked_attempts: input.blockedAdapter.attempts, gateway_state: state, cost_row_fallback: costRow };
    if (result.provider === input.blocked) return fail("den sperrede leverandøren svarte likevel", detail);
    if (input.blockedAdapter.attempts === 0) return fail("den sperrede leverandøren ble aldri forsøkt (kjeden startet ikke med den)", detail);
    if (!from.includes(input.blocked)) return fail("svaret er ikke merket som fallback fra den sperrede leverandøren", detail);
    if (result.text.trim().length === 0) return fail("reserven svarte uten synlig tekst", detail);
    if (costRowMissing) return fail("kostraden ble ikke funnet i cost_events (finnes --tenant, og er databasen skrivbar?)", detail);
    if (costRow === false) return fail("kostraden mangler fallback-flagget (get_ai_mesh_status ville ikke sett beviset)", detail);
    return { status: "PROVEN", ...base, ...detail, reason: null };
  } catch (err) {
    return fail(`kallet feilet: ${errorKindOf(err)} ${errorCodeOf(err) ?? ""}`.trim());
  }
}

export const SKIPPED_FALLBACK: SmokeFallbackCheck = {
  status: "SKIPPED", blocked: null, chain: [], served_by: null, fallback_from: [], blocked_attempts: 0, gateway_state: null, cost_row_fallback: null, reason: "krever minst to live leverandører"
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Sensitivitetsporten (frakoblet)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export interface SmokeGateCheck {
  status: "PASS" | "FAIL" | "SKIPPED";
  outcome: "REFUSED" | "SERVED_LOCAL" | "SERVED_CLOUD" | "ERROR" | null;
  chain: string[];
  /** Antall kall som nådde en skyleverandør (SKAL være 0). */
  cloud_calls: number;
  local_calls: number;
  detail: string | null;
}

/**
 * SECRET_RESTRICTED mot en kjede der skyleverandørene står FØRST (verste tilfelle) - skal enten besvares lokalt eller avvises, aldri nå en skyleverandør (D-378). `makeGateway` bygger en
 * gateway over de gitte (tripwire-)adapterne. Ingen nettkall.
 */
export async function runSensitivityGateCheck(input: {
  adapters: readonly ModelProviderAdapter[];
  registry: CapabilityRegistry;
  makeGateway: (providers: ModelProviderAdapter[]) => Pick<ModelGateway, "complete">;
  tenantId: string;
}): Promise<SmokeGateCheck> {
  const wrapped = input.adapters.filter((a) => a.available()).map((a) => new TripwireAdapter(a, localityOf(input.registry, a)));
  if (wrapped.length === 0) return { status: "SKIPPED", outcome: null, chain: [], cloud_calls: 0, local_calls: 0, detail: "ingen konfigurerte leverandører" };
  const ordered = [...wrapped.filter((a) => a.locality === "cloud"), ...wrapped.filter((a) => a.locality === "local")];
  const chain = ordered.map((a) => a.name);
  const gateway = input.makeGateway(wrapped);
  const counts = () => ({ cloud_calls: wrapped.filter((a) => a.locality === "cloud").reduce((n, a) => n + a.calls, 0), local_calls: wrapped.filter((a) => a.locality === "local").reduce((n, a) => n + a.calls, 0) });
  try {
    const result = await gateway.complete({
      tenant_id: input.tenantId,
      purpose: "QUICK_CLASSIFICATION",
      sensitivity: "SECRET_RESTRICTED",
      providerPreference: chain,
      preferenceFailover: true,
      request: smokeRequest()
    });
    const served = wrapped.find((a) => a.name === result.provider);
    const c = counts();
    const cloud = c.cloud_calls > 0 || served?.locality === "cloud";
    return { status: cloud ? "FAIL" : "PASS", outcome: cloud ? "SERVED_CLOUD" : "SERVED_LOCAL", chain, ...c, detail: cloud ? "SECRET_RESTRICTED nådde en skyleverandør" : null };
  } catch (err) {
    const c = counts();
    if (c.cloud_calls > 0) return { status: "FAIL", outcome: "ERROR", chain, ...c, detail: "SECRET_RESTRICTED nådde en skyleverandør" };
    if (err instanceof NoEligibleProviderError) return { status: "PASS", outcome: "REFUSED", chain, ...c, detail: "avvist uten kvalifisert lokal leverandør (riktig)" };
    return { status: "PASS", outcome: "ERROR", chain, ...c, detail: `feil uten skykall: ${errorKindOf(err)}` };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Fase 3 (--tools): verktøykall, rundtur og streaming
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export type SmokeToolStatus = "TOOL_CALL_OK" | "ROUNDTRIP_OK" | "STREAM_TOOL_CALL_OK" | "NO_TOOL_CALL" | "WRONG_TOOL" | "INVALID_TOOL_CALL" | "NO_FINAL_TEXT" | "FAILED" | "SKIPPED";

export interface SmokeToolRecord {
  provider: string;
  call: SmokeToolStatus;
  roundtrip: SmokeToolStatus;
  stream: SmokeToolStatus;
  error_codes: string[];
  cost_ore: number;
}

const toolRequest = (tool_exchanges?: ToolExchange[]): ModelRequest => ({
  system: TOOL_SYSTEM, messages: [{ role: "user", content: TOOL_PROMPT }], tools: [SMOKE_TOOL], max_tokens: 512, temperature: 0, ...(tool_exchanges ? { tool_exchanges } : {})
});

function classifyToolCall(calls: readonly ToolCallRequest[] | undefined): { status: SmokeToolStatus; call: ToolCallRequest | null } {
  if (!calls || calls.length === 0) return { status: "NO_TOOL_CALL", call: null };
  const first = calls[0] as ToolCallRequest;
  if (first.tool_name !== SMOKE_TOOL.name) return { status: "WRONG_TOOL", call: null };
  if (typeof first.arguments !== "object" || first.arguments === null || Array.isArray(first.arguments)) return { status: "INVALID_TOOL_CALL", call: null };
  return { status: "TOOL_CALL_OK", call: first };
}

const toolFailure = (out: CallOutcome): SmokeToolStatus => (out.error_kind === "invalid_tool_call" ? "INVALID_TOOL_CALL" : "FAILED");

export async function probeTools(adapter: ModelProviderAdapter, deps: { pricing: PricingTable; meter: SmokeCostMeter; streaming: boolean; now?: () => Date }): Promise<SmokeToolRecord> {
  const rec: SmokeToolRecord = { provider: adapter.name, call: "SKIPPED", roundtrip: "SKIPPED", stream: "SKIPPED", error_codes: [], cost_ore: 0 };
  const spentBefore = deps.meter.spent;
  const note = (out: CallOutcome) => { if (out.error_code) rec.error_codes.push(out.error_code); };
  if (deps.meter.exhausted) return rec;

  const first = await callOnce(adapter, toolRequest(), deps.pricing, deps.meter);
  if (!first.ok || first.result === null) {
    rec.call = toolFailure(first);
    note(first);
  } else {
    const classified = classifyToolCall(first.result.tool_calls);
    rec.call = classified.status;
    if (classified.call && !deps.meter.exhausted) {
      const at = (deps.now ?? (() => new Date()))().toISOString();
      const second = await callOnce(adapter, toolRequest([{
        calls: [classified.call],
        results: [{ tool_call_id: classified.call.tool_call_id, tool_name: classified.call.tool_name, execution_id: "smoke-exec-1", success: true, output: { now: at }, at, trust: "trusted" }]
      }]), deps.pricing, deps.meter);
      if (!second.ok || second.result === null) {
        rec.roundtrip = toolFailure(second);
        note(second);
      } else {
        rec.roundtrip = second.result.text.trim().length > 0 ? "ROUNDTRIP_OK" : "NO_FINAL_TEXT";
      }
    }
  }

  if (deps.streaming && adapter.stream && !deps.meter.exhausted) {
    const events: StreamEvent[] = [];
    try {
      const result = await adapter.stream(toolRequest(), (e) => events.push(e));
      deps.meter.add(costOre(deps.pricing, result.provider, result.model, result.usage));
      const complete = events.find((e): e is Extract<StreamEvent, { type: "tool_call_complete" }> => e.type === "tool_call_complete");
      const viaResult = classifyToolCall(result.tool_calls);
      rec.stream = complete && complete.call.tool_name === SMOKE_TOOL.name && viaResult.status === "TOOL_CALL_OK" ? "STREAM_TOOL_CALL_OK" : viaResult.status === "TOOL_CALL_OK" ? "FAILED" : viaResult.status;
      if (rec.stream === "FAILED") rec.error_codes.push("stream_ga_kall_uten_tool_call_complete");
    } catch (err) {
      rec.stream = errorKindOf(err) === "invalid_tool_call" ? "INVALID_TOOL_CALL" : "FAILED";
      const code = errorCodeOf(err);
      if (code) rec.error_codes.push(code);
    }
  }
  rec.cost_ore = deps.meter.spent - spentBefore;
  return rec;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Fase 4 (--parallel): kontrollert overhead ved samtidige kall
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export interface SmokeParallelRecord {
  provider: string;
  solo_samples: number;
  parallel_samples: number;
  p50_solo_ms: number | null;
  p50_parallel_ms: number | null;
  /** p50 samtidig minus p50 alene (ms). `null` med færre enn 3 vellykkede prøver i en av gruppene. */
  overhead_ms: number | null;
  failed_calls: number;
  note: string | null;
}

const MIN_SAMPLES = 3;

export function overheadOf(solo: readonly number[], parallel: readonly number[]): { p50_solo: number | null; p50_parallel: number | null; overhead: number | null } {
  const s = medianOf(solo);
  const p = medianOf(parallel);
  const overhead = solo.length >= MIN_SAMPLES && parallel.length >= MIN_SAMPLES && s !== undefined && p !== undefined ? Math.round(p - s) : null;
  return { p50_solo: s === undefined ? null : Math.round(s), p50_parallel: p === undefined ? null : Math.round(p), overhead };
}

/** Samme lille forespørsel `soloCalls` ganger etter hverandre, deretter `parallelCalls` samtidig - identisk innhold, så forskjellen er overhead (kø/rate-begrensning), ikke innhold. */
export async function measureParallel(adapter: ModelProviderAdapter, deps: { pricing: PricingTable; meter: SmokeCostMeter; soloCalls: number; parallelCalls: number }): Promise<SmokeParallelRecord> {
  const solo: number[] = [];
  const parallel: number[] = [];
  let failed = 0;
  let capped = false;
  for (let i = 0; i < deps.soloCalls; i += 1) {
    if (deps.meter.exhausted) { capped = true; break; }
    const out = await callOnce(adapter, smokeRequest(), deps.pricing, deps.meter);
    if (out.ok && out.result && out.result.text.trim().length > 0) solo.push(out.latency_ms);
    else failed += 1;
  }
  if (!deps.meter.exhausted) {
    const outs = await Promise.all(Array.from({ length: deps.parallelCalls }, () => callOnce(adapter, smokeRequest(), deps.pricing, deps.meter)));
    for (const out of outs) {
      if (out.ok && out.result && out.result.text.trim().length > 0) parallel.push(out.latency_ms);
      else failed += 1;
    }
  } else {
    capped = true;
  }
  const o = overheadOf(solo, parallel);
  const note = capped ? "stoppet av kostnadstaket" : o.overhead === null ? `for få vellykkede prøver (trenger ${MIN_SAMPLES} i hver gruppe)` : null;
  return { provider: adapter.name, solo_samples: solo.length, parallel_samples: parallel.length, p50_solo_ms: o.p50_solo, p50_parallel_ms: o.p50_parallel, overhead_ms: o.overhead, failed_calls: failed, note };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Verdikt og evidens
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export type SmokeVerdict = "PASS" | "FAIL" | "INCOMPLETE";
export const SMOKE_REQUIRED_LIVE = 3;

export interface SmokeEvaluation {
  verdict: SmokeVerdict;
  reasons: string[];
  notes: string[];
  live: string[];
  configured: string[];
}

/**
 * PASS = minst tre leverandører bevist live (synlig tekst) OG fallback bevist OG sensitivitetsporten holdt. FAIL = noe er konfigurert men virker ikke, fallback uten bevis eller (verst) at
 * SECRET_RESTRICTED nådde sky. INCOMPLETE = eieren må gjøre noe først (for få nøkler) eller kostnadstaket stoppet kjøringen - aldri en falsk PASS og aldri en falsk FAIL.
 */
export function evaluateSmoke(input: { probes: readonly SmokeProbeRecord[]; fallback: SmokeFallbackCheck; gate: SmokeGateCheck; costCapHit: boolean }): SmokeEvaluation {
  const configured = input.probes.filter((p) => p.configured).map((p) => p.provider);
  const live = input.probes.filter((p) => p.status === "LIVE").map((p) => p.provider);
  const reasons: string[] = [];
  const notes: string[] = [];
  if (live.includes("gemini") && live.includes("gemma_hosted")) notes.push("gemini og gemma_hosted går mot samme leverandør (Google) og er ikke uavhengige ved et Google-utfall - vurder tre uavhengige leverandører.");

  if (input.gate.status === "FAIL") reasons.push(`SIKKERHET: ${input.gate.detail ?? "SECRET_RESTRICTED nådde en skyleverandør"} (${input.gate.cloud_calls} skykall).`);
  const notLive = input.probes.filter((p) => p.configured && p.status !== "LIVE");
  if (configured.length < SMOKE_REQUIRED_LIVE) reasons.push(`Bare ${configured.length} konfigurerte leverandører (trenger ${SMOKE_REQUIRED_LIVE}) - legg inn nøkkel/URL for flere.`);
  else if (live.length < SMOKE_REQUIRED_LIVE) reasons.push(`Bare ${live.length} av ${SMOKE_REQUIRED_LIVE} nødvendige leverandører er live: ${notLive.map((p) => `${p.provider}=${p.status}${p.error_kind ? `(${p.error_kind})` : ""}`).join(", ")}.`);
  if (input.fallback.status === "NOT_PROVEN") reasons.push(`Fallback er ikke bevist: ${input.fallback.reason ?? "ukjent årsak"}.`);
  else if (input.fallback.status === "SKIPPED") reasons.push(`Fallback ble ikke testet: ${input.fallback.reason ?? "hoppet over"}.`);
  if (input.costCapHit) reasons.push("Kostnadstaket stoppet kjøringen før alt var gjort.");

  let verdict: SmokeVerdict;
  if (input.gate.status === "FAIL") verdict = "FAIL";
  else if (configured.length < SMOKE_REQUIRED_LIVE || input.costCapHit) verdict = "INCOMPLETE";
  else if (live.length < SMOKE_REQUIRED_LIVE || input.fallback.status !== "PROVEN") verdict = "FAIL";
  else verdict = "PASS";
  return { verdict, reasons: verdict === "PASS" ? [] : reasons, notes, live, configured };
}

export interface SmokeEvidence {
  schema: "jarvis.mesh-smoke/1";
  started_at: string;
  finished_at: string;
  node: string;
  mode: "no_db" | "db";
  /** Flaggene som ble brukt (aldri nøkler). */
  options: { providers: string[] | null; block: string | null; tools: boolean; parallel: boolean; max_cost_ore: number; timeout_ms: number; tenant: string | null };
  providers: SmokeProbeRecord[];
  fallback: SmokeFallbackCheck;
  sensitivity_gate: SmokeGateCheck;
  tools: SmokeToolRecord[] | null;
  parallel: SmokeParallelRecord[] | null;
  cost: { spent_ore: number; cap_ore: number; cap_hit: boolean };
  live_providers: string[];
  verdict: SmokeVerdict;
  reasons: string[];
  notes: string[];
}

/** Kortfattet norsk sammendrag til terminalen (ingen nøkler, ingen innhold utover tilstander og tall). */
export function renderSmokeSummaryNo(ev: SmokeEvidence): string {
  const lines: string[] = [];
  lines.push(`AI Mesh røyktest (${ev.mode === "db" ? "med database" : "uten database"}): ${ev.verdict}`);
  for (const p of ev.providers) {
    const where = p.locality === "local" ? "lokal" : "sky";
    if (!p.configured) { lines.push(`  ${p.provider.padEnd(12)} ${where.padEnd(6)} IKKE KONFIGURERT`); continue; }
    const tail = p.status === "LIVE" ? `${p.latency_ms} ms, ${p.input_tokens}/${p.output_tokens} tokens, ${p.cost_ore} øre` : p.error_kind ? `${p.error_kind}${p.error_code ? ` ${p.error_code}` : ""}` : p.finish_reason ? `finish=${p.finish_reason}` : "";
    lines.push(`  ${p.provider.padEnd(12)} ${where.padEnd(6)} ${p.status}${tail ? ` - ${tail}` : ""}`);
  }
  const f = ev.fallback;
  lines.push(`  fallback: ${f.status}${f.status === "PROVEN" ? ` (${f.blocked} sperret → svart av ${f.served_by}${f.cost_row_fallback === true ? "; kostraden har fallback=true" : ""})` : f.reason ? ` - ${f.reason}` : ""}`);
  lines.push(`  sensitivitetsport (SECRET_RESTRICTED): ${ev.sensitivity_gate.status}${ev.sensitivity_gate.outcome ? ` (${ev.sensitivity_gate.outcome}, skykall ${ev.sensitivity_gate.cloud_calls})` : ""}`);
  if (ev.tools) for (const t of ev.tools) lines.push(`  verktøy ${t.provider}: kall=${t.call} rundtur=${t.roundtrip} streaming=${t.stream}`);
  if (ev.parallel) for (const p of ev.parallel) lines.push(`  parallell ${p.provider}: alene p50 ${p.p50_solo_ms ?? "?"} ms, samtidig p50 ${p.p50_parallel_ms ?? "?"} ms, overhead ${p.overhead_ms === null ? `ukjent${p.note ? ` (${p.note})` : ""}` : `${p.overhead_ms >= 0 ? "+" : ""}${p.overhead_ms} ms`}`);
  lines.push(`  kostnad: ${ev.cost.spent_ore} av ${ev.cost.cap_ore} øre${ev.cost.cap_hit ? " (TAK NÅDD)" : ""}`);
  for (const r of ev.reasons) lines.push(`  - ${r}`);
  for (const n of ev.notes) lines.push(`  merk: ${n}`);
  return lines.join("\n");
}
