import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOLDEN, GOLDEN_SUITE_DIGEST, goldenSuite } from "../src/golden-suite.ts";
import { createGoldenSuiteRunner } from "../src/golden-suite-runner.ts";
import { PRODUCTION_SURFACE } from "./support/fast-path-harness.ts";

/**
 * WP-H2: golden-suite-knappens kjører (`golden-suite-runner.ts`). Suiten selv (WP-B/D-452) er låst av golden-suite.test.ts; her låses det knappen legger til:
 * deterministisk resultat med to digester, én kjøring om gangen, ærlig om det som ikke ble kjørt, og INGEN modell/database/nettverk (strukturelt og målt).
 */
const HEX64 = /^[0-9a-f]{64}$/;
const SRC = (file: string): string => readFileSync(resolve(import.meta.dirname, "../src", file), "utf8");
afterEach(() => { vi.unstubAllGlobals(); });

describe("resultatet", () => {
  it("med produksjonens verktøyflate består ALLE oppgavene, ingenting hoppes over, og resultatet bærer begge digestene og null modellkall", async () => {
    const runner = createGoldenSuiteRunner({ surface: () => PRODUCTION_SURFACE, now: () => new Date("2026-11-14T10:00:00.000Z") });
    expect(runner.last()).toBeNull();
    const r = await runner.run();
    expect(r.failed, `ikke bestått: ${r.failed.join(", ")}`).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r).toMatchObject({ total: GOLDEN.length, ran: GOLDEN.length, passed: GOLDEN.length, hard_stop: false, uncovered: [], surface_available: true, model_calls: 0, suite_id: "jarvis-golden", ran_at: "2026-11-14T10:00:00.000Z" });
    expect(r.suite_version).toBe(goldenSuite().version);
    expect(r.suite_digest).toMatch(HEX64);
    expect(r.suite_digest).toBe(GOLDEN_SUITE_DIGEST());
    expect(r.result_digest).toMatch(HEX64);
    expect(r.result_digest).not.toBe(r.suite_digest);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    expect(r.red_team.length).toBeGreaterThan(0);
    for (const c of r.red_team) expect(c.breaches, c.category).toBe(0);
    expect(runner.last()).toEqual(r);
  });

  it("resultat-digesten er DETERMINISTISK: to kjøringer (ulikt tidspunkt og varighet) gir samme digest; en annen utgang gir en annen digest", async () => {
    let tick = 0;
    const runner = createGoldenSuiteRunner({ surface: () => PRODUCTION_SURFACE, now: () => new Date(Date.UTC(2026, 10, 14, 10, 0, tick++)) });
    const a = await runner.run();
    const b = await runner.run();
    expect(b.ran_at).not.toBe(a.ran_at);
    expect(b.result_digest).toBe(a.result_digest);
    expect(b.suite_digest).toBe(a.suite_digest);
    const without = await createGoldenSuiteRunner({ surface: () => null }).run();
    expect(without.result_digest).not.toBe(a.result_digest);
    expect(without.suite_digest).toBe(a.suite_digest);
  });

  it("uten verktøyflate hoppes utvalgs-oppgavene over og sies å være hoppet over (ikke målt) - de teller aldri som bestått", async () => {
    const r = await createGoldenSuiteRunner({ surface: () => null }).run();
    expect(r.surface_available).toBe(false);
    expect(r.skipped.length).toBeGreaterThanOrEqual(3);
    expect(r.skipped).toEqual([...r.skipped].sort());
    expect(r.ran).toBe(GOLDEN.length - r.skipped.length);
    expect(r.passed).toBe(r.ran - r.failed.length);
    expect(r.passed + r.skipped.length).toBeLessThanOrEqual(r.total);
    expect(r.failed).toEqual([]);
  });

  it("siste resultat holdes kun i minnet i denne kjøreren (en ny kjører starter uten resultat) og overskrives av neste kjøring", async () => {
    const runner = createGoldenSuiteRunner({ surface: () => PRODUCTION_SURFACE });
    expect(createGoldenSuiteRunner({ surface: () => null }).last()).toBeNull();
    const first = await runner.run();
    expect(runner.last()).toBe(first);
    const second = await runner.run();
    expect(runner.last()).toBe(second);
    expect(second).not.toBe(first);
  });
});

describe("én kjøring om gangen", () => {
  it("samtidige kall deler ÉN kjøring (verktøyflaten leses én gang) og får samme resultat; etter at den er ferdig starter neste kall en ny", async () => {
    let reads = 0;
    const runner = createGoldenSuiteRunner({ surface: () => { reads += 1; return PRODUCTION_SURFACE; } });
    const [a, b, c] = await Promise.all([runner.run(), runner.run(), runner.run()]);
    expect(reads).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
    await runner.run();
    expect(reads).toBe(2);
  });

  it("en feil i selve kjøringen frigjør låsen: neste kall kan lykkes (aldri en hengt kjører)", async () => {
    let fail = true;
    const runner = createGoldenSuiteRunner({ surface: () => { if (fail) throw new Error("flate nede"); return PRODUCTION_SURFACE; } });
    await expect(runner.run()).rejects.toThrow("flate nede");
    expect(runner.last()).toBeNull();
    fail = false;
    expect((await runner.run()).failed).toEqual([]);
  });
});

describe("ingen modell, ingen database, ingen nettverk", () => {
  it("kjøringen gjør ingen nettverkskall: fetch er stubbet til å kaste, og suiten består likevel", async () => {
    const fetchSpy = vi.fn(() => { throw new Error("nettverkskall er forbudt i golden-suiten"); });
    vi.stubGlobal("fetch", fetchSpy);
    const r = await createGoldenSuiteRunner({ surface: () => PRODUCTION_SURFACE }).run();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.failed).toEqual([]);
    expect(r.model_calls).toBe(0);
  });

  it("kjøreren importerer ingen modellgateway, database, nettverks- eller filsystem-modul (kildevakt) - kun suiten, krypto for digesten og tool-gateway-typer", () => {
    const code = SRC("golden-suite-runner.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const imports = [...code.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./golden-suite.ts", "@jarvis/executive", "@jarvis/tool-gateway", "node:crypto"].sort());
    for (const forbidden of ["ModelGateway", "pg", "fetch(", "http", "net"]) expect(code, forbidden).not.toMatch(new RegExp(`\\b${forbidden.replace("(", "\\(")}`));
  });

  it("suiten selv (golden-suite.ts) kaller ingen gateway.execute og ingen modelladapter - kun rene regler og stubber (kildevakt mot en fremtidig modellvei)", () => {
    const code = SRC("golden-suite.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    expect(code).not.toMatch(/ModelGateway|ModelProviderAdapter|provider-adapters|from\s+"pg"|new\s+Pool\b|fetch\(/);
  });
});
