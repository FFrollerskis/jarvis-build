import type { IdentityContext, JsonValue, MemorySpace } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { parseSendParams, type FunnelContext, type OutboundFunnel } from "./funnel.ts";

/**
 * WP-G1 (D-463): eierens HTTP-flate for kommunikasjon (`POST /comms/action`, `POST /comms/preview`) - logikken bor HER (testbar uten HTTP), ruten i `apps/api` gjør kun autentisering (grant -> KUN eieren) og kaller hit.
 * Alt går via `ToolGateway.execute()` (policy, eier-binding, klasse D-kjeden, idempotens, varsling) - ruten har ingen egen sendevei og ingen egen sjekk å omgå.
 *
 * Forespørsels-id: for send/rediger/slett/reager ER `idempotency_key` journalens `request_id` (ruten setter den; en innsendt `request_id` som avviker avvises). Dermed kan ikke ledgeren og journalen komme ut av takt, og en
 * ny nøkkel er ALLTID et nytt forsøk (en brent/feilet forespørsel kan ikke gjenbrukes).
 */
export const COMMS_OUTBOUND_ACTIONS: readonly string[] = ["send", "edit_message", "delete_message", "add_reaction"];
export const COMMS_ADMIN_ACTIONS: readonly string[] = ["authorize_account", "revoke_account", "record_opt_out"];
export const COMMS_READ_ACTIONS: readonly string[] = ["list_inbound", "list_outbound", "list_opt_outs", "list_accounts"];
export const COMMS_OWNER_ACTIONS: readonly string[] = [...COMMS_OUTBOUND_ACTIONS, ...COMMS_ADMIN_ACTIONS, ...COMMS_READ_ACTIONS];

const KEY = /^[A-Za-z0-9._:-]{8,200}$/;

export interface OwnerActionDeps {
  readonly gateway: Pick<ToolGateway, "execute" | "get">;
  readonly funnel: OutboundFunnel;
}

export type OwnerActionResult =
  | { readonly ok: true; readonly external_id?: string; readonly data: JsonValue; readonly output_trust: string; readonly deduplicated: boolean }
  | { readonly ok: false; readonly status: "denied"; readonly denial_codes: readonly string[]; readonly rules: JsonValue; readonly journal_id: string }
  | { readonly ok: false; readonly status: "rejected" | "failed"; readonly reason: string };

function funnelContext(identity: IdentityContext): FunnelContext {
  return { tenantId: identity.tenant_id, space: identity.memory_space_id as MemorySpace, actor: { person_id: identity.person_id, session_id: identity.session_id }, source: "owner_route" };
}

/** Tørrkjøring: hva ville policyen sagt? Ingen sending, ingen journal. Svaret bærer regelutfall og mottakerbevis - aldri meldingsteksten. */
export async function previewCommsSend(deps: OwnerActionDeps, identity: IdentityContext, parameters: Record<string, JsonValue>): Promise<OwnerActionResult> {
  const parsed = parseSendParams({ request_id: "preview-00000000", ...parameters });
  if (!parsed.ok) return { ok: false, status: "rejected", reason: parsed.code };
  const ev = await deps.funnel.evaluate(funnelContext(identity), parsed.value);
  return { ok: true, data: deps.funnel.summarize(ev), output_trust: "internal", deduplicated: false };
}

export async function executeCommsOwnerAction(
  deps: OwnerActionDeps, identity: IdentityContext, input: { action: string; parameters: Record<string, JsonValue>; idempotency_key?: string }
): Promise<OwnerActionResult> {
  const { action } = input;
  if (!COMMS_OWNER_ACTIONS.includes(action) || deps.gateway.get("comms", action) === undefined) return { ok: false, status: "rejected", reason: "comms_unknown_action" };
  const outbound = COMMS_OUTBOUND_ACTIONS.includes(action);
  const idempotencyKey = input.idempotency_key;
  let parameters = input.parameters;
  if (outbound) {
    if (idempotencyKey === undefined || !KEY.test(idempotencyKey)) return { ok: false, status: "rejected", reason: "idempotency_key_required" };
    if (parameters["request_id"] !== undefined && parameters["request_id"] !== idempotencyKey) return { ok: false, status: "rejected", reason: "comms_request_id_mismatch" };
    parameters = { ...parameters, request_id: idempotencyKey };
    // Send: tørrkjør FØRST, slik at eieren får ALLE avslagskodene (ikke bare den første) og avslaget journalføres som bevis. ToolGateway kjører policyen på nytt (preflight + rett før kallet).
    if (action === "send") {
      const parsed = parseSendParams(parameters);
      if (!parsed.ok) return { ok: false, status: "rejected", reason: parsed.code };
      const ctx = funnelContext(identity);
      const ev = await deps.funnel.evaluate(ctx, parsed.value);
      if (!ev.decision.allowed) {
        const journalId = await deps.funnel.recordDenial(ctx, ev);
        return { ok: false, status: "denied", denial_codes: ev.decision.denial_codes, rules: deps.funnel.summarize(ev)["rules"] as JsonValue, journal_id: journalId };
      }
    }
  }
  const result = await deps.gateway.execute({
    identity, tool_id: "comms", action, parameters, ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {})
  });
  if (!result.ok) return { ok: false, status: "failed", reason: result.reason.slice(0, 120) };
  return { ok: true, ...(result.external_id !== undefined ? { external_id: result.external_id } : {}), data: result.data ?? null, output_trust: result.output_trust, deduplicated: result.deduplicated };
}
