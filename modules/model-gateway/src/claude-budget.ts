import { ModelPurposeSchema, type ModelPurpose } from "@jarvis/contracts";
import { PRICING_NOK_PER_USD } from "./pricing.ts";

/**
 * WP-B4 (D-476): månedlig Claude-/Anthropic-budsjett (100 USD gratis kreditt) med TEMPOSTYRING og BEHOVSPRIORITERING.
 *
 * Eierens ordre (2026-11-16): «100 dollar gratis api hos Claude hver måned - pass på at jarvis bruker de fornuftig over måneden hver måned til ting som den trenger».
 * Eierens svar (Q-67, 2026-11-16): kreditten FORNYES DEN 15. HVER MÅNED, så «måneden» er perioden fra den 15. kl. 00:00 (Europe/Oslo) til neste 15. - 28 til 31 døgn, IKKE kalendermåneden.
 * Kurven, prognosen og dagsrommet bruker alltid den FAKTISKE periodelengden (skuddår og sommertid gir 28/29/30/31 døgn, ±1 time). Ved 100 % gjelder HARD STOPP av Anthropic (lokal fallback) til neste fornyelse.
 * Denne filen er den RENE tempomotoren: deterministisk, ingen I/O, injisert klokke. Håndhevelsen (lese forbruket, påvirke ruteren, logge) ligger i `claude-budget-enforcer.ts`, og
 * `ModelGateway` kobler den på KUN når `JARVIS_CLAUDE_BUDGET_USD` er satt - uten flagget finnes ingen av disse kodeveiene i bruk (identisk med main).
 *
 * Forholdet til `BudgetGuard` (D-395): BudgetGuard teller ALLE leverandører i UTC-måneden i øre (1000/2000/3000 kr) og er det YTRE vernet - det er uendret. Dette budsjettet gjelder KUN Anthropic
 * (kreditten er Anthropic-spesifikk), regnes i Europe/Oslo fra en konfigurerbar fornyelsesdag (standard 15.), og er et INDRE, mykere styringslag: det flytter bruk bort fra Anthropic (billigere modell, lokal
 * modell, utsettelse) FØR den harde grensen, og det stenger Anthropic helt først ved 100 % av kreditten.
 *
 * KURVEN. Tillatt kumulativt forbruk C(t) = min(P, M + (P − M) × f(t)), der B = budsjett, P = B × (1 − reserve) er tempobudsjettet, M = B × margin er en liten forhåndsmargin (så dag 1 ikke
 * starter på null) og f(t) er forløpt andel av vinduet. Ubrukt rom fra tidligere dager overføres automatisk (kurven er kumulativ). RESERVEN (standard 15 %) kan kun ESSENSIELLE behov bruke:
 * den ligger utenfor kurven hele perioden og er det som er igjen de siste dagene hvis tempobudsjettet er brukt opp.
 *
 * NIVÅER (forbruk S): `exhausted` S ≥ B · `tight` S ≥ P (inne i reserven) ELLER S > C × tempoforhold (standard 1,3) · `ahead` S > C · `on_pace` ellers.
 *
 * POLITIKK (nivå × tier):
 *   on_pace   : alt tillatt
 *   ahead     : BAKGRUNN → billigere modell (eller annen leverandør); ESSENSIELL/VIKTIG uendret
 *   tight     : ESSENSIELL tillatt; VIKTIG tillatt så lenge tempobudsjettet ikke er brukt opp (ellers utsatt - reserven er kun for ESSENSIELL); BAKGRUNN utsatt
 *   exhausted : alt avvist (Anthropic stengt) - med `hard_stop=off` fortsetter ESSENSIELL og VIKTIG (kun varsling), BAKGRUNN utsettes fortsatt
 *
 * FX: kreditten er i USD, forbruket bokføres i øre med prislistens kurs (`PRICING_NOK_PER_USD`, ca. 10,5 kr/USD, IKKE sanntid). Budsjettet omregnes med SAMME kurs, så de er sammenlignbare.
 */

export const CLAUDE_BUDGET_PROVIDER = "anthropic";
export const CLAUDE_BUDGET_TIME_ZONE = "Europe/Oslo";

export const BUDGET_TIERS = ["essential", "important", "background"] as const;
export type BudgetTier = (typeof BUDGET_TIERS)[number];

/** Hvem som ber om kallet: eierens egen tur (chat/tale), en jobb eieren bestilte, eller bakgrunnsarbeid Jarvis selv driver. */
export const BUDGET_ORIGINS = ["owner_turn", "owner_task", "background"] as const;
export type BudgetOrigin = (typeof BUDGET_ORIGINS)[number];

