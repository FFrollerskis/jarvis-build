// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import type { IdentityContext, MemorySpace } from "@jarvis/contracts";
import { scanForSecrets, withTenantTransaction, writeAudit } from "@jarvis/core";
import type { ConversationGraphService } from "@jarvis/conversation-graph";
import {
  FOLLOW_UP_PUSH_TICK_MS, flattenText, reduceLedger, runFollowUpPushTick,
  type FollowUpLedgerPort, type FollowUpNotifier, type FollowUpPushPolicy, type NotifyOutcome, type PushAuditType, type PushCandidate, type PushDecision, type PushLedgerRow, type PushSend,
  type PushTickResult, type SettleOutcome
} from "@jarvis/executive";
import type { ToolGateway } from "@jarvis/tool-gateway";

/**
 * WP-C4, V2 Unified Follow-up PUSH: limet mellom den rene planleggeren (`@jarvis/executive`) og kjøretiden. Tre adaptere og en starter, alle uten ny leverandør:
 *  - kandidater: `ConversationGraphService.crossChannelAttention` (forfalte/ventende løkker over de to eksisterende kildene `business_followups` og `business_open_loops`), i eierens egne rom (aldri helse/gjest),
 *  - ledger: revisjonssporet (`audit_events`, append-only) - reservasjon -> sendt/feilet/ukjent. Atomisk claim med advisory-lås per tenant, så to samtidige tikk aldri begge sender. Ingen ny tabell/migrasjon,
 *  - avsender: den EKSISTERENDE `telegram.notify` via `ToolGateway` (policy, kill switch, frys, revisjon, idempotens). Mottakeren er eierens konfigurerte chat - aldri en parameter her.
 * Av som standard (`JARVIS_V2_PUSH_ENABLED`): `startFollowUpPush` kalles bare når policyen er på OG en leveringskanal er konfigurert.
 */
type Pool = Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>;

/** Eierens egne rom varsler leses fra. Helse kan ikke kombineres med andre rom (og skal aldri i et varsel); gjest er ikke eierens. */
export const PUSH_SPACES: readonly MemorySpace[] = ["personal", "business", "project"];
/** Hvor langt tilbake ledgeren leses. Frister som varsles er høyst ~16 døgn gamle (se `stale_overdue_days`), så 90 døgn dekker dedupe med god margin. */
const LEDGER_HORIZON_DAYS = 90;
const MAX_MESSAGE_CHARS = 3900;

/** Feiltekst som kan lagres/logges: hemmelighetsskannet (en feilmelding kan inneholde en URL med token), flatet og kortet. */
const safeDetail = (value: unknown, max = 120): string => flattenText(scanForSecrets(value instanceof Error ? value.message : String(value)).text, max);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Kandidater (conversation-graph)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface GraphCandidateDeps {
  graph: Pick<ConversationGraphService, "crossChannelAttention">;
  tenantId: string;
  now?: () => Date;
  spaces?: readonly MemorySpace[];
  warn?: (event: Record<string, unknown>) => void;
}

/**
 * Leser forfalte/ventende løkker per rom og mapper dem til rene kandidater. Tittelen til en oppfølging passerer hemmelighetsskanneren her (og vaskes ytterligere i planleggeren); systemløkker bærer kun `loop_type`.
 * Feiler ETT rom, fortsetter de andre (færre kandidater kan aldri gi en dobbel varsling - dedupe ligger i ledgeren); feiler ALLE, kastes feilen og tikket sender ingenting.
 */
