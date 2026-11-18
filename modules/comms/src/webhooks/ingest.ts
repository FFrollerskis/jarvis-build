import { randomUUID } from "node:crypto";
import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { BusinessService } from "@jarvis/business";
import { scanForSecrets } from "@jarvis/core";
import type { ConversationGraphService } from "@jarvis/conversation-graph";
import { recipientHash, recipientHint, sha256Hex, type CommsChannel } from "../channels.ts";
import type { CommsConfig, CommsWebhookProvider } from "../config.ts";
import { OPT_KEYWORD_CHANNELS, parseOptKeyword } from "../optout.ts";
import type { Clock, CommsStore, OptEffect } from "../store.ts";
import { parseMetaBody, parseSlackBody, parseTelnyxBody, parseTwilioParams, type NormalizedInbound, type ParseOutcome } from "./parsers.ts";
import { secretsEqual, verifyMetaSignature, verifySlackSignature, verifyTelnyxSignature, verifyTwilioSignature } from "./verify.ts";

/**
 * WP-G1 (D-463, P1d): inngangen for signerte innkommende webhooks (Slack, Meta, Twilio, Telnyx). Rekkefølge, alltid: konfigurert? -> hemmelighet fra hvelvet -> SIGNATURVERIFISERING mot rå bytes (ingenting leses av kroppen før den
 * består) -> tolkning -> per hendelse: konto på allowlist? -> ferskhet -> gjenspillingsvern (UNIQUE) -> lagring som UBETRODD data -> avmelding (STOP/START) -> tidslinjepeker.
 *
 * UBETRODD INNHOLD (CLAUDE.md regel 7, akseptansekravet «untrusted messages cannot directly exfiltrate unrelated private data or raw secrets»): ingenting i en melding kan utløse en handling. Inntaket har INGEN vei til
 * ToolGateway, modell, minne eller utsendelse - det eneste en melding kan føre til er (1) en lagret, renset og hemmelighetsskannet rad merket `untrusted`, (2) en deterministisk avmelding/gjenopptak når HELE meldingen er ett
 * stopp-/start-ord, og (3) en tidslinjepeker med FAST tekst. Teksten er aldri en instruksjon og kopieres aldri videre. Svaret til leverandøren ekkoer aldri innhold - kun tellere.
 */
export interface SecretReader {
  get(ref: string): Promise<string | null>;
}

export interface WebhookRequest {
  readonly method: string;
  /** Header-navn i små bokstaver. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: Buffer;
  /** Sti + query slik leverandøren kalte den (`/webhooks/comms/twilio?x=1`). Twilio signerer mot basis-URL + dette. */
  readonly pathAndQuery: string;
  readonly query: URLSearchParams;
}

export interface WebhookResponse {
  readonly status: number;
  readonly body: Record<string, JsonValue> | string;
}

export interface WebhookDeps {
  readonly store: CommsStore;
  readonly graph: Pick<ConversationGraphService, "resolveIdentityByChannel" | "resolveIdentityByPhone" | "readIdentity">;
  readonly config: CommsConfig;
  readonly secrets: SecretReader;
  readonly clock: Clock;
  readonly business?: Pick<BusinessService, "recordActivity">;
  readonly warn?: (event: Record<string, unknown>) => void;
}

export const WEBHOOK_SECRET_REFS = {
  slack: "JARVIS_SLACK_SIGNING_SECRET",
  meta: "JARVIS_META_APP_SECRET",
  metaVerifyToken: "JARVIS_META_WEBHOOK_VERIFY_TOKEN",
  twilio: "JARVIS_TWILIO_AUTH_TOKEN",
  telnyx: "JARVIS_TELNYX_WEBHOOK_PUBLIC_KEY"
} as const;

/** Maks størrelse på en webhook-kropp (ruten håndhever den FØR signaturen vurderes). */
export const WEBHOOK_MAX_BYTES = 256 * 1024;
/** Avmeldings-/gjenopptakshendelser beholdes lenge (kun pseudonym, ingen tekst): en gjenspilt gammel START skal ikke kunne oppheve en nyere avmelding. */
const OPT_EVENT_RETENTION_DAYS = 1825;
const EXCERPT_MAX = 2000;
/** DB-grensen for `evidence_ref` (migrasjon 118). Leverandørens hendelsesnøkkel kan være opptil 300 tegn (WhatsApp-meldings-id alene kan være 200). */
const EVIDENCE_REF_MAX = 200;

