import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { withMemoryTransaction } from "@jarvis/memory";
import { DailyBrief } from "@jarvis/tool-gateway";
import type { BriefItem, BriefSource } from "@jarvis/tool-gateway";
import { BusinessService } from "../src/service.ts";
import { OpenLoopService } from "../src/open-loop-service.ts";
import { BusinessTransport } from "../src/transport.ts";
import { BUSINESS_DOMAIN_COVERAGE, businessOpenLoopsSource, generateWeeklyBrief, renderDomainCoverage, renderWeeklyBrief } from "../src/business-brief.ts";

/**
 * UA-3 next slice (D-53) §13/§15: business-brief-testmatrise. Daglig brief
 * gjenbruker EKSISTERENDE DailyBrief-motor uendret (kun en ny BriefSource);
 * ukentlig brief er en egen, liten, kilde-forankret aggregeringsfunksjon.
 * Begge MÅ rapportere manglende domenedekning ærlig (§15) - aldri fabrikkere
 * data for product/finance/marketing/operations.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let business: BusinessService;
let openLoops: OpenLoopService;

const TENANT_A = "tenant-brief-a";
const TENANT_B = "tenant-brief-b";
const identityA: IdentityContext = {
  person_id: "system", tenant_id: TENANT_A, memory_space_id: "business",
  session_id: "sess-brief-a", device_id: "jarvis-core", channel: "api", auth_strength: "active"
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-business-brief-"));
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
  await adminPool.query("CREATE ROLE jarvis_brief_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_brief_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-a-business','${TENANT_A}','business'), ('ms-b-business','${TENANT_B}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_brief_test", password: "pw2" });
  business = new BusinessService(appPool);
  openLoops = new OpenLoopService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: daglig brief - gjenbruker EKSISTERENDE DailyBrief-motor via en ny BriefSource", () => {
  it("aapne open loops dukker opp som brief-punkter med kilde-forankret 'why'", async () => {
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Brief-test oppfoelging", due_at: "2020-01-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    const loop = (await openLoops.listOpenLoops(TENANT_A, "business", "open")).find((l) => l.followup_id === followup.followup_id);
    const dailyBrief = new DailyBrief([businessOpenLoopsSource(openLoops)], appPool);
    const artifact = await dailyBrief.generate(identityA);
    // Forfalt => tittel prefikset "OVERDUE" => havner i "today"-bøtten (samme regel som andre kilder).
    const item = artifact.today.find((i) => i.ref === loop?.open_loop_id);
    expect(item).toBeTruthy();
    expect(item?.why).toContain("Brief-test oppfoelging");
  });

  it("ingen aapne loops gir en tom, aerlig brief - ikke oppdiktede punkter", async () => {
    const dailyBrief = new DailyBrief([businessOpenLoopsSource(openLoops)], appPool);
    const artifact = await dailyBrief.generate({
      person_id: "system", tenant_id: TENANT_B, memory_space_id: "business",
      session_id: "sess-brief-b-empty", device_id: "jarvis-core", channel: "api", auth_strength: "active"
    });
    const allBuckets = [
      ...artifact.top_priorities, ...artifact.today, ...artifact.needs_attention,
      ...artifact.follow_ups, ...artifact.build_status, ...artifact.fyi
    ];
    expect(allBuckets.filter((i) => i.source === "business-open-loops")).toHaveLength(0);
  });
});

describe("B: ukentlig brief - egen, kilde-forankret aggregering (ikke en andre motor)", () => {
  it("teller aapnede/loeste loops og flyttede opportunities i 7-dagers vinduet, korrekt tenant-scoped", async () => {
    const followup = await business.createFollowup(TENANT_A, "business", { title: "Ukentlig-test", due_at: "2020-02-01T00:00:00Z" });
    await openLoops.detectOverdueFollowups(TENANT_A, "business");
    await openLoops.resolveOpenLoop(
      TENANT_A, "business",
      (await openLoops.listOpenLoops(TENANT_A, "business", "open")).find((l) => l.followup_id === followup.followup_id)!.open_loop_id,
      "ukentlig-test-resolusjon"
    );
    const opp = await business.createOpportunity(TENANT_A, "business", { title: "Flyttet denne uken" });
    await business.updateOpportunityStage(TENANT_A, "business", opp.opportunity_id, "qualified");

    const weekly = await generateWeeklyBrief(appPool, TENANT_A, "business");
    expect(weekly.tenant_id).toBe(TENANT_A);
    expect(weekly.resolved_loops).toBeGreaterThanOrEqual(1);
    expect(weekly.opportunities_moved.some((o) => o.opportunity_id === opp.opportunity_id)).toBe(true);
  });

  it("tenant B sin ukentlige brief inneholder aldri tenant A sine tall", async () => {
    const weeklyB = await generateWeeklyBrief(appPool, TENANT_B, "business");
    expect(weeklyB.opened_loops).toBe(0);
    expect(weeklyB.opportunities_moved).toHaveLength(0);
  });

  it("renderWeeklyBrief() produserer lesbar tekst som inkluderer domenedekning", async () => {
    const weekly = await generateWeeklyBrief(appPool, TENANT_B, "business");
    const rendered = renderWeeklyBrief(weekly);
    expect(rendered).toContain("JARVIS BUSINESS WEEKLY BRIEF");
    expect(rendered).toContain("DATA COVERAGE");
  });

  // D-78: den ukentlige brief-artefakten sitt `data_coverage`-felt maa faktisk reflektere den
  // oppdaterte kartleggingen (ikke en separat, frosset kopi) - OG dekningen er en arkitektonisk
  // (build-time) fakta, ikke tenant-data, saa den er IDENTISK for begge tenantene (bevisst, ikke
  // en tenant-isolasjonsfeil - se filkommentaren i business-brief.ts).
  it("weekly.data_coverage reflekterer marketing/finance/product=available (Growth Core/Finance Gateway/Product Core) for ALLE tenants likt - domenedekning er arkitektur, ikke tenant-data", async () => {
    const weeklyA = await generateWeeklyBrief(appPool, TENANT_A, "business");
    const weeklyB = await generateWeeklyBrief(appPool, TENANT_B, "business");
    expect(weeklyA.data_coverage.marketing.status).toBe("available");
    expect(weeklyB.data_coverage.marketing.status).toBe("available");
    expect(weeklyA.data_coverage.finance.status).toBe("available");
    expect(weeklyB.data_coverage.finance.status).toBe("available");
    expect(weeklyA.data_coverage.product.status).toBe("available");
    expect(weeklyB.data_coverage.product.status).toBe("available");
    expect(weeklyA.data_coverage).toEqual(weeklyB.data_coverage);
    expect(weeklyA.data_coverage.sales.status).toBe("available");
    expect(weeklyA.data_coverage.operations.status).toBe("available");
  });
});

// D-78 CI-akseptanse (avløser manuell host-kjøring for DENNE sliceen - se
// docs/DECISIONS_AND_ASSUMPTIONS.md D-78-oppdateringen "CI-AKSEPTANSE
// ERSTATTER MANUELL HOST-KJØRING"): beviser at Business OS-tidslinjen
// (`business_activities`, akseptansekriterium 1: "hva skjer med kunde X?")
// er UPÅVIRKET av at en Native Growth Core-kampanje (`marketing_campaigns`)
// eksisterer i samme tenant - ingen tabell-krysskontaminering, ingen
// regresjon i den eksisterende §9-tidslinjefunksjonen fra at marketing nå
// rapporteres tilgjengelig.
describe("E: Business OS-tidslinje-regresjon (D-78 - Growth Core sameksistens)", () => {
  it("selskapstidslinjen returnerer KUN sine egne aktiviteter, uendret av en samtidig marketing-kampanje i samme tenant", async () => {
    const company = await business.createCompany(TENANT_A, "business", { name: "D-78 Tidslinje AS" });
    await business.recordActivity(TENANT_A, "business", {
      activity_type: "note", summary: "D-78 tidslinje-regresjonstest",
      company_id: company.company_id, occurred_at: "2026-08-15T09:00:00Z"
    });

    // Samme rå-SQL-mønster som open-loop-growth.test.ts - `@jarvis/business`
    // importerer bevisst ALDRI `@jarvis/growth` (domenegrense).
    const campaignId = `grw-cm-${randomUUID()}`;
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query(
        `INSERT INTO marketing_campaigns (campaign_id, tenant_id, memory_space_id, channel, name, status, owner_person_id)
         VALUES ($1, $2, 'business', 'google_ads', $3, 'active', 'person-tobias')`,
        [campaignId, TENANT_A, `D-78 kampanje ${campaignId}`]
      )
    );

    const timeline = await business.companyTimeline(TENANT_A, "business", company.company_id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.summary).toBe("D-78 tidslinje-regresjonstest");

    const weekly = await generateWeeklyBrief(appPool, TENANT_A, "business");
    expect(weekly.data_coverage.marketing.status).toBe("available");
  });
});

describe("C: §15 aerlighet - akseptansekriterium 2 ('sales, product, finance, marketing, operations') er NÅ dekket for alle fem domener (D-129)", () => {
  // UA-4 Growth -> Business Domain Coverage-integrasjon (D-78): `marketing` gikk fra
  // `not_integrated` til `available` FORDI Native Jarvis Growth Core (D-74/D-75/D-76/D-77) nå
  // faktisk finnes - IKKE en fabrikkert/kosmetisk endring.
  // D-127: `finance` gikk fra `not_integrated` til `available` av SAMME grunn - UA-6 Finance &
  // Spend Integrity Gateway sin interne implementasjon/arkitektur var allerede komplett/
  // verifisert (UA6_IMPLEMENTATION_COMPLETE=true, UA6_ARCHITECTURE_ACCEPTANCE_COMPLETE=true,
  // D-107-D-118) - MEN live leverandørverifisering/D-108-credentials gjenstår fortsatt
  // (UA6_LIVE_PROVIDER_VERIFICATION_COMPLETE=false, uendret av D-127) - og dens
  // avviksdeteksjon var allerede overflatert som `business_open_loops` (open-loop-finance-
  // spend.test.ts) som SAMME `businessOpenLoopsSource()` under allerede viser i denne briefen -
  // PÅSTANDEN var usann, ikke kapabiliteten.
  // D-128: `product` gikk fra `not_integrated` til `available` av et ANNET mønster enn D-78/D-127
  // - her fantes INGEN eksisterende kapabilitet fra før; en genuint ny JARVIS_CANONICAL Product
  // Core (`@jarvis/product`) ble bygget, med samme rapportør-/OpenLoopService-mønster som
  // Support/Contracts Core.
  // D-129: `operations` gikk fra `not_integrated` til `available` av SAMME mønster som D-128 -
  // ingen eksisterende kapabilitet fantes (D-64-gaten bekreftet at `finance_vendors`/
  // `modules/incidents`/`modules/watchdog` IKKE dekker business-operations); en genuint ny
  // JARVIS_CANONICAL Operations Core (`@jarvis/operations`) ble bygget for
  // leverandører/driftsoppgaver/runbooks/eskalering (masterplan §13).
  it("BUSINESS_DOMAIN_COVERAGE markerer sales OG marketing OG finance OG product OG operations som tilgjengelig - aldri fabrikkert", () => {
    expect(BUSINESS_DOMAIN_COVERAGE.sales.status).toBe("available");
    expect(BUSINESS_DOMAIN_COVERAGE.marketing.status).toBe("available");
    expect(BUSINESS_DOMAIN_COVERAGE.finance.status).toBe("available");
    expect(BUSINESS_DOMAIN_COVERAGE.product.status).toBe("available");
    expect(BUSINESS_DOMAIN_COVERAGE.operations.status).toBe("available");
  });

  it("marketing sin dekning er eksplisitt begrunnet i Native Growth Core, ALDRI en leverandør-tilkobling", () => {
    expect(BUSINESS_DOMAIN_COVERAGE.marketing.source).toMatch(/Growth Core/);
    // Domenekapabilitet (status) og ekstern leverandør-tilkobling (live_provider_connected) er
    // BEVISST separate felt - denne sliceen kobler INGEN live annonseplattform til noe.
    expect(BUSINESS_DOMAIN_COVERAGE.marketing.live_provider_connected).toBe(false);
  });

  it("finance sin dekning er eksplisitt begrunnet i Finance & Spend Integrity Gateway, ALDRI en bank-/regnskapsleverandør-tilkobling", () => {
    expect(BUSINESS_DOMAIN_COVERAGE.finance.source).toMatch(/Finance & Spend Integrity Gateway/);
    // Samme separasjon som marketing (D-78): domenekapabilitet != ekstern leverandør-tilkobling.
    // Wallester/Stripe/Vipps/Fiken/Neonomics-adapterne er allerede implementert i UA-6 på
    // arkitektur-/kode-nivå (UA6_ARCHITECTURE_ACCEPTANCE_COMPLETE=true) - IKKE at deres live
    // credentials er verifisert (UA6_LIVE_PROVIDER_VERIFICATION_COMPLETE=false, uendret her).
    // DENNE briefen hevder ikke live tilkobling - kun at Jarvis kan rapportere avvik den selv har oppdaget.
    expect(BUSINESS_DOMAIN_COVERAGE.finance.live_provider_connected).toBe(false);
  });

  it("product sin dekning er eksplisitt begrunnet i Native Product Core, ALDRI en issue-tracker-/analytics-leverandør-tilkobling", () => {
    expect(BUSINESS_DOMAIN_COVERAGE.product.source).toMatch(/Product Core/);
    // Samme separasjon som marketing/finance: domenekapabilitet != ekstern leverandør-tilkobling.
    // Linear/Jira/GitHub Issues er en FREMTIDIG, valgfri adapter, aldri domeneeier (D-64) - denne
    // briefen hevder ikke live tilkobling, kun at Jarvis kan rapportere produktpunkter den selv sporer.
    expect(BUSINESS_DOMAIN_COVERAGE.product.live_provider_connected).toBe(false);
  });

  it("sales sin dekning er uendret av denne sliceen (ingen regresjon)", () => {
    expect(BUSINESS_DOMAIN_COVERAGE.sales).toEqual({ status: "available", source: "Business Graph/CRM", live_provider_connected: false });
  });

  it("operations sin dekning er eksplisitt begrunnet i Native Operations Core, ALDRI en driftsplattform-leverandør-tilkobling", () => {
    expect(BUSINESS_DOMAIN_COVERAGE.operations.source).toMatch(/Operations Core/);
    // Samme separasjon som marketing/finance/product: domenekapabilitet != ekstern leverandør-tilkobling.
    expect(BUSINESS_DOMAIN_COVERAGE.operations.live_provider_connected).toBe(false);
  });

  it("renderDomainCoverage() sier eksplisitt fra at alle 5 domener er dekket, OG nevner marketing/finance/product/operations som tilgjengelig uten aa hevde en live leverandør", () => {
    const text = renderDomainCoverage();
    expect(text).toContain("dekket for alle 5/5 domener");
    expect(text).not.toContain("IKKE integrert");
    expect(text).toContain("marketing: tilgjengelig");
    expect(text).toContain("finance: tilgjengelig");
    expect(text).toContain("product: tilgjengelig");
    expect(text).toContain("operations: tilgjengelig");
    expect(text).toContain("ingen live ekstern leverandør tilkoblet");
  });

  it("renderDomainCoverage() er 100% deterministisk (samme resultat ved gjentatte kall, ingen DB/klokke-avhengighet)", () => {
    expect(renderDomainCoverage()).toBe(renderDomainCoverage());
  });

  // D-64/Section 9-krav: denne sliceen skal STRUKTURELT bevise at domenekapabiliteten aldri
  // krever en annonseplattform-credential - ingen leverandør er koblet inn for å faa
  // `marketing.status = "available"`.
  it("business-brief.ts krever INGEN annonseplattform-credential/SDK for aa markere marketing tilgjengelig", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/business-brief.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/GOOGLE_ADS|META_ADS|GA4|SEARCH_CONSOLE|FACEBOOK_ADS|LINKEDIN_ADS|TIKTOK_ADS/i);
  });

  // D-127 (samme disiplin som D-78 over, men for finance-leverandører): ingen bank-/
  // betalings-/regnskapsleverandør-credential-formet streng skal noensinne trenge å stå i
  // DENNE filen for at `finance.status = "available"` skal være sant - business-brief.ts
  // importerer aldri `@jarvis/finance` og kjenner ingen leverandør-SDK.
  it("business-brief.ts krever INGEN bank-/betalings-/regnskapsleverandør-credential/SDK for aa markere finance tilgjengelig", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/business-brief.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/STRIPE|VIPPS|WALLESTER|FIKEN|NEONOMICS/i);
    expect(source).not.toMatch(/@jarvis\/finance/);
  });

  // D-128 (samme disiplin som D-78/D-127 over, men for produkt-analytics-/issue-tracker-
  // leverandører): ingen slik leverandør-credential-formet streng skal noensinne trenge å stå i
  // DENNE filen for at `product.status = "available"` skal være sant - business-brief.ts
  // importerer aldri `@jarvis/product` og kjenner ingen leverandør-SDK.
  it("business-brief.ts krever INGEN produkt-analytics-/issue-tracker-leverandør-credential/SDK for aa markere product tilgjengelig", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/business-brief.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/LINEAR|JIRA|MIXPANEL|AMPLITUDE|POSTHOG/i);
    expect(source).not.toMatch(/@jarvis\/product/);
  });

  // D-129 (samme disiplin som D-78/D-127/D-128 over, men for driftsplattform-leverandører):
  // ingen slik leverandør-credential-formet streng skal noensinne trenge å stå i DENNE filen
  // for at `operations.status = "available"` skal være sant - business-brief.ts importerer
  // aldri `@jarvis/operations` og kjenner ingen leverandør-SDK.
  it("business-brief.ts krever INGEN driftsplattform-/ticketing-leverandør-credential/SDK for aa markere operations tilgjengelig", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/business-brief.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/SERVICENOW|NOTION|JIRA|ATLASSIAN/i);
    expect(source).not.toMatch(/@jarvis\/operations/);
  });
});

describe("G (D-127): finance-avledede open loops overflater i Business OS-briefen via SAMME businessOpenLoopsSource() som sales", () => {
  // Beviser EMPIRISK, ikke bare via BUSINESS_DOMAIN_COVERAGE-paastanden over, at finance
  // sin dekning er reell: en ekte `finance_spend_records`-avviksrad (identisk fixture-form som
  // `open-loop-finance-spend.test.ts` §A) -> OpenLoopService.detectUnexpectedSpend() ->
  // `finance_spend_unexpected`-open-loop -> businessOpenLoopsSource() -> DailyBrief-punkt.
  // INGEN ny BriefSource bygget her - dette er den EKSISTERENDE `businessOpenLoopsSource()`
  // (§13/D-53), som allerede haandterer ENHVER open_loop_type generisk. Testen beviser at
  // finance-opprinnelse ikke er noe spesialtilfelle den faller utenfor.
  it("en finance_spend_unexpected-open-loop dukker opp som et brief-punkt, med finansielt kilde-forankret 'why'", async () => {
    const spendRecordId = `fin-sr-brief-${randomUUID()}`;
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query(
        `INSERT INTO finance_spend_records
           (spend_record_id, tenant_id, memory_space_id, source_family, source_record_id, occurred_at, amount_ore, currency, category, anomaly_flags)
         VALUES ($1, $2, 'business', 'model_cost', $1, now(), 12345, 'NOK', 'ai_api_cost', $3)`,
        [spendRecordId, TENANT_A, JSON.stringify(["UNEXPECTED_SPEND"])]
      )
    );
    const detection = await openLoops.detectUnexpectedSpend(TENANT_A, "business");
    expect(detection.detected).toBeGreaterThanOrEqual(1);

    const dailyBrief = new DailyBrief([businessOpenLoopsSource(openLoops)], appPool);
    const artifact = await dailyBrief.generate(identityA);
    const allBuckets = [
      ...artifact.top_priorities, ...artifact.today, ...artifact.needs_attention,
      ...artifact.follow_ups, ...artifact.build_status, ...artifact.fyi
    ];
    const item = allBuckets.find((i) => i.source === "business-open-loops" && i.title.includes("finance_spend_unexpected"));
    expect(item).toBeTruthy();
    expect(item?.why).toContain("Utgift på");
    // høy prioritet (finance_spend_unexpected er "high") -> ikke i FYI-boetta.
    expect(artifact.fyi.find((i) => i.ref === item?.ref)).toBeUndefined();
  });
});

describe("H (D-128): produkt-avledede open loops overflater i Business OS-briefen via SAMME businessOpenLoopsSource() som sales/finance", () => {
  // Beviser EMPIRISK, ikke bare via BUSINESS_DOMAIN_COVERAGE-paastanden over, at product sin
  // dekning er reell: en ekte `product_items`-rad i status 'new' (identisk fixture-form som
  // `open-loop-product.test.ts` §A) -> OpenLoopService.detectProductItemsNeedingTriage() ->
  // `product_item_needs_triage`-open-loop -> businessOpenLoopsSource() -> DailyBrief-punkt.
  // INGEN ny BriefSource bygget her - dette er den EKSISTERENDE `businessOpenLoopsSource()`
  // (§13/D-53), som allerede haandterer ENHVER open_loop_type generisk.
  it("et product_item_needs_triage-open-loop dukker opp som et brief-punkt, med produkt-kilde-forankret 'why'", async () => {
    const itemId = `prd-it-brief-${randomUUID()}`;
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query(
        `INSERT INTO product_items (item_id, tenant_id, memory_space_id, title, status, priority, created_at, updated_at)
         VALUES ($1, $2, 'business', 'Brief-test produktpunkt', 'new', 'normal', now() - interval '10 days', now() - interval '10 days')`,
        [itemId, TENANT_A]
      )
    );
    const detection = await openLoops.detectProductItemsNeedingTriage(TENANT_A, "business");
    expect(detection.detected).toBeGreaterThanOrEqual(1);

    const dailyBrief = new DailyBrief([businessOpenLoopsSource(openLoops)], appPool);
    const artifact = await dailyBrief.generate(identityA);
    const allBuckets = [
      ...artifact.top_priorities, ...artifact.today, ...artifact.needs_attention,
      ...artifact.follow_ups, ...artifact.build_status, ...artifact.fyi
    ];
    const item = allBuckets.find((i) => i.source === "business-open-loops" && i.title.includes("product_item_needs_triage"));
    expect(item).toBeTruthy();
    expect(item?.why).toContain("triagert");
  });
});

describe("I (D-129): driftsoppgave-avledede open loops overflater i Business OS-briefen via SAMME businessOpenLoopsSource() som sales/finance/product", () => {
  // Beviser EMPIRISK, ikke bare via BUSINESS_DOMAIN_COVERAGE-paastanden over, at operations sin
  // dekning er reell: en ekte `operations_tasks`-rad med passert `due_at` (identisk fixture-form
  // som `open-loop-operations.test.ts` §A) -> OpenLoopService.detectOverdueOperationsTasks() ->
  // `operations_task_overdue`-open-loop -> businessOpenLoopsSource() -> DailyBrief-punkt.
  // INGEN ny BriefSource bygget her - dette er den EKSISTERENDE `businessOpenLoopsSource()`
  // (§13/D-53), som allerede haandterer ENHVER open_loop_type generisk.
  it("et operations_task_overdue-open-loop dukker opp som et brief-punkt, med driftsoppgave-kilde-forankret 'why'", async () => {
    const taskId = `ops-tk-brief-${randomUUID()}`;
    await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query(
        `INSERT INTO operations_tasks (task_id, tenant_id, memory_space_id, title, status, priority, due_at)
         VALUES ($1, $2, 'business', 'Brief-test driftsoppgave', 'open', 'normal', now() - interval '1 day')`,
        [taskId, TENANT_A]
      )
    );
    const detection = await openLoops.detectOverdueOperationsTasks(TENANT_A, "business");
    expect(detection.detected).toBeGreaterThanOrEqual(1);

    const dailyBrief = new DailyBrief([businessOpenLoopsSource(openLoops)], appPool);
    const artifact = await dailyBrief.generate(identityA);
    const allBuckets = [
      ...artifact.top_priorities, ...artifact.today, ...artifact.needs_attention,
      ...artifact.follow_ups, ...artifact.build_status, ...artifact.fyi
    ];
    // Merk: `operations_task_overdue` HAR en `due_at` (i motsetning til `product_item_needs_triage`,
    // som aldri har en frist) - `businessOpenLoopsSource()` prefikser derfor tittelen med "OVERDUE",
    // IKKE loop_type-strengen (samme regel som followup-loopene i blokk A) - identifiser derfor
    // via `why`, som er unikt for driftsoppgave-teksten.
    const item = allBuckets.find((i) => i.source === "business-open-loops" && i.why.includes("Driftsoppgave") && i.why.includes("forfalt"));
    expect(item).toBeTruthy();
    expect(item?.title).toContain("OVERDUE");
  });
});

describe("D: ingen direkte modell-leverandør-bypass (strukturelt) - business-brief.ts kaller aldri AI Mesh", () => {
  it("business-brief.ts importerer aldri en provider-SDK eller ModelGateway direkte", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/business-brief.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/@jarvis\/model-gateway|@jarvis\/provider-adapters|openai|anthropic/i);
  });
});

/**
 * D-90 (UA-4 NESTE SLICE): Business OS × Marketing Memory-integrasjon.
 * `BusinessTransport` importerer BEVISST ALDRI `@jarvis/growth` (ville vært
 * sirkulært - se `business-os-integration.ts` i `@jarvis/growth`). Denne
 * testblokken beviser DERFOR injeksjonspunktet (`extraBriefSources`) med en
 * FAKE `BriefSource` - `@jarvis/growth` sin FAKTISKE
 * `marketingMemoryBriefSource()` er allerede bevist separat, mot ekte
 * Postgres, i `modules/growth/test/service-rls.test.ts` §S.
 */
