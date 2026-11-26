import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * WP-FIN2 K1(a) (D-486, JARVIS-019-resten) - KILDEVAKT: ingen leverandør-I/O inne i en DB-transaksjon i `modules/finance/src/**`. `FOR UPDATE`-låsen og pool-forbindelsen skal aldri holdes over et
 * nettverkskall (Stripe/Vipps/Neonomics/Wallester/Fiken eller credential-oppslaget, som kan være et Infisical-kall). Ledgerradene 018/019 sto med «Åpent: refresh- og sync-metodene, kort-/bank-/spend-tjenester
 * ligger fortsatt i transaksjon» - revisjonen (`FINANCE_D_CHAIN.md` §11) viser at det ikke stemmer for koden på `main`, men BEVISET manglet for kort-/banktjenestene. Vakten (AST via TypeScript-kompilatoren, ikke regex)
 * låser det for alle filer; kjøretidsprobene (`fin2-no-lock-card-bank.test.ts`) viser det mot ekte Postgres.
 *
 * «Inne i en transaksjon» = (a) et kall til `withMemoryTransaction(`/`withTenantContext(`, og (b) `prepare:`/`apply:`/`onCallError:`-funksjonene til `providerCallOutsideLock` (kjøres av hjelperen i en transaksjon).
 * Unntatt (kjøres FØRST ETTER commit): `call:`-egenskapen til `providerCallOutsideLock` og det første lukkingsargumentet til `this.submitPlan(` (selve leverandørkallet). Ellers er forbudt:
 *   - `.getCredentials(` (credential-oppslag), kall på mottakere som heter `transport`/`gateway`/`gw` (leverandørtransportene), leverandørmetoder (`createPaymentIntent`, `capturePayment`, `listTransactions`, ...) på ikke-`this`-mottaker,
 *   - `fetch(`/`financeFetch(`, og `this.gateway(`/`this.refresh*`/`this.sync*`/`this.submit*`/... (egne tjenestemetoder som selv gjør leverandør-I/O).
 * Negativ kontroll: syntetiske kilder med bruddene MÅ fanges (og de lovlige formene MÅ ikke), så vakten ikke kan bli stille tom.
 *
 * KJENT BEGRENSNING (fiks-runde 1, FIX-10; `FINANCE_D_CHAIN.md` §11.1): vakten er NAVNEBASERT/leksikalsk. Den fanger kallene over når de står i klartekst inne i en transaksjonsblokk, men kan omgås: leverandør-I/O via en
 * HJELPEMETODE (`this.minHjelper()` som selv kaller `getCredentials`/`fetch`), `getCredentials` via destrukturering/`['getCredentials']`, `fetch` via `await import()`, egne tjenestemetoder som ikke står i `IO_SERVICE_METHODS`,
 * en leverandørmetode med et navn som ikke står i `PROVIDER_METHODS`, og en manuell `pool.connect()` + `BEGIN` uten `withMemoryTransaction` (reviewer A: 9 av 14 omgåelser slapp gjennom). Det som låser disse er KJØRETIDSPROBENE mot ekte
 * Postgres (`fin2-no-lock-card-bank.test.ts`: kort- og banktjenestene; `fin2-vipps-ack-and-locks.test.ts`: Vipps-cancel/capture/refund og Stripe-refusjon - credential-oppslag OG leverandørkall må stå uten åpen tx og uten radlås),
 * som feiler uansett hvordan I/O-en er skrevet. Nye leverandørmetoder MÅ legges til i `PROVIDER_METHODS` (sanity-testen under låser at alle metoder på transportene står på listen), og nye tjenester bør få en kjøretidsprobe.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const full = join(dir, n);
  return statSync(full).isDirectory() ? files(full) : n.endsWith(".ts") ? [full] : [];
});

