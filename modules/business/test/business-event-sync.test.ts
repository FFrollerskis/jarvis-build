import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { withMemoryTransaction } from "@jarvis/memory";
import { FakeTransport, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { BusinessService } from "../src/service.ts";
import { OpenLoopService } from "../src/open-loop-service.ts";
import {
  BusinessEventSyncService, extractCounterpartEmails, extractEmailAddress
} from "../src/business-event-sync.ts";

/**
 * UA-3 business-event-linkage (D-57): testmatrise A-N. Ekte embedded
 * Postgres/RLS (samme non-bypass-rolle-mønster som business-service.test.ts)
 * + en ekte `ToolGateway` med `FakeTransport` for email/calendar - beviser
 * at synkroniseringen faktisk gaar gjennom den NORMALE trusted
 * ToolGateway-veien (§20 i byggeordren), ikke en snarvei direkte mot
 * `BusinessService`.
 */
const PORT = 30000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: BusinessService;
let openLoops: OpenLoopService;
let toolGateway: ToolGateway;
let emailFake: FakeTransport;
let calendarFake: FakeTransport;

const TENANT_A = "tenant-biz-events-a";
const TENANT_B = "tenant-biz-events-b";
const ACCOUNT = "post@tsworkflow.com";
const identity = (tenantId: string): IdentityContext => ({
  person_id: "system", tenant_id: tenantId, memory_space_id: "business",
  session_id: `sess-events-${tenantId}`, device_id: "jarvis-core", channel: "api", auth_strength: "active"
});

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-business-events-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_business_events_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_business_events_test");
  await adminPool.query(`
    INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}','A','business'), ('${TENANT_B}','B','business');
    INSERT INTO people (person_id, display_name) VALUES ('person-tobias','Tobias');
    INSERT INTO person_tenants (person_id, tenant_id) VALUES ('person-tobias','${TENANT_A}'), ('person-tobias','${TENANT_B}');
    INSERT INTO memory_spaces (memory_space_id, tenant_id, space) VALUES
      ('ms-a-business','${TENANT_A}','business'), ('ms-b-business','${TENANT_B}','business');
  `);
  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_business_events_test", password: "pw2" });
  service = new BusinessService(appPool);
  openLoops = new OpenLoopService(appPool);

  emailFake = new FakeTransport(() => ({ data: { messages: [] } }));
  calendarFake = new FakeTransport(() => ({ data: { events: [] } }));
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A, TENANT_B] }
  });
  toolGateway = new ToolGateway(appPool, policy, { name: "test-static", get: async () => "dummy-credential" });
  for (const tool of firstWaveTools({ email: emailFake, calendar: calendarFake })) toolGateway.register(tool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

function syncService(): BusinessEventSyncService {
  return new BusinessEventSyncService(toolGateway, service, openLoops, ACCOUNT);
}

describe("A: rene entitets-parsing-hjelpefunksjoner (deterministisk, ingen nettverk)", () => {
  it("trekker ut e-post fra 'Navn <adresse>'-format", () => {
    expect(extractEmailAddress('"Kari Nordmann" <kari@acme.no>')).toBe("kari@acme.no");
  });
  it("trekker ut e-post fra ren adresse uten navn", () => {
    expect(extractEmailAddress("kari@acme.no")).toBe("kari@acme.no");
  });
  it("returnerer null for ugyldig/manglende header", () => {
    expect(extractEmailAddress("")).toBeNull();
    expect(extractEmailAddress(undefined)).toBeNull();
    expect(extractEmailAddress("ikke en e-post")).toBeNull();
  });
  it("normaliserer store/små bokstaver til lowercase", () => {
    expect(extractEmailAddress("Kari@ACME.no")).toBe("kari@acme.no");
  });
});

describe("B: motpart-utledning (From/To/Cc, kontoens egen adresse ekskludert)", () => {
  it("inkluderer From naar kontoen selv er mottaker (innkommende e-post)", () => {
    const emails = extractCounterpartEmails({ from: "kari@acme.no", to: ACCOUNT }, ACCOUNT);
    expect(emails).toEqual(["kari@acme.no"]);
  });
  it("inkluderer To naar kontoen selv er avsender (utgaaende e-post)", () => {
    const emails = extractCounterpartEmails({ from: ACCOUNT, to: "kari@acme.no" }, ACCOUNT);
    expect(emails).toEqual(["kari@acme.no"]);
  });
  it("dedupliserer naar samme adresse forekommer i flere felt", () => {
    const emails = extractCounterpartEmails({ from: "kari@acme.no", to: "kari@acme.no, andre@acme.no" }, ACCOUNT);
    expect(emails.sort()).toEqual(["andre@acme.no", "kari@acme.no"]);
  });
});

describe("C: matchet kontakt - Gmail-aktivitet registreres med korrekt kobling", () => {
  it("en e-post fra en kjent kontakt kobles til riktig selskap/kontakt, ALDRI body-tekst lagret", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: "Acme AS" });
    const contact = await service.createContact(TENANT_A, "business", { name: "Kari Nordmann", email: "kari@acme.no", company_id: company.company_id });
    emailFake = new FakeTransport(() => ({
      data: {
        messages: [{
          id: "msg-1", from: "Kari Nordmann <kari@acme.no>", to: ACCOUNT, subject: "Spørsmål om pris",
          at: "2026-08-17T10:00:00Z", body_text: "HEMMELIG FULL E-POST-KROPP SOM ALDRI SKAL LAGRES"
        }]
      }
    }));
    calendarFake = new FakeTransport(() => ({ data: { events: [] } }));
    toolGateway = new ToolGateway(appPool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A, TENANT_B] }
    }), { name: "test-static", get: async () => "dummy-credential" });
    for (const tool of firstWaveTools({ email: emailFake, calendar: calendarFake })) toolGateway.register(tool);

    const stats = await syncService().syncGmailActivities(TENANT_A, "business", identity(TENANT_A));
    expect(stats).toEqual({ scanned: 1, recorded: 1, unmatched: 0, ambiguous: 0 });

    const timeline = await service.companyTimeline(TENANT_A, "business", company.company_id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.summary).toBe("E-post: Spørsmål om pris");
    expect(timeline[0]?.canonical_uri).toBe("https://mail.google.com/mail/u/0/#all/msg-1");
    expect(JSON.stringify(timeline[0])).not.toContain("HEMMELIG");

    const { rows } = await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("SELECT contact_id FROM business_activities WHERE activity_id = $1", [timeline[0]?.activity_id])
    );
    expect((rows[0] as { contact_id: string }).contact_id).toBe(contact.contact_id);
  });
});

