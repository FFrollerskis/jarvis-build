import { z } from "zod";
import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import { COMMS_CHANNELS, PROVIDERS_FOR_CHANNEL, normalizeRecipient, recipientHash, recipientHint, type CommsProvider } from "./channels.ts";
import { parseDeleteParams, parseEditParams, parseReactParams, parseSendParams, type FunnelContext, type OutboundFunnel, type ParseResult } from "./funnel.ts";
import type { CommsStore } from "./store.ts";

/**
 * WP-G1 (D-463): `comms.*`-transporten - tynn limer mellom ToolGateway og `OutboundFunnel`/`CommsStore`. Ingen policy her (den bor i funnelen); transporten bygger KUN den tiltrodde konteksten av `context.identity`
 * (tenant/space/person/sesjon kommer ALDRI fra `parameters` - D-119-hardening-prinsippet: «ingen parameter = ingen forfalskningsflate») og sender hver handling videre.
 *
 * Mutasjoner (send/edit/delete/react) kalles av gatewayen med den LØSTE leverandør-credentialen (`credential_ref_resolver`); lesing og administrasjon bruker den interne sentinel-credentialen.
 */
const ALLOWED_SPACES: readonly MemorySpace[] = ["personal", "business", "project", "shared"];

const ListInbound = z.object({ channel: z.enum(COMMS_CHANNELS).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const ListOutbound = z.object({ status: z.enum(["denied", "requested", "sent", "outcome_unknown", "failed"]).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const ListOptOuts = z.object({ limit: z.number().int().min(1).max(200).optional() }).strict();
const Authorize = z.object({
  channel: z.enum(COMMS_CHANNELS), account_ref: z.string().min(1).max(200), provider: z.enum(["slack", "discord", "meta_whatsapp", "twilio", "telnyx", "ms_graph", "meta_messenger", "meta_instagram"]),
  display_name: z.string().min(1).max(120).optional()
}).strict();
const Revoke = z.object({ account_id: z.string().min(8).max(80) }).strict();
const RecordOptOut = z.object({
  channel: z.enum(COMMS_CHANNELS), account_ref: z.string().min(1).max(200), recipient: z.string().min(1).max(300), source: z.enum(["owner_recorded", "recipient_request"]).optional()
}).strict();

export class CommsTransport implements ToolTransport {
  constructor(private readonly deps: { funnel: OutboundFunnel; store: CommsStore }) {}

  private ctxOf(context: ToolInvocationContext): FunnelContext {
    const identity = context?.identity;
    if (!identity) throw new Error("comms_missing_invocation_context");
    const space = identity.memory_space_id as MemorySpace;
    if (!ALLOWED_SPACES.includes(space)) throw new Error("comms_space_not_allowed");
    return {
      tenantId: identity.tenant_id, space,
      actor: { person_id: identity.person_id, session_id: identity.session_id, ...(context.task_id !== undefined ? { task_id: context.task_id } : {}) },
      source: "tool"
    };
  }

  private parsed(result: ParseResult) {
    if (!result.ok) throw new Error(`comms_invalid_parameters:${result.code}`.slice(0, 80));
    return result.value;
  }

  async invoke(action: string, parameters: Record<string, JsonValue>, credential: string, context: ToolInvocationContext): Promise<{ external_id?: string; data?: JsonValue }> {
    const ctx = this.ctxOf(context);
    const { funnel, store } = this.deps;
    switch (action) {
      // Tørrkjøring OG ToolGateway-preflight: ren lesing av tilstand + policy. Returnerer ALLTID en evaluering (også ved avslag) - validatoren i verktøydefinisjonen avgjør.
      case "evaluate_send":
        return { data: funnel.summarize(await funnel.evaluate(ctx, this.parsed(parseSendParams(parameters)))) };
      case "send": {
        const r = await funnel.send(ctx, this.parsed(parseSendParams(parameters)), credential);
        return { external_id: r.external_id, data: r.data };
      }
      case "edit_message": {
        const r = await funnel.execute(ctx, this.parsed(parseEditParams(parameters)), credential);
        return { external_id: r.external_id, data: r.data };
      }
      case "add_reaction": {
        const r = await funnel.execute(ctx, this.parsed(parseReactParams(parameters)), credential);
        return { external_id: r.external_id, data: r.data };
      }
      // `check_message_target` = fersk lesing for sletting (preflight OG readback). `data: null` = meldingen finnes ikke (etterbetingelsen for sletting).
      case "check_message_target":
        return { data: await funnel.checkTarget(ctx, this.parsed(parseDeleteParams(parameters)), credential) };
      case "delete_message": {
        const r = await funnel.execute(ctx, this.parsed(parseDeleteParams(parameters)), credential);
        return { external_id: r.external_id, data: r.data };
      }
      case "list_inbound": {
        const p = ListInbound.parse(parameters);
        const rows = await store.listInbound(ctx.tenantId, ctx.space, { ...(p.channel !== undefined ? { channel: p.channel } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) });
        return { data: rows as unknown as JsonValue };
      }
      case "list_outbound": {
        const p = ListOutbound.parse(parameters);
        const rows = await store.listJournal(ctx.tenantId, ctx.space, { ...(p.status !== undefined ? { status: p.status } : {}), ...(p.limit !== undefined ? { limit: p.limit } : {}) });
        return { data: rows as unknown as JsonValue };
      }
      case "list_opt_outs": {
        const p = ListOptOuts.parse(parameters);
        return { data: (await store.listOptOuts(ctx.tenantId, ctx.space, p.limit)) as unknown as JsonValue };
      }
      case "list_accounts":
        z.object({}).strict().parse(parameters);
        return { data: (await store.listAccounts(ctx.tenantId, ctx.space)) as unknown as JsonValue };
      case "authorize_account": {
        const p = Authorize.parse(parameters);
        if (!(PROVIDERS_FOR_CHANNEL[p.channel] as readonly CommsProvider[]).includes(p.provider)) throw new Error("comms_provider_not_valid_for_channel");
        const r = await store.authorizeAccount(ctx.tenantId, ctx.space, { channel: p.channel, account_ref: p.account_ref, provider: p.provider, ...(p.display_name !== undefined ? { display_name: p.display_name } : {}), source: "tool" }, ctx.actor);
        return { external_id: r.account.account_id, data: { account: r.account, created: r.created } as unknown as JsonValue };
      }
      case "revoke_account": {
        const p = Revoke.parse(parameters);
        return { data: { revoked: await store.revokeAccount(ctx.tenantId, ctx.space, p.account_id) } };
      }
      case "record_opt_out": {
        const p = RecordOptOut.parse(parameters);
        const normalized = normalizeRecipient(p.channel, p.recipient);
        if (!normalized.ok) throw new Error(`comms_invalid_parameters:${normalized.code}`);
        const r = await store.recordOptOut(ctx.tenantId, ctx.space, {
          channel: p.channel, account_ref: p.account_ref, recipient_hash: recipientHash(ctx.tenantId, p.channel, normalized.value), recipient_hint: recipientHint(p.channel, normalized.value),
          source: p.source ?? "owner_recorded", recorded_by: ctx.actor.person_id, session_id: ctx.actor.session_id, ...(ctx.actor.task_id !== undefined ? { task_id: ctx.actor.task_id } : {})
        });
        return { external_id: r.opt_out_id, data: { opt_out_id: r.opt_out_id, created: r.created } };
      }
      default:
        throw new Error(`comms_action_not_implemented:${action}`);
    }
  }
}
