import { z } from "zod";
import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { BusinessService } from "@jarvis/business";
import type { ConversationGraphService } from "@jarvis/conversation-graph";
import { isIndeterminateTransportError, isOutcomeUnknownMessage } from "@jarvis/tool-gateway";
import { ProviderRejectedError, type AdapterMap } from "./adapters.ts";
import { COMMS_CHANNELS, PROVIDERS_FOR_CHANNEL, normalizeRecipient, optOutHash, recipientHash, recipientHint, type CommsChannel, type CommsProvider } from "./channels.ts";
import type { CommsConfig } from "./config.ts";
import { evaluateOutboundPolicy, rateCaps, type OutboundKind, type OutboundPolicyState, type OutboundPurpose, type OutboundRequest, type PolicyDecision, type ReservationRegisterStatus } from "./policy.ts";
import type { Actor, AuthorizedAccount, Clock, CommsStore, JournalEntryInput, JournalSource } from "./store.ts";

/**
 * WP-G1 (D-463, P1b/P1c): TRAKTEN alle nye sendeveier går gjennom. ÉN kodevei fra forespørsel til leverandørkall: parse (streng) -> normaliser mottaker -> last tilstand -> `evaluateOutboundPolicy` -> journal (`requested`) ->
 * adapter -> journal (`sent`/`failed`/`outcome_unknown`) -> D-121-tidslinje. Verktøyene (`comms.send` m.fl.), eier-rutene og den valgfrie vakten rundt de gamle `*.notify`-veiene kaller ALLE hit - det finnes ingen annen vei til en adapter.
 *
 * Policyen kjøres to ganger for en klasse D-utsendelse: som tørrkjøring i ToolGateway-preflight (`evaluate_send`, avslag FØR reservasjon) og på nytt HER rett før leverandørkallet (tilstanden kan ha flyttet seg).
 * Journalen er det andre gjenspillingsvernet (etter gateway-ledgeren): samme `request_id` kan aldri gi to leverandørkall, uansett innfallsvei.
 */
export interface MarketingBasisPort {
  /** Har mottakeren gitt et REGISTRERT forhåndssamtykke til markedsføring på denne kanalen? Samtykkeregisteret er IKKE bygget (JARVIS-084/Q-47f er utenfor omfang) - standard er `false`. */
  priorConsent(tenantId: string, space: MemorySpace, channel: CommsChannel, recipientHashValue: string): Promise<boolean>;
  /** Oppslag i Reservasjonsregisteret (Brønnøysundregistrene). IKKE bygget/verifisert (BLOCKED_EXTERNAL) - standard er `unverified`, som får markedsføring til å feile lukket. */
  reservationRegister(recipient: string, channel: CommsChannel): Promise<ReservationRegisterStatus>;
}

export const DEFAULT_MARKETING_PORT: MarketingBasisPort = {
  priorConsent: async () => false,
  reservationRegister: async () => "unverified"
};

export interface FunnelDeps {
  readonly store: CommsStore;
  readonly graph: Pick<ConversationGraphService, "resolveIdentityByChannel" | "resolveIdentityByPhone" | "listChannelLinks" | "readIdentity">;
  readonly adapters: AdapterMap;
  readonly config: CommsConfig;
  readonly clock: Clock;
  readonly marketing?: MarketingBasisPort;
  /** D-121: valgfri tidslinje (en utsendt melding blir en `business_activities`-peker når mottakeren er en løst identitet med lenket kontakt). */
  readonly business?: Pick<BusinessService, "recordActivity">;
  readonly warn?: (event: Record<string, unknown>) => void;
}

export interface FunnelContext {
  readonly tenantId: string;
  readonly space: MemorySpace;
  readonly actor: Actor;
  readonly source: JournalSource;
}

const json = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const RequestId = z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const Channel = z.enum(COMMS_CHANNELS);
const Purpose = z.enum(["transactional", "agreed", "marketing"]);
const AccountRef = z.string().min(1).max(200);
const Recipient = z.string().min(1).max(300);
const MessageId = z.string().min(1).max(300);