/**
 * Peker fra en avmelding til hendelsen som beviste den (B-H2). Er nøkkelen for lang for kolonnen erstattes den av sin SHA-256 (`sha256:<hex>`, fortsatt sporbar mot hendelsesraden) - en avmelding kan ALDRI feile på lengden på en
 * leverandør-id (før: WhatsApp-STOP med meldings-id på 194+ tegn ga CHECK-brudd ETTER at dedupe-raden var lagret, og avmeldingen gikk tapt for alltid).
 */
export function evidenceRefFor(eventKey: string): string {
  return eventKey.length <= EVIDENCE_REF_MAX ? eventKey : `sha256:${sha256Hex(eventKey)}`;
}

/** Renser ubetrodd meldingstekst for lagring: kontrolltegn/usynlige tegn fjernes, hemmeligheter redigeres, lengden begrenses (kodepunkt-sikkert). */
export function sanitizeInboundText(text: string | null): string | null {
  if (text === null) return null;
  let cleaned = "";
  for (const ch of text) {
    if (ch === "\n" || ch === "\t") cleaned += ch;
    else if (/[\p{Zl}\p{Zp}]/u.test(ch)) cleaned += " ";
    else if (!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(ch)) cleaned += ch;
  }
  const scanned = scanForSecrets(cleaned.trim()).text;
  const points = Array.from(scanned);
  const cut = points.length > EXCERPT_MAX ? `${points.slice(0, EXCERPT_MAX - 1).join("")}…` : scanned;
  return cut.length === 0 ? null : cut;
}

export interface IngestSummary {
  received: number;
  inserted: number;
  duplicates: number;
  ignored: number;
  opt_outs: number;
  opt_ins: number;
}

const emptySummary = (): IngestSummary => ({ received: 0, inserted: 0, duplicates: 0, ignored: 0, opt_outs: 0, opt_ins: 0 });

function formParams(raw: Buffer): Map<string, string[]> | null {
  try {
    const params = new URLSearchParams(raw.toString("utf8"));
    const map = new Map<string, string[]>();
    for (const [k, v] of params) map.set(k, [...(map.get(k) ?? []), v]);
    return map;
  } catch {
    return null;
  }
}

export class CommsWebhookService {
  constructor(private readonly deps: WebhookDeps) {}

  private reject(status: number, code: string): WebhookResponse {
    return { status, body: { error: code } };
  }

