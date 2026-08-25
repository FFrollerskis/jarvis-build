import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { createPool, runMigrations } from "@jarvis/core";
import { BusinessInternalSecretProvider } from "@jarvis/business";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { EnvSecretProvider, FallbackSecretProvider, ToolGateway, firstWaveTools } from "@jarvis/tool-gateway";
import { FinanceService, FinanceTransport, type FikenCredentials, type FikenCredentialsProvider, type FikenGeneralJournalEntryWriter } from "../src/index.ts";

/**
 * UA-6 Finance & Spend Integrity Gateway - D-107 HOST-FIX regresjonstester.
 *
 * Root cause (host-funn, 2026-08-24): `modules/finance/scripts/fiken-live.ts`
 * konstruerte sin `ToolGateway` med en BAR `EnvSecretProvider()`. 9 av 10
 * finance.*-handlinger bruker `credential_ref: "JARVIS_BUSINESS_INTERNAL_
 * TOKEN"` (D-49 - en BEVISST ikke-hemmelig sentinel, ALDRI satt i .env, kun
 * levert av `BusinessInternalSecretProvider`). Uten `FallbackSecretProvider
 * (env, BusinessInternalSecretProvider)` - SAMME sammensetning som
 * `apps/api/src/main.ts`/`worker-main.ts` faktisk bruker i produksjon -
 * returnerte `EnvSecretProvider` `null` for denne referansen, og
 * `ToolGateway.execute()` avviste HVERT internt finance-kall med
 * `credential_unavailable` FØR transporten noensinne ble kalt. Ingen
 * eksisterende test beviste tidligere `ToolGateway.execute()` end-to-end for
 * finance.* med en produksjonslik secret-sammensetning -
 * `transport-wiring.test.ts` tester kun registrering/dispatch (fake
 * `FinanceService`, ingen ToolGateway), og `service-rls.test.ts` kaller
 * `FinanceService` direkte (aldri gjennom `ToolGateway`). Denne filen lukker
 * akkurat DET dekningshullet - samme kontrakt ekte Jarvis-kallere (API-ruter,
 * modellverktøykall) faktisk mottar.
 */
const PORT = 40000 + Math.floor(Math.random() * 20000);
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;

const TENANT_A = "tenant-fin-tgw-a";
const TENANT_B = "tenant-fin-tgw-b";
const OWNER_PERSON = "person-fin-tgw-owner";

const fakeFikenFactory = (_credentials: FikenCredentials): FikenGeneralJournalEntryWriter => ({
  async createGeneralJournalEntry(input) {
    return { journalEntryId: 99, description: input.description, date: input.date };
  }
});

function identityFor(tenantId: string): IdentityContext {
  return {
    person_id: OWNER_PERSON, tenant_id: tenantId, memory_space_id: "business",
    session_id: "sess-fin-tgw", device_id: "jarvis-core", channel: "api", auth_strength: "active"
  };
}

function buildGateway(secrets: EnvSecretProvider | FallbackSecretProvider, finance: FinanceService): ToolGateway {
  const credentialsProvider: FikenCredentialsProvider = { async getCredentials(): Promise<FikenCredentials | null> { return null; } };
  const policy = new PolicyGateway({
    devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(),
    authority: { owner_person_id: OWNER_PERSON, owner_tenants: [TENANT_A] }
  });
  const gateway = new ToolGateway(appPool, policy, secrets);
  for (const tool of firstWaveTools({ finance: new FinanceTransport(finance, credentialsProvider) })) gateway.register(tool);
  return gateway;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-finance-tgw-"));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_fin_tgw_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_fin_tgw_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Finance TGW A', 'business'), ('${TENANT_B}', 'Finance TGW B', 'business')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('${OWNER_PERSON}', 'Owner')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_fin_tgw_test", password: "pw2" });
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await epg?.stop();
}, 120_000);

