import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  VisionRetentionConfirmationRequiredError, VisionService, describeRetention, derivedWindowShortened, retentionShortening, type DerivedWindowDays, type VisionRetentionView
} from "../src/service.ts";
import { seedTenant, startVisionDb, type VisionDb } from "./support/harness.ts";

/**
 * WP-G3b fiks-runde 1 (D-485), F1: den typede bekreftelsen dekker AVLEDEDE data (G4-signalsituasjoner i domenet `vision`) også når grunnvinduet over er lengre enn rutens standard (30).
 *
 * Tjenesten kjenner verken G4 eller miljøvariabler: kjøretiden gir `derived_window_days` = det EFFEKTIVE vinduet avledede data følger som funksjon av `retention_days` (`null` = ingen rad). Her brukes G4-regelen speilet som en ren funksjon
 * (`min(grunnvindu, dager ?? grunnvindu)`); at regelen er DEN SAMME som sveipets, og at hele kjeden rute -> sveip stemmer, bevises mot ekte sveip i apps/api/test/wpg3b-vision-retention-g4-chain.test.ts.
 */
const g4 = (base: number): DerivedWindowDays => (days) => Math.min(base, days ?? base);

describe("derivedWindowShortened og retentionShortening: den avledede regelen kommer i TILLEGG til de effektive vinduene", () => {
  const view = (retention: number, snapshot: number | null): VisionRetentionView => describeRetention({ retention_days: retention, snapshot_retention_days: snapshot, updated_at: null });
  const NONE = describeRetention(null);
  // [navn, forrige, ny, grunnvindu, forventet {retention_days, snapshot_retention_days}, forventet at det AVLEDEDE vinduet blir kortere]
  const cases: Array<[string, VisionRetentionView, { retention_days: number; snapshot_retention_days: number | null }, number, { retention_days: boolean; snapshot_retention_days: boolean }, boolean]> = [
    ["grunnvindu 90, ingen rad: å sette 31 er en forkorting av avledede situasjoner (90 -> 31) selv om 31 er lengre enn rutens standard 30", NONE, { retention_days: 31, snapshot_retention_days: null }, 90, { retention_days: true, snapshot_retention_days: false }, true],
    ["grunnvindu 30 (standard), ingen rad: 31 er ingen forkorting (30 -> 30)", NONE, { retention_days: 31, snapshot_retention_days: null }, 30, { retention_days: false, snapshot_retention_days: false }, false],
    ["grunnvindu 90, ingen rad: 90 og 365 gir uendret avledet vindu (90 -> 90)", NONE, { retention_days: 365, snapshot_retention_days: null }, 90, { retention_days: false, snapshot_retention_days: false }, false],
    ["grunnvindu 90, ingen rad: en første setting LIK standarden (30) forkorter det avledede vinduet 90 -> 30", NONE, { retention_days: 30, snapshot_retention_days: null }, 90, { retention_days: true, snapshot_retention_days: false }, true],
    ["grunnvindu 90, rad 40: 60 forlenger (40 -> 60), ingen bekreftelse", view(40, null), { retention_days: 60, snapshot_retention_days: null }, 90, { retention_days: false, snapshot_retention_days: false }, false],
    ["grunnvindu 90, rad 40: 20 forkorter (også etter den vanlige regelen)", view(40, null), { retention_days: 20, snapshot_retention_days: null }, 90, { retention_days: true, snapshot_retention_days: false }, true],
    ["grunnvindu 90, rad 100 (satt utenom ruten): 95 er kortere enn raden (vanlig regel) men det avledede vinduet er uendret (90 -> 90)", view(100, null), { retention_days: 95, snapshot_retention_days: null }, 90, { retention_days: true, snapshot_retention_days: false }, false],
    ["grunnvindu 90, rad 100: 50 forkorter det avledede vinduet 90 -> 50", view(100, null), { retention_days: 50, snapshot_retention_days: null }, 90, { retention_days: true, snapshot_retention_days: false }, true],
    ["grunnvindu 7, ingen rad: 30 er en forlengelse av hendelsene men det avledede vinduet er uendret (7 -> 7)", NONE, { retention_days: 30, snapshot_retention_days: null }, 7, { retention_days: false, snapshot_retention_days: false }, false],
    ["grunnvindu 7, ingen rad: 5 forkorter alt (hendelser, bilder og avledet)", NONE, { retention_days: 5, snapshot_retention_days: null }, 7, { retention_days: true, snapshot_retention_days: true }, true],
    ["kun bildevinduet forkortes: det avledede vinduet følger hendelsesvinduet og er uendret", view(60, 14), { retention_days: 60, snapshot_retention_days: 3 }, 30, { retention_days: false, snapshot_retention_days: true }, false],
    ["grunnvindu 365 (maks), ingen rad: 200 forkorter 365 -> 200", NONE, { retention_days: 200, snapshot_retention_days: null }, 365, { retention_days: true, snapshot_retention_days: false }, true]
  ];
  for (const [name, previous, next, base, expected, derived] of cases) {
    it(name, () => {
      expect(derivedWindowShortened(previous, next, g4(base))).toBe(derived);
      expect(retentionShortening(previous, next, g4(base))).toEqual(expected);
    });
  }

  it("uten avledet funksjon (signalbryteren AV) er resultatet IDENTISK med reglene før: aldri en avledet forkorting", () => {
    expect(derivedWindowShortened(NONE, { retention_days: 5, snapshot_retention_days: null }, undefined)).toBe(false);
    expect(retentionShortening(NONE, { retention_days: 31, snapshot_retention_days: null })).toEqual({ retention_days: false, snapshot_retention_days: false });
    expect(retentionShortening(NONE, { retention_days: 31, snapshot_retention_days: null }, undefined)).toEqual({ retention_days: false, snapshot_retention_days: false });
    expect(retentionShortening(NONE, { retention_days: 5, snapshot_retention_days: null }, undefined)).toEqual({ retention_days: true, snapshot_retention_days: true });
  });

  it("`previous` uten rad (configured: false) gir `null` til funksjonen (ikke standarden 30): uten rad gjelder grunnvinduet selv", () => {
    const seen: Array<number | null> = [];
    const spy: DerivedWindowDays = (days) => { seen.push(days); return 100; };
    derivedWindowShortened(NONE, { retention_days: 31, snapshot_retention_days: null }, spy);
    derivedWindowShortened(view(30, null), { retention_days: 31, snapshot_retention_days: null }, spy); // en rad lik standarden er IKKE «ingen rad»
    expect(seen).toEqual([31, null, 31, 30]);
  });
});

