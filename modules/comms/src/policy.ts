import { containsSecret } from "@jarvis/core";
import { CHANNEL_PROFILES, CUSTOMER_SERVICE_WINDOW_MS, normalizeRecipient, sha256Hex, type CommsChannel } from "./channels.ts";
import type { CommsConfig } from "./config.ts";

/**
 * WP-G1 (D-463, P1b): DEN felles, deterministiske utgående kommunikasjonspolicyen (CLAUDE.md regel 2/6: kode, aldri prompt). ALLE nye sendeveier (`comms.send`, `comms.edit_message`, `comms.add_reaction`, utgående samtale)
 * går gjennom `evaluateOutboundPolicy` - både som tørrkjøring i preflight og på nytt rett før leverandørkallet (forsvar i dybden mot at tilstanden flytter seg).
 *
 * Funksjonen er REN: all tilstand (konto-allowlist, opt-out, tellere, siste innkommende melding, identitet, markedsføringsgrunnlag) leses av kalleren fra databasen og gis inn - slik at hver regel kan bevises isolert og
 * ingen modellstyrt parameter kan nå en tilstand (det finnes ingen parameter for AI-opplysning, stille timer, opt-out eller mål-konto: de utledes her og fra tilstanden). ALLE regler evalueres (ingen kortslutning): eieren
 * ser hele listen over hvorfor noe ble stoppet. `allowed` er kun `true` når INGEN regel avslo.
 *
 * Merk om eier-suverenitet (D-41/D-192): policyen er IKKE en godkjenningssperre for eieren - den håndhever mottakerens rettigheter (opt-out, markedsføringsregler, plattformvindu, stille timer, AI-opplysning) og
 * eierens EGNE konto-allowlist. Eieren kan endre allowlist og stille timer; mottakerens avmelding og markedsføringsforbudet kan ikke slås av av noen parameter.
 */
export type OutboundKind = "message" | "edit" | "delete" | "reaction" | "call";
export type OutboundPurpose = "transactional" | "agreed" | "marketing";
export const OUTBOUND_PURPOSES: readonly OutboundPurpose[] = ["transactional", "agreed", "marketing"];

export interface TemplateContent {
  readonly name: string;
  readonly language: string;
  readonly params: readonly string[];
}

export interface MediaContent {
  readonly kind: "image" | "document" | "audio" | "video";
  readonly url: string;
  readonly caption?: string;
}

export interface OutboundContent {
  readonly text?: string;
  readonly template?: TemplateContent;
  readonly media?: MediaContent;
  /** Emoji/reaksjonsnavn for `reaction`. */
  readonly reaction?: string;
  /** Samtale: eieren ber om opptak (bygges IKKE: se `call_recording_not_supported`). */
  readonly recording?: boolean;
}

export interface OutboundRequest {
  readonly kind: OutboundKind;
  readonly channel: CommsChannel;
  readonly account_ref: string;
  /** NORMALISERT mottaker (`normalizeRecipient`); policyen validerer den på nytt. */
  readonly recipient: string;
  readonly purpose: OutboundPurpose;
  readonly content: OutboundContent;
  readonly thread_ref?: string;
  /** Leverandørens meldings-id for `edit`/`delete`/`reaction`. */
  readonly target_message_id?: string;
}

export type ReservationRegisterStatus = "not_reserved" | "reserved" | "unverified";

export interface OutboundPolicyState {
  readonly account_authorized: boolean;
  readonly recipient_opted_out: boolean;
  readonly sends_last_24h_to_recipient: number;
  readonly calls_last_24h_to_recipient: number;
  readonly sends_last_hour_from_account: number;
  /** ISO-tidspunkt for mottakerens siste VERIFISERTE innkommende melding til denne kontoen (kun signaturverifiserte webhook-hendelser), ellers `null`. */
  readonly last_inbound_at: string | null;
  readonly recipient_identity: { readonly identity_id: string; readonly confidence: number } | null;
  /** For `edit`/`delete`: er målet en melding Jarvis selv har sendt fra DENNE kontoen (journalen). */
  readonly target: { readonly own_sent: boolean; readonly same_account: boolean } | null;
  readonly marketing: { readonly prior_consent: boolean; readonly reservation_register: ReservationRegisterStatus };
}

