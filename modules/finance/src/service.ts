import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { assertValidPaymentIntentTransition, isTerminalPaymentIntentState } from "./state-machine.ts";
import { FikenTransport, type FikenGeneralJournalEntryInput, type FikenJournalEntry } from "./fiken-transport.ts";
import {
  ACCOUNT_CODE_PATTERN,
  CURRENCY_PATTERN,
  FikenCredentialsUnavailableError,
  FinanceKillSwitchActiveError,
  InvalidAccountCodeError,
  InvalidAmountError,
  InvalidCurrencyError,
  MissingCounterAccountError,
  MissingVendorProviderRefError,
  PaymentIntentAlreadySubmittedError,
  PaymentIntentNotFoundError
} from "./types.ts";
import type {
  CreatePaymentIntentInput,
  FinanceKillSwitch,
  PaymentIntent,
  PaymentIntentEventType,
  PaymentIntentState
} from "./types.ts";

export interface FikenCredentials {
  refreshToken: string;
  companySlug: string;
}

/** Tenant-skopet credential-oppslag (SAMME `SecretProvider`-prinsipp som resten av kodebasen - IKKE en hardkodet global). */
export interface FikenCredentialsProvider {
  getCredentials(tenantId: string): Promise<FikenCredentials | null>;
}

export interface ListPaymentIntentsFilter {
  state?: PaymentIntentState;
  limit?: number;
}

/** Minimalt grensesnitt FinanceService faktisk trenger av en Fiken-transport - lar tester injisere en fake UTEN å røre `submitPaymentIntent()` sin deterministiske håndhevingsrekkefølge (kill switch/vendor-/motkonto-validering skjer FØR denne noensinne konstrueres/kalles). */
export interface FikenGeneralJournalEntryWriter {
  createGeneralJournalEntry(input: FikenGeneralJournalEntryInput): Promise<FikenJournalEntry>;
}

export type FikenTransportFactory = (credentials: FikenCredentials) => FikenGeneralJournalEntryWriter;

const defaultFikenTransportFactory: FikenTransportFactory = (credentials) => new FikenTransport(credentials.refreshToken, credentials.companySlug);

async function insertEvent(
  client: pg.PoolClient,
  tenantId: string,
  memorySpace: MemorySpace,
  input: { payment_intent_id: string; event_type: PaymentIntentEventType; summary: string; actor_person_id: string | null; metadata: Record<string, unknown> }
): Promise<void> {
  await client.query(
    `INSERT INTO payment_intent_events (event_id, tenant_id, memory_space_id, payment_intent_id, event_type, summary, actor_person_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [`fin-ev-${randomUUID()}`, tenantId, memorySpace, input.payment_intent_id, input.event_type, input.summary, input.actor_person_id, JSON.stringify(input.metadata)]
  );
}

/**
 * `finance_kill_switch` er tenant-skopet RLS, MEN IKKE space-skopet (se
 * toppkommentar i 038_finance.sql) - `withMemoryTransaction` (som krever et
 * `MemorySpace[]`-argument og setter `jarvis.memory_spaces`) passer derfor
 * IKKE. Denne hjelperen speiler SAMME `set_config('jarvis.tenant_id', ...)`-
 * mønster, uten space-settet, for de tre kill-switch-metodene alene.
 */
async function withTenantContext<T>(pool: pg.Pool, tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('jarvis.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function readForUpdate(client: pg.PoolClient, tenantId: string, paymentIntentId: string, forUpdate: boolean): Promise<PaymentIntent | null> {
  const { rows } = await client.query(
    `SELECT * FROM payment_intents WHERE tenant_id = $1 AND payment_intent_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, paymentIntentId]
  );
  return (rows[0] as PaymentIntent | undefined) ?? null;
}

