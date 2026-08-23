import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AiRouter, CapabilityRegistry, PaidModelsDisabledError, ProviderHealthTracker } from "@jarvis/model-gateway";

/**
 * D-106 HOST-FIX (produksjonsherding, Defekt E): live host-kjøring viste
 * `PAID_MODELS_DISABLED_PROVIDERS_INVOKED=gemma_local:false,scripted:true` -
 * `ScriptedAdapter` (en DETERMINISTISK TEST-DOBLE, `packages/provider-
 * adapters/src/scripted.ts`) var registrert i `main.ts` sin PRODUKSJONS-
 * `ModelGateway` på lik linje med ekte providere. Under
 * `paid_models_allowed=false` uten en ekte, frisk lokal provider kunne
 * routeren derfor LEGITIMT velge den som eneste gjenværende "local"-
 * profilerte kandidat - og Jarvis returnerte et KANONISERT FAKE-svar i
 * produksjon, ALDRI en ærlig feil.
 *
 * `main.ts`/`worker-main.ts` er top-level side-effekt-skript (kobler til
 * ekte Postgres idet de importeres) - kan IKKE trygt importeres direkte i en
 * testfil, samme presedens som `worker-coding-wiring.test.ts`. Denne suiten
 * beviser derfor STRUKTURELT (kildetekst-inspeksjon) at `ScriptedAdapter`
 * ALDRI er en del av den ekte API-/worker-prosessens `ModelGateway`-
 * konstruksjon, PLUSS et rent routing-bevis for at den nå faktiske
 * konsekvensen (ærlig `PaidModelsDisabledError` i stedet for et falskt svar)
 * faktisk inntreffer når kun testdobbelen ville vært "lokal".
 */
function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("D-106 HOST-FIX Defekt E: ScriptedAdapter er ALDRI en produksjons-provider", () => {
  it("A: main.ts verken importerer eller instansierer ScriptedAdapter (kun ekte providere i produksjons-ModelGateway)", () => {
    const source = readSource("../src/main.ts");
    expect(source).not.toMatch(/new ScriptedAdapter\(/);
    expect(source).not.toMatch(/import\s*\{[^}]*\bScriptedAdapter\b[^}]*\}\s*from\s*"@jarvis\/provider-adapters"/s);
  });

  it("B: worker-main.ts verken importerer eller instansierer ScriptedAdapter (samme invariant, egen prosess)", () => {
    const source = readSource("../src/worker-main.ts");
    expect(source).not.toMatch(/new ScriptedAdapter\(/);
    expect(source).not.toMatch(/import\s*\{[^}]*\bScriptedAdapter\b[^}]*\}\s*from\s*"@jarvis\/provider-adapters"/s);
  });

  it("C: SCRIPTED_ADAPTER_PRODUCTION_ELIGIBLE=false - routeren (ren logikk, ingen adapterinjeksjon) feiler ÆRLIG med PaidModelsDisabledError under paid_models_allowed=false uten noen ekte lokal provider konfigurert (LOCAL_ONLY_NO_REAL_PROVIDER_FAILS_HONESTLY) - ALDRI et stille fallback til en 'scripted'-kandidat", () => {
    const router = new AiRouter(new CapabilityRegistry(), new ProviderHealthTracker());
    // Bevisst UTEN "scripted" i providers-mapen her - dette er nøyaktig
    // produksjons-tilstanden etter Defekt E-fiksen (main.ts registrerer den
    // aldri). Kun betalte sky-providere konfigurert, ingen ekte lokal.
    const providers = new Map([
      ["openai", { configured: true, model: "gpt-5" }],
      ["anthropic", { configured: true, model: "claude-sonnet-5" }]
    ]);
    expect(() => router.plan({ paid_models_allowed: false }, providers)).toThrow(PaidModelsDisabledError);
  });
});
