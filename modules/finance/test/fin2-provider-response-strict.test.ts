import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FikenTransport,
  NeonomicsTransport,
  ProviderResponseInvalidError,
  StripeTransport,
  VippsTransport,
  WallesterTransport,
  classifyProviderFailure,
  createRsaJwtSigner,
  resetFikenAccessTokenCache
} from "../src/index.ts";

/**
 * WP-FIN2 K7 (D-486, JARVIS-097/020-resten): leverandørsvar valideres STRENGT. Tabelltest over ALLE transportmetoder x (mangler / null / tom / feil type / negativ / brøk / ugyldig tegn):
 * et ugyldig 2xx-svar er for POST/PATCH `outcome_unknown:provider_response_invalid:<kode>` (leverandøren kan ha utført handlingen -> klassifiseres UKJENT av `classifyProviderFailure`),
 * for lesing en typet feil. Aldri en lagret «undefined» som id, aldri `?? "0"`/`?? "NOK"`/`?? "PDNG"`. Ingen nettverk: `fetch` er stubbet med ekte `Response`-objekter.
 */
const DELETE = Symbol("delete");
type Path = readonly string[];
type FieldKind = "id" | "amount" | "decimal" | "currency" | "status" | "object" | "nested_record";
interface Field { readonly path: Path; readonly kind: FieldKind; readonly name?: string }
interface Method {
  readonly name: string;
  readonly mutation: boolean;
  readonly operation: string;
  /** Gyldig svar - kontroll. */
  readonly valid: unknown;
  readonly expect: (result: unknown) => void;
  readonly call: () => Promise<unknown>;
  readonly fields: readonly Field[];
  /** Hele kroppen er en liste (ikke et objekt). */
  readonly bodyIsArray?: boolean;
  /** Listefeltet som bærer elementene (path til listen), og elementenes felter relativt. */
  readonly listPath?: Path;
}

const BAD: Record<Exclude<FieldKind, "object" | "nested_record">, ReadonlyArray<{ v: unknown; suffix: string }>> = {
  id: [{ v: DELETE, suffix: "missing" }, { v: null, suffix: "missing" }, { v: "", suffix: "empty" }, { v: 123, suffix: "wrong_type" }, { v: "bad id!", suffix: "invalid" }],
  amount: [
    { v: DELETE, suffix: "missing" }, { v: null, suffix: "missing" }, { v: "", suffix: "empty" }, { v: true, suffix: "wrong_type" }, { v: -5, suffix: "negative" },
    { v: 12.5, suffix: "not_integer" }, { v: "abc", suffix: "not_digits" }, { v: 1e15, suffix: "too_large" }
  ],
  decimal: [{ v: DELETE, suffix: "missing" }, { v: null, suffix: "missing" }, { v: "", suffix: "empty" }, { v: true, suffix: "wrong_type" }, { v: "abc", suffix: "unparseable" }, { v: "12.345", suffix: "unparseable" }],
  currency: [{ v: DELETE, suffix: "missing" }, { v: null, suffix: "missing" }, { v: "", suffix: "empty" }, { v: 123, suffix: "wrong_type" }, { v: "NO", suffix: "invalid" }, { v: "NOKK", suffix: "invalid" }],
  status: [{ v: DELETE, suffix: "missing" }, { v: null, suffix: "missing" }, { v: "", suffix: "empty" }, { v: 5, suffix: "wrong_type" }, { v: "bad status!", suffix: "invalid" }]
};

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function setAt(root: unknown, path: Path, value: unknown): unknown {
  const copy = clone(root) as Record<string, unknown>;
  let cursor: Record<string, unknown> = copy;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  const last = path[path.length - 1]!;
  if (value === DELETE) delete cursor[last]; else cursor[last] = value;
  return copy;
}

