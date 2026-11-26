import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  STATUS_BLOCK_BEGIN, STATUS_BLOCK_END, UsageSnapshotSchema, buildConstitution, canonicalizeManifest, checkStatusBlock, extractStatusBlock, renderEvolutionStatusBlock,
  spliceStatusBlock, usageSnapshotFromLedger, type BudgetCaps, type EvolutionStatusInput, type LedgerCounter, type UsageCounter, type UsageSnapshot
} from "../src/index.ts";

/**
 * WP-EV0 (HF2 §29/§31 #18, PC2): PROJECT_STATUS-visningen av Evolution-takene (planlagt), faktisk forbruk, run-rate og eier-tid. Visningen er GENERERT:
 * det signerte manifestet er kilden (øre/minutter), og alt som ikke er målt står som «ikke målt» - aldri 0. Ren logikk.
 */
/** SHA-256 beregnet uavhengig av koden under test. */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const manifest = (): { version: number; budget_caps: BudgetCaps } => JSON.parse(readFileSync(new URL("../../../config/evolution/constitution.v1.json", import.meta.url), "utf8"));
const CAPS: BudgetCaps = {
  max_auto_merges_per_day: 5, max_deploys_per_day: 3, max_deploys_per_hour: 1, max_owner_proposals_per_day: 10, max_evolution_cost_ore_per_month: 10_000,
  max_radar_cost_ore_per_month: 2000, max_eval_cost_ore_per_month: 3000, max_redteam_cost_ore_per_month: 1500, max_shadow_cost_ore_per_month: 1500, max_review_cost_ore_per_month: 2000,
  owner_time_budget_minutes_per_week: 240, max_owner_minutes_per_autonomous_change: 15
};
const USAGE: UsageSnapshot = {
  month: "2026-12", days_elapsed: 10, days_in_month: 31,
  spend_ore: { radar: 450, eval: 1000, redteam: 0, shadow: 1500, review: 300 },
  week_start: "2026-12-07", owner_minutes_week: 90, autonomous_changes_week: 6
};
const SIGNED = { version: 2, digest: "ab".repeat(32), signed: true as boolean | null, verification_code: null as string | null };
const input = (over: Partial<EvolutionStatusInput> = {}): EvolutionStatusInput => ({ generated_at: "2026-12-10T12:00:00.000Z", constitution: SIGNED, caps: CAPS, usage: USAGE, ...over });
const render = (over: Partial<EvolutionStatusInput> = {}): string => renderEvolutionStatusBlock(input(over));
const row = (md: string, label: string): string[] => (md.split("\n").find((l) => l.startsWith(`| ${label} |`)) ?? "").split("|").slice(1, -1).map((c) => c.trim());

