import { describe, expect, it } from "vitest";
import type { IdentityContext } from "@jarvis/contracts";
import { CLOUD_MUTATION_PROVIDERS, executeCloudMutation } from "../src/cloud-execution.ts";

/**
 * Gjennomgang av PR #324 (L8): `CLOUD_MUTATION_PROVIDERS[input.provider]` slo opp på et vanlig objekt med kaller-styrt nøkkel. `provider: "constructor"` ga `Object`-funksjonen som «adapter», og
 * `adapter.actions.has` kastet en `TypeError` (generisk 400 uten forklaring; `"__proto__"` ga prototypen). Oppslaget er nå `Object.hasOwn` - kun de tre registrerte leverandørene finnes, og alt annet gir
 * den tydelige, bevisste feilen `cloud_mutation_unknown_provider:<navn>` FØR noe databasekall (pool og gateway kalles aldri).
 */
const identity: IdentityContext = { person_id: "p", tenant_id: "t", memory_space_id: "business", session_id: "s", device_id: "d", channel: "api", auth_strength: "signed" };
const untouched = new Proxy({}, { get: () => { throw new Error("pool/gateway skal ikke røres"); } }) as never;
const run = (provider: string, action = "purge_cache") =>
  executeCloudMutation({ pool: untouched, gateway: untouched }, identity, { tenant_id: "t", person_id: "p", provider, action, parameters: {}, idempotency_key: "k" });

describe("leverandør-oppslaget er et eget-egenskap-oppslag", () => {
  it("Object.prototype-navn og andre ikke-registrerte leverandører gir `cloud_mutation_unknown_provider:<navn>` - ikke en TypeError - og berører aldri pool/gateway", async () => {
    for (const provider of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "__lookupGetter__", "nope", "", "CLOUDFLARE"]) {
      await expect(run(provider), JSON.stringify(provider)).rejects.toThrow(new RegExp(`^cloud_mutation_unknown_provider:${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    }
  });

  it("navnet i feilen kuttes til 40 tegn (ingen uendelig lang kaller-streng i feilmeldingen)", async () => {
    await expect(run("x".repeat(500))).rejects.toThrow(`cloud_mutation_unknown_provider:${"x".repeat(40)}`);
    const err = await run("x".repeat(500)).catch((e: Error) => e);
    expect((err as Error).message).toHaveLength("cloud_mutation_unknown_provider:".length + 40);
  });

  it("de tre registrerte leverandørene er de eneste egne egenskapene, og en ukjent HANDLING hos en ekte leverandør gir fortsatt `cloud_mutation_unknown_action` (oppslaget avviser ikke alt)", async () => {
    expect(Object.keys(CLOUD_MUTATION_PROVIDERS).sort()).toEqual(["cloudflare", "infisical", "postgres_ops"]);
    await expect(run("cloudflare", "constructor")).rejects.toThrow("cloud_mutation_unknown_action:constructor");
    await expect(run("postgres_ops", "__proto__")).rejects.toThrow("cloud_mutation_unknown_action:__proto__");
  });
});
