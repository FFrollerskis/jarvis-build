import type { SecretProvider, SecretSourceHealth } from "./gateway.ts";

/**
 * WP-K (D-471, JARVIS-056): OAuth-KLIENTENS id/secret (Google, og Spotify når ingen resolver er gitt) leses via hvelvet FØRST (dashbord-lagret/Infisical, samme kilde som alle andre connectorer),
 * med miljøvariabelen som en LOGGET-DEPRECATED fallback slik at dagens NAS-oppsett (`.env`) fortsetter å virke uendret.
 *
 * Rekkefølge per referanse:
 *  1. hvelvet (`vault.get(ref)`, med kort frist) - en tom streng er aldri en gyldig verdi (D-236). Treffet logges som `credential_source` (source=vault) første gang og når kilden skifter.
 *  2. HVELVET FEILET (frist/unntak/`health === "unavailable"`; review M3a - ikke det samme som «finnes ikke»): den SIST KJENTE hvelvverdien i denne prosessen brukes (en flyttet/rotert hemmelighet skal ikke
 *     byttes ut med en utdatert `.env`-verdi), ellers miljøet. Feilen logges som `credential_vault_error` (strupet; kun referanse, årsakskode og hva som ble brukt) - med en tekst som IKKE sier «flytt til dashbordet».
 *     Den sist kjente verdien ligger KUN i prosessens minne og nullstilles så snart hvelvet SVARER «finnes ikke»/«ikke konfigurert» (re-review LOW 3: en slettet hvelvverdi kommer ikke tilbake ved et senere avbrudd).
 *     Sletter eieren hvelvoppføringen mens hvelvet allerede er nede (eller før noe oppslag har sett fraværet), huskes verdien til neste omstart av api/worker - se runbook §10.
 *  3. hvelvet svarte «finnes ikke»/er ikke konfigurert, og miljøet har verdien: miljøet brukes og logges ÉN gang per referanse og prosess som `credential_env_fallback_deprecated` (kun referansenavnet, aldri verdien).
 *  4. `null` - ikke konfigurert (kalleren avgjør feilen).
 *
 * Uten en konfigurert kilde (skript, tester) leser transportene miljøet stille som før (`readEnvConfig`) - denne leseren aktiveres kun der oppstartskoden (api/worker) kobler den inn.
 */
export type ConfigReader = (ref: string) => Promise<string | null>;

/** Utfallet av SISTE hvelvoppslag: `ok` (verdi funnet), `absent` (hvelvet svarte «finnes ikke»), `unconfigured` (hvelvet er ikke i bruk), `error` (frist/unntak/utilgjengelig). */
export type VaultState = "ok" | "absent" | "unconfigured" | "error";

/** Hvilken kilde en referanse ble løst fra sist (kun etiketter - aldri verdier). */
export type ConfigSource = "vault" | "vault_last_known" | "env" | "missing";

export interface VaultFirstConfigReaderOptions {
  /** Hvelvet (Infisical). Utelatt/`undefined` = ingen hvelv: kun miljøfallbacken (fortsatt logget som deprecated). `health` (om kilden har den) skiller «finnes ikke» fra «kunne ikke leses». */
  vault?: (Pick<SecretProvider, "get"> & { health?: SecretSourceHealth }) | undefined;
  env?: Record<string, string | undefined>;
  /** Strukturert logg. Standard: `console.warn(JSON.stringify(...))`. Mottar aldri en verdi. */
  log?: (line: Record<string, string>) => void;
  /** Frist per hvelvoppslag (ms). Standard 2500: et hengt hvelv skal ikke gjøre hver token-utveksling til 5-10 s ventetid (Infisical har selv 5 s per lesing). */
  timeoutMs?: number;
  /** Strupe for `credential_vault_error`-linjer per referanse (ms). Standard 300 000 (5 min): et vedvarende avbrudd skal synes uten å fylle loggen. */
  errorLogIntervalMs?: number;
  now?: () => number;
}

export interface VaultFirstConfigReader extends ConfigReader {
  /** Kilden den SISTE oppslagsrunden for `ref` ble løst fra (`undefined` = aldri slått opp). */
  lastSource(ref: string): ConfigSource | undefined;
  /** `error` hvis NOE hvelvoppslag feilet sist (oppstartens Drive-måling bruker det til å vente på et hvelv som ikke er oppe ennå); ellers `ok`. */
  vaultState(): "ok" | "error";
}

const HVELV_TIMEOUT = Symbol("vault_timeout");

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(HVELV_TIMEOUT), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

