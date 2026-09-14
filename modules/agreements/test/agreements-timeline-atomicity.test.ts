import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { AgreementsContactCompanyMismatchError, AgreementsCrossScopeReferenceError, AgreementsService } from "../src/service.ts";

/**
 * Arkitekt-review MERGE BLOCKER A+B (D-130/Q-33, PR #79): ekte Postgres-bevis
 * for de to fiksene i denne slicen, mot en EKTE NOSUPERUSER/NOBYPASSRLS-rolle
 * (samme mønster som `service-rls.test.ts`/`agreements-business-timeline.test.ts`
 * - IKKE en `fakePool()`-mock). Speiler `support-timeline-atomicity.test.ts`
 * sin struktur/kommentarer 1:1 for Agreements-domenet.
 *
 *  (A) `addVersion()`s tidslinje-speiling (business_activities) skjer NAA i
 *      SAMME transaksjon som selve versjons-/event-raden - feiler INSERT-en,
 *      ruller HELE transaksjonen (versjonsraden inkludert, IKKE kontrakten -
 *      den ble committet av et TIDLIGERE, separat createContract()-kall)
 *      tilbake. Bevist med en DETERMINISTISK feilinjeksjon - `addVersion()`
 *      sin `input.summary` er DIREKTE innbakt i den endelige
 *      business_activities-summary-en, saa markøren trenger ingen ekstra
 *      trigger-logikk utover `support-timeline-atomicity.test.ts` sin - se
 *      `installPoisonTrigger()`.
 *  (B) `assertCompanyContactInScope()` (Q-33) avviser et caller-oppgitt
 *      company_id/contact_id FØR noen INSERT skjer, BÅDE i `createContract()`
 *      og `linkCounterparty()` - se `modules/operations/src/service.ts` sin
 *      `assertCompanyContactInScope()` for det opprinnelige mønsteret (D-129).
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let agreements: AgreementsService;

const TENANT_A = "tenant-agr-atom-a";
const TENANT_B = "tenant-agr-atom-b";
const POISON_MARKER = "__JARVIS_TEST_POISON__";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-agreements-atomicity-"));
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

  await adminPool.query("CREATE ROLE jarvis_agr_atom_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_agr_atom_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Agreements Atomicity A', 'business'), ('${TENANT_B}', 'Agreements Atomicity B', 'business')`
  );
  // `business_companies.company_id`/`business_contacts.contact_id` er GLOBALE
  // primærnøkler (ingen sammensatt tenant-nøkkel) - to distinkte selskaper i
  // TENANT_A (for mismatch-testen) og ett i TENANT_B (for kryss-tenant-testen).
  await adminPool.query(
    `INSERT INTO business_companies (company_id, tenant_id, name) VALUES
       ('co-agr-atom-a', '${TENANT_A}', 'Acme AS'),
       ('co-agr-atom-a2', '${TENANT_A}', 'Contoso AS'),
       ('co-agr-atom-b', '${TENANT_B}', 'Globex AS')`
  );
  await adminPool.query(
    `INSERT INTO business_contacts (contact_id, tenant_id, company_id, name, email) VALUES
       ('ct-agr-atom-a', '${TENANT_A}', 'co-agr-atom-a', 'Kari', 'kari@acme.no'),
       ('ct-agr-atom-b', '${TENANT_B}', 'co-agr-atom-b', 'Ola', 'ola@globex.no')`
  );

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_agr_atom_test", password: "pw2" });
  agreements = new AgreementsService(appPool);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("Blocker A: addVersion() ruller HELE transaksjonen tilbake naar business_activities-skrivingen feiler", () => {
  it("business_activities-INSERT-feil etterlater INGEN versjons-, event- eller activity-rad (ekte rollback, ikke antatt)", async () => {
    const contract = await agreements.createContract(TENANT_A, "business", { title: "Poison-Version-Kontrakt", company_id: "co-agr-atom-a" });

    await installPoisonTrigger(adminPool);
    try {
      await expect(
        agreements.addVersion(TENANT_A, "business", contract.contract_id, {
          summary: `Versjonsnotat ${POISON_MARKER} skal trigge feilinjeksjonen`
        })
      ).rejects.toThrow();

      const versionRows = await adminPool.query(
        `SELECT 1 FROM contract_versions WHERE tenant_id = $1 AND contract_id = $2`,
        [TENANT_A, contract.contract_id]
      );
      expect(versionRows.rows).toHaveLength(0);

      const eventRows = await adminPool.query(
        `SELECT 1 FROM contract_events WHERE tenant_id = $1 AND contract_id = $2 AND event_type = 'version_added'`,
        [TENANT_A, contract.contract_id]
      );
      expect(eventRows.rows).toHaveLength(0);

      const activityRows = await adminPool.query(
        `SELECT 1 FROM business_activities WHERE tenant_id = $1 AND summary LIKE $2`,
        [TENANT_A, `%${POISON_MARKER}%`]
      );
      expect(activityRows.rows).toHaveLength(0);

      // Kontrakten selv ble committet av det TIDLIGERE, separate
      // createContract()-kallet over - addVersion() sin rollback ruller
      // KUN tilbake sin EGEN transaksjon (versjonen), aldri kontrakt-raden.
      const current = await agreements.getCurrentVersion(TENANT_A, "business", contract.contract_id);
      expect(current).toBeNull();
    } finally {
      await removePoisonTrigger(adminPool);
    }
  });

  it("uten feilinjeksjon lykkes SAMME kall og produserer BÅDE versjons- OG business_activities-rad (sanity-motstykke)", async () => {
    const contract = await agreements.createContract(TENANT_A, "business", { title: "Poison-Sanity-Kontrakt", company_id: "co-agr-atom-a" });
    const version = await agreements.addVersion(TENANT_A, "business", contract.contract_id, { summary: "Versjonsnotat uten markør" });
    const activityRows = await adminPool.query(
      `SELECT 1 FROM business_activities WHERE tenant_id = $1 AND external_id = $2`,
      [TENANT_A, `${contract.contract_id}:version:${version.version_number}`]
    );
    expect(activityRows.rows).toHaveLength(1);
  });
});

describe("Blocker B (Q-33): cross-scope company_id/contact_id avvises FØR noen rad skrives", () => {
  it("createContract avviser et company_id fra en ANNEN tenant - INGEN kontrakt-rad opprettes", async () => {
    await expect(
      agreements.createContract(TENANT_A, "business", { title: "Cross-tenant company", company_id: "co-agr-atom-b" })
    ).rejects.toThrow(AgreementsCrossScopeReferenceError);
    const rows = await adminPool.query(`SELECT 1 FROM contracts WHERE tenant_id = $1 AND title = $2`, [TENANT_A, "Cross-tenant company"]);
    expect(rows.rows).toHaveLength(0);
  });

  it("createContract avviser et contact_id fra en ANNEN tenant - INGEN kontrakt-rad opprettes", async () => {
    await expect(
      agreements.createContract(TENANT_A, "business", { title: "Cross-tenant contact", contact_id: "ct-agr-atom-b" })
    ).rejects.toThrow(AgreementsCrossScopeReferenceError);
    const rows = await adminPool.query(`SELECT 1 FROM contracts WHERE tenant_id = $1 AND title = $2`, [TENANT_A, "Cross-tenant contact"]);
    expect(rows.rows).toHaveLength(0);
  });

  it("createContract avviser naar contact_id tilhoerer en ANNEN company enn oppgitt company_id (mismatch)", async () => {
    await expect(
      agreements.createContract(TENANT_A, "business", { title: "Mismatch", company_id: "co-agr-atom-a2", contact_id: "ct-agr-atom-a" })
    ).rejects.toThrow(AgreementsContactCompanyMismatchError);
    const rows = await adminPool.query(`SELECT 1 FROM contracts WHERE tenant_id = $1 AND title = $2`, [TENANT_A, "Mismatch"]);
    expect(rows.rows).toHaveLength(0);
  });

  it("linkCounterparty avviser et company_id fra en ANNEN tenant - kontraktens motpart forblir UENDRET", async () => {
    const contract = await agreements.createContract(TENANT_A, "business", { title: "Link-Cross-Tenant" });
    await expect(
      agreements.linkCounterparty(TENANT_A, "business", contract.contract_id, "co-agr-atom-b", null)
    ).rejects.toThrow(AgreementsCrossScopeReferenceError);
    const unchanged = await agreements.getContract(TENANT_A, "business", contract.contract_id);
    expect(unchanged?.company_id).toBeNull();
  });

  it("linkCounterparty avviser naar contact_id tilhoerer en ANNEN company enn oppgitt company_id (mismatch)", async () => {
    const contract = await agreements.createContract(TENANT_A, "business", { title: "Link-Mismatch" });
    await expect(
      agreements.linkCounterparty(TENANT_A, "business", contract.contract_id, "co-agr-atom-a2", "ct-agr-atom-a")
    ).rejects.toThrow(AgreementsContactCompanyMismatchError);
    const unchanged = await agreements.getContract(TENANT_A, "business", contract.contract_id);
    expect(unchanged?.company_id).toBeNull();
    expect(unchanged?.contact_id).toBeNull();
  });

  it("linkCounterparty med company_id=null/contact_id=null (fjern kobling) hopper BEVISST over vakten - ingen falsk avvisning ved fjerning", async () => {
    const contract = await agreements.createContract(TENANT_A, "business", { title: "Link-Clear", company_id: "co-agr-atom-a" });
    const cleared = await agreements.linkCounterparty(TENANT_A, "business", contract.contract_id, null, null);
    expect(cleared?.company_id).toBeNull();
  });

  it("samme-tenant/samme-space gyldig company_id+contact_id-kombinasjon avvises ALDRI, verken i createContract eller linkCounterparty (ingen falsk positiv)", async () => {
    const created = await agreements.createContract(TENANT_A, "business", {
      title: "Valid combo", company_id: "co-agr-atom-a", contact_id: "ct-agr-atom-a"
    });
    expect(created.company_id).toBe("co-agr-atom-a");
    expect(created.contact_id).toBe("ct-agr-atom-a");

    const bare = await agreements.createContract(TENANT_A, "business", { title: "Valid combo via link" });
    const linked = await agreements.linkCounterparty(TENANT_A, "business", bare.contract_id, "co-agr-atom-a", "ct-agr-atom-a");
    expect(linked?.company_id).toBe("co-agr-atom-a");
    expect(linked?.contact_id).toBe("ct-agr-atom-a");
  });
});

/**
 * DETERMINISTISK feilinjeksjon (IKKE en permission-hack): en midlertidig
 * `BEFORE INSERT`-trigger paa `business_activities` (installert/fjernet via
 * `adminPool`, altsaa UTENFOR appens NOSUPERUSER/NOBYPASSRLS-rolle) som
 * kaster naar `NEW.summary` inneholder en kjent markør. Kjøres med
 * SECURITY INVOKER (Postgres-standard) - fyres uansett hvilken rolle som
 * faktisk utfoerer INSERT-en (her: appens `jarvis_agr_atom_test`-rolle via
 * `AgreementsService`), helt uavhengig av RLS (triggeren kjoerer FØR
 * RLS-policyen evalueres for selve raden). Samme funksjon/trigger-navn som
 * `support-timeline-atomicity.test.ts` - trygt, siden hver testfil kjoerer
 * mot sin EGEN, isolerte embedded-postgres-instans.
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
