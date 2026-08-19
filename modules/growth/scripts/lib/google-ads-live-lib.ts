/**
 * UA-4 Google Ads-adapter (D-83) - PRE-MERGE HARDENING: rene, avhengighetsfrie
 * hjelpefunksjoner for `google-ads-live.ts` FLYTTET HIT slik at de kan
 * enhetstestes direkte (SAMME "lib vs. orkestrator"-mønster som
 * `google-drive-reauth-lib.ts`/`drive-acceptance-sandbox.ts` - `-live.ts`-
 * scriptene selv kjøres KUN mot ekte Postgres/en ekte host, ALDRI unit-testet
 * direkte). INGEN Node/DB/nettverks-avhengighet i denne filen.
 */

export type Verdict = "PASS" | "FAIL" | "NO_DATA" | "BLOCKED_BY_RUNTIME_ROLE" | "BLOCKED_NO_CREDENTIALS" | "NOT_RUN";

/** §3 i byggeordren: nøyaktig disse fem MÅ være tilstede (kun tilstedeværelse sjekkes, ALDRI verdien). */
export const REQUIRED_ENV_VARS = [
  "JARVIS_GOOGLE_CLIENT_ID",
  "JARVIS_GOOGLE_CLIENT_SECRET",
  "JARVIS_GOOGLE_ADS_REFRESH_TOKEN",
  "JARVIS_GOOGLE_ADS_DEVELOPER_TOKEN",
  "JARVIS_GOOGLE_ADS_CUSTOMER_ID"
] as const;

/** §3: valgfri - kun nødvendig ved manager-/MCC-kontotilgang. */
export const OPTIONAL_ENV_VARS = ["JARVIS_GOOGLE_ADS_LOGIN_CUSTOMER_ID"] as const;

/** §9: hvilke markører er HARDE krav (må være PASS når credentials er konfigurert) vs. hvilke som SANNFERDIG kan rapportere NO_DATA uten at det skjuler en implementasjonsfeil. */
export const HARD_REQUIRED_MARKERS = [
  "googleads_live_env_safe",
  "googleads_live_auth",
  "googleads_live_customer_access",
  "googleads_live_provider_read",
  "googleads_live_campaign_sync",
  "googleads_live_campaign_sync_idempotent",
  "googleads_live_tracking_no_guess",
  "googleads_live_tenant_isolation",
  "googleads_live_secret_safety",
  "googleads_live_cleanup"
] as const;
export const NO_DATA_ELIGIBLE_MARKERS = ["googleads_live_spend_sync", "googleads_live_spend_idempotent", "googleads_live_tracking_sync", "googleads_live_provenance"] as const;

/** §2 i byggeordren: DEN ENE tillatte handlingsmengden denne runneren noensinne kaller - identisk med D-83 sitt eget, mutate-frie ToolGateway-overflate (`googleads.*`, INGEN klasse D). */
export const ALLOWED_GOOGLE_ADS_ACTIONS = ["list_campaigns", "sync_campaigns", "sync_spend", "sync_tracking_tags"] as const;
export type AllowedGoogleAdsAction = (typeof ALLOWED_GOOGLE_ADS_ACTIONS)[number];

export function isAllowedGoogleAdsAction(action: string): action is AllowedGoogleAdsAction {
  return (ALLOWED_GOOGLE_ADS_ACTIONS as readonly string[]).includes(action);
}

/** §3: ren tilstedeværelses-sjekk - ALDRI leser/returnerer den faktiske verdien, kun navnet på det som mangler. */
export function checkRequiredEnv(env: Record<string, string | undefined>): { configured: boolean; missing: string[] } {
  const missing = REQUIRED_ENV_VARS.filter((k) => !env[k]);
  return { configured: missing.length === 0, missing };
}

/**
 * §4: klassifiserer ToolGateway sin `reason`-streng for en feilet
 * googleads.*-handling til hvilken av de to distinkte feilklassene som
 * faktisk inntraff. `googleAccessToken()` kastes FØR selve GAQL-kallet i
 * `GoogleAdsTransport.invoke()` (uendret produksjonskode i D-83) - prefikset
 * alene er derfor tilstrekkelig til å skille dem uten gjetting.
 */
