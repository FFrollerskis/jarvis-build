import { describe, expect, it } from "vitest";
import {
  checkRequiredEnv,
  computeCanonicalDomainVerified,
  computeFikenLiveVerified,
  computeHardFail,
  evaluateSecretSafety,
  isLiveWriteOptedIn,
  CANONICAL_DOMAIN_MARKERS,
  PROVIDER_MARKERS,
  REQUIRED_ENV_VARS,
  type Verdict
} from "../scripts/lib/fiken-live-lib.ts";

/**
 * D-107 HOST-FIX #2-regresjon: den opprinnelige runneren koblet
 * JARVIS_CANONICAL-domeneverifisering og Fiken-leverandørverifisering i ÉN
 * hard_fail-boolean (env_safe/secret_safety lå i samme hard-krav-sett som
 * domenegatene, og JARVIS_CANONICAL_DOMAIN_VERIFIED ble avledet som
 * `!hard_fail`). Tobias' ekte host-kjøring (a5f3d1a) beviste selvmotsigelsen:
 * ALLE åtte credential-uavhengige gater PASS, men
 * JARVIS_CANONICAL_DOMAIN_VERIFIED=false/hard_fail=true KUN fordi
 * credentials manglet - samtidig som scriptet selv logget at domenet var
 * "FULLT ut bevist". Disse testene låser den nye, adskilte semantikken.
 */

/** Alle credential-uavhengige domenegater PASS - grunnlaget for case A/C/D/E. */
function allCanonicalPass(): Record<string, Verdict> {
  return Object.fromEntries(CANONICAL_DOMAIN_MARKERS.map((m) => [m, "PASS" as Verdict]));
}

describe("A: credentials FRAVÆRENDE + alle domenegater PASS - domenet ER bevist, leverandøren er det IKKE", () => {
  it("JARVIS_CANONICAL_DOMAIN_VERIFIED=true helt uavhengig av Fiken-credentials", () => {
    const results = { ...allCanonicalPass(), finance_live_env_safe: "BLOCKED_NO_CREDENTIALS" as Verdict, finance_live_secret_safety: "NO_DATA" as Verdict };
    expect(computeCanonicalDomainVerified(results)).toBe(true);
  });
  it("FIKEN_LIVE_VERIFIED=false uten credentials", () => {
    const results = { ...allCanonicalPass(), finance_live_provider_auth: "NOT_RUN" as Verdict, finance_live_provider_read: "NOT_RUN" as Verdict };
    expect(computeFikenLiveVerified({ credentialsConfigured: false, results })).toBe(false);
  });
  it("hard_fail=false - manglende credentials er en FORVENTET ventetilstand, aldri en runner-feil (den eksakte a5f3d1a-host-regresjonen)", () => {
    const results = {
      ...allCanonicalPass(),
      finance_live_env_safe: "BLOCKED_NO_CREDENTIALS" as Verdict,
      finance_live_secret_safety: "NO_DATA" as Verdict,
      finance_live_provider_auth: "NOT_RUN" as Verdict,
      finance_live_provider_read: "NOT_RUN" as Verdict,
      finance_live_provider_write: "NOT_RUN" as Verdict
    };
    expect(computeHardFail({ blockedByRuntimeRole: false, credentialsConfigured: false, results })).toBe(false);
  });
});

describe("B: ETT feilende domenegate - domenet er IKKE bevist, og kjøringen er en ekte feil", () => {
  it.each([...CANONICAL_DOMAIN_MARKERS])("%s=FAIL gir JARVIS_CANONICAL_DOMAIN_VERIFIED=false og hard_fail=true", (failing) => {
    const results = { ...allCanonicalPass(), [failing]: "FAIL" as Verdict };
    expect(computeCanonicalDomainVerified(results)).toBe(false);
    expect(computeHardFail({ blockedByRuntimeRole: false, credentialsConfigured: false, results })).toBe(true);
  });
  it("et domenegate som ALDRI kjørte (NOT_RUN) beviser heller ingenting", () => {
    const results = { ...allCanonicalPass(), finance_live_db_idempotency: "NOT_RUN" as Verdict };
    expect(computeCanonicalDomainVerified(results)).toBe(false);
    expect(computeHardFail({ blockedByRuntimeRole: false, credentialsConfigured: false, results })).toBe(true);
  });
});

describe("C: credentials fraværende - provider-markører forblir ærlig NOT_RUN, aldri fabrikkert suksess", () => {
  it("NOT_RUN/NO_DATA på provider-markører gir aldri FIKEN_LIVE_VERIFIED=true", () => {
    for (const verdict of ["NOT_RUN", "NO_DATA"] as Verdict[]) {
      const results = { ...allCanonicalPass(), finance_live_provider_auth: verdict, finance_live_provider_read: verdict };
      expect(computeFikenLiveVerified({ credentialsConfigured: false, results })).toBe(false);
    }
  });
  it("selv PASS på provider-markørene teller IKKE uten credentialsConfigured=true (en logisk umulig tilstand skal ikke belønnes)", () => {
    const results = { ...allCanonicalPass(), finance_live_provider_auth: "PASS" as Verdict, finance_live_provider_read: "PASS" as Verdict };
    expect(computeFikenLiveVerified({ credentialsConfigured: false, results })).toBe(false);
  });
});

