/**
 * UA-6 Finance & Spend Integrity Gateway - HARDENING (D-116): deterministisk
 * vendor-identitet/provider-referanse-registrering. Lukker masterplanens
 * akseptansekriterium 3 sitt eneste gjenværende delgap (D-115): en
 * SYNTAKTISK gyldig, men FEIL `vendor_provider_ref` kunne ikke skilles fra
 * en korrekt verdi. Se `045_finance_vendor_registry.sql` for full
 * arkitekturbegrunnelse (Core-vs-Adapter, reuse-audit).
 *
 * Registeret sier KUN: "denne provider-referansen er DEN eier-/
 * systemregistrerte referansen for denne Jarvis-vendor-identiteten." Det
 * er ALDRI en live-provider-verifikasjon (D-108 forblir uendret utsatt) -
 * kun at et FORSØK PÅ Å BRUKE en annen referanse enn den registrerte
 * oppdages FØR provider-transporten kalles.
 *
 * Alle funksjoner tar en EKSISTERENDE `pg.PoolClient` (aldri sin egen
 * pool/transaksjon) - `assertValidVendorBinding()` MÅ kunne kjøres i SAMME
 * transaksjon som `submitPaymentIntent()` sin `readForUpdate()`/
 * provider-dispatch, slik at en mismatch garantert kastes FØR noe
 * utgående side-effekt (byggeordrens §5, "provider transport invocation
 * count = 0" ved mismatch).
 */

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import type { PaymentProvider } from "./types.ts";

export type VendorBindingStatus = "active" | "revoked";

