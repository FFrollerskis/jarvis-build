import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { EVOLUTION_DECISION_AUDIT_TYPE, type ControlAction, type ControlCenterReport, type ControlItem, type ControlRiskClass, type ControlSection, type EvolutionReport, type EvolutionSection } from "@jarvis/executive";
import { evaluateAllReadiness, type ReadinessFacts } from "@jarvis/self-modification";
import type { Ev0BootStatus } from "../src/ev0-boot.ts";
import { createEvolutionCenter, type EvolutionCenterDeps } from "../src/control-center/evolution.ts";
import { CONTROL_CENTER_FLAGS, CONTROL_FEATURE_FLAGS, createControlCenterRegistry, registerControlCenters } from "../src/control-center/register.ts";
import { ScriptedPool, type ScriptedRule } from "./support/scripted-pool.ts";

/**
 * WP-B3 (D-475, EV-23) - «Registrer avgjørelse»-knappene og visningen av eierens avgjørelse i Evolusjon-senteret (ENHETSTESTER uten database; ekte SQL/RLS bevises i wpb3-evolution-approval-db.test.ts):
 *  1. uten `approval` (flagget AV) er senteret NØYAKTIG som EV-22: ingen knapper, ingen lesing av revisjonssporet, EV-23 står som DEFERRED;
 *  2. med `approval` og et registrert verktøy: tre knapper per åpne forslag (to for E3 - den kan aldri godkjennes), kroppen er den eksisterende ruten + det strenge skjemaet, klasse og step-up kommer fra gatewayen/step-up-reglene;
 *  3. verktøyet ikke registrert (`risk_class()` ukjent/kaster) = ingen knapper og ingen lesing - en knapp skal aldri peke på noe ruten avviser;
 *  4. den GJELDENDE avgjørelsen vises (kun for NØYAKTIG denne versjonen) og knappen for den skjules; radens status er uendret (en avgjørelse har ingen virkning); ukjent verdi i revisjonsraden teller ikke;
 *  5. kilden som ikke kan leses = «ikke målt» (aldri «ingen avgjørelse»), uten feiltekst i rapporten;
 *  6. ubetrodde/uentydige id-er og ugyldige versjoner får ingen knapp;
 *  7. produksjonsfabrikken (`registerControlCenters`) kobler det kun med eget flagg, og slår risikoklassen opp LATT.
 */
const authority = { owner_person_id: "person-owner", owner_tenants: ["tenant-owner"] };
const owner: IdentityContext = { person_id: "person-owner", tenant_id: "tenant-owner", memory_space_id: "personal", session_id: "s", device_id: "d", channel: "web", auth_strength: "signed" };
const NOW = new Date("2026-11-15T10:00:00.000Z");
const FACTS: ReadinessFacts = { constitution_verified: true, ledger_ok: true, change_freeze_off: true, proven_connectors: 0, job_runner_configured: false, declared_gates: new Set<string>() };
const BOOT: Ev0BootStatus = { constitution: { status: "verified", version: 1, digest: "a".repeat(64) }, ledger: { status: "ok", count: 3, head_hash: "b".repeat(64) } };
const HEX = (c: string): string => c.repeat(64);

const sections: EvolutionSection[] = ["EV-0/EV-8", "EV-5"].map((ev) => ({ ev, title_no: ev, mode: "observe", status: "OK", summary_no: `Sammendrag ${ev}.`, findings: [], source: "k", observed_at: NOW.toISOString() }));
const evolutionReport = async (): Promise<EvolutionReport> => ({ as_of: NOW.toISOString(), acts: false, sections, summary_no: "x" });

type Pending = { change_id: string; change_class: string; digest: string; recorded_at: string; path_count: number };
const proposal = (change_id: string, change_class: string, digest: string, recorded_at = "2026-11-10T08:00:00.000Z"): Pending => ({ change_id, change_class, digest, recorded_at, path_count: 2 });
type DecisionRow = { change_id: string; digest: string; decision: string; decided_at: string };

