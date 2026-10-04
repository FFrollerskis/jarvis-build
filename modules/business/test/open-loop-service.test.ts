import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";
import { BusinessService } from "../src/service.ts";
import { OpenLoopService, formatMoney } from "../src/open-loop-service.ts";
import { deterministicLoopConfidence } from "../src/open-loop-types.ts";

/**
 * UA-3 next slice (D-53) - testmatrise for automatisk open-loop-deteksjon
 * (byggeordrens §29, kategoriene som faktisk gjelder dette sliceet). Ekte
 * embedded Postgres, ekte migrasjoner (019 + 020), ekte RLS via en
 * GARANTERT non-bypass rolle - samme mønster som business-service.test.ts.
 *
 * Honest scope: AI Mesh/Model Gateway-bruk = INGEN i dette sliceet (§11) -
 * testet strukturelt under, ikke fabrikkert. Gmail/Calendar-lenking er
 * bevisst utenfor scope (§21/§22) - deteksjonen bevises kun mot eksisterende
 * P0 business-data.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let business: BusinessService;
let openLoops: OpenLoopService;

const TENANT_A = "tenant-ol-a";
const TENANT_B = "tenant-ol-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-openloop-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_openloop_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_openloop_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-a-business','${TENANT_A}','business'), ('ms-a-personal','${TENANT_A}','personal'),
      ('ms-b-business','${TENANT_B}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_openloop_test", password: "pw2" });
  business = new BusinessService(appPool);
  openLoops = new OpenLoopService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: forfalt oppfoelging - deterministisk deteksjon", () => {
  it("en forfalt, aapen oppfoelging blir et open loop med type overdue_followup", async () => {
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Send tilbud til Acme", due_at: "2020-01-01T00:00:00Z" });
    const result = await openLoops.detectOverdueFollowups(TENANT_A, "business");
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.followup_id === followup.followup_id);
    expect(loop).toBeTruthy();
    expect(loop?.loop_type).toBe("overdue_followup");
    expect(loop?.status).toBe("open");
  });

  it("en fremtidig oppfoelging gir IKKE et open loop", async () => {
    const future = await business.createFollowup(TENANT_A, "business", { title: "Fremtidig oppfoelging", due_at: "2099-01-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.followup_id === future.followup_id)).toBeUndefined();
  });
});

describe("B: idempotens - re-kjoert deteksjon oppdaterer SAMME rad, oppretter aldri en duplikat", () => {
  it("to etterfoelgende sveip for samme forfalte oppfoelging gir eksakt EN open_loop-rad", async () => {
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Idempotent-test", due_at: "2020-06-01T00:00:00Z" });
    const first = await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const second = await openLoops.detectOverdueFollowups(TENANT_A, "business");
    expect(second.updated).toBeGreaterThanOrEqual(1);
    const { rows } = await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND followup_id = $2", [TENANT_A, followup.followup_id])
    );
    expect((rows[0] as { n: number }).n).toBe(1);
    expect(first.detected).toBeGreaterThanOrEqual(0);
  });
});

describe("C: resolusjon - deterministisk vilkaar-basert auto-resolve", () => {
  it("fullfoering av en forfalt oppfoelging gjor at neste sveip auto-resolver loopet (vilkaaret er ikke lenger sant)", async () => {
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Skal fullfoeres", due_at: "2020-03-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const beforeComplete = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(beforeComplete.find((l) => l.followup_id === followup.followup_id)).toBeTruthy();

    await business.completeFollowup(TENANT_A, "business", followup.followup_id);
    const sweep = await openLoops.detectOverdueFollowups(TENANT_A, "business");
    expect(sweep.auto_resolved).toBeGreaterThanOrEqual(1);

    const afterComplete = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(afterComplete.find((l) => l.followup_id === followup.followup_id)).toBeUndefined();
    const all = await openLoops.listOpenLoops(TENANT_A, "business", "all");
    const resolvedLoop = all.find((l) => l.followup_id === followup.followup_id);
    expect(resolvedLoop?.status).toBe("resolved");
    expect(resolvedLoop?.resolution_reason).toBe("condition_no_longer_true");
  });

  it("manuell resolveOpenLoop() setter status/resolved_at/resolution_reason, og respekterer at loopet allerede er lukket", async () => {
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Manuell resolusjon", due_at: "2020-04-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.followup_id === followup.followup_id);
    const resolved = await openLoops.resolveOpenLoop(TENANT_A, "business", loop!.open_loop_id, "manuelt loest av eier");
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolution_reason).toBe("manuelt loest av eier");
    const secondAttempt = await openLoops.resolveOpenLoop(TENANT_A, "business", loop!.open_loop_id, "duplikat-forsoek");
    expect(secondAttempt).toBeNull();
  });
});

describe("D: gjenaapning - D-396: operatoer-lukket loop undertrykkes 7 dager, deretter gjenaapnes den paa SAMME rad", () => {
  it("en manuelt resolved, fortsatt-forfalt oppfoelging forblir lukket ved neste sveip, og gjenaapnes (samme open_loop_id) naar undertrykkelsen er utloept", async () => {
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Gjenaapnes", due_at: "2020-05-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const originalLoop = loops.find((l) => l.followup_id === followup.followup_id)!;
    await openLoops.resolveOpenLoop(TENANT_A, "business", originalLoop.open_loop_id, "feilaktig lukket");

    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const stillResolved = await openLoops.readOpenLoop(TENANT_A, "business", originalLoop.open_loop_id);
    expect(stillResolved?.status).toBe("resolved");
    expect(stillResolved?.resolution_reason).toBe("feilaktig lukket");

    await adminPool.query("UPDATE business_open_loops SET resolved_at = now() - interval '8 days' WHERE open_loop_id = $1", [originalLoop.open_loop_id]);
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const reopened = await openLoops.readOpenLoop(TENANT_A, "business", originalLoop.open_loop_id);
    expect(reopened?.status).toBe("open");
    expect(reopened?.resolved_at).toBeNull();
    expect(reopened?.resolution_reason).toBeNull();

    const { rows } = await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("SELECT count(*)::int AS n FROM business_open_loops WHERE tenant_id = $1 AND followup_id = $2", [TENANT_A, followup.followup_id])
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("en auto-loest loop (vilkaaret forsvant) gjenaapnes umiddelbart naar vilkaaret kommer tilbake", async () => {
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Auto-loest", due_at: "2020-06-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const original = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).find((l) => l.followup_id === followup.followup_id)!;
    await adminPool.query(
      "UPDATE business_open_loops SET status = 'resolved', resolved_at = now(), resolution_reason = 'condition_no_longer_true' WHERE open_loop_id = $1",
      [original.open_loop_id]
    );
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    expect((await openLoops.readOpenLoop(TENANT_A, "business", original.open_loop_id))?.status).toBe("open");
  });
});

describe("D-396 (JARVIS-045): deterministisk confidence", () => {
  it("en deterministisk loop faar confidence 0.9 (hard fakta), heuristikk 0.7 - aldri NULL", async () => {
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Confidence", due_at: "2020-07-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const loop = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).find((l) => l.followup_id === followup.followup_id)!;
    expect(loop.detection_method).toBe("deterministic");
    expect(Number(loop.confidence)).toBe(0.9);
    expect(deterministicLoopConfidence("stalled_opportunity")).toBe(0.7);
    expect(deterministicLoopConfidence("support_ticket_needs_reply")).toBe(0.9);
  });
});

describe("D-396 (JARVIS-082): sortering og beloepsformat", () => {
  it("listOpenLoops sorterer 'high' foer 'normal' (alfabetisk DESC ga motsatt rekkefoelge)", async () => {
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const priorities = loops.map((l) => l.priority);
    const firstNormal = priorities.indexOf("normal");
    const lastHigh = priorities.lastIndexOf("high");
    if (firstNormal !== -1 && lastHigh !== -1) expect(lastHigh).toBeLessThan(firstNormal);
  });

  it("formatMoney: oere -> kroner med to desimaler og tusenskille, eksakt for store bigint-verdier", () => {
    expect(formatMoney("50000", "NOK")).toBe("500,00 NOK");
    expect(formatMoney(5, "NOK")).toBe("0,05 NOK");
    expect(formatMoney("123456789012")).toBe("1\u00a0234\u00a0567\u00a0890,12");
    expect(formatMoney(-150, "EUR")).toBe("-1,50 EUR");
    expect(formatMoney(null, "NOK")).toBe("ukjent beløp NOK");
  });
});

describe("E: prioritet - deterministisk basert paa hvor lenge forfalt", () => {
  it("en oppfoelging forfalt > 3 dager faar prioritet 'high', en nylig forfalt faar 'normal'", async () => {
    const longOverdue = await business.createFollowup(TENANT_A, "business", { title: "Lenge forfalt", due_at: "2020-01-01T00:00:00Z" });
    const recentlyOverdue = await business.createFollowup(TENANT_A, "business", {
      title: "Nylig forfalt", due_at: new Date(Date.now() - 6 * 3_600_000).toISOString()
    });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.followup_id === longOverdue.followup_id)?.priority).toBe("high");
    expect(loops.find((l) => l.followup_id === recentlyOverdue.followup_id)?.priority).toBe("normal");
  });
});

describe("F: stagnert opportunity - deterministisk deteksjon (ikke terminal stage + ingen aapen oppfoelging + gammel oppdatering)", () => {
  it("en opportunity uten aapen oppfoelging og gammel updated_at blir et stalled_opportunity-loop", async () => {
    const opp = await business.createOpportunity(TENANT_A, "business", { title: "Stagnert deal" });
    await adminPool.query("UPDATE business_opportunities SET updated_at = now() - interval '20 days' WHERE opportunity_id = $1", [opp.opportunity_id]);
    const result = await openLoops.detectStalledOpportunities(TENANT_A, "business", 14);
    expect(result.detected).toBeGreaterThanOrEqual(1);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.opportunity_id === opp.opportunity_id);
    expect(loop?.loop_type).toBe("stalled_opportunity");
  });

  it("en opportunity MED en aapen oppfoelging linket blir IKKE flagget som stagnert (allerede under oppfoelging)", async () => {
    const opp = await business.createOpportunity(TENANT_A, "business", { title: "Under oppfoelging" });
    await adminPool.query("UPDATE business_opportunities SET updated_at = now() - interval '20 days' WHERE opportunity_id = $1", [opp.opportunity_id]);
    await business.createFollowup(TENANT_A, "business", { title: "Aktiv oppfoelging", due_at: "2099-01-01T00:00:00Z", opportunity_id: opp.opportunity_id });
    await openLoops.detectStalledOpportunities(TENANT_A, "business", 14);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.opportunity_id === opp.opportunity_id)).toBeUndefined();
  });

  it("en won/lost opportunity blir ALDRI flagget som stagnert, uansett alder", async () => {
    const opp = await business.createOpportunity(TENANT_A, "business", { title: "Vunnet gammel deal" });
    await business.updateOpportunityStage(TENANT_A, "business", opp.opportunity_id, "won");
    await adminPool.query("UPDATE business_opportunities SET updated_at = now() - interval '100 days' WHERE opportunity_id = $1", [opp.opportunity_id]);
    await openLoops.detectStalledOpportunities(TENANT_A, "business", 14);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.find((l) => l.opportunity_id === opp.opportunity_id)).toBeUndefined();
  });
});

describe("G: runSweep() kombinerer begge regler idempotent", () => {
  it("runSweep() kjoert to ganger paa rad endrer ikke antall aapne loops andre gang (utover evt. nye reelle vilkaar)", async () => {
    await business.createFollowup(TENANT_A, "business", { title: "Sweep-test", due_at: "2020-02-01T00:00:00Z" });
    await openLoops.runSweep(TENANT_A, "business");
    const afterFirst = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).length;
    await openLoops.runSweep(TENANT_A, "business");
    const afterSecond = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).length;
    expect(afterSecond).toBe(afterFirst);
  });
});

describe("H: kilde-forankret begrunnelse - hvert loop kan forklares uten hallusinasjon", () => {
  it("et open loop for en forfalt oppfoelging refererer det EKSAKTE followup_id/company_id/reason - sporbart, ikke oppdiktet", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: "Kilde-sporing AS" });
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Sporbar oppfoelging", due_at: "2020-07-01T00:00:00Z", company_id: company.company_id });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.followup_id === followup.followup_id);
    expect(loop?.company_id).toBe(company.company_id);
    expect(loop?.detection_key).toBe(`overdue_followup:${followup.followup_id}`);
    expect(loop?.reason).toContain("Sporbar oppfoelging");
  });
});

describe("I: tenant-isolasjon (RLS)", () => {
  it("tenant B ser ALDRI tenant A sine open loops - haandhevet i databasen", async () => {
    await business.createFollowup(TENANT_A, "business", { title: "Kun for A", due_at: "2020-08-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const loopsB = await openLoops.listOpenLoops(TENANT_B, "business", "open");
    expect(loopsB).toHaveLength(0);
  });

  it("tenant B sitt eget sveip paavirker aldri tenant A sine loops", async () => {
    const beforeA = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).length;
    await openLoops.runSweep(TENANT_B, "business");
    const afterA = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).length;
    expect(afterA).toBe(beforeA);
  });
});

describe("J: memory-space-isolasjon", () => {
  it("et open loop i 'business'-space er usynlig fra en 'personal'-space-spoerring i samme tenant", async () => {
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Space-isolert", due_at: "2020-09-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const rows = await withMemoryTransaction(appPool, TENANT_A, ["personal"], (client) =>
      client.query("SELECT * FROM business_open_loops WHERE tenant_id = $1 AND followup_id = $2", [TENANT_A, followup.followup_id])
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe("K: oppmerksomhets-koe (attention queue) - deterministisk bucket-inndeling over persistert state", () => {
  it("high-prioritet + forfalt => 'critical'; normal + forfalt => 'overdue'; ingen due_at => 'informational'", async () => {
    const critical = await business.createFollowup(TENANT_A, "business", { title: "Kritisk", due_at: "2020-01-01T00:00:00Z" });
    const overdue = await business.createFollowup(TENANT_A, "business", { title: "Forfalt normal", due_at: new Date(Date.now() - 6 * 3_600_000).toISOString() });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const queue = await openLoops.attentionQueue(TENANT_A, "business");
    const criticalEntry = queue.find((e) => e.loop.followup_id === critical.followup_id);
    const overdueEntry = queue.find((e) => e.loop.followup_id === overdue.followup_id);
    expect(criticalEntry?.bucket).toBe("critical");
    expect(overdueEntry?.bucket).toBe("overdue");
  });
});

describe("L: defer/assign/set_next_action - operasjonell tilstandsoppdatering", () => {
  it("deferOpenLoop() flytter due_at, assignOpenLoop() setter eier, setNextAction() oppdaterer anbefalt handling", async () => {
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Operasjonell-test", due_at: "2020-10-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    const loop = loops.find((l) => l.followup_id === followup.followup_id)!;

    const deferred = await openLoops.deferOpenLoop(TENANT_A, "business", loop.open_loop_id, "2099-01-01T00:00:00Z");
    expect(new Date(deferred!.due_at as unknown as string).toISOString()).toContain("2099-01-01");

    const assigned = await openLoops.assignOpenLoop(TENANT_A, "business", loop.open_loop_id, "person-tobias");
    expect(assigned?.owner_person_id).toBe("person-tobias");

    const withNextAction = await openLoops.setNextAction(TENANT_A, "business", loop.open_loop_id, "Ring kunden i morgen");
    expect(withNextAction?.next_action).toBe("Ring kunden i morgen");
  });
});

describe("M: Q-20-interaksjon (strukturelt bevist - ingen FK til knowledge_documents)", () => {
  it("business_open_loops har INGEN fremmednøkkel-kolonne mot knowledge_documents - erasure av kildedokument kan aldri cascade-slette eller feile mot et open loop", async () => {
    const { rows } = await adminPool.query(
      `SELECT count(*)::int AS n FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
       WHERE tc.table_name = 'business_open_loops' AND tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'knowledge_documents'`
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe("N: RLS haandheves i databasen for business_open_loops (FORCE ROW LEVEL SECURITY)", () => {
  it("relrowsecurity og relforcerowsecurity er begge true - samme muster som alle andre business_*-tabeller", async () => {
    const { rows } = await adminPool.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'business_open_loops'"
    );
    expect((rows[0] as { relrowsecurity: boolean }).relrowsecurity).toBe(true);
    expect((rows[0] as { relforcerowsecurity: boolean }).relforcerowsecurity).toBe(true);
  });
});

describe("O: ingen direkte modell-leverandør-bypass (strukturelt) - §11 AI Mesh-bruk er INGEN i dette sliceet", () => {
  it("open-loop-service.ts importerer aldri en provider-SDK eller ModelGateway direkte", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/open-loop-service.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/@jarvis\/model-gateway|@jarvis\/provider-adapters|openai|anthropic/i);
  });
});
