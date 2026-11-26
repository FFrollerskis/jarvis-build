import { describe, expect, it } from "vitest";
import { canonicalJson, contractFingerprint, normalizeLineEndings, sha256Hex } from "../src/program/hash.ts";
import { COMPONENT_ID, D_REF, EVENT_TYPE, FINGERPRINT, GIT_SHA, MIGRATION_FILE, REPO_PATH, SEMVER, SHA256_HEX, TABLE_NAME } from "../src/program/ids.ts";
import { compareSemver, parseMax, parseSemver, rangeIsValid, satisfiesRange } from "../src/program/semver.ts";

/**
 * WP-PGA / PG1: byggeklossene under programindeksen - identifikator-mønstre, semver (uten ny avhengighet), hash og kanonisk JSON. Alt er rene funksjoner; hver grense har et
 * positivt og et negativt tilfelle (mutantsettet løsner/skjerper hver av dem).
 */
describe("identifikator-mønstre", () => {
  const ok = (re: RegExp, values: string[]) => values.forEach((v) => expect(re.test(v), `skal godtas: ${JSON.stringify(v)}`).toBe(true));
  const bad = (re: RegExp, values: string[]) => values.forEach((v) => expect(re.test(v), `skal avvises: ${JSON.stringify(v)}`).toBe(false));

  it("component_id: <familie>.<navn> med små bokstaver, tall og bindestrek", () => {
    ok(COMPONENT_ID, ["core.policy", "ua.conversation-graph", "ci.skill-learning", "ev.capability-registry", "program.canonical-index", "core.db-foundation", "a1.b2"]);
    bad(COMPONENT_ID, ["core", "Core.policy", "core.Policy", "core.policy.", ".core.policy", "core..policy", "core.-policy", "core.policy-", "core.poli cy", "1core.policy", "core.1policy", "core/policy", "core.policy\n", ""]);
  });

  it("semver: kun MAJOR.MINOR.PATCH, ingen ledende nuller, ingen prerelease/build, ingen blanke", () => {
    ok(SEMVER, ["0.0.0", "0.1.0", "1.2.3", "10.20.30", "999999.999999.999999"]);
    bad(SEMVER, ["01.2.3", "1.02.3", "1.2.03", "1.2", "1", "1.2.3.4", "1.2.3-beta", "1.2.3+build", "v1.2.3", " 1.2.3", "1.2.3 ", "1.2.3\n", "1.2.x", "-1.2.3", "1.2.1000000", ""]);
  });

  it("sha256 / fingeravtrykk / git-sha: nøyaktig lengde, kun små hex-tegn", () => {
    const h = "a".repeat(64);
    ok(SHA256_HEX, [h]);
    bad(SHA256_HEX, ["a".repeat(63), "a".repeat(65), "A".repeat(64), `${"a".repeat(63)}g`, ""]);
    ok(FINGERPRINT, [`sha256:${h}`]);
    bad(FINGERPRINT, [h, `sha256:${"a".repeat(63)}`, `SHA256:${h}`, `sha256: ${h}`, `sha1:${h}`]);
    ok(GIT_SHA, ["b".repeat(40)]);
    bad(GIT_SHA, ["b".repeat(39), "b".repeat(41), "B".repeat(40), "xyz"]);
  });

  it("repo-sti: relativ, uten .., uten backslash, uten absolutt rot", () => {
    ok(REPO_PATH, ["modules/core", "packages/contracts/src/event.ts", "docs/evidence/2026-11-26-x.md", "config/program/manifest.json", "a"]);
    bad(REPO_PATH, ["/etc/passwd", "../x", "a/../b", "a/..", "..", "a\\b", "a b", "a/./../b", "", "~/x", "a:b"]);
  });

  it("tabellnavn, migrasjonsfil, hendelsestype og beslutningsreferanse", () => {
    ok(TABLE_NAME, ["tenants", "ci_experiences", "a", "x1_y2"]);
    bad(TABLE_NAME, ["Tenants", "1x", "a-b", "a b", "a".repeat(64), "", "public.tenants"]);
    ok(MIGRATION_FILE, ["001_identity.sql", "148_situation_autonomy_scope.sql", "999_x.sql"]);
    bad(MIGRATION_FILE, ["1_identity.sql", "0001_x.sql", "001-identity.sql", "001_Identity.sql", "001_identity.SQL", "001_identity.sql.bak", "x/001_a.sql", "001_.sql"]);
    ok(EVENT_TYPE, ["TaskCompleted", "council_round_1", "a.b", "OperationalGateChanged"]);
    bad(EVENT_TYPE, ["", "a", "1abc", "a b", "a-b", "x".repeat(82)]);
    ok(D_REF, ["D-1", "D-497", "D-1234", "D-PROG-07", "D-CI-24", "D-MC-34"]);
    bad(D_REF, ["D-", "D-12345", "d-1", "D-1a", "D-prog-01", "X-1", "D-PROG-1234", ""]);
  });
});