export type RuleOutcome = "pass" | "deny" | "not_applicable";
export interface RuleResult {
  readonly rule: string;
  readonly outcome: RuleOutcome;
  readonly code?: string;
}

export interface RecipientProof {
  readonly method: "inbound_thread" | "identity_link" | "explicit_param";
  readonly identity_id: string | null;
  readonly confidence: number | null;
  readonly last_inbound_age_minutes: number | null;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly denial_codes: readonly string[];
  readonly rules: readonly RuleResult[];
  /** NØYAKTIG teksten som sendes (AI-opplysningen lagt til). `null` for maler, reaksjoner og slettinger. */
  readonly final_text: string | null;
  readonly disclosure_applied: boolean;
  readonly content_sha256: string | null;
  readonly content_length: number;
  readonly recipient_proof: RecipientProof;
}

/** Opptaksvarsel som alltid er med i en samtale som tas opp - men opptak bygges ikke (se `evaluateOutboundPolicy`). Eksportert for testene. */
export const MARKETING_OPT_OUT_INSTRUCTION = /\b(stopp?|avmeld\w*|unsubscribe|reserver\w*)\b/i;

/** Slack: kringkastingsomtaler (`<!channel>`, `<!here>`, `<!everyone>`, brukergrupper) kan aldri komme fra en modellstyrt tekst. */
const SLACK_BROADCAST = /<!(channel|here|everyone|subteam\^[A-Za-z0-9]+)(\|[^>]*)?>/i;
/** Discord/andre: tekstlig @everyone/@here - leverandøradapteren slår dessuten av omtale-parsing (`allowed_mentions`). */
const AT_BROADCAST = /(^|[^\p{L}\p{N}])@(everyone|here|channel)(?![\p{L}\p{N}])/iu;

/**
 * Markedsføringsspråk (norsk og engelsk). Forsvar i DYBDEN, ikke bevis: en modell kan merke en reklame «transactional». Treffer teksten dette OG mottakeren ikke har skrevet til oss siste `reply_window_days`
 * (en fersk samtale er per definisjon ikke uanmodet), avvises meldingen som `content_looks_like_marketing` - eieren kan sende den som `marketing` (som feiler lukket uten verifisert reservasjonsoppslag og samtykke).
 */
const MARKETING_LANGUAGE: readonly RegExp[] = [
  /\b(tilbud|rabatt\w*|kampanje\w*|kupong\w*|salg|gratis|nyhetsbrev|abonner\w*|prøvemåned|prøveperiode|bestill nå|kjøp nå|begrenset tid|siste sjanse)\b/i,
  /\d+\s?% (rabatt|avslag|off)/i,
  /\b(discount|special offer|limited[- ]time|free trial|buy now|order now|sign up now|exclusive deal|promo(tion)?|newsletter|subscribe|unsubscribe)\b/i
];

export function looksLikeMarketing(text: string): boolean {
  return MARKETING_LANGUAGE.some((pattern) => pattern.test(text));
}

/** Klokketime 0-23 i en tidssone (Intl; «24» ved midnatt normaliseres til 0). */
export function localHour(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone, hour12: false, hour: "2-digit" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "NaN");
  return Number.isFinite(hour) ? hour % 24 : Number.NaN;
}

