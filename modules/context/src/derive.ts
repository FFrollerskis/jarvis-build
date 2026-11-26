import { createHash } from "node:crypto";

/**
 * WP-G2 (D-464, UA-8 Personal Twin) P2g: RENE avledninger for den personlige konteksten (tid på døgnet og reise) - ingen database, ingen modell, ingen klokke utenom den som sendes inn. De bygger på dataene `ContextEngine` og kalenderen
 * allerede har og lagrer ingenting selv; kalleren bestemmer om et utfall blir en `context_observations`-rad (da med `basis` som under). Alt som kommer fra e-post/kalender er UBETRODD data: kun enkeltord matches deterministisk,
 * ingen tekst tolkes som instruks, og utfallet bærer aldri innsendt fritekst utover et reisemål som allerede står i kalenderens stedsfelt.
 * Samme regel som resten av kontekstmotoren: `deterministic` er bevist av data (stedsfelt som avviker fra hjemmesteder), `inferred` er en gjetning fra nøkkelord og skal aldri overstyre noe deterministisk.
 */
export type PartOfDay = "night" | "morning" | "day" | "evening";

export interface TimeContext {
  /** Lokal dato (YYYY-MM-DD) i tidssonen. */
  local_date: string;
  /** ISO-ukedag: 1 = mandag ... 7 = søndag. */
  iso_weekday: number;
  is_weekend: boolean;
  part_of_day: PartOfDay;
  time_zone: string;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Tid på døgnet og ukedag i en gitt tidssone: natt 00-06, morgen 06-12, dag 12-18, kveld 18-24. Ren funksjon av (tidspunkt, tidssone). */
export function deriveTimeContext(now: Date, timeZone: string): TimeContext {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(now).map((p) => [p.type, p.value])
  ) as Record<string, string>;
  const hour = Number(parts["hour"]);
  const isoWeekday = WEEKDAYS[parts["weekday"] as string] as number;
  return {
    local_date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    iso_weekday: isoWeekday,
    is_weekend: isoWeekday >= 6,
    part_of_day: hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "day" : "evening",
    time_zone: timeZone
  };
}

export interface CalendarEventLike {
  event_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  /** Kalenderens stedsfelt (data, ikke instruks). */
  location?: string | null;
  all_day?: boolean;
}

export interface EmailLike {
  message_id: string;
  subject: string;
  received_at: string;
}

export interface TripCandidate {
  /**
   * Stabil, INTERN id: samme første hendelse og startdag gir samme id, uansett rekkefølge i inndata. Den er en hash (`trip-` + 24 hex av SHA-256): den bærer ALDRI den eksterne hendelses-id-en (en kalender-id kan være en e-postadresse, en
   * URL eller en tilfeldig nøkkel som tilhører en tredjepart) og kan ikke føres tilbake til den (WP-G2c, JARVIS-113 e).
   */
  trip_id: string;
  starts_at: string;
  ends_at: string;
  /** Stedsfeltet fra den første hendelsen borte fra hjemmet (kalenderdata), ellers `null`. */
  destination: string | null;
  event_ids: string[];
  /** `deterministic`: hendelsen har et sted som ikke er et hjemmested. `inferred`: kun nøkkelord (tittel) - en gjetning. */
  basis: "deterministic" | "inferred";
  /** E-poster med reisebekreftelse-signal som peker på samme periode (kun id-er; innholdet leses aldri videre). */
  email_signal_ids: string[];
}

const TRAVEL_WORDS = /\b(flight|fly|flyvning|avgang|departure|tog|train|ferge|ferry|hotell|hotel|reise|trip|overnatting|booking)\b/i;
const EMAIL_TRAVEL_WORDS = /\b(flybillett|billett|boarding|e-?ticket|itinerary|reiseplan|hotellbooking|booking confirmation|bookingbekreftelse|check-?in)\b/i;
const MIN_AWAY_MS = 4 * 3_600_000;
const MAX_GAP_MS = 36 * 3_600_000;
const EMAIL_LOOKBACK_MS = 14 * 86_400_000;
const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** E-poster som ser ut som reisebekreftelser (kun et SIGNAL: emneord, ingen innholdstolking, aldri dato/sted herfra). Returnerer meldings-id-er. */
export function emailTravelSignals(emails: readonly EmailLike[]): string[] {
  return emails.filter((e) => EMAIL_TRAVEL_WORDS.test(e.subject)).map((e) => e.message_id);
}

/** Kodeenhet-sammenligning (ikke `localeCompare`): samme rekkefølge uavhengig av ICU/locale, så «første hendelse» og dermed `trip_id` er deterministisk overalt. */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Intern, hashet reise-id (se `TripCandidate.trip_id`). Domeneseparert; 96 bits er rikelig mot kollisjon innen én eiers kalender. */
function tripIdFor(firstEventId: string, startMs: number): string {
  return `trip-${createHash("sha256").update(`jarvis-trip-v1\u0000${firstEventId}\u0000${new Date(startMs).toISOString().slice(0, 10)}`).digest("hex").slice(0, 24)}`;
}

