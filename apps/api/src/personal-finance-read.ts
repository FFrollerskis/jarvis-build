import type { BankAccount, BankAccountBalance, BankTransaction } from "@jarvis/finance";
import type { PersonalRouteContext } from "./personal-routes.ts";

/**
 * WP-G2 (D-464, UA-8 Personal Twin) P2f: PERSONLIG ØKONOMI-LESING. KUN lesing av eierens EGNE kontoer, saldoer og transaksjoner i `personal`-rommet (det private rommet), fra Jarvis' egne kanoniske banktabeller (`bank_*`, UA-6/D-111). Fasaden:
 *  - er en RUTE (`POST /personal/finance/read`), aldri et verktøy: finansdata er begrenset (SECRET_RESTRICTED, Q-64 strengeste regel) og kan dermed STRUKTURELT ikke nå en modell, en prompt eller en samtale (de eksisterende `finance_*`-verktøyene har
 *    kun valg-lås, ikke utførelseslås - Q-64 pkt 3/Q-66 - og utvides derfor ikke). Utdata leveres til eierens signerte enhet som en side/JSON.
 *  - gjør INGEN leverandørkall og har INGEN skrivevei: den bruker bare tre lese-metoder på `BankingService` (konstruert uten credentials), så BankID/PSD2-samtykket (opprettelse, SCA hos banken, utløp, tilbakekall) forblir i de eksisterende
 *    samtykke-verktøyene og kan aldri utløses herfra. Ingen betaling, ingen synkronisering, ingen avstemming.
 *  - krever eieren, enhetssignert økt (step-up) og et grant scopet til `personal` - aldri `business` (virksomhetens bankdata er et annet rom).
 *  - viser kun et minimalt, normalisert utvalg: ingen leverandør-id-er, ingen match-/avstemmingsdata. Fritekst fra banken (motpart, referanse, kontonavn) er UBETRODD data: kuttet og merket, aldri en instruks.
 */
export interface PersonalFinanceReadApi {
  listBankAccounts(tenantId: string, memorySpace: "personal", includeInactive?: boolean, limit?: number): Promise<BankAccount[]>;
  listBalances(tenantId: string, memorySpace: "personal", bankAccountId: string, limit?: number): Promise<BankAccountBalance[]>;
  listBankTransactions(tenantId: string, memorySpace: "personal", filter: { bank_account_id?: string; limit?: number }): Promise<BankTransaction[]>;
}

export interface PersonalFinanceDeps {
  banking: PersonalFinanceReadApi;
}

export const FINANCE_READ_VIEWS = ["accounts", "balances", "transactions"] as const;
type FinanceReadView = (typeof FINANCE_READ_VIEWS)[number];
export const FINANCE_READ_DEFAULT_LIMIT = 50;
export const FINANCE_READ_MAX_LIMIT = 200;
const TEXT_MAX = 140;

/** Felt som er fritekst fra banken/kunden: ubetrodd data, aldri en instruks. */
export const FINANCE_UNTRUSTED_TEXT_FIELDS = ["account_name", "counterparty_name", "reference_text"] as const;

const iso = (v: unknown): string | null => {
  const t = v instanceof Date ? v.getTime() : typeof v === "string" || typeof v === "number" ? Date.parse(String(v)) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
/** Fritekst fra banken: kontrolltegn (kode under 32 og DEL) blir mellomrom, og teksten kuttes. */
const text = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? Array.from(v).map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("").slice(0, TEXT_MAX) : null;
/** `bigint`-kolonner kommer som strenger fra pg: kun hele tall godtas (øre), alt annet er `null` (aldri en gjetning). */
const ore = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d{1,15}$/.test(v) ? Number(v) : Number.NaN;
  return Number.isSafeInteger(n) ? n : null;
};

