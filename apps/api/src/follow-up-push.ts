// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import { correlationFields, scheduledRunCorrelation, type IdentityContext, type MemorySpace, type RunCorrelation } from "@jarvis/contracts";
import { scanForSecrets, withTenantTransaction, writeAudit } from "@jarvis/core";
import type { ConversationGraphService } from "@jarvis/conversation-graph";
import {
  FOLLOW_UP_PUSH_TICK_MS, flattenText, reduceLedger, runFollowUpPushTick,
  type FollowUpLedgerPort, type FollowUpNotifier, type FollowUpPushPolicy, type NotifyOutcome, type PushAuditType, type PushCandidate, type PushDecision, type PushLedgerRow, type PushSend,
  type PushSendGuard, type PushTickResult, type SettleOutcome
} from "@jarvis/executive";
import type { InfraExecutionGate, KillSwitch, OwnerControls } from "@jarvis/policy";
import type { ToolGateway } from "@jarvis/tool-gateway";

/**
 * WP-C4, V2 Unified Follow-up PUSH: limet mellom den rene planleggeren (`@jarvis/executive`) og kjøretiden. Tre adaptere og en starter, alle uten ny leverandør:
 *  - kandidater: `ConversationGraphService.crossChannelAttention` (forfalte/ventende løkker over de to eksisterende kildene `business_followups` og `business_open_loops`), i eierens egne rom (aldri helse/gjest),
 *  - ledger: revisjonssporet (`audit_events`, append-only) - reservasjon -> sendt/feilet/ukjent. Atomisk claim med advisory-lås per tenant, så to samtidige tikk aldri begge sender. Ingen ny tabell/migrasjon,
 *  - avsender: den EKSISTERENDE `telegram.notify` via `ToolGateway` (policy, kill switch, frys, revisjon, idempotens). Mottakeren er eierens konfigurerte chat - aldri en parameter her,
 *  - stopp-sjekk (M1): kill switch, frosset connector, tilbakekalt credential og infra-pause leses FØR noe reserveres (`createPushSendGuard`) - samme regler som gatewayen ellers ville avslått med, men uten forsøk og audit-støy.
 * Utfallsregel (H1, «høyst én gang»): bare et avslag som BEVISER at ingenting gikk ut frigir reservasjonen (se `classifyNotifyFailure` i `@jarvis/executive`). Tidsavbrudd, 5xx, nettverksbrudd og alt ukjent beholder den - en påminnelse kan i
 * sjeldne tilfeller gå tapt, men kan ikke komme to ganger så lenge ledgeren (revisjonssporet) er intakt.
 * Av som standard (`JARVIS_V2_PUSH_ENABLED`): `startFollowUpPush` kalles bare når policyen er på OG en leveringskanal er konfigurert.
 * WP-P3 K5 (JARVIS-054): hvert tikk bærer en korrelasjon (`task_id` = `sched:v2-push:<UTC-dato>`, `trace_id` unik per tikk) som ledgeren skriver i `followup.push_*`-radene og som sendes videre til `gateway.execute()`; identiteten er uendret `system`.
 */
type Pool = Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>;

/** Eierens egne rom varsler leses fra. Helse kan ikke kombineres med andre rom (og skal aldri i et varsel); gjest er ikke eierens. */
export const PUSH_SPACES: readonly MemorySpace[] = ["personal", "business", "project"];
/** Hvor langt tilbake ledgeren leses. Frister som varsles er høyst ~16 døgn gamle (se `stale_overdue_days`), så 90 døgn dekker dedupe med god margin. */
const LEDGER_HORIZON_DAYS = 90;
const MAX_MESSAGE_CHARS = 3900;

/** Feiltekst som kan lagres/logges: hemmelighetsskannet (en feilmelding kan inneholde en URL med token), flatet og kortet. */
const safeDetail = (value: unknown, max = 120): string => flattenText(scanForSecrets(value instanceof Error ? value.message : String(value)).text, max);

/** WP-P3 K5: jobbnavnet i tikkets korrelasjon (`sched:v2-push:<dato>`). */
export const PUSH_JOB_NAME = "v2-push";

