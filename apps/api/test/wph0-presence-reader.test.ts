import { describe, expect, it } from "vitest";
import { PRESENCE_CONCURRENCY, PRESENCE_OUTAGE_BACKOFF_MS, PRESENCE_TTL_MS, PresenceReader, type PresenceSource } from "../src/control-center/presence.ts";

/**
 * WP-H0, gjennomgang av PR #316 (L-3 + M-1): `PresenceReader` - cache, single-flight, samtidighetsgrense og utfallsvern for credential-presence i kontrollsentrene.
 * Én Integration-bygging leste ~87 refs uten noen av delene (en oppdatering ~174), og uten token ga hver sin innlogging.
 */
const T0 = Date.parse("2026-10-09T12:00:00.000Z");
const refs = (n: number): string[] => Array.from({ length: n }, (_, i) => `JARVIS_REF_${i}`);

interface Probe extends PresenceSource {
  calls: Map<string, number>;
  total(): number;
  readonly maxInflight: number;
  answer: (ref: string) => boolean | null | "throw" | string;
  health: "healthy" | "unavailable" | "unconfigured" | undefined;
}

function probe(answer: Probe["answer"] = () => true, delayMs = 0): Probe {
  const state = { inflight: 0, maxInflight: 0 };
  const p: Probe = {
    calls: new Map(),
    total: () => [...p.calls.values()].reduce((a, n) => a + n, 0),
    get maxInflight() { return state.maxInflight; },
    answer,
    health: undefined,
    secretPresence: async (ref: string) => {
      p.calls.set(ref, (p.calls.get(ref) ?? 0) + 1);
      state.inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      try {
        if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        const a = p.answer(ref);
        if (a === "throw") throw new Error("kilden kastet");
        return a as boolean | null;
      } finally {
        state.inflight -= 1;
      }
    },
    secretsHealth: () => p.health as never
  };
  return p;
}

describe("cache: et definitivt svar gjenbrukes i 30 s, ukjent caches aldri", () => {
  it("true og false gjenbrukes til TTL er ute, og måles på nytt akkurat da", async () => {
    const src = probe((ref) => ref.endsWith("1"));
    const reader = new PresenceReader(src);
    const first = await reader.readAll(refs(4), T0);
    expect(first.get("JARVIS_REF_1")).toBe(true);
    expect(first.get("JARVIS_REF_0")).toBe(false);
    expect(src.total()).toBe(4);
    await reader.readAll(refs(4), T0 + PRESENCE_TTL_MS - 1);
    expect(src.total()).toBe(4);
    await reader.readAll(refs(4), T0 + PRESENCE_TTL_MS);
    expect(src.total()).toBe(8);
  });

  it("ukjent (null) caches ALDRI: en kilde som er tilbake måles på neste bygging", async () => {
    const src = probe(() => null);
    const reader = new PresenceReader(src);
    expect([...(await reader.readAll(refs(3), T0)).values()]).toEqual([null, null, null]);
    expect(src.total()).toBe(3);
    src.answer = () => true;
    expect([...(await reader.readAll(refs(3), T0 + 1)).values()]).toEqual([true, true, true]);
    expect(src.total()).toBe(6);
  });

  it("en klokke som går bakover gjør ikke en cachet verdi fersk", async () => {
    const src = probe();
    const reader = new PresenceReader(src);
    await reader.readAll(refs(1), T0);
    await reader.readAll(refs(1), T0 - 5_000);
    expect(src.total()).toBe(2);
  });

  it("duplikate refs spørres én gang", async () => {
    const src = probe();
    const out = await new PresenceReader(src).readAll(["A", "A", "B", "A"], T0);
    expect(src.total()).toBe(2);
    expect([...out.keys()]).toEqual(["A", "B"]);
  });
});

