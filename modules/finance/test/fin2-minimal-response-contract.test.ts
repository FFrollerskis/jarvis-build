import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FikenTransport,
  NeonomicsTransport,
  ProviderResponseInvalidError,
  StripeTransport,
  VippsTransport,
  WallesterTransport,
  acknowledgedFrom,
  classifyProviderFailure,
  createRsaJwtSigner,
  expectCurrency,
  expectId,
  expectStatus,
  resetFikenAccessTokenCache
} from "../src/index.ts";

/**
 * WP-FIN2 fiks-runde 1 (FIX-1, FIX-2, FIX-5, FIX-6): leverandørsvar valideres KUN på feltene koden faktisk bruker; resten valideres bare hvis det er til stede.
 * K7 var for streng: en fungerende 2xx (der leverandøren HAR utført handlingen) ble `outcome_unknown` fordi svaret manglet felt koden aldri leser - og en retry ga samme feil.
 * Her låses den smalere kontrakten, og at ekte feil (til stede, men ugyldig / feil `reference` / ikke et objekt) fortsatt feiler lukket. Svarformene er `unverified` (D-41).
 * Ingen nettverk: `fetch` er stubbet med ekte `Response`-objekter.
 */
let respond: (url: string, init?: RequestInit) => Response = () => new Response("{}", { status: 200 });
beforeEach(() => {
  resetFikenAccessTokenCache();
  vi.stubEnv("JARVIS_FIKEN_CLIENT_ID", "client-fixture");
  vi.stubEnv("JARVIS_FIKEN_CLIENT_SECRET", "secret-fixture");
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => respond(String(url), init));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function route(body: unknown, rawText?: string): void {
  respond = (url) => {
    if (/accesstoken\/get|openid-connect\/token|fiken\.no\/oauth\/token/.test(url)) return json({ access_token: "tok-fixture", expires_in: 3600 });
    return rawText !== undefined ? new Response(rawText, { status: 200 }) : json(body);
  };
}
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const wallester = () => new WallesterTransport("https://wallester.test", "api-key-fixture", createRsaJwtSigner(privateKey), "acc-1");
const vipps = () => new VippsTransport("c", "s-fixture", "k", "1", "test");
const stripe = () => new StripeTransport("sk-fixture-not-a-key");
const neonomics = () => new NeonomicsTransport("c", "s-fixture", "11111111-2222-3333-4444-555555555555", "sandbox");
const fiken = () => new FikenTransport("refresh-fixture", "firma");
const codeOf = async (call: () => Promise<unknown>): Promise<string> => {
  const err = await call().then(() => null, (e: unknown) => e);
  expect(err, "skulle kastet").toBeInstanceOf(ProviderResponseInvalidError);
  return (err as ProviderResponseInvalidError).code;
};

// === FIX-1: Wallester livssyklus-PATCH ===================================================================================================
const LIFECYCLE = [
  ["activateCard", () => wallester().activateCard("wc-1")],
  ["blockCard", () => wallester().blockCard("wc-1")],
  ["unblockCard", () => wallester().unblockCard("wc-1")],
  ["closeCard", () => wallester().closeCard("wc-1")]
] as const;

describe("FIX-1: Wallester livssyklusverb - tom/ufullstendig 2xx er `status: unknown` (aldri outcome_unknown), til stede-men-ugyldig feiler fortsatt", () => {
  const ACCEPTED: ReadonlyArray<[string, unknown, string | undefined, string]> = [
    ["tom kropp", undefined, "", "unknown"],
    ["{}", {}, undefined, "unknown"],
    ["JSON null", null, undefined, "unknown"],
    ["kun {status}", { status: "Blocked" }, undefined, "Blocked"],
    ["kun {id}", { id: "wc-1" }, undefined, "unknown"],
    ["wrapper {card:{id,status}} (ingen felt på toppnivå)", { card: { id: "wc-1", status: "Blocked" } }, undefined, "unknown"],
    ["tom status-streng", { id: "wc-1", status: "" }, undefined, "unknown"],
    ["null-status og null-id", { id: null, status: null }, undefined, "unknown"],
    ["full {id,status}", { id: "wc-1", status: "Blocked" }, undefined, "Blocked"]
  ];
  for (const [verb, call] of LIFECYCLE) {
    for (const [label, body, rawText, expectedStatus] of ACCEPTED) {
      it(`${verb}: ${label} -> ok, status ${expectedStatus}, id fra forespørselen`, async () => {
        route(body, rawText);
        expect(await call()).toMatchObject({ id: "wc-1", status: expectedStatus });
      });
    }
    const REJECTED: ReadonlyArray<[string, unknown, string | undefined, string]> = [
      ["status feil type", { status: 5 }, undefined, "status_wrong_type"],
      ["status med ugyldige tegn", { status: "bad status!" }, undefined, "status_invalid"],
      ["status er strengen «undefined»", { status: "undefined" }, undefined, "status_invalid"],
      ["id feil type", { id: 123, status: "Blocked" }, undefined, "id_wrong_type"],
      ["id med ugyldige tegn", { id: "bad id!", status: "Blocked" }, undefined, "id_invalid"],
      ["liste i stedet for objekt", [], undefined, "body_wrong_type"],
      ["tekst i stedet for objekt", "tekst", undefined, "body_wrong_type"],
      ["ikke JSON (HTML fra en mellomtjener)", undefined, "<html>502</html>", "body_not_json"]
    ];
    for (const [label, body, rawText, code] of REJECTED) {
      it(`${verb}: ${label} -> outcome_unknown (${code})`, async () => {
        route(body, rawText);
        const err = await call().then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(ProviderResponseInvalidError);
        expect((err as ProviderResponseInvalidError).code).toBe(code);
        expect((err as Error).message).toMatch(/^outcome_unknown:provider_response_invalid:/);
        expect(classifyProviderFailure(err)).toBe("unknown");
      });
    }
  }

  it("createCard og getCard beholder STRENG validering (id og status påkrevd - kortet lagres med dem)", async () => {
    route({ status: "Active" });
    expect(await codeOf(() => wallester().getCard("wc-1"))).toBe("id_missing");
    route({ id: "wc-1" });
    expect(await codeOf(() => wallester().getCard("wc-1"))).toBe("status_missing");
    route({});
    expect(await codeOf(() => wallester().createCard({
      externalReference: "card-1", name: "K", type: "virtual", currency: "EUR", cardholderName: null,
      limits: { transactionLimitOre: null, dailyLimitOre: null, weeklyLimitOre: null, monthlyLimitOre: null, atmEnabled: false, onlineEnabled: true, contactlessEnabled: true }
    }))).toBe("id_missing");
  });
});

// === FIX-2: Vipps =====================================================================================================================
const REF = "fin-pi-1";
const createInput = { amountOre: 10_000, currency: "NOK", reference: REF, paymentDescription: "x", returnUrl: "https://x.test", idempotencyKey: "k" };
const MODIFICATIONS = [
  ["capturePayment", () => vipps().capturePayment({ reference: REF, amountOre: 5_000, currency: "NOK", idempotencyKey: "k" })],
  ["cancelPayment", () => vipps().cancelPayment(REF, "k")],
  ["refundPayment", () => vipps().refundPayment({ reference: REF, amountOre: 5_000, currency: "NOK", idempotencyKey: "k" })]
] as const;

describe("FIX-2: Vipps capture/cancel/refund - en 2xx med et objekt er en bekreftelse (tjenesten leser ikke svaret)", () => {
  for (const [name, call] of MODIFICATIONS) {
    for (const [label, body] of [
      ["tomt objekt", {}],
      ["kun reference", { reference: REF }],
      ["annen kropp (aggregate/pspReference)", { aggregate: { capturedAmount: { currency: "NOK", value: 5_000 } }, pspReference: "p-1" }],
      ["fullt betalingsobjekt", { reference: REF, state: "AUTHORIZED", amount: { currency: "NOK", value: 10_000 } }],
      ["til og med ugyldige ubrukte felt (state/amount leses aldri)", { state: 5, amount: "x" }],
      ["tom reference-streng (= ikke oppgitt)", { reference: "" }]
    ] as const) {
      it(`${name}: ${label} -> ok { reference: forespurt }`, async () => {
        route(body);
        expect(await call()).toEqual({ reference: REF });
      });
    }
    for (const [label, body, rawText, code] of [
      ["feil reference", { reference: "fin-pi-ANNEN" }, undefined, "reference_mismatch"],
      ["reference feil type", { reference: 5 }, undefined, "reference_wrong_type"],
      ["reference med ugyldige tegn", { reference: "bad ref!" }, undefined, "reference_invalid"],
      ["JSON null", null, undefined, "body_missing"],
      ["liste", [], undefined, "body_wrong_type"],
      ["tekst", "tekst", undefined, "body_wrong_type"],
      ["ikke JSON", undefined, "<html>502</html>", "body_not_json"]
    ] as const) {
      it(`${name}: ${label} -> outcome_unknown (${code})`, async () => {
        route(body, rawText);
        const err = await call().then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(ProviderResponseInvalidError);
        expect((err as ProviderResponseInvalidError).code).toBe(code);
        expect((err as Error).message).toMatch(/^outcome_unknown:provider_response_invalid:/);
        expect(classifyProviderFailure(err)).toBe("unknown");
      });
    }
  }

  it("acknowledgedFrom: ren enhetstest (ingen nettverk) - krever objekt; reference må matche hvis til stede; returnerer alltid den forespurte referansen", () => {
    const ctx = { operation: "vipps.test", mutation: true } as const;
    expect(acknowledgedFrom({}, ctx, REF)).toEqual({ reference: REF });
    expect(acknowledgedFrom({ reference: REF, extra: 1 }, ctx, REF)).toEqual({ reference: REF });
    expect(() => acknowledgedFrom(null, ctx, REF)).toThrow(/body_missing/);
    expect(() => acknowledgedFrom({ reference: "x" }, ctx, REF)).toThrow(/reference_mismatch/);
  });

  it("getPayment beholder STRENG validering (state og beløp LESES av oppfriskingen)", async () => {
    route({ reference: REF });
    expect(await codeOf(() => vipps().getPayment(REF))).toBe("amount_missing");
    route({ reference: REF, amount: { currency: "NOK", value: 1 } });
    expect(await codeOf(() => vipps().getPayment(REF))).toBe("state_missing");
  });
});

describe("FIX-2: Vipps createPayment - kun `reference` er påkrevd; state/amount valideres hvis til stede, ellers NULL (første webhook/oppfrisking fyller dem)", () => {
  it("dokumentert svar {reference, redirectUrl} -> ok med state=null og amount=null", async () => {
    route({ reference: REF, redirectUrl: "https://example.invalid/r" });
    expect(await vipps().createPayment(createInput)).toEqual({ reference: REF, state: null, amount: null });
  });
  it("fullt svar -> state og amount som før", async () => {
    route({ reference: REF, state: "CREATED", amount: { currency: "NOK", value: 10_000 } });
    expect(await vipps().createPayment(createInput)).toEqual({ reference: REF, state: "CREATED", amount: { currency: "NOK", value: 10_000 } });
  });
  it("kun state, eller kun amount, er gyldig (det andre feltet blir null)", async () => {
    route({ reference: REF, state: "CREATED" });
    expect(await vipps().createPayment(createInput)).toEqual({ reference: REF, state: "CREATED", amount: null });
    route({ reference: REF, amount: { currency: "NOK", value: 10_000 } });
    expect(await vipps().createPayment(createInput)).toEqual({ reference: REF, state: null, amount: { currency: "NOK", value: 10_000 } });
  });
  for (const [label, body, code] of [
    ["reference mangler", { redirectUrl: "https://x.test" }, "reference_missing"],
    ["reference er en annen enn forespurt", { reference: "fin-pi-ANNEN" }, "reference_mismatch"],
    ["state feil type", { reference: REF, state: 5 }, "state_wrong_type"],
    ["state med ugyldige tegn", { reference: REF, state: "bad state!" }, "state_invalid"],
    ["amount er ikke et objekt", { reference: REF, amount: "tekst" }, "amount_wrong_type"],
    ["amount uten value", { reference: REF, amount: { currency: "NOK" } }, "value_missing"],
    ["amount uten valuta", { reference: REF, amount: { value: 1 } }, "currency_missing"],
    ["amount.value negativ", { reference: REF, amount: { currency: "NOK", value: -5 } }, "value_negative"],
    ["tom kropp {}", {}, "reference_missing"]
  ] as const) {
    it(`${label} -> outcome_unknown (${code})`, async () => {
      route(body);
      expect(await codeOf(() => vipps().createPayment(createInput))).toMatch(new RegExp(`${code}$`));
    });
  }
});

describe("FIX-2: Stripe-refusjon - id, beløp og valuta (brukes) er påkrevd; object/status/payment_intent/reason er valgfrie (valideres hvis til stede)", () => {
  const base = { id: "re_123", amount: 2_500, currency: "nok" };
  const create = () => stripe().createRefund({ stripePaymentIntentId: "pi_123", amountOre: 2_500, idempotencyKey: "k" });
  const get = () => stripe().getRefund("re_123");
  for (const [name, call] of [["createRefund", create], ["getRefund", get]] as const) {
    it(`${name}: minimalt svar {id, amount, currency} -> ok med status=null og payment_intent=null`, async () => {
      route(base);
      expect(await call()).toMatchObject({ id: "re_123", object: "refund", amount: 2_500, currency: "nok", status: null, payment_intent: null, reason: null });
    });
    it(`${name}: status: null og payment_intent: null (Stripe kan sende null) -> ok`, async () => {
      route({ ...base, object: "refund", status: null, payment_intent: null, reason: null });
      expect(await call()).toMatchObject({ status: null, payment_intent: null });
    });
    it(`${name}: fullt svar -> som før`, async () => {
      route({ ...base, object: "refund", status: "pending", payment_intent: "pi_123", reason: "requested_by_customer" });
      expect(await call()).toMatchObject({ status: "pending", payment_intent: "pi_123", reason: "requested_by_customer" });
    });
    for (const [label, body, code] of [
      ["id mangler", { amount: 1, currency: "nok" }, "id_missing"],
      ["amount mangler", { id: "re_1", currency: "nok" }, "amount_missing"],
      ["currency mangler", { id: "re_1", amount: 1 }, "currency_missing"],
      ["object er noe annet", { ...base, object: "payment_intent" }, "object_mismatch"],
      ["status feil type", { ...base, status: 5 }, "status_wrong_type"],
      ["status med ugyldige tegn", { ...base, status: "bad status!" }, "status_invalid"],
      ["payment_intent feil type", { ...base, payment_intent: 5 }, "payment_intent_wrong_type"]
    ] as const) {
      it(`${name}: ${label} -> ${code}`, async () => {
        route(body);
        expect(await codeOf(call)).toBe(code);
      });
    }
  }
});

// === FIX-5: Neonomics-transaksjoner med ukjent/manglende status settes i karantene (ikke hele siden feiler) =========================
describe("FIX-5: Neonomics listTransactions - ukjent/manglende status gir `unknown` (karantene i tjenesten), id/beløp/valuta feiler fortsatt hele siden", () => {
  const tx = (extra: Record<string, unknown>) => ({ id: "tx-1", amount: "-99.00", currency: "nok", bookingDate: "2026-11-25", ...extra });
  for (const [label, status, expected] of [
    ["pending", "pending", "pending"], ["PENDING (store bokstaver)", "PENDING", "pending"], ["BOOKED", "BOOKED", "booked"], ["booked", "booked", "booked"],
    ["rejected", "rejected", "unknown"], ["information", "information", "unknown"], ["cancelled", "cancelled", "unknown"], ["reserved", "reserved", "unknown"],
    ["tom streng", "", "unknown"], ["null", null, "unknown"], ["feil type", 5, "unknown"], ["ugyldige tegn", "bad status!", "unknown"], ["strengen «undefined»", "undefined", "unknown"],
    ["pending med mellomrom (ikke normalisert)", "pending ", "unknown"]
  ] as const) {
    it(`status ${label} -> ${expected}`, async () => {
      route([tx({ status })]);
      const page = await neonomics().listTransactions("s", "a", null);
      expect(page.transactions.map((t) => [t.id, t.status, t.amountOre, t.direction, t.currency])).toEqual([["tx-1", expected, 9_900, "debit", "NOK"]]);
    });
  }
  it("manglende status-felt -> unknown; resten av siden leses normalt (ett avvikende element stopper ikke synken)", async () => {
    route({ transactions: [{ id: "a", amount: "1.00", currency: "NOK" }, { id: "b", status: "booked", amount: "2.00", currency: "NOK" }, { id: "c", status: "weird", amount: "3.00", currency: "NOK" }], nextPageToken: "p2" });
    const page = await neonomics().listTransactions("s", "a", null);
    expect(page.transactions.map((t) => [t.id, t.status])).toEqual([["a", "unknown"], ["b", "booked"], ["c", "unknown"]]);
    expect(page.nextPageToken).toBe("p2");
  });
  for (const [label, item, code] of [
    ["id mangler", { status: "booked", amount: "1.00", currency: "NOK" }, "id_missing"],
    ["beløp mangler", { id: "x", status: "booked", currency: "NOK" }, "amount_missing"],
    ["valuta mangler", { id: "x", status: "booked", amount: "1.00" }, "currency_missing"]
  ] as const) {
    it(`${label} -> fortsatt typet feil for hele siden (${code})`, async () => {
      route([item]);
      expect(await codeOf(() => neonomics().listTransactions("s", "a", null))).toBe(code);
    });
  }
});

// === FIX-6 ==============================================================================================================================
describe("FIX-6: strengene «undefined»/«null»/«NaN» er aldri en gyldig id, status eller valuta", () => {
  const ctx = { operation: "test.sentinel", mutation: false } as const;
  for (const sentinel of ["undefined", "null", "NaN", "nan", "NULL", "Undefined"]) {
    it(`expectId/expectStatus avviser «${sentinel}»`, () => {
      expect(() => expectId({ id: sentinel }, "id", ctx)).toThrow(/id_invalid/);
      expect(() => expectStatus({ status: sentinel }, "status", ctx)).toThrow(/status_invalid/);
    });
    it(`transportmetoder avviser «${sentinel}» som id/status (Wallester getCard, Stripe getPaymentIntent, Vipps getPayment, Neonomics getPayment)`, async () => {
      route({ id: sentinel, status: "Active" });
      expect(await codeOf(() => wallester().getCard("wc-1"))).toBe("id_invalid");
      route({ id: "wc-1", status: sentinel });
      expect(await codeOf(() => wallester().getCard("wc-1"))).toBe("status_invalid");
      route({ id: "pi_1", object: "payment_intent", amount: 1, currency: "nok", status: sentinel });
      expect(await codeOf(() => stripe().getPaymentIntent("pi_1"))).toBe("status_invalid");
      route({ reference: sentinel, state: "AUTHORIZED", amount: { currency: "NOK", value: 1 } });
      expect(await codeOf(() => vipps().getPayment(REF))).toBe("reference_invalid");
      route({ id: "pay-1", status: sentinel });
      expect(await codeOf(() => neonomics().getPayment("s", "pay-1"))).toBe("status_invalid");
    });
  }
  it("vanlige verdier som BARE ligner (nullable, undefined_state, id 'nulla') avvises ikke", () => {
    expect(expectId({ id: "nulla" }, "id", ctx)).toBe("nulla");
    expect(expectStatus({ status: "undefined_state" }, "status", ctx)).toBe("undefined_state");
  });
  it("expectCurrency avviser «NaN» (tre bokstaver, men aldri en valuta)", () => {
    expect(() => expectCurrency({ currency: "NaN" }, "currency", ctx)).toThrow(/currency_invalid/);
    expect(expectCurrency({ currency: "NOK" }, "currency", ctx)).toBe("NOK");
  });
});

describe("FIX-6: Neonomics listAccounts validerer valutaformat når valuta er oppgitt (ikke bare uppercase)", () => {
  const account = (currency: unknown) => ({ id: "acc-1", accountName: "Drift", accountNumber: "12345678903", currency, accountType: "checking" });
  it("små bokstaver normaliseres; fraværende valuta er fortsatt null (kjent PARTIAL, banking-service.ts)", async () => {
    route([account("nok")]);
    expect((await neonomics().listAccounts("s"))[0]!.currency).toBe("NOK");
    route([{ id: "acc-1" }]);
    expect((await neonomics().listAccounts("s"))[0]!.currency).toBeNull();
    route([account(null)]);
    expect((await neonomics().listAccounts("s"))[0]!.currency).toBeNull();
  });
  for (const [label, value, code] of [["fire bokstaver", "NOKK", "currency_invalid"], ["tall i koden", "N0K", "currency_invalid"], ["for kort", "NO", "currency_invalid"], ["feil type", 123, "currency_wrong_type"], ["tom streng", "", "currency_empty"]] as const) {
    it(`valuta ${label} -> ${code}`, async () => {
      route([account(value)]);
      expect(await codeOf(() => neonomics().listAccounts("s"))).toBe(code);
    });
  }
});

describe("FIX-6: Fiken-lesere (listContacts, listBankAccounts, listJournalEntries) validerer liste og id - aldri `as T`", () => {
  const readers = [
    ["listContacts", () => fiken().listContacts(), "fiken.list_contacts", "contactId", { contactId: 1, name: "Kunde" }],
    ["listBankAccounts", () => fiken().listBankAccounts(), "fiken.list_bank_accounts", "bankAccountId", { bankAccountId: 2, name: "Drift", type: "NORMAL" }],
    ["listJournalEntries", () => fiken().listJournalEntries(), "fiken.list_journal_entries", "journalEntryId", { journalEntryId: 3, description: "x", date: "2026-11-25", lines: [{ debit: 100 }] }]
  ] as const;
  for (const [name, call, operation, idField, valid] of readers) {
    it(`${name}: gyldig liste passerer UENDRET (alle felt bevares, f.eks. bilagslinjer)`, async () => {
      route([valid]);
      expect(await call()).toEqual([valid]);
      route([]);
      expect(await call()).toEqual([]);
    });
    for (const [label, body, rawText, code] of [
      ["objekt i stedet for liste (aldri en stille tom liste)", {}, undefined, "body_wrong_type"],
      ["JSON null", null, undefined, "body_missing"],
      ["ikke JSON (HTML 200)", undefined, "<html>login</html>", "body_not_json"],
      ["element er ikke et objekt", ["tekst"], undefined, "item_wrong_type"],
      ["id mangler", [{ ...valid, [idField]: undefined }], undefined, `${idField}_missing`],
      ["id er ikke et positivt heltall", [{ ...valid, [idField]: -4 }], undefined, `${idField}_invalid`],
      ["id er en brøk", [{ ...valid, [idField]: 1.5 }], undefined, `${idField}_invalid`],
      ["id er en tekst som ikke er siffer", [{ ...valid, [idField]: "abc" }], undefined, `${idField}_invalid`]
    ] as const) {
      it(`${name}: ${label} -> typet feil ${code}`, async () => {
        route(body, rawText);
        const err = await call().then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(ProviderResponseInvalidError);
        expect((err as ProviderResponseInvalidError).code).toBe(code);
        expect((err as Error).message).toMatch(new RegExp(`^provider_response_invalid:${operation.replace(/\./g, "\\.")}:`));
        expect((err as Error).message.startsWith("outcome_unknown")).toBe(false); // lesing: ingen bivirkning å være usikker på
      });
    }
  }
});