export interface FinanceVendor {
  vendor_id: string;
  tenant_id: string;
  memory_space_id: string;
  name: string;
  created_by_person_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FinanceVendorProviderBinding {
  binding_id: string;
  tenant_id: string;
  memory_space_id: string;
  vendor_id: string;
  provider: PaymentProvider;
  provider_vendor_ref: string;
  status: VendorBindingStatus;
  created_by_person_id: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export class VendorNotFoundError extends Error {
  constructor(readonly vendorId: string) {
    super(`vendor_not_found:${vendorId}`);
    this.name = "VendorNotFoundError";
  }
}

/** Akseptansekrav A: samme (tenant, provider, provider_vendor_ref) kan ALDRI peke på to forskjellige vendors - DB UNIQUE-constrainten er den strukturelle håndhevingen, denne feilen er den typede oversettelsen av et brudd på den ved skriving. */
export class VendorProviderRefAlreadyBoundError extends Error {
  constructor(readonly provider: string, readonly providerVendorRef: string, readonly existingVendorId: string) {
    super(`vendor_provider_ref_already_bound:${provider}:${providerVendorRef}:${existingVendorId}`);
    this.name = "VendorProviderRefAlreadyBoundError";
  }
}

/** Akseptansekrav B/C/F: ingen binding matcher den PÅSTÅTTE (vendor, provider, provider_vendor_ref)-tripletten - dekker manglende binding, feil vendor, feil ref og feil provider identisk (ALLE er "ingen matchende aktiv rad", ALDRI en fuzzy/delvis match). FAIL-CLOSED, ingen default, ingen gjetting. */
export class VendorBindingMismatchError extends Error {
  constructor(readonly paymentIntentId: string, readonly vendorId: string, readonly provider: string) {
    super(`vendor_binding_mismatch:${paymentIntentId}:${vendorId}:${provider}`);
    this.name = "VendorBindingMismatchError";
  }
}

/** Akseptansekrav D: en eksplisitt revokert binding kan ikke brukes for en NY pengehandling, selv om den EN GANG var korrekt. */
export class VendorBindingRevokedError extends Error {
  constructor(readonly paymentIntentId: string, readonly bindingId: string) {
    super(`vendor_binding_revoked:${paymentIntentId}:${bindingId}`);
    this.name = "VendorBindingRevokedError";
  }
}

export async function createVendor(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, name: string, actorPersonId?: string): Promise<FinanceVendor> {
  const vendorId = `fin-vnd-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO finance_vendors (vendor_id, tenant_id, memory_space_id, name, created_by_person_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [vendorId, tenantId, memorySpace, name, actorPersonId ?? null]
  );
  return rows[0] as FinanceVendor;
}

export async function getVendor(client: pg.PoolClient, tenantId: string, vendorId: string): Promise<FinanceVendor | null> {
  const { rows } = await client.query(`SELECT * FROM finance_vendors WHERE tenant_id = $1 AND vendor_id = $2`, [tenantId, vendorId]);
  return (rows[0] as FinanceVendor | undefined) ?? null;
}

export async function listVendors(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, limit = 200): Promise<FinanceVendor[]> {
  const { rows } = await client.query(
    `SELECT * FROM finance_vendors WHERE tenant_id = $1 AND memory_space_id = $2 ORDER BY created_at DESC LIMIT $3`,
    [tenantId, memorySpace, limit]
  );
  return rows as FinanceVendor[];
}

/**
 * Idempotent: SAMME (tenant, provider, provider_vendor_ref) mot SAMME
 * `vendorId` reaktiverer bindingen i SAMME rad (aldri en ny rad, aldri
 * duplikat-UNIQUE-feil). Mot en ANNEN eksisterende `vendorId` kastes
 * `VendorProviderRefAlreadyBoundError` FØR noe skrives - akseptansekrav A
 * håndheves derfor BÅDE her (typet feil, tidlig) OG strukturelt av
 * DB-UNIQUE-constrainten (siste forsvarslinje mot samtidige skrivinger).
 */
export async function bindVendorProvider(
  client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, vendorId: string,
  provider: PaymentProvider, providerVendorRef: string, actorPersonId?: string
): Promise<FinanceVendorProviderBinding> {
  const vendor = await getVendor(client, tenantId, vendorId);
  if (!vendor) throw new VendorNotFoundError(vendorId);

  const { rows: existingRows } = await client.query(
    `SELECT * FROM finance_vendor_provider_bindings WHERE tenant_id = $1 AND provider = $2 AND provider_vendor_ref = $3`,
    [tenantId, provider, providerVendorRef]
  );
  const existing = existingRows[0] as FinanceVendorProviderBinding | undefined;
  if (existing && existing.vendor_id !== vendorId) {
    throw new VendorProviderRefAlreadyBoundError(provider, providerVendorRef, existing.vendor_id);
  }
  if (existing) {
    const { rows } = await client.query(
      `UPDATE finance_vendor_provider_bindings SET status = 'active', revoked_at = NULL, updated_at = now()
       WHERE tenant_id = $1 AND binding_id = $2 RETURNING *`,
      [tenantId, existing.binding_id]
    );
    return rows[0] as FinanceVendorProviderBinding;
  }

  const bindingId = `fin-vnd-bind-${randomUUID()}`;
  const { rows } = await client.query(
    `INSERT INTO finance_vendor_provider_bindings
       (binding_id, tenant_id, memory_space_id, vendor_id, provider, provider_vendor_ref, created_by_person_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [bindingId, tenantId, memorySpace, vendorId, provider, providerVendorRef, actorPersonId ?? null]
  );
  return rows[0] as FinanceVendorProviderBinding;
}

export async function revokeVendorProviderBinding(
  client: pg.PoolClient, tenantId: string, provider: PaymentProvider, providerVendorRef: string, actorPersonId?: string
): Promise<FinanceVendorProviderBinding | null> {
  const { rows } = await client.query(
    `UPDATE finance_vendor_provider_bindings SET status = 'revoked', revoked_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND provider = $2 AND provider_vendor_ref = $3 RETURNING *`,
    [tenantId, provider, providerVendorRef]
  );
  void actorPersonId; // proveniens for revokering spores i dag kun via `updated_at`/kallerens egen event-logging (payment_intent_events har ingen egen vendor-binding-hendelsestype ennå) - se D-116 for begrunnelse (minste nødvendige struktur).
  return (rows[0] as FinanceVendorProviderBinding | undefined) ?? null;
}

export async function listVendorBindings(client: pg.PoolClient, tenantId: string, vendorId: string): Promise<FinanceVendorProviderBinding[]> {
  const { rows } = await client.query(
    `SELECT * FROM finance_vendor_provider_bindings WHERE tenant_id = $1 AND vendor_id = $2 ORDER BY created_at DESC`,
    [tenantId, vendorId]
  );
  return rows as FinanceVendorProviderBinding[];
}

/**
 * DEN kanoniske choke-point-validatoren (byggeordrens §5) - kalles fra
 * ÉTT sted, `FinanceService.submitPaymentIntent()`, FØR alle fire
 * provider-grener (fiken/stripe/vipps/neonomics), i SAMME transaksjon som
 * `readForUpdate()`. Utløses KUN når betalingsintensjonen EKSPLISITT
 * hevder en canonical vendor (`vendorId` er ikke-null på raden) -
 * historiske/fremtidige vendor-id-løse intents omgår denne funksjonen
 * HELT (akseptansekrav 13, "unknown remains unknown").
 *
 * `provider`/`providerVendorRef` er BEGGE del av oppslaget (akseptansekrav
 * F, "provider er del av identiteten") - ETT presist `SELECT` mot
 * UNIQUE-nøkkelen (tenant_id, provider, provider_vendor_ref) skiller
 * strukturelt "feil vendor for korrekt ref"/"feil ref for korrekt
 * vendor"/"korrekt ref men feil provider" fra "korrekt triplett" - ALLE
 * fire mismatch-formene kollapser bevisst til SAMME
 * `VendorBindingMismatchError` (ingen fuzzy/delvis kreditering av en
 * DELVIS korrekt påstand).
 */
export async function assertValidVendorBinding(
  client: pg.PoolClient, tenantId: string, paymentIntentId: string, vendorId: string,
  provider: PaymentProvider, providerVendorRef: string | null
): Promise<void> {
  if (!providerVendorRef) throw new VendorBindingMismatchError(paymentIntentId, vendorId, provider);
  const { rows } = await client.query(
    `SELECT * FROM finance_vendor_provider_bindings WHERE tenant_id = $1 AND provider = $2 AND provider_vendor_ref = $3`,
    [tenantId, provider, providerVendorRef]
  );
  const binding = rows[0] as FinanceVendorProviderBinding | undefined;
  if (!binding || binding.vendor_id !== vendorId) {
    throw new VendorBindingMismatchError(paymentIntentId, vendorId, provider);
  }
  if (binding.status !== "active") {
    throw new VendorBindingRevokedError(paymentIntentId, binding.binding_id);
  }
}
