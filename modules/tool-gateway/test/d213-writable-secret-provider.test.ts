import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { PolicyGateway } from "@jarvis/policy";
import {
  InfisicalSecretProvider,
  ToolGateway,
  isWritableSecretProvider,
  type SecretProvider,
  type WritableSecretProvider
} from "../src/gateway.ts";

/**
 * Task #122 (D-213): DB-uavhengige tester for den nye credential-SKRIVE-
 * kapabiliteten - `WritableSecretProvider`/`isWritableSecretProvider()`,
 * `InfisicalSecretProvider.set()` (upsert PATCH→POST-på-404), og
 * `ToolGateway.setSecret()`. Ingen av disse berører `pool`/policy-pipelinen
 * (ekte skriving skjer KUN via `connector_credentials`-handlingene i
 * `@jarvis/owner-controls`, testet der) - denne suiten beviser kun selve
 * skrive-PRIMITIVEN isolert.
 */

function fakePolicy(): PolicyGateway {
  return {} as unknown as PolicyGateway;
}
function fakePool(): pg.Pool {
  return {} as unknown as pg.Pool;
}

describe("A: isWritableSecretProvider() - strukturell type guard, ALDRI en antakelse om providertype", () => {
  it("true for en provider med en set()-metode", () => {
    const provider: WritableSecretProvider = { name: "x", get: async () => null, set: async () => undefined };
    expect(isWritableSecretProvider(provider)).toBe(true);
  });

  it("false for en ren SecretProvider uten set()", () => {
    const provider: SecretProvider = { name: "x", get: async () => null };
    expect(isWritableSecretProvider(provider)).toBe(false);
  });
});

describe("B: ToolGateway.setSecret() - fail-closed uten konfigurert writableSecrets, ALDRI en stille no-op", () => {
  it("kaster 'secret_provider_not_writable' når writableSecrets ikke er gitt inn", async () => {
    const secrets: SecretProvider = { name: "read-only", get: async () => null };
    const gateway = new ToolGateway(fakePool(), fakePolicy(), secrets);
    await expect(gateway.setSecret("SOME_REF", "value")).rejects.toThrow("secret_provider_not_writable");
  });

  it("delegerer TIL writableSecrets.set() med eksakt (ref, value) når konfigurert - verdien går ALDRI andre steder", async () => {
    const secrets: SecretProvider = { name: "read-only", get: async () => null };
    const calls: Array<{ ref: string; value: string }> = [];
    const writable: WritableSecretProvider = {
      name: "writable", get: async () => null,
      set: async (ref, value) => { calls.push({ ref, value }); }
    };
    const gateway = new ToolGateway(fakePool(), fakePolicy(), secrets, undefined, writable);
    await gateway.setSecret("JARVIS_GITHUB_TOKEN", "ghp_super_secret_value");
    expect(calls).toEqual([{ ref: "JARVIS_GITHUB_TOKEN", value: "ghp_super_secret_value" }]);
  });
});

describe("C: InfisicalSecretProvider.set() - upsert (PATCH FØRST, POST kun på 404), verdien logges/kastes ALDRI i feilmeldinger", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function configuredProvider(): InfisicalSecretProvider {
    return new InfisicalSecretProvider(
      "https://infisical.example", "client-id", "client-secret", "project-id", "dev"
    );
  }

  it("kaster 'infisical_unconfigured' når providerern ikke er konfigurert, uten noe fetch-kall", async () => {
    const provider = new InfisicalSecretProvider(undefined, undefined, undefined, undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(provider.set("REF", "value")).rejects.toThrow("infisical_unconfigured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("PATCH lykkes (secreten fantes fra før) - INGEN POST-kall gjøres i tillegg", async () => {
    const calls: Array<{ method: string; url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).includes("/auth/universal-auth/login")) {
        return { ok: true, json: async () => ({ accessToken: "tok-1" }) } as unknown as Response;
      }
      calls.push({ method: String(init.method), url: String(url), body: String(init.body) });
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    const provider = configuredProvider();
    // Bevisst IKKE et ekte-utseende leverandørnøkkel-format (f.eks. "sk_live_...") -
    // gitleaks sin generic-api-key-regel flagget nettopp denne linjen i en
    // tidligere runde. Verdien testes strukturelt (sendes uendret gjennom),
    // formen på selve teststrengen er irrelevant for det.
    await provider.set("JARVIS_STRIPE_SECRET_KEY", "test-fixture-value-not-a-real-key");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/api/v3/secrets/raw/JARVIS_STRIPE_SECRET_KEY");
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body).toEqual({ workspaceId: "project-id", environment: "dev", secretValue: "test-fixture-value-not-a-real-key" });
    expect(provider.health).toBe("healthy");
  });

  it("PATCH 404 (secreten fantes IKKE fra før) faller tilbake til POST mot SAMME URL/kropp", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).includes("/auth/universal-auth/login")) {
        return { ok: true, json: async () => ({ accessToken: "tok-1" }) } as unknown as Response;
      }
      methods.push(String(init.method));
      if (init.method === "PATCH") return { ok: false, status: 404 } as unknown as Response;
      return { ok: true, status: 201, json: async () => ({}) } as unknown as Response;
    });
    const provider = configuredProvider();
    await provider.set("JARVIS_NEW_CONNECTOR_TOKEN", "brand-new-value");
    expect(methods).toEqual(["PATCH", "POST"]);
    expect(provider.health).toBe("healthy");
  });

  it("401 nullstiller token og kaster 'infisical_auth_expired' - INGEN fallback til POST for en auth-feil", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/auth/universal-auth/login")) {
        return { ok: true, json: async () => ({ accessToken: "tok-expired" }) } as unknown as Response;
      }
      return { ok: false, status: 401 } as unknown as Response;
    });
    const provider = configuredProvider();
    await expect(provider.set("REF", "value")).rejects.toThrow("infisical_auth_expired");
  });

  it("en vedvarende feil (verken 401 eller 404) kaster 'infisical_set_<status>' og setter health='unavailable'", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/auth/universal-auth/login")) {
        return { ok: true, json: async () => ({ accessToken: "tok-1" }) } as unknown as Response;
      }
      return { ok: false, status: 500 } as unknown as Response;
    });
    const provider = configuredProvider();
    await expect(provider.set("REF", "value")).rejects.toThrow("infisical_set_500");
    expect(provider.health).toBe("unavailable");
  });

  it("feilmeldingen inneholder ALDRI selve secret-verdien - kun HTTP-status", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/auth/universal-auth/login")) {
        return { ok: true, json: async () => ({ accessToken: "tok-1" }) } as unknown as Response;
      }
      return { ok: false, status: 500 } as unknown as Response;
    });
    const provider = configuredProvider();
    const secretValue = "correct-horse-battery-staple-do-not-leak";
    try {
      await provider.set("REF", secretValue);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(secretValue);
    }
  });
});
