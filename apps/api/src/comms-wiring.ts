// .ts-utvidelser kreves: filene kjøres direkte med Nodes type-stripping (ingen build-steg)
import type pg from "pg";
import type { BusinessService } from "@jarvis/business";
import {
  CommsStore, CommsTransport, CommsWebhookService, DiscordAdapter, OutboundFunnel, SlackAdapter, TelnyxSmsAdapter, TwilioSmsAdapter, WhatsAppAdapter,
  commsAnyEnabled, commsToolDefinitions, parseCommsConfig, type CommsConfig
} from "@jarvis/comms";
import type { ConversationGraphService } from "@jarvis/conversation-graph";
import type { ToolDefinition, ToolGateway } from "@jarvis/tool-gateway";
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
  const funnel = config.outbound
    ? new OutboundFunnel({
        store, graph: input.graph, config, clock, business: input.business,
        adapters: {
          slack: new SlackAdapter(), discord: new DiscordAdapter(), meta_whatsapp: new WhatsAppAdapter(config.graph_api_version),
          twilio: new TwilioSmsAdapter(() => secrets.get("JARVIS_TWILIO_ACCOUNT_SID")), telnyx: new TelnyxSmsAdapter()
        },
        ...(input.warn ? { warn: input.warn } : {})
      })
    : undefined;
  const webhookService = config.webhooks.size > 0
    ? new CommsWebhookService({ store, graph: input.graph, config, secrets, clock, business: input.business, ...(input.warn ? { warn: input.warn } : {}) })
    : undefined;
  const tools = funnel ? commsToolDefinitions({ transport: new CommsTransport({ funnel, store }), store }) : [];

  // Kun kanalnavn/leverandørnavn/flagg - aldri hemmeligheter, tenant-id eller URL-er.
  console.log(JSON.stringify({
    msg: "comms_enabled", status: "NOT_VERIFIED", outbound: config.outbound, channels: [...config.channels].sort(), webhooks: [...config.webhooks].sort(),
    contacts: config.contacts, meetings: config.meetings, calls: config.calls, reply_sweep: config.reply_sweep, vendor_reads: config.vendor_reads, gate_legacy_notify: config.gate_legacy_notify
  }));

  return {
    config, tools,
    apiDeps: (gateway) => ({
      ...(webhookService ? { webhooks: { service: webhookService, providers: config.webhooks } } : {}),
      ...(funnel ? { outbound: { gateway, funnel } } : {})
    })
  };
}
