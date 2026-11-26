import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectTrips, type CalendarEventLike, type EmailLike, type TripCandidate } from "../src/derive.ts";

/**
 * WP-G2c (D-483, JARVIS-113 e): herding av `detectTrips`.
 *  1. hjemmested = EKSAKT, normalisert treff på hele stedsfeltet (før: delstrengtreff i begge retninger), og FEIL LUKKET uten kjente hjemmesteder
 *  2. lineær/n·log n (før: O(n^2) pga. `Math.max(...)` per hendelse og et fullt e-postfilter per reise)
 *  3. ingen spredning av lange lister (`Math.max(...liste)` gir RangeError ved ca. 120 000 elementer)
 *  4. `trip_id` er en INTERN hash, aldri den eksterne hendelses-id-en
 * Rene funksjoner: ingen database, ingen klokke, ingen nettverk.
 */
const T0 = Date.parse("2026-12-01T00:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();
const ev = (event_id: string, start: number, end: number, extra: Partial<CalendarEventLike> = {}): CalendarEventLike => ({ event_id, title: "Møte", starts_at: iso(start), ends_at: iso(end), ...extra });
/** Et langt arrangement (to dager) med sted. */
const away = (event_id: string, location: string | undefined, start = T0): CalendarEventLike => ev(event_id, start, start + 2 * DAY, location === undefined ? {} : { location });
const trips = (events: CalendarEventLike[], homeLocations: readonly string[], emails?: EmailLike[]): TripCandidate[] => detectTrips(events, emails === undefined ? { homeLocations } : { homeLocations, emails });

describe("detectTrips: hjemmested er et EKSAKT, normalisert treff på hele stedsfeltet (JARVIS-113 e/1)", () => {
  it("store/små bokstaver, ekstra mellomrom og NFKC-former (full bredde) er samme sted: hjemme, ingen reise", () => {
    for (const location of ["Oslo", "OSLO", "  oslo  ", "Ｏｓｌｏ", "oslo "]) {
      expect(trips([away("e-1", location)], ["Oslo"]), JSON.stringify(location)).toEqual([]);
    }
    expect(trips([away("e-1", "Oslo   Sentrum")], ["oslo sentrum"])).toEqual([]);
    expect(trips([away("e-1", "oslo sentrum")], ["  OSLO\tSENTRUM  "])).toEqual([]);
  });

  it("et DELSTRENGTREFF er IKKE hjemme: «Os», «Oslo lufthavn» og «Hjemme hos Per i Bergen» er reiser når bare «Oslo»/«Hjemme» er hjemmesteder (før: alle tre ble regnet som hjemme)", () => {
    const home = ["Oslo", "Hjemme"];
    expect(trips([away("e-1", "Os")], home)).toMatchObject([{ basis: "deterministic", destination: "Os" }]); // stedet er en del av hjemmestedet
    expect(trips([away("e-2", "Oslo lufthavn")], home)).toMatchObject([{ basis: "deterministic", destination: "Oslo lufthavn" }]); // hjemmestedet er en del av stedet
    expect(trips([away("e-3", "Hjemme hos Per i Bergen")], home)).toMatchObject([{ basis: "deterministic", destination: "Hjemme hos Per i Bergen" }]);
    expect(trips([away("e-4", "Oslo S")], home)).toMatchObject([{ basis: "deterministic", destination: "Oslo S" }]); // eieren må selv føre opp «Oslo S» hvis det er hjemme
    expect(trips([away("e-5", "Oslo S")], ["Oslo", "Oslo S"])).toEqual([]);
  });

  it("flere hjemmesteder: treffer ett av dem, er det hjemme; ellers reise (også når et annet hjemmested er en delstreng)", () => {
    const home = ["Oslo", "Hjemme", "Hytta"];
    expect(trips([away("e-1", "hytta")], home)).toEqual([]);
    expect(trips([away("e-2", "Hytta på fjellet")], home)).toHaveLength(1);
  });

  it("hjemmestedets egen normalisering gjelder også tomme/blanke navn: de teller aldri som hjemmested", () => {
    expect(trips([away("e-1", "Bergen")], ["", "   ", "Oslo"])).toMatchObject([{ destination: "Bergen" }]);
  });
});

describe("detectTrips: FEIL LUKKET uten kjente hjemmesteder (JARVIS-113 e/1)", () => {
  it("tom liste: et sted alene gjør ALDRI en deterministisk reise (ingenting kan bevises «borte fra hjemmet»); før ble hver hendelse med sted en reise", () => {
    expect(trips([away("e-1", "Bergen"), away("e-2", "Oslo", T0 + 10 * DAY), away("e-3", "Paris", T0 + 20 * DAY)], [])).toEqual([]);
  });

  it("bare blanke navn er det samme som en tom liste", () => {
    expect(trips([away("e-1", "Bergen")], ["", "  ", "\t"])).toEqual([]);
  });

  it("reiseord i tittelen gir fortsatt en GJETNING (inferred), men aldri et reisemål eller en deterministisk reise uten hjemmesteder", () => {
    const withWords = ev("e-1", T0, T0 + 2 * DAY, { title: "Flight to Rome", location: "Roma" });
    const result = trips([withWords], []);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ basis: "inferred", destination: null, event_ids: ["e-1"] });
    // uten tittelord: ingenting
    expect(trips([ev("e-2", T0, T0 + 2 * DAY, { title: "Arbeid", location: "Roma" })], [])).toEqual([]);
  });

  it("kjente hjemmesteder og et ukjent sted: en deterministisk reise med reisemål (uendret oppførsel)", () => {
    expect(trips([away("e-1", "Bergen")], ["Oslo"])).toMatchObject([{ basis: "deterministic", destination: "Bergen" }]);
  });

  it("hendelser uten sted regnes aldri som hjemme/borte av hjemmestedene: bare reiseord gir gjetning", () => {
    expect(trips([away("e-1", undefined)], ["Oslo"])).toEqual([]);
    expect(trips([ev("e-2", T0, T0 + 2 * DAY, { title: "Hotell i Bergen" })], ["Oslo"])).toMatchObject([{ basis: "inferred", destination: null }]);
  });
});

