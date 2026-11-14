import type { SecretProvider } from "./gateway.ts";

/**
 * WP-K (D-471, JARVIS-056): OAuth-KLIENTENS id/secret (Google, og Spotify når ingen resolver er gitt) leses via hvelvet FØRST (dashbord-lagret/Infisical, samme kilde som alle andre connectorer),
 * med miljøvariabelen som en LOGGET-DEPRECATED fallback slik at dagens NAS-oppsett (`.env`) fortsetter å virke uendret.
 *
 * Rekkefølge per referanse:
 *  1. hvelvet (`vault.get(ref)`) - en tom streng er aldri en gyldig verdi (D-236). En feil/nedetid i hvelvet er «ikke tilgjengelig», ALDRI en grunn til å feile kallet (miljøfallbacken under tar over).
 *  2. `env[ref]` - brukes kun når hvelvet ikke ga noe. Første gang per referanse og prosess skrives ÉN loggline (`credential_env_fallback_deprecated`) med KUN referansenavnet - aldri verdien.
 *  3. `null` - ikke konfigurert (kalleren avgjør feilen).
 *
 * Uten en konfigurert kilde (skript, tester) leser transportene miljøet stille som før (`readEnvConfig`) - denne leseren aktiveres kun der oppstartskoden (api/worker) kobler den inn.
 */
export type ConfigReader = (ref: string) => Promise<string | null>;

export interface VaultFirstConfigReaderOptions {
  /** Hvelvet (Infisical). Utelatt/`undefined` = ingen hvelv: kun miljøfallbacken (fortsatt logget som deprecated). */
  vault?: Pick<SecretProvider, "get"> | undefined;
  env?: Record<string, string | undefined>;
  /** Strukturert logg. Standard: `console.warn(JSON.stringify(...))`. Mottar aldri en verdi. */
  log?: (line: Record<string, string>) => void;
}

/** Hvilket hvelv-/env-valg en referanse faktisk ble løst fra sist (kun tellere/etiketter - aldri verdier). Nyttig for helse-/statusvisning og tester. */
export type ConfigSource = "vault" | "env" | "missing";

export interface VaultFirstConfigReader extends ConfigReader {
  /** Kilden den SISTE oppslagsrunden for `ref` ble løst fra (`undefined` = aldri slått opp). */
  lastSource(ref: string): ConfigSource | undefined;
}

export function createVaultFirstConfigReader(options: VaultFirstConfigReaderOptions = {}): VaultFirstConfigReader {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: Record<string, string>) => console.warn(JSON.stringify(line)));
  const warned = new Set<string>();
  const sources = new Map<string, ConfigSource>();
  const read = async (ref: string): Promise<string | null> => {
    if (options.vault) {
      try {
        const value = await options.vault.get(ref);
        if (typeof value === "string" && value.length > 0) {
          sources.set(ref, "vault");
          return value;
        }
      } catch {
        // hvelvet er nede/utilgjengelig - fall til miljøet (aldri en grunn til å feile selve kallet)
      }
    }
    const fromEnv = env[ref];
    if (typeof fromEnv === "string" && fromEnv.length > 0) {
      sources.set(ref, "env");
      if (!warned.has(ref)) {
        warned.add(ref);
        log({ msg: "credential_env_fallback_deprecated", ref, source: "env", action: "lagre verdien i dashbordet (Tilkoblinger) eller Infisical - miljøfallbacken fjernes senere" });
      }
      return fromEnv;
    }
    sources.set(ref, "missing");
    return null;
  };
  return Object.assign(read, { lastSource: (ref: string): ConfigSource | undefined => sources.get(ref) });
}

/** Stille miljøoppslag - dagens oppførsel for skript/tester der ingen kilde er koblet inn. Tom streng = ikke satt (D-236). */
export function readEnvConfig(ref: string, env: Record<string, string | undefined> = process.env): string | null {
  const value = env[ref];
  return typeof value === "string" && value.length > 0 ? value : null;
}
