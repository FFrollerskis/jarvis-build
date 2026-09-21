import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import { ToolGateway } from "../src/gateway.ts";

/**
 * D-219: `ToolGateway.deny()` sin egen audit-skriving (`writeAudit()` inne i
 * `withTenantTransaction()`) hadde `.catch(() => undefined)` - INGEN av de
 * 12+ avslags-stedene i `execute()` (unknown_tool/rate_limited/
 * connector_frozen/credential_revoked/preflight_failed/osv.) hadde noen
 * logglinje hvis selve audit-skrivingen feilet. Samme "isolasjon beholdes,
 * feilen gjøres OBSERVERBAR"-mønster som PR #79 sin fiks for
 * `location`/`health`-retensjonssveipene. Denne testen bruker `unknown_tool`-
 * stien (`execute()` sitt aller første avslag, FØR noe policy-/DB-kall) mot
 * en BEVISST ødelagt `pg.Pool`-fake - ingen embedded Postgres nødvendig.
 */

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "home",
  session_id: "s", device_id: "d", channel: "voice", auth_strength: "active"
};

function makePolicy(): PolicyGateway {
  return new PolicyGateway({
    devices: new InMemoryDeviceRegistry(),
    nonces: new InMemoryNonceStore(),
    killSwitch: new KillSwitch()
  });
}

describe("D-219: ToolGateway.deny() sitt siste sikkerhetsnett for audit-skrivefeil", () => {
  it("audit-skriving som kaster logges strukturert (tool_id+action+reason+error) OG avslaget returneres likevel normalt", async () => {
    const brokenPool = { connect: () => Promise.reject(new Error("boom-audit")) } as unknown as pg.Pool;
    const gateway = new ToolGateway(brokenPool, makePolicy(), { name: "t", async get() { return null; } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await gateway.execute({
        identity, tool_id: "nonexistent_tool", action: "nonexistent_action", parameters: {}
      });
      expect(result).toEqual({ ok: false, reason: "unknown_tool" }); // fail-safe: avslaget kommer likevel gjennom
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [line] = errorSpy.mock.calls[0] as [string];
      const parsed = JSON.parse(line) as { msg: string; tool_id: string; action: string; reason: string; error: string };
      expect(parsed.msg).toBe("tool_denied_audit_write_failed");
      expect(parsed.tool_id).toBe("nonexistent_tool");
      expect(parsed.action).toBe("nonexistent_action");
      expect(parsed.reason).toBe("unknown_tool");
      expect(parsed.error).toContain("boom-audit");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
