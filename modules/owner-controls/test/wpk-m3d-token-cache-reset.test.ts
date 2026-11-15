import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { AccessTokenCache, type ToolGateway } from "@jarvis/tool-gateway";
import type { OwnerControlsService } from "../src/service.ts";
import { OwnerControlsTransport } from "../src/transport.ts";

/**
 * WP-K review M3d: når eieren bytter en connector-credential (`set_connector_credential`: Google klient-id/-secret, refresh-token ...) skal access-tokens som ble utstedt med den GAMLE konfigurasjonen
 * ikke leve videre i cachen i opptil en time (`expires_in`). Nullstillingen skjer KUN etter en vellykket skriving - en avvist eller feilet skriving endrer ingenting og skal heller ikke koste en ny utveksling.
 * Verdiene er åpenbart falske.
 */
const identity = (): IdentityContext => ({
  person_id: "person-tobias", tenant_id: "tenant-personal", memory_space_id: "personal", session_id: "sess-m3d", device_id: "dev-test", channel: "api", auth_strength: "active"
});

function setup(options: { failWrite?: boolean } = {}): { transport: OwnerControlsTransport; writes: string[] } {
  const writes: string[] = [];
  const gateway = {
    setSecret: async (ref: string) => {
      if (options.failWrite) throw new Error("infisical_unconfigured");
      writes.push(ref);
    }
  } as unknown as ToolGateway;
  return { transport: new OwnerControlsTransport({} as unknown as OwnerControlsService, gateway), writes };
}

function warmCache(): { cache: AccessTokenCache; exchanges: () => number } {
  let n = 0;
  const cache = new AccessTokenCache({ exchange: async () => { n += 1; return { access_token: `fake-access-${n}`, expires_in: 3600 }; } });
  return { cache, exchanges: () => n };
}

describe("set_connector_credential nullstiller access-token-cachene (review M3d)", () => {
  it("en vellykket skriving nullstiller cachene: et token utstedt med gammel konfig gjenbrukes ikke", async () => {
    const { cache, exchanges } = warmCache();
    expect(await cache.get("fake-refresh-token")).toBe("fake-access-1");
    expect(await cache.get("fake-refresh-token")).toBe("fake-access-1"); // cachet
    const { transport, writes } = setup();
    await transport.invoke("set_connector_credential", { connector_id: "google_calendar", credential_ref: "JARVIS_GOOGLE_CLIENT_SECRET", value: "fake-client-secret-for-test" }, "cred", { identity: identity() });
    expect(writes).toEqual(["JARVIS_GOOGLE_CLIENT_SECRET"]);
    expect(await cache.get("fake-refresh-token")).toBe("fake-access-2");
    expect(exchanges()).toBe(2);
  });

  it("også en ny refresh-token-verdi nullstiller (alle cacher, ikke bare Google)", async () => {
    const { cache } = warmCache();
    await cache.get("fake-refresh-token");
    const { transport } = setup();
    await transport.invoke("set_connector_credential", { connector_id: "google_drive", credential_ref: "JARVIS_GOOGLE_TOKEN", value: "fake-new-refresh-token" }, "cred", { identity: identity() });
    expect(await cache.get("fake-refresh-token")).toBe("fake-access-2");
  });

  it("en AVVIST skriving (uregistrert ref/ukjent connector) nullstiller IKKE cachene", async () => {
    const { cache, exchanges } = warmCache();
    await cache.get("fake-refresh-token");
    const { transport, writes } = setup();
    await expect(
      transport.invoke("set_connector_credential", { connector_id: "telegram", credential_ref: "JARVIS_GOOGLE_CLIENT_SECRET", value: "v" }, "cred", { identity: identity() })
    ).rejects.toThrow("credential_ref_not_registered_for_connector:telegram");
    await expect(
      transport.invoke("set_connector_credential", { connector_id: "finnes_ikke", credential_ref: "X", value: "v" }, "cred", { identity: identity() })
    ).rejects.toThrow("unknown_connector:finnes_ikke");
    expect(writes).toEqual([]);
    await cache.get("fake-refresh-token");
    expect(exchanges()).toBe(1);
  });

  it("en FEILET skriving (setSecret kaster) nullstiller IKKE cachene - ingenting er endret", async () => {
    const { cache, exchanges } = warmCache();
    await cache.get("fake-refresh-token");
    const { transport } = setup({ failWrite: true });
    await expect(
      transport.invoke("set_connector_credential", { connector_id: "google_calendar", credential_ref: "JARVIS_GOOGLE_CLIENT_ID", value: "fake-client-id-for-test" }, "cred", { identity: identity() })
    ).rejects.toThrow("infisical_unconfigured");
    await cache.get("fake-refresh-token");
    expect(exchanges()).toBe(1);
  });
});
