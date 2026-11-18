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

export interface PendingReply {
  readonly event_id: string;
  readonly channel: CommsChannel;
  readonly account_ref: string;
  readonly sender_hint: string | null;
  readonly received_at: string;
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

/** REN beslutning: hvilke ubesvarte meldinger skal bli oppfølginger NÅ? Eldst først, høyst `maxPerRun`; kun meldinger eldre enn `afterHours`; ingen duplikater. */
export function planReplyFollowUps(rows: readonly PendingReply[], opts: { now: Date; afterHours: number; maxPerRun?: number }): ReplyFollowUpPlan[] {
  const cutoff = opts.now.getTime() - opts.afterHours * 3_600_000;
  const seen = new Set<string>();
  return [...rows]
    .map((r) => ({ r, at: Date.parse(r.received_at) }))
    .filter(({ at }) => Number.isFinite(at) && at <= cutoff)
    .sort((a, b) => a.at - b.at)
    .filter(({ r }) => (seen.has(r.event_id) ? false : (seen.add(r.event_id), true)))
    .slice(0, opts.maxPerRun ?? REPLY_SWEEP_MAX_PER_RUN)
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

  /** Ubesvarte, verifiserte innkommende meldinger: den ELDSTE per avsender (kanal + avsender-pseudonym) uten utgående rad etter seg. Kun `kind = 'message'`. */
  async pending(tenantId: string, space: MemorySpace): Promise<PendingReply[]> {
    const now = this.deps.clock();
    const since = new Date(now.getTime() - this.deps.windowDays * 86_400_000);
    return withMemoryTransaction(this.deps.pool, tenantId, [space], async (client) => {
      const res = await client.query(
        `SELECT DISTINCT ON (e.channel, e.sender_hash) e.event_id, e.channel, e.account_ref, e.sender_hint, e.received_at
         FROM comms_inbound_events e
         WHERE e.tenant_id = $1 AND e.kind = 'message' AND e.sender_hash IS NOT NULL AND e.received_at >= $2
           AND NOT EXISTS (
             SELECT 1 FROM comms_outbound_log l
             WHERE l.tenant_id = e.tenant_id AND l.channel = e.channel AND l.recipient_hash = e.sender_hash AND l.status IN ('requested', 'sent', 'outcome_unknown') AND l.created_at > e.received_at)
         ORDER BY e.channel, e.sender_hash, e.received_at ASC`, [tenantId, since]);
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