export const SendParamsSchema = json({
  request_id: RequestId, channel: Channel, account_ref: AccountRef, recipient: Recipient, purpose: Purpose,
  text: z.string().min(1).max(8000).optional(),
  template: json({ name: z.string().min(1).max(512), language: z.string().min(2).max(10), params: z.array(z.string().max(200)).max(10).optional() }).optional(),
  media: json({ kind: z.enum(["image", "document", "audio", "video"]), url: z.string().min(1).max(2000), caption: z.string().max(1000).optional() }).optional(),
  thread_ref: z.string().min(1).max(300).optional()
});
export const EditParamsSchema = json({ request_id: RequestId, channel: Channel, account_ref: AccountRef, recipient: Recipient, target_message_id: MessageId, text: z.string().min(1).max(8000) });
export const DeleteParamsSchema = json({ request_id: RequestId, channel: Channel, account_ref: AccountRef, recipient: Recipient, target_message_id: MessageId });
export const ReactParamsSchema = json({ request_id: RequestId, channel: Channel, account_ref: AccountRef, recipient: Recipient, target_message_id: MessageId, reaction: z.string().min(1).max(64) });
/** Utgående samtale (P3h): kun kanalen `phone`; `text` er manuset (AI-opplysningen settes FØRST av policyen). `recording` finnes bare for at en forespørsel om opptak skal AVSLÅS med kode - den ignoreres aldri stille. */
export const CallParamsSchema = json({
  request_id: RequestId, channel: z.literal("phone"), account_ref: AccountRef, recipient: Recipient, purpose: Purpose, text: z.string().min(1).max(2000), recording: z.boolean().optional()
});

export interface ParsedOutbound {
  readonly request_id: string;
  readonly request: OutboundRequest;
}

export type ParseResult = { readonly ok: true; readonly value: ParsedOutbound } | { readonly ok: false; readonly code: string };

function build(kind: OutboundKind, base: { request_id: string; channel: CommsChannel; account_ref: string; recipient: string; purpose: OutboundPurpose }, content: OutboundRequest["content"], extra: { thread_ref?: string; target_message_id?: string }): ParseResult {
  const recipient = normalizeRecipient(base.channel, base.recipient);
  // En ugyldig mottaker avvises HER med fast kode (policyen ville avvist den også, men journalen trenger en hash - og vi hasher aldri en ugyldig verdi).
  if (!recipient.ok) return { ok: false, code: recipient.code };
  return {
    ok: true,
    value: {
      request_id: base.request_id,
      request: {
        kind, channel: base.channel, account_ref: base.account_ref, recipient: recipient.value, purpose: base.purpose, content,
        ...(extra.thread_ref !== undefined ? { thread_ref: extra.thread_ref } : {}), ...(extra.target_message_id !== undefined ? { target_message_id: extra.target_message_id } : {})
      }
    }
  };
}

export function parseSendParams(raw: unknown): ParseResult {
  const p = SendParamsSchema.safeParse(raw);
  if (!p.success) return { ok: false, code: "invalid_parameters" };
  const d = p.data;
  return build("message", { request_id: d.request_id, channel: d.channel, account_ref: d.account_ref, recipient: d.recipient, purpose: d.purpose },
    {
      ...(d.text !== undefined ? { text: d.text } : {}),
      ...(d.template !== undefined ? { template: { name: d.template.name, language: d.template.language, params: d.template.params ?? [] } } : {}),
      ...(d.media !== undefined ? { media: { kind: d.media.kind, url: d.media.url, ...(d.media.caption !== undefined ? { caption: d.media.caption } : {}) } } : {})
    },
    { ...(d.thread_ref !== undefined ? { thread_ref: d.thread_ref } : {}) });
}

