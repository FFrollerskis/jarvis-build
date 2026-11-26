import { describe, expect, it } from "vitest";
import { easterSunday, isNorwegianHoliday, isSundayOrNorwegianHoliday, localCalendarDate, norwegianHolidays, weekday, type CalendarDate } from "../src/holidays.ts";

/**
 * WP-G1c (JARVIS-112 g2): norsk helligdagsberegning i ren kode. Ingen database, ingen klokke, ingen nettverk.
 * Forventede datoer er skrevet ned for hånd (kjente påskedatoer og tellingen P-3, P-2, P+1, P+39, P+49, P+50) og krysskontrolleres av egenskapstester som ikke bruker samme algoritme (ukedager og Gauss).
 */
const d = (year: number, month: number, day: number): CalendarDate => ({ year, month, day });
const iso = (c: CalendarDate): string => `${String(c.year).padStart(4, "0")}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;

/** Kjente påskedager (1. påskedag, gregoriansk). */
const KNOWN_EASTER: Array<[number, string]> = [
  [1818, "1818-03-22"], [1943, "1943-04-25"], [2000, "2000-04-23"], [2008, "2008-03-23"], [2011, "2011-04-24"], [2016, "2016-03-27"], [2019, "2019-04-21"], [2020, "2020-04-12"], [2021, "2021-04-04"],
  [2022, "2022-04-17"], [2023, "2023-04-09"], [2024, "2024-03-31"], [2025, "2025-04-20"], [2026, "2026-04-05"], [2027, "2027-03-28"], [2028, "2028-04-16"], [2029, "2029-04-01"],
  [2030, "2030-04-21"], [2031, "2031-04-13"], [2032, "2032-03-28"], [2033, "2033-04-17"], [2034, "2034-04-09"], [2035, "2035-03-25"], [2038, "2038-04-25"], [2285, "2285-03-22"]
];

/** Alle tolv høytidsdager per år (håndregnet fra påskedagen; se kommentar over). */
const EXPECTED: Record<number, string[]> = {
  2024: ["2024-01-01", "2024-03-28", "2024-03-29", "2024-03-31", "2024-04-01", "2024-05-01", "2024-05-09", "2024-05-17", "2024-05-19", "2024-05-20", "2024-12-25", "2024-12-26"],
  2025: ["2025-01-01", "2025-04-17", "2025-04-18", "2025-04-20", "2025-04-21", "2025-05-01", "2025-05-17", "2025-05-29", "2025-06-08", "2025-06-09", "2025-12-25", "2025-12-26"],
  2026: ["2026-01-01", "2026-04-02", "2026-04-03", "2026-04-05", "2026-04-06", "2026-05-01", "2026-05-14", "2026-05-17", "2026-05-24", "2026-05-25", "2026-12-25", "2026-12-26"],
  2027: ["2027-01-01", "2027-03-25", "2027-03-26", "2027-03-28", "2027-03-29", "2027-05-01", "2027-05-06", "2027-05-16", "2027-05-17", "2027-05-17", "2027-12-25", "2027-12-26"],
  2028: ["2028-01-01", "2028-04-13", "2028-04-14", "2028-04-16", "2028-04-17", "2028-05-01", "2028-05-17", "2028-05-25", "2028-06-04", "2028-06-05", "2028-12-25", "2028-12-26"],
  2029: ["2029-01-01", "2029-03-29", "2029-03-30", "2029-04-01", "2029-04-02", "2029-05-01", "2029-05-10", "2029-05-17", "2029-05-20", "2029-05-21", "2029-12-25", "2029-12-26"],
  2030: ["2030-01-01", "2030-04-18", "2030-04-19", "2030-04-21", "2030-04-22", "2030-05-01", "2030-05-17", "2030-05-30", "2030-06-09", "2030-06-10", "2030-12-25", "2030-12-26"]
};

describe("easterSunday: kjente datoer", () => {
  for (const [year, expected] of KNOWN_EASTER) {
    it(`${year} -> ${expected}`, () => {
      expect(iso(easterSunday(year))).toBe(expected);
    });
  }

  it("avviser år utenfor den gregorianske kalenderen og ikke-heltall (aldri en gjetning)", () => {
    for (const bad of [1582, 0, -5, 10_000, 2026.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => easterSunday(bad), String(bad)).toThrow(RangeError);
  });
});

describe("easterSunday: egenskaper som ikke bruker samme algoritme", () => {
  /** Gauss' algoritme (M=24, N=5, gyldig 1900-2099) - en uavhengig oppskrift. */
  const gauss = (year: number): string => {
    const a = year % 19, b = year % 4, c = year % 7;
    const dd = (19 * a + 24) % 30;
    const e = (2 * b + 4 * c + 6 * dd + 5) % 7;
    let day = 22 + dd + e;
    let month = 3;
    if (day > 31) { day -= 31; month = 4; }
    // to kjente unntak i Gauss' algoritme (26. april -> 19. april, 25. april med store d og a -> 18. april)
    if (month === 4 && day === 26) day = 19;
    if (month === 4 && day === 25 && dd === 28 && e === 6 && a > 10) day = 18;
    return iso(d(year, month, day));
  };

  it("1900-2099: samme dato som Gauss, alltid en søndag mellom 22. mars og 25. april", () => {
    for (let year = 1900; year <= 2099; year++) {
      const easter = easterSunday(year);
      expect(iso(easter), String(year)).toBe(gauss(year));
      expect(weekday(easter), String(year)).toBe(0);
      const k = easter.month * 100 + easter.day;
      expect(k >= 322 && k <= 425, String(year)).toBe(true);
    }
  });

  it("1583-4000: alltid søndag og innenfor 22. mars - 25. april (periodisk kontroll av hele algoritmen)", () => {
    for (let year = 1583; year <= 4000; year++) {
      const easter = easterSunday(year);
      expect(weekday(easter), String(year)).toBe(0);
      const k = easter.month * 100 + easter.day;
      expect(k >= 322 && k <= 425, String(year)).toBe(true);
    }
  });
});

describe("norwegianHolidays: håndregnede år", () => {
  for (const [year, expected] of Object.entries(EXPECTED)) {
    it(`${year}: tolv dager, sortert, nøyaktig disse`, () => {
      const list = norwegianHolidays(Number(year));
      expect(list.map((h) => iso(h.date))).toEqual(expected);
      expect(list).toHaveLength(12);
    });
  }

  it("2027: 2. pinsedag og 17. mai er SAMME dato (to navn, én fridag); isNorwegianHoliday er likevel sann", () => {
    const names = norwegianHolidays(2027).filter((h) => iso(h.date) === "2027-05-17").map((h) => h.name).sort();
    expect(names).toEqual(["2. pinsedag", "Grunnlovsdagen"]);
    expect(isNorwegianHoliday(d(2027, 5, 17))).toBe(true);
  });

  it("ukedagene stemmer for alle år 1900-2200: skjærtorsdag torsdag, langfredag fredag, 2. påskedag mandag, Kristi himmelfart torsdag, 1. pinsedag søndag, 2. pinsedag mandag", () => {
    const expectedDay: Record<string, number> = { Skjærtorsdag: 4, Langfredag: 5, "1. påskedag": 0, "2. påskedag": 1, "Kristi himmelfartsdag": 4, "1. pinsedag": 0, "2. pinsedag": 1 };
    for (let year = 1900; year <= 2200; year++) {
      const list = norwegianHolidays(year);
      expect(list).toHaveLength(12);
      for (const h of list) if (h.name in expectedDay) expect(weekday(h.date), `${year} ${h.name}`).toBe(expectedDay[h.name]);
      const sorted = [...list].map((h) => iso(h.date));
      expect(sorted).toEqual([...sorted].sort());
    }
  });

  it("julaften (24.12.) og nyttårsaften (31.12.) er IKKE helligdager i loven og er ikke med", () => {
    for (let year = 2020; year <= 2035; year++) {
      expect(isNorwegianHoliday(d(year, 12, 24)), `${year}-12-24`).toBe(false);
      expect(isNorwegianHoliday(d(year, 12, 31)), `${year}-12-31`).toBe(false);
    }
  });

  it("vanlige hverdager og lørdager er ikke helligdager", () => {
    expect(isNorwegianHoliday(d(2026, 11, 25))).toBe(false); // onsdag
    expect(isNorwegianHoliday(d(2026, 4, 4))).toBe(false); // påskeaften (lørdag) er ikke en helligdag
    expect(isNorwegianHoliday(d(2026, 5, 18))).toBe(false); // dagen etter 17. mai (mandag)
    expect(isNorwegianHoliday(d(2026, 12, 27))).toBe(false); // dagen etter 2. juledag
  });
});

describe("weekday og localCalendarDate", () => {
  it("weekday: kjente datoer", () => {
    expect(weekday(d(2026, 11, 25))).toBe(3); // onsdag
    expect(weekday(d(2026, 11, 29))).toBe(0); // søndag
    expect(weekday(d(2026, 5, 17))).toBe(0); // 17. mai 2026 er en søndag
    expect(weekday(d(2000, 1, 1))).toBe(6); // lørdag
  });

  it("kalenderdatoen er den LOKALE (Europe/Oslo), ikke UTC-datoen: rett etter midnatt lokal tid er det allerede neste dag, vinter og sommer", () => {
    expect(localCalendarDate(new Date("2026-12-24T23:30:00Z"), "Europe/Oslo")).toEqual(d(2026, 12, 25)); // UTC+1
    expect(localCalendarDate(new Date("2026-05-16T22:30:00Z"), "Europe/Oslo")).toEqual(d(2026, 5, 17)); // UTC+2 (sommertid)
    expect(localCalendarDate(new Date("2026-05-17T22:30:00Z"), "Europe/Oslo")).toEqual(d(2026, 5, 18));
    expect(localCalendarDate(new Date("2026-03-29T00:30:00Z"), "Europe/Oslo")).toEqual(d(2026, 3, 29)); // sommertidens start
  });

  it("ugyldig tidssone gir null", () => {
    expect(localCalendarDate(new Date("2026-11-25T10:00:00Z"), "Mars/Olympus_Mons")).toBeNull();
  });
});

describe("isSundayOrNorwegianHoliday: ringevinduets dagsregel", () => {
  const at = (iso8601: string): boolean => isSundayOrNorwegianHoliday(new Date(iso8601), "Europe/Oslo");

  it("søndag er stengt, også midt på dagen", () => {
    expect(at("2026-11-29T11:00:00Z")).toBe(true);
    expect(at("2026-12-06T09:30:00Z")).toBe(true);
  });

  it("vanlige dager (mandag-lørdag) er åpne", () => {
    for (const day of ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28"]) expect(at(`${day}T11:00:00Z`), day).toBe(false);
  });

  it("helligdager på ukedager er stengt (1. mai 2026 fredag, 25. desember 2026 fredag, 2. påskedag 6. april 2026)", () => {
    expect(at("2026-05-01T10:00:00Z")).toBe(true);
    expect(at("2026-12-25T10:00:00Z")).toBe(true);
    expect(at("2026-12-26T10:00:00Z")).toBe(true); // lørdag + 2. juledag
    expect(at("2026-04-06T10:00:00Z")).toBe(true);
    expect(at("2026-04-02T10:00:00Z")).toBe(true); // skjærtorsdag
    expect(at("2026-04-03T10:00:00Z")).toBe(true); // langfredag
    expect(at("2026-05-14T10:00:00Z")).toBe(true); // Kristi himmelfart
  });

  it("dagen FØR og ETTER en helligdag er åpen (påskeaften er en lørdag og ikke en helligdag; 2. påskedag + 1)", () => {
    expect(at("2026-04-04T10:00:00Z")).toBe(false);
    expect(at("2026-04-07T10:00:00Z")).toBe(false);
    expect(at("2026-05-18T10:00:00Z")).toBe(false);
  });

  it("avgjørelsen følger LOKAL dato: 17. mai kl. 00:30 lokal tid er allerede helligdag, og 18. mai kl. 00:30 lokal tid er det ikke (UTC-datoen sier det motsatte)", () => {
    expect(at("2026-05-16T22:30:00Z")).toBe(true);
    expect(at("2026-05-17T22:30:00Z")).toBe(false);
    expect(at("2026-12-24T23:30:00Z")).toBe(true);
  });

  it("ugyldig tidssone er stengt (fail-closed)", () => {
    expect(isSundayOrNorwegianHoliday(new Date("2026-11-25T10:00:00Z"), "Mars/Olympus_Mons")).toBe(true);
  });

  it("alle søndager og alle tolv helligdager i 2024-2030 er stengt, og ingen dag mellom dem som er en vanlig hverdag blir det (full gjennomgang)", () => {
    const holidays = new Set<string>();
    for (let year = 2024; year <= 2030; year++) for (const h of norwegianHolidays(year)) holidays.add(iso(h.date));
    for (let t = Date.UTC(2024, 0, 1, 11, 0, 0); t < Date.UTC(2031, 0, 1); t += 86_400_000) {
      const date = new Date(t);
      const key = date.toISOString().slice(0, 10);
      const sunday = date.getUTCDay() === 0;
      expect(isSundayOrNorwegianHoliday(date, "Europe/Oslo"), key).toBe(sunday || holidays.has(key));
    }
  });
});