describe("detectTrips: trip_id er en INTERN hash og bærer aldri den eksterne hendelses-id-en (JARVIS-113 e/4)", () => {
  const HOSTILE = "alice@example.com/https://cal.example.test/ev?id=hemmelig-nøkkel&token=abc123";

  it("formatet er `trip-` + 24 hex, også for fiendtlige id-er (e-postadresse, URL, nullbyte, linjeskift, svært lang)", () => {
    for (const id of [HOSTILE, "a\u0000b", "linje\nskift", "x".repeat(10_000), "", "æøå-💥"]) {
      const [t] = trips([away(id, "Bergen")], ["Oslo"]);
      expect(t?.trip_id, JSON.stringify(id).slice(0, 40)).toMatch(/^trip-[0-9a-f]{24}$/);
    }
  });

  it("id-en inneholder ingen del av den eksterne id-en, og hele `trip_id` kan ikke føres tilbake (verken i klartekst eller som delstreng)", () => {
    const [t] = trips([away(HOSTILE, "Bergen")], ["Oslo"]);
    const id = t!.trip_id;
    for (const part of ["alice", "example", "hemmelig", "token", "abc123", "cal.", "https", "@", "?", "&", "="]) expect(id).not.toContain(part);
    expect(id).not.toContain(HOSTILE);
    expect(id.length).toBe("trip-".length + 24);
  });

  it("STABIL: samme første hendelse og startdag gir samme id, uansett rekkefølge i inndata, og når reisen vokser bakover i tid IKKE (da er første hendelse en annen)", () => {
    const a = away("e-a", "Berlin");
    const b = ev("e-b", T0 + 2 * DAY, T0 + 3 * DAY, { location: "Berlin" });
    const first = trips([a, b], ["Oslo"]);
    expect(trips([b, a], ["Oslo"])).toEqual(first);
    expect(trips([a], ["Oslo"])[0]?.trip_id).toBe(first[0]?.trip_id); // en senere hendelse i reisen endrer ikke id-en
    const earlier = ev("e-0", T0 - DAY, T0, { location: "Berlin" });
    expect(trips([earlier, a, b], ["Oslo"])[0]?.trip_id).not.toBe(first[0]?.trip_id);
  });

  it("id-en avhenger av BÅDE første hendelses id og startdagen, og to ulike reiser får ulike id-er", () => {
    const base = trips([away("e-1", "Bergen", T0)], ["Oslo"])[0]!.trip_id;
    expect(trips([away("e-2", "Bergen", T0)], ["Oslo"])[0]!.trip_id).not.toBe(base); // annen hendelse
    expect(trips([away("e-1", "Bergen", T0 + DAY)], ["Oslo"])[0]!.trip_id).not.toBe(base); // annen startdag
    expect(trips([away("e-1", "Bergen", T0 + HOUR)], ["Oslo"])[0]!.trip_id).toBe(base); // samme dag (UTC-dato)
    const both = trips([away("e-1", "Bergen", T0), away("e-1", "Paris", T0 + 30 * DAY)], ["Oslo"]);
    expect(new Set(both.map((t) => t.trip_id)).size).toBe(2);
  });

  it("ingen kollisjoner på 5 000 ulike hendelser, og id-en er uavhengig av sted og tittel", () => {
    const events = Array.from({ length: 5_000 }, (_, i) => away(`ev-${i}`, "Bergen", T0 + i * 10 * DAY));
    const ids = trips(events, ["Oslo"]).map((t) => t.trip_id);
    expect(ids).toHaveLength(5_000);
    expect(new Set(ids).size).toBe(5_000);
    expect(trips([away("ev-1", "Bergen")], ["Oslo"])[0]!.trip_id).toBe(trips([ev("ev-1", T0, T0 + 2 * DAY, { location: "Paris", title: "Noe helt annet" })], ["Oslo"])[0]!.trip_id);
  });

  it("`event_ids` (koblingen tilbake til kalenderen) er uendret: det er kun `trip_id` som er internt", () => {
    expect(trips([away(HOSTILE, "Bergen")], ["Oslo"])[0]?.event_ids).toEqual([HOSTILE]);
  });

  it("samme starttidspunkt: «første hendelse» velges etter kodeenhet-rekkefølge (ikke locale), så id-en er den samme på alle verter", () => {
    const upper = away("B-1", "Bergen");
    const lower = away("a-1", "Bergen");
    const result = trips([lower, upper], ["Oslo"]);
    expect(result[0]?.event_ids).toEqual(["B-1", "a-1"]); // «B» (0x42) før «a» (0x61); `localeCompare` ville gitt motsatt rekkefølge
    expect(trips([upper, lower], ["Oslo"])).toEqual(result);
  });
});

