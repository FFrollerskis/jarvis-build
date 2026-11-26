import { describe, expect, it, vi } from "vitest";
import { PLACE_MAX_AGE_MS, familySharedDataReaders, type LocationReadApi } from "../src/personal-family-readers.ts";

/**
 * WP-G2c (D-483, JARVIS-113 e/5): «nå»-stedet i familievisningen har en maks alder. Et åpent sonebesøk lukkes bare av en NY observasjon, så en telefon som slutter å melde ville latt familien se «Hjemme» for alltid. Ferskheten måles på personens
 * SISTE observasjon (ikke besøkets start: en lang natt hjemme er et gyldig besøk), og `observed_at` i svaret er nå tidspunktet personen sist ble sett. Rene funksjoner med fakes (ingen database).
 */
const HOUR = 3_600_000;
const NOW = new Date("2026-11-18T10:30:00.000Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

function location(over: { visits?: Array<{ zone_id: string; entered_at: unknown }>; lastSeen?: unknown; zones?: Record<string, string> } = {}): LocationReadApi & { listZoneVisits: ReturnType<typeof vi.fn>; getZone: ReturnType<typeof vi.fn>; getPersonLocation: ReturnType<typeof vi.fn> } {
  const visits = over.visits ?? [{ zone_id: "z-1", entered_at: ago(30 * HOUR) }];
  const zones = over.zones ?? { "z-1": "Hjemme" };
  return {
    listZoneVisits: vi.fn(async () => visits),
    getZone: vi.fn(async (_t: string, _s: "personal", id: string) => (zones[id] === undefined ? null : ({ name: zones[id] as string, center_lat: 59.9, center_lon: 10.7 } as { name: string }))),
    // en ekte observasjon bærer koordinater; leseren skal aldri la dem slippe ut
    getPersonLocation: vi.fn(async () => (over.lastSeen === null ? null : { observed_at: over.lastSeen === undefined ? ago(5 * 60_000) : over.lastSeen, lat: 59.91, lon: 10.75 }))
  } as never;
}
const readers = (loc: LocationReadApi, extra: { placeMaxAgeMs?: number } = {}) => familySharedDataReaders({ location: loc, health: { getRecentMetrics: async () => [] }, now: () => NOW, ...extra });

describe("currentPlace: ferskhet (maks alder) på personens siste observasjon", () => {
  it("standarden er 6 timer", () => {
    expect(PLACE_MAX_AGE_MS).toBe(6 * HOUR);
  });

  it("FERSK: et besøk som startet for 30 timer siden vises når personen sist ble sett for 5 minutter siden, og `observed_at` er SIST SETT (ikke besøkets start)", async () => {
    const loc = location({ lastSeen: ago(5 * 60_000) });
    expect(await readers(loc).currentPlace("t-data", "p-adult")).toEqual({ zone_name: "Hjemme", observed_at: ago(5 * 60_000) });
    expect(loc.listZoneVisits).toHaveBeenCalledWith("t-data", "personal", "p-adult", { open_only: true });
    expect(loc.getPersonLocation).toHaveBeenCalledWith("t-data", "personal", "p-adult");
  });

  it("GRENSEN: akkurat 6 timer gammel vises, ett millisekund eldre er ukjent (null)", async () => {
    expect(await readers(location({ lastSeen: ago(6 * HOUR) })).currentPlace("t", "p")).toMatchObject({ zone_name: "Hjemme", observed_at: ago(6 * HOUR) });
    expect(await readers(location({ lastSeen: ago(6 * HOUR + 1) })).currentPlace("t", "p")).toBeNull();
  });

  it("FORELDET: en telefon som sluttet å melde for 7 timer (eller 3 dager) siden gir ukjent sted, selv om besøket fortsatt er åpent", async () => {
    for (const age of [7 * HOUR, 24 * HOUR, 72 * HOUR]) expect(await readers(location({ lastSeen: ago(age) })).currentPlace("t", "p"), `${age / HOUR} t`).toBeNull();
  });

  it("ingen observasjon eller en ulesbar tidsverdi gir ukjent (aldri et gjettet sted)", async () => {
    expect(await readers(location({ lastSeen: null })).currentPlace("t", "p")).toBeNull();
    for (const bad of ["i går", "", "2026-13-45T00:00:00Z", Number.NaN, {}, [], undefined as never, true]) {
      const loc = location({ lastSeen: bad === undefined ? "ugyldig" : bad });
      expect(await readers(loc).currentPlace("t", "p"), String(bad)).toBeNull();
    }
  });

  it("FREMTID (klokkefeil): inntil 10 minutter frem i tid regnes som fersk, mer enn det er ukjent (en fremtidig tidsverdi ville holdt stedet «ferskt» i timevis)", async () => {
    expect(await readers(location({ lastSeen: ago(-9 * 60_000) })).currentPlace("t", "p")).toMatchObject({ zone_name: "Hjemme" });
    expect(await readers(location({ lastSeen: ago(-10 * 60_000) })).currentPlace("t", "p")).toMatchObject({ zone_name: "Hjemme" });
    expect(await readers(location({ lastSeen: ago(-10 * 60_000 - 1) })).currentPlace("t", "p")).toBeNull();
    expect(await readers(location({ lastSeen: ago(-24 * HOUR) })).currentPlace("t", "p")).toBeNull();
  });

  it("`Date`-objekter (slik pg leverer `timestamptz`) og ISO-strenger leses; et tall (epoke-ms) er ikke et tidspunkt vi kjenner igjen og gir ukjent (fail closed)", async () => {
    expect(await readers(location({ lastSeen: new Date(NOW.getTime() - HOUR) })).currentPlace("t", "p")).toEqual({ zone_name: "Hjemme", observed_at: ago(HOUR) });
    expect(await readers(location({ lastSeen: ago(HOUR) })).currentPlace("t", "p")).toEqual({ zone_name: "Hjemme", observed_at: ago(HOUR) });
    expect(await readers(location({ lastSeen: NOW.getTime() - HOUR })).currentPlace("t", "p")).toBeNull();
  });

  it("konfigurerbar maks alder: 1 time avviser 61 minutter; ugyldige verdier (0, negative, brøk, NaN, Infinity, tekst) gir standarden (6 timer), aldri «ingen grense»", async () => {
    expect(await readers(location({ lastSeen: ago(61 * 60_000) }), { placeMaxAgeMs: HOUR }).currentPlace("t", "p")).toBeNull();
    expect(await readers(location({ lastSeen: ago(59 * 60_000) }), { placeMaxAgeMs: HOUR }).currentPlace("t", "p")).toMatchObject({ zone_name: "Hjemme" });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3600000" as never, null as never]) {
      expect(await readers(location({ lastSeen: ago(5 * HOUR) }), { placeMaxAgeMs: bad }).currentPlace("t", "p"), String(bad)).toMatchObject({ zone_name: "Hjemme" });
      expect(await readers(location({ lastSeen: ago(7 * HOUR) }), { placeMaxAgeMs: bad }).currentPlace("t", "p"), String(bad)).toBeNull();
    }
  });

  it("ingen åpen sone eller ukjent sone gir null; uten åpent besøk leses ikke observasjonen engang, og ukjent sone gir null også når observasjonen er fersk", async () => {
    const none = location({ visits: [] });
    expect(await readers(none).currentPlace("t", "p")).toBeNull();
    expect(none.getPersonLocation).not.toHaveBeenCalled();
    expect(await readers(location({ zones: {} })).currentPlace("t", "p")).toBeNull();
  });

  it("minimering: ingen koordinater i svaret selv om observasjonen bærer dem, og en stale observasjon leser ikke sonen", async () => {
    const fresh = await readers(location()).currentPlace("t", "p");
    expect(JSON.stringify(fresh)).not.toMatch(/59\.9|10\.7|59\.91|10\.75|lat|lon/);
    const stale = location({ lastSeen: ago(10 * HOUR) });
    expect(await readers(stale).currentPlace("t", "p")).toBeNull();
    expect(stale.getZone).not.toHaveBeenCalled();
  });

  it("det er den SISTE observasjonen som teller: et nylig besøk med en gammel observasjon er også ukjent (observasjonen er beviset, ikke besøket)", async () => {
    const loc = location({ visits: [{ zone_id: "z-1", entered_at: ago(60_000) }], lastSeen: ago(8 * HOUR) });
    expect(await readers(loc).currentPlace("t", "p")).toBeNull();
  });
});
