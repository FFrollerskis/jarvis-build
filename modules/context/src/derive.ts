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
  /** Stabil id: samme hendelser gir samme id. */
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
const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** E-poster som ser ut som reisebekreftelser (kun et SIGNAL: emneord, ingen innholdstolking, aldri dato/sted herfra). Returnerer meldings-id-er. */
export function emailTravelSignals(emails: readonly EmailLike[]): string[] {
  return emails.filter((e) => EMAIL_TRAVEL_WORDS.test(e.subject)).map((e) => e.message_id);
}

/**
 * Finner reiser i kalenderen: en hendelse er «borte» når den har et sted som IKKE er et hjemmested (deterministisk) og varer minst fire timer eller er heldags; en hendelse uten sted men med reiseord i tittelen og samme varighet er en
 * GJETNING (`inferred`). Hendelser med høyst 36 timer mellom seg slås sammen til én reise. `homeLocations` er eierens egne stedsnavn (`business_activities`/konfigurasjon). E-postsignaler knyttes kun til en reise når mottakstidspunktet
 * ligger innenfor 14 dager før reisens start til reisens slutt (de gir aldri en reise alene: en e-post uten kalenderhendelse er ikke nok data for datoer).
 */
export function detectTrips(events: readonly CalendarEventLike[], options: { homeLocations: readonly string[]; emails?: readonly EmailLike[] }): TripCandidate[] {
  const homes = options.homeLocations.map(norm).filter((h) => h.length > 0);
  const away = events
    .map((e) => {
      const start = Date.parse(e.starts_at);
      const end = Date.parse(e.ends_at);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
      const long = e.all_day === true || end - start >= MIN_AWAY_MS;
      const location = typeof e.location === "string" ? norm(e.location) : "";
      const atHome = location.length > 0 && homes.some((h) => location.includes(h) || h.includes(location));
      if (!long || atHome) return null;
      if (location.length > 0) return { e, start, end, basis: "deterministic" as const };
      return TRAVEL_WORDS.test(e.title) ? { e, start, end, basis: "inferred" as const } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.start - b.start || a.e.event_id.localeCompare(b.e.event_id));

  const groups: Array<typeof away> = [];
  for (const item of away) {
    const last = groups[groups.length - 1];
    const lastEnd = last === undefined ? Number.NEGATIVE_INFINITY : Math.max(...last.map((g) => g.end));
    if (last !== undefined && item.start - lastEnd <= MAX_GAP_MS) last.push(item);
    else groups.push([item]);
  }
  const emails = options.emails ?? [];
  return groups.map((group) => {
    const start = Math.min(...group.map((g) => g.start));
    const end = Math.max(...group.map((g) => g.end));
    const firstWithPlace = group.find((g) => g.basis === "deterministic");
    const signals = emails.filter((m) => {
      const at = Date.parse(m.received_at);
      return EMAIL_TRAVEL_WORDS.test(m.subject) && Number.isFinite(at) && at >= start - 14 * 86_400_000 && at <= end;
    }).map((m) => m.message_id);
    return {
      trip_id: `trip-${group[0]!.e.event_id}-${new Date(start).toISOString().slice(0, 10)}`,
      starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(),
      destination: firstWithPlace?.e.location?.trim() || null,
      event_ids: group.map((g) => g.e.event_id),
      basis: group.some((g) => g.basis === "deterministic") ? "deterministic" : "inferred",
      email_signal_ids: signals
    };
  });
}
