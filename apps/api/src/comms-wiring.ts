// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import type { BusinessService } from "@jarvis/business";
import {
  COMMS_PEPPER_REF, CommsStore, CommsTransport, CommsWebhookService, DiscordAdapter, GoogleContacts, MeetingService, ReplySweep, MetaMessagingAdapter, OutboundFunnel, SlackAdapter, TeamsGraphAdapter, TelnyxSmsAdapter, TwilioSmsAdapter, VendorReads, WhatsAppAdapter,
  commsAnyEnabled, commsToolDefinitions, createContentHasher, parseCommsConfig, retentionTenants, startRetentionSweep, type CommsConfig
} from "@jarvis/comms";
import type { ConversationGraphService } from "@jarvis/conversation-graph";
import { AccessTokenCache, googleAccessToken, microsoftRefreshExchange, type ToolDefinition, type ToolGateway } from "@jarvis/tool-gateway";

/** Delegerte Graph-scopes for Teams-sending (`ChatMessage.Send`/`ChannelMessage.Send` finnes KUN som delegerte rettigheter - verifisert via søk). Eksakt scope-streng i refresh-forespørselen er UVERIFISERT. */
const TEAMS_REFRESH_SCOPE = "https://graph.microsoft.com/ChatMessage.Send https://graph.microsoft.com/ChannelMessage.Send offline_access";
import type { ApiDeps } from "./server.ts";

/**
 * WP-G1 (D-463, UA-7 Communications Hub - resterende deler): ÉN fabrikk for hele kommunikasjons-oppkoblingen i api-prosessen. Alt er DORMANT og `NOT VERIFIED`:
 *  - `JARVIS_COMMS_OUTBOUND` AV (standard): INGEN `comms.*`-verktøy registreres (verktøylisten, utvalgstreff og rate limits er identiske med main) og ingen `/comms/*`-rute finnes.
 *  - `JARVIS_COMMS_WEBHOOKS` tom (standard): INGEN `/webhooks/comms/*`-rute finnes (404) og ruten er ikke i den strenge per-IP-grensen.
 *  - Alt AV: ingenting konstrueres i det hele tatt (ingen `CommsStore`, ingen adaptere, ingen oppstartslogg) - flagg AV er strukturelt identisk med main.
 * Ugyldig konfigurasjon (ukjent kanal/leverandør, ugyldig base-URL, ugyldig tall) KASTER her og stopper oppstarten (fail closed) - aldri en stille «tom» konfigurasjon.
 * Ingen leverandør-SDK: adapterne bruker den vaktede `guardedFetch` (se `@jarvis/comms` adapters). Hemmeligheter leses via den delte vault-kjeden ved hvert kall (rotasjon gjelder umiddelbart).
 */
export interface CommsRuntimeInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pool: pg.Pool;
  readonly graph: ConversationGraphService;
  readonly business: BusinessService;
  readonly secrets: { get(ref: string): Promise<string | null | undefined> };
  readonly clock?: () => Date;
  readonly warn?: (event: Record<string, unknown>) => void;
}

export interface CommsRuntime {
  readonly config: CommsConfig;
  /** `comms.*`-verktøyene (additionalTools). Tom liste uten JARVIS_COMMS_OUTBOUND=on. */
  readonly tools: ToolDefinition[];
  /** `ApiDeps.comms` for den gitte gatewayen, eller `undefined` når verken webhooks eller utgående er slått på. */
  apiDeps(gateway: ToolGateway): ApiDeps["comms"] | undefined;
  /**
   * Starter de planlagte sveipene (kun når noe er slått på): retensjon (UMIDDELBART ved oppstart, deretter hver 6. time) og - kun med JARVIS_COMMS_REPLY_SWEEP=on - ubesvarte meldinger -> åpne oppfølginger (hver 30. minutt). `tenants` = eierens tenants;
   `JARVIS_COMMS_TENANT_ID` MÅ være en av dem (ellers kastes `InvalidCommsConfigError` og oppstarten stopper: hendelser skrevet dit ville aldri blitt sveipet).
   */
  startSweeps(tenants: readonly string[], ownerPersonId: string): void;
}