  async handle(provider: CommsWebhookProvider, req: WebhookRequest): Promise<WebhookResponse> {
    const { config, secrets, clock } = this.deps;
    if (!config.webhooks.has(provider)) return this.reject(404, "not_found");
    // Fail-closed: uten en eksplisitt tenant er det ingen eier å skrive til.
    if (config.webhook_tenant_id === null) return this.reject(503, "not_configured");
    const nowSeconds = Math.floor(clock().getTime() / 1000);

    if (provider === "meta" && req.method === "GET") return this.metaHandshake(req);
    if (req.method !== "POST") return this.reject(405, "method_not_allowed");

    let outcome: ParseOutcome;
    if (provider === "slack") {
      const secret = await secrets.get(WEBHOOK_SECRET_REFS.slack);
      if (!secret) return this.reject(503, "not_configured");
      const v = verifySlackSignature({ rawBody: req.rawBody, timestamp: req.headers["x-slack-request-timestamp"], signature: req.headers["x-slack-signature"], signingSecret: secret, nowSeconds });
      if (!v.ok) return this.invalid(provider, v.reason);
      const body = this.json(req.rawBody);
      if (body === undefined) return this.reject(400, "malformed");
      const parsed = parseSlackBody(body);
      if (parsed.challenge !== undefined) return { status: 200, body: { challenge: parsed.challenge } };
      outcome = parsed;
    } else if (provider === "meta") {
      const secret = await secrets.get(WEBHOOK_SECRET_REFS.meta);
      if (!secret) return this.reject(503, "not_configured");
      const v = verifyMetaSignature({ rawBody: req.rawBody, signature: req.headers["x-hub-signature-256"], appSecret: secret });
      if (!v.ok) return this.invalid(provider, v.reason);
      const body = this.json(req.rawBody);
      if (body === undefined) return this.reject(400, "malformed");
      outcome = parseMetaBody(body);
    } else if (provider === "twilio") {
      const token = await secrets.get(WEBHOOK_SECRET_REFS.twilio);
      if (!token || config.public_base_url === null) return this.reject(503, "not_configured");
      const params = formParams(req.rawBody);
      if (params === null) return this.reject(400, "malformed");
      const v = verifyTwilioSignature({ url: `${config.public_base_url}${req.pathAndQuery}`, params, signature: req.headers["x-twilio-signature"], authToken: token });
      if (!v.ok) return this.invalid(provider, v.reason);
      outcome = parseTwilioParams(params);
    } else {
      const key = await secrets.get(WEBHOOK_SECRET_REFS.telnyx);
      if (!key) return this.reject(503, "not_configured");
      const v = verifyTelnyxSignature({
        rawBody: req.rawBody, signature: req.headers["telnyx-signature-ed25519"], timestamp: req.headers["telnyx-timestamp"], publicKeyBase64: key, nowSeconds
      });
      if (!v.ok) return this.invalid(provider, v.reason);
      const body = this.json(req.rawBody);
      if (body === undefined) return this.reject(400, "malformed");
      outcome = parseTelnyxBody(body);
    }

    const summary = emptySummary();
    summary.ignored += outcome.ignored;
    const ingestId = `ingest-${randomUUID()}`;
    for (const event of outcome.events) {
      summary.received++;
      await this.processEvent(event, ingestId, summary);
    }
    return { status: 200, body: { received: true, events: { ...summary } } };
  }

  /** Metas GET-håndtrykk (`hub.mode=subscribe`): ingen signatur - autentiseres med verifiseringstokenet (konstant-tid). Svarer med utfordringen som ren tekst. */
  private async metaHandshake(req: WebhookRequest): Promise<WebhookResponse> {
    const expected = await this.deps.secrets.get(WEBHOOK_SECRET_REFS.metaVerifyToken);
    if (!expected) return this.reject(503, "not_configured");
    const mode = req.query.get("hub.mode");
    const token = req.query.get("hub.verify_token");
    const challenge = req.query.get("hub.challenge");
    if (mode !== "subscribe" || token === null || challenge === null || !secretsEqual(token, expected) || !/^[A-Za-z0-9_-]{1,200}$/.test(challenge)) return this.reject(403, "forbidden");
    return { status: 200, body: challenge };
  }

  private invalid(provider: CommsWebhookProvider, reason: string): WebhookResponse {
    // Årsaken logges (kode, aldri kropp/hemmelighet) men svares aldri: ingen orakel for en angriper.
    this.deps.warn?.({ msg: "comms_webhook_rejected", provider, reason });
    return this.reject(401, "invalid_signature");
  }