export const PACING_LEVELS = ["on_pace", "ahead", "tight", "exhausted"] as const;
export type PacingLevel = (typeof PACING_LEVELS)[number];

export type PacingAction = "allow" | "downgrade" | "defer" | "deny";

export type PacingReason =
  | "within_curve"
  | "ahead_allowed"
  | "ahead_background_downgrade"
  | "tight_essential_allowed"
  | "tight_important_allowed"
  | "tight_background_deferred"
  | "reserve_kept_for_essential"
  | "exhausted_closed"
  | "exhausted_hard_stop_off"
  | "exhausted_hard_stop_off_background_deferred";

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------------
// Konfigurasjon (miljø) - ugyldig verdi = feil ved oppstart, aldri en stille rar verdi
// ---------------------------------------------------------------------------------------------------------------------

export class InvalidClaudeBudgetConfigError extends Error {
  constructor(readonly variable: string, detail: string) {
    super(`ugyldig ${variable}: ${detail}`);
    this.name = "InvalidClaudeBudgetConfigError";
  }
}

export interface PacingParams {
  /** Andel av budsjettet (prosent) som kun ESSENSIELLE behov kan bruke. */
  reserve_pct: number;
  /** Forhåndsmargin (prosent av budsjettet) som er tillatt allerede ved vinduets start. */
  margin_pct: number;
  /** Forbruk over kurven × dette gir nivået `tight`. */
  tight_ratio: number;
  /** `false` = fortsett over 100 % (kun varsling). */
  hard_stop: boolean;
  /** Dag i måneden (1-31, avkortet til månedens siste dag) kreditten fornyes. Standard 15 (eierens Anthropic-kreditt fornyes den 15., Q-67). */
  reset_day: number;
}

export const DEFAULT_PACING_PARAMS: PacingParams = { reserve_pct: 15, margin_pct: 5, tight_ratio: 1.3, hard_stop: true, reset_day: 15 };
export const DEFAULT_ALERT_PCTS: readonly number[] = [50, 75, 90, 100];

/** Kun tempoparametrene (uten budsjett, terskler og tabell) - det `decide`/`pacingState` tar inn. */
export function pacingParamsOf(config: PacingParams): PacingParams {
  return { reserve_pct: config.reserve_pct, margin_pct: config.margin_pct, tight_ratio: config.tight_ratio, hard_stop: config.hard_stop, reset_day: config.reset_day };
}

/**
 * Når forbruket ikke kan leses (databasefeil, ugyldig svar) tas beslutningen UTEN tall (fail-safe): ESSENSIELL tillates (eierens egne turer skal ikke stoppe av en målefeil), VIKTIG nedgraderes
 * (billigere modell, ingen stopp), BAKGRUNN utsettes. Samme tre årsaker brukes av håndhevelsen (`claude-budget-enforcer.ts`).
 */
export type FailsafeReason = "spend_unreadable_essential_allowed" | "spend_unreadable_important_downgraded" | "spend_unreadable_background_deferred";

export type TierTable = Readonly<Record<BudgetOrigin, Readonly<Record<string, BudgetTier>>>>;

export interface ClaudeBudgetConfig extends PacingParams {
  budget_usd: number;
  /** `budget_usd` × `PRICING_NOK_PER_USD` × 100, avrundet. */
  budget_ore: number;
  nok_per_usd: number;
  alert_pcts: readonly number[];
  tiers: TierTable;
}

/** Nøkkelen for et kall uten `purpose` (eldre kallere). */
export const UNSPECIFIED_PURPOSE = "UNSPECIFIED";
const PURPOSE_KEYS: readonly string[] = [...ModelPurposeSchema.options, UNSPECIFIED_PURPOSE];

function buildDefaultTierTable(): TierTable {
  const ownerTurn: Record<string, BudgetTier> = {};
  const ownerTask: Record<string, BudgetTier> = {};
  const background: Record<string, BudgetTier> = {};
  const essentialInTurn = new Set<string>(["CHAT", "CODE", "REASON", "PLAN", "RESEARCH", "VISION", UNSPECIFIED_PURPOSE]);
  for (const key of PURPOSE_KEYS) {
    // Eierens egen tur: det eieren selv ba om er ESSENSIELT; en kritikk/andre-mening er VIKTIG; minneuttrekk, sammendrag og klassifisering er bakgrunnsarbeid selv om de bærer økt-id.
    ownerTurn[key] = essentialInTurn.has(key) ? "essential" : key === "CRITIQUE" ? "important" : "background";
    // En jobb eieren bestilte er VIKTIG uansett formål (jobbkontrakten merker den «BACKGROUND» bare som køetikett).
    ownerTask[key] = "important";
    background[key] = "background";
  }
  return { owner_turn: ownerTurn, owner_task: ownerTask, background };
}

