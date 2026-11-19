import { z } from "zod";
import type { SituationCandidateInput } from "./types.ts";

/**
 * WP-G4 (D-466), UA-10: LUKKET kontrakt for det samlede hendelsesabonnementet (abonnementsregister + inntaksbuss).
 *
 * D-64: Situation Engine er JARVIS_CANONICAL. En KILDE (Home Assistant, kamerahendelser, helse, hendelsesregisteret) er aldri stedet motoren bor: hver kilde leverer en liten, MINIMERT OBSERVASJON
 * bak en port, en ren bro oversetter observasjonen til en `SituationCandidateInput`, og motoren (`evaluateCandidate`) eier tilstandsmaskin, dedupe, undertrykking og stille timer. Ingen ny leverandør.
 *
 * Hva som er LUKKET her (alt utenfor settet forkastes, aldri tolkes): kildene, hendelsestypene per kilde, rollene til et Home Assistant-objekt, filterformen per kilde og regelregisteret (terskler med harde grenser).
 *
 * BEGRENSEDE data (CLAUDE.md regel 7, kjent hull N1): helse og kamera er SECRET_RESTRICTED. Observasjonene som forlater kildeporten er derfor allerede AVLEDEDE og minimerte (kategorier og grove tall); broene skriver
 * en innholdsfri `reason` for begrensede domener, og `facts` i signalloggen er en lukket fakta-mengde uten målinger, bilder, etiketter eller fritekst. Klassifisering av slike signaler skjer kun lokalt (assist.ts).
 */

export const SIGNAL_SOURCES = ["home_assistant", "vision", "health", "incident", "communications", "business"] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];
export const isSignalSource = (value: unknown): value is SignalSource => typeof value === "string" && (SIGNAL_SOURCES as readonly string[]).includes(value);

/**
 * Lukket hendelsessett per kilde. `communications` og `business` har BEVISST ingen hendelsestyper her (DEFERRED/dekket av eksisterende broer): forpliktelser og oppfølginger går via open-loop-broen (`overdue_followup`)
 * og V2-pushen (WP-C4), og økonomi/pipeline/frist via open-loop-broen - en ekstra bro ville gitt to varsler om samme sak (se runbook, kilde-/bro-tabellen).
 */
export const SIGNAL_EVENT_TYPES = {
  home_assistant: ["door_open_too_long", "water_leak", "alarm_triggered", "power_over_limit"],
  vision: ["motion_detected", "person_present", "doorbell_event", "security_alert", "opening_detected", "package_detected"],
  health: ["resting_heart_rate_deviation", "sleep_duration_deviation", "activity_deviation"],
  incident: ["incident_active"],
  communications: [],
  business: []
} as const satisfies Record<SignalSource, readonly string[]>;

export type SignalEventType<S extends SignalSource = SignalSource> = (typeof SIGNAL_EVENT_TYPES)[S][number];

export function isEventTypeOf(source: SignalSource, eventType: string): boolean {
  return (SIGNAL_EVENT_TYPES[source] as readonly string[]).includes(eventType);
}

/** Domener der motoren ALDRI kan utføre ACT (INFORM/SUGGEST til eier kun): helse (ingen medisinsk handling) og kamera (ingen autonom handling på grunnlag av bilde). Hardkodet, ikke en innstilling. */
export const NEVER_ACT_DOMAINS: ReadonlySet<string> = new Set(["health", "vision"]);

/** Domener med BEGRENSEDE data: innholdsfri varseltekst og klassifisering kun lokalt. */
export const RESTRICTED_DOMAINS: ReadonlySet<string> = new Set(["health", "vision"]);

// ---------------------------------------------------------------------
// Regelregisteret: ett innslag per (kilde, hendelsestype) med domene, egenskaper og (valgfri) tunbar terskel med HARDE grenser.
// ---------------------------------------------------------------------

export interface TunableThreshold {
  /** Hva tallet betyr (vises til eieren). */
  readonly name: string;
  readonly unit: string;
  readonly default: number;
  /** HARDE grenser i kode: en tuning (eller en korrupt rad) kan aldri gå utenfor [min, max]. */
  readonly min: number;
  readonly max: number;
  /** Ett tilbakemeldingssteg. */
  readonly step: number;
}

export interface RuleDefinition {
  readonly rule_key: string;
  readonly source: SignalSource;
  readonly event_type: string;
  /** Situasjonsdomenet (pause, autonomi-binding og varslingsstøtte er per domene). */
  readonly domain: string;
  /** Avledet av et begrenset domene: innholdsfri tekst, lokal klassifisering. */
  readonly restricted: boolean;
  /** Sikkerhetssignal: kan bryte stille timer KUN når eieren eksplisitt har valgt det (`critical_bypass_quiet`). */
  readonly urgent: boolean;
  /** Berettiget til modellassistert vurdering (kategori/forklaring/løft remember -> inform). Deterministiske sikkerhetssignaler trenger ingen modell. */
  readonly assist: boolean;
  /** `null` = ikke tunbar (sikkerhetsregler og faste regler flyttes aldri av tilbakemelding). */
  readonly tunable: TunableThreshold | null;
}

