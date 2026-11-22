import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILES } from "@jarvis/model-gateway";
import { FINANCE_EXECUTION_LOCK, financeLockServedLocally, withholdsRestrictedJobFromCloud } from "../src/restricted-context-guard.ts";

/**
 * WP-N1 (fiks-runde 1, F-A1/F-B2): lokalitetsprediktatet til utførelseslåsen ligger i `restricted-context-guard.ts` (flyttet ut av `main.ts`) og KJØRES her mot det ekte leverandørregisteret. Før dette sto det inline i `main.ts`
 * og en invertert (W01/R41), alltid-lokal (W02/R42, gjør låsen inert) eller alltid-sky versjon (W07) overlevde alle N1-tester - gateway-testene bruker egne prediktater.
 */
const LOCAL = ["local_llm", "gemma_local", "ollama", "scripted"] as const;
const CLOUD = ["openai", "anthropic", "gemini", "gemma_hosted", "kimi", "hermes"] as const;
const model = (provider: unknown) => ({ provider, model: "m" }) as { provider: string; model: string };

describe("financeLockServedLocally mot de ekte produksjonsprofilene (DEFAULT_PROFILES)", () => {
  it("registeret har nøyaktig de ti profilene vi kjenner (en ny leverandør tvinger en bevisst avgjørelse her)", () => {
    expect(DEFAULT_PROFILES.map((p) => p.provider).sort()).toEqual([...LOCAL, ...CLOUD].sort());
  });

  it("lokale leverandører (local_llm, gemma_local, ollama, scripted) får finansdata", () => {
    for (const provider of LOCAL) expect(financeLockServedLocally(model(provider)), provider).toBe(true);
  });

  it("skyleverandører (openai, anthropic, gemini, gemma_hosted, kimi, hermes) får det aldri", () => {
    for (const provider of CLOUD) expect(financeLockServedLocally(model(provider)), provider).toBe(false);
  });

  it("prediktatet følger registerets `locality` for HVER profil (ingen avvikende kopi av lokalitetsreglen)", () => {
    for (const profile of DEFAULT_PROFILES) expect(financeLockServedLocally(model(profile.provider)), profile.provider).toBe(profile.locality === "local");
  });

  it("fail-closed: tom, blank, ukjent, STORE BOKSTAVER, mellomrom rundt og feil type regnes som sky", () => {
    for (const provider of ["", " ", "   ", "ukjent", "unknown", "GEMMA_LOCAL", "Gemma_Local", "gemma_local ", " gemma_local", "ollama\n", "local", "gemma", "local_vision", undefined, null, 7, {}, [], true]) {
      expect(financeLockServedLocally(model(provider)), JSON.stringify(provider)).toBe(false);
    }
  });

  it("modellnavnet påvirker ikke utfallet (kun leverandøren, stemplet av adapteren, avgjør)", () => {
    expect(financeLockServedLocally({ provider: "anthropic", model: "gemma3:4b" })).toBe(false);
    expect(financeLockServedLocally({ provider: "gemma_local", model: "claude-sonnet-5-5" })).toBe(true);
  });
});

describe("FINANCE_EXECUTION_LOCK er det main.ts gir ToolGateway", () => {
  it("er nøyaktig prediktatet over (ingen ekstra valg som kan gjøre låsen svakere)", () => {
    expect(Object.keys(FINANCE_EXECUTION_LOCK)).toEqual(["servedLocally"]);
    expect(FINANCE_EXECUTION_LOCK.servedLocally).toBe(financeLockServedLocally);
  });
});

describe("withholdsRestrictedJobFromCloud (fiks-runde 2, F2-B1): tilbakehold av tittel/resultat/feil fra en jobb startet fra en LÅST tur", () => {
  it("uten modell i løkka (eierens egne ruter og kall uten servingModel) holdes ingenting tilbake", () => {
    expect(withholdsRestrictedJobFromCloud(undefined)).toBe(false);
  });

  it("lokale leverandører (local_llm, gemma_local, ollama, scripted) får alt; hver skyleverandør i registeret holdes tilbake", () => {
    for (const provider of LOCAL) expect(withholdsRestrictedJobFromCloud(model(provider)), provider).toBe(false);
    for (const provider of CLOUD) expect(withholdsRestrictedJobFromCloud(model(provider)), provider).toBe(true);
  });

  it("følger registerets `locality` for HVER profil og er det eksakte motsatte av utførelseslåsens prediktat (ÉN lokalitetsregel, ingen avvikende kopi)", () => {
    for (const profile of DEFAULT_PROFILES) {
      expect(withholdsRestrictedJobFromCloud(model(profile.provider)), profile.provider).toBe(profile.locality !== "local");
      expect(withholdsRestrictedJobFromCloud(model(profile.provider)), profile.provider).toBe(!financeLockServedLocally(model(profile.provider)));
    }
  });

  it("fail-closed: tom, blank, ukjent, STORE BOKSTAVER, mellomrom rundt, feil type på leverandøren og en modell som ikke er et objekt holdes tilbake", () => {
    for (const provider of ["", " ", "   ", "\t", "ukjent", "unknown", "GEMMA_LOCAL", "Gemma_Local", "gemma_local ", " gemma_local", "ollama\n", "local", "gemma", undefined, null, 7, {}, [], true]) {
      expect(withholdsRestrictedJobFromCloud(model(provider)), JSON.stringify(provider)).toBe(true);
    }
    for (const notAModel of [null, "anthropic", "gemma_local", 7, true, [], () => undefined, {}]) {
      expect(withholdsRestrictedJobFromCloud(notAModel as never), JSON.stringify(notAModel)).toBe(true);
    }
  });

  it("modellnavnet påvirker ikke utfallet (kun leverandøren, stemplet av adapteren, avgjør)", () => {
    expect(withholdsRestrictedJobFromCloud({ provider: "anthropic", model: "gemma3:4b" })).toBe(true);
    expect(withholdsRestrictedJobFromCloud({ provider: "gemma_local", model: "claude-sonnet-5-5" })).toBe(false);
  });
});
