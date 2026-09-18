import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withMemoryTransaction } from "@jarvis/memory";
import type { MemorySpace } from "@jarvis/contracts";
import { WallesterApiError, WallesterTransport, type WallesterGateway, type WallesterCardLimitsInput, type WallesterAccountBalance, type WallesterBusinessJwtSigner } from "./wallester-transport.ts";
import { parseWallesterEventEnvelope, verifyWallesterWebhookBasicAuth, WallesterEventEnvelopeError, type WallesterEventEnvelope } from "./wallester-webhook.ts";
import {
  CardInvalidStateError,
  CardNotFoundError,
  CardNotSubmittedError,
  WallesterCredentialsUnavailableError,
  WallesterTenantNotConfiguredError,
  isValidCardTransition,
  mapWallesterCardState,
  type CardAuthorization,
  type CardSpendPolicy,
  type CardState,
  type CardTransaction,
  type CardType,
  type ProviderCard
} from "./card-types.ts";
import { FinanceKillSwitchActiveError, InvalidWebhookSignatureError } from "./types.ts";

/**
 * UA-6 Slice 6 (D-112): kanonisk programmerbar kort-domenetjeneste
 * (Wallester-adapteret). Egen klasse ved siden av FinanceService/
 * SpendService/BankingService - SAMME oppdelingspresedens som Slice 2/5:
 * kortdomenet er et eget deldomene med egen livssyklus, IKKE nok en
 * betalingsleverandør-gren i payment_intents (kort er TREKK-basert spend
 * hos brukersteder, ikke Jarvis-initierte push-betalinger).
 *
 * Nødbryter-semantikk (byggeordrens §11): `finance_kill_switch` (038,
 * UENDRET) blokkerer de AKTIVE spend-muliggjørende handlingene -
 * provider-innsending av nytt kort, avfrysing og grense-ØKNINGER - men
 * ALDRI passiv transaksjons-ingestion/avstemming/avviksdeteksjon/
 * tilstandssynk/audit. Frys/lukking (spend-REDUSERENDE) er alltid tillatt.
 *
 * Sanntidsautorisasjon (§10): `UNVERIFIED_PRODUCT_ENTITLEMENT` for det
 * valgte Wallester-programmet (korrigert D-113 - IKKE `NOT_APPLICABLE`).
 * Wallester-webhooks OBSERVERT som varsler om beslutninger WALLESTER
 * allerede har fattet mot provider-anvendte grenser/kontroller - men
 * INGEN tilgjengelig kilde (primær eller sekundær) bekreftet ELLER
 * avkreftet en synkron decision-request-kapabilitet for dette programmet.
 * Ikke implementert mot en gjettet kontrakt for en direkte finansiell
 * autorisasjonsbeslutning (D-41 anti-gjetting). Jarvis uttrykker policy
 * GJENNOM de provider-anvendte grensene + frys inntil videre - se D-113.
 */

/** Deterministiske konstanter - dokumentert, aldri skjult-tilfeldige. */
export const CARD_UNMATCHED_FLAG_AGE_DAYS = 3;

/**
 * Owner-provided primary-source-audit (PR #62, runde 4): Wallester Business
 * sin autentiseringskontrakt bruker api_key/ts JWT-claims signert med RS256
 * - IKKE issuer/audience/sub/exp/rbh (D-113-modellen gjaldt Wallester Card
 * API, en ANNEN produkt-grense - se wallester-transport.ts filhode).
 * Signeringsmekanismen (`sign`) er injiserbar med hensikt: selve
 * nøkkelanskaffelsen (BUSINESS_AUTH_SIGNING_MATERIAL) er
 * PRIMARY_SOURCE_PUBLIC_DOC_GAP - ALDRI gjettet her.
 */
export interface WallesterCredentials {
  baseUrl: string;
  apiKey: string;
  sign: WallesterBusinessJwtSigner;
  accountId: string;
  environment: "sandbox" | "production";
}

export interface WallesterCredentialsProvider {
  getCredentials(tenantId: string): Promise<WallesterCredentials | null>;
}

export type WallesterGatewayFactory = (credentials: WallesterCredentials) => WallesterGateway;

export const defaultWallesterGatewayFactory: WallesterGatewayFactory = (c) =>
  new WallesterTransport(c.baseUrl, c.apiKey, c.sign, c.accountId);

/** Webhook-Basic-credential (kunde-konfigurert hos Wallester) - `null` = webhook ikke konfigurert (fail-closed). */
export type WallesterWebhookBasicAuthProvider = () => { username: string; password: string } | null;
/** Enkelt-global-konto-mønsteret (SAMME som Stripe/Vipps/Neonomics): hvilken tenant provider-kontoen tilhører. */
export type WallesterTenantResolver = () => string | null;

export interface CreateCardInput {
  idempotency_key: string;
  name: string;
  purpose: string;
  card_type: CardType;
  currency?: string;
  cardholder_person_id?: string;
  commitment_id?: string;
  campaign_id?: string;
  vendor_name?: string;
  requested_transaction_limit_ore?: number;
  requested_daily_limit_ore?: number;
  requested_weekly_limit_ore?: number;
  requested_monthly_limit_ore?: number;
  requested_atm_enabled?: boolean;
  requested_online_enabled?: boolean;
  requested_contactless_enabled?: boolean;
}

export interface UpdateSpendPolicyInput {
  requested_transaction_limit_ore?: number | null;
  requested_daily_limit_ore?: number | null;
  requested_weekly_limit_ore?: number | null;
  requested_monthly_limit_ore?: number | null;
  requested_atm_enabled?: boolean;
  requested_online_enabled?: boolean;
  requested_contactless_enabled?: boolean;
}

function rowToCard(row: Record<string, unknown>): ProviderCard {
  return { ...(row as unknown as ProviderCard), anomaly_flags: (row["anomaly_flags"] as string[] | null) ?? [] };
}

function rowToPolicy(row: Record<string, unknown>): CardSpendPolicy {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    ...(row as unknown as CardSpendPolicy),
    requested_transaction_limit_ore: num(row["requested_transaction_limit_ore"]),
    requested_daily_limit_ore: num(row["requested_daily_limit_ore"]),
    requested_weekly_limit_ore: num(row["requested_weekly_limit_ore"]),
    requested_monthly_limit_ore: num(row["requested_monthly_limit_ore"]),
    applied_transaction_limit_ore: num(row["applied_transaction_limit_ore"]),
    applied_daily_limit_ore: num(row["applied_daily_limit_ore"]),
    applied_weekly_limit_ore: num(row["applied_weekly_limit_ore"]),
    applied_monthly_limit_ore: num(row["applied_monthly_limit_ore"])
  };
}