/** Rolig time? start<slutt: [start,slutt). start>slutt (over midnatt): ≥start eller <slutt. start=slutt: hele døgnet (fail-closed). Ugyldig time er rolig (fail-closed). */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return true;
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Tekst som kan sendes: ingen kontrollbokstaver (unntatt linjeskift/tabulator), ingen usynlige formateringstegn (bidi/null-bredde), ingen ensomme surrogater, ingen Unicode-linjeseparatorer. */
export function textIsSendable(text: string): boolean {
  for (const ch of text) {
    if (ch === "\n" || ch === "\t") continue;
    if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(ch)) return false;
  }
  return true;
}

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const MEDIA_KINDS: readonly string[] = ["image", "document", "audio", "video"];

function ageMinutes(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, (now.getTime() - ms) / 60_000) : null;
}

function validateTemplate(template: TemplateContent): boolean {
  return TEMPLATE_NAME.test(template.name) && TEMPLATE_LANGUAGE.test(template.language) && template.params.length <= 10
    && template.params.every((p) => p.length > 0 && p.length <= 200 && textIsSendable(p) && !p.includes("\n") && !containsSecret(p));
}

function contentCanonical(request: OutboundRequest, finalText: string | null): string | null {
  const c = request.content;
  if (request.kind === "delete") return `delete:${request.target_message_id ?? ""}`;
  if (request.kind === "reaction") return `reaction:${request.target_message_id ?? ""}:${c.reaction ?? ""}`;
  if (c.template) return JSON.stringify(["template", c.template.name, c.template.language, [...c.template.params]]);
  if (c.media) return JSON.stringify(["media", c.media.kind, c.media.url, finalText ?? ""]);
  return finalText;
}

