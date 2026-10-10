import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerTenantsOrExit } from "../src/owner.ts";

/**
 * WP-D2, gjennomgang av PR #326 (F7): eierens tenanter (`JARVIS_OWNER_EXTRA_TENANTS`) regnes ut ÉN gang per prosess og deles av Policy Gateway, kontrollsentrene og ToolGateway sin credentialBinding - i BÅDE api og worker
 * (tidligere uvaktet: en worker som falt tilbake til `[owner.tenant_id]` ville gitt andre grenser enn api). Og en ugyldig verdi stopper oppstarten (fail closed).
 */
const REPO = resolve(import.meta.dirname, "../../..");
const MAIN = readFileSync(resolve(REPO, "apps/api/src/main.ts"), "utf8");
const WORKER = readFileSync(resolve(REPO, "apps/api/src/worker-main.ts"), "utf8");

describe("kildevakt: api og worker bruker samme eier-tenanter overalt", () => {
  it.each([["main.ts", MAIN, 2], ["worker-main.ts", WORKER, 2]] as const)("%s: ÉN ownerTenantsOrExit, `owner_tenants: ownerTenants` i både policy-autoritet og credentialBinding, ingen innebygd liste", (_name, source, uses) => {
    expect(source.match(/const ownerTenants = ownerTenantsOrExit\(owner\);/g)).toHaveLength(1);
    expect(source.match(/owner_tenants:\s*ownerTenants\b/g)).toHaveLength(uses);
    expect(source.match(/owner_tenants:\s*\[/g) ?? []).toHaveLength(0);
  });
});

describe("ownerTenantsOrExit: fail closed", () => {
  const owner = { tenant_id: "tenant-primary", owner_person_id: "person-tobias", owner_display_name: "Tobias" };
  afterEach(() => vi.restoreAllMocks());

  it("gyldig liste gir primær-tenanten først, og tom/usatt gir kun primær-tenanten", () => {
    expect(ownerTenantsOrExit(owner, { JARVIS_OWNER_EXTRA_TENANTS: "tenant-biz" })).toEqual(["tenant-primary", "tenant-biz"]);
    expect(ownerTenantsOrExit(owner, {})).toEqual(["tenant-primary"]);
  });

  it("ugyldig verdi avslutter prosessen med kode 1 og en melding uten verdien", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => ownerTenantsOrExit(owner, { JARVIS_OWNER_EXTRA_TENANTS: "Ugyldig Tenant;DROP" })).toThrow("exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("owner_config_invalid_refusing_to_start");
    expect(String(log.mock.calls[0]?.[0])).not.toContain("DROP");
  });
});
