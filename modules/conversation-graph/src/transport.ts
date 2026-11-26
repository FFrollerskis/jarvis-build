import type { JsonValue } from "@jarvis/contracts";
import { financeWithheldMarker, withholdFinanceFromCurrentModel, type ToolInvocationContext, type ToolTransport } from "@jarvis/tool-gateway";
import type { ConversationGraphService } from "./service.ts";
import type { ConversationChannel } from "./types.ts";

/**
 * D-119 FINAL AUTHORITY / TENANT-BOUNDARY HARDENING (pre-merge, PR #67,
 * second hardening round). A second external final-review found that the
 * FIRST hardening round (see git history / the D-119 addendum in
 * DECISIONS_AND_ASSUMPTIONS.md) correctly fixed `performed_by` provenance
 * but left `tenant_id`/`memory_space` reading from caller-supplied
 * `parameters` UNCHANGED - the SAME class of bug this transport's OWN
 * D-119 header comment had already fixed for `performed_by`. Proven
 * adversarially (temporary probe test, deleted after confirming) via the
 * FULL `ToolGateway.execute()` path: a caller authenticated as tenant A
 * could both READ tenant B's `conversation_identities` row and WRITE a new
 * `conversation_channel_links` row into tenant B, purely by setting
 * `parameters.tenant_id = "tenant-B"` - `PolicyGateway.authorize()`
 * authorizes against `request.identity` (the REAL caller), never against
 * `request.parameters`, and nothing else in the pipeline compared the two.
 * `D119_TENANT_PARAMETER_AUTHORITY_BYPASS_CONFIRMED=true`.
 *
 * Fix: `tenant_id`/`memory_space` are NO LONGER read from `parameters` at
 * all - removed from every `conversation_graph.*` `input_schema`
 * (`integrations.ts`, `.strict()` zod rejects a caller who still sends
 * them with `invalid_parameters`, same "no parameter = no spoof surface"
 * principle already used for `confidence`/`match_method`). `tenantId`/
 * `memorySpace` below come EXCLUSIVELY from `context.identity` - the
 * TRUSTED caller identity `ToolGateway.execute()` builds from
 * `request.identity` (D-68, `gateway.ts:232-238`), never fabricable by a
 * caller. `context` is REQUIRED (not `_context?` as in the D-49-affected
 * historical transports, see `business/src/transport.ts`'s header for that
 * SEPARATE, documented, repo-wide, out-of-scope-for-this-PR pattern) -
 * this transport fails closed with `conversation_graph_missing_invocation_context`
 * if a caller somehow invokes it without one, rather than silently trusting
 * a parameter. `TOOL_TARGET_TENANT == CALLER_AUTHORIZED_TENANT` and
 * `TOOL_TARGET_SPACE == CALLER_AUTHORIZED_SPACE` now hold structurally -
 * there is no longer a parameter through which they could diverge.
 *
 * `link_channel_identity` (Blocker B) is REMOVED from this ToolGateway
 * namespace entirely - the SAME reasoning already applied to
 * `merge_identities`/`split_merge` in the first hardening round ("Correct
 * architecture > test-count preservation"). Audit found ZERO legitimate
 * reason for it to remain model-visible in this first UA-7 slice:
 * (a) it had ZERO production callers - not wired into `mesh-bridge.ts`,
 * no REST route ever called it, only test code did; (b) its
 * `created_by_person_id`/`source_type`/`source_instance_id`/`external_id`
 * fields have NO legitimate caller-asserted use - the only TRUSTED
 * deterministic linking path (`ConversationGraphSyncService`, Gmail sync +
 * owner-configured Telegram) calls `ConversationGraphService.linkChannelIdentity()`
 * DIRECTLY, never through this transport/ToolGateway, so a real Gmail
 * `source_type`/`external_id` NEVER needed to cross this boundary in the
 * first place - any value a ToolGateway caller could supply for those
 * fields would be a bare, unverifiable assertion; (c) `linked_business_contact_id`/
 * `linked_person_id` determine WHOSE communications a channel belongs to -
 * a wrong same-tenant link is exactly the identity-resolution failure UA-7
 * exists to prevent, and same-tenant is NOT the same as "this specific
 * person/contact is correct"; (d) its `reversible: true`/rollback-procedure
 * ToolDefinition metadata ("revoker lenken") described a FUTURE, not-yet-
 * built revoke path - `D119_LINK_REVERSIBILITY_CLAIM_VALID=false`, the
 * claim was not actually true as execution metadata. Removing the action
 * resolves all four points at once without building an unproven trusted-
 * provenance system under time pressure. `ConversationGraphService.linkChannelIdentity()`
 * itself is UNCHANGED and remains the trusted internal API the sync
 * service already uses directly - this is a ToolGateway-surface removal
 * only, exactly like `merge_identities`/`split_merge`.
 *
 * `conversation_graph.*` is therefore READ-ONLY via ToolGateway as of this
 * hardening round: `resolve_identity`, `read_identity`,
 * `resolve_effective_identity`, `list_channel_links`,
 * `read_cross_channel_commitments`, `read_identity_timeline` (6 actions,
 * all class A). Canonical identity mutations happen ONLY via the trusted
 * internal `ConversationGraphSyncService` (Gmail sync, owner Telegram
 * config) or a future trusted owner-only admin path - never via a
 * model-/tool-call-reachable surface, mirroring the merge/split precedent.
 *
 * UA-7 slice 2 (D-121) adds `read_cross_channel_commitment_view` and
 * `read_cross_channel_attention` - 8 actions, STILL all class A, the
 * namespace is STILL READ-ONLY. Both new actions are pure SELECTs over the
 * two existing commitment systems-of-record (`business_followups`,
 * `business_open_loops`) joined through the Conversation Graph identity;
 * they create no new durable row and no new mutation surface, and they read
 * `tenant_id`/`memory_space` from `context.identity` exactly like the six
 * existing actions.
 */
