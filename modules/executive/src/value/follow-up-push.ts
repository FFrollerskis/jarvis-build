/**
 * WP-C4, V2 Unified Follow-up - PUSH-LEVERING (dormant: AV som standard, `JARVIS_V2_PUSH_ENABLED`). Fram til nå var oppfølging kun PULL (conversation-graph-verktøyene: eieren må spørre). Denne filen er den REN logikken for en planlagt
 * «oppfølgingsvarsling» til eierens EGEN kanal; selve lesingen (conversation-graph), ledgeren (audit-sporet) og avsenderen (Telegram via ToolGateway) injiseres som porter fra `apps/api`.
 *
 * Garantier (alle låst av tester):
 *  - AV som standard; kun den eksakte verdien `true` slår den på.
 *  - Rolig tid (standard 22-07 Europe/Oslo): ingenting sendes i vinduet. Start = slutt betyr HELE døgnet rolig (fail-closed), aldri «ingen rolig tid».
 *  - Rate-limit: høyst N meldinger per rullerende døgn (standard 3) og minst 60 minutter mellom meldinger. Flere løkker pakkes i ÉN melding (høyst 5), aldri en melding per løkke.
 *  - Dedupe: samme løkke varsles aldri to ganger for samme forfallsperiode (`kilde:id:forfalt|snart:forfallsdato`). Flyttes fristen, er det en NY periode. Reservasjonen skrives FØR sending (høyst én gang - aldri to).
 *  - Kun eierens egne løkker: `ai_assisted`-funn (LLM-forslag) varsles aldri, systemdetekterte løkker vises med FAST etikett (aldri fritekst), og oppfølgingstitler vaskes (`safeFollowUpTitle`) og vises som sitert DATA.
 *  - Ingen ny leverandør og ingen ny kanal: `FollowUpNotifier` er en port; implementasjonen i `apps/api` bruker den eksisterende `telegram.notify` til eierens konfigurerte chat (mottaker er aldri en parameter).
 */
import { createHash } from "node:crypto";
import { envHour, envInt } from "@jarvis/contracts";
import { flattenText } from "./text.ts";

export type PushBucket = "critical" | "overdue" | "due_soon" | "informational";
export type PushGroup = "overdue" | "due_soon";

export interface PushCandidate {
  source_kind: "business_followup" | "business_open_loop";
  source_id: string;
  due_at: string | null;
  bucket: PushBucket;
  priority: "low" | "normal" | "high";
  /** Hvordan løkken oppstod. `ai_assisted` (LLM-forslag) varsles aldri. */
  provenance: "explicit" | "deterministic" | "ai_assisted";
  /** Oppfølging: lagret tittel (ubetrodd tekst, vaskes). Systemløkke: `loop_type` (lukket mengde, oversettes til fast etikett). */
  title: string;
}

export interface FollowUpPushPolicy {
  enabled: boolean;
  max_messages_per_day: number;
  max_items_per_message: number;
  min_gap_minutes: number;
  quiet_start_hour: number;
  quiet_end_hour: number;
  time_zone: string;
  /** Løkker forfalt lenger enn dette varsles ikke (de står i morgenbriefen) - hindrer en flom første gang push slås på. */
  stale_overdue_days: number;
}

export const FOLLOW_UP_PUSH_DEFAULTS = {
  max_messages_per_day: 3, max_items_per_message: 5, min_gap_minutes: 60, quiet_start_hour: 22, quiet_end_hour: 7, stale_overdue_days: 14, time_zone: "Europe/Oslo"
} as const;

/** Tikk-intervall for løkken i `apps/api` (ms). Fast: ikke en innstilling - rate-limit og dedupe er det som begrenser utsendelsen. */
export const FOLLOW_UP_PUSH_TICK_MS = 15 * 60_000;

/** Kun den eksakte verdien `true` slår push på (aldri «1»/«yes»/«TRUE»). Satt-men-ugyldige tall stopper oppstarten (som øvrige env-verdier). */
export function parseFollowUpPushPolicy(env: Readonly<Record<string, string | undefined>>): FollowUpPushPolicy {
  return {
    enabled: env["JARVIS_V2_PUSH_ENABLED"]?.trim() === "true",
    max_messages_per_day: envInt("JARVIS_V2_PUSH_MAX_PER_DAY", FOLLOW_UP_PUSH_DEFAULTS.max_messages_per_day, { min: 1, max: 20 }, env),
    max_items_per_message: FOLLOW_UP_PUSH_DEFAULTS.max_items_per_message,
    min_gap_minutes: FOLLOW_UP_PUSH_DEFAULTS.min_gap_minutes,
    quiet_start_hour: envHour("JARVIS_V2_PUSH_QUIET_START", FOLLOW_UP_PUSH_DEFAULTS.quiet_start_hour, env),
    quiet_end_hour: envHour("JARVIS_V2_PUSH_QUIET_END", FOLLOW_UP_PUSH_DEFAULTS.quiet_end_hour, env),
    time_zone: FOLLOW_UP_PUSH_DEFAULTS.time_zone,
    stale_overdue_days: FOLLOW_UP_PUSH_DEFAULTS.stale_overdue_days
  };
}

