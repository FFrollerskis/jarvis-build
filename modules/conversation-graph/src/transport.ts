import type { JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolInvocationContext, ToolTransport } from "@jarvis/tool-gateway";
import type { ConversationGraphService } from "./service.ts";
import { MANUAL_LINK_CONFIDENCE, TOOLGATEWAY_LINK_MATCH_METHOD, type ConversationChannel } from "./types.ts";

/**
 * D-49 (samme kjente, delte begrensning som ALLE eksisterende
 * ToolTransport-er - se `business/src/transport.ts` sitt filhode):
 * `tenant_id`/`memory_space` MAA komme via de zod-validerte `parameters`,
 * ALLTID bygget av et TRUSTED kallerlag, ALDRI av modell-output - dette
 * gjelder FORTSATT, uendret.
 *
 * D-119 SECURITY HARDENING (pre-merge, PR #67, rettelse av en TIDLIGERE
 * FEIL kommentar): `invoke()` FAAR faktisk `ToolInvocationContext` som 4.
 * parameter fra `ToolGateway.execute()` (§2 i herdingsordren, SECURITY FIX
 * #2/D-68 - se `gateway.ts:96-108,235-238` og `support/src/transport.ts`
 * sitt filhode for det kanoniske presedenset). Den TIDLIGERE påstanden her
 * ("invoke() faar IKKE IdentityContext") var STALE/USANN etter D-68 - denne
 * transporten deklarerte bare `invoke(action, parameters)` (2 av 4
 * TypeScript-parametre, strukturelt gyldig mot `ToolTransport`-grensesnittet
 * siden JS/TS tillater FÆRRE deklarerte parametre enn kalleren faktisk
 * sender), og BRUKTE DERFOR ALDRI den ekte kallerkonteksten.
 *
 * Konsekvens (bevist adversarielt FØR fiksen, se `authority-security.test.ts`
 * i samme herdingsrunde): `merge_identities`/`split_merge` sin
 * `performed_by`-parameter ble akseptert UKRITISK fra `parameters` - ETHVER
 * kall (uansett faktisk kalleridentitet) kunne skrive
 * `performed_by: "owner"` og dermed FORFALSKE eier-proveniens for en
 * PERMANENT identitets-sammenslåing (§4/§5C i herdingsordren: "owner
 * identity is executing a Jarvis conversation" er IKKE det samme som
 * "Tobias manually asserted this specific identity merge is correct" -
 * SOVEREIGN autonom class-C-utførelse betyr at Jarvis' EGEN agent kan
 * utføre handlingen, IKKE at enhver `performed_by`-streng en modell
 * skriver dermed blir sann). Retting (§6): `merge_identities`/`split_merge`
 * er FJERNET fra dette ToolGateway-navnerommet inntil en ekte, tiltrodd
 * eier-godkjenningsvei finnes - se `service.ts` sitt filhode for full
 * begrunnelse og hvorfor selve tjenestemetodene beholdes UENDRET (fullt
 * testet, kun ikke lenger modell-/kall-synlige).
 *
 * `link_channel_identity` beholdes, men `confidence`/`match_method` LESES
 * IKKE LENGER fra `parameters` (§8-10) - en ToolGateway-kalt lenke er per
 * definisjon en MANUELL/uverifisert påstand (`TOOLGATEWAY_LINK_MATCH_METHOD
 * = 'manual'`, `MANUAL_LINK_CONFIDENCE` - en FAST, lav verdi), ALDRI en
 * selv-hevdet `exact_email`/`owner_configured` med selv-hevdet `1.0`.
 * Ekte deterministisk `exact_email`/`owner_configured`-lenking skjer KUN
 * via `ConversationGraphSyncService`, som kaller `ConversationGraphService`
 * DIREKTE (aldri via ToolGateway/denne transporten).
 */
export class ConversationGraphTransport implements ToolTransport {
  constructor(private readonly service: ConversationGraphService) {}

  async invoke(
    action: string,
    parameters: Record<string, JsonValue>,
    _credential?: string,
    _context?: ToolInvocationContext
  ): Promise<{ external_id?: string; data?: JsonValue }> {
    const tenantId = requireString(parameters, "tenant_id");
    const memorySpace = (parameters["memory_space"] !== undefined ? String(parameters["memory_space"]) : "business") as MemorySpace;

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
      case "link_channel_identity": {
        const row = await this.service.linkChannelIdentity(tenantId, memorySpace, {
          channel: requireString(parameters, "channel") as ConversationChannel,
          channel_identifier: requireString(parameters, "channel_identifier"),
          // §8-10: IKKE fra parameters - en ToolGateway-kalt lenke er ALLTID
          // 'manual' med en fast, lav confidence, uansett hva kalleren sender.
          confidence: MANUAL_LINK_CONFIDENCE,
          match_method: TOOLGATEWAY_LINK_MATCH_METHOD,
          ...(parameters["identity_id"] !== undefined ? { identity_id: String(parameters["identity_id"]) } : {}),
          ...(parameters["source_type"] !== undefined ? { source_type: String(parameters["source_type"]) } : {}),
          ...(parameters["source_instance_id"] !== undefined ? { source_instance_id: String(parameters["source_instance_id"]) } : {}),
          ...(parameters["external_id"] !== undefined ? { external_id: String(parameters["external_id"]) } : {}),
          ...(parameters["display_name"] !== undefined ? { display_name: String(parameters["display_name"]) } : {}),
          ...(parameters["linked_business_contact_id"] !== undefined ? { linked_business_contact_id: String(parameters["linked_business_contact_id"]) } : {}),
          ...(parameters["linked_person_id"] !== undefined ? { linked_person_id: String(parameters["linked_person_id"]) } : {}),
          ...(parameters["created_by_person_id"] !== undefined ? { created_by_person_id: String(parameters["created_by_person_id"]) } : {})
        });
        return { external_id: row.link_id, data: row as unknown as JsonValue };
      }
      case "read_cross_channel_commitments": {
        const rows = await this.service.crossChannelCommitments(tenantId, memorySpace, requireString(parameters, "identity_id"));
        return { data: rows as unknown as JsonValue };
      }
      case "read_identity_timeline": {
        const rows = await this.service.identityTimeline(tenantId, memorySpace, requireString(parameters, "identity_id"));
        return { data: rows as unknown as JsonValue };
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
