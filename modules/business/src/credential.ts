import type { SecretProvider } from "@jarvis/tool-gateway";

/**
 * D-49: `ToolGateway.execute()` krever ubetinget en ikke-null credential for
 * ALLE verktøy (`secrets.get(definition.credential_ref)` - "credential_
 * unavailable" ved null), ogsaa for et rent internt verktøy uten ekte
 * ekstern secret. Business OS har INGEN ekstern leverandør-credential -
 * `BusinessTransport.invoke()` bruker aldri `credential`-parameteren.
 * Denne provideren returnerer en EKSPLISITT ikke-hemmelig sentinel-streng
 * KUN for denne ene referansen - aldri en ekte credential, aldri logget som
 * hemmelig (den ER ikke hemmelig). Wires via `FallbackSecretProvider(env,
 * new BusinessInternalSecretProvider())` i main.ts/worker-main.ts - env kan
 * fortsatt overstyre for tester, gjenbruker EKSISTERENDE FallbackSecretProvider-
 * primitiv i stedet for en ny mekanisme.
 */
export const BUSINESS_INTERNAL_CREDENTIAL_REF = "JARVIS_BUSINESS_INTERNAL_TOKEN";
const BUSINESS_INTERNAL_SENTINEL = "internal-no-external-credential";

export class BusinessInternalSecretProvider implements SecretProvider {
  readonly name = "business-internal";
  async get(ref: string): Promise<string | null> {
    return ref === BUSINESS_INTERNAL_CREDENTIAL_REF ? BUSINESS_INTERNAL_SENTINEL : null;
  }
}
