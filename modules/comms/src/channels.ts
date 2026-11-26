import { createHash, createHmac } from "node:crypto";
import { normalizeE164 } from "@jarvis/conversation-graph";

/**
 * WP-G1 (D-463, UA-7): kanalene Jarvis kan SENDE på gjennom den felles utgående policyen. `email` og `telegram` er bevisst ikke med: de har egne, eksisterende veier (`email.send` klasse D, `telegram.notify` til eieren selv).
 * Kanaltaksonomien her er en delmengde av `CONVERSATION_CHANNELS` (Conversation Graph) - samme ord, én betydning.
 */
export const COMMS_CHANNELS = ["slack", "discord", "whatsapp", "sms", "teams", "messenger", "instagram", "phone"] as const;
export type CommsChannel = (typeof COMMS_CHANNELS)[number];

export function isCommsChannel(value: unknown): value is CommsChannel {
  return typeof value === "string" && (COMMS_CHANNELS as readonly string[]).includes(value);
}

/** Leverandøren bak en kanal (adapteren). `sms` kan gå via Twilio ELLER Telnyx - kontoen (`account_ref`) bestemmer, se `smsProviderFor`. */
export type CommsProvider = "slack" | "discord" | "meta_whatsapp" | "twilio" | "telnyx" | "ms_graph" | "meta_messenger" | "meta_instagram";

export interface ChannelProfile {
  /** Maks tegn i selve meldingsteksten (etter at AI-opplysningen er lagt til). Leverandørens egen grense, ikke en Jarvis-oppfinnelse (kilde i runbooken, D-41). */
  readonly max_text_chars: number;
  /** Fritekst kun innenfor leverandørens kundeserviceviduto (24 t etter mottakers siste melding). */
  readonly requires_open_window: boolean;
  /** Godkjente maler finnes og kan sendes utenfor vinduet (kun WhatsApp). */
  readonly supports_templates: boolean;
  /** Stille timer gjelder (personlige enheter). Arbeidsflate-chat (Slack/Discord/Teams) har egne «ikke forstyrr»-innstillinger. */
  readonly quiet_hours_apply: boolean;
  /** Kan en melding redigeres/slettes/reageres på av en bot-konto (leverandørens kapabilitet, ikke Jarvis' valg). */
  readonly supports_edit: boolean;
  readonly supports_delete: boolean;
  readonly supports_reaction: boolean;
  readonly supports_media: boolean;
}

/**
 * Grensene er leverandørens dokumenterte tak der de er kjent: Slack `chat.postMessage` tekst anbefalt ≤ 4000 (eksisterende `slack.notify` bruker 4000), Discord 2000 (`discord.notify`), SMS 1600 (`twilio.notify`),
 * WhatsApp tekst 4096 (Meta dokumenterer 4096 for `text.body` - UVERIFISERT i denne økten, se runbook), Messenger/Instagram 2000 (UVERIFISERT), Teams 28 KB (vi bruker et forsiktig 4000). Telefon har ingen tekstmelding (manus ≤ 2000).
 */
export const CHANNEL_PROFILES: Readonly<Record<CommsChannel, ChannelProfile>> = {
  slack: { max_text_chars: 4000, requires_open_window: false, supports_templates: false, quiet_hours_apply: false, supports_edit: true, supports_delete: true, supports_reaction: true, supports_media: false },
  discord: { max_text_chars: 2000, requires_open_window: false, supports_templates: false, quiet_hours_apply: false, supports_edit: true, supports_delete: true, supports_reaction: true, supports_media: false },
  whatsapp: { max_text_chars: 4096, requires_open_window: true, supports_templates: true, quiet_hours_apply: true, supports_edit: false, supports_delete: false, supports_reaction: true, supports_media: true },
  sms: { max_text_chars: 1600, requires_open_window: false, supports_templates: false, quiet_hours_apply: true, supports_edit: false, supports_delete: false, supports_reaction: false, supports_media: false },
  teams: { max_text_chars: 4000, requires_open_window: false, supports_templates: false, quiet_hours_apply: false, supports_edit: false, supports_delete: false, supports_reaction: false, supports_media: false },
  messenger: { max_text_chars: 2000, requires_open_window: true, supports_templates: false, quiet_hours_apply: true, supports_edit: false, supports_delete: false, supports_reaction: false, supports_media: false },
  instagram: { max_text_chars: 1000, requires_open_window: true, supports_templates: false, quiet_hours_apply: true, supports_edit: false, supports_delete: false, supports_reaction: false, supports_media: false },
  phone: { max_text_chars: 2000, requires_open_window: false, supports_templates: false, quiet_hours_apply: true, supports_edit: false, supports_delete: false, supports_reaction: false, supports_media: false }
};