export function parseEditParams(raw: unknown): ParseResult {
  const p = EditParamsSchema.safeParse(raw);
  if (!p.success) return { ok: false, code: "invalid_parameters" };
  const d = p.data;
  return build("edit", { request_id: d.request_id, channel: d.channel, account_ref: d.account_ref, recipient: d.recipient, purpose: "transactional" }, { text: d.text }, { target_message_id: d.target_message_id });
}

export function parseDeleteParams(raw: unknown): ParseResult {
  const p = DeleteParamsSchema.safeParse(raw);
  if (!p.success) return { ok: false, code: "invalid_parameters" };
  const d = p.data;
  return build("delete", { request_id: d.request_id, channel: d.channel, account_ref: d.account_ref, recipient: d.recipient, purpose: "transactional" }, {}, { target_message_id: d.target_message_id });
}

export function parseReactParams(raw: unknown): ParseResult {
  const p = ReactParamsSchema.safeParse(raw);
  if (!p.success) return { ok: false, code: "invalid_parameters" };
  const d = p.data;
  return build("reaction", { request_id: d.request_id, channel: d.channel, account_ref: d.account_ref, recipient: d.recipient, purpose: "transactional" }, { reaction: d.reaction }, { target_message_id: d.target_message_id });
}

export function parseCallParams(raw: unknown): ParseResult {
  const p = CallParamsSchema.safeParse(raw);
  if (!p.success) return { ok: false, code: "invalid_parameters" };
  const d = p.data;
  return build("call", { request_id: d.request_id, channel: d.channel, account_ref: d.account_ref, recipient: d.recipient, purpose: d.purpose }, { text: d.text, ...(d.recording !== undefined ? { recording: d.recording } : {}) }, {});
}

export interface Evaluation {
  readonly parsed: ParsedOutbound;
  readonly decision: PolicyDecision;
  readonly account: AuthorizedAccount | null;
  readonly provider: CommsProvider;
  readonly recipient_hash: string;
  readonly recipient_hint: string;
  readonly state: OutboundPolicyState;
  readonly target_log_id: string | null;
}

export interface ExecResult {
  readonly external_id: string;
  readonly data: Record<string, JsonValue>;
}

const SAFE_ERROR = /^[A-Za-z0-9_:.+-]{1,120}$/;
const safeError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : "";
  return SAFE_ERROR.test(message) ? message : "comms_unspecified_error";
};

export class OutboundFunnel {
  constructor(private readonly deps: FunnelDeps) {}

  private get marketing(): MarketingBasisPort {
    return this.deps.marketing ?? DEFAULT_MARKETING_PORT;
  }

