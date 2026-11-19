import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction } from "@jarvis/memory";
import { PROVIDERS_FOR_CHANNEL, isValidAccountRef, type CommsChannel, type CommsProvider } from "./channels.ts";
import type { OutboundKind, OutboundPurpose, RateCaps, RecipientProof, RuleResult } from "./policy.ts";

/**
 * WP-G1 (D-463): databasetilgang for kommunikasjonstabellene (migrasjon 118). ALL tilgang går via `withMemoryTransaction` (tenant + memory space på transaksjonen, RLS FORCE) - ingen spørring uten tenant-kontekst.
 * Klokken er injisert (`now`) og brukes BÅDE til `created_at`/`retention_until` og til tellervinduene, slik at policy-evalueringen og radene alltid er på samme tid (og testbare).
 */
export type Clock = () => Date;

export interface AuthorizedAccount {
  readonly account_id: string;
  readonly channel: CommsChannel;
  readonly account_ref: string;
  readonly provider: CommsProvider;
  readonly display_name: string | null;
  readonly status: "active" | "revoked";
  readonly created_at: string;
  readonly revoked_at: string | null;
}

export interface Actor {
  readonly person_id: string;
  readonly session_id: string;
  readonly task_id?: string;
}

export type OptOutSource = "inbound_stop_keyword" | "provider_error" | "owner_recorded" | "recipient_request";

/**
 * N1 (LEDER-AVGJØRELSE, delta-review A): ÉN aktiv avmeldingsrad per (tenant, mottaker-navnerom, KANAL, KILDE). Den unike indeksen i migrasjon 118 er (tenant, kanal, account_ref, hash) for aktive rader, og en tenant-bred avmelding
 * har ingen avsenderkonto - `account_ref` er derfor et KILDE-spor (aldri en faktisk konto): stopp-ord `*` (som før), leverandørfeil `*provider`, eierregistrert `*owner`, mottakerens bønn utenfor kanalen `*request`. Slik kan en senere
 * STOP aldri «absorberes» i en eksisterende rad med annen kanal/kilde (da ble kanalen/kilden til den første stående, og START på én kanal åpnet de andre, eller en eierregistrering forsvant ved START). Ingen migrasjon.
 */
const OPT_OUT_SLOT: Readonly<Record<OptOutSource, string>> = {
  inbound_stop_keyword: "*", provider_error: "*provider", owner_recorded: "*owner", recipient_request: "*request"
};

/** B-H2: avmeldingen/gjenopptaket en innkommende STOP/START fører til. Skrives i SAMME transaksjon som hendelsens dedupe-rad (se `recordInbound`). */
export interface OptEffect {
  readonly kind: "stop" | "start";
  readonly channel: CommsChannel;
  /** `optOutHash` (tenant-bredt navnerom), ikke journalens kanalspesifikke `recipientHash`. */
  readonly recipient_hash: string;
  readonly recipient_hint: string;
  /** Peker til hendelsen (DB-grense 200 tegn: bruk `evidenceRefFor`). */
  readonly evidence_ref: string;
}

export interface OptOutRow {
  readonly opt_out_id: string;
  readonly channel: CommsChannel;
  readonly account_ref: string;
  readonly recipient_hint: string | null;
  readonly status: "active" | "lifted";
  readonly source: OptOutSource;
  readonly created_at: string;
  readonly lifted_at: string | null;
}

export type JournalStatus = "denied" | "requested" | "sent" | "outcome_unknown" | "failed";
export type JournalSource = "owner_route" | "tool" | "sweep" | "legacy_notify_guard";

export interface JournalEntryInput {
  readonly request_id: string;
  readonly kind: OutboundKind;
  readonly channel: CommsChannel;
  readonly account_ref: string;
  readonly provider: CommsProvider;
  readonly recipient_hash: string;
  readonly recipient_hint: string;
  readonly purpose: OutboundPurpose;
  readonly rule_evaluation: readonly RuleResult[];
  readonly denial_codes: readonly string[];
  readonly recipient_proof: RecipientProof;
  readonly content_sha256: string | null;
  readonly content_length: number;
  readonly ai_disclosure_applied: boolean;
  readonly target_log_id?: string;
  readonly thread_ref?: string;
  readonly before_state?: unknown;
  readonly source: JournalSource;
}

