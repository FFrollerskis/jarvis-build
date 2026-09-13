import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { BusinessService } from "@jarvis/business";
import { SupportCrossScopeReferenceError, SupportService } from "@jarvis/support";
import { AgreementsCrossScopeReferenceError, AgreementsService } from "@jarvis/agreements";

/**
 * UA-3 akseptansekriterium 1 ("Hva skjer med kunde X?") - HOST FIX, ekte
 * ende-til-ende-bevis: dette er den EGENTLIGE kriterium-1-proofen. Testen
 * kaller den EKTE `BusinessService.companyTimeline()` (samme metode
 * `apps/api` allerede eksponerer produktivt) for et selskap som har EN sales-
 * aktivitet (den EKSISTERENDE `recordActivity()`-veien, f.eks.
 * Gmail/Calendar-synk), EN support-ticket (den NYE veien i
 * `modules/support/src/service.ts`) og EN kontrakt (den NYE veien i
 * `modules/agreements/src/service.ts`) - og beviser at alle tre er synlige,
 * korrekt typet og korrekt sortert i ÉTT samlet tidslinjesvar. Ligger i
 * `apps/api` (IKKE i `modules/business|support|agreements`) fordi dette er
 * det ENESTE eksisterende workspace-paketet som allerede har `@jarvis/
 * business`, `@jarvis/support` OG `@jarvis/agreements` som deklarerte
 * avhengigheter samtidig (SAMME komposisjon som `apps/api/src/main.ts`/
 * `worker-main.ts` allerede bruker i produksjon) - ingen ny avhengighet lagt
 * til noe sted for aa faa denne testen til aa kompilere.
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let business: BusinessService;
let support: SupportService;
let agreements: AgreementsService;

const TENANT_A = "tenant-ua3-tl-e2e-a";
// Arkitekt-review MERGE BLOCKER B (Q-33/D-130, PR #79): egen, urelatert
// tenant KUN for kryss-tenant-avvisningstesten under (describe H) - beviser
// at Q-33-vakten er wired inn i den SAMME komposisjonsroten som
// `apps/api/src/main.ts`/`worker-main.ts` faktisk bruker i produksjon
// (BEGGE tjenester konstruert fra ÉN delt `pool`, se `beforeAll` under).
const TENANT_B = "tenant-ua3-tl-e2e-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-ua3-timeline-e2e-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_ua3_tl_e2e_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_ua3_tl_e2e_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'UA-3 Timeline E2E A', 'business'), ('${TENANT_B}', 'UA-3 Timeline E2E B', 'business')`
  );
  await adminPool.query(`INSERT INTO business_companies (company_id, tenant_id, name) VALUES ('co-ua3-tl-e2e', '${TENANT_A}', 'Acme AS')`);
  await adminPool.query(
    `INSERT INTO business_contacts (contact_id, tenant_id, company_id, name, email) VALUES ('ct-ua3-tl-e2e', '${TENANT_A}', 'co-ua3-tl-e2e', 'Kari', 'kari@acme.no')`
  );
  // Q-33: en company i TENANT_B - brukes KUN til aa bevise at TENANT_A ALDRI
  // kan referere den (describe H under).
  await adminPool.query(`INSERT INTO business_companies (company_id, tenant_id, name) VALUES ('co-ua3-tl-e2e-b', '${TENANT_B}', 'Globex AS')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_ua3_tl_e2e_test", password: "pw2" });
  business = new BusinessService(appPool);
  support = new SupportService(appPool);
  agreements = new AgreementsService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("G: 'Hva skjer med kunde X?' - komplett, kilde-forankret tidslinje", () => {
  it("companyTimeline() viser sales-aktivitet + support-ticket + kontrakt sammen, korrekt typet og sortert", async () => {
    // 1) Sales-aktivitet: DEN EKSISTERENDE `recordActivity()`-veien (samme
    //    mekanisme som `business-event-sync.ts` bruker for Gmail/Calendar) -
    //    urørt av denne byggeordren, kun brukt her som fikspunkt.
    await business.recordActivity(TENANT_A, "business", {
      activity_type: "meeting",
      summary: "Møte: Kvartalsgjennomgang",
      company_id: "co-ua3-tl-e2e",
      source_type: "calendar",
      source_instance_id: "acct-e2e",
      external_id: "evt-e2e-1",
      occurred_at: "2026-01-10T09:00:00Z"
    });

    // 2) Support-ticket: DEN NYE veien (modules/support/src/service.ts).
    const ticket = await support.createTicket(TENANT_A, "business", {
      subject: "Faktura-avvik", company_id: "co-ua3-tl-e2e", occurred_at: "2026-01-12T10:00:00Z"
    });
    await support.setStatus(TENANT_A, "business", ticket.ticket_id, "resolved");

    // 3) Kontrakt: DEN NYE veien (modules/agreements/src/service.ts).
    const contract = await agreements.createContract(TENANT_A, "business", {
      title: "Fornyet driftsavtale", company_id: "co-ua3-tl-e2e"
    });

    const timeline = await business.companyTimeline(TENANT_A, "business", "co-ua3-tl-e2e");

    const sales = timeline.find((e) => e.summary === "Møte: Kvartalsgjennomgang");
    const ticketCreated = timeline.find((e) => e.activity_type === "external_event" && e.summary.includes("Faktura-avvik"));
    const contractCreated = timeline.find((e) => e.summary.includes("Fornyet driftsavtale"));

    // Alle tre kilde-domener er representert - AC1 sitt kjernekrav.
    expect(sales).toBeDefined();
    expect(sales?.activity_type).toBe("meeting");
    expect(ticketCreated).toBeDefined();
    expect(ticketCreated?.activity_type).toBe("external_event");
    expect(ticketCreated?.canonical_uri).toBe(`jarvis:support_ticket:${ticket.ticket_id}`);
    expect(contractCreated).toBeDefined();
    expect(contractCreated?.activity_type).toBe("external_event");
    expect(contractCreated?.canonical_uri).toBe(`jarvis:contract:${contract.contract_id}`);
    // Ticket-statusovergangen (resolved) er sin EGEN, distinkte post - ikke
    // sammenslaatt med opprettelsen.
    const statusChange = timeline.find((e) => e.activity_type === "status_change" && e.summary.includes("-> resolved"));
    expect(statusChange).toBeDefined();
    expect(statusChange?.activity_id).not.toBe(ticketCreated?.activity_id);

    // Deterministisk, stabil sortering: `companyTimeline()` sorterer
    // `occurred_at DESC` - beviser at UNIONEN av alle tre kilder faktisk
    // deler ÉN konsistent, kronologisk rekkefoelge, ikke tre losrevne lister.
    const occurredTimestamps = timeline.map((e) => new Date(e.occurred_at).getTime());
    const sorted = [...occurredTimestamps].sort((a, b) => b - a);
    expect(occurredTimestamps).toEqual(sorted);

    expect(timeline.length).toBeGreaterThanOrEqual(4);
  });
});

/**
 * Arkitekt-review MERGE BLOCKER B (Q-33/D-130, PR #79): SAMME ende-til-ende
 * komposisjon som describe G over (SupportService/AgreementsService/
 * BusinessService konstruert fra ÉN delt `pool`, identisk med
 * `apps/api/src/main.ts`/`worker-main.ts` i produksjon) - beviser at
 * `assertCompanyContactInScope()`-vakten faktisk virker i DEN wiringen
 * appen ekte kjoerer, ikke bare isolert i modul-testene
 * (`support-timeline-atomicity.test.ts`/`agreements-timeline-atomicity.test.ts`,
 * som beviser samme oppførsel mer utfoerlig per modul).
 */
