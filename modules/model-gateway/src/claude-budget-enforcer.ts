import type pg from "pg";
import { withTenantTransaction, writeAudit } from "@jarvis/core";
import type { ModelPurpose } from "@jarvis/contracts";
import { textOnly, type ModelRequest } from "@jarvis/provider-adapters";
import { isModelSelectable, type CatalogModel } from "./model-catalog.ts";
import { costOre, rateFor, type PricingTable } from "./pricing.ts";
import type { TraceSink } from "./trace.ts";
import {
  CLAUDE_BUDGET_PROVIDER, blockedMessageNo, budgetWindow, decide, deriveBudgetOrigin, pacingParamsOf, pacingState, tierFor,
  type BlockedKind, type BudgetOrigin, type BudgetTier, type BudgetWindow, type ClaudeBudgetConfig, type FailsafeReason, type PacingAction, type PacingDecision, type PacingLevel, type PacingReason, type PacingState
} from "./claude-budget.ts";

/**
 * WP-B4 (D-476): HÅNDHEVELSEN av Claude-kreditten. Den rene motoren (`claude-budget.ts`) sier hva som skal skje; denne filen leser forbruket (Anthropic-rader i `cost_events`, tenant-RLS), tar beslutningen
 * FØR leverandørvalg, reserverer konservativt for kall som er på vei (parallelle kall), logger (trace `kind: "budget"` + revisjonsrad - aldri innhold) og gir `ModelGateway` en billett som sier hva ruteren
 * skal få lov til. `ModelGateway` bruker den KUN når den er konstruert med en enforcer (`JARVIS_CLAUDE_BUDGET_USD` satt) - uten er ingenting av dette i bruk, og gatewayen er identisk med main.
 *
 * SENSITIVITET GÅR ALLTID FØRST: dette laget kan bare SNEVRE INN Anthropic (billigere modell, stengt) - aldri åpne noe. Ruteren filtrerer på sensitivitet/betalte modeller/helse som før, og et kall som
 * allerede ikke kan nå Anthropic (SECRET_RESTRICTED, `paid_models_allowed=false`, lokal modus, annen leverandør) kommer aldri hit (se `ModelGateway.mayReachClaude`).
 *
 * PARALLELLE KALL: sjekk og reservasjon skjer SYNKRONT rett etter at forbruket er lest, og hvert kall som kan nå Anthropic reserverer et konservativt anslag (tegn/3 inn, `max_tokens` ut, tak 5 % av
 * budsjettet) til det er ferdig bokført (`release` i `finally`; utløper uansett etter 5 minutter, så en lekkasje aldri stenger for alltid). Samtidige kall ved kanten ser derfor hverandres reservasjoner.
 * Rest-risiko (dokumentert): forbruket leses fra databasen, så et kall som ble bokført mellom en annen leses og dens synkrone sjekk kan telles én gang for lite (høyst ett kalls kost), og kall fra en
 * ANNEN prosess (api vs worker) ser ikke hverandres reservasjoner, bare bokført forbruk. Overskridelsen ved 100 % er derfor begrenset til anslaget for de kallene som var på vei samtidig, ikke ubegrenset.
 */

const MS_PER_DAY = 86_400_000;
const RESERVATION_TTL_MS = 5 * 60_000;
/** Frist for lesingen av forbruket per kall: en database som ikke svarer skal gi fail-safe (se `begin`), ikke la eierens tur vente for alltid. */
export const DEFAULT_SPEND_READ_TIMEOUT_MS = 3_000;
/**
 * WP-B4 (review M3): levetid for den leste summen per tenant og kredittperiode. Innenfor levetiden deler kall én lesing (en frisk database gjorde ellers opptil fire lesinger per verktøytur); kall fra DENNE prosessen
 * ses uansett fortsatt av overlegget (pågående reservasjoner + det hvert fullførte kall bokførte siden lesingen startet), så bufferen kan ikke slippe forbruket i denne prosessen forbi taket. Kun forbruk fra en ANNEN
 * prosess (api mot worker) er usynlig i inntil denne tiden - dokumentert rest-overskridelse. 0 = ingen buffer (hver beslutning leser).
 */
export const DEFAULT_SPEND_CACHE_TTL_MS = 3_000;
/** WP-B4 (review M3): etter en lesefeil eller utløpt frist hoppes lesingen over så lenge (fail-safe per tier gjelder i mellomtiden), så en hengende database koster ÉN frist - ikke én per kall - og holder ikke en pool-klient per kall. */
export const SPEND_FAILURE_COOLDOWN_MS = 30_000;

