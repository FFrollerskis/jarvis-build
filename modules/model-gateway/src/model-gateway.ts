import { BACKGROUND_PURPOSE_SET, INTERACTIVE_PURPOSES, type InteractivePriorityGate } from "./interactive-priority.ts";
import { randomUUID } from "node:crypto";
import { allFailedText, mustReplaceWithFailureText, partialFailureNote, summarizeToolOutcomes } from "./tool-honesty.ts";
import type pg from "pg";
import { withTenantTransaction } from "@jarvis/core";
import type { DataSensitivity, ModelPurpose, RouterMode } from "@jarvis/contracts";
import { createHash } from "node:crypto";
import {
  ProviderError,
  hasRestrictedMedia,
  textOnly,
  type ModelProviderAdapter,
  type ModelRequest,
  type ModelResult,
  type StreamEvent,
  type StreamHandler,
  type ToolCallRequest,
  type ToolDefinition,
  type ToolExchange,
  type ToolResultMessage
} from "@jarvis/provider-adapters";
import { BudgetGuard, type BudgetConfig, DEFAULT_BUDGET } from "./budget-guard.ts";
import { classifyCompletionOutcome, computeAdaptiveRetryMaxTokens, type CompletionOutcome } from "./completion-outcome.ts";
import { CapabilityRegistry, type ModelCapability } from "./capability-registry.ts";
import { ProviderHealthTracker, type ProviderHealthDetail, type ProviderHealthDetails, type ProviderHealthState } from "./provider-health.ts";
import { AiRouter, LocalModelUnavailableError, NoEligibleProviderError, PaidModelsDisabledError, type RouteInput, type RoutePlan } from "./router.ts";
import { meshToolsVerifiedFromEnv } from "./mesh-verification.ts";
import { assertExplicitPricing, costOre as computeCostOre, DEFAULT_PRICING, type PricingTable } from "./pricing.ts";
import { modelCatalogFromEnv, type CatalogModel, type ModelTier } from "./model-catalog.ts";
import { describeTask, HeuristicRoutingAdvisor, selectModelForTier, type RoutingAdvisor } from "./routing-advisor.ts";
import type { TraceSink } from "./trace.ts";
import { CLAUDE_BUDGET_PROVIDER, type BudgetOrigin } from "./claude-budget.ts";
import { estimateFailedCallOre, type ClaudeBudgetEnforcer, type PacingRoundContext, type PacingTicket } from "./claude-budget-enforcer.ts";

/**
 * D-106 Council reliability (§ARCHITECTURE DECISION, evidensbasert 2026-08-24):
 * ordinær `ModelGateway.complete()`/`.stream()`-default - UENDRET fra
 * adapternes egen historiske `JARVIS_MODEL_TIMEOUT_MS ?? 60000`-konvensjon.
 * Eksportert kun som dokumentasjon/referanse for kallere og tester - selve
 * default-oppførselen skjer FORTSATT i den enkelte adapterens konstruktør
 * (uendret), ikke her.
 */
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

/**
 * D-106 Council reliability (§DESIGN REQUIREMENTS pkt. 4-5): hard øvre grense
 * for ETHVERT eksplisitt `CompleteInput.timeoutMs`-overstyring - ingen kaller
 * kan be om ubegrenset kjøretid, uansett arbeidsmengde. Council sin egen
 * `COUNCIL_MODEL_TIMEOUT_MS=120000` (`council.ts`) ligger godt under denne.
 */
export const MAX_MODEL_TIMEOUT_MS = 180_000;

/**
 * D-402: bakgrunnsformål (minneuttrekk, sammendrag, klassifisering) kan ta lang tid på en lokal modell uten at leverandøren er nede.
 * Et TIDSAVBRUDD der sier ingenting om om samme leverandør kan svare på en chat-tur, så det teller ikke mot helsesporingen
 * (ellers stenger bakgrunnsjobber en lokal modell ute fra chatten og samtalen faller stille til betalt sky). Nettverks-/server-feil teller fortsatt.
 */
const BACKGROUND_PURPOSES: ReadonlySet<string> = new Set(["EXTRACT", "SUMMARIZE", "QUICK_CLASSIFICATION"]);
export function isBackgroundTimeout(purpose: string | undefined, kind: string): boolean {
  return kind === "timeout" && purpose !== undefined && BACKGROUND_PURPOSES.has(purpose);
}

/** Ugyldig eksplisitt `CompleteInput.timeoutMs` (ikke-endelig/≤0/over `MAX_MODEL_TIMEOUT_MS`) - feiler høylytt, aldri en stille klemming/gjetning. */
export class InvalidTimeoutError extends Error {
  constructor(readonly requestedMs: number) {
    super(
      `Ugyldig timeoutMs=${requestedMs}: må være et endelig tall > 0 og <= ${MAX_MODEL_TIMEOUT_MS}ms (${MAX_MODEL_TIMEOUT_MS / 1000}s hard grense).`
    );
    this.name = "InvalidTimeoutError";
  }
}

/**
 * D-106 Council reliability: validerer en eksplisitt per-kall
 * timeout-overstyring. `undefined` (ingen overstyring bedt om) gis tilbake
 * UENDRET - ordinære kall uten eksplisitt `timeoutMs` oppfører seg
 * byte-for-byte som før dette feltet fantes (adapterens egen
 * konstruksjonstidsdefault brukes). Provider-identitet inngår ALDRI i denne
 * vurderingen (§DESIGN REQUIREMENTS: ingen `if provider === "kimi"`-logikk
 * noe sted i denne arbeidsmengde-kapabiliteten).
 */
function resolveTimeoutMs(requested: number | undefined): number | undefined {
  if (requested === undefined) return undefined;
  if (!Number.isFinite(requested) || requested <= 0 || requested > MAX_MODEL_TIMEOUT_MS) {
    throw new InvalidTimeoutError(requested);
  }
  return requested;
}

/** Tydelig, maskinlesbar feil når budsjettet stopper kall (akseptanse 5). */
export class BudgetExceededError extends Error {
  constructor(
    readonly level: "needs_approval" | "hard_blocked",
    readonly spent_ore: number
  ) {
    super(
      level === "hard_blocked"
        ? `Månedsbudsjettet (hardgrense) er brukt opp (${(spent_ore / 100).toFixed(0)} kr). Nye modellkall nektes til grensen heves med signert overstyring.`
        : `Månedsforbruket (${(spent_ore / 100).toFixed(0)} kr) krever aktiv godkjenning før flere modellkall.`
    );
    this.name = "BudgetExceededError";
  }
}

/** WP-D4 (JARVIS-033): ett mislykket leverandørforsøk (se `CompleteInput.onAttemptFailed`). Kun leverandørnavn og feilklasse - aldri innhold eller feilmelding. */
export interface AttemptFailure {
  provider: string;
  kind: string;
}

export interface CompleteInput {
  tenant_id: string;
  session_id?: string;
  task_id?: string;
  request: ModelRequest;
  onToken?: (token: string) => void;
  /** UA-1: purpose-taksonomi for routing/kost/metrikk. */
  purpose?: ModelPurpose;
  /** UA-1: eksplisitt routing-mode; default AUTO. */
  mode?: RouterMode;
  /** UA-1 owner-override (§10): eksakt provider - ingen stille fallback. */
  provider?: string;
  required_capabilities?: ModelCapability[];
  /** UA-1 critic (§18): eksplisitt opt-in; aldri default. */
  critic?: boolean;
  /** D-106: se `RouteInput.sensitivity`/`isSensitivityEligible` for semantikk - videreført uendret hit. */
  sensitivity?: DataSensitivity;
  /** D-106: se `RouteInput.paid_models_allowed`. */
  paid_models_allowed?: boolean;
  /** D-106: se `RouteInput.providerPreference`. */
  providerPreference?: string[];
  /** WP-D4 (JARVIS-033): se `RouteInput.preferenceFailover` - preferanselisten blir en kandidatkjede med failover inne i gatewayen. Udefinert = uendret enkeltvalg. */
  preferenceFailover?: boolean;
  /** WP-D4 (L6): se `RouteInput.excludeProviders` - leverandører som allerede er forsøkt i turen og ikke skal prøves igjen i den scorede ruten (samtalemotorens siste reserve). Udefinert = uendret. */
  excludeProviders?: readonly string[];
  /**
   * WP-D4 (JARVIS-033): kalles for HVERT mislykket leverandørforsøk i hovedkallet (aldri critic, aldri brukeravbrudd) - også når en senere kandidat eller retry lykkes, og også når hele planen til slutt feiler.
   * Gir flatene (chatten) synlighet i reservebruk: hvem som ikke svarte før noen gjorde det (hvem som svarte står i resultatet). Gjennom verktøyløkker rapporteres alle runder, ikke bare den siste.
   * En feil i lytteren logges og teller aldri som leverandørfeil.
   */
  onAttemptFailed?: (failure: AttemptFailure) => void;
  /**
   * D-106 Council reliability (§ARCHITECTURE DECISION): eksplisitt, generisk
   * arbeidsmengde-spesifikk timeout-overstyring for DETTE kallet (millisekunder).
   * Validert mot `MAX_MODEL_TIMEOUT_MS` (kaster `InvalidTimeoutError` ved
   * ugyldig verdi - ALDRI en stille klemming). Udefinert (normaltilfellet) =
   * UENDRET ordinær oppførsel (adapterens egen konstruksjonstidsdefault,
   * `JARVIS_MODEL_TIMEOUT_MS`/60000). `AiCouncil` bruker dette for sin egen
   * `COUNCIL_MODEL_TIMEOUT_MS` - ALDRI provider-spesifikk, kun arbeidsmengde-
   * spesifikk (§DESIGN REQUIREMENTS: ingen `if provider === "kimi"` noe sted).
   */
  timeoutMs?: number;
  /**
   * WP-B4 (D-476): hvem kallet er for (eierens egen tur, en jobb eieren bestilte, bakgrunnsarbeid) - brukes KUN av Claude-kreditten (`GatewayOptions.claudeBudget`) til behovsprioriteringen. Udefinert = utledes av
   * `task_id`/`session_id`. Betrodde kallere (delegerte jobber, AI-råd) setter den KUN når `gateway.claudeBudgetActive` er sant, så innputtet er uendret uten flagget. Ignoreres helt uten Claude-kreditten.
   */
  budget_origin?: BudgetOrigin;
}

export interface GatewayOptions {
  pool: pg.Pool;
  /** Registrerte adaptere; router velger blant de som er konfigurert. */
  providers: ModelProviderAdapter[];
  trace: TraceSink;
  budget?: BudgetConfig;
  registry?: CapabilityRegistry;
  pricing?: PricingTable;
  /** Bakoverkompatibel enkel rate-tabell (øre/1k) - overstyrer pricing hvis satt. */
  rates?: Record<string, { input_per_1k_ore: number; output_per_1k_ore: number }>;
  /** Enkel rate limit: maks kall per minutt per tenant. */
  maxCallsPerMinute?: number;
  /**
   * D-399 (modellrådgiver): rådgiver som anbefaler modelltrinn per oppgave (default: deterministisk heuristikk). `advisorMode`: `off` = ingen rådgivning, `shadow` (default) = logg hva
   * rådgiveren VILLE valgt men endre ingenting, `active` = bruk anbefalingen (billigste valgbare modell som holder, kun hos ruterens primære leverandør). Env: `JARVIS_MODEL_ADVISOR`.
   */
  advisor?: RoutingAdvisor;
  catalog?: readonly CatalogModel[];
  advisorMode?: "off" | "shadow" | "active";
  /**
   * D-414: «chat først» - bakgrunnsformål (EXTRACT/SUMMARIZE/QUICK_CLASSIFICATION/BACKGROUND) venter mens en interaktiv forespørsel pågår.
   * Udefinert = ingen venting (uendret oppførsel, f.eks. i worker-prosessen som ikke ser API-ets chat).
   */
  priorityGate?: InteractivePriorityGate;
  /**
   * WP-D4 (M3, gjennomgang av PR #315): leverandører eieren har erklært LIVE-verifisert for verktøykall (og Kimi for streaming) etter `mesh-live-smoke.ts --tools`. AUTO-ruting bruker ikke Kimi/Hermes til verktøyløkker før de står her;
   * eksplisitte valg (`provider`, `providerPreference`) er uendret. Udefinert = leses fra `JARVIS_MESH_TOOLS_VERIFIED` (standard tom) - samme kilde i api OG worker, så bakgrunnsjobber og D-404-omkjøringen følger det samme.
   */
  meshToolsVerified?: Iterable<string>;
  /**
   * WP-H0 / JARVIS-087: eierens pause eller tilbakekall av en MODELLLEVERANDØR. Kilden leses LIVE ved hvert kall (varig og delt mellom api og worker), så en pause virker umiddelbart og uten omstart.
   * Utelatt = ingen leverandør er pauset (uendret oppførsel, f.eks. i tester). Se `ProviderPauseSource`.
   */
  providerPause?: ProviderPauseSource;
  /**
   * Klokke i millisekunder (standard `Date.now`). Finnes kun slik at tester kan styre alderen på siste kjente pausetilstand; selve aldersgrensen (`PAUSE_STATE_MAX_AGE_MS`) kan IKKE konfigureres.
   */
  now?: () => number;
  /**
   * WP-B4 (D-476): Claude-kreditten (100 USD/mnd) med tempostyring og behovsprioritering. Utelatt (standard, `JARVIS_CLAUDE_BUDGET_USD` ikke satt) = ingen av kodeveiene under er i bruk og gatewayen er identisk med main.
   * Satt: beslutningen tas FØR leverandørvalg for kall som kan ende hos Anthropic, og kan bare SNEVRE INN Anthropic (billigere modell, stengt) - aldri åpne noe sensitivitetsreglene har stengt. Se `claude-budget-enforcer.ts`.
   */
  claudeBudget?: ClaudeBudgetEnforcer;
}

