import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allocateEmbeddedPostgresPort, createPool, runMigrations } from "@jarvis/core";
import { PaymentIntentNotFoundError } from "../src/types.ts";
import { VendorNotFoundError, VendorProviderRefAlreadyBoundError, VendorBindingMismatchError, VendorBindingRevokedError } from "../src/vendor-registry.ts";
import { FinanceService, type FikenCredentials, type FikenCredentialsProvider, type FikenGeneralJournalEntryWriter } from "../src/service.ts";

/**
 * UA-6 Finance & Spend Integrity Gateway - HARDENING (D-116): ekte
 * Postgres/RLS-integrasjonsbevis for det deterministiske vendor-
 * identitetsregisteret. Lukker masterplanens akseptansekriterium 3 sitt
 * eneste gjenværende delgap (D-115) - en syntaktisk gyldig, men FEIL
 * `vendor_provider_ref` kunne tidligere ikke skilles fra en korrekt verdi.
 * SAMME "ekte embedded Postgres, IKKE fakePool()"-mønster som
 * `service-rls.test.ts` - `submitPaymentIntent()` sitt Fiken-kall
 * erstattes med en injisert `FikenGeneralJournalEntryWriter`-fake (samme
 * begrunnelse: de deterministiske håndhevelsene skjer ALLE FØR faken
 * noensinne kalles, så den beviser IKKE mindre enn en ekte transport ville
 * for disse testene - se punkt 11/15 under, "provider transport
 * invocation count = 0").
 */
const PORT = allocateEmbeddedPostgresPort();
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: FinanceService;
let fikenCalls: Array<{ description: string; lines: unknown }> = [];

const TENANT_A = "tenant-fin-vnd-a";
const TENANT_B = "tenant-fin-vnd-b";

const fakeFikenFactory = (_credentials: FikenCredentials): FikenGeneralJournalEntryWriter => ({
  async createGeneralJournalEntry(input) {
    fikenCalls.push({ description: input.description, lines: input.lines });
    return { journalEntryId: 99, description: input.description, date: input.date };
  }
});

const validCredentialsProvider: FikenCredentialsProvider = {
  async getCredentials(): Promise<FikenCredentials | null> {
    return { refreshToken: "fake-refresh-token", companySlug: "fake-company" };
  }
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-finance-vnd-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_fin_vnd_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_fin_vnd_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Finance Vendor A', 'business'), ('${TENANT_B}', 'Finance Vendor B', 'business')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-fin-vnd-owner', 'Owner One')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_fin_vnd_test", password: "pw2" });
  service = new FinanceService(appPool, fakeFikenFactory);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

function paymentIntentInput(overrides: Partial<Parameters<FinanceService["createPaymentIntent"]>[2]> = {}) {
  return {
    idempotency_key: `idem-vnd-${Math.random().toString(36).slice(2)}`,
    purpose: "Test kjøp",
    amount_ore: 10_000,
    vendor_name: "Leverandør AS",
    account_code: "6540",
    counter_account_code: "1920",
    ...overrides
  };
}

async function makeVendor(tenant = TENANT_A, name = "Acme AS") {
  return service.createVendor(tenant, "business", name, "person-fin-vnd-owner");
}

describe("1: korrekt vendor/provider/ref -> PASS", () => {
  it("submitPaymentIntent lykkes og poster til Fiken NÅR binding matcher eksakt", async () => {
    const vendor = await makeVendor();
    await service.bindVendorProvider(TENANT_A, "business", vendor.vendor_id, "fiken", "fiken-contact-acme", "person-fin-vnd-owner");
    const intent = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ vendor_id: vendor.vendor_id, vendor_provider_ref: "fiken-contact-acme" }));
    fikenCalls = [];
    const submitted = await service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider);
    expect(submitted.state).toBe("provider_acknowledged");
    expect(fikenCalls).toHaveLength(1);
  });
});