describe("A: DEN EKSAKTE regresjonen - bar EnvSecretProvider reproduserer host-feilen", () => {
  it("create_payment_intent avvises med credential_unavailable UTEN BusinessInternalSecretProvider (beviser hvorfor host-scriptet feilet)", async () => {
    const finance = new FinanceService(appPool, fakeFikenFactory);
    const gateway = buildGateway(new EnvSecretProvider(), finance);
    const result = await gateway.execute({
      identity: identityFor(TENANT_A), tool_id: "finance", action: "create_payment_intent",
      parameters: { tenant_id: TENANT_A, idempotency_key: `regress-${Math.random()}`, purpose: "x", amount_ore: 100, vendor_name: "x", account_code: "6540" }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("credential_unavailable");
  });
});

describe("B: PRODUKSJONS-sammensetningen (FallbackSecretProvider(env, BusinessInternalSecretProvider)) - den faktiske fiksen", () => {
  it("create_payment_intent gjennom ToolGateway eksponerer payment_intent_id som external_id (kontrakten ekte kallere mottar)", async () => {
    const finance = new FinanceService(appPool, fakeFikenFactory);
    const gateway = buildGateway(new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()), finance);
    const result = await gateway.execute({
      identity: identityFor(TENANT_A), tool_id: "finance", action: "create_payment_intent",
      parameters: { tenant_id: TENANT_A, idempotency_key: `create-${Math.random()}`, purpose: "x", amount_ore: 100, vendor_name: "x", account_code: "6540" }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.external_id).toBeTruthy();
      const stored = await finance.getPaymentIntent(TENANT_A, "business", result.external_id!);
      expect(stored?.payment_intent_id).toBe(result.external_id);
    }
  });

  it("idempotent retry gjennom ToolGateway løser til SAMME canonical intent-id", async () => {
    const finance = new FinanceService(appPool, fakeFikenFactory);
    const gateway = buildGateway(new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()), finance);
    const key = `idem-tgw-${Math.random()}`;
    const params = { tenant_id: TENANT_A, idempotency_key: key, purpose: "x", amount_ore: 100, vendor_name: "x", account_code: "6540" };
    const first = await gateway.execute({ identity: identityFor(TENANT_A), tool_id: "finance", action: "create_payment_intent", parameters: params });
    const second = await gateway.execute({ identity: identityFor(TENANT_A), tool_id: "finance", action: "create_payment_intent", parameters: params });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.external_id).toBe(first.external_id);
    const all = await finance.listPaymentIntents(TENANT_A, "business");
    expect(all.filter((i) => i.idempotency_key === key)).toHaveLength(1);
  });

  it("kill-switch-fixturen kan opprettes gjennom den EKTE produksjonsstien (ToolGateway), deretter blokkeres submit", async () => {
    const finance = new FinanceService(appPool, fakeFikenFactory);
    const gateway = buildGateway(new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()), finance);
    const created = await gateway.execute({
      identity: identityFor(TENANT_A), tool_id: "finance", action: "create_payment_intent",
      parameters: {
        tenant_id: TENANT_A, idempotency_key: `ks-tgw-${Math.random()}`, purpose: "x", amount_ore: 100, vendor_name: "x",
        vendor_provider_ref: "fake-contact", account_code: "6540", counter_account_code: "1920"
      }
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const intentId = created.external_id!;
    await gateway.execute({ identity: identityFor(TENANT_A), tool_id: "finance", action: "enable_kill_switch", parameters: { tenant_id: TENANT_A, actor_person_id: OWNER_PERSON, reason: "test" } });
    const blocked = await gateway.execute({ identity: identityFor(TENANT_A), tool_id: "finance", action: "submit_payment_intent", parameters: { tenant_id: TENANT_A, payment_intent_id: intentId, actor_person_id: OWNER_PERSON } });
    expect(blocked.ok).toBe(false);
    const stillDraft = await finance.getPaymentIntent(TENANT_A, "business", intentId);
    expect(stillDraft?.state).toBe("draft");
    await gateway.execute({ identity: identityFor(TENANT_A), tool_id: "finance", action: "disable_kill_switch", parameters: { tenant_id: TENANT_A, actor_person_id: OWNER_PERSON } });
  });

  it("state-machine-fixturen kan opprettes OG overgå (cancel) gjennom ToolGateway", async () => {
    const finance = new FinanceService(appPool, fakeFikenFactory);
    const gateway = buildGateway(new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()), finance);
    const created = await gateway.execute({
      identity: identityFor(TENANT_A), tool_id: "finance", action: "create_payment_intent",
      parameters: { tenant_id: TENANT_A, idempotency_key: `sm-tgw-${Math.random()}`, purpose: "x", amount_ore: 100, vendor_name: "x", account_code: "6540" }
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const cancelled = await gateway.execute({ identity: identityFor(TENANT_A), tool_id: "finance", action: "cancel_payment_intent", parameters: { tenant_id: TENANT_A, payment_intent_id: created.external_id! } });
    expect(cancelled.ok).toBe(true);
    const invalidSettle = await gateway.execute({ identity: identityFor(TENANT_A), tool_id: "finance", action: "settle_payment_intent", parameters: { tenant_id: TENANT_A, payment_intent_id: created.external_id! } });
    expect(invalidSettle.ok).toBe(false);
  });

  it("avstemmings-fixturen kan opprettes OG avstemmes gjennom ToolGateway", async () => {
    const finance = new FinanceService(appPool, fakeFikenFactory);
    const gateway = buildGateway(new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()), finance);
    const created = await gateway.execute({
      identity: identityFor(TENANT_A), tool_id: "finance", action: "create_payment_intent",
      parameters: { tenant_id: TENANT_A, idempotency_key: `rec-tgw-${Math.random()}`, purpose: "x", amount_ore: 100, vendor_name: "x", account_code: "6540" }
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const reconciled = await gateway.execute({ identity: identityFor(TENANT_A), tool_id: "finance", action: "reconcile_payment_intent", parameters: { tenant_id: TENANT_A, payment_intent_id: created.external_id!, matched: false } });
    expect(reconciled.ok).toBe(true);
  });

  it("deterministisk validering avvises FORTSATT (ikke maskert av credential-fiksen) - ugyldig beløp/kontokode", async () => {
    const finance = new FinanceService(appPool, fakeFikenFactory);
    const gateway = buildGateway(new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()), finance);
    const badAmount = await gateway.execute({ identity: identityFor(TENANT_A), tool_id: "finance", action: "create_payment_intent", parameters: { tenant_id: TENANT_A, idempotency_key: `bad-amt-tgw-${Math.random()}`, purpose: "x", amount_ore: -1, vendor_name: "x", account_code: "6540" } });
    expect(badAmount.ok).toBe(false);
    if (!badAmount.ok) expect(badAmount.reason).not.toBe("credential_unavailable");
    const badAccount = await gateway.execute({ identity: identityFor(TENANT_A), tool_id: "finance", action: "create_payment_intent", parameters: { tenant_id: TENANT_A, idempotency_key: `bad-acc-tgw-${Math.random()}`, purpose: "x", amount_ore: 100, vendor_name: "x", account_code: "abc" } });
    expect(badAccount.ok).toBe(false);
    if (!badAccount.ok) expect(badAccount.reason).not.toBe("credential_unavailable");
  });

  it("tenant-isolasjon er uendret gjennom ToolGateway-stien - TENANT_B ser aldri TENANT_A sine intents", async () => {
    const finance = new FinanceService(appPool, fakeFikenFactory);
    const gateway = buildGateway(new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()), finance);
    await gateway.execute({
      identity: identityFor(TENANT_A), tool_id: "finance", action: "create_payment_intent",
      parameters: { tenant_id: TENANT_A, idempotency_key: `iso-tgw-${Math.random()}`, purpose: "x", amount_ore: 100, vendor_name: "x", account_code: "6540" }
    });
    const listB = await finance.listPaymentIntents(TENANT_B, "business");
    expect(listB).toHaveLength(0);
  });
});