/** Venter på `promise`, men gir opp etter `ms` (feiler med `claude_spend_timeout`). Fristen ryddes alltid; en forsinket avvisning av det oppgitte løftet er håndtert (race abonnerer på begge). */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("claude_spend_timeout")), ms); });
  return Promise.race([promise, deadline]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
/** Ett kalls reservasjon kan aldri overstige dette av budsjettet (et gigantisk prompt skal ikke alene stenge alt). */
const RESERVATION_CAP_SHARE = 0.05;

export class ClaudeBudgetBlockedError extends Error {
  constructor(
    readonly kind: BlockedKind,
    readonly level: PacingLevel | "unknown",
    readonly tier: BudgetTier,
    readonly reason: string,
    readonly resume_at_ms: number | null,
    readonly window_end_ms: number
  ) {
    super(blockedMessageNo(kind, reason, resume_at_ms, window_end_ms));
    this.name = "ClaudeBudgetBlockedError";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Lesing av forbruket
// ---------------------------------------------------------------------------------------------------------------------

export interface ClaudeSpend {
  /** Anthropic-forbruk (øre) i inneværende kredittperiode. */
  window_ore: number;
  /** Forbruk (øre) siste `trailing_days` døgn (høyst 7, aldri før periodens start) - til prognosen. */
  trailing_ore: number;
  trailing_days: number;
}

function finiteNonNegative(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) throw new Error("claude_spend_invalid");
  return n;
}

/** Kun Anthropic-rader (`provider = 'anthropic'`) i perioden, under tenant-RLS. Mislykkede forsøk er 0 øre. Slutten er eksklusiv (en rad på nøyaktig fornyelsestidspunktet hører til neste periode). */
export async function readClaudeSpend(pool: pg.Pool, tenantId: string, window: BudgetWindow, nowMs: number): Promise<ClaudeSpend> {
  const trailingStart = Math.max(window.start_ms, nowMs - 7 * MS_PER_DAY);
  const result = await withTenantTransaction(pool, tenantId, (client) =>
    client.query(
      `SELECT coalesce(sum(amount_ore), 0)::float8 AS window_ore,
              coalesce(sum(amount_ore) FILTER (WHERE at >= $3), 0)::float8 AS trailing_ore
         FROM cost_events
        WHERE provider = $4 AND at >= $1 AND at < $2`,
      [new Date(window.start_ms), new Date(window.end_ms), new Date(trailingStart), CLAUDE_BUDGET_PROVIDER]
    )
  );
  const row = result.rows[0] as { window_ore?: unknown; trailing_ore?: unknown } | undefined;
  if (row === undefined) throw new Error("claude_spend_invalid");
  return { window_ore: finiteNonNegative(row.window_ore), trailing_ore: finiteNonNegative(row.trailing_ore), trailing_days: Math.max(0, (nowMs - trailingStart) / MS_PER_DAY) };
}

export interface ClaudeBudgetStatus {
  state: PacingState;
  spend: ClaudeSpend;
  window: BudgetWindow;
}

/** Tilstanden for flatene (kontrollsenter, brief, varsler): samme lesing og samme motor som håndhevelsen. Kaster ved lesefeil - flaten skal si «ukjent», aldri «i orden». */
export async function readClaudeBudgetState(pool: pg.Pool, tenantId: string, config: ClaudeBudgetConfig, nowMs: number): Promise<ClaudeBudgetStatus> {
  const window = budgetWindow(nowMs, config.reset_day);
  const spend = await readClaudeSpend(pool, tenantId, window, nowMs);
  const state = pacingState({ now: nowMs, budget_ore: config.budget_ore, spent_ore: spend.window_ore, params: pacingParamsOf(config), trailing: { spent_ore: spend.trailing_ore, days: spend.trailing_days } });
  return { state, spend, window };
}

// ---------------------------------------------------------------------------------------------------------------------
// Anslag og modellvalg
// ---------------------------------------------------------------------------------------------------------------------

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Antall tegn i ett meldingsinnhold; fiendtlig/ugyldig innhold (undefined, null, deler uten tekst, kastende objekter) teller 0 - aldri en feil. */
function contentLength(content: unknown): number {
  try {
    if (typeof content === "string") return content.length;
    if (!Array.isArray(content)) return 0;
    return textOnly(content.filter((part) => typeof part === "object" && part !== null) as never).length;
  } catch {
    return 0;
  }
}

const DEFAULT_MAX_TOKENS = 1024;

/** Størst mulig anslag for ett kall (taket); brukes også når anslaget ikke lar seg beregne (aldri 0 og aldri NaN). */
function reservationCap(budgetOre: number): number {
  const cap = Math.round(budgetOre * RESERVATION_CAP_SHARE);
  return Number.isFinite(cap) && cap >= 1 ? cap : 1;
}

/**
 * Konservativt kostnadsanslag (øre) for ett kall FØR det kjøres: innholdstegn / 3 som inn-tokens (en token er ca. 3-4 tegn), `max_tokens` (standard 1024) som ut-tokens, priset med satsen for modellen. Bilder
 * telles ikke (underestimat for vision). Brukes KUN til reservasjonen mot parallelle kall - den faktiske kostnaden bokføres fra leverandørens tokenregnskap som før.
 * L5 (review): kaster ALDRI og gir alltid et endelig tall mellom 0 og taket - fiendtlig innhold (`content: undefined`, manglende `messages`, sirkulære verktøy) teller 0 tegn, og en ugyldig `max_tokens`
 * (NaN, negativ, ikke-endelig, tekst) regnes som standarden; kan anslaget ikke beregnes, brukes taket (det mest konservative). Et NaN-anslag ville ellers gjort alle samtidige beslutninger til `on_pace`.
 */
export function estimateCallOre(pricing: PricingTable, provider: string, model: string, request: ModelRequest, budgetOre: number): number {
  const cap = reservationCap(budgetOre);
  try {
    const estimate = costOre(pricing, provider, model, { input_tokens: Math.ceil(requestChars(request) / 3), output_tokens: effectiveMaxTokens(request) });
    return Number.isFinite(estimate) && estimate >= 0 ? Math.min(estimate, cap) : cap;
  } catch {
    return cap;
  }
}

/** Antall tegn forespørselen sender (system, meldinger, verktøy, tidligere runder) - fiendtlige deler teller 0. Kan kaste for helt ugyldige objekter: kallerne fanger det. */
function requestChars(request: ModelRequest): number {
  let chars = typeof request.system === "string" ? request.system.length : 0;
  if (Array.isArray(request.messages)) for (const message of request.messages) chars += contentLength((message as { content?: unknown } | null | undefined)?.content);
  if (request.tools !== undefined) chars += jsonLength(request.tools);
  if (request.tool_exchanges !== undefined) chars += jsonLength(request.tool_exchanges);
  return chars;
}

function effectiveMaxTokens(request: ModelRequest): number {
  return typeof request.max_tokens === "number" && Number.isFinite(request.max_tokens) && request.max_tokens > 0 ? request.max_tokens : DEFAULT_MAX_TOKENS;
}

/**
 * WP-B4 (review L2): anslag (øre) for et AVBRUTT, utløpt eller feilet Anthropic-kall som er sendt, men aldri fikk et tokenregnskap fra leverandøren. Anthropic fakturerer input og det som ble generert før avbruddet,
 * så 0 øre (som før) ville underteller forbruket - taleavbrudd (barge-in) er hovedkilden. Anslaget er det samme som reservasjonen (tegn / 3 per token) men for det FAKTISK genererte: inn-tokens fra forespørselen +
 * ut-tokens fra tegnene som er strømmet til nå (aldri mer enn `max_tokens`). Et anslag, ikke fakturaen (en lokal modells ukjente tokentelling er uten betydning her: kun Anthropic bokføres slik).
 */
export function estimateFailedCallOre(pricing: PricingTable, provider: string, model: string, request: ModelRequest, generatedChars: number): number {
  try {
    const generated = typeof generatedChars === "number" && Number.isFinite(generatedChars) && generatedChars > 0 ? generatedChars : 0;
    const output = Math.min(Math.ceil(generated / 3), effectiveMaxTokens(request));
    const ore = costOre(pricing, provider, model, { input_tokens: Math.ceil(requestChars(request) / 3), output_tokens: output });
    return Number.isFinite(ore) && ore >= 0 ? ore : 0;
  } catch {
    return 0;
  }
}

/**
 * Billigste VALGBARE Anthropic-modell (eksplisitt pris eller leverandørens standardmodell, samme regel som modellrådgiveren, D-399) som er STRENGT billigere enn modellen kallet ellers ville brukt.
 * `null` = ingen billigere modell finnes (da beholdes modellen - aldri en modell uten pris, ellers ville forbruket bokføres til feil sats).
 */
export function cheaperClaudeModel(args: { pricing: PricingTable; catalog: readonly CatalogModel[]; provider_default_model?: string; effective_model: string }): string | null {
  const price = (model: string): number => {
    const rate = rateFor(args.pricing, CLAUDE_BUDGET_PROVIDER, model);
    return rate.input_per_1k_ore + rate.output_per_1k_ore;
  };
  const selectable = args.catalog
    .filter((m) => m.provider === CLAUDE_BUDGET_PROVIDER && isModelSelectable(m, args.pricing, args.provider_default_model))
    .map((m) => m.model)
    .sort((a, b) => price(a) - price(b) || a.localeCompare(b));
  const cheapest = selectable[0];
  return cheapest !== undefined && price(cheapest) < price(args.effective_model) ? cheapest : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Beslutning og billett
// ---------------------------------------------------------------------------------------------------------------------

export type PacingConstraint = "open" | "cheaper_model" | "closed";

/** Hvorfor en runde av en verktøytur ble avgjort uten ny vurdering (kun kategori i spor og revisjon). */
export type RoundRule = "continuation" | "earlier_round_closed";

export interface PacingVerdict {
  action: PacingAction;
  reason: PacingReason | FailsafeReason | "continuation_round_allowed";
  level: PacingLevel | "unknown";
  tier: BudgetTier;
  origin: BudgetOrigin;
  purpose: ModelPurpose | null;
  resume_at_ms: number | null;
  window: BudgetWindow;
}

/** Det gatewayen får ut av en beslutning. `release()` MÅ kalles når kallet er ferdig (idempotent). */
export class PacingTicket {
  private released = false;
  private booked = 0;

  constructor(
    readonly verdict: PacingVerdict,
    /** `closed`: Anthropic skal ikke brukes for dette kallet. `cheaper_model`: bruk `downgrade_model`. `open`: uendret. */
    readonly constraint: PacingConstraint,
    readonly downgrade_model: string | undefined,
    private readonly onRelease: (booked: number) => void
  ) {}

  /** Gatewayen melder hva kallet kostet (øre) idet det bokføres (også anslag for avbrutte kall): overlegget i enforceren bruker det til å se egne bokføringer før bufferen av forbruket er fornyet. */
  noteBooked(ore: number): void {
    if (Number.isFinite(ore) && ore > 0) this.booked += ore;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.onRelease(this.booked);
  }

  /** Feilen når kallet ikke kan betjenes uten Anthropic (ingen lokal modell). */
  blockedError(): ClaudeBudgetBlockedError {
    const kind: BlockedKind = this.verdict.action === "deny" ? "exhausted" : "deferred";
    return new ClaudeBudgetBlockedError(kind, this.verdict.level, this.verdict.tier, this.verdict.reason, this.verdict.resume_at_ms, this.verdict.window.end_ms);
  }

  /** Det som legges i `ModelResult.metadata.claude_budget` (kun kategorier - brukes til merknaden bak svaret). */
  resultMetadata(): Record<string, string | number | boolean> {
    return {
      action: this.verdict.action, level: this.verdict.level, tier: this.verdict.tier, reason: this.verdict.reason, constraint: this.constraint,
      window_end_ms: this.verdict.window.end_ms, ...(this.downgrade_model !== undefined ? { downgrade_model: this.downgrade_model } : {})
    };
  }
}

export interface PacingBeginInfo {
  tenant_id: string;
  session_id?: string;
  task_id?: string;
  purpose?: ModelPurpose;
  budget_origin?: unknown;
  request: ModelRequest;
  pricing: PricingTable;
  catalog: readonly CatalogModel[];
  /** Anthropic-adapterens konfigurerte standardmodell. */
  provider_default_model?: string;
  trace_id: string;
  started: number;
  /** WP-B4 (M1): hva GATEWAYEN vet om tidligere runder av denne verktøyturen. Settes kun av `ModelGateway.completeWithTools` - aldri fra en forespørsel (en `tool_exchanges` i forespørselen er bare data og åpner ingenting). */
  round?: PacingRoundContext;
}

/**
 * WP-B4 (M1): tilstanden til en verktøytur på tvers av runder, slik gatewayen selv har sett den (`ModelResult.provider` er stemplet av adapteren). To tilfeller:
 *  - `continuation_of`: en tidligere runde ble FAKTISK betjent av Anthropic (billetten er den siste slike runden). Å fullføre en påbegynt tur er ikke en ny beslutning: runden bærer billetten videre
 *    (samme modell/begrensning, uten ny lesing av forbruket). En billig modell blir værende billig; en åpen tur forblir åpen.
 *  - `closed_by`: en tidligere runde ble STENGT for Anthropic av kreditten (og betjent av noe annet). Resten av turen forblir stengt - en tur som startet lokalt går aldri tilbake til Anthropic midt i, selv om forbruket
 *    i mellomtiden ser ut til å ha rom, og verktøyresultater en lokal modell har fått se går dermed aldri videre til Anthropic.
 */
export interface PacingRoundContext {
  continuation_of?: PacingTicket;
  closed_by?: PacingTicket;
}

export interface ClaudeBudgetEnforcerOptions {
  config: ClaudeBudgetConfig;
  pool: pg.Pool;
  trace: TraceSink;
  /** Revisjonsraden skrives under eierens sovereign-autoritet (samme presedens som vakthunden, D-181): beslutningen er en deterministisk systemhandling på vegne av eieren. */
  actor_person_id: string;
  now?: () => number;
  /** Frist (ms) for lesingen av forbruket per kall; standard 3 s. Utløpt = uleselig forbruk = fail-safe. */
  spend_timeout_ms?: number;
  /** Levetid (ms) for bufferen av forbruket per tenant og periode (se `DEFAULT_SPEND_CACHE_TTL_MS`); standard 3 s, 0 = av. */
  spend_cache_ttl_ms?: number;
}

export class ClaudeBudgetEnforcer {
  readonly config: ClaudeBudgetConfig;
  /** Antall logg-/revisjonsskrivinger som feilet (isolert fra modellkallet; synlig for drift/tester). */
  logFailures = 0;
  private readonly inflight = new Map<string, Map<symbol, { ore: number; expires: number }>>();
  /** M3: sist leste forbruk per tenant (`at` = når lesingen STARTET), og når lesingen sist feilet (negativ buffer), og lesinger som pågår (enkeltflyt per tenant og periode). */
  private readonly spendCache = new Map<string, { window_start: number; at: number; spend: ClaudeSpend }>();
  private readonly readFailedUntil = new Map<string, number>();
  private readonly inflightReads = new Map<string, { promise: Promise<ClaudeSpend>; started: number }>();
  /** M3: det fullførte kall har bokført (øre, høyeste av reservasjonen og det bokførte) etter at lesingen startet - broen mellom en buffer og databasen. */
  private readonly settled = new Map<string, Array<{ ore: number; at: number }>>();
  private readonly now: () => number;

  constructor(private readonly opts: ClaudeBudgetEnforcerOptions) {
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
  }

  /** Sum av reservasjonene til kall som er på vei akkurat nå for tenanten (utløpte telles ikke). */
  inFlightOre(tenantId: string, nowMs: number = this.now()): number {
    const reservations = this.inflight.get(tenantId);
    if (reservations === undefined) return 0;
    let sum = 0;
    for (const [key, r] of reservations) {
      if (r.expires <= nowMs) reservations.delete(key);
      else sum += r.ore;
    }
    if (reservations.size === 0) this.inflight.delete(tenantId);
    return sum;
  }

  private reserve(tenantId: string, rawOre: number, nowMs: number): (booked: number) => void {
    // L5: en reservasjon er alltid et endelig tall ≥ 0 (et NaN-/negativt anslag ville forgiftet summen alle samtidige beslutninger bygger på)
    const ore = Number.isFinite(rawOre) && rawOre >= 0 ? rawOre : reservationCap(this.config.budget_ore);
    const key = Symbol("claude-budget-reservation");
    let reservations = this.inflight.get(tenantId);
    if (reservations === undefined) {
      reservations = new Map();
      this.inflight.set(tenantId, reservations);
    }
    reservations.set(key, { ore, expires: nowMs + RESERVATION_TTL_MS });
    return (booked: number) => {
      const current = this.inflight.get(tenantId);
      current?.delete(key);
      if (current !== undefined && current.size === 0) this.inflight.delete(tenantId);
      this.noteSettled(tenantId, Math.max(ore, Number.isFinite(booked) && booked > 0 ? booked : 0), this.now());
    };
  }

  private cacheTtl(): number {
    const ttl = this.opts.spend_cache_ttl_ms ?? DEFAULT_SPEND_CACHE_TTL_MS;
    return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
  }

  /** M3: et fullført kall (reservasjon eller det bokførte, det høyeste) legges til overlegget til bufferen av forbruket er fornyet. Uten buffer trengs det ikke (hver beslutning leser). */
  private noteSettled(tenantId: string, ore: number, at: number): void {
    const ttl = this.cacheTtl();
    if (ttl === 0 || !(ore > 0)) return;
    const kept = (this.settled.get(tenantId) ?? []).filter((entry) => entry.at > at - ttl);
    kept.push({ ore, at });
    this.settled.set(tenantId, kept);
  }

  private settledSince(tenantId: string, since: number): number {
    let sum = 0;
    for (const entry of this.settled.get(tenantId) ?? []) if (entry.at >= since) sum += entry.ore;
    return sum;
  }

  /**
   * M3: forbruket i perioden for tenanten - fra bufferen (levetid `spend_cache_ttl_ms`, samme kredittperiode), fra en lesing som allerede pågår (enkeltflyt), eller fra en ny lesing med frist. `null` = uleselig (feil, frist,
   * ugyldig svar, eller negativ buffer etter en nylig feil): kalleren tar fail-safe-beslutningen. `since` = når lesingen startet (overlegget teller det som er bokført etter det).
   */
  private async spendView(tenantId: string, window: BudgetWindow, nowMs: number): Promise<{ spend: ClaudeSpend; since: number } | null> {
    const failedUntil = this.readFailedUntil.get(tenantId);
    if (failedUntil !== undefined) {
      if (nowMs < failedUntil && failedUntil - nowMs <= SPEND_FAILURE_COOLDOWN_MS) return null; // negativ buffer: ingen ny lesing før den har utløpt
      this.readFailedUntil.delete(tenantId);
    }
    const ttl = this.cacheTtl();
    const cached = this.spendCache.get(tenantId);
    if (ttl > 0 && cached !== undefined && cached.window_start === window.start_ms && nowMs >= cached.at && nowMs - cached.at < ttl) return { spend: cached.spend, since: cached.at };
    const key = `${tenantId}|${window.start_ms}`;
    let flight = this.inflightReads.get(key);
    if (flight === undefined) {
      const created = { promise: readClaudeSpend(this.opts.pool, tenantId, window, nowMs), started: nowMs };
      flight = created;
      this.inflightReads.set(key, created);
      const done = (): void => { if (this.inflightReads.get(key) === created) this.inflightReads.delete(key); };
      created.promise.then(done, done); // en frist som utløper mens lesingen henger fjerner den ikke (se under), så den ryddes når den (om noen gang) svarer
    }
    try {
      const spend = await withDeadline(flight.promise, this.opts.spend_timeout_ms ?? DEFAULT_SPEND_READ_TIMEOUT_MS);
      if (ttl > 0) this.spendCache.set(tenantId, { window_start: window.start_ms, at: flight.started, spend });
      return { spend, since: flight.started };
    } catch (err) {
      if (this.inflightReads.get(key) === flight) this.inflightReads.delete(key); // en hengende lesing blokkerer aldri senere forsøk (etter den negative bufferen)
      this.spendCache.delete(tenantId);
      const first = !this.readFailedUntil.has(tenantId);
      this.readFailedUntil.set(tenantId, nowMs + SPEND_FAILURE_COOLDOWN_MS);
      if (first) console.error(JSON.stringify({ msg: "claude_budget_spend_unreadable", error: err instanceof Error ? err.name : "unknown", ...(err instanceof Error && err.message === "claude_spend_timeout" ? { timeout: true } : {}) }));
      return null;
    }
  }

  private failsafe(tier: BudgetTier, origin: BudgetOrigin, purpose: ModelPurpose | null, window: BudgetWindow): PacingVerdict {
    const base = { level: "unknown" as const, tier, origin, purpose, window };
    if (tier === "essential") return { ...base, action: "allow", reason: "spend_unreadable_essential_allowed", resume_at_ms: null };
    if (tier === "important") return { ...base, action: "downgrade", reason: "spend_unreadable_important_downgraded", resume_at_ms: null };
    return { ...base, action: "defer", reason: "spend_unreadable_background_deferred", resume_at_ms: null };
  }

  /**
   * ÉN beslutning for ETT modellkall. Kaster ALDRI: en lesefeil (eller en feil i motoren) gir fail-safe (ESSENSIELL tillates, VIKTIG nedgraderes, BAKGRUNN utsettes) - aldri et stoppet eiertur av en målefeil og
   * aldri ubegrenset bruk. Runder i en pågående verktøytur avgjøres av `info.round` (kun gatewayen setter den): en runde som fullfører en tur som ER påbegynt på Anthropic bærer billetten videre, og en tur
   * kreditten har stengt forblir stengt (se `PacingRoundContext`). Alt annet - også en forespørsel som bare HAR `tool_exchanges` - er en ny beslutning.
   */
  async begin(info: PacingBeginInfo): Promise<PacingTicket> {
    try {
      return await this.decideAndReserve(info);
    } catch (err) {
      // L5: begin() kaster ALDRI - heller ingen modellkall stoppet av en feil i selve styringen. En uventet feil (fiendtlig innputt, en bug) gir fail-safe etter tier, aldri en tillatelse uten grenser.
      return this.safetyTicket(info, err);
    }
  }

  /** Siste skanse når selve beslutningen feilet: fail-safe etter tier (ukjent tier = BAKGRUNN, den strengeste) uten å røre noe som kan kaste. */
  private safetyTicket(info: PacingBeginInfo, err: unknown): PacingTicket {
    console.error(JSON.stringify({ msg: "claude_budget_begin_failed", error: err instanceof Error ? err.name : "unknown" }));
    let origin: BudgetOrigin = "background";
    let tier: BudgetTier = "background";
    let purpose: ModelPurpose | null = null;
    try {
      origin = deriveBudgetOrigin(info);
      tier = tierFor(this.config.tiers, origin, info.purpose);
      purpose = info.purpose ?? null;
    } catch {
      origin = "background";
      tier = "background";
    }
    let window: BudgetWindow;
    try {
      window = budgetWindow(Date.now(), this.config.reset_day);
    } catch {
      window = { start_ms: 0, end_ms: 0, start_date: "", end_date: "" };
    }
    const verdict = this.failsafe(tier, origin, purpose, window);
    return new PacingTicket(verdict, verdict.action === "defer" || verdict.action === "deny" ? "closed" : "open", undefined, () => undefined);
  }

  private async decideAndReserve(info: PacingBeginInfo): Promise<PacingTicket> {
    const nowMs = this.now();
    const cfg = this.config;
    const origin = deriveBudgetOrigin(info);
    const tier = tierFor(cfg.tiers, origin, info.purpose);
    const purpose = info.purpose ?? null;
    const window = budgetWindow(nowMs, cfg.reset_day);

    const closedBy = info.round?.closed_by;
    if (closedBy !== undefined) {
      // M1: en tur som startet lokalt fordi kreditten stengte Anthropic forblir lokal (ingen ny lesing, ingen ny vurdering). Samme begrunnelse som runden som stengte den.
      const ticket = new PacingTicket({ ...closedBy.verdict, tier, origin, purpose }, "closed", undefined, () => undefined);
      await this.log(info, ticket, null, null, "earlier_round_closed");
      return ticket;
    }
    const continuationOf = info.round?.continuation_of;
    if (continuationOf !== undefined) {
      // M1/M3: en påbegynt tur på Anthropic fullføres. Ingen ny lesing av forbruket og ingen ny beslutning: runden bærer den forrige Anthropic-rundens billett (samme modell og begrensning).
      const carried = continuationOf.verdict;
      const verdict: PacingVerdict = { ...carried, tier, origin, purpose, reason: "continuation_round_allowed", window };
      const model = continuationOf.downgrade_model ?? info.request.model ?? info.provider_default_model ?? "";
      const release = this.reserve(info.tenant_id, estimateCallOre(info.pricing, CLAUDE_BUDGET_PROVIDER, model, info.request, cfg.budget_ore), nowMs);
      const ticket = new PacingTicket(verdict, continuationOf.constraint, continuationOf.downgrade_model, release);
      await this.log(info, ticket, null, null, "continuation");
      return ticket;
    }

    const view = await this.spendView(info.tenant_id, window, nowMs);
    const spend: ClaudeSpend | null = view === null ? null : view.spend;
    // Herfra til reservasjonen er alt SYNKRONT: samtidige kall i denne prosessen ser hverandres reservasjoner (atomisk sjekk-og-reserver).
    let verdict: PacingVerdict;
    let decision: PacingDecision | null = null;
    if (view === null || spend === null) {
      verdict = this.failsafe(tier, origin, purpose, window);
    } else {
      try {
        decision = decide({
          now: nowMs, budget_ore: cfg.budget_ore, spent_ore: spend.window_ore + this.inFlightOre(info.tenant_id, nowMs) + this.settledSince(info.tenant_id, view.since), tier, ...(info.purpose !== undefined ? { purpose: info.purpose } : {}),
          params: pacingParamsOf(cfg), trailing: { spent_ore: spend.trailing_ore, days: spend.trailing_days }
        });
        verdict = { action: decision.action, reason: decision.reason, level: decision.level, tier, origin, purpose, resume_at_ms: decision.resume_at_ms, window };
      } catch (err) {
        console.error(JSON.stringify({ msg: "claude_budget_decide_failed", error: err instanceof Error ? err.name : "unknown" }));
        decision = null;
        verdict = this.failsafe(tier, origin, purpose, window);
      }
    }

    let constraint: PacingConstraint = verdict.action === "defer" || verdict.action === "deny" ? "closed" : "open";
    let downgradeModel: string | undefined;
    if (verdict.action === "downgrade") {
      const cheaper = cheaperClaudeModel({
        pricing: info.pricing, catalog: info.catalog, ...(info.provider_default_model !== undefined ? { provider_default_model: info.provider_default_model } : {}),
        effective_model: info.request.model ?? info.provider_default_model ?? ""
      });
      if (cheaper !== null) {
        constraint = "cheaper_model";
        downgradeModel = cheaper;
      }
    }
    let release: (booked: number) => void = () => undefined;
    if (constraint !== "closed") {
      const model = downgradeModel ?? info.request.model ?? info.provider_default_model ?? "";
      release = this.reserve(info.tenant_id, estimateCallOre(info.pricing, CLAUDE_BUDGET_PROVIDER, model, info.request, cfg.budget_ore), nowMs);
    }
    const ticket = new PacingTicket(verdict, constraint, downgradeModel, release);
    await this.log(info, ticket, decision?.state ?? null, spend);
    return ticket;
  }

  /** Kategorier og tall - aldri prompt, svar, verktøyargumenter eller feiltekst. */
  private facts(ticket: PacingTicket, state: PacingState | null, spend: ClaudeSpend | null, roundRule?: RoundRule): Record<string, string | number | boolean | null> {
    const v = ticket.verdict;
    return {
      level: v.level, tier: v.tier, origin: v.origin, purpose: v.purpose ?? "UNSPECIFIED", action: v.action, reason: v.reason, constraint: ticket.constraint,
      ...(ticket.downgrade_model !== undefined ? { downgrade_model: ticket.downgrade_model } : {}), ...(roundRule !== undefined ? { round_rule: roundRule } : {}),
      window_start: v.window.start_date, window_end: v.window.end_date, budget_ore: this.config.budget_ore, spent_ore: spend === null ? null : Math.round(spend.window_ore),
      ...(state !== null ? { curve_ore: state.curve_ore, spent_pct: Math.round(state.spent_pct * 100) / 100, pace_ratio: state.pace_ratio === null ? null : Math.round(state.pace_ratio * 100) / 100 } : {})
    };
  }

  private async log(info: PacingBeginInfo, ticket: PacingTicket, state: PacingState | null, spend: ClaudeSpend | null, roundRule?: RoundRule): Promise<void> {
    const facts = this.facts(ticket, state, spend, roundRule);
    try {
      await this.opts.trace.record({
        trace_id: info.trace_id, kind: "budget", name: `claude_budget_${ticket.verdict.action}`, tenant_id: info.tenant_id,
        ...(info.session_id !== undefined ? { session_id: info.session_id } : {}), ...(info.task_id !== undefined ? { task_id: info.task_id } : {}),
        at: new Date(this.now()).toISOString(), duration_ms: Date.now() - info.started, metadata: facts
      });
    } catch (err) {
      this.logFailures += 1;
      console.error(JSON.stringify({ msg: "claude_budget_trace_failed", error: err instanceof Error ? err.name : "unknown" }));
    }
    // Revisjon kun når beslutningen gjorde noe (ikke-tillat), var fail-safe ELLER tillot forbruk over en oppbrukt kreditt (eierens override `HARD_STOP=off`: beviset på hvilke kall som gikk forbi kreditten).
    // En vanlig «tillat på tempo» er sporet i trace, ikke revisjon (ellers én rad per modellkall). Hver runde av en verktøytur er ett kall og revideres likt (også de som bærer en tidligere rundes billett).
    const v = ticket.verdict;
    if (v.action === "allow" && v.level !== "unknown" && v.level !== "exhausted") return;
    try {
      await withTenantTransaction(this.opts.pool, info.tenant_id, (client) =>
        writeAudit(
          client,
          { tenant_id: info.tenant_id, person_id: this.opts.actor_person_id, ...(info.session_id !== undefined ? { session_id: info.session_id } : {}) },
          {
            type: "claude_budget.decision", decision: v.action, reason: v.reason, tool_id: "claude_budget", action: "pacing", trace_id: info.trace_id,
            ...(info.task_id !== undefined ? { task_id: info.task_id } : {}), payload: facts
          }
        )
      );
    } catch (err) {
      this.logFailures += 1;
      console.error(JSON.stringify({ msg: "claude_budget_audit_failed", error: err instanceof Error ? err.name : "unknown" }));
    }
  }
}