describe("single-flight og samtidighet", () => {
  it("samtidige bygginger (oversikt + detalj) deler ÉTT oppslag per ref", async () => {
    const src = probe(() => true, 10);
    const reader = new PresenceReader(src);
    const [a, b] = await Promise.all([reader.readAll(refs(12), T0), reader.readAll(refs(12), T0)]);
    expect(src.total()).toBe(12);
    expect([...src.calls.values()].every((n) => n === 1)).toBe(true);
    expect([...a.values()].every((v) => v === true) && [...b.values()].every((v) => v === true)).toBe(true);
  });

  it("aldri flere enn 8 oppslag samtidig - og alle 87 refer får likevel svar (ingen fastlåsing når plasser overleveres)", async () => {
    expect(PRESENCE_CONCURRENCY).toBe(8);
    const src = probe((ref) => Number(ref.split("_")[2]) % 2 === 0, 4);
    const out = await new PresenceReader(src).readAll(refs(87), T0);
    expect(out.size).toBe(87);
    expect(src.total()).toBe(87);
    expect(src.maxInflight).toBeLessThanOrEqual(PRESENCE_CONCURRENCY);
    expect(src.maxInflight).toBeGreaterThan(1);
    expect(out.get("JARVIS_REF_86")).toBe(true);
    expect(out.get("JARVIS_REF_85")).toBe(false);
  });
});

describe("ukjent er aldri «mangler», og verdier passerer aldri", () => {
  it("en kilde som kaster, og et svar som ikke er ja/nei (f.eks. en streng med en verdi), gir null", async () => {
    const SECRET = "ghp_SUPERSECRETVALUE1234567890";
    const src = probe((ref) => (ref === "A" ? "throw" : ref === "B" ? SECRET : ref === "C" ? (undefined as never) : true));
    const out = await new PresenceReader(src).readAll(["A", "B", "C", "D"], T0);
    expect(out.get("A")).toBeNull();
    expect(out.get("B")).toBeNull();
    expect(out.get("C")).toBeNull();
    expect(out.get("D")).toBe(true);
    expect(JSON.stringify([...out])).not.toContain(SECRET);
  });

  it("en helse-avlesning som kaster velter ikke leseren: refene er ukjente, utfallsvernet slås ikke på, og plassene frigjøres", async () => {
    const src = probe(() => null);
    src.secretsHealth = () => { throw new Error("helse kastet"); };
    const reader = new PresenceReader(src);
    const out = await reader.readAll(refs(20), T0);
    expect([...out.values()].every((v) => v === null)).toBe(true);
    expect(src.total()).toBe(20);
    src.secretsHealth = () => "healthy";
    src.answer = () => true;
    expect([...(await reader.readAll(refs(3), T0 + 1)).values()]).toEqual([true, true, true]);
  });
});

describe("utfallsvern: kilden er nede", () => {
  it("ukjent + helse utilgjengelig: høyst første gruppe (8) spørres, resten sparer kilden og står som ukjent", async () => {
    const src = probe(() => null, 5);
    src.health = "unavailable";
    const reader = new PresenceReader(src);
    const out = await reader.readAll(refs(87), T0);
    expect(out.size).toBe(87);
    expect([...out.values()].every((v) => v === null)).toBe(true);
    expect(src.total()).toBeLessThanOrEqual(PRESENCE_CONCURRENCY);
  });

  it("nye bygginger innenfor utfallsvinduet rører ikke kilden; etter vinduet prøves den på nytt og kan svare", async () => {
    const src = probe(() => null);
    src.health = "unavailable";
    const reader = new PresenceReader(src);
    await reader.readAll(refs(20), T0);
    const after1 = src.total();
    await reader.readAll(refs(20), T0 + PRESENCE_OUTAGE_BACKOFF_MS - 1);
    expect(src.total()).toBe(after1);
    src.answer = () => true;
    src.health = "healthy";
    const out = await reader.readAll(refs(20), T0 + PRESENCE_OUTAGE_BACKOFF_MS);
    expect([...out.values()].every((v) => v === true)).toBe(true);
  });

  it("uten helseopplysning (eller helse ≠ utilgjengelig) slås utfallsvernet ALDRI på: alle refer spørres", async () => {
    for (const health of [undefined, "healthy", "unconfigured"] as const) {
      const src = probe(() => null);
      src.health = health;
      await new PresenceReader(src).readAll(refs(20), T0);
      expect(src.total(), String(health)).toBe(20);
    }
  });

  it("definitive svar som ble målt før kilden falt ut beholdes (cachet), mens resten er ukjent", async () => {
    const src = probe((ref) => (ref === "JARVIS_REF_0" ? true : null));
    const reader = new PresenceReader(src);
    src.health = "healthy";
    await reader.readAll(["JARVIS_REF_0"], T0);
    src.health = "unavailable";
    const out = await reader.readAll(["JARVIS_REF_0", "JARVIS_REF_1"], T0 + 1_000);
    expect(out.get("JARVIS_REF_0")).toBe(true);
    expect(out.get("JARVIS_REF_1")).toBeNull();
  });
});