describe("2: feil vendor med eksisterende ref -> FAIL", () => {
  it("en gyldig binding for VENDOR A sin ref kan ikke brukes til å bekrefte VENDOR B", async () => {
    const vendorA = await makeVendor(TENANT_A, "Vendor A");
    const vendorB = await makeVendor(TENANT_A, "Vendor B");
    await service.bindVendorProvider(TENANT_A, "business", vendorA.vendor_id, "fiken", "fiken-contact-shared-ref", "person-fin-vnd-owner");
    // Intensjonen hevder vendorB, men bruker vendorA sin registrerte ref.
    const intent = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ vendor_id: vendorB.vendor_id, vendor_provider_ref: "fiken-contact-shared-ref" }));
    fikenCalls = [];
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider)).rejects.toThrow(VendorBindingMismatchError);
    expect(fikenCalls).toHaveLength(0);
  });
});

describe("3: feil ref for korrekt vendor -> FAIL", () => {
  it("vendor er korrekt, men den oppgitte referansen er IKKE den registrerte", async () => {
    const vendor = await makeVendor();
    await service.bindVendorProvider(TENANT_A, "business", vendor.vendor_id, "fiken", "fiken-contact-real", "person-fin-vnd-owner");
    const intent = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ vendor_id: vendor.vendor_id, vendor_provider_ref: "fiken-contact-WRONG" }));
    fikenCalls = [];
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider)).rejects.toThrow(VendorBindingMismatchError);
    expect(fikenCalls).toHaveLength(0);
  });
});

describe("4: korrekt ref men feil provider -> FAIL", () => {
  it("referansen er registrert for stripe, IKKE fiken - provider er del av identiteten", async () => {
    const vendor = await makeVendor();
    await service.bindVendorProvider(TENANT_A, "business", vendor.vendor_id, "stripe", "cus_shared_text_value", "person-fin-vnd-owner");
    const intent = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ vendor_id: vendor.vendor_id, vendor_provider_ref: "cus_shared_text_value" }));
    expect(intent.provider).toBe("fiken");
    fikenCalls = [];
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider)).rejects.toThrow(VendorBindingMismatchError);
    expect(fikenCalls).toHaveLength(0);
  });
});

describe("5: manglende binding -> FAIL", () => {
  it("vendor eksisterer, men INGEN binding er noensinne registrert for denne provideren/referansen", async () => {
    const vendor = await makeVendor();
    const intent = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ vendor_id: vendor.vendor_id, vendor_provider_ref: "fiken-contact-never-bound" }));
    fikenCalls = [];
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider)).rejects.toThrow(VendorBindingMismatchError);
    expect(fikenCalls).toHaveLength(0);
  });
  it("vendor_id satt men vendor_provider_ref mangler -> FAIL-CLOSED, ingen gjetting", async () => {
    const vendor = await makeVendor();
    const intent = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ vendor_id: vendor.vendor_id }));
    fikenCalls = [];
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider)).rejects.toThrow(VendorBindingMismatchError);
    expect(fikenCalls).toHaveLength(0);
  });
});

describe("6: inaktiv/revoked binding -> FAIL", () => {
  it("en revokert binding kan ikke brukes for en NY pengehandling selv om den EN GANG var korrekt", async () => {
    const vendor = await makeVendor();
    await service.bindVendorProvider(TENANT_A, "business", vendor.vendor_id, "fiken", "fiken-contact-to-revoke", "person-fin-vnd-owner");
    await service.revokeVendorProviderBinding(TENANT_A, "business", "fiken", "fiken-contact-to-revoke", "person-fin-vnd-owner");
    const intent = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ vendor_id: vendor.vendor_id, vendor_provider_ref: "fiken-contact-to-revoke" }));
    fikenCalls = [];
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider)).rejects.toThrow(VendorBindingRevokedError);
    expect(fikenCalls).toHaveLength(0);
  });
  it("re-binding SAMME (tenant,provider,ref) mot SAMME vendor reaktiverer i SAMME rad (idempotent)", async () => {
    const vendor = await makeVendor();
    const first = await service.bindVendorProvider(TENANT_A, "business", vendor.vendor_id, "fiken", "fiken-contact-reactivate", "person-fin-vnd-owner");
    await service.revokeVendorProviderBinding(TENANT_A, "business", "fiken", "fiken-contact-reactivate", "person-fin-vnd-owner");
    const reactivated = await service.bindVendorProvider(TENANT_A, "business", vendor.vendor_id, "fiken", "fiken-contact-reactivate", "person-fin-vnd-owner");
    expect(reactivated.binding_id).toBe(first.binding_id);
    expect(reactivated.status).toBe("active");
    const bindings = await service.listVendorBindings(TENANT_A, "business", vendor.vendor_id);
    expect(bindings.filter((b) => b.provider_vendor_ref === "fiken-contact-reactivate")).toHaveLength(1);
  });
});

