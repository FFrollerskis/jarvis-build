// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";

/**
 * Owner-seed (BO-08 + D-30 live-funn): identitetsdata for fersk database,
 * idempotent (ON CONFLICT DO NOTHING). ID-ene er konfig - aldri hardkodet i
 * domenelogikk (D-34-prinsippet). Ingen secrets.
 *
 * D-30: voice-gatewayen identifiserer seg med egen device (`jarvis-voice-live`
 * som default, konfigurerbar via JARVIS_VOICE_DEVICE_ID). Uten seed ga /chat
 * 403 identity_denied/unknown_device på host-live - derfor seedes den her,
 * i samme transaksjonsfrie idempotente stil som jarvis-core.
 *
 * D-130 arkitekt-review MERGE BLOCKER 1-fiks: `apps/web/index.html`s dev-
 * chat-demo registrerer nå sin egen enhetsnøkkel via `/devices/register` FØR
 * den kan autorisere en sesjon - men `/devices/register` selv krever en
 * ALLEREDE KJENT enhet (`resolveIdentity()` avviser `unknown_device` for en
 * device_id uten noen rad i det hele tatt, uavhengig av om raden har en
 * nøkkel). Samme bootstrap-mønster som `jarvis-core`/den beviste
 * voice-enheten over - IKKE en ny tillitsgrense, kun én til rad i den
 * samme idempotente pre-seeden slik at web-demoen faktisk fungerer på en
 * fersk database.
 */
export async function seedOwner(pool: pg.Pool): Promise<void> {
  const tenant = process.env["JARVIS_TENANT_ID"] ?? "tenant-personal";
  const person = process.env["JARVIS_OWNER_PERSON_ID"] ?? "person-tobias";
  const name = process.env["JARVIS_OWNER_NAME"] ?? "Tobias";
  const voiceDevice = process.env["JARVIS_VOICE_DEVICE_ID"] ?? "jarvis-voice-live";
  await pool.query("INSERT INTO tenants (tenant_id,name,kind) VALUES ($1,$2,'person') ON CONFLICT DO NOTHING", [tenant, name]);
  await pool.query("INSERT INTO people (person_id,display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [person, name]);
  await pool.query("INSERT INTO person_tenants (person_id,tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [person, tenant]);
  await pool.query(
    "INSERT INTO devices (device_id,tenant_id,person_id,kind) VALUES ('jarvis-core',$1,$2,'service') ON CONFLICT DO NOTHING",
    [tenant, person]
  );
  await pool.query(
    "INSERT INTO devices (device_id,tenant_id,person_id,kind) VALUES ($1,$2,$3,'voice') ON CONFLICT DO NOTHING",
    [voiceDevice, tenant, person]
  );
  await pool.query(
    "INSERT INTO devices (device_id,tenant_id,person_id,kind) VALUES ('dev-web',$1,$2,'web') ON CONFLICT DO NOTHING",
    [tenant, person]
  );
  await pool.query(
    "INSERT INTO memory_spaces (memory_space_id,tenant_id,space) VALUES ('personal',$1,'personal') ON CONFLICT DO NOTHING",
    [tenant]
  );
}