/**
 * WP-P3 K5 (JARVIS-054): korrelasjon per tikk. `task_id` er STABIL per UTC-dag (alle tikk samme dag hører til samme logiske oppgave); `trace_id` er UNIK per tikk. «Forsøksnummeret» er sekunder siden UTC-midnatt (+1), tvunget
 * strengt økende i prosessen (to tikk i samme sekund, f.eks. en fast testklokke) og uten teller som deles mellom prosesser: en omstart samme dag tikker på et senere tidspunkt og kolliderer derfor ikke med tikkene
 * før omstarten. Kun tegn fra det trygge mønsteret (`scheduledRunCorrelation`); aldri innhold eller hemmeligheter.
 */
export function createPushCorrelator(now: () => Date): () => RunCorrelation {
  let lastDate = "";
  let lastAttempt = 0;
  return () => {
    const at = now();
    const date = at.toISOString().slice(0, 10);
    let attempt = at.getUTCHours() * 3600 + at.getUTCMinutes() * 60 + at.getUTCSeconds() + 1;
    if (date === lastDate && attempt <= lastAttempt) attempt = lastAttempt + 1;
    lastDate = date;
    lastAttempt = attempt;
    return scheduledRunCorrelation(PUSH_JOB_NAME, date, attempt);
  };
}

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
  /** WP-P3 K5: korrelasjonen til GJELDENDE tikk (leses ved hver skriving). Utelatt/`undefined` = ingen `task_id`/`trace_id` (som før). Porten `FollowUpLedgerPort` er uendret. */
  correlation?: () => RunCorrelation | undefined;
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
            type: "followup.push_reserved", decision: "ALLOW", tool_id: "telegram", action: "notify", ...correlationFields(deps.correlation?.()),
            payload: { message_key: decision.message_key, item_keys: decision.item_keys, count: decision.items.length }
          });
        }
        return decision;
      });
    },
    async settle(decision: PushSend, outcome: SettleOutcome, detail: string): Promise<void> {
      await withTenantTransaction(deps.pool as pg.Pool, deps.tenantId, (client) =>
        writeAudit(client, subject, {
          type: AUDIT_TYPES[outcome], decision: outcome === "sent" ? "ALLOW" : "DENY", tool_id: "telegram", action: "notify", ...correlationFields(deps.correlation?.()),
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
export function createTelegramNotifier(deps: { gateway: Pick<ToolGateway, "execute">; identity: IdentityContext; correlation?: () => RunCorrelation | undefined }): FollowUpNotifier {
  return {
    channel: "telegram",
    async notify(text: string, opts: { idempotency_key: string }): Promise<NotifyOutcome> {
      try {
        // Mottakeren er eierens konfigurerte chat (`JARVIS_TELEGRAM_CHAT_ID`); `message` er det eneste parameteret. Policy, kill switch, frys og revisjon håndheves av gatewayen.
        const result = await deps.gateway.execute({
          identity: deps.identity, tool_id: "telegram", action: "notify", parameters: { message: text.slice(0, MAX_MESSAGE_CHARS) }, idempotency_key: opts.idempotency_key,
          // WP-P3 K5: tikkets task_id/trace_id (gatewayens rader og policy-avgjørelsen knyttes til samme tikk som ledger-radene)
          ...correlationFields(deps.correlation?.())
        });
        return result.ok ? { ok: true, ...(result.external_id !== undefined ? { external_id: result.external_id } : {}) } : { ok: false, reason: safeDetail(result.reason) };
      } catch (err) {
        // Et kastet unntak midt i kallet betyr at utfallet er UKJENT (meldingen kan være sendt): merkes tvetydig slik at reservasjonen beholdes (høyst én gang; `classifyNotifyFailure` kjenner ikke denne teksten som bevist «ikke sendt»).
        // Teksten hemmelighetsskannes FØR den kuttes.
        return { ok: false, reason: `postcondition_unverified:exception:${safeDetail(err, 80)}` };
      }
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Stopp-sjekk (M1): kill switch, frys, tilbakekalt credential, infra-pause - FØR reservasjon
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
export interface PushGuardDeps {
  killSwitch: Pick<KillSwitch, "isActiveDurable">;
  controls: Pick<OwnerControls, "isFrozenDurable" | "isRevokedDurable">;
  /**
   * Infra-modus (`infraGate.checkDurable`) gjelder KUN verktøy i `infraToolIds` (i dag `github`/`docker`) - `telegram` er ikke blant dem, så sjekken er et strukturelt no-op akkurat som i `PolicyGateway.authorize()`. Den er likevel
   * med slik at en framtidig endring av `infraToolIds` også stopper løperen før reservasjon i stedet for å gi et forsøk hvert kvarter.
   */
  infraGate?: Pick<InfraExecutionGate, "checkDurable">;
  infraToolIds?: ReadonlySet<string>;
  /** Verktøyet og credential-referansen `telegram.notify` bruker (standardene er de samme som i tool-definisjonen). */
  toolId?: string;
  credentialRef?: string;
}

/**
 * Speiler det gatewayen uansett ville avslått (`PolicyGateway.authorize()` og `ToolGateway.execute()`, i samme rekkefølge: kill switch, frosset connector, infra-modus, tilbakekalt credential), men uten at noe reserveres eller skrives:
 * ingen `push_reserved`/`push_failed`-rader, ingen `tool.denied`-rader og ingen forsøk mens eieren har stanset systemet. Samme LIVE, delte (`*Durable`) sjekker som gatewayen bruker. En feil her kastes videre og tolkes av tikket som stanset (fail-closed).
 * Gatewayen sjekker uansett på nytt ved selve kallet, så et løp mellom sjekken og sendingen gir i verste fall ett (frigitt, bevist ikke sendt) forsøk.
 */
export function createPushSendGuard(deps: PushGuardDeps): PushSendGuard {
  const toolId = deps.toolId ?? "telegram";
  const credentialRef = deps.credentialRef ?? "JARVIS_TELEGRAM_TOKEN";
  return {
    async blocked(): Promise<string | null> {
      if (await deps.killSwitch.isActiveDurable()) return "kill_switch_active";
      if (await deps.controls.isFrozenDurable(toolId)) return "connector_frozen";
      if (deps.infraGate !== undefined && deps.infraToolIds?.has(toolId) === true) {
        const deny = await deps.infraGate.checkDurable("B"); // telegram.notify er klasse B
        if (deny !== null) return deny;
      }
      if (await deps.controls.isRevokedDurable(credentialRef)) return "credential_revoked";
      return null;
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
  /** M1: stopp-sjekk FØR reservasjon (påkrevd: produksjonskoblingen kan ikke glemme den). */
  guard: PushSendGuard;
  tickMs?: number;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

/** Rutinemessige utfall som ikke logges hvert kvarter (rolig tid, ingenting nytt, døgngrense, minsteavstand, ventetid etter en feil). */
const QUIET_RESULTS = new Set(["disabled", "quiet_hours", "nothing_new", "rate_limited", "min_gap", "backoff"]);
/** Tilstander som varer: logges KUN når de oppstår eller endrer seg (ikke 96 ganger i døgnet), og vises i `status()`. */
const STATE_RESULTS = new Set(["attempts_exhausted", "send_blocked"]);
/** Utfall som kommer FØR forsøkstaket i planleggerens rekkefølge og dermed ikke sier noe om om taket fortsatt gjelder (rolig tid, døgngrense, minsteavstand): de opphever ikke `attempts_exhausted`. */
const SAYS_NOTHING_ABOUT_EXHAUSTION = new Set(["disabled", "quiet_hours", "rate_limited", "min_gap"]);

export interface FollowUpPushStatus {
  /** Siste tikks utfall (kort kode, aldri innhold), eller null før første tikk. */
  last_result: string | null;
  last_tick_at: string | null;
  /** Satt mens løperen er stanset før reservasjon (`kill_switch_active`, `connector_frozen`, `credential_revoked`, ...). */
  blocked_by: string | null;
  /** Satt når en melding har brukt opp forsøkene sine for døgnet (`attempts_exhausted`): meldingens hash, aldri innhold. */
  attempts_exhausted_message: string | null;
}

export interface FollowUpPushHandle {
  /** Ett tikk nå (brukes av testene og kan kalles manuelt). Kaster aldri. */
  tick(): Promise<PushTickResult>;
  /** M1(c): tilstanden løperen er i, til status og tester (aldri hemmeligheter eller innhold). */
  status(): FollowUpPushStatus;
  stop(): void;
}

export function startFollowUpPush(deps: StartFollowUpPushDeps): FollowUpPushHandle {
  const log = deps.log ?? ((event) => console.log(JSON.stringify(event)));
  const now = deps.now ?? (() => new Date());
  const tenantId = deps.ownerIdentity.tenant_id;
  const identity: IdentityContext = { ...deps.ownerIdentity, session_id: `${deps.ownerIdentity.session_id}-v2-push` };
  // WP-P3 K5: ÉN korrelasjon per tikk, satt FØR planleggeren kjører og lest lat av ledgeren og avsenderen (to tikk kjører aldri samtidig i denne prosessen: `running`-vakten under).
  const nextCorrelation = createPushCorrelator(now);
  let correlation: RunCorrelation | undefined;
  const currentCorrelation = (): RunCorrelation | undefined => correlation;
  const ports = {
    candidates: createGraphCandidateSource({ graph: deps.graph, tenantId, now, warn: log }),
    ledger: createAuditLedger({ pool: deps.pool, tenantId, sessionId: identity.session_id, now, correlation: currentCorrelation }),
    notifier: createTelegramNotifier({ gateway: deps.gateway, identity, correlation: currentCorrelation }),
    guard: deps.guard
  };
  let running = false;
  let lastState: string | null = null;
  const status: FollowUpPushStatus = { last_result: null, last_tick_at: null, blocked_by: null, attempts_exhausted_message: null };
  const tick = async (): Promise<PushTickResult> => {
    // Aldri to tikk samtidig i denne prosessen (en treg lesing skal ikke stable seg); mellom prosesser sørger ledgerens advisory-lås for det samme.
    if (running) return { sent: false, reason: "min_gap" };
    running = true;
    try {
      correlation = nextCorrelation();
      const result = await runFollowUpPushTick(ports, deps.policy, now);
      const reason = result.sent ? "sent" : result.reason;
      status.last_result = reason;
      status.last_tick_at = now().toISOString();
      status.blocked_by = !result.sent && result.reason === "send_blocked" ? result.blocked_by : null;
      status.attempts_exhausted_message = !result.sent && result.reason === "attempts_exhausted" ? (result.message_key ?? null) : null;
      // Varige tilstander (stanset / forsøk brukt opp) logges bare ved endring; ellers logges alt som ikke er rutine. Aldri tittel, tekst eller hemmeligheter.
      const state = STATE_RESULTS.has(reason) ? `${reason}:${status.blocked_by ?? status.attempts_exhausted_message ?? ""}` : null;
      if (state !== null) {
        if (state !== lastState) log({ msg: "v2_push_tick", result: reason, ...(status.blocked_by !== null ? { blocked_by: status.blocked_by } : {}), ...(status.attempts_exhausted_message !== null ? { message_key: status.attempts_exhausted_message } : {}) });
        lastState = state;
      } else {
        const was = lastState?.split(":")[0];
        // Rolig tid/døgngrense/minsteavstand sier ingenting om forsøkstaket: tilstanden gjelder videre og logges ikke på nytt når den igjen blir synlig.
        const stillInForce = was === "attempts_exhausted" && SAYS_NOTHING_ABOUT_EXHAUSTION.has(reason);
        if (lastState !== null && !stillInForce) { log({ msg: "v2_push_state_cleared", was }); lastState = null; }
        if (result.sent || !QUIET_RESULTS.has(reason)) log({ msg: "v2_push_tick", result: reason, ...(result.sent ? { items: result.items } : {}) });
      }
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
  log({
    msg: "v2_push_started", max_per_day: deps.policy.max_messages_per_day, quiet: `${deps.policy.quiet_start_hour}-${deps.policy.quiet_end_hour}`, tick_ms: deps.tickMs ?? FOLLOW_UP_PUSH_TICK_MS,
    titles: deps.policy.include_titles, max_attempts_per_message: deps.policy.max_attempts_per_message, retry_backoff_minutes: deps.policy.retry_backoff_minutes
  });
  return { tick, status: () => ({ ...status }), stop: () => { clearInterval(interval); clearTimeout(first); } };
}