export interface JournalRow {
  readonly log_id: string;
  readonly request_id: string;
  readonly kind: OutboundKind;
  readonly channel: CommsChannel;
  readonly account_ref: string;
  readonly provider: CommsProvider;
  readonly recipient_hint: string | null;
  readonly purpose: OutboundPurpose;
  readonly status: JournalStatus;
  readonly denial_codes: readonly string[];
  readonly content_sha256: string | null;
  readonly content_length: number;
  readonly ai_disclosure_applied: boolean;
  readonly target_log_id: string | null;
  readonly provider_message_id: string | null;
  readonly thread_ref: string | null;
  readonly person_id: string;
  readonly session_id: string;
  readonly task_id: string | null;
  readonly source: JournalSource;
  readonly created_at: string;
  readonly updated_at: string;
}

export type BeginResult =
  | { readonly kind: "started"; readonly log_id: string }
  | { readonly kind: "replay"; readonly log_id: string; readonly status: JournalStatus; readonly provider_message_id: string | null; readonly request_fingerprint: string | null }
  /** A-H2: taket var nådd da forsøket skulle reserveres (tellingen ble gjort UNDER lås, etter at policyen så «0 sendt»). Ingenting er skrevet; kalleren journalfører et avslag. */
  | { readonly kind: "cap_exceeded"; readonly scope: "recipient" | "account"; readonly code: string };

export interface InboundEventInput {
  readonly provider: "slack" | "meta" | "twilio" | "telnyx";
  readonly channel: CommsChannel;
  readonly account_ref: string;
  readonly event_key: string;
  readonly kind: "message" | "status" | "opt_out" | "opt_in" | "other";
  readonly sender_hash: string | null;
  readonly sender_hint: string | null;
  readonly identity_id: string | null;
  readonly thread_ref: string | null;
  readonly content_excerpt: string | null;
  readonly content_sha256: string | null;
  readonly provider_ts: string | null;
  readonly ingest_id: string;
}

export interface InboundEventRow {
  readonly event_id: string;
  readonly provider: string;
  readonly channel: CommsChannel;
  readonly account_ref: string;
  readonly kind: string;
  readonly sender_hint: string | null;
  readonly identity_id: string | null;
  readonly thread_ref: string | null;
  readonly content_excerpt: string | null;
  readonly trust_level: "untrusted";
  readonly received_at: string;
}

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
const newId = (prefix: string): string => `${prefix}-${randomUUID()}`;
const ACTIVE_STATUSES = ["requested", "sent", "outcome_unknown"];
/** Rommene kommunikasjon kan skje i (helse/hjem/gjest er aldri mål). Mottakerens avmelding leses og skrives på tvers av ALLE disse (A-M3: tenant-bred), uavhengig av rommet avsenderen eller webhooken står i. */
const COMMS_SPACES: readonly MemorySpace[] = ["personal", "business", "project", "shared"];

export class CommsStore {
  constructor(private readonly pool: pg.Pool, private readonly clock: Clock = () => new Date()) {}

