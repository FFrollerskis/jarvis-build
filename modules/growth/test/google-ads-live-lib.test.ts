import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_GOOGLE_ADS_ACTIONS, checkRequiredEnv, classifyGoogleAdsFailure, classifyListCampaignsResult, classifyScanStats,
  computeHardFail, evaluateSecretSafety, isoDate, REQUIRED_ENV_VARS
} from "../scripts/lib/google-ads-live-lib.ts";

/**
 * PR #23 PRE-MERGE HARDENING (D-83 live-runner): rene enhetstester for
 * `google-ads-live-lib.ts` - de faktiske `-live.ts`/`-host-run.ts`-scriptene
 * er, som ALLE øvrige UA-3/UA-4-host-run-scripts i denne kodebasen, KUN
 * kjørbare mot en ekte host/Postgres/Google Ads-konto og derfor IKKE
 * unit-testet direkte (samme etablerte konvensjon som
 * google-drive-reauth-lib.test.ts). §13 i byggeordren sin sjekkliste er
 * dekket eksplisitt describe-for-describe under.
 */

describe("A: §3 env-preksjekk - manglende env feiler TRYGT (kun navn, ALDRI verdi)", () => {
  it("alle fem påkrevde variabler tilstede -> configured=true, missing=[]", () => {
    const env: Record<string, string> = {};
    for (const k of REQUIRED_ENV_VARS) env[k] = "x".repeat(20);
    expect(checkRequiredEnv(env)).toEqual({ configured: true, missing: [] });
  });

  it("én manglende variabel navngis EKSAKT, resten uberørt", () => {
    const env: Record<string, string> = {};
    for (const k of REQUIRED_ENV_VARS) env[k] = "x".repeat(20);
    delete env["JARVIS_GOOGLE_ADS_DEVELOPER_TOKEN"];
    const result = checkRequiredEnv(env);
    expect(result.configured).toBe(false);
    expect(result.missing).toEqual(["JARVIS_GOOGLE_ADS_DEVELOPER_TOKEN"]);
  });

  it("alle fem mangler -> alle fem navngis, ingen krasjer/kaster", () => {
    expect(() => checkRequiredEnv({})).not.toThrow();
    const result = checkRequiredEnv({});
    expect(result.configured).toBe(false);
    expect(result.missing).toHaveLength(5);
    expect(result.missing).toEqual(expect.arrayContaining([...REQUIRED_ENV_VARS]));
  });

  it("tom streng telles som manglende (ikke bare undefined)", () => {
    const env: Record<string, string> = {};
    for (const k of REQUIRED_ENV_VARS) env[k] = "x".repeat(20);
    env["JARVIS_GOOGLE_ADS_CUSTOMER_ID"] = "";
    expect(checkRequiredEnv(env).missing).toEqual(["JARVIS_GOOGLE_ADS_CUSTOMER_ID"]);
  });
});

describe("B: §13 secrets ALDRI printet - evaluateSecretSafety() er et etterprøvbart bevis, ikke en antakelse", () => {
  it("secret-verdi til stede i loggbufferet -> FAIL", () => {
    const secret = "hemmelig-refresh-token-abc123";
    expect(evaluateSecretSafety([`noe context her`, `feil: ${secret} ble avvist`], [secret])).toBe("FAIL");
  });

  it("secret-verdi ALDRI logget -> PASS", () => {
    const secret = "hemmelig-refresh-token-abc123";
    expect(evaluateSecretSafety(["googleads_live_auth=PASS", "googleads_live_env_safe=PASS"], [secret])).toBe("PASS");
  });

  it("korte verdier (<8 tegn) ignoreres - unngår trivielle falske positiver på f.eks. et enkelt tall i loggen", () => {
    expect(evaluateSecretSafety(["stats={\"scanned\":5}"], ["5"])).toBe("PASS");
  });

  it("tomme/udefinerte secrets (BLOCKED_NO_CREDENTIALS-tilfellet) -> trivielt PASS", () => {
    expect(evaluateSecretSafety(["googleads_live_env_safe=BLOCKED_NO_CREDENTIALS"], ["", ""])).toBe("PASS");
  });

  it("flere secrets, KUN én lekker -> fortsatt FAIL (ikke maskert av at de andre er trygge)", () => {
    const leaked = "developer-token-xyz789";
    expect(evaluateSecretSafety([`x=${leaked}`], ["safe-refresh-token-1", leaked])).toBe("FAIL");
  });
});

describe("C: §4 zero-campaign-konto håndteres SANNFERDIG - tomt resultat er IKKE en feil", () => {
  it("ok:true med data.data=[] (tom kampanjeliste) -> auth/customer_access/provider_read ALLE PASS, campaignCount=0", () => {
    const result = classifyListCampaignsResult({ ok: true, data: { data: [] } });
    expect(result).toEqual({ auth: "PASS", customerAccess: "PASS", providerRead: "PASS", campaignCount: 0 });
  });

  it("ok:true med N reelle kampanjer -> ALLE PASS, campaignCount=N", () => {
    const result = classifyListCampaignsResult({ ok: true, data: { data: [{ external_campaign_id: "1" }, { external_campaign_id: "2" }] } });
    expect(result.auth).toBe("PASS");
    expect(result.customerAccess).toBe("PASS");
    expect(result.providerRead).toBe("PASS");
    expect(result.campaignCount).toBe(2);
  });
});

