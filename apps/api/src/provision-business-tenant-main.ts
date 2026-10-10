// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
//
// WP-D2 (JARVIS-044 / Q-44 / Q-48): EIER-INITIERT oppretting av en bedrifts-tenant på NAS-en. Hele den kanoniske mekanismen ligger i
// `provisionBusinessTenant()` (@jarvis/core); denne filen er kun prosess-inngangen. Se `provision-business-tenant-cli.ts` for logikk og
// `docs/runbooks/WPD2_BUSINESS_OS.md` for hva du må gjøre etterpå.
//
// Autoritet (samme argument som `enroll-ticket-main.ts`, D-131): du har admin-tilgang til databasen og kjørte kommandoen selv. Ingen ny credential
// (SAMME admin-DB-miljø som migrasjonene), ingen leverandør, ingenting kjører automatisk - hverken ved oppstart, seed eller migrering.
//
// Bruk (på NAS, fra repoets rot - kjører i `migrate`-tjenesten som har admin-DB):
//   ops/nas/provision-business-tenant.sh "Kundeoppfølging AS" [slug]            # dry-run: viser planen, skriver ingenting
//   ops/nas/provision-business-tenant.sh "Kundeoppfølging AS" [slug] --confirm tenant-kundeoppfolging-as
//
// Direkte (utvikling):
//   node --experimental-transform-types src/provision-business-tenant-main.ts --name "Kundeoppfølging AS" [--slug kundeoppfolging] [--confirm <tenant_id>]
import "./normalize-env.ts";
import { adminConfigFromEnv, createPool } from "@jarvis/core";
import { ownerConfigOrExit } from "./owner.ts";
import { runProvisionBusinessTenantCli } from "./provision-business-tenant-cli.ts";

// Eier fra validert konfig (fail closed uten) - samme kilde som seed og enroll-ticket.
const ownerConfig = ownerConfigOrExit();
const adminPool = createPool(adminConfigFromEnv());
try {
  process.exitCode = await runProvisionBusinessTenantCli(
    process.argv.slice(2),
    { owner_person_id: ownerConfig.owner_person_id, owner_tenant_id: ownerConfig.tenant_id },
    adminPool,
    { out: (line) => console.log(line), err: (line) => console.error(line) }
  );
} finally {
  await adminPool.end();
}