describe("H: Q-33 - kryss-tenant company_id avvises i den SAMME komposisjonsroten produksjonen bruker", () => {
  it("SupportService.createTicket() avviser TENANT_B sin company_id fra TENANT_A - INGEN ticket-rad opprettes", async () => {
    await expect(
      support.createTicket(TENANT_A, "business", { subject: "E2E-Cross-Tenant-Ticket", company_id: "co-ua3-tl-e2e-b" })
    ).rejects.toThrow(SupportCrossScopeReferenceError);
    const rows = await adminPool.query(`SELECT 1 FROM support_tickets WHERE tenant_id = $1 AND subject = $2`, [TENANT_A, "E2E-Cross-Tenant-Ticket"]);
    expect(rows.rows).toHaveLength(0);
  });

  it("AgreementsService.createContract() avviser TENANT_B sin company_id fra TENANT_A - INGEN kontrakt-rad opprettes", async () => {
    await expect(
      agreements.createContract(TENANT_A, "business", { title: "E2E-Cross-Tenant-Kontrakt", company_id: "co-ua3-tl-e2e-b" })
    ).rejects.toThrow(AgreementsCrossScopeReferenceError);
    const rows = await adminPool.query(`SELECT 1 FROM contracts WHERE tenant_id = $1 AND title = $2`, [TENANT_A, "E2E-Cross-Tenant-Kontrakt"]);
    expect(rows.rows).toHaveLength(0);
  });
});
