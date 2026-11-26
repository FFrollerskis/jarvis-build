import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import { withMemoryTransaction } from "@jarvis/memory";
import { containsSecret } from "@jarvis/core";
import { PROVIDERS_FOR_CHANNEL, isValidAccountRef, sha256Hex, type CommsChannel, type CommsProvider } from "./channels.ts";
import { textIsSendable, type OutboundKind, type OutboundPurpose, type RateCaps, type RecipientProof, type RuleResult } from "./policy.ts";

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

/**
 * FIX-3 (WP-G1c fiks-runde 1): tie-marginen en START må ha til en STOP for å løfte den. En START løfter KUN en avmelding hvis registreringssekvensen er lavere enn START-ens mottakssekvens OG den siste STOP-en ble registrert MER enn denne marginen
 * før START-en ble mottatt (begge tidspunkt er DATABASENS klokke, `clock_timestamp()` i samme setning som sekvensen). Innenfor marginen vinner STOP, uansett sekvens og uansett hvilken transaksjon som rakk å allokere først: «samtidig» betyr «innenfor
 * marginen», ikke «samme millisekund». Uten marginen avgjorde den som tilfeldigvis allokerte sekvensen først (en START mottatt mens en STOP holdt låsen ucommittet kunne løfte den, og mottakeren ble FRI). 5 s: mye lengre enn en transaksjon
 * (millisekunder, også på NAS) og enn skjevheten mellom to forespørsler som ankom «samtidig», men kortere enn noe et menneske gjør (en START rett etter en STOP). En START innenfor marginen er IKKE tapt som hendelse (kvitteringen og dedupe-raden
 * står), men løfter ingenting - mottakeren forblir avmeldt (strengeste regel) og må sende START på nytt.
 * RESTRISIKO (akseptert): en leverandør som leverer i feil rekkefølge eller forsinket (Twilio har ingen signert tidsstempel å avgjøre på) kan fortsatt gi en annen rekkefølge enn mottakeren sendte; marginen dekker kun plattformens egen behandling.
 */
export const START_TIE_MARGIN_MS = 5000;

export interface CommsStoreOptions {
  /** Tie-marginen i millisekunder (standard `START_TIE_MARGIN_MS`). `0` = ren sekvensmodell (kun testene, som legger inn en STOP og straks en START og forventer at den løfter). Negativt eller ikke-endelig er en feil. */
  readonly startTieMarginMs?: number;
}

/** Plattformens sekvensnummer (`comms_event_seq`) og DATABASENS klokke i SAMME setning - aldri leverandørens tid. */
export interface OptReceipt {
  readonly seq: number;
  readonly at: Date;
}

export type OptOutLifter = "inbound_start_keyword" | "owner_undo";

export interface OptOutRow {
  readonly opt_out_id: string;
  readonly channel: CommsChannel;
  readonly account_ref: string;
  readonly recipient_hint: string | null;
  readonly status: "active" | "lifted";
  readonly source: OptOutSource;
  readonly created_at: string;
  readonly lifted_at: string | null;
  /** K5: hvem opphevet avmeldingen (mottakerens START eller eierens angre). `null` så lenge den er aktiv. */
  readonly lifted_by: OptOutLifter | null;
  /** K5: eierens begrunnelse for en angre (kun for `owner_undo`). */
  readonly lift_reason: string | null;
}

/** K5: den ferske, MINIMALE lesingen av en avmelding eieren vurderer å oppheve (preflight/readback i klasse D-kjeden). Aldri hele mottakeren - kun den maskerte visningen. */
export interface OptOutTarget {
  readonly exists: true;
  readonly opt_out_id: string;
  readonly channel: CommsChannel;
  readonly recipient_hint: string | null;
  readonly source: OptOutSource;
  /** Kun `owner_recorded` kan oppheves av eieren (databasetriggeren håndhever det også). */
  readonly liftable_by_owner: boolean;
}

export interface OwnerLiftResult {
  readonly lifted: boolean;
  readonly channel: CommsChannel;
  readonly recipient_hint: string | null;
  /** Mottakeren kan fortsatt være avmeldt via en ANNEN, aktiv rad (mottakerens eget stopp-ord, en annen kanal, en mottakerbedt avmelding): eierens angre fjerner kun den eierregistrerte raden. */
  readonly still_opted_out: boolean;
}

/**
 * K5: begrunnelsen for en eier-angre: kort, én linje, uten kontrolltegn og uten hemmeligheter (samme regler som `purpose_basis_note`). Returnerer den trimmede teksten, eller `null` når den er ugyldig.
 * Obligatorisk: en angre uten begrunnelse finnes ikke (DB-CHECK krever 3-200 tegn for `owner_undo`).
 */
