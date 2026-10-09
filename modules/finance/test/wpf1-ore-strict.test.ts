import { describe, expect, it } from "vitest";
import { MAX_AMOUNT_MINOR_UNITS as GATEWAY_MAX } from "@jarvis/tool-gateway";
import { MAX_AMOUNT_MINOR_UNITS, isCurrencyCode, parseMinorUnitsStrict, providerAmountEchoMatches, toOreInteger } from "../src/ore.ts";

/**
 * WP-F1 (D-453, JARVIS-020/070): STRENG heltallsparsing av beløp i minste enhet. Ubetrodde kilder (webhook-nyttelast, leverandørsvar) får aldri en
 * `Number()`-coercion som gjør tekst, tomme verdier, eksponent-/heksadesimalformer, NaN eller Infinity til «et beløp».
 */
describe("A: parseMinorUnitsStrict - kun trygge, ikke-negative heltall", () => {
  const ok = (v: unknown, expected: number) => expect(parseMinorUnitsStrict(v), String(v)).toEqual({ ok: true, value: expected });
  const bad = (v: unknown, reason: string) => expect(parseMinorUnitsStrict(v), `${typeof v}:${String(v)}`).toEqual({ ok: false, reason });

  it("godtar heltall (number), rene sifferstrenger og trygg bigint", () => {
    ok(0, 0); ok(1, 1); ok(1500, 1500); ok(MAX_AMOUNT_MINOR_UNITS, MAX_AMOUNT_MINOR_UNITS);
    ok("0", 0); ok("1500", 1500); ok("000123", 123); ok("999999999999", 999_999_999_999);
    ok(1500n, 1500); ok(0n, 0);
    ok(-0, 0);
    expect(Object.is((parseMinorUnitsStrict(-0) as { value: number }).value, 0)).toBe(true); // aldri negativ null
  });

  it("avviser NaN/Infinity/negative/brøk/for store tall", () => {
    bad(Number.NaN, "amount_not_a_number");
    bad(Number.POSITIVE_INFINITY, "amount_not_finite");
    bad(Number.NEGATIVE_INFINITY, "amount_not_finite");
    bad(JSON.parse("1e400"), "amount_not_finite"); // JSON-tall utenfor double-området blir Infinity
    bad(-1, "amount_negative");
    bad(-0.5, "amount_negative");
    bad(1.5, "amount_not_integer");
    bad(0.1 + 0.2, "amount_not_integer");
    bad(Number.MAX_SAFE_INTEGER + 1, "amount_too_large");
    bad(2 ** 53, "amount_too_large");
    bad(MAX_AMOUNT_MINOR_UNITS + 1, "amount_too_large");
    bad(Number.MAX_SAFE_INTEGER, "amount_too_large");
  });

  it("avviser tekst som `Number()` ville tolket raust: eksponent, heksadesimal, mellomrom, fortegn, desimal, tusenskille, tom", () => {
    for (const s of ["1e3", "1E3", "0x10", "0b11", " 5", "5 ", " 5 ", "\n5", "5\n", "-5", "+5", "1.5", "1,5", "1 500", "1_000", "NaN", "Infinity", "-Infinity", "5abc", "abc", "١٢٣", "1e400"]) {
      bad(s, "amount_not_digits");
    }
    bad("", "amount_empty");
    bad("   ", "amount_empty");
    bad("1234567890123456", "amount_too_large"); // 16 sifre
    bad("9999999999999", "amount_too_large"); // 13 sifre > formatgrensen
    bad(String(MAX_AMOUNT_MINOR_UNITS + 1), "amount_too_large");
  });

  it("avviser alle andre typer: null/undefined (mangler), boolean, objekt, liste, funksjon, symbol", () => {
    bad(null, "amount_missing");
    bad(undefined, "amount_missing");
    for (const v of [true, false, {}, [], [7], { value: 5 }, () => 5, Symbol("x")]) bad(v, "amount_wrong_type");
  });

  it("bigint: negative og for store avvises", () => {
    bad(-1n, "amount_negative");
    bad(2n ** 60n, "amount_too_large");
    bad(BigInt(MAX_AMOUNT_MINOR_UNITS) + 1n, "amount_too_large");
  });

  it("allowZero: false avviser 0 (men ikke «0»-formen av andre feil)", () => {
    expect(parseMinorUnitsStrict(0, { allowZero: false })).toEqual({ ok: false, reason: "amount_zero" });
    expect(parseMinorUnitsStrict("0", { allowZero: false })).toEqual({ ok: false, reason: "amount_zero" });
    expect(parseMinorUnitsStrict(1, { allowZero: false })).toEqual({ ok: true, value: 1 });
  });
});

describe("B: toOreInteger og leverandørens ekko", () => {
  it("toOreInteger: positivt trygt heltall under formatgrensen; alt annet kaster `invalid_amount_ore` FØR noe nettverkskall", () => {
    expect(toOreInteger("1500")).toBe(1500);
    expect(toOreInteger(1500)).toBe(1500);
    expect(toOreInteger(1500n)).toBe(1500);
    expect(toOreInteger(MAX_AMOUNT_MINOR_UNITS)).toBe(MAX_AMOUNT_MINOR_UNITS);
    for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_AMOUNT_MINOR_UNITS + 1, Number.MAX_SAFE_INTEGER, "0", "-5", "15.5", "abc", "", "1e3", "9007199254740993", 0n, -1n]) {
      expect(() => toOreInteger(v as number), String(v)).toThrow("invalid_amount_ore");
    }
  });

  it("providerAmountEchoMatches: eksakt samsvar eller IKKE samsvar - et ekko som ikke lar seg parse regnes aldri som ok", () => {
    expect(providerAmountEchoMatches(4000, 4000)).toBe(true);
    expect(providerAmountEchoMatches("4000", 4000)).toBe(true);
    expect(providerAmountEchoMatches(4001, 4000)).toBe(false);
    for (const v of [null, undefined, "4000.0", "4e3", Number.NaN, -4000, 4000.5, {}, "abc"]) expect(providerAmountEchoMatches(v, 4000), String(v)).toBe(false);
  });

  it("isCurrencyCode: tre store bokstaver", () => {
    expect(isCurrencyCode("NOK")).toBe(true);
    for (const v of ["nok", "NO", "NOKK", "N0K", "", " NOK", null, undefined, 5, {}]) expect(isCurrencyCode(v), String(v)).toBe(false);
  });

  it("formatgrensen er den SAMME i finansmodulen og i klasse D-validatorene (to speil låst mot hverandre)", () => {
    expect(MAX_AMOUNT_MINOR_UNITS).toBe(GATEWAY_MAX);
  });
});
