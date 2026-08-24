/**
 * UA-6 Finance & Spend Integrity Gateway - FØRSTE slice (D-107): rene,
 * avhengighetsfrie hjelpefunksjoner for `fiken-live.ts` (SAMME "lib vs.
 * orkestrator"-mønster som `google-ads-live-lib.ts`/`google-drive-reauth-
 * lib.ts` - `-live.ts` selv kjøres KUN mot en ekte host, ALDRI unit-testet
 * direkte). INGEN Node/DB/nettverks-avhengighet i denne filen.
 */

export type Verdict = "PASS" | "FAIL" | "NO_DATA" | "BLOCKED_BY_RUNTIME_ROLE" | "BLOCKED_NO_CREDENTIALS" | "NOT_RUN";

/** Nøyaktig disse fire MÅ være tilstede for at Fiken-transporten skal være reachable (kun tilstedeværelse sjekkes, ALDRI verdien). */
export const REQUIRED_ENV_VARS = [
  "JARVIS_FIKEN_CLIENT_ID",
  "JARVIS_FIKEN_CLIENT_SECRET",
  "JARVIS_FIKEN_REFRESH_TOKEN",
  "JARVIS_FIKEN_COMPANY_SLUG"
] as const;

/**
 * `submitPaymentIntent()` poster en EKTE, permanent regnskapspost i Tobias
 * sin virkelige Fiken-konto (INGEN sandbox-/test-modus-konsept dokumentert
 * for Fiken, i motsetning til f.eks. Stripe) - D-41-blast-radius-kravet
 * ("test-/akseptanseløp begrenses til sandbox/test-ressurser") er derfor
 * IKKE strukturelt oppfyllbart for selve skrivehandlingen uten at Tobias
 * SELV har satt opp en dedikert test-/sandbox-bedrift i sin egen Fiken-
 * konto. Denne runneren gjør AlDRI et ekte `submit`-forsøk med mindre
 * EKSPLISITT opt-in er satt - ellers er kun en LESE-basert reachability-
 * probe (`listCompanies()`, ZERO mutasjon) forsøkt.
 */
export const LIVE_WRITE_OPT_IN_ENV_VAR = "JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE";

export const HARD_REQUIRED_MARKERS = [
  "finance_live_env_safe",
  "finance_live_db_idempotency",
  "finance_live_db_validation",
  "finance_live_db_kill_switch",
  "finance_live_db_state_machine",
  "finance_live_db_reconciliation",
  "finance_live_db_tenant_isolation",
  "finance_live_secret_safety",
  "finance_live_cleanup"
] as const;
/** Reachability/skriving mot en EKTE Fiken-konto er BEVISST NO_DATA-kvalifisert - IKKE en implementasjonsfeil dersom credentials/opt-in mangler. */
export const NO_DATA_ELIGIBLE_MARKERS = ["finance_live_provider_auth", "finance_live_provider_read", "finance_live_provider_write"] as const;

/** Ren tilstedeværelses-sjekk - ALDRI leser/returnerer den faktiske verdien, kun navnet på det som mangler. */
export function checkRequiredEnv(env: Record<string, string | undefined>): { configured: boolean; missing: string[] } {
  const missing = REQUIRED_ENV_VARS.filter((k) => !env[k]);
  return { configured: missing.length === 0, missing };
}

export function isLiveWriteOptedIn(env: Record<string, string | undefined>): boolean {
  return env[LIVE_WRITE_OPT_IN_ENV_VAR] === "true";
}

/** §3: buffrede log-linjer skal ALDRI inneholde noen av de faktiske hemmelighet-verdiene - EKSPLISITT og etterprøvbart, ikke bare "vi prøvde å huske det". */
export function evaluateSecretSafety(logLines: readonly string[], secretValues: readonly string[]): Verdict {
  const realSecrets = secretValues.filter((v): v is string => Boolean(v) && v.length > 0);
  if (realSecrets.length === 0) return "NO_DATA";
  for (const line of logLines) {
    for (const secret of realSecrets) {
      if (line.includes(secret)) return "FAIL";
    }
  }
  return "PASS";
}

/** Hard-fail = kjøringen bør avslutte med ikke-null exit code - kun HARD_REQUIRED-markørene teller (MÅ være PASS), NO_DATA-kvalifiserte markører (manglende credentials/opt-in) gjør ALDRI runneren til en feil. */
export function computeHardFail(results: Record<string, Verdict>): boolean {
  return HARD_REQUIRED_MARKERS.some((marker) => results[marker] !== "PASS");
}