/** Klokketime 0-23 i tidssonen (Intl; «24» ved midnatt normaliseres til 0). */
export function localHour(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone, hour12: false, hour: "2-digit" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "NaN");
  return Number.isFinite(hour) ? hour % 24 : Number.NaN;
}

/** Rolig time? start<slutt: [start,slutt). start>slutt (over midnatt): ≥start eller <slutt. start=slutt: hele døgnet (fail-closed). Ugyldig time er rolig (fail-closed). */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return true;
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Tekstvask: det eneste fritekst-feltet som kan nå varselet er en oppfølgingstittel
// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const TITLE_MAX_CHARS = 60;
const RISKY_TLDS = "com|no|org|net|io|app|dev|me|ly|co|info|biz|xyz|ru|cn|tk|ml|ga|cf|gq|top|click|link|site|online|store|shop|cc|to|gl|gd|is|se|dk|fi|de|uk|eu|us|ai|tv|fm|sh|im|cloud|page|zip|mov";
const URL_LIKE = new RegExp(
  String.raw`(?:\b[a-z][a-z0-9+.-]{1,15}:\/\/\S+|\b(?:mailto|tel|sms|javascript|data|tg):\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+(?:${RISKY_TLDS})\b(?:[/:?#]\S*)?)`, "gi"
);

/**
 * Oppfølgingstittel -> trygg, sitert DATA-linje. Fjerner usynlige/kontrolltegn og retningstegn, lenker (med skjema, `www.` og nakne domener), @-omtaler og /-kommandoer (Telegram gjør dem klikkbare), samt markup-tegn;
 * kutter til 60 tegn. Tom etter vask gir «uten tittel». Teksten tolkes aldri som instruks av noen - den er en etikett eieren selv har satt.
 */