describe("semver: parse, sammenlikning og intervaller", () => {
  it("parseSemver gir tall eller null (aldri en gjetning)", () => {
    expect(parseSemver("1.22.333")).toEqual({ major: 1, minor: 22, patch: 333 });
    expect(parseSemver("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
    for (const bad of ["1.2", "1.2.3-rc1", "01.1.1", "", " 1.2.3", "a.b.c", "1.2.3.4"]) expect(parseSemver(bad), bad).toBeNull();
  });

  it("compareSemver ordner på major, så minor, så patch (numerisk, ikke leksikografisk)", () => {
    const c = (a: string, b: string) => compareSemver(parseSemver(a)!, parseSemver(b)!);
    expect(c("1.0.0", "1.0.0")).toBe(0);
    expect(c("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(c("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(c("1.0.10", "1.0.9")).toBeGreaterThan(0);
    expect(c("0.9.9", "1.0.0")).toBeLessThan(0);
    expect(c("1.2.3", "1.3.0")).toBeLessThan(0);
    expect(c("1.2.3", "1.2.4")).toBeLessThan(0);
  });

  it("parseMax: eksakt, «M.x» og «M.m.x»; alt annet er null", () => {
    expect(parseMax("1.2.3")).toEqual({ kind: "exact", major: 1, minor: 2, patch: 3 });
    expect(parseMax("0.x")).toEqual({ kind: "major", major: 0 });
    expect(parseMax("2.5.x")).toEqual({ kind: "minor", major: 2, minor: 5 });
    for (const bad of ["x", "x.x", "1.x.x", "1.x.3", "1.2.x.4", "1.*", "^1.2.3", "~1.2.3", ">=1.0.0", "1.X", ""]) expect(parseMax(bad), bad).toBeNull();
  });

  it("satisfiesRange: min er inklusiv; eksakt max er inklusiv; M.x og M.m.x dekker hele familien", () => {
    const s = (v: string, min: string, max: string) => satisfiesRange(v, { min, max });
    expect(s("1.0.0", "1.0.0", "1.0.0")).toBe(true);
    expect(s("0.9.9", "1.0.0", "2.0.0")).toBe(false);
    expect(s("2.0.0", "1.0.0", "2.0.0")).toBe(true);
    expect(s("2.0.1", "1.0.0", "2.0.0")).toBe(false);
    expect(s("0.1.0", "0.1.0", "0.x")).toBe(true);
    expect(s("0.99.99", "0.1.0", "0.x")).toBe(true);
    expect(s("1.0.0", "0.1.0", "0.x")).toBe(false);
    expect(s("1.4.9", "1.2.0", "1.4.x")).toBe(true);
    expect(s("1.5.0", "1.2.0", "1.4.x")).toBe(false);
    expect(s("1.1.9", "1.2.0", "1.4.x")).toBe(false);
  });

  it("satisfiesRange er false (ikke kast) for ugyldig versjon, min eller max", () => {
    expect(satisfiesRange("x", { min: "1.0.0", max: "2.0.0" })).toBe(false);
    expect(satisfiesRange("1.0.0", { min: "1", max: "2.0.0" })).toBe(false);
    expect(satisfiesRange("1.0.0", { min: "1.0.0", max: "^2" })).toBe(false);
  });

  it("rangeIsValid: gyldige deler og min <= øvre grense", () => {
    expect(rangeIsValid({ min: "1.0.0", max: "1.0.0" })).toBe(true);
    expect(rangeIsValid({ min: "1.0.0", max: "1.x" })).toBe(true);
    expect(rangeIsValid({ min: "1.5.0", max: "1.4.x" })).toBe(false);
    expect(rangeIsValid({ min: "2.0.0", max: "1.x" })).toBe(false);
    expect(rangeIsValid({ min: "2.0.0", max: "1.9.9" })).toBe(false);
    expect(rangeIsValid({ min: "0.1.0", max: "0.x" })).toBe(true);
    expect(rangeIsValid({ min: "1.0", max: "2.0.0" })).toBe(false);
    expect(rangeIsValid({ min: "1.0.0", max: "latest" })).toBe(false);
  });
});

describe("hash, linjeskift og kanonisk JSON", () => {
  it("sha256Hex gir kjent testvektor (UTF-8)", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("æøå")).toBe(sha256Hex("æøå"));
    expect(sha256Hex("æøå")).not.toBe(sha256Hex("aoa"));
  });

  it("normalizeLineEndings gjør CRLF og enslige CR til LF (samme innhold gir samme hash på alle plattformer)", () => {
    expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(sha256Hex(normalizeLineEndings("x\r\ny"))).toBe(sha256Hex("x\ny"));
  });

  it("canonicalJson sorterer objektnøkler rekursivt, bevarer array-rekkefølge og avviser udefinert/ikke-endelige tall/sykler", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,2,1]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    expect(() => canonicalJson(cyc)).toThrow();
  });

  it("contractFingerprint er uavhengig av rekkefølgen filene oppgis i, avhenger av hver sti og hver hash, og har formatet sha256:<hex>", () => {
    const a = { path: "packages/contracts/src/a.ts", sha256: "1".repeat(64) };
    const b = { path: "packages/contracts/src/b.ts", sha256: "2".repeat(64) };
    const f = contractFingerprint([a, b]);
    expect(f).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contractFingerprint([b, a])).toBe(f);
    expect(contractFingerprint([a])).not.toBe(f);
    expect(contractFingerprint([a, { ...b, sha256: "3".repeat(64) }])).not.toBe(f);
    expect(contractFingerprint([a, { ...b, path: "packages/contracts/src/c.ts" }])).not.toBe(f);
    expect(contractFingerprint([])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("contractFingerprint skiller sti fra hash (en sti kan ikke «låne» tegn fra hashen) og avviser duplikate stier", () => {
    const x = contractFingerprint([{ path: "a", sha256: `1${"0".repeat(63)}` }]);
    const y = contractFingerprint([{ path: "a1", sha256: "0".repeat(64) }]);
    expect(x).not.toBe(y);
    expect(() => contractFingerprint([{ path: "a", sha256: "1".repeat(64) }, { path: "a", sha256: "1".repeat(64) }])).toThrow();
  });
});