describe("D: idempotens - re-synkronisering av SAMME melding gir ingen duplikat", () => {
  it("kaller syncGmailActivities to ganger med samme message-id -> kun én aktivitetsrad", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: "Idempotent AS" });
    await service.createContact(TENANT_A, "business", { name: "Ola", email: "ola@idempotent.no", company_id: company.company_id });
    const fixedEmail = new FakeTransport(() => ({
      data: { messages: [{ id: "msg-idempotent-1", from: "ola@idempotent.no", to: ACCOUNT, subject: "Samme melding", at: "2026-08-17T11:00:00Z" }] }
    }));
    const localCalendar = new FakeTransport(() => ({ data: { events: [] } }));
    const localGateway = new ToolGateway(appPool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
    }), { name: "test-static", get: async () => "dummy-credential" });
    for (const tool of firstWaveTools({ email: fixedEmail, calendar: localCalendar })) localGateway.register(tool);
    const localSync = new BusinessEventSyncService(localGateway, service, openLoops, ACCOUNT);

    await localSync.syncGmailActivities(TENANT_A, "business", identity(TENANT_A));
    await localSync.syncGmailActivities(TENANT_A, "business", identity(TENANT_A));

    const { rows } = await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM business_activities WHERE tenant_id = $1 AND source_type = 'gmail' AND external_id = 'msg-idempotent-1'",
        [TENANT_A]
      )
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});

