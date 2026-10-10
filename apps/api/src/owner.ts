import { type OwnerConfig, describeOwnerConfigError, loadOwnerConfig, ownerTenantsFromEnv } from "@jarvis/contracts";

/**
 * Remediering del 2 (JARVIS-065): prosess-inngang for den ENE eier-identiteten. Ugyldig/manglende konfig
 * stopper oppstarten (fail closed) - aldri en stille default. Kun feilkode + variabelnavn logges, aldri verdier.
 */
export function ownerConfigOrExit(env: Record<string, string | undefined> = process.env): OwnerConfig {
  try {
    return loadOwnerConfig(env);
  } catch (err) {
    console.error(JSON.stringify({ msg: "owner_config_invalid_refusing_to_start", detail: describeOwnerConfigError(err) }));
    process.exit(1);
  }
}

/**
 * WP-D2 (Q-44/Q-48 C): tenantene eieren er suveren i. Uten `JARVIS_OWNER_EXTRA_TENANTS` er svaret NØYAKTIG `[JARVIS_TENANT_ID]` (uendret oppførsel); planlagte jobber som kjører med eierens egen person-id
 * (brief, situasjonssveip) er suverene i en utvidet tenant som i primær-tenanten (PR #326 F1); `system`-jobber og andre personer er det ikke. En ugyldig
 * verdi stopper oppstarten (fail closed) i stedet for å gi en stille delvis liste.
 */
export function ownerTenantsOrExit(owner: OwnerConfig, env: Record<string, string | undefined> = process.env): readonly string[] {
  try {
    return ownerTenantsFromEnv(owner, env);
  } catch (err) {
    console.error(JSON.stringify({ msg: "owner_config_invalid_refusing_to_start", detail: describeOwnerConfigError(err) }));
    process.exit(1);
  }
}