  /** Last tilstand og kjør policyen. Ren lesing - ingen skriving (brukes som preflight og av tørrkjøringsverktøyet). */
  async evaluate(ctx: FunnelContext, parsed: ParsedOutbound): Promise<Evaluation> {
    const { store, config } = this.deps;
    const req = parsed.request;
    const hash = recipientHash(ctx.tenantId, req.channel, req.recipient);
    const hint = recipientHint(req.channel, req.recipient);
    const account = await store.findActiveAccount(ctx.tenantId, ctx.space, req.channel, req.account_ref);
    const provider: CommsProvider = account?.provider ?? PROVIDERS_FOR_CHANNEL[req.channel][0]!;
    const isAddressed = req.kind === "message" || req.kind === "call" || req.kind === "edit";
    const [optedOut, sends24, calls24, hourCount, lastInbound, identity, targetRow, priorConsent, reservation] = await Promise.all([
      isAddressed ? store.isOptedOut(ctx.tenantId, optOutHash(ctx.tenantId, req.channel, req.recipient)) : Promise.resolve(false),
      req.kind === "message" ? store.countRecipient24h(ctx.tenantId, ctx.space, req.channel, hash, "message") : Promise.resolve(0),
      req.kind === "call" ? store.countRecipient24h(ctx.tenantId, ctx.space, req.channel, hash, "call") : Promise.resolve(0),
      store.countAccountHour(ctx.tenantId, ctx.space, req.channel, req.account_ref),
      isAddressed ? store.lastInboundAt(ctx.tenantId, ctx.space, req.channel, req.account_ref, hash) : Promise.resolve(null),
      isAddressed ? this.resolveRecipientIdentity(ctx, req) : Promise.resolve(null),
      (req.kind === "edit" || req.kind === "delete") && req.target_message_id !== undefined ? store.findSentMessage(ctx.tenantId, ctx.space, req.channel, req.target_message_id) : Promise.resolve(null),
      req.purpose === "marketing" && isAddressed ? this.marketing.priorConsent(ctx.tenantId, ctx.space, req.channel, hash).catch(() => false) : Promise.resolve(false),
      req.purpose === "marketing" && isAddressed ? this.marketing.reservationRegister(req.recipient, req.channel).catch((): ReservationRegisterStatus => "unverified") : Promise.resolve("unverified" as ReservationRegisterStatus)
    ]);
    const state: OutboundPolicyState = {
      account_authorized: account !== null,
      recipient_opted_out: optedOut,
      sends_last_24h_to_recipient: sends24,
      calls_last_24h_to_recipient: calls24,
      sends_last_hour_from_account: hourCount,
      last_inbound_at: lastInbound,
      recipient_identity: identity,
      target: req.kind === "edit" || req.kind === "delete"
        ? { own_sent: targetRow !== null && targetRow.recipient_hash === hash, same_account: targetRow !== null && targetRow.account_ref === req.account_ref }
        : null,
      marketing: { prior_consent: priorConsent, reservation_register: reservation }
    };
    const decision = evaluateOutboundPolicy(req, state, config, this.deps.clock());
    return { parsed, decision, account, provider, recipient_hash: hash, recipient_hint: hint, state, target_log_id: targetRow?.log_id ?? null };
  }

  /** Mottakerens løste identitet (kun EKSAKT treff i Conversation Graph; ukjent forblir ukjent). Aldri en feil: en identitet er et bevis, ikke en forutsetning. */
  private async resolveRecipientIdentity(ctx: FunnelContext, req: OutboundRequest): Promise<{ identity_id: string; confidence: number } | null> {
    const { graph } = this.deps;
    try {
      let identityId: string | null = null;
      let identifier = req.recipient;
      if (req.channel === "sms" || req.channel === "phone" || req.channel === "whatsapp") {
        identityId = (await graph.resolveIdentityByPhone(ctx.tenantId, ctx.space, req.recipient))?.identity_id ?? null;
      } else if (req.channel === "slack" && /^[UW]/.test(req.recipient)) {
        identifier = `${req.account_ref}:${req.recipient}`;
        identityId = (await graph.resolveIdentityByChannel(ctx.tenantId, ctx.space, "slack", identifier))?.identity_id ?? null;
      } else if (req.channel === "messenger" || req.channel === "instagram") {
        identifier = `${req.account_ref}:${req.recipient}`;
        identityId = (await graph.resolveIdentityByChannel(ctx.tenantId, ctx.space, req.channel, identifier))?.identity_id ?? null;
      }
      if (identityId === null) return null;
      const links = await graph.listChannelLinks(ctx.tenantId, ctx.space, identityId);
      const matching = links.filter((l) => l.status === "active" && l.channel_identifier === identifier);
      const confidence = matching.length === 0 ? 0 : Math.max(...matching.map((l) => l.confidence));
      return { identity_id: identityId, confidence };
    } catch {
      return null;
    }
  }

