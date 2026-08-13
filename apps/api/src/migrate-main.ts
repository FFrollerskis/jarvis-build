// One-shot migrasjonskjøring (BO-07): kjøres som egen compose-tjeneste FØR api/worker
// starter (service_completed_successfully) slik at flere instanser aldri kappløper
// om skjemaet. Avslutter med kode 0 kun når alle migrasjoner er på plass.
// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { configFromEnv, createPool, runMigrations } from "@jarvis/core";

const pool = createPool(configFromEnv());
try {
  await runMigrations(pool);
  // Owner-seed (BO-08): identitetsdata for fersk database, idempotent (ON CONFLICT
  // DO NOTHING) - fjerner det manuelle one-time-SQL-steget fra BO-07. Ingen secrets;
  // ID-ene er konfig (samme prinsipp som D-34: aldri hardkodet i domenelogikk).
  const tenant = process.env["JARVIS_TENANT_ID"] ?? "tenant-personal";
  const person = process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias";
  const name = process.env["JARVIS_OWNER_NAME"] ?? "Tobias";
  await pool.query("INSERT INTO tenants (tenant_id,name,kind) VALUES ($1,$2,'person') ON CONFLICT DO NOTHING", [tenant, name]);
  await pool.query("INSERT INTO people (person_id,display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [person, name]);
  await pool.query("INSERT INTO person_tenants (person_id,tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [person, tenant]);
  await pool.query(
    "INSERT INTO devices (device_id,tenant_id,person_id,kind) VALUES ('jarvis-core',$1,$2,'service') ON CONFLICT DO NOTHING",
    [tenant, person]
  );
  await pool.query(
    "INSERT INTO memory_spaces (memory_space_id,tenant_id,space) VALUES ('personal',$1,'personal') ON CONFLICT DO NOTHING",
    [tenant]
  );
  console.log(JSON.stringify({ msg: "migrations_complete", owner_seed: "ensured" }));
} finally {
  await pool.end();
}