/** Kundeservicevinduet (WhatsApp, Messenger, Instagram): 24 timer etter mottakerens siste melding. Verifisert mot flere kilder (se runbook §D-41); malene/tagger utenfor vinduet bygges IKKE for Messenger/Instagram. */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 3_600_000;

export type RecipientResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly code: string };

const SLACK_RECIPIENT = /^[CDGUW][A-Z0-9]{8,14}$/;
/** FIX-4 (runde 2): en snowflake starter aldri med 0. En utfylt form (`0` + id) ville fått en ANNEN avmeldingsnøkkel enn id-en den ligner på, så den kan ikke regnes som samme mottaker: avvises. */
const DISCORD_RECIPIENT = /^[1-9]\d{16,19}$/;
const TEAMS_CHAT = /^chat:19:[A-Za-z0-9_.@:=-]{5,200}$/;
const TEAMS_CHANNEL = /^channel:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/19:[A-Za-z0-9_.@:=-]{5,200}$/;
const META_RECIPIENT = /^\d{5,20}$/;

/**
 * DETERMINISTISK mottakervalidering per kanal. Aldri en stille «rensing» som endrer hvem meldingen går til: ugyldig form gir en fast kode (aldri verdien, den kan være et telefonnummer). Telefon/SMS/WhatsApp krever
 * E.164 (nasjonalt nummer uten landnummer avvises - et landnummer gjettes aldri); WhatsApps egen `wa_id` (sifre uten `+`) godtas kun på `whatsapp`.
 */
export function normalizeRecipient(channel: CommsChannel, raw: unknown): RecipientResult {
  if (typeof raw !== "string") return { ok: false, code: "recipient_not_a_string" };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return { ok: false, code: "recipient_length_invalid" };
  switch (channel) {
    case "sms":
    case "phone":
    case "whatsapp": {
      const e164 = normalizeE164(trimmed, { allowBareInternationalDigits: channel === "whatsapp" });
      return e164 === null ? { ok: false, code: `recipient_not_e164` } : { ok: true, value: e164 };
    }
    case "slack": {
      const upper = trimmed.toUpperCase();
      return SLACK_RECIPIENT.test(upper) ? { ok: true, value: upper } : { ok: false, code: "recipient_not_a_slack_id" };
    }
    case "discord":
      return DISCORD_RECIPIENT.test(trimmed) ? { ok: true, value: trimmed } : { ok: false, code: "recipient_not_a_discord_id" };
    case "teams":
      // Teams-id-er (`19:…@thread.v2`) er store/små-sensitive: de endres aldri.
      return TEAMS_CHAT.test(trimmed) || TEAMS_CHANNEL.test(trimmed) ? { ok: true, value: trimmed } : { ok: false, code: "recipient_not_a_teams_target" };
    case "messenger":
    case "instagram":
      return META_RECIPIENT.test(trimmed) ? { ok: true, value: trimmed } : { ok: false, code: "recipient_not_a_scoped_id" };
    default:
      return { ok: false, code: "recipient_channel_unknown" };
  }
}

/** Leverandører som kan bære en kanal (kontoen velger; SMS/telefon kan gå via Twilio ELLER Telnyx). */
export const PROVIDERS_FOR_CHANNEL: Readonly<Record<CommsChannel, readonly CommsProvider[]>> = {
  slack: ["slack"], discord: ["discord"], whatsapp: ["meta_whatsapp"], sms: ["twilio", "telnyx"], phone: ["twilio", "telnyx"],
  teams: ["ms_graph"], messenger: ["meta_messenger"], instagram: ["meta_instagram"]
};

const ACCOUNT_REF_FORMAT: Readonly<Record<CommsChannel, RegExp>> = {
  slack: /^T[A-Z0-9]{8,14}$/, // team-id
  discord: /^\d{17,20}$/, // guild-id
  whatsapp: /^\d{5,20}$/, // phone_number_id
  sms: /^\+[1-9]\d{7,14}$/, // avsendernummer (E.164)
  phone: /^\+[1-9]\d{7,14}$/,
  teams: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, // Entra-tenant (GUID)
  messenger: /^\d{5,20}$/, // side-id
  instagram: /^\d{5,20}$/ // Instagram-konto-id
};

/** Kontoreferansen (IKKE en credential) i riktig kanalform. Aldri en modellstyrt fritekst: eieren registrerer den og policyen sammenligner eksakt. */
export function isValidAccountRef(channel: CommsChannel, ref: unknown): ref is string {
  return typeof ref === "string" && ACCOUNT_REF_FORMAT[channel].test(ref);
}

/**
 * Pseudonym for en mottaker i opt-out-registeret, journalen og innkommende hendelser: SHA-256 over en fast prefiks, tenant, kanal og den NORMALISERTE mottakeren. Samme mottaker gir alltid samme hash i samme tenant
 * og kanal (oppslag), aldri på tvers av tenants. Dette er pseudonymisering, ikke anonymisering (et telefonnummer kan brute-force-hashes) - DPIA-en sier det.
 */