export const DEFAULT_TIER_TABLE: TierTable = buildDefaultTierTable();

const TIER_OVERRIDE = /^(owner_turn|owner_task|background)\.([A-Za-z_]+)=(essential|important|background)$/i;

/** `JARVIS_CLAUDE_BUDGET_TIERS=owner_turn.CODE=important,background.VISION=important` - ukjent opprinnelse/formål/tier, duplikat eller feil form = feil (aldri en stille rar tabell). */
export function parseTierOverrides(raw: string | undefined, base: TierTable = DEFAULT_TIER_TABLE): TierTable {
  const value = (raw ?? "").trim();
  if (value === "") return base;
  const next: Record<BudgetOrigin, Record<string, BudgetTier>> = {
    owner_turn: { ...base.owner_turn }, owner_task: { ...base.owner_task }, background: { ...base.background }
  };
  const seen = new Set<string>();
  for (const token of value.split(",").map((t) => t.trim()).filter((t) => t !== "")) {
    const m = TIER_OVERRIDE.exec(token);
    if (!m) throw new InvalidClaudeBudgetConfigError("JARVIS_CLAUDE_BUDGET_TIERS", `«${token.slice(0, 40)}» må ha formen opphav.FORMÅL=tier (opphav: ${BUDGET_ORIGINS.join("/")}, tier: ${BUDGET_TIERS.join("/")})`);
    const origin = (m[1] as string).toLowerCase() as BudgetOrigin;
    const purpose = (m[2] as string).toUpperCase();
    const tier = (m[3] as string).toLowerCase() as BudgetTier;
    if (!PURPOSE_KEYS.includes(purpose)) throw new InvalidClaudeBudgetConfigError("JARVIS_CLAUDE_BUDGET_TIERS", `ukjent formål «${purpose.slice(0, 30)}» (gyldige: ${PURPOSE_KEYS.join(", ")})`);
    const key = `${origin}.${purpose}`;
    if (seen.has(key)) throw new InvalidClaudeBudgetConfigError("JARVIS_CLAUDE_BUDGET_TIERS", `${key} er oppgitt to ganger`);
    seen.add(key);
    next[origin][purpose] = tier;
  }
  return next;
}

function readBounded(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, bounds: { min: number; max: number; integer: boolean }): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const text = raw.trim();
  const pattern = bounds.integer ? /^\d{1,4}$/ : /^\d{1,2}(?:\.\d{1,2})?$/;
  const parsed = pattern.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new InvalidClaudeBudgetConfigError(name, `«${text.slice(0, 20)}» må være ${bounds.integer ? "et heltall" : "et tall"} mellom ${bounds.min} og ${bounds.max}`);
  }
  return parsed;
}

