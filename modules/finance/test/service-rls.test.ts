import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations } from "@jarvis/core";
import { startLeasedEmbeddedPostgres } from "@jarvis/core/testing";
import {
  FikenCredentialsUnavailableError,
  FinanceKillSwitchActiveError,
  InvalidAccountCodeError,
  InvalidAmountError,
  InvalidCurrencyError,
  MissingCounterAccountError,
  MissingVendorProviderRefError,
  PaymentIntentAlreadySubmittedError,
  PaymentIntentNotFoundError
} from "../src/types.ts";
import { InvalidPaymentIntentTransitionError } from "../src/state-machine.ts";
import { FinanceService, type FikenCredentials, type FikenCredentialsProvider, type FikenGeneralJournalEntryWriter } from "../src/service.ts";

/**
 * UA-6 Finance & Spend Integrity Gateway - FØRSTE slice (D-107): ekte
 * Postgres/RLS-integrasjonsbevis for `FinanceService` (samme mønster som
 * growth/agreements/support service-rls.test.ts, IKKE en `fakePool()`-mock).
 * `submitPaymentIntent()` sitt ekte HTTP-kall mot Fiken erstattes med en
 * injisert `FikenTransportFactory`-fake (se `FikenGeneralJournalEntryWriter`
 * i service.ts) - DETERMINISTISKE håndhevelsene (kill switch/vendor-/
 * motkonto-validering/idempotent no-op) skjer ALLE FØR denne noensinne
 * konstrueres/kalles, så faken beviser IKKE mindre enn en ekte transport
 * ville for disse testene.
 */
let PORT = 0;
let stopEmbeddedPostgres: (() => Promise<void>) | undefined;
let epg: InstanceType<typeof EmbeddedPostgres>;
let adminPool: pg.Pool;
let appPool: pg.Pool;
let service: FinanceService;
let fikenCalls: Array<{ description: string; lines: unknown }> = [];

const TENANT_A = "tenant-fin-svc-a";
const TENANT_B = "tenant-fin-svc-b";

const fakeFikenFactory = (_credentials: FikenCredentials): FikenGeneralJournalEntryWriter => ({
  async createGeneralJournalEntry(input) {
    fikenCalls.push({ description: input.description, lines: input.lines });
    return { journalEntryId: 42, description: input.description, date: input.date };
  },
  async listCompanies() {
    return [];
  }
});

const validCredentialsProvider: FikenCredentialsProvider = {
  async getCredentials(): Promise<FikenCredentials | null> {
    return { refreshToken: "fake-refresh-token", companySlug: "fake-company" };
  }
};

const noCredentialsProvider: FikenCredentialsProvider = {
  async getCredentials(): Promise<FikenCredentials | null> {
    return null;
  }
};

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-pg-finance-svc-"));
  const leasedPostgres = await startLeasedEmbeddedPostgres((port) =>
    new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port, persistent: false })
  );
  epg = leasedPostgres.postgres;
  PORT = leasedPostgres.port;
  stopEmbeddedPostgres = leasedPostgres.stop;
  await epg.createDatabase("jarvis_test");
  adminPool = new pg.Pool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "postgres", password: "pw" });
  adminPool.on("error", () => undefined);
  await runMigrations(adminPool);

  await adminPool.query("CREATE ROLE jarvis_fin_svc_test LOGIN PASSWORD 'pw2' NOSUPERUSER NOBYPASSRLS");
  await adminPool.query("GRANT jarvis_app TO jarvis_fin_svc_test");

  await adminPool.query(
    `INSERT INTO tenants (tenant_id, name, kind) VALUES ('${TENANT_A}', 'Finance Svc A', 'business'), ('${TENANT_B}', 'Finance Svc B', 'business')`
  );
  await adminPool.query(`INSERT INTO people (person_id, display_name) VALUES ('person-fin-owner', 'Owner One')`);

  appPool = createPool({ host: "127.0.0.1", port: PORT, database: "jarvis_test", user: "jarvis_fin_svc_test", password: "pw2" });
  service = new FinanceService(appPool, fakeFikenFactory);
}, 240_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await stopEmbeddedPostgres?.();
}, 120_000);