function rulesFor(pending: Pending[], decisions: DecisionRow[] | Error): ScriptedRule[] {
  return [
    { match: /FROM audit_events/, rows: decisions },
    { match: /date_trunc\('month', now\(\)\)/, rows: [{ spent: 1_000 }] },
    { match: /GROUP BY t\.change_class/, rows: pending.length > 0 ? [{ change_class: "E2", n: pending.length }] : [] },
    { match: /DISTINCT ON \(change_id\)/, rows: pending },
    { match: /GROUP BY decision/, rows: [] }
  ];
}

type Approval = NonNullable<EvolutionCenterDeps["approval"]>;
const approvalOf = (risk: () => ControlRiskClass | undefined = () => "C", requires_step_up = true): Approval => ({ risk_class: risk, requires_step_up });

async function reportOf(pending: Pending[], decisions: DecisionRow[] | Error, approval: Approval | undefined): Promise<{ report: ControlCenterReport; pool: ScriptedPool }> {
  const pool = new ScriptedPool(rulesFor(pending, decisions));
  const deps: EvolutionCenterDeps = {
    pool: pool.asPool(), env: {}, evolutionReport, readiness: async () => evaluateAllReadiness(FACTS), ev0Status: () => BOOT, reportTenantId: "tenant-owner",
    ...(approval !== undefined ? { approval } : {})
  };
  const registry = createControlCenterRegistry({ authority, now: () => NOW });
  registry.register(createEvolutionCenter(deps));
  return { report: (await registry.report("evolution", owner)) as ControlCenterReport, pool };
}
const sectionOf = (r: ControlCenterReport, id: string): ControlSection => {
  const s = r.sections.find((x) => x.id === id);
  if (!s) throw new Error(`seksjon mangler: ${id}`);
  return s;
};
const itemOf = (s: ControlSection, id: string): ControlItem => {
  const i = s.items.find((x) => x.id === id);
  if (!i) throw new Error(`rad mangler: ${id}`);
  return i;
};
const decisionOf = (a: ControlAction): string | undefined => (a.body["parameters"] as { decision?: string } | undefined)?.decision;
const auditQueries = (pool: ScriptedPool) => pool.queries.filter((q) => /FROM audit_events/.test(q.sql));

describe("1. uten `approval` (flagget AV) er senteret som EV-22: ingen knapper, ingen lesing av revisjonssporet, EV-23 DEFERRED", () => {
  it("åpne forslag gir ingen handlinger og ingen spørring mot revisjonssporet; radene har ingen avgjørelsesfakta", async () => {
    const { report, pool } = await reportOf([proposal("p1", "E1", HEX("a")), proposal("p2", "E3", HEX("b"))], [], undefined);
    expect(report.actions).toEqual([]);
    expect(auditQueries(pool)).toEqual([]);
    const row = itemOf(sectionOf(report, "ledger"), "proposal:p1");
    expect(row.facts).not.toHaveProperty("owner_decision");
    expect(row.detail_no).not.toContain("avgjørelse registrert");
    expect(itemOf(sectionOf(report, "ledger"), "proposals").detail_no).toContain("Å se innholdet og avgjøre skjer utenfor kontrollsenteret");
    expect(sectionOf(report, "ledger").source).not.toContain("audit_events");
  });

  it("EV-23 står som DEFERRED i de sovende delene: «ingen knapp godkjenner, avviser eller utfører noe»", async () => {
    const { report } = await reportOf([], [], undefined);
    const ev23 = sectionOf(report, "dormant").items.find((i) => i.id.includes("EV-23") || i.label.includes("EV-23"));
    expect(ev23?.detail_no).toContain("Godkjenning i kontrollsenteret er DEFERRED");
    expect(ev23?.facts?.["activation_decision"]).toBe(false);
  });
});