describe("E: umatchet - e-post fra ukjent avsender registreres ALDRI som aktivitet", () => {
  it("ingen aktivitet opprettes naar ingen business_contact matcher noen motpart-adresse", async () => {
    const fixedEmail = new FakeTransport(() => ({
      data: { messages: [{ id: "msg-unknown-1", from: "ukjent@fremmed.no", to: ACCOUNT, subject: "Spam?", at: "2026-08-17T12:00:00Z" }] }
    }));
    const localGateway = new ToolGateway(appPool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
    }), { name: "test-static", get: async () => "dummy-credential" });
    for (const tool of firstWaveTools({ email: fixedEmail, calendar: new FakeTransport(() => ({ data: { events: [] } })) })) localGateway.register(tool);
    const localSync = new BusinessEventSyncService(localGateway, service, openLoops, ACCOUNT);

    const stats = await localSync.syncGmailActivities(TENANT_A, "business", identity(TENANT_A));
    expect(stats).toEqual({ scanned: 1, recorded: 0, unmatched: 1, ambiguous: 0 });

    const { rows } = await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("SELECT count(*)::int AS n FROM business_activities WHERE tenant_id = $1 AND source_type = 'gmail' AND external_id = 'msg-unknown-1'", [TENANT_A])
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe("F: tvetydig - motparter som matcher FLERE distinkte selskaper hoppes over", () => {
  it("aldri gjett hvilket selskap som er riktig - ingen aktivitet, ambiguous-telling øker", async () => {
    const companyOne = await service.createCompany(TENANT_A, "business", { name: "Selskap Én" });
    const companyTwo = await service.createCompany(TENANT_A, "business", { name: "Selskap To" });
    await service.createContact(TENANT_A, "business", { name: "Person Én", email: "person1@ambiguous.no", company_id: companyOne.company_id });
    await service.createContact(TENANT_A, "business", { name: "Person To", email: "person2@ambiguous.no", company_id: companyTwo.company_id });
    const fixedEmail = new FakeTransport(() => ({
      data: {
        messages: [{
          id: "msg-ambiguous-1", from: "person1@ambiguous.no", to: `${ACCOUNT}, person2@ambiguous.no`,
          subject: "Fellesmøte", at: "2026-08-17T13:00:00Z"
        }]
      }
    }));
    const localGateway = new ToolGateway(appPool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
    }), { name: "test-static", get: async () => "dummy-credential" });
    for (const tool of firstWaveTools({ email: fixedEmail, calendar: new FakeTransport(() => ({ data: { events: [] } })) })) localGateway.register(tool);
    const localSync = new BusinessEventSyncService(localGateway, service, openLoops, ACCOUNT);

    const stats = await localSync.syncGmailActivities(TENANT_A, "business", identity(TENANT_A));
    expect(stats).toEqual({ scanned: 1, recorded: 0, unmatched: 0, ambiguous: 1 });
  });
});

describe("G: Calendar-lenking - deltaker-e-post matcher kontakt, html_link brukes som canonical_uri", () => {
  it("et møte med en kjent deltaker registreres som 'meeting'-aktivitet med Calendar sin egen lenke", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: "Møte AS" });
    await service.createContact(TENANT_A, "business", { name: "Per", email: "per@mote.no", company_id: company.company_id });
    const fixedCalendar = new FakeTransport(() => ({
      data: {
        events: [{
          id: "evt-1", title: "Kundemøte", start: "2026-08-18T09:00:00Z",
          html_link: "https://calendar.google.com/event?eid=abc", attendees: ["per@mote.no", ACCOUNT]
        }]
      }
    }));
    const localGateway = new ToolGateway(appPool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
    }), { name: "test-static", get: async () => "dummy-credential" });
    for (const tool of firstWaveTools({ email: new FakeTransport(() => ({ data: { messages: [] } })), calendar: fixedCalendar })) localGateway.register(tool);
    const localSync = new BusinessEventSyncService(localGateway, service, openLoops, ACCOUNT);

    const stats = await localSync.syncCalendarActivities(TENANT_A, "business", identity(TENANT_A));
    expect(stats).toEqual({ scanned: 1, recorded: 1, unmatched: 0, ambiguous: 0 });

    const timeline = await service.companyTimeline(TENANT_A, "business", company.company_id);
    const meeting = timeline.find((t) => t.canonical_uri === "https://calendar.google.com/event?eid=abc");
    expect(meeting?.summary).toBe("Møte: Kundemøte");
    expect(meeting?.activity_type).toBe("meeting");
  });
});