/**
 * WP-H0 / JARVIS-087 (UA-11): eierens pause eller tilbakekall av en MODELLLEVERANDØR - kontrollsenterets «stopp enhver leverandør fra én flate». Implementasjonen (apps/api) leser den varige, delte
 * eier-tilstanden (`owner_control_state`) og returnerer navnene på leverandørene som IKKE skal brukes akkurat nå. Gatewayen behandler en pauset leverandør som «ikke konfigurert» i ALL ruting:
 * ingen kandidat i AUTO/LOCAL/CHEAP/..., ikke som eksplisitt eier-override (`provider`), ikke i en preferanseliste, ikke som fallback, critic eller Council-medlem. Sensitivitetsreglene røres ikke:
 * SECRET_RESTRICTED slipper fortsatt kun lokale leverandører, så en pauset LOKAL leverandør gir fail-closed for slike turer - aldri en sky-fallback.
 *
 * Fail-closed ved lesefeil: kan tilstanden ikke leses og ingen tilstrekkelig fersk lesing finnes (første kall etter oppstart, eller siste vellykkede lesing er eldre enn `PAUSE_STATE_MAX_AGE_MS`), nektes
 * kallet (`not_configured`). Har en lesing lyktes for høyst `PAUSE_STATE_MAX_AGE_MS` siden, brukes den siste kjente tilstanden (en kort databaseblipp skal ikke stanse all modellbruk) og feilen logges.
 * Gjennomgang av PR #316 (M-3): uten aldersgrensen ble en gammel «ingen er pauset»-tilstand brukt uavgrenset - og en pause satt i en ANNEN prosess (tilbakekall av en lekket nøkkel) ble da aldri sett så
 * lenge lesingen feilet.
 */
export interface ProviderPauseSource {
  pausedProviders(): Promise<ReadonlySet<string>>;
}

/**
 * Gjennomgang av PR #316 (M-3): hvor gammel siste LESTE pausetilstand kan være og fortsatt brukes når en senere lesing feiler. Målt fra da lesingen STARTET (tilstanden er minst så gammel som det).
 * Konstant og bevisst IKKE konfigurerbar (hverken via env eller valg): en grense som kan skrus opp i drift er en grense som kan skrus av. 45 s dekker en kort databaseblipp, men er så kort at et
 * tilbakekall av en lekket nøkkel aldri blir værende usett lenge fordi databasen er utilgjengelig.
 */
export const PAUSE_STATE_MAX_AGE_MS = 45_000;

/**
 * UA-1 P1A: trusted executor-grensesnitt. Gateway/modell har ALDRI direkte
 * verktøytilgang - all utførelse går via denne broen til Tool Gateway,
 * som håndhever Policy/Execution Authority/D-pipeline som før (§17).
 */
export interface ToolExecutor {
  execute(
    call: ToolCallRequest,
    ctx: { tenant_id: string; session_id?: string; task_id?: string; idempotency_key: string }
  ): Promise<ToolResultMessage>;
}

export interface ToolLoopOptions {
  tools: ToolDefinition[];
  executor: ToolExecutor;
  /** Streaming-events for hver runde (valgfritt). */
  onEvent?: StreamHandler;
  signal?: AbortSignal;
  /** Maks modellrunder (default 4) - aldri uendelig tool-loop. */
  maxRounds?: number;
  /** Del 3 (JARVIS-028): maks verktøykall utført per runde. Overskytende kall forkastes (ikke utført) - aldri en ubegrenset fan-out. */
  maxCallsPerRound?: number;
  /**
   * Gjennomgang av WP-A (D-451, bekreftet med ekte gateway): hver runde planlegges på nytt, så en runde kan betjenes av en lokal modell (f.eks. fordi skyen hadde tidsavbrudd) og den NESTE av en skymodell.
   * Verktøyresultater og -kall fra den lokale runden (som kan inneholde det lokale modeller har lov til å se, men skyen ikke) stod da i `tool_exchanges` til skyen. Med `localStickiness` blir resten av løkken lokal
   * så snart en runde er betjent av en lokal modell (`mode: "LOCAL"`, og en eventuell preferanseliste snevres inn til lokale leverandører) - skyen får aldri se noe en lokal modell har rørt. Av som standard
   * (kun chatten bruker den), så øvrige verktøyløkker er uendret.
   */
  localStickiness?: boolean;
}

/** Minimal, deterministisk JSON-Schema-validering (§25): required + ukjente felter. */
export function validateToolArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const required = (schema["required"] as string[] | undefined) ?? [];
  for (const field of required) {
    if (!(field in args)) {
      return `missing_required:${field}`;
    }
  }
  if (schema["additionalProperties"] === false) {
    const allowed = new Set(Object.keys((schema["properties"] as Record<string, unknown> | undefined) ?? {}));
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) {
        return `unknown_field:${key}`;
      }
    }
  }
  return null;
}

export interface MeshProviderStatus {
  provider: string;
  model: string;
  state: ProviderHealthState;
  success: number;
  failures: number;
  avg_latency_ms?: number;
  /** WP-H0: `true` når eieren har pauset/tilbakekalt leverandøren (siste kjente tilstand i DENNE prosessen; oppdateres ved hvert modellkall). `state` er helsen, uavhengig av pausen. */
  paused?: boolean;
}

/** WP-H0 (JARVIS-087): kontrollsenterets rike visning av én leverandør. Ingen feiltekst - kun kategori (se `ProviderHealthDetail`). */
export interface ProviderOverviewRow {
  provider: string;
  model: string;
  locality: "local" | "cloud";
  /** Gratis-tier-hostet sky (kun `gemma_hosted`): krever eksplisitt lav sensitivitet. */
  hosted_free_tier: boolean;
  /** Adapteren har nøkkel/URL (`available()`), uavhengig av en eventuell eier-pause. */
  configured: boolean;
  health: ProviderHealthDetail;
}

/**
 * Ruterens tilstand utledes av de KONFIGURERTE providerne: ingen konfigurert (eller alle UNAVAILABLE) = UNAVAILABLE, noen DEGRADED/RATE_LIMITED/UNAVAILABLE = DEGRADED,
 * ellers HEALTHY. Ren funksjon (testbar).
 */
export function meshRouterState(providers: Array<{ configured: boolean; state: ProviderHealthState }>): "HEALTHY" | "DEGRADED" | "UNAVAILABLE" {
  const usable = providers.filter((p) => p.configured && p.state !== "NOT_CONFIGURED");
  if (usable.length === 0 || usable.every((p) => p.state === "UNAVAILABLE")) return "UNAVAILABLE";
  return usable.some((p) => p.state === "DEGRADED" || p.state === "RATE_LIMITED" || p.state === "UNAVAILABLE") ? "DEGRADED" : "HEALTHY";
}

/** WP-D4: detaljert, hemmelighetsfri leverandørstatus (kun tall, tilstand og feilklasse) til `executive.get_ai_mesh_status`. Runtime i DENNE prosessen - nullstilles ved omstart. */
export interface MeshProviderDetail extends ProviderHealthDetails {
  provider: string;
  model: string;
  /** Kan brukes NÅ: nøkkel/URL er satt (presence - aldri verdien) OG eieren har ikke pauset leverandøren (WP-H0). */
  configured: boolean;
  /** WP-H0: eieren har pauset/tilbakekalt leverandøren (siste kjente tilstand i denne prosessen). Da er `configured` false selv om nøkkel/URL er satt; `state` er likevel den faktiske helsen. */
  paused?: boolean;
  locality: "local" | "cloud";
  capabilities: ModelCapability[];
  hosted_free_tier: boolean;
  /** M3: capabilities som er PÅSTÅTT men ikke live-verifisert og som AUTO-ruting derfor ikke bruker på tillit (tom = alt påstått brukes). Fjernes ved `JARVIS_MESH_TOOLS_VERIFIED=<leverandør>`. */
  auto_unverified?: ModelCapability[];
}

export interface MeshStatus {
  providers: MeshProviderStatus[];
  /** D-395 (JARVIS-078): beregnet fra faktisk providerhelse (tidligere en hardkodet «HEALTHY»). */
  router: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  /** VERIFIED = cross-provider fallback har faktisk skjedd i denne runtime (§25). */
  fallback: "VERIFIED" | "READY" | "LOGIC_ONLY";
  critic: "VERIFIED" | "READY_SELECTIVE";
}

const CRITIC_SYSTEM =
  "Du er en kritisk kvalitetssjekker. Vurder svaret mot oppgaven: pek på faktiske feil, hull eller risiko. Svar kompakt: CONFIDENCE: <0-100> etterfulgt av punktliste med funn (eller 'ingen funn').";

/**
 * Model Gateway (CANONICAL_SPEC §7 + UA-1 AI Mesh): eneste vei til modell-
 * leverandører. Budsjett håndheves FØR kallet; router velger provider
 * deterministisk (registry+health); fallback er klassifisert, aldri blind;
 * kostnad/latency/purpose skrives til cost_events; alt spores i trace-sinken.
 */
/**
 * D-441: leverer ett stream-event som gatewayen selv (ikke adapteren) står for - frigivelse av tilbakeholdte `usage`/`finish` og avspilling av et retry-svar.
 * En konsument som kaster her er konsumentens feil, ikke leverandørens: kallet er allerede gjennomført og betalt, så det må ALDRI klassifiseres som en
 * leverandørfeil (helsestraff, ekstra 0-øre-rad, failover til en ny betalt kandidat). Logges og svelges.
 */
function deliverStreamEvent(onEvent: StreamHandler, event: StreamEvent): void {
  try {
    onEvent(event);
  } catch (err) {
    console.error(JSON.stringify({ msg: "stream_consumer_error", event_type: event.type, error: (err as Error).message.slice(0, 120) }));
  }
}

/** D-441: spiller et komplett (ikke-streamet) resultat av som normaliserte stream-events - brukt når et retry-svar erstatter et tomt/avkortet stream-svar. */
function replayResultAsStreamEvents(onEvent: StreamHandler, r: ModelResult): void {
  if (r.text.length > 0) deliverStreamEvent(onEvent, { type: "text_delta", text: r.text });
  for (const call of r.tool_calls ?? []) {
    deliverStreamEvent(onEvent, { type: "tool_call_start", tool_call_id: call.tool_call_id, tool_name: call.tool_name });
    deliverStreamEvent(onEvent, { type: "tool_call_complete", call });
  }
  deliverStreamEvent(onEvent, { type: "usage", usage: r.usage });
  deliverStreamEvent(onEvent, { type: "finish", finish_reason: r.finish_reason ?? "stop" });
}

/** WP-H0: logger kun feilens klasse (og SQLSTATE), aldri meldingen - en tilkoblingsfeil kan inneholde verter eller tilkoblingsdetaljer. */
function pauseReadFailure(err: unknown): { error: string; code?: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return { error: err instanceof Error ? err.name : "unknown", ...(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? { code } : {}) };
}

/** WP-B4 (L2): hva gatewayen vet om et leverandørkall som feilet etter at det var sendt (se `recordFailedAttempt`). */
interface FailedCallBilling {
  pacing: PacingTicket | undefined;
  request: ModelRequest;
  model: string;
  generated_chars: number;
}