describe("A: planlagt tak, faktisk forbruk, brukt % og run-rate pr. kategori (kr)", () => {
  const md = render();

  it("A1: markørene og maskinlesbar kontrollinje (versjon + SHA-256 av de kanoniske takene) er med", () => {
    expect(md.startsWith(`${STATUS_BLOCK_BEGIN}\n`)).toBe(true);
    expect(md.trimEnd().endsWith(STATUS_BLOCK_END)).toBe(true);
    const caps = canonicalizeManifest(CAPS);
    expect(md).toContain(`<!-- evolution-status: constitution_version=2 caps_sha256=${sha256(caps)} -->`);
  });

  it("A2: radar: tak 20,00 kr, faktisk 4,50 kr = 22,5 %, run-rate 4,50 × 31/10 = 13,95 kr -> innenfor", () => {
    expect(row(md, "Radar")).toEqual(["Radar", "20,00", "4,50", "22,5 %", "13,95", "innenfor"]);
  });

  it("A3: evaluering: 10,00 av 30,00 kr = 33,3 %, prognose 31,00 kr (over 30,00) -> «prognose over taket»", () => {
    expect(row(md, "Evaluering")).toEqual(["Evaluering", "30,00", "10,00", "33,3 %", "31,00", "prognose over taket"]);
  });

  it("A4: red team med 0 forbruk er målt 0 (ikke «ikke målt»): 0,00 kr = 0,0 %, prognose 0,00 -> innenfor", () => {
    expect(row(md, "Red team")).toEqual(["Red team", "15,00", "0,00", "0,0 %", "0,00", "innenfor"]);
  });

  it("A5: shadow på nøyaktig taket: 15,00 av 15,00 = 100,0 %, men IKKE over; prognosen (46,50) er over -> «prognose over taket»", () => {
    expect(row(md, "Shadow/canary")).toEqual(["Shadow/canary", "15,00", "15,00", "100,0 %", "46,50", "prognose over taket"]);
  });

  it("A6: totalen summerer alle kategorier (4,50+10+0+15+3 = 32,50 kr = 32,5 % av 100) og prognosen er 100,75 kr (over 100,00)", () => {
    expect(row(md, "Totalt Evolution")).toEqual(["Totalt Evolution", "100,00", "32,50", "32,5 %", "100,75", "prognose over taket"]);
  });

  it("A7: over taket (faktisk > tak) gir «OVER TAKET» (skal aldri skje med låsen, men visningen sier det ærlig)", () => {
    const over = render({ usage: { ...USAGE, spend_ore: { ...USAGE.spend_ore, radar: 2001 } } });
    expect(row(over, "Radar")[5]).toBe("OVER TAKET");
  });

  it("A8: tak 0 = stengt: uten forbruk «stengt (tak 0)», med forbruk «OVER TAKET (tak 0)»; ingen deling på null (brukt vises som «-»)", () => {
    const closed = render({ caps: { ...CAPS, max_radar_cost_ore_per_month: 0, max_evolution_cost_ore_per_month: 8000 }, usage: { ...USAGE, spend_ore: { ...USAGE.spend_ore, radar: 0 } } });
    expect(row(closed, "Radar")).toEqual(["Radar", "0,00", "0,00", "-", "0,00", "stengt (tak 0)"]);
    const bad = render({ caps: { ...CAPS, max_radar_cost_ore_per_month: 0, max_evolution_cost_ore_per_month: 8000 } });
    expect(row(bad, "Radar")).toEqual(["Radar", "0,00", "4,50", "-", "13,95", "OVER TAKET (tak 0)"]);
  });

  it("A9: dagens dag teller som gått (dag 1: prognose = faktisk × 31); formatering uten tusenskille og med to desimaler", () => {
    const d1 = render({ usage: { ...USAGE, days_elapsed: 1, spend_ore: { radar: 1, eval: 0, redteam: 0, shadow: 0, review: 0 } } });
    expect(row(d1, "Radar")[4]).toBe("0,31");
    const big = render({ caps: { ...CAPS, max_evolution_cost_ore_per_month: 100_000, max_radar_cost_ore_per_month: 100_000, max_eval_cost_ore_per_month: 0, max_redteam_cost_ore_per_month: 0, max_shadow_cost_ore_per_month: 0, max_review_cost_ore_per_month: 0 }, usage: { ...USAGE, days_elapsed: 31, spend_ore: { radar: 123_456, eval: 0, redteam: 0, shadow: 0, review: 0 } } });
    expect(row(big, "Radar")[1]).toBe("1000,00");
    expect(row(big, "Radar")[2]).toBe("1234,56");
  });
});

describe("B: ikke målt er aldri 0", () => {
  it("B1: uten forbruksdata (usage null) står alle faktiske verdier som «ikke målt», og forbeholdet sier det", () => {
    const md = render({ usage: null });
    for (const label of ["Radar", "Evaluering", "Red team", "Shadow/canary", "Uavhengig review", "Totalt Evolution"]) {
      const r = row(md, label);
      expect(r.slice(2), label).toEqual(["ikke målt", "ikke målt", "ikke målt", "ikke målt"]);
    }
    expect(md).toContain("Faktisk forbruk er IKKE målt");
    expect(md).toContain("ikke målt");
    expect(md).not.toMatch(/Brukt denne uken[^\n]*\b0\b/);
  });

  it("B2: én kategori som ikke er målt gir «ikke målt» på den raden OG på totalen (en delsum er aldri en total)", () => {
    const md = render({ usage: { ...USAGE, spend_ore: { ...USAGE.spend_ore, eval: null } } });
    expect(row(md, "Evaluering").slice(2)).toEqual(["ikke målt", "ikke målt", "ikke målt", "ikke målt"]);
    expect(row(md, "Radar")[2]).toBe("4,50");
    expect(row(md, "Totalt Evolution").slice(2)).toEqual(["ikke målt", "ikke målt", "ikke målt", "ikke målt"]);
    expect(md).toContain("Forbruk for evaluering er ikke målt");
  });

  it("B3: eier-tid som ikke er målt gir «ikke målt» (ikke 0 min), og snittet pr. endring utelates", () => {
    const md = render({ usage: { ...USAGE, owner_minutes_week: null } });
    expect(row(md, "Brukt denne uken (fra 2026-12-07)")[1]).toBe("ikke målt");
    expect(row(md, "Eier-minutter pr. autonom endring (snitt)")[1]).toBe("ikke målt");
    expect(md).toContain("Eier-tid denne uken er ikke målt");
  });
});