describe("H: tenant-isolasjon - synk for tenant A finner aldri tenant B sine kontakter", () => {
  it("en e-post fra en adresse som KUN finnes som kontakt i tenant B forblir umatchet naar sync kjøres for tenant A", async () => {
    await service.createContact(TENANT_B, "business", { name: "Kun i B", email: "kun-i-b@isolert.no" });
    const fixedEmail = new FakeTransport(() => ({
      data: { messages: [{ id: "msg-isolation-1", from: "kun-i-b@isolert.no", to: ACCOUNT, subject: "Isolasjonstest", at: "2026-08-17T14:00:00Z" }] }
    }));
    const localGateway = new ToolGateway(appPool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A, TENANT_B] }
    }), { name: "test-static", get: async () => "dummy-credential" });
    for (const tool of firstWaveTools({ email: fixedEmail, calendar: new FakeTransport(() => ({ data: { events: [] } })) })) localGateway.register(tool);
    const localSync = new BusinessEventSyncService(localGateway, service, openLoops, ACCOUNT);

    const stats = await localSync.syncGmailActivities(TENANT_A, "business", identity(TENANT_A));
    expect(stats.unmatched).toBe(1);
    expect(stats.recorded).toBe(0);
  });
});

describe("I: memory-space-isolasjon - kontakt i 'personal' space er usynlig for 'business'-space-synk", () => {
  it("en kontakt registrert i personal-space matcher ikke naar sync kjøres for business-space", async () => {
    await service.createContact(TENANT_A, "personal", { name: "Privat kontakt", email: "privat@space.no" });
    const fixedEmail = new FakeTransport(() => ({
      data: { messages: [{ id: "msg-space-1", from: "privat@space.no", to: ACCOUNT, subject: "Space-test", at: "2026-08-17T15:00:00Z" }] }
    }));
    const localGateway = new ToolGateway(appPool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
    }), { name: "test-static", get: async () => "dummy-credential" });
    for (const tool of firstWaveTools({ email: fixedEmail, calendar: new FakeTransport(() => ({ data: { events: [] } })) })) localGateway.register(tool);
    const localSync = new BusinessEventSyncService(localGateway, service, openLoops, ACCOUNT);

    const stats = await localSync.syncGmailActivities(TENANT_A, "business", identity(TENANT_A));
    expect(stats.unmatched).toBe(1);
  });
});

describe("J: open-loop-reevaluering gjenbruker EKSISTERENDE OpenLoopService uendret", () => {
  it("syncTenant() kaller runSweep() - en forfalt oppfoelging blir et open loop etter synk, ingen ny mekanisme", async () => {
    const company = await service.createCompany(TENANT_A, "business", { name: "Reeval AS" });
    await service.createContact(TENANT_A, "business", { name: "Reeval Person", email: "reeval@sweep.no", company_id: company.company_id });
    await service.createFollowup(TENANT_A, "business", { title: "Forfalt for reeval-test", due_at: "2020-01-01T00:00:00Z", company_id: company.company_id });
    const localGateway = new ToolGateway(appPool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
    }), { name: "test-static", get: async () => "dummy-credential" });
    for (const tool of firstWaveTools({ email: new FakeTransport(() => ({ data: { messages: [] } })), calendar: new FakeTransport(() => ({ data: { events: [] } })) })) localGateway.register(tool);
    const localSync = new BusinessEventSyncService(localGateway, service, openLoops, ACCOUNT);

    const result = await localSync.syncTenant(TENANT_A, "business", identity(TENANT_A));
    expect(result.open_loops_reevaluated).toBe(true);
    const loops = await openLoops.listOpenLoops(TENANT_A, "business", "open");
    expect(loops.some((l) => l.loop_type === "overdue_followup")).toBe(true);
  });
});