export function createGraphCandidateSource(deps: GraphCandidateDeps): () => Promise<PushCandidate[]> {
  const spaces = deps.spaces ?? PUSH_SPACES;
  const now = deps.now ?? (() => new Date());
  return async () => {
    const out: PushCandidate[] = [];
    let failed = 0;
    let lastError: unknown;
    const at = now().getTime();
    for (const space of spaces) {
      try {
        const entries = await deps.graph.crossChannelAttention(deps.tenantId, space, at);
        for (const e of entries) {
          const c = e.commitment;
          out.push({
            source_kind: c.source_kind, source_id: c.source_id, due_at: c.due_at, bucket: c.bucket, priority: c.priority, provenance: c.provenance,
            title: c.source_kind === "business_followup" ? scanForSecrets(c.title).text : c.title
          });
        }
      } catch (err) {
        failed += 1;
        lastError = err;
        deps.warn?.({ msg: "v2_push_space_read_failed", space, error: safeDetail(err) });
      }
    }
    if (failed === spaces.length && failed > 0) throw lastError instanceof Error ? lastError : new Error("v2_push_all_spaces_failed");
    return out;
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Ledger (audit_events)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface AuditLedgerDeps {
  pool: Pool;
  tenantId: string;
  /** Sporbarhet: sesjonen push-løkken kjører i. Radene skrives som SYSTEM (aldri som om en person handlet). */
  sessionId: string;
  now?: () => Date;
}

const AUDIT_TYPES: Record<SettleOutcome, PushAuditType> = { sent: "followup.push_sent", failed: "followup.push_failed", unknown: "followup.push_unknown" };

/** Les ledger-radene (kun typer og nøkler i payload - aldri noe annet) i gjeldende tenant-transaksjon. */
export async function readPushLedgerRows(client: pg.PoolClient): Promise<PushLedgerRow[]> {
  const { rows } = await client.query(
    `SELECT audit_id::float8 AS seq, type, at, payload->>'message_key' AS message_key, payload->'item_keys' AS item_keys
       FROM audit_events
      WHERE type IN ('followup.push_reserved', 'followup.push_sent', 'followup.push_failed', 'followup.push_unknown') AND at > now() - make_interval(days => $1::int)
      ORDER BY audit_id`,
    [LEDGER_HORIZON_DAYS]
  );
  const out: PushLedgerRow[] = [];
  for (const r of rows as Array<{ seq: number; type: PushAuditType; at: Date | string; message_key: unknown; item_keys: unknown }>) {
    if (typeof r.message_key !== "string") continue;
    const keys = Array.isArray(r.item_keys) ? r.item_keys.filter((k): k is string => typeof k === "string") : [];
    out.push({ seq: Number(r.seq), type: r.type, at: r.at instanceof Date ? r.at.toISOString() : new Date(r.at).toISOString(), message_key: r.message_key, item_keys: keys });
  }
  return out;
}

export function createAuditLedger(deps: AuditLedgerDeps): FollowUpLedgerPort {
  const now = deps.now ?? (() => new Date());
  const subject = { tenant_id: deps.tenantId, person_id: "system", session_id: deps.sessionId, device_id: "jarvis-core" };
  return {
    async claim(build: (state: ReturnType<typeof reduceLedger>) => PushDecision): Promise<PushDecision> {
      return withTenantTransaction(deps.pool as pg.Pool, deps.tenantId, async (client) => {
        // Advisory-låsen serialiserer alle som claimer for denne tenanten (flere prosesser/tikk): lesing av ledgeren, beslutning og reservasjon skjer som ÉN udelelig enhet.
        // Begrenset ventetid: kan ikke låsen tas, kastes feilen (-> `ledger_unavailable`, ingenting sendes) i stedet for at tikket henger.
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`v2-push:${deps.tenantId}`]);
        const decision = build(reduceLedger(await readPushLedgerRows(client), now()));
        if (decision.send) {
          await writeAudit(client, subject, {
            type: "followup.push_reserved", decision: "ALLOW", tool_id: "telegram", action: "notify",
            payload: { message_key: decision.message_key, item_keys: decision.item_keys, count: decision.items.length }
          });
        }
        return decision;
      });
    },
    async settle(decision: PushSend, outcome: SettleOutcome, detail: string): Promise<void> {
      await withTenantTransaction(deps.pool as pg.Pool, deps.tenantId, (client) =>
        writeAudit(client, subject, {
          type: AUDIT_TYPES[outcome], decision: outcome === "sent" ? "ALLOW" : "DENY", tool_id: "telegram", action: "notify",
          ...(outcome === "sent" ? {} : { reason: safeDetail(detail) }),
          payload: { message_key: decision.message_key, count: decision.items.length, ...(outcome === "sent" ? { external_id: safeDetail(detail, 60) } : {}) }
        })
      );
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Avsender (telegram.notify via ToolGateway)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export function createTelegramNotifier(deps: { gateway: Pick<ToolGateway, "execute">; identity: IdentityContext }): FollowUpNotifier {
  return {
    channel: "telegram",
    async notify(text: string, opts: { idempotency_key: string }): Promise<NotifyOutcome> {
      try {
        // Mottakeren er eierens konfigurerte chat (`JARVIS_TELEGRAM_CHAT_ID`); `message` er det eneste parameteret. Policy, kill switch, frys og revisjon håndheves av gatewayen.
        const result = await deps.gateway.execute({
          identity: deps.identity, tool_id: "telegram", action: "notify", parameters: { message: text.slice(0, MAX_MESSAGE_CHARS) }, idempotency_key: opts.idempotency_key
        });
        return result.ok ? { ok: true, ...(result.external_id !== undefined ? { external_id: result.external_id } : {}) } : { ok: false, reason: safeDetail(result.reason) };
      } catch (err) {
        // Et kastet unntak midt i kallet betyr at utfallet er UKJENT (meldingen kan være sendt): merkes tvetydig slik at reservasjonen beholdes (høyst én gang). Teksten hemmelighetsskannes FØR den kuttes.
        return { ok: false, reason: `postcondition_unverified:exception:${safeDetail(err, 80)}` };
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Starter
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface StartFollowUpPushDeps {
  pool: Pool;
  graph: Pick<ConversationGraphService, "crossChannelAttention">;
  gateway: Pick<ToolGateway, "execute">;
  /** Eierens systemidentitet (samme som morgenbriefen bruker). Sesjonen får et eget suffiks. */
  ownerIdentity: IdentityContext;
  policy: FollowUpPushPolicy;
  tickMs?: number;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

/** Rutinemessige utfall som ikke logges hvert kvarter (rolig tid, ingenting nytt, døgngrense, minsteavstand). */
const QUIET_RESULTS = new Set(["disabled", "quiet_hours", "nothing_new", "rate_limited", "min_gap"]);

export interface FollowUpPushHandle {
  /** Ett tikk nå (brukes av testene og kan kalles manuelt). Kaster aldri. */
  tick(): Promise<PushTickResult>;
  stop(): void;
}

export function startFollowUpPush(deps: StartFollowUpPushDeps): FollowUpPushHandle {
  const log = deps.log ?? ((event) => console.log(JSON.stringify(event)));
  const now = deps.now ?? (() => new Date());
  const tenantId = deps.ownerIdentity.tenant_id;
  const identity: IdentityContext = { ...deps.ownerIdentity, session_id: `${deps.ownerIdentity.session_id}-v2-push` };
  const ports = {
    candidates: createGraphCandidateSource({ graph: deps.graph, tenantId, now, warn: log }),
    ledger: createAuditLedger({ pool: deps.pool, tenantId, sessionId: identity.session_id, now }),
    notifier: createTelegramNotifier({ gateway: deps.gateway, identity })
  };
  let running = false;
  const tick = async (): Promise<PushTickResult> => {
    // Aldri to tikk samtidig i denne prosessen (en treg lesing skal ikke stable seg); mellom prosesser sørger ledgerens advisory-lås for det samme.
    if (running) return { sent: false, reason: "min_gap" };
    running = true;
    try {
      const result = await runFollowUpPushTick(ports, deps.policy, now);
      const reason = result.sent ? "sent" : result.reason;
      if (result.sent || !QUIET_RESULTS.has(reason)) log({ msg: "v2_push_tick", result: reason, ...(result.sent ? { items: result.items } : {}) });
      return result;
    } catch (err) {
      log({ msg: "v2_push_tick_failed", error: safeDetail(err) });
      return { sent: false, reason: "ledger_unavailable" };
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => void tick(), deps.tickMs ?? FOLLOW_UP_PUSH_TICK_MS);
  interval.unref();
  // Første tikk etter en kort pause (ikke i oppstartsstien).
  const first = setTimeout(() => void tick(), 60_000);
  first.unref();
  log({ msg: "v2_push_started", max_per_day: deps.policy.max_messages_per_day, quiet: `${deps.policy.quiet_start_hour}-${deps.policy.quiet_end_hour}`, tick_ms: deps.tickMs ?? FOLLOW_UP_PUSH_TICK_MS });
  return { tick, stop: () => { clearInterval(interval); clearTimeout(first); } };
}
