import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { SupportContactCompanyMismatchError, SupportCrossScopeReferenceError, SupportService } from "../src/service.ts";

/**
 * Arkitekt-review MERGE BLOCKER A+B (D-130/Q-33, PR #79): ekte Postgres-bevis
 * for de to fiksene i denne slicen, mot en EKTE NOSUPERUSER/NOBYPASSRLS-rolle
 * (samme mønster som `support-service-rls.test.ts`/`support-business-timeline.test.ts`
 * - IKKE en `fakePool()`-mock):
 *
 *  (A) `createTicket()`s tidslinje-speiling (business_activities) skjer NAA i
 *      SAMME transaksjon som selve ticket-/event-raden - feiler INSERT-en,
 *      ruller HELE transaksjonen (ticket inkludert) tilbake. Bevist med en
 *      DETERMINISTISK feilinjeksjon - en midlertidig BEFORE INSERT-trigger
 *      paa `business_activities` (admin-pool) som kaster naar `summary`
 *      inneholder en kjent markør - IKKE en permission-hack (§ instruksjon:
 *      "prefer a clean, realistic technique"), se `installPoisonTrigger()`.
 *  (B) `assertCompanyContactInScope()` (Q-33) avviser et caller-oppgitt
 *      company_id/contact_id FØR noen INSERT skjer naar det ikke tilhoerer
 *      kallerens EGEN tenant+memory_space, eller naar en oppgitt kontakt
 *      tilhoerer en ANNEN company enn den oppgitte - se
 *      `modules/operations/src/service.ts` sin `assertCompanyContactInScope()`
 *      for det opprinnelige mønsteret (D-129).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let support: SupportService;

const TENANT_A = "tenant-sup-atom-a";
const TENANT_B = "tenant-sup-atom-b";
const POISON_MARKER = "__JARVIS_TEST_POISON__";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-support-atomicity-"));
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

  await adminPool.query("CREATE ROLE jarvis_sup_atom_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_sup_atom_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Support Atomicity A', 'business'), ('${TENANT_B}', 'Support Atomicity B', 'business')`
  );
  // `business_companies.company_id`/`business_contacts.contact_id` er GLOBALE
  // primærnøkler (ingen sammensatt tenant-nøkkel) - to distinkte selskaper i
  // TENANT_A (for mismatch-testen) og ett i TENANT_B (for kryss-tenant-testen).
  await adminPool.query(
    `INSERT INTO business_companies (company_id, tenant_id, name) VALUES
       ('co-sup-atom-a', '${TENANT_A}', 'Acme AS'),
       ('co-sup-atom-a2', '${TENANT_A}', 'Contoso AS'),
       ('co-sup-atom-b', '${TENANT_B}', 'Globex AS')`
  );
  await adminPool.query(
    `INSERT INTO business_contacts (contact_id, tenant_id, company_id, name, email) VALUES
       ('ct-sup-atom-a', '${TENANT_A}', 'co-sup-atom-a', 'Kari', 'kari@acme.no'),
       ('ct-sup-atom-b', '${TENANT_B}', 'co-sup-atom-b', 'Ola', 'ola@globex.no')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_sup_atom_test", password: "pw2" });
  support = new SupportService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("Blocker A: createTicket() ruller HELE transaksjonen tilbake naar business_activities-skrivingen feiler", () => {
  it("business_activities-INSERT-feil etterlater INGEN ticket-, event- eller activity-rad (ekte rollback, ikke antatt)", async () => {
    await installPoisonTrigger(adminPool);
    try {
      await expect(
        support.createTicket(TENANT_A, "business", {
          subject: "Poison-Create-Test",
          company_id: "co-sup-atom-a",
          initial_summary: `Kunde-melding ${POISON_MARKER} skal trigge feilinjeksjonen`
        })
      ).rejects.toThrow();

      const ticketRows = await adminPool.query(
        `SELECT 1 FROM support_tickets WHERE tenant_id = $1 AND subject = $2`,
        [TENANT_A, "Poison-Create-Test"]
      );
      expect(ticketRows.rows).toHaveLength(0);

      const eventRows = await adminPool.query(
        `SELECT 1 FROM support_ticket_events WHERE tenant_id = $1 AND summary LIKE $2`,
        [TENANT_A, `%${POISON_MARKER}%`]
      );
      expect(eventRows.rows).toHaveLength(0);

      const activityRows = await adminPool.query(
        `SELECT 1 FROM business_activities WHERE tenant_id = $1 AND summary LIKE $2`,
        [TENANT_A, `%${POISON_MARKER}%`]
      );
      expect(activityRows.rows).toHaveLength(0);
    } finally {
      await removePoisonTrigger(adminPool);
    }
  });

  it("uten feilinjeksjon lykkes SAMME kall og produserer BÅDE ticket OG business_activities-rad (sanity-motstykke)", async () => {
    const ticket = await support.createTicket(TENANT_A, "business", {
      subject: "Poison-Sanity-Test",
      company_id: "co-sup-atom-a",
      initial_summary: "Kunde-melding uten markør"
    });
    const activityRows = await adminPool.query(
      `SELECT 1 FROM business_activities WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT_A, `${ticket.ticket_id}:created`]
    );
    expect(activityRows.rows).toHaveLength(1);
  });
});

describe("Blocker B (Q-33): cross-scope company_id/contact_id avvises FØR noen rad skrives", () => {
  it("createTicket avviser et company_id fra en ANNEN tenant - INGEN ticket-rad opprettes", async () => {
    await expect(
      support.createTicket(TENANT_A, "business", { subject: "Cross-tenant company", company_id: "co-sup-atom-b" })
    ).rejects.toThrow(SupportCrossScopeReferenceError);
    const rows = await adminPool.query(`SELECT 1 FROM support_tickets WHERE tenant_id = $1 AND subject = $2`, [TENANT_A, "Cross-tenant company"]);
    expect(rows.rows).toHaveLength(0);
  });

  it("createTicket avviser et contact_id fra en ANNEN tenant - INGEN ticket-rad opprettes", async () => {
    await expect(
      support.createTicket(TENANT_A, "business", { subject: "Cross-tenant contact", contact_id: "ct-sup-atom-b" })
    ).rejects.toThrow(SupportCrossScopeReferenceError);
    const rows = await adminPool.query(`SELECT 1 FROM support_tickets WHERE tenant_id = $1 AND subject = $2`, [TENANT_A, "Cross-tenant contact"]);
    expect(rows.rows).toHaveLength(0);
  });

  it("createTicket avviser naar contact_id tilhoerer en ANNEN company enn oppgitt company_id (mismatch)", async () => {
    await expect(
      support.createTicket(TENANT_A, "business", { subject: "Mismatch", company_id: "co-sup-atom-a2", contact_id: "ct-sup-atom-a" })
    ).rejects.toThrow(SupportContactCompanyMismatchError);
    const rows = await adminPool.query(`SELECT 1 FROM support_tickets WHERE tenant_id = $1 AND subject = $2`, [TENANT_A, "Mismatch"]);
    expect(rows.rows).toHaveLength(0);
  });

  it("ingestMessage (ny ticket paa FØRSTE melding i en tråd) avviser et company_id fra en ANNEN tenant", async () => {
    await expect(
      support.ingestMessage(TENANT_A, "business", {
        channel: "email", source_type: "gmail", source_instance_id: "acct-atom",
        source_thread_id: "thread-atom-cross", source_message_id: "msg-atom-cross",
        subject: "Cross-tenant ingress", summary: "Kunde melder", is_from_customer: true,
        company_id: "co-sup-atom-b", entity_resolution: "matched"
      })
    ).rejects.toThrow(SupportCrossScopeReferenceError);
    const rows = await adminPool.query(
      `SELECT 1 FROM support_tickets WHERE tenant_id = $1 AND source_thread_id = $2`,
      [TENANT_A, "thread-atom-cross"]
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("samme-tenant/samme-space gyldig company_id+contact_id-kombinasjon avvises ALDRI (ingen falsk positiv)", async () => {
    const ticket = await support.createTicket(TENANT_A, "business", {
      subject: "Valid combo", company_id: "co-sup-atom-a", contact_id: "ct-sup-atom-a"
    });
    expect(ticket.company_id).toBe("co-sup-atom-a");
    expect(ticket.contact_id).toBe("ct-sup-atom-a");
  });
});

/**
 * DETERMINISTISK feilinjeksjon (IKKE en permission-hack): en midlertidig
 * `BEFORE INSERT`-trigger paa `business_activities` (installert/fjernet via
 * `adminPool`, altsaa UTENFOR appens NOSUPERUSER/NOBYPASSRLS-rolle) som
 * kaster naar `NEW.summary` inneholder en kjent markør. Kjøres med
 * SECURITY INVOKER (Postgres-standard) - fyres uansett hvilken rolle som
 * faktisk utfoerer INSERT-en (her: appens `jarvis_sup_atom_test`-rolle via
 * `SupportService`), helt uavhengig av RLS (triggeren kjoerer FØR
 * RLS-policyen evalueres for selve raden).
 */
async function installPoisonTrigger(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION jarvis_test_poison_activity_insert() RETURNS trigger AS $$
    BEGIN
      IF NEW.summary LIKE '%${POISON_MARKER}%' THEN
        RAISE EXCEPTION 'jarvis_test_poison_activity_insert: deterministic test-injected failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`
    CREATE TRIGGER jarvis_test_poison_trigger BEFORE INSERT ON business_activities
    FOR EACH ROW EXECUTE FUNCTION jarvis_test_poison_activity_insert();
  `);
}

async function removePoisonTrigger(pool: pg.Pool): Promise<void> {
  await pool.query(`DROP TRIGGER IF EXISTS jarvis_test_poison_trigger ON business_activities`);
  await pool.query(`DROP FUNCTION IF EXISTS jarvis_test_poison_activity_insert()`);
}