describe("F (D-90): BusinessTransport.get_business_brief injiserer EKSTRA BriefSource-er fra app-laget - ingen ny @jarvis/growth-avhengighet", () => {
  function fakeMarketingMemorySource(items: BriefItem[]): BriefSource {
    return { name: "marketing-memory", async collect() { return items; } };
  }

  // MERK: bruker TENANT_B, IKKE TENANT_A - TENANT_A akkumulerer flere høyt-skårede
  // (85) "OVERDUE"-open-loops fra tidligere testblokker (A/B) i denne filen, som ville
  // fortrenge et informasjonelt 55-skåret punkt fra `top_priorities` (DailyBrief sin
  // EKSISTERENDE `slice(0,3)`-oppførsel, uendret av D-90) og gjøre testen kjørerekkefølge-
  // skjør. TENANT_B forblir bevisst loop-fri gjennom hele filen - en ren, deterministisk fixture.
  it("en injisert ekstra BriefSource sine punkter dukker opp i get_business_brief (daily)", async () => {
    const extra = fakeMarketingMemorySource([{
      source: "marketing-memory", ref: "grw-ob-fake-f1", title: "F1 Fake kampanje: 2 attribuerte møter, ingen vunnet opportunity ennå",
      score: 55, why: "deterministisk markedsførings-observasjon (D-89)"
    }]);
    const transport = new BusinessTransport(business, openLoops, appPool, undefined, undefined, [extra]);
    const result = await transport.invoke("get_business_brief", { tenant_id: TENANT_B, memory_space: "business" });
    const data = result.data as unknown as { needs_attention: BriefItem[]; fyi: BriefItem[]; top_priorities: BriefItem[]; today: BriefItem[]; follow_ups: BriefItem[]; build_status: BriefItem[] };
    const allBuckets = [...data.top_priorities, ...data.today, ...data.needs_attention, ...data.follow_ups, ...data.build_status, ...data.fyi];
    expect(allBuckets.some((i) => i.source === "marketing-memory" && i.ref === "grw-ob-fake-f1")).toBe(true);
  });

  it("UTEN injiserte ekstra kilder (default `[]`, EKSAKT samme konstruktørkall som FØR D-90) er brief-oppførselen uendret - ingen marketing-memory-punkter", async () => {
    const transport = new BusinessTransport(business, openLoops, appPool, undefined, undefined);
    const result = await transport.invoke("get_business_brief", { tenant_id: TENANT_B, memory_space: "business" });
    const data = result.data as unknown as { needs_attention: BriefItem[]; fyi: BriefItem[]; top_priorities: BriefItem[]; today: BriefItem[]; follow_ups: BriefItem[]; build_status: BriefItem[] };
    const allBuckets = [...data.top_priorities, ...data.today, ...data.needs_attention, ...data.follow_ups, ...data.build_status, ...data.fyi];
    expect(allBuckets.some((i) => i.source === "marketing-memory")).toBe(false);
  });

  // PR #29-audit §9: EKSISTERENDE `DailyBrief.generate()`-arkitektur (uendret av D-90)
  // isolerer allerede hver kildes feil individuelt (per-kilde try/catch, se
  // modules/tool-gateway/src/daily-brief.ts) - en kastende `marketingMemoryBriefSource()`
  // skal derfor ALDRI velte hele Business OS-briefen, kun degradere pent med et
  // `source_errors`-oppføring, EKSAKT samme mønster som en manglende gmail/calendar-
  // credential allerede håndteres for de andre kildene.
  it("en kastende ekstra BriefSource velter ALDRI hele briefen - degraderer pent med en source_errors-oppføring, andre kilder upåvirket", async () => {
    const throwingSource: BriefSource = {
      name: "marketing-memory",
      async collect() { throw new Error("simulert growth-feil (f.eks. DB nede)"); }
    };
    const transport = new BusinessTransport(business, openLoops, appPool, undefined, undefined, [throwingSource]);
    const result = await transport.invoke("get_business_brief", { tenant_id: TENANT_B, memory_space: "business" });
    const data = result.data as unknown as {
      needs_attention: BriefItem[]; fyi: BriefItem[]; top_priorities: BriefItem[]; today: BriefItem[];
      follow_ups: BriefItem[]; build_status: BriefItem[]; source_errors: Array<{ source: string; error: string }>;
    };
    expect(data.source_errors.some((e) => e.source === "marketing-memory")).toBe(true);
    // Business OS-open-loops-kilden (TENANT_B er bevisst loop-fri) svarer fortsatt normalt -
    // ingen marketing-memory-punkter (kilden feilet), men INGEN unhandled rejection/krasj.
    const allBuckets = [...data.top_priorities, ...data.today, ...data.needs_attention, ...data.follow_ups, ...data.build_status, ...data.fyi];
    expect(allBuckets.some((i) => i.source === "marketing-memory")).toBe(false);
  });

  it("STRUKTURELT: @jarvis/business importerer ALDRI @jarvis/growth noe sted (sirkulær-avhengighet-grensen er bevisst, ikke tilfeldig)", async () => {
    const files = ["../src/transport.ts", "../src/business-brief.ts", "../src/service.ts", "../src/open-loop-service.ts"];
    for (const f of files) {
      const source = await readFile(fileURLToPath(new URL(f, import.meta.url)), "utf8");
      expect(source).not.toMatch(/from ["']@jarvis\/growth["']/);
    }
  });
});