describe("applyRetentionPolicy med `derived_window_days`: forkorting av avledede data krever den typede bekreftelsen", () => {
  let db: VisionDb;
  let T: Awaited<ReturnType<typeof seedTenant>>;
  let vision: VisionService;
  const prov = (over: Record<string, unknown> = {}) => ({ actor_person_id: T.owner, task_id: "g3b-derived-test", session_id: "s-derived", device_id: "d-derived", audit: true, ...over });
  const apply = (retention: number, snapshot: number | null, over: Record<string, unknown> = {}, space: "home" | "personal" = "home") =>
    vision.applyRetentionPolicy(T.tenant, space, { retention_days: retention, snapshot_retention_days: snapshot }, prov(over));
  const row = async (space = "home"): Promise<Record<string, unknown> | undefined> =>
    (await db.admin.query(`SELECT retention_days, snapshot_retention_days, updated_at FROM vision_retention_policies WHERE tenant_id = $1 AND memory_space_id = $2`, [T.tenant, space])).rows[0] as Record<string, unknown> | undefined;
  /** Revisjonsradene siden denne testen startet (`audit_events` er append-only: ingenting slettes mellom testene, så hver test teller fra et utgangspunkt). */
  let auditBase = 0;
  const allAudits = async (): Promise<Array<{ payload: Record<string, unknown> }>> =>
    (await db.admin.query(`SELECT payload FROM audit_events WHERE tenant_id = $1 AND type = 'vision.retention_set' ORDER BY audit_id`, [T.tenant])).rows as never;
  const audits = async (): Promise<Array<{ payload: Record<string, unknown> }>> => (await allAudits()).slice(auditBase);
  const refused = async (run: () => Promise<unknown>): Promise<VisionRetentionConfirmationRequiredError> => {
    try {
      await run();
    } catch (err) {
      expect(err).toBeInstanceOf(VisionRetentionConfirmationRequiredError);
      return err as VisionRetentionConfirmationRequiredError;
    }
    throw new Error("forventet VisionRetentionConfirmationRequiredError, men forespørselen gikk gjennom");
  };

  beforeAll(async () => {
    db = await startVisionDb("g3bder");
    T = await seedTenant(db, "g3bder-t1");
    vision = new VisionService(db.app);
  }, 240_000);
  afterAll(async () => { await db?.stop(); }, 120_000);
  beforeEach(async () => {
    await db.admin.query(`DELETE FROM vision_retention_policies WHERE tenant_id = $1`, [T.tenant]);
    auditBase = (await allAudits()).length;
  });

  it("S3: grunnvindu 90 og ingen rad: 31 uten bekreftelse kastes FØR noe skrives (ingen rad, ingen revisjon) og peker på de avledede situasjonene; uten funksjonen går samme forespørsel igjennom som før", async () => {
    const err = await refused(() => apply(31, null, { derived_window_days: g4(90), confirm_shortening: false }));
    expect(err.shortened).toEqual(["retention_days"]);
    expect(err.affectsExisting).toEqual(["signal_situations"]);
    expect(await row()).toBeUndefined();
    expect(await audits()).toHaveLength(0);
    // kontroll: uten avledet funksjon (signalbryteren AV) er 31 en forlengelse av standarden: ingen bekreftelse (uendret oppførsel)
    const plain = await apply(31, null, { confirm_shortening: false });
    expect(plain).toMatchObject({ changed: true, shortened: { retention_days: false, snapshot_retention_days: false } });
    expect(await row()).toMatchObject({ retention_days: 31 });
  });

  it("med bekreftelse skrives forkortingen, og revisjonen bærer `shortened`, `confirmed` og `affects_existing` (kun koder)", async () => {
    const out = await apply(31, null, { derived_window_days: g4(90), confirm_shortening: true });
    expect(out).toMatchObject({ changed: true, shortened: { retention_days: true, snapshot_retention_days: false }, current: { retention_days: 31 } });
    const [audit] = await audits();
    expect(audit?.payload).toMatchObject({ previous_configured: false, previous_retention_days: 30, retention_days: 31, shortened: ["retention_days"], confirmed: true, affects_existing: ["signal_situations"] });
  });

  it("en forlengelse av det avledede vinduet (rad 40 -> 60 under grunnvindu 90) krever ingen bekreftelse, og revisjonen har ingen `affects_existing`", async () => {
    await apply(40, null);
    const out = await apply(60, null, { derived_window_days: g4(90), confirm_shortening: false });
    expect(out).toMatchObject({ changed: true, shortened: { retention_days: false, snapshot_retention_days: false } });
    const all = await audits();
    expect(all).toHaveLength(2);
    expect(all[1]?.payload).toMatchObject({ shortened: [], confirmed: false });
    expect(Object.keys(all[1]?.payload ?? {})).not.toContain("affects_existing");
  });

  it("gjenspilling er fortsatt en no-op (ingen bekreftelse, ingen skriving, ingen revisjon) også med avledet funksjon", async () => {
    await apply(31, null, { derived_window_days: g4(90), confirm_shortening: true });
    const before = { row: await row(), audits: (await audits()).length };
    const again = await apply(31, null, { derived_window_days: g4(90), confirm_shortening: false });
    expect(again.changed).toBe(false);
    expect(await row()).toEqual(before.row);
    expect(await audits()).toHaveLength(before.audits);
  });

  it("en vanlig forkorting som IKKE forkorter det avledede vinduet (rad 90 -> 40 under grunnvindu 30) krever bekreftelse, men peker ikke på avledede situasjoner; bildevinduet alene gjør det heller ikke", async () => {
    await apply(90, 30);
    const plain = await refused(() => apply(40, 30, { derived_window_days: g4(30), confirm_shortening: false }));
    expect(plain.shortened).toEqual(["retention_days"]);
    expect(plain.affectsExisting).toEqual([]);
    const snapshotOnly = await refused(() => apply(90, 3, { derived_window_days: g4(30), confirm_shortening: false }));
    expect(snapshotOnly.shortened).toEqual(["snapshot_retention_days"]);
    expect(snapshotOnly.affectsExisting).toEqual([]);
    expect(await row()).toMatchObject({ retention_days: 90, snapshot_retention_days: 30 });
  });

  it("når både den vanlige og den avledede regelen slår inn (rad 60 -> 10 under grunnvindu 30): `shortened` har hendelsesvinduet, og begge årsakene vises", async () => {
    await apply(60, 5, { confirm_shortening: true }); // 5 er kortere enn standard bildevindu (7): oppsettet må selv bekrefte
    const err = await refused(() => apply(10, 5, { derived_window_days: g4(30), confirm_shortening: false }));
    expect(err.shortened).toEqual(["retention_days"]);
    expect(err.affectsExisting).toEqual(["signal_situations"]);
  });

  it("avgjørelsen tas mot raden som faktisk overskrives (under låsen): den avledede funksjonen får `null` uten rad og radens dager med rad", async () => {
    const seen: Array<number | null> = [];
    const spy: DerivedWindowDays = (days) => { seen.push(days); return days ?? 90; };
    await apply(50, null, { derived_window_days: spy, confirm_shortening: true }); // spionen gir 90 uten rad: 50 er en forkorting (bekreftes)
    expect(seen).toContain(null); // ingen rad: `null`, aldri standarden 30
    expect(seen).not.toContain(30);
    seen.length = 0;
    await apply(60, null, { derived_window_days: spy });
    expect(seen).toContain(50); // raden som faktisk overskrives
    expect(seen).not.toContain(null);
  });

  it("(tenant, space) er nøkkelen: raden i `personal` regnes ikke som forrige tilstand for `home`", async () => {
    await apply(40, null, {}, "personal");
    const err = await refused(() => apply(31, null, { derived_window_days: g4(90), confirm_shortening: false }, "home"));
    expect(err.affectsExisting).toEqual(["signal_situations"]); // `home` har ingen rad: grunnvinduet 90 -> 31
  });
});