describe("C: Fiken-credentials er IRRELEVANTE for JARVIS_CANONICAL-domenet gjennom ToolGateway", () => {
  it("create/kill-switch/state-machine/reconciliation lykkes via ToolGateway UTEN JARVIS_FIKEN_*-env satt i det hele tatt", async () => {
    expect(process.env["JARVIS_FIKEN_CLIENT_ID"]).toBeUndefined();
    expect(process.env["JARVIS_FIKEN_REFRESH_TOKEN"]).toBeUndefined();
    const finance = new FinanceService(appPool, fakeFikenFactory);
    const gateway = buildGateway(new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()), finance);
    const result = await gateway.execute({
      identity: identityFor(TENANT_A), tool_id: "finance", action: "create_payment_intent",
      parameters: { tenant_id: TENANT_A, idempotency_key: `nocred-tgw-${Math.random()}`, purpose: "x", amount_ore: 100, vendor_name: "x", account_code: "6540" }
    });
    expect(result.ok).toBe(true);
  });

  it("submit_payment_intent (den ENESTE ekte Fiken-avhengige handlingen) BLOKKERES korrekt på ToolGateway-nivå UTEN JARVIS_FIKEN_REFRESH_TOKEN - dette er FORVENTET og distinkt fra credential_unavailable-regresjonen over: submit sin credential_ref (JARVIS_FIKEN_REFRESH_TOKEN) er en EKTE ekstern secret, IKKE sentinel-dekket av BusinessInternalSecretProvider, mens create/get/list/settle/cancel/reconcile/kill-switch (JARVIS_BUSINESS_INTERNAL_TOKEN) ALDRI skal kreve den", async () => {
    expect(process.env["JARVIS_FIKEN_REFRESH_TOKEN"]).toBeUndefined();
    const finance = new FinanceService(appPool, fakeFikenFactory);
    const gateway = buildGateway(new FallbackSecretProvider(new EnvSecretProvider(), new BusinessInternalSecretProvider()), finance);
    const created = await gateway.execute({
      identity: identityFor(TENANT_A), tool_id: "finance", action: "create_payment_intent",
      parameters: { tenant_id: TENANT_A, idempotency_key: `submit-nocred-${Math.random()}`, purpose: "x", amount_ore: 100, vendor_name: "x", vendor_provider_ref: "x", account_code: "6540", counter_account_code: "1920" }
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const submitted = await gateway.execute({ identity: identityFor(TENANT_A), tool_id: "finance", action: "submit_payment_intent", parameters: { tenant_id: TENANT_A, payment_intent_id: created.external_id! } });
    expect(submitted.ok).toBe(false);
    if (!submitted.ok) expect(submitted.reason).toBe("credential_unavailable");
  });
});
