import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * D-396 (JARVIS-096/093): test-/fake-implementasjoner skal ikke vokse stille inn i produksjonsflaten.
 *  A. health/vision-barrels re-eksporterer ikke `fake-source.ts` (JARVIS-093),
 *  B. BASELINE over eksporterte `Fake*`/`Scripted*`/`InMemory*`/`Mock*`-klasser i `src/` - en NY slik klasse må legges til her med begrunnelse
 *     (og vurderes mot om den heller bør ligge under test/). Baselinen kan bare krympe.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "test" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const BASELINE: Record<string, string> = {
  "modules/core/src/services/device-service.ts#FakePushAdapter": "push-adapter uten leverandør (lokal/dev) - bak PushAdapter-grensesnittet",
  "modules/health/src/fake-source.ts#FakeHealthMetricSource": "test-/dev-kilde; IKKE i barrel (importeres direkte i tester)",
  "modules/vision/src/fake-source.ts#FakeVisionEventSource": "test-/dev-kilde; IKKE i barrel (importeres direkte i tester)",
  "modules/policy/src/nonce-store.ts#InMemoryNonceStore": "referanseimplementasjon av NonceStore (produksjon bruker Pg-varianten)",
  "modules/policy/src/device-registry.ts#InMemoryDeviceRegistry": "referanseimplementasjon av DeviceRegistry (produksjon bruker Pg-varianten)",
  "modules/tasks/src/coding.ts#ScriptedCodingAgent": "deterministisk kodeagent for tester/dev (produksjon: ClaudeCodeAgent)",
  "modules/tool-gateway/src/integrations.ts#FakeTransport": "test-transport brukt av mange tester via @jarvis/tool-gateway",
  "modules/tool-gateway/src/github-rate-limit-controller.ts#InMemoryGithubRateLimitStore": "prosess-lokal rate-limit-store (default)",
  "apps/voice-gateway/src/tts.ts#FakeTts": "deterministisk TTS for tester/dev bak SpeechAdapter-grensen",
  "packages/contracts/src/mobility.ts#FakeMobilityAdapter": "dev/test-adapter bak MobilityAdapter",
  "packages/provider-adapters/src/scripted.ts#ScriptedAdapter": "deterministisk modelladapter (tester, `scripted`-provider i mesh)"
};

describe("fake-/test-implementasjoner i produksjonsflaten", () => {
  it("A: health- og vision-barrel re-eksporterer ikke fake-source", () => {
    for (const m of ["health", "vision"]) {
      const index = readFileSync(join(ROOT, `modules/${m}/src/index.ts`), "utf8");
      expect(index, m).not.toMatch(/export\s+\*\s+from\s+"\.\/fake-source\.ts"/);
    }
  });

  it("B: eksporterte Fake*/Scripted*/InMemory*/Mock*-klasser i src/ er nøyaktig baselinen (ingen nye uten begrunnelse, ingen døde oppføringer)", () => {
    const found: string[] = [];
    for (const root of ["modules", "packages", "apps"]) {
      for (const file of walk(join(ROOT, root))) {
        if (!file.includes(`${"/"}src${"/"}`)) continue;
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(/^export\s+(?:abstract\s+)?class\s+((?:Fake|Scripted|InMemory|Mock)\w+)/gm)) {
          found.push(`${relative(ROOT, file)}#${m[1]}`);
        }
      }
    }
    expect(found.sort()).toEqual(Object.keys(BASELINE).sort());
  });
});
