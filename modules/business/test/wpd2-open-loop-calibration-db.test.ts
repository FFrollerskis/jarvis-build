import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { BusinessService, CONFIDENCE_V1, OpenLoopService, ProductUsageService, churnDetectionKey, type ConfidenceBasis } from "../src/index.ts";

/**
 * WP-D2 (JARVIS-045, migrasjon 091): confidence skrevet fra flere signaler + kalibreringsrapport mot faktiske utfall, mot ekte Postgres som app-rolle (RLS).
 *  A. skjema/utfall, B. confidence fra flere signaler (persistens, forfall, uavhengig bekreftelse, churn-familier), C. heuristikk-tak (ingen SUGGEST uten kalibrering),
 *  D. kalibreringsrapport og tilbakemating (overkonfident senker, treffsikker heuristikk løftes), E. isolasjon og idempotens.
 */
let stop: (() => Promise<void>) | undefined;
let admin: pg.Pool;
let app: pg.Pool;
let loops: OpenLoopService;
let business: BusinessService;
let usage: ProductUsageService;

const A = "tenant-wpd2-cal";
const B = "tenant-wpd2-cal-b";
const OWNER = "person-wpd2-cal-owner";
const SP = "business" as const;
const DAY = 86_400_000;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-wpd2-cal-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stop = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  admin = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  admin.on("error", () => undefined);
  await runMigrations(admin);
  await admin.query("CREATE ROLE jarvis_wpd2_cal LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await admin.query("GRANT jarvis_app TO jarvis_wpd2_cal");
  await admin.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${A}', 'Cal', 'business'), ('${B}', 'Cal B', 'business');
    INSERT INTO people (person_id, display_name) VALUES ('${OWNER}', 'Eier');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('${OWNER}', '${A}'), ('${OWNER}', '${B}');
  `);
  app = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_wpd2_cal", password: "pw2" });
  loops = new OpenLoopService(app);
  business = new BusinessService(app);
  usage = new ProductUsageService(app);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await stop?.();
}, 120_000);

type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params))["n"]);
const loopRow = async (id: string) => one("SELECT status, confidence::float8 AS confidence, confidence_basis, resolution_outcome, resolution_reason FROM business_open_loops WHERE open_loop_id = $1", [id]);
/** Churn-loopens detection_key inneholder en digest av kontoreferansen (PR #326 F2) - aldri selve referansen. */
const churnLoop = (tenant: string, accountRef: string) => openLoop(tenant, "customer_churn_risk", churnDetectionKey(accountRef).split(":")[1]);
const openLoop = async (tenant: string, type: string, key?: string) =>
  (await loops.listOpenLoops(tenant, SP, "open")).find((l) => l.loop_type === type && (key === undefined || l.detection_key.endsWith(key)));
const basis = (r: Row): ConfidenceBasis => r["confidence_basis"] as ConfidenceBasis;

let seq = 0;
/** Lukket loop med kjent utfall og forutsagt confidence (det kalibreringen leser) – direkte i databasen. */
async function seedResolved(tenant: string, type: string, outcome: "acted" | "dismissed" | "condition_cleared" | null, confidence: number | null, n = 1, openedDaysAgo = 10): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    await admin.query(
      `INSERT INTO business_open_loops (open_loop_id, tenant_id, loop_type, detection_key, reason, status, resolved_at, resolution_reason, resolution_outcome, confidence, opened_at)
       VALUES ($1, $2, $3, $4, 'seed', 'resolved', now() - interval '1 day', $5, $6, $7, now() - make_interval(days => $8))`,
      [`ol-cal-${seq}`, tenant, type, `seed:${type}:${seq}`, outcome === "condition_cleared" ? "condition_no_longer_true" : "Seedet", outcome, confidence, openedDaysAgo]
    );
  }
}

describe("A: skjema og utfall (migrasjon 091)", () => {
  it("resolution_outcome og confidence_basis finnes; CHECK avviser ukjent utfall og utfall på en åpen loop", async () => {
    await expect(admin.query(`INSERT INTO business_open_loops (open_loop_id, tenant_id, loop_type, detection_key, reason, status, resolution_outcome) VALUES ('ol-x1', $1, 'overdue_followup', 'k1', 'r', 'resolved', 'bogus')`, [A])).rejects.toThrow(/resolution_outcome/);
    await expect(admin.query(`INSERT INTO business_open_loops (open_loop_id, tenant_id, loop_type, detection_key, reason, status, resolution_outcome) VALUES ('ol-x2', $1, 'overdue_followup', 'k2', 'r', 'open', 'acted')`, [A])).rejects.toThrow(/outcome_needs_resolved/);
    await expect(admin.query(`INSERT INTO business_open_loops (open_loop_id, tenant_id, loop_type, detection_key, reason, status, resolution_outcome, resolved_at) VALUES ('ol-x3', $1, 'overdue_followup', 'k3', 'r', 'resolved', 'dismissed', now())`, [A])).resolves.toBeDefined();
  });

  it("resolveOpenLoop lagrer utfall (acted/dismissed); uten utfall er loopen umerket; ugyldig utfall avvises FØR noe skrives", async () => {
    const co = await business.createCompany(A, SP, { name: "Utfall AS" });
    const mk = async (title: string) => {
      const fu = await business.createFollowup(A, SP, { title, company_id: co.company_id, due_at: new Date(Date.now() - 5 * DAY).toISOString() });
      await loops.detectOverdueFollowups(A, SP);
      return (await openLoop(A, "overdue_followup", fu.followup_id))!;
    };
    const acted = await mk("Handlet");
    const dismissed = await mk("Avvist");
    const unlabelled = await mk("Umerket");
    expect(await loops.resolveOpenLoop(A, SP, acted.open_loop_id, "Ringte kunden", "acted")).toMatchObject({ status: "resolved", resolution_outcome: "acted" });
    expect(await loops.resolveOpenLoop(A, SP, dismissed.open_loop_id, "Ikke relevant", "dismissed")).toMatchObject({ resolution_outcome: "dismissed" });
    expect(await loops.resolveOpenLoop(A, SP, unlabelled.open_loop_id, "Ferdig")).toMatchObject({ status: "resolved", resolution_outcome: null });
    const bogus = await mk("Ugyldig");
    await expect(loops.resolveOpenLoop(A, SP, bogus.open_loop_id, "x", "won" as never)).rejects.toThrow(/outcome/);
    expect((await loopRow(bogus.open_loop_id))["status"]).toBe("open");
  });

  it("automatisk lukking (vilkåret forsvant) merkes condition_cleared; gjenåpning nullstiller utfallet", async () => {
    const co = await business.createCompany(A, SP, { name: "Auto AS" });
    const fu = await business.createFollowup(A, SP, { title: "Auto", company_id: co.company_id, due_at: new Date(Date.now() - 5 * DAY).toISOString() });
    await loops.detectOverdueFollowups(A, SP);
    const loop = (await openLoop(A, "overdue_followup", fu.followup_id))!;
    await admin.query("UPDATE business_followups SET status = 'completed', completed_at = now() WHERE followup_id = $1", [fu.followup_id]);
    await loops.detectOverdueFollowups(A, SP);
    expect(await loopRow(loop.open_loop_id)).toMatchObject({ status: "resolved", resolution_reason: "condition_no_longer_true", resolution_outcome: "condition_cleared" });
    // vilkåret kommer tilbake: loopen gjenåpnes på SAMME rad og utfallet nullstilles
    await admin.query("UPDATE business_followups SET status = 'open', completed_at = NULL WHERE followup_id = $1", [fu.followup_id]);
    await loops.detectOverdueFollowups(A, SP);
    expect(await loopRow(loop.open_loop_id)).toMatchObject({ status: "open", resolution_outcome: null, resolution_reason: null });
  });
});

describe("B: confidence fra flere signaler (refineConfidence i runSweep)", () => {
  it("uten ekstra signaler er verdien nøyaktig basisverdien (0.9 hardt faktum) og forklaringen er tom", async () => {
    const co = await business.createCompany(A, SP, { name: "Base AS" });
    const fu = await business.createFollowup(A, SP, { title: "Base", company_id: co.company_id, due_at: new Date(Date.now() - 2 * DAY).toISOString() });
    await loops.runSweep(A, SP);
    const loop = (await openLoop(A, "overdue_followup", fu.followup_id))!;
    const row = await loopRow(loop.open_loop_id);
    expect(row["confidence"]).toBe(0.9);
    expect(basis(row)).toMatchObject({ rule_version: "loop_confidence_v1", base: 0.9, adjustments: [], capped: null, calibrated: false });
  });

  it("persistens (7+ dager åpen) og forfallsstørrelse (14+ dager) hever hardt faktum til 0.95, med forklaring per justering - og er idempotent", async () => {
    const co = await business.createCompany(A, SP, { name: "Gammel AS" });
    const fu = await business.createFollowup(A, SP, { title: "Gammel", company_id: co.company_id, due_at: new Date(Date.now() - 20 * DAY).toISOString() });
    await loops.runSweep(A, SP);
    const loop = (await openLoop(A, "overdue_followup", fu.followup_id))!;
    await admin.query("UPDATE business_open_loops SET opened_at = now() - interval '9 days' WHERE open_loop_id = $1", [loop.open_loop_id]);
    await loops.runSweep(A, SP);
    const row = await loopRow(loop.open_loop_id);
    expect(row["confidence"]).toBe(0.95);
    expect(basis(row).adjustments.map((a) => [a.code, a.delta])).toEqual([["persistence", 0.03], ["overdue_magnitude", 0.02]]);
    for (const a of basis(row).adjustments) expect(a.note.length).toBeGreaterThan(10);
    // ny kjøring: ingen drift (basisverdien nullstilles av upsert og beregnes på nytt til samme tall)
    await loops.runSweep(A, SP);
    await loops.runSweep(A, SP);
    expect((await loopRow(loop.open_loop_id))["confidence"]).toBe(0.95);
  });

  it("uavhengig bekreftelse: andre åpne loops hos SAMME kunde fra ANDRE domener hever; samme domene, andre kunder og churn↔support gjør det ikke", async () => {
    const co = await business.createCompany(A, SP, { name: "Bekreftet AS" });
    const other = await business.createCompany(A, SP, { name: "Annen AS" });
    const fu1 = await business.createFollowup(A, SP, { title: "F1", company_id: co.company_id, due_at: new Date(Date.now() - 2 * DAY).toISOString() });
    const fu2 = await business.createFollowup(A, SP, { title: "F2", company_id: co.company_id, due_at: new Date(Date.now() - 2 * DAY).toISOString() });
    const fuOther = await business.createFollowup(A, SP, { title: "Annen", company_id: other.company_id, due_at: new Date(Date.now() - 2 * DAY).toISOString() });
    await loops.runSweep(A, SP);
    // kun samme domene (pipeline) hos samme kunde: ingen korroborasjon
    expect((await loopRow((await openLoop(A, "overdue_followup", fu1.followup_id))!.open_loop_id))["confidence"]).toBe(0.9);
    // en supportsak hos SAMME kunde med eksplisitt forfalt frist = loop fra et annet domene
    await admin.query(
      `INSERT INTO support_tickets (ticket_id, tenant_id, company_id, subject, next_response_due_at) VALUES ('tkt-cal-corr', $1, $2, 'Hjelp', now() - interval '3 hours')`, [A, co.company_id]
    );
    await loops.runSweep(A, SP);
    const f1 = await loopRow((await openLoop(A, "overdue_followup", fu1.followup_id))!.open_loop_id);
    const f2 = await loopRow((await openLoop(A, "overdue_followup", fu2.followup_id))!.open_loop_id);
    const tk = await loopRow((await openLoop(A, "support_ticket_overdue", "tkt-cal-corr"))!.open_loop_id);
    // korroborasjon teller distinkte ANDRE DOMENER (ikke antall loops): pipeline ser «support» (overdue + unassigned = ett domene), support ser «pipeline» (to loops = ett domene)
    expect([f1["confidence"], f2["confidence"], tk["confidence"]]).toEqual([0.93, 0.93, 0.93]);
    expect(basis(f1).adjustments.map((a) => a.code)).toEqual(["corroboration"]);
    // en annen kunde berøres ikke
    expect((await loopRow((await openLoop(A, "overdue_followup", fuOther.followup_id))!.open_loop_id))["confidence"]).toBe(0.9);
  });

  it("churn-loopens egne signalfamilier teller (bruk+support+fakturering), men supportsaker 'bekrefter' ikke churn en gang til", async () => {
    const co = await business.createCompany(A, SP, { name: "Churn-kalibrert AS" });
    const ref = "acct-cal-churn-1";
    const iso = (d: number) => new Date(Date.now() - d * DAY - 60_000).toISOString();
    await usage.importText(A, "jsonl", "cal", [
      { event_id: "cal-evt-000001", account_ref: ref, feature: "chat.send", occurred_at: iso(45) },
      { event_id: "cal-evt-000002", account_ref: ref, feature: "chat.send", occurred_at: iso(40) },
      { event_id: "cal-bill-00001", kind: "billing_status", account_ref: ref, quantity: 3, occurred_at: iso(2) }
    ].map((e) => JSON.stringify(e)).join("\n"), { actor_person_id: OWNER });
    await usage.linkAccount(A, SP, ref, co.company_id, OWNER);
    await admin.query(`INSERT INTO support_tickets (ticket_id, tenant_id, company_id, subject, status, priority) VALUES ('tkt-cal-churn', $1, $2, 'Churn-sak', 'open', 'high')`, [A, co.company_id]);
    await loops.runSweep(A, SP);
    const loop = (await churnLoop(A, ref))!;
    const row = await loopRow(loop.open_loop_id);
    // tre uavhengige familier (bruk, support, fakturering) = +0.06, men en heuristikk er kappet under SUGGEST-terskelen
    expect(basis(row).intrinsic_signals).toBe(2);
    expect(basis(row).adjustments.find((a) => a.code === "independent_signals")?.delta).toBe(0.06);
    expect(row["confidence"]).toBe(CONFIDENCE_V1.heuristic_ceiling);
    expect(basis(row).capped).toBe("heuristic_ceiling");
    expect(basis(row).adjustments.find((a) => a.code === "corroboration")).toBeUndefined();
  });
});

describe("C: heuristikk når ikke SUGGEST uten kalibrering", () => {
  it("en stagnert mulighet med alle signaler er kappet ved 0.74 (< 0.75)", async () => {
    const co = await business.createCompany(A, SP, { name: "Stagnert AS" });
    const opp = await business.createOpportunity(A, SP, { title: "Gammel deal", company_id: co.company_id });
    await admin.query("UPDATE business_opportunities SET updated_at = now() - interval '40 days' WHERE opportunity_id = $1", [opp.opportunity_id]);
    await admin.query(`INSERT INTO support_tickets (ticket_id, tenant_id, company_id, subject, next_response_due_at) VALUES ('tkt-cal-stag', $1, $2, 'Hjelp', now() - interval '1 hour')`, [A, co.company_id]);
    await loops.runSweep(A, SP);
    const loop = (await openLoop(A, "stalled_opportunity", opp.opportunity_id))!;
    await admin.query("UPDATE business_open_loops SET opened_at = now() - interval '10 days' WHERE open_loop_id = $1", [loop.open_loop_id]);
    await loops.runSweep(A, SP);
    const row = await loopRow(loop.open_loop_id);
    expect(row["confidence"]).toBeLessThan(CONFIDENCE_V1.suggest_threshold);
    expect(row["confidence"]).toBeGreaterThan(0.7);
    expect(basis(row).adjustments.map((a) => a.code)).toEqual(expect.arrayContaining(["persistence", "corroboration"]));
  });
});

describe("D: kalibreringsrapport og tilbakemating", () => {
  it("rapporten teller merkede utfall per loop-type og er ærlig om umerkede; kun loops innenfor vinduet; en annen tenant sees ikke", async () => {
    const T = "overdue_followup";
    await seedResolved(B, T, "dismissed", 0.9, 40); // BIZ B: skal ikke påvirke A
    await seedResolved(A, T, "acted", 0.9, 15);
    await seedResolved(A, T, "dismissed", 0.9, 15);
    await seedResolved(A, T, "condition_cleared", 0.9, 4);
    await seedResolved(A, T, null, 0.9, 2);
    await seedResolved(A, T, "acted", 0.9, 50, 500); // for gamle (utenfor 365 dager) – ekskluderes
    const report = await loops.calibrationReport(A, SP);
    const t = report.by_type.find((x) => x.loop_type === T)!;
    // 15 + 15 seedet, pluss de to ekte loopene fra test A (1 acted, 1 dismissed) = 16/16
    expect(t).toMatchObject({ n_acted: 16, n_dismissed: 16, n_labelled: 32, hit_rate: 0.5, mean_confidence: 0.9, verdict: "overconfident" });
    expect(t.n_condition_cleared).toBeGreaterThanOrEqual(4); // seedet + de automatisk lukkede fra tidligere tester
    expect(t.n_unlabelled).toBeGreaterThanOrEqual(3); // 2 seedet + «Umerket» fra test A
    expect(report.notes.join(" ")).toContain("overkonfident");
    const wide = await loops.calibrationReport(A, SP, { sinceDays: 730 });
    expect(wide.by_type.find((x) => x.loop_type === T)!.n_labelled).toBe(82); // + 50 gamle
    const b = await loops.calibrationReport(B, SP);
    expect(b.by_type.find((x) => x.loop_type === T)).toMatchObject({ n_labelled: 40, n_dismissed: 40, hit_rate: 0, verdict: "overconfident" });
  });

  it("overkonfident type: neste sveip senker confidence for åpne loops av den typen (kalibrert, med observert treffrate i forklaringen)", async () => {
    const co = await business.createCompany(A, SP, { name: "Etter kalibrering AS" });
    const fu = await business.createFollowup(A, SP, { title: "Kalibrert", company_id: co.company_id, due_at: new Date(Date.now() - 2 * DAY).toISOString() });
    await loops.runSweep(A, SP);
    const loop = (await openLoop(A, "overdue_followup", fu.followup_id))!;
    const row = await loopRow(loop.open_loop_id);
    expect(row["confidence"]).toBeLessThan(0.9);
    expect(basis(row)).toMatchObject({ calibrated: true, calibration_n: 32, observed_hit_rate: 0.5 });
    expect(basis(row).adjustments.at(-1)?.code).toBe("calibration");
    // tenant B (40 bom) har egen, strengere kalibrering; A påvirkes ikke av B
    const coB = await business.createCompany(B, SP, { name: "B AS" });
    const fuB = await business.createFollowup(B, SP, { title: "B", company_id: coB.company_id, due_at: new Date(Date.now() - 2 * DAY).toISOString() });
    await loops.runSweep(B, SP);
    const loopB = (await openLoop(B, "overdue_followup", fuB.followup_id))!;
    const rowB = await loopRow(loopB.open_loop_id);
    expect(basis(rowB)).toMatchObject({ calibrated: true, calibration_n: 40, observed_hit_rate: 0 });
    expect(rowB["confidence"] as number).toBeLessThan(row["confidence"] as number);
  });

  it("treffsikker heuristikk (36 av 40 handlet på) løfter taket slik at en velbegrunnet loop kan nå SUGGEST-terskelen", async () => {
    const T = "stalled_opportunity";
    await seedResolved(A, T, "acted", 0.7, 36);
    await seedResolved(A, T, "dismissed", 0.7, 4);
    const co = await business.createCompany(A, SP, { name: "Treffsikker AS" });
    const opp = await business.createOpportunity(A, SP, { title: "Treffer", company_id: co.company_id });
    await admin.query("UPDATE business_opportunities SET updated_at = now() - interval '40 days' WHERE opportunity_id = $1", [opp.opportunity_id]);
    await admin.query(`INSERT INTO support_tickets (ticket_id, tenant_id, company_id, subject, next_response_due_at) VALUES ('tkt-cal-hit', $1, $2, 'Hjelp', now() - interval '1 hour')`, [A, co.company_id]);
    await loops.runSweep(A, SP);
    const loop = (await openLoop(A, T, opp.opportunity_id))!;
    await admin.query("UPDATE business_open_loops SET opened_at = now() - interval '10 days' WHERE open_loop_id = $1", [loop.open_loop_id]);
    await loops.runSweep(A, SP);
    const row = await loopRow(loop.open_loop_id);
    expect(basis(row)).toMatchObject({ calibrated: true, calibration_n: 40, observed_hit_rate: 0.9, capped: null });
    expect(row["confidence"]).toBeGreaterThanOrEqual(CONFIDENCE_V1.suggest_threshold);
  });

  it("kalibreringsrapporten er ren lesing: ingen loops endres av å hente den", async () => {
    const before = await count("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND updated_at > now() - interval '1 second'", [A]);
    await loops.calibrationReport(A, SP);
    await loops.calibrationReport(A, SP, { sinceDays: 30 });
    expect(await count("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND updated_at > now() - interval '1 second'", [A])).toBe(before);
  });
});

describe("E: refineConfidence", () => {
  it("returnerer antall endrede loops, rører kun åpne loops, og en andre kjøring uten endringer gir 0", async () => {
    await loops.runSweep(A, SP);
    const snapshot = async () => (await admin.query("SELECT open_loop_id, confidence::float8 AS c, confidence_basis AS b FROM business_open_loops WHERE tenant_id = $1 AND status = 'resolved' ORDER BY 1", [A])).rows;
    const resolvedBefore = await snapshot();
    const first = await loops.refineConfidence(A, SP);
    const second = await loops.refineConfidence(A, SP);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBe(0);
    expect(await snapshot()).toEqual(resolvedBefore); // lukkede loops er historikk og røres ikke
  });

  it("alle åpne loops har en confidence innenfor [0.1, 0.97] med to desimaler og en forklaring etter sveipet", async () => {
    const rows = (await admin.query("SELECT confidence::float8 AS c, confidence_basis AS b FROM business_open_loops WHERE tenant_id = $1 AND status = 'open'", [A])).rows as Array<{ c: number; b: ConfidenceBasis | null }>;
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) {
      expect(r.c).toBeGreaterThanOrEqual(0.1);
      expect(r.c).toBeLessThanOrEqual(0.97);
      expect(Math.round(r.c * 100) / 100).toBe(r.c);
      expect(r.b?.rule_version).toBe("loop_confidence_v1");
    }
  });
});

describe("F: merkede utfall overlever gjenåpning (survivorship), og en vanlig re-deteksjon nullstiller ikke confidence", () => {
  const typeRow = async (report: Awaited<ReturnType<typeof loops.calibrationReport>>, type: string) => report.by_type.find((x) => x.loop_type === type)!;

  it("avvist loop der vilkåret fortsatt holder: etter 7 dager gjenåpnes den, men utfallet + confidence ved lukking ligger i closure_history og teller fortsatt i rapporten", async () => {
    const T = "overdue_followup";
    const co = await business.createCompany(A, SP, { name: "Gjenåpnet AS" });
    const fu = await business.createFollowup(A, SP, { title: "Vedvarende", company_id: co.company_id, due_at: new Date(Date.now() - 5 * DAY).toISOString() });
    await loops.runSweep(A, SP);
    const loop = (await openLoop(A, T, fu.followup_id))!;
    const id = loop.open_loop_id;
    const before = await typeRow(await loops.calibrationReport(A, SP), T);

    await loops.resolveOpenLoop(A, SP, id, "Ikke relevant", "dismissed");
    const closedWith = (await loopRow(id))["confidence"] as number;
    // innenfor 7-dagers-undertrykkelsen: fortsatt lukket med utfallet, og confidence ved lukking beholdes (ikke nullstilt til grunnverdien)
    await loops.detectOverdueFollowups(A, SP);
    expect(await loopRow(id)).toMatchObject({ status: "resolved", resolution_outcome: "dismissed", confidence: closedWith });

    // undertrykkelsen utløper mens vilkåret fortsatt holder -> gjenåpnet på SAMME rad
    await admin.query("UPDATE business_open_loops SET resolved_at = now() - interval '8 days' WHERE open_loop_id = $1", [id]);
    await loops.detectOverdueFollowups(A, SP);
    const reopened = await one("SELECT status, resolution_outcome, closure_history FROM business_open_loops WHERE open_loop_id = $1", [id]);
    expect(reopened["status"]).toBe("open");
    expect(reopened["resolution_outcome"]).toBeNull();
    const history = reopened["closure_history"] as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ outcome: "dismissed", confidence: closedWith });
    const mid = await typeRow(await loops.calibrationReport(A, SP), T);
    expect(mid.n_dismissed).toBe(before.n_dismissed + 1); // «avvist, men vilkåret holder» forsvinner ikke fra grunnlaget
    expect(mid.n_open).toBe(before.n_open); // loopen er fortsatt åpen (telles ikke dobbelt)

    // lukkes igjen, nå som handlet: begge merkede utfall teller (ett fra historikken, ett fra raden)
    await loops.resolveOpenLoop(A, SP, id, "Ringte kunden", "acted");
    const after = await typeRow(await loops.calibrationReport(A, SP), T);
    expect(after.n_dismissed).toBe(before.n_dismissed + 1);
    expect(after.n_acted).toBe(before.n_acted + 1);
    expect(after.n_labelled).toBe(before.n_labelled + 2);
  });

  it("umerkede lukkinger (uten utfall, eller vilkåret forsvant) legges IKKE i closure_history ved gjenåpning, og utfallet nullstilles", async () => {
    const co = await business.createCompany(A, SP, { name: "Umerket gjenåpning AS" });
    const fu = await business.createFollowup(A, SP, { title: "Umerket", company_id: co.company_id, due_at: new Date(Date.now() - 5 * DAY).toISOString() });
    await loops.runSweep(A, SP);
    const id = (await openLoop(A, "overdue_followup", fu.followup_id))!.open_loop_id;
    await loops.resolveOpenLoop(A, SP, id, "Ferdig uten utfall");
    await admin.query("UPDATE business_open_loops SET resolved_at = now() - interval '8 days' WHERE open_loop_id = $1", [id]);
    await loops.detectOverdueFollowups(A, SP);
    expect(await one("SELECT status, closure_history FROM business_open_loops WHERE open_loop_id = $1", [id])).toMatchObject({ status: "open", closure_history: [] });
  });

  it("closure_history er begrenset til 100 og må være en liste (CHECK)", async () => {
    const id = (await one("SELECT open_loop_id FROM business_open_loops WHERE tenant_id = $1 AND status = 'open' LIMIT 1", [A]))["open_loop_id"] as string;
    await expect(admin.query("UPDATE business_open_loops SET closure_history = '{}'::jsonb WHERE open_loop_id = $1", [id])).rejects.toThrow(/closure_history_array/);
    const big = JSON.stringify(Array.from({ length: 101 }, () => ({ outcome: "acted", confidence: 0.9, closed_at: new Date().toISOString() })));
    await expect(admin.query("UPDATE business_open_loops SET closure_history = $2::jsonb WHERE open_loop_id = $1", [id, big])).rejects.toThrow(/closure_history_array/);
  });

  it("en enkeltdetektor kjørt utenom runSweep nullstiller ikke en kalibrert confidence til grunnverdien (ellers kunne SUGGEST åpnes igjen til neste fulle sveip)", async () => {
    const co = await business.createCompany(A, SP, { name: "Enkeltdetektor AS" });
    const fu = await business.createFollowup(A, SP, { title: "Enkelt", company_id: co.company_id, due_at: new Date(Date.now() - 2 * DAY).toISOString() });
    await loops.runSweep(A, SP);
    const id = (await openLoop(A, "overdue_followup", fu.followup_id))!.open_loop_id;
    const refined = (await loopRow(id))["confidence"] as number;
    expect(refined).toBeLessThan(0.9); // kalibrert (overkonfident type)
    await loops.detectOverdueFollowups(A, SP);
    await loops.detectOverdueFollowups(A, SP);
    const row = await loopRow(id);
    expect(row["confidence"]).toBe(refined);
    expect(basis(row)).toMatchObject({ calibrated: true });
  });

  it("churn: antall uavhengige signalfamilier kan gå NED mellom sveip (hintet flettes inn uten å slette resten av forklaringen)", async () => {
    const ref = "acct-cal-churn-1"; // fra test B: bruk + support + fakturering = intrinsic_signals 2
    const loop = (await churnLoop(A, ref))!;
    expect(basis(await loopRow(loop.open_loop_id)).intrinsic_signals).toBe(2);
    await admin.query("UPDATE support_tickets SET status = 'closed' WHERE ticket_id = 'tkt-cal-churn'");
    await loops.runSweep(A, SP);
    const row = await loopRow(loop.open_loop_id);
    expect(basis(row).intrinsic_signals).toBe(1);
    expect(basis(row).adjustments.find((a) => a.code === "independent_signals")?.delta).toBe(0.03);
    expect(basis(row).rule_version).toBe("loop_confidence_v1");
  });
});