export class ConversationGraphTransport implements ToolTransport {
  constructor(private readonly service: ConversationGraphService) {}

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential: string,
    context: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    if (!context?.identity) {
      throw new Error("conversation_graph_missing_invocation_context");
    }
    const tenantId = context.identity.tenant_id;
    const memorySpace = context.identity.memory_space_id;

    switch (action) {
      case "resolve_identity": {
        const row = await this.service.resolveIdentityByChannel(
          tenantId, memorySpace,
          requireString(parameters, "channel") as ConversationChannel,
          requireString(parameters, "channel_identifier")
        );
        return { ...(row ? { external_id: row.identity_id } : {}), data: row as unknown as JsonValue };
      }
      case "read_identity": {
        const row = await this.service.readIdentity(tenantId, memorySpace, requireString(parameters, "identity_id"));
        return { ...(row ? { external_id: row.identity_id } : {}), data: row as unknown as JsonValue };
      }
      case "resolve_effective_identity": {
        const row = await this.service.resolveEffectiveIdentity(tenantId, memorySpace, requireString(parameters, "identity_id"));
        return { ...(row ? { external_id: row.identity_id } : {}), data: row as unknown as JsonValue };
      }
      case "list_channel_links": {
        const rows = await this.service.listChannelLinks(tenantId, memorySpace, requireString(parameters, "identity_id"));
        return { data: rows as unknown as JsonValue };
      }
      case "read_cross_channel_commitments": {
        const rows = await this.service.crossChannelCommitments(tenantId, memorySpace, requireString(parameters, "identity_id"));
        return { data: rows as unknown as JsonValue };
      }
      case "read_identity_timeline": {
        const rows = await this.service.identityTimeline(tenantId, memorySpace, requireString(parameters, "identity_id"));
        return { data: rows as unknown as JsonValue };
      }
      // UA-7 slice 2 (D-121): to NYE handlinger, begge klasse A og rene
      // lese-oppslag - namespacet forblir READ-ONLY (ingen mutasjonsflate
      // gjeninnfoeres, D-119 FINAL AUTHORITY HARDENING uendret). `now`
      // hentes IKKE fra parametre: en kaller som kunne styre "naa" kunne
      // styre hvilken bucket en forpliktelse havner i - tiden kommer
      // utelukkende fra serveren, samme "no parameter = no spoof surface"-
      // prinsipp som tenant/space.
      case "read_cross_channel_commitment_view": {
        // WP-N1b (K2): en sky-/ukjent modell får ikke finansavledede åpne løkker (beløp/leverandør i `reason`/`next_action`): utelatt i SPØRRINGEN + nøytralt merke. Eier/lokal modell: uendret.
        const withhold = withholdFinanceFromCurrentModel();
        const view = await this.service.crossChannelCommitmentView(
          tenantId, memorySpace, requireString(parameters, "identity_id"), undefined, withhold ? { excludeFinanceDerived: true } : undefined
        );
        return {
          ...(view.effective_identity_id !== null ? { external_id: view.effective_identity_id } : {}),
          data: (withhold ? { ...view, ...financeWithheldMarker() } : view) as unknown as JsonValue
        };
      }
      case "read_cross_channel_attention": {
        // WP-N1b (K2): som over. Matriseformen (liste) beholdes for eier/lokal modell; en begrenset modell får `{ entries, ...merke }`.
        const withhold = withholdFinanceFromCurrentModel();
        const rows = await this.service.crossChannelAttention(
          tenantId, memorySpace, undefined, withhold ? { excludeFinanceDerived: true } : undefined
        );
        return { data: (withhold ? { entries: rows, ...financeWithheldMarker() } : rows) as unknown as JsonValue };
      }
      default:
        throw new Error(`conversation_graph_action_not_implemented:${action}`);
    }
  }
}

function requireString(parameters: Record<string, JsonValue>, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`conversation_graph_missing_parameter:${key}`);
  }
  return value;
}