describe("C: eier-tid", () => {
  const md = render();

  it("C1: ukebudsjett 4,0 t (240 min), brukt 1,5 t (90 min) = 37,5 %, tak pr. endring 15 min, 6 autonome endringer, snitt 15,0 min", () => {
    expect(row(md, "Ukebudsjett")).toEqual(["Ukebudsjett", "4,0 t (240 min)"]);
    expect(row(md, "Brukt denne uken (fra 2026-12-07)")).toEqual(["Brukt denne uken (fra 2026-12-07)", "1,5 t (90 min) · 37,5 %"]);
    expect(row(md, "Tak pr. autonom endring")).toEqual(["Tak pr. autonom endring", "15 min"]);
    expect(row(md, "Autonome endringer denne uken")).toEqual(["Autonome endringer denne uken", "6"]);
    expect(row(md, "Eier-minutter pr. autonom endring (snitt)")).toEqual(["Eier-minutter pr. autonom endring (snitt)", "15,0 min"]);
  });

  it("C2: ukebudsjett 0 gir «stengt», ingen deling på 0; ingen autonome endringer gir «ingen endringer» (ikke 0/0)", () => {
    const closed = render({ caps: { ...CAPS, owner_time_budget_minutes_per_week: 0, max_owner_minutes_per_autonomous_change: 0 } });
    expect(row(closed, "Brukt denne uken (fra 2026-12-07)")[1]).toBe("1,5 t (90 min) · over budsjettet (tak 0)");
    const none = render({ usage: { ...USAGE, autonomous_changes_week: 0 } });
    expect(row(none, "Eier-minutter pr. autonom endring (snitt)")[1]).toBe("ingen autonome endringer");
  });

  it("C3: over ukebudsjettet vises som OVER BUDSJETTET", () => {
    expect(row(render({ usage: { ...USAGE, owner_minutes_week: 241 } }), "Brukt denne uken (fra 2026-12-07)")[1]).toBe("4,0 t (241 min) · 100,4 % · OVER BUDSJETTET");
  });
});

describe("D: signaturstatus - takene er aldri «autoritative» uten verifisert signatur", () => {
  it("D1: signert og verifisert", () => {
    expect(render()).toContain("SIGNERT og verifisert");
    expect(render()).not.toContain("UTKAST");
  });

  it("D2: ikke signert: UTKAST med feilkoden, og tydelig at takene ikke er autoritative", () => {
    const md = render({ constitution: { ...SIGNED, signed: false, verification_code: "constitution_unsigned" } });
    expect(md).toContain("UTKAST - IKKE signert/verifisert (constitution_unsigned)");
    expect(md).toContain("IKKE autoritative");
  });

  it("D3: ukjent signaturstatus (null) er heller aldri «signert»", () => {
    const md = render({ constitution: { ...SIGNED, signed: null } });
    expect(md).toContain("ukjent");
    expect(md).not.toContain("SIGNERT og verifisert");
  });

  it("D4: issued_by (kan være et navn) vises ALDRI i visningen; digesten kortes til 12 tegn", () => {
    const md = render({ constitution: { ...SIGNED, issued_by: "Et Personnavn" } as never });
    expect(md).not.toContain("Personnavn");
    expect(md).toContain(`\`${"ab".repeat(6)}\``);
    expect(md).not.toContain("ab".repeat(32));
  });
});

