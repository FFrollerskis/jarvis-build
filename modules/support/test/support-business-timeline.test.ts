import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { BusinessService } from "@jarvis/business";
import { SupportService } from "../src/service.ts";

/**
 * UA-3 akseptansekriterium 1 ("Hva skjer med kunde X?") - HOST FIX: ekte
 * Postgres/RLS-bevis for at `SupportService`s ticket-lifecycle nå FAKTISK
 * speiles inn i `business_activities` og dukker opp i
 * `BusinessService.companyTimeline()` - se `recordTicketTimelineActivity()`
 * i `../src/service.ts`. FØR denne fiksen skrev ingenting i
 * `modules/support` noensinne til `business_activities` (bekreftet ved
 * grep av hele modulen FØR denne testen ble skrevet - se øktrapporten) -
 * disse testene beviser den ekte, ende-til-ende oppførselen mot en EKTE
 * NOSUPERUSER/NOBYPASSRLS-rolle, IKKE en `fakePool()`-mock (samme mønster
 * som `support-service-rls.test.ts`).
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let support: SupportService;
let business: BusinessService;

const TENANT_A = "tenant-sup-tl-a";
const TENANT_B = "tenant-sup-tl-b";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-support-timeline-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_sup_tl_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sup_tl_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Support Timeline A', 'business'), ('${TENANT_B}', 'Support Timeline B', 'business')`
  );
  // `business_companies.company_id` er en GLOBAL PRIMARY KEY (ikke
  // tenant-scoped) - to tenants kan derfor ALDRI dele samme `company_id`.
  // Tenant-isolasjonstesten (H) trenger ikke identiske ID-er for aa vaere
  // gyldig: isolasjonen bevises av at `companyTimeline()` filtrerer paa
  // `tenant_id`, ikke av at ID-verdiene tilfeldigvis er like.
  await adminPool.query(
    `INSERT INTO business_companies (company_id, tenant_id, name) VALUES
       ('co-sup-tl', '${TENANT_A}', 'Acme AS'), ('co-sup-tl-b', '${TENANT_B}', 'Acme AS')`
  );
  await adminPool.query(
    `INSERT INTO business_contacts (contact_id, tenant_id, company_id, name, email) VALUES
       ('ct-sup-tl-a', '${TENANT_A}', 'co-sup-tl', 'Kari', 'kari@acme.no'),
       ('ct-sup-tl-b', '${TENANT_B}', 'co-sup-tl', 'Kari', 'kari@acme.no')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sup_tl_test", password: "pw2" });
  support = new SupportService(appPool);
  business = new BusinessService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: ticket-opprettelse havner i selskapets tidslinje", () => {
  it("en ticket med company_id gir en synlig business_activities-rad via companyTimeline()", async () => {
    const ticket = await support.createTicket(TENANT_A, "business", { subject: "Kan ikke logge inn", company_id: "co-sup-tl" });
    const timeline = await business.companyTimeline(TENANT_A, "business", "co-sup-tl");
    const entry = timeline.find((e) => e.summary.includes("Kan ikke logge inn"));
    expect(entry).toBeDefined();
    expect(entry?.activity_type).toBe("external_event");
    expect(entry?.occurred_at).toBeDefined();
    // Pointer-not-payload (019_business.sql): peker til ticketen, ALDRI en kopi av innhold.
    expect(entry?.canonical_uri).toBe(`jarvis:support_ticket:${ticket.ticket_id}`);
  });

  it("en ticket med KUN contact_id (ingen company_id) er synlig via kontaktens tidslinje-rader i business_activities", async () => {
    await support.createTicket(TENANT_A, "business", { subject: "Kontakt-only-ticket", contact_id: "ct-sup-tl-a" });
    const { rows } = await queryAsAdmin(
      `SELECT * FROM business_activities WHERE tenant_id = $1 AND contact_id = $2 AND summary = $3`,
      [TENANT_A, "ct-sup-tl-a", "Ticket opprettet: Kontakt-only-ticket"]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.company_id).toBeNull();
  });
});

describe("B: statusovergang gir en DISTINKT tidslinje-post", () => {
  it("setStatus produserer en egen 'status_change'-rad, ikke en duplikat av opprettelsen", async () => {
    const ticket = await support.createTicket(TENANT_A, "business", { subject: "Status-Test", company_id: "co-sup-tl" });
    await support.setStatus(TENANT_A, "business", ticket.ticket_id, "pending");
    const timeline = await business.companyTimeline(TENANT_A, "business", "co-sup-tl");
    const created = timeline.find((e) => e.activity_type === "external_event" && e.summary.includes("Status-Test"));
    const statusChange = timeline.find((e) => e.activity_type === "status_change" && e.summary.includes("open -> pending"));
    expect(created).toBeDefined();
    expect(statusChange).toBeDefined();
    expect(created?.activity_id).not.toBe(statusChange?.activity_id);
  });
});

describe("C: idempotens - gjentatt overgang dupliserer ALDRI", () => {
  it("to setStatus-kall til SAMME maal-status gir kun EN business_activities-rad", async () => {
    const ticket = await support.createTicket(TENANT_A, "business", { subject: "Idempotens-Test", company_id: "co-sup-tl" });
    await support.setStatus(TENANT_A, "business", ticket.ticket_id, "pending");
    // Simulerer en retried sweep/duplikat-levering av NOEYAKTIG samme statusovergang.
    await support.setStatus(TENANT_A, "business", ticket.ticket_id, "open");
    await support.setStatus(TENANT_A, "business", ticket.ticket_id, "pending");
    const { rows } = await queryAsAdmin(
      `SELECT * FROM business_activities WHERE tenant_id = $1 AND source_type = 'support_ticket' AND external_id = $2`,
      [TENANT_A, `${ticket.ticket_id}:status:pending`]
    );
    expect(rows).toHaveLength(1);
  });

  it("gjentatt ticket-opprettelse via ingestMessage (samme thread) oppretter KUN én 'created'-tidslinjepost", async () => {
    const first = await support.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1",
      source_thread_id: "thread-idem-1", source_message_id: "msg-1",
      subject: "Idempotent ingress", summary: "Kunde spoer om status",
      is_from_customer: true, company_id: "co-sup-tl", entity_resolution: "matched"
    });
    expect(first.ticket_created).toBe(true);
    // Samme melding levert paa nytt (worker-retry) - SAMME source_message_id.
    const retried = await support.ingestMessage(TENANT_A, "business", {
      channel: "email", source_type: "gmail", source_instance_id: "acct-1",
      source_thread_id: "thread-idem-1", source_message_id: "msg-1",
      subject: "Idempotent ingress", summary: "Kunde spoer om status",
      is_from_customer: true, company_id: "co-sup-tl", entity_resolution: "matched"
    });
    expect(retried.ticket_created).toBe(false);
    expect(retried.ticket.ticket_id).toBe(first.ticket.ticket_id);
    const { rows } = await queryAsAdmin(
      `SELECT * FROM business_activities WHERE tenant_id = $1 AND source_type = 'support_ticket' AND external_id = $2`,
      [TENANT_A, `${first.ticket.ticket_id}:created`]
    );
    expect(rows).toHaveLength(1);
  });
});

describe("F: ticket uten company_id/contact_id skaper INGEN tidslinje-rad", () => {
  it("createTicket uten motpart kaster ikke, og etterlater INGEN business_activities-rad for ticketen", async () => {
    const ticket = await support.createTicket(TENANT_A, "business", { subject: "Ingen motpart" });
    expect(ticket.company_id).toBeNull();
    expect(ticket.contact_id).toBeNull();
    const { rows } = await queryAsAdmin(
      `SELECT * FROM business_activities WHERE tenant_id = $1 AND source_type = 'support_ticket' AND external_id = $2`,
      [TENANT_A, `${ticket.ticket_id}:created`]
    );
    expect(rows).toHaveLength(0);
  });

  it("setStatus paa en motpart-los ticket kaster ikke, og etterlater INGEN business_activities-rad", async () => {
    const ticket = await support.createTicket(TENANT_A, "business", { subject: "Ingen motpart status" });
    const updated = await support.setStatus(TENANT_A, "business", ticket.ticket_id, "pending");
    expect(updated?.status).toBe("pending");
    const { rows } = await queryAsAdmin(
      `SELECT * FROM business_activities WHERE tenant_id = $1 AND source_type = 'support_ticket' AND external_id = $2`,
      [TENANT_A, `${ticket.ticket_id}:status:pending`]
    );
    expect(rows).toHaveLength(0);
  });
});

describe("H: tenant-isolasjon", () => {
  it("en ticket i tenant B er ALDRI synlig i tenant A sin companyTimeline()", async () => {
    await support.createTicket(TENANT_B, "business", { subject: "Hemmelig-B-ticket", company_id: "co-sup-tl-b" });
    const timelineA = await business.companyTimeline(TENANT_A, "business", "co-sup-tl");
    expect(timelineA.some((e) => e.summary.includes("Hemmelig-B-ticket"))).toBe(false);
    const timelineB = await business.companyTimeline(TENANT_B, "business", "co-sup-tl-b");
    expect(timelineB.some((e) => e.summary.includes("Hemmelig-B-ticket"))).toBe(true);
  });

  it("companyTimeline(TENANT_A, 'co-sup-tl-b') - en gjetning paa tenant B sin company_id fra tenant A - gir ALDRI tenant B sine rader (RLS, ikke bare app-filter)", async () => {
    const timeline = await business.companyTimeline(TENANT_A, "business", "co-sup-tl-b");
    expect(timeline).toHaveLength(0);
  });
});

async function queryAsAdmin(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
  return adminPool.query(sql, params);
}
