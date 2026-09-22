import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvSecretProvider, FallbackSecretProvider, ToolGateway, type SecretProvider } from "../src/gateway.ts";
import type pg from "pg";
import type { PolicyGateway } from "@jarvis/policy";

/**
 * D-236: regresjonstest for et EKTE funn i Tobias sin egen host-kjøring
 * (2026-09-22) - dashbordet viste Vipps som "konfigurert" med ✓ på alle tre
 * credential-felt selv om `.env` hadde `JARVIS_VIPPS_CLIENT_ID=` (m.fl.)
 * som TOMME linjer. Årsak: `.env.example`/`.env` har en uutfylt
 * `NØKKEL=`-linje for så godt som ALLE connector-credential-refs (bevisst
 * dokumentasjonsmønster) - Docker sin `env_file`-mekanisme setter da
 * `process.env[ref]` til `""` (tom streng), IKKE `undefined`, inne i
 * containeren. `EnvSecretProvider.get()` sin opprinnelige
 * `process.env[ref] ?? null` fanger kun `undefined`/`null` - en tom streng
 * gikk rett gjennom som en "verdi", og `hasSecret()` (`!== null`) regnet
 * den som konfigurert. Denne suiten beviser fiksen isolert (denne filen)
 * OG gjennom hele `ToolGateway.hasSecret()`-kjeden slik den faktisk er
 * satt sammen i `apps/api/src/main.ts` (env -> fallback).
 */

const REF = "JARVIS_D236_TEST_REF";

function fakePolicy(): PolicyGateway {
  return {} as unknown as PolicyGateway;
}
function fakePool(): pg.Pool {
  return {} as unknown as pg.Pool;
}

describe("A: EnvSecretProvider.get() - tom streng regnes IKKE som en satt verdi", () => {
  const original = process.env[REF];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[REF];
    } else {
      process.env[REF] = original;
    }
  });

  it("returnerer null når env-variabelen er en TOM streng (uutfylt '.env'-placeholder)", async () => {
    process.env[REF] = "";
    const provider = new EnvSecretProvider();
    await expect(provider.get(REF)).resolves.toBeNull();
  });

  it("returnerer null når env-variabelen ikke er satt i det hele tatt", async () => {
    delete process.env[REF];
    const provider = new EnvSecretProvider();
    await expect(provider.get(REF)).resolves.toBeNull();
  });

  it("returnerer den faktiske verdien når env-variabelen er en ekte, ikke-tom streng", async () => {
    process.env[REF] = "ekte-verdi";
    const provider = new EnvSecretProvider();
    await expect(provider.get(REF)).resolves.toBe("ekte-verdi");
  });
});

describe("B: ToolGateway.hasSecret() gjennom SAMME provider-kjede som apps/api/src/main.ts (env -> fallback)", () => {
  beforeEach(() => {
    delete process.env[REF];
  });
  afterEach(() => {
    delete process.env[REF];
  });

  it("hasSecret() er FALSE for en tom-men-satt env-linje - IKKE lenger et falskt 'konfigurert'-funn", async () => {
    process.env[REF] = "";
    const fallback: SecretProvider = { name: "business-internal-stub", get: async () => null };
    const secrets = new FallbackSecretProvider(new EnvSecretProvider(), fallback);
    const gateway = new ToolGateway(fakePool(), fakePolicy(), secrets);
    await expect(gateway.hasSecret(REF)).resolves.toBe(false);
  });

  it("hasSecret() er TRUE når en av kjedens ledd faktisk har en ikke-tom verdi", async () => {
    process.env[REF] = "ekte-vipps-nøkkel";
    const fallback: SecretProvider = { name: "business-internal-stub", get: async () => null };
    const secrets = new FallbackSecretProvider(new EnvSecretProvider(), fallback);
    const gateway = new ToolGateway(fakePool(), fakePolicy(), secrets);
    await expect(gateway.hasSecret(REF)).resolves.toBe(true);
  });
});