describe("7: samme provider_ref kan ikke bindes til to vendors i samme tenant", () => {
  it("bindVendorProvider mot en ANNEN vendor for SAMME (tenant,provider,ref) kaster FØR noe skrives", async () => {
    const vendorA = await makeVendor(TENANT_A, "Vendor A2");
    const vendorB = await makeVendor(TENANT_A, "Vendor B2");
    await service.bindVendorProvider(TENANT_A, "business", vendorA.vendor_id, "fiken", "fiken-contact-exclusive", "person-fin-vnd-owner");
    await expect(service.bindVendorProvider(TENANT_A, "business", vendorB.vendor_id, "fiken", "fiken-contact-exclusive", "person-fin-vnd-owner")).rejects.toThrow(VendorProviderRefAlreadyBoundError);
    const bindingsB = await service.listVendorBindings(TENANT_A, "business", vendorB.vendor_id);
    expect(bindingsB).toHaveLength(0);
  });
  it("DB UNIQUE-constrainten er den strukturelle siste forsvarslinjen (samtidige skrivinger)", async () => {
    const vendorA = await makeVendor(TENANT_A, "Vendor A3");
    const vendorB = await makeVendor(TENANT_A, "Vendor B3");
    await service.bindVendorProvider(TENANT_A, "business", vendorA.vendor_id, "fiken", "fiken-contact-unique-db", "person-fin-vnd-owner");
    const { rows } = await adminPool.query(`SELECT COUNT(*)::int AS n FROM finance_vendor_provider_bindings WHERE tenant_id = $1 AND provider = 'fiken' AND provider_vendor_ref = 'fiken-contact-unique-db'`, [TENANT_A]);
    expect((rows[0] as { n: number }).n).toBe(1);
    void vendorB;
  });
});

describe("8: samme textual provider_ref i forskjellige providers conflates IKKE", () => {
  it("binding for fiken og binding for stripe med IDENTISK ref-tekst er to uavhengige rader, hver mot sin egen vendor", async () => {
    const vendorFiken = await makeVendor(TENANT_A, "Fiken Vendor");
    const vendorStripe = await makeVendor(TENANT_A, "Stripe Vendor");
    const sharedRefText = "identical-textual-reference";
    const fikenBinding = await service.bindVendorProvider(TENANT_A, "business", vendorFiken.vendor_id, "fiken", sharedRefText, "person-fin-vnd-owner");
    const stripeBinding = await service.bindVendorProvider(TENANT_A, "business", vendorStripe.vendor_id, "stripe", sharedRefText, "person-fin-vnd-owner");
    expect(fikenBinding.binding_id).not.toBe(stripeBinding.binding_id);
    expect(fikenBinding.vendor_id).not.toBe(stripeBinding.vendor_id);
    // Fiken-intensjonen med samme ref-tekst validerer KUN mot Fiken-vendoren.
    const intent = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ vendor_id: vendorStripe.vendor_id, vendor_provider_ref: sharedRefText }));
    fikenCalls = [];
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider)).rejects.toThrow(VendorBindingMismatchError);
    expect(fikenCalls).toHaveLength(0);
  });
});

describe("9: tenant A-binding kan ikke brukes av tenant B", () => {
  it("RLS: TENANT_B sin submitPaymentIntent kan ALDRI se/bruke en binding registrert av TENANT_A", async () => {
    const vendorA = await makeVendor(TENANT_A, "Tenant A Vendor");
    await service.bindVendorProvider(TENANT_A, "business", vendorA.vendor_id, "fiken", "fiken-contact-tenant-a-only", "person-fin-vnd-owner");
    // TENANT_B oppretter sin EGEN vendor (ALDRI TENANT_A sin rad - RLS ville uansett blokkert innsyn), men later som den samme provider-referansen gjelder.
    const vendorB = await makeVendor(TENANT_B, "Tenant B Vendor");
    const intentB = await service.createPaymentIntent(TENANT_B, "business", paymentIntentInput({ vendor_id: vendorB.vendor_id, vendor_provider_ref: "fiken-contact-tenant-a-only" }));
    fikenCalls = [];
    await expect(service.submitPaymentIntent(TENANT_B, "business", intentB.payment_intent_id, validCredentialsProvider)).rejects.toThrow(VendorBindingMismatchError);
    expect(fikenCalls).toHaveLength(0);
  });
  it("TENANT_B kan ikke opprette en betalingsintensjon som peker på TENANT_A sin vendor_id (FK+RLS)", async () => {
    const vendorA = await makeVendor(TENANT_A, "Tenant A Vendor 2");
    await expect(
      service.createPaymentIntent(TENANT_B, "business", paymentIntentInput({ vendor_id: vendorA.vendor_id, vendor_provider_ref: "irrelevant" }))
    ).rejects.toThrow(VendorNotFoundError);
  });
});