// Regelregisteret er DYPT FRYST: hverken tilbakemelding, modell eller feil kode kan flytte en terskel, en grense eller en egenskap i en kjørende prosess (D-397: ingen selvmodifikasjon).
const rule = (source: SignalSource, event_type: string, domain: string, props: Pick<RuleDefinition, "urgent" | "assist" | "tunable">): RuleDefinition =>
  Object.freeze({
    rule_key: `${source}:${event_type}`,
    source,
    event_type,
    domain,
    restricted: RESTRICTED_DOMAINS.has(domain),
    urgent: props.urgent,
    assist: props.assist,
    tunable: props.tunable === null ? null : Object.freeze({ ...props.tunable })
  });

export const RULES: readonly RuleDefinition[] = Object.freeze([
  rule("home_assistant", "door_open_too_long", "home", { urgent: false, assist: false, tunable: { name: "open_minutes", unit: "min", default: 15, min: 5, max: 120, step: 5 } }),
  rule("home_assistant", "water_leak", "home", { urgent: true, assist: false, tunable: null }),
  rule("home_assistant", "alarm_triggered", "home", { urgent: true, assist: false, tunable: null }),
  rule("home_assistant", "power_over_limit", "home", { urgent: false, assist: false, tunable: { name: "sustained_ticks", unit: "tikk", default: 3, min: 2, max: 20, step: 1 } }),
  rule("vision", "motion_detected", "vision", { urgent: false, assist: true, tunable: { name: "cooldown_minutes", unit: "min", default: 10, min: 5, max: 120, step: 5 } }),
  rule("vision", "person_present", "vision", { urgent: false, assist: true, tunable: { name: "cooldown_minutes", unit: "min", default: 10, min: 5, max: 120, step: 5 } }),
  rule("vision", "doorbell_event", "vision", { urgent: false, assist: false, tunable: { name: "cooldown_minutes", unit: "min", default: 2, min: 1, max: 30, step: 1 } }),
  rule("vision", "security_alert", "vision", { urgent: true, assist: false, tunable: null }),
  rule("vision", "opening_detected", "home", { urgent: false, assist: false, tunable: null }),
  rule("vision", "package_detected", "vision", { urgent: false, assist: true, tunable: { name: "cooldown_minutes", unit: "min", default: 60, min: 15, max: 720, step: 15 } }),
  rule("health", "resting_heart_rate_deviation", "health", { urgent: false, assist: true, tunable: { name: "z_score", unit: "z", default: 2, min: 1.5, max: 4, step: 0.25 } }),
  rule("health", "sleep_duration_deviation", "health", { urgent: false, assist: true, tunable: { name: "z_score", unit: "z", default: 2, min: 1.5, max: 4, step: 0.25 } }),
  rule("health", "activity_deviation", "health", { urgent: false, assist: true, tunable: { name: "z_score", unit: "z", default: 2, min: 1.5, max: 4, step: 0.25 } }),
  rule("incident", "incident_active", "infra", { urgent: false, assist: true, tunable: null })
]);

const RULE_INDEX: ReadonlyMap<string, RuleDefinition> = new Map(RULES.map((r) => [r.rule_key, r]));

export function ruleFor(source: SignalSource, eventType: string): RuleDefinition | undefined {
  return RULE_INDEX.get(`${source}:${eventType}`);
}
export function ruleByKey(ruleKey: string): RuleDefinition | undefined {
  return RULE_INDEX.get(ruleKey);
}

/**
 * Den EFFEKTIVE terskelen for en regel: en lagret (tunet) verdi KLEMMES alltid mot kodens harde grenser, og en ugyldig/manglende verdi gir standarden.
 * Dette er forsvaret mot en korrupt eller manipulert rad: ingen verdi i databasen kan flytte en terskel utenfor [min, max].
 */
export function resolveRuleThreshold(rule: RuleDefinition, stored: number | null | undefined): number | null {
  const t = rule.tunable;
  if (t === null) return null;
  if (stored === null || stored === undefined || typeof stored !== "number" || !Number.isFinite(stored)) return t.default;
  return Math.min(t.max, Math.max(t.min, stored));
}

// ---------------------------------------------------------------------
// Abonnementsfilter: LUKKET form per kilde (strict - ukjent felt avvises).
// ---------------------------------------------------------------------

export const HOME_ROLES = ["door", "window", "garage_door", "gate", "opening", "leak", "alarm", "power"] as const;
export type HomeRole = (typeof HOME_ROLES)[number];