describe("2. med `approval` og registrert verktøy: knapper per åpent forslag", () => {
  const pending = [proposal("p1", "E1", HEX("a")), proposal("p2", "E3", HEX("b")), proposal("p3", "E2", HEX("c"), "2026-11-12T08:00:00.000Z")];

  it("E1/E2: godkjenn, avvis, utsett; E3: kun avvis og utsett (registeret forbyr godkjent E3) - alle peker på den EKSISTERENDE ruten med det strenge skjemaet", async () => {
    const { report } = await reportOf(pending, [], approvalOf());
    const byItem = (id: string) => report.actions.filter((a) => a.item_id === `proposal:${id}`).map((a) => decisionOf(a));
    expect(byItem("p1")).toEqual(["approve", "reject", "defer"]);
    expect(byItem("p3")).toEqual(["approve", "reject", "defer"]);
    expect(byItem("p2")).toEqual(["reject", "defer"]);
    expect(report.actions).toHaveLength(8);
    for (const a of report.actions) {
      expect(a.endpoint).toBe("/executive/mutate");
      expect(Object.keys(a.body).sort()).toEqual(["action", "parameters"]);
      expect(a.body["action"]).toBe("record_evolution_decision");
      expect(Object.keys(a.body["parameters"] as object).sort()).toEqual(["change_id", "decision", "proposal_digest"]);
      expect(a.section_id).toBe("ledger");
      expect(a.reversible).toBe(true);
      expect(a.description_no).toContain("KUN en registrering");
      expect(a.description_no).toContain("ingenting utføres");
      expect(a.description_no).toContain("D-397");
      expect(a.rollback_no).toContain("Registrer en ny avgjørelse");
    }
    expect(new Set(report.actions.map((a) => a.id)).size).toBe(report.actions.length);
  });

  it("kroppen bærer HELE versjons-digesten (64 hex) til forslaget - aldri de 12 tegnene som vises - og id-en uendret", async () => {
    const { report } = await reportOf(pending, [], approvalOf());
    const p1 = report.actions.find((a) => a.item_id === "proposal:p1");
    expect(p1?.body["parameters"]).toMatchObject({ change_id: "p1", proposal_digest: HEX("a") });
    expect(itemOf(sectionOf(report, "ledger"), "proposal:p1").facts?.["digest"]).toBe("a".repeat(12));
  });

  it("klassen og step-up kommer fra injiseringen (gatewayen/step-up-reglene), aldri fra senteret selv", async () => {
    const c = (await reportOf(pending, [], approvalOf(() => "C", true))).report.actions;
    expect(c.every((a) => a.risk_class === "C" && a.requires_step_up)).toBe(true);
    const d = (await reportOf(pending, [], approvalOf(() => "D", false))).report.actions;
    expect(d.every((a) => a.risk_class === "D" && !a.requires_step_up)).toBe(true);
  });

  it("seksjonen og forslagsoppsummeringen sier at en registrert avgjørelse ikke har virkning; kilden nevner revisjonssporet", async () => {
    const { report } = await reportOf(pending, [], approvalOf());
    const ledger = sectionOf(report, "ledger");
    expect(ledger.summary_no).toContain("har ingen virkning");
    expect(ledger.source).toContain("audit_events");
    expect(itemOf(ledger, "proposals").detail_no).toContain("kun REGISTRERE din avgjørelse (ingen virkning)");
  });

  it("EV-23 i de sovende delene sier at registrering er mulig men at en godkjenning som utfører noe er DEFERRED - og er fortsatt IKKE aktivert", async () => {
    const { report } = await reportOf(pending, [], approvalOf());
    const ev23 = sectionOf(report, "dormant").items.find((i) => i.label.includes("EV-23") || i.id.includes("EV-23"));
    expect(ev23?.detail_no).toContain("Ikke aktivert - ingen kodevei aktiverer dette.");
    expect(ev23?.detail_no).toContain("REGISTRERE din avgjørelse");
    expect(ev23?.detail_no).toContain("DEFERRED");
    expect(ev23?.detail_no?.length ?? 0).toBeLessThanOrEqual(400);
    expect(ev23?.facts?.["activation_decision"]).toBe(false);
  });

  it("revisjonssporet leses ÉN gang, tenant-skopet (identitetens tenant), parametrisert, kun SELECT, avgrenset av det eldste forslagets tidspunkt, med kun trygge id-er", async () => {
    const { pool } = await reportOf(pending, [], approvalOf());
    const q = auditQueries(pool);
    expect(q).toHaveLength(1);
    expect(q[0]?.tenant).toBe("tenant-owner");
    expect(q[0]?.sql).toMatch(/^\s*SELECT /);
    expect(q[0]?.sql).toContain("tenant_id = $1");
    expect(q[0]?.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(q[0]?.params).toEqual(["tenant-owner", EVOLUTION_DECISION_AUDIT_TYPE, "2026-11-10T08:00:00.000Z", ["p1", "p2", "p3"]]);
  });
});

describe("3. verktøyet ikke registrert = ingen knapper og ingen lesing", () => {
  const pending = [proposal("p1", "E1", HEX("a"))];
  it("`risk_class()` ukjent (undefined): ingen handlinger, ingen spørring, EV-23 DEFERRED som uten flagg", async () => {
    const { report, pool } = await reportOf(pending, [], approvalOf(() => undefined));
    expect(report.actions).toEqual([]);
    expect(auditQueries(pool)).toEqual([]);
    expect(itemOf(sectionOf(report, "ledger"), "proposal:p1").facts).not.toHaveProperty("owner_decision");
    expect(sectionOf(report, "dormant").items.some((i) => i.detail_no?.includes("Godkjenning i kontrollsenteret er DEFERRED"))).toBe(true);
  });

  it("`risk_class()` som kaster behandles som ikke registrert (fail-closed), uten feiltekst i rapporten", async () => {
    const { report, pool } = await reportOf(pending, [], approvalOf(() => { throw new Error("hemmelig-intern-feil-vert.example"); }));
    expect(report.actions).toEqual([]);
    expect(auditQueries(pool)).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("hemmelig-intern-feil");
  });

  it("ingen åpne forslag: ingen knapper og ingen lesing av revisjonssporet (kilden trengs ikke)", async () => {
    const { report, pool } = await reportOf([], [], approvalOf());
    expect(report.actions).toEqual([]);
    expect(auditQueries(pool)).toEqual([]);
  });
});

describe("4. eierens registrerte avgjørelse vises for NØYAKTIG denne versjonen, og knappen for den skjules", () => {
  const pending = [proposal("p1", "E1", HEX("a")), proposal("p2", "E2", HEX("b"))];
  const decided = (id: string, digest: string, decision: string, at = "2026-11-14T12:30:00.000Z"): DecisionRow => ({ change_id: id, digest, decision, decided_at: at });

  it("«godkjent»: faktaene og teksten sier det, og den sier at forslaget fortsatt er åpent i endringsregisteret (uten virkning); statusen er uendret WARN; knappen for godkjenn er borte", async () => {
    const { report } = await reportOf(pending, [decided("p1", HEX("a"), "approve")], approvalOf());
    const row = itemOf(sectionOf(report, "ledger"), "proposal:p1");
    expect(row.facts).toMatchObject({ owner_decision: "approve", owner_decided_at: "2026-11-14T12:30:00.000Z" });
    expect(row.detail_no).toContain("Din registrerte avgjørelse: godkjent (2026-11-14)");
    expect(row.detail_no).toContain("uten virkning");
    expect(row.detail_no).toContain("fortsatt som åpent i endringsregisteret");
    expect(row.status).toBe("WARN");
    expect(report.actions.filter((a) => a.item_id === "proposal:p1").map((a) => decisionOf(a))).toEqual(["reject", "defer"]);
    // det andre forslaget har ingen avgjørelse: alle tre knapper, og teksten sier det
    const other = itemOf(sectionOf(report, "ledger"), "proposal:p2");
    expect(other.facts).toMatchObject({ owner_decision: "none", owner_decided_at: null });
    expect(other.detail_no).toContain("Ingen avgjørelse registrert fra deg.");
    expect(report.actions.filter((a) => a.item_id === "proposal:p2")).toHaveLength(3);
  });

  it("«avvist» og «utsatt» vises med sine ord og skjuler hver sin knapp", async () => {
    const rejected = (await reportOf(pending, [decided("p1", HEX("a"), "reject")], approvalOf())).report;
    expect(itemOf(sectionOf(rejected, "ledger"), "proposal:p1").detail_no).toContain("avvist");
    expect(rejected.actions.filter((a) => a.item_id === "proposal:p1").map((a) => decisionOf(a))).toEqual(["approve", "defer"]);
    const deferred = (await reportOf(pending, [decided("p1", HEX("a"), "defer")], approvalOf())).report;
    expect(itemOf(sectionOf(deferred, "ledger"), "proposal:p1").detail_no).toContain("utsatt");
    expect(deferred.actions.filter((a) => a.item_id === "proposal:p1").map((a) => decisionOf(a))).toEqual(["approve", "reject"]);
  });

  it("en avgjørelse om en ANNEN versjon (annen digest) av samme forslag teller ikke: forslaget er endret siden du så det", async () => {
    const { report } = await reportOf(pending, [decided("p1", HEX("f"), "approve")], approvalOf());
    expect(itemOf(sectionOf(report, "ledger"), "proposal:p1").facts?.["owner_decision"]).toBe("none");
    expect(report.actions.filter((a) => a.item_id === "proposal:p1")).toHaveLength(3);
  });

  it("en ukjent verdi i revisjonsraden (ikke godkjenn/avvis/utsett) tas IKKE med - aldri tolket som en avgjørelse", async () => {
    const { report } = await reportOf(pending, [decided("p1", HEX("a"), "grant_all"), { change_id: "p2", digest: HEX("b"), decision: "", decided_at: "x" }], approvalOf());
    expect(itemOf(sectionOf(report, "ledger"), "proposal:p1").facts?.["owner_decision"]).toBe("none");
    expect(itemOf(sectionOf(report, "ledger"), "proposal:p2").facts?.["owner_decision"]).toBe("none");
  });

  it("en avgjørelse gjør aldri senteret «i orden»: forslagsraden er WARN og forslagslinjen teller fortsatt forslaget som ventende (registeret er sannheten)", async () => {
    const { report } = await reportOf(pending, [decided("p1", HEX("a"), "approve"), decided("p2", HEX("b"), "reject")], approvalOf());
    const ledger = sectionOf(report, "ledger");
    expect(itemOf(ledger, "proposals")).toMatchObject({ status: "WARN", facts: { waiting: 2 } });
    expect(itemOf(ledger, "proposal:p1").status).toBe("WARN");
    expect(itemOf(ledger, "proposal:p2").status).toBe("WARN");
  });
});

describe("5. kilden som ikke kan leses er «ikke målt» - aldri «ingen avgjørelse»", () => {
  it("feil ved lesing av revisjonssporet: raden sier ikke målt, faktaene er null, knappene finnes fortsatt (skriveren er idempotent), og feilteksten når aldri rapporten", async () => {
    const { report } = await reportOf([proposal("p1", "E1", HEX("a"))], new Error("connect ECONNREFUSED hemmelig-db-vert.example:5432 password=hunter2"), approvalOf());
    const row = itemOf(sectionOf(report, "ledger"), "proposal:p1");
    expect(row.detail_no).toContain("Din avgjørelse kunne ikke leses (ikke målt).");
    expect(row.facts).toMatchObject({ owner_decision: null, owner_decided_at: null });
    expect(row.status).toBe("WARN");
    expect(report.actions).toHaveLength(3);
    const out = JSON.stringify(report);
    for (const leak of ["hemmelig-db-vert", "ECONNREFUSED", "hunter2"]) expect(out).not.toContain(leak);
    expect(sectionOf(report, "ledger").measured).toBe(true);
  });
});

describe("6. ubetrodde/uentydige id-er og ugyldige versjoner får ingen knapp", () => {
  it("en id med mellomrom, for lang id, hemmelighetslignende id og en id som kolliderer etter rensing: ingen knapper (raden vises med reserveverdi) og de blir ikke slått opp i revisjonssporet", async () => {
    const secretLike = ["sk", "ant", "Kanarifugl", "0123456789"].join("-");
    const pending = [
      proposal("har mellomrom", "E1", HEX("1")), proposal("x".repeat(80), "E1", HEX("2")), proposal(secretLike, "E1", HEX("3")), proposal("trygg-id", "E1", HEX("4"))
    ];
    const { report, pool } = await reportOf(pending, [], approvalOf());
    expect(report.actions.map((a) => a.item_id)).toEqual(["proposal:trygg-id", "proposal:trygg-id", "proposal:trygg-id"]);
    expect(JSON.stringify(report)).not.toContain(secretLike);
    expect(auditQueries(pool)[0]?.params[3]).toEqual(["trygg-id"]);
  });

  it("to forslag med samme id får bare ÉN rad uten løpenummer-hale-forvirring: raden med hale (`-N`) har ingen knapp", async () => {
    const { report } = await reportOf([proposal("dup", "E1", HEX("1")), proposal("dup", "E1", HEX("2"))], [], approvalOf());
    expect(report.actions.map((a) => a.item_id)).toEqual(["proposal:dup", "proposal:dup", "proposal:dup"]);
    expect(sectionOf(report, "ledger").items.filter((i) => i.id.startsWith("proposal:dup"))).toHaveLength(2);
  });

  it("en versjon som ikke er 64 små hex-tegn får ingen knapp (skriveren ville avvist den)", async () => {
    const pending = [proposal("v1", "E1", "ABC"), proposal("v2", "E1", "A".repeat(64)), proposal("v3", "E1", HEX("d"))];
    const { report } = await reportOf(pending, [], approvalOf());
    expect([...new Set(report.actions.map((a) => a.item_id))]).toEqual(["proposal:v3"]);
  });
});

describe("7. produksjonsfabrikken (`registerControlCenters`) kobler det kun med eget flagg og slår risikoklassen opp lat", () => {
  const owner2 = owner;
  function wiringFor(env: Record<string, string>, gateway: { get(toolId: string, action: string): { capability_class: ControlRiskClass } | undefined } | undefined) {
    const pool = new ScriptedPool(rulesFor([proposal("p1", "E1", HEX("a"))], []));
    const registry = createControlCenterRegistry({ authority, now: () => NOW });
    registerControlCenters(registry, {
      pool: pool.asPool(), env, evolutionReport, evolutionReadiness: async () => evaluateAllReadiness(FACTS), ev0Status: () => BOOT, evolutionTenantId: "tenant-owner",
      ...(gateway !== undefined ? { toolGateway: gateway as never } : {})
    });
    return { registry, pool };
  }
  const ON = { [CONTROL_CENTER_FLAGS.evolution]: "on", [CONTROL_FEATURE_FLAGS.evolutionApproval]: "on" };

  it("flagget for senteret på men IKKE for avgjørelser: ingen knapper, selv med en gateway som har verktøyet", async () => {
    const { registry } = wiringFor({ [CONTROL_CENTER_FLAGS.evolution]: "on" }, { get: () => ({ capability_class: "C" }) });
    expect((await registry.report("evolution", owner2) as ControlCenterReport).actions).toEqual([]);
  });

  it("flagget for avgjørelser på men ikke for senteret: senteret finnes ikke (ingenting å vise knapper i)", () => {
    const { registry } = wiringFor({ [CONTROL_FEATURE_FLAGS.evolutionApproval]: "on" }, { get: () => ({ capability_class: "C" }) });
    expect(registry.has("evolution")).toBe(false);
  });

  it("begge flagg på men uten verktøyregister (ingen gateway i koblingen): ingen knapper (fail-closed)", async () => {
    const { registry } = wiringFor(ON, undefined);
    expect((await registry.report("evolution", owner2) as ControlCenterReport).actions).toEqual([]);
  });

  it("begge flagg på: knappene kommer først når verktøyet FAKTISK er registrert i gatewayen (oppslaget er lat), med gatewayens klasse og step-up fra den ene step-up-mengden", async () => {
    let registered = false;
    const gateway = { get: (tool: string, action: string) => (registered && tool === "executive" && action === "record_evolution_decision" ? { capability_class: "C" as const } : undefined) };
    const { registry } = wiringFor(ON, gateway);
    expect((await registry.report("evolution", owner2) as ControlCenterReport).actions).toEqual([]);
    registered = true;
    const actions = (await registry.report("evolution", owner2) as ControlCenterReport).actions;
    expect(actions).toHaveLength(3);
    expect(actions.every((a) => a.risk_class === "C" && a.requires_step_up === true)).toBe(true);
  });

  it("kun eksakt «on» teller (ikke «true», «1», «ON» eller mellomrom)", async () => {
    for (const value of ["true", "1", "ON", "on ", ""]) {
      const { registry } = wiringFor({ [CONTROL_CENTER_FLAGS.evolution]: "on", [CONTROL_FEATURE_FLAGS.evolutionApproval]: value }, { get: () => ({ capability_class: "C" }) });
      expect((await registry.report("evolution", owner2) as ControlCenterReport).actions, JSON.stringify(value)).toEqual([]);
    }
  });
});