  // ---------------------------------------------------------------- konto-allowlist (eierens egen)
  async authorizeAccount(
    tenantId: string, space: MemorySpace,
    input: { channel: CommsChannel; account_ref: string; provider: CommsProvider; display_name?: string; source: "owner_route" | "tool" },
    actor: Actor
  ): Promise<{ account: AuthorizedAccount; created: boolean }> {
    if (!isValidAccountRef(input.channel, input.account_ref)) throw new Error("comms_invalid_account_ref");
    if (!PROVIDERS_FOR_CHANNEL[input.channel].includes(input.provider)) throw new Error("comms_provider_not_valid_for_channel");
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const id = newId("acct");
      const inserted = await client.query(
        `INSERT INTO comms_authorized_accounts (tenant_id, account_id, memory_space_id, channel, account_ref, provider, display_name, created_by_person_id, source, session_id, task_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, channel, account_ref) WHERE status = 'active' DO NOTHING RETURNING *`,
        [tenantId, id, space, input.channel, input.account_ref, input.provider, input.display_name ?? null, actor.person_id === "system" ? null : actor.person_id, input.source, actor.session_id, actor.task_id ?? null, this.clock()]
      );
      if (inserted.rowCount === 1) return { account: this.toAccount(inserted.rows[0] as Record<string, unknown>), created: true };
      const existing = await client.query(
        `SELECT * FROM comms_authorized_accounts WHERE tenant_id = $1 AND channel = $2 AND account_ref = $3 AND status = 'active'`, [tenantId, input.channel, input.account_ref]
      );
      // Konflikten kan være en aktiv rad i et ANNET rom (RLS skjuler den): da finnes ingen rad å returnere her. Før lekket det et TypeError («Cannot read properties of undefined»); nå en fast, ryddig feilkode.
      if (existing.rowCount === 0) throw new Error("comms_account_authorized_in_another_room");
      return { account: this.toAccount(existing.rows[0] as Record<string, unknown>), created: false };
    });
  }

  async revokeAccount(tenantId: string, space: MemorySpace, accountId: string): Promise<boolean> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const res = await client.query(
        `UPDATE comms_authorized_accounts SET status = 'revoked', revoked_at = $3 WHERE tenant_id = $1 AND account_id = $2 AND status = 'active'`, [tenantId, accountId, this.clock()]
      );
      return res.rowCount === 1;
    });
  }

  async findActiveAccount(tenantId: string, space: MemorySpace, channel: CommsChannel, accountRef: string): Promise<AuthorizedAccount | null> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const res = await client.query(
        `SELECT * FROM comms_authorized_accounts WHERE tenant_id = $1 AND channel = $2 AND account_ref = $3 AND status = 'active'`, [tenantId, channel, accountRef]
      );
      return res.rowCount === 1 ? this.toAccount(res.rows[0] as Record<string, unknown>) : null;
    });
  }

  async listAccounts(tenantId: string, space: MemorySpace): Promise<AuthorizedAccount[]> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const res = await client.query(`SELECT * FROM comms_authorized_accounts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`, [tenantId]);
      return (res.rows as Array<Record<string, unknown>>).map((r) => this.toAccount(r));
    });
  }

  private toAccount(r: Record<string, unknown>): AuthorizedAccount {
    return {
      account_id: r["account_id"] as string, channel: r["channel"] as CommsChannel, account_ref: r["account_ref"] as string, provider: r["provider"] as CommsProvider,
      display_name: (r["display_name"] as string | null) ?? null, status: r["status"] as "active" | "revoked", created_at: iso(r["created_at"]), revoked_at: isoOrNull(r["revoked_at"])
    };
  }

  // ---------------------------------------------------------------- mottakerens avmelding
  /**
   * A-M3: mottakerens STOP gjelder TENANT-bredt: hver av våre kontoer, hvert rom og hver kanal som deler identifikator-navnerom (telefon = SMS + WhatsApp + samtale). `optHash` er `optOutHash` (navnerom, ikke kanal);
   * avsenderkonto og rom er IKKE en del av oppslaget. (Før: kun (kanal, avsender|'*', rom) - en STOP til konto A stoppet ikke konto B, WhatsApp eller AI-ringing, og `*` gjaldt ikke på tvers av rom.)
   */
  async isOptedOut(tenantId: string, optHash: string): Promise<boolean> {
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, async (client) => {
      const res = await client.query(`SELECT 1 FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2 AND status = 'active' LIMIT 1`, [tenantId, optHash]);
      return res.rowCount === 1;
    });
  }

  /**
   * Idempotent og TENANT-bred (A-M3): avmeldingen gjelder mottakeren (`optOutHash`) i hele tenanten (alle kontoer, alle rom, alle kanaler i navnerommet) og leses uavhengig av rom (`isOptedOut`). Radene skrives derimot PER KANAL og
   * PER KILDE (N1, se `OPT_OUT_SLOT`): samme STOP en gang til (samme kanal, samme kilde) gir `created: false`; en STOP på en annen kanal eller fra en annen kilde (f.eks. eieren) får sin EGEN rad, så START på én kanal kun løfter
   * radene for den kanalen og aldri en eierregistrert avmelding. Skrives i rommet kalleren står i.
   */
  async recordOptOut(
    tenantId: string, space: MemorySpace,
    input: { channel: CommsChannel; recipient_hash: string; recipient_hint: string; source: OptOutSource; evidence_ref?: string; recorded_by: string; session_id?: string; task_id?: string }
  ): Promise<{ opt_out_id: string; created: boolean }> {
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, (client) => this.recordOptOutIn(client, tenantId, space, input));
  }

  private async recordOptOutIn(
    client: pg.PoolClient, tenantId: string, space: MemorySpace,
    input: { channel: CommsChannel; recipient_hash: string; recipient_hint: string; source: OptOutSource; evidence_ref?: string; recorded_by: string; session_id?: string; task_id?: string }
  ): Promise<{ opt_out_id: string; created: boolean }> {
    // To samtidige STOP for samme mottaker (f.eks. SMS og WhatsApp i samme sekund) serialiseres, så vi aldri får to aktive rader i SAMME (kanal, kilde)-spor.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340464))", [`comms-optout|${tenantId}|${input.recipient_hash}`]);
    const slot = OPT_OUT_SLOT[input.source];
    const existing = await client.query(
      `SELECT opt_out_id FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2 AND channel = $3 AND account_ref = $4 AND status = 'active' LIMIT 1`,
      [tenantId, input.recipient_hash, input.channel, slot]
    );
    if (existing.rowCount === 1) return { opt_out_id: (existing.rows[0] as { opt_out_id: string }).opt_out_id, created: false };
    const id = newId("optout");
    await client.query(
      `INSERT INTO comms_recipient_opt_outs (tenant_id, opt_out_id, memory_space_id, channel, account_ref, recipient_hash, recipient_hint, source, evidence_ref, recorded_by, session_id, task_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [tenantId, id, space, input.channel, slot, input.recipient_hash, input.recipient_hint, input.source, input.evidence_ref ?? null, input.recorded_by, input.session_id ?? null, input.task_id ?? null, this.clock()]
    );
    return { opt_out_id: id, created: true };
  }

  /**
   * KUN mottakerens egen START kan oppheve en avmelding, og kun en som kom fra et stopp-ord/leverandørfeil og på SAMME kanal som START-en kom på (konservativt: en STOP på SMS opphever ikke en START på WhatsApp - mottakeren må
   * svare START der den ble avmeldt). En avmelding eieren har registrert (`owner_recorded`) eller mottakeren har bedt om utenfor kanalen (`recipient_request`) kan aldri oppheves av et tekstsvar.
   */
  async liftByStartKeyword(tenantId: string, input: { channel: CommsChannel; recipient_hash: string }): Promise<number> {
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, (client) => this.liftIn(client, tenantId, input));
  }

  private async liftIn(client: pg.PoolClient, tenantId: string, input: { channel: CommsChannel; recipient_hash: string }): Promise<number> {
    const res = await client.query(
      `UPDATE comms_recipient_opt_outs SET status = 'lifted', lifted_at = $4, lifted_by = 'inbound_start_keyword'
        WHERE tenant_id = $1 AND channel = $2 AND recipient_hash = $3 AND status = 'active' AND source IN ('inbound_stop_keyword', 'provider_error')`,
      [tenantId, input.channel, input.recipient_hash, this.clock()]
    );
    return res.rowCount ?? 0;
  }

  /** Alle avmeldinger i tenanten (de gjelder tenant-bredt, så listen er det også - på tvers av rom). `account_ref` vises alltid som `*` (alle våre avsendere): kolonnen er internt et kilde-spor (`OPT_OUT_SLOT`), ikke en konto. */
  async listOptOuts(tenantId: string, _space: MemorySpace, limit = 100): Promise<OptOutRow[]> {
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, async (client) => {
      const res = await client.query(`SELECT * FROM comms_recipient_opt_outs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`, [tenantId, Math.min(Math.max(limit, 1), 500)]);
      return (res.rows as Array<Record<string, unknown>>).map((r) => ({
        opt_out_id: r["opt_out_id"] as string, channel: r["channel"] as CommsChannel, account_ref: "*", recipient_hint: (r["recipient_hint"] as string | null) ?? null,
        status: r["status"] as "active" | "lifted", source: r["source"] as OptOutSource, created_at: iso(r["created_at"]), lifted_at: isoOrNull(r["lifted_at"])
      }));
    });
  }

  // ---------------------------------------------------------------- utgående journal
  /**
   * Starter et forsøk - ATOMISK (A-H2). I ÉN transaksjon: (1) to transaksjonsbundne rådgivende låser, alltid i samme rekkefølge (mottaker, så konto - aldri deadlock), serialiserer «tell + reserver» for samme mottaker/konto;
   * (2) en eksisterende, ikke-avslått rad med samme `request_id` gir `replay` (ingenting sendes to ganger, og en gjenspilling telles ikke mot taket mot seg selv); (3) ratetakene telles PÅ NYTT under låsen (READ COMMITTED: alle
   * som holdt låsen før oss har committet og er synlige) - nådd tak gir `cap_exceeded` uten skriving; (4) først da skrives `requested`-raden, som neste i køen ser. Før dette (sjekk i policyen, skriv senere uten lås) så N samtidige
   * sendinger alle «0 sendt» og alle sendte. Låsen holdes kun gjennom denne korte DB-transaksjonen, aldri over leverandørkallet.
   * Journal-nivåets gjenspillingsvern (`INSERT ... ON CONFLICT DO NOTHING` på (tenant, request_id)) står i tillegg til ToolGateway-ledgeren (forsvar i dybden).
   */
  async beginAttempt(tenantId: string, space: MemorySpace, entry: JournalEntryInput, actor: Actor, retentionDays: number, caps: RateCaps): Promise<BeginResult> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      if (caps.recipient !== null) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340463))", [`comms-cap-recipient|${tenantId}|${entry.channel}|${entry.recipient_hash}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340463))", [`comms-cap-account|${tenantId}|${entry.channel}|${entry.account_ref}`]);
      const replay = await this.priorAttemptOf(client, tenantId, entry.request_id);
      if (replay !== null) return replay;
      const now = this.clock();
      if (caps.recipient !== null && (await this.recipientCount(client, tenantId, entry.channel, entry.recipient_hash, caps.recipient.kind, now)) >= caps.recipient.limit) {
        return { kind: "cap_exceeded", scope: "recipient", code: caps.recipient.code } as const;
      }
      if ((await this.accountCount(client, tenantId, entry.channel, entry.account_ref, now)) >= caps.account.limit) return { kind: "cap_exceeded", scope: "account", code: caps.account.code } as const;
      const id = newId("clog");
      const retention = new Date(now.getTime() + retentionDays * 86_400_000);
      const res = await client.query(
        `INSERT INTO comms_outbound_log
           (tenant_id, log_id, memory_space_id, request_id, kind, channel, account_ref, provider, recipient_hash, recipient_hint, purpose, status, rule_evaluation, denial_codes, recipient_proof,
            content_sha256, content_length, ai_disclosure_applied, target_log_id, thread_ref, before_state, person_id, session_id, task_id, source, created_at, updated_at, retention_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'requested',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25,$26)
         ON CONFLICT (tenant_id, request_id) WHERE status <> 'denied' DO NOTHING RETURNING log_id`,
        [tenantId, id, space, entry.request_id, entry.kind, entry.channel, entry.account_ref, entry.provider, entry.recipient_hash, entry.recipient_hint, entry.purpose,
          JSON.stringify(entry.rule_evaluation), JSON.stringify(entry.denial_codes), JSON.stringify(entry.recipient_proof), entry.content_sha256, entry.content_length, entry.ai_disclosure_applied,
          entry.target_log_id ?? null, entry.thread_ref ?? null, entry.before_state === undefined ? null : JSON.stringify(entry.before_state), actor.person_id, actor.session_id, actor.task_id ?? null, entry.source, now, retention]
      );
      if (res.rowCount === 1) return { kind: "started", log_id: id } as const;
      const raced = await this.priorAttemptOf(client, tenantId, entry.request_id);
      if (raced === null) throw new Error("comms_journal_insert_conflict_without_row");
      return raced;
    });
  }

  private async priorAttemptOf(client: pg.PoolClient, tenantId: string, requestId: string): Promise<Extract<BeginResult, { kind: "replay" }> | null> {
    const prior = await client.query(
      `SELECT log_id, status, provider_message_id, before_state->>'request_fingerprint' AS request_fingerprint FROM comms_outbound_log WHERE tenant_id = $1 AND request_id = $2 AND status <> 'denied'`, [tenantId, requestId]
    );
    if (prior.rowCount === 0) return null;
    const row = prior.rows[0] as { log_id: string; status: JournalStatus; provider_message_id: string | null; request_fingerprint: string | null };
    return { kind: "replay", log_id: row.log_id, status: row.status, provider_message_id: row.provider_message_id, request_fingerprint: row.request_fingerprint };
  }

  /** Finnes det allerede et IKKE-avslått forsøk med denne forespørsels-id-en? (`null` = nei.) Eier-ruten bruker det til å la en gjenspilling gå rett til gatewayens ledger i stedet for å vurdere policyen mot en tilstand det første forsøket selv har endret. */
  async findAttempt(tenantId: string, space: MemorySpace, requestId: string): Promise<Extract<BeginResult, { kind: "replay" }> | null> {
    return withMemoryTransaction(this.pool, tenantId, [space], (client) => this.priorAttemptOf(client, tenantId, requestId));
  }

  /** Bevisføring for et AVSLÅTT forsøk (policy). Brenner IKKE forespørsels-id-en (delvis unik indeks utelater `denied`). */
  async recordDenied(tenantId: string, space: MemorySpace, entry: JournalEntryInput, actor: Actor, retentionDays: number): Promise<string> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const id = newId("clog");
      const now = this.clock();
      await client.query(
        `INSERT INTO comms_outbound_log
           (tenant_id, log_id, memory_space_id, request_id, kind, channel, account_ref, provider, recipient_hash, recipient_hint, purpose, status, rule_evaluation, denial_codes, recipient_proof,
            content_sha256, content_length, ai_disclosure_applied, target_log_id, thread_ref, person_id, session_id, task_id, source, created_at, updated_at, retention_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'denied',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24,$25)`,
        [tenantId, id, space, entry.request_id, entry.kind, entry.channel, entry.account_ref, entry.provider, entry.recipient_hash, entry.recipient_hint, entry.purpose,
          JSON.stringify(entry.rule_evaluation), JSON.stringify(entry.denial_codes), JSON.stringify(entry.recipient_proof), entry.content_sha256, entry.content_length, entry.ai_disclosure_applied,
          entry.target_log_id ?? null, entry.thread_ref ?? null, actor.person_id, actor.session_id, actor.task_id ?? null, entry.source, now, new Date(now.getTime() + retentionDays * 86_400_000)]
      );
      return id;
    });
  }

  async settleAttempt(
    tenantId: string, space: MemorySpace, logId: string,
    outcome: { status: "sent" | "failed" | "outcome_unknown"; provider_message_id?: string; thread_ref?: string; after_state?: unknown }
  ): Promise<void> {
    await withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      await client.query(
        `UPDATE comms_outbound_log SET status = $3, provider_message_id = COALESCE($4, provider_message_id), thread_ref = COALESCE($5, thread_ref), after_state = $6, updated_at = $7
          WHERE tenant_id = $1 AND log_id = $2 AND status IN ('requested', 'outcome_unknown')`,
        [tenantId, logId, outcome.status, outcome.provider_message_id ?? null, outcome.thread_ref ?? null, outcome.after_state === undefined ? null : JSON.stringify(outcome.after_state), this.clock()]
      );
    });
  }

  async countRecipient24h(tenantId: string, space: MemorySpace, channel: CommsChannel, recipientHash: string, kind: "message" | "call"): Promise<number> {
    return withMemoryTransaction(this.pool, tenantId, [space], (client) => this.recipientCount(client, tenantId, channel, recipientHash, kind, this.clock()));
  }

  async countAccountHour(tenantId: string, space: MemorySpace, channel: CommsChannel, accountRef: string): Promise<number> {
    return withMemoryTransaction(this.pool, tenantId, [space], (client) => this.accountCount(client, tenantId, channel, accountRef, this.clock()));
  }

  /** Samme SQL for den rådgivende tellingen (policyens tørrkjøring) og den atomiske tellingen under lås i `beginAttempt`: aktive forsøk (requested/sent/outcome_unknown) siste 24 t til mottakeren, per handlingstype. */
  private async recipientCount(client: pg.PoolClient, tenantId: string, channel: CommsChannel, recipientHash: string, kind: "message" | "call", now: Date): Promise<number> {
    const since = new Date(now.getTime() - 24 * 3_600_000);
    const res = await client.query(
      `SELECT count(*)::int AS n FROM comms_outbound_log WHERE tenant_id = $1 AND channel = $2 AND recipient_hash = $3 AND kind = $4 AND status = ANY($5::text[]) AND created_at > $6`,
      [tenantId, channel, recipientHash, kind, ACTIVE_STATUSES, since]
    );
    return (res.rows[0] as { n: number }).n;
  }

  /** Aktive forsøk (alle handlinger) fra kontoen siste time. */
  private async accountCount(client: pg.PoolClient, tenantId: string, channel: CommsChannel, accountRef: string, now: Date): Promise<number> {
    const since = new Date(now.getTime() - 3_600_000);
    const res = await client.query(
      `SELECT count(*)::int AS n FROM comms_outbound_log WHERE tenant_id = $1 AND channel = $2 AND account_ref = $3 AND status = ANY($4::text[]) AND created_at > $5`,
      [tenantId, channel, accountRef, ACTIVE_STATUSES, since]
    );
    return (res.rows[0] as { n: number }).n;
  }

  /** Meldingen Jarvis selv har sendt (status `sent`) med dette leverandør-id-et fra denne kontoen - grunnlaget for «egen melding» ved redigering/sletting. */
  async findSentMessage(tenantId: string, space: MemorySpace, channel: CommsChannel, providerMessageId: string): Promise<{ log_id: string; account_ref: string; recipient_hash: string; thread_ref: string | null } | null> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const res = await client.query(
        `SELECT log_id, account_ref, recipient_hash, thread_ref FROM comms_outbound_log
          WHERE tenant_id = $1 AND channel = $2 AND provider_message_id = $3 AND kind = 'message' AND status = 'sent' ORDER BY created_at DESC LIMIT 1`,
        [tenantId, channel, providerMessageId]
      );
      return res.rowCount === 1 ? (res.rows[0] as { log_id: string; account_ref: string; recipient_hash: string; thread_ref: string | null }) : null;
    });
  }

  async listJournal(tenantId: string, space: MemorySpace, opts: { status?: JournalStatus; limit?: number } = {}): Promise<JournalRow[]> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const res = await client.query(
        `SELECT * FROM comms_outbound_log WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT $3`,
        [tenantId, opts.status ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 200)]
      );
      return (res.rows as Array<Record<string, unknown>>).map((r) => ({
        log_id: r["log_id"] as string, request_id: r["request_id"] as string, kind: r["kind"] as OutboundKind, channel: r["channel"] as CommsChannel, account_ref: r["account_ref"] as string,
        provider: r["provider"] as CommsProvider, recipient_hint: (r["recipient_hint"] as string | null) ?? null, purpose: r["purpose"] as OutboundPurpose, status: r["status"] as JournalStatus,
        denial_codes: (r["denial_codes"] as string[]) ?? [], content_sha256: (r["content_sha256"] as string | null) ?? null, content_length: r["content_length"] as number,
        ai_disclosure_applied: r["ai_disclosure_applied"] as boolean, target_log_id: (r["target_log_id"] as string | null) ?? null, provider_message_id: (r["provider_message_id"] as string | null) ?? null,
        thread_ref: (r["thread_ref"] as string | null) ?? null, person_id: r["person_id"] as string, session_id: r["session_id"] as string, task_id: (r["task_id"] as string | null) ?? null,
        source: r["source"] as JournalSource, created_at: iso(r["created_at"]), updated_at: iso(r["updated_at"])
      }));
    });
  }

  // ---------------------------------------------------------------- innkommende hendelser (kun signaturverifiserte)
  /**
   * `inserted: false` = samme leverandørhendelse er sett før (gjenspilling): ingenting skrives eller utføres en gang til.
   *
   * FIKS B-H2: dedupe-raden og avmeldingen/gjenopptaket (`effect`) skrives i ÉN transaksjon. Før lå de i to: feilet det andre steget etter at dedupe-raden var committet, var leverandørens retry en «duplikat» og mottakerens
   * STOP ble aldri registrert (juridisk tung, lav sannsynlighet). Nå ruller en feil i avmeldingen tilbake HELE hendelsen, og retry behandles på nytt.
   */
  async recordInbound(tenantId: string, space: MemorySpace, input: InboundEventInput, retentionDays: number, effect?: OptEffect): Promise<{ inserted: boolean; event_id: string | null }> {
    // Alle comms-rom er synlige i transaksjonen: avmeldingen er tenant-bred (A-M3), så en eksisterende avmelding i et annet rom må sees (ingen duplikat) og START må kunne oppheve den. Hendelsen selv skrives i `space`.
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, async (client) => {
      const id = newId("cin");
      const now = this.clock();
      const res = await client.query(
        `INSERT INTO comms_inbound_events
           (tenant_id, event_id, memory_space_id, provider, channel, account_ref, event_key, kind, sender_hash, sender_hint, identity_id, thread_ref, content_excerpt, content_sha256,
            trust_level, signature_verified, provider_ts, received_at, retention_until, source, ingest_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'untrusted',true,$15,$16,$17,$18,$19)
         ON CONFLICT (tenant_id, provider, event_key) DO NOTHING RETURNING event_id`,
        [tenantId, id, space, input.provider, input.channel, input.account_ref, input.event_key, input.kind, input.sender_hash, input.sender_hint, input.identity_id, input.thread_ref,
          input.content_excerpt, input.content_sha256, input.provider_ts, now, new Date(now.getTime() + retentionDays * 86_400_000), `webhook:${input.provider}`, input.ingest_id]
      );
      if (res.rowCount !== 1) return { inserted: false, event_id: null };
      if (effect?.kind === "stop") {
        await this.recordOptOutIn(client, tenantId, space, {
          channel: effect.channel, recipient_hash: effect.recipient_hash, recipient_hint: effect.recipient_hint, source: "inbound_stop_keyword", evidence_ref: effect.evidence_ref, recorded_by: "system", task_id: input.ingest_id
        });
      } else if (effect?.kind === "start") {
        await this.liftIn(client, tenantId, { channel: effect.channel, recipient_hash: effect.recipient_hash });
      }
      return { inserted: true, event_id: id };
    });
  }

  /** Mottakerens siste VERIFISERTE innkommende melding til kontoen (server-tid, aldri leverandørens påstand). */
  async lastInboundAt(tenantId: string, space: MemorySpace, channel: CommsChannel, accountRef: string, senderHash: string): Promise<string | null> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const res = await client.query(
        `SELECT max(received_at) AS at FROM comms_inbound_events WHERE tenant_id = $1 AND channel = $2 AND sender_hash = $3 AND kind = 'message' AND account_ref IN ($4, '*')`,
        [tenantId, channel, senderHash, accountRef]
      );
      return isoOrNull((res.rows[0] as { at: unknown }).at);
    });
  }

  async listInbound(tenantId: string, space: MemorySpace, opts: { channel?: CommsChannel; limit?: number } = {}): Promise<InboundEventRow[]> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const res = await client.query(
        `SELECT * FROM comms_inbound_events WHERE tenant_id = $1 AND ($2::text IS NULL OR channel = $2) AND kind = 'message' ORDER BY received_at DESC LIMIT $3`,
        [tenantId, opts.channel ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 200)]
      );
      return (res.rows as Array<Record<string, unknown>>).map((r) => ({
        event_id: r["event_id"] as string, provider: r["provider"] as string, channel: r["channel"] as CommsChannel, account_ref: r["account_ref"] as string, kind: r["kind"] as string,
        sender_hint: (r["sender_hint"] as string | null) ?? null, identity_id: (r["identity_id"] as string | null) ?? null, thread_ref: (r["thread_ref"] as string | null) ?? null,
        content_excerpt: (r["content_excerpt"] as string | null) ?? null, trust_level: "untrusted" as const, received_at: iso(r["received_at"])
      }));
    });
  }

  /** Retensjonssveip: sletter utløpte innkommende hendelser og journalrader for én tenant/space. Returnerer antall (kun tall). */
  async purgeExpired(tenantId: string, space: MemorySpace): Promise<{ inbound: number; journal: number }> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const now = this.clock();
      const inbound = await client.query(`DELETE FROM comms_inbound_events WHERE tenant_id = $1 AND retention_until < $2`, [tenantId, now]);
      const journal = await client.query(`DELETE FROM comms_outbound_log WHERE tenant_id = $1 AND retention_until < $2`, [tenantId, now]);
      return { inbound: inbound.rowCount ?? 0, journal: journal.rowCount ?? 0 };
    });
  }
}