/** Eksakt HA-entitets-id (`domene.navn`), ingen jokertegn: eieren navngir hver entitet selv, Jarvis gjetter aldri. */
export const HA_ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

const HomeEntitySchema = z
  .object({
    entity_id: z.string().regex(HA_ENTITY_ID).max(100),
    role: z.enum(HOME_ROLES),
    /** Kun for rollen `power`: eierens EGEN grense i watt (ingen standard - uten grense er det ingen regel). */
    limit_w: z.number().positive().max(100_000).optional()
  })
  .strict()
  .refine((e) => (e.role === "power") === (e.limit_w !== undefined), { message: "limit_w_only_and_required_for_power" });

export const HomeFilterSchema = z.object({ entities: z.array(HomeEntitySchema).min(1).max(50) }).strict();
export type HomeFilter = z.infer<typeof HomeFilterSchema>;

const SOURCE_INSTANCE_ID = /^[A-Za-z0-9_.:@-]{1,100}$/;

export const VisionFilterSchema = z
  .object({
    /** Begrens til disse kildene (HA-entitet/kilde-ref fra eierens kameraregister). Utelatt = alle eierens kilder. */
    source_instance_ids: z.array(z.string().regex(SOURCE_INSTANCE_ID)).max(20).optional(),
    /** Natt-vindu i UTC-timer der bevegelse/tilstedeværelse regnes som uventet (ellers kun `remember`). Utelatt = ingen natt-regel. */
    night_hours_utc: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).strict().optional()
  })
  .strict();
export type VisionFilter = z.infer<typeof VisionFilterSchema>;

export const HEALTH_SIGNAL_METRICS = ["resting_heart_rate", "sleep_duration_minutes", "steps"] as const;
export type HealthSignalMetric = (typeof HEALTH_SIGNAL_METRICS)[number];

export const HealthFilterSchema = z
  .object({
    /** Personen som eier helsedataene. MÅ være den innloggede eieren selv (kun egen helse: ingen leser andres). */
    person_id: z.string().min(1).max(200)
  })
  .strict();
export type HealthFilter = z.infer<typeof HealthFilterSchema>;

export const IncidentFilterSchema = z.object({}).strict();
export type IncidentFilter = z.infer<typeof IncidentFilterSchema>;

export const FILTER_SCHEMAS = {
  home_assistant: HomeFilterSchema,
  vision: VisionFilterSchema,
  health: HealthFilterSchema,
  incident: IncidentFilterSchema,
  communications: z.object({}).strict(),
  business: z.object({}).strict()
} as const satisfies Record<SignalSource, z.ZodTypeAny>;

// ---------------------------------------------------------------------
// Bro-kontrakten (REN): observasjon -> kandidat. Ingen I/O, ingen klokke (nowMs injiseres).
// ---------------------------------------------------------------------

/** Minimert fakta-mengde (kun skalarer; strenger er korte og lukkede). Dette er ALT som lagres om selve signalet i loggen. */
export type SignalFacts = Record<string, string | number | boolean>;

export interface BridgeResult {
  rule_key: string;
  source: SignalSource;
  event_type: string;
  /** Kandidaten til `SituationEngine.evaluateCandidate()`. For begrensede domener er `reason` innholdsfri. */
  candidate: SituationCandidateInput;
  /** Idempotent identitet for signalet (episode + nivå): maks ett loggført signal per nøkkel. */
  source_ref: string;
  facts: SignalFacts;
  urgent: boolean;
  occurred_at: string;
}

export interface BridgeContext {
  nowMs: number;
  /** Effektiv (tunet, klemt) terskel for en regel, `null` hvis regelen ikke er tunbar. */
  threshold: (rule: RuleDefinition) => number | null;
}

export const FACT_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_FACT_STRING = 80;

/** Hindrer at `facts` blir en kanal for fritekst eller rader: bare skalarer, korte nøkler, korte strenger uten kontrolltegn/linjeskift. */
export function assertMinimalFacts(facts: SignalFacts): void {
  const keys = Object.keys(facts);
  if (keys.length > 16) throw new Error("signal_facts_too_many_keys");
  for (const key of keys) {
    if (!FACT_KEY.test(key)) throw new Error(`signal_facts_bad_key:${key}`);
    const value = facts[key];
    if (typeof value === "string") {
      if (value.length > MAX_FACT_STRING || /\p{Cc}/u.test(value)) throw new Error(`signal_facts_bad_string:${key}`);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`signal_facts_bad_number:${key}`);
    } else if (typeof value !== "boolean") {
      throw new Error(`signal_facts_bad_type:${key}`);
    }
  }
}

/** Parser en ISO-tid til ms, ellers `null` (en ugyldig tid gir aldri et signal). */
export function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