export function validateLiftReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  if (trimmed.length < 3 || trimmed.length > 200 || !textIsSendable(trimmed) || /[\r\n\t]/u.test(trimmed) || containsSecret(trimmed)) return null;
  return trimmed;
}

/** K4 (JARVIS-112 f1): en kontaktkonflikt `contacts_sync` fant. `shared_identity` = identifikatorene eies allerede av en ANNEN kontakt (kan godtas av eieren); `split_identities` = de peker på ULIKE identiteter (kan aldri godtas: ville vært en sammenslåing). */
export type ContactConflictKind = "shared_identity" | "split_identities";
export type ContactConflictStatus = "proposed" | "accepted" | "dismissed";
/** Et lagret konfliktforslag. Kun Googles ugjennomsiktige ressursnavn: aldri telefon, e-post eller navn. */
export interface ContactConflictRow {
  readonly conflict_id: string;
  readonly resource_name: string;
  readonly kind: ContactConflictKind;
  readonly conflicting_resources: readonly string[];
  readonly status: ContactConflictStatus;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly seen_count: number;
  readonly decided_at: string | null;
}
/** Fingerprint (SHA-256 hex) av en konflikt: samme kontakt + art + sortert konfliktsett gir alltid samme verdi (idempotens); endres settet, er det et NYTT forslag. */
export function contactConflictFingerprint(resourceName: string, kind: ContactConflictKind, conflictingResources: readonly string[]): string {
  return sha256Hex(JSON.stringify(["comms-contact-conflict-v1", resourceName, kind, [...new Set(conflictingResources)].sort()]));
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
  /** K1: 2 = HMAC-SHA256 med server-side pepper; 1 = den gamle, usaltede SHA-256 (rader skrevet før WP-G1c). */
  readonly content_hash_version: number;
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
  | { readonly kind: "replay"; readonly log_id: string; readonly status: JournalStatus; readonly provider_message_id: string | null; readonly request_fingerprint: string | null; readonly fingerprint_version: number | null }
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
  private readonly startTieMarginMs: number;

  constructor(private readonly pool: pg.Pool, private readonly clock: Clock = () => new Date(), options: CommsStoreOptions = {}) {
    const margin = options.startTieMarginMs ?? START_TIE_MARGIN_MS;
    if (!Number.isFinite(margin) || margin < 0) throw new Error("comms_invalid_start_tie_margin");
    this.startTieMarginMs = margin;
  }

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

  /**
   * K2 (JARVIS-112 c): ALL avmeldings-skriving og -opphevelse for en mottaker serialiseres bak denne ENE advisory-låsen (per tenant + mottakerens navnerom-hash; strengere enn (tenant, mottaker, kanal), så en STOP på SMS og en START på
   * WhatsApp for samme nummer heller aldri kjører om hverandre). Låsen er transaksjonsbundet (frigis ved COMMIT/ROLLBACK) og re-entrant innen samme transaksjon.
   */
  private async lockRecipient(client: pg.PoolClient, tenantId: string, recipientHash: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340464))", [`comms-optout|${tenantId}|${recipientHash}`]);
  }

  /**
   * Plattformens monotone sekvens (`comms_event_seq`, CACHE 1: strengt økende på tvers av tilkoblinger): mottakssekvens for en START og registreringssekvens for en STOP, sammen med DATABASENS klokke i SAMME setning (tie-marginen, FIX-3).
   * Aldri leverandørens tidsstempel.
   */
  private async nextSeq(client: pg.PoolClient): Promise<OptReceipt> {
    const res = await client.query("SELECT nextval('comms_event_seq')::text AS seq, clock_timestamp() AS at");
    const row = res.rows[0] as { seq: string; at: Date };
    return { seq: Number(row.seq), at: row.at };
  }

  private async recordOptOutIn(
    client: pg.PoolClient, tenantId: string, space: MemorySpace,
    input: { channel: CommsChannel; recipient_hash: string; recipient_hint: string; source: OptOutSource; evidence_ref?: string; recorded_by: string; session_id?: string; task_id?: string }
  ): Promise<{ opt_out_id: string; created: boolean }> {
    // To samtidige STOP for samme mottaker (f.eks. SMS og WhatsApp i samme sekund) serialiseres, så vi aldri får to aktive rader i SAMME (kanal, kilde)-spor.
    await this.lockRecipient(client, tenantId, input.recipient_hash);
    // K2: registreringssekvensen allokeres UNDER låsen - en START som ble mottatt FØR denne registreringen (mindre sekvens) kan aldri løfte den. FIX-3: registreringstiden (databasens klokke, samme setning) er den andre halvdelen: en START som ble
    // mottatt mindre enn `START_TIE_MARGIN_MS` etter denne registreringen kan heller ikke løfte den (en START mottatt mens denne transaksjonen holdt låsen ucommittet har høyere sekvens, men er innenfor marginen).
    const { seq, at } = await this.nextSeq(client);
    const slot = OPT_OUT_SLOT[input.source];
    const existing = await client.query(
      `SELECT opt_out_id FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2 AND channel = $3 AND account_ref = $4 AND status = 'active' LIMIT 1`,
      [tenantId, input.recipient_hash, input.channel, slot]
    );
    if (existing.rowCount === 1) {
      // En senere STOP i samme spor «absorberes» i raden, men registreringen mistes ikke: sekvensen økes, så en START som ble mottatt før denne STOP-en aldri kan løfte raden.
      const id = (existing.rows[0] as { opt_out_id: string }).opt_out_id;
      // `GREATEST`: registreringstiden kan aldri gå bakover (triggeren avviser det), heller ikke om databasens klokke skulle stilles tilbake - en STOP skal aldri feile på det.
      await client.query(
        `UPDATE comms_recipient_opt_outs SET stop_seq = $3, stop_db_at = GREATEST(COALESCE(stop_db_at, $4::timestamptz), $4::timestamptz) WHERE tenant_id = $1 AND opt_out_id = $2 AND (stop_seq IS NULL OR stop_seq < $3)`,
        [tenantId, id, seq, at]
      );
      return { opt_out_id: id, created: false };
    }
    const id = newId("optout");
    await client.query(
      `INSERT INTO comms_recipient_opt_outs (tenant_id, opt_out_id, memory_space_id, channel, account_ref, recipient_hash, recipient_hint, source, evidence_ref, recorded_by, session_id, task_id, created_at, stop_seq, stop_db_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [tenantId, id, space, input.channel, slot, input.recipient_hash, input.recipient_hint, input.source, input.evidence_ref ?? null, input.recorded_by, input.session_id ?? null, input.task_id ?? null, this.clock(), seq, at]
    );
    return { opt_out_id: id, created: true };
  }

  /**
   * KUN mottakerens egen START kan oppheve en avmelding, og kun en som kom fra et stopp-ord/leverandørfeil og på SAMME kanal som START-en kom på (konservativt: en STOP på SMS opphever ikke en START på WhatsApp - mottakeren må
   * svare START der den ble avmeldt). En avmelding eieren har registrert (`owner_recorded`) eller mottakeren har bedt om utenfor kanalen (`recipient_request`) kan aldri oppheves av et tekstsvar (håndhevet av databasetriggeren, 141).
   * K2: `recv` er START-ens mottak (sekvens og databasetid); utelatt = «mottatt nå» (ny sekvens). En START løfter KUN rader hvis registreringssekvens er mindre enn mottakssekvensen OG (FIX-3) hvis siste STOP ble registrert mer enn
   * `START_TIE_MARGIN_MS` før mottaket - innenfor marginen vinner STOP.
   */
  async liftByStartKeyword(tenantId: string, input: { channel: CommsChannel; recipient_hash: string }, recv?: OptReceipt): Promise<number> {
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, async (client) => {
      await this.lockRecipient(client, tenantId, input.recipient_hash);
      return this.liftIn(client, tenantId, input, recv ?? (await this.nextSeq(client)));
    });
  }

  private async liftIn(client: pg.PoolClient, tenantId: string, input: { channel: CommsChannel; recipient_hash: string }, recv: OptReceipt): Promise<number> {
    // `COALESCE(stop_seq, 0)`: en rad fra før migrasjon 141 har ingen registreringssekvens og regnes som eldre enn enhver START (uendret atferd for gamle rader); `stop_db_at IS NULL` på samme måte (ingen registreringstid = gammel).
    // Marginen `<= 0` (kun testene) er den rene sekvensmodellen. Streng ulikhet: en STOP nøyaktig på marginen er fortsatt et uavgjort (STOP vinner).
    const res = await client.query(
      `UPDATE comms_recipient_opt_outs SET status = 'lifted', lifted_at = $4, lifted_by = 'inbound_start_keyword'
        WHERE tenant_id = $1 AND channel = $2 AND recipient_hash = $3 AND status = 'active' AND source IN ('inbound_stop_keyword', 'provider_error') AND COALESCE(stop_seq, 0) < $5
          AND ($7::double precision <= 0 OR stop_db_at IS NULL OR stop_db_at < $6::timestamptz - ($7::double precision * interval '1 millisecond'))`,
      [tenantId, input.channel, input.recipient_hash, this.clock(), recv.seq, recv.at, this.startTieMarginMs]
    );
    return res.rowCount ?? 0;
  }

  /**
   * K2: persisterer FØRSTE mottak av en opt-in-/opt-out-hendelse i en EGEN, committet transaksjon FØR behandlingen. Returnerer plattformens mottak for hendelsen (sekvens og databasetid): det som ble tildelt ved første mottak, også når leverandøren
   * leverer samme hendelse en gang til (retry etter en feil midtveis). Uten dette fikk en retry en NY, større sekvens og kunne løfte en STOP som ble registrert etter den opprinnelige START-en.
   */
  async receiveOptEvent(tenantId: string, space: MemorySpace, input: { provider: InboundEventInput["provider"]; event_key: string; kind: "opt_in" | "opt_out"; ingest_id: string }, retentionDays: number): Promise<OptReceipt> {
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, async (client) => {
      const { seq, at } = await this.nextSeq(client);
      const now = this.clock();
      const inserted = await client.query(
        `INSERT INTO comms_inbound_receipts (tenant_id, memory_space_id, provider, event_key, kind, recv_seq, recv_db_at, received_at, retention_until, source, ingest_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, provider, event_key) DO NOTHING RETURNING recv_seq, recv_db_at`,
        [tenantId, space, input.provider, input.event_key, input.kind, seq, at, now, new Date(now.getTime() + retentionDays * 86_400_000), `webhook:${input.provider}`, input.ingest_id]
      );
      if (inserted.rowCount === 1) { const r = inserted.rows[0] as { recv_seq: string; recv_db_at: Date }; return { seq: Number(r.recv_seq), at: r.recv_db_at }; }
      const first = await client.query(`SELECT recv_seq, recv_db_at FROM comms_inbound_receipts WHERE tenant_id = $1 AND provider = $2 AND event_key = $3`, [tenantId, input.provider, input.event_key]);
      if (first.rowCount !== 1) throw new Error("comms_receipt_conflict_without_row");
      const r = first.rows[0] as { recv_seq: string; recv_db_at: Date };
      return { seq: Number(r.recv_seq), at: r.recv_db_at };
    });
  }

  /**
   * K5 (JARVIS-112 f2): den ferske, MINIMALE lesingen av en AKTIV avmelding (preflight og readback for `lift_owner_opt_out`). `null` = finnes ikke eller er allerede opphevet (etterbetingelsen «målet er borte»). Aldri hele mottakeren.
   */
  async findOptOutTarget(tenantId: string, optOutId: string): Promise<OptOutTarget | null> {
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, async (client) => {
      const res = await client.query(`SELECT opt_out_id, channel, recipient_hint, source FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = $2 AND status = 'active'`, [tenantId, optOutId]);
      if (res.rowCount !== 1) return null;
      const r = res.rows[0] as { opt_out_id: string; channel: CommsChannel; recipient_hint: string | null; source: OptOutSource };
      return { exists: true as const, opt_out_id: r.opt_out_id, channel: r.channel, recipient_hint: r.recipient_hint ?? null, source: r.source, liftable_by_owner: r.source === "owner_recorded" };
    });
  }

  /**
   * K5 (JARVIS-112 f2, Q-72 pkt 10): EIERENS angre av en FEILREGISTRERT STOP. Den ENESTE veien utenom mottakerens egen START, og kun for en `owner_recorded`-rad - aldri `recipient_request`, aldri en mottakers eget stopp-ord eller en
   * leverandørfeil (databasetriggeren, 141, håndhever det også mot en kodefeil). Obligatorisk begrunnelse (`validateLiftReason`), og person/sesjon/oppgave lagres på raden (revisjonsspor, regel 4). Tar samme lås som STOP/START.
   * Opphever KUN den ene raden: mottakeren kan fortsatt være avmeldt via en annen aktiv rad (`still_opted_out`). Idempotent: en allerede opphevet rad gir `lifted: false`.
   */
  async liftOwnerOptOut(tenantId: string, input: { opt_out_id: string; reason: string }, actor: Actor): Promise<OwnerLiftResult> {
    const reason = validateLiftReason(input.reason);
    if (reason === null) throw new Error("comms_invalid_parameters:lift_reason_invalid");
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, async (client) => {
      const peek = await client.query(`SELECT recipient_hash FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = $2`, [tenantId, input.opt_out_id]);
      if (peek.rowCount !== 1) throw new Error("comms_opt_out_not_found");
      const hash = (peek.rows[0] as { recipient_hash: string }).recipient_hash;
      await this.lockRecipient(client, tenantId, hash);
      const cur = await client.query(`SELECT channel, recipient_hint, source, status FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND opt_out_id = $2 FOR UPDATE`, [tenantId, input.opt_out_id]);
      const row = cur.rows[0] as { channel: CommsChannel; recipient_hint: string | null; source: OptOutSource; status: "active" | "lifted" } | undefined;
      if (row === undefined) throw new Error("comms_opt_out_not_found");
      const remaining = async (): Promise<boolean> => ((await client.query(`SELECT 1 FROM comms_recipient_opt_outs WHERE tenant_id = $1 AND recipient_hash = $2 AND status = 'active' LIMIT 1`, [tenantId, hash])).rowCount ?? 0) > 0;
      if (row.status === "lifted") return { lifted: false, channel: row.channel, recipient_hint: row.recipient_hint ?? null, still_opted_out: await remaining() };
      // Appens egen sjekk (tydelig feil); triggeren er den siste, uavhengige porten.
      if (row.source !== "owner_recorded") throw new Error(`comms_opt_out_not_liftable_by_owner:${row.source}`);
      await client.query(
        `UPDATE comms_recipient_opt_outs SET status = 'lifted', lifted_at = $3, lifted_by = 'owner_undo', lift_reason = $4, lifted_by_person_id = $5, lift_session_id = $6, lift_task_id = $7
          WHERE tenant_id = $1 AND opt_out_id = $2 AND status = 'active' AND source = 'owner_recorded'`,
        [tenantId, input.opt_out_id, this.clock(), reason, actor.person_id, actor.session_id, actor.task_id ?? null]
      );
      return { lifted: true, channel: row.channel, recipient_hint: row.recipient_hint ?? null, still_opted_out: await remaining() };
    });
  }

  /** Alle avmeldinger i tenanten (de gjelder tenant-bredt, så listen er det også - på tvers av rom). `account_ref` vises alltid som `*` (alle våre avsendere): kolonnen er internt et kilde-spor (`OPT_OUT_SLOT`), ikke en konto. */
  async listOptOuts(tenantId: string, _space: MemorySpace, limit = 100): Promise<OptOutRow[]> {
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, async (client) => {
      const res = await client.query(`SELECT * FROM comms_recipient_opt_outs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`, [tenantId, Math.min(Math.max(limit, 1), 500)]);
      return (res.rows as Array<Record<string, unknown>>).map((r) => ({
        opt_out_id: r["opt_out_id"] as string, channel: r["channel"] as CommsChannel, account_ref: "*", recipient_hint: (r["recipient_hint"] as string | null) ?? null,
        status: r["status"] as "active" | "lifted", source: r["source"] as OptOutSource, created_at: iso(r["created_at"]), lifted_at: isoOrNull(r["lifted_at"]),
        lifted_by: (r["lifted_by"] as OptOutLifter | null) ?? null, lift_reason: (r["lift_reason"] as string | null) ?? null
      }));
    });
  }

  // ---------------------------------------------------------------- kontaktkonflikt-forslag (K4, migrasjon 143)
  /**
   * Lagrer (idempotent) en konflikt `contacts_sync` fant. Samme kontakt + art + konfliktsett i samme rom gir SAMME rad (teller og sist-sett økes, ingenting annet endres - en allerede avgjort konflikt forblir avgjort). Et endret konfliktsett er et NYTT forslag.
   * Kun ressursnavn lagres (aldri telefon, e-post eller navn).
   */
  async recordContactConflict(
    tenantId: string, space: MemorySpace, input: { resource_name: string; kind: ContactConflictKind; conflicting_resources: readonly string[] }, actor: Actor
  ): Promise<{ conflict_id: string; status: ContactConflictStatus; created: boolean }> {
    const conflicting = input.kind === "shared_identity" ? [...new Set(input.conflicting_resources)].sort().slice(0, 20) : [];
    const fingerprint = contactConflictFingerprint(input.resource_name, input.kind, conflicting);
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const now = this.clock();
      const res = await client.query(
        `INSERT INTO comms_contact_conflicts (tenant_id, conflict_id, memory_space_id, resource_name, kind, conflicting_resources, fingerprint, first_seen_at, last_seen_at, detected_by_person_id, detect_session_id, detect_task_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, memory_space_id, resource_name, fingerprint) DO UPDATE
           SET last_seen_at = GREATEST(comms_contact_conflicts.last_seen_at, EXCLUDED.last_seen_at), seen_count = comms_contact_conflicts.seen_count + 1
         RETURNING conflict_id, status, (xmax = 0) AS created`,
        [tenantId, newId("ccf"), space, input.resource_name, input.kind, JSON.stringify(conflicting), fingerprint, now, actor.person_id, actor.session_id, actor.task_id ?? null]
      );
      const r = res.rows[0] as { conflict_id: string; status: ContactConflictStatus; created: boolean };
      return { conflict_id: r.conflict_id, status: r.status, created: r.created };
    });
  }

  private contactConflictOf(r: Record<string, unknown>): ContactConflictRow {
    return {
      conflict_id: r["conflict_id"] as string, resource_name: r["resource_name"] as string, kind: r["kind"] as ContactConflictKind, conflicting_resources: ((r["conflicting_resources"] as string[] | null) ?? []).map(String),
      status: r["status"] as ContactConflictStatus, first_seen_at: iso(r["first_seen_at"]), last_seen_at: iso(r["last_seen_at"]), seen_count: Number(r["seen_count"]), decided_at: isoOrNull(r["decided_at"])
    };
  }

  /** Konfliktforslag i rommet, nyeste først (standard: kun åpne forslag). */
  async listContactConflicts(tenantId: string, space: MemorySpace, opts: { status?: ContactConflictStatus; limit?: number } = {}): Promise<ContactConflictRow[]> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const res = await client.query(
        `SELECT conflict_id, resource_name, kind, conflicting_resources, status, first_seen_at, last_seen_at, seen_count, decided_at FROM comms_contact_conflicts
          WHERE tenant_id = $1 AND status = $2 ORDER BY last_seen_at DESC, conflict_id LIMIT $3`,
        [tenantId, opts.status ?? "proposed", Math.min(Math.max(opts.limit ?? 50, 1), 200)]
      );
      return (res.rows as Array<Record<string, unknown>>).map((r) => this.contactConflictOf(r));
    });
  }

  async getContactConflict(tenantId: string, space: MemorySpace, conflictId: string): Promise<ContactConflictRow | null> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const res = await client.query(
        `SELECT conflict_id, resource_name, kind, conflicting_resources, status, first_seen_at, last_seen_at, seen_count, decided_at FROM comms_contact_conflicts WHERE tenant_id = $1 AND conflict_id = $2`, [tenantId, conflictId]
      );
      return res.rowCount === 1 ? this.contactConflictOf(res.rows[0] as Record<string, unknown>) : null;
    });
  }

  /**
   * Eierens avgjørelse. `accepted` er bare lov for `shared_identity` (databasen håndhever det også). Kan ombestemmes mellom godtatt og avvist; et forslag blir aldri åpent igjen. Returnerer `null` når forslaget ikke finnes.
   * (Selve lenkingen ved `accepted` gjøres av kalleren FØR statusen settes; en avvisning av en tidligere godtatt konflikt tilbakekaller IKKE lenkene - det gjør `contacts_unlink`.)
   */
  async decideContactConflict(tenantId: string, space: MemorySpace, conflictId: string, decision: "accepted" | "dismissed", actor: Actor): Promise<ContactConflictRow | null> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const cur = await client.query(`SELECT kind FROM comms_contact_conflicts WHERE tenant_id = $1 AND conflict_id = $2 FOR UPDATE`, [tenantId, conflictId]);
      if (cur.rowCount !== 1) return null;
      if (decision === "accepted" && (cur.rows[0] as { kind: ContactConflictKind }).kind !== "shared_identity") throw new Error("comms_contact_conflict_not_acceptable:split_identities");
      const res = await client.query(
        `UPDATE comms_contact_conflicts SET status = $3, decided_at = $4, decided_by_person_id = $5, decision_session_id = $6, decision_task_id = $7
          WHERE tenant_id = $1 AND conflict_id = $2
          RETURNING conflict_id, resource_name, kind, conflicting_resources, status, first_seen_at, last_seen_at, seen_count, decided_at`,
        [tenantId, conflictId, decision, this.clock(), actor.person_id, actor.session_id, actor.task_id ?? null]
      );
      return this.contactConflictOf(res.rows[0] as Record<string, unknown>);
    });
  }

  /**
   * Kildene eieren har GODTATT at `resourceName` deler identitet med - i begge retninger (en godtatt konflikt for A mot B gjelder også når B synkes). Brukes av `contacts_sync` som `allow_shared_with`; en kontakt uten godtatte konflikter gir en tom liste (da gjelder
   * den vanlige regelen: enhver annen eier er en konflikt).
   */
  async acceptedConflictPartners(tenantId: string, space: MemorySpace, resourceName: string): Promise<string[]> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const res = await client.query(
        `SELECT partner FROM (
           SELECT jsonb_array_elements_text(conflicting_resources) AS partner FROM comms_contact_conflicts WHERE tenant_id = $1 AND status = 'accepted' AND resource_name = $2
           UNION
           SELECT resource_name AS partner FROM comms_contact_conflicts WHERE tenant_id = $1 AND status = 'accepted' AND conflicting_resources ? $2
         ) x WHERE partner <> $2 ORDER BY partner`,
        [tenantId, resourceName]
      );
      return (res.rows as Array<{ partner: string }>).map((r) => r.partner);
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
    // Alle comms-rom er synlige (A-H2 rest, LEDER-AVGJØRELSE): per-mottaker-døgntaket gjelder TENANT-bredt på tvers av rom, i samsvar med tenant-bred STOP (et nummer er ÉN mottaker uansett hvilket rom vi sender fra). Kontotaket er
    // fortsatt per konto (konto-allowlisten er per tenant, og telles over alle rom kontoen har stått i). Raden skrives i `space`; gjenspillingsvernet (unik indeks på (tenant, request_id)) er også tenant-bredt.
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, async (client) => {
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
            content_sha256, content_length, ai_disclosure_applied, target_log_id, thread_ref, before_state, person_id, session_id, task_id, source, created_at, updated_at, retention_until, content_hash_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'requested',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25,$26,2)
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
      `SELECT log_id, status, provider_message_id, before_state->>'request_fingerprint' AS request_fingerprint, NULLIF(before_state->>'v', '')::int AS fingerprint_version
         FROM comms_outbound_log WHERE tenant_id = $1 AND request_id = $2 AND status <> 'denied'`, [tenantId, requestId]
    );
    if (prior.rowCount === 0) return null;
    const row = prior.rows[0] as { log_id: string; status: JournalStatus; provider_message_id: string | null; request_fingerprint: string | null; fingerprint_version: number | null };
    return { kind: "replay", log_id: row.log_id, status: row.status, provider_message_id: row.provider_message_id, request_fingerprint: row.request_fingerprint, fingerprint_version: row.fingerprint_version ?? null };
  }

  /** Finnes det allerede et IKKE-avslått forsøk med denne forespørsels-id-en? (`null` = nei.) Eier-ruten bruker det til å la en gjenspilling gå rett til gatewayens ledger i stedet for å vurdere policyen mot en tilstand det første forsøket selv har endret. */
  async findAttempt(tenantId: string, _space: MemorySpace, requestId: string): Promise<Extract<BeginResult, { kind: "replay" }> | null> {
    // Tenant-bredt (alle comms-rom): den unike indeksen på (tenant, request_id) er det, og ledgeren er ikke rom-skopet - en forespørsels-id brukt i ett rom skal aldri se «ny» ut fra et annet (ellers `ok + deduplicated` uten sending).
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, (client) => this.priorAttemptOf(client, tenantId, requestId));
  }

  /** Bevisføring for et AVSLÅTT forsøk (policy). Brenner IKKE forespørsels-id-en (delvis unik indeks utelater `denied`). */
  async recordDenied(tenantId: string, space: MemorySpace, entry: JournalEntryInput, actor: Actor, retentionDays: number): Promise<string> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const id = newId("clog");
      const now = this.clock();
      await client.query(
        `INSERT INTO comms_outbound_log
           (tenant_id, log_id, memory_space_id, request_id, kind, channel, account_ref, provider, recipient_hash, recipient_hint, purpose, status, rule_evaluation, denial_codes, recipient_proof,
            content_sha256, content_length, ai_disclosure_applied, target_log_id, thread_ref, person_id, session_id, task_id, source, created_at, updated_at, retention_until, content_hash_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'denied',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24,$25,2)`,
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

  async countRecipient24h(tenantId: string, _space: MemorySpace, channel: CommsChannel, recipientHash: string, kind: "message" | "call"): Promise<number> {
    // Tenant-bredt (samme tall som den atomiske tellingen i `beginAttempt`): policyens tørrkjøring skal aldri være mildere enn håndhevelsen.
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, (client) => this.recipientCount(client, tenantId, channel, recipientHash, kind, this.clock()));
  }

  async countAccountHour(tenantId: string, _space: MemorySpace, channel: CommsChannel, accountRef: string): Promise<number> {
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, (client) => this.accountCount(client, tenantId, channel, accountRef, this.clock()));
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
        denial_codes: (r["denial_codes"] as string[]) ?? [], content_sha256: (r["content_sha256"] as string | null) ?? null, content_hash_version: Number(r["content_hash_version"] ?? 1), content_length: r["content_length"] as number,
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
    // K2: en START får sin MOTTAKSSEKVENS persistert i en egen, committet transaksjon FØR behandlingen. Feiler behandlingen under og leverandøren prøver på nytt, bruker retry-en den OPPRINNELIGE sekvensen - en forsinket START kan
    // aldri løfte en STOP som ble registrert etter at den først ble mottatt.
    const startRecv = effect?.kind === "start"
      ? await this.receiveOptEvent(tenantId, space, { provider: input.provider, event_key: input.event_key, kind: "opt_in", ingest_id: input.ingest_id }, retentionDays)
      : undefined;
    // Alle comms-rom er synlige i transaksjonen: avmeldingen er tenant-bred (A-M3), så en eksisterende avmelding i et annet rom må sees (ingen duplikat) og START må kunne oppheve den. Hendelsen selv skrives i `space`.
    return withMemoryTransaction(this.pool, tenantId, COMMS_SPACES, async (client) => {
      // K2: ALL behandling av en STOP/START for samme mottaker serialiseres fra første statement (før dedupe-raden), så to leveranser av samme hendelse eller en STOP og en START aldri kjører om hverandre.
      if (effect !== undefined) await this.lockRecipient(client, tenantId, effect.recipient_hash);
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
        await this.liftIn(client, tenantId, { channel: effect.channel, recipient_hash: effect.recipient_hash }, startRecv as OptReceipt);
      }
      return { inserted: true, event_id: id };
    });
  }

  /**
   * FIX-2: hvilke av disse hendelsesnøklene er allerede sett (dedupe-raden finnes)? En dedupe-rad og avmeldingen/gjenopptaket den hører til skrives i ÉN transaksjon (B-H2), så en kjent nøkkel er FERDIG behandlet og kan hoppes over uten arbeid.
   * Kun en lesing (RLS: tenant og rom); selve dedupe-garantien er fortsatt `ON CONFLICT DO NOTHING` i `recordInbound`, så en samtidig levering av samme hendelse gir uansett nøyaktig én behandling.
   */
  async knownEventKeys(tenantId: string, space: MemorySpace, provider: InboundEventInput["provider"], keys: readonly string[]): Promise<ReadonlySet<string>> {
    const known = new Set<string>();
    if (keys.length === 0) return known;
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      for (let i = 0; i < keys.length; i += 1000) {
        const res = await client.query(`SELECT event_key FROM comms_inbound_events WHERE tenant_id = $1 AND provider = $2 AND event_key = ANY($3::text[])`, [tenantId, provider, keys.slice(i, i + 1000)]);
        for (const row of res.rows as Array<{ event_key: string }>) known.add(row.event_key);
      }
      return known;
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

  /**
   * Retensjonssveip: sletter utløpte innkommende hendelser, første-mottak-rader og journalrader for én tenant/space. Returnerer antall (kun tall). Databasen avviser sletting av en journal-/mottaksrad hvis `retention_until`
   * ikke har passert på DATABASENS klokke (triggeren i 141/142), uansett hva appens klokke sier; `comms_inbound_events` har ikke dette vernet (uendret).
   */
  async purgeExpired(tenantId: string, space: MemorySpace): Promise<{ inbound: number; journal: number; receipts: number }> {
    return withMemoryTransaction(this.pool, tenantId, [space], async (client) => {
      const now = this.clock();
      const inbound = await client.query(`DELETE FROM comms_inbound_events WHERE tenant_id = $1 AND retention_until < $2`, [tenantId, now]);
      // `LEAST($2, now())`: aldri et utvalg databasen selv ville avvist (appens klokke foran databasens, eller en injisert fremtidig testklokke) - da ville HELE sletteoperasjonen feilet på triggeren i stedet for å hoppe over raden.
      const receipts = await client.query(`DELETE FROM comms_inbound_receipts WHERE tenant_id = $1 AND retention_until < LEAST($2::timestamptz, now())`, [tenantId, now]);
      const journal = await client.query(`DELETE FROM comms_outbound_log WHERE tenant_id = $1 AND retention_until < LEAST($2::timestamptz, now())`, [tenantId, now]);
      return { inbound: inbound.rowCount ?? 0, journal: journal.rowCount ?? 0, receipts: receipts.rowCount ?? 0 };
    });
  }
}
