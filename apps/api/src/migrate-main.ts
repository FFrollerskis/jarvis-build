// One-shot migrasjonskjøring (BO-07): kjøres som egen compose-tjeneste FØR api/worker
// starter (service_completed_successfully) slik at flere instanser aldri kappløper
// om skjemaet. Avslutter med kode 0 kun når alle migrasjoner er på plass.
// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import { configFromEnv, createPool, runMigrations } from "@jarvis/core";

const pool = createPool(configFromEnv());
try {
  await runMigrations(pool);
  console.log(JSON.stringify({ msg: "migrations_complete" }));
} finally {
  await pool.end();
}
