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

/**
 * UA-3 P0 (Business Domain Foundation) - testmatrise A-X fra byggeordren.
 * Ekte embedded Postgres, ekte migrasjoner, ekte RLS via en GARANTERT
 * non-bypass rolle (samme mønster som modules/erasure/test/erasure-service.test.ts -
 * Q-21 må aldri regresere).
 *
 * Honest scope (§30 i BO-en - IKKE fabrikkerte akseptansekriterier):
 * - J (Knowledge evidence retrieval), Q (Gmail linkage), R (Calendar linkage),
 *   V (worker retry/idempotency), X (cost/model accounting) er N/A - dette
 *   sliceet integrerer bevisst IKKE Knowledge/Gmail/Calendar/worker-kø/AI Mesh
 *   (se docs/OPEN_QUESTIONS.md Q-25 for deferred-listen).
 * - S/T (Q-20-interaksjon) er strukturelt bevist ved skjema-design: business_activities
 *   har INGEN FK til knowledge_documents (kun løs canonical_uri-peker) - en
 *   Q-20-sletting av kilde-dokumentet kan derfor ALDRI cascade-slette eller
 *   feile mot en business-aktivitet. Testet direkte under (test S).
 * - N (audit metadata) og O/P (owner sovereign/delegert policy) testes i
 *   business-transport-wiring.test.ts via den EKSISTERENDE, generiske
 *   ToolGateway/PolicyGateway-revisjons-/policy-mekanismen - ikke duplisert her.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: BusinessService;

const TENANT_A = "tenant-biz-a";
const TENANT_B = "tenant-biz-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-business-"));
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
  await adminPool.query("CREATE ROLE jarvis_business_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_business_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-a-business','${TENANT_A}','business'), ('ms-a-personal','${TENANT_A}','personal'),
      ('ms-b-business','${TENANT_B}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_business_test", password: "pw2" });
  service = new BusinessService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: tenant-scoped selskap/kontakt-opprettelse", () => {
  it("oppretter et selskap scoped til riktig tenant/space", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: "Acme AS" });
    expect(company.tenant_id).toBe(TENANT_A);
    expect(company.memory_space_id).toBe("business");
    expect(company.status).toBe("prospect");
  });
});

describe("B: organisasjon/kontakt-relasjoner", () => {
  it("knytter en kontakt til et selskap", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: "Contoso AS" });
    const contact = await service.createContact(TENANT_A, "business", { name: "Kari Nordmann", company_id: company.company_id, email: "kari@contoso.no" });
    expect(contact.company_id).toBe(company.company_id);
  });
});

describe("C: lead/opportunity-livssyklus", () => {
  it("oppretter en lead, konverterer til opportunity, flytter gjennom pipeline-stadier", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: "Fjord Consulting" });
    const lead = await service.createLead(TENANT_A, "business", { title: "Interessert i tjeneste X", company_id: company.company_id });
    expect(lead.status).toBe("new");
    const converted = await service.updateLeadStatus(TENANT_A, "business", lead.lead_id, "converted");
    expect(converted?.status).toBe("converted");
    const opp = await service.createOpportunity(TENANT_A, "business", { title: "Fjord - tjeneste X", company_id: company.company_id, lead_id: lead.lead_id, value_ore: 5_000_00 });
    expect(opp.stage).toBe("new");
    const qualified = await service.updateOpportunityStage(TENANT_A, "business", opp.opportunity_id, "qualified");
    expect(qualified?.stage).toBe("qualified");
    const won = await service.updateOpportunityStage(TENANT_A, "business", opp.opportunity_id, "won");
    expect(won?.stage).toBe("won");
  });
});

describe("D: idempotent lead/aktivitet-ingestion", () => {
  it("samme (source_type, source_instance_id, external_id) for en lead gir samme rad, ikke en ny", async () => {
    const first = await service.createLead(TENANT_A, "business", {
      title: "Webskjema-lead", source_type: "webform", source_instance_id: "site:acme", external_id: "form-123"
    });
    const second = await service.createLead(TENANT_A, "business", {
      title: "Webskjema-lead (duplikat-hendelse)", source_type: "webform", source_instance_id: "site:acme", external_id: "form-123"
    });
    expect(second.lead_id).toBe(first.lead_id);
  });

  it("samme eksterne aktivitets-hendelse re-prosesseres trygt - ingen duplikat-rad", async () => {
    const first = await service.recordActivity(TENANT_A, "business", {
      activity_type: "email", summary: "Kunde spurte om pris",
      source_type: "gmail", source_instance_id: "inbox:acme", external_id: "msg-abc"
    });
    const second = await service.recordActivity(TENANT_A, "business", {
      activity_type: "email", summary: "Kunde spurte om pris (re-sync)",
      source_type: "gmail", source_instance_id: "inbox:acme", external_id: "msg-abc"
    });
    expect(second.activity_id).toBe(first.activity_id);
  });
});

describe("E: aktivitetstidslinje", () => {
  it("'hva skjer med kunde X?' - komplett tidslinje sortert nyest først", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: "Nordlys Handel" });
    await service.recordActivity(TENANT_A, "business", { activity_type: "note", summary: "Første kontakt", company_id: company.company_id, occurred_at: "2026-08-01T10:00:00Z" });
    await service.recordActivity(TENANT_A, "business", { activity_type: "call", summary: "Oppfølgingssamtale", company_id: company.company_id, occurred_at: "2026-08-10T10:00:00Z" });
    const timeline = await service.companyTimeline(TENANT_A, "business", company.company_id);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.summary).toBe("Oppfølgingssamtale");
    expect(timeline[1]?.summary).toBe("Første kontakt");
  });
});

describe("F/G: oppfoelging-opprettelse og fullføring", () => {
  it("oppretter og fullfører en oppfoelging", async () => {
    const followup = await service.createFollowup(TENANT_A, "business", { title: "Send tilbud", due_at: "2026-08-20T09:00:00Z" });
    expect(followup.status).toBe("open");
    const completed = await service.completeFollowup(TENANT_A, "business", followup.followup_id);
    expect(completed?.status).toBe("completed");
    expect(completed?.completed_at).toBeTruthy();
  });

  it("avbryter en åpen oppfoelging", async () => {
    const followup = await service.createFollowup(TENANT_A, "business", { title: "Ring kunde", due_at: "2026-08-21T09:00:00Z" });
    const cancelled = await service.cancelFollowup(TENANT_A, "business", followup.followup_id);
    expect(cancelled?.status).toBe("cancelled");
  });

  it("fullføring av en allerede lukket oppfoelging er en no-op (ingen dobbel tilstandsovergang)", async () => {
    const followup = await service.createFollowup(TENANT_A, "business", { title: "Engangsoppgave", due_at: "2026-08-22T09:00:00Z" });
    await service.completeFollowup(TENANT_A, "business", followup.followup_id);
    const secondAttempt = await service.completeFollowup(TENANT_A, "business", followup.followup_id);
    expect(secondAttempt).toBeNull();
  });
});

describe("H: forfalt/due-spørring", () => {
  it("lister kun forfalte, åpne oppfoelginger - ikke fremtidige eller lukkede", async () => {
    await service.createFollowup(TENANT_A, "business", { title: "Forfalt oppgave", due_at: "2020-01-01T00:00:00Z" });
    const future = await service.createFollowup(TENANT_A, "business", { title: "Fremtidig oppgave", due_at: "2099-01-01T00:00:00Z" });
    const closed = await service.createFollowup(TENANT_A, "business", { title: "Lukket forfalt oppgave", due_at: "2020-01-01T00:00:00Z" });
    await service.completeFollowup(TENANT_A, "business", closed.followup_id);

    const overdue = await service.overdueFollowups(TENANT_A, "business");
    const titles = overdue.map((f) => f.title);
    expect(titles).toContain("Forfalt oppgave");
    expect(titles).not.toContain(future.title);
    expect(titles).not.toContain("Lukket forfalt oppgave");
  });
});

describe("I: kilde-peker-lenking (ALDRI kopi av fullt innhold)", () => {
  it("lagrer canonical_uri som peker, ikke kopi - aktivitetens summary er kort/strukturert", async () => {
    const activity = await service.recordActivity(TENANT_A, "business", {
      activity_type: "document", summary: "Kontraktsutkast mottatt",
      canonical_uri: "drive://file/abc123", source_type: "drive", source_instance_id: "drive:acme", external_id: "abc123"
    });
    expect(activity.canonical_uri).toBe("drive://file/abc123");
    expect(activity.summary.length).toBeLessThan(200);
  });
});

describe("K: kunde/deal-tilstandsoppdatering", () => {
  it("oppdaterer opportunity-stage idempotent (samme stage to ganger endrer ikke identitet)", async () => {
    const opp = await service.createOpportunity(TENANT_A, "business", { title: "Idempotent stage-test" });
    const first = await service.updateOpportunityStage(TENANT_A, "business", opp.opportunity_id, "proposal");
    const second = await service.updateOpportunityStage(TENANT_A, "business", opp.opportunity_id, "proposal");
    expect(first?.opportunity_id).toBe(second?.opportunity_id);
    expect(second?.stage).toBe("proposal");
  });
  // HOST FIX #1 (D-75): før dette var det INGEN kanonisk, RLS-trygg vei til å
  // sette value_ore ved lukking - UA-4-akseptansescriptet brukte derfor en rå
  // pool.query() UPDATE som stille traff 0 rader under FORCE RLS (ingen
  // jarvis.tenant_id/jarvis.memory_spaces-sesjonskontekst satt). Dette beviser
  // at den ekte kanoniske lifecycle-metoden nå setter BÅDE stage og value_ore.
  it("oppdaterer stage OG value_ore sammen naar en deal lukkes som 'won' (RLS-trygg via withMemoryTransaction)", async () => {
    const opp = await service.createOpportunity(TENANT_A, "business", { title: "Won med endelig verdi", value_ore: 100_000 });
    const won = await service.updateOpportunityStage(TENANT_A, "business", opp.opportunity_id, "won", 500_000);
    expect(won?.stage).toBe("won");
    expect(won?.value_ore).toBe(500_000);
  });
  it("value_ore forblir uendret naar valueOre-parameteret utelates (kun stage endres)", async () => {
    const opp = await service.createOpportunity(TENANT_A, "business", { title: "Stage uten verdiendring", value_ore: 42_000 });
    const moved = await service.updateOpportunityStage(TENANT_A, "business", opp.opportunity_id, "qualified");
    expect(moved?.stage).toBe("qualified");
    expect(moved?.value_ore).toBe(42_000);
  });
});

describe("L: cross-tenant-tilgang nektes (RLS)", () => {
  it("tenant B kan IKKE se tenant A sitt selskap - RLS håndhevet i databasen, ikke bare i app-koden", async () => {
    const companyA = await service.createCompany(TENANT_A, "business", { name: "Kun for A" });
    const rows = await withMemoryTransaction(appPool, TENANT_B, ["business"], (client) =>
      client.query("SELECT * FROM business_companies WHERE company_id = $1", [companyA.company_id])
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("tenant B sin egen metrics-spørring ser aldri tenant A sine tall", async () => {
    await service.createLead(TENANT_A, "business", { title: "A-lead" });
    const metricsB = await service.metrics(TENANT_B, "business");
    expect(metricsB.open_leads).toBe(0);
  });
});

describe("M: memory-space-isolasjon", () => {
  it("et selskap i 'business'-space er usynlig fra en 'personal'-space-spørring i samme tenant", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: "Space-isolert selskap" });
    const rows = await withMemoryTransaction(appPool, TENANT_A, ["personal"], (client) =>
      client.query("SELECT * FROM business_companies WHERE company_id = $1", [company.company_id])
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe("S/T: Q-20-interaksjon (strukturelt bevist - ingen FK til knowledge_documents)", () => {
  it("business_activities har INGEN fremmednøkkel-kolonne mot knowledge_documents - en Q-20-sletting av kildedokumentet kan derfor aldri cascade-slette eller feile mot en aktivitet", async () => {
    const { rows } = await adminPool.query(
      `SELECT count(*)::int AS n FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
       WHERE tc.table_name = 'business_activities' AND tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'knowledge_documents'`
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it("en aktivitet med canonical_uri overlever uendret selv om ingen knowledge_document med den URI-en finnes (løs peker, ikke cascade)", async () => {
    const activity = await service.recordActivity(TENANT_A, "business", {
      activity_type: "document", summary: "Peker til slettet/aldri-eksisterende dokument",
      canonical_uri: "drive://file/never-existed-or-erased"
    });
    const { rows } = await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("SELECT canonical_uri FROM business_activities WHERE activity_id = $1", [activity.activity_id])
    );
    expect((rows[0] as { canonical_uri: string }).canonical_uri).toBe("drive://file/never-existed-or-erased");
  });
});

describe("U: samtidig oppdatering / idempotency_key-sikkerhet", () => {
  it("to parallelle createFollowup-kall med SAMME idempotency_key gir kun én rad", async () => {
    const key = "dedupe-key-parallel-1";
    const [a, b] = await Promise.all([
      service.createFollowup(TENANT_A, "business", { title: "Parallell A", due_at: "2026-09-01T00:00:00Z", idempotency_key: key }),
      service.createFollowup(TENANT_A, "business", { title: "Parallell B", due_at: "2026-09-01T00:00:00Z", idempotency_key: key })
    ]);
    expect(a.followup_id).toBe(b.followup_id);
    const { rows } = await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("SELECT count(*)::int AS n FROM business_followups WHERE tenant_id = $1 AND idempotency_key = $2", [TENANT_A, key])
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});

describe("W: ingen direkte modell-leverandør-bypass (strukturelt)", () => {
  it("BusinessService importerer aldri en provider-SDK eller ModelGateway direkte", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/service.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/@jarvis\/model-gateway|@jarvis\/provider-adapters|openai|anthropic/i);
  });
});