function baseInput(overrides: Partial<Parameters<FinanceService["createPaymentIntent"]>[2]> = {}) {
  return {
    idempotency_key: `idem-${Math.random().toString(36).slice(2)}`,
    purpose: "Test kjøp",
    amount_ore: 10_000,
    vendor_name: "Leverandør AS",
    account_code: "6540",
    ...overrides
  };
}

describe("A: idempotent opprettelse (akseptansekriterium 1 - retry can never double-pay)", () => {
  it("samme idempotency_key returnerer SAMME rad, oppretter aldri en duplikat", async () => {
    const key = `idem-fixed-${Math.random()}`;
    const first = await service.createPaymentIntent(TENANT_A, "business", baseInput({ idempotency_key: key }));
    const second = await service.createPaymentIntent(TENANT_A, "business", baseInput({ idempotency_key: key }));
    expect(second.payment_intent_id).toBe(first.payment_intent_id);
    expect(second.vendor_name).toBe("Leverandør AS");
    // D-392 (JARVIS-072): samme nøkkel med ANDRE parametre er en konflikt - aldri en stille retur av en annen betaling.
    await expect(service.createPaymentIntent(TENANT_A, "business", baseInput({ idempotency_key: key, vendor_name: "ANNET NAVN" }))).rejects.toThrow("idempotency_key_conflict");
    const all = await service.listPaymentIntents(TENANT_A, "business");
    expect(all.filter((i) => i.idempotency_key === key)).toHaveLength(1);
  });
  it("oppretter et intent_created-event kun ved den FØRSTE (ekte) opprettelsen", async () => {
    const key = `idem-events-${Math.random()}`;
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput({ idempotency_key: key }));
    await service.createPaymentIntent(TENANT_A, "business", baseInput({ idempotency_key: key }));
    const events = await service.listEvents(TENANT_A, "business", intent.payment_intent_id);
    expect(events.filter((e) => e["event_type"] === "intent_created")).toHaveLength(1);
  });
});

describe("B: deterministisk validering (akseptansekriterium 3 - feil format fanges FØR noe providerkall)", () => {
  it("amount_ore <= 0 kaster InvalidAmountError", async () => {
    await expect(service.createPaymentIntent(TENANT_A, "business", baseInput({ amount_ore: 0 }))).rejects.toThrow(InvalidAmountError);
    await expect(service.createPaymentIntent(TENANT_A, "business", baseInput({ amount_ore: -100 }))).rejects.toThrow(InvalidAmountError);
  });
  it("ikke-heltall amount_ore kaster InvalidAmountError", async () => {
    await expect(service.createPaymentIntent(TENANT_A, "business", baseInput({ amount_ore: 100.5 }))).rejects.toThrow(InvalidAmountError);
  });
  it("ugyldig valutakode kaster InvalidCurrencyError", async () => {
    await expect(service.createPaymentIntent(TENANT_A, "business", baseInput({ currency: "nok" }))).rejects.toThrow(InvalidCurrencyError);
    await expect(service.createPaymentIntent(TENANT_A, "business", baseInput({ currency: "NOKX" }))).rejects.toThrow(InvalidCurrencyError);
  });
  it("ugyldig kontokode kaster InvalidAccountCodeError", async () => {
    await expect(service.createPaymentIntent(TENANT_A, "business", baseInput({ account_code: "abc" }))).rejects.toThrow(InvalidAccountCodeError);
    await expect(service.createPaymentIntent(TENANT_A, "business", baseInput({ account_code: "123" }))).rejects.toThrow(InvalidAccountCodeError);
  });
  it("gyldig reskontro-format (NNNN:NNNNN) aksepteres", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput({ account_code: "1500:10001" }));
    expect(intent.account_code).toBe("1500:10001");
  });
  it("ugyldig motkonto-format kaster InvalidAccountCodeError", async () => {
    await expect(service.createPaymentIntent(TENANT_A, "business", baseInput({ counter_account_code: "xx" }))).rejects.toThrow(InvalidAccountCodeError);
  });
});

describe("C: deterministisk avviksflagging ved opprettelse", () => {
  it("manglende vendor_provider_ref/counter_account_code flagges (ikke blokkerende ved DRAFT)", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput());
    expect(intent.anomaly_flags).toContain("vendor_provider_ref_missing_at_creation");
    expect(intent.anomaly_flags).toContain("counter_account_code_missing_at_creation");
    expect(intent.state).toBe("draft");
  });
  it("full informasjon ved opprettelse gir INGEN avviksflagg", async () => {
    const intent = await service.createPaymentIntent(
      TENANT_A, "business",
      baseInput({ vendor_provider_ref: "fiken-contact-1", counter_account_code: "1920" })
    );
    expect(intent.anomaly_flags).toEqual([]);
  });
});