export function classifyGoogleAdsFailure(reason: string): "AUTH" | "CUSTOMER_ACCESS" | "OTHER" {
  if (reason.includes("google_auth_failed") || reason.includes("google_oauth_client_not_configured")) return "AUTH";
  if (reason.includes("google_ads_api_error") || reason.includes("google_ads_customer_id_not_configured") || reason.includes("google_ads_developer_token_not_configured")) {
    return "CUSTOMER_ACCESS";
  }
  return "OTHER";
}

export interface ToolGatewayResult {
  ok: boolean;
  reason?: string;
  data?: unknown;
}

export interface ListCampaignsClassification {
  auth: Verdict;
  customerAccess: Verdict;
  providerRead: Verdict;
  campaignCount: number;
}

/**
 * §4: "API nåbar/autentisert" MÅ bevises UAVHENGIG av "kampanjer finnes" -
 * en tom, men strukturelt gyldig kampanjeliste er et GYLDIG PASS for alle
 * tre markørene (auth/customer_access/provider_read), ALDRI en feil.
 */
export function classifyListCampaignsResult(result: ToolGatewayResult): ListCampaignsClassification {
  if (result.ok) {
    const inner = (result.data as { data?: unknown[] } | undefined)?.data;
    const campaigns = Array.isArray(inner) ? inner : Array.isArray(result.data) ? (result.data as unknown[]) : [];
    return { auth: "PASS", customerAccess: "PASS", providerRead: "PASS", campaignCount: campaigns.length };
  }
  const failure = classifyGoogleAdsFailure(result.reason ?? "");
  if (failure === "AUTH") return { auth: "FAIL", customerAccess: "NOT_RUN", providerRead: "NOT_RUN", campaignCount: 0 };
  return { auth: "PASS", customerAccess: "FAIL", providerRead: "NOT_RUN", campaignCount: 0 };
}

export interface ScanStats {
  scanned: number;
  failed: number;
  errors: Array<{ reason: string }>;
}

/**
 * §5/§6: en synk-handling som strukturelt lyktes (`ok:true`), men hvor
 * providerens EGET rå datasett var tomt (`scanned=0`) er NO_DATA - en LEGITIM
 * kontotilstand, IKKE en implementasjonsfeil. `ignorableErrorReason` lar
 * kalleren behandle en kjent, forventet feilårsak (f.eks.
 * `campaign_not_yet_synced` for sporingstagger på en kampanje som reelt sett
 * ikke ble synket denne runden) som ikke-blokkerende for selve PASS/FAIL-
 * vurderingen.
 */
export function classifyScanStats(stats: ScanStats, ignorableErrorReason?: string): "PASS" | "NO_DATA" | "FAIL" {
  if (stats.scanned === 0) return "NO_DATA";
  if (stats.failed === 0) return "PASS";
  if (ignorableErrorReason && stats.errors.every((e) => e.reason === ignorableErrorReason)) return "PASS";
  return "FAIL";
}

/** §13: bevis, ikke antakelse - skanner ALLE bufrede log-linjer for de faktiske secret-verdiene. Korte/tomme verdier ignoreres (unngår trivielle falske positiver). */
export function evaluateSecretSafety(logLines: readonly string[], secrets: readonly string[]): Verdict {
  const haystack = logLines.join("\n");
  const leaked = secrets.filter((s) => s.length >= 8 && haystack.includes(s));
  return leaked.length > 0 ? "FAIL" : "PASS";
}

export interface HardFailInput {
  blockedByRuntimeRole: boolean;
  credentialsConfigured: boolean;
  results: Record<string, Verdict>;
}

/**
 * §9/§14: Q-21-regresjon er ALLTID hard_fail. Manglende credentials er en
 * FORVENTET ventetilstand FØR Tobias' oppsett, ALDRI en runner-feil. Når
 * credentials ER konfigurert, MÅ alle harde markører være PASS, og INGEN
 * NO_DATA-kvalifisert markør får være en eksplisitt FAIL (NO_DATA i seg selv
 * er OK).
 */
export function computeHardFail(input: HardFailInput): boolean {
  if (input.blockedByRuntimeRole) return true;
  if (!input.credentialsConfigured) return false;
  const hardRequiredFail = HARD_REQUIRED_MARKERS.some((k) => input.results[k] !== "PASS");
  const noDataEligibleFail = NO_DATA_ELIGIBLE_MARKERS.some((k) => input.results[k] === "FAIL");
  return hardRequiredFail || noDataEligibleFail;
}

export function isoDate(d: Date): string {
  const iso = d.toISOString();
  return iso.slice(0, iso.indexOf("T"));
}
