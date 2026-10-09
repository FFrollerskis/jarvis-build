import { describe, expect, it } from "vitest";
import { evaluateAllReadiness, type DormantEv } from "@jarvis/self-modification";
import type { EvolutionSection } from "@jarvis/executive";
import { boundariesSection, buildEvolutionReport, dormantSection, errorClass, healSection, modelRouteSection, readinessFacts, type EvolutionSourceDeps } from "../src/evolution-source.ts";
import { HEALTHY_HANDLERS, SECRET_FRAGMENTS, SECRET_TEXT, connector, ctxOf, fakePool, healthy, healthyWorld, mesh, secretError, sloReport, type OptionalDep, type World } from "./support/evolution-world.ts";

/**
 * M2 (gjennomgang av PR #313): seksjonene feilet ÅPENT - «alt nede» ga `OK – Grensene er på plass` fordi kill switch ble fabrikkert til `false`, hendelsestallet til `0` og manglende oppstartssjekk ikke ga noe funn. Her er
 * den bindende testmatrisen: for HVER avhengighet i `EvolutionSourceDeps` som svikter på HVER måte den kan svikte (kaster synkront/asynkront, `null`, `undefined`, ugyldig form, tomt svar) gjelder
 *   1. seksjonene som hviler på avhengigheten er ALDRI `OK` (UNKNOWN, eller ATTENTION hvis noe KJENT står i veien),
 *   2. seksjonene som IKKE hviler på den er uberørt (svikten sprer seg ikke, og ingen seksjon forsvinner fra rapporten),
 *   3. `activation_decision` er fortsatt literal `false`, og nøyaktig de sovende delene som hviler på avhengigheten er IKKE lenger «klare for en navngitt D-beslutning».
 * Referansen er en frisk verden (`support/evolution-world.ts`) der alt er OK og alle ni sovende deler er klare - ellers beviser ikke «ikke OK» noe.
 */
const OBSERVE = ["EV-0/EV-8", "EV-5", "EV-3", "EV-4", "EV-9", "EV-10", "EV-12", "EV-16", "EV-17", "EV-19", "EV-21"] as const;
const DORMANT_ID = "EV-6/11/13/14/15/18/20/22/23";
/** Rapportens faste rekkefølge (BASE_SECTIONS). */
const ORDER = ["EV-0/EV-8", "EV-5", "EV-3", "EV-4", "EV-9", "EV-10", "EV-12", "EV-16", "EV-17", "EV-19", "EV-21", DORMANT_ID];
const PARTS: DormantEv[] = ["EV-6", "EV-11", "EV-13", "EV-14", "EV-15", "EV-18", "EV-20", "EV-22", "EV-23"];

const throwsSync = (): never => { throw secretError(); };
const rejects = async (): Promise<never> => { throw secretError(); };
const returnsNull = (): never => null as never;
const returnsUndefined = (): never => undefined as never;

interface Scenario {
  name: string;
  over: (w: World) => Partial<EvolutionSourceDeps>;
  /** Valgfrie avhengigheter som utelates helt. */
  drop?: readonly OptionalDep[];
  /** Observasjonsseksjonene som hviler på avhengigheten og derfor ikke kan være OK. */
  broken: readonly string[];
  /** Sovende deler som ikke lenger er klare. */
  notReady: readonly DormantEv[];
}

const FREEZE_BROKEN = ["EV-0/EV-8"] as const;
const ALL_PARTS = PARTS;
const POOL_DEPENDENT = ["EV-0/EV-8", "EV-5", "EV-9", "EV-10", "EV-16", "EV-19"] as const;