export function recipientHash(tenantId: string, channel: CommsChannel, normalizedRecipient: string): string {
  return createHash("sha256").update(`jarvis-comms-recipient-v1|${tenantId}|${channel}|${normalizedRecipient}`, "utf8").digest("hex");
}

/**
 * A-M3: NAVNEROMMET en avmelding (STOP) gjelder i. Samme mottaker på tvers av kanaler deler navnerom: et telefonnummer er ÉN mottaker enten vi når det på SMS, WhatsApp eller med en AI-samtale (`tel`). Øvrige identifikatorer er
 * plattformens egne (en Slack-id er ikke en Discord-id): navnerommet er kanalen selv. E-post har egen sendevei utenfor comms.
 */
export function optOutNamespace(channel: CommsChannel): string {
  return channel === "sms" || channel === "whatsapp" || channel === "phone" ? "tel" : channel;
}

/**
 * Pseudonym for en mottaker i opt-out-registeret (A-M3): som `recipientHash`, men over avmeldingens NAVNEROMMET i stedet for kanalen, og UTEN avsenderkonto/rom i nøkkelen - mottakerens STOP gjelder hele tenanten
 * (alle våre kontoer, alle rom, alle kanaler som deler identifikator). Journalens/innkommende hendelsers `recipientHash` er uendret (kanalspesifikk: ratetak og kundeservicevindu er per kanal).
 */
export function optOutHash(tenantId: string, channel: CommsChannel, normalizedRecipient: string): string {
  return createHash("sha256").update(`jarvis-comms-optout-v1|${tenantId}|${optOutNamespace(channel)}|${normalizedRecipient}`, "utf8").digest("hex");
}

