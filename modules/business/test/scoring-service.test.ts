import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { BusinessService } from "../src/service.ts";
import { OpenLoopService } from "../src/open-loop-service.ts";
import { ScoringService } from "../src/scoring-service.ts";

/**
 * UA-3 profiling/scoring-slice (D-61) - DB-baserte tester (idempotens/
 * tenant-/space-isolasjon/manuell overstyring/Q-20-resiliens/Q-21-
 * rollesikkerhet). Ekte embedded Postgres, ekte migrasjoner (opp til 022),
 * ekte RLS via en GARANTERT non-bypass rolle - samme mønster som
 * open-loop-service.test.ts.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let business: BusinessService;
let openLoops: OpenLoopService;
let scoring: ScoringService;

const TENANT_A = "tenant-score-a";
const TENANT_B = "tenant-score-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-scoring-"));
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
  await adminPool.query("CREATE ROLE jarvis_scoring_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_scoring_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-a-business','${TENANT_A}','business'), ('ms-a-personal','${TENANT_A}','personal'),
      ('ms-b-business','${TENANT_B}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_scoring_test", password: "pw2" });
  business = new BusinessService(appPool);
  openLoops = new OpenLoopService(appPool);
  scoring = new ScoringService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("L: score-rekalkulering", () => {
  it("recalculateLeadScore beregner OG persisterer en score for en ekte lead", async () => {
    const lead = await business.createLead(TENANT_A, "business", { title: "Ny lead", status: "qualified" });
    const row = await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
    expect(row).not.toBeNull();
    // 30 (qualified) - 15 (ingen aktivitet noensinne registrert -> stale_30d, korrekt siden leaden aldri har blitt fulgt opp)
    expect(row?.score).toBe(15);
    expect(row?.score_type).toBe("lead_priority");
    expect(row?.rule_version).toBe("lead_priority_v1");
    expect(typeof row?.score).toBe("number");
  });

  it("recalculateOpportunityScore beregner OG persisterer en score for en ekte opportunity", async () => {
    const opp = await business.createOpportunity(TENANT_A, "business", { title: "Ny opportunity", stage: "proposal" });
    const row = await scoring.recalculateOpportunityScore(TENANT_A, "business", opp.opportunity_id);
    expect(row).not.toBeNull();
    expect(row?.score).toBe(35 + 15); // proposal (35) + ingen aapen oppfoelging (15)
    expect(row?.score_type).toBe("opportunity_risk");
  });

  it("returnerer null for en entitet som ikke finnes (aldri en fabrikkert score)", async () => {
    expect(await scoring.recalculateLeadScore(TENANT_A, "business", "biz-lead-nonexistent")).toBeNull();
    expect(await scoring.recalculateOpportunityScore(TENANT_A, "business", "biz-op-nonexistent")).toBeNull();
  });
});

describe("M: idempotent rekalkulering", () => {
  it("rekalkulering for SAMME lead flere ganger oppdaterer SAMME rad, oppretter aldri en duplikat", async () => {
    const lead = await business.createLead(TENANT_A, "business", { title: "Idempotens-lead", status: "new" });
    const first = await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
    const second = await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
    expect(first?.score_id).toBe(second?.score_id);
    const { rows } = await adminPool.query(
      "SELECT count(*)::int AS n FROM business_scores WHERE tenant_id = $1 AND entity_id = $2 AND score_type = 'lead_priority'",
      [TENANT_A, lead.lead_id]
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("en manuell overstyring overlever rekalkulering (rekalkulering endrer ALDRI override-feltene)", async () => {
    const lead = await business.createLead(TENANT_A, "business", { title: "Override-overlever-lead", status: "new" });
    await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
    await scoring.setManualOverride(TENANT_A, "business", "lead", lead.lead_id, { override_score: 99, reason: "VIP-kunde" });
    await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
    const row = await scoring.explainScore(TENANT_A, "business", "lead", lead.lead_id);
    expect(row?.manual_override).toBe(true);
    expect(row?.override_score).toBe(99);
    expect(row?.effective_score).toBe(99);
  });
});

describe("C: rangeringsstabilitet", () => {
  it("rankLeads returnerer synkende effektiv score, stabil paa tvers av gjentatte kall", async () => {
    const low = await business.createLead(TENANT_A, "business", { title: "Lav prioritet", status: "new" });
    const high = await business.createLead(TENANT_A, "business", { title: "Hoy prioritet", status: "qualified" });
    await scoring.recalculateLeadScore(TENANT_A, "business", low.lead_id);
    await scoring.recalculateLeadScore(TENANT_A, "business", high.lead_id);
    const first = await scoring.rankLeads(TENANT_A, "business", 50);
    const second = await scoring.rankLeads(TENANT_A, "business", 50);
    expect(first.map((r) => r.entity_id)).toEqual(second.map((r) => r.entity_id));
    const highIdx = first.findIndex((r) => r.entity_id === high.lead_id);
    const lowIdx = first.findIndex((r) => r.entity_id === low.lead_id);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it("rankLeads respekterer en manuell overstyring i sorteringsrekkefolgen (effective_score, ikke raw score)", async () => {
    const normalLead = await business.createLead(TENANT_A, "business", { title: "Normal", status: "qualified" });
    const overriddenLead = await business.createLead(TENANT_A, "business", { title: "Overstyrt lavt", status: "qualified" });
    await scoring.recalculateLeadScore(TENANT_A, "business", normalLead.lead_id);
    await scoring.recalculateLeadScore(TENANT_A, "business", overriddenLead.lead_id);
    await scoring.setManualOverride(TENANT_A, "business", "lead", overriddenLead.lead_id, { override_score: 1, reason: "avklart lavt behov" });
    const ranked = await scoring.rankLeads(TENANT_A, "business", 50);
    const normalIdx = ranked.findIndex((r) => r.entity_id === normalLead.lead_id);
    const overriddenIdx = ranked.findIndex((r) => r.entity_id === overriddenLead.lead_id);
    expect(normalIdx).toBeLessThan(overriddenIdx);
  });
});

describe("J: manuell overstyring", () => {
  it("setManualOverride setter override_score/reason/actor uten aa endre den beregnede scoren/faktorene", async () => {
    const lead = await business.createLead(TENANT_A, "business", { title: "Overstyrings-lead", status: "contacted" });
    const computed = await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
    const overridden = await scoring.setManualOverride(TENANT_A, "business", "lead", lead.lead_id, {
      override_score: 5, reason: "Kunde har trukket seg midlertidig", actor_person_id: "person-tobias"
    });
    expect(overridden?.manual_override).toBe(true);
    expect(overridden?.override_score).toBe(5);
    expect(overridden?.override_reason).toBe("Kunde har trukket seg midlertidig");
    expect(overridden?.override_by).toBe("person-tobias");
    expect(overridden?.override_at).not.toBeNull();
    // Den underliggende beregnede scoren/faktorene er UENDRET - overstyring forfalsker aldri kildedata (§18).
    expect(overridden?.score).toBe(computed?.score);
    expect(overridden?.factor_summary).toEqual(computed?.factor_summary);
  });

  it("clearManualOverride fjerner overstyringen og gaar tilbake til den beregnede scoren", async () => {
    const lead = await business.createLead(TENANT_A, "business", { title: "Clear-override-lead", status: "contacted" });
    await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
    await scoring.setManualOverride(TENANT_A, "business", "lead", lead.lead_id, { override_score: 5, reason: "midlertidig" });
    const cleared = await scoring.clearManualOverride(TENANT_A, "business", "lead", lead.lead_id);
    expect(cleared?.manual_override).toBe(false);
    expect(cleared?.override_score).toBeNull();
    expect(cleared?.override_reason).toBeNull();
    expect(cleared?.override_by).toBeNull();
    const explained = await scoring.explainScore(TENANT_A, "business", "lead", lead.lead_id);
    expect(explained?.effective_score).toBe(explained?.score);
  });
});

describe("N: tenant-isolasjon", () => {
  it("tenant B kan aldri se/rangere tenant A sine scorer (FORCE RLS, ekte non-bypass rolle)", async () => {
    const leadA = await business.createLead(TENANT_A, "business", { title: "Kun A", status: "qualified" });
    await scoring.recalculateLeadScore(TENANT_A, "business", leadA.lead_id);
    const rankedB = await scoring.rankLeads(TENANT_B, "business", 50);
    expect(rankedB.some((r) => r.entity_id === leadA.lead_id)).toBe(false);
    const explainCrossTenant = await scoring.explainScore(TENANT_B, "business", "lead", leadA.lead_id);
    expect(explainCrossTenant).toBeNull();
  });
});

describe("O: memory-space-isolasjon", () => {
  it("en score i 'business'-space er ikke synlig naar kun 'personal'-space er tillatt (RESTRICTIVE space-policy, samme mønster som business_open_loops)", async () => {
    const lead = await business.createLead(TENANT_A, "business", { title: "Space-test-lead", status: "qualified" });
    await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
    const wrongSpace = await scoring.explainScore(TENANT_A, "personal", "lead", lead.lead_id);
    expect(wrongSpace).toBeNull();
    const rightSpace = await scoring.explainScore(TENANT_A, "business", "lead", lead.lead_id);
    expect(rightSpace).not.toBeNull();
  });
});

describe("P: Q-21 - business_scores respekterer den EKTE non-bypass runtime-rollen", () => {
  it("jarvis_scoring_test er NOSUPERUSER/NOBYPASSRLS (samme rolle ALLE testene over kjorer under)", async () => {
    const { rows } = await adminPool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'jarvis_scoring_test'"
    );
    expect((rows[0] as { rolsuper: boolean }).rolsuper).toBe(false);
    expect((rows[0] as { rolbypassrls: boolean }).rolbypassrls).toBe(false);
  });

  it("en raw spoerring UTEN withMemoryTransaction ser 0 rader for business_scores under samme rolle (RLS er reelt haandhevet, ikke bare i applikasjonskoden)", async () => {
    const rawPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_scoring_test", password: "pw2" });
    try {
      const lead = await business.createLead(TENANT_A, "business", { title: "RLS-bevis-lead", status: "qualified" });
      await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
      const { rows } = await rawPool.query("SELECT * FROM business_scores WHERE tenant_id = $1", [TENANT_A]);
      expect(rows).toHaveLength(0);
    } finally {
      await rawPool.end();
    }
  });
});

describe("V: Q-20/kildefjerning - scoring er resilient naar en referert kilde-entitet fjernes", () => {
  it("rekalkulering etter at den eneste aktiviteten er slettet gir en gyldig (lavere) score, krasjer aldri", async () => {
    const lead = await business.createLead(TENANT_A, "business", { title: "Q20-resiliens-lead", status: "contacted" });
    const activity = await business.recordActivity(TENANT_A, "business", { activity_type: "note", summary: "Ringte kunde", lead_id: lead.lead_id });
    const withActivity = await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
    expect(withActivity?.evidence.some((e) => e.id === activity.activity_id)).toBe(true);

    // §22 i byggeordren: simuler at aktiviteten er fjernet (f.eks. via en fremtidig Q-20-kilde-sletting) -
    // rekalkulering skal fortsette aa fungere, ikke referere en slettet rad, og aldri kopiere innhold inn i scoren.
    await adminPool.query("DELETE FROM business_activities WHERE tenant_id = $1 AND activity_id = $2", [TENANT_A, activity.activity_id]);
    const afterRemoval = await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
    expect(afterRemoval).not.toBeNull();
    expect(afterRemoval?.evidence.some((e) => e.id === activity.activity_id)).toBe(false);
  });

  it("evidence/factor_summary inneholder ALDRI kopiert aktivitets-/oppfoelgings-innhold (kun struktur-koder + ID-referanser)", async () => {
    const lead = await business.createLead(TENANT_A, "business", { title: "Ingen-kopi-lead", status: "contacted" });
    await business.recordActivity(TENANT_A, "business", { activity_type: "email", summary: "HEMMELIG-EMNE-SKAL-ALDRI-I-SCORE", lead_id: lead.lead_id });
    const row = await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
    const serialized = JSON.stringify(row?.factor_summary) + JSON.stringify(row?.evidence);
    expect(serialized).not.toContain("HEMMELIG-EMNE-SKAL-ALDRI-I-SCORE");
  });
});

const scoringServiceSource = await readFile(fileURLToPath(new URL("../src/scoring-service.ts", import.meta.url)), "utf8");

describe("W: hoy-konsekvens autonom personbeslutning strukturelt umulig (§10 i byggeordren)", () => {
  const source = scoringServiceSource;

  it("ScoringService kaller ALDRI en ekstern ToolGateway-handling/transport basert paa en score - kun egen business_scores-tilstand", () => {
    expect(source).not.toMatch(/toolGateway\.execute|\.invoke\(/);
    // Merk: disse ordene forekommer BEVISST i filens egen §10-forklarende kommentar-prosa
    // (se klassens JSDoc) - sjekker derfor eksplisitt etter faktisk FUNKSJONSKALL-syntaks
    // (identifikator etterfulgt av parentes), ikke bare ordets tilstedevaerelse noe sted.
    expect(source).not.toMatch(/\b(reject|deny|terminate|credit|employment|insurance)\s*\(/i);
  });

  it("en score-rad har INGEN kolonne/felt som representerer en autonomt utfoert hoy-konsekvens-handling - kun prioriterings-tall + forklaring", async () => {
    const lead = await business.createLead(TENANT_A, "business", { title: "Hoy-konsekvens-sjekk-lead", status: "qualified" });
    const row = await scoring.recalculateLeadScore(TENANT_A, "business", lead.lead_id);
    const keys = Object.keys(row ?? {});
    for (const forbidden of ["rejected", "denied", "terminated", "credit_decision", "employment_decision"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("X: scoring-kapabilitet er fail-closed naar ikke konfigurert (deployment-nivaa 'av'-tilstand)", () => {
  it("BusinessTransport uten en ScoringService-instans kaster en eksplisitt, tydelig feil for score-handlinger - aldri en stille tom/fabrikkert score", async () => {
    const { BusinessTransport } = await import("../src/transport.ts");
    const transport = new BusinessTransport(business, openLoops, appPool);
    await expect(transport.invoke("get_lead_score", { tenant_id: TENANT_A, memory_space: "business", lead_id: "biz-lead-x" }))
      .rejects.toThrow("business_scoring_not_configured");
  });
});

describe("D-395 (JARVIS-083): rangering og rekalkulering", () => {
  it("rankLeads/rankOpportunities viser IKKE avsluttede entiteter som beholder en gammel skår", async () => {
    const open = await business.createLead(TENANT_A, "business", { title: "D395 åpen lead", status: "qualified" });
    const closed = await business.createLead(TENANT_A, "business", { title: "D395 avsluttet lead", status: "qualified" });
    await scoring.recalculateLeadScore(TENANT_A, "business", open.lead_id);
    await scoring.recalculateLeadScore(TENANT_A, "business", closed.lead_id);
    await adminPool.query("UPDATE business_leads SET status = 'disqualified' WHERE lead_id = $1", [closed.lead_id]);
    const ranked = (await scoring.rankLeads(TENANT_A, "business", 500)).map((r) => r.entity_id);
    expect(ranked).toContain(open.lead_id);
    expect(ranked).not.toContain(closed.lead_id);
  });

  it("recalculateTenant tar de lengst siden skårede først (aldri skårede aller først) - ikke en vilkårlig 500-delmengde", async () => {
    const stale = await business.createLead(TENANT_B, "business", { title: "D395 gammel skår", status: "qualified" });
    const fresh = await business.createLead(TENANT_B, "business", { title: "D395 fersk skår", status: "qualified" });
    await scoring.recalculateLeadScore(TENANT_B, "business", stale.lead_id);
    await scoring.recalculateLeadScore(TENANT_B, "business", fresh.lead_id);
    await adminPool.query("UPDATE business_scores SET calculated_at = now() - interval '30 days' WHERE entity_id = $1", [stale.lead_id]);
    const before = Date.now();
    await scoring.recalculateTenant(TENANT_B, "business");
    const rows = await adminPool.query("SELECT entity_id, calculated_at FROM business_scores WHERE entity_id = ANY($1)", [[stale.lead_id, fresh.lead_id]]);
    // Begge er skåret på nytt innenfor grensen (<500); den gamle skåren er ikke lenger 30 dager gammel.
    for (const r of rows.rows as Array<{ calculated_at: Date }>) expect(r.calculated_at.getTime()).toBeGreaterThanOrEqual(before - 60_000);
  });

  it("spørringen som velger kandidater sorterer etter siste skåring (strukturelt bevis for ORDER BY)", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../src/scoring-service.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ORDER BY s\.calculated_at ASC NULLS FIRST, l\.lead_id LIMIT 500/);
    expect(src).toMatch(/ORDER BY s\.calculated_at ASC NULLS FIRST, o\.opportunity_id LIMIT 500/);
  });
});