export function createVaultFirstConfigReader(options: VaultFirstConfigReaderOptions = {}): VaultFirstConfigReader {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: Record<string, string>) => console.warn(JSON.stringify(line)));
  const timeoutMs = Math.max(50, Math.trunc(options.timeoutMs ?? 2_500));
  const errorLogIntervalMs = options.errorLogIntervalMs ?? 300_000;
  const now = options.now ?? Date.now;
  const warnedDeprecated = new Set<string>();
  const sources = new Map<string, ConfigSource>();
  const states = new Map<string, VaultState>();
  const lastKnown = new Map<string, string>();
  const lastErrorLogAt = new Map<string, number>();

  const readVault = async (ref: string): Promise<{ state: VaultState; value?: string; reason?: string }> => {
    const vault = options.vault;
    if (!vault) return { state: "unconfigured" };
    try {
      const value = await withDeadline(Promise.resolve(vault.get(ref)), timeoutMs);
      if (typeof value === "string" && value.length > 0) return { state: "ok", value };
      // `get()` gir null: «finnes ikke» ELLER «kunne ikke leses» (InfisicalSecretProvider svarer null begge steder og setter `health`).
      if (vault.health === "unavailable") return { state: "error", reason: "unavailable" };
      if (vault.health === "unconfigured") return { state: "unconfigured" };
      return { state: "absent" };
    } catch (err) {
      return { state: "error", reason: err === HVELV_TIMEOUT ? "timeout" : "exception" };
    }
  };

  const noteSource = (ref: string, source: ConfigSource): void => {
    const previous = sources.get(ref);
    sources.set(ref, source);
    if (previous !== source && (source === "vault" || source === "vault_last_known")) log({ msg: "credential_source", ref, source });
  };

  const read = async (ref: string): Promise<string | null> => {
    const outcome = await readVault(ref);
    states.set(ref, outcome.state);
    // Re-review LOW 3: svarte hvelvet «finnes ikke»/«ikke konfigurert», er det en BEKREFTET fravær - den sist kjente hvelvverdien er da foreldet og må ikke kunne komme tilbake. Uten dette ville en verdi eieren
    // slettet fra hvelvet (rollback, runbook §10) vinne over `.env` igjen så snart hvelvet fikk et avbrudd i samme prosess. En FEIL (frist/unntak/utilgjengelig) rører den ikke - da er det nettopp den som brukes.
    if (outcome.state === "absent" || outcome.state === "unconfigured") lastKnown.delete(ref);
    if (outcome.state === "ok" && outcome.value !== undefined) {
      lastKnown.set(ref, outcome.value);
      noteSource(ref, "vault");
      return outcome.value;
    }
    const fromEnv = env[ref];
    const envValue = typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : null;
    if (outcome.state === "error") {
      const known = lastKnown.get(ref) ?? null;
      const using = known !== null ? "last_known_vault_value" : envValue !== null ? "env" : "none";
      const at = now();
      if (at - (lastErrorLogAt.get(ref) ?? Number.NEGATIVE_INFINITY) >= errorLogIntervalMs) {
        lastErrorLogAt.set(ref, at);
        log({
          msg: "credential_vault_error", ref, reason: outcome.reason ?? "unknown", using,
          action: "hvelvet kunne ikke leses akkurat nå (det er IKKE det samme som at verdien mangler): ikke flytt eller slett noe - sjekk at Infisical er oppe. Verdien som brukes kan være utdatert hvis den er endret i hvelvet."
        });
      }
      if (known !== null) { noteSource(ref, "vault_last_known"); return known; }
    }
    if (envValue !== null) {
      noteSource(ref, "env");
      if (outcome.state !== "error" && !warnedDeprecated.has(ref)) {
        warnedDeprecated.add(ref);
        log({
          msg: "credential_env_fallback_deprecated", ref, source: "env", vault: outcome.state,
          action: outcome.state === "unconfigured"
            ? "hvelvet (Infisical) er ikke konfigurert - miljøet er eneste kilde. Konfigurer Infisical og lagre verdien i dashbordet (Tilkoblinger) før miljøfallbacken fjernes senere."
            : "lagre verdien i dashbordet (Tilkoblinger) eller Infisical - miljøfallbacken fjernes senere."
        });
      }
      return envValue;
    }
    noteSource(ref, "missing");
    return null;
  };

  return Object.assign(read, {
    lastSource: (ref: string): ConfigSource | undefined => sources.get(ref),
    vaultState: (): "ok" | "error" => ([...states.values()].includes("error") ? "error" : "ok")
  });
}

/** Stille miljøoppslag - dagens oppførsel for skript/tester der ingen kilde er koblet inn. Tom streng = ikke satt (D-236). */
export function readEnvConfig(ref: string, env: Record<string, string | undefined> = process.env): string | null {
  const value = env[ref];
  return typeof value === "string" && value.length > 0 ? value : null;
}