  private json(raw: Buffer): unknown {
    try {
      return JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  private async processEvent(ev: NormalizedInbound, ingestId: string, summary: IngestSummary): Promise<void> {
    const { store, config, clock } = this.deps;
    const tenantId = config.webhook_tenant_id as string;
    const space: MemorySpace = config.webhook_memory_space;
    // Kun kontoer eieren har autorisert: en hendelse til en ukjent konto lagres ikke (ingen unødvendige personopplysninger).
    const account = await store.findActiveAccount(tenantId, space, ev.channel, ev.account_ref);
    if (account === null) { summary.ignored++; return; }
    // Ferskhet: en hendelse eldre enn dedupe-vinduet (retensjon) kan være en gjenspilling etter at dedupe-raden er slettet.
    if (ev.provider_ts !== null && clock().getTime() - Date.parse(ev.provider_ts) > config.inbound_retention_days * 86_400_000) { summary.ignored++; return; }

    const hash = ev.reply_to === null ? null : recipientHash(tenantId, ev.channel, ev.reply_to);
    const hint = ev.reply_to === null ? null : recipientHint(ev.channel, ev.reply_to);
    const keyword = ev.kind === "message" && hash !== null && OPT_KEYWORD_CHANNELS.has(ev.channel) ? parseOptKeyword(ev.text) : null;
    const kind = keyword === "stop" ? "opt_out" : keyword === "start" ? "opt_in" : ev.kind;
    const excerpt = kind === "opt_out" || kind === "opt_in" ? null : sanitizeInboundText(ev.text);
    const identity = ev.kind === "message" && ev.sender !== null ? await this.resolveIdentity(tenantId, space, ev.channel, ev.sender) : null;

    // B-H2: STOP/START skrives i SAMME transaksjon som dedupe-raden (en feil rulles tilbake sammen og leverandørens retry behandles på nytt - aldri en «duplikat» uten avmelding).
    const effect: OptEffect | undefined = hash === null || hint === null ? undefined
      : kind === "opt_out" ? { kind: "stop", channel: ev.channel, account_ref: ev.account_ref, recipient_hash: hash, recipient_hint: hint, evidence_ref: evidenceRefFor(ev.event_key) }
        : kind === "opt_in" ? { kind: "start", channel: ev.channel, account_ref: ev.account_ref, recipient_hash: hash, recipient_hint: hint, evidence_ref: evidenceRefFor(ev.event_key) } : undefined;
    const rec = await store.recordInbound(tenantId, space, {
      provider: ev.provider, channel: ev.channel, account_ref: ev.account_ref, event_key: ev.event_key, kind, sender_hash: hash, sender_hint: hint, identity_id: identity?.identity_id ?? null,
      thread_ref: ev.thread_ref, content_excerpt: excerpt, content_sha256: ev.text === null ? null : sha256Hex(ev.text), provider_ts: ev.provider_ts, ingest_id: ingestId
    }, kind === "opt_out" || kind === "opt_in" ? OPT_EVENT_RETENTION_DAYS : config.inbound_retention_days, effect);
    if (!rec.inserted) { summary.duplicates++; return; }
    summary.inserted++;

    if (effect?.kind === "stop") {
      summary.opt_outs++;
    } else if (effect?.kind === "start") {
      summary.opt_ins++;
    } else if (kind === "message" && identity !== null && rec.event_id !== null) {
      await this.recordTimeline(tenantId, space, ev.channel, ev.account_ref, identity.linked_business_contact_id, rec.event_id);
    }
  }

  /** EKSAKT identitetsoppslag (aldri opprettelse): ukjent avsender forblir ukjent (Q-26). */
  private async resolveIdentity(tenantId: string, space: MemorySpace, channel: CommsChannel, sender: string): Promise<{ identity_id: string; linked_business_contact_id: string | null } | null> {
    const { graph } = this.deps;
    try {
      const identity = channel === "sms" || channel === "whatsapp" || channel === "phone"
        ? await graph.resolveIdentityByPhone(tenantId, space, sender)
        : channel === "slack" || channel === "messenger" || channel === "instagram" ? await graph.resolveIdentityByChannel(tenantId, space, channel, sender) : null;
      return identity === null ? null : { identity_id: identity.identity_id, linked_business_contact_id: identity.linked_business_contact_id };
    } catch {
      return null;
    }
  }

  /** D-121: en mottatt melding fra en løst identitet med lenket kontakt blir en pekerrad med FAST tekst (aldri innhold). Best-effort - lagringen av hendelsen er allerede gjort. */
  private async recordTimeline(tenantId: string, space: MemorySpace, channel: CommsChannel, accountRef: string, contactId: string | null, eventId: string): Promise<void> {
    const { business, clock } = this.deps;
    if (business === undefined || contactId === null) return;
    try {
      await business.recordActivity(tenantId, space, {
        activity_type: "external_event", summary: `Melding mottatt (${channel})`, contact_id: contactId, source_type: `comms_${channel}`, source_instance_id: accountRef, external_id: eventId,
        canonical_uri: `comms:inbound:${eventId}`, occurred_at: clock().toISOString()
      });
    } catch (err) {
      this.deps.warn?.({ msg: "comms_inbound_timeline_failed", error: err instanceof Error ? err.message.slice(0, 80) : "unknown" });
    }
  }
}
