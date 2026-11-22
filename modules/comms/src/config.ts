import { envHour, envInt } from "@jarvis/contracts";
import type { MemorySpace } from "@jarvis/contracts";
import { COMMS_CHANNELS, isCommsChannel, type CommsChannel } from "./channels.ts";

/**
 * WP-G1 (D-463): ALL kommunikasjonskonfigurasjon. ALT er AV som standard (tom/usatt = ingenting registreres, ingen rute finnes, ingen kanal er aktiv). Kun den EKSAKTE verdien `on` slår et av/på-flagg på - aldri
 * `1`/`true`/`yes` (tvetydighet strammer alltid inn). Lister er kommaseparerte og eksakte: en ukjent kanal/leverandør i en liste STOPPER oppstarten (skrivefeil skal aldri gi en stille «tom» konfigurasjon).
 * Ingen hemmeligheter: kun flagg og ikke-hemmelige id-er/tekster. Credentials er vault-referansene (`JARVIS_SLACK_BOT_TOKEN`, ...).
 */
export const COMMS_WEBHOOK_PROVIDERS = ["slack", "meta", "twilio", "telnyx"] as const;
export type CommsWebhookProvider = (typeof COMMS_WEBHOOK_PROVIDERS)[number];

export const DEFAULT_AI_DISCLOSURE_TEXT = "Sendt av Jarvis (AI-assistent).";

export interface CommsConfig {
  /** `JARVIS_COMMS_OUTBOUND=on`: utgående verktøy (`comms.*`), eier-rutene `/comms/*` og policyen. */
  readonly outbound: boolean;
  /** Kanalene som er slått på (`JARVIS_COMMS_CHANNELS`). Tom = ingen sending selv med `outbound` på. */
  readonly channels: ReadonlySet<CommsChannel>;
  /** Hvilke webhook-ruter som finnes (`JARVIS_COMMS_WEBHOOKS`). Tom = ingen `/webhooks/comms/*`-ruter. */
  readonly webhooks: ReadonlySet<CommsWebhookProvider>;
  /** Tenant/rom innkommende webhooks skrives til (ingen eier-identitet finnes i en webhook). `null` = webhook-ruter avviser alt (fail-closed). */
  readonly webhook_tenant_id: string | null;
  readonly webhook_memory_space: MemorySpace;
  /** Offentlig basis-URL Twilio signerer mot (eksakt, uten avsluttende skråstrek). `null` = Twilio-ruten avviser alt. */
  readonly public_base_url: string | null;
  readonly contacts: boolean;
  readonly meetings: boolean;
  readonly calls: boolean;
  readonly reply_sweep: boolean;
  readonly vendor_reads: boolean;
  readonly quiet_hours_enabled: boolean;
  readonly quiet_start_hour: number;
  readonly quiet_end_hour: number;
  readonly time_zone: string;
  readonly max_per_recipient_per_day: number;
  readonly max_cold_per_recipient_per_day: number;
  readonly max_per_account_per_hour: number;
  /** Utgående samtale (P3h): høyst så mange anrop per nummer per døgn, og eget tidsvindu (lokal time, [start, slutt)). Standardene er KONSERVATIVE valg, ikke en lovfestet norm (UVERIFISERT, krever juridisk gjennomgang). */
  readonly max_calls_per_number_per_day: number;
  readonly call_window_start_hour: number;
  readonly call_window_end_hour: number;
  readonly reply_window_days: number;
  /** Timer en verifisert innkommende melding kan stå ubesvart før oppfølgingssveipet lager en åpen oppfølging (`JARVIS_COMMS_REPLY_AFTER_HOURS`, standard 24). */
  readonly reply_after_hours: number;
  readonly conversational_window_minutes: number;
  readonly ai_disclosure_text: string;
  /** WhatsApp-maler eieren HAR attestert inneholder AI-opplysningen (en godkjent mal kan ikke få tekst lagt til). */
  readonly templates_with_disclosure: ReadonlySet<string>;
  readonly media_url_hosts: ReadonlySet<string>;
  readonly inbound_retention_days: number;
  readonly log_retention_days: number;
  /** Oppbevaring (dager) for behandlede møter og deres deltakere/forslag (`JARVIS_COMMS_MEETING_RETENTION_DAYS`, standard 180). */
  readonly meeting_retention_days: number;
  readonly graph_api_version: string;
}

