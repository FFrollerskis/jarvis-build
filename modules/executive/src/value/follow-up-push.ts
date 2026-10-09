/**
 * WP-C4, V2 Unified Follow-up - PUSH-LEVERING (dormant: AV som standard, `JARVIS_V2_PUSH_ENABLED`). Fram til nå var oppfølging kun PULL (conversation-graph-verktøyene: eieren må spørre). Denne filen er den REN logikken for en planlagt
 * «oppfølgingsvarsling» til eierens EGEN kanal; selve lesingen (conversation-graph), ledgeren (audit-sporet), avsenderen (Telegram via ToolGateway) og stopp-sjekken (kill switch/frys) injiseres som porter fra `apps/api`.
 *
 * Garantier (alle låst av tester):
 *  - AV som standard; kun den eksakte verdien `true` slår den på.
 *  - Rolig tid (standard 22-07 Europe/Oslo): ingenting sendes i vinduet. Start = slutt betyr HELE døgnet rolig (fail-closed), aldri «ingen rolig tid».
 *  - Rate-limit: høyst N meldinger per rullerende døgn (standard 3) og minst 60 minutter mellom FORSØK (et mislykket forsøk som ble frigitt teller også - M1). Flere løkker pakkes i ÉN melding (høyst 5), aldri en melding per løkke.
 *  - HØYST ÉN GANG (H1): reservasjonen skrives FØR sending og frigis KUN når utfallet er BEVIST «ikke sendt» - en positiv tillatelsesliste av eksplisitte avslag FØR leverandørkallet (`classifyNotifyFailure`). ALT annet
 *    (tidsavbrudd, 5xx, nettverksfeil etter sending, `postcondition_unverified`, ukjente tekster, kastede unntak) BEHOLDER reservasjonen og teller mot døgngrense og minsteavstand. Restrisiko (bevisst, «høyst én» går foran
 *    «minst én»): et usikkert utfall kan i sjeldne tilfeller TAPE en påminnelse (leverandøren mottok den aldri), men den kan aldri sendes to ganger.
 *  - Forsøkstak og backoff (M1): høyst 3 forsøk per melding per rullerende døgn, og ventetid etter siste forsøk som vokser med antall feil (15 min, 1 t, deretter 4 t). Når taket er nådd er løperen stille (`attempts_exhausted`).
 *  - Stopp FØR reservasjon (M1): kill switch, frosset connector, tilbakekalt credential og infra-pause sjekkes via `PushSendGuard` FØR noe reserveres - ingen audit-støy og ingen forsøk mens eieren har stanset systemet.
 *  - Dedupe: samme løkke varsles aldri to ganger for samme forfallsperiode (`kilde:id:forfalt|snart:forfallsdato`). Flyttes fristen, er det en NY periode.
 *  - Kun eierens egne løkker: `ai_assisted`-funn (LLM-forslag) varsles aldri, systemdetekterte løkker vises med FAST etikett (aldri fritekst), og oppfølgingstitler vaskes etter hvitelisteprinsippet (`safeFollowUpTitle`, M2) og
 *    vises som sitert DATA. Valgfritt (`JARVIS_V2_PUSH_TITLES=false`) sendes kun antall og «åpne dashbordet».
 *  - Ingen ny leverandør og ingen ny kanal: `FollowUpNotifier` er en port; implementasjonen i `apps/api` bruker den eksisterende `telegram.notify` til eierens konfigurerte chat (mottaker er aldri en parameter).
 */