const SCENARIOS: Scenario[] = [
  // --- EV-0: oppstartssjekken -----------------------------------------------------------------------------------------------------------------------------------------------------
  { name: "ev0Status kaster", over: () => ({ ev0Status: throwsSync }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  { name: "ev0Status gir null", over: () => ({ ev0Status: returnsNull }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  { name: "ev0Status gir undefined", over: () => ({ ev0Status: returnsUndefined }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  { name: "ev0Status gir ugyldig form ({})", over: () => ({ ev0Status: () => ({}) as never }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  // --- SLO-rapporten --------------------------------------------------------------------------------------------------------------------------------------------------------------
  { name: "slo avviser", over: () => ({ slo: rejects }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  { name: "slo kaster synkront", over: () => ({ slo: throwsSync }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  { name: "slo gir null", over: () => ({ slo: async () => null as never }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  { name: "slo gir undefined", over: () => ({ slo: async () => undefined as never }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  { name: "slo gir tomt objekt ({})", over: () => ({ slo: async () => ({}) as never }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  { name: "slo gir en rapport uten ett eneste tjenestemål (slos: [])", over: () => ({ slo: async () => sloReport({ slos: [] }) }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  // --- kill switch ----------------------------------------------------------------------------------------------------------------------------------------------------------------
  { name: "killSwitchActive avviser", over: () => ({ killSwitchActive: rejects }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  { name: "killSwitchActive kaster synkront", over: () => ({ killSwitchActive: throwsSync }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  { name: "killSwitchActive gir null", over: () => ({ killSwitchActive: async () => null as never }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  { name: "killSwitchActive gir undefined", over: () => ({ killSwitchActive: async () => undefined as never }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  { name: "killSwitchActive gir noe som ikke er en boolsk verdi", over: () => ({ killSwitchActive: async () => "false" as never }), broken: FREEZE_BROKEN, notReady: ALL_PARTS },
  // --- connector-registeret -------------------------------------------------------------------------------------------------------------------------------------------------------
  { name: "connectors avviser", over: () => ({ connectors: rejects }), broken: ["EV-9", "EV-17"], notReady: ["EV-18"] },
  { name: "connectors kaster synkront", over: () => ({ connectors: throwsSync }), broken: ["EV-9", "EV-17"], notReady: ["EV-18"] },
  { name: "connectors gir null", over: () => ({ connectors: async () => null as never }), broken: ["EV-9", "EV-17"], notReady: ["EV-18"] },
  { name: "connectors gir undefined", over: () => ({ connectors: async () => undefined as never }), broken: ["EV-9", "EV-17"], notReady: ["EV-18"] },
  { name: "connectors gir tomt svar ([])", over: () => ({ connectors: async () => [] }), broken: ["EV-9", "EV-17"], notReady: ["EV-18"] },
  // --- modellmeshen ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  { name: "mesh kaster", over: () => ({ mesh: throwsSync }), broken: ["EV-9", "EV-12"], notReady: [] },
  { name: "mesh gir null", over: () => ({ mesh: returnsNull }), broken: ["EV-9", "EV-12"], notReady: [] },
  { name: "mesh gir undefined", over: () => ({ mesh: returnsUndefined }), broken: ["EV-9", "EV-12"], notReady: [] },
  { name: "mesh gir en liste uten leverandører", over: () => ({ mesh: () => mesh({}, []) }), broken: ["EV-9", "EV-12"], notReady: [] },
  // --- databasen (pool) -----------------------------------------------------------------------------------------------------------------------------------------------------------
  { name: "pool: query og connect avviser", over: () => ({ pool: { query: rejects, connect: rejects } as never }), broken: POOL_DEPENDENT, notReady: ALL_PARTS },
  { name: "pool er undefined", over: () => ({ pool: undefined as never }), broken: POOL_DEPENDENT, notReady: ALL_PARTS },
  { name: "pool er null", over: () => ({ pool: null as never }), broken: POOL_DEPENDENT, notReady: ALL_PARTS },
  { name: "pool: svar uten rows-felt ({})", over: () => ({ pool: { query: async () => ({}), connect: async () => ({ query: async () => ({}), release: () => undefined }) } as never }), broken: POOL_DEPENDENT, notReady: ALL_PARTS },
  // Tomt svar på ALT: EV-10 er unntaket (null aktive minner er et gyldig svar og sies eksplisitt - se egen test under); resten hviler på aggregeringer som alltid gir én rad.
  { name: "pool: tomt svar på alle spørringer", over: () => ({ pool: fakePool([]) }), broken: ["EV-0/EV-8", "EV-5", "EV-9", "EV-16", "EV-19"], notReady: ALL_PARTS },
  // --- radaren (EV-3) -------------------------------------------------------------------------------------------------------------------------------------------------------------
  { name: "radar mangler", over: () => ({}), drop: ["radar"], broken: ["EV-3"], notReady: [] },
  { name: "radar.last() kaster", over: (w) => ({ radar: { ...w.radar, last: throwsSync } }), broken: ["EV-3"], notReady: [] },
  { name: "radar.last() gir undefined (ugyldig form)", over: (w) => ({ radar: { ...w.radar, last: returnsUndefined } }), broken: ["EV-3"], notReady: [] },
  { name: "radar har kilder men sveipet har ikke kjørt (null)", over: (w) => ({ radar: { ...w.radar, last: returnsNull } }), broken: ["EV-3"], notReady: [] },
  // --- omregning av sensitivitet (EV-10) ------------------------------------------------------------------------------------------------------------------------------------------
  { name: "resensitize kaster", over: () => ({ resensitize: throwsSync }), broken: ["EV-10"], notReady: [] },
  { name: "resensitize gir null (har ikke kjørt)", over: () => ({ resensitize: returnsNull }), broken: ["EV-10"], notReady: [] },
  { name: "resensitize mangler", over: () => ({}), drop: ["resensitize"], broken: ["EV-10"], notReady: [] },
  // --- verktøyflaten (EV-4/EV-21) -------------------------------------------------------------------------------------------------------------------------------------------------
  { name: "toolSurface kaster", over: () => ({ toolSurface: throwsSync }), broken: ["EV-4", "EV-21"], notReady: [] },
  // Uten verktøyflate hoppes verktøyutvalgs-oppgavene over (L3): EV-4 er ikke OK. Red-team-oppgavene trenger ikke flaten, så EV-21 er uberørt.
  { name: "toolSurface gir null (verktøyflaten er ikke tilgjengelig)", over: () => ({ toolSurface: returnsNull }), broken: ["EV-4"], notReady: [] },
  { name: "toolSurface mangler", over: () => ({}), drop: ["toolSurface"], broken: ["EV-4"], notReady: [] }
];

const byEv = (sections: readonly EvolutionSection[], ev: string): EvolutionSection => sections.find((s) => s.ev === ev)!;

describe("M2: referanse - den friske verdenen", () => {
  it("alle elleve observasjonsseksjoner er OK og alle ni sovende deler er klare for en beslutning (aktivering er likevel alltid false)", async () => {
    const w = await healthyWorld();
    const report = await buildEvolutionReport(w.deps());
    expect(report.sections.map((s) => s.ev)).toEqual(ORDER);
    for (const ev of OBSERVE) expect(byEv(report.sections, ev).status, `${ev}: ${byEv(report.sections, ev).summary_no}`).toBe("OK");
    expect(byEv(report.sections, DORMANT_ID).status).toBe("DORMANT");
    const verdicts = evaluateAllReadiness(await readinessFacts(ctxOf(w.deps())));
    expect(verdicts.map((v) => v.ev)).toEqual(PARTS);
    for (const v of verdicts) { expect(v.ready_for_owner_decision, v.ev).toBe(true); expect(v.activation_decision, v.ev).toBe(false); expect(v.unknown_signals, v.ev).toEqual([]); }
  });
});

describe("M2: svikt i HVER avhengighet gir aldri OK i seksjonene som hviler på den", () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      const w = await healthyWorld();
      const d = w.deps(sc.over(w), sc.drop);
      const report = await buildEvolutionReport(d);
      expect(report.acts).toBe(false);
      expect(report.sections.map((s) => s.ev), "ingen seksjon forsvinner").toEqual(ORDER);
      // L2: avhengighetene kaster en feil full av vert/port/rolle/passord - ingenting av det skal ende i rapporten (som går til modellen).
      const json = JSON.stringify(report);
      for (const fragment of SECRET_FRAGMENTS) expect(json, `${sc.name}: «${fragment}» lekket til rapporten`).not.toContain(fragment);
      for (const ev of OBSERVE) {
        const s = byEv(report.sections, ev);
        if (sc.broken.includes(ev)) expect(["UNKNOWN", "ATTENTION"], `${ev} hviler på det som sviktet, men sa: ${s.status} - ${s.summary_no}`).toContain(s.status);
        else expect(s.status, `${ev} hviler ikke på det som sviktet, men sa: ${s.status} - ${s.summary_no}`).toBe("OK");
      }
      const verdicts = evaluateAllReadiness(await readinessFacts(ctxOf(d)));
      for (const v of verdicts) expect(v.activation_decision, v.ev).toBe(false);
      expect(verdicts.filter((v) => !v.ready_for_owner_decision).map((v) => v.ev), "sovende deler som ikke lenger er klare").toEqual([...sc.notReady]);
      // Rapportteksten må stemme med beslutningsfunksjonen: like mange «klar»-linjer som klare deler.
      const dormant = byEv(report.sections, DORMANT_ID);
      expect(dormant.status).toBe("DORMANT");
      expect(dormant.findings.filter((f) => f.includes("klar for en navngitt D-beslutning")).length).toBe(PARTS.length - sc.notReady.length);
    });
  }

  it("ALT nede samtidig: ingen observasjonsseksjon er OK, ingen sovende del er klar, og rapporten har fortsatt alle seksjonene", async () => {
    const w = await healthyWorld();
    const d = w.deps({
      ev0Status: throwsSync, slo: rejects, killSwitchActive: rejects, connectors: rejects, mesh: throwsSync, toolSurface: throwsSync, resensitize: throwsSync,
      pool: { query: rejects, connect: rejects } as never
    }, ["radar"]);
    const report = await buildEvolutionReport(d);
    expect(report.sections.map((s) => s.ev)).toEqual(ORDER);
    for (const ev of OBSERVE) expect(byEv(report.sections, ev).status, `${ev}: ${byEv(report.sections, ev).summary_no}`).not.toBe("OK");
    expect(byEv(report.sections, DORMANT_ID).findings.filter((f) => f.includes("klar for en navngitt D-beslutning"))).toEqual([]);
    for (const v of evaluateAllReadiness(await readinessFacts(ctxOf(d)))) { expect(v.activation_decision, v.ev).toBe(false); expect(v.ready_for_owner_decision, v.ev).toBe(false); }
  });

  it("klokken kaster: rapporten avvises helt (aldri en rapport med påstått tid eller en OK-seksjon)", async () => {
    const w = await healthyWorld();
    await expect(buildEvolutionReport(w.deps({ now: throwsSync }))).rejects.toBeInstanceOf(Error);
    await expect(buildEvolutionReport(w.deps({ now: () => new Date(Number.NaN) }))).rejects.toBeInstanceOf(Error);
  });

  it("ekstra seksjoner som kaster eller returnerer noe ugyldig blir UNKNOWN - aldri OK og aldri borte", async () => {
    const w = await healthyWorld();
    const report = await buildEvolutionReport(w.deps({ extraSections: [async () => { throw secretError(); }, () => { throw secretError(); }] }));
    const extras = report.sections.slice(ORDER.length);
    expect(extras.map((s) => [s.ev, s.status])).toEqual([["EV-extra-1", "UNKNOWN"], ["EV-extra-2", "UNKNOWN"]]);
  });
});

describe("M2: reviewerens reproduksjoner, én og én", () => {
  it("bare ev0Status: () => null → EV-0/EV-8 er ikke OK, og sier at oppstartssjekken er ukjent", async () => {
    const w = await healthyWorld();
    const s = await boundariesSection(ctxOf(w.deps({ ev0Status: () => null })));
    expect(s.status).not.toBe("OK");
    expect(s.summary_no).not.toContain("Grensene er på plass");
    expect(s.findings.join("\n")).toContain("kunne ikke leses (ukjent)");
  });

  it("kill switch som kaster → freeze kan ikke utelukkes, og seksjonen sier det (aldri «Change freeze er av»)", async () => {
    const w = await healthyWorld();
    for (const killSwitchActive of [rejects, throwsSync, async () => undefined as never]) {
      const s = await boundariesSection(ctxOf(w.deps({ killSwitchActive })));
      const text = s.findings.join("\n");
      expect(s.status).toBe("UNKNOWN");
      expect(text).toContain("Change freeze kan ikke utelukkes");
      expect(text).toContain("kill_switch_unknown");
      expect(text).not.toContain("Change freeze er av");
      expect(s.summary_no).toContain("kill switch");
    }
  });

  it("ukjent hendelsestall (databasen nede) er ikke «0 hendelser»: freeze kan ikke utelukkes", async () => {
    const w = await healthyWorld();
    const s = await boundariesSection(ctxOf(w.deps({ pool: { query: rejects, connect: rejects } as never })));
    expect(s.status).toBe("UNKNOWN");
    expect(s.findings.join("\n")).toContain("incident_state_unknown");
    expect(s.findings.join("\n")).toContain("Åpne hendelser kunne ikke telles (ukjent)");
  });

  it("kjent problem + ukjent: ATTENTION vinner, og det ukjente sies i tillegg", async () => {
    const w = await healthyWorld();
    const s = await boundariesSection(ctxOf(w.deps({ killSwitchActive: async () => true, ev0Status: () => null })));
    expect(s.status).toBe("ATTENTION");
    expect(s.findings.join("\n")).toContain("Change freeze er PÅ: kill_switch_active");
    expect(s.summary_no).toContain("I tillegg kunne ikke");
  });

  it("kill switch ulesbar + eieren har erklært ADMIN_CONTROL_CENTER → EV-22/EV-23 sier IKKE «klar for en navngitt D-beslutning»", async () => {
    const w = await healthyWorld();
    const env = { JARVIS_EV_VERIFIED_GATES: "ADMIN_CONTROL_CENTER" };
    const healthyText = (await dormantSection(ctxOf(w.deps({ env })))).findings.join("\n");
    expect(healthyText).toContain("EV-22 Evolution-flate i kontrollsentrene: alle tekniske krav er oppfylt - klar for en navngitt D-beslutning");
    expect(healthyText).toContain("EV-23 Eier-godkjenning av evolusjon i kontrollsentrene: alle tekniske krav er oppfylt - klar for en navngitt D-beslutning");
    const s = await dormantSection(ctxOf(w.deps({ env, killSwitchActive: rejects })));
    const text = s.findings.join("\n");
    expect(text).not.toContain("klar for en navngitt D-beslutning");
    expect(text).toMatch(/EV-22 [^\n]*mangler \d+ \(ukjent, kunne ikke måles: change freeze\)/);
    expect(text).toContain("Innsignal som ikke kunne måles");
    expect(s.summary_no).toContain("0 har alle tekniske krav oppfylt");
    // To ukjente innsignal: change freeze (rammer alle deler) og jobb-runneren (rammer bare EV-6: env uten JARVIS_JOB_* - API-et ser ikke worker-oppsettet, L6).
    expect(s.summary_no).toContain("2 innsignal kunne ikke måles");
    expect(text).toMatch(/EV-6 [^\n]*\(ukjent, kunne ikke måles: change freeze, jobb-runneren/);
    expect(text).not.toMatch(/EV-22 [^\n]*jobb-runneren/);
  });

  it("ukjent er noe annet enn kjent-dårlig i de sovende delene: en usignert konstitusjon er «mangler» uten «ukjent»", async () => {
    const w = await healthyWorld();
    const s = await dormantSection(ctxOf(w.deps({ ev0Status: () => ({ constitution: { status: "not_verified", code: "constitution_unsigned" }, ledger: { status: "ok", count: 1, head_hash: "h" } }) })));
    expect(s.findings.join("\n")).not.toContain("ukjent, kunne ikke måles");
    expect(s.findings.join("\n")).not.toContain("Innsignal som ikke kunne måles");
  });

  it("tom leverandørliste i meshen er UKJENT (ikke «bare én leverandør i kjeden»), og ukjent connector-register er ukjent i de sovende delene (ikke «0 beviste connectorer»)", async () => {
    const w = await healthyWorld();
    const noProviders = await modelRouteSection(ctxOf(w.deps({ mesh: () => mesh({}, []) })));
    expect(noProviders.status).toBe("UNKNOWN");
    expect(noProviders.summary_no).toContain("ingen leverandører");
    expect(noProviders.findings.join("\n")).not.toContain("bare én leverandør");
    const facts = await readinessFacts(ctxOf(w.deps({ connectors: rejects })));
    expect(facts.proven_connectors).toBeNull();
    const ev18 = evaluateAllReadiness(facts).find((v) => v.ev === "EV-18")!;
    expect(ev18.unknown_signals).toEqual(["proven_connectors"]);
    const text = (await dormantSection(ctxOf(w.deps({ connectors: rejects })))).findings.join("\n");
    expect(text).toMatch(/EV-18 [^\n]*\(ukjent, kunne ikke måles: beviste connectorer\)/);
    // Et register som svarer med færre enn tre beviste connectorer er derimot KJENT utilstrekkelig - ikke ukjent.
    const known = await readinessFacts(ctxOf(w.deps({ connectors: async () => [connector("github", true, healthy(), "live")] })));
    expect(known.proven_connectors).toBe(1);
    expect(evaluateAllReadiness(known).find((v) => v.ev === "EV-18")!.unknown_signals).toEqual([]);
  });

  it("EV-9: connectors og scheduler som ikke kan leses sies eksplisitt (UNKNOWN), og blir aldri «ingen feilsignaler»", async () => {
    const w = await healthyWorld();
    const noConnectors = await healSection(ctxOf(w.deps({ connectors: rejects })));
    expect(noConnectors.status).toBe("UNKNOWN");
    expect(noConnectors.findings.join("\n")).toContain("Kunne ikke leses: tilkoblingsregisteret");
    expect(noConnectors.findings.join("\n")).not.toContain("Ingen feilsignaler å vurdere");
    const noScheduler = await healSection(ctxOf(w.deps({ pool: { query: rejects, connect: rejects } as never })));
    expect(noScheduler.status).toBe("UNKNOWN");
    expect(noScheduler.findings.join("\n")).toContain("planlagte jobber");
    const noJobsSeen = await healSection(ctxOf(w.deps({ pool: fakePool(HEALTHY_HANDLERS.filter(([re]) => !re.test("DISTINCT ON (job_name)"))) })));
    expect(noJobsSeen.status).toBe("UNKNOWN");
    const both = await healSection(ctxOf(w.deps({ connectors: rejects, pool: { query: rejects, connect: rejects } as never })));
    expect(both.summary_no).toContain("tilkoblingsregisteret, planlagte jobber");
  });

  it("EV-9: ukjent kill switch + et ekte feilsignal → «krever eier (kill_switch_unknown)», aldri «tillatt automatisk»; kjent PÅ gir kill_switch_active", async () => {
    const w = await healthyWorld();
    const failing = { connectors: async () => [connector("github", true, { state: "unauthorized", at: "2026-10-15T11:00:00.000Z" })] };
    const unknown = await healSection(ctxOf(w.deps({ ...failing, killSwitchActive: rejects })));
    expect(unknown.status).toBe("ATTENTION");
    expect(unknown.findings.join("\n")).toContain("Tilkobling github svikter → gjenoppkobling er H1: krever eier (kill_switch_unknown)");
    expect(unknown.findings.join("\n")).not.toContain("tillatt automatisk");
    const on = await healSection(ctxOf(w.deps({ ...failing, killSwitchActive: async () => true })));
    expect(on.findings.join("\n")).toContain("krever eier (kill_switch_active)");
    const off = await healSection(ctxOf(w.deps(failing)));
    expect(off.findings.join("\n")).toContain("Tilkobling github svikter → gjenoppkobling er H1: tillatt automatisk");
  });

  it("tomt pool-svar er ikke «0»: EV-5 og EV-16 sier at tallet mangler, og EV-10 sier eksplisitt «0 aktive minner» (et gyldig svar)", async () => {
    const w = await healthyWorld();
    const empty = w.deps({ pool: fakePool([]) });
    const report = await buildEvolutionReport(empty);
    expect(byEv(report.sections, "EV-5").summary_no).toContain("gyldig antall");
    expect(byEv(report.sections, "EV-16").summary_no).toContain("mangler");
    expect(byEv(report.sections, "EV-10").findings.join("\n")).toContain("Vurdert: 0 aktive minner");
  });

  it("databasetall som ikke er tall ('abc', NaN, null) gir UNKNOWN i stedet for 0/NaN", async () => {
    const w = await healthyWorld();
    for (const bad of [{ n: "abc" }, { n: null }, { n: Number.NaN }, {}, { n: "1.5" }]) {
      const pool = fakePool([[/::bigint/, () => [bad]], [/DISTINCT ON \(change_id\)/, () => [bad]], [/FROM incidents/, () => [bad]], ...HEALTHY_HANDLERS]);
      const report = await buildEvolutionReport(w.deps({ pool }));
      for (const ev of ["EV-5", "EV-16"]) expect(byEv(report.sections, ev).status, `${ev} ${JSON.stringify(bad)}`).toBe("UNKNOWN");
      expect(byEv(report.sections, "EV-0/EV-8").status, JSON.stringify(bad)).toBe("UNKNOWN");
    }
  });
});

/**
 * L2 (gjennomgang av PR #313): `safely` la `err.message.slice(0, 100)` i `summary_no`. Rapporten går til modellen (kan være sky), og meldingene fra pg/Node bærer vert, port, databasenavn, rolle og passordfeil.
 * Nå vises kun feilklassen (navn / Node-kode / SQLSTATE-klasse).
 */
describe("L2: rapporten lekker ikke rå feilmelding", () => {
  it("errorClass: kun navn, Node-systemkode og SQLSTATE-klasse - aldri meldingstekst, vert, adresse eller en kode med fritekst", () => {
    expect(errorClass(new TypeError("Cannot read properties of null (reading 'x')"))).toBe("TypeError");
    expect(errorClass(secretError())).toBe("Error/ECONNREFUSED");
    expect(errorClass(Object.assign(new Error('password authentication failed for user "jarvis_ro"'), { name: "error", code: "28P01" }))).toBe("error/sqlstate_28");
    expect(errorClass(Object.assign(new Error("x"), { code: "ERR_INVALID_ARG_TYPE" }))).toBe("Error/ERR_INVALID_ARG_TYPE");
    // Navn og koder som ikke ser ut som korte identifikatorer slipper aldri gjennom.
    expect(errorClass(Object.assign(new Error("x"), { name: "ECONNREFUSED 10.0.0.5:5432" }))).toBe("Error");
    expect(errorClass(Object.assign(new Error("x"), { code: "password for hunter2" }))).toBe("Error");
    expect(errorClass(Object.assign(new Error("x"), { code: "connect to 10.0.0.5" }))).toBe("Error");
    expect(errorClass(Object.assign(new Error("x"), { code: 42 }))).toBe("Error");
    expect(errorClass(Object.assign(new Error("x"), { name: "N".repeat(41) }))).toBe("Error");
    for (const odd of [null, undefined, "streng med 10.0.0.5", 42, {}, []]) expect(errorClass(odd), String(odd)).toBe("Error");
    for (const fragment of SECRET_FRAGMENTS) expect(errorClass(secretError())).not.toContain(fragment);
  });

  it("reviewerens eksempler: avviste pool-spørringer gir UNKNOWN med feilklasse, og hverken vert, port, rolle eller passordtekst er i rapport-JSON", async () => {
    const w = await healthyWorld();
    const messages = [
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432 (db=jarvis, user=jarvis_app)"), { code: "ECONNREFUSED" }),
      Object.assign(new Error('password authentication failed for user "jarvis_ro"'), { name: "error", code: "28P01" }),
      new Error(SECRET_TEXT)
    ];
    for (const err of messages) {
      const reject = async (): Promise<never> => { throw err; };
      const report = await buildEvolutionReport(w.deps({ pool: { query: reject, connect: reject } as never }));
      const proposals = byEv(report.sections, "EV-5");
      expect(proposals.status).toBe("UNKNOWN");
      expect(proposals.summary_no).toMatch(/^Ikke målt: målingen feilet \((Error|error)(\/ECONNREFUSED|\/sqlstate_28)?\)$/);
      const json = JSON.stringify(report);
      for (const fragment of [...SECRET_FRAGMENTS, "db=jarvis", "jarvis_ro", "authentication failed", "connect ECONNREFUSED"]) expect(json, fragment).not.toContain(fragment);
    }
  });

  it("feil fra ekstra seksjoner, verktøyflate og radar-leser lekker heller ikke", async () => {
    const w = await healthyWorld();
    const report = await buildEvolutionReport(w.deps({
      extraSections: [async () => { throw secretError(); }],
      toolSurface: () => { throw secretError(); },
      radar: { ...w.radar, last: () => { throw secretError(); } }
    }));
    const json = JSON.stringify(report);
    for (const fragment of SECRET_FRAGMENTS) expect(json, fragment).not.toContain(fragment);
    expect(byEv(report.sections, "EV-3").summary_no).toBe("Ikke målt: målingen feilet (Error/ECONNREFUSED)");
    expect(report.sections.at(-1)!.summary_no).toBe("Ikke målt: målingen feilet (Error/ECONNREFUSED)");
  });
});

/**
 * L6 (gjennomgang av PR #313): `JARVIS_JOB_*` går kun til worker-containeren. I API-et er «jobb-runner konfigurert» derfor UKJENT (ikke «nei») med mindre variablene tilfeldigvis er synlige (lokal kjøring),
 * og eieren erklærer det med `JOB_RUNNER_CONFIGURED` etter å ha verifisert det på verten.
 */
describe("L6: jobb-runner-faktumet når API-et ikke ser worker-oppsettet", () => {
  const RUNNER = { JARVIS_JOB_RUNNER: "container", JARVIS_JOB_IMAGE: "jarvis-job@sha256:abc", JARVIS_JOB_NETWORK: "jarvis-jobs", JARVIS_JOB_EGRESS_PROXY: "http://egress:3128" };
  const factFor = async (env: Record<string, string>): Promise<boolean | null> => {
    const w = await healthyWorld();
    return (await readinessFacts(ctxOf(w.deps({ env })))).job_runner_configured;
  };

  it("ikke synlig (normalt i produksjon) → ukjent; delvis synlig → ukjent; synlig og komplett → ja; synlig men ikke container/ufullstendig → nei", async () => {
    expect(await factFor({})).toBeNull();
    expect(await factFor({ JARVIS_JOB_RUNNER: "container", JARVIS_JOB_IMAGE: "x" })).toBeNull();
    expect(await factFor(RUNNER)).toBe(true);
    expect(await factFor({ ...RUNNER, JARVIS_JOB_RUNNER: "" })).toBe(false);
    expect(await factFor({ ...RUNNER, JARVIS_JOB_RUNNER: "process" })).toBe(false);
    expect(await factFor({ ...RUNNER, JARVIS_JOB_EGRESS_PROXY: "  " })).toBe(false);
  });

  it("EV-6 uten synlig oppsett: «mangler … (ukjent: jobb-runneren)» - og kun eierens erklæring JOB_RUNNER_CONFIGURED (i tillegg til D-32) gjør den klar", async () => {
    const w = await healthyWorld();
    const lineOf = async (gates: string): Promise<string> => (await dormantSection(ctxOf(w.deps({ env: { JARVIS_EV_VERIFIED_GATES: gates } })))).findings.find((f) => f.startsWith("EV-6 "))!;
    expect(await lineOf("D-32")).toMatch(/mangler 1 \(ukjent, kunne ikke måles: jobb-runneren/);
    expect(await lineOf("D-32,JOB_RUNNER_CONFIGURED")).toContain("alle tekniske krav er oppfylt - klar for en navngitt D-beslutning");
    expect(await lineOf("JOB_RUNNER_CONFIGURED")).toMatch(/mangler 1 - Worker-isolasjon er verifisert/);
    // Synlig og komplett: kravet er målt oppfylt uten erklæring.
    const measured = await dormantSection(ctxOf(w.deps({ env: { JARVIS_EV_VERIFIED_GATES: "D-32", ...RUNNER } })));
    expect(measured.findings.find((f) => f.startsWith("EV-6 "))).toContain("klar for en navngitt D-beslutning");
  });
});