export function safeFollowUpTitle(raw: string): string {
  let t = flattenText(raw, 400);
  t = t.replace(URL_LIKE, "[lenke]");
  t = t.replace(/@(?=[\p{L}\p{N}_])/gu, "");
  t = t.replace(/(^|\s)\/(?=[\p{L}\p{N}_])/gu, "$1");
  t = t.replace(/[`<>]/g, "");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length === 0 || /^(\[lenke\]\s*)+$/.test(t)) return t.length === 0 ? "uten tittel" : "[lenke]";
  const chars = Array.from(t);
  return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS - 1).join("").trimEnd()}…` : t;
}

/** Fast norsk etikett per systemløkke-type (lukket mengde). Ukjent type -> generisk etikett, aldri typen som fritekst. */
const LOOP_LABEL_NO: Readonly<Record<string, string>> = {
  stalled_opportunity: "Salgsmulighet står stille",
  support_ticket_needs_reply: "Supportsak venter på svar",
  support_ticket_overdue: "Supportsak er forfalt",
  support_ticket_unassigned: "Supportsak uten eier",
  support_ticket_waiting_internal: "Supportsak venter på intern avklaring",
  contract_renewal_due: "Kontrakt: fornyelse nærmer seg",
  contract_termination_deadline: "Kontrakt: oppsigelsesfrist",
  contract_obligation_due: "Kontrakt: forpliktelse forfaller",
  contract_review_required: "Kontrakt trenger gjennomgang",
  marketing_spend_anomaly: "Uvanlig annonseforbruk",
  payment_intent_anomaly: "Uvanlig betaling",
  payment_intent_reconciliation_mismatch: "Betaling stemmer ikke med avstemming",
  finance_spend_unexpected: "Uventet utgift",
  finance_spend_amount_deviation: "Utgift med avvikende beløp",
  finance_recurring_charge_missing: "Fast trekk uteble",
  finance_recurring_charge_duplicate: "Fast trekk er dobbelt",
  finance_spend_correction_conflict: "Utgiftskorrigering i konflikt",
  bank_transaction_unmatched: "Banktransaksjon uten treff",
  bank_consent_attention: "Banksamtykke trenger oppmerksomhet",
  card_anomaly_attention: "Kortavvik trenger oppmerksomhet",
  finance_procurement_missing: "Innkjøp mangler registrering",
  product_item_needs_triage: "Produktsak trenger triage",
  product_item_high_priority_stalled: "Viktig produktsak står stille",
  operations_task_overdue: "Driftsoppgave er forfalt",
  operations_task_escalation_needed: "Driftsoppgave bør eskaleres"
};

/** `overdue_followup` er systemets egen speiling av en forfalt oppfølging som allerede varsles som oppfølging - varsles ikke to ganger. */
const MIRRORED_LOOP_TYPE = "overdue_followup";
const SAFE_ID = /^[A-Za-z0-9:_.-]{1,120}$/;
const DAY_MS = 86_400_000;

export interface PushItem {
  key: string;
  source_kind: PushCandidate["source_kind"];
  source_id: string;
  group: PushGroup;
  label: string;
  /** Hele døgn forfalt (overdue) eller igjen (due_soon). */
  days: number;
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Kvalifisert kandidat -> push-element (eller null). Ingen sideeffekter. */
export function toPushItem(c: PushCandidate, now: Date, staleOverdueDays: number): PushItem | null {
  if (c.provenance === "ai_assisted") return null;
  if (c.bucket === "informational") return null;
  if (c.source_kind !== "business_followup" && c.source_kind !== "business_open_loop") return null;
  if (typeof c.source_id !== "string" || !SAFE_ID.test(c.source_id)) return null;
  if (c.due_at === null || typeof c.due_at !== "string") return null;
  const dueMs = new Date(c.due_at).getTime();
  if (!Number.isFinite(dueMs)) return null;
  if (c.source_kind === "business_open_loop" && c.title === MIRRORED_LOOP_TYPE) return null;
  const group: PushGroup = c.bucket === "due_soon" ? "due_soon" : "overdue";
  const delta = now.getTime() - dueMs;
  // Bucket og klokke må stemme (en kandidat som påstår «forfalt» men har en frist i fremtiden eller omvendt, varsles ikke).
  if (group === "overdue" && delta < 0) return null;
  if (group === "due_soon" && delta >= 0) return null;
  if (group === "overdue" && delta > staleOverdueDays * DAY_MS) return null;
  const label = c.source_kind === "business_followup" ? `«${safeFollowUpTitle(c.title)}»` : (LOOP_LABEL_NO[c.title] ?? "Åpen sak");
  return {
    key: `${c.source_kind}:${c.source_id}:${group}:${isoDay(dueMs)}`,
    source_kind: c.source_kind, source_id: c.source_id, group, label,
    days: Math.floor(Math.abs(delta) / DAY_MS)
  };
}

// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Ledger (kun audit-spor): reservasjon -> sendt | feilet | ukjent
// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export const PUSH_AUDIT_TYPES = ["followup.push_reserved", "followup.push_sent", "followup.push_failed", "followup.push_unknown"] as const;
export type PushAuditType = (typeof PUSH_AUDIT_TYPES)[number];

export interface PushLedgerRow {
  /** Stigende rekkefølge (audit_id). Tidsstempel er ikke nok: to rader i samme millisekund må ha en definert rekkefølge. */
  seq: number;
  type: PushAuditType;
  at: string;
  message_key: string;
  item_keys: readonly string[];
}

export interface PushLedgerState {
  /** Løkke-perioder som allerede er reservert/varslet (og ikke frigitt av en definitiv feil). */
  consumed_keys: ReadonlySet<string>;
  /** Reserverte meldinger siste 24 t (frigitte telles ikke). */
  messages_last_24h: number;
  last_reserved_at: string | null;
}

export const EMPTY_PUSH_LEDGER: PushLedgerState = { consumed_keys: new Set<string>(), messages_last_24h: 0, last_reserved_at: null };

/**
 * Reduserer audit-radene til dedupe-/rate-tilstand. En reservasjon holder løkkene (og teller mot døgngrensen) til en DEFINITIV feil (`push_failed`) frigir dem; `push_sent` og `push_unknown` (utfall ukjent, for
 * eksempel tidsavbrudd) beholder dem - høyst én gang er viktigere enn å garantere ankomst. En gjentatt reservasjon av samme melding etter en feil starter på nytt.
 */
export function reduceLedger(rows: readonly PushLedgerRow[], now: Date): PushLedgerState {
  const active = new Map<string, { at: string; items: readonly string[] }>();
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (row.type === "followup.push_reserved") active.set(row.message_key, { at: row.at, items: row.item_keys });
    else if (row.type === "followup.push_failed") active.delete(row.message_key);
  }
  const consumed = new Set<string>();
  let last: string | null = null;
  let count24 = 0;
  const since = now.getTime() - DAY_MS;
  for (const { at, items } of active.values()) {
    for (const key of items) consumed.add(key);
    const t = new Date(at).getTime();
    if (Number.isFinite(t) && t > since) count24 += 1;
    if (Number.isFinite(t) && (last === null || t > new Date(last).getTime())) last = at;
  }
  return { consumed_keys: consumed, messages_last_24h: count24, last_reserved_at: last };
}

// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Planlegger
// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type PushSkipReason = "disabled" | "invalid_policy" | "quiet_hours" | "rate_limited" | "min_gap" | "nothing_new";

export type PushDecision =
  | { send: false; reason: PushSkipReason }
  | { send: true; message_key: string; text: string; items: PushItem[]; item_keys: string[] };
export type PushSend = Extract<PushDecision, { send: true }>;

const GROUP_ORDER: Record<PushGroup, number> = { overdue: 0, due_soon: 1 };
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 } as const;

function compose(items: readonly PushItem[]): string {
  const overdue = items.filter((i) => i.group === "overdue");
  const soon = items.filter((i) => i.group === "due_soon");
  const lines = [`Oppfølging fra Jarvis: ${items.length} ${items.length === 1 ? "sak" : "saker"} trenger deg.`];
  if (overdue.length > 0) {
    lines.push("Forfalt:");
    for (const i of overdue) lines.push(`- ${i.label} (${i.days === 0 ? "forfalt i dag" : `forfalt ${i.days} d`})`);
  }
  if (soon.length > 0) {
    lines.push("Snart forfall:");
    for (const i of soon) lines.push(`- ${i.label} (${i.days === 0 ? "innen et døgn" : `om ${i.days} d`})`);
  }
  lines.push("Dette er en påminnelse fra dine egne lister. Åpne dashbordet eller spør meg om oppfølginger.");
  return lines.join("\n");
}

const validPolicy = (p: FollowUpPushPolicy): boolean =>
  Number.isInteger(p.max_messages_per_day) && p.max_messages_per_day >= 1 &&
  Number.isInteger(p.max_items_per_message) && p.max_items_per_message >= 1 &&
  Number.isFinite(p.min_gap_minutes) && p.min_gap_minutes >= 0 &&
  Number.isInteger(p.quiet_start_hour) && p.quiet_start_hour >= 0 && p.quiet_start_hour <= 23 &&
  Number.isInteger(p.quiet_end_hour) && p.quiet_end_hour >= 0 && p.quiet_end_hour <= 23 &&
  Number.isFinite(p.stale_overdue_days) && p.stale_overdue_days >= 1;

/**
 * Bestemmer om en melding skal sendes nå, og hva den inneholder. Rekkefølgen er bindende: av -> ugyldig policy -> rolig tid -> døgngrense -> minsteavstand -> ingenting nytt. Ren funksjon; `now` injiseres.
 */
export function planFollowUpPush(input: { candidates: readonly PushCandidate[]; policy: FollowUpPushPolicy; state: PushLedgerState; now: Date }): PushDecision {
  const { policy, state, now } = input;
  if (!policy.enabled) return { send: false, reason: "disabled" };
  if (!validPolicy(policy)) return { send: false, reason: "invalid_policy" };
  if (isQuietHour(localHour(now, policy.time_zone), policy.quiet_start_hour, policy.quiet_end_hour)) return { send: false, reason: "quiet_hours" };
  if (state.messages_last_24h >= policy.max_messages_per_day) return { send: false, reason: "rate_limited" };
  if (state.last_reserved_at !== null) {
    const last = new Date(state.last_reserved_at).getTime();
    if (Number.isFinite(last) && now.getTime() - last < policy.min_gap_minutes * 60_000) return { send: false, reason: "min_gap" };
  }
  const seen = new Set<string>();
  const eligible: Array<{ item: PushItem; due: number; priority: PushCandidate["priority"]; critical: boolean }> = [];
  for (const c of input.candidates) {
    const item = toPushItem(c, now, policy.stale_overdue_days);
    if (item === null || state.consumed_keys.has(item.key) || seen.has(item.key)) continue;
    seen.add(item.key);
    eligible.push({ item, due: new Date(c.due_at as string).getTime(), priority: c.priority, critical: c.bucket === "critical" });
  }
  if (eligible.length === 0) return { send: false, reason: "nothing_new" };
  eligible.sort((a, b) =>
    GROUP_ORDER[a.item.group] - GROUP_ORDER[b.item.group] || Number(b.critical) - Number(a.critical) || a.due - b.due ||
    (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1) || a.item.key.localeCompare(b.item.key)
  );
  const items = eligible.slice(0, policy.max_items_per_message).map((e) => e.item);
  const item_keys = items.map((i) => i.key).sort();
  const message_key = `v2-push:${createHash("sha256").update(item_keys.join("\n")).digest("hex").slice(0, 40)}`;
  return { send: true, message_key, text: compose(items), items, item_keys };
}

// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Porter og orkestrering
// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type NotifyOutcome = { ok: true; external_id?: string } | { ok: false; reason: string };

/** Avsender-port. Implementasjonen sender til eierens EGEN kanal (aldri en mottaker som parameter) via den eksisterende avsenderen. Kaster aldri for forventede feil. */
export interface FollowUpNotifier {
  readonly channel: "telegram";
  notify(text: string, opts: { idempotency_key: string }): Promise<NotifyOutcome>;
}

export type SettleOutcome = "sent" | "failed" | "unknown";

/** Ledger-port. `claim` er ATOMISK: leser tilstanden, bygger beslutningen, og reserverer (skriver `push_reserved`) i samme låste transaksjon - to samtidige tikk kan aldri begge få «send». */
export interface FollowUpLedgerPort {
  claim(build: (state: PushLedgerState) => PushDecision): Promise<PushDecision>;
  settle(decision: PushSend, outcome: SettleOutcome, detail: string): Promise<void>;
}

export interface FollowUpPushPorts {
  candidates(): Promise<readonly PushCandidate[]>;
  ledger: FollowUpLedgerPort;
  notifier: FollowUpNotifier;
}

export type PushTickResult =
  | { sent: false; reason: PushSkipReason | "source_unavailable" | "ledger_unavailable" }
  | { sent: true; message_key: string; items: number; settled: boolean }
  | { sent: false; reason: "send_failed" | "send_unknown"; message_key: string; settled: boolean };

/** Utfall der leverandøren kan ha sendt meldingen: reservasjonen beholdes (høyst én gang). */
const AMBIGUOUS_REASON = /^(postcondition_unverified|execution_in_flight)/;

/**
 * Ett tikk: les kandidater -> reserver atomisk -> send -> bokfør utfallet. Feiler kilden eller ledgeren, sendes ingenting (uten ledger finnes ingen dedupe-garanti). Kaster aldri.
 */
export async function runFollowUpPushTick(ports: FollowUpPushPorts, policy: FollowUpPushPolicy, now: () => Date = () => new Date()): Promise<PushTickResult> {
  if (!policy.enabled) return { sent: false, reason: "disabled" };
  let candidates: readonly PushCandidate[];
  try {
    candidates = await ports.candidates();
  } catch {
    return { sent: false, reason: "source_unavailable" };
  }
  let decision: PushDecision;
  try {
    decision = await ports.ledger.claim((state) => planFollowUpPush({ candidates, policy, state, now: now() }));
  } catch {
    return { sent: false, reason: "ledger_unavailable" };
  }
  if (!decision.send) return { sent: false, reason: decision.reason };

  let outcome: SettleOutcome;
  let detail: string;
  try {
    const result = await ports.notifier.notify(decision.text, { idempotency_key: decision.message_key });
    if (result.ok) { outcome = "sent"; detail = result.external_id ?? "sendt"; }
    else if (AMBIGUOUS_REASON.test(result.reason)) { outcome = "unknown"; detail = flattenText(result.reason, 120); }
    else { outcome = "failed"; detail = flattenText(result.reason, 120); }
  } catch (err) {
    // Et kastet unntak betyr at vi ikke vet om meldingen ble sendt (tidsavbrudd midt i kallet): behold reservasjonen.
    outcome = "unknown";
    detail = flattenText(err instanceof Error ? err.message : String(err), 120);
  }
  let settled = true;
  try {
    await ports.ledger.settle(decision, outcome, detail);
  } catch {
    settled = false; // reservasjonen står (sikker retning); bokføringen av utfallet mangler
  }
  if (outcome === "sent") return { sent: true, message_key: decision.message_key, items: decision.items.length, settled };
  return { sent: false, reason: outcome === "failed" ? "send_failed" : "send_unknown", message_key: decision.message_key, settled };
}