  /** Kort, redigert oppsummering av en evaluering for ToolGateway-preflight/før-etter-evidens og for eieren. Aldri tekst, aldri hele mottakeren. */
  summarize(ev: Evaluation): Record<string, JsonValue> {
    const r = ev.parsed.request;
    return {
      v: 1, kind: r.kind, channel: r.channel, provider: ev.provider, purpose: r.purpose,
      allowed: ev.decision.allowed, denial_codes: [...ev.decision.denial_codes],
      rules: ev.decision.rules.map((x) => ({ rule: x.rule, outcome: x.outcome, ...(x.code !== undefined ? { code: x.code } : {}) })),
      recipient: { hint: ev.recipient_hint, proof: { method: ev.decision.recipient_proof.method, identity_linked: ev.decision.recipient_proof.identity_id !== null, last_inbound_age_minutes: ev.decision.recipient_proof.last_inbound_age_minutes } },
      content: { sha256: ev.decision.content_sha256, length: ev.decision.content_length, ai_disclosure_applied: ev.decision.disclosure_applied },
      counters: { recipient_24h: ev.state.sends_last_24h_to_recipient, account_1h: ev.state.sends_last_hour_from_account }
    };
  }

  private entry(ctx: FunnelContext, ev: Evaluation): JournalEntryInput {
    const r = ev.parsed.request;
    return {
      request_id: ev.parsed.request_id, kind: r.kind, channel: r.channel, account_ref: r.account_ref, provider: ev.provider, recipient_hash: ev.recipient_hash, recipient_hint: ev.recipient_hint,
      purpose: r.purpose, rule_evaluation: ev.decision.rules, denial_codes: ev.decision.denial_codes, recipient_proof: ev.decision.recipient_proof, content_sha256: ev.decision.content_sha256,
      content_length: ev.decision.content_length, ai_disclosure_applied: ev.decision.disclosure_applied, ...(ev.target_log_id !== null ? { target_log_id: ev.target_log_id } : {}),
      ...(r.thread_ref !== undefined ? { thread_ref: r.thread_ref } : {}), source: ctx.source
    };
  }

  /**
   * Har denne forespørsels-id-en allerede et (ikke-avslått) forsøk? Da er det en GJENSPILLING: eier-ruten sender den rett til gatewayen (ledgeren gir det første resultatet tilbake; journalens unike nøkkel er andre vern) i stedet for å
   * vurdere policyen på nytt mot en tilstand det første forsøket selv har endret (ratetelleren ville ellers avslå en ellers idempotent gjenspilling). Ingenting kan sendes to ganger av dette: nytt utsendelsesforsøk går alltid gjennom preflight,
   * policyen i transporten og `beginAttempt` (som gir `replay`).
   */
  async hasPriorAttempt(ctx: FunnelContext, requestId: string): Promise<boolean> {
    return (await this.deps.store.findAttempt(ctx.tenantId, ctx.space, requestId)) !== null;
  }

  /** A-H2: taket ble nådd UNDER låsen (policyens tørrkjøring så det ikke): avslaget journalføres med regelen som faktisk slo til, så beviset og utfallet stemmer. */
  private withCapDenial(ev: Evaluation, scope: "recipient" | "account", code: string): Evaluation {
    const ruleName = scope === "recipient" ? "rate_limit_recipient" : "rate_limit_account";
    const rules = ev.decision.rules.map((r) => (r.rule === ruleName ? ({ rule: ruleName, outcome: "deny", code } as const) : r));
    return { ...ev, decision: { ...ev.decision, allowed: false, denial_codes: [...new Set([...ev.decision.denial_codes, code])], rules } };
  }

  /** Journalfører et avslag (bevis) uten å sende. Brukes av eier-ruten når tørrkjøringen avslår. */
  async recordDenial(ctx: FunnelContext, ev: Evaluation): Promise<string> {
    return this.deps.store.recordDenied(ctx.tenantId, ctx.space, this.entry(ctx, ev), ctx.actor, this.deps.config.log_retention_days);
  }

  async send(ctx: FunnelContext, parsed: ParsedOutbound, credential: string): Promise<ExecResult> {
    return this.execute(ctx, parsed, credential);
  }