describe("D: §4/§12 auth-feil klassifiseres KORREKT som FAIL, ATSKILT fra en customer-access-feil", () => {
  it("google_auth_failed_401-prefikset reason -> AUTH -> auth:FAIL, customer_access/provider_read: NOT_RUN (aldri forsøkt)", () => {
    expect(classifyGoogleAdsFailure("tool_failed:google_auth_failed_401:invalid_grant")).toBe("AUTH");
    const result = classifyListCampaignsResult({ ok: false, reason: "tool_failed:google_auth_failed_401:invalid_grant" });
    expect(result).toEqual({ auth: "FAIL", customerAccess: "NOT_RUN", providerRead: "NOT_RUN", campaignCount: 0 });
  });

  it("google_oauth_client_not_configured -> AUTH (OAuth-klienten selv mangler, ikke en Google Ads-spesifikk feil)", () => {
    expect(classifyGoogleAdsFailure("tool_failed:google_oauth_client_not_configured")).toBe("AUTH");
  });

  it("google_ads_api_error_403-prefikset reason -> CUSTOMER_ACCESS -> auth:PASS (token-utveksling lyktes), customer_access:FAIL", () => {
    expect(classifyGoogleAdsFailure("tool_failed:google_ads_api_error_403:PERMISSION_DENIED")).toBe("CUSTOMER_ACCESS");
    const result = classifyListCampaignsResult({ ok: false, reason: "tool_failed:google_ads_api_error_403:PERMISSION_DENIED" });
    expect(result).toEqual({ auth: "PASS", customerAccess: "FAIL", providerRead: "NOT_RUN", campaignCount: 0 });
  });

  it("google_ads_customer_id_not_configured -> CUSTOMER_ACCESS (konfigurasjonsgap, ikke et OAuth-problem)", () => {
    expect(classifyGoogleAdsFailure("tool_failed:google_ads_customer_id_not_configured")).toBe("CUSTOMER_ACCESS");
  });

  it("credential_unavailable (ToolGateway sin egen manglende-secret-melding, IKKE en transport-feil) -> OTHER, fortsatt klassifisert konservativt som customer_access-lignende FAIL, aldri stille PASS", () => {
    const result = classifyListCampaignsResult({ ok: false, reason: "credential_unavailable" });
    expect(result.auth).toBe("PASS");
    expect(result.customerAccess).toBe("FAIL");
  });
});

describe("E: §5/§6 NO_DATA er DISTINKT fra FAIL - en tom, men strukturelt gyldig synk er IKKE en implementasjonsfeil", () => {
  it("scanned=0 -> NO_DATA, uansett failed-verdi", () => {
    expect(classifyScanStats({ scanned: 0, failed: 0, errors: [] })).toBe("NO_DATA");
  });

  it("scanned>0, failed=0 -> PASS", () => {
    expect(classifyScanStats({ scanned: 5, failed: 0, errors: [] })).toBe("PASS");
  });

  it("scanned>0, failed>0, INGEN ignorableErrorReason -> FAIL (en ekte feil, ikke skjult bak NO_DATA)", () => {
    expect(classifyScanStats({ scanned: 5, failed: 2, errors: [{ reason: "some_real_error" }] })).toBe("FAIL");
  });

  it("scanned>0, failed>0, ALLE feil matcher ignorableErrorReason -> PASS (f.eks. campaign_not_yet_synced for gclid på en kampanje utenfor scope)", () => {
    expect(classifyScanStats({ scanned: 3, failed: 1, errors: [{ reason: "campaign_not_yet_synced" }] }, "campaign_not_yet_synced")).toBe("PASS");
  });

  it("scanned>0, failed>0, KUN NOEN feil matcher ignorableErrorReason -> FAIL (blandet, ikke trygt å anta alt er godartet)", () => {
    expect(classifyScanStats({ scanned: 3, failed: 2, errors: [{ reason: "campaign_not_yet_synced" }, { reason: "unexpected" }] }, "campaign_not_yet_synced")).toBe("FAIL");
  });
});