const MEMORY_SPACES_ALLOWED: readonly MemorySpace[] = ["personal", "business", "project", "shared"];

function onFlag(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  return env[name]?.trim() === "on";
}

function listOf(env: Readonly<Record<string, string | undefined>>, name: string): string[] {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export class InvalidCommsConfigError extends Error {
  constructor(readonly variable: string, readonly reason: string) {
    super(`ugyldig kommunikasjonskonfigurasjon ${variable}: ${reason}`);
    this.name = "InvalidCommsConfigError";
  }
}

const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;

export function parseCommsConfig(env: Readonly<Record<string, string | undefined>> = process.env): CommsConfig {
  const channels = new Set<CommsChannel>();
  for (const entry of listOf(env, "JARVIS_COMMS_CHANNELS")) {
    if (!isCommsChannel(entry)) throw new InvalidCommsConfigError("JARVIS_COMMS_CHANNELS", `ukjent kanal (gyldige: ${COMMS_CHANNELS.join(", ")})`);
    channels.add(entry);
  }
  const webhooks = new Set<CommsWebhookProvider>();
  for (const entry of listOf(env, "JARVIS_COMMS_WEBHOOKS")) {
    if (!(COMMS_WEBHOOK_PROVIDERS as readonly string[]).includes(entry)) throw new InvalidCommsConfigError("JARVIS_COMMS_WEBHOOKS", `ukjent leverandør (gyldige: ${COMMS_WEBHOOK_PROVIDERS.join(", ")})`);
    webhooks.add(entry as CommsWebhookProvider);
  }
  const spaceRaw = env["JARVIS_COMMS_MEMORY_SPACE"]?.trim();
  const space = spaceRaw === undefined || spaceRaw === "" ? "business" : spaceRaw;
  if (!(MEMORY_SPACES_ALLOWED as readonly string[]).includes(space)) {
    // Helse/hjem/gjest kan aldri være mål for innkommende kommunikasjon (fail-closed).
    throw new InvalidCommsConfigError("JARVIS_COMMS_MEMORY_SPACE", `kun ${MEMORY_SPACES_ALLOWED.join("/")} er tillatt`);
  }
  const tenant = env["JARVIS_COMMS_TENANT_ID"]?.trim();
  const baseRaw = env["JARVIS_COMMS_PUBLIC_BASE_URL"]?.trim();
  let publicBase: string | null = null;
  if (baseRaw !== undefined && baseRaw !== "") {
    if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(baseRaw) || baseRaw.endsWith("/")) {
      throw new InvalidCommsConfigError("JARVIS_COMMS_PUBLIC_BASE_URL", "forventet https://vert[:port][/sti] uten avsluttende skråstrek");
    }
    publicBase = baseRaw;
  }
  const disclosureRaw = env["JARVIS_COMMS_AI_DISCLOSURE_TEXT"];
  const disclosure = disclosureRaw === undefined || disclosureRaw.trim() === "" ? DEFAULT_AI_DISCLOSURE_TEXT : disclosureRaw.trim();
  // eslint-disable-next-line no-control-regex
  if (disclosure.length < 5 || disclosure.length > 200 || /[\u0000-\u001f\u007f]/.test(disclosure)) {
    throw new InvalidCommsConfigError("JARVIS_COMMS_AI_DISCLOSURE_TEXT", "5-200 tegn, ingen kontrolltegn");
  }
  const templates = new Set<string>();
  for (const name of listOf(env, "JARVIS_COMMS_TEMPLATES_WITH_DISCLOSURE")) {
    if (!TEMPLATE_NAME.test(name)) throw new InvalidCommsConfigError("JARVIS_COMMS_TEMPLATES_WITH_DISCLOSURE", "malnavn: a-z, 0-9 og understrek");
    templates.add(name);
  }
  const hosts = new Set<string>();
  for (const host of listOf(env, "JARVIS_COMMS_MEDIA_URL_HOSTS")) {
    if (!HOST.test(host)) throw new InvalidCommsConfigError("JARVIS_COMMS_MEDIA_URL_HOSTS", "eksakte vertsnavn (små bokstaver, ingen jokertegn/IP)");
    hosts.add(host);
  }
  const version = env["JARVIS_META_GRAPH_VERSION"]?.trim();
  if (version !== undefined && version !== "" && !/^v\d{2}\.\d$/.test(version)) throw new InvalidCommsConfigError("JARVIS_META_GRAPH_VERSION", "forventet vNN.N");
  // Avhengigheter (fail-closed): leverandør-lesing, utgående samtale og kontakter bruker kontoene, journalen og policyen som hører til `JARVIS_COMMS_OUTBOUND` - uten den ville de stå uten allowlist og regler.
  if (!onFlag(env, "JARVIS_COMMS_OUTBOUND")) {
    for (const dependent of ["JARVIS_COMMS_VENDOR_READS", "JARVIS_COMMS_CALLS", "JARVIS_COMMS_CONTACTS", "JARVIS_COMMS_MEETINGS"] as const) {
      if (onFlag(env, dependent)) throw new InvalidCommsConfigError(dependent, "krever JARVIS_COMMS_OUTBOUND=on (kontoer, journal og policy)");
    }
  }
  const quietOff = env["JARVIS_COMMS_QUIET_HOURS"]?.trim() === "off";
  return Object.freeze({
    outbound: onFlag(env, "JARVIS_COMMS_OUTBOUND"),
    channels,
    webhooks,
    webhook_tenant_id: tenant === undefined || tenant === "" ? null : tenant,
    webhook_memory_space: space as MemorySpace,
    public_base_url: publicBase,
    contacts: onFlag(env, "JARVIS_COMMS_CONTACTS"),
    meetings: onFlag(env, "JARVIS_COMMS_MEETINGS"),
    calls: onFlag(env, "JARVIS_COMMS_CALLS"),
    reply_sweep: onFlag(env, "JARVIS_COMMS_REPLY_SWEEP"),
    vendor_reads: onFlag(env, "JARVIS_COMMS_VENDOR_READS"),
    quiet_hours_enabled: !quietOff,
    quiet_start_hour: envHour("JARVIS_COMMS_QUIET_START", 22, env),
    quiet_end_hour: envHour("JARVIS_COMMS_QUIET_END", 8, env),
    time_zone: "Europe/Oslo",
    max_per_recipient_per_day: envInt("JARVIS_COMMS_MAX_PER_RECIPIENT_DAY", 3, { min: 1, max: 50 }, env),
    max_cold_per_recipient_per_day: envInt("JARVIS_COMMS_MAX_COLD_PER_RECIPIENT_DAY", 1, { min: 1, max: 10 }, env),
    max_per_account_per_hour: envInt("JARVIS_COMMS_MAX_PER_ACCOUNT_HOUR", 30, { min: 1, max: 1000 }, env),
    max_calls_per_number_per_day: envInt("JARVIS_COMMS_MAX_CALLS_PER_NUMBER_DAY", 1, { min: 1, max: 5 }, env),
    call_window_start_hour: envHour("JARVIS_COMMS_CALL_WINDOW_START", 9, env),
    call_window_end_hour: envHour("JARVIS_COMMS_CALL_WINDOW_END", 20, env),
    reply_window_days: envInt("JARVIS_COMMS_REPLY_WINDOW_DAYS", 7, { min: 1, max: 90 }, env),
    reply_after_hours: envInt("JARVIS_COMMS_REPLY_AFTER_HOURS", 24, { min: 1, max: 168 }, env),
    conversational_window_minutes: 120,
    ai_disclosure_text: disclosure,
    templates_with_disclosure: templates,
    media_url_hosts: hosts,
    inbound_retention_days: envInt("JARVIS_COMMS_INBOUND_RETENTION_DAYS", 30, { min: 1, max: 365 }, env),
    log_retention_days: envInt("JARVIS_COMMS_LOG_RETENTION_DAYS", 400, { min: 30, max: 1825 }, env),
    meeting_retention_days: envInt("JARVIS_COMMS_MEETING_RETENTION_DAYS", 180, { min: 30, max: 1825 }, env),
    graph_api_version: version === undefined || version === "" ? "v25.0" : version
  });
}

/** Er NOEN del av UA-7-komponentene slått på? Brukes til oppstartsloggen og til å la `main.ts` hoppe over alt når alt er av (flagg-AV = identisk med main). */
export function commsAnyEnabled(config: CommsConfig): boolean {
  return config.outbound || config.webhooks.size > 0 || config.contacts || config.meetings || config.reply_sweep || config.vendor_reads || config.calls;
}