import { createHash } from "node:crypto";
import { envHour, envInt } from "@jarvis/contracts";
import { flattenText, ownValue } from "./text.ts";

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
  /** Minste avstand mellom to FORSØK (en reservasjon, også en som en definitiv feil senere frigav). */
  min_gap_minutes: number;
  quiet_start_hour: number;
  quiet_end_hour: number;
  time_zone: string;
  /** Løkker forfalt lenger enn dette varsles ikke (de står i morgenbriefen) - hindrer en flom første gang push slås på. */
  stale_overdue_days: number;
  /** M1: høyst så mange forsøk (reservasjoner, også frigitte) PER MELDING per rullerende døgn. Når taket er nådd er løperen stille for den meldingen (`attempts_exhausted`). */
  max_attempts_per_message: number;
  /** M1: ventetid i minutter etter siste forsøk, indeksert på antall definitive feil så langt på denne meldingen (1 feil -> [0], 2 feil -> [1], flere -> siste verdi). */
  retry_backoff_minutes: readonly number[];
  /** M2: `false` = meldingen har kun antall og «åpne dashbordet» - ingen titler (siste forsvarslinje mot ubetrodd tekst). Standard `true`. */
  include_titles: boolean;
}

export const FOLLOW_UP_PUSH_DEFAULTS = {
  max_messages_per_day: 3, max_items_per_message: 5, min_gap_minutes: 60, quiet_start_hour: 22, quiet_end_hour: 7, stale_overdue_days: 14, time_zone: "Europe/Oslo",
  max_attempts_per_message: 3, retry_backoff_minutes: [15, 60, 240]
} as const;

/** Tikk-intervall for løkken i `apps/api` (ms). Fast: ikke en innstilling - rate-limit og dedupe er det som begrenser utsendelsen. */
export const FOLLOW_UP_PUSH_TICK_MS = 15 * 60_000;

/**
 * Kun den eksakte verdien `true` slår push på (aldri «1»/«yes»/«TRUE»). Satt-men-ugyldige tall stopper oppstarten (som øvrige env-verdier).
 * `JARVIS_V2_PUSH_TITLES` er en SIKKERHETSKNAPP med omvendt standard: tom/usatt/`true` = titler vises (vasket); ALT annet (`false`, `FALSE`, `0`, `nei`, skrivefeil) = kun antall. Tvetydighet strammer alltid inn.
 */
