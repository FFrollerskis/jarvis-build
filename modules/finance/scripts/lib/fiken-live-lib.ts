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

/**
 * D-107 HOST-FIX #2 (aggregerings-splitt): TO ADSKILTE verifikasjonsdomener,
 * ALDRI koblet i én boolean.
 *
 * 1. JARVIS_CANONICAL-domenet (Payment/Spend Intent-kjernen Jarvis selv
 *    eier): NØYAKTIG disse markørene, ALLE credential-UAVHENGIGE. Manglende
 *    Fiken-credentials kan ALDRI tvinge dette domenet til "ikke bevist".
 * 2. Fiken-leverandøren (EXTERNAL_CANONICAL): provider-markørene under +
 *    `finance_live_env_safe`. Uten credentials forblir de ærlig
 *    NOT_RUN/BLOCKED_NO_CREDENTIALS - det er FORVENTET ventetilstand
 *    (samme semantikk som google-ads-live-lib sin computeHardFail), IKKE
 *    en runner-feil.
 *
 * Den opprinnelige D-107-runneren la `finance_live_env_safe` og
 * `finance_live_secret_safety` i ETT felles hard-krav-sett og avledet
 * JARVIS_CANONICAL_DOMAIN_VERIFIED som `!hard_fail` - dermed tvang manglende
 * credentials (env_safe=BLOCKED_NO_CREDENTIALS, secret_safety=NO_DATA) hele
 * kjøringen til hard_fail=true SELV NÅR alle domenegatene besto, i direkte
 * selvmotsigelse med runnerens egen "domenet er likevel FULLT ut bevist"-
 * logglinje. Denne splitten retter det.
 */
export const CANONICAL_DOMAIN_MARKERS = [
  "q21_runtime_role_safe",
  "finance_live_db_idempotency",
  "finance_live_db_validation",
  "finance_live_db_kill_switch",
  "finance_live_db_state_machine",
  "finance_live_db_reconciliation",
  "finance_live_db_tenant_isolation",
  "finance_live_cleanup"
] as const;
/** Reachability/skriving mot en EKTE Fiken-konto er BEVISST NO_DATA-kvalifisert - IKKE en implementasjonsfeil dersom credentials/opt-in mangler. */
export const PROVIDER_MARKERS = ["finance_live_provider_auth", "finance_live_provider_read", "finance_live_provider_write"] as const;

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

/** JARVIS_CANONICAL-domenet er bevist HVIS OG BARE HVIS samtlige credential-uavhengige domenemarkører er PASS - Fiken-credentials inngår ALDRI i denne beregningen. */
export function computeCanonicalDomainVerified(results: Record<string, Verdict>): boolean {
  return CANONICAL_DOMAIN_MARKERS.every((marker) => results[marker] === "PASS");
}

export interface ProviderVerificationInput {
  credentialsConfigured: boolean;
  results: Record<string, Verdict>;
}

/**
 * FIKEN_LIVE_VERIFIED = KUN ekte, evidensbasert leverandørsuksess
 * (credentials konfigurert + ekte auth + ekte lesing mot api.fiken.no).
 * Skriving er BEVISST utenfor denne sliceens verifisering (ingen sandbox
 * finnes - se LIVE_WRITE_OPT_IN_ENV_VAR over), så `provider_write` inngår
 * ikke; den forblir ærlig NO_DATA/NOT_RUN i output uansett.
 */
export function computeFikenLiveVerified(input: ProviderVerificationInput): boolean {
  return input.credentialsConfigured && input.results["finance_live_provider_auth"] === "PASS" && input.results["finance_live_provider_read"] === "PASS";
}

export interface HardFailInput {
  blockedByRuntimeRole: boolean;
  credentialsConfigured: boolean;
  results: Record<string, Verdict>;
}

/**
 * Hard-fail = kjøringen bør avslutte med ikke-null exit code, og betyr en
 * EKTE produkt-/runner-feil - ALDRI en ventetilstand:
 * - Q-21-regresjon (utrygg runtime-DB-rolle) er alltid hard_fail.
 * - Ett eller flere JARVIS_CANONICAL-domenegater ikke PASS er hard_fail.
 * - En FAKTISK secret-lekkasje i loggene (secret_safety=FAIL) er hard_fail;
 *   NO_DATA (ingen secrets å sjekke) er det ALDRI.
 * - Provider-feil teller KUN når credentials faktisk ER konfigurert (samme
 *   presedens som google-ads-live-lib): manglende credentials er en
 *   FORVENTET tilstand FØR Tobias' OAuth-oppsett, aldri en feil.
 */
export function computeHardFail(input: HardFailInput): boolean {
  if (input.blockedByRuntimeRole) return true;
  if (!computeCanonicalDomainVerified(input.results)) return true;
  if (input.results["finance_live_secret_safety"] === "FAIL") return true;
  if (input.credentialsConfigured && PROVIDER_MARKERS.some((marker) => input.results[marker] === "FAIL")) return true;
  return false;
}