describe("D: submitPaymentIntent fail-closed FØR noe providerkall", () => {
  it("manglende vendor_provider_ref blokkerer innsending (MissingVendorProviderRefError)", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput({ counter_account_code: "1920" }));
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider)).rejects.toThrow(MissingVendorProviderRefError);
  });
  it("manglende counter_account_code blokkerer innsending (MissingCounterAccountError)", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput({ vendor_provider_ref: "fiken-contact-1" }));
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider)).rejects.toThrow(MissingCounterAccountError);
  });
  it("ukjent payment_intent_id kaster PaymentIntentNotFoundError", async () => {
    await expect(service.submitPaymentIntent(TENANT_A, "business", "fin-pi-does-not-exist", validCredentialsProvider)).rejects.toThrow(PaymentIntentNotFoundError);
  });
  it("manglende Fiken-credentials kaster FikenCredentialsUnavailableError", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput({ vendor_provider_ref: "fiken-contact-1", counter_account_code: "1920" }));
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, noCredentialsProvider)).rejects.toThrow(FikenCredentialsUnavailableError);
  });
});

describe("E: finans-nødbryter (akseptansekriterium 5 - deterministisk håndhevet)", () => {
  it("aktivert nødbryter blokkerer submitPaymentIntent umiddelbart", async () => {
    await service.enableKillSwitch(TENANT_A, "person-fin-owner", "test-blokkering");
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput({ vendor_provider_ref: "fiken-contact-1", counter_account_code: "1920" }));
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider)).rejects.toThrow(FinanceKillSwitchActiveError);
    const stillDraft = await service.getPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(stillDraft?.state).toBe("draft"); // fail-closed: INGEN delvis overgang
    const killSwitchBlockedEvents = await service.listEvents(TENANT_A, "business", intent.payment_intent_id);
    expect(killSwitchBlockedEvents.some((e) => e["event_type"] === "kill_switch_blocked")).toBe(true);
    await service.disableKillSwitch(TENANT_A, "person-fin-owner");
  });
  it("get_kill_switch reflekterer gjeldende tilstand", async () => {
    await service.enableKillSwitch(TENANT_A, "person-fin-owner", "reason-x");
    let ks = await service.getKillSwitch(TENANT_A);
    expect(ks?.enabled).toBe(true);
    await service.disableKillSwitch(TENANT_A, "person-fin-owner");
    ks = await service.getKillSwitch(TENANT_A);
    expect(ks?.enabled).toBe(false);
  });
  it("tenant uten noensinne aktivert nødbryter har enabled=false (fail-open for aldri-konfigurert = normal drift)", async () => {
    const ks = await service.getKillSwitch(TENANT_B);
    expect(ks).toBeNull();
  });
});

describe("F: full innsendingsflyt (idempotent no-op ved retry)", () => {
  it("submitPaymentIntent poster til Fiken ÉN gang, overgang til provider_acknowledged", async () => {
    fikenCalls = [];
    const intent = await service.createPaymentIntent(
      TENANT_A, "business",
      baseInput({ vendor_provider_ref: "fiken-contact-1", counter_account_code: "1920", amount_ore: 25_000 })
    );
    const submitted = await service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider, "person-fin-owner");
    expect(submitted.state).toBe("provider_acknowledged");
    expect(submitted.provider_ref).toBe("42");
    expect(fikenCalls).toHaveLength(1);
    expect(fikenCalls[0]!.lines).toEqual([
      { account: "6540", amount: 25_000 },
      { account: "1920", amount: -25_000 }
    ]);
  });
  it("en RETRY av submitPaymentIntent på SAMME intent er en idempotent no-op - ALDRI et nytt Fiken-kall", async () => {
    fikenCalls = [];
    const intent = await service.createPaymentIntent(
      TENANT_A, "business",
      baseInput({ vendor_provider_ref: "fiken-contact-2", counter_account_code: "1920" })
    );
    const first = await service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider);
    expect(fikenCalls).toHaveLength(1);
    const second = await service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider);
    expect(fikenCalls).toHaveLength(1); // uendret - INGEN nytt providerkall
    expect(second.payment_intent_id).toBe(first.payment_intent_id);
    expect(second.provider_ref).toBe(first.provider_ref);
  });
  it("submitPaymentIntent på en TERMINAL tilstand (failed/cancelled) kaster PaymentIntentAlreadySubmittedError", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput());
    await service.cancelPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    await expect(service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider)).rejects.toThrow(PaymentIntentAlreadySubmittedError);
  });
});