describe("E: grenser fra manifestet og determinisme", () => {
  it("E1: deploy-/merge-/forslagsgrensene vises (fra manifestet, uten tall for forbruk)", () => {
    expect(render()).toContain("auto-merger 5/døgn · deploys 3/døgn og 1/time · E2-forslag til eier 10/døgn");
  });

  it("E2: samme input gir byte-lik utdata (ingen klokke/tilfeldighet), og tidsstempelet er det som ble gitt inn", () => {
    expect(render()).toBe(render());
    expect(render()).toContain("Generert 2026-12-10T12:00:00.000Z");
    expect(render({ generated_at: "2027-01-01T00:00:00.000Z" })).toContain("Generert 2027-01-01T00:00:00.000Z");
  });

  it("E3: repoets manifest kan vises (UTKAST-verdiene): 100 kr totalt, fem kategorier, 4,0 t eier-tid", () => {
    const m = manifest();
    const md = renderEvolutionStatusBlock(input({ caps: m.budget_caps, constitution: { ...SIGNED, version: m.version, signed: false, verification_code: "constitution_unsigned" }, usage: null }));
    expect(row(md, "Totalt Evolution")[1]).toBe("100,00");
    expect(row(md, "Ukebudsjett")[1]).toBe("4,0 t (240 min)");
  });
});