/** Kallerens (route/verktøy) bevisste, ikke-modellstyrte tilstand for «nå». Injiseres slik at testene er deterministiske. */
export function evaluateOutboundPolicy(request: OutboundRequest, state: OutboundPolicyState, config: CommsConfig, now: Date): PolicyDecision {
  const rules: RuleResult[] = [];
  const profile = CHANNEL_PROFILES[request.channel];
  const add = (rule: string, outcome: RuleOutcome, code?: string): void => {
    rules.push(code === undefined ? { rule, outcome } : { rule, outcome, code });
  };
  const deny = (rule: string, code: string): void => add(rule, "deny", code);
  const isMessageLike = request.kind === "message" || request.kind === "call";
  const content = request.content;

  // ---- mottakerbevis: HVORDAN vet vi at dette er en mottaker vi har grunn til å skrive til? (alltid utledet fra tilstanden, aldri fra en parameter) ----
  const inboundAgeMin = ageMinutes(state.last_inbound_at, now);
  const proofMethod: RecipientProof["method"] = inboundAgeMin !== null && inboundAgeMin <= config.reply_window_days * 24 * 60
    ? "inbound_thread"
    : state.recipient_identity !== null ? "identity_link" : "explicit_param";
  const recipient_proof: RecipientProof = {
    method: proofMethod,
    identity_id: state.recipient_identity?.identity_id ?? null,
    confidence: state.recipient_identity?.confidence ?? null,
    last_inbound_age_minutes: inboundAgeMin === null ? null : Math.round(inboundAgeMin)
  };

  // 1. kanal og konto (eierens egen allowlist)
  if (config.channels.has(request.channel)) add("channel_enabled", "pass");
  else deny("channel_enabled", "channel_not_enabled");
  if (state.account_authorized) add("account_authorized", "pass");
  else deny("account_authorized", "account_not_authorized");

  // 2. mottakervalidering (deterministisk, per kanal) - policyen validerer på nytt selv om kalleren har normalisert
  const normalized = normalizeRecipient(request.channel, request.recipient);
  if (!normalized.ok) deny("recipient_format", normalized.code);
  else if (normalized.value !== request.recipient) deny("recipient_format", "recipient_not_normalized");
  else add("recipient_format", "pass");

  // 3. handlingen finnes hos leverandøren for kanalen (leverandørens kapabilitet, aldri Jarvis' valg)
  // `phone` har KUN utgående samtale (ingen tekstmelding); samtale finnes kun på `phone`.
  const kindSupported = request.kind === "call" ? request.channel === "phone"
    : request.channel === "phone" ? false
      : request.kind === "message" ? true
        : request.kind === "edit" ? profile.supports_edit
          : request.kind === "delete" ? profile.supports_delete
            : profile.supports_reaction;
  if (kindSupported) add("kind_supported", "pass");
  else deny("kind_supported", "kind_not_supported_by_channel");

  // 4. mottakerens egen avmelding (STOP): gjelder alt som er adressert til mottakeren. Å slette egen melding berøres ikke.
  if (request.kind === "delete" || request.kind === "reaction") add("recipient_opt_out", "not_applicable");
  else if (state.recipient_opted_out) deny("recipient_opt_out", "recipient_opted_out");
  else add("recipient_opt_out", "pass");

  // 5. formål: markedsføring feiler LUKKET (markedsføringsloven § 15 / Reservasjonsregisteret: oppslaget er uverifisert, samtykkeregisteret er ikke bygget)
  const text = content.text;
  if (!isMessageLike) {
    add("purpose_marketing", "not_applicable");
  } else if (request.purpose === "marketing") {
    if (state.marketing.reservation_register === "reserved") deny("purpose_marketing", "marketing_recipient_in_reservation_register");
    else if (state.marketing.reservation_register === "unverified") deny("purpose_marketing", "marketing_blocked_reservation_register_unverified");
    else if (!state.marketing.prior_consent) deny("purpose_marketing", "marketing_blocked_no_registered_consent");
    else if (text === undefined || !MARKETING_OPT_OUT_INSTRUCTION.test(text)) deny("purpose_marketing", "marketing_missing_opt_out_instruction");
    else add("purpose_marketing", "pass");
  } else {
    add("purpose_marketing", "not_applicable");
  }

  // 5b. ikke-markedsføring som likevel ser ut som reklame til en mottaker uten fersk samtale
  if (isMessageLike && request.purpose !== "marketing") {
    const textLike = text ?? content.media?.caption ?? "";
    if (proofMethod !== "inbound_thread" && textLike.length > 0 && looksLikeMarketing(textLike)) deny("content_not_marketing", "content_looks_like_marketing");
    else add("content_not_marketing", "pass");
  } else {
    add("content_not_marketing", "not_applicable");
  }

  // 5c. «avtalt» krever BEVIS på et forhold (verifisert innkommende tråd eller en løst identitet) - aldri bare at modellen sier det
  if (isMessageLike && request.purpose === "agreed") {
    if (proofMethod === "explicit_param") deny("relationship_evidence", "agreed_requires_relationship_evidence");
    else add("relationship_evidence", "pass");
  } else {
    add("relationship_evidence", "not_applicable");
  }

  // 6. stille timer (mottakerens enhet). Unntak: mottakeren skrev til oss siste `conversational_window_minutes` (da er hen våken). Samtaler har et STRENGERE, eget vindu (under).
  if (isMessageLike && request.kind !== "call" && profile.quiet_hours_apply && config.quiet_hours_enabled) {
    const conversational = inboundAgeMin !== null && inboundAgeMin <= config.conversational_window_minutes;
    if (!conversational && isQuietHour(localHour(now, config.time_zone), config.quiet_start_hour, config.quiet_end_hour)) deny("quiet_hours", "quiet_hours");
    else add("quiet_hours", "pass");
  } else {
    add("quiet_hours", "not_applicable");
  }

  // 7. ratebegrensning (per mottaker per døgn - kald mottaker strengere - og per konto per time)
  if (request.kind === "call") {
    if (state.calls_last_24h_to_recipient >= config.max_calls_per_number_per_day) deny("rate_limit_recipient", "rate_limit_calls_per_number_day");
    else add("rate_limit_recipient", "pass");
  } else if (request.kind === "message") {
    const cap = proofMethod === "explicit_param" ? config.max_cold_per_recipient_per_day : config.max_per_recipient_per_day;
    if (state.sends_last_24h_to_recipient >= cap) deny("rate_limit_recipient", proofMethod === "explicit_param" ? "rate_limit_cold_recipient_day" : "rate_limit_recipient_day");
    else add("rate_limit_recipient", "pass");
  } else {
    add("rate_limit_recipient", "not_applicable");
  }
  if (state.sends_last_hour_from_account >= config.max_per_account_per_hour) deny("rate_limit_account", "rate_limit_account_hour");
  else add("rate_limit_account", "pass");

  // 8. plattformregler: kundeservicevindu (WhatsApp/Messenger/Instagram) - fritekst kun innenfor 24 t etter mottakerens siste melding; WhatsApp tillater godkjente maler utenfor. Meldingskoder (tagger) brukes ALDRI.
  if (request.kind === "message" && profile.requires_open_window) {
    const windowOpen = state.last_inbound_at !== null && now.getTime() - Date.parse(state.last_inbound_at) <= CUSTOMER_SERVICE_WINDOW_MS;
    if (content.template) {
      if (!profile.supports_templates) deny("platform_window", "templates_not_supported_by_channel");
      else add("platform_window", "pass");
    } else if (windowOpen) {
      add("platform_window", "pass");
    } else {
      deny("platform_window", profile.supports_templates ? "outside_window_use_approved_template" : "outside_messaging_window");
    }
  } else if (content.template && request.kind === "message") {
    deny("platform_window", "templates_not_supported_by_channel");
  } else {
    add("platform_window", "not_applicable");
  }

  // 9. innhold + 10. AI-opplysning (lagt til av KODEN, aldri av en parameter)
  let finalText: string | null = null;
  let disclosureApplied = false;
  const disclosure = config.ai_disclosure_text;
  const contentDenials: string[] = [];
  const textKinds = request.kind === "message" || request.kind === "edit" || request.kind === "call";
  if (request.kind === "delete") {
    if (!request.target_message_id) contentDenials.push("target_message_id_missing");
  } else if (request.kind === "reaction") {
    const reaction = content.reaction;
    if (!request.target_message_id) contentDenials.push("target_message_id_missing");
    if (reaction === undefined || reaction.length === 0 || reaction.length > 64 || !textIsSendable(reaction) || reaction.includes("\n")) contentDenials.push("reaction_invalid");
  } else if (textKinds) {
    if (request.kind === "edit" && !request.target_message_id) contentDenials.push("target_message_id_missing");
    const parts =[text !== undefined, content.template !== undefined, content.media !== undefined].filter(Boolean).length;
    if (request.kind !== "message" && (content.template !== undefined || content.media !== undefined)) contentDenials.push("content_kind_not_allowed_for_action");
    else if (parts !== 1) contentDenials.push(parts === 0 ? "content_empty" : "content_ambiguous");
    if (content.template && !validateTemplate(content.template)) contentDenials.push("template_invalid");
    let bodyText: string | undefined = text;
    if (content.media) {
      const media = content.media;
      if (!profile.supports_media) contentDenials.push("media_not_supported_by_channel");
      else if (!MEDIA_KINDS.includes(media.kind)) contentDenials.push("media_kind_invalid");
      else {
        let host: string | null = null;
        try {
          const url = new URL(media.url);
          host = url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && !media.url.includes("\\") ? url.hostname.toLowerCase() : null;
        } catch {
          host = null;
        }
        if (host === null) contentDenials.push("media_url_invalid");
        else if (!config.media_url_hosts.has(host)) contentDenials.push("media_host_not_allowed");
      }
      bodyText = media.caption;
      if (bodyText === undefined || bodyText.length === 0) contentDenials.push("media_caption_required_for_disclosure");
    }
    if (bodyText !== undefined && bodyText.length > 0) {
      if (!textIsSendable(bodyText)) contentDenials.push("content_control_characters");
      if (containsSecret(bodyText)) contentDenials.push("content_contains_secret");
      if (request.channel === "slack" && SLACK_BROADCAST.test(bodyText)) contentDenials.push("content_slack_broadcast_mention");
      if (AT_BROADCAST.test(bodyText)) contentDenials.push("content_broadcast_mention");
    }
    if (bodyText !== undefined && bodyText.trim().length === 0) contentDenials.push("content_empty");
    if (contentDenials.length === 0) {
      if (content.template) {
        // En godkjent mal kan ikke få tekst lagt til: eieren må ha attestert at den inneholder AI-opplysningen.
        if (config.templates_with_disclosure.has(content.template.name)) disclosureApplied = true;
        else contentDenials.push("template_without_disclosure_attestation");
      } else if (bodyText !== undefined) {
        if (request.kind === "call") {
          // Opplysningen kommer FØRST i en utgående samtale (aldri etter at motparten har hørt resten).
          finalText = bodyText.startsWith(disclosure) ? bodyText : `${disclosure} ${bodyText}`;
          disclosureApplied = true;
        } else {
          finalText = bodyText.includes(disclosure) ? bodyText : `${bodyText}\n\n${disclosure}`;
          disclosureApplied = true;
        }
        const limit = request.kind === "call" ? 2000 : profile.max_text_chars;
        if (Array.from(finalText).length > limit) contentDenials.push("content_too_long_with_disclosure");
      }
    }
    // Opptak bygges ikke: det finnes ingen registrert rettslig grunnlag-mekanisme (JARVIS-084 er ikke bygget) og et opptaksvarsel alene gir ikke grunnlag.
    if (request.kind === "call" && content.recording === true) contentDenials.push("call_recording_not_supported");
  }
  if (contentDenials.length === 0) add("content_valid", "pass");
  else for (const code of contentDenials) deny("content_valid", code);
  if (request.kind === "delete" || request.kind === "reaction") add("ai_disclosure", "not_applicable");
  else if (disclosureApplied) add("ai_disclosure", "pass", content.template ? "template_attested" : finalText !== null && text !== undefined && text.includes(disclosure) ? "already_present" : "applied");
  else if (contentDenials.length > 0) add("ai_disclosure", "deny", "not_applied_content_invalid");
  else add("ai_disclosure", "not_applicable");

  // 11. samtale-spesifikt: eget, snevrere tidsvindu (ikke omgåelig av «de skrev til oss»)
  if (request.kind === "call") {
    const hour = localHour(now, config.time_zone);
    const inWindow = Number.isInteger(hour) && (config.call_window_start_hour < config.call_window_end_hour
      ? hour >= config.call_window_start_hour && hour < config.call_window_end_hour
      : hour >= config.call_window_start_hour || hour < config.call_window_end_hour) && config.call_window_start_hour !== config.call_window_end_hour;
    if (inWindow) add("call_window", "pass");
    else deny("call_window", "outside_call_window");
  } else {
    add("call_window", "not_applicable");
  }

  // 12. mål for redigering/sletting: kun en melding Jarvis selv har sendt fra DENNE kontoen
  if (request.kind === "edit" || request.kind === "delete") {
    if (state.target !== null && state.target.own_sent && state.target.same_account) add("target_own_message", "pass");
    else deny("target_own_message", "target_not_own_sent_message");
  } else {
    add("target_own_message", "not_applicable");
  }

  const denial_codes = rules.filter((r) => r.outcome === "deny" && r.code !== undefined).map((r) => r.code as string);
  const canonical = contentCanonical(request, finalText);
  return Object.freeze({
    allowed: denial_codes.length === 0,
    denial_codes: [...new Set(denial_codes)],
    rules,
    final_text: finalText,
    disclosure_applied: disclosureApplied,
    content_sha256: canonical === null ? null : sha256Hex(canonical),
    content_length: canonical === null ? 0 : Array.from(canonical).length,
    recipient_proof
  });
}
