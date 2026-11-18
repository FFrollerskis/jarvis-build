import type pg from "pg";
import type { MemorySpace } from "@jarvis/contracts";
import type { BusinessService } from "@jarvis/business";
import { withMemoryTransaction } from "@jarvis/memory";
import type { CommsChannel } from "./channels.ts";
import type { Clock } from "./store.ts";

/**
 * WP-G1 (D-463, P3i): oppfølgingssveipet for UBESVARTE meldinger (`JARVIS_COMMS_REPLY_SWEEP=on`, AV som standard, NOT VERIFIED). Et verifisert innkommende budskap uten svar fra oss etter `JARVIS_COMMS_REPLY_AFTER_HOURS` (standard 24 t) blir en
 * ÅPEN OPPFØLGING (`business_followups`, idempotent på `reply-pending:<hendelses-id>`) - og når den først er en oppfølging følger den ALLE de eksisterende garantiene til V2-pushen (WP-C4, `JARVIS_V2_PUSH_ENABLED`): eierens egen Telegram-kanal,
 * rolig tid, døgngrense, minsteavstand, «høyst én gang», kun faste etiketter og vasket tittel. Åpne forpliktelser fra møter (godtatte forslag) er allerede oppfølginger og går samme vei. Det er ÉN push-vei (ingen ny kanal, ingen ny leverandør);
 * APNs (iOS-push) er BLOCKED_EXTERNAL og ikke bygget.
 *
 * `planReplyFollowUps` er ren (ingen I/O, ingen klokke, ingen innhold): tittel = fast tekst + kanal + maskert avsender - aldri meldingsteksten. Hendelser som er avmelding/gjenopptak/status utelates allerede i spørringen (kun `kind = 'message'`),
 * og en avsender som har fått svar (utgående rad etter hendelsen, også «ukjent utfall» og «under sending») er ikke ubesvart.
 */
export const REPLY_SWEEP_MAX_PER_RUN = 20;
/** B-M2: høyst så mange oppfølginger per KANAL per sveip (én kanal - f.eks. SMS-spam - kan ikke ta hele kapasiteten). */
export const REPLY_SWEEP_MAX_PER_CHANNEL = 10;
/** B-M2: høyst så mange fra UKJENTE avsendere (ingen løst identitet) per sveip; kjente avsendere går alltid foran, så en flom fra ukjente aldri sulter de kjente. */
export const REPLY_SWEEP_MAX_UNKNOWN_PER_RUN = 8;

export interface PendingReply {
  readonly event_id: string;
  readonly channel: CommsChannel;
  readonly account_ref: string;
  readonly sender_hint: string | null;
  readonly received_at: string;
  /** Løst identitet (eksakt treff i Conversation Graph) eller `null`/utelatt = ukjent avsender. */
  readonly identity_id?: string | null;
}

export interface ReplyFollowUpPlan {
  readonly idempotency_key: string;
  readonly title: string;
  readonly reason: string;
  readonly due_at: string;
  readonly event_id: string;
}

const CHANNEL_LABEL: Readonly<Record<CommsChannel, string>> = {
  slack: "Slack", discord: "Discord", whatsapp: "WhatsApp", sms: "SMS", teams: "Teams", messenger: "Messenger", instagram: "Instagram", phone: "telefon"
};

/**
 * REN beslutning: hvilke ubesvarte meldinger skal bli oppfølginger NÅ? Kun meldinger eldre enn `afterHours`; ingen duplikater. Rekkefølge: KJENTE avsendere (løst identitet) først, deretter eldst først. Tak (B-M2): `maxPerRun` totalt,
 * `maxPerChannel` per kanal og `maxUnknown` fra ukjente avsendere - slik at en flom fra én kanal/ukjente avsendere aldri tar hele kapasiteten. (Rotasjon mellom sveip skjer ved at `pending()` utelater avsendere som ALLEREDE har en oppfølging.)
 */
export function planReplyFollowUps(rows: readonly PendingReply[], opts: { now: Date; afterHours: number; maxPerRun?: number; maxPerChannel?: number; maxUnknown?: number }): ReplyFollowUpPlan[] {
  const cutoff = opts.now.getTime() - opts.afterHours * 3_600_000;
  const maxPerRun = opts.maxPerRun ?? REPLY_SWEEP_MAX_PER_RUN;
  const maxPerChannel = opts.maxPerChannel ?? REPLY_SWEEP_MAX_PER_CHANNEL;
  const maxUnknown = opts.maxUnknown ?? REPLY_SWEEP_MAX_UNKNOWN_PER_RUN;
  const seen = new Set<string>();
  const perChannel = new Map<string, number>();
  let unknown = 0;
  const chosen: Array<{ r: PendingReply; at: number }> = [];
  const candidates = [...rows]
    .map((r) => ({ r, at: Date.parse(r.received_at), known: r.identity_id !== undefined && r.identity_id !== null }))
    .filter(({ at }) => Number.isFinite(at) && at <= cutoff)
    .sort((a, b) => (a.known === b.known ? a.at - b.at : a.known ? -1 : 1));
  for (const { r, at, known } of candidates) {
    if (chosen.length >= maxPerRun) break;
    if (seen.has(r.event_id)) continue;
    if ((perChannel.get(r.channel) ?? 0) >= maxPerChannel) continue;
    if (!known && unknown >= maxUnknown) continue;
    seen.add(r.event_id);
    perChannel.set(r.channel, (perChannel.get(r.channel) ?? 0) + 1);
    if (!known) unknown += 1;
    chosen.push({ r, at });
  }
  return chosen
    .sort((a, b) => a.at - b.at)
    .map(({ r, at }) => ({
      idempotency_key: `reply-pending:${r.event_id}`,
      title: `Svar på melding (${CHANNEL_LABEL[r.channel]}) fra ${r.sender_hint ?? "ukjent avsender"}`,
      reason: "Ubesvart innkommende melding (verifisert avsender, ingen svar fra oss)",
      due_at: new Date(at + opts.afterHours * 3_600_000).toISOString(),
      event_id: r.event_id
    }));
}