describe("detectTrips: e-postsignalenes vindu (binærsøk) er uendret og eksakt (JARVIS-113 e/2)", () => {
  const trip = ev("e-1", T0, T0 + 2 * DAY, { location: "Bergen" });
  const END = T0 + 2 * DAY;
  const mail = (message_id: string, at: number, subject = "Din flybillett"): EmailLike => ({ message_id, subject, received_at: iso(at) });
  const signalIds = (emails: EmailLike[]): string[] => trips([trip], ["Oslo"], emails)[0]!.email_signal_ids;

  it("grensene: akkurat 14 dager før start er med, ett millisekund tidligere er det ikke; akkurat ved slutten er med, ett millisekund etter er det ikke", () => {
    expect(signalIds([mail("lo-1", T0 - 14 * DAY - 1), mail("lo", T0 - 14 * DAY), mail("hi", END), mail("hi+1", END + 1)])).toEqual(["lo", "hi"]);
  });

  it("resultatet beholder INNDATA-rekkefølgen (ikke tidsrekkefølgen), duplikate tidspunkt beholder inndata-rekkefølgen, og ugyldige/ikke-reisee-poster utelates", () => {
    const emails = [mail("c", T0 + DAY), mail("a", T0 - DAY), mail("b", T0 + DAY), { message_id: "bad", subject: "Din flybillett", received_at: "ikke en dato" }, mail("nl", T0, "Nyhetsbrev"), mail("d", T0 - 2 * DAY)];
    expect(signalIds(emails)).toEqual(["c", "a", "b", "d"]);
  });

  it("flere reiser får hver sitt vindu; en e-post kan høre til flere reiser (overlappende vinduer), og e-post utenfor alle vinduer til ingen", () => {
    const t1 = ev("e-1", T0, T0 + 2 * DAY, { location: "Bergen" });
    const t2 = ev("e-2", T0 + 10 * DAY, T0 + 11 * DAY, { location: "Paris" });
    const emails = [mail("m1", T0 - 20 * DAY), mail("m2", T0 + DAY), mail("m3", T0 + 5 * DAY), mail("m4", T0 + 11 * DAY), mail("m5", T0 + 11 * DAY + HOUR)];
    const out = trips([t2, t1], ["Oslo"], emails);
    expect(out.map((t) => t.event_ids)).toEqual([["e-1"], ["e-2"]]);
    // m2 (T0+1d) er både innenfor reise 1 og innenfor 14 dager før reise 2; m3 kun reise 2; m4 er akkurat reise 2s slutt; m1 og m5 ingen
    expect(out.map((t) => t.email_signal_ids)).toEqual([["m2"], ["m2", "m3", "m4"]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Differensialtest mot en naiv O(n^2)-referanse (den gamle algoritmen med eksakt hjemmesteds-treff): samme utfall på tilfeldige (seedede) inndata.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES = ["Møte", "Flight til Roma", "Arbeidsdag", "Hotel Bergen", "Lunsj"] as const;
const isTravelTitle = (t: string): boolean => t.startsWith("Flight") || t.startsWith("Hotel");
const SUBJECTS = ["Din flybillett", "Nyhetsbrev", "Boarding pass", "Hei", "Booking confirmation"] as const;
const isTravelSubject = (s: string): boolean => s === "Din flybillett" || s === "Boarding pass" || s === "Booking confirmation";
const LOCATIONS = ["Bergen", "Oslo", " oslo ", "Tromsø", "Oslo S", "  Paris  ", "Hjemme", ""] as const;
const HOMES = ["Oslo", "hjemme"] as const;

function reference(events: readonly CalendarEventLike[], emails: readonly EmailLike[], homeLocations: readonly string[]): Array<Omit<TripCandidate, "trip_id">> {
  const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const homes = homeLocations.map(norm).filter((h) => h.length > 0);
  const items: Array<{ e: CalendarEventLike; start: number; end: number; basis: "deterministic" | "inferred" }> = [];
  for (const e of events) {
    const start = Date.parse(e.starts_at);
    const end = Date.parse(e.ends_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    if (!(e.all_day === true || end - start >= 4 * HOUR)) continue;
    const location = typeof e.location === "string" ? norm(e.location) : "";
    if (location.length > 0 && homes.length > 0) {
      if (homes.includes(location)) continue;
      items.push({ e, start, end, basis: "deterministic" });
    } else if (isTravelTitle(e.title)) items.push({ e, start, end, basis: "inferred" });
  }
  items.sort((a, b) => a.start - b.start || (a.e.event_id < b.e.event_id ? -1 : a.e.event_id > b.e.event_id ? 1 : 0));
  const groups: Array<typeof items> = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    let lastEnd = Number.NEGATIVE_INFINITY;
    if (last !== undefined) for (const g of last) lastEnd = Math.max(lastEnd, g.end);
    if (last !== undefined && item.start - lastEnd <= 36 * HOUR) last.push(item);
    else groups.push([item]);
  }
  return groups.map((group) => {
    const start = Math.min(...group.map((g) => g.start));
    const end = Math.max(...group.map((g) => g.end));
    const firstWithPlace = group.find((g) => g.basis === "deterministic");
    return {
      starts_at: iso(start), ends_at: iso(end),
      destination: firstWithPlace?.e.location?.trim() || null,
      event_ids: group.map((g) => g.e.event_id),
      basis: group.some((g) => g.basis === "deterministic") ? "deterministic" : "inferred",
      email_signal_ids: emails.filter((m) => {
        const at = Date.parse(m.received_at);
        return isTravelSubject(m.subject) && Number.isFinite(at) && at >= start - 14 * DAY && at <= end;
      }).map((m) => m.message_id)
    };
  });
}

function randomCase(seed: number, nEvents: number, nEmails: number): { events: CalendarEventLike[]; emails: EmailLike[] } {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const events = Array.from({ length: nEvents }, (_, i): CalendarEventLike => {
    const start = T0 + Math.floor(rnd() * 300 * 24) * HOUR;
    const dur = (1 + Math.floor(rnd() * 90)) * HOUR;
    const e: CalendarEventLike = { event_id: `ev-${i}`, title: pick(TITLES), starts_at: iso(start), ends_at: iso(start + dur) };
    const loc = pick(LOCATIONS);
    if (loc !== "") e.location = loc;
    if (rnd() < 0.15) e.all_day = true;
    if (rnd() < 0.02) e.ends_at = "ikke en dato"; // ugyldig
    if (rnd() < 0.02) e.ends_at = iso(start - HOUR); // slutt før start
    return e;
  });
  const emails = Array.from({ length: nEmails }, (_, i): EmailLike => ({
    message_id: `m-${i}`, subject: pick(SUBJECTS), received_at: rnd() < 0.03 ? "ugyldig" : iso(T0 + Math.floor((rnd() * 330 - 20) * 24) * HOUR)
  }));
  return { events, emails };
}

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe("detectTrips: samme utfall som en naiv O(n^2)-referanse på tilfeldige (seedede) inndata, og uavhengig av rekkefølgen i inndata", () => {
  it("40 tilfeldige tilfeller (opptil 300 hendelser og 200 e-poster) gir identiske reiser (sted, tider, hendelser, grunnlag, e-postsignaler); id-ene er unike", () => {
    let nonEmpty = 0;
    let multi = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { events, emails } = randomCase(seed, 20 + (seed * 7) % 281, (seed * 5) % 201);
      const got = detectTrips(events, { homeLocations: HOMES, emails });
      const expected = reference(events, emails, HOMES);
      expect(got.map(({ trip_id: _id, ...rest }) => rest), `seed ${seed}`).toEqual(expected);
      expect(new Set(got.map((t) => t.trip_id)).size, `seed ${seed}`).toBe(got.length);
      if (got.length > 0) nonEmpty++;
      if (got.some((t) => t.event_ids.length > 1)) multi++;
      // rekkefølgen i inndata spiller ingen rolle for reisene (e-postsignalene følger inndata-rekkefølgen, så de holdes like)
      expect(detectTrips(shuffled(events, seed), { homeLocations: HOMES, emails }), `seed ${seed} (shuffle)`).toEqual(got);
    }
    expect(nonEmpty).toBeGreaterThan(30); // testen er ikke tom
    expect(multi).toBeGreaterThan(20); // og sammenslåing er dekket
  });

  it("uten hjemmesteder (tom liste) er referansen og implementasjonen enige: bare gjetninger fra reiseord", () => {
    for (let seed = 101; seed <= 110; seed++) {
      const { events, emails } = randomCase(seed, 150, 80);
      const got = detectTrips(events, { homeLocations: [], emails });
      expect(got.map(({ trip_id: _id, ...rest }) => rest), `seed ${seed}`).toEqual(reference(events, emails, []));
      for (const t of got) expect(t).toMatchObject({ basis: "inferred", destination: null });
    }
  });
});

describe("detectTrips: lineær i antall hendelser og uten spredning av lange lister (JARVIS-113 e/2-3)", () => {
  it("150 000 lenkede hendelser i én reise: ingen RangeError (før: `Math.max(...liste)` brøt ved ca. 120 000) og under 5 s (før: O(n^2))", () => {
    const n = 150_000;
    const events = Array.from({ length: n }, (_, i): CalendarEventLike => ({ event_id: `e-${i}`, title: "Møte", starts_at: iso(T0 + i * HOUR), ends_at: iso(T0 + (i + 1) * HOUR), location: "Bergen", all_day: true }));
    const started = performance.now();
    const result = detectTrips(events, { homeLocations: ["Oslo"] });
    const elapsed = performance.now() - started;
    expect(result).toHaveLength(1);
    expect(result[0]?.event_ids).toHaveLength(n);
    expect(result[0]).toMatchObject({ starts_at: iso(T0), ends_at: iso(T0 + n * HOUR), destination: "Bergen", basis: "deterministic" });
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);

  it("e-postsignaler leses ÉN gang per e-post uansett antall reiser (ingen fullt e-postfilter per reise: n·m -> n·log n)", () => {
    const nTrips = 2_000;
    const events = Array.from({ length: nTrips }, (_, i) => away(`e-${i}`, "Bergen", T0 + i * 5 * DAY));
    let reads = 0;
    const emails: EmailLike[] = Array.from({ length: 2_000 }, (_, i) => {
      const base = { message_id: `m-${i}`, subject: "Din flybillett" };
      return Object.defineProperty(base, "received_at", { enumerable: true, get: () => { reads++; return iso(T0 + i * 5 * DAY); } }) as EmailLike;
    });
    const result = detectTrips(events, { homeLocations: ["Oslo"], emails });
    expect(result).toHaveLength(nTrips);
    expect(reads).toBeLessThanOrEqual(emails.length); // en gang per e-post, ikke en gang per (reise, e-post)
    expect(result.every((t) => t.email_signal_ids.length >= 1)).toBe(true);
  });

  it("mange reiser og mange e-poster (50 000 hver) uten tidsavbrudd, og hver reise får nøyaktig sine signaler", () => {
    const n = 50_000;
    const events = Array.from({ length: n }, (_, i) => ev(`e-${i}`, T0 + i * 3 * DAY, T0 + i * 3 * DAY + HOUR, { location: "Bergen", all_day: true }));
    const emails = Array.from({ length: n }, (_, i): EmailLike => ({ message_id: `m-${i}`, subject: "Din flybillett", received_at: iso(T0 + i * 3 * DAY) }));
    const started = performance.now();
    const result = detectTrips(events, { homeLocations: ["Oslo"], emails });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(result).toHaveLength(n);
    // reise i: e-poster mottatt fra (start - 14 d) til slutt (start + 1 t): de 4 forrige (3-dagersavstand, 14 d / 3 d) og sin egen
    const mid = result[25_000]!;
    expect(mid.email_signal_ids).toEqual(["m-24996", "m-24997", "m-24998", "m-24999", "m-25000"]);
    expect(result[0]?.email_signal_ids).toEqual(["m-0"]);
  }, 60_000);

  it("kildekoden spreder aldri en liste inn i Math.max/Math.min (en stakkgrense som kan gi RangeError på stor inndata)", () => {
    // kommentarene fjernes først: de beskriver selve feilen og nevner uttrykket
    const code = readFileSync(new URL("../src/derive.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("detectTrips"); // fjerningen av kommentarer tok ikke med seg koden
    expect(code).not.toMatch(/Math\.(max|min)\(\s*\.\.\./);
  });
});