/** Første indeks i den sorterte tabellen `at` med `at[i] >= x` (binærsøk). */
function lowerBound(at: readonly number[], x: number): number {
  let lo = 0;
  let hi = at.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((at[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Finner reiser i kalenderen: en hendelse er «borte» når den har et sted som IKKE er et hjemmested (deterministisk) og varer minst fire timer eller er heldags; en hendelse uten sted men med reiseord i tittelen og samme varighet er en
 * GJETNING (`inferred`). Hendelser med høyst 36 timer mellom seg slås sammen til én reise. `homeLocations` er eierens egne stedsnavn (`business_activities`/konfigurasjon). E-postsignaler knyttes kun til en reise når mottakstidspunktet
 * ligger innenfor 14 dager før reisens start til reisens slutt (de gir aldri en reise alene: en e-post uten kalenderhendelse er ikke nok data for datoer).
 *
 * WP-G2c (D-483, JARVIS-113 e):
 *  - HJEMMESTED = EKSAKT, normalisert treff på hele stedsfeltet (NFKC, små bokstaver, komprimert mellomrom). Før var det et delstrengtreff i begge retninger: «Os» regnet som hjemme for «Oslo», og «Oslo lufthavn» (stedet reisen starter) regnet som
 *    hjemme. Eieren oppgir stedsnavnene slik de står i kalenderen; alt annet er «ikke et oppgitt hjemmested».
 *  - FEIL LUKKET uten kjente hjemmesteder (tom liste eller bare tomme navn): ingenting kan bevises «borte fra hjemmet», så en hendelse med sted blir ALDRI en deterministisk reise (før: hver hendelse med sted ble det). Reiseord i tittelen gir fortsatt en
 *    GJETNING (`inferred`, uten reisemål) - den bygger ikke på hjemmesteder.
 *  - LINEÆR/n·log n: løpende maks per gruppe (før `Math.max(...)` over hele gruppen for HVER hendelse = O(n^2), 20 000 lenkede hendelser tok 3,1 s) og binærsøk i de sorterte e-postsignalene (før en full gjennomgang av alle e-poster per reise).
 *    Ingen spredning av lange lister (`Math.max(...liste)` gir RangeError ved ca. 120 000 elementer).
 */
export function detectTrips(events: readonly CalendarEventLike[], options: { homeLocations: readonly string[]; emails?: readonly EmailLike[] }): TripCandidate[] {
  const homes = new Set(options.homeLocations.map(norm).filter((h) => h.length > 0));
  const away = events
    .map((e) => {
      const start = Date.parse(e.starts_at);
      const end = Date.parse(e.ends_at);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
      const long = e.all_day === true || end - start >= MIN_AWAY_MS;
      if (!long) return null;
      const location = typeof e.location === "string" ? norm(e.location) : "";
      // Et sted er BEVIST «borte» bare når hjemstedene er kjent og stedet ikke er ett av dem.
      if (location.length > 0 && homes.size > 0) return homes.has(location) ? null : { e, start, end, basis: "deterministic" as const };
      return TRAVEL_WORDS.test(e.title) ? { e, start, end, basis: "inferred" as const } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.start - b.start || byCode(a.e.event_id, b.e.event_id));

  // Grupper: sortert på start, så gruppens start er første elements start, og slutten holdes som løpende maks.
  const groups: Array<{ items: typeof away; start: number; end: number }> = [];
  for (const item of away) {
    const last = groups[groups.length - 1];
    if (last !== undefined && item.start - last.end <= MAX_GAP_MS) {
      last.items.push(item);
      if (item.end > last.end) last.end = item.end;
    } else groups.push({ items: [item], start: item.start, end: item.end });
  }

  // E-postsignaler: filtrer og tidsfest ÉN gang, sorter på tid, og finn hver reises vindu med binærsøk (resultatet i inndata-rekkefølge, som før).
  const signals = (options.emails ?? []).flatMap((m, index) => {
    const at = Date.parse(m.received_at);
    return EMAIL_TRAVEL_WORDS.test(m.subject) && Number.isFinite(at) ? [{ at, index, id: m.message_id }] : [];
  }).sort((a, b) => a.at - b.at || a.index - b.index);
  const signalTimes = signals.map((m) => m.at);

  return groups.map((group) => {
    const first = group.items[0]!;
    const firstWithPlace = group.items.find((g) => g.basis === "deterministic");
    const from = lowerBound(signalTimes, group.start - EMAIL_LOOKBACK_MS);
    const to = lowerBound(signalTimes, group.end + 1); // `at <= end`
    const emailSignalIds = signals.slice(from, to).sort((a, b) => a.index - b.index).map((m) => m.id);
    return {
      trip_id: tripIdFor(first.e.event_id, group.start),
      starts_at: new Date(group.start).toISOString(), ends_at: new Date(group.end).toISOString(),
      destination: firstWithPlace?.e.location?.trim() || null,
      event_ids: group.items.map((g) => g.e.event_id),
      basis: firstWithPlace !== undefined ? "deterministic" : "inferred",
      email_signal_ids: emailSignalIds
    };
  });
}