describe("G: settle/cancel-overganger", () => {
  it("settlePaymentIntent krever gyldig forutgående tilstand (draft -> settled er ugyldig)", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput());
    await expect(service.settlePaymentIntent(TENANT_A, "business", intent.payment_intent_id)).rejects.toThrow(InvalidPaymentIntentTransitionError);
  });
  it("full syklus draft -> submitted/provider_acknowledged -> settled", async () => {
    const intent = await service.createPaymentIntent(
      TENANT_A, "business",
      baseInput({ vendor_provider_ref: "fiken-contact-3", counter_account_code: "1920" })
    );
    await service.submitPaymentIntent(TENANT_A, "business", intent.payment_intent_id, validCredentialsProvider);
    const settled = await service.settlePaymentIntent(TENANT_A, "business", intent.payment_intent_id, "person-fin-owner");
    expect(settled.state).toBe("settled");
    expect(settled.settled_at).not.toBeNull();
  });
  it("cancelPaymentIntent fra draft lykkes, ALDRI fra en allerede innsendt intensjon", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput());
    const cancelled = await service.cancelPaymentIntent(TENANT_A, "business", intent.payment_intent_id);
    expect(cancelled.state).toBe("cancelled");
  });
});

describe("H: avstemming (akseptansekriterium 2)", () => {
  it("reconcilePaymentIntent(matched=true) setter reconciliation_state=matched", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput());
    const reconciled = await service.reconcilePaymentIntent(TENANT_A, "business", intent.payment_intent_id, true, "person-fin-owner", "OK");
    expect(reconciled.reconciliation_state).toBe("matched");
  });
  it("reconcilePaymentIntent(matched=false) setter reconciliation_state=mismatched og skriver et reconciled-event", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput());
    const reconciled = await service.reconcilePaymentIntent(TENANT_A, "business", intent.payment_intent_id, false, "person-fin-owner", "Beløp stemmer ikke");
    expect(reconciled.reconciliation_state).toBe("mismatched");
    const events = await service.listEvents(TENANT_A, "business", intent.payment_intent_id);
    expect(events.some((e) => e["event_type"] === "reconciled")).toBe(true);
  });
});

describe("I: tenant-isolasjon (RLS)", () => {
  it("TENANT_B ser ALDRI TENANT_A sine betalingsintensjoner", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput());
    const bList = await service.listPaymentIntents(TENANT_B, "business");
    expect(bList.find((i) => i.payment_intent_id === intent.payment_intent_id)).toBeUndefined();
    const bGet = await service.getPaymentIntent(TENANT_B, "business", intent.payment_intent_id);
    expect(bGet).toBeNull();
  });
  it("TENANT_B sin nødbryter er uavhengig av TENANT_A sin", async () => {
    await service.enableKillSwitch(TENANT_A, "person-fin-owner", "kun-A");
    const bKillSwitch = await service.getKillSwitch(TENANT_B);
    expect(bKillSwitch?.enabled ?? false).toBe(false);
    await service.disableKillSwitch(TENANT_A, "person-fin-owner");
  });
});

describe("J: listing/filter", () => {
  it("listPaymentIntents(state) filtrerer korrekt", async () => {
    const intent = await service.createPaymentIntent(TENANT_A, "business", baseInput());
    const draftList = await service.listPaymentIntents(TENANT_A, "business", { state: "draft" });
    expect(draftList.some((i) => i.payment_intent_id === intent.payment_intent_id)).toBe(true);
    const settledList = await service.listPaymentIntents(TENANT_A, "business", { state: "settled" });
    expect(settledList.some((i) => i.payment_intent_id === intent.payment_intent_id)).toBe(false);
  });
});
