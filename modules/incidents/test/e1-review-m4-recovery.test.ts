import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { CLOUDFLARE_RECOVERY_STRATEGIES } from "../src/cloudflare-recovery.ts";

/**
 * Gjennomgang av PR #324 (M4): gjenoppretting av en SLETTET regel der snapshotet manglet felt som var for store til å bevares (`extra_omitted`) er ALDRI en automatisk «SUCCESS» - kompensasjonen kan ikke
 * gjenskape feltet, så den svarer PARTIAL med snapshotet og ber om manuell gjenoppretting, uten å kalle gatewayen. (Selve slettingen avvises nå allerede i preflight; dette er forsvar i dybden for
 * journalrader fra før rettelsen.)
 */
const identity: IdentityContext = { person_id: "p", tenant_id: "t", memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "signed" };
const gateway = { execute: async () => { throw new Error("gatewayen skal ikke kalles"); } } as never;
const execution = (rule: Record<string, unknown>) => ({
  requested_state: { zone_id: "0123456789abcdef0123456789abcdef", phase: "http_request_firewall_custom", rule_id: "r1" },
  provider_receipt: { external_id: "r1" },
  before_state: { rules: [rule] }
}) as never;
const baseRule = { id: "r1", action: "block", expression: "ip.src eq 1.1.1.1", description: "d", enabled: true, ratelimit: null, extra: {} };

describe("undoDeleteRule med utelatte felt", () => {
  const strategy = CLOUDFLARE_RECOVERY_STRATEGIES["cloudflare:delete_waf_rule"]!;

  it("`extra_omitted` i snapshotet gir PARTIAL med manuell gjenoppretting - gatewayen kalles aldri", async () => {
    const out = await strategy({ gateway, identity, idempotencyKey: "k", execution: execution({ ...baseRule, extra_omitted: ["action_parameters"] }) });
    expect(out.status).toBe("PARTIAL");
    expect(out.result).toMatchObject({ reason: "rule_has_unmodelled_fields_manual_restore_required" });
  });

  it("kontroll: uten utelatte felt og uten extra går strategien videre til gatewayen (leser rulesettet)", async () => {
    await expect(strategy({ gateway, identity, idempotencyKey: "k", execution: execution({ ...baseRule, extra_omitted: [] }) })).rejects.toThrow("gatewayen skal ikke kalles");
  });
});