describe("F: usageSnapshotFromLedger - fra de samme tellerne som budsjettlåsen", () => {
  const now = new Date("2026-12-10T12:00:00Z");
  const usage = (over: Partial<UsageCounter> = {}): UsageCounter => ({
    sumSince: async (kind, categories) => (kind === "spend" ? { radar: 450, eval: 1000, redteam: 0, shadow: 1500, review: 300 }[(categories ?? [""])[0] as string] ?? 0 : 90),
    sumForChange: async () => 0, ...over
  });
  const ledger: LedgerCounter = { countSince: async () => 6 };

  it("F1: bygger månedens og ukens tall (dager gått = dag i måneden, dager i måneden, ukestart = mandag)", async () => {
    expect(await usageSnapshotFromLedger(usage(), now, ledger)).toEqual({
      month: "2026-12", days_elapsed: 10, days_in_month: 31, spend_ore: { radar: 450, eval: 1000, redteam: 0, shadow: 1500, review: 300 },
      week_start: "2026-12-07", owner_minutes_week: 90, autonomous_changes_week: 6
    });
  });

  it("F2: februar i skuddår og månedsskifte gir riktig dager i måneden", async () => {
    const feb = await usageSnapshotFromLedger(usage(), new Date("2028-02-29T23:59:59Z"), ledger);
    expect([feb.month, feb.days_elapsed, feb.days_in_month]).toEqual(["2028-02", 29, 29]);
    const jan = await usageSnapshotFromLedger(usage(), new Date("2027-01-01T00:00:00Z"), ledger);
    expect([jan.month, jan.days_elapsed, jan.days_in_month, jan.week_start]).toEqual(["2027-01", 1, 31, "2026-12-28"]);
  });

  it("F3: en teller som feiler eller gir ugyldig verdi gir null for akkurat den delen (aldri 0), resten beholdes", async () => {
    const partial = await usageSnapshotFromLedger(usage({
      sumSince: async (kind, categories) => {
        if (kind === "spend" && categories?.[0] === "eval") throw new Error("db nede");
        if (kind === "spend" && categories?.[0] === "shadow") return Number.NaN;
        if (kind === "owner_time") throw new Error("db nede");
        return 5;
      }
    }), now, { countSince: async () => -1 });
    expect(partial.spend_ore).toEqual({ radar: 5, eval: null, redteam: 5, shadow: null, review: 5 });
    expect(partial.owner_minutes_week).toBeNull();
    expect(partial.autonomous_changes_week).toBeNull();
  });

  it("F4: uten endringsregister-teller er antall autonome endringer null; ugyldig klokke kaster (kalleren må håndtere)", async () => {
    expect((await usageSnapshotFromLedger(usage(), now)).autonomous_changes_week).toBeNull();
    await expect(usageSnapshotFromLedger(usage(), new Date(Number.NaN), ledger)).rejects.toThrow();
  });

  it("F5: skjemaet for et snapshot er strengt (ukjent felt, negative tall, feil dato, dager gått > dager i måneden avvises)", () => {
    expect(UsageSnapshotSchema.safeParse(USAGE).success).toBe(true);
    for (const bad of [
      { ...USAGE, extra: 1 }, { ...USAGE, month: "2026-13" }, { ...USAGE, month: "26-12" }, { ...USAGE, days_elapsed: 0 }, { ...USAGE, days_elapsed: 32 }, { ...USAGE, days_in_month: 27 },
      { ...USAGE, days_elapsed: 30, days_in_month: 28 }, { ...USAGE, spend_ore: { ...USAGE.spend_ore, radar: -1 } }, { ...USAGE, spend_ore: { ...USAGE.spend_ore, radar: 1.5 } },
      { ...USAGE, spend_ore: { ...USAGE.spend_ore, total: 3 } }, { ...USAGE, week_start: "2026-12-07T00:00:00Z" }, { ...USAGE, owner_minutes_week: -5 }
    ]) expect(UsageSnapshotSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe("G: kontroll mot PROJECT_STATUS (doc-vakt) - blokken kan ikke avvike fra det signerte manifestet", () => {
  const m = manifest();
  const caps = m.budget_caps;
  const block = renderEvolutionStatusBlock(input({ caps, constitution: { ...SIGNED, version: m.version } }));
  const doc = `# PROJECT STATUS\n\nformål\n\n${block}\n\nresten av dokumentet\n`;

  it("G1: en frisk blokk gir ingen funn; uten blokk gir «status_block_missing» (kalleren avgjør om det er en feil)", () => {
    expect(checkStatusBlock(doc, { version: m.version, caps })).toEqual([]);
    expect(checkStatusBlock("# ingenting\n", { version: m.version, caps })).toEqual(["status_block_missing"]);
  });

  it("G2: endrede tak eller versjon i manifestet gir foreldet blokk", () => {
    expect(checkStatusBlock(doc, { version: m.version, caps: { ...caps, max_radar_cost_ore_per_month: caps.max_radar_cost_ore_per_month + 1 } })).toEqual(["status_block_caps_stale"]);
    expect(checkStatusBlock(doc, { version: m.version + 1, caps })).toEqual([`status_block_version_stale:${m.version}!=${m.version + 1}`]);
    expect(checkStatusBlock(doc, { version: m.version + 1, caps: { ...caps, owner_time_budget_minutes_per_week: 1 } }).sort()).toEqual(["status_block_caps_stale", `status_block_version_stale:${m.version}!=${m.version + 1}`].sort());
  });

  it("G3: håndredigert kontrollinje (fjernet eller ødelagt) og ødelagte markører avsløres", () => {
    expect(checkStatusBlock(doc.replace(/<!-- evolution-status:[^>]*-->\n/, ""), { version: m.version, caps })).toEqual(["status_block_marker_missing"]);
    expect(checkStatusBlock(doc.replace("caps_sha256=", "caps_sha256=0"), { version: m.version, caps })).toEqual(["status_block_marker_missing"]);
    expect(checkStatusBlock(doc.replace(STATUS_BLOCK_END, ""), { version: m.version, caps })).toEqual(["status_block_malformed"]);
    expect(checkStatusBlock(`${doc}\n${block}\n`, { version: m.version, caps })).toEqual(["status_block_malformed"]);
    expect(checkStatusBlock(`${STATUS_BLOCK_END}\n${doc}`, { version: m.version, caps })).toEqual(["status_block_malformed"]);
  });

  it("G4: extractStatusBlock gir blokken (inkl. markører) eller null; spliceStatusBlock bytter KUN det mellom markørene og returnerer null uten gyldige markører", () => {
    expect(extractStatusBlock(doc)).toBe(block.trimEnd());
    expect(extractStatusBlock("ingen")).toBeNull();
    const fresh = renderEvolutionStatusBlock(input({ caps: { ...caps, max_radar_cost_ore_per_month: 1 }, constitution: { ...SIGNED, version: m.version } }));
    const spliced = spliceStatusBlock(doc, fresh)!;
    expect(spliced.startsWith("# PROJECT STATUS\n\nformål\n\n")).toBe(true);
    expect(spliced.endsWith("\n\nresten av dokumentet\n")).toBe(true);
    expect(extractStatusBlock(spliced)).toBe(fresh.trimEnd());
    expect(spliceStatusBlock("ingen markører", fresh)).toBeNull();
    expect(spliceStatusBlock(doc.replace(STATUS_BLOCK_END, ""), fresh)).toBeNull();
  });

  it("G5: repoets manifest passerer sin egen generator (den innsjekkede konstitusjonen kan vises uten feil)", () => {
    expect(() => buildConstitution(JSON.parse(readFileSync(new URL("../../../config/evolution/constitution.v1.json", import.meta.url), "utf8")))).not.toThrow();
  });
});