/**
 * UA-6 Finance & Spend Integrity Gateway - FØRSTE slice (D-107):
 * kjerne-domenetjeneste for Payment/Spend Intent-lifecycle. Gjenbruker
 * `withMemoryTransaction` (SAMME RLS-primitiv som resten av Business OS/
 * Support/Contracts/Growth) - ingen ny sikkerhetsmodell. Klasse D-
 * håndhevelser (kill switch) er DETERMINISTISK KODE (CLAUDE.md regel 2),
 * ALDRI kun en promptregel.
 */
export class FinanceService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly fikenTransportFactory: FikenTransportFactory = defaultFikenTransportFactory
  ) {}

  private validateCreateInput(input: CreatePaymentIntentInput): void {
    if (!Number.isInteger(input.amount_ore) || input.amount_ore <= 0) throw new InvalidAmountError(input.amount_ore);
    const currency = input.currency ?? "NOK";
    if (!CURRENCY_PATTERN.test(currency)) throw new InvalidCurrencyError(currency);
    if (!ACCOUNT_CODE_PATTERN.test(input.account_code)) throw new InvalidAccountCodeError(input.account_code);
    if (input.counter_account_code !== undefined && !ACCOUNT_CODE_PATTERN.test(input.counter_account_code)) {
      throw new InvalidAccountCodeError(input.counter_account_code);
    }
  }

  /**
   * Idempotent opprettelse (akseptansekriterium 1, "Retry cannot
   * double-pay"): `ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
   * RETURNING` - ved konflikt hentes den EKSISTERENDE raden og returneres
   * uendret. En retry med SAMME `idempotency_key` oppretter ALDRI en ny
   * intent, uavhengig av hvor mange ganger kallet gjentas.
   */
  async createPaymentIntent(tenantId: string, memorySpace: MemorySpace, input: CreatePaymentIntentInput): Promise<PaymentIntent> {
    this.validateCreateInput(input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const anomalyFlags: string[] = [];
      if (!input.vendor_provider_ref) anomalyFlags.push("vendor_provider_ref_missing_at_creation");
      if (!input.counter_account_code) anomalyFlags.push("counter_account_code_missing_at_creation");

      const paymentIntentId = `fin-pi-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO payment_intents
           (payment_intent_id, tenant_id, memory_space_id, idempotency_key, purpose, amount_ore, currency,
            vendor_name, vendor_provider_ref, account_code, counter_account_code, owner_person_id, anomaly_flags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          paymentIntentId, tenantId, memorySpace, input.idempotency_key, input.purpose, input.amount_ore,
          input.currency ?? "NOK", input.vendor_name, input.vendor_provider_ref ?? null, input.account_code,
          input.counter_account_code ?? null, input.owner_person_id ?? null, JSON.stringify(anomalyFlags)
        ]
      );
      if (rows.length === 0) {
        const existing = await client.query(`SELECT * FROM payment_intents WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, input.idempotency_key]);
        return existing.rows[0] as PaymentIntent;
      }
      const intent = rows[0] as PaymentIntent;
      await insertEvent(client, tenantId, memorySpace, {
        payment_intent_id: intent.payment_intent_id, event_type: "intent_created",
        summary: `Betalingsintensjon opprettet: ${input.purpose} (${input.amount_ore} øre til ${input.vendor_name})`,
        actor_person_id: input.actor_person_id ?? null, metadata: { anomaly_flags: anomalyFlags }
      });
      if (anomalyFlags.length > 0) {
        await insertEvent(client, tenantId, memorySpace, {
          payment_intent_id: intent.payment_intent_id, event_type: "anomaly_flagged",
          summary: `Avvik registrert ved opprettelse: ${anomalyFlags.join(", ")}`,
          actor_person_id: input.actor_person_id ?? null, metadata: { anomaly_flags: anomalyFlags }
        });
      }
      return intent;
    });
  }

  async getPaymentIntent(tenantId: string, memorySpace: MemorySpace, paymentIntentId: string): Promise<PaymentIntent | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => readForUpdate(client, tenantId, paymentIntentId, false));
  }

  async listPaymentIntents(tenantId: string, memorySpace: MemorySpace, filter: ListPaymentIntentsFilter = {}): Promise<PaymentIntent[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const limit = Math.min(filter.limit ?? 50, 200);
      const { rows } = filter.state
        ? await client.query(`SELECT * FROM payment_intents WHERE tenant_id = $1 AND state = $2 ORDER BY created_at DESC LIMIT $3`, [tenantId, filter.state, limit])
        : await client.query(`SELECT * FROM payment_intents WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`, [tenantId, limit]);
      return rows as PaymentIntent[];
    });
  }

  /**
   * Sender intensjonen til Fiken. Fail-closed rekkefølge (viktigst FØRST):
   * (1) hent-og-lås raden, (2) idempotent no-op dersom allerede innsendt/
   * bekreftet/oppgjort (akseptansekriterium 1 - en retry poster ALDRI på
   * nytt mot Fiken), (3) kill switch-sjekk (akseptansekriterium 5 -
   * DETERMINISTISK KODE, CLAUDE.md regel 2), (4) deterministisk validering
   * av motkonto/vendor-referanse FØR noe providerkall (akseptansekriterium
   * 3 - Jarvis gjetter ALDRI en manglende Fiken-kontakt-/kontokode).
   */
  async submitPaymentIntent(tenantId: string, memorySpace: MemorySpace, paymentIntentId: string, credentialsProvider: FikenCredentialsProvider, actorPersonId?: string): Promise<PaymentIntent> {
    const outcome = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client): Promise<{ ok: true; intent: PaymentIntent } | { ok: false; error: FinanceKillSwitchActiveError }> => {
      const current = await readForUpdate(client, tenantId, paymentIntentId, true);
      if (!current) throw new PaymentIntentNotFoundError(paymentIntentId);

      if (current.state === "submitted" || current.state === "provider_acknowledged" || current.state === "settled") {
        return { ok: true, intent: current }; // idempotent no-op: ALDRI en ny provider-mutasjon for en allerede-innsendt intent.
      }
      if (isTerminalPaymentIntentState(current.state)) {
        throw new PaymentIntentAlreadySubmittedError(paymentIntentId, current.state);
      }

      const killSwitch = await client.query(`SELECT enabled FROM finance_kill_switch WHERE tenant_id = $1`, [tenantId]);
      if ((killSwitch.rows[0] as { enabled: boolean } | undefined)?.enabled === true) {
        // Skrevet via SAMME `client`/transaksjon (IKKE en nøstet, uavhengig
        // transaksjon - en tidligere versjon prøvde det og satt fast i en
        // ekte cross-connection FK-radlås: `payment_intent_events.payment_
        // intent_id`-FK-en krever en SHARE-lås på DENNE nøyaktige `payment_
        // intents`-raden, som allerede holdes EXCLUSIVE av `readForUpdate()`
        // sin `FOR UPDATE` over på DENNE samme transaksjonen - en ANNEN
        // tilkobling ville ventet for alltid). I stedet: skriv hendelsen på
        // `client`, la `withMemoryTransaction` COMMIT-e NORMALT (returner,
        // ikke kast), og kast feilen til kalleren ETTER at transaksjonen
        // allerede er commitet - hendelsen overlever uansett.
        await insertEvent(client, tenantId, memorySpace, {
          payment_intent_id: paymentIntentId, event_type: "kill_switch_blocked",
          summary: "Innsending blokkert: finans-nødbryter er aktivert", actor_person_id: actorPersonId ?? null, metadata: {}
        });
        return { ok: false, error: new FinanceKillSwitchActiveError(tenantId) };
      }

      if (!current.vendor_provider_ref) throw new MissingVendorProviderRefError(paymentIntentId);
      if (!current.counter_account_code) throw new MissingCounterAccountError(paymentIntentId);

      assertValidPaymentIntentTransition(current.state, "submitted");
      const credentials = await credentialsProvider.getCredentials(tenantId);
      if (!credentials) throw new FikenCredentialsUnavailableError(tenantId);

      // `amount_ore` er `bigint` i Postgres - `pg` returnerer bigint-kolonner
      // som JS-strenger (SAMME kjente egenskap som `spend_amount_ore` i
      // growth/service.ts sin `detectSpendAnomalies()`, ingen global
      // OID-20-typeparser registrert i @jarvis/core) - MÅ eksplisitt
      // `Number()`-castes her, ellers ville Fiken-linjene fått en streng-
      // verdi i `amount`-feltet.
      const amountOre = Number(current.amount_ore);
      const transport = this.fikenTransportFactory(credentials);
      const journalEntry = await transport.createGeneralJournalEntry({
        description: current.purpose,
        date: new Date().toISOString().slice(0, 10),
        lines: [
          { account: current.account_code, amount: amountOre },
          { account: current.counter_account_code, amount: -amountOre }
        ]
      });

      const { rows } = await client.query(
        `UPDATE payment_intents SET state = 'provider_acknowledged', provider_ref = $3, submitted_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND payment_intent_id = $2 RETURNING *`,
        [tenantId, paymentIntentId, String(journalEntry.journalEntryId)]
      );
      const updated = rows[0] as PaymentIntent;
      await insertEvent(client, tenantId, memorySpace, {
        payment_intent_id: paymentIntentId, event_type: "submitted",
        summary: `Sendt til Fiken - journalpost ${journalEntry.journalEntryId}`, actor_person_id: actorPersonId ?? null,
        metadata: { provider_ref: String(journalEntry.journalEntryId) }
      });
      await insertEvent(client, tenantId, memorySpace, {
        payment_intent_id: paymentIntentId, event_type: "provider_acknowledged",
        summary: "Fiken bekreftet journalposten", actor_person_id: actorPersonId ?? null, metadata: {}
      });
      return { ok: true, intent: updated };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.intent;
  }

  /** Eier/agent markerer en intensjon som endelig oppgjort (f.eks. etter manuell bankavstemming) - egen, eksplisitt handling, ALDRI auto-utledet. */
  async settlePaymentIntent(tenantId: string, memorySpace: MemorySpace, paymentIntentId: string, actorPersonId?: string): Promise<PaymentIntent> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await readForUpdate(client, tenantId, paymentIntentId, true);
      if (!current) throw new PaymentIntentNotFoundError(paymentIntentId);
      assertValidPaymentIntentTransition(current.state, "settled");
      const { rows } = await client.query(
        `UPDATE payment_intents SET state = 'settled', settled_at = now(), updated_at = now() WHERE tenant_id = $1 AND payment_intent_id = $2 RETURNING *`,
        [tenantId, paymentIntentId]
      );
      await insertEvent(client, tenantId, memorySpace, { payment_intent_id: paymentIntentId, event_type: "settled", summary: "Markert oppgjort", actor_person_id: actorPersonId ?? null, metadata: {} });
      return rows[0] as PaymentIntent;
    });
  }

  async cancelPaymentIntent(tenantId: string, memorySpace: MemorySpace, paymentIntentId: string, actorPersonId?: string): Promise<PaymentIntent> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await readForUpdate(client, tenantId, paymentIntentId, true);
      if (!current) throw new PaymentIntentNotFoundError(paymentIntentId);
      assertValidPaymentIntentTransition(current.state, "cancelled");
      const { rows } = await client.query(
        `UPDATE payment_intents SET state = 'cancelled', cancelled_at = now(), updated_at = now() WHERE tenant_id = $1 AND payment_intent_id = $2 RETURNING *`,
        [tenantId, paymentIntentId]
      );
      await insertEvent(client, tenantId, memorySpace, { payment_intent_id: paymentIntentId, event_type: "cancelled", summary: "Kansellert (aldri innsendt)", actor_person_id: actorPersonId ?? null, metadata: {} });
      return rows[0] as PaymentIntent;
    });
  }

  /**
   * Deterministisk avstemming (akseptansekriterium 2, "intent -> provider
   * request -> outcome -> accounting/reconciliation"). `matched=false`
   * setter `reconciliation_state='mismatched'` - `OpenLoopService.
   * detectPaymentAnomalies()` (modules/business, egen spørring mot DENNE
   * tabellen - ingen pakkeavhengighet) plukker den opp deterministisk.
   */
  async reconcilePaymentIntent(tenantId: string, memorySpace: MemorySpace, paymentIntentId: string, matched: boolean, actorPersonId?: string, note?: string): Promise<PaymentIntent> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await readForUpdate(client, tenantId, paymentIntentId, true);
      if (!current) throw new PaymentIntentNotFoundError(paymentIntentId);
      const reconciliationState = matched ? "matched" : "mismatched";
      const { rows } = await client.query(
        `UPDATE payment_intents SET reconciliation_state = $3, updated_at = now() WHERE tenant_id = $1 AND payment_intent_id = $2 RETURNING *`,
        [tenantId, paymentIntentId, reconciliationState]
      );
      await insertEvent(client, tenantId, memorySpace, {
        payment_intent_id: paymentIntentId, event_type: "reconciled",
        summary: `Avstemt: ${reconciliationState}${note ? ` - ${note}` : ""}`, actor_person_id: actorPersonId ?? null, metadata: { matched, note: note ?? null }
      });
      return rows[0] as PaymentIntent;
    });
  }

  /** Akseptansekriterium 5: eier-kontrollert, DETERMINISTISK håndhevet (CLAUDE.md regel 2) - ingen kunstig godkjenningssperre for eier (D-41). */
  async enableKillSwitch(tenantId: string, actorPersonId: string, reason: string): Promise<FinanceKillSwitch> {
    return withTenantContext(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO finance_kill_switch (tenant_id, enabled, enabled_by_person_id, enabled_at, reason, updated_at)
         VALUES ($1, true, $2, now(), $3, now())
         ON CONFLICT (tenant_id) DO UPDATE SET enabled = true, enabled_by_person_id = $2, enabled_at = now(), disabled_at = NULL, reason = $3, updated_at = now()
         RETURNING *`,
        [tenantId, actorPersonId, reason]
      );
      return rows[0] as FinanceKillSwitch;
    });
  }

  async disableKillSwitch(tenantId: string, actorPersonId: string): Promise<FinanceKillSwitch> {
    void actorPersonId; // sporet via payment_intent_events for individuelle blokkerte forsøk; selve bryter-tilstanden er ett rad per tenant (samme presedens som scheduler_state).
    return withTenantContext(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO finance_kill_switch (tenant_id, enabled, disabled_at, updated_at)
         VALUES ($1, false, now(), now())
         ON CONFLICT (tenant_id) DO UPDATE SET enabled = false, disabled_at = now(), updated_at = now()
         RETURNING *`,
        [tenantId]
      );
      return rows[0] as FinanceKillSwitch;
    });
  }

  async getKillSwitch(tenantId: string): Promise<FinanceKillSwitch | null> {
    return withTenantContext(this.pool, tenantId, async (client) => {
      const { rows } = await client.query(`SELECT * FROM finance_kill_switch WHERE tenant_id = $1`, [tenantId]);
      return (rows[0] as FinanceKillSwitch | undefined) ?? null;
    });
  }

  async listEvents(tenantId: string, memorySpace: MemorySpace, paymentIntentId: string): Promise<Array<Record<string, unknown>>> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM payment_intent_events WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY occurred_at DESC`, [tenantId, paymentIntentId]);
      return rows;
    });
  }
}