describe("K: kilde-peker (ALDRI kopi av innhold) - canonical_uri for Gmail følger etablert konvensjon", () => {
  it("Gmail canonical_uri matcher SAMME lenke-konvensjon som Knowledge sin email-attachment-kilde", async () => {
    await service.createContact(TENANT_A, "business", { name: "Konvensjon", email: "konvensjon@lenke.no" });
    const fixedEmail = new FakeTransport(() => ({
      data: { messages: [{ id: "msg-convention-1", from: "konvensjon@lenke.no", to: ACCOUNT, subject: "Lenke-test", at: "2026-08-17T16:00:00Z" }] }
    }));
    const localGateway = new ToolGateway(appPool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
    }), { name: "test-static", get: async () => "dummy-credential" });
    for (const tool of firstWaveTools({ email: fixedEmail, calendar: new FakeTransport(() => ({ data: { events: [] } })) })) localGateway.register(tool);
    const localSync = new BusinessEventSyncService(localGateway, service, openLoops, ACCOUNT);
    await localSync.syncGmailActivities(TENANT_A, "business", identity(TENANT_A));
    const { rows } = await withMemoryTransaction(appPool, TENANT_A, ["business"], (client) =>
      client.query("SELECT canonical_uri FROM business_activities WHERE tenant_id = $1 AND external_id = 'msg-convention-1'", [TENANT_A])
    );
    expect((rows[0] as { canonical_uri: string }).canonical_uri).toBe("https://mail.google.com/mail/u/0/#all/msg-convention-1");
  });
});

describe("L: kjøring gjennom EKTE ToolGateway (ikke direkte transport-kall)", () => {
  it("syncGmailActivities feiler tydelig naar email-transporten kaster (gateway sin normale feilhaandtering, ikke stille svelging)", async () => {
    const failingEmail = new FakeTransport(undefined, "gmail_simulated_outage");
    const localGateway = new ToolGateway(appPool, new PolicyGateway({
      devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
      authority: { owner_person_id: "person-tobias", owner_tenants: [TENANT_A] }
    }), { name: "test-static", get: async () => "dummy-credential" });
    for (const tool of firstWaveTools({ email: failingEmail, calendar: new FakeTransport(() => ({ data: { events: [] } })) })) localGateway.register(tool);
    const localSync = new BusinessEventSyncService(localGateway, service, openLoops, ACCOUNT);
    await expect(localSync.syncGmailActivities(TENANT_A, "business", identity(TENANT_A))).rejects.toThrow();
  });
});

describe("M: ingen provider-SDK-bypass (strukturelt)", () => {
  it("BusinessEventSyncService kaller UTELUKKENDE gjennom ToolGateway.execute() - aldri fetch/googleapis direkte", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const source = await readFile(fileURLToPath(new URL("../src/business-event-sync.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/fetch\(|googleapis\.com|gmail\.googleapis/);
  });
});

describe("N: ingen AI Mesh-bruk i entitetsgjenkjenning (deterministisk-først, §9 i byggeordren)", () => {
  it("BusinessEventSyncService importerer aldri ModelGateway/provider-adaptere", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const source = await readFile(fileURLToPath(new URL("../src/business-event-sync.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/@jarvis\/model-gateway|@jarvis\/provider-adapters|openai|anthropic/i);
  });
});