  /** Utfører (send/edit/delete/reaksjon) ETTER en ny policyevaluering og med journalføring før og etter leverandørkallet. Den ENESTE veien til en adapter. */
  async execute(ctx: FunnelContext, parsed: ParsedOutbound, credential: string): Promise<ExecResult> {
    const { store, adapters, config } = this.deps;
    const ev = await this.evaluate(ctx, parsed);
    if (!ev.decision.allowed) {
      await this.recordDenial(ctx, ev);
      throw new Error(`comms_policy_denied:${ev.decision.denial_codes.slice(0, 4).join(".")}`.slice(0, 120));
    }
    const req = parsed.request;
    const adapter = ev.account === null ? undefined : adapters[ev.account.provider];
    if (adapter === undefined) throw new Error("comms_adapter_unavailable");
    const supported = req.kind === "message" ? true : req.kind === "edit" ? adapter.edit !== undefined : req.kind === "delete" ? adapter.delete !== undefined : req.kind === "call" ? adapter.call !== undefined : adapter.react !== undefined;
    if (!supported) throw new Error("comms_action_not_supported_by_provider");
    // A-H2: ratetakene håndheves ATOMISK i `beginAttempt` (lås + ny telling + INSERT i samme transaksjon); policyen over er kun den rådgivende tørrkjøringen.
    const caps = rateCaps(req.kind, ev.decision.recipient_proof.method === "explicit_param", config);
    const begin = await store.beginAttempt(ctx.tenantId, ctx.space, this.entry(ctx, ev), ctx.actor, config.log_retention_days, caps);
    if (begin.kind === "cap_exceeded") {
      await this.recordDenial(ctx, this.withCapDenial(ev, begin.scope, begin.code));
      throw new Error(`comms_policy_denied:${begin.code}`);
    }
    if (begin.kind === "replay") {
      if (begin.status === "sent") {
        return { external_id: begin.provider_message_id ?? "replayed", data: { log_id: begin.log_id, status: "sent", deduplicated: true, channel: req.channel, kind: req.kind } };
      }
      if (begin.status === "failed") throw new Error("comms_request_id_burned_use_a_new_key");
      throw new Error("outcome_unknown:comms_request_in_flight_or_unknown");
    }
    const target = { account_ref: req.account_ref, recipient: req.recipient };
    try {
      let providerMessageId: string;
      let threadRef: string | undefined;
      if (req.kind === "message") {
        const media = req.content.media === undefined ? null : { kind: req.content.media.kind, url: req.content.media.url };
        const result = await adapter.send({ ...target, text: ev.decision.final_text, template: req.content.template ?? null, media, thread_ref: req.thread_ref ?? null }, credential);
        providerMessageId = result.provider_message_id;
        threadRef = result.thread_ref;
      } else if (req.kind === "call") {
        // Manuset er policyens `final_text` (AI-opplysningen FØRST) - aldri den rå forespørselsteksten.
        providerMessageId = (await adapter.call!({ ...target, script: ev.decision.final_text! }, credential)).provider_message_id;
      } else if (req.kind === "edit") {
        providerMessageId = (await adapter.edit!({ ...target, target_message_id: req.target_message_id!, text: ev.decision.final_text! }, credential)).provider_message_id;
      } else if (req.kind === "delete") {
        await adapter.delete!({ ...target, target_message_id: req.target_message_id! }, credential);
        providerMessageId = req.target_message_id!;
      } else {
        await adapter.react!({ ...target, target_message_id: req.target_message_id!, reaction: req.content.reaction! }, credential);
        providerMessageId = req.target_message_id!;
      }
      await store.settleAttempt(ctx.tenantId, ctx.space, begin.log_id, {
        status: "sent", provider_message_id: providerMessageId, ...(threadRef !== undefined ? { thread_ref: threadRef } : {}),
        after_state: { provider_message_id_present: true }
      });
      if (req.kind === "message") await this.recordTimeline(ctx, ev, begin.log_id);
      return {
        external_id: providerMessageId,
        data: { log_id: begin.log_id, status: "sent", channel: req.channel, kind: req.kind, content_sha256: ev.decision.content_sha256, ai_disclosure_applied: ev.decision.disclosure_applied, ...(threadRef !== undefined ? { thread_ref: threadRef } : {}) }
      };
    } catch (err) {
      const unknown = isOutcomeUnknownMessage(err instanceof Error ? err.message : "") || (!(err instanceof ProviderRejectedError) && isIndeterminateTransportError(err));
      // Vi VET ikke om sendingen gikk gjennom (ukjent) eller at den ikke gjorde det (avslag/feil før sending).
      await store.settleAttempt(ctx.tenantId, ctx.space, begin.log_id, { status: unknown ? "outcome_unknown" : "failed", after_state: { error: safeError(err) } }).catch((e) => this.deps.warn?.({ msg: "comms_journal_settle_failed", error: safeError(e) }));
      // Twilio 21610 = mottakeren har meldt STOPP hos operatør/Twilio: registrer det hos oss også (opt-out kan aldri «glemmes» av et vellykket nytt forsøk) - tenant-bredt (A-M3).
      if (err instanceof ProviderRejectedError && err.provider === "twilio" && err.code === "21610") {
        await store.recordOptOut(ctx.tenantId, ctx.space, {
          channel: req.channel, recipient_hash: optOutHash(ctx.tenantId, req.channel, req.recipient), recipient_hint: ev.recipient_hint, source: "provider_error", evidence_ref: "twilio:21610",
          recorded_by: "system", session_id: ctx.actor.session_id, ...(ctx.actor.task_id !== undefined ? { task_id: ctx.actor.task_id } : {})
        }).catch(() => undefined);
      }
      if (unknown && !(err instanceof Error && isOutcomeUnknownMessage(err.message))) throw new Error("outcome_unknown:comms_transport_indeterminate");
      throw err;
    }
  }