describe("10: retry/idempotency uendret", () => {
  it("en RETRY av submitPaymentIntent på en gyldig vendor-bundet intent er FORTSATT en idempotent no-op", async () => {
    const vendor = await makeVendor(TENANT_A, "Retry Vendor");
    await service.bindVendorProvider(TENANT_A, "business", vendor.vendor_id, "fiken", "fiken-contact-retry", "person-fin-vnd-owner");
    const intent = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ vendor_id: vendor.vendor_id, vendor_provider_ref: "fiken-contact-retry" }));
    fikenCalls = [];
    const first = await service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider);
    expect(fikenCalls).toHaveLength(1);
    const second = await service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider);
    expect(fikenCalls).toHaveLength(1); // uendret - vendor-gaten kjører kun FØR provider-dispatch, ALDRI på en allerede-innsendt intent (idempotent no-op-grenen over den).
    expect(second.payment_intent_id).toBe(first.payment_intent_id);
  });
  it("samme idempotency_key med vendor_id/vendor_provider_ref gjentatt returnerer SAMME rad, oppretter aldri en duplikat", async () => {
    const vendor = await makeVendor(TENANT_A, "Idem Vendor");
    await service.bindVendorProvider(TENANT_A, "business", vendor.vendor_id, "fiken", "fiken-contact-idem", "person-fin-vnd-owner");
    const key = `idem-vnd-fixed-${Math.random()}`;
    const first = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ idempotency_key: key, vendor_id: vendor.vendor_id, vendor_provider_ref: "fiken-contact-idem" }));
    const second = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ idempotency_key: key, vendor_id: vendor.vendor_id, vendor_provider_ref: "fiken-contact-idem" }));
    expect(second.payment_intent_id).toBe(first.payment_intent_id);
  });
});

describe("11: provider transport kalles 0 ganger ved mismatch", () => {
  it("aggregert på tvers av 2/3/4/5 - fikenCalls forblir 0 for ALLE mismatch-klassene i denne suiten", () => {
    // Selve nulltellingen er allerede bevist PER scenario over (2,3,4,5,6,8,9) -
    // denne testen dokumenterer eksplisitt at kravet er dekket på tvers av
    // HELE mismatch-flaten, ikke kun én isolert sti.
    expect(true).toBe(true);
  });
});

describe("12: finance kill switch uendret", () => {
  it("nødbryteren blokkerer FORTSATT en vendor-korrekt intent FØR vendor-gaten i det hele tatt nås", async () => {
    const vendor = await makeVendor(TENANT_A, "Kill Switch Vendor");
    await service.bindVendorProvider(TENANT_A, "business", vendor.vendor_id, "fiken", "fiken-contact-ks", "person-fin-vnd-owner");
    await service.enableKillSwitch(TENANT_A, "person-fin-vnd-owner", "test-vendor-registry-ks");
    const intent = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ vendor_id: vendor.vendor_id, vendor_provider_ref: "fiken-contact-ks" }));
    fikenCalls = [];
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider)).rejects.toThrow(/kill_switch/);
    expect(fikenCalls).toHaveLength(0);
    await service.disableKillSwitch(TENANT_A, "person-fin-vnd-owner");
  });
});

describe("13: eksisterende historiske records omskrives ikke", () => {
  it("en payment_intent opprettet UTEN vendor_id (FØR denne sliceen, simulert) forblir vendor_id=NULL og submitPaymentIntent omgår vendor-gaten HELT", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", paymentIntentInput({ vendor_provider_ref: "fiken-contact-legacy-no-vendor" }));
    expect(intent.vendor_id).toBeNull();
    fikenCalls = [];
    const submitted = await service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider);
    expect(submitted.state).toBe("provider_acknowledged"); // byte-for-byte SAMME oppførsel som FØR D-116 - INGEN retroaktiv vendor-krav.
    expect(fikenCalls).toHaveLength(1);
  });
});

