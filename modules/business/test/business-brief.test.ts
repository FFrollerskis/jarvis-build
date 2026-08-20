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
const PORT = 30000 + Math.floor(Math.random() * 20000);
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
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
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
  await epg?.stop();
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
  it("weekly.data_coverage reflekterer marketing=available (Growth Core) for ALLE tenants likt - domenedekning er arkitektur, ikke tenant-data", async () => {
    const weeklyA = await generateWeeklyBrief(appPool, TENANT_A, "business");
    const weeklyB = await generateWeeklyBrief(appPool, TENANT_B, "business");
    expect(weeklyA.data_coverage.marketing.status).toBe("available");
    expect(weeklyB.data_coverage.marketing.status).toBe("available");
    expect(weeklyA.data_coverage).toEqual(weeklyB.data_coverage);
    expect(weeklyA.data_coverage.sales.status).toBe("available");
    expect(weeklyA.data_coverage.product.status).toBe("not_integrated");
    expect(weeklyA.data_coverage.finance.status).toBe("not_integrated");
    expect(weeklyA.data_coverage.operations.status).toBe("not_integrated");
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

describe("C: §15 aerlighet - akseptansekriterium 2 ('sales, product, finance, marketing, operations') er IKKE fullt oppfylt", () => {
  // UA-4 Growth -> Business Domain Coverage-integrasjon (D-78): `marketing` gikk fra
  // `not_integrated` til `available` FORDI Native Jarvis Growth Core (D-74/D-75/D-76/D-77) nå
  // faktisk finnes - IKKE en fabrikkert/kosmetisk endring. `product`/`finance`/`operations`
  // forblir eksplisitt `not_integrated`, uendret.
  it("BUSINESS_DOMAIN_COVERAGE markerer sales OG marketing som tilgjengelig - de tre andre er eksplisitt not_integrated, aldri fabrikkert", () => {
    expect(BUSINESS_DOMAIN_COVERAGE.sales.status).toBe("available");
    expect(BUSINESS_DOMAIN_COVERAGE.marketing.status).toBe("available");
    expect(BUSINESS_DOMAIN_COVERAGE.product.status).toBe("not_integrated");
    expect(BUSINESS_DOMAIN_COVERAGE.finance.status).toBe("not_integrated");
    expect(BUSINESS_DOMAIN_COVERAGE.operations.status).toBe("not_integrated");
  });

  it("marketing sin dekning er eksplisitt begrunnet i Native Growth Core, ALDRI en leverandør-tilkobling", () => {
    expect(BUSINESS_DOMAIN_COVERAGE.marketing.source).toMatch(/Growth Core/);
    // Domenekapabilitet (status) og ekstern leverandør-tilkobling (live_provider_connected) er
    // BEVISST separate felt - denne sliceen kobler INGEN live annonseplattform til noe.
    expect(BUSINESS_DOMAIN_COVERAGE.marketing.live_provider_connected).toBe(false);
  });

  it("sales/product/finance/operations sin dekning er uendret av denne sliceen (ingen regresjon)", () => {
    expect(BUSINESS_DOMAIN_COVERAGE.sales).toEqual({ status: "available", source: "Business Graph/CRM", live_provider_connected: false });
    expect(BUSINESS_DOMAIN_COVERAGE.product).toEqual({ status: "not_integrated", source: "ikke bygget ennå", live_provider_connected: false });
    expect(BUSINESS_DOMAIN_COVERAGE.finance).toEqual({ status: "not_integrated", source: "ikke bygget ennå", live_provider_connected: false });
    expect(BUSINESS_DOMAIN_COVERAGE.operations).toEqual({ status: "not_integrated", source: "ikke bygget ennå", live_provider_connected: false });
  });

  it("renderDomainCoverage() sier eksplisitt fra at kriteriet ikke er fullt oppfylt, OG nevner marketing som tilgjengelig uten aa hevde en live leverandør", () => {
    const text = renderDomainCoverage();
    expect(text).toContain("IKKE fullt oppfylt");
    expect(text).toContain("IKKE integrert");
    expect(text).toContain("marketing: tilgjengelig");
    expect(text).toContain("ingen live ekstern leverandør tilkoblet");
    // 2/5 domener dekket (sales + marketing) - eksplisitt telling, ikke en gjettet brøk.
    expect(text).toContain("2/5 domener dekket");
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

  it("STRUKTURELT: @jarvis/business importerer ALDRI @jarvis/growth noe sted (sirkulær-avhengighet-grensen er bevisst, ikke tilfeldig)", async () => {
    const files = ["../src/transport.ts", "../src/business-brief.ts", "../src/service.ts", "../src/open-loop-service.ts"];
    for (const f of files) {
      const source = await readFile(fileURLToPath(new URL(f, import.meta.url)), "utf8");
      expect(source).not.toMatch(/from ["']@jarvis\/growth["']/);
    }
  });
});
