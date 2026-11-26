import { describe, expect, it } from "vitest";
import { evaluateBaseline, gateVerdict } from "../src/program/baseline.ts";
import type { Baseline } from "../src/program/schema.ts";
import type { Finding } from "../src/program/scan.ts";

/**
 * WP-PGA / PG1 (lead-beslutning 2): «baseline kan bare krympe». Kjente brudd står i `config/program/baseline.json`; en frosset ORIGIN-liste (pinnet i testkilden, ikke i datafilen) er øvre grense:
 *  - en baseline-oppføring som ikke står i origin = baselinen har VOKST = rød (i begge moduser);
 *  - en oppføring uten et tilsvarende funn er FORELDET = rød (i begge moduser): når et brudd er rettet, må oppføringen fjernes, ellers kan et nytt brudd gjemme seg bak den;
 *  - et funn som ikke står i baselinen er NYTT: rapporteres i `report`-modus, rødt i `enforce`.
 */
const f = (id: string): Finding => {
  const [rule, ...rest] = id.split(":");
  return { rule: rule as Finding["rule"], component_id: null, subject: rest.join(":"), id, message: `funn ${id}` };
};
const baseline = (...ids: string[]): Baseline => ({ schema_version: "1.0.0", entries: ids.map((id) => ({ id, reason: "Kjent brudd i påvente av en eierbeslutning.", since: "2026-11-26", decision_ref: null })) });

describe("evaluateBaseline", () => {
  it("ingen funn og tom baseline: alt er tomt", () => {
    expect(evaluateBaseline([], baseline(), [])).toEqual({ new_findings: [], known_findings: [], stale_entries: [], growth_entries: [] });
  });

  it("et funn som ikke står i baselinen er nytt", () => {
    const r = evaluateBaseline([f("table_orphan:a")], baseline(), []);
    expect(r.new_findings.map((x) => x.id)).toEqual(["table_orphan:a"]);
    expect(r.known_findings).toEqual([]);
  });

  it("et funn som står i baselinen (og i origin) er kjent, ikke nytt", () => {
    const r = evaluateBaseline([f("table_orphan:a")], baseline("table_orphan:a"), ["table_orphan:a"]);
    expect(r.known_findings.map((x) => x.id)).toEqual(["table_orphan:a"]);
    expect(r.new_findings).toEqual([]);
    expect(r.stale_entries).toEqual([]);
    expect(r.growth_entries).toEqual([]);
  });

  it("en baseline-oppføring uten funn er foreldet (kan fjernes - baselinen skal krympe)", () => {
    const r = evaluateBaseline([], baseline("table_orphan:a"), ["table_orphan:a"]);
    expect(r.stale_entries).toEqual(["table_orphan:a"]);
  });

  it("en baseline-oppføring utenfor origin er vekst - også når den treffer et ekte funn", () => {
    const r = evaluateBaseline([f("table_orphan:b")], baseline("table_orphan:b"), ["table_orphan:a"]);
    expect(r.growth_entries).toEqual(["table_orphan:b"]);
    expect(r.known_findings.map((x) => x.id)).toEqual(["table_orphan:b"]);
  });

  it("origin er en øvre grense, ikke et krav: en baseline som har krympet er i orden", () => {
    const r = evaluateBaseline([f("table_orphan:a")], baseline("table_orphan:a"), ["table_orphan:a", "table_orphan:b", "service_orphan:c"]);
    expect(r.growth_entries).toEqual([]);
    expect(r.stale_entries).toEqual([]);
  });

  it("blandet: kjent, nytt, foreldet og vekst samtidig", () => {
    const r = evaluateBaseline([f("table_orphan:a"), f("table_orphan:new")], baseline("table_orphan:a", "service_orphan:gone", "dir_uncovered:x"), ["table_orphan:a", "service_orphan:gone"]);
    expect(r.known_findings.map((x) => x.id)).toEqual(["table_orphan:a"]);
    expect(r.new_findings.map((x) => x.id)).toEqual(["table_orphan:new"]);
    expect(r.stale_entries.sort()).toEqual(["dir_uncovered:x", "service_orphan:gone"]);
    expect(r.growth_entries).toEqual(["dir_uncovered:x"]);
  });

  it("id-sammenligningen er eksakt (ikke prefiks, ikke case)", () => {
    const r = evaluateBaseline([f("table_orphan:abc")], baseline("table_orphan:ab"), ["table_orphan:ab"]);
    expect(r.new_findings.map((x) => x.id)).toEqual(["table_orphan:abc"]);
    expect(r.stale_entries).toEqual(["table_orphan:ab"]);
    const c = evaluateBaseline([f("table_orphan:ABC")], baseline("table_orphan:abc"), ["table_orphan:abc"]);
    expect(c.new_findings.length).toBe(1);
  });
});

describe("gateVerdict", () => {
  const clean = { new_findings: [], known_findings: [], stale_entries: [], growth_entries: [] };

  it("rent resultat er ok i begge moduser", () => {
    expect(gateVerdict("report", clean)).toEqual({ ok: true, failures: [] });
    expect(gateVerdict("enforce", clean)).toEqual({ ok: true, failures: [] });
  });

  it("nye funn: ok i report, rødt i enforce (med id-ene i meldingen)", () => {
    const r = { ...clean, new_findings: [f("table_orphan:a")] };
    expect(gateVerdict("report", r).ok).toBe(true);
    const e = gateVerdict("enforce", r);
    expect(e.ok).toBe(false);
    expect(e.failures.join("\n")).toContain("table_orphan:a");
  });

  it("kjente funn feller aldri (verken report eller enforce)", () => {
    const r = { ...clean, known_findings: [f("table_orphan:a")] };
    expect(gateVerdict("report", r).ok).toBe(true);
    expect(gateVerdict("enforce", r).ok).toBe(true);
  });

  it("vekst og foreldede oppføringer er røde i BEGGE moduser", () => {
    for (const mode of ["report", "enforce"] as const) {
      const grew = gateVerdict(mode, { ...clean, growth_entries: ["table_orphan:z"] });
      expect(grew.ok, mode).toBe(false);
      expect(grew.failures.join("\n")).toContain("table_orphan:z");
      const stale = gateVerdict(mode, { ...clean, stale_entries: ["table_orphan:y"] });
      expect(stale.ok, mode).toBe(false);
      expect(stale.failures.join("\n")).toContain("table_orphan:y");
    }
  });
});
