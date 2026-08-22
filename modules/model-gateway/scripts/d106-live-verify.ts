/**
 * D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse): manuell
 * live-verifiseringsscript - IKKE en del av den automatiserte test-suiten
 * (samme presedens som `bo9-live.ts`/`bo10-live.ts`/`mesh-live.ts`). Kjøres
 * MANUELT av en operatør (Tobias) med ekte credentials i miljøet.
 *
 * For hver av de fem kanoniske modellfamiliene (OpenAI/Claude/Gemini/Kimi/
 * Gemma) printer scriptet EN AV eksakt disse markørene, ALDRI fabrikkert:
 *   LIVE_VERIFIED               - ekte, vellykket modellkall observert NÅ
 *   CONFIGURED_NOT_LIVE_VERIFIED - nøkkel/URL satt, men kallet feilet
 *   UNCONFIGURED                 - ingen nøkkel/URL satt i det hele tatt
 *   HOST_RUNTIME_REQUIRED        - krever en lokal vert (Ollama/OpenAI-
 *                                  kompatibel server) utenfor dette miljøets
 *                                  tilgang - se D106_LOCAL_GEMMA_HOST_
 *                                  ACCEPTANCE.md
 *   UNAVAILABLE                  - konfigurert, men leverandøren avviste
 *                                  kallet (auth/rate_limit/server-feil)
 *
 * Kjør: node --experimental-transform-types modules/model-gateway/scripts/d106-live-verify.ts
 */
import {
  AnthropicAdapter,
  GeminiAdapter,
  GemmaHostedAdapter,
  KimiAdapter,
  LocalOpenAiCompatibleAdapter,
  OpenAiAdapter,
  type ModelProviderAdapter
} from "@jarvis/provider-adapters";

type LiveStatus =
  | "LIVE_VERIFIED"
  | "CONFIGURED_NOT_LIVE_VERIFIED"
  | "UNCONFIGURED"
  | "HOST_RUNTIME_REQUIRED"
  | "UNAVAILABLE";

async function verify(adapter: ModelProviderAdapter, isLocal: boolean): Promise<LiveStatus> {
  if (!adapter.available()) {
    return isLocal ? "HOST_RUNTIME_REQUIRED" : "UNCONFIGURED";
  }
  try {
    const result = await adapter.complete({
      messages: [{ role: "user", content: "Svar med nøyaktig ett ord: OK" }],
      max_tokens: 16
    });
    return result.text.trim().length > 0 ? "LIVE_VERIFIED" : "CONFIGURED_NOT_LIVE_VERIFIED";
  } catch (err) {
    console.error(`[d106-live-verify] ${adapter.name} feilet: ${(err as Error).message}`);
    return isLocal ? "UNAVAILABLE" : "CONFIGURED_NOT_LIVE_VERIFIED";
  }
}

async function main(): Promise<void> {
  const gemmaLocal = new LocalOpenAiCompatibleAdapter(
    process.env["JARVIS_GEMMA_LOCAL_URL"],
    process.env["JARVIS_GEMMA_LOCAL_MODEL"] ?? "gemma-local",
    undefined,
    "gemma_local"
  );
  const checks: Array<{ label: string; adapter: ModelProviderAdapter; isLocal: boolean }> = [
    { label: "OPENAI_LIVE_STATUS", adapter: new OpenAiAdapter(), isLocal: false },
    { label: "CLAUDE_LIVE_STATUS", adapter: new AnthropicAdapter(), isLocal: false },
    { label: "GEMINI_LIVE_STATUS", adapter: new GeminiAdapter(), isLocal: false },
    { label: "KIMI_LIVE_STATUS", adapter: new KimiAdapter(), isLocal: false },
    { label: "GEMMA_HOSTED_LIVE_STATUS", adapter: new GemmaHostedAdapter(), isLocal: false },
    { label: "GEMMA_LOCAL_LIVE_STATUS", adapter: gemmaLocal, isLocal: true }
  ];

  console.log("=== D-106 AI Mesh live-verifisering ===");
  for (const { label, adapter, isLocal } of checks) {
    const status = await verify(adapter, isLocal);
    console.log(`${label}=${status}`);
  }
  console.log("=== FERDIG ===");
}

main().catch((err) => {
  console.error("[d106-live-verify] uventet feil:", err);
  process.exitCode = 1;
});
