import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@jarvis/contracts";
import { HOME_CRITICAL_READ_ACTION, HomeAssistantCriticalTransport } from "../src/index.ts";
import { FakeHomeAssistant } from "./support/fake-home-assistant.ts";

/**
 * WP-G2c fiks-runde 1 (LOW-1): transporten måler klokkeskjevheten HA - Jarvis fra HTTP-`Date` i HA-svaret og legger KUN tallet (`clock_skew_ms`) på lese-handlingens tilstand - det er grunnlaget avstemmingen bruker for å nekte `failed`
 * når klokkene avviker. Lesingene INNE i en mutasjon (før-tilstand, ventesløyfe) er uendret. Mot den ekte fake-HA-tjeneren (`node:http`): ingen database.
 */
let ha: FakeHomeAssistant;
beforeAll(async () => { ha = new FakeHomeAssistant(); await ha.start(); });
afterAll(async () => { await ha.stop(); });
beforeEach(() => { ha.reset(); });

let t0 = 0;
const transport = (): HomeAssistantCriticalTransport => new HomeAssistantCriticalTransport({ baseUrl: async () => ha.baseUrl, settleMs: 5_000, pollMs: 500, now: () => t0, sleep: async (ms) => { t0 += ms; } });
const read = async (): Promise<Record<string, JsonValue>> => ((await transport().invoke(HOME_CRITICAL_READ_ACTION, { entity: "lock.a" }, ha.token)).data as Record<string, JsonValue>);

describe("lese-handlingen bærer målt klokkeskjevhet (HTTP-`Date`)", () => {
  it("HA i takt: skjevheten er et heltall innen ca. +-2 s (`Date` har sekundoppløsning); tilstanden er ellers uendret (ingen andre nøkler enn før)", async () => {
    ha.set("lock.a", { state: "locked", last_changed: "2026-11-18T09:00:00.000Z" });
    const out = await read();
    expect(Number.isInteger(out["clock_skew_ms"])).toBe(true);
    expect(Math.abs(out["clock_skew_ms"] as number)).toBeLessThanOrEqual(2_000);
    const { clock_skew_ms: _skew, ...rest } = out;
    expect(Object.keys(rest).sort()).toEqual(["domain", "entity_id", "last_changed", "locked", "settled", "state", "usable"]);
  });

  it("HA-klokken 5 min BAK og 5 min FREM måles som ca. -300 000 og +300 000 ms (innen sekundoppløsningen)", async () => {
    ha.set("lock.a", { state: "locked" });
    ha.dateSkewMs = -300_000;
    expect(Math.abs(((await read())["clock_skew_ms"] as number) + 300_000)).toBeLessThanOrEqual(2_000);
    ha.dateSkewMs = 300_000;
    expect(Math.abs(((await read())["clock_skew_ms"] as number) - 300_000)).toBeLessThanOrEqual(2_000);
  });

  it("uten `Date`-header (tjener uten klokke) eller med en uleselig verdi er målingen `null`: avstemmingen oppfører seg da som uten måling", async () => {
    ha.set("lock.a", { state: "locked" });
    ha.omitDate = true;
    expect((await read())["clock_skew_ms"]).toBeNull();
    ha.omitDate = false;
    for (const raw of ["ikke en dato", "", "Date", "NaN"]) {
      ha.rawDate = raw;
      expect((await read())["clock_skew_ms"], JSON.stringify(raw)).toBeNull();
    }
  });

  it("kun et TALL når ut: svarteksten og andre headere påvirker ikke tilstanden, og en fiendtlig attributt-/entitetstekst slipper ikke gjennom", async () => {
    ha.set("lock.a", { state: "locked" });
    const out = await read();
    expect(JSON.stringify(out)).not.toMatch(/IGNORE|friendly|GMT/);
    expect(typeof out["clock_skew_ms"]).toBe("number");
  });

  it("lesingene INNE i en mutasjon (før-tilstand/ventesløyfe) bærer ingen måling: etter-tilstanden i svaret er som før", async () => {
    ha.set("lock.a", { state: "unlocked" });
    const result = await transport().invoke("critical_lock", { entity: "lock.a", locked: true }, ha.token);
    const state = (result.data as { state: Record<string, JsonValue> }).state;
    expect(state["state"]).toBe("locked");
    expect("clock_skew_ms" in state).toBe(false);
  });
});
