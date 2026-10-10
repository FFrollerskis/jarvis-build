import { describe, expect, it } from "vitest";
import { CLOUDFLARE_CAPABILITIES, assertWafExpression, isObviousMatchAllExpression } from "../src/cloudflare-target-policy.ts";

/**
 * Gjennomgang av PR #324 (L1): vakten «treffer all trafikk» var triviell å omgå - kun `true`/`(true)`/`TRUE` ble avvist, mens `1 == 1`, `not false`, `http.host ne ""`, `true == true`, `(true) or (false)`,
 * `len(http.request.uri.path) >= 0` og `ip.src ne 0.0.0.0` ble godtatt, og påstanden «deterministisk vakt» var for sterk. Nå fanger den åpenbare literal-/tautologi-uttrykk (konstantevaluering gjennom
 * or/and/not/xor + en kort liste kjente alltid-sanne idiomer), og påstanden er «best-effort, ikke et bevis». Disse testene låser BEGGE sider: tautologiene avvises, og vanlige spesifikke regler (og alt for `log`)
 * avvises ikke - en vakt som avviser legitime regler er også en feil.
 */
const REJECTED: readonly string[] = [
  // reviewerens liste
  "1 == 1", "not false", 'http.host ne ""', "true == true", "(true) or (false)", "len(http.request.uri.path) >= 0", "ip.src ne 0.0.0.0",
  // opprinnelig
  "true", "TRUE", "(true)", " ( ( true ) ) ", "True",
  // konstanter og sammenligninger
  "1 eq 1", "1 EQ 1", "1==1", "2 gt 1", "2 > 1", "1 le 1", "1 ge 1", "0x10 eq 16", '"a" eq "a"', '"a" ne "b"', "1 ne 2", "true eq true", "false == false", "false ne true",
  "!false", "! false", "not (false)", "not not true", "not (1 == 2)", "1.2.3.4 eq 1.2.3.4",
  // sammensatt
  "true and true", "true && true", "true or false", "false or true", "false || true", "(true) or (false)", "not (false and true)", "(1 == 1) and (2 == 2)", "true xor false", "false ^^ true",
  "ip.src eq 1.2.3.4 or 1 == 1", "true or http.host eq \"x\"", "(ip.src eq 1.2.3.4) or true", "http.host eq \"x\" or not false", "(ip.src eq 1.1.1.1 or true) and true",
  // kjente alltid-sanne idiomer
  'http.host != ""', 'http.request.method ne ""', 'http.request.uri.path ne ""', "len(http.host) ge 0", "len(http.request.uri.path) ge 0", "len(http.host) > 0", "len(http.request.uri.path) gt 0", "len(http.request.uri) ge 1",
  "ip.src != 0.0.0.0", "not ip.src eq 0.0.0.0", "!(ip.src == 0.0.0.0)", "cf.threat_score ge 0", "cf.threat_score >= 0", 'http.request.uri.path contains "/"', 'starts_with(http.request.uri.path, "/")',
  'http.request.uri.path matches ".*"', 'http.host matches "^"', "ip.src ne 0.0.0.0 or ip.src eq 9.9.9.9", "ip.src ne 0.0.0.0 and true", "(((true)))", "\n true \t"
];

const ACCEPTED: readonly string[] = [
  "ip.src eq 203.0.113.9", 'http.host eq "example.com"', "(ip.src eq 1.1.1.1) or (ip.src eq 2.2.2.2)", 'http.request.uri.path contains "/admin"', "len(http.request.uri.path) > 100", "ip.src ne 1.2.3.4",
  'http.host ne "example.com"', "cf.threat_score ge 10", "not ip.src in {1.1.1.1 2.2.2.2}", "ip.src in {1.1.1.1 2.2.2.2}", 'http.request.method eq "POST" and http.request.uri.path eq "/login"',
  "ip.src eq 1.1.1.1 and true", 'http.request.method eq "POST" and not (1 == 2)', "len(http.host) > 5", "len(http.request.uri.path) ge 1000", 'http.request.uri.path ne "/x"',
  'http.request.uri.path matches "^/api/.*"', 'starts_with(http.request.uri.path, "/admin")', "cf.threat_score gt 14", "ip.src ne 0.0.0.1",
  // konstante som er FALSKE treffer ingenting (ufarlig) - avvises ikke
  "false", "1 == 2", "true == false", "not true", "1 gt 2", 'http.host eq ""',
  // ikke analyserbart -> ukjent, ikke avvist
  'http.host eq "uavsluttet', "ip.src = 1.1.1.1", "constructor", "1 constructor 1", "__proto__ eq __proto__", "toString == toString"
];

