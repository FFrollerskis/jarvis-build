// One-shot migrasjonskjøring (BO-07): kjøres som egen compose-tjeneste FØR api/worker
// starter (service_completed_successfully) slik at flere instanser aldri kappløper
// om skjemaet. Avslutter med kode 0 kun når alle migrasjoner er på plass.
// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { configFromEnv, createPool, runMigrations } from "@jarvis/core";
import { seedOwner } from "./seed.ts";

const pool = createPool(configFromEnv());
try {
  await runMigrations(pool);
  // Owner-seed (BO-08 + D-30 voice-device): idempotent, delt funksjon (testes
  // direkte) - fjerner det manuelle one-time-SQL-steget fra BO-07.
  await seedOwner(pool);
  console.log(JSON.stringify({ msg: "migrations_complete", owner_seed: "ensured" }));
} finally {
  await pool.end();
}