/** Maskert visning (aldri hele nummeret/id-en i journal og lister): `+47•••••000`, `U01…ABC`. */
export function recipientHint(channel: CommsChannel, normalizedRecipient: string): string {
  if (channel === "sms" || channel === "phone" || channel === "whatsapp") return `${normalizedRecipient.slice(0, 3)}${"•".repeat(Math.max(0, normalizedRecipient.length - 6))}${normalizedRecipient.slice(-3)}`;
  if (normalizedRecipient.length <= 8) return `${normalizedRecipient.slice(0, 2)}•••`;
  return `${normalizedRecipient.slice(0, 4)}…${normalizedRecipient.slice(-3)}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * K1 (JARVIS-112 b): SALTET innholds-hash. Den gamle journal-hashen var et usaltet SHA-256 av meldingsinnholdet - ordbok-gjettbar for korte meldinger («Hei!», «Ja», «Takk»), og journalen er det ENESTE sporet av innholdet. Nå er den en
 * HMAC-SHA256 med en server-side PEPPER fra den EKSISTERENDE hemmelighetsmekanismen (vault-kjeden `readSecretProvider`, samme som leverandør-credentials; referansen er `COMMS_PEPPER_REF`). Pepperen er aldri i kode, testfiksturer eller
 * logger (kun en kort feilkode når den mangler), og hver HMAC bruker en nøkkel utledet PER FORMÅL (`PepperPurpose`) OG TENANT (FIX-7), så en hash laget for ett formål aldri kan gjenbrukes for et annet - og samme pepper kan gjenbrukes av flere formål senere
 * (Q-78 pkt 2: pepper for G1b-nyttelastavtrykket) uten at oppskriftene blandes. Mangler pepperen (eller er den for kort), finnes ingen `ContentHasher`, og utsendelse feiler LUKKET (`content_hash_key_unavailable`) - aldri en stille standardverdi.
 * Rotasjon: en ny pepper gir nye hasher; eldre rader beholder sin versjon (`comms_outbound_log.content_hash_version` = 2 for HMAC, 1 for den gamle usaltede) og en gjenspilling av en forespørsel laget FØR rotasjonen avvises som kollisjon (feil retning: ingen sending).
 */
export const COMMS_PEPPER_REF = "JARVIS_COMMS_CONTENT_PEPPER";
/** Minste pepper-lengde (tegn). `openssl rand -base64 48` gir 64. En kortere verdi regnes som manglende (fail-closed) - en svak pepper er verre enn ingen, fordi den ser ut som beskyttelse. */
export const PEPPER_MIN_LENGTH = 32;
/**
 * FIX-7 (fiks-runde 1): minste antall FORSKJELLIGE tegn. En pepper på `"a"` x 32 eller `"0"` x 32 har riktig lengde men ingen styrke. Grensen 10 er valgt så en ekte tilfeldig verdi aldri avvises: 32 tilfeldige hex-tegn har færre enn 10
 * ulike tegn med sannsynlighet ca. 1 av 10 000 (en 64-tegns hex eller base64-verdi, som `openssl rand` gir, praktisk talt aldri). Dette er IKKE en entropimåling, kun et filter mot åpenbart svake verdier.
 */
export const PEPPER_MIN_DISTINCT_CHARS = 10;
/** Hvorfor en pepper ikke godtas (kun en fast kode - aldri verdien). `missing` = ikke satt. */
export type PepperProblem = "missing" | "not_a_string" | "surrounding_whitespace" | "too_short" | "too_few_distinct_characters" | "repeating_pattern";
export type PepperAssessment = { readonly ok: true } | { readonly ok: false; readonly code: PepperProblem };

/**
 * FIX-7: vurderer en pepper FØR en hasher lages. Fail-lukket med en tydelig kode (aldri verdien i koden eller feilmeldingen): manglende, ikke-tekst, ledende/avsluttende mellomrom eller linjeskift (AVVISES i stedet for å trimmes stille, så to ulike
 * lagrede strenger aldri gir samme nøkkel; en hemmelighet limt inn med et linjeskift må rettes), for kort, for få ulike tegn, og en periodisk verdi, dvs. en kortere blokk gjentatt også med en delvis siste blokk (`0123456789` x 3 + `01`).
 */
export function assessPepper(pepper: unknown): PepperAssessment {
  if (pepper === null || pepper === undefined) return { ok: false, code: "missing" };
  if (typeof pepper !== "string") return { ok: false, code: "not_a_string" };
  if (pepper.length === 0) return { ok: false, code: "missing" };
  if (pepper !== pepper.trim()) return { ok: false, code: "surrounding_whitespace" };
  if (pepper.length < PEPPER_MIN_LENGTH) return { ok: false, code: "too_short" };
  if (new Set(pepper).size < PEPPER_MIN_DISTINCT_CHARS) return { ok: false, code: "too_few_distinct_characters" };
  // En periodisk verdi (en kortere blokk gjentatt, også med en delvis siste blokk): `s[i] === s[i - p]` for alle i >= p, med en periode p på høyst halve lengden.
  for (let period = 1; period <= pepper.length / 2; period++) {
    let periodic = true;
    for (let i = period; i < pepper.length && periodic; i++) periodic = pepper[i] === pepper[i - period];
    if (periodic) return { ok: false, code: "repeating_pattern" };
  }
  return { ok: true };
}

export type PepperPurpose = "content" | "request";
export interface ContentHasher {
  /** 2 = HMAC-SHA256 med pepper (1 = den gamle, usaltede SHA-256 - finnes kun i eldre rader). */
  readonly version: 2;
  /**
   * HMAC-SHA256 (hex) over `data` med en nøkkel utledet av pepperen for (formål, TENANT): samme tekst gir ulik hash i ulike tenanter (FIX-7), og en hash laget for ett formål kan aldri gjenbrukes for et annet. `tenantId` er obligatorisk
   * (tom streng kaster): en hash uten tenant-kontekst skal ikke kunne oppstå ved en glipp.
   */
  hmac(purpose: PepperPurpose, tenantId: string, data: string): string;
}

export function createContentHasher(pepper: string | null | undefined): ContentHasher | null {
  if (!assessPepper(pepper).ok) return null;
  const secret = pepper as string;
  const keys = new Map<string, Buffer>();
  const keyFor = (purpose: PepperPurpose, tenantId: string): Buffer => {
    if (typeof tenantId !== "string" || tenantId.length === 0) throw new Error("comms_hash_scope_invalid");
    const cacheKey = JSON.stringify([purpose, tenantId]);
    let key = keys.get(cacheKey);
    if (key === undefined) {
      // JSON gir en entydig koding (en tenant-id med skilletegn kan ikke forveksles med et annet formål/tenant-par). Versjonen i teksten er 2: nøkkelutledningen med tenant er ikke den samme oppskriften som den første (kun formål).
      key = createHmac("sha256", secret).update(JSON.stringify(["jarvis-comms-pepper-v2", purpose, tenantId]), "utf8").digest();
      keys.set(cacheKey, key);
    }
    return key;
  };
  return { version: 2, hmac: (purpose, tenantId, data) => createHmac("sha256", keyFor(purpose, tenantId)).update(data, "utf8").digest("hex") };
}

/** Teknisk leverandør per kanal (SMS avgjøres av kontoens `provider`, se `authorized account`). */
export function defaultProviderFor(channel: CommsChannel): CommsProvider {
  switch (channel) {
    case "slack": return "slack";
    case "discord": return "discord";
    case "whatsapp": return "meta_whatsapp";
    case "sms": return "twilio";
    case "phone": return "twilio";
    case "teams": return "ms_graph";
    case "messenger": return "meta_messenger";
    case "instagram": return "meta_instagram";
    default: return "slack";
  }
}