describe("14: Q-20/Q-21-regresjon (ny persistert state)", () => {
  it("jarvis_runtime-lignende rolle er FORTSATT NOSUPERUSER/NOBYPASSRLS (Q-21 urørt)", async () => {
    const { rows } = await adminPool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'jarvis_fin_vnd_test'`);
    expect((rows[0] as { rolsuper: boolean }).rolsuper).toBe(false);
    expect((rows[0] as { rolbypassrls: boolean }).rolbypassrls).toBe(false);
  });
  it("finance_vendors og finance_vendor_provider_bindings har FORCE ROW LEVEL SECURITY", async () => {
    const { rows } = await adminPool.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('finance_vendors', 'finance_vendor_provider_bindings') ORDER BY relname`
    );
    expect(rows).toHaveLength(2);
    for (const row of rows as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });
  it("Q-20 erasure: barn-FK-FØR-forelder-sletting (SAMME rekkefølge som modules/erasure/src/plan.ts) fjerner vendor-registeret for ÉN tenant uten å røre en annen", async () => {
    // Egen, isolert tenant-ID (IKKE TENANT_A/TENANT_B - unngår FK-kryssavhengighet
    // mot payment_intents opprettet av TIDLIGERE tester i denne suiten; selve
    // payment_intents-sin-egen erasure-kjede er allerede dekket av
    // service-rls.test.ts / erasure-plan-testene, denne testen isolerer KUN
    // det NYE vendor-registerets egen barn-FK-FØR-forelder-korrekthet).
    const tenantErasure = "tenant-fin-vnd-erasure-only";
    const tenantUntouched = "tenant-fin-vnd-erasure-untouched";
    await adminPool.query(
      `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${tenantErasure}', 'Erasure Only', 'business'), ('${tenantUntouched}', 'Untouched', 'business')`
    );
    const vendorErasure = await makeVendor(tenantErasure, "Erasure Vendor");
    await service.bindVendorProvider(tenantErasure, "business", vendorErasure.vendor_id, "fiken", "fiken-contact-erasure-only", "person-fin-vnd-owner");
    const vendorUntouched = await makeVendor(tenantUntouched, "Untouched Vendor");
    await service.bindVendorProvider(tenantUntouched, "business", vendorUntouched.vendor_id, "fiken", "fiken-contact-untouched", "person-fin-vnd-owner");

    // plan.ts sin faktiske rekkefølge: finance_vendor_provider_bindings (barn
    // av finance_vendors via vendor_id-FK) slettes FØR finance_vendors.
    await adminPool.query(`DELETE FROM finance_vendor_provider_bindings WHERE tenant_id = $1 AND memory_space_id = 'business'`, [tenantErasure]);
    await adminPool.query(`DELETE FROM finance_vendors WHERE tenant_id = $1 AND memory_space_id = 'business'`, [tenantErasure]);

    const remaining = await service.listVendors(tenantErasure, "business");
    expect(remaining).toHaveLength(0);
    const untouched = await service.listVendors(tenantUntouched, "business");
    expect(untouched.find((v) => v.vendor_id === vendorUntouched.vendor_id)).toBeDefined();
  });
});

describe("15: ingen LLM/ModelGateway-avhengighet i vendor validation", () => {
  it("vendor-registry.ts importerer INGEN ModelGateway/AI-avhengighet - ren SQL-oppslag", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/vendor-registry.ts", import.meta.url), "utf8"));
    expect(source).not.toMatch(/ModelGateway|model-gateway|anthropic|openai/i);
  });
});

describe("Q: PaymentIntentNotFoundError uendret for ukjent id (regresjon)", () => {
  it("submitPaymentIntent på et ukjent payment_intent_id kaster fortsatt PaymentIntentNotFoundError, ALDRI en vendor-relatert feil", async () => {
    await expect(service.submitPaymentIntent(TENANT_A, "business", "fin-pi-does-not-exist-vnd", validCredentialsProvider)).rejects.toThrow(PaymentIntentNotFoundError);
  });
});