describe("F: §14 hard_fail-beregning - Q-21-regresjon ALLTID hard_fail, manglende credentials ALDRI hard_fail", () => {
  const allPass: Record<string, "PASS"> = {
    googleads_live_env_safe: "PASS", googleads_live_auth: "PASS", googleads_live_customer_access: "PASS", googleads_live_provider_read: "PASS",
    googleads_live_campaign_sync: "PASS", googleads_live_campaign_sync_idempotent: "PASS", googleads_live_tracking_no_guess: "PASS",
    googleads_live_tenant_isolation: "PASS", googleads_live_secret_safety: "PASS", googleads_live_cleanup: "PASS",
    googleads_live_spend_sync: "PASS", googleads_live_spend_idempotent: "PASS", googleads_live_tracking_sync: "PASS", googleads_live_provenance: "PASS"
  };

  it("blockedByRuntimeRole=true -> ALLTID hard_fail=true, uansett øvrige markører", () => {
    expect(computeHardFail({ blockedByRuntimeRole: true, credentialsConfigured: false, results: {} })).toBe(true);
    expect(computeHardFail({ blockedByRuntimeRole: true, credentialsConfigured: true, results: allPass })).toBe(true);
  });

  it("credentialsConfigured=false (BLOCKED_NO_CREDENTIALS) -> hard_fail=false (forventet ventetilstand, IKKE en runner-feil)", () => {
    expect(computeHardFail({ blockedByRuntimeRole: false, credentialsConfigured: false, results: {} })).toBe(false);
  });

  it("credentials konfigurert, ALLE harde markører PASS, NO_DATA-kvalifiserte er NO_DATA -> hard_fail=false", () => {
    const results = { ...allPass, googleads_live_spend_sync: "NO_DATA" as const, googleads_live_spend_idempotent: "NO_DATA" as const, googleads_live_tracking_sync: "NO_DATA" as const, googleads_live_provenance: "NO_DATA" as const };
    expect(computeHardFail({ blockedByRuntimeRole: false, credentialsConfigured: true, results })).toBe(false);
  });

  it("credentials konfigurert, ÉN hard-required markør FAIL -> hard_fail=true", () => {
    const results = { ...allPass, googleads_live_auth: "FAIL" as const };
    expect(computeHardFail({ blockedByRuntimeRole: false, credentialsConfigured: true, results })).toBe(true);
  });

  it("credentials konfigurert, en NO_DATA-kvalifisert markør er en EKSPLISITT FAIL (ikke NO_DATA) -> hard_fail=true (NO_DATA skjuler ALDRI en reell feil)", () => {
    const results = { ...allPass, googleads_live_spend_sync: "FAIL" as const };
    expect(computeHardFail({ blockedByRuntimeRole: false, credentialsConfigured: true, results })).toBe(true);
  });
});

describe("G: isoDate() er tidssone-trygg formattering (samme YYYY-MM-DD-krav som GAQL-adapteren selv validerer mot)", () => {
  it("returnerer eksakt YYYY-MM-DD, ingen klokkeslett/tidssone-suffiks", () => {
    expect(isoDate(new Date("2026-03-01T12:34:56.000Z"))).toBe("2026-03-01");
  });
});

describe("H: §2/§12 STRUKTURELT bevis - live-scriptet kaller ALDRI en mutate-lignende handling, KUN de fire kjente googleads.*-handlingene", () => {
  const liveScriptPath = fileURLToPath(new URL("../scripts/google-ads-live.ts", import.meta.url));
  const liveScriptSource = readFileSync(liveScriptPath, "utf8");

  it("ALLOWED_GOOGLE_ADS_ACTIONS er EKSAKT de fire D-83-handlingene, INGEN mutate/budsjett/bud/pause/resume/konvertering", () => {
    expect(ALLOWED_GOOGLE_ADS_ACTIONS).toEqual(["list_campaigns", "sync_campaigns", "sync_spend", "sync_tracking_tags"]);
  });

  it("hver googleads(\"...\", ...)-kall i google-ads-live.ts sin kildetekst bruker KUN en handling fra ALLOWED_GOOGLE_ADS_ACTIONS", () => {
    const calls = [...liveScriptSource.matchAll(/googleads\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0); // beviser selve regex-en faktisk fant noe - en tom treffliste ville gjort testen meningsløs
    for (const action of calls) expect(ALLOWED_GOOGLE_ADS_ACTIONS as readonly string[]).toContain(action);
  });

  it("kildeteksten inneholder INGEN av de kjente FREMTIDIGE mutate-handlingsnavnene (regresjonsvakt mot en fremtidig utilsiktet utvidelse)", () => {
    const forbidden = [
      "create_campaign", "update_campaign", "delete_campaign", "remove_campaign", "pause_campaign", "resume_campaign",
      "update_budget", "set_budget", "update_bid", "set_bid", "upload_conversion", "create_keyword", "create_audience", "create_creative"
    ];
    for (const name of forbidden) expect(liveScriptSource).not.toContain(`"${name}"`);
  });

  it("cleanupTenant() sine DELETE-setninger er ALLE tenant_id-parameterisert ($1) - INGEN unscoped DELETE FROM", () => {
    const cleanupFnMatch = liveScriptSource.match(/async function cleanupTenant[\s\S]*?\n}/);
    expect(cleanupFnMatch).toBeDefined();
    const body = cleanupFnMatch![0];
    const deleteStatements = [...body.matchAll(/adminPool\.query\("(DELETE FROM [^"]+)"/g)].map((m) => m[1]);
    expect(deleteStatements.length).toBeGreaterThan(0);
    for (const stmt of deleteStatements) expect(stmt).toMatch(/WHERE tenant_id = \$1$/);
  });
});