  /** D-121: en utsendt melding til en løst identitet med lenket kontakt blir en pekerrad i `business_activities` (fast tekst, aldri innhold). Best-effort: en feil her endrer aldri utfallet av en sendt melding. */
  private async recordTimeline(ctx: FunnelContext, ev: Evaluation, logId: string): Promise<void> {
    const { business, graph } = this.deps;
    const identityId = ev.decision.recipient_proof.identity_id;
    if (business === undefined || identityId === null) return;
    try {
      const identity = await graph.readIdentity(ctx.tenantId, ctx.space, identityId);
      if (identity?.linked_business_contact_id === null || identity?.linked_business_contact_id === undefined) return;
      await business.recordActivity(ctx.tenantId, ctx.space, {
        activity_type: "external_event", summary: `Melding sendt (${ev.parsed.request.channel})`, contact_id: identity.linked_business_contact_id,
        source_type: `comms_${ev.parsed.request.channel}`, source_instance_id: ev.parsed.request.account_ref, external_id: logId, canonical_uri: `comms:outbound:${logId}`, occurred_at: this.deps.clock().toISOString()
      });
    } catch (err) {
      this.deps.warn?.({ msg: "comms_timeline_record_failed", error: safeError(err) });
    }
  }

  /** Fersk lesing for `delete_message`-preflight: finnes meldingen hos leverandøren, og er den vår? `null` = finnes ikke (etterbetingelsen for sletting). */
  async checkTarget(ctx: FunnelContext, parsed: ParsedOutbound, credential: string): Promise<Record<string, JsonValue> | null> {
    const ev = await this.evaluate(ctx, parsed);
    const adapter = ev.account === null ? undefined : this.deps.adapters[ev.account.provider];
    if (adapter?.messageExists === undefined) throw new Error("comms_target_read_not_supported_by_provider");
    const exists = await adapter.messageExists({ account_ref: parsed.request.account_ref, recipient: parsed.request.recipient, target_message_id: parsed.request.target_message_id! }, credential);
    if (!exists) return null;
    return { ...this.summarize(ev), exists: true };
  }
}