const TX_CALLEES = new Set(["withMemoryTransaction", "withTenantContext"]);
const TX_PROPS = new Set(["prepare", "apply", "onCallError"]);
const PROVIDER_RECEIVERS = new Set(["transport", "gateway", "gw"]);
const PROVIDER_METHODS = new Set([
  "createPaymentIntent", "getPaymentIntent", "createRefund", "getRefund", "getBalance", "createPayment", "getPayment", "capturePayment", "cancelPayment", "refundPayment", "checkCredentials",
  "listBanks", "createSession", "getConsentUrl", "listAccounts", "getBalances", "listTransactions", "initiateDomesticPayment", "getPaymentAuthorizeUrl", "createCard", "getCard", "activateCard",
  "blockCard", "unblockCard", "closeCard", "updateCardLimits", "listAuthorizations", "getAccountBalance", "createGeneralJournalEntry", "listCompanies", "listJournalEntries", "listPostings", "getCredentials",
  // fiks-runde 1 (FIX-10): Fiken-lesemetodene sto ikke på listen (reviewer A M56: `this.fikenTransportFactory(...).listContacts()` i en transaksjon slapp gjennom).
  "listContacts", "listBankAccounts"
]);
/** Egne tjenestemetoder som selv gjør leverandør-I/O (credential-oppslag/nettverkskall) og derfor aldri kan kalles fra en transaksjon. EKSPLISITT liste (en sync*-prefiks ville truffet lokale DB-metoder som `syncIntentFlags`); at hvert navn finnes som metode låses under. */
export const IO_SERVICE_METHODS: readonly string[] = [
  "gateway", "providerCallOutsideLock", "runSubmitPlan", "prefetchCredentialsFor", "lifecycleAction",
  "refreshStripePaymentState", "refreshStripeRefundState", "refreshVippsPaymentState", "refreshNeonomicsPaymentState", "syncPendingStripePayments", "syncPendingVippsPayments", "syncPendingNeonomicsPayments",
  "syncCardState", "syncAuthorizations", "syncTransactions", "syncAccounts", "syncBalances",
  "submitPaymentIntent", "submitStripeRefund", "submitVippsCapture", "submitVippsRefund", "submitCard", "cancelVippsPayment",
  "activateCard", "freezeCard", "unfreezeCard", "closeCard", "updateSpendPolicy", "createConsent", "verifyConsent", "getConsentAuthorizationUrl", "listBanks",
  "getStripeBalance", "checkVippsCredentials", "listFikenCompanies", "getProviderBalance", "getNeonomicsPaymentAuthorizationUrl"
];
const IO_SERVICE_METHOD_SET = new Set(IO_SERVICE_METHODS);

export interface Violation { line: number; kind: string; text: string }

const nameOf = (n: ts.Node | undefined): string | null => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : null);
const receiverName = (e: ts.Expression): string | null => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null);