export interface ReplySweepDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly business: Pick<BusinessService, "createFollowup">;
  readonly afterHours: number;
  readonly windowDays: number;
  readonly warn?: (event: Record<string, unknown>) => void;
}

export class ReplySweep {
  constructor(private readonly deps: ReplySweepDeps) {}

  /**
   * Ubesvarte, verifiserte innkommende meldinger: den ELDSTE per avsender (kanal + avsender-pseudonym) uten utgående rad etter seg. Kun `kind = 'message'`. B-M2: avsendere som ALLEREDE har en oppfølging (`reply-pending:<hendelses-id>`,
   * uansett status - også en lukket) utelates ETTER utvelgelsen av den eldste, slik at et nytt sveip tar de NESTE i køen i stedet for de samme eldste igjen (før: 25 ubesvarte ga 20 oppfølginger, og de 5 nyeste fikk aldri en, selv etter at
   * eieren hadde lukket de 20). Kjente avsendere (løst identitet) først, så eldst; avgrenset til 500 rader per spørring.
   */
  async pending(tenantId: string, space: MemorySpace): Promise<PendingReply[]> {
    const now = this.deps.clock();
    const since = new Date(now.getTime() - this.deps.windowDays * 86_400_000);
    return withMemoryTransaction(this.deps.pool, tenantId, [space], async (client) => {
      const res = await client.query(
        `SELECT p.event_id, p.channel, p.account_ref, p.sender_hint, p.identity_id, p.received_at FROM (
           SELECT DISTINCT ON (e.channel, e.sender_hash) e.tenant_id, e.event_id, e.channel, e.account_ref, e.sender_hint, e.identity_id, e.received_at
           FROM comms_inbound_events e
           WHERE e.tenant_id = $1 AND e.kind = 'message' AND e.sender_hash IS NOT NULL AND e.received_at >= $2
             AND NOT EXISTS (
               SELECT 1 FROM comms_outbound_log l
               WHERE l.tenant_id = e.tenant_id AND l.channel = e.channel AND l.recipient_hash = e.sender_hash AND l.status IN ('requested', 'sent', 'outcome_unknown') AND l.created_at > e.received_at)
           ORDER BY e.channel, e.sender_hash, e.received_at ASC
         ) p
         WHERE NOT EXISTS (SELECT 1 FROM business_followups f WHERE f.tenant_id = p.tenant_id AND f.idempotency_key = 'reply-pending:' || p.event_id)
         ORDER BY (p.identity_id IS NULL), p.received_at ASC
         LIMIT 500`, [tenantId, since]);
      return res.rows.map((r) => ({ ...(r as Record<string, unknown>), received_at: (r as { received_at: Date }).received_at.toISOString() }) as unknown as PendingReply);
    });
  }

  /** Kjører ett sveip for tenant+rom. Idempotent: samme ubesvarte melding gir alltid samme oppfølging (aldri to). Feil på én hendelse stopper ikke de andre. */
  async run(tenantId: string, space: MemorySpace, ownerPersonId: string): Promise<{ pending: number; planned: number; ensured: number; failed: number }> {
    const rows = await this.pending(tenantId, space);
    const plans = planReplyFollowUps(rows, { now: this.deps.clock(), afterHours: this.deps.afterHours });
    let ensured = 0;
    let failed = 0;
    for (const plan of plans) {
      try {
        await this.deps.business.createFollowup(tenantId, space, { title: plan.title, reason: plan.reason, next_action: "Svar avsenderen (eller avslutt saken)", due_at: plan.due_at, priority: "normal", owner_person_id: ownerPersonId, idempotency_key: plan.idempotency_key });
        ensured += 1;
      } catch (err) {
        failed += 1;
        this.deps.warn?.({ msg: "comms_reply_sweep_followup_failed", error: err instanceof Error ? err.message.slice(0, 80) : "unknown" });
      }
    }
    return { pending: rows.length, planned: plans.length, ensured, failed };
  }
}