describe("D: credentials KONFIGURERT men leverandørfeil - domenene forblir uavhengige", () => {
  it("JARVIS_CANONICAL_DOMAIN_VERIFIED forblir true selv når provider-proben feiler", () => {
    const results = { ...allCanonicalPass(), finance_live_provider_auth: "FAIL" as Verdict, finance_live_provider_read: "FAIL" as Verdict };
    expect(computeCanonicalDomainVerified(results)).toBe(true);
    expect(computeFikenLiveVerified({ credentialsConfigured: true, results })).toBe(false);
  });
  it("en KONFIGURERT men feilende leverandør er derimot en ekte hard_fail (google-ads-presedens)", () => {
    const results = { ...allCanonicalPass(), finance_live_provider_auth: "FAIL" as Verdict };
    expect(computeHardFail({ blockedByRuntimeRole: false, credentialsConfigured: true, results })).toBe(true);
  });
  it("konfigurerte credentials + provider PASS + domene PASS = ingen hard_fail", () => {
    const results = { ...allCanonicalPass(), finance_live_provider_auth: "PASS" as Verdict, finance_live_provider_read: "PASS" as Verdict, finance_live_provider_write: "NO_DATA" as Verdict, finance_live_secret_safety: "PASS" as Verdict };
    expect(computeHardFail({ blockedByRuntimeRole: false, credentialsConfigured: true, results })).toBe(false);
  });
});

describe("E: kun EKTE leverandørsuksess kan sette FIKEN_LIVE_VERIFIED=true", () => {
  it("credentialsConfigured + auth PASS + read PASS er det ENESTE som gir true", () => {
    const results = { ...allCanonicalPass(), finance_live_provider_auth: "PASS" as Verdict, finance_live_provider_read: "PASS" as Verdict };
    expect(computeFikenLiveVerified({ credentialsConfigured: true, results })).toBe(true);
  });
  it("auth PASS alene (read feilet/ikke kjørt) er IKKE nok", () => {
    for (const read of ["FAIL", "NOT_RUN"] as Verdict[]) {
      const results = { ...allCanonicalPass(), finance_live_provider_auth: "PASS" as Verdict, finance_live_provider_read: read };
      expect(computeFikenLiveVerified({ credentialsConfigured: true, results })).toBe(false);
    }
  });
});

describe("F: øvrig hard_fail-semantikk", () => {
  it("Q-21-regresjon (utrygg runtime-rolle) er ALLTID hard_fail, uansett alt annet", () => {
    const results = { ...allCanonicalPass() };
    expect(computeHardFail({ blockedByRuntimeRole: true, credentialsConfigured: false, results })).toBe(true);
  });
  it("en FAKTISK secret-lekkasje (secret_safety=FAIL) er hard_fail selv med alle domenegater PASS", () => {
    const results = { ...allCanonicalPass(), finance_live_secret_safety: "FAIL" as Verdict };
    expect(computeHardFail({ blockedByRuntimeRole: false, credentialsConfigured: true, results })).toBe(true);
  });
  it("PROVIDER_MARKERS-settet er nøyaktig de tre provider-markørene (strukturlås for computeHardFail sitt konfigurert-provider-krav)", () => {
    expect([...PROVIDER_MARKERS]).toEqual(["finance_live_provider_auth", "finance_live_provider_read", "finance_live_provider_write"]);
  });
});

describe("G: checkRequiredEnv (uendret fra host-fix #1)", () => {
  it("configured=true når alle fire er tilstede", () => {
    const env = Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, "x"]));
    expect(checkRequiredEnv(env)).toEqual({ configured: true, missing: [] });
  });
  it("rapporterer NAVNET på manglende variabler, ALDRI en verdi", () => {
    const result = checkRequiredEnv({ JARVIS_FIKEN_CLIENT_ID: "x" });
    expect(result.configured).toBe(false);
    expect(result.missing).toContain("JARVIS_FIKEN_CLIENT_SECRET");
    expect(result.missing).toContain("JARVIS_FIKEN_REFRESH_TOKEN");
    expect(result.missing).toContain("JARVIS_FIKEN_COMPANY_SLUG");
    expect(result.missing).not.toContain("JARVIS_FIKEN_CLIENT_ID");
  });
});

describe("H: isLiveWriteOptedIn - fail-closed default (uendret)", () => {
  it("false når variabelen mangler", () => {
    expect(isLiveWriteOptedIn({})).toBe(false);
  });
  it("false for enhver verdi ANNET enn den eksakte strengen 'true'", () => {
    expect(isLiveWriteOptedIn({ JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE: "1" })).toBe(false);
    expect(isLiveWriteOptedIn({ JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE: "TRUE" })).toBe(false);
    expect(isLiveWriteOptedIn({ JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE: "yes" })).toBe(false);
  });
  it("true KUN for den eksakte strengen 'true'", () => {
    expect(isLiveWriteOptedIn({ JARVIS_FIKEN_HOST_ACCEPTANCE_ALLOW_LIVE_WRITE: "true" })).toBe(true);
  });
});

describe("I: evaluateSecretSafety (uendret)", () => {
  it("NO_DATA når ingen faktiske hemmeligheter er konfigurert (ingenting å bevise)", () => {
    expect(evaluateSecretSafety(["log line one", "log line two"], ["", undefined as unknown as string].filter(Boolean))).toBe("NO_DATA");
  });
  it("PASS når ingen logglinje inneholder en av hemmelighetene", () => {
    expect(evaluateSecretSafety(["safe line", "another safe line"], ["super-secret-token-123"])).toBe("PASS");
  });
  it("FAIL dersom EN logglinje inneholder hemmeligheten - selv delvis", () => {
    expect(evaluateSecretSafety(["prefix super-secret-token-123 suffix"], ["super-secret-token-123"])).toBe("FAIL");
  });
});