export function parseFollowUpPushPolicy(env: Readonly<Record<string, string | undefined>>): FollowUpPushPolicy {
  const titles = env["JARVIS_V2_PUSH_TITLES"]?.trim();
  return {
    enabled: env["JARVIS_V2_PUSH_ENABLED"]?.trim() === "true",
    max_messages_per_day: envInt("JARVIS_V2_PUSH_MAX_PER_DAY", FOLLOW_UP_PUSH_DEFAULTS.max_messages_per_day, { min: 1, max: 20 }, env),
    max_items_per_message: FOLLOW_UP_PUSH_DEFAULTS.max_items_per_message,
    min_gap_minutes: FOLLOW_UP_PUSH_DEFAULTS.min_gap_minutes,
    quiet_start_hour: envHour("JARVIS_V2_PUSH_QUIET_START", FOLLOW_UP_PUSH_DEFAULTS.quiet_start_hour, env),
    quiet_end_hour: envHour("JARVIS_V2_PUSH_QUIET_END", FOLLOW_UP_PUSH_DEFAULTS.quiet_end_hour, env),
    time_zone: FOLLOW_UP_PUSH_DEFAULTS.time_zone,
    stale_overdue_days: FOLLOW_UP_PUSH_DEFAULTS.stale_overdue_days,
    max_attempts_per_message: FOLLOW_UP_PUSH_DEFAULTS.max_attempts_per_message,
    retry_backoff_minutes: FOLLOW_UP_PUSH_DEFAULTS.retry_backoff_minutes,
    include_titles: titles === undefined || titles === "" || titles === "true"
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
// Tekstvask: det eneste fritekst-feltet som kan nå varselet er en oppfølgingstittel (M2: HVITELISTE, ikke svarteliste)
// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const TITLE_MAX_CHARS = 60;
/** Markør for en fjernet lenke mens vasken pågår. NUL kan aldri finnes i inndata (`flattenText` bytter kontrolltegn med mellomrom) og blir først til «[lenke]» helt til slutt. */
const LINK = "\u0000";
const LINK_COST = "[lenke]".length;
const MAX_CLEAN_PASSES = 8;
// Toppdomene: `xn--` FØRST (ellers leses «xn» som toppdomene og «--p1ai» blir stående); 2-24 ASCII-bokstaver avgrenset som `\w\.[a-z]{2,24}\b` (en bokstav fra et annet skriftsystem rett etter regnes IKKE som del av ordet - blandet skrift
// skal ikke kunne skjule et domene); og 2-24 Unicode-bokstaver avgrenset av bokstaver/tall (homoglyfer som `еvil.рro`).
const TLD = String.raw`(?:xn--[a-z0-9-]{1,59}|[a-z]{2,24}(?![a-z0-9_])|\p{L}{2,24}(?![\p{L}\p{N}_]))`;

/**
 * Alt som kan bli klikkbart i Telegram (eller utføres av en klient) byttes med en markør. Rekkefølgen er bevisst: e-post FØR `@` fjernes (ellers ble `per@firma.pro` til `perfirma.pro`), domener med ENHVER alfabetisk
 * toppdomene (2-24 tegn) eller `xn--` (ikke en kort liste), og sifferrekker på ≥ 7 sifre (telefon, kortnummer) også med enkle skilletegn. Mønstrene er lineære (ingen nøstede kvantorer over samme tegn).
 */
const LINK_PATTERNS: readonly RegExp[] = [
  /[\p{L}][\p{L}\p{N}+.-]{1,15}:\/\/\S*/giu, // skjema med // (https://, ftp://, tg://, ...) - alt til neste mellomrom
  /(?<![\p{L}\p{N}])(?:mailto|tel|sms|smsto|callto|javascript|vbscript|data|file|tg|ton|sip|skype|facetime|whatsapp|viber|intent):\S+/giu, // skjema uten // (≥ 1 tegn rett etter kolon: «data: nye tall» er vanlig tekst)
  /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*/giu, // e-postadresse
  new RegExp(String.raw`(?:[\p{L}\p{N}-]+\.)+${TLD}(?::\d{1,5})?(?:[/?#]\S*)?`, "giu"), // ord.ord der siste ledd er 2-24 bokstaver eller xn--, med evt. port/sti
  /(?<![\p{L}\p{N}])[a-z]{2}\d{2}(?: ?[a-z0-9]){11,30}(?![\p{L}\p{N}])/giu, // IBAN-lignende
  /\+?\d(?:[ ().-]{0,2}\d){6,}/gu // telefonnummer-/kortnummer-lignende sifferrekke (≥ 7 sifre)
];
/** Hele ord som inneholder `http`/`https` eller `www.` uansett sammenheng. */
const HTTP_OR_WWW = /https?|www\./i;
/** Hvitelisten: bokstaver (Unicode), sifre, mellomrom og `.,:;!?()-–'’%`. Alt annet fjernes uansett posisjon (inkl. `/ \ @ # * _ [ ] < >`, backticks og kontroll-/bidi-tegn). Markøren overlever. */
// eslint-disable-next-line no-control-regex -- markøren (NUL) er bevisst med: den kan aldri finnes i inndata og må overleve filteret
const NOT_ALLOWED = /[^\p{L}\p{Nd} .,:;!?()\-–'’%\u0000]/gu;
// eslint-disable-next-line no-control-regex -- samme markør: flere markører på rad (evt. adskilt av ett mellomrom) slås sammen til én
const LINK_RUN = /\u0000(?: ?\u0000)+/g;

const costOf = (chars: readonly string[]): number => chars.reduce((sum, ch) => sum + (ch === LINK ? LINK_COST : 1), 0);

/** Én vaskerunde: lenker -> markør, hvitelistefilter, mellomrom, lengdegrense (en markør teller som «[lenke]»). Fjerning av tegn kan SKJØTTE sammen nye mønstre (`evil/.com` -> `evil.com`), derfor gjentas runden til teksten er stabil. */
function cleanPass(input: string, state: { cut: boolean }): string {
  let t = input.split(" ").map((token) => (HTTP_OR_WWW.test(token) ? LINK : token)).join(" ");
  for (const pattern of LINK_PATTERNS) t = t.replace(pattern, LINK);
  t = t.replace(NOT_ALLOWED, "").replace(/\s+/g, " ").trim().replace(LINK_RUN, LINK);
  const chars = Array.from(t);
  if (costOf(chars) > TITLE_MAX_CHARS) {
    // Kutt til 59 «tegn» (en markør teller som «[lenke]») og la «…» fylle det 60. - kuttet skjer INNE i løkken, så et avkortet ord som blir til et nytt mønster (`x.abc`) fanges i neste runde.
    state.cut = true;
    const kept: string[] = [];
    let cost = 0;
    for (const ch of chars) {
      const next = cost + (ch === LINK ? LINK_COST : 1);
      if (next > TITLE_MAX_CHARS - 1) break;
      kept.push(ch);
      cost = next;
    }
    t = kept.join("").trimEnd();
  }
  return t;
}

/**
 * Oppfølgingstittel -> trygg, sitert DATA-linje (M2: hvitelisteprinsippet). Titler kan komme fra modellopprettede oppfølginger (`business.create_followup`) og er dermed potensielt ubetrodd innhold som pushes med stempelet
 * «dette er en påminnelse fra dine egne lister». Fremgangsmåte: usynlige/kontrolltegn bort, NFKC (fullbredde-tegn blir vanlige), ALT lenkelignende byttes med `[lenke]` (skjema, `www.`, ord.ord med ethvert alfabetisk toppdomene
 * eller `xn--`, e-post, telefon-/kortnummer, IBAN), og så beholdes KUN bokstaver, sifre, mellomrom og `.,:;!?()-–'’%` - alt annet (`/ \ @ # * _ [ ] < >`, backticks, emoji, retningstegn) fjernes uansett posisjon. Kuttes til 60 tegn.
 * Tom etter vask gir «uten tittel». Teksten tolkes aldri som instruks av noen - den er en etikett. Kjente kostnader (trygg side): datoer med skilletegn og beløp over 7 sifre (`15.10.2026`, `1 250 000`) kan bli `[lenke]`; forfallet står i meldingen uansett.
 */
export function safeFollowUpTitle(raw: string): string {
  // NFKC kan utvide teksten (ligaturer, «㎞»): begrens på nytt etter normalisering. U+3002 (ideografisk punktum) leses som `.` av nettlesere i domenenavn.
  let t = Array.from(flattenText(raw, 400).normalize("NFKC")).slice(0, 400).join("").replace(/。/g, ".");
  const state = { cut: false };
  let stable = false;
  for (let pass = 0; pass < MAX_CLEAN_PASSES && !stable; pass += 1) {
    const next = cleanPass(t, state);
    stable = next === t;
    t = next;
  }
  if (!stable) return "[lenke]"; // kan i praksis ikke skje; ikke konvergert = ikke trygt å vise noe av teksten
  if (t === "") return "uten tittel";
  if (t.replaceAll(LINK, "").trim() === "") return "[lenke]";
  const out = t.replaceAll(LINK, "[lenke]");
  return state.cut ? `${out}…` : out;
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
  // L1: `loop_type` kommer fra databasen; `LOOP_LABEL_NO["constructor"]` ga tidligere en funksjon i meldingen. Kun egne felt gjelder.
  const label = c.source_kind === "business_followup" ? `«${safeFollowUpTitle(c.title)}»` : (ownValue(LOOP_LABEL_NO, c.title) ?? "Åpen sak");
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

/** M1: forsøkshistorikk for ÉN melding (`message_key`) - inkluderer forsøk en definitiv feil senere frigav. */
export interface PushAttemptState {
  /** Forsøk (reservasjoner) på meldingen siste 24 t. */
  attempts_24h: number;
  /** Antall definitive feil (frigitte forsøk) på meldingen i hele lesehorisonten; styrer hvor lang backoff som gjelder. */
  failures: number;
  /** Tidspunkt for meldingens siste forsøk. */
  last_attempt_at: string | null;
}

export interface PushLedgerState {
  /** Løkke-perioder som allerede er reservert/varslet (og ikke frigitt av en definitiv feil). */
  consumed_keys: ReadonlySet<string>;
  /** Reserverte meldinger siste 24 t (frigitte telles ikke - de ble bevist ikke sendt). */
  messages_last_24h: number;
  /** Tidspunkt for siste FORSØK: siste `push_reserved`-rad, også en som en definitiv feil senere frigav (M1: forsøk teller mot minsteavstanden, ikke bare aktive reservasjoner). */
  last_reserved_at: string | null;
  /** M1: forsøkshistorikk per `message_key`. */
  attempts: ReadonlyMap<string, PushAttemptState>;
}

export const EMPTY_PUSH_LEDGER: PushLedgerState = { consumed_keys: new Set<string>(), messages_last_24h: 0, last_reserved_at: null, attempts: new Map<string, PushAttemptState>() };

/**
 * Reduserer audit-radene til dedupe-/rate-tilstand. En reservasjon holder løkkene (og teller mot døgngrensen) til en DEFINITIV feil (`push_failed`, utfallet bevist «ikke sendt») frigir dem; `push_sent` og `push_unknown`
 * (utfall ukjent, for eksempel tidsavbrudd) beholder dem - høyst én gang er viktigere enn å garantere ankomst. En gjentatt reservasjon av samme melding etter en feil starter på nytt. Forsøk (alle `push_reserved`-rader) telles
 * i tillegg per melding og globalt for minsteavstanden, uavhengig av om de senere ble frigitt.
 */
export function reduceLedger(rows: readonly PushLedgerRow[], now: Date): PushLedgerState {
  const active = new Map<string, { at: string; items: readonly string[] }>();
  const attempts = new Map<string, { attempts_24h: number; failures: number; last_attempt_at: string | null }>();
  const since = now.getTime() - DAY_MS;
  let lastAttempt: string | null = null;
  const entryOf = (key: string) => {
    const existing = attempts.get(key);
    if (existing !== undefined) return existing;
    const created = { attempts_24h: 0, failures: 0, last_attempt_at: null as string | null };
    attempts.set(key, created);
    return created;
  };
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (row.type === "followup.push_reserved") {
      active.set(row.message_key, { at: row.at, items: row.item_keys });
      const entry = entryOf(row.message_key);
      const t = new Date(row.at).getTime();
      if (Number.isFinite(t)) {
        if (t > since) entry.attempts_24h += 1;
        if (entry.last_attempt_at === null || t > new Date(entry.last_attempt_at).getTime()) entry.last_attempt_at = row.at;
        if (lastAttempt === null || t > new Date(lastAttempt).getTime()) lastAttempt = row.at;
      }
    } else if (row.type === "followup.push_failed") {
      active.delete(row.message_key);
      entryOf(row.message_key).failures += 1;
    }
  }
  const consumed = new Set<string>();
  let count24 = 0;
  for (const { at, items } of active.values()) {
    for (const key of items) consumed.add(key);
    const t = new Date(at).getTime();
    if (Number.isFinite(t) && t > since) count24 += 1;
  }
  return { consumed_keys: consumed, messages_last_24h: count24, last_reserved_at: lastAttempt, attempts };
}

// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Planlegger
// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type PushSkipReason = "disabled" | "invalid_policy" | "quiet_hours" | "rate_limited" | "min_gap" | "nothing_new" | "backoff" | "attempts_exhausted";

export type PushDecision =
  /** `message_key` er satt for `backoff`/`attempts_exhausted` (en hash av løkkenøklene - aldri innhold). */
  | { send: false; reason: PushSkipReason; message_key?: string }
  | { send: true; message_key: string; text: string; items: PushItem[]; item_keys: string[] };
export type PushSend = Extract<PushDecision, { send: true }>;

const GROUP_ORDER: Record<PushGroup, number> = { overdue: 0, due_soon: 1 };
const PRIORITY_ORDER: Readonly<Record<string, number>> = { high: 0, normal: 1, low: 2 };
const FOOTER = "Dette er en påminnelse fra dine egne lister. Åpne dashbordet eller spør meg om oppfølginger.";

function compose(items: readonly PushItem[], includeTitles: boolean): string {
  const overdue = items.filter((i) => i.group === "overdue");
  const soon = items.filter((i) => i.group === "due_soon");
  const noun = items.length === 1 ? "sak" : "saker";
  if (!includeTitles) {
    // M2 (valgfri, `JARVIS_V2_PUSH_TITLES=false`): kun antall - ingen fritekst fra noen kilde når meldingen.
    const parts = [...(overdue.length > 0 ? [`${overdue.length} forfalt`] : []), ...(soon.length > 0 ? [`${soon.length} snart forfall`] : [])];
    return [`Oppfølging fra Jarvis: ${items.length} ${noun} trenger deg (${parts.join(", ")}).`, FOOTER].join("\n");
  }
  const lines = [`Oppfølging fra Jarvis: ${items.length} ${noun} trenger deg.`];
  if (overdue.length > 0) {
    lines.push("Forfalt:");
    for (const i of overdue) lines.push(`- ${i.label} (${i.days === 0 ? "forfalt i dag" : `forfalt ${i.days} d`})`);
  }
  if (soon.length > 0) {
    lines.push("Snart forfall:");
    for (const i of soon) lines.push(`- ${i.label} (${i.days === 0 ? "innen et døgn" : `om ${i.days} d`})`);
  }
  lines.push(FOOTER);
  return lines.join("\n");
}

const validPolicy = (p: FollowUpPushPolicy): boolean =>
  Number.isInteger(p.max_messages_per_day) && p.max_messages_per_day >= 1 &&
  Number.isInteger(p.max_items_per_message) && p.max_items_per_message >= 1 &&
  Number.isFinite(p.min_gap_minutes) && p.min_gap_minutes >= 0 &&
  Number.isInteger(p.quiet_start_hour) && p.quiet_start_hour >= 0 && p.quiet_start_hour <= 23 &&
  Number.isInteger(p.quiet_end_hour) && p.quiet_end_hour >= 0 && p.quiet_end_hour <= 23 &&
  Number.isFinite(p.stale_overdue_days) && p.stale_overdue_days >= 1 &&
  Number.isInteger(p.max_attempts_per_message) && p.max_attempts_per_message >= 1 &&
  Array.isArray(p.retry_backoff_minutes) && p.retry_backoff_minutes.length >= 1 && p.retry_backoff_minutes.every((m) => Number.isFinite(m) && m >= 0) &&
  typeof p.include_titles === "boolean";

/** Ventetid (ms) etter siste forsøk når meldingen har `failures` definitive feil bak seg: 15 min, 1 t, deretter 4 t (standard). */
const retryBackoffMs = (policy: FollowUpPushPolicy, failures: number): number =>
  (policy.retry_backoff_minutes[Math.min(failures, policy.retry_backoff_minutes.length) - 1] ?? 0) * 60_000;

/**
 * Bestemmer om en melding skal sendes nå, og hva den inneholder. Rekkefølgen er bindende: av -> ugyldig policy -> rolig tid -> døgngrense -> minsteavstand (siste FORSØK) -> ingenting nytt -> forsøkstak -> backoff.
 * Ren funksjon; `now` injiseres.
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
    (ownValue(PRIORITY_ORDER, a.priority) ?? 1) - (ownValue(PRIORITY_ORDER, b.priority) ?? 1) || a.item.key.localeCompare(b.item.key)
  );
  const items = eligible.slice(0, policy.max_items_per_message).map((e) => e.item);
  const item_keys = items.map((i) => i.key).sort();
  const message_key = `v2-push:${createHash("sha256").update(item_keys.join("\n")).digest("hex").slice(0, 40)}`;
  // M1: samme melding har allerede vært forsøkt (og frigitt av en definitiv feil). Tak per rullerende døgn, og backoff etter siste forsøk. Taket er nådd: stille til døgnet er rundt.
  const prior = state.attempts.get(message_key);
  if (prior !== undefined) {
    if (prior.attempts_24h >= policy.max_attempts_per_message) return { send: false, reason: "attempts_exhausted", message_key };
    if (prior.failures > 0 && prior.last_attempt_at !== null) {
      const last = new Date(prior.last_attempt_at).getTime();
      if (Number.isFinite(last) && now.getTime() - last < retryBackoffMs(policy, prior.failures)) return { send: false, reason: "backoff", message_key };
    }
  }
  return { send: true, message_key, text: compose(items, policy.include_titles), items, item_keys };
}

// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// H1: hva er BEVIST «ikke sendt»? (positiv tillatelsesliste - alt annet er «ukjent» og beholder reservasjonen)
// -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export type NotifyFailureClass = "not_sent" | "unknown";

/**
 * Eksakte avslag som BEVISER at ingen melding gikk ut. Listen er hentet fra den faktiske koden (aldri gjettet): `ToolGateway.execute()` (`deny()`: `unknown_tool`, `invalid_parameters`, `credential_not_bound_to_identity`,
 * `rate_limited`, `connector_frozen`, `credential_revoked`, `credential_unavailable`), `PolicyGateway.authorize()` (`invalid_identity_context`, `invalid_tool_call`, `kill_switch_active`, `connector_frozen`, `infra_*`,
 * `class_b_requires_active_auth` for telegram.notify som er klasse B) og `TelegramTransport.invoke()` (`telegram_chat_id_not_configured` kastes FØR noen forespørsel). Alle gis før `transport.invoke()` for selve sendingen.
 * Hold listen kort: en ukjent streng skal alltid bli «ukjent» (en tapt påminnelse er bedre enn en duplikat).
 */
const NOT_SENT_REASONS: ReadonlySet<string> = new Set([
  "kill_switch_active", "connector_frozen", "credential_revoked", "credential_unavailable", "credential_not_bound_to_identity",
  "class_b_requires_active_auth", "invalid_identity_context", "invalid_tool_call", "unknown_tool", "invalid_parameters", "rate_limited",
  "infra_paused", "infra_degraded_blocks_class_d", "infra_mode_unavailable",
  "tool_failed:telegram_chat_id_not_configured"
]);
/** Avslag med variabel hale: `scope_mismatch:<felt>` (gateway, før policy) og `unsafe_vendor_url:<grunn>` (`guardedFetch` avviser URL-en FØR `fetch` kalles - f.eks. et token med ugyldige tegn). */
const NOT_SENT_PREFIXES: readonly string[] = ["scope_mismatch:", "tool_failed:unsafe_vendor_url:"];
/**
 * Telegram Bot API avviste selve kallet: dokumenterte 4xx for `sendMessage` (400 ugyldig forespørsel, 401 ugyldig token, 403 boten er blokkert, 404 ukjent bot, 429 for mange forespørsler) - ingen melding ble opprettet.
 * Andre 4xx (408, 499 ...) kan komme fra mellomledd og regnes IKKE som bevis. ALLE 5xx er «ukjent»: Telegram kan ha levert meldingen og likevel svart 502.
 */
const TELEGRAM_REJECTED = /^tool_failed:telegram_error_(?:400|401|403|404|429)$/;

/**
 * Klassifiserer en ikke-ok avsenderrespons. `not_sent` frigir reservasjonen (løkkene kan varsles senere, innenfor forsøkstak og backoff); `unknown` BEHOLDER den. Standarden er `unknown`.
 * Bevisst IKKE «not_sent»: `tool_failed:tool_timeout` (fetch kan levere etter gatewayens frist), `tool_failed:telegram_error_5xx`, `tool_failed:fetch failed` (nettverksbrudd kan skje etter sending),
 * `tool_failed:<hva som helst annet>`, `postcondition_unverified:*`, `postcondition_mismatch`, `execution_in_flight_or_outcome_unknown` og alt ukjent.
 */
export function classifyNotifyFailure(reason: unknown): NotifyFailureClass {
  if (typeof reason !== "string") return "unknown";
  if (NOT_SENT_REASONS.has(reason)) return "not_sent";
  if (NOT_SENT_PREFIXES.some((prefix) => reason.startsWith(prefix) && reason.length > prefix.length)) return "not_sent";
  return TELEGRAM_REJECTED.test(reason) ? "not_sent" : "unknown";
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

/**
 * M1(a): stopp-port, sjekket FØR noe reserveres. Implementasjonen speiler det gatewayen uansett ville avslått (kill switch, frosset connector, tilbakekalt credential, infra-pause), slik at et stanset system ikke gir
 * et forsøk, en reservasjon og tre audit-rader hvert kvarter. Returnerer en kort maskinlesbar årsak, eller `null` når veien er åpen. Kaster aldri (en feil tolkes som stoppet).
 */
export interface PushSendGuard {
  blocked(): Promise<string | null>;
}

export interface FollowUpPushPorts {
  candidates(): Promise<readonly PushCandidate[]>;
  ledger: FollowUpLedgerPort;
  notifier: FollowUpNotifier;
  guard: PushSendGuard;
}

export type PushTickResult =
  /** `message_key` følger `backoff`/`attempts_exhausted` (hash av løkkenøklene, aldri innhold). */
  | { sent: false; reason: PushSkipReason | "source_unavailable" | "ledger_unavailable"; message_key?: string }
  | { sent: false; reason: "send_blocked"; blocked_by: string }
  | { sent: true; message_key: string; items: number; settled: boolean }
  | { sent: false; reason: "send_failed" | "send_unknown"; message_key: string; settled: boolean };

/**
 * Ett tikk: sjekk stopp -> les kandidater -> reserver atomisk -> send -> bokfør utfallet. Feiler kilden eller ledgeren, sendes ingenting (uten ledger finnes ingen dedupe-garanti). Kaster aldri.
 */
export async function runFollowUpPushTick(ports: FollowUpPushPorts, policy: FollowUpPushPolicy, now: () => Date = () => new Date()): Promise<PushTickResult> {
  if (!policy.enabled) return { sent: false, reason: "disabled" };
  // M1(a): stanset system (kill switch/frys/tilbakekalt credential/infra-pause) -> ingen kandidatlesing, ingen reservasjon, ingen audit-rad, ingen forsøk.
  let blocked: string | null;
  try {
    blocked = await ports.guard.blocked();
  } catch {
    blocked = "guard_unavailable";
  }
  if (blocked !== null) return { sent: false, reason: "send_blocked", blocked_by: typeof blocked === "string" && blocked !== "" ? flattenText(blocked, 60) : "guard_invalid" };
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
  if (!decision.send) return { sent: false, reason: decision.reason, ...(decision.message_key !== undefined ? { message_key: decision.message_key } : {}) };

  let outcome: SettleOutcome;
  let detail: string;
  try {
    const result = await ports.notifier.notify(decision.text, { idempotency_key: decision.message_key });
    if (result.ok) { outcome = "sent"; detail = result.external_id ?? "sendt"; }
    // H1: kun BEVIST «ikke sendt» frigir reservasjonen; alt annet (tidsavbrudd, 5xx, nettverksbrudd, ukjent tekst) beholdes (høyst én gang).
    else if (classifyNotifyFailure(result.reason) === "not_sent") { outcome = "failed"; detail = flattenText(result.reason, 120); }
    else { outcome = "unknown"; detail = flattenText(result.reason, 120); }
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
