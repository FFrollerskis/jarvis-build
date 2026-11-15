import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { OwnerControlsService } from "../src/service.ts";
import { OwnerControlsTransport } from "../src/transport.ts";

/**
 * WP-K (D-471, JARVIS-056): Google OAuth-klientens id/secret kan lagres fra dashbordet (`set_connector_credential` -> `ToolGateway.setSecret()` -> Infisical) under Google-connectorene - fortsatt KUN de to
 * refene på de fire Google-connectorene (allowlisten er eneste grense mot en vilkårlig secret-skrive-primitiv). Verdiene er åpenbart falske og ekkoes aldri tilbake.
 */
const identity = (): IdentityContext => ({
  person_id: "person-tobias", tenant_id: "tenant-personal", memory_space_id: "personal", session_id: "sess-wpk056", device_id: "dev-test", channel: "api", auth_strength: "active"
});

function setup(): { transport: OwnerControlsTransport; writes: Array<{ ref: string; value: string }> } {
  const writes: Array<{ ref: string; value: string }> = [];
  const gateway = { setSecret: async (ref: string, value: string) => { writes.push({ ref, value }); } } as unknown as ToolGateway;
  return { transport: new OwnerControlsTransport({} as unknown as OwnerControlsService, gateway), writes };
}

describe("set_connector_credential: Google-klientens id/secret", () => {
  it("kan lagres under hver Google-connector, når kun setSecret, og ekkoes aldri tilbake", async () => {
    for (const connector of ["google_calendar", "gmail", "google_drive", "google_sheets"]) {
      for (const ref of ["JARVIS_GOOGLE_CLIENT_ID", "JARVIS_GOOGLE_CLIENT_SECRET"]) {
        const { transport, writes } = setup();
        const value = `fake-${ref.toLowerCase()}-for-test`;
        const result = await transport.invoke("set_connector_credential", { connector_id: connector, credential_ref: ref, value }, "cred", { identity: identity() });
        expect(writes, `${connector}/${ref}`).toEqual([{ ref, value }]);
        expect(result.data).toEqual({ connector_id: connector, credential_ref: ref, configured: true });
        expect(JSON.stringify(result)).not.toContain(value);
      }
    }
  });

  it("kan IKKE skrives under en connector som ikke bruker Google-klienten, og nærliggende refer er fortsatt avvist", async () => {
    const { transport, writes } = setup();
    for (const connector of ["telegram", "github", "spotify"]) {
      await expect(
        transport.invoke("set_connector_credential", { connector_id: connector, credential_ref: "JARVIS_GOOGLE_CLIENT_SECRET", value: "v" }, "cred", { identity: identity() })
      ).rejects.toThrow(`credential_ref_not_registered_for_connector:${connector}`);
    }
    for (const ref of ["JARVIS_GOOGLE_CLIENT_SECRET_JSON", "JARVIS_GOOGLE_OAUTH_CLIENT_TYPE", "JARVIS_GOOGLE_CLIENT_ID_2"]) {
      await expect(
        transport.invoke("set_connector_credential", { connector_id: "google_calendar", credential_ref: ref, value: "v" }, "cred", { identity: identity() })
      ).rejects.toThrow("credential_ref_not_registered_for_connector:google_calendar");
    }
    expect(writes).toEqual([]);
  });
});