function parseAlertPcts(env: Readonly<Record<string, string | undefined>>): readonly number[] {
  const raw = env["JARVIS_CLAUDE_BUDGET_ALERT_PCTS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_ALERT_PCTS;
  const parts = raw.split(",").map((p) => p.trim());
  const values = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  const ok = values.length >= 1 && values.length <= 8 && values.every((v, i) => Number.isInteger(v) && v >= 1 && v <= 100 && (i === 0 || v > (values[i - 1] as number)));
  if (!ok) throw new InvalidClaudeBudgetConfigError("JARVIS_CLAUDE_BUDGET_ALERT_PCTS", `«${raw.trim().slice(0, 30)}» må være 1-8 stigende heltall mellom 1 og 100, skilt med komma`);
  return values;
}

/**
 * Leser budsjettkonfigurasjonen. `null` = AV (variabelen `JARVIS_CLAUDE_BUDGET_USD` er tom/usatt/`off`) - da finnes ingen tempostyring og alt er identisk med main. Ugyldig verdi KASTER
 * (`InvalidClaudeBudgetConfigError`) slik at api og worker feiler ved oppstart; «0» er ugyldig (bruk `off`), fordi det ellers enten stille ville slått av styringen eller stengt Anthropic helt.
 * De øvrige variablene leses KUN når budsjettet er på (uten budsjett har de ingen virkning).
 */
export function claudeBudgetConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ClaudeBudgetConfig | null {
  const rawUsd = (env["JARVIS_CLAUDE_BUDGET_USD"] ?? "").trim();
  if (rawUsd === "" || /^off$/i.test(rawUsd)) return null;
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(rawUsd) || !(Number(rawUsd) > 0) || Number(rawUsd) > 100_000) {
    throw new InvalidClaudeBudgetConfigError("JARVIS_CLAUDE_BUDGET_USD", `«${rawUsd.slice(0, 20)}» må være et positivt tall i USD (høyst to desimaler, over 0 og høyst 100000) - eller «off» for å slå styringen av`);
  }
  const budget_usd = Number(rawUsd);
  const rawStop = (env["JARVIS_CLAUDE_BUDGET_HARD_STOP"] ?? "").trim().toLowerCase();
  if (rawStop !== "" && rawStop !== "on" && rawStop !== "off") {
    throw new InvalidClaudeBudgetConfigError("JARVIS_CLAUDE_BUDGET_HARD_STOP", `«${rawStop.slice(0, 20)}» må være «on» eller «off»`);
  }
  return {
    budget_usd,
    budget_ore: Math.round(budget_usd * PRICING_NOK_PER_USD * 100),
    nok_per_usd: PRICING_NOK_PER_USD,
    reset_day: readBounded(env, "JARVIS_CLAUDE_BUDGET_RESET_DAY", DEFAULT_PACING_PARAMS.reset_day, { min: 1, max: 31, integer: true }),
    reserve_pct: readBounded(env, "JARVIS_CLAUDE_BUDGET_RESERVE_PCT", DEFAULT_PACING_PARAMS.reserve_pct, { min: 0, max: 50, integer: true }),
    margin_pct: readBounded(env, "JARVIS_CLAUDE_BUDGET_MARGIN_PCT", DEFAULT_PACING_PARAMS.margin_pct, { min: 0, max: 20, integer: true }),
    tight_ratio: readBounded(env, "JARVIS_CLAUDE_BUDGET_TIGHT_RATIO", DEFAULT_PACING_PARAMS.tight_ratio, { min: 1.05, max: 5, integer: false }),
    hard_stop: rawStop !== "off",
    alert_pcts: parseAlertPcts(env),
    tiers: parseTierOverrides(env["JARVIS_CLAUDE_BUDGET_TIERS"])
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Behovsprioritering: formål (+ opphav) → tier
// ---------------------------------------------------------------------------------------------------------------------

const ORIGIN_SET: ReadonlySet<string> = new Set(BUDGET_ORIGINS);

/** Gyldig opphavs-hint fra kalleren, ellers `undefined` (en ukjent verdi ignoreres aldri stille til noe annet enn utledning). */
export function asBudgetOrigin(value: unknown): BudgetOrigin | undefined {
  return typeof value === "string" && ORIGIN_SET.has(value) ? (value as BudgetOrigin) : undefined;
}

/**
 * Opphav: eksplisitt hint fra en betrodd kaller vinner (delegerte jobber, AI-råd); ellers utledes det: et kall med jobb-id er bakgrunnsarbeid, et kall i en økt uten jobb er en eier-tur, resten er bakgrunn.
 * Utledningen er bevisst grov - tiertabellen er ENDELIG avgjørende (minneuttrekk og sammendrag bærer økt-id, men har et bakgrunnsformål).
 */
export function deriveBudgetOrigin(input: { budget_origin?: unknown; task_id?: string | undefined; session_id?: string | undefined }): BudgetOrigin {
  const hint = asBudgetOrigin(input.budget_origin);
  if (hint !== undefined) return hint;
  if (input.task_id !== undefined) return "background";
  if (input.session_id !== undefined) return "owner_turn";
  return "background";
}

export function tierFor(table: TierTable, origin: BudgetOrigin, purpose: ModelPurpose | string | undefined): BudgetTier {
  const row = table[origin];
  return row[purpose ?? UNSPECIFIED_PURPOSE] ?? row[UNSPECIFIED_PURPOSE] ?? "background";
}

/** Tiertabellen som rader (for runbook/kontrollsenter): ett formål per rad, tier per opphav. */
export function tierTableRows(table: TierTable): Array<{ purpose: string } & Record<BudgetOrigin, BudgetTier>> {
  return PURPOSE_KEYS.map((purpose) => ({ purpose, owner_turn: tierFor(table, "owner_turn", purpose), owner_task: tierFor(table, "owner_task", purpose), background: tierFor(table, "background", purpose) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Tid: budsjettvindu i Europe/Oslo (månedsskifte, skuddår og sommertid)
// ---------------------------------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** Klokkeslett/dato slik de leses i `timeZone` på det gitte UTC-tidspunktet. */
export function localParts(utcMs: number, timeZone: string = CLAUDE_BUDGET_TIME_ZONE): LocalParts {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const p = localParts(utcMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** UTC-tidspunktet da klokka i `timeZone` er 00:00:00 den gitte datoen. To pass håndterer sommertidsovergangen (som i Norge skjer kl. 01:00 UTC, aldri ved lokal midnatt). */
export function zonedMidnightUtcMs(year: number, month: number, day: number, timeZone: string = CLAUDE_BUDGET_TIME_ZONE): number {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const first = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(first, timeZone);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export interface BudgetWindow {
  start_ms: number;
  end_ms: number;
  /** Lokal (Europe/Oslo) dato for vinduets start/slutt: `YYYY-MM-DD`. Slutten er fornyelsestidspunktet (eksklusiv). */
  start_date: string;
  end_date: string;
}

/**
 * Det løpende budsjettvinduet (kredittperioden): fra siste fornyelse (`reset_day` kl. 00:00 Europe/Oslo) til neste - med standard 15. er det 15. til 15., altså 28-31 døgn (±1 time ved sommertid), IKKE kalendermåneden.
 * En fornyelsesdag som ikke finnes i måneden (f.eks. 31 i februar) avkortes til månedens siste dag.
 * Hele beregningen går på UTC-tidspunkter, så skuddår og sommertid (23/25-timers døgn) gir riktige vinduer.
 */
export function budgetWindow(nowMs: number, resetDay: number, timeZone: string = CLAUDE_BUDGET_TIME_ZONE): BudgetWindow {
  const here = localParts(nowMs, timeZone);
  const startOf = (year: number, month: number): { ms: number; date: string } => {
    const day = Math.min(resetDay, daysInMonth(year, month));
    return { ms: zonedMidnightUtcMs(year, month, day, timeZone), date: `${year}-${pad2(month)}-${pad2(day)}` };
  };
  let y = here.year;
  let m = here.month;
  let start = startOf(y, m);
  if (nowMs < start.ms) {
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
    start = startOf(y, m);
  }
  let ny = y;
  let nm = m + 1;
  if (nm === 13) { nm = 1; ny += 1; }
  const end = startOf(ny, nm);
  return { start_ms: start.ms, end_ms: end.ms, start_date: start.date, end_date: end.date };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tilstand og beslutning (ren)
// ---------------------------------------------------------------------------------------------------------------------

export interface PacingStateInput {
  now: number | Date;
  budget_ore: number;
  /** Anthropic-forbruk (øre) i inneværende vindu - inkludert eventuelle pågående kalls reservasjon (konservativt). */
  spent_ore: number;
  params?: Partial<PacingParams>;
  /** Forbruk siste døgn-vindu (typisk 7 d) til prognosen: `spent_ore` over `days` døgn. Utelatt = snitt for hele vinduet så langt. */
  trailing?: { spent_ore: number; days: number };
}

export interface PacingState {
  level: PacingLevel;
  window: BudgetWindow & { days_total: number; elapsed_fraction: number; elapsed_days: number; days_left: number; days_left_whole: number; day_of_window: number };
  budget_ore: number;
  spent_ore: number;
  spent_pct: number;
  /** P = budsjett × (1 − reserve): det som fordeles jevnt over perioden. */
  pacing_budget_ore: number;
  reserve_ore: number;
  /** C(t): tillatt kumulativt forbruk nå. */
  curve_ore: number;
  /** C(t) − forbruk: positivt = under kurven (rom), negativt = foran kurven. */
  room_to_curve_ore: number;
  remaining_ore: number;
  /** Forbruk / kurve (null når kurven er 0). */
  pace_ratio: number | null;
  /** Rest av tempobudsjettet fordelt på gjenstående døgn (avrundet opp). */
  daily_room_ore: number;
  /** Rest av HELE budsjettet (inkl. reserven) fordelt på gjenstående døgn. */
  daily_room_incl_reserve_ore: number;
  /** Forventet forbruk ved vindusslutt (null med under ett døgns data). */
  forecast_end_ore: number | null;
  forecast_pct: number | null;
  in_reserve: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function pacingState(input: PacingStateInput): PacingState {
  const params: PacingParams = { ...DEFAULT_PACING_PARAMS, ...input.params };
  const nowMs = input.now instanceof Date ? input.now.getTime() : input.now;
  const w = budgetWindow(nowMs, params.reset_day);
  const length = w.end_ms - w.start_ms;
  const elapsedMs = clamp(nowMs - w.start_ms, 0, length);
  const fraction = elapsedMs / length;
  const B = Math.max(0, Math.round(input.budget_ore));
  const S = Math.max(0, Math.round(input.spent_ore));
  const P = Math.round((B * (100 - params.reserve_pct)) / 100);
  const M = Math.min(P, Math.round((B * params.margin_pct) / 100));
  const C = Math.min(P, Math.round(M + (P - M) * fraction));
  const inReserve = S >= P;
  let level: PacingLevel;
  if (S >= B) level = "exhausted";
  else if (inReserve || S > C * params.tight_ratio) level = "tight";
  else if (S > C) level = "ahead";
  else level = "on_pace";

  const elapsedDays = elapsedMs / MS_PER_DAY;
  const daysLeft = (length - elapsedMs) / MS_PER_DAY;
  const daysLeftWhole = Math.max(1, Math.ceil(daysLeft - 1e-9));
  let dailyRate: number | null = null;
  if (input.trailing !== undefined && input.trailing.days >= 1) dailyRate = input.trailing.spent_ore / input.trailing.days;
  else if (elapsedDays >= 1) dailyRate = S / elapsedDays;
  const forecast = dailyRate === null ? null : Math.round(S + dailyRate * Math.max(0, daysLeft));
  return {
    level,
    window: { ...w, days_total: Math.round(length / MS_PER_DAY), elapsed_fraction: fraction, elapsed_days: elapsedDays, days_left: daysLeft, days_left_whole: daysLeftWhole, day_of_window: Math.floor(elapsedDays) + 1 },
    budget_ore: B,
    spent_ore: S,
    spent_pct: B === 0 ? 0 : (S / B) * 100,
    pacing_budget_ore: P,
    reserve_ore: B - P,
    curve_ore: C,
    room_to_curve_ore: C - S,
    remaining_ore: B - S,
    pace_ratio: C > 0 ? S / C : null,
    daily_room_ore: Math.round(Math.max(0, P - S) / daysLeftWhole),
    daily_room_incl_reserve_ore: Math.round(Math.max(0, B - S) / daysLeftWhole),
    forecast_end_ore: forecast,
    forecast_pct: forecast === null || B === 0 ? null : (forecast / B) * 100,
    in_reserve: inReserve
  };
}

/** Når (UTC ms) kurven har tatt igjen forbruket slik at `forbruk ≤ forhold × kurve`, uten mer forbruk. `now` hvis det allerede gjelder; `null` hvis det ikke skjer i dette vinduet. */
export function resumeAtMs(state: PacingState, params: Pick<PacingParams, "reserve_pct" | "margin_pct">, ratio: number, nowMs: number): number | null {
  const B = state.budget_ore;
  const P = state.pacing_budget_ore;
  const M = Math.min(P, Math.round((B * params.margin_pct) / 100));
  const target = state.spent_ore / ratio;
  if (target <= state.curve_ore) return nowMs;
  if (target > P || P === M) return null;
  const f = (target - M) / (P - M);
  const t = state.window.start_ms + f * (state.window.end_ms - state.window.start_ms);
  return Math.max(nowMs, Math.ceil(t));
}

export interface DecideInput extends PacingStateInput {
  /** Eksplisitt tier. Utelatt = utledes av `origin` + `purpose` og tiertabellen. */
  tier?: BudgetTier;
  purpose?: ModelPurpose;
  origin?: BudgetOrigin;
  tiers?: TierTable;
}

export interface PacingDecision {
  action: PacingAction;
  reason: PacingReason;
  level: PacingLevel;
  tier: BudgetTier;
  purpose: ModelPurpose | null;
  state: PacingState;
  /** Tidligste tidspunkt (UTC ms) det vil bli rom igjen for denne typen kall hvis forbruket stanser - `null` = ikke før kreditten fornyes. */
  resume_at_ms: number | null;
}

function policy(level: PacingLevel, tier: BudgetTier, inReserve: boolean, hardStop: boolean): { action: PacingAction; reason: PacingReason } {
  switch (level) {
    case "on_pace":
      return { action: "allow", reason: "within_curve" };
    case "ahead":
      return tier === "background" ? { action: "downgrade", reason: "ahead_background_downgrade" } : { action: "allow", reason: "ahead_allowed" };
    case "tight":
      if (tier === "essential") return { action: "allow", reason: "tight_essential_allowed" };
      if (tier === "important") return inReserve ? { action: "defer", reason: "reserve_kept_for_essential" } : { action: "allow", reason: "tight_important_allowed" };
      return { action: "defer", reason: "tight_background_deferred" };
    case "exhausted":
      if (hardStop) return { action: "deny", reason: "exhausted_closed" };
      return tier === "background" ? { action: "defer", reason: "exhausted_hard_stop_off_background_deferred" } : { action: "allow", reason: "exhausted_hard_stop_off" };
  }
}

/**
 * ÉN beslutning: allow | downgrade (billigere modell eller annen leverandør) | defer (utsett - det kan vente) | deny (Anthropic er stengt). Ren funksjon av tid, forbruk, tier og parametre.
 * Sensitivitetsrutingen er IKKE en del av dette: den går alltid foran og avgjøres i ruteren (private/helse/finans-turer forblir lokale uansett hva dette sier).
 */
export function decide(input: DecideInput): PacingDecision {
  const params: PacingParams = { ...DEFAULT_PACING_PARAMS, ...input.params };
  const nowMs = input.now instanceof Date ? input.now.getTime() : input.now;
  const state = pacingState({ ...input, params, now: nowMs });
  const tier = input.tier ?? tierFor(input.tiers ?? DEFAULT_TIER_TABLE, input.origin ?? "owner_turn", input.purpose);
  const { action, reason } = policy(state.level, tier, state.in_reserve, params.hard_stop);
  let resume: number | null = null;
  if (action === "defer" && !state.in_reserve && state.level !== "exhausted") resume = resumeAtMs(state, params, params.tight_ratio, nowMs);
  else if (action === "deny" || (action === "defer" && (state.in_reserve || state.level === "exhausted"))) resume = state.window.end_ms;
  return { action, reason, level: state.level, tier, purpose: input.purpose ?? null, state, resume_at_ms: resume };
}

// ---------------------------------------------------------------------------------------------------------------------
// Varsler: terskler som er passert (idempotensen - én gang per terskel per kredittperiode - ligger i varslerens revisjonsmarkør)
// ---------------------------------------------------------------------------------------------------------------------

/** Nøkler for terskler som er passert nå (`pct:50`, ..., `pace`). Rekkefølgen er stigende; `pace` sist. */
export function dueAlertKeys(state: PacingState, config: Pick<ClaudeBudgetConfig, "alert_pcts" | "tight_ratio">): string[] {
  const keys = config.alert_pcts.filter((pct) => state.spent_pct >= pct).map((pct) => `pct:${pct}`);
  if (state.pace_ratio !== null && state.pace_ratio > config.tight_ratio && state.level !== "exhausted") keys.push("pace");
  return keys;
}

// ---------------------------------------------------------------------------------------------------------------------
// Norsk tekst (kun kategorier og tall - aldri innhold). Chat-synlige tekster unngår ord sensitivitetsklassifiseringen reagerer på (budsjett, betaling, osv.)
// ---------------------------------------------------------------------------------------------------------------------

export const LEVEL_LABEL_NO: Readonly<Record<PacingLevel, string>> = { on_pace: "på tempo", ahead: "foran tempo", tight: "stramt", exhausted: "oppbrukt" };
export const TIER_LABEL_NO: Readonly<Record<BudgetTier, string>> = { essential: "essensiell", important: "viktig", background: "bakgrunn" };

export function formatUsdNo(ore: number, nokPerUsd: number = PRICING_NOK_PER_USD): string {
  return (ore / (nokPerUsd * 100)).toFixed(2).replace(".", ",");
}

export function formatKrNo(ore: number): string {
  return `${(ore / 100).toFixed(0)} kr`;
}

export function formatDateNo(ms: number, timeZone: string = CLAUDE_BUDGET_TIME_ZONE): string {
  return new Intl.DateTimeFormat("nb-NO", { timeZone, day: "numeric", month: "long" }).format(new Date(ms));
}

export function formatDateTimeNo(ms: number, timeZone: string = CLAUDE_BUDGET_TIME_ZONE): string {
  return new Intl.DateTimeFormat("nb-NO", { timeZone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

/** Én linje om tilstanden til eieren (brief, varsel, kontrollsenter). Inneholder beløp - skal ALDRI sendes til en skymodell (Q-64). */
export function describeStateNo(state: PacingState, config: Pick<ClaudeBudgetConfig, "nok_per_usd" | "budget_usd">): string {
  const usd = (ore: number): string => formatUsdNo(ore, config.nok_per_usd);
  const base = `Claude-kreditten: ${usd(state.spent_ore)} av ${config.budget_usd.toFixed(2).replace(".", ",")} USD brukt (${Math.round(state.spent_pct)} %, ca. ${formatKrNo(state.spent_ore)}) - ${LEVEL_LABEL_NO[state.level]}. Dag ${state.window.day_of_window} av ${state.window.days_total}`;
  const room = state.level === "exhausted" ? "" : `, rom ca. ${usd(state.daily_room_ore)} USD per døgn`;
  const forecast = state.forecast_pct === null ? "" : `, prognose ved fornyelsen ${Math.round(state.forecast_pct)} %`;
  return `${base}${room}${forecast}.`;
}

export type BlockedKind = "deferred" | "exhausted";

/**
 * Teksten eieren får når det ikke finnes noe lokalt alternativ. Uten beløp og uten ord klassifiseringen reagerer på (teksten lagres i samtalen). `resumeMs` er null = «ved fornyelsen».
 */
export function blockedMessageNo(kind: BlockedKind, reason: string, resumeMs: number | null, windowEndMs: number): string {
  const resetText = `Kreditten fornyes ${formatDateNo(windowEndMs)}.`;
  if (kind === "exhausted") {
    return `Claude-kreditten for perioden er brukt opp, så Anthropic er stengt til neste fornyelse, og ingen lokal modell kunne svare i stedet. ${resetText} Du kan heve grensen med JARVIS_CLAUDE_BUDGET_USD eller skru av hardstoppen med JARVIS_CLAUDE_BUDGET_HARD_STOP=off.`;
  }
  if (reason === "reserve_kept_for_essential") {
    return `Resten av Claude-kreditten er forbeholdt det aller viktigste ut perioden, så dette kallet er utsatt, og ingen lokal modell kunne svare i stedet. ${resetText}`;
  }
  if (reason === "spend_unreadable_background_deferred") {
    return "Forbruket av Claude-kreditten kunne ikke leses akkurat nå, så dette kallet er utsatt, og ingen lokal modell kunne svare i stedet. Prøv igjen om litt.";
  }
  if (reason === "exhausted_hard_stop_off_background_deferred") {
    // hardstoppen er AV: egne turer og bestilte jobber går fortsatt på Claude, men bakgrunnsarbeid venter til fornyelsen
    return `Claude-kreditten for perioden er brukt opp, og hardstoppen er av, så bakgrunnsarbeid på Claude er utsatt til fornyelsen, og ingen lokal modell kunne svare i stedet. ${resetText}`;
  }
  const until = resumeMs !== null && resumeMs < windowEndMs ? ` Det blir rom igjen omtrent ${formatDateTimeNo(resumeMs)}.` : ` ${resetText}`;
  return `Claude-bruken ligger foran periodens tempo, så dette kallet er utsatt, og ingen lokal modell kunne svare i stedet.${until}`;
}

/** Starten på hver merknad bak et svar som Claude-kreditten har styrt bort fra Anthropic. Står i `SYSTEM_NOTE_PREFIXES` (tool-turn-route.ts), så merknaden fjernes fra historikken før den klassifiseres eller sendes til en modell. */
export const CLAUDE_BUDGET_NOTE_PREFIX = "Claude-kreditten:";

/**
 * Merknaden bak et svar (eller en jobb) som kom fra lokal modell fordi Claude-kreditten styrte bort fra Anthropic (D-447: aldri en usynlig nedgradering). Kun kategorier og dato - ingen beløp
 * (AI-kostnad behandles etter strengeste regel inntil Q-64 er besvart, og merknaden lagres i samtalen). Ingen parenteser inni teksten (se `stripSystemNotes`).
 */
export function claudeBudgetNoteNo(action: PacingAction, reason: string, windowEndMs: number, what: "svaret" | "jobben" = "svaret"): string {
  const subject = what === "svaret" ? "dette svaret" : "jobben";
  if (action === "deny" || reason === "exhausted_hard_stop_off_background_deferred") return `${CLAUDE_BUDGET_NOTE_PREFIX} perioden er brukt opp, så ${subject} kom fra den lokale modellen. Kreditten fornyes ${formatDateNo(windowEndMs)}.`;
  if (reason === "reserve_kept_for_essential") return `${CLAUDE_BUDGET_NOTE_PREFIX} resten er forbeholdt det aller viktigste, så ${subject} kom fra den lokale modellen. Kreditten fornyes ${formatDateNo(windowEndMs)}.`;
  if (reason === "spend_unreadable_background_deferred") return `${CLAUDE_BUDGET_NOTE_PREFIX} forbruket kunne ikke leses, så ${subject} kom fra den lokale modellen.`;
  return `${CLAUDE_BUDGET_NOTE_PREFIX} bruken ligger foran periodens tempo, så ${subject} kom fra den lokale modellen.`;
}