let respond: (url: string, init?: RequestInit) => Response = () => new Response("{}", { status: 200 });
let seenCalls: string[] = [];
beforeEach(() => {
  seenCalls = [];
  resetFikenAccessTokenCache();
  vi.stubEnv("JARVIS_FIKEN_CLIENT_ID", "client-fixture");
  vi.stubEnv("JARVIS_FIKEN_CLIENT_SECRET", "secret-fixture");
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seenCalls.push(String(url));
    return respond(String(url), init);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Token-endepunktene svarer gyldig; kun selve metodens endepunkt får den fabrikkerte kroppen. */
function route(body: unknown, rawText?: string): void {
  respond = (url) => {
    if (/accesstoken\/get|openid-connect\/token|fiken\.no\/oauth\/token/.test(url)) return json({ access_token: "tok-fixture", expires_in: 3600 });
    return rawText !== undefined ? new Response(rawText, { status: 200 }) : json(body);
  };
}

// === fikstur: gyldige svar =================================================================================================================
const stripePi = { id: "pi_123", object: "payment_intent", amount: 10_000, currency: "nok", status: "requires_payment_method", metadata: {} };
const stripeRefund = { id: "re_123", object: "refund", amount: 2_500, currency: "nok", status: "succeeded", payment_intent: "pi_123", reason: null };
const vippsPayment = { reference: "fin-pi-1", state: "AUTHORIZED", amount: { currency: "NOK", value: 10_000 } };
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

const stripe = () => new StripeTransport("sk-fixture-not-a-key");
const vipps = () => new VippsTransport("c", "s-fixture", "k", "1", "test");
const neonomics = () => new NeonomicsTransport("c", "s-fixture", "11111111-2222-3333-4444-555555555555", "sandbox");
const wallester = () => new WallesterTransport("https://wallester.test", "api-key-fixture", createRsaJwtSigner(privateKey), "acc-1");
const fiken = () => new FikenTransport("refresh-fixture", "firma");

const METHODS: readonly Method[] = [
  // --- Stripe ---------------------------------------------------------------------------------------------------------------------------
  {
    name: "stripe.createPaymentIntent", mutation: true, operation: "stripe.create_payment_intent", valid: stripePi,
    call: () => stripe().createPaymentIntent({ amountOre: 10_000, currency: "NOK", metadata: {}, idempotencyKey: "k" }),
    expect: (r) => expect(r).toMatchObject({ id: "pi_123", amount: 10_000, currency: "nok", status: "requires_payment_method" }),
    fields: [{ path: ["id"], kind: "id" }, { path: ["amount"], kind: "amount" }, { path: ["currency"], kind: "currency" }, { path: ["status"], kind: "status" }, { path: ["object"], kind: "object" }]
  },
  {
    name: "stripe.getPaymentIntent", mutation: false, operation: "stripe.get_payment_intent", valid: stripePi,
    call: () => stripe().getPaymentIntent("pi_123"),
    expect: (r) => expect(r).toMatchObject({ id: "pi_123", amount: 10_000, status: "requires_payment_method" }),
    fields: [{ path: ["id"], kind: "id" }, { path: ["amount"], kind: "amount" }, { path: ["currency"], kind: "currency" }, { path: ["status"], kind: "status" }, { path: ["object"], kind: "object" }]
  },
  {
    name: "stripe.createRefund", mutation: true, operation: "stripe.create_refund", valid: stripeRefund,
    call: () => stripe().createRefund({ stripePaymentIntentId: "pi_123", amountOre: 2_500, idempotencyKey: "k" }),
    expect: (r) => expect(r).toMatchObject({ id: "re_123", amount: 2_500, status: "succeeded", payment_intent: "pi_123" }),
    fields: [{ path: ["id"], kind: "id" }, { path: ["amount"], kind: "amount" }, { path: ["currency"], kind: "currency" }, { path: ["status"], kind: "status" }, { path: ["payment_intent"], kind: "id" }, { path: ["object"], kind: "object" }]
  },
  {
    name: "stripe.getRefund", mutation: false, operation: "stripe.get_refund", valid: stripeRefund,
    call: () => stripe().getRefund("re_123"),
    expect: (r) => expect(r).toMatchObject({ id: "re_123", amount: 2_500 }),
    fields: [{ path: ["id"], kind: "id" }, { path: ["amount"], kind: "amount" }, { path: ["currency"], kind: "currency" }, { path: ["status"], kind: "status" }, { path: ["payment_intent"], kind: "id" }, { path: ["object"], kind: "object" }]
  },
  // --- Vipps ----------------------------------------------------------------------------------------------------------------------------
  ...([
    ["createPayment", true, () => vipps().createPayment({ amountOre: 10_000, currency: "NOK", reference: "fin-pi-1", paymentDescription: "x", returnUrl: "https://x.test", idempotencyKey: "k" })],
    ["getPayment", false, () => vipps().getPayment("fin-pi-1")],
    ["capturePayment", true, () => vipps().capturePayment({ reference: "fin-pi-1", amountOre: 5_000, currency: "NOK", idempotencyKey: "k" })],
    ["cancelPayment", true, () => vipps().cancelPayment("fin-pi-1", "k")],
    ["refundPayment", true, () => vipps().refundPayment({ reference: "fin-pi-1", amountOre: 5_000, currency: "NOK", idempotencyKey: "k" })]
  ] as const).map(([name, mutation, call]): Method => ({
    name: `vipps.${name}`, mutation, operation: `vipps.${name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`, valid: vippsPayment, call,
    expect: (r) => expect(r).toMatchObject({ reference: "fin-pi-1", state: "AUTHORIZED", amount: { currency: "NOK", value: 10_000 } }),
    fields: [{ path: ["reference"], kind: "id" }, { path: ["state"], kind: "status" }, { path: ["amount"], kind: "nested_record" }, { path: ["amount", "value"], kind: "amount" }, { path: ["amount", "currency"], kind: "currency" }]
  })),
  // --- Neonomics ------------------------------------------------------------------------------------------------------------------------
  {
    name: "neonomics.listBanks", mutation: false, operation: "neonomics.list_banks", valid: [{ id: "DNB_NO", bankDisplayName: "DNB", countryCode: "NO" }], bodyIsArray: true,
    call: () => neonomics().listBanks(), expect: (r) => expect(r).toEqual([{ id: "DNB_NO", bankDisplayName: "DNB", countryCode: "NO" }]),
    fields: [{ path: ["0", "id"], kind: "id" }]
  },
  {
    name: "neonomics.createSession", mutation: true, operation: "neonomics.create_session", valid: { sessionId: "sess-1" },
    call: () => neonomics().createSession("DNB_NO"), expect: (r) => expect(r).toEqual({ sessionId: "sess-1" }),
    fields: [{ path: ["sessionId"], kind: "id" }]
  },
  {
    name: "neonomics.listAccounts", mutation: false, operation: "neonomics.list_accounts", valid: [{ id: "acc-1", accountName: "Drift", accountNumber: "12345678903", currency: "nok", accountType: "checking" }], bodyIsArray: true,
    call: () => neonomics().listAccounts("sess-1"), expect: (r) => expect(r).toEqual([{ id: "acc-1", accountName: "Drift", accountNumber: "12345678903", currency: "NOK", accountType: "checking" }]),
    fields: [{ path: ["0", "id"], kind: "id" }]
  },
  {
    name: "neonomics.getBalances", mutation: false, operation: "neonomics.get_balances", valid: [{ type: "closingBooked", amount: "-12.50", currency: "nok", referenceDate: "2026-11-25" }], bodyIsArray: true,
    call: () => neonomics().getBalances("sess-1", "acc-1"), expect: (r) => expect(r).toEqual([{ type: "closingBooked", amountOre: -1250, currency: "NOK", referenceDate: "2026-11-25" }]),
    fields: [{ path: ["0", "type"], kind: "status" }, { path: ["0", "amount"], kind: "decimal" }, { path: ["0", "currency"], kind: "currency" }]
  },
  {
    name: "neonomics.listTransactions", mutation: false, operation: "neonomics.list_transactions",
    valid: { transactions: [{ id: "tx-1", status: "BOOKED", amount: "-99.00", currency: "nok", bookingDate: "2026-11-25" }], nextPageToken: "p2" },
    call: () => neonomics().listTransactions("sess-1", "acc-1", null),
    expect: (r) => expect(r).toMatchObject({ transactions: [{ id: "tx-1", status: "booked", amountOre: 9_900, direction: "debit", currency: "NOK" }], nextPageToken: "p2" }),
    fields: [{ path: ["transactions", "0", "id"], kind: "id" }, { path: ["transactions", "0", "status"], kind: "status" }, { path: ["transactions", "0", "amount"], kind: "decimal" }, { path: ["transactions", "0", "currency"], kind: "currency" }]
  },
  {
    name: "neonomics.initiateDomesticPayment", mutation: true, operation: "neonomics.initiate_domestic_payment", valid: { id: "pay-1", status: "PDNG" },
    call: () => neonomics().initiateDomesticPayment({ sessionId: "sess-1", debtorAccountId: "acc-1", creditorName: "Lev AS", creditorAccountIdentifier: "98765432101", amountOre: 10_000, currency: "NOK", referenceText: "x", endToEndReference: "fin-pi-1" }),
    expect: (r) => expect(r).toEqual({ id: "pay-1", status: "PDNG" }),
    fields: [{ path: ["id"], kind: "id" }, { path: ["status"], kind: "status" }]
  },
  {
    name: "neonomics.getPayment", mutation: false, operation: "neonomics.get_payment", valid: { id: "pay-1", status: "ACSC" },
    call: () => neonomics().getPayment("sess-1", "pay-1"), expect: (r) => expect(r).toEqual({ id: "pay-1", status: "ACSC" }),
    fields: [{ path: ["id"], kind: "id" }, { path: ["status"], kind: "status" }]
  },
  // --- Wallester ------------------------------------------------------------------------------------------------------------------------
  ...([
    ["createCard", true, () => wallester().createCard({ externalReference: "card-1", name: "K", type: "virtual", currency: "EUR", cardholderName: null, limits: { transactionLimitOre: null, dailyLimitOre: null, weeklyLimitOre: null, monthlyLimitOre: null, atmEnabled: false, onlineEnabled: true, contactlessEnabled: true } })],
    ["getCard", false, () => wallester().getCard("wc-1")],
    ["activateCard", true, () => wallester().activateCard("wc-1")],
    ["blockCard", true, () => wallester().blockCard("wc-1")],
    ["unblockCard", true, () => wallester().unblockCard("wc-1")],
    ["closeCard", true, () => wallester().closeCard("wc-1")]
  ] as const).map(([name, mutation, call]): Method => ({
    name: `wallester.${name}`, mutation, operation: `wallester.${name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`, valid: { id: "wc-1", status: "Active", masked_card_number: "…4321", account_id: "acc-1" }, call,
    expect: (r) => expect(r).toMatchObject({ id: "wc-1", status: "Active", maskedCardNumber: "…4321" }),
    fields: [{ path: ["id"], kind: "id" }, { path: ["status"], kind: "status" }]
  })),
  {
    name: "wallester.listAuthorizations", mutation: false, operation: "wallester.list_authorizations",
    valid: { authorizations: [{ id: "a1", card_id: "wc-1", status: "approved", amount: 7_500, currency: "EUR" }] },
    call: () => wallester().listAuthorizations("wc-1", null), expect: (r) => expect((r as { items: unknown[] }).items[0]).toMatchObject({ id: "a1", amountOre: 7_500, currency: "EUR" }),
    fields: [{ path: ["authorizations", "0", "id"], kind: "id" }]
  },
  {
    name: "wallester.listTransactions", mutation: false, operation: "wallester.list_transactions",
    valid: { transactions: [{ id: "t1", card_id: "wc-1", type: "purchase", amount: 1_200, currency: "EUR" }] },
    call: () => wallester().listTransactions("wc-1", null), expect: (r) => expect((r as { items: unknown[] }).items[0]).toMatchObject({ id: "t1", amountOre: 1_200 }),
    fields: [{ path: ["transactions", "0", "id"], kind: "id" }]
  },
  // --- Fiken ----------------------------------------------------------------------------------------------------------------------------
  {
    name: "fiken.listCompanies", mutation: false, operation: "fiken.list_companies", valid: [{ slug: "firma-as", name: "Firma AS" }], bodyIsArray: true,
    call: () => fiken().listCompanies(), expect: (r) => expect(r).toEqual([{ slug: "firma-as", name: "Firma AS" }]),
    fields: [{ path: ["0", "slug"], kind: "id" }]
  }
];

function expectInvalid(error: unknown, method: Method, codeSuffix: string): void {
  expect(error, `${method.name} skulle kastet`).toBeInstanceOf(ProviderResponseInvalidError);
  const e = error as ProviderResponseInvalidError;
  expect(e.mutation).toBe(method.mutation);
  if (method.mutation) {
    // POST/PATCH: leverandøren kan ha utført handlingen - ukjent utfall, aldri en retry-bar feil
    expect(e.message).toMatch(/^outcome_unknown:provider_response_invalid:/);
    expect(classifyProviderFailure(e)).toBe("unknown");
  } else {
    expect(e.message).toMatch(new RegExp(`^provider_response_invalid:${method.operation.replace(/\./g, "\\.")}:`));
    expect(e.message.startsWith("outcome_unknown")).toBe(false);
  }
  if (codeSuffix) expect(e.code, `${method.name}`).toMatch(new RegExp(`${codeSuffix}$`));
  expect(e.message.length).toBeLessThanOrEqual(160);
  expect(e.message).not.toMatch(/undefined|\[object/);
}

describe("K7: gyldige svar passerer (kontroll) - strengheten avviser ikke det som er riktig", () => {
  for (const method of METHODS) {
    it(`${method.name}: gyldig svar`, async () => {
      route(method.valid);
      method.expect(await method.call());
    });
  }
});

describe("K7: tabelltest - hvert felt x (mangler / null / tom / feil type / negativ / brøk / ugyldig)", () => {
  for (const method of METHODS) {
    for (const field of method.fields) {
      if (field.kind === "object") {
        for (const [label, value, suffix] of [["mangler", DELETE, "object_missing"], ["feil objekttype", "balance", "object_mismatch"]] as const) {
          it(`${method.name}: ${field.path.join(".")} ${label}`, async () => {
            route(setAt(method.valid, field.path, value));
            expectInvalid(await method.call().catch((e: unknown) => e), method, suffix);
          });
        }
        continue;
      }
      if (field.kind === "nested_record") {
        for (const [label, value, suffix] of [["mangler", DELETE, "_missing"], ["feil type", "tekst", "_wrong_type"], ["liste", [], "_wrong_type"]] as const) {
          it(`${method.name}: ${field.path.join(".")} (objekt) ${label}`, async () => {
            route(setAt(method.valid, field.path, value));
            expectInvalid(await method.call().catch((e: unknown) => e), method, suffix);
          });
        }
        continue;
      }
      for (const bad of BAD[field.kind]) {
        it(`${method.name}: ${field.path.join(".")} (${field.kind}) = ${bad.v === DELETE ? "<mangler>" : JSON.stringify(bad.v)} -> ${bad.suffix}`, async () => {
          route(setAt(method.valid, field.path, bad.v));
          expectInvalid(await method.call().catch((e: unknown) => e), method, bad.suffix);
        });
      }
    }
  }
});

describe("K7: hele kroppen - null / feil type / ikke-JSON", () => {
  for (const method of METHODS) {
    const badBodies: ReadonlyArray<[string, unknown, string]> = method.bodyIsArray
      ? [["null", null, "body_missing"], ["objekt i stedet for liste", {}, "body_wrong_type"], ["tekst", "tekst", "body_wrong_type"]]
      : [["null", null, "body_missing"], ["liste", [], "body_wrong_type"], ["tekst", "tekst", "body_wrong_type"], ["tall", 42, "body_wrong_type"]];
    for (const [label, body, suffix] of badBodies) {
      // `listTransactions` godtar BÅDE en liste og et objekt med `transactions` - en tom liste er en gyldig tom side (dekket separat under).
      if (method.name === "neonomics.listTransactions" && label === "liste") continue;
      it(`${method.name}: kropp = ${label}`, async () => {
        route(body);
        expectInvalid(await method.call().catch((e: unknown) => e), method, suffix);
      });
    }
    it(`${method.name}: kropp som ikke er JSON`, async () => {
      route(undefined, "<html>502 Bad Gateway</html>");
      expectInvalid(await method.call().catch((e: unknown) => e), method, "body_not_json");
    });
  }

  it("Neonomics-transaksjoner: manglende `transactions`-liste er ugyldig (aldri en stille tom side), og et tomt array er en gyldig tom side", async () => {
    route({ nextPageToken: "x" });
    const err = await neonomics().listTransactions("s", "a", null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderResponseInvalidError);
    expect((err as ProviderResponseInvalidError).code).toBe("transactions_missing");
    route([]);
    expect(await neonomics().listTransactions("s", "a", null)).toEqual({ transactions: [], nextPageToken: null });
    route({ transactions: [] });
    expect(await neonomics().listTransactions("s", "a", null)).toEqual({ transactions: [], nextPageToken: null });
  });

  it("Neonomics-transaksjoner: ukjent status avvises (aldri stille `booked`); kreditt/debet følger fortegnet", async () => {
    route([{ id: "t1", status: "weird", amount: "5.00", currency: "NOK" }]);
    expect(((await neonomics().listTransactions("s", "a", null).catch((e: unknown) => e)) as ProviderResponseInvalidError).code).toBe("status_unknown");
    route([{ id: "t1", status: "pending", amount: "5", currency: "NOK" }, { id: "t2", status: "booked", amount: "-0.05", currency: "eur" }]);
    const page = await neonomics().listTransactions("s", "a", null);
    expect(page.transactions.map((t) => [t.id, t.status, t.amountOre, t.direction, t.currency])).toEqual([["t1", "pending", 500, "credit", "NOK"], ["t2", "booked", 5, "debit", "EUR"]]);
  });
});

describe("K7: token-utvekslinger - ugyldig svar er en typet feil og forgifter aldri hurtigbufferen", () => {
  const cases: ReadonlyArray<[string, unknown, string]> = [
    ["mangler", { expires_in: 3600 }, "access_token_missing"], ["tom", { access_token: "", expires_in: 3600 }, "access_token_empty"],
    ["feil type", { access_token: 12345, expires_in: 3600 }, "access_token_wrong_type"], ["med mellomrom", { access_token: "to ord", expires_in: 3600 }, "access_token_invalid"], ["ikke et objekt", ["x"], "body_wrong_type"]
  ];
  const exchanges: ReadonlyArray<[string, RegExp, () => Promise<unknown>]> = [
    ["vipps", /accesstoken\/get/, () => vipps().getPayment("fin-pi-1")],
    ["neonomics", /openid-connect\/token/, () => neonomics().getPayment("s", "p")],
    ["fiken", /fiken\.no\/oauth\/token/, () => fiken().listCompanies()]
  ];
  for (const [provider, tokenUrl, call] of exchanges) {
    for (const [label, tokenBody, code] of cases) {
      it(`${provider}: access_token ${label} -> ${code}, ingen forespørsel til selve ressursen`, async () => {
        respond = (url) => (tokenUrl.test(url) ? json(tokenBody) : json({}));
        const err = await call().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ProviderResponseInvalidError);
        expect((err as ProviderResponseInvalidError).code).toBe(code);
        expect((err as ProviderResponseInvalidError).mutation).toBe(false);
        expect(seenCalls.filter((u) => !tokenUrl.test(u))).toHaveLength(0);
      });
    }
  }

  it("Fiken: et mislykket token-svar caches aldri - neste forsøk kan lykkes", async () => {
    respond = (url) => (/oauth\/token/.test(url) ? json({ nothing: true }) : json([{ slug: "a", name: "A" }]));
    await expect(fiken().listCompanies()).rejects.toBeInstanceOf(ProviderResponseInvalidError);
    respond = (url) => (/oauth\/token/.test(url) ? json({ access_token: "tok-ok", expires_in: 3600 }) : json([{ slug: "a", name: "A" }]));
    expect(await fiken().listCompanies()).toEqual([{ slug: "a", name: "A" }]);
  });
});

describe("K7: grenseverdier som SKAL være gyldige", () => {
  it("Stripe/Vipps/Neonomics/Wallester godtar siffer-streng-beløp og 0, store/små valutabokstaver, og negative Neonomics-saldoer og -transaksjoner", async () => {
    route({ ...stripePi, amount: "10000", currency: "NOK" });
    expect(await stripe().getPaymentIntent("pi_123")).toMatchObject({ amount: 10_000, currency: "NOK" });
    route({ ...vippsPayment, amount: { currency: "nok", value: 0 } });
    expect(await vipps().getPayment("fin-pi-1")).toMatchObject({ amount: { currency: "nok", value: 0 } });
    route([{ type: "expected", amount: -1, currency: "NOK" }, { type: "available", amount: 0, currency: "NOK" }, { type: "booked", amount: 12.5, currency: "NOK" }]);
    expect((await neonomics().getBalances("s", "a")).map((b) => b.amountOre)).toEqual([-100, 0, 1250]);
  });

  it("Stripe getBalance: negative saldoer er gyldige; ugyldig oppføring/objekttype avvises", async () => {
    route({ object: "balance", available: [{ amount: -500, currency: "nok" }], pending: [] });
    expect(await stripe().getBalance()).toEqual({ object: "balance", available: [{ amount: -500, currency: "nok" }], pending: [] });
    route({ object: "balance", available: [{ amount: 1.5, currency: "nok" }], pending: [] });
    expect(((await stripe().getBalance().catch((e: unknown) => e)) as ProviderResponseInvalidError).code).toBe("available_amount_invalid");
    route({ object: "balance", available: "x", pending: [] });
    expect(((await stripe().getBalance().catch((e: unknown) => e)) as ProviderResponseInvalidError).code).toBe("available_wrong_type");
    route({ object: "refund", available: [], pending: [] });
    expect(((await stripe().getBalance().catch((e: unknown) => e)) as ProviderResponseInvalidError).code).toBe("object_mismatch");
  });

  it("Wallester updateCardLimits: tomme PATCH-svar er fortsatt gyldige (ekko-verifisering gir confirmed=false) - men en ikke-objekt-kropp er et ugyldig svar", async () => {
    const limits = { transactionLimitOre: 1_000, dailyLimitOre: null, weeklyLimitOre: null, monthlyLimitOre: null, atmEnabled: false, onlineEnabled: true, contactlessEnabled: true };
    respond = () => new Response("", { status: 200 });
    expect((await wallester().updateCardLimits("wc-1", limits)).confirmed).toBe(false);
    respond = () => new Response("null", { status: 200 });
    const err = await wallester().updateCardLimits("wc-1", limits).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderResponseInvalidError);
    expect((err as Error).message).toMatch(/^outcome_unknown:provider_response_invalid:limits_body_missing$/);
  });
});
