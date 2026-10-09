import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { OwnerControlsService } from "../src/service.ts";
import { OwnerControlsTransport } from "../src/transport.ts";

/**
 * WP-C3 (Q-45 b): GitHub App-ens privatnøkkel (`JARVIS_GITHUB_APP_PRIVATE_KEY`) er en VALGFRI credential_ref for `github`-connectoren og
 * kan derfor lagres fra dashbordet (`set_connector_credential` -> `ToolGateway.setSecret()` -> Infisical) - men fortsatt KUN den ene refen
 * på den ene connectoren: allowlisten er fortsatt eneste grense mot en vilkårlig secret-skrive-primitiv.
 */

const identity = (): IdentityContext => ({
  person_id: "person-tobias", tenant_id: "tenant-personal", memory_space_id: "personal", session_id: "sess-wpc3", device_id: "dev-test", channel: "api", auth_strength: "active"
});

function setup(): { transport: OwnerControlsTransport; writes: Array<{ ref: string; value: string }> } {
  const writes: Array<{ ref: string; value: string }> = [];
  const gateway = { setSecret: async (ref: string, value: string) => { writes.push({ ref, value }); } } as unknown as ToolGateway;
  return { transport: new OwnerControlsTransport({} as unknown as OwnerControlsService, gateway), writes };
}

describe("WP-C3: set_connector_credential og valgfrie refer", () => {
  it("A: App-nøkkelen kan lagres for github-connectoren (verdien når kun setSecret, og ekkoes aldri tilbake)", async () => {
    const { transport, writes } = setup();
    const pem = "enlinjes-pem-limt-inn-i-passordfeltet";
    const result = await transport.invoke("set_connector_credential", { connector_id: "github", credential_ref: "JARVIS_GITHUB_APP_PRIVATE_KEY", value: pem }, "cred", { identity: identity() });
    expect(writes).toEqual([{ ref: "JARVIS_GITHUB_APP_PRIVATE_KEY", value: pem }]);
    expect(result.data).toEqual({ connector_id: "github", credential_ref: "JARVIS_GITHUB_APP_PRIVATE_KEY", configured: true });
    expect(JSON.stringify(result)).not.toContain(pem);
  });

  it("B: den valgfrie refen kan IKKE brukes under en annen connector, og andre refer kan fortsatt ikke skrives under github", async () => {
    const { transport, writes } = setup();
    await expect(
      transport.invoke("set_connector_credential", { connector_id: "gmail", credential_ref: "JARVIS_GITHUB_APP_PRIVATE_KEY", value: "v" }, "cred", { identity: identity() })
    ).rejects.toThrow("credential_ref_not_registered_for_connector:gmail");
    for (const ref of ["JARVIS_GITHUB_APP_ID", "JARVIS_GITHUB_APP_INSTALLATION_ID", "JARVIS_BUSINESS_INTERNAL_TOKEN", "JARVIS_GITHUB_APP_PRIVATE_KEY_2"]) {
      await expect(
        transport.invoke("set_connector_credential", { connector_id: "github", credential_ref: ref, value: "v" }, "cred", { identity: identity() })
      ).rejects.toThrow("credential_ref_not_registered_for_connector:github");
    }
    expect(writes).toEqual([]);
  });

  it("C: JARVIS_GITHUB_TOKEN (PAT) kan fortsatt lagres som før", async () => {
    const { transport, writes } = setup();
    await transport.invoke("set_connector_credential", { connector_id: "github", credential_ref: "JARVIS_GITHUB_TOKEN", value: "pat" }, "cred", { identity: identity() });
    expect(writes).toEqual([{ ref: "JARVIS_GITHUB_TOKEN", value: "pat" }]);
  });
});