export class CardService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly credentialsProvider: WallesterCredentialsProvider = { getCredentials: async () => null },
    private readonly gatewayFactory: WallesterGatewayFactory = defaultWallesterGatewayFactory,
    private readonly webhookAuthProvider: WallesterWebhookBasicAuthProvider = () => null,
    private readonly tenantResolver: WallesterTenantResolver = () => null
  ) {}

  private async gateway(tenantId: string): Promise<WallesterGateway> {
    const credentials = await this.credentialsProvider.getCredentials(tenantId);
    if (!credentials) throw new WallesterCredentialsUnavailableError(tenantId);
    return this.gatewayFactory(credentials);
  }

  /** Håndhevet i DETERMINISTISK kode i samme transaksjon som handlingen (CLAUDE.md regel 2) - aldri kun promptregler. */
  private async assertKillSwitchInactive(client: pg.PoolClient, tenantId: string): Promise<void> {
    const { rows } = await client.query(`SELECT enabled FROM finance_kill_switch WHERE tenant_id = $1`, [tenantId]);
    if ((rows[0] as { enabled: boolean } | undefined)?.enabled) throw new FinanceKillSwitchActiveError(tenantId);
  }

  private async logCardEvent(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    cardId: string,
    eventType: string,
    detail: Record<string, unknown> = {},
    actorPersonId?: string
  ): Promise<void> {
    await client.query(
      `INSERT INTO card_events (card_event_id, tenant_id, memory_space_id, card_id, event_type, actor_person_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [`cev-${randomUUID()}`, tenantId, memorySpace, cardId, eventType, actorPersonId ?? null, JSON.stringify(detail)]
    );
  }

  private async requireCard(client: pg.PoolClient, tenantId: string, cardId: string, forUpdate = false): Promise<ProviderCard> {
    const { rows } = await client.query(`SELECT * FROM provider_cards WHERE tenant_id = $1 AND card_id = $2${forUpdate ? " FOR UPDATE" : ""}`, [tenantId, cardId]);
    if (rows.length === 0) throw new CardNotFoundError(cardId);
    return rowToCard(rows[0] as Record<string, unknown>);
  }

  // === Kortopprettelse (byggeordrens §5) ==================================

  /**
   * Lokal kanonisk opprettelse (draft) + policy-rad - deterministisk
   * idempotent på (tenant, idempotency_key): retry returnerer SAMME
   * kanoniske kort, aldri et duplikat. INGEN provider-kall her -
   * `submitCard()` er den spend-muliggjørende (kill-switch-gatede)
   * provider-innsendingen.
   */
  async createCard(tenantId: string, memorySpace: MemorySpace, input: CreateCardInput, actorPersonId?: string): Promise<ProviderCard> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const existing = await client.query(`SELECT * FROM provider_cards WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, input.idempotency_key]);
      if (existing.rows.length > 0) return rowToCard(existing.rows[0] as Record<string, unknown>);
      const cardId = `card-${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO provider_cards (card_id, tenant_id, memory_space_id, idempotency_key, name, purpose, card_type, currency, cardholder_person_id, commitment_id, campaign_id, vendor_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING *`,
        [
          cardId, tenantId, memorySpace, input.idempotency_key, input.name, input.purpose, input.card_type,
          (input.currency ?? "EUR").toUpperCase(), input.cardholder_person_id ?? null,
          input.commitment_id ?? null, input.campaign_id ?? null, input.vendor_name ?? null
        ]
      );
      if (rows.length === 0) {
        const raced = await client.query(`SELECT * FROM provider_cards WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, input.idempotency_key]);
        return rowToCard(raced.rows[0] as Record<string, unknown>);
      }
      await client.query(
        `INSERT INTO card_spend_policies (policy_id, tenant_id, memory_space_id, card_id,
           requested_transaction_limit_ore, requested_daily_limit_ore, requested_weekly_limit_ore, requested_monthly_limit_ore,
           requested_atm_enabled, requested_online_enabled, requested_contactless_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          `cpol-${randomUUID()}`, tenantId, memorySpace, cardId,
          input.requested_transaction_limit_ore ?? null, input.requested_daily_limit_ore ?? null,
          input.requested_weekly_limit_ore ?? null, input.requested_monthly_limit_ore ?? null,
          input.requested_atm_enabled ?? false, input.requested_online_enabled ?? true, input.requested_contactless_enabled ?? true
        ]
      );
      await this.logCardEvent(client, tenantId, memorySpace, cardId, "requested", { card_type: input.card_type, purpose: input.purpose }, actorPersonId);
      return rowToCard(rows[0] as Record<string, unknown>);
    });
  }

  /**
   * Provider-innsending (spend-muliggjørende -> kill-switch-gated, §11).
   * Idempotent: allerede innsendt kort (provider_card_id satt) returneres
   * uendret UTEN nytt provider-kall - retry kan ALDRI skape duplikatkort
   * (§5); kanonisk card_id sendes som ekstern referanse slik at et
   * usikkert utfall kan gjenfinnes hos provider. En provider-feil
   * etterlater kortet i draft (kanonisk tilstand endres ALDRI av en feil).
   */
  async submitCard(tenantId: string, memorySpace: MemorySpace, cardId: string, actorPersonId?: string): Promise<ProviderCard> {
    const prepared = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const card = await this.requireCard(client, tenantId, cardId, true);
      if (card.provider_card_id !== null) return { card, policy: null, submit: false };
      if (card.state !== "draft") throw new CardInvalidStateError(cardId, card.state, "pending_provider");
      await this.assertKillSwitchInactive(client, tenantId);
      const { rows } = await client.query(`SELECT * FROM card_spend_policies WHERE tenant_id = $1 AND card_id = $2`, [tenantId, cardId]);
      return { card, policy: rows.length > 0 ? rowToPolicy(rows[0] as Record<string, unknown>) : null, submit: true };
    });
    if (!prepared.submit) return prepared.card;

    const gw = await this.gateway(tenantId);
    const providerCard = await gw.createCard({
      externalReference: cardId,
      name: prepared.card.name,
      type: prepared.card.card_type,
      currency: prepared.card.currency,
      cardholderName: null,
      limits: this.policyToLimits(prepared.policy)
    });

    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const mapped = mapWallesterCardState(providerCard.status);
      const nextState: CardState = mapped === "active" ? "active" : "pending_provider";
      const { rows } = await client.query(
        `UPDATE provider_cards SET provider_card_id = $3, provider_account_id = $4, provider_state = $5, masked_card_number = $6,
           wallet_tokenization_status = $7, state = $8, submitted_at = now(), activated_at = CASE WHEN $8 = 'active' THEN now() ELSE activated_at END,
           last_synced_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND card_id = $2 RETURNING *`,
        [tenantId, cardId, providerCard.id, providerCard.accountId, providerCard.status, providerCard.maskedCardNumber, providerCard.tokenizationStatus, nextState]
      );
      await this.logCardEvent(client, tenantId, memorySpace, cardId, "submitted", { provider_card_id: providerCard.id, provider_state: providerCard.status }, actorPersonId);
      return rowToCard(rows[0] as Record<string, unknown>);
    });
  }

  private policyToLimits(policy: CardSpendPolicy | null): WallesterCardLimitsInput {
    return {
      transactionLimitOre: policy?.requested_transaction_limit_ore ?? null,
      dailyLimitOre: policy?.requested_daily_limit_ore ?? null,
      weeklyLimitOre: policy?.requested_weekly_limit_ore ?? null,
      monthlyLimitOre: policy?.requested_monthly_limit_ore ?? null,
      atmEnabled: policy?.requested_atm_enabled ?? false,
      onlineEnabled: policy?.requested_online_enabled ?? true,
      contactlessEnabled: policy?.requested_contactless_enabled ?? true
    };
  }

  // === Kortlivssyklus (byggeordrens §6) ===================================

  private async lifecycleAction(
    tenantId: string,
    memorySpace: MemorySpace,
    cardId: string,
    target: CardState,
    eventType: "activated" | "frozen" | "unfrozen" | "closed",
    providerCall: (gw: WallesterGateway, providerCardId: string) => Promise<{ status: string }>,
    opts: { killSwitchGated?: boolean } = {},
    actorPersonId?: string
  ): Promise<ProviderCard> {
    const prepared = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const card = await this.requireCard(client, tenantId, cardId, true);
      if (card.state === target) return { card, act: false };
      if (card.provider_card_id === null) throw new CardNotSubmittedError(cardId);
      if (!isValidCardTransition(card.state, target)) throw new CardInvalidStateError(cardId, card.state, target);
      if (opts.killSwitchGated) await this.assertKillSwitchInactive(client, tenantId);
      return { card, act: true };
    });
    if (!prepared.act) return prepared.card;

    const gw = await this.gateway(tenantId);
    // Provider-kallet skjer FØR kanonisk overgang - en provider-feil
    // propagerer og etterlater kanonisk tilstand URØRT (§6).
    const providerResult = await providerCall(gw, prepared.card.provider_card_id!);

    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const timestampColumn = target === "active" ? "activated_at" : target === "frozen" ? "frozen_at" : "closed_at";
      const { rows } = await client.query(
        `UPDATE provider_cards SET state = $3, provider_state = $4, ${timestampColumn} = now(), last_synced_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND card_id = $2 RETURNING *`,
        [tenantId, cardId, target, providerResult.status]
      );
      await this.logCardEvent(client, tenantId, memorySpace, cardId, eventType, { provider_state: providerResult.status }, actorPersonId);
      return rowToCard(rows[0] as Record<string, unknown>);
    });
  }

  /** Aktivering RE-muliggjør spend -> kill-switch-gated (§11, D-174 rettet - se D-174). */
  async activateCard(tenantId: string, memorySpace: MemorySpace, cardId: string, actorPersonId?: string): Promise<ProviderCard> {
    return this.lifecycleAction(
      tenantId,
      memorySpace,
      cardId,
      "active",
      "activated",
      (gw, id) => gw.activateCard(id),
      { killSwitchGated: true },
      actorPersonId
    );
  }

  /** Frys er spend-REDUSERENDE - alltid tillatt, også under nødbryter (§11). */
  async freezeCard(tenantId: string, memorySpace: MemorySpace, cardId: string, actorPersonId?: string): Promise<ProviderCard> {
    return this.lifecycleAction(tenantId, memorySpace, cardId, "frozen", "frozen", (gw, id) => gw.blockCard(id), {}, actorPersonId);
  }

  /** Avfrysing RE-muliggjør spend -> kill-switch-gated (§11). */
  async unfreezeCard(tenantId: string, memorySpace: MemorySpace, cardId: string, actorPersonId?: string): Promise<ProviderCard> {
    return this.lifecycleAction(tenantId, memorySpace, cardId, "active", "unfrozen", (gw, id) => gw.unblockCard(id), { killSwitchGated: true }, actorPersonId);
  }

  /** Lukking er irreversibel (klasse C) - historiske transaksjoner/hendelser BEVARES (§6). */
  async closeCard(tenantId: string, memorySpace: MemorySpace, cardId: string, actorPersonId?: string): Promise<ProviderCard> {
    return this.lifecycleAction(tenantId, memorySpace, cardId, "closed", "closed", (gw, id) => gw.closeCard(id), {}, actorPersonId);
  }

  async getCard(tenantId: string, memorySpace: MemorySpace, cardId: string): Promise<ProviderCard | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM provider_cards WHERE tenant_id = $1 AND card_id = $2`, [tenantId, cardId]);
      return rows.length > 0 ? rowToCard(rows[0] as Record<string, unknown>) : null;
    });
  }

  async listCards(tenantId: string, memorySpace: MemorySpace, includeClosed = false, limit = 100): Promise<ProviderCard[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM provider_cards WHERE tenant_id = $1 AND memory_space_id = $2 ${includeClosed ? "" : "AND state != 'closed'"} ORDER BY created_at DESC LIMIT $3`,
        [tenantId, memorySpace, limit]
      );
      return rows.map((r) => rowToCard(r as Record<string, unknown>));
    });
  }

  // === Programmerbare spend-kontroller (byggeordrens §7) ==================

  async getSpendPolicy(tenantId: string, memorySpace: MemorySpace, cardId: string): Promise<CardSpendPolicy | null> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(`SELECT * FROM card_spend_policies WHERE tenant_id = $1 AND card_id = $2`, [tenantId, cardId]);
      return rows.length > 0 ? rowToPolicy(rows[0] as Record<string, unknown>) : null;
    });
  }

  /**
   * Oppdaterer ØNSKET policy og PUSHER den til provider. ANVENDT policy
   * settes KUN fra provider-ekkoet - en grenseendring antas ALDRI
   * vellykket før provider bekrefter (§7). Nødbryteren blokkerer
   * grense-ØKNINGER og kanal-REAKTIVERING (spend-muliggjørende);
   * reduksjoner/deaktiveringer er alltid tillatt (§11). En ikke-retrybar
   * provider-avvisning markerer policyen 'rejected' (ærlig requested-vs-
   * applied-avvik) - anvendte verdier røres ikke.
   */
  async updateSpendPolicy(tenantId: string, memorySpace: MemorySpace, cardId: string, input: UpdateSpendPolicyInput, actorPersonId?: string): Promise<CardSpendPolicy> {
    const prepared = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const card = await this.requireCard(client, tenantId, cardId, true);
      const { rows } = await client.query(`SELECT * FROM card_spend_policies WHERE tenant_id = $1 AND card_id = $2 FOR UPDATE`, [tenantId, cardId]);
      if (rows.length === 0) throw new CardNotFoundError(cardId);
      const current = rowToPolicy(rows[0] as Record<string, unknown>);

      const next = {
        transaction: input.requested_transaction_limit_ore !== undefined ? input.requested_transaction_limit_ore : current.requested_transaction_limit_ore,
        daily: input.requested_daily_limit_ore !== undefined ? input.requested_daily_limit_ore : current.requested_daily_limit_ore,
        weekly: input.requested_weekly_limit_ore !== undefined ? input.requested_weekly_limit_ore : current.requested_weekly_limit_ore,
        monthly: input.requested_monthly_limit_ore !== undefined ? input.requested_monthly_limit_ore : current.requested_monthly_limit_ore,
        atm: input.requested_atm_enabled !== undefined ? input.requested_atm_enabled : current.requested_atm_enabled,
        online: input.requested_online_enabled !== undefined ? input.requested_online_enabled : current.requested_online_enabled,
        contactless: input.requested_contactless_enabled !== undefined ? input.requested_contactless_enabled : current.requested_contactless_enabled
      };

      // Spend-muliggjørende endring? Sammenlign mot PROVIDER-ANVENDT
      // sannhet (fall tilbake til requested når ingenting er anvendt ennå).
      // En hevet/fjernet grense og en gjenåpnet kanal er begge økninger.
      const increases = (
        [
          [next.transaction, current.applied_transaction_limit_ore ?? current.requested_transaction_limit_ore],
          [next.daily, current.applied_daily_limit_ore ?? current.requested_daily_limit_ore],
          [next.weekly, current.applied_weekly_limit_ore ?? current.requested_weekly_limit_ore],
          [next.monthly, current.applied_monthly_limit_ore ?? current.requested_monthly_limit_ore]
        ] as Array<[number | null, number | null]>
      ).some(([requested, baseline]) => baseline !== null && (requested === null || requested > baseline));
      const reactivations =
        (next.atm && !(current.applied_atm_enabled ?? current.requested_atm_enabled)) ||
        (next.online && !(current.applied_online_enabled ?? current.requested_online_enabled)) ||
        (next.contactless && !(current.applied_contactless_enabled ?? current.requested_contactless_enabled));
      if (increases || reactivations) await this.assertKillSwitchInactive(client, tenantId);

      await client.query(
        `UPDATE card_spend_policies SET
           requested_transaction_limit_ore = $3, requested_daily_limit_ore = $4, requested_weekly_limit_ore = $5, requested_monthly_limit_ore = $6,
           requested_atm_enabled = $7, requested_online_enabled = $8, requested_contactless_enabled = $9,
           sync_state = 'pending', requested_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND card_id = $2`,
        [tenantId, cardId, next.transaction, next.daily, next.weekly, next.monthly, next.atm, next.online, next.contactless]
      );
      await this.logCardEvent(client, tenantId, memorySpace, cardId, "limits_requested", { requested: next }, actorPersonId);
      return { card, limits: { transactionLimitOre: next.transaction, dailyLimitOre: next.daily, weeklyLimitOre: next.weekly, monthlyLimitOre: next.monthly, atmEnabled: next.atm, onlineEnabled: next.online, contactlessEnabled: next.contactless } satisfies WallesterCardLimitsInput };
    });

    // Kort som ennå ikke finnes hos provider: ønsket policy sendes med
    // selve kortopprettelsen (submitCard) - forblir 'pending' her.
    if (prepared.card.provider_card_id === null) {
      return (await this.getSpendPolicy(tenantId, memorySpace, cardId))!;
    }

    const gw = await this.gateway(tenantId);
    try {
      const applied = await gw.updateCardLimits(prepared.card.provider_card_id, prepared.limits);
      return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
        const { rows } = await client.query(
          `UPDATE card_spend_policies SET
             applied_transaction_limit_ore = $3, applied_daily_limit_ore = $4, applied_weekly_limit_ore = $5, applied_monthly_limit_ore = $6,
             applied_atm_enabled = $7, applied_online_enabled = $8, applied_contactless_enabled = $9,
             sync_state = 'applied', applied_at = now(), updated_at = now()
           WHERE tenant_id = $1 AND card_id = $2 RETURNING *`,
          [tenantId, cardId, applied.transactionLimitOre, applied.dailyLimitOre, applied.weeklyLimitOre, applied.monthlyLimitOre, applied.atmEnabled, applied.onlineEnabled, applied.contactlessEnabled]
        );
        await this.logCardEvent(client, tenantId, memorySpace, cardId, "limits_applied", { applied }, actorPersonId);
        // UA-6 closeout (D-115): en vellykket anvendelse superseder en
        // TIDLIGERE avvisning - selv-korrigerende, samme prinsipp som
        // resten av avviksdeteksjonen (ALDRI en stale flagg-rest).
        await client.query(
          `UPDATE provider_cards SET anomaly_flags = anomaly_flags - 'CARD_SPEND_POLICY_REJECTED', updated_at = now()
           WHERE tenant_id = $1 AND card_id = $2 AND anomaly_flags @> '["CARD_SPEND_POLICY_REJECTED"]'::jsonb`,
          [tenantId, cardId]
        );
        return rowToPolicy(rows[0] as Record<string, unknown>);
      });
    } catch (err) {
      if (err instanceof WallesterApiError && !err.retryable) {
        await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
          await client.query(`UPDATE card_spend_policies SET sync_state = 'rejected', updated_at = now() WHERE tenant_id = $1 AND card_id = $2`, [tenantId, cardId]);
          await this.logCardEvent(client, tenantId, memorySpace, cardId, "limits_rejected", { error: err.message.slice(0, 200) }, actorPersonId);
          // UA-6 closeout (D-115): en avvist grenseendring ble tidligere
          // KUN logget til card_events - card_anomaly_attention-open-loop-
          // regelen leser `provider_cards.anomaly_flags` (ren SQL, ALDRI
          // AI-inferert - Q-26-grensen), IKKE card_events, så avvisningen
          // var usynlig for den automatiserte daglige sveipen. SAMME jsonb-
          // append-mønster som CARD_PROVIDER_OBJECT_TENANT_CONFLICT over -
          // guard mot duplikat-append ved gjentatt avvisning.
          await client.query(
            `UPDATE provider_cards SET anomaly_flags = anomaly_flags || '["CARD_SPEND_POLICY_REJECTED"]'::jsonb, updated_at = now()
             WHERE tenant_id = $1 AND card_id = $2 AND NOT (anomaly_flags @> '["CARD_SPEND_POLICY_REJECTED"]'::jsonb)`,
            [tenantId, cardId]
          );
        });
      }
      throw err;
    }
  }

  // === Passiv tilstandssynk (byggeordrens §6/§19) =========================

  /** Passiv reparasjon av stale kanonisk tilstand fra provider-sannheten. Resurrekterer ALDRI et kanonisk lukket kort - konflikt flagges CARD_PROVIDER_STATE_CONFLICT i stedet. */
  async syncCardState(tenantId: string, memorySpace: MemorySpace, cardId: string): Promise<ProviderCard> {
    const card = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => this.requireCard(client, tenantId, cardId));
    if (card.provider_card_id === null) throw new CardNotSubmittedError(cardId);
    const gw = await this.gateway(tenantId);
    const providerCard = await gw.getCard(card.provider_card_id);
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const fresh = await this.requireCard(client, tenantId, cardId, true);
      const mapped = mapWallesterCardState(providerCard.status);
      let nextState = fresh.state;
      let conflict = false;
      if (mapped !== null && mapped !== fresh.state) {
        if (fresh.state === "closed") {
          conflict = true; // Kanonisk lukket er terminalt - provider-drift flagges, aldri stille gjenopplivet.
        } else if (isValidCardTransition(fresh.state, mapped) || mapped === "pending_provider") {
          nextState = mapped;
        } else {
          conflict = true;
        }
      }
      const flags = new Set(fresh.anomaly_flags);
      if (conflict) flags.add("CARD_PROVIDER_STATE_CONFLICT");
      const { rows } = await client.query(
        `UPDATE provider_cards SET state = $3, provider_state = $4, masked_card_number = COALESCE($5, masked_card_number),
           wallet_tokenization_status = COALESCE($6, wallet_tokenization_status), anomaly_flags = $7::jsonb,
           activated_at = CASE WHEN $3 = 'active' AND activated_at IS NULL THEN now() ELSE activated_at END,
           frozen_at = CASE WHEN $3 = 'frozen' AND $3 != $8 THEN now() ELSE frozen_at END,
           last_synced_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND card_id = $2 RETURNING *`,
        [tenantId, cardId, nextState, providerCard.status, providerCard.maskedCardNumber, providerCard.tokenizationStatus, JSON.stringify([...flags]), fresh.state]
      );
      if (conflict) {
        await this.logCardEvent(client, tenantId, memorySpace, cardId, "provider_state_conflict", { canonical_state: fresh.state, provider_state: providerCard.status });
      }
      return rowToCard(rows[0] as Record<string, unknown>);
    });
  }

  // === Autorisasjons-/transaksjonssynk (byggeordrens §9/§12) ==============

  async syncAuthorizations(tenantId: string, memorySpace: MemorySpace, cardId: string, opts: { maxPages?: number } = {}): Promise<{ inserted: number; updated: number; pages: number }> {
    const card = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => this.requireCard(client, tenantId, cardId));
    if (card.provider_card_id === null) throw new CardNotSubmittedError(cardId);
    const gw = await this.gateway(tenantId);
    const maxPages = opts.maxPages ?? 10;
    let inserted = 0;
    let updated = 0;
    let pages = 0;
    let pageToken: string | null = null;
    do {
      const page = await gw.listAuthorizations(card.provider_card_id, pageToken);
      pages++;
      await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
        for (const auth of page.items) {
          const result = await client.query(
            `INSERT INTO card_authorizations (authorization_id, tenant_id, memory_space_id, card_id, provider_authorization_id, status, amount_ore, currency, merchant_name, merchant_category_code, channel, decline_reason, authorized_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (tenant_id, provider, provider_authorization_id) DO NOTHING RETURNING authorization_id`,
            [`cauth-${randomUUID()}`, tenantId, memorySpace, cardId, auth.id, auth.status, auth.amountOre, auth.currency, auth.merchantName, auth.merchantCategoryCode, auth.channel, auth.declineReason, auth.authorizedAt]
          );
          if (result.rows.length > 0) {
            inserted++;
          } else {
            // Statusprogresjon på SAMME rad (approved -> settled/reversed/
            // expired) - terminalt 'declined' bevares.
            const changed = await client.query(
              `UPDATE card_authorizations SET status = $4, updated_at = now()
               WHERE tenant_id = $1 AND provider_authorization_id = $2 AND status = 'approved' AND $4 != status AND card_id = $3 RETURNING authorization_id`,
              [tenantId, auth.id, cardId, auth.status]
            );
            if (changed.rows.length > 0) updated++;
          }
        }
      });
      pageToken = page.nextPageToken;
    } while (pageToken !== null && pages < maxPages);
    return { inserted, updated, pages };
  }

  async syncTransactions(tenantId: string, memorySpace: MemorySpace, cardId: string, opts: { maxPages?: number } = {}): Promise<{ inserted: number; corrections_flagged: number; pages: number }> {
    const card = await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => this.requireCard(client, tenantId, cardId));
    if (card.provider_card_id === null) throw new CardNotSubmittedError(cardId);
    const gw = await this.gateway(tenantId);
    const maxPages = opts.maxPages ?? 10;
    let inserted = 0;
    let correctionsFlagged = 0;
    let pages = 0;
    let pageToken: string | null = null;
    do {
      const page = await gw.listTransactions(card.provider_card_id, pageToken);
      pages++;
      await withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
        for (const tx of page.items) {
          await this.ingestTransaction(client, tenantId, memorySpace, cardId, tx, (n) => {
            inserted += n.inserted;
            correctionsFlagged += n.corrections;
          });
        }
      });
      pageToken = page.nextPageToken;
    } while (pageToken !== null && pages < maxPages);
    return { inserted, corrections_flagged: correctionsFlagged, pages };
  }

  /** Delt idempotent ingest for polling OG webhook (duplikat webhook+polling-observasjon er uskadelig - §12). */
  private async ingestTransaction(
    client: pg.PoolClient,
    tenantId: string,
    memorySpace: MemorySpace,
    cardId: string,
    tx: { id: string; authorizationId: string | null; type: "purchase" | "refund" | "reversal" | "fee" | "unknown"; amountOre: number; currency: string; merchantName: string | null; merchantCategoryCode: string | null; channel: string; transactionAt: string | null; settledAt: string | null },
    count: (n: { inserted: number; corrections: number }) => void
  ): Promise<void> {
    // Deterministisk autorisasjon<->oppgjør-lenking (§9).
    let authorizationRowId: string | null = null;
    if (tx.authorizationId) {
      const auth = await client.query(`SELECT authorization_id, status, amount_ore FROM card_authorizations WHERE tenant_id = $1 AND provider_authorization_id = $2`, [tenantId, tx.authorizationId]);
      if (auth.rows.length > 0) authorizationRowId = (auth.rows[0] as { authorization_id: string }).authorization_id;
    }
    const flags: string[] = [];
    if (authorizationRowId) {
      const existingSettlements = await client.query(
        `SELECT count(*)::int AS n FROM card_transactions WHERE tenant_id = $1 AND authorization_id = $2 AND transaction_type = 'purchase'`,
        [tenantId, authorizationRowId]
      );
      // ETT økonomisk beløp per autorisasjon - et ANDRE oppgjør mot samme
      // autorisasjon er DUPLICATE_ECONOMIC_EFFECT (§9/§14).
      if ((existingSettlements.rows[0] as { n: number }).n > 0 && tx.type === "purchase") flags.push("DUPLICATE_ECONOMIC_EFFECT");
      const auth = await client.query(`SELECT amount_ore FROM card_authorizations WHERE tenant_id = $1 AND authorization_id = $2`, [tenantId, authorizationRowId]);
      const authAmount = Number((auth.rows[0] as { amount_ore: string }).amount_ore);
      if (tx.type === "purchase" && tx.amountOre > authAmount) flags.push("CARD_AUTH_SETTLEMENT_CONFLICT");
    }

    const result = await client.query(
      `INSERT INTO card_transactions (card_transaction_id, tenant_id, memory_space_id, card_id, provider_transaction_id, authorization_id, transaction_type, amount_ore, currency, merchant_name, merchant_category_code, channel, transaction_at, settled_at, anomaly_flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
       ON CONFLICT (tenant_id, provider, provider_transaction_id) DO NOTHING RETURNING card_transaction_id`,
      [
        `ctx-${randomUUID()}`, tenantId, memorySpace, cardId, tx.id, authorizationRowId, tx.type, tx.amountOre, tx.currency,
        tx.merchantName, tx.merchantCategoryCode, tx.channel, tx.transactionAt, tx.settledAt, JSON.stringify(flags)
      ]
    );
    if (result.rows.length > 0) {
      count({ inserted: 1, corrections: 0 });
      if (authorizationRowId && tx.type === "purchase") {
        await client.query(`UPDATE card_authorizations SET status = 'settled', updated_at = now() WHERE tenant_id = $1 AND authorization_id = $2 AND status = 'approved'`, [tenantId, authorizationRowId]);
      }
      return;
    }
    // Provider-KORREKSJON av etablert beløp/valuta: flagg, originalen
    // bevares - aldri stille overskrevet (§12).
    const existing = await client.query(
      `SELECT card_transaction_id, amount_ore, currency, anomaly_flags FROM card_transactions WHERE tenant_id = $1 AND provider_transaction_id = $2`,
      [tenantId, tx.id]
    );
    const row = existing.rows[0] as { card_transaction_id: string; amount_ore: string; currency: string; anomaly_flags: string[] } | undefined;
    if (row && (Number(row.amount_ore) !== tx.amountOre || row.currency !== tx.currency)) {
      const merged = new Set([...(row.anomaly_flags ?? []), "CARD_TRANSACTION_CORRECTION_CONFLICT"]);
      if (merged.size !== new Set(row.anomaly_flags ?? []).size) {
        await client.query(`UPDATE card_transactions SET anomaly_flags = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND card_transaction_id = $2`, [
          tenantId, row.card_transaction_id, JSON.stringify([...merged])
        ]);
        count({ inserted: 0, corrections: 1 });
      }
    }
  }

  async listAuthorizations(tenantId: string, memorySpace: MemorySpace, filter: { card_id?: string; limit?: number } = {}): Promise<CardAuthorization[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM card_authorizations WHERE tenant_id = $1 AND memory_space_id = $2 ${filter.card_id ? "AND card_id = $4" : ""} ORDER BY created_at DESC LIMIT $3`,
        filter.card_id ? [tenantId, memorySpace, filter.limit ?? 100, filter.card_id] : [tenantId, memorySpace, filter.limit ?? 100]
      );
      return rows.map((r) => ({ ...(r as unknown as CardAuthorization), amount_ore: Number((r as Record<string, unknown>)["amount_ore"]), anomaly_flags: ((r as Record<string, unknown>)["anomaly_flags"] as string[] | null) ?? [] }));
    });
  }

  async listCardTransactions(tenantId: string, memorySpace: MemorySpace, filter: { card_id?: string; reconciliation_state?: string; limit?: number } = {}): Promise<CardTransaction[]> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const conditions: string[] = ["tenant_id = $1", "memory_space_id = $2"];
      const params: unknown[] = [tenantId, memorySpace, filter.limit ?? 200];
      if (filter.card_id) {
        params.push(filter.card_id);
        conditions.push(`card_id = $${params.length}`);
      }
      if (filter.reconciliation_state) {
        params.push(filter.reconciliation_state);
        conditions.push(`reconciliation_state = $${params.length}`);
      }
      const { rows } = await client.query(`SELECT * FROM card_transactions WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT $3`, params);
      return rows.map((r) => ({
        ...(r as unknown as CardTransaction),
        amount_ore: Number((r as Record<string, unknown>)["amount_ore"]),
        anomaly_flags: ((r as Record<string, unknown>)["anomaly_flags"] as string[] | null) ?? []
      }));
    });
  }

  // === Finance-avstemming (byggeordrens §13) ==============================

  /**
   * Deterministisk kortspend-avstemming mot forventet spend
   * (`finance_recurring_commitments`) - Q-26: ALDRI AI-inferert, tvetydige
   * kandidater forblir uløste. REGEL 1 `card_purpose_commitment`
   * (sterkest bevis): kortet er FORMÅLSBUNDET til en forpliktelse
   * (eier-satt peker) og beløp+valuta ligger innenfor forpliktelsens
   * deterministiske toleranse. Avvik utenfor toleransen flagges
   * CARD_PURPOSE_MISMATCH - aldri en stille match. REGEL 2
   * `commitment_amount`: ubundet kort - NØYAKTIG ÉN aktiv forpliktelse
   * matcher beløp+valuta innenfor toleranse; flere -> 'ambiguous'.
   * KUN 'purchase'-transaksjoner avstemmes (refusjon/reversering/gebyr er
   * ikke forventet-spend-bevis).
   */
  async reconcileCardTransactions(tenantId: string, memorySpace: MemorySpace): Promise<{ matched_by_purpose: number; matched_by_amount: number; mismatch_flagged: number; ambiguous: number }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      let matchedByPurpose = 0;
      let matchedByAmount = 0;
      let mismatchFlagged = 0;
      let ambiguous = 0;
      const { rows: txRows } = await client.query(
        `SELECT ct.card_transaction_id, ct.card_id, ct.amount_ore, ct.currency, ct.anomaly_flags, pc.commitment_id AS card_commitment_id
         FROM card_transactions ct JOIN provider_cards pc ON pc.card_id = ct.card_id AND pc.tenant_id = ct.tenant_id
         WHERE ct.tenant_id = $1 AND ct.memory_space_id = $2 AND ct.transaction_type = 'purchase' AND ct.reconciliation_state = 'unmatched'
         ORDER BY ct.created_at ASC`,
        [tenantId, memorySpace]
      );
      for (const raw of txRows as Array<{ card_transaction_id: string; card_id: string; amount_ore: string; currency: string; anomaly_flags: string[]; card_commitment_id: string | null }>) {
        const amount = Number(raw.amount_ore);
        if (raw.card_commitment_id) {
          const { rows } = await client.query(
            `SELECT commitment_id, expected_amount_ore, amount_tolerance_ore, currency FROM finance_recurring_commitments
             WHERE tenant_id = $1 AND commitment_id = $2 AND state = 'active'`,
            [tenantId, raw.card_commitment_id]
          );
          const commitment = rows[0] as { commitment_id: string; expected_amount_ore: string; amount_tolerance_ore: string; currency: string } | undefined;
          if (commitment && commitment.currency === raw.currency && Math.abs(amount - Number(commitment.expected_amount_ore)) <= Number(commitment.amount_tolerance_ore)) {
            await this.linkCardMatch(client, tenantId, raw.card_transaction_id, commitment.commitment_id, "card_purpose_commitment", { amount_ore: amount, expected_amount_ore: Number(commitment.expected_amount_ore) });
            matchedByPurpose++;
          } else {
            const flags = new Set([...(raw.anomaly_flags ?? []), "CARD_PURPOSE_MISMATCH"]);
            await client.query(`UPDATE card_transactions SET anomaly_flags = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND card_transaction_id = $2`, [
              tenantId, raw.card_transaction_id, JSON.stringify([...flags])
            ]);
            mismatchFlagged++;
          }
          continue;
        }
        const { rows: candidates } = await client.query(
          `SELECT commitment_id FROM finance_recurring_commitments
           WHERE tenant_id = $1 AND memory_space_id = $2 AND state = 'active' AND currency = $3
             AND abs(expected_amount_ore - $4) <= amount_tolerance_ore`,
          [tenantId, memorySpace, raw.currency, amount]
        );
        if (candidates.length === 1) {
          await this.linkCardMatch(client, tenantId, raw.card_transaction_id, (candidates[0] as { commitment_id: string }).commitment_id, "commitment_amount", { amount_ore: amount });
          matchedByAmount++;
        } else if (candidates.length > 1) {
          await client.query(
            `UPDATE card_transactions SET reconciliation_state = 'ambiguous', match_evidence = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND card_transaction_id = $2`,
            [tenantId, raw.card_transaction_id, JSON.stringify({ candidate_count: candidates.length, rule: "commitment_amount" })]
          );
          ambiguous++;
        }
      }
      return { matched_by_purpose: matchedByPurpose, matched_by_amount: matchedByAmount, mismatch_flagged: mismatchFlagged, ambiguous };
    });
  }

  private async linkCardMatch(client: pg.PoolClient, tenantId: string, cardTransactionId: string, commitmentId: string, rule: string, evidence: Record<string, unknown>): Promise<void> {
    await client.query(
      `UPDATE card_transactions SET reconciliation_state = 'matched', matched_commitment_id = $3, match_rule = $4, match_evidence = $5::jsonb, updated_at = now()
       WHERE tenant_id = $1 AND card_transaction_id = $2`,
      [tenantId, cardTransactionId, commitmentId, rule, JSON.stringify(evidence)]
    );
  }

  // === Kortavviksdeteksjon (byggeordrens §14) =============================

  /**
   * Deterministisk, selv-korrigerende sveip. Sveipen EIER de rene
   * beregningstypene og full-gjenberegner dem; kilde-satte flagg
   * (CARD_TRANSACTION_CORRECTION_CONFLICT / DUPLICATE_ECONOMIC_EFFECT /
   * CARD_AUTH_SETTLEMENT_CONFLICT / CARD_PURPOSE_MISMATCH satt ved synk/
   * avstemming, CARD_PROVIDER_STATE_CONFLICT på kortet satt ved
   * tilstandssynk) BEVARES.
   */
  async runCardAnomalyDetection(tenantId: string, memorySpace: MemorySpace): Promise<{ transaction_flags_added: number; flags_cleared: number; card_flags_added: number }> {
    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const sweepOwned = new Set([
        "UNEXPECTED_CARD_SPEND", "CARD_CURRENCY_MISMATCH", "CARD_AMOUNT_LIMIT_BREACH", "CARD_DUPLICATE_TRANSACTION",
        "CARD_SPEND_AFTER_FREEZE", "CARD_SPEND_AFTER_CLOSE", "UNEXPECTED_CASH_WITHDRAWAL", "UNEXPECTED_ONLINE_PURCHASE"
      ]);
      const { rows } = await client.query(
        `SELECT ct.card_transaction_id, ct.card_id, ct.transaction_type, ct.amount_ore, ct.currency, ct.channel, ct.merchant_name,
                ct.transaction_at, ct.reconciliation_state, ct.anomaly_flags, ct.created_at,
                pc.currency AS card_currency, pc.state AS card_state, pc.frozen_at, pc.closed_at, pc.commitment_id AS card_commitment_id,
                pol.applied_transaction_limit_ore, pol.applied_atm_enabled, pol.applied_online_enabled
         FROM card_transactions ct
         JOIN provider_cards pc ON pc.card_id = ct.card_id AND pc.tenant_id = ct.tenant_id
         LEFT JOIN card_spend_policies pol ON pol.card_id = ct.card_id AND pol.tenant_id = ct.tenant_id
         WHERE ct.tenant_id = $1 AND ct.memory_space_id = $2`,
        [tenantId, memorySpace]
      );
      type TxRow = {
        card_transaction_id: string; card_id: string; transaction_type: string; amount_ore: string; currency: string;
        channel: string; merchant_name: string | null; transaction_at: string | null; reconciliation_state: string;
        anomaly_flags: string[]; created_at: string; card_currency: string; card_state: string; frozen_at: string | null;
        closed_at: string | null; card_commitment_id: string | null; applied_transaction_limit_ore: string | null;
        applied_atm_enabled: boolean | null; applied_online_enabled: boolean | null;
      };
      const txRows = rows as TxRow[];

      // CARD_DUPLICATE_TRANSACTION: samme kort+beløp+brukersted+tidspunkt
      // med FLERE distinkte provider-transaksjons-ID-er.
      const dupKeys = new Map<string, number>();
      for (const tx of txRows) {
        const key = `${tx.card_id}:${tx.amount_ore}:${tx.merchant_name ?? ""}:${tx.transaction_at ?? ""}`;
        dupKeys.set(key, (dupKeys.get(key) ?? 0) + 1);
      }

      const ageThresholdMs = CARD_UNMATCHED_FLAG_AGE_DAYS * 24 * 60 * 60 * 1000;
      const now = Date.now();
      let flagsAdded = 0;
      let flagsCleared = 0;
      for (const tx of txRows) {
        const computed = new Set<string>();
        const amount = Number(tx.amount_ore);
        if (tx.currency !== tx.card_currency) computed.add("CARD_CURRENCY_MISMATCH");
        if (tx.applied_transaction_limit_ore !== null && amount > Number(tx.applied_transaction_limit_ore)) computed.add("CARD_AMOUNT_LIMIT_BREACH");
        if ((dupKeys.get(`${tx.card_id}:${tx.amount_ore}:${tx.merchant_name ?? ""}:${tx.transaction_at ?? ""}`) ?? 0) > 1) computed.add("CARD_DUPLICATE_TRANSACTION");
        if (tx.channel === "atm" && tx.applied_atm_enabled === false) computed.add("UNEXPECTED_CASH_WITHDRAWAL");
        if (tx.channel === "online" && tx.applied_online_enabled === false) computed.add("UNEXPECTED_ONLINE_PURCHASE");
        const txAt = tx.transaction_at ? Date.parse(tx.transaction_at) : null;
        if (txAt !== null && tx.card_state === "frozen" && tx.frozen_at && txAt > Date.parse(tx.frozen_at)) computed.add("CARD_SPEND_AFTER_FREEZE");
        if (txAt !== null && tx.closed_at && txAt > Date.parse(tx.closed_at)) computed.add("CARD_SPEND_AFTER_CLOSE");
        if (
          tx.transaction_type === "purchase" && tx.reconciliation_state !== "matched" && tx.card_commitment_id === null &&
          now - Date.parse(tx.created_at) > ageThresholdMs
        ) {
          computed.add("UNEXPECTED_CARD_SPEND");
        }
        const before = new Set(tx.anomaly_flags ?? []);
        const preserved = [...before].filter((f) => !sweepOwned.has(f));
        const next = new Set([...preserved, ...computed]);
        if (next.size === before.size && [...next].every((f) => before.has(f))) continue;
        if ([...before].some((f) => sweepOwned.has(f) && !next.has(f))) flagsCleared++;
        if ([...next].some((f) => !before.has(f))) flagsAdded++;
        await client.query(`UPDATE card_transactions SET anomaly_flags = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND card_transaction_id = $2`, [
          tenantId, tx.card_transaction_id, JSON.stringify([...next])
        ]);
      }

      // Kort-nivå: CARD_PROVIDER_OBJECT_TENANT_CONFLICT (defensiv - RLS er
      // primærvokteren): kort i en annen tenant enn den konfigurerte
      // provider-konto-tenanten (enkelt-global-konto-mønsteret).
      let cardFlagsAdded = 0;
      const configuredTenant = this.tenantResolver();
      if (configuredTenant && configuredTenant !== tenantId) {
        const { rows: cardRows } = await client.query(`SELECT card_id, anomaly_flags FROM provider_cards WHERE tenant_id = $1 AND memory_space_id = $2 AND provider_card_id IS NOT NULL`, [tenantId, memorySpace]);
        for (const card of cardRows as Array<{ card_id: string; anomaly_flags: string[] }>) {
          const flags = new Set(card.anomaly_flags ?? []);
          if (!flags.has("CARD_PROVIDER_OBJECT_TENANT_CONFLICT")) {
            flags.add("CARD_PROVIDER_OBJECT_TENANT_CONFLICT");
            await client.query(`UPDATE provider_cards SET anomaly_flags = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND card_id = $2`, [tenantId, card.card_id, JSON.stringify([...flags])]);
            cardFlagsAdded++;
          }
        }
      }
      return { transaction_flags_added: flagsAdded, flags_cleared: flagsCleared, card_flags_added: cardFlagsAdded };
    });
  }

  // === Webhook-ingestion (byggeordrens §15) ===============================

  /**
   * Autentiserer (HTTP Basic, konstant-tid), deduper, ruter via KJENT
   * provider-kort-mapping (ALDRI payload-tenant-metadata som autoritet)
   * og anvender hendelsen idempotent. RLS er primærvokteren for
   * tenant-isolasjon (ingestionen kjører i den KONFIGURERTE tenantens
   * kontekst - et kort utenfor den er usynlig -> 'unsupported').
   */
  async ingestWallesterWebhookEvent(rawBody: Buffer, authorizationHeader: string | undefined): Promise<{ status: "processed" | "duplicate" | "unsupported" | "failed_retryable"; eventId: string }> {
    const basicAuth = this.webhookAuthProvider();
    if (!basicAuth) throw new InvalidWebhookSignatureError("wallester_webhook_auth_unconfigured");
    const verdict = verifyWallesterWebhookBasicAuth(authorizationHeader, basicAuth.username, basicAuth.password);
    if (!verdict.valid) throw new InvalidWebhookSignatureError(`wallester_webhook_${verdict.reason ?? "invalid"}`);

    let envelope: WallesterEventEnvelope;
    try {
      envelope = parseWallesterEventEnvelope(rawBody);
    } catch (err) {
      if (err instanceof WallesterEventEnvelopeError) throw err;
      throw new WallesterEventEnvelopeError("unparseable");
    }

    const tenantId = this.tenantResolver();
    if (!tenantId) throw new WallesterTenantNotConfiguredError();
    const memorySpace: MemorySpace = "business";

    return withMemoryTransaction(this.pool, tenantId, [memorySpace], async (client) => {
      const inserted = await client.query(
        `INSERT INTO wallester_webhook_events (dedupe_key, tenant_id, memory_space_id, event_type, provider_object_id, status)
         VALUES ($1, $2, $3, $4, $5, 'verified') ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key`,
        [envelope.dedupeKey, tenantId, memorySpace, envelope.eventType, envelope.providerObjectId]
      );
      if (inserted.rows.length === 0) return { status: "duplicate" as const, eventId: envelope.dedupeKey };

      const providerCardId = envelope.providerCardId ?? (envelope.kind === "card" ? envelope.providerObjectId : null);
      const cardRow = providerCardId
        ? await client.query(`SELECT card_id FROM provider_cards WHERE tenant_id = $1 AND provider_card_id = $2 FOR UPDATE`, [tenantId, providerCardId])
        : { rows: [] as Array<{ card_id: string }> };
      if (cardRow.rows.length === 0) {
        await client.query(`UPDATE wallester_webhook_events SET status = 'unsupported', processed_at = now() WHERE dedupe_key = $1`, [envelope.dedupeKey]);
        return { status: "unsupported" as const, eventId: envelope.dedupeKey };
      }
      const cardId = (cardRow.rows[0] as { card_id: string }).card_id;

      try {
        // "authorization_release" (owner-provided primary-source-audit, PR #62
        // runde 4) rapporterer et senere utfall for en EKSISTERENDE
        // autorisasjon (f.eks. reversert/utløpt uten oppgjør) - samme
        // status-lagrings-/korrigeringssti som "authorization".
        if (envelope.kind === "authorization" || envelope.kind === "authorization_release") {
          const p = envelope.payload;
          const status = String(p["status"] ?? "unknown").toLowerCase();
          // Fail-safe (owner-provided primary-source-audit, PR #62 runde 4): en
          // ubekreftet providerstatus mappes ALDRI stille til "approved".
          const mapped = status === "approved" || status === "declined" || status === "reversed" || status === "settled" || status === "expired" ? status : "unknown";
          const insertedAuth = await client.query(
            `INSERT INTO card_authorizations (authorization_id, tenant_id, memory_space_id, card_id, provider_authorization_id, status, amount_ore, currency, merchant_name, merchant_category_code, channel, decline_reason, authorized_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (tenant_id, provider, provider_authorization_id) DO NOTHING RETURNING authorization_id`,
            [
              `cauth-${randomUUID()}`, tenantId, memorySpace, cardId, envelope.providerObjectId, mapped,
              Number(p["amount"] ?? 0), String(p["currency"] ?? "EUR").toUpperCase(),
              typeof p["merchant_name"] === "string" ? p["merchant_name"] : null,
              typeof p["merchant_category_code"] === "string" ? p["merchant_category_code"] : null,
              ["pos", "online", "atm", "contactless"].includes(String(p["channel"])) ? String(p["channel"]) : "unknown",
              typeof p["decline_reason"] === "string" ? p["decline_reason"] : null,
              typeof p["authorized_at"] === "string" ? p["authorized_at"] : null
            ]
          );
          if (insertedAuth.rows.length === 0) {
            // Kun ikke-terminale plassholdertilstander ('approved' fra
            // optimistisk polling, 'unknown' fra en tidligere uidentifisert
            // status) korrigeres ved en senere, mer presis hendelse.
            await client.query(
              `UPDATE card_authorizations SET status = $3, updated_at = now() WHERE tenant_id = $1 AND provider_authorization_id = $2 AND status IN ('approved', 'unknown') AND $3 != status`,
              [tenantId, envelope.providerObjectId, mapped]
            );
          }
        } else if (envelope.kind === "transaction") {
          const p = envelope.payload;
          const type = String(p["transaction_type"] ?? p["type"] ?? "unknown").toLowerCase();
          // Fail-safe (owner-provided primary-source-audit, PR #62 runde 4): en
          // ubekreftet transaksjonstype mappes ALDRI stille til "purchase".
          await this.ingestTransaction(client, tenantId, memorySpace, cardId, {
            id: envelope.providerObjectId,
            authorizationId: typeof p["authorization_id"] === "string" ? (p["authorization_id"] as string) : null,
            type: type === "purchase" || type === "refund" || type === "reversal" || type === "fee" ? (type as "purchase" | "refund" | "reversal" | "fee") : "unknown",
            amountOre: Number(p["amount"] ?? 0),
            currency: String(p["currency"] ?? "EUR").toUpperCase(),
            merchantName: typeof p["merchant_name"] === "string" ? (p["merchant_name"] as string) : null,
            merchantCategoryCode: typeof p["merchant_category_code"] === "string" ? (p["merchant_category_code"] as string) : null,
            channel: ["pos", "online", "atm", "contactless"].includes(String(p["channel"])) ? String(p["channel"]) : "unknown",
            transactionAt: typeof p["transaction_at"] === "string" ? (p["transaction_at"] as string) : null,
            settledAt: typeof p["settled_at"] === "string" ? (p["settled_at"] as string) : null
          }, () => undefined);
        } else if (envelope.kind === "card") {
          // Provider-korttilstand oppdateres OBSERVASJONELT; kanonisk
          // reparasjon (aldri closed-resurreksjon) følger syncCardState-
          // reglene ved neste sveip - webhooken alene endrer ikke
          // kanonisk terminaltilstand.
          await client.query(`UPDATE provider_cards SET provider_state = $3, last_synced_at = now(), updated_at = now() WHERE tenant_id = $1 AND card_id = $2`, [
            tenantId, cardId, envelope.status
          ]);
        }
        await client.query(`UPDATE wallester_webhook_events SET status = 'processed', card_id = $2, processed_at = now() WHERE dedupe_key = $1`, [envelope.dedupeKey, cardId]);
        return { status: "processed" as const, eventId: envelope.dedupeKey };
      } catch (err) {
        await client.query(`UPDATE wallester_webhook_events SET status = 'failed_retryable', error_message = $2, processed_at = now() WHERE dedupe_key = $1`, [
          envelope.dedupeKey, (err as Error).message.slice(0, 500)
        ]);
        return { status: "failed_retryable" as const, eventId: envelope.dedupeKey };
      }
    });
  }

  // === Provider-saldo (byggeordrens §17) ==================================

  /** Read-only provider-kontosaldo (Wallester-spesifikk finansiell tilstand - dupliserer ALDRI Neonomics-bankautoriteten). */
  async getProviderBalance(tenantId: string): Promise<WallesterAccountBalance> {
    const gw = await this.gateway(tenantId);
    return gw.getAccountBalance();
  }
}
