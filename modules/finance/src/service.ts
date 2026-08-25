import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { assertValidPaymentIntentTransition, canTransitionPaymentIntent, isTerminalPaymentIntentState } from "./state-machine.ts";
import { FikenTransport, type FikenGeneralJournalEntryInput, type FikenJournalEntry } from "./fiken-transport.ts";
import { StripeTransport, type StripePaymentIntentObject, type StripeRefundObject } from "./stripe-transport.ts";
import { verifyStripeWebhookSignature, parseStripeEventEnvelope } from "./stripe-webhook.ts";
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
  PaymentIntentNotFoundError,
  StripeCredentialsUnavailableError,
  PaymentIntentNotStripeError,
  PaymentIntentNotSettledError,
  ExcessiveRefundAmountError,
  RefundAlreadySubmittedError,
  RefundNotFoundError,
  ProviderObjectTenantConflictError,
  InvalidWebhookSignatureError,
  StripeTenantNotConfiguredError,
  STRIPE_STATUS_TO_JARVIS_STATE,
  STRIPE_REFUND_STATUS_TO_STATE,
  STRIPE_REFUND_REASONS
} from "./types.ts";
import type {
  CreatePaymentIntentInput,
  CreateStripeRefundInput,
  FinanceKillSwitch,
  PaymentIntent,
  PaymentIntentEventType,
  PaymentIntentState,
  StripeAnomalyType,
  StripeProviderAnomalyDetectionResult,
  StripeRefund,
  StripeRefundReason,
  StripeRefundState,
  StripeWebhookEventRecord,
  StripeWebhookEventStatus
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

/** ÉTT globalt eier-tilkoblet Stripe-konto-credential (SAMME "single-owner, ikke multi-kunde-SaaS"-mønster som `FikenCredentials`/`JARVIS_GOOGLE_ADS_REFRESH_TOKEN`). */
export interface StripeCredentials {
  secretKey: string;
}

export interface StripeCredentialsProvider {
  getCredentials(tenantId: string): Promise<StripeCredentials | null>;
}

/** Minimalt grensesnitt FinanceService faktisk trenger av en Stripe-transport - SAMME "narrow injectable writer"-prinsipp som `FikenGeneralJournalEntryWriter`. */
export interface StripePaymentWriter {
  createPaymentIntent(input: { amountOre: number; currency: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<StripePaymentIntentObject>;
  getPaymentIntent(stripePaymentIntentId: string): Promise<StripePaymentIntentObject>;
  createRefund(input: { stripePaymentIntentId: string; amountOre: number; reason?: string; idempotencyKey: string }): Promise<StripeRefundObject>;
  getRefund(stripeRefundId: string): Promise<StripeRefundObject>;
}

export type StripeTransportFactory = (credentials: StripeCredentials) => StripePaymentWriter;

const defaultStripeTransportFactory: StripeTransportFactory = (credentials) => new StripeTransport(credentials.secretKey);

/**
 * Webhook-signeringshemmeligheten er IKKE tenant-parametrisert (ETT globalt
 * Stripe-konto denne sliceen, se toppkommentaren i `040_stripe.sql`) - en
 * enkel, synkron oppslagsfunksjon (samme sentinel-mønster som
 * `BusinessInternalSecretProvider`, IKKE et async `SecretProvider`-kall
 * for hvert innkommende webhook-kall).
 */
export type StripeWebhookSecretProvider = () => string | null;

/**
 * D-109 tenant/konto-mapping-grense (byggeordrens §12): ETT globalt Stripe-
 * konto denne sliceen tilhører NØYAKTIG ÉN eksplisitt konfigurert tenant -
 * ALDRI utledet fra webhook-nyttelastens egen metadata (Stripe sender uansett
 * intet tenant-konsept). Ekte multi-konto/multi-tenant Stripe (Stripe
 * Connect) er EKSPLISITT IKKE bygget - se 040_stripe.sql sin toppkommentar.
 */
export type StripeTenantResolver = () => string | null;

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
    private readonly fikenTransportFactory: FikenTransportFactory = defaultFikenTransportFactory,
    /**
     * D-109 (UA-6 Slice 3): alle fire er BEVISST konstruktørnivå (ikke
     * per-kall som `FikenCredentialsProvider`, se `submitPaymentIntent()`
     * sin kommentar for hvorfor) - satt ÉN gang i `apps/api/src/main.ts`/
     * `worker-main.ts`, identisk mønster for begge prosessene.
     */
    private readonly stripeCredentialsProvider: StripeCredentialsProvider = { getCredentials: async () => null },
    private readonly stripeTransportFactory: StripeTransportFactory = defaultStripeTransportFactory,
    private readonly stripeWebhookSecretProvider: StripeWebhookSecretProvider = () => null,
    private readonly stripeTenantResolver: StripeTenantResolver = () => null
  ) {}

  private validateCreateInput(input: CreatePaymentIntentInput): void {
    if (!Number.isInteger(input.amount_ore) || input.amount_ore <= 0) throw new InvalidAmountError(input.amount_ore);
    const currency = input.currency ?? "NOK";
    if (!CURRENCY_PATTERN.test(currency)) throw new InvalidCurrencyError(currency);
    // D-109: Fiken sitt strenge kontoformat (`NNNN`/`NNNN:NNNNN`) håndheves
    // KUN for provider='fiken' - SAMME betingelse som 040_stripe.sql sin
    // CHECK-constraint (applikasjonslaget og DB-en må være enige). Andre
    // providere krever fortsatt en IKKE-tom `account_code` (obligatorisk
    // intern bokføringskategori-tag), bare uten Fikens sifferformat.
    const isFiken = (input.provider ?? "fiken") === "fiken";
    if (isFiken) {
      if (!ACCOUNT_CODE_PATTERN.test(input.account_code)) throw new InvalidAccountCodeError(input.account_code);
      if (input.counter_account_code !== undefined && !ACCOUNT_CODE_PATTERN.test(input.counter_account_code)) {
        throw new InvalidAccountCodeError(input.counter_account_code);
      }
    } else if (input.account_code.trim().length === 0) {
      throw new InvalidAccountCodeError(input.account_code);
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
            vendor_name, vendor_provider_ref, account_code, counter_account_code, owner_person_id, anomaly_flags, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          paymentIntentId, tenantId, memorySpace, input.idempotency_key, input.purpose, input.amount_ore,
          input.currency ?? "NOK", input.vendor_name, input.vendor_provider_ref ?? null, input.account_code,
          input.counter_account_code ?? null, input.owner_person_id ?? null, JSON.stringify(anomalyFlags),
          // D-109: eksplisitt `provider` - `?? "fiken"` matcher DB-defaulten
          // byte-for-byte, så en kaller som aldri sender feltet (all
          // eksisterende Fiken-kode) får IDENTISK rad som FØR denne sliceen.
          input.provider ?? "fiken"
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
   * Sender intensjonen til leverandøren `current.provider` peker til
   * (Fiken ELLER Stripe - EN handling, provider-dispatchet internt, ALDRI
   * to konkurrerende `finance.*`/`finance_stripe.*`-handlinger for samme
   * konsept, D-109 §14). Fail-closed rekkefølge (viktigst FØRST, DELT av
   * BEGGE providere): (1) hent-og-lås raden, (2) idempotent no-op dersom
   * allerede innsendt/bekreftet/oppgjort (akseptansekriterium 1 - en retry
   * poster ALDRI på nytt mot noen leverandør), (3) kill switch-sjekk
   * (akseptansekriterium 5 - DETERMINISTISK KODE, CLAUDE.md regel 2,
   * gjelder BEGGE providere - D-109 §5 "existing finance kill switch must
   * block active execution"), (4) provider-spesifikk deterministisk
   * validering FØR noe providerkall.
   *
   * `credentialsProvider`-parameteren er BEVISST fortsatt Fiken-typet og
   * UENDRET i signatur (ingen eksisterende kallsted/test brutt) - Stripe
   * sitt credential-oppslag skjer via `this.stripeCredentialsProvider`
   * (konstruktørnivå, satt ÉN gang), IKKE denne parameteren, siden HVILKEN
   * leverandør som faktisk trengs først er kjent FØRST etter at raden er
   * lest (`current.provider`).
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

      assertValidPaymentIntentTransition(current.state, "submitted");

      if (current.provider === "stripe") {
        const credentials = await this.stripeCredentialsProvider.getCredentials(tenantId);
        if (!credentials) throw new StripeCredentialsUnavailableError(tenantId);
        const amountOre = Number(current.amount_ore);
        const transport = this.stripeTransportFactory(credentials);
        // Deterministisk idempotens-nøkkel avledet FRA payment_intent_id
        // (ALDRI random per forsøk) - byggeordrens §6 "exactly-once
        // economic effect": et nettverks-timeout FØR svaret ankommer
        // etterlater raden i sin FORRIGE (ikke-terminale) tilstand, så en
        // agent-/worker-retry kaller submitPaymentIntent() på nytt - MEN
        // parametrene (avledet UTELUKKENDE fra `current`, som ALDRI endres
        // etter opprettelse) er byte-for-byte identiske hver gang, så
        // Stripe sin EGEN idempotens-nøkkel-mekanisme (Idempotency-Key-
        // header) garanterer at et forsinket FØRSTE forsøk som FAKTISK
        // gikk gjennom hos Stripe returneres UENDRET i stedet for å
        // opprette et nytt PaymentIntent-objekt - to uavhengige idempotens-
        // lag (Jarvis sin egen DB-tilstandssjekk over + Stripe sin egen
        // server-side nøkkel-cache), ALDRI kun ett.
        const idempotencyKey = `stripe-submit:${paymentIntentId}`;
        // En IKKE-retrybar Stripe-feil (f.eks. autentisering/ugyldig
        // forespørsel) etterlater raden UENDRET (fortsatt draft, se
        // katch-frie propagering under - ingen state-mutasjon skjer FØR
        // dette kallet returnerer) - en korrigert retry er trygg. En
        // retrybar/nettverksfeil kaster likeledes UTEN å endre state -
        // NESTE forsøk gjenbruker SAMME idempotency-nøkkel over (se
        // kommentar over), ALDRI en blind ny økonomisk handling mot et
        // usikkert forrige utfall.
        const stripePaymentIntent: StripePaymentIntentObject = await transport.createPaymentIntent({
          amountOre, currency: current.currency,
          metadata: { jarvis_payment_intent_id: paymentIntentId, jarvis_tenant_id: tenantId },
          idempotencyKey
        });

        const { rows } = await client.query(
          `UPDATE payment_intents
             SET state = 'provider_acknowledged', provider_ref = $3, provider_status = $4,
                 provider_reported_amount_ore = $5, provider_reported_currency = $6,
                 provider_status_updated_at = now(), submitted_at = now(), updated_at = now()
           WHERE tenant_id = $1 AND payment_intent_id = $2 RETURNING *`,
          [tenantId, paymentIntentId, stripePaymentIntent.id, stripePaymentIntent.status, stripePaymentIntent.amount, stripePaymentIntent.currency.toUpperCase()]
        );
        const updated = rows[0] as PaymentIntent;
        await insertEvent(client, tenantId, memorySpace, {
          payment_intent_id: paymentIntentId, event_type: "submitted",
          summary: `Sendt til Stripe - PaymentIntent ${stripePaymentIntent.id} (status=${stripePaymentIntent.status})`,
          actor_person_id: actorPersonId ?? null, metadata: { provider_ref: stripePaymentIntent.id, provider_status: stripePaymentIntent.status }
        });
        await insertEvent(client, tenantId, memorySpace, {
          payment_intent_id: paymentIntentId, event_type: "provider_acknowledged",
          summary: "Stripe bekreftet opprettelsen av PaymentIntent-objektet", actor_person_id: actorPersonId ?? null, metadata: {}
        });
        return { ok: true, intent: updated };
      }

      // provider === "fiken" (uendret oppførsel, byte-for-byte identisk med FØR D-109).
      if (!current.vendor_provider_ref) throw new MissingVendorProviderRefError(paymentIntentId);
      if (!current.counter_account_code) throw new MissingCounterAccountError(paymentIntentId);

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

  // ======================================================================
  // D-109 (UA-6 Slice 3): Stripe payment outcome sync/webhooks/refunds/anomalies
  // ======================================================================

  /**
   * DEN ENE deterministiske domenestien for provider-tilstandsendring
   * (byggeordrens §7: "update canonical Finance state through one
   * deterministic domain path rather than multiple competing
   * implementations") - kalt av BÅDE `refreshStripePaymentState()`
   * (eksplisitt lesing) OG `ingestStripeWebhookEvent()` (hendelsesdrevet).
   * Ordens-vokter: `sourceEventEpochSeconds` sammenlignes mot allerede
   * lagret `provider_status_updated_at` - en ELDRE hendelse skriver ALDRI
   * over en NYERE allerede etablert tilstand (byggeordrens §7). Kaster
   * ALDRI - returnerer et diskriminert resultat slik at webhook-
   * innhentingen kan markere hendelsen `processed`/`failed_retryable`
   * uendret ved en konflikt i stedet for å krasje hele requesten.
   */
  private async applyStripePaymentOutcome(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    current: PaymentIntent,
    outcome: {
      stripeStatus: string;
      stripeAmountOre: number | null;
      stripeCurrency: string | null;
      sourceEventId: string | null;
      sourceEventEpochSeconds: number;
      /** `payment_intent.payment_failed` er en HENDELSE, ikke en egen `status`-verdi (Stripe har INGEN "failed"-status på selve objektet - se `types.ts`) - eksplisitt overstyring FØR statustabellen konsulteres. */
      forceJarvisState?: PaymentIntentState;
      lastPaymentErrorMessage?: string | null;
    },
    actorPersonId: string | null
  ): Promise<{ applied: true; intent: PaymentIntent } | { applied: false; reason: "stale_event" | "terminal_state_conflict"; intent: PaymentIntent }> {
    const sourceUpdatedAtMs = outcome.sourceEventEpochSeconds * 1000;
    if (current.provider_status_updated_at !== null) {
      // Stripe sitt `created`-felt (og dermed `sourceEventEpochSeconds`) er
      // KUN hele-sekunds-presisjon, mens `provider_status_updated_at` er en
      // `timestamptz` med millisekund-presisjon. Å sammenligne dem RÅTT
      // ville gjort en ekte, senere webhook-hendelse (levert innen SAMME
      // kalender-sekund som en forutgående lokal skriving - fullt normalt
      // ved lav nettverkslatens) feilaktig avvist som `stale_event` fordi
      // det avkortede sekund-tidsstempelet kan havne FØR det millisekund-
      // presise lagrede tidspunktet i samme sekund. Fix: avkort OGSÅ det
      // lagrede tidspunktet ned til nærmeste sekund FØR sammenligning - et
      // sekund er den mest presise ordenen Stripe sin egen `created`
      // faktisk kan uttrykke, så to hendelser i samme sekund behandles som
      // "like nye" (den siste vinner), ALDRI som at den nyeste er "for gammel".
      const storedFlooredToSecondMs = Math.floor(new Date(current.provider_status_updated_at).getTime() / 1000) * 1000;
      if (sourceUpdatedAtMs < storedFlooredToSecondMs) {
        return { applied: false, reason: "stale_event", intent: current }; // eldre hendelse - ALDRI la den overskrive en nyere allerede-lagret tilstand.
      }
    }

    const targetState = outcome.forceJarvisState ?? STRIPE_STATUS_TO_JARVIS_STATE[outcome.stripeStatus] ?? null;
    let stateChanges = "";
    const values: unknown[] = [tenantId, current.payment_intent_id, outcome.stripeStatus, outcome.stripeAmountOre, outcome.stripeCurrency, new Date(sourceUpdatedAtMs).toISOString(), outcome.sourceEventId];

    if (targetState !== null && targetState !== current.state) {
      if (!canTransitionPaymentIntent(current.state, targetState)) {
        // F.eks. en sen/duplisert hendelse som rapporterer "canceled" ETTER
        // at raden allerede er `settled` - fail-closed: FLAGG, ALDRI
        // overskriv en allerede etablert terminal-tilstand.
        await this.appendAnomalyFlags(client, "payment_intents", "payment_intent_id", current.payment_intent_id, ["WEBHOOK_STATE_CONFLICT"]);
        const { rows } = await client.query(`SELECT * FROM payment_intents WHERE tenant_id = $1 AND payment_intent_id = $2`, [tenantId, current.payment_intent_id]);
        return { applied: false, reason: "terminal_state_conflict", intent: rows[0] as PaymentIntent };
      }
      const timestampColumn = targetState === "settled" ? "settled_at" : targetState === "failed" ? "failed_at" : targetState === "cancelled" ? "cancelled_at" : null;
      stateChanges = `state = $8${timestampColumn ? `, ${timestampColumn} = now()` : ""}, `;
      values.push(targetState);
    }

    const { rows } = await client.query(
      `UPDATE payment_intents
         SET ${stateChanges}provider_status = $3, provider_reported_amount_ore = $4, provider_reported_currency = $5,
             provider_status_updated_at = $6, latest_stripe_event_id = $7,
             failure_reason = COALESCE($${values.length + 1}, failure_reason), updated_at = now()
       WHERE tenant_id = $1 AND payment_intent_id = $2 RETURNING *`,
      [...values, outcome.lastPaymentErrorMessage ?? null]
    );
    const updated = rows[0] as PaymentIntent;

    if (targetState !== null && targetState !== current.state) {
      const eventType: PaymentIntentEventType = targetState === "settled" ? "settled" : targetState === "failed" ? "failed" : "cancelled";
      await insertEvent(client, tenantId, memorySpace, {
        payment_intent_id: current.payment_intent_id, event_type: eventType,
        summary: `Stripe-utfall synkronisert: ${outcome.stripeStatus} -> ${targetState}${outcome.sourceEventId ? ` (hendelse ${outcome.sourceEventId})` : " (eksplisitt oppfrisking)"}`,
        actor_person_id: actorPersonId, metadata: { provider_status: outcome.stripeStatus, source_event_id: outcome.sourceEventId }
      });
    }
    return { applied: true, intent: updated };
  }

  private async appendAnomalyFlags(client: pg.PoolClient, table: "payment_intents" | "stripe_refunds", idColumn: string, id: string, flags: readonly StripeAnomalyType[]): Promise<void> {
    await client.query(
      `UPDATE ${table} SET anomaly_flags = (
         SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements_text(anomaly_flags || $2::jsonb) AS v
       ), updated_at = now() WHERE ${idColumn} = $1`,
      [id, JSON.stringify(flags)]
    );
  }

  private async requireStripePaymentIntent(client: pg.PoolClient, tenantId: string, paymentIntentId: string, forUpdate: boolean): Promise<PaymentIntent> {
    const current = await readForUpdate(client, tenantId, paymentIntentId, forUpdate);
    if (!current) throw new PaymentIntentNotFoundError(paymentIntentId);
    if (current.provider !== "stripe") throw new PaymentIntentNotStripeError(paymentIntentId, current.provider);
    return current;
  }

  /**
   * Eksplisitt oppfriskings-sti (byggeordrens §7 "explicit refresh/read
   * path") - leser Stripe sin GJELDENDE tilstand direkte (IKKE en
   * webhook-hendelse, derfor `sourceEventId=null`, tidsstempel = NÅ, som
   * naturlig alltid vinner over en eldre lagret webhook-tilstand).
   */
  async refreshStripePaymentState(tenantId: string, memorySpace: MemorySpace, paymentIntentId: string, actorPersonId?: string): Promise<PaymentIntent> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const current = await this.requireStripePaymentIntent(client, tenantId, paymentIntentId, true);
      if (!current.provider_ref) return current; // aldri innsendt ennå - intet å hente.
      const credentials = await this.stripeCredentialsProvider.getCredentials(tenantId);
      if (!credentials) throw new StripeCredentialsUnavailableError(tenantId);
      const transport = this.stripeTransportFactory(credentials);
      const stripePaymentIntent = await transport.getPaymentIntent(current.provider_ref);
      const result = await this.applyStripePaymentOutcome(
        client, tenantId, memorySpace, current,
        {
          stripeStatus: stripePaymentIntent.status, stripeAmountOre: stripePaymentIntent.amount, stripeCurrency: stripePaymentIntent.currency.toUpperCase(),
          sourceEventId: null,
          // `Math.ceil` (IKKE `Math.floor`) - `applyStripePaymentOutcome()`
          // sin ordens-vokter sammenligner denne (*1000, hele sekunder) mot
          // en `timestamptz`-kolonne med millisekund-presisjon. En eksplisitt
          // oppfrisking som skjer i SAMME kalender-sekund som en forutgående
          // `submitPaymentIntent()` (helt normalt under rask sekvensiell
          // kjøring - f.eks. rett etter innsending, eller i en testsuite)
          // ville med `floor` av og til blitt trunkert til et tidspunkt
          // FØR den allerede lagrede `provider_status_updated_at` (som har
          // sekundets millisekunder med), og dermed feilaktig avvist som
          // `stale_event`. `ceil` garanterer det beregnede tidsstempelet
          // ALLTID er >= det faktiske "nå" - og dermed >= ethvert tidligere
          // lagret tidsstempel - siden en eksplisitt oppfrisking (i
          // motsetning til en ekte Stripe-webhook-hendelse med sitt eget
          // historiske `created`-tidsstempel) pr. definisjon ALLTID skal
          // vinne over hva som helst lagret tidligere (se JSDoc over).
          sourceEventEpochSeconds: Math.ceil(Date.now() / 1000),
          lastPaymentErrorMessage: stripePaymentIntent.last_payment_error?.message?.slice(0, 500) ?? null
        },
        actorPersonId ?? null
      );
      return result.intent;
    });
  }

  /**
   * Webhook-innhentingsstien (byggeordrens §8). Rekkefølge: (1) verifiser
   * signatur FØR noe annet (rå kropp, IKKE JSON-parset ennå - `server.ts`
   * MÅ sende den rå Bufferen uendret), (2) parse ETT trygt utdrag (ALDRI
   * hele nyttelasten persistert), (3) sett inn i `stripe_webhook_events`
   * med `ON CONFLICT DO NOTHING` - DETTE ER hele dedup-/idempotens-
   * mekanismen for dupliserte hendelser (Stripe kan levere samme hendelse
   * flere ganger, byggeordrens §8 "duplicate-event suppression"), (4)
   * resolve tenant DETERMINISTISK fra konfigurert `stripeTenantResolver`
   * (ALDRI fra nyttelastens egen metadata - byggeordrens §12), (5) resolve
   * `payment_intents`-raden via `provider_ref` MED tenant-kryssjekk
   * (PROVIDER_OBJECT_TENANT_CONFLICT ved avvik, fail-closed), (6) anvend
   * utfallet via DEN SAMME `applyStripePaymentOutcome()` som eksplisitt
   * oppfrisking bruker.
   */
  async ingestStripeWebhookEvent(rawBody: Buffer, signatureHeader: string | undefined, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<{ status: StripeWebhookEventStatus | "duplicate" | "invalid_signature"; eventId?: string }> {
    const webhookSecret = this.stripeWebhookSecretProvider();
    if (!webhookSecret) throw new StripeCredentialsUnavailableError("(webhook-signeringshemmelighet ikke konfigurert)");
    const verification = verifyStripeWebhookSignature(rawBody, signatureHeader, webhookSecret, nowSeconds);
    if (!verification.valid) {
      throw new InvalidWebhookSignatureError(verification.reason ?? "unknown");
    }

    const stripeTenantId = this.stripeTenantResolver();
    if (!stripeTenantId) throw new StripeTenantNotConfiguredError();

    let envelope: ReturnType<typeof parseStripeEventEnvelope>;
    try {
      envelope = parseStripeEventEnvelope(rawBody);
    } catch {
      throw new Error("stripe_event_envelope_malformed");
    }

    // `withMemoryTransaction` (IKKE `withTenantContext`) - `payment_intents`/
    // `stripe_refunds`/`stripe_webhook_events` er ALLE space-skopet RLS
    // (RESTRICTIVE-policy mot `jarvis.memory_spaces`), som `withTenantContext`
    // ALDRI setter - ville stille returnert null rader for ETHVERT
    // `payment_intents`-oppslag. "business" er DEFAULT/eneste brukte space
    // for hele finance-domenet (SAMME konvensjon som `payment_intents.
    // memory_space_id DEFAULT 'business'`).
    return withMemoryTransaction(this.pool, stripeTenantId, ["business"], async (client) => {
      // ON CONFLICT DO NOTHING = HELE dedup-mekanismen (samme mønster som
      // `payment_intents.idempotency_key`) - `stripe_event_id` er Stripe
      // sin egen globalt unike hendelses-ID.
      const inserted = await client.query(
        `INSERT INTO stripe_webhook_events (stripe_event_id, tenant_id, memory_space_id, event_type, api_version, status, payload_summary, stripe_created_at)
         VALUES ($1, $2, 'business', $3, $4, 'received', $5, to_timestamp($6))
         ON CONFLICT (stripe_event_id) DO NOTHING
         RETURNING *`,
        [envelope.id, stripeTenantId, envelope.type, envelope.api_version, JSON.stringify({
          object_id: envelope.object_id, object_type: envelope.object_type, status: envelope.status,
          amount_ore: envelope.amount_ore, currency: envelope.currency
        }), envelope.created]
      );
      if (inserted.rows.length === 0) {
        return { status: "duplicate" as const, eventId: envelope.id };
      }

      await client.query(`UPDATE stripe_webhook_events SET status = 'verified' WHERE stripe_event_id = $1`, [envelope.id]);

      try {
        // charge.*/refund.*-hendelser peker til foreldre-PaymentIntent via
        // `payment_intent_ref`; payment_intent.*-hendelser peker til SEG
        // SELV (se `parseStripeEventEnvelope()`).
        const providerRef = envelope.payment_intent_ref;
        if (!providerRef) {
          await client.query(`UPDATE stripe_webhook_events SET status = 'unsupported', processed_at = now() WHERE stripe_event_id = $1`, [envelope.id]);
          return { status: "unsupported" as const, eventId: envelope.id };
        }

        const existing = await client.query(`SELECT * FROM payment_intents WHERE provider_ref = $1 AND provider = 'stripe' FOR UPDATE`, [providerRef]);
        const intentRow = existing.rows[0] as PaymentIntent | undefined;
        if (!intentRow) {
          // Ukjent objekt (f.eks. en test-hendelse mot et objekt Jarvis
          // aldri opprettet) - IKKE en feil å krasje på, men heller ikke
          // "processed" (ingenting ble faktisk anvendt).
          await client.query(`UPDATE stripe_webhook_events SET status = 'unsupported', processed_at = now() WHERE stripe_event_id = $1`, [envelope.id]);
          return { status: "unsupported" as const, eventId: envelope.id };
        }
        if (intentRow.tenant_id !== stripeTenantId) {
          // Fail-closed (byggeordrens §12) - flagg og NEKT å behandle,
          // ALDRI stille rute til feil tenant.
          await this.appendAnomalyFlags(client, "payment_intents", "payment_intent_id", intentRow.payment_intent_id, ["PROVIDER_OBJECT_TENANT_CONFLICT"]);
          await client.query(`UPDATE stripe_webhook_events SET status = 'failed_retryable', payment_intent_id = $2, error_message = $3, processed_at = now() WHERE stripe_event_id = $1`, [
            envelope.id, intentRow.payment_intent_id, new ProviderObjectTenantConflictError(providerRef, stripeTenantId, intentRow.tenant_id).message
          ]);
          return { status: "failed_retryable" as const, eventId: envelope.id };
        }

        const forceJarvisState: PaymentIntentState | undefined = envelope.type === "payment_intent.payment_failed" ? "failed" : undefined;
        await this.applyStripePaymentOutcome(
          client, intentRow.tenant_id, intentRow.memory_space_id as MemorySpace, intentRow,
          {
            stripeStatus: envelope.status ?? intentRow.provider_status ?? "", stripeAmountOre: envelope.amount_ore, stripeCurrency: envelope.currency,
            sourceEventId: envelope.id, sourceEventEpochSeconds: envelope.created,
            ...(forceJarvisState !== undefined ? { forceJarvisState } : {}),
            lastPaymentErrorMessage: envelope.last_payment_error_message
          },
          null
        );

        // Refusjons-hendelser (refund.*/charge.refunded) synker OGSÅ den
        // tilknyttede `stripe_refunds`-raden hvis en finnes for dette
        // objektet - SAMME ordens-vokter-prinsipp, egen liten sti (ikke
        // via applyStripePaymentOutcome, som er PaymentIntent-spesifikk).
        if (envelope.object_type === "refund" && envelope.object_id) {
          await this.applyStripeRefundOutcome(client, intentRow.tenant_id, intentRow.memory_space_id as MemorySpace, envelope.object_id, envelope.status, envelope.created);
        }

        await client.query(`UPDATE stripe_webhook_events SET status = 'processed', payment_intent_id = $2, processed_at = now() WHERE stripe_event_id = $1`, [envelope.id, intentRow.payment_intent_id]);
        return { status: "processed" as const, eventId: envelope.id };
      } catch (err) {
        await client.query(`UPDATE stripe_webhook_events SET status = 'failed_retryable', error_message = $2, processed_at = now() WHERE stripe_event_id = $1`, [envelope.id, (err as Error).message.slice(0, 500)]);
        return { status: "failed_retryable" as const, eventId: envelope.id };
      }
    });
  }

  // === Refunds (byggeordrens §9) ==========================================

  private validateRefundInput(input: CreateStripeRefundInput): void {
    if (!Number.isInteger(input.amount_ore) || input.amount_ore <= 0) throw new InvalidAmountError(input.amount_ore);
    if (input.reason !== undefined && !STRIPE_REFUND_REASONS.includes(input.reason as StripeRefundReason)) {
      throw new Error(`invalid_refund_reason:${input.reason}`);
    }
  }

  /**
   * Oppretter en draft-refusjon - INGEN Stripe-kall ennå (SAMME to-stegs
   * draft->submit-mønster som `createPaymentIntent`/`submitPaymentIntent`).
   * Forhindrer et for stort AGGREGERT refusjonsbeløp DETERMINISTISK FØR
   * raden i det hele tatt opprettes (byggeordrens §9 "prevent invalid
   * aggregate refund amount") - summerer alle IKKE-mislykkede/-kansellerte
   * refusjoner for samme intent, radlåst innenfor SAMME transaksjon som
   * selve INSERT-en (ingen TOCTOU-vindu).
   */
  async createStripeRefund(tenantId: string, memorySpace: MemorySpace, input: CreateStripeRefundInput): Promise<StripeRefund> {
    this.validateRefundInput(input);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const intent = await this.requireStripePaymentIntent(client, tenantId, input.payment_intent_id, true);
      if (intent.state !== "settled") throw new PaymentIntentNotSettledError(input.payment_intent_id, intent.state);

      const refundId = `fin-rf-${randomUUID()}`;
      const { rows: existingByKey } = await client.query(`SELECT * FROM stripe_refunds WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, input.idempotency_key]);
      if (existingByKey.length > 0) return existingByKey[0] as StripeRefund; // idempotent no-op - SAMME mønster som createPaymentIntent.

      // Postgres tillater IKKE `FOR UPDATE` sammen med en aggregatfunksjon
      // (`SUM`) - MEN TOCTOU-vinduet er allerede lukket av radlåsen
      // `requireStripePaymentIntent(..., forUpdate=true)` tok på selve
      // FORELDRE `payment_intents`-raden over: enhver SAMTIDIG
      // `createStripeRefund()`-kall mot SAMME `payment_intent_id` må
      // vente på DENNE transaksjonens commit/rollback FØR den i det hele
      // tatt når denne spørringen - ingen egen radlås trengs her.
      const { rows: aggregateRows } = await client.query(
        `SELECT COALESCE(SUM(amount_ore), 0)::bigint AS total FROM stripe_refunds
         WHERE tenant_id = $1 AND payment_intent_id = $2 AND state NOT IN ('failed', 'cancelled')`,
        [tenantId, input.payment_intent_id]
      );
      const alreadyRefundedOre = Number((aggregateRows[0] as { total: string }).total);
      const remainingOre = Number(intent.amount_ore) - alreadyRefundedOre;
      if (input.amount_ore > remainingOre) {
        throw new ExcessiveRefundAmountError(input.payment_intent_id, input.amount_ore, remainingOre);
      }

      const { rows } = await client.query(
        `INSERT INTO stripe_refunds (refund_id, tenant_id, memory_space_id, payment_intent_id, idempotency_key, amount_ore, currency, reason, owner_person_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [refundId, tenantId, memorySpace, input.payment_intent_id, input.idempotency_key, input.amount_ore, intent.currency, input.reason ?? null, input.owner_person_id ?? null]
      );
      if (rows.length === 0) {
        const existing = await client.query(`SELECT * FROM stripe_refunds WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, input.idempotency_key]);
        return existing.rows[0] as StripeRefund;
      }
      return rows[0] as StripeRefund;
    });
  }

  /**
   * Sender refusjonen til Stripe. SAMME fail-closed rekkefølge som
   * `submitPaymentIntent()` (idempotent no-op -> kill switch -> provider-
   * kall) - en refusjon ER en utgående økonomisk handling (byggeordrens §9
   * "finance kill switch treatment based on existing canonical policy for
   * outgoing economic actions"), derfor SAMME nødbryter-gate.
   */
  async submitStripeRefund(tenantId: string, memorySpace: MemorySpace, refundId: string, actorPersonId?: string): Promise<StripeRefund> {
    // Refusjonens EGEN audit-sti (byggeordrens §9 "audit trail") er raden
    // sin fulle, ALDRI-overskrevne tidsstempel-historikk (created_at/
    // submitted_at/settled_at/failed_at/cancelled_at + owner_person_id),
    // lest via `getStripeRefund()`/`listStripeRefunds()` - IKKE en egen
    // `payment_intent_events`-rad (den EKSISterende event_type-CHECK-en i
    // 038_finance.sql har INGEN "refund_*"-verdi, og å legge til én ville
    // vært en spekulativ skjemaendring uten en faktisk lesende forbruker
    // denne sliceen - D-41). `actorPersonId` er derfor BEVISST ikke brukt
    // her ennå (samme mønster som `disableKillSwitch()` sin `void
    // actorPersonId` over) - en fremtidig slice kan koble den til en
    // dedikert refusjons-hendelseslogg om behovet faktisk oppstår.
    void actorPersonId;
    const outcome = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client): Promise<{ ok: true; refund: StripeRefund } | { ok: false; error: FinanceKillSwitchActiveError }> => {
      const { rows: refundRows } = await client.query(`SELECT * FROM stripe_refunds WHERE tenant_id = $1 AND refund_id = $2 FOR UPDATE`, [tenantId, refundId]);
      const current = refundRows[0] as StripeRefund | undefined;
      if (!current) throw new RefundNotFoundError(refundId);

      if (current.state === "submitted" || current.state === "provider_acknowledged" || current.state === "settled") {
        return { ok: true, refund: current }; // idempotent no-op.
      }
      if (isTerminalPaymentIntentState(current.state)) {
        throw new RefundAlreadySubmittedError(refundId, current.state);
      }

      const killSwitch = await client.query(`SELECT enabled FROM finance_kill_switch WHERE tenant_id = $1`, [tenantId]);
      if ((killSwitch.rows[0] as { enabled: boolean } | undefined)?.enabled === true) {
        return { ok: false, error: new FinanceKillSwitchActiveError(tenantId) };
      }

      assertValidPaymentIntentTransition(current.state, "submitted");
      const intent = await this.requireStripePaymentIntent(client, tenantId, current.payment_intent_id, false);
      if (!intent.provider_ref) throw new PaymentIntentNotSettledError(current.payment_intent_id, intent.state);
      const credentials = await this.stripeCredentialsProvider.getCredentials(tenantId);
      if (!credentials) throw new StripeCredentialsUnavailableError(tenantId);
      const transport = this.stripeTransportFactory(credentials);

      const stripeRefund = await transport.createRefund({
        stripePaymentIntentId: intent.provider_ref, amountOre: current.amount_ore,
        ...(current.reason !== null ? { reason: current.reason } : {}),
        // Deterministisk avledet fra refund_id - SAMME dobbel-idempotens-
        // begrunnelse som `submitPaymentIntent()` sin Stripe-gren.
        idempotencyKey: `stripe-refund:${refundId}`
      });

      const targetState: StripeRefundState = STRIPE_REFUND_STATUS_TO_STATE[stripeRefund.status] ?? "provider_acknowledged";
      const timestampColumn = targetState === "settled" ? "settled_at" : targetState === "failed" ? "failed_at" : targetState === "cancelled" ? "cancelled_at" : null;
      const { rows } = await client.query(
        `UPDATE stripe_refunds SET state = $3, provider_ref = $4${timestampColumn ? `, ${timestampColumn} = now()` : ""}, submitted_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND refund_id = $2 RETURNING *`,
        [tenantId, refundId, targetState === current.state ? "provider_acknowledged" : targetState, stripeRefund.id]
      );
      return { ok: true, refund: rows[0] as StripeRefund };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.refund;
  }

  /** Kalt fra webhook-innhentingen for `refund.*`/`charge.refunded`-hendelser - SAMME ordens-/anti-tilbakegang-prinsipp, egen liten sti siden `stripe_refunds` er en egen tabell. */
  private async applyStripeRefundOutcome(client: pg.PoolClient, tenantId: string, memorySpace: MemorySpace, stripeRefundId: string, stripeStatus: string | null, sourceEventEpochSeconds: number): Promise<void> {
    if (!stripeStatus) return;
    const { rows } = await client.query(`SELECT * FROM stripe_refunds WHERE tenant_id = $1 AND provider_ref = $2 FOR UPDATE`, [tenantId, stripeRefundId]);
    const current = rows[0] as StripeRefund | undefined;
    if (!current) return; // ukjent refusjon for Jarvis - intet å synkronisere (samme "unsupported"-prinsipp som PaymentIntent-siden).
    void memorySpace; void sourceEventEpochSeconds;
    const targetState = STRIPE_REFUND_STATUS_TO_STATE[stripeStatus];
    if (targetState === undefined || targetState === null || targetState === current.state) return;
    if (!canTransitionPaymentIntent(current.state, targetState)) {
      await this.appendAnomalyFlags(client, "stripe_refunds", "refund_id", current.refund_id, ["WEBHOOK_STATE_CONFLICT"]);
      return;
    }
    const timestampColumn = targetState === "settled" ? "settled_at" : targetState === "failed" ? "failed_at" : targetState === "cancelled" ? "cancelled_at" : null;
    await client.query(
      `UPDATE stripe_refunds SET state = $3${timestampColumn ? `, ${timestampColumn} = now()` : ""}, updated_at = now() WHERE tenant_id = $1 AND refund_id = $2`,
      [tenantId, current.refund_id, targetState]
    );
  }

  async getStripeRefund(tenantId: string, memorySpace: MemorySpace, refundId: string): Promise<StripeRefund | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM stripe_refunds WHERE tenant_id = $1 AND refund_id = $2`, [tenantId, refundId]);
      return (rows[0] as StripeRefund | undefined) ?? null;
    });
  }

  async listStripeRefunds(tenantId: string, memorySpace: MemorySpace, paymentIntentId?: string, limit = 50): Promise<StripeRefund[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const cappedLimit = Math.min(limit, 200);
      const { rows } = paymentIntentId
        ? await client.query(`SELECT * FROM stripe_refunds WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY created_at DESC LIMIT $3`, [tenantId, paymentIntentId, cappedLimit])
        : await client.query(`SELECT * FROM stripe_refunds WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`, [tenantId, cappedLimit]);
      return rows as StripeRefund[];
    });
  }

  /** `withMemoryTransaction` (IKKE `withTenantContext`) - `stripe_webhook_events` er space-skopet RLS (SAMME begrunnelse som `ingestStripeWebhookEvent()`). */
  async getWebhookEvent(tenantId: string, stripeEventId: string): Promise<StripeWebhookEventRecord | null> {
    return withMemoryTransaction(this.pool, tenantId, ["business"], async (client) => {
      const { rows } = await client.query(`SELECT * FROM stripe_webhook_events WHERE tenant_id = $1 AND stripe_event_id = $2`, [tenantId, stripeEventId]);
      return (rows[0] as StripeWebhookEventRecord | undefined) ?? null;
    });
  }

  // === Deterministisk Stripe-avviksdeteksjon (byggeordrens §11) ==========

  /**
   * SAMME "full gjenberegning per kjøring, selv-korrigerende" mønster som
   * `SpendService.runAnomalyDetection()` - ALDRI AI-inferert (Q-26-
   * grensen), ren SQL. Skriver til DEN EKSISTERENDE `payment_intents.
   * anomaly_flags` (refusjonsavvik propagert opp til foreldre-intenten,
   * se `REFUND_AMOUNT_CONFLICT`-blokken) slik at DEN EKSISTERENDE
   * `detectPaymentAnomalies()`-overflatingen i @jarvis/business fanger det
   * uten noen ny OpenLoop-mekanisme.
   */
  async runProviderAnomalyDetection(tenantId: string, memorySpace: MemorySpace): Promise<StripeProviderAnomalyDetectionResult> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const candidateFlags = new Map<string, Set<StripeAnomalyType>>();
      const addFlag = (id: string, flag: StripeAnomalyType): void => {
        if (!candidateFlags.has(id)) candidateFlags.set(id, new Set());
        candidateFlags.get(id)!.add(flag);
      };

      // A) PROVIDER_AMOUNT_MISMATCH
      const amountMismatch = await client.query(
        `SELECT payment_intent_id FROM payment_intents
         WHERE tenant_id = $1 AND memory_space_id = $2 AND provider = 'stripe'
           AND provider_reported_amount_ore IS NOT NULL AND provider_reported_amount_ore != amount_ore`,
        [tenantId, memorySpace]
      );
      for (const row of amountMismatch.rows as Array<{ payment_intent_id: string }>) addFlag(row.payment_intent_id, "PROVIDER_AMOUNT_MISMATCH");

      // B) PROVIDER_CURRENCY_MISMATCH
      const currencyMismatch = await client.query(
        `SELECT payment_intent_id FROM payment_intents
         WHERE tenant_id = $1 AND memory_space_id = $2 AND provider = 'stripe'
           AND provider_reported_currency IS NOT NULL AND provider_reported_currency != currency`,
        [tenantId, memorySpace]
      );
      for (const row of currencyMismatch.rows as Array<{ payment_intent_id: string }>) addFlag(row.payment_intent_id, "PROVIDER_CURRENCY_MISMATCH");

      // C) PROVIDER_DUPLICATE_OBJECT_CONFLICT - to Jarvis-rader peker til SAMME Stripe-objekt (bør være strukturelt umulig, defensivt bevist likevel).
      const duplicateObject = await client.query(
        `SELECT payment_intent_id FROM payment_intents
         WHERE tenant_id = $1 AND memory_space_id = $2 AND provider = 'stripe' AND provider_ref IN (
           SELECT provider_ref FROM payment_intents WHERE tenant_id = $1 AND provider = 'stripe' AND provider_ref IS NOT NULL
           GROUP BY provider_ref HAVING count(*) > 1
         )`,
        [tenantId, memorySpace]
      );
      for (const row of duplicateObject.rows as Array<{ payment_intent_id: string }>) addFlag(row.payment_intent_id, "PROVIDER_DUPLICATE_OBJECT_CONFLICT");

      // D) UNKNOWN_PROVIDER_OUTCOME - Stripe anerkjente opprettelsen, men aldri nådd et avgjørende utfall innen et rimelig vindu (24t).
      const unknownOutcome = await client.query(
        `SELECT payment_intent_id FROM payment_intents
         WHERE tenant_id = $1 AND memory_space_id = $2 AND provider = 'stripe' AND state = 'provider_acknowledged'
           AND provider_status IN ('requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture')
           AND provider_status_updated_at < now() - interval '24 hours'`,
        [tenantId, memorySpace]
      );
      for (const row of unknownOutcome.rows as Array<{ payment_intent_id: string }>) addFlag(row.payment_intent_id, "UNKNOWN_PROVIDER_OUTCOME");

      // E) PROVIDER_OBJECT_TENANT_CONFLICT (defensivt - hovedvokteren er ingestStripeWebhookEvent() sin fail-closed sjekk; denne fanger det om det likevel skjedde via en annen vei).
      const configuredTenant = this.stripeTenantResolver();
      if (configuredTenant) {
        const tenantConflict = await client.query(
          `SELECT payment_intent_id FROM payment_intents WHERE tenant_id = $1 AND memory_space_id = $2 AND provider = 'stripe' AND tenant_id != $3`,
          [tenantId, memorySpace, configuredTenant]
        );
        for (const row of tenantConflict.rows as Array<{ payment_intent_id: string }>) addFlag(row.payment_intent_id, "PROVIDER_OBJECT_TENANT_CONFLICT");
      }

      // Re-evaluer allerede flaggede rader også (selv-korrigerende - en rad kan bli renere over tid, ikke bare skitnere).
      const alreadyFlagged = await client.query(
        `SELECT payment_intent_id FROM payment_intents WHERE tenant_id = $1 AND memory_space_id = $2 AND provider = 'stripe' AND jsonb_array_length(anomaly_flags) > 0`,
        [tenantId, memorySpace]
      );
      for (const row of alreadyFlagged.rows as Array<{ payment_intent_id: string }>) {
        if (!candidateFlags.has(row.payment_intent_id)) candidateFlags.set(row.payment_intent_id, new Set());
      }

      let paymentIntentFlagsAdded = 0;
      let flagsCleared = 0;
      for (const [paymentIntentId, flags] of candidateFlags) {
        const { rows } = await client.query(`SELECT anomaly_flags FROM payment_intents WHERE tenant_id = $1 AND payment_intent_id = $2`, [tenantId, paymentIntentId]);
        const before = new Set((rows[0]?.["anomaly_flags"] as string[] | undefined) ?? []);
        const stripeFlagTypes: readonly StripeAnomalyType[] = [
          "PROVIDER_AMOUNT_MISMATCH", "PROVIDER_CURRENCY_MISMATCH", "PROVIDER_DUPLICATE_OBJECT_CONFLICT",
          "UNKNOWN_PROVIDER_OUTCOME", "PROVIDER_OBJECT_TENANT_CONFLICT"
        ]; // WEBHOOK_STATE_CONFLICT/REFUND_AMOUNT_CONFLICT håndteres ved kilden (applyStripePaymentOutcome/refund-blokken under) - ALDRI overskrevet av denne full-rewrite-sveipen.
        const preserved = [...before].filter((f) => !stripeFlagTypes.includes(f as StripeAnomalyType));
        const next = new Set([...preserved, ...flags]);
        if (next.size < before.size) flagsCleared++;
        if (next.size > before.size) paymentIntentFlagsAdded++;
        await client.query(`UPDATE payment_intents SET anomaly_flags = $2::jsonb, updated_at = now() WHERE tenant_id = $1 AND payment_intent_id = $3`, [tenantId, JSON.stringify([...next]), paymentIntentId]);
      }

      // F) REFUND_AMOUNT_CONFLICT - defensiv (applikasjonslaget forhindrer dette allerede ved opprettelse) - propageres opp til foreldre-intenten.
      const refundConflicts = await client.query(
        `SELECT sr.payment_intent_id, array_agg(sr.refund_id) AS refund_ids FROM stripe_refunds sr
         JOIN payment_intents pi ON pi.tenant_id = sr.tenant_id AND pi.payment_intent_id = sr.payment_intent_id
         WHERE sr.tenant_id = $1 AND sr.memory_space_id = $2 AND sr.state NOT IN ('failed', 'cancelled')
         GROUP BY sr.payment_intent_id, pi.amount_ore HAVING SUM(sr.amount_ore) > pi.amount_ore`,
        [tenantId, memorySpace]
      );
      let refundFlagsAdded = 0;
      for (const row of refundConflicts.rows as Array<{ payment_intent_id: string; refund_ids: string[] }>) {
        await this.appendAnomalyFlags(client, "payment_intents", "payment_intent_id", row.payment_intent_id, ["REFUND_AMOUNT_CONFLICT"]);
        for (const refundId of row.refund_ids) {
          await this.appendAnomalyFlags(client, "stripe_refunds", "refund_id", refundId, ["REFUND_AMOUNT_CONFLICT"]);
        }
        refundFlagsAdded++;
      }

      return { payment_intent_flags_added: paymentIntentFlagsAdded, refund_flags_added: refundFlagsAdded, flags_cleared: flagsCleared };
    });
  }

  /**
   * Worker-sveip (byggeordrens §15): synker alle ikke-terminale Stripe-
   * `payment_intents` for en tenant. Retry-/krasj-trygg (hver
   * `refreshStripePaymentState()`-kjøring er sin egen transaksjon,
   * feil på ÉN rad velter ALDRI resten - samme feilisolasjons-prinsipp som
   * `runFullSweep()`/`syncTenant()`-mønstrene ellers i workspacet).
   */
  async syncPendingStripePayments(tenantId: string, memorySpace: MemorySpace): Promise<{ synced: number; failed: number }> {
    const pending = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT payment_intent_id FROM payment_intents WHERE tenant_id = $1 AND memory_space_id = $2 AND provider = 'stripe' AND state = 'provider_acknowledged'`,
        [tenantId, memorySpace]
      );
      return (rows as Array<{ payment_intent_id: string }>).map((r) => r.payment_intent_id);
    });
    let synced = 0;
    let failed = 0;
    for (const paymentIntentId of pending) {
      try {
        await this.refreshStripePaymentState(tenantId, memorySpace, paymentIntentId);
        synced++;
      } catch {
        failed++;
      }
    }
    return { synced, failed };
  }
}