/** WP-B4 (L2): feilklassene der Anthropic kan ha fakturert det som var gjort (avbrutt/utløpt/brutt midt i/ugyldig svar etter generering). Andre feil (auth, kvote, dårlig forespørsel, serverfeil uten tekst) faktureres ikke. */
const BILLABLE_FAILURE_KINDS: ReadonlySet<string> = new Set(["cancelled", "timeout", "stream_interrupted", "invalid_tool_call", "invalid_response"]);

/** Gatewayens syn på én leverandør i denne prosessen (ruteren ser kun `configured`/`paused`/`budget_blocked`/`model`). */
type RuntimeRow = { configured: boolean; available: boolean; paused: boolean; model: string; budget_blocked?: boolean };

export class ModelGateway {
  /**
   * WP-B4 (M1): hva gatewayens EGEN verktøyløkke (`completeWithTools`) vet om tidligere runder, nøklet på selve `CompleteInput`-objektet løkka lager for hver runde. En svakt referert, privat tabell: ingen kaller
   * (og ingen forespørsel) kan legge noe inn i den, så en «fortsettelse» kan aldri påstås utenfra. Tom uten Claude-kreditten.
   */
  private readonly pacingRounds = new WeakMap<CompleteInput, PacingRoundContext>();
  /** WP-B4 (M1): billetten hver leverandørrunde ble avgjort med, nøklet på resultatet (så løkka kan bære den til neste runde). */
  private readonly resultTickets = new WeakMap<ModelResult, PacingTicket>();
  private readonly guard: BudgetGuard;
  private readonly callTimestamps = new Map<string, number[]>();
  private readonly registry: CapabilityRegistry;
  private readonly pricing: PricingTable;
  private readonly advisor: RoutingAdvisor;
  private readonly catalog: readonly CatalogModel[];
  private readonly advisorMode: "off" | "shadow" | "active";
  readonly health = new ProviderHealthTracker();
  private readonly router: AiRouter;
  private readonly toolsVerified: ReadonlySet<string>;
  private readonly byName = new Map<string, ModelProviderAdapter>();
  /** Runtime-evidens for /status (§25): satt først når hendelsen faktisk har skjedd. */
  private crossProviderFallbackSeen = false;
  private criticRunSeen = false;
  /** WP-D4: antall leverandørkall som pågår akkurat nå i denne prosessen (til å skille parallell delegering fra enkeltkall i latensmålingen). */
  private inFlightCalls = 0;
  /**
   * WP-H0: siste LESTE eier-pause (se `ProviderPauseSource`). Oppdateres ved hvert modellkall; synkrone lesere (`listConfiguredProviders`, `meshStatus`) bruker den - de er kun visning/rådgivende,
   * håndhevelsen skjer i `livePauses()` ved hvert kall.
   */
  private pausedSnapshot: ReadonlySet<string> = new Set();
  /** Gjennomgang av PR #316 (L-6): hver lesing får et løpenummer FØR den starter; snapshotet bærer nummeret til lesingen det kommer fra, og en eldre lesing overskriver aldri en nyere. */
  private pauseReadSeq = 0;
  private pauseSnapshotSeq = 0;
  /** Gjennomgang av PR #316 (M-3): når lesingen snapshotet kommer fra STARTET (ms), eller null når ingen lesing har lyktes ennå. Aldersgrensen er `PAUSE_STATE_MAX_AGE_MS`. */
  private pauseSnapshotReadAt: number | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: GatewayOptions) {
    this.now = opts.now ?? Date.now;
    this.guard = new BudgetGuard(opts.pool, opts.budget ?? DEFAULT_BUDGET);
    this.registry = opts.registry ?? new CapabilityRegistry();
    this.pricing = opts.pricing ?? DEFAULT_PRICING;
    // JARVIS-006: ingen registrert modellprofil får falle til `default_rate`.
    assertExplicitPricing(this.pricing, this.registry.list());
    // M3 (gjennomgang av PR #315): leverandørene eieren har erklært live-verifisert for verktøykall/streaming (`JARVIS_MESH_TOOLS_VERIFIED`). Standard tom: AUTO-ruting velger ikke Kimi/Hermes til verktøyløkker.
    this.toolsVerified = new Set(opts.meshToolsVerified ?? meshToolsVerifiedFromEnv());
    this.router = new AiRouter(this.registry, this.health, this.toolsVerified);
    this.advisor = opts.advisor ?? new HeuristicRoutingAdvisor();
    this.catalog = opts.catalog ?? modelCatalogFromEnv();
    const envMode = process.env["JARVIS_MODEL_ADVISOR"]?.trim().toLowerCase();
    this.advisorMode = opts.advisorMode ?? (envMode === "off" || envMode === "active" || envMode === "shadow" ? envMode : "shadow");
    for (const p of opts.providers) {
      this.byName.set(p.name, p);
    }
  }

  /** D-106: eksponerer registryet (read-only) for AI Council/Collaboration sin deterministiske rolletildeling (§35 - Jarvis-kode, ikke modell, velger). */
  get capabilityRegistry(): CapabilityRegistry {
    return this.registry;
  }

  /**
   * WP-B4 (D-476): `true` når gatewayen er konstruert med Claude-kreditten på. Kallere som vil merke kall med opphav (`CompleteInput.budget_origin`) gjør det KUN når dette er sant - uten flagget er innputtet byte-identisk med main.
   */
  get claudeBudgetActive(): boolean {
    return this.opts.claudeBudget !== undefined;
  }

  /** Remediering del 1: ALLE konstruerte adapternavn (uansett `available()`), brukt av oppstartens eksplisitt-pris-sjekk. */
  listProviderNames(): string[] {
    return this.opts.providers.map((p) => p.name);
  }

  /** D-106: providernavn med `available()===true` akkurat nå - AI Council/Collaboration bruker denne til å avgjøre kandidater/`unavailable_members` FØR kall gjøres. */
  listConfiguredProviders(): string[] {
    return this.opts.providers.filter((p) => p.available() && !this.pausedSnapshot.has(p.name)).map((p) => p.name);
  }

  /**
   * `configured` = kan brukes NÅ (nøkkel/URL satt OG ikke pauset av eieren); `available` = adapteren har nøkkel/URL uavhengig av pausen (helse og visning); `paused` = eierens pause.
   * Ruteren ser kun `configured`/`paused`/`model`.
   */
  private providerRuntimes(paused: ReadonlySet<string> = this.pausedSnapshot): Map<string, RuntimeRow> {
    const map = new Map<string, RuntimeRow>();
    for (const p of this.opts.providers) {
      const available = p.available();
      const isPaused = paused.has(p.name);
      map.set(p.name, { configured: available && !isPaused, available, paused: isPaused, model: p.model ?? "ukjent" });
    }
    return map;
  }

  /**
   * WP-H0: leser eierens pause LIVE (se `ProviderPauseSource`). Uten kilde: ingen er pauset. Kalles i starten av hvert modellkall, så pausen virker fra neste kall - også mellom rundene i en verktøyløkke -
   * uten omstart.
   *
   * Lesefeil (gjennomgang av PR #316, M-3): har en lesing lyktes for høyst `PAUSE_STATE_MAX_AGE_MS` siden, brukes siste kjente tilstand; ellers (aldri lest, eller tilstanden er for gammel, eller klokken har gått
   * bakover) er svaret det samme som ved første lesefeil - kallet nektes (`not_configured`, fail-closed).
   *
   * Samtidige lesinger (L-6): lesingen får et løpenummer før den starter, og et snapshot fra en ELDRE lesing som kommer tilbake sent overskriver aldri et nyere. Kallet bruker alltid det nyeste snapshotet.
   */
  private async livePauses(): Promise<ReadonlySet<string>> {
    const source = this.opts.providerPause;
    if (source === undefined) return this.pausedSnapshot;
    const seq = ++this.pauseReadSeq;
    const startedAt = this.now();
    try {
      const paused = await source.pausedProviders();
      if (seq > this.pauseSnapshotSeq) {
        this.pausedSnapshot = paused;
        this.pauseSnapshotSeq = seq;
        this.pauseSnapshotReadAt = startedAt;
      }
      return this.pausedSnapshot;
    } catch (err) {
      const ageMs = this.pauseSnapshotReadAt === null ? null : this.now() - this.pauseSnapshotReadAt;
      if (ageMs !== null && ageMs >= 0 && ageMs <= PAUSE_STATE_MAX_AGE_MS) {
        console.error(JSON.stringify({ msg: "provider_pause_read_failed_using_last_known", age_ms: ageMs, ...pauseReadFailure(err) }));
        return this.pausedSnapshot;
      }
      console.error(JSON.stringify({
        msg: "provider_pause_read_failed_fail_closed", reason: ageMs === null ? "no_state_yet" : "last_known_stale", ...(ageMs !== null ? { age_ms: ageMs } : {}), ...pauseReadFailure(err)
      }));
      throw new ProviderError("router", "not_configured", "provider_pause_state_unavailable");
    }
  }

  /** WP-H0: en eksplisitt `provider` (eier-override, verktøyrute, Council-medlem) som er pauset feiler som `not_configured` for DEN leverandøren - så eksisterende «skyen er nede → lokal modell»-fallback (D-431/D-449) gjelder også en pause. */
  private assertNotPaused(provider: string | undefined, paused: ReadonlySet<string>): void {
    if (provider !== undefined && paused.has(provider)) {
      throw new ProviderError(provider, "not_configured", `${provider}_paused_by_owner`);
    }
  }

  /**
   * D-106 Council reliability: SENTRALISERT, validert anvendelse av ETT
   * eksplisitt `CompleteInput.timeoutMs`-overstyring - eneste sted dette
   * feltet kan nå en adapter (`ModelRequest.timeoutMs` fylles KUN inn her,
   * aldri satt direkte av en kaller). `undefined` (normaltilfellet) gir
   * `input` tilbake UENDRET - ingen ny objektallokering, ingen atferdsendring
   * for ordinære kall.
   */
  private applyTimeoutOverride(input: CompleteInput): CompleteInput {
    const resolved = resolveTimeoutMs(input.timeoutMs);
    if (resolved === undefined) return input;
    return { ...input, request: { ...input.request, timeoutMs: resolved } };
  }

  /**
   * WP-G3 (D-465): BEGRENSEDE medier (kamerabilder, `ContentPart.restricted`) er SECRET_RESTRICTED og lokal-kun UANSETT hva kalleren oppga. Strammer KUN inn (sensitivitet opp til
   * SECRET_RESTRICTED, betalte modeller av, ruting `LOCAL` med mindre en eksplisitt leverandør er valgt - og også da stenger ruterens sensitivitetsport alle skyleverandører). Uten en
   * slik bildedel returneres NØYAKTIG samme objekt (ingen atferdsendring for noe eksisterende kall). Se også utførelseslåsen i `executePlan`, som gjelder uavhengig av ruteren.
   */
  private lockRestrictedMedia(input: CompleteInput): CompleteInput {
    if (!hasRestrictedMedia(input.request)) return input;
    return { ...input, sensitivity: "SECRET_RESTRICTED", paid_models_allowed: false, ...(input.provider === undefined ? { mode: "LOCAL" as const } : {}) };
  }


  /**
   * D-399 (modellrådgiver): velger MODELL innenfor ruterens primære leverandør. Leverandørvalget (sensitivitet, betalte modeller, helse, capabilities) er allerede gjort av ruteren og
   * røres ikke; her velges billigste valgbare katalogmodell som holder for oppgaven. `shadow` logger kun hva som VILLE skjedd. Feil i rådgivningen faller alltid tilbake til ruterens plan.
   */
  private async applyModelAdvice(input: CompleteInput, plan: RoutePlan, budgetLevel: string, traceId: string): Promise<RoutePlan> {
    if (this.advisorMode === "off") return plan;
    const primary = plan.candidates[0];
    if (!primary) return plan;
    try {
      const task = describeTask(input.request, input.purpose);
      const advice = await this.advisor.advise(task);
      const maxTier: ModelTier | undefined = budgetLevel === "warn" ? "standard" : undefined;
      const selection = selectModelForTier(advice.tier, {
        eligibleProviders: [primary.provider],
        providerDefaultModel: (p) => this.byName.get(p)?.model,
        pricing: this.pricing,
        catalog: this.catalog,
        ...(maxTier !== undefined ? { maxTier } : {})
      });
      const wouldChange = selection !== null && selection.model !== primary.model;
      await this.opts.trace.record({
        trace_id: traceId, kind: "model_advice", name: `advice_${this.advisorMode}`, tenant_id: input.tenant_id,
        ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
        ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
        at: new Date().toISOString(), duration_ms: 0,
        metadata: {
          mode: this.advisorMode, advisor: advice.advisor, advised_tier: advice.tier, confidence: advice.confidence, reason: advice.reason,
          task: { kind: task.kind, complexity: task.complexity, size_chars: task.size_chars, needs_tools: task.needs_tools, tool_rounds: task.tool_rounds },
          router_provider: primary.provider, router_model: primary.model,
          advised_model: selection?.model ?? null, downgraded: selection?.downgraded ?? false, would_change: wouldChange,
          budget_level: budgetLevel, ...(maxTier !== undefined ? { tier_cap: maxTier } : {})
        }
      });
      if (this.advisorMode === "active" && selection && wouldChange) {
        return { ...plan, candidates: [{ provider: selection.provider, model: selection.model }, ...plan.candidates.slice(1)] };
      }
    } catch (err) {
      console.warn(JSON.stringify({ msg: "model_advice_failed", error: (err as Error).message.slice(0, 120) }));
    }
    return plan;
  }

  /** D-399: per-kall modell: kun når kandidatens modell avviker fra adapterens standard (ellers uendret request). */
  private requestForCandidate(request: ModelRequest, candidateModel: string, adapterModel: string | undefined): ModelRequest {
    return candidateModel !== "ukjent" && adapterModel !== undefined && candidateModel !== adapterModel ? { ...request, model: candidateModel } : request;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // WP-B4 (D-476): Claude-kreditten. ALT under er død kode uten `GatewayOptions.claudeBudget` (`pacing` er da alltid `undefined`).
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Kan dette kallet ende hos Anthropic? Konservativt: tempostyringen (og lesingen av forbruket) hoppes KUN over når det er KLART at kallet ikke kan nå Anthropic - leverandøren er ikke konfigurert/pauset, betalte modeller er av,
   * innholdet er SECRET_RESTRICTED, en annen leverandør er valgt eksplisitt, en preferanseliste ikke har Anthropic, eller modusen er lokal. Tvil = evaluer. Sensitivitetsreglene i ruteren er uendret og gjelder uansett.
   */
  private mayReachClaude(input: CompleteInput, paused: ReadonlySet<string>): boolean {
    const adapter = this.byName.get(CLAUDE_BUDGET_PROVIDER);
    if (adapter === undefined || !adapter.available() || paused.has(CLAUDE_BUDGET_PROVIDER)) return false;
    if (input.paid_models_allowed === false || input.sensitivity === "SECRET_RESTRICTED") return false;
    if (input.critic === true) return true; // criticen velger sin egen leverandør
    if (input.provider !== undefined) return input.provider === CLAUDE_BUDGET_PROVIDER;
    if (input.mode === "LOCAL") return false;
    if (input.providerPreference !== undefined && input.providerPreference.length > 0) return input.providerPreference.includes(CLAUDE_BUDGET_PROVIDER);
    return true;
  }

  /** Beslutningen for dette kallet, tatt FØR leverandørvalg. `undefined` = Claude-kreditten er av, eller kallet kan ikke nå Anthropic. Kaster aldri (se `ClaudeBudgetEnforcer.begin`). */
  private async beginPacing(input: CompleteInput, paused: ReadonlySet<string>, traceId: string, started: number, round?: PacingRoundContext): Promise<PacingTicket | undefined> {
    const enforcer = this.opts.claudeBudget;
    if (enforcer === undefined || !this.mayReachClaude(input, paused)) return undefined;
    const defaultModel = this.byName.get(CLAUDE_BUDGET_PROVIDER)?.model;
    return enforcer.begin({
      tenant_id: input.tenant_id,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.budget_origin !== undefined ? { budget_origin: input.budget_origin } : {}),
      request: input.request, pricing: this.pricing, catalog: this.catalog,
      ...(defaultModel !== undefined ? { provider_default_model: defaultModel } : {}),
      ...(round !== undefined ? { round } : {}),
      trace_id: traceId, started
    });
  }

  /** Stenger Anthropic for ruteren (som en pause, men med egen begrunnelse). Aldri en måte å åpne noe på. */
  private closeClaudeRuntime(runtimes: Map<string, RuntimeRow>): void {
    const rt = runtimes.get(CLAUDE_BUDGET_PROVIDER);
    if (rt !== undefined) runtimes.set(CLAUDE_BUDGET_PROVIDER, { ...rt, configured: false, budget_blocked: true });
  }

  /**
   * `router.plan` med Claude-kreditten som innsnevring. Uten billett, eller når Anthropic ikke er stengt: nøyaktig `router.plan(routeInput, providerRuntimes(paused))` som før.
   * Stengt: et EKSPLISITT valg av Anthropic (eier-override, AI-råd-medlem) får aldri en stille omruting (§10) - kallet avvises med en tydelig feil.
   * ELLERS (L1, Q-67: «hard stopp av Anthropic med lokal fallback»): et kall UTEN eksplisitt leverandør eller preferanseliste planlegges `mode: LOCAL` - kun lokale modeller. Fallbacken er aldri en annen BETALT skyleverandør
   * (openai/gemini ville brukt eierens penger i stedet for den gratis kreditten, og var ikke det Q-67 ba om). Sensitivitets- og betalt-modell-reglene i ruteren gjelder uendret oppå dette (LOCAL kan bare snevre inn).
   * Et eksplisitt valg beholder sin egen semantikk: en preferanseliste (spesialist-delegering: anthropic → openai → gemini) går videre til neste medlem i sin egen liste, men Anthropic står stengt.
   */
  private planRoute(routeInput: RouteInput, paused: ReadonlySet<string>, input: CompleteInput, pacing: PacingTicket | undefined): RoutePlan {
    if (pacing === undefined || pacing.constraint !== "closed") return this.router.plan(routeInput, this.providerRuntimes(paused));
    if (input.provider === CLAUDE_BUDGET_PROVIDER) throw pacing.blockedError();
    const closed = this.providerRuntimes(paused);
    this.closeClaudeRuntime(closed);
    const explicitChoice = input.provider !== undefined || (input.providerPreference?.length ?? 0) > 0;
    try {
      return this.router.plan(explicitChoice ? routeInput : { ...routeInput, mode: "LOCAL" }, closed);
    } catch (err) {
      throw this.explainClosedRoute(err, routeInput, closed, paused, input, pacing);
    }
  }

  /**
   * Ruteren fant ingen kandidat uten Anthropic. Hadde kallet gått MED Anthropic åpen, er det kreditten som stoppet det: da får eieren en tydelig norsk feil (`ClaudeBudgetBlockedError`) i stedet for en teknisk rutefeil.
   * Unntak: en hard preferanseliste beholder rutefeilen (`provider_preference_exhausted`) - kallerne (chatten, jobbene) har allerede en lokal fallback som trigges av nettopp den, og som igjen ender i den tydelige
   * feilen hvis ingen lokal modell finnes. Feiler planen uansett (kallet krever noe ingen konfigurert modell har, sensitivitet, ingen lokal modell for SECRET_RESTRICTED), er den ærlige årsaken en annen: da gis feilen
   * ruteren ville gitt for det OPPRINNELIGE kallet med Anthropic stengt (den nevner både den virkelige årsaken og «stengt av Claude-kreditten») - ikke «lokal modell mangler» fra lokal-planen.
   */
  private explainClosedRoute(err: unknown, routeInput: RouteInput, closedRuntimes: Map<string, RuntimeRow>, paused: ReadonlySet<string>, input: CompleteInput, pacing: PacingTicket): unknown {
    if (!(err instanceof NoEligibleProviderError || err instanceof LocalModelUnavailableError || err instanceof PaidModelsDisabledError)) return err;
    try {
      this.router.plan(routeInput, this.providerRuntimes(paused));
    } catch {
      try {
        this.router.plan(routeInput, closedRuntimes);
      } catch (honest) {
        return honest;
      }
      return err;
    }
    const preferenceList = input.provider === undefined && (input.providerPreference?.length ?? 0) > 0;
    // L7: en hard preferanseliste gir rutefeilen kallerne svarer på med en ny kjøring (samtalemotorens D-354-fallback): den kjøringen er SAMME avviste kall og skal ikke telles en gang til.
    if (preferenceList) pacing.expectRetry();
    return preferenceList ? err : pacing.blockedError();
  }

  /** Nedgradering: Anthropic-kandidater bruker den billigere modellen (siste ord - også over modellrådgiverens valg og over en eksplisitt `request.model`). */
  private requestWithPacingModel(request: ModelRequest, provider: string, pacing: PacingTicket | undefined): ModelRequest {
    return pacing?.downgrade_model !== undefined && provider === CLAUDE_BUDGET_PROVIDER ? { ...request, model: pacing.downgrade_model } : request;
  }

  async complete(rawInput: CompleteInput): Promise<ModelResult> {
    return this.withPriority(rawInput.purpose, () => this.completeInner(rawInput));
  }

  private async completeInner(rawInput: CompleteInput): Promise<ModelResult> {
    const input = this.lockRestrictedMedia(this.applyTimeoutOverride(rawInput));
    const started = Date.now();
    const traceId = `trace-${randomUUID()}`;

    this.enforceRateLimit(input.tenant_id);

    const budget = await this.guard.evaluate(input.tenant_id);
    if (budget.level === "hard_blocked" || budget.level === "needs_approval") {
      await this.opts.trace.record({
        trace_id: traceId,
        kind: "budget",
        name: `budget_${budget.level}`,
        tenant_id: input.tenant_id,
        ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
        ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
        at: new Date().toISOString(),
        duration_ms: Date.now() - started,
        metadata: { spent_ore: budget.spent_ore }
      });
      throw new BudgetExceededError(budget.level, budget.spent_ore);
    }

    const paused = await this.livePauses();
    this.assertNotPaused(input.provider, paused);
    // WP-B4 (D-476): Claude-kreditten tar sin beslutning FØR leverandørvalg. `undefined` (av, eller kallet kan ikke nå Anthropic) = alt under er som før.
    const pacing = await this.beginPacing(input, paused, traceId, started, this.pacingRounds.get(rawInput));
    try {
      const routeInput: RouteInput = {
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.required_capabilities !== undefined
          ? { required_capabilities: input.required_capabilities }
          : {}),
        ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
        ...(input.paid_models_allowed !== undefined
          ? { paid_models_allowed: input.paid_models_allowed }
          : {}),
        ...(input.providerPreference !== undefined
          ? { providerPreference: input.providerPreference }
          : {}),
        ...(input.preferenceFailover !== undefined ? { preferenceFailover: input.preferenceFailover } : {}),
        ...(input.excludeProviders !== undefined ? { excludeProviders: input.excludeProviders } : {}),
        needs_structured: Boolean(input.request.structured_schema)
      };
      const routerPlan = this.planRoute(routeInput, paused, input, pacing);
      const plan = await this.applyModelAdvice(input, routerPlan, budget.level, traceId);

      const result = await this.executePlan(input, plan, traceId, started, budget.level, false, undefined, undefined, pacing);

      if (input.critic || plan.mode === "CRITIC") {
        await this.runCritic(input, result, traceId, pacing);
      }
      return result;
    } finally {
      pacing?.release();
    }
  }

  /**
   * Deterministisk fallback (§12): klassifiserte feil, aldri blind retry-spam.
   * Streaming (§10-§11): retry/fallback er mulig så lenge INGEN synlig output er levert til konsumenten; etter output-start er policyen konservativ -
   * stream markeres interrupted, aldri skjult provider-bytte. D-441: `usage`/`finish` holdes tilbake til utfallet er klassifisert, så et tomt eller
   * avkortet stream-svar følger de samme reglene som ikke-streaming (ett begrenset retry ved avkorting, neste kandidat, ellers en ærlig feil).
   */
  private async executePlan(
    input: CompleteInput,
    plan: RoutePlan,
    traceId: string,
    started: number,
    budgetLevel: string,
    isCritic: boolean,
    requestOverride?: ModelRequest,
    streamOpts?: { onEvent: StreamHandler; signal?: AbortSignal },
    /** WP-B4: Claude-kreditten sin billett for dette kallet (nedgradering av modellen; metadata). `undefined` = uendret. */
    pacing?: PacingTicket
  ): Promise<ModelResult> {
    const baseRequest = requestOverride ?? input.request;
    const failedProviders: string[] = [];
    let lastError: Error | null = null;
    // WP-D4 (M2): preferansemedlemmer som ble hoppet over fordi helsen er UNAVAILABLE er reservebruk som aldri ble et forsøk - flaten skal likevel få vite det.
    for (const name of plan.unavailable ?? []) this.notifyAttemptFailed(input, name, "unavailable", isCritic);
    // D-441: retry-kallet (`adapter.complete`) tar ikke imot et avbruddssignal, så en avbrutt tur (barge-in, lukket SSE) må sjekkes eksplisitt FØR et nytt betalt kall
    // starter og FØR et svar spilles av - ellers lever en «zombie»-generering videre og et avbrutt svar lagres som et vanlig svar (D-30: ingen zombie-generering).
    const throwIfCancelled = (adapterName: string): void => {
      if (streamOpts?.signal?.aborted) throw new ProviderError(adapterName, "cancelled", `${adapterName}_cancelled`);
    };

    // WP-G3 (D-465): utførelseslås for kamerabilder - sjekket her, rett før ethvert adapterkall, uavhengig av hva ruteren/rådgiveren/fallbacken ga.
    const restrictedMedia = hasRestrictedMedia(baseRequest);
    for (const candidate of plan.candidates) {
      const adapter = this.byName.get(candidate.provider);
      if (!adapter || !adapter.available() || this.pausedSnapshot.has(candidate.provider)) {
        continue;
      }
      if (restrictedMedia && this.registry.profileOrGeneric(adapter.name, adapter.model ?? candidate.model).locality !== "local") {
        // Ukjent leverandør regnes som sky (`profileOrGeneric`: fail-closed). Aldri kalt; ingen innhold i loggen.
        console.error(JSON.stringify({ msg: "restricted_media_blocked", provider: adapter.name }));
        lastError = new ProviderError(adapter.name, "bad_request", `${adapter.name}_restricted_media_blocked`);
        this.notifyAttemptFailed(input, adapter.name, "restricted_media_blocked", isCritic);
        failedProviders.push(candidate.provider);
        continue;
      }
      // D-399: per-kall modell for DENNE kandidaten (kun når rådgiveren valgte en annen enn adapterens standard).
      const request = this.requestWithPacingModel(this.requestForCandidate(baseRequest, candidate.model, adapter.model), candidate.provider, pacing);
      if (failedProviders.length > 0 && streamOpts) {
        throwIfCancelled(adapter.name); // ingen `fallback`-event og ingen ny kandidat etter at brukeren har avbrutt
        streamOpts.onEvent({
          type: "fallback",
          from: failedProviders[failedProviders.length - 1] as string,
          to: adapter.name,
          reason: (lastError as ProviderError | null)?.kind ?? "unknown"
        });
      }
      const maxTries = 2; // 1 + maks én retry for transient/invalid_response på samme provider
      for (let attempt = 1; attempt <= maxTries; attempt++) {
        const attemptStart = Date.now();
        // WP-D4: startet dette kallet mens et annet leverandørkall pågikk (council/samarbeid kjører medlemmene parallelt)? Brukes kun til latensmålingen per leverandør (`ProviderHealthTracker.details`).
        const concurrent = this.inFlightCalls > 0;
        this.inFlightCalls += 1;
        let outputStarted = false;
        // WP-B4 (L2): hva et avbrutt/feilet Anthropic-kall kan ha kostet. `callActive` = leverandørkallet er sendt og ikke ferdig (en avbrytelse FØR kallet eller etter at det ga svar koster ingenting nytt);
        // `generatedChars` = tegnene som er strømmet til konsumenten så langt (tekst og verktøyargumenter).
        let callActive = false;
        let generatedChars = 0;
        const billing = (billedRequest: ModelRequest): FailedCallBilling | undefined =>
          callActive && this.opts.claudeBudget !== undefined ? { pacing, request: billedRequest, model: billedRequest.model ?? adapter.model ?? candidate.model, generated_chars: generatedChars } : undefined;
        // D-441 (JARVIS-038): `usage`/`finish` holdes tilbake til utfallet er klassifisert. Leveres de FØR (som tidligere), er konsumenten allerede «ferdig» når et tomt
        // eller avkortet resultat avsløres, og vi kan verken prøve neste kandidat eller feile ærlig - da ble et tomt svar returnert som suksess.
        const heldTerminalEvents: StreamEvent[] = [];
        let visibleOutputStarted = false;
        try {
          let result: ModelResult;
          if (streamOpts) {
            // D-30 HOST BLOCKER §1/§2: valgfri, kostnadsfri diagnostikk for å avgjøre
            // OM/NÅR provider-adapteren faktisk emitterer text_delta live (spørsmål A/B
            // i host-ordren). Kun type/provider/timing - ALDRI event-innhold (aldri
            // secrets/prompt/svar-tekst) - og kun aktiv når eksplisitt slått på.
            const streamDebug = process.env["JARVIS_STREAM_DEBUG"] === "true";
            const guardedOnEvent: StreamHandler = (event) => {
              // WP-B4 (L2): kun med Claude-kreditten på (uten den er denne funksjonen uendret), og aldri en feil fra en uventet hendelsesform
              if (this.opts.claudeBudget !== undefined) {
                if (event.type === "text_delta" && typeof event.text === "string") generatedChars += event.text.length;
                else if (event.type === "tool_call_delta" && typeof event.arguments_delta === "string") generatedChars += event.arguments_delta.length;
              }
              if (event.type === "text_delta" || event.type === "tool_call_start") {
                outputStarted = true;
                if (event.type === "tool_call_start" || event.text.trim().length > 0) visibleOutputStarted = true;
              }
              if (streamDebug) {
                console.error(JSON.stringify({
                  msg: "stream_debug_gateway", provider: adapter.name, event_type: event.type,
                  at_ms: Date.now() - attemptStart
                }));
              }
              if (event.type === "usage" || event.type === "finish") {
                heldTerminalEvents.push(event);
                return;
              }
              streamOpts.onEvent(event);
            };
            callActive = true;
            if (adapter.stream) {
              result = await adapter.stream(request, guardedOnEvent, streamOpts.signal);
            } else {
              // Adapter uten native streaming: normalisert enkelt-delta (capability-routing
              // skal normalt hindre dette; brukes kun når streaming ikke er påkrevd cap).
              result = await adapter.complete(request, (token) => guardedOnEvent({ type: "text_delta", text: token }));
              guardedOnEvent({ type: "usage", usage: result.usage });
              guardedOnEvent({ type: "finish", finish_reason: result.finish_reason ?? "stop" });
            }
            callActive = false;
          } else {
            callActive = true;
            result = await adapter.complete(request, isCritic ? undefined : input.onToken);
            callActive = false;
          }
          const latency = result.latency_ms ?? Date.now() - attemptStart;
          // D-106 PR #53: transport lyktes (ingen kastet feil) - health reflekterer
          // NÅBARHET, ikke innholdskvalitet (§3/§7 - dette gjelder uansett utfall under).
          this.health.recordSuccess(adapter.name, latency, concurrent);
          if (failedProviders.some((p) => p !== adapter.name)) {
            this.crossProviderFallbackSeen = true;
          }
          result.metadata = {
            ...result.metadata,
            router: {
              mode: plan.mode,
              reason: plan.reason,
              ...(failedProviders.length > 0 ? { fallback_from: failedProviders } : {})
            }
          };
          // WP-B4: kun kategorier (aldri innhold) - brukes av flatene til merknaden «Claude-kreditten: ...» når svaret kom fra en annen modell enn planlagt.
          if (pacing !== undefined) {
            result.metadata = { ...result.metadata, claude_budget: pacing.resultMetadata() };
            this.resultTickets.set(result, pacing);
          }
          // L10 (gjennomgang av PR #315): adapteren har nullet ugyldige tokentall (aldri en streng/NaN inn i kostformelen) og merket svaret - kostnaden er UKJENT, ikke gratis. Kun kategorier logges, aldri verdiene.
          const usageProblems = result.metadata["usage_problems"];
          if (Array.isArray(usageProblems) && usageProblems.length > 0) {
            console.error(JSON.stringify({ msg: "provider_usage_invalid", provider: adapter.name, problems: usageProblems.filter((p): p is string => typeof p === "string").slice(0, 6) }));
          }
          const outcome = classifyCompletionOutcome(result);
          // Brukbart (eller synlig output allerede levert): slipp ut de tilbakeholdte `usage`/`finish` nå, FØR den (tregere) DB-skrivingen under.
          if (streamOpts && (outcome === "USABLE_SUCCESS" || visibleOutputStarted)) {
            for (const held of heldTerminalEvents.splice(0)) deliverStreamEvent(streamOpts.onEvent, held);
          }
          await this.recordAttemptResult(input, result, outcome, {
            traceId,
            started,
            budgetLevel,
            isCritic,
            adapterName: adapter.name,
            latency,
            ...(streamOpts !== undefined ? { streamOpts } : {}),
            failedProviders,
            plan,
            ...(pacing !== undefined ? { pacing } : {})
          });

          if (outcome === "USABLE_SUCCESS") {
            return result;
          }

          if (streamOpts && visibleOutputStarted) {
            // Synlig tekst (utover blanke tegn) nådde allerede konsumenten, men resultatet er likevel ikke brukbart (ekstremt sjeldent). Et nytt forsøk ville gitt en
            // forvirrende dobbel sekvens, så resultatet returneres som før; `usage`/`finish` er sluppet ut over.
            return result;
          }
          // D-441 (JARVIS-038): INGEN synlig output er levert og `usage`/`finish` er holdt tilbake - da behandles et tomt eller avkortet stream-resultat som i
          // ikke-streaming-stien (ett begrenset retry ved avkorting, ellers neste kandidat eller en ærlig feil), aldri som en stille suksess.
          heldTerminalEvents.length = 0;

          // D-106 PR #53 functional-success-invariant (§4): ETT begrenset,
          // evidensbasert retry-forsøk (alltid ikke-streamet; i streaming-stien når vi
          // bare hit uten synlig output - se returnen over, D-441). KUN når finish_reason
          // indikerer budsjett-uttømming (TRUNCATED) - en ordinær tom EMPTY_OUTPUT
          // (finish_reason=stop) er IKKE et retry-kandidat (§4).
          if (outcome === "TRUNCATED_NO_USABLE_OUTPUT") {
            throwIfCancelled(adapter.name); // avbrutt tur: aldri start et nytt (betalt) retry-kall
            const budgetPermits = await this.adaptiveRetryPermittedByBudget(input.tenant_id);
            if (budgetPermits) {
              const retryStart = Date.now();
              try {
                const retryRequest: ModelRequest = {
                  ...request,
                  max_tokens: computeAdaptiveRetryMaxTokens(result, request)
                };
                generatedChars = 0; // retry-kallet er ikke streamet: ingenting er generert som vi vet om før det svarer
                callActive = true;
                const retryResult = await adapter.complete(retryRequest, streamOpts || isCritic ? undefined : input.onToken);
                callActive = false;
                const retryLatency = retryResult.latency_ms ?? Date.now() - retryStart;
                this.health.recordSuccess(adapter.name, retryLatency, concurrent);
                retryResult.metadata = {
                  ...retryResult.metadata,
                  router: {
                    mode: plan.mode,
                    reason: plan.reason,
                    ...(failedProviders.length > 0 ? { fallback_from: failedProviders } : {})
                  },
                  adaptive_retry: {
                    triggered: true,
                    first_attempt_outcome: outcome,
                    ...(result.finish_reason !== undefined ? { first_attempt_finish_reason: result.finish_reason } : {}),
                    first_attempt_output_tokens: result.usage.output_tokens,
                    retry_max_tokens: retryRequest.max_tokens
                  }
                };
                if (pacing !== undefined) {
                  retryResult.metadata = { ...retryResult.metadata, claude_budget: pacing.resultMetadata() };
                  this.resultTickets.set(retryResult, pacing);
                }
                const retryOutcome = classifyCompletionOutcome(retryResult);
                await this.recordAttemptResult(input, retryResult, retryOutcome, {
                  traceId,
                  started,
                  budgetLevel,
                  isCritic,
                  adapterName: adapter.name,
                  latency: retryLatency,
                  failedProviders,
                  plan,
                  adaptiveRetryOfOutcome: outcome,
                  ...(pacing !== undefined ? { pacing } : {})
                });
                if (retryOutcome === "USABLE_SUCCESS") {
                  if (streamOpts) {
                    // Retry-kallet er gjennomført og kostnadsført over; men er turen avbrutt mens det kjørte, spilles svaret IKKE av (kastes som «cancelled»).
                    throwIfCancelled(adapter.name);
                    replayResultAsStreamEvents(streamOpts.onEvent, retryResult); // konsumenten får en ren sekvens for det brukbare retry-svaret
                  }
                  return retryResult;
                }
                // Retry-forsøket var OGSÅ ubrukelig - ærlig feil, aldri stille suksess (§4).
                lastError = new ProviderError(adapter.name, "invalid_response", `${adapter.name}_no_usable_output_after_retry`);
                this.notifyAttemptFailed(input, adapter.name, "invalid_response", isCritic); // WP-D4 (M2): en reserve som tar over etter et ubrukelig svar skal være synlig
                break;
              } catch (retryErr) {
                // Selve retry-kallet feilet på transportnivå (§5: begge forsøk er ekte,
                // reelle feil skal IKKE skjules) - normal feilhåndtering, ingen ny retry.
                const pe =
                  retryErr instanceof ProviderError
                    ? retryErr
                    : new ProviderError(adapter.name, "server", (retryErr as Error).message);
                if (pe.kind === "cancelled") {
                  // Bruker-cancellation (§35): la den YTRE catch-blokken håndtere dette
                  // ÉN gang uniformt (recordFailedAttempt + rethrow) - ikke dobbeltregistrer her.
                  throw pe;
                }
                lastError = pe;
                if (!isBackgroundTimeout(input.purpose, pe.kind)) this.health.recordFailure(adapter.name, pe.kind, pe.message);
                await this.recordFailedAttempt(input, adapter.name, pe, isCritic, billing(request));
                break;
              }
            }
          }

          // Ikke brukbart, ingen (eller uttømt) retry: gå videre til neste kandidat
          // UTEN å straffe provider-helsen (§3/§7 - transporten lyktes faktisk).
          lastError = new ProviderError(adapter.name, "invalid_response", `${adapter.name}_no_usable_output`);
          // WP-D4 (M2): helsen straffes ikke, men reservebruk skal alltid være synlig (D-447) - også når reserven tok over etter et TOMT eller AVKORTET svar, ikke bare etter en kastet feil.
          this.notifyAttemptFailed(input, adapter.name, "invalid_response", isCritic);
          break;
        } catch (err) {
          const pe =
            err instanceof ProviderError
              ? err
              : new ProviderError(adapter.name, "server", (err as Error).message);
          lastError = pe;
          // Bruker-cancellation er ikke provider-feil (§35): ingen health-straff, ingen fallback.
          if (pe.kind === "cancelled") {
            await this.recordFailedAttempt(input, adapter.name, pe, isCritic, billing(request));
            throw pe;
          }
          if (!isBackgroundTimeout(input.purpose, pe.kind)) this.health.recordFailure(adapter.name, pe.kind, pe.message);
          await this.recordFailedAttempt(input, adapter.name, pe, isCritic, billing(request));
          // D-106 HOST-FIX Defekt B-oppfølging (host-bevis 2026-09-20): et mislykket
          // forsøk skrev FØR denne linjen KUN `kind` til `cost_events`
          // (`recordFailedAttempt` over) - selve feilmeldingen/diagnostikken
          // (`pe.diagnostic`, allerede vettet trygg - se `ProviderErrorDiagnostic`
          // i types.ts, ALDRI secrets/frie leverandør-meldinger) gikk tapt for
          // godt før noen (menneske ELLER en fremtidig feilsøkingsrunde) kunne se
          // den - `gemma_hosted` falt stille tilbake til `openai` på HVERT kall i
          // produksjon uten at dette var synlig noe sted. Alltid-på (ikke bak
          // `JARVIS_STREAM_DEBUG`, som kun gjelder verbos per-event-strømming) -
          // dette er en faktisk feil, ikke rutinemessig sporing.
          console.error(JSON.stringify({
            msg: "model_attempt_failed", provider: adapter.name, kind: pe.kind,
            status: pe.status, diagnostic: pe.diagnostic
          }));
          // §11: etter output-start byttes ALDRI provider stille i samme stream.
          if (streamOpts && outputStarted) {
            streamOpts.onEvent({ type: "error", category: "stream_interrupted", message: pe.message.slice(0, 120) });
            throw new ProviderError(adapter.name, "stream_interrupted", pe.message);
          }
          // auth/bad_request/not_configured: aldri retry-spam på samme provider (§12).
          if (!(pe.retryableSameProvider && attempt < maxTries)) {
            break;
          }
        } finally {
          this.inFlightCalls -= 1;
        }
      }
      failedProviders.push(candidate.provider);
    }
    throw lastError ?? new ProviderError("router", "not_configured", "no_provider_available");
  }

  /**
   * UA-1 P1A: normalisert streaming (§3-§10). Fallback kun før første output;
   * cancel via signal gir ren avslutning uten zombie-generation (§9/§28).
   */
  async stream(rawInput: CompleteInput, onEvent: StreamHandler, signal?: AbortSignal): Promise<ModelResult> {
    return this.withPriority(rawInput.purpose, () => this.streamInner(rawInput, onEvent, signal));
  }

  /**
   * D-414: interaktive formål registreres som aktive mens de kjører; bakgrunnsformål venter først på ro (maks `maxWaitMs`).
   * Hele chat-turen (verktøyrunder med pauser) holdes sammen av `quietMs`.
   */
  private async withPriority<T>(purpose: string | undefined, run: () => Promise<T>): Promise<T> {
    const gate = this.opts.priorityGate;
    if (gate === undefined || purpose === undefined) return run();
    if (INTERACTIVE_PURPOSES.has(purpose as never)) {
      const leave = gate.enterInteractive();
      try {
        return await run();
      } finally {
        leave();
      }
    }
    if (BACKGROUND_PURPOSE_SET.has(purpose as never)) {
      const y = await gate.yieldToInteractive();
      if (y.waited_ms >= 1000) console.log(JSON.stringify({ msg: "background_yielded_to_interactive", purpose, waited_ms: y.waited_ms, reason: y.reason }));
    }
    return run();
  }

  private async streamInner(rawInput: CompleteInput, onEvent: StreamHandler, signal?: AbortSignal): Promise<ModelResult> {
    const input = this.lockRestrictedMedia(this.applyTimeoutOverride(rawInput));
    const started = Date.now();
    const traceId = `trace-${randomUUID()}`;
    this.enforceRateLimit(input.tenant_id);
    const budget = await this.guard.evaluate(input.tenant_id);
    if (budget.level === "hard_blocked" || budget.level === "needs_approval") {
      throw new BudgetExceededError(budget.level, budget.spent_ore);
    }
    const paused = await this.livePauses();
    this.assertNotPaused(input.provider, paused);
    // WP-B4 (D-476): se `completeInner`.
    const pacing = await this.beginPacing(input, paused, traceId, started, this.pacingRounds.get(rawInput));
    try {
      const routeInput: RouteInput = {
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        // D-379: for SECRET_RESTRICTED er kun lokale providere kvalifisert, og de lokale OpenAI-kompatible
        // adapterne har ikke native streaming (ærlig registry, D-80). `executePlan` normaliserer allerede til én
        // text_delta for adaptere uten `.stream()`, så native streaming kreves ikke her - alternativet er at
        // helse/finans-chat feiler lukket uten noen kvalifisert provider.
        required_capabilities: [
          ...(input.required_capabilities ?? []),
          ...(input.sensitivity === "SECRET_RESTRICTED" ? [] : (["streaming"] as const))
        ],
        ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
        ...(input.paid_models_allowed !== undefined
          ? { paid_models_allowed: input.paid_models_allowed }
          : {}),
        ...(input.providerPreference !== undefined
          ? { providerPreference: input.providerPreference }
          : {}),
        ...(input.preferenceFailover !== undefined ? { preferenceFailover: input.preferenceFailover } : {}),
        ...(input.excludeProviders !== undefined ? { excludeProviders: input.excludeProviders } : {}),
        needs_structured: Boolean(input.request.structured_schema)
      };
      const routerPlan = this.planRoute(routeInput, paused, input, pacing);
      const plan = await this.applyModelAdvice(input, routerPlan, budget.level, traceId);
      return await this.executePlan(input, plan, traceId, started, budget.level, false, undefined, { onEvent, ...(signal ? { signal } : {}) }, pacing);
    } finally {
      pacing?.release();
    }
  }

  /**
   * UA-1 P1A tool-løkke (§16, §19-§26): modell ber om verktøy → trusted executor
   * (Tool Gateway/Authority) → normalisert resultat → modellen fortsetter. Runder er
   * provider-nøytrale (tool_exchanges), så fallback etter utført verktøy fortsetter
   * med persistert resultat - aldri dobbel utførelse (§21).
   */
  async completeWithTools(input: CompleteInput, opts: ToolLoopOptions): Promise<ModelResult> {
    const maxRounds = opts.maxRounds ?? 4;
    const known = new Map(opts.tools.map((t) => [t.name, t]));
    const executed = new Map<string, ToolResultMessage>(); // idempotency: samme kall → samme resultat
    const exchanges: ToolExchange[] = [];
    let repairUsed = false;
    let forceFinal = false;
    let honestyApplied = false;
    let result: ModelResult | null = null;
    let lockedToLocal = false;
    // WP-D4 (L11): hver leverandør som betjente en runde (i rekkefølge). Ruten kan skifte mellom runder (runde 1 reserve i skyen, siste runde den lokale som kom tilbake), og flaten skal få vite om en skyleverandør
    // har rørt turen selv om den ikke var den som ga det siste svaret.
    const servedProviders: string[] = [];
    // WP-B4 (M1): Claude-kreditten på tvers av runder. `anthropicRound` = billetten til den siste runden Anthropic FAKTISK betjente (turen er påbegynt der og fullføres); `closedRound` = en runde kreditten stengte for Anthropic
    // (resten av turen forblir stengt). Begge kommer fra gatewayens egne resultater (leverandør stemplet av adapteren) - aldri fra innholdet i forespørselen.
    let anthropicRound: PacingTicket | undefined;
    let closedRound: PacingTicket | undefined;

    for (let round = 1; round <= maxRounds; round++) {
      // Siste runde / loop-vern: uten tools MÅ modellen syntetisere tekstsvar av
      // resultatene den alt har - aldri tom respons pga. runde-taket.
      const withTools = !forceFinal && round < maxRounds;
      const request: ModelRequest = {
        ...input.request,
        ...(withTools ? { tools: opts.tools } : {}),
        ...(exchanges.length > 0 ? { tool_exchanges: exchanges } : {})
      };
      const roundInput: CompleteInput = {
        ...input,
        required_capabilities: [...(input.required_capabilities ?? []), "tool_calling"],
        request,
        ...(lockedToLocal ? this.localOnlyRouting(input) : {})
      };
      if (closedRound !== undefined) this.pacingRounds.set(roundInput, { closed_by: closedRound });
      else if (anthropicRound !== undefined) this.pacingRounds.set(roundInput, { continuation_of: anthropicRound });
      // D-430: har ingen verktøykall lyktes så langt, bufres runden (ingen tekst strømmes) - modellen kan ennå rette kallet, men en tekst
      // uten data er gjetting og erstattes under av en fast, ærlig melding.
      const failureGuard = mustReplaceWithFailureText(summarizeToolOutcomes(exchanges));
      result = opts.onEvent && !failureGuard
        ? await this.stream(roundInput, opts.onEvent, opts.signal)
        : await this.complete(roundInput);
      if (!servedProviders.includes(result.provider)) servedProviders.push(result.provider);
      const roundTicket = this.resultTickets.get(result);
      if (roundTicket !== undefined) {
        if (roundTicket.constraint === "closed") closedRound ??= roundTicket;
        else if (result.provider === CLAUDE_BUDGET_PROVIDER) anthropicRound = roundTicket;
      }
      if (opts.localStickiness && !lockedToLocal && this.servedLocally(result)) lockedToLocal = true;
      const calls = (result.tool_calls ?? []).slice(0, opts.maxCallsPerRound ?? Number.POSITIVE_INFINITY);
      if (calls.length === 0) {
        if (failureGuard) {
          const text = allFailedText(summarizeToolOutcomes(exchanges));
          result = { ...result, text, metadata: { ...result.metadata, tool_honesty: "all_failed" } };
          opts.onEvent?.({ type: "text_delta", text });
          honestyApplied = true;
        }
        break;
      }
      const sizeBefore = executed.size;
      const results: ToolResultMessage[] = [];
      for (const call of calls) {
        // D-390 (JARVIS-079 «barge-in stops streaming not tools»): et avbrudd (tale-barge-in, klient borte) stopper også
        // verktøyløkka - ingen nye verktøykall startes etter at signalet er satt. Et kall som allerede kjører fullføres
        // (side-effekter rulles aldri tilbake, §17), men neste kall/runde avbrytes rent som `cancelled`.
        if (opts.signal?.aborted) {
          throw new ProviderError(result.provider ?? "router", "cancelled", "tool_loop_cancelled");
        }
        results.push(await this.executeToolCall(call, input, known, executed, () => {
          if (repairUsed) {
            return false;
          }
          repairUsed = true;
          return true;
        }, opts.executor));
      }
      exchanges.push({ calls, results });
      // Kun cache-treff i runden = modellen looper på samme kall → tving syntese (§19).
      if (executed.size === sizeBefore && results.every((r) => r.success)) {
        forceFinal = true;
      }
    }
    if (!result) {
      throw new ProviderError("router", "not_configured", "no_provider_available");
    }
    // D-430: noen kall lyktes og andre feilet → fast merknad om det som mangler (modellen kan ha tiet eller dikta rundt det).
    const partialNote = honestyApplied ? "" : partialFailureNote(summarizeToolOutcomes(exchanges));
    if (partialNote) {
      result = { ...result, text: `${result.text}${partialNote}`, metadata: { ...result.metadata, tool_honesty: "partial" } };
      opts.onEvent?.({ type: "text_delta", text: partialNote });
    }
    // `served_providers` settes kun når FLERE leverandører betjente turen (vanlig tur: én leverandør, metadata uendret).
    result.metadata = { ...result.metadata, tool_rounds: exchanges.length, ...(servedProviders.length > 1 ? { served_providers: servedProviders } : {}) };
    return result;
  }

  /** Var runden betjent av en LOKAL leverandør? Ukjent leverandør regnes som sky (fail-closed: den låser ikke løkken, men får heller ikke se mer enn før). */
  private servedLocally(result: ModelResult): boolean {
    return this.registry.profileOrGeneric(result.provider, result.model).locality === "local";
  }

  /** `localStickiness`: ruting som kun slipper lokale leverandører til (preferanselisten snevres inn; en tom liste faller til `mode: "LOCAL"`). */
  private localOnlyRouting(input: CompleteInput): Pick<CompleteInput, "mode" | "providerPreference"> {
    const local = (input.providerPreference ?? []).filter((name) => this.registry.profileOrGeneric(name, "ukjent").locality === "local");
    return { mode: "LOCAL", ...(input.providerPreference !== undefined ? { providerPreference: local } : {}) };
  }

  /** Ett verktøykall: ukjent tool → DENY uten utførelse (§26); schema-feil → normalisert feil (§25). */
  private async executeToolCall(
    call: ToolCallRequest,
    input: CompleteInput,
    known: Map<string, ToolDefinition>,
    executed: Map<string, ToolResultMessage>,
    allowRepair: () => boolean,
    executor: ToolExecutor
  ): Promise<ToolResultMessage> {
    const at = new Date().toISOString();
    const def = known.get(call.tool_name);
    if (!def) {
      return {
        tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "none",
        success: false, output: null, error_category: "TOOL_NOT_FOUND", at
      };
    }
    const validationError = validateToolArgs(def.input_schema, call.arguments);
    if (validationError) {
      // Modellen får normalisert feil og kan reparere ÉN gang (§25); aldri delvis utførelse.
      allowRepair();
      return {
        tool_call_id: call.tool_call_id, tool_name: call.tool_name, execution_id: "none",
        success: false, output: null, error_category: `INVALID_ARGUMENTS:${validationError}`, at
      };
    }
    const idempotencyKey = toolCallIdempotencyKey(input, call);
    const cached = executed.get(idempotencyKey);
    if (cached) {
      // Retry/fallback/reconnect: samme utførelse returneres - aldri dobbel side-effekt (§19).
      return { ...cached, tool_call_id: call.tool_call_id };
    }
    const result = await executor.execute(call, {
      tenant_id: input.tenant_id,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      idempotency_key: idempotencyKey
    });
    executed.set(idempotencyKey, result);
    return result;
  }

  /** Critic (§18-§19): separat modellkjøring, egen kostrad, aldri koblet til D-godkjenning. */
  private async runCritic(input: CompleteInput, primary: ModelResult, traceId: string, pacing?: PacingTicket): Promise<void> {
    try {
      let runtimes = this.providerRuntimes(this.pausedSnapshot);
      // WP-B4: criticen er en ekstra, valgfri kvalitetskjøring - aldri på Anthropic når kreditten har snevret inn dette kallet (nedgradert, utsatt eller stengt). L1: og da heller aldri en annen BETALT skyleverandør i
      // stedet - criticen er lokal (en gratis kvalitetsforsterkning skal ikke koste eierens penger fordi den gratis kreditten er styrt bort fra).
      const narrowed = pacing !== undefined && pacing.constraint !== "open";
      if (narrowed) {
        this.closeClaudeRuntime(runtimes);
        runtimes = new Map([...runtimes].filter(([name, rt]) => this.registry.profileOrGeneric(name, rt.model).locality === "local"));
      }
      // Foretrekk annen provider enn primær for uavhengig blikk; ellers samme.
      const others = new Map([...runtimes].filter(([name, rt]) => rt.configured && name !== primary.provider));
      const pool = others.size > 0 ? others : runtimes;
      // Del 3 (JARVIS-016): criticen ser det samme innholdet som primærkallet - SAMME sensitivitets-/betalt-modell-regler gjelder.
      const criticPlan = this.router.plan({
        mode: narrowed ? "LOCAL" : "QUALITY",
        purpose: "CRITIQUE",
        ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
        ...(input.paid_models_allowed !== undefined ? { paid_models_allowed: input.paid_models_allowed } : {})
      }, pool);
      // WP-G3 (review A-L1): critic-forespørselen under er REN TEKST (tekstdelene + primærsvaret), så utførelseslåsen i `executePlan` (som leter etter `restricted`-bildedeler) slår aldri inn for criticen. Primærsvaret er derimot
      // AVLEDET av kamerabildet (en beskrivelse av det) og skal aldri til en skyleverandør: var innkallingen BEGRENSET, må HVER critic-kandidat være lokal, ellers kastes (fanges under som `critic_error`; primærsvaret er uberørt).
      // Dette er et eget lag under sensitivitetsarven (`lockRestrictedMedia` setter SECRET_RESTRICTED): en senere endring av den arven åpner ikke critic-veien mot sky.
      if (hasRestrictedMedia(input.request) && criticPlan.candidates.some((c) => this.registry.profileOrGeneric(c.provider, c.model).locality !== "local")) {
        throw new Error("critic_restricted_media_nonlocal");
      }
      const lastUserMessage = [...input.request.messages].reverse().find((m) => m.role === "user");
      const lastUser = lastUserMessage ? textOnly(lastUserMessage.content) : "";
      // §30: critic er review-rolle - får ALDRI tools, kan aldri utføre side-effekter.
      const criticRequest: ModelRequest = {
        system: CRITIC_SYSTEM,
        messages: [
          {
            role: "user",
            content: `OPPGAVE:\n${lastUser.slice(0, 4000)}\n\nSVAR SOM SKAL VURDERES:\n${primary.text.slice(0, 6000)}`
          }
        ],
        max_tokens: 512
      };
      // WP-B4 (M3): billetten følger med så criticens kostnad (og et avbrutt critic-kall) også ses av overlegget i enforceren mens bufferen av forbruket er gyldig. Er kallet snevret inn er criticen lokal (ingen Anthropic-kandidat),
      // og er det åpent finnes ingen nedgradering å anvende - billetten endrer derfor ingenting ved valget, kun bokføringen. Uten Claude-kreditten er `pacing` udefinert og kallet er uendret.
      const criticResult = await this.executePlan(
        input,
        criticPlan,
        traceId,
        Date.now(),
        "ok",
        true,
        criticRequest,
        undefined,
        pacing
      );
      this.criticRunSeen = true;
      primary.metadata = {
        ...primary.metadata,
        critic: {
          provider: criticResult.provider,
          model: criticResult.model,
          critique: criticResult.text
        }
      };
    } catch (err) {
      // Critic er kvalitetsforsterkning - feil her skal aldri velte primærsvaret.
      primary.metadata = { ...primary.metadata, critic_error: (err as Error).message.slice(0, 120) };
    }
  }

  /** WP-D4: detaljert status per registrert leverandør (også ikke-konfigurerte) til rapporten `executive.get_ai_mesh_status`. Ingen secrets - kun presence, tall og feilklasse. */
  meshDetails(): MeshProviderDetail[] {
    return [...this.providerRuntimes()].map(([name, rt]) => {
      const profile = this.registry.profileOrGeneric(name, rt.model);
      return {
        provider: name,
        model: rt.model,
        configured: rt.configured,
        ...(rt.paused ? { paused: true } : {}),
        locality: profile.locality,
        capabilities: [...profile.capabilities],
        hosted_free_tier: profile.hosted_free_tier === true,
        auto_unverified: this.toolsVerified.has(name) ? [] : [...(profile.live_unverified ?? [])],
        // Helsen (`state`) ignorerer pausen (som i `meshStatus`): den sier hvordan leverandøren faktisk har det, ikke om eieren har stengt den.
        ...this.health.details(name, rt.available)
      };
    });
  }

  /** Kompakt mesh-status for /status og /ai (§37-§38). Ingen secrets. */
  meshStatus(): MeshStatus {
    const runtimes = this.providerRuntimes();
    // Helsen (`state`) ignorerer pausen: den sier hvordan leverandøren faktisk har det. Hvem som kan brukes (ruter, fallback) regnes med `configured` (= tilgjengelig og ikke pauset).
    const snapshot = this.health.snapshot(new Map([...runtimes].map(([k, v]) => [k, v.available])));
    return {
      providers: [...runtimes].map(([name, rt]) => {
        const s = snapshot[name] as NonNullable<(typeof snapshot)[string]>;
        return {
          provider: name,
          model: rt.model,
          state: s.state,
          success: s.success,
          failures: s.failures,
          ...(s.avg_latency_ms !== undefined ? { avg_latency_ms: s.avg_latency_ms } : {}),
          ...(rt.paused ? { paused: true } : {})
        };
      }),
      router: meshRouterState([...runtimes].map(([name, rt]) => ({ configured: rt.configured, state: (snapshot[name] as NonNullable<(typeof snapshot)[string]>).state }))),
      fallback: this.crossProviderFallbackSeen
        ? "VERIFIED"
        : [...runtimes].filter(([name, r]) => r.configured && name !== "scripted").length >= 2
          ? "READY"
          : "LOGIC_ONLY",
      critic: this.criticRunSeen ? "VERIFIED" : "READY_SELECTIVE"
    };
  }

  /**
   * WP-H0 (JARVIS-087): kontrollsenterets rike visning av hver registrert leverandør (lokalitet, konfigurasjon, helse inkl. krets). Ren lesing av gatewayens egen bokføring - ingen nettverkskall, ingen
   * feiltekster. Eier-pausen er IKKE med her: kontrollsenteret leser den LIVE fra den varige tilstanden (en pause satt av den andre prosessen er da synlig umiddelbart).
   */
  providerOverview(): ProviderOverviewRow[] {
    return this.opts.providers.map((p) => {
      const available = p.available();
      const model = p.model ?? "ukjent";
      const profile = this.registry.profileOrGeneric(p.name, model);
      return {
        provider: p.name,
        model,
        locality: profile.locality,
        hosted_free_tier: profile.hosted_free_tier === true,
        configured: available,
        health: this.health.detail(p.name, available)
      };
    });
  }

  /** WP-H0: modellrådgiverens modus (off/shadow/active, D-399) - kontrollsenteret viser den. */
  get routingAdvisorMode(): "off" | "shadow" | "active" {
    return this.advisorMode;
  }

  /** WP-H0: har en fallback mellom ULIKE leverandører faktisk skjedd i denne prosessen (§25)? */
  get crossProviderFallbackVerified(): boolean {
    return this.crossProviderFallbackSeen;
  }

  /**
   * D-106 PR #53 (functional-success-invariant, §3/§5): kost + trace for ETT
   * faktisk providerforsøk - brukes for både det ordinære forsøket OG et evt.
   * adaptivt retry-forsøk, slik at BEGGE forblir egne, ærlige, kostnadssporede
   * rader (§5: "Do NOT erase the failed first completion from history").
   * `outcome`/`finish_reason`/synlig tekstlengde persisteres alltid i
   * trace-metadata - aldri hemmelig, aldri rå resonnement-tekst.
   */
  private async recordAttemptResult(
    input: CompleteInput,
    result: ModelResult,
    outcome: CompletionOutcome,
    ctx: {
      traceId: string;
      started: number;
      budgetLevel: string;
      isCritic: boolean;
      adapterName: string;
      latency: number;
      streamOpts?: { onEvent: StreamHandler; signal?: AbortSignal };
      failedProviders: string[];
      plan: RoutePlan;
      /** Satt kun når DETTE forsøket er det adaptive retry-forsøket. */
      adaptiveRetryOfOutcome?: CompletionOutcome;
      /** WP-B4: Claude-kreditten sin billett for kallet (kostnaden meldes til overlegget i enforceren). */
      pacing?: PacingTicket;
    }
  ): Promise<void> {
    const cost =
      this.legacyCostOverride(result) ?? computeCostOre(this.pricing, result.provider, result.model, result.usage);
    // WP-B4 (M3): meld kostnaden til billetten FØR bokføringen (en feilet INSERT betyr ikke at pengene ikke er brukt - overlegget må likevel se dem).
    if (result.provider === CLAUDE_BUDGET_PROVIDER) ctx.pacing?.noteBooked(cost);
    // D-393 (JARVIS-034): kostnads- og sporingsskriving ETTER et vellykket leverandørkall er bokføring, ikke en leverandørfeil. Tidligere
    // gikk en feilet `cost_events`-INSERT eller trace-skriving til `catch` i `executePlan`, ble talt som leverandørfeil og utløste et NYTT
    // (fakturert) kall mot neste kandidat selv om svaret allerede forelå. Nå logges feilen høyt (med beløpet slik at det kan etterbokføres)
    // og svaret returneres.
    try {
      await this.recordCost(input, result, cost, {
        success: true,
        fallback: ctx.failedProviders.length > 0,
        critic: ctx.isCritic,
        latency_ms: ctx.latency,
        // BO-11.1 §4: streaming-/tool-metrics SQL-spørrbare (migrasjon 016).
        stream: Boolean(ctx.streamOpts),
        ...(result.ttft_ms !== undefined ? { ttft_ms: result.ttft_ms } : {}),
        tool_calls: result.tool_calls?.length ?? 0
      });
    } catch (err) {
      this.bookkeepingFailures += 1;
      console.error(JSON.stringify({
        msg: "model_cost_bookkeeping_failed", provider: result.provider, model: result.model, tenant_id: input.tenant_id,
        cost_ore: cost, input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, error: (err as Error).message.slice(0, 160)
      }));
    }
    try {
      await this.recordAttemptTrace(input, result, outcome, cost, ctx);
    } catch (err) {
      this.bookkeepingFailures += 1;
      console.error(JSON.stringify({ msg: "model_trace_bookkeeping_failed", provider: result.provider, error: (err as Error).message.slice(0, 160) }));
    }
  }

  /** D-393: antall bokføringsfeil (kost/trace) som ble isolert fra leverandørfeilhåndteringen - synlig for drift/tester. */
  bookkeepingFailures = 0;

  private async recordAttemptTrace(
    input: CompleteInput,
    result: ModelResult,
    outcome: CompletionOutcome,
    cost: number,
    ctx: {
      traceId: string;
      started: number;
      budgetLevel: string;
      isCritic: boolean;
      adapterName: string;
      latency: number;
      failedProviders: string[];
      plan: { mode: string; reason: string };
      adaptiveRetryOfOutcome?: CompletionOutcome;
    }
  ): Promise<void> {
    await this.opts.trace.record({
      trace_id: ctx.traceId,
      kind: "model_call",
      name: `${ctx.isCritic ? "critic:" : ""}${ctx.adapterName}:${result.model}`,
      tenant_id: input.tenant_id,
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
      at: new Date().toISOString(),
      duration_ms: Date.now() - ctx.started,
      cost_ore: cost,
      metadata: {
        usage: { ...result.usage },
        budget_level: ctx.budgetLevel,
        router_mode: ctx.plan.mode,
        routing_reason: ctx.plan.reason,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(ctx.failedProviders.length > 0 ? { fallback_from: ctx.failedProviders } : {}),
        latency_ms: ctx.latency,
        ...(result.ttft_ms !== undefined ? { ttft_ms: result.ttft_ms } : {}),
        ...(result.tool_calls?.length ? { tool_calls_requested: result.tool_calls.length } : {}),
        critic: ctx.isCritic,
        // D-106 PR #53 functional-success-invariant (§3): ærlig utfallsklassifisering,
        // alltid persistert. Ingen secrets, ingen rå resonnement-tekst - kun metadata.
        outcome,
        ...(result.finish_reason !== undefined ? { finish_reason: result.finish_reason } : {}),
        visible_text_length: result.text.length,
        has_tool_calls: Boolean(result.tool_calls?.length),
        has_structured_output: result.structured_output !== undefined,
        ...(ctx.adaptiveRetryOfOutcome !== undefined
          ? { adaptive_retry: true, adaptive_retry_of_outcome: ctx.adaptiveRetryOfOutcome }
          : {})
      }
    });
  }

  /**
   * D-106 PR #53 (§4): "policy/budget permits retry" - gjenbruker DEN SAMME
   * `BudgetGuard` som styrer det ordinære kallet (ingen ny budsjett-mekanisme).
   * Evalueres PÅ NYTT rett før retry-kallet, fordi retry er et EKSTRA, reelt
   * billable kall utover det som allerede ble godkjent innledningsvis - hvis
   * budsjettet i mellomtiden har blitt hardt blokkert/krever godkjenning,
   * nektes retry-forsøket (ærlig fallback/feil, §4/§7), men SELVE det
   * allerede utførte (og allerede kostnadsførte) første forsøket rulles
   * aldri tilbake.
   */
  private async adaptiveRetryPermittedByBudget(tenantId: string): Promise<boolean> {
    const budget = await this.guard.evaluate(tenantId);
    return budget.level !== "hard_blocked" && budget.level !== "needs_approval";
  }

  private async recordCost(
    input: CompleteInput,
    result: ModelResult,
    costOre: number,
    flags: {
      success: boolean;
      fallback: boolean;
      critic: boolean;
      latency_ms: number;
      /** BO-11.1 §4: kun satt for streaming-executions (migrasjon 016). */
      stream?: boolean;
      ttft_ms?: number;
      tool_calls?: number;
    }
  ): Promise<void> {
    await withTenantTransaction(this.opts.pool, input.tenant_id, (client) =>
      client.query(
        `INSERT INTO cost_events (tenant_id, task_id, session_id, kind, amount_ore, provider, model,
                                  input_tokens, output_tokens, purpose, success, fallback, critic, latency_ms,
                                  ttft_ms, stream, tool_calls)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          input.tenant_id,
          input.task_id ?? null,
          input.session_id ?? null,
          `model:${result.provider}`,
          costOre,
          result.provider,
          result.model,
          result.usage.input_tokens,
          result.usage.output_tokens,
          input.purpose ?? null,
          flags.success,
          flags.fallback,
          flags.critic,
          flags.latency_ms,
          flags.ttft_ms ?? null,
          flags.stream ?? false,
          flags.tool_calls ?? 0
        ]
      )
    );
  }

  /** Bakoverkompatibilitet: eksplisitt rates-opsjon (eldre tester/konfig) vinner over pricing-tabellen. */
  private legacyCostOverride(result: ModelResult): number | undefined {
    const rate = this.opts.rates?.[result.provider];
    if (!rate) {
      return undefined;
    }
    return Math.ceil(
      (result.usage.input_tokens / 1000) * rate.input_per_1k_ore +
        (result.usage.output_tokens / 1000) * rate.output_per_1k_ore
    );
  }

  /**
   * WP-D4 (JARVIS-033, gjennomgang av PR #315 M2): meld ÉN kandidat som ikke svarte til flatens lytter (`CompleteInput.onAttemptFailed`). Brukes av ALLE veier der en kandidat ikke ble den som svarte: kastet feil
   * (`recordFailedAttempt`), tomt/avkortet/ubrukelig svar (`executePlan`, «Ikke brukbart»-grenene - transporten lyktes, så helsen straffes ikke, men eieren skal likevel få vite at en reserve svarte) og en kandidat som
   * ble hoppet over fordi helsen er UNAVAILABLE (`plan.unavailable`). Brukeravbrudd er ingen leverandørfeil, og criticen er en egen kjøring. En feil i lytteren er konsumentens og må aldri stoppe fallback-kjeden.
   */
  private notifyAttemptFailed(input: CompleteInput, provider: string, kind: string, critic: boolean): void {
    if (critic || kind === "cancelled" || input.onAttemptFailed === undefined) return;
    try {
      input.onAttemptFailed({ provider, kind });
    } catch (listenerError) {
      console.error(JSON.stringify({ msg: "attempt_failed_listener_error", error: (listenerError as Error).message.slice(0, 120) }));
    }
  }

  private async recordFailedAttempt(
    input: CompleteInput,
    provider: string,
    err: ProviderError,
    critic: boolean,
    billing?: FailedCallBilling
  ): Promise<void> {
    this.notifyAttemptFailed(input, provider, err.kind, critic);
    // WP-B4 (L2): et sendt, men avbrutt/utløpt/feilet Anthropic-kall bokføres med et ANSLAG (input + det som er generert så langt) i stedet for 0 øre - ellers undertelles kreditten (taleavbrudd er hovedkilden).
    // Kun med Claude-kreditten på (uten den er raden som før: 0 øre, samme SQL) og kun for Anthropic og feilklasser som kan være fakturert. Anslaget meldes også til overlegget i enforceren.
    let estimate = 0;
    if (billing !== undefined && provider === CLAUDE_BUDGET_PROVIDER && (BILLABLE_FAILURE_KINDS.has(err.kind) || billing.generated_chars > 0)) {
      estimate = estimateFailedCallOre(this.pricing, provider, billing.model, billing.request, billing.generated_chars);
      if (estimate > 0) billing.pacing?.noteBooked(estimate);
    }
    try {
      await withTenantTransaction(this.opts.pool, input.tenant_id, (client) =>
        client.query(
          // `0` er literal når ingenting er anslått (SQL-teksten er da byte-identisk med main); et anslag settes inn som parameter `$9`.
          `INSERT INTO cost_events (tenant_id, task_id, session_id, kind, amount_ore, provider, model,
                                    input_tokens, output_tokens, purpose, success, fallback, critic, latency_ms)
           VALUES ($1, $2, $3, $4, ${estimate > 0 ? "$9" : "0"}, $5, $6, 0, 0, $7, false, false, $8, NULL)`,
          [
            input.tenant_id,
            input.task_id ?? null,
            input.session_id ?? null,
            `model:failed:${err.kind}`,
            provider,
            "(failed)",
            input.purpose ?? null,
            critic,
            ...(estimate > 0 ? [estimate] : [])
          ]
        )
      );
    } catch {
      // Kostlogging av feilforsøk skal aldri stoppe fallback-kjeden.
    }
  }

  private enforceRateLimit(tenantId: string): void {
    const limit = this.opts.maxCallsPerMinute ?? 60;
    const now = Date.now();
    const stamps = (this.callTimestamps.get(tenantId) ?? []).filter((t) => now - t < 60_000);
    if (stamps.length >= limit) {
      throw new Error("rate_limited: for mange modellkall per minutt");
    }
    stamps.push(now);
    this.callTimestamps.set(tenantId, stamps);
  }
}

/** Tidsvindu for samtalebundne (ikke oppgavebundne) nøkler: samme mutasjon senere i en langlevd økt er en NY intensjon, ikke en retry. */
export const SESSION_IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

/** Kanonisk JSON: nøkler sortert på ALLE nivåer (JARVIS-017: replacer-arrayen `JSON.stringify(x, keys)` filtrerte bort nøstede felt). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function toolCallIdempotencyKey(
  input: { tenant_id: string; task_id?: string; session_id?: string },
  call: { tool_name: string; arguments: Record<string, unknown> },
  nowMs: number = Date.now()
): string {
  // Oppgavebundne nøkler er stabile (en oppgave-retry skal aldri duplisere); samtalebundne får et tidsvindu så en senere, bevisst gjentakelse ikke
  // stilltiende hoppes over for alltid (JARVIS-017: dedupe-rader utløp aldri).
  const scope = input.task_id !== undefined
    ? `task:${input.task_id}`
    : `${input.session_id ?? "adhoc"}:${Math.floor(nowMs / SESSION_IDEMPOTENCY_WINDOW_MS)}`;
  return createHash("sha256")
    .update(`${input.tenant_id}:${scope}:${call.tool_name}:${canonicalJson(call.arguments)}`)
    .digest("hex")
    .slice(0, 32);
}
