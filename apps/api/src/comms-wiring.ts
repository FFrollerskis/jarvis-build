// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import type { BusinessService } from "@jarvis/business";
import {
  CommsStore, CommsTransport, CommsWebhookService, DiscordAdapter, MetaMessagingAdapter, OutboundFunnel, SlackAdapter, TeamsGraphAdapter, TelnyxSmsAdapter, TwilioSmsAdapter, VendorReads, WhatsAppAdapter,
  commsAnyEnabled, commsToolDefinitions, parseCommsConfig, type CommsConfig
} from "@jarvis/comms";
import type { ConversationGraphService } from "@jarvis/conversation-graph";
import { AccessTokenCache, microsoftRefreshExchange, type ToolDefinition, type ToolGateway } from "@jarvis/tool-gateway";

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
}

export function buildCommsRuntime(input: CommsRuntimeInput): CommsRuntime {
  const config = parseCommsConfig(input.env);
  if (!commsAnyEnabled(config)) return { config, tools: [], apiDeps: () => undefined };

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
  const reads = config.vendor_reads ? new VendorReads({ graphVersion: config.graph_api_version, accountSid: twilioSid }) : undefined;
  const webhookService = config.webhooks.size > 0
    ? new CommsWebhookService({ store, graph: input.graph, config, secrets, clock, business: input.business, ...(input.warn ? { warn: input.warn } : {}) })
    : undefined;
  const tools = funnel ? commsToolDefinitions({ transport: new CommsTransport({ funnel, store, ...(reads ? { reads } : {}) }), store, vendorReads: reads !== undefined, calls: config.calls }) : [];

  // Kun kanalnavn/leverandørnavn/flagg - aldri hemmeligheter, tenant-id eller URL-er.
  console.log(JSON.stringify({
    msg: "comms_enabled", status: "NOT_VERIFIED", outbound: config.outbound, channels: [...config.channels].sort(), webhooks: [...config.webhooks].sort(),
    contacts: config.contacts, meetings: config.meetings, calls: config.calls, reply_sweep: config.reply_sweep, vendor_reads: config.vendor_reads
  }));

  return {
    config, tools,
    apiDeps: (gateway) => ({
      ...(webhookService ? { webhooks: { service: webhookService, providers: config.webhooks } } : {}),
      ...(funnel ? { outbound: { gateway, funnel } } : {})
    })
  };
}
