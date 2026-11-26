// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import type { OwnerConfig } from "@jarvis/contracts";

/** `production`/`prod` (uavhengig av store/små bokstaver) regnes som produksjon; alt annet (inkl. uset) er dev. */
export function isProductionEnv(value: string | undefined): boolean {
  return value !== undefined && /^(production|prod)$/i.test(value.trim());
}

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
 * `dev-web` er `apps/web/index.html`s dev-chat-demo sin enhet (D-395: seedes ikke når `JARVIS_ENV=production`).
 *
 * D-131 (uavhengig arkitektkontroll av PR #79, funn 2): raden seedes fortsatt,
 * men den er ikke lenger noen forutsetning for innrullering -
 * `DeviceEnrollmentService` oppretter raden selv når en gyldig eier-billett
 * legges fram. Ingen av de seedede radene har `public_key_pem`, og det er
 * hele poenget: en seedet enhet UTEN nøkkel kan ikke bevise noe som helst, og
 * kan derfor ikke gi noen autoritet. Nøkkelen kommer først når eieren faktisk
 * innrullerer enheten med et eksplisitt bevis (`pnpm --filter @jarvis/api
 * enroll-ticket`, eller proof-of-possession fra en allerede innrullert enhet).
 * Seeden er altså identitets-/medlemskapsdata, ALDRI en tillitsgrense.
 */
export async function seedOwner(pool: pg.Pool, owner: OwnerConfig): Promise<void> {
  // Remediering del 2 (JARVIS-065): eier-identiteten kommer fra validert konfig (`loadOwnerConfig`) - ingen defaults.
  const tenant = owner.tenant_id;
  const person = owner.owner_person_id;
  const name = owner.owner_display_name;
  const voiceDevice = process.env["JARVIS_VOICE_DEVICE_ID"] ?? "jarvis-voice-live";
  await pool.query("INSERT INTO tenants (tenant_id,name,kind) VALUES ($1,$2,'person') ON CONFLICT DO NOTHING", [tenant, name]);
  await pool.query("INSERT INTO people (person_id,display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [person, name]);
  await pool.query("INSERT INTO person_tenants (person_id,tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [person, tenant]);
  // WP-S1 (JARVIS-111): seed-radene får en eksplisitt, lukket enhetstype (`device_kind`, kilde `trusted_provisioning` = server-side kode). Ingen av dem har en nøkkel og kan derfor ikke autorisere noe uansett type.
  await pool.query(
    "INSERT INTO devices (device_id,tenant_id,person_id,kind,device_kind,device_kind_source) VALUES ('jarvis-core',$1,$2,'service','service','trusted_provisioning') ON CONFLICT DO NOTHING",
    [tenant, person]
  );
  await pool.query(
    "INSERT INTO devices (device_id,tenant_id,person_id,kind,device_kind,device_kind_source) VALUES ($1,$2,$3,'voice','voice_gateway','trusted_provisioning') ON CONFLICT DO NOTHING",
    [voiceDevice, tenant, person]
  );
  // D-395 (JARVIS-092): `dev-web` er en delt demo-enhet (nettleserne bruker per-nettleser-ID siden D-252) - den seedes IKKE i produksjon
  // (`JARVIS_ENV=production`). Raden har ingen offentlig nøkkel og kan ikke autentisere, men en produksjonsdatabase skal ikke bære demo-rader.
  if (!isProductionEnv(process.env["JARVIS_ENV"])) {
    await pool.query(
      "INSERT INTO devices (device_id,tenant_id,person_id,kind,device_kind,device_kind_source) VALUES ('dev-web',$1,$2,'web','web_browser','trusted_provisioning') ON CONFLICT DO NOTHING",
      [tenant, person]
    );
  }
  await pool.query(
    "INSERT INTO memory_spaces (memory_space_id,tenant_id,space) VALUES ('personal',$1,'personal') ON CONFLICT DO NOTHING",
    [tenant]
  );
}