export function buildCommsRuntime(input: CommsRuntimeInput): CommsRuntime {
  const config = parseCommsConfig(input.env);
  if (!commsAnyEnabled(config)) return { config, tools: [], apiDeps: () => undefined, startSweeps: () => undefined };

  const clock = input.clock ?? (() => new Date());
  const store = new CommsStore(input.pool, clock);
  const secrets = { get: async (ref: string): Promise<string | null> => (await input.secrets.get(ref)) ?? null };
  // Teams: delegert refresh-token (eget samtykke, BLOCKED_EXTERNAL live) -> access-token via den eksisterende Microsoft-utvekslingen. Rotert refresh-token lagres IKKE (DEFERRED).
  const teamsTokens = new AccessTokenCache(
    microsoftRefreshExchange(() => secrets.get("JARVIS_MICROSOFT_CLIENT_ID"), () => secrets.get("JARVIS_MICROSOFT_CLIENT_SECRET"), () => secrets.get("JARVIS_MICROSOFT_TENANT_ID"), TEAMS_REFRESH_SCOPE),
    { label: "teams" }
  );
  const twilioSid = (): Promise<string | null> => secrets.get("JARVIS_TWILIO_ACCOUNT_SID");
  const funnel = config.outbound
    ? new OutboundFunnel({
        store, graph: input.graph, config, clock, business: input.business,
        // K1 (JARVIS-112 b): innholds-hashen i journalen er en HMAC med en server-side pepper fra DEN EKSISTERENDE hemmelighetskjeden (vault først, som leverandør-credentials) - lest på nytt ved hvert kall, så en rotasjon gjelder umiddelbart.
        // Mangler pepperen (eller er den for kort), feiler ALL utsendelse lukket (`content_hash_key_unavailable`); det finnes ingen standardverdi og verdien logges aldri. Å skaffe pepperen er eierens handling (BLOCKED_EXTERNAL kun for aktivering, se runbook).
        contentHasher: async () => createContentHasher(await secrets.get(COMMS_PEPPER_REF)),
        adapters: {
          slack: new SlackAdapter(), discord: new DiscordAdapter(), meta_whatsapp: new WhatsAppAdapter(config.graph_api_version),
          // Telnyx har bevisst INGEN `call` (AI-opplysningen kan ikke garanteres som første talte innhold uten call.answered-flyten): samtale via Telnyx feiler lukket (DEFERRED).
          twilio: new TwilioSmsAdapter(twilioSid), telnyx: new TelnyxSmsAdapter(),
          meta_messenger: new MetaMessagingAdapter("meta_messenger", config.graph_api_version), meta_instagram: new MetaMessagingAdapter("meta_instagram", config.graph_api_version),
          ms_graph: new TeamsGraphAdapter((refreshToken) => teamsTokens.get(refreshToken.trim()))
        },
        ...(input.warn ? { warn: input.warn } : {})
      })
    : undefined;
  // Google Contacts: egen refresh-token (`JARVIS_GOOGLE_CONTACTS_TOKEN`, scope `contacts`) via den delte Google-klienten.
  const contacts = config.contacts ? { api: new GoogleContacts((refreshToken) => googleAccessToken(refreshToken.trim())), graph: input.graph } : undefined;
  // Møtetranskripsjon: tekstkilder fra dag én; lyd krever en `AudioTranscriber` + talebehandler-erklæring som IKKE er bundet (DEFERRED) - `ingestAudio` svarer da `meeting_audio_not_configured`.
  const meetings = config.meetings ? new MeetingService({ pool: input.pool, clock, graph: input.graph, business: input.business, retentionDays: config.meeting_retention_days, ...(input.warn ? { warn: input.warn } : {}) }) : undefined;
  const reads = config.vendor_reads ? new VendorReads({ graphVersion: config.graph_api_version, accountSid: twilioSid }) : undefined;
  const webhookService = config.webhooks.size > 0
    ? new CommsWebhookService({ store, graph: input.graph, config, secrets, clock, business: input.business, ...(input.warn ? { warn: input.warn } : {}) })
    : undefined;
  const tools = funnel ? commsToolDefinitions({ transport: new CommsTransport({ funnel, store, ...(reads ? { reads } : {}), ...(contacts ? { contacts } : {}), ...(meetings ? { meetings } : {}) }), store, vendorReads: reads !== undefined, calls: config.calls, contacts: contacts !== undefined, meetings: meetings !== undefined }) : [];

  // Kun kanalnavn/leverandørnavn/flagg - aldri hemmeligheter, tenant-id eller URL-er.
  console.log(JSON.stringify({
    msg: "comms_enabled", status: "NOT_VERIFIED", outbound: config.outbound, channels: [...config.channels].sort(), webhooks: [...config.webhooks].sort(),
    contacts: config.contacts, meetings: config.meetings, calls: config.calls, reply_sweep: config.reply_sweep, vendor_reads: config.vendor_reads
  }));

  // Retensjonssveip (utløpte innkommende hendelser, journalrader og møter): ved oppstart og hver 6. time for eierens tenants (inkl. webhook-tenanten) og de tillatte rommene (`@jarvis/comms` retention.ts, B-M6). Feil logges, stopper aldri prosessen. Intet sveip uten at noe er slått på.
  const replySweep = config.reply_sweep ? new ReplySweep({ pool: input.pool, clock, business: input.business, afterHours: config.reply_after_hours, windowDays: config.reply_window_days, ...(input.warn ? { warn: input.warn } : {}) }) : undefined;
  const startSweeps = (tenants: readonly string[], ownerPersonId: string): void => {
    const sweepTenants = retentionTenants(tenants, config.webhook_tenant_id); // kaster hvis webhook-tenanten ikke er en av eierens (fail closed, før noe planlegges)
    // K1: en tydelig oppstartsvarsel (kun koden og et ja/nei, aldri verdien) når utgående er på men pepperen mangler - utsendelse feiler lukket helt til eieren har lagt den inn (runbook §6, NAS-trinn).
    if (config.outbound) {
      void secrets.get(COMMS_PEPPER_REF).then((value) => {
        if (createContentHasher(value) === null) input.warn?.({ msg: "comms_content_pepper_missing", effect: "outbound_fails_closed" });
      }).catch(() => input.warn?.({ msg: "comms_content_pepper_check_failed" }));
    }
    startRetentionSweep({
      tenants: sweepTenants,
      purge: async (tenantId, space) => {
        await store.purgeExpired(tenantId, space);
        if (meetings) await meetings.purgeExpired(tenantId, space);
      },
      ...(input.warn ? { warn: input.warn } : {})
    });
    // Ubesvarte meldinger -> åpne oppfølginger (V2-pushen leverer dem; dormant uten JARVIS_COMMS_REPLY_SWEEP=on). Idempotent; feil logges.
    if (replySweep) {
      const reply = async (): Promise<void> => {
        for (const tenantId of tenants) {
          try {
            await replySweep.run(tenantId, config.webhook_memory_space, ownerPersonId);
          } catch (err) {
            input.warn?.({ msg: "comms_reply_sweep_failed", error: err instanceof Error ? err.message.slice(0, 80) : "unknown" });
          }
        }
      };
      setInterval(() => void reply(), 30 * 60_000).unref();
    }
  };

  return {
    config, tools, startSweeps,
    apiDeps: (gateway) => ({
      ...(webhookService ? { webhooks: { service: webhookService, providers: config.webhooks } } : {}),
      ...(funnel ? { outbound: { gateway, funnel } } : {})
    })
  };
}