export const shapeAccount = (a: BankAccount) => ({
  bank_account_id: a.bank_account_id, account_name: text(a.account_name), account_identifier_masked: text(a.account_identifier_masked), currency: a.currency, account_type: text(a.account_type), active: a.active === true, last_synced_at: iso(a.last_synced_at)
});
export const shapeBalance = (b: BankAccountBalance) => ({ balance_type: b.balance_type, amount_ore: ore(b.amount_ore), currency: b.currency, reference_date: iso(b.provider_reference_date), observed_at: iso(b.observed_at) });
export const shapeTransaction = (t: BankTransaction) => ({
  bank_transaction_id: t.bank_transaction_id, bank_account_id: t.bank_account_id, status: t.status, direction: t.direction, amount_ore: ore(t.amount_ore), currency: t.currency,
  booking_date: iso(t.booking_date), value_date: iso(t.value_date), counterparty_name: text(t.counterparty_name), reference_text: text(t.reference_text), bank_transaction_code: text(t.bank_transaction_code)
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** `true` = ruten er håndtert. Rekkefølge: grant -> EIER -> step-up (enhetssignert) -> personal-rom -> lesing. Ingenting leses før alle portene er passert. */
export async function handleFinanceRead(ctx: PersonalRouteContext, finance: PersonalFinanceDeps): Promise<boolean> {
  const authed = await ctx.authed(["view", "bank_account_id", "limit"]);
  if (!authed) return true;
  const { identity, body } = authed;
  if (!(await ctx.requireOwner(identity, { tool_id: "personal", action: "finance_read" }))) return true;
  const stepUp = ctx.stepUpDenial(identity, "personal_finance_read");
  if (stepUp) return ctx.json(403, { error: "step_up_required", reason: stepUp, request_id: ctx.requestId() }), true;
  if (identity.memory_space_id !== "personal") return ctx.json(403, { error: "finance_read_denied", reason: "personal_space_required", request_id: ctx.requestId() }), true;

  const view = ctx.fieldString(body, "view");
  if (!(FINANCE_READ_VIEWS as readonly string[]).includes(view)) return ctx.json(400, { error: "malformed_request", reason: "view", request_id: ctx.requestId() }), true;
  const accountId = ctx.fieldOptionalString(body, "bank_account_id");
  if (accountId !== undefined && !ID.test(accountId)) return ctx.json(400, { error: "malformed_request", reason: "bank_account_id", request_id: ctx.requestId() }), true;
  const requested = ctx.fieldOptionalNumber(body, "limit");
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > FINANCE_READ_MAX_LIMIT)) return ctx.json(400, { error: "malformed_request", reason: "limit", request_id: ctx.requestId() }), true;
  if ((view as FinanceReadView) === "balances" && accountId === undefined) return ctx.json(400, { error: "malformed_request", reason: "bank_account_id", request_id: ctx.requestId() }), true;
  const limit = requested ?? FINANCE_READ_DEFAULT_LIMIT;
  const envelope = { view, space: "personal", output_trust: "restricted_financial_data", untrusted_text_fields: FINANCE_UNTRUSTED_TEXT_FIELDS };

  try {
    const tenant = identity.tenant_id;
    if (view === "accounts") ctx.json(200, { ...envelope, accounts: (await finance.banking.listBankAccounts(tenant, "personal", false, limit)).map(shapeAccount) });
    else if (view === "balances") ctx.json(200, { ...envelope, bank_account_id: accountId, balances: (await finance.banking.listBalances(tenant, "personal", accountId as string, limit)).map(shapeBalance) });
    else ctx.json(200, { ...envelope, transactions: (await finance.banking.listBankTransactions(tenant, "personal", { ...(accountId !== undefined ? { bank_account_id: accountId } : {}), limit })).map(shapeTransaction) });
  } catch (err) {
    // Aldri feilmeldingen: en databasefeil kan sitere rader med beløp og motparter.
    ctx.domainFailure(500, "finance_read_failed", new Error(err instanceof Error ? err.name : "unknown"));
  }
  return true;
}