export function findProviderIoInTransactions(fileName: string, source: string): Violation[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const tx: Array<[number, number]> = [];
  const exempt: Array<[number, number]> = [];
  const range = (n: ts.Node): [number, number] => [n.getStart(sf), n.getEnd()];
  const collect = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && TX_CALLEES.has(callee.text)) tx.push(range(n));
      // første lukkingsargument til `this.submitPlan(idempotent, invoke, finalize)`: selve leverandørkallet, kjøres først etter commit
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "submitPlan" && n.arguments[1]) exempt.push(range(n.arguments[1]));
    }
    if (ts.isPropertyAssignment(n)) {
      const name = nameOf(n.name);
      if (name !== null && TX_PROPS.has(name)) tx.push(range(n.initializer));
      if (name === "call") exempt.push(range(n.initializer));
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const inside = (pos: number, ranges: ReadonlyArray<[number, number]>): boolean => ranges.some(([a, b]) => pos >= a && pos < b);
  const violations: Violation[] = [];
  const classify = (n: ts.CallExpression): string | null => {
    const callee = n.expression;
    if (ts.isIdentifier(callee)) return callee.text === "fetch" || callee.text === "financeFetch" ? "fetch" : null;
    if (!ts.isPropertyAccessExpression(callee)) return null;
    const method = callee.name.text;
    const receiver = receiverName(callee.expression);
    const onThis = callee.expression.kind === ts.SyntaxKind.ThisKeyword;
    if (method === "getCredentials") return "credential_lookup";
    if ((method === "fetch" || method === "financeFetch") && !onThis) return "fetch"; // `globalThis.fetch(...)`/`window.fetch(...)` (fiks-runde 1)
    if (receiver !== null && PROVIDER_RECEIVERS.has(receiver) && !onThis) return "provider_call";
    if (!onThis && PROVIDER_METHODS.has(method)) return "provider_method";
    if (onThis && IO_SERVICE_METHOD_SET.has(method)) return "service_method_with_provider_io";
    return null;
  };
  const isFetchName = (name: string): boolean => name === "fetch" || name === "financeFetch";
  const report = (n: ts.Node, kind: string): void => {
    const pos = n.getStart(sf);
    violations.push({ line: sf.getLineAndCharacterOfPosition(pos).line + 1, kind, text: n.getText(sf).slice(0, 80) });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const kind = inside(n.getStart(sf), tx) && !inside(n.getStart(sf), exempt) ? classify(n) : null;
      if (kind !== null) report(n, kind);
    }
    // fiks-runde 1 (FIX-10; reviewer A M57): `fetch` som REFERANSE (alias/`globalThis.fetch`/sendt videre som verdi), ikke bare som direkte kall: `const f = globalThis.fetch; await f(url)`.
    if (inside(n.getStart(sf), tx) && !inside(n.getStart(sf), exempt)) {
      if (ts.isPropertyAccessExpression(n) && isFetchName(n.name.text) && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) report(n, "fetch_reference");
      if (ts.isIdentifier(n) && isFetchName(n.text) && !(ts.isCallExpression(n.parent) && n.parent.expression === n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
        && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n) && !ts.isBindingElement(n.parent) && !ts.isParameter(n.parent)) report(n, "fetch_reference");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return violations;
}

describe("K1a: ingen leverandør-I/O inne i withMemoryTransaction/withTenantContext (og prepare/apply/onCallError) i modules/finance/src", () => {
  for (const file of files(SRC)) {
    const name = file.slice(SRC.length + 1);
    it(`${name}: ingen transport-/gateway-/getCredentials-/fetch-kall i en transaksjon`, () => {
      expect(findProviderIoInTransactions(name, readFileSync(file, "utf8"))).toEqual([]);
    });
  }

  it("sanity: hvert navn på listen over I/O-tjenestemetoder finnes som metode i kildene (en omdøping uten oppdatering feiler her)", () => {
    const all = files(SRC).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const method of IO_SERVICE_METHODS) expect(all, method).toMatch(new RegExp(`(?:async\\s+|private\\s+(?:async\\s+)?|^\\s*)${method}\\s*(?:<[^>]*>)?\\(`, "m"));
  });

  it("sanity: vakten leser faktisk transaksjonsblokker i hovedfilene (ikke en tom skanning)", () => {
    const blocks = (name: string): number => (readFileSync(join(SRC, name), "utf8").match(/withMemoryTransaction\(/g) ?? []).length;
    expect(blocks("service.ts")).toBeGreaterThan(30);
    expect(blocks("card-service.ts")).toBeGreaterThan(15);
    expect(blocks("banking-service.ts")).toBeGreaterThan(10);
    expect(readFileSync(join(SRC, "service.ts"), "utf8")).toContain("providerCallOutsideLock");
  });
});

describe("K1a: negativ kontroll - bruddene fanges, de lovlige formene fanges ikke", () => {
  const scan = (body: string) => findProviderIoInTransactions("synthetic.ts", body);
  const kinds = (body: string) => scan(body).map((v) => v.kind);

  it("lokale DB-metoder med sync-/refresh-prefiks (f.eks. syncIntentFlags) er IKKE leverandør-I/O og fanges ikke", () => {
    expect(kinds(`class C { async f(){ await withMemoryTransaction(pool, t, [s], async (client) => { await this.syncIntentFlags(client, t, s); }); } }`)).toEqual([]);
  });

  it("transportkall, credential-oppslag, fetch og gateway-/tjenestemetoder inne i withMemoryTransaction fanges", () => {
    expect(kinds(`async function f(){ await withMemoryTransaction(pool, t, [s], async (client) => { await transport.createCard({}); }); }`)).toEqual(["provider_call"]);
    expect(kinds(`async function f(){ await withMemoryTransaction(pool, t, [s], async (client) => { await plan.transport.capturePayment({}); }); }`)).toEqual(["provider_call"]);
    expect(kinds(`async function f(){ await withMemoryTransaction(pool, t, [s], async (client) => { const c = await this.credentialsProvider.getCredentials(t); }); }`)).toEqual(["credential_lookup"]);
    expect(kinds(`async function f(){ await withTenantContext(pool, t, async (client) => { await fetch("https://x.test"); }); }`)).toEqual(["fetch"]);
    expect(kinds(`async function f(){ await withMemoryTransaction(pool, t, [s], async (client) => { await financeFetch("https://x.test"); }); }`)).toEqual(["fetch"]);
    expect(kinds(`class C { async f(){ await withMemoryTransaction(pool, t, [s], async (client) => { const gw = await this.gateway(t); }); } }`)).toEqual(["service_method_with_provider_io"]);
    expect(kinds(`class C { async f(){ await withMemoryTransaction(pool, t, [s], async (client) => { await this.refreshStripePaymentState(t, s, id); }); } }`)).toEqual(["service_method_with_provider_io"]);
    expect(kinds(`async function f(){ await withMemoryTransaction(pool, t, [s], async (client) => { await stripe.createRefund({}); }); }`)).toEqual(["provider_method"]);
  });

  it("fiken-lesemetodene (reviewer A M56) og `fetch` som referanse/alias (reviewer A M57) inne i en transaksjon fanges; direkte `fetch`-kall gir fortsatt bare ÉN melding", () => {
    expect(kinds(`class C { async f(){ await withMemoryTransaction(pool, t, [s], async (client) => { const api = this.fikenTransportFactory(c); await api.listContacts(); }); } }`)).toEqual(["provider_method"]);
    expect(kinds(`class C { async f(){ await withMemoryTransaction(pool, t, [s], async (client) => { await fiken.listBankAccounts(); }); } }`)).toEqual(["provider_method"]);
    expect(kinds(`async function f(){ await withMemoryTransaction(pool, t, [s], async (client) => { const f = globalThis.fetch; await f("https://x.test"); }); }`)).toEqual(["fetch_reference"]);
    expect(kinds(`async function f(){ await withMemoryTransaction(pool, t, [s], async (client) => { const g = fetch; await g("https://x.test"); }); }`)).toEqual(["fetch_reference"]);
    expect(kinds(`async function f(){ await withMemoryTransaction(pool, t, [s], async (client) => { const g = financeFetch; await g("https://x.test"); }); }`)).toEqual(["fetch_reference"]);
    expect(kinds(`async function f(){ await withMemoryTransaction(pool, t, [s], async (client) => { await fetch("https://x.test"); await globalThis.fetch("https://y.test"); }); }`)).toEqual(["fetch", "fetch"]); // `globalThis.fetch(...)` er et direkte kall (ikke en referanse) og fanges som `fetch`
    expect(kinds(`async function f(){ const g = globalThis.fetch; await withMemoryTransaction(pool, t, [s], async (client) => { await client.query("SELECT 1"); }); await g("x"); }`)).toEqual([]); // utenfor transaksjon er lovlig
    expect(kinds(`async function f(){ await withMemoryTransaction(pool, t, [s], async (client) => { const o = { fetch: 1 }; await client.query("SELECT $1", [o.fetch === 1]); }); }`)).toEqual(["fetch_reference"]); // o.fetch (egenskapsoppslag) er leksikalsk lik globalThis.fetch: konservativt avvist
  });

  it("mønsteret fra `cancelVippsPayment` på main: credential-oppslag i `prepare` (under radlåsen) fanges; oppslag FØR providerCallOutsideLock fanges ikke", () => {
    expect(kinds(`class C { async cancel(){ return this.providerCallOutsideLock(t, s, { prepare: async (client) => { const current = await this.requireVippsPaymentIntent(client, t, id, true); const credentials = await this.vippsCredentialsProvider.getCredentials(t); return { kind: "call", plan: { credentials } }; }, call: () => 1, apply: async () => 1 }); } }`)).toEqual(["credential_lookup"]);
    expect(kinds(`class C { async cancel(){ const credentials = await this.vippsCredentialsProvider.getCredentials(t); return this.providerCallOutsideLock(t, s, { prepare: async (client) => { if (!credentials) throw new Error("x"); return { kind: "call", plan: { credentials } }; }, call: () => 1, apply: async () => 1 }); } }`)).toEqual([]);
  });

  it("`prepare:`/`apply:`/`onCallError:` til providerCallOutsideLock regnes som transaksjon; `call:` er unntatt", () => {
    expect(kinds(`this.providerCallOutsideLock(t, s, { prepare: async (client) => { await transport.createRefund({}); }, call: (plan) => plan.transport.createRefund({}), apply: async () => 1 });`)).toEqual(["provider_call"]);
    expect(kinds(`this.providerCallOutsideLock(t, s, { prepare: async (client) => ({ kind: "call" }), call: (plan) => plan.transport.createRefund({}), apply: async () => 1 });`)).toEqual([]);
    expect(kinds(`this.providerCallOutsideLock(t, s, { prepare: async () => 1, call: async () => 1, apply: async (client) => { await gw.getCard("x"); } });`)).toEqual(["provider_call"]);
    expect(kinds(`this.providerCallOutsideLock(t, s, { prepare: async () => 1, call: async () => 1, apply: async () => 1, onCallError: async (client) => { await this.getCredentials(); } });`)).toEqual(["credential_lookup"]);
  });

  it("det første lukkingsargumentet til submitPlan (selve leverandørkallet) er unntatt; ferdigstillingen (3. argument) er IKKE det", () => {
    expect(kinds(`async function f(){ await withMemoryTransaction(pool, t, [s], async (client) => { return this.submitPlan(true, () => transport.createPaymentIntent({}), async (client2, r) => 1); }); }`)).toEqual([]);
    expect(kinds(`async function f(){ await withMemoryTransaction(pool, t, [s], async (client) => { return this.submitPlan(true, () => transport.createPaymentIntent({}), async (client2, r) => { await transport.getPaymentIntent("x"); }); }); }`)).toEqual(["provider_call"]);
  });

  it("lovlig: oppslag og kall UTENFOR transaksjon, lokale tjenestemetoder og SQL i transaksjon, `this.submitPlan`-oppbygging", () => {
    expect(kinds(`class C { async f(){ const creds = await this.credentialsProvider.getCredentials(t); const gw = this.factory(creds); const p = await gw.getPayment("x"); return withMemoryTransaction(pool, t, [s], async (client) => { await client.query("SELECT 1"); return this.requireCard(client, t, "c"); }); } }`)).toEqual([]);
    expect(kinds(`class C { async f(){ return withMemoryTransaction(pool, t, [s], async (client) => { const flags = await this.appendAnomalyFlags(client, "x", "id", "1", []); const plan = this.submitPlan(false, async () => 1, async () => 2); return plan; }); } }`)).toEqual([]);
    expect(kinds(`// transport.createCard() i en kommentar\nconst s = "gw.createCard()"; withMemoryTransaction(pool, t, [s], async () => 1);`)).toEqual([]);
  });

  it("linjenummer og tekst oppgis i bruddet (til feilsøking)", () => {
    const v = scan(`\n\nasync function f(){\n  await withMemoryTransaction(pool, t, [s], async (client) => {\n    await transport.createCard({});\n  });\n}`);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ line: 5, kind: "provider_call" });
    expect(v[0]!.text).toContain("transport.createCard");
  });
});
