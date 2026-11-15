import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import { ErasureService } from "../src/index.ts";

/**
 * D-395 (JARVIS-030): erasure-planene dekket 87 av 128 tabeller, og `session_grants` blokkerte sletting av enhver sesjon med et grant.
 *  A. Sesjon med grant kan slettes (FK-kaskade) - uten at runtime-rollen får DELETE på session_grants.
 *  B. Dekningsvakt: hver tabell med `tenant_id` står i planen ELLER i en eksplisitt, begrunnet BASELINE. Baselinen kan bare krympe: en NY tabell uten
 *     registrering feiler, og en baseline-tabell som blir dekket må fjernes fra listen.
 */
const PLAN_SRC = fileURLToPath(new URL("../src/plan.ts", import.meta.url));
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let adminPool: pg.Pool;
let appPool: pg.Pool;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-erasure-cov-"));
  const leased = await startLeasedEmbeddedPostgres((port) => new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false }));
  stopEmbeddedPostgres = leased.stop;
  await leased.postgres.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);
  await adminPool.query("CREATE ROLE jarvis_erasure_cov LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_erasure_cov");
  appPool = createPool({ host: "127.0.0.1", port: leased.port, database: "jarvis_test", user: "jarvis_erasure_cov", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

describe("A: sesjon med enhets-grant kan slettes", () => {
  it("DELETE FROM sessions kaskaderer til session_grants (tidligere FK-brudd) - runtime-rollen har fortsatt ikke DELETE på session_grants", async () => {
    await adminPool.query(`
      INSERT INTO tenants (tenant_id, name, kind) VALUES ('t-er', 'E', 'person');
      INSERT INTO people (person_id, display_name) VALUES ('p-er', 'E');
      INSERT INTO devices (device_id, tenant_id, person_id, kind) VALUES ('d-er', 't-er', 'p-er', 'pc');
      INSERT INTO sessions (session_id, tenant_id, person_id, last_channel, last_device_id) VALUES ('s-er', 't-er', 'p-er', 'web', 'd-er');
      INSERT INTO session_grants (grant_id, tenant_id, person_id, device_id, session_id, memory_space, channel, auth_strength, device_key_fingerprint, expires_at)
        VALUES ('g-er', 't-er', 'p-er', 'd-er', 's-er', 'personal', 'web', 'active', 'fp', now() + interval '1 hour');
    `);
    await expect(appPool.query("DELETE FROM session_grants")).rejects.toThrow(/permission denied/);
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('jarvis.tenant_id', 't-er', true)");
      const deleted = await client.query("DELETE FROM sessions WHERE session_id = 's-er'");
      await client.query("COMMIT");
      expect(deleted.rowCount).toBe(1);
    } finally {
      client.release();
    }
    const left = await adminPool.query("SELECT count(*)::int AS n FROM session_grants WHERE session_id = 's-er'");
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });

  it("ErasureService finnes og er bygget mot samme pool (sanity for dekningsvakten under)", () => {
    expect(typeof ErasureService).toBe("function");
  });
});

/**
 * Tabeller med `tenant_id` som erasure-planene IKKE refererer ennå. Hver gruppe har en begrunnelse. Baselinen er et GJELD-register (DEFERRED), ikke et
 * unntak: å legge til planregistrering for en tabell og fjerne den herfra er riktig retning.
 */
const BASELINE_REASON: Record<string, string> = {
  // APPEND_ONLY_EVIDENCE: revisjons-/bevistabeller (append-only eller replay-vern); sletting er en eierbeslutning om oppbevaring/juridisk grunnlag (JARVIS-074/030), ikke en teknisk lapp
  action_confirmations: "APPEND_ONLY_EVIDENCE",
  approvals: "APPEND_ONLY_EVIDENCE",
  audit_events: "APPEND_ONLY_EVIDENCE",
  cost_events: "APPEND_ONLY_EVIDENCE",
  connector_maintenance_log: "APPEND_ONLY_EVIDENCE",
  erasure_fingerprints: "APPEND_ONLY_EVIDENCE",
  erasure_requests: "APPEND_ONLY_EVIDENCE",
  events: "APPEND_ONLY_EVIDENCE",
  // WP-K (D-471, JARVIS-053, migrasjon 108): policy-journalen er append-only (ingen DELETE-grant for runtime; kun `prune_policy_decisions()` sletter, etter 90 dager) og inneholder kun metadata - samme kategori som `audit_events`/`tool_executions`.
  // PRESIS (review L3): tabellen er IKKE dekket av noen erasure-plan og slettes IKKE av en kaskade - dette er en oppføring i GJELDSREGISTERET, ikke en løsning. `tenant_id` har FK mot `tenants` UTEN `ON DELETE CASCADE`, så en hard
  // `DELETE FROM tenants` (admin-opprydding) må først slette tenantens `policy_decisions` som admin, og `person_id` står i klartekst til retensjonen (standard 90 dager, gulv 30) har ryddet raden. Om erasure skal pseudonymisere
  // `person_id` her er en eierbeslutning sammen med `audit_events` (JARVIS-030/074) - ikke tatt i WP-K, og tabellen er tom så lenge `JARVIS_POLICY_AUDIT_SINK` er AV.
  policy_decisions: "APPEND_ONLY_EVIDENCE",
  revoked_device_keys: "APPEND_ONLY_EVIDENCE",
  tool_executions: "APPEND_ONLY_EVIDENCE",
  // IDENTITY_SCAFFOLD: identitets-/strukturrader som følger tenant-/person-slettingen på høyere nivå (tenants/people), ikke en datainnholds-sletting per scope
  device_enrollment_tickets: "IDENTITY_SCAFFOLD",
  devices: "IDENTITY_SCAFFOLD",
  memory_spaces: "IDENTITY_SCAFFOLD",
  organizations: "IDENTITY_SCAFFOLD",
  person_tenants: "IDENTITY_SCAFFOLD",
  projects: "IDENTITY_SCAFFOLD",
  rooms: "IDENTITY_SCAFFOLD",
  sites: "IDENTITY_SCAFFOLD",
  brief_seen: "IDENTITY_SCAFFOLD",
  // CASCADED: slettes via FK-kaskade fra en tabell planen allerede sletter (074)
  session_grants: "CASCADED",
  // Q-44 (D-435, migrasjon 081): koblingstabellen fikk tenant_id; ON DELETE CASCADE fra incident_diagnoses (komposittnøkkel) fjerner lenkene når diagnosene slettes.
  incident_diagnosis_evidence: "CASCADED",
  // WP-E1 (JARVIS-068, migrasjon 096): varig overgangshistorikk. ON DELETE CASCADE fra incidents (komposittnøkkel) fjerner den når hendelsen slettes; en BEFORE DELETE-vakt
  // avviser direkte sletting så lenge hendelsen finnes (append-only), så erasure går via hendelsen - aldri ved å skrive om historikken.
  incident_transitions: "CASCADED",
  // CRM_CORE: Business Graph-kjernen (companies/leads/opportunities/...) - PRE-EKSISTERENDE gap fra UA-3 P0 (se plan.ts-kommentar, D-66)
  business_activities: "CRM_CORE",
  business_companies: "CRM_CORE",
  business_followups: "CRM_CORE",
  business_leads: "CRM_CORE",
  business_opportunities: "CRM_CORE",
  business_scores: "CRM_CORE",
  // OPERATIONAL: oppgave-/infra-/hendelsestilstand uten egen person-/space-nøkkel ennå
  deployments: "OPERATIONAL",
  incident_producer_runs: "OPERATIONAL",
  incident_repair_tasks: "OPERATIONAL",
  infra_executions: "OPERATIONAL",
  infra_recovery_actions: "OPERATIONAL",
  memory_sources: "OPERATIONAL",
  situation_autonomy_policies: "OPERATIONAL",
  situation_notification_policies: "OPERATIONAL",
  tasks: "OPERATIONAL",
};

describe("B: dekningsvakt", () => {
  it("hver tenant-tabell er i erasure-planen eller i den begrunnede baselinen - baselinen kan bare krympe", async () => {
    const plan = await readFile(PLAN_SRC, "utf8");
    const { rows } = await adminPool.query(
      `SELECT DISTINCT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`
    );
    const tenantTables = (rows as { table_name: string }[]).map((r) => r.table_name);
    expect(tenantTables.length).toBeGreaterThan(100);
    const covered = (t: string): boolean => new RegExp(`(?:["'\\s,(]|^)${t}(?:["'\\s,)]|$)`).test(plan);
    const uncovered = tenantTables.filter((t) => !covered(t));
    const baseline = Object.keys(BASELINE_REASON);
    expect(uncovered.filter((t) => !baseline.includes(t)), "NYE tabeller uten erasure-registrering - registrer dem i plan.ts (eller baseline med begrunnelse)").toEqual([]);
    expect(baseline.filter((t) => !uncovered.includes(t)), "baseline-tabeller som nå ER dekket - fjern dem fra BASELINE_REASON").toEqual([]);
  });
});