describe("L1: assertWafExpression avviser åpenbare tautologier for ikke-log-handlinger", () => {
  it("hver tautologi avvises med `treffer_all_trafikk` for block/challenge/managed_challenge/js_challenge", () => {
    for (const expression of REJECTED) {
      for (const action of ["block", "challenge", "managed_challenge", "js_challenge"]) {
        expect(() => assertWafExpression(expression, action), `${action}: ${JSON.stringify(expression)}`).toThrow("cloudflare_invalid_expression:treffer_all_trafikk");
      }
      expect(isObviousMatchAllExpression(expression.trim()), JSON.stringify(expression)).toBe(true);
    }
  });

  it("`log` er unntatt: en logg-regel som treffer alt er lovlig og ufarlig", () => {
    for (const expression of REJECTED) expect(assertWafExpression(expression, "log"), JSON.stringify(expression)).toBe(expression.trim());
  });

  it("vanlige spesifikke regler, falske konstanter og uanalyserbare uttrykk avvises IKKE (ingen falske positive)", () => {
    for (const expression of ACCEPTED) {
      for (const action of ["block", "challenge"]) expect(assertWafExpression(expression, action), `${action}: ${JSON.stringify(expression)}`).toBe(expression.trim());
      expect(isObviousMatchAllExpression(expression), JSON.stringify(expression)).toBe(false);
    }
  });

  it("lengde, tegn og tom streng avvises som før (uavhengig av tautologi-vakten); ikke-streng avvises", () => {
    expect(() => assertWafExpression("", "block")).toThrow("cloudflare_invalid_expression");
    expect(() => assertWafExpression("   ", "block")).toThrow("cloudflare_invalid_expression");
    expect(() => assertWafExpression("x".repeat(4097), "block")).toThrow("cloudflare_invalid_expression");
    expect(() => assertWafExpression("ip.src eq 1.1.1.1\u0000", "block")).toThrow("cloudflare_invalid_expression");
    expect(() => assertWafExpression(42, "block")).toThrow("cloudflare_invalid_expression");
  });

  it("analysen er avgrenset: dypt nestede/svært lange uttrykk gir et svar (ingen krasj, ingen uendelig rekursjon)", () => {
    const deep = `${"(".repeat(500)}true${")".repeat(500)}`;
    expect(typeof isObviousMatchAllExpression(deep)).toBe("boolean");
    const longOr = Array.from({ length: 300 }, (_, i) => `ip.src eq 10.0.${i % 255}.1`).join(" or ");
    expect(isObviousMatchAllExpression(longOr)).toBe(false);
    expect(isObviousMatchAllExpression(`${longOr} or 1 == 1`)).toBe(true);
    expect(isObviousMatchAllExpression("(" + "(true) or ".repeat(2000))).toBe(false);
  });
});

describe("L1: påstanden er ærlig - best-effort, ikke et bevis", () => {
  it("kapabilitetsmatrisen kaller vakten best-effort og sier eksplisitt at den ikke er et bevis (ikke «deterministisk vakt»)", () => {
    const waf = CLOUDFLARE_CAPABILITIES.find((c) => /opprett\/endre\/slett regel/.test(c.capability))!;
    expect(waf.note).toMatch(/BEST-EFFORT/);
    expect(waf.note).toMatch(/IKKE et bevis/);
    expect(waf.note).not.toMatch(/deterministisk vakt/);
  });
});
