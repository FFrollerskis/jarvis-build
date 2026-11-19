/**
 * UA-1 capability registry (BO-08 §7): konfigurerbart og testbart - routing
 * skjer mot registry-data, aldri som if/else-blokker per provider i koden.
 *
 * UA-2 P1B-A (D-43 §3): `vision`-flagget må reflektere FAKTISK wiret
 * bildestøtte i den tilhørende adapteren (`packages/provider-adapters`),
 * ALDRI et informativt/aspirasjonelt leverandør-fakta. `anthropic` og (D-81)
 * `gemma_hosted` har ekte bilde-mapping (se `anthropic.ts` sin
 * `toAnthropicContent()` og `gemma.ts` sin `toGemmaParts()`) - `openai`/
 * `gemini`/`local_llm` støtter i praksis vision hos leverandøren, men
 * adapteren her bruker fortsatt `textOnly()` og ville stille droppet
 * bildedata; å beholde `vision` i profilen ville latt routeren sende et
 * vision-krevd kall til en adapter som degraderer det til ren tekst. Rettes
 * når disse adapterne faktisk får bilde-mapping (egen fremtidig runde).
 *
 * D-80 (samme regel, samme rigiditet): `streaming` er FJERNET fra `gemini`
 * sin profil her - adapteren (`gemini.ts`) har ALDRI hatt en `.stream()`-
 * metode (kun `generateContent`, ikke `streamGenerateContent`), så den
 * tidligere `streaming: true`-påstanden var en registry/adapter-mismatch
 * (fanget under D-80 sin arkitekturgjennomgang - `ModelGateway.executePlan()`
 * degraderer allerede trygt til enkelt-delta for adaptere uten `.stream()`,
 * så dette var ALDRI en krasj-bug, kun en unøyaktig capability-påstand som
 * brøt filens egen regel over). `local_llm` følger fortsatt SAMME grense -
 * INGEN `.stream()`-metode, derfor INGEN `streaming` her.
 *
 * WP-G3 (D-465, 2026-11): `local_vision` er `LocalOpenAiCompatibleAdapter` konstruert med `{ vision: true }` (se `local-llm.ts`, `toOpenAiVisionContent`):
 * adapteren sender `image_url` med base64 `data:`-URL til et lokalt OpenAI-kompatibelt endepunkt (Ollama/llama.cpp/LM Studio/vLLM med en visjonsmodell).
 * `local_llm`/`gemma_local` har fortsatt `textOnly()` og FÅR IKKE `vision` her - flagget reflekterer wiret støtte per provider-identitet. Profilen (`LOCAL_VISION_PROFILE`, UTENFOR
 * `DEFAULT_PROFILES`, se under) er `dedicated_to: "vision"` (ingen vanlig ruting) og kameramedier (`restricted`) går kun til LOKALE kandidater (se `ModelGateway.executePlan`).
 *
 * D-199-B (Q-30 lukket, 2026-09-20): `gemma_hosted` fikk en EKTE
 * `.stream()`-implementasjon (`gemma.ts`, samme SSE-mønster som `anthropic.ts`/
 * `openai.ts` via delt `sseLines()`) - `streaming` er derfor nå en SANN
 * capability-påstand for DENNE profilen (fortsatt IKKE for `gemini`, som
 * uendret mangler `.stream()` - de to deler API-flate, ikke adapterkode).
 */
export type ModelCapability =
  | "text"
  | "reasoning"
  | "vision"
  | "tool_calling"
  | "structured_output"
  | "streaming";

export interface ModelProfile {
  provider: string;
  /** Informativ default-modell (adapterens konfigurerte modell vinner runtime). */
  model: string;
  capabilities: ModelCapability[];
  context_tokens: number;
  locality: "local" | "cloud";
  /** Relativ kost 1 (billigst) - 5 (dyrest). */
  cost_class: 1 | 2 | 3 | 4 | 5;
  /** Relativ kvalitet 1 (svakest) - 5 (best). */
  quality_class: 1 | 2 | 3 | 4 | 5;
  latency_class: "fast" | "medium" | "slow";
  /**
   * D-80/D-81 (§3 personvern-grense): `true` KUN for hostede sky-providere som
   * kjører på et delt gratis-tier-kvotebasseng (i dag: `gemma_hosted`).
   * Routeren (`router.ts`) krever et EKSPLISITT
   * `sensitivity === "PUBLIC_OR_LOW_SENSITIVITY"` for at denne providertypen
   * skal være kvalifisert (D-81 P0-fiks: udefinert/ukjent sensitivitet blir
   * ALDRI tolket som "public") - se `DataSensitivity` i `@jarvis/contracts`.
   * Default `false` for ALLE eksisterende betalte/lokale providere (uendret
   * tillit - denne sliceen innfører INGEN ny begrensning på allerede
   * konfigurerte betalte leverandører, kun på det NYE gratis-tier-tillegget).
   */
  hosted_free_tier?: boolean;
  /**
   * WP-D4 (gjennomgang av PR #315, M3): capabilities registeret PÅSTÅR (adapteren har dem og de er bevist mot en fake server), men som ikke er LIVE-verifisert mot leverandøren. AUTO-ruting (ingen eksplisitt valg) bruker ikke
   * leverandøren til et kall som krever en av dem før eieren har kjørt `mesh-live-smoke.ts --tools` og erklært det med `JARVIS_MESH_TOOLS_VERIFIED=<leverandør>` (se `AiRouter`). Eksplisitte valg (`provider`, `providerPreference`,
   * `JARVIS_CHAT_CANDIDATES`, «bruk Kimi») påvirkes ikke. Udefinert/tom = alt påstått er verifisert (alle øvrige profiler). `capabilities` er uendret: påstanden står, men AUTO bruker den ikke på tillit.
   */
  live_unverified?: ReadonlyArray<ModelCapability>;
  /**
   * WP-G3 (D-465): leverandøren er DEDIKERT til én capability (i dag kun `local_vision` -> `vision`) og deltar i den SCOREDE rutingen (AUTO/FAST/...) kun når kallet faktisk krever den. En lokal modell
   * eieren har satt opp for kamerabilder skal ikke bli en stille kandidat for vanlig prat, bakgrunnsjobber eller helse-/finansturer. Eksplisitte valg (`provider`, `providerPreference`) er uendret.
   * Udefinert (alle øvrige profiler) = ingen innsnevring.
   */
  dedicated_to?: ModelCapability;
}

/** Defaults matcher adapterens env-defaults; overstyres via konstruktør/konfig. */
export const DEFAULT_PROFILES: ModelProfile[] = [
  {
    provider: "openai",
    model: "gpt-5",
    capabilities: ["text", "reasoning", "tool_calling", "structured_output", "streaming"],
    context_tokens: 272_000,
    locality: "cloud",
    cost_class: 3,
    quality_class: 5,
    latency_class: "medium"
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    capabilities: ["text", "reasoning", "vision", "tool_calling", "streaming"],
    context_tokens: 200_000,
    locality: "cloud",
    cost_class: 4,
    quality_class: 5,
    latency_class: "medium"
  },
  {
    // D-106 GEMINI MODEL MIGRATION (2026-08-23): `model`/`context_tokens`
    // oppdatert til `gemini-3.6-flash` (se `gemini.ts` sin filkommentar for
    // live-bevis/rot-årsak - `gemini-2.5-flash` under utfasing, IKKE en
    // gjettet oppgradering). `context_tokens: 1_048_576` er det EKSAKTE,
    // verifiserte input-token-taket (offisiell spesifikasjon via WebSearch -
    // direkte `WebFetch` mot Google sine egne dokumentasjonsdomener var
    // nettverks-blokkert i denne økten, se D-41-disiplinen i `gemini.ts`).
    // `capabilities` er BEVISST UENDRET: `gemini-3.6-flash` støtter reelt
    // function calling/vision/thinking/caching hos LEVERANDØREN, men
    // `GeminiAdapter` (`gemini.ts`) bruker fortsatt `textOnly()` (ingen
    // bilde-mapping) og har INGEN tool-calling-håndtering wired - samme
    // D-43 §3-regel som resten av denne filen: et capability-flagg
    // reflekterer ALLTID faktisk wiret adapter-støtte, ALDRI et
    // leverandør-faktum alene. `streaming` forblir fjernet (D-80, adapteren
    // har fortsatt aldri hatt `.stream()`).
    provider: "gemini",
    model: "gemini-3.6-flash",
    capabilities: ["text", "reasoning", "structured_output"],
    context_tokens: 1_048_576,
    locality: "cloud",
    cost_class: 2,
    quality_class: 4,
    latency_class: "fast"
  },
  {
    // D-80 (AI Mesh Gemma-first): hostet Gemma via Gemini API - standard
    // rimelig/rask kandidat for ordinære 24/7-oppgaver (§4) NÅR
    // personvernpolicyen tillater det. `hosted_free_tier: true` er den
    // eneste mekanismen som beskytter sensitivt innhold fra gratis-tieret
    // (§3, D-81 P0-fiks: udefinert sensitivitet ekskluderer OGSÅ) - se
    // `router.ts` for hvordan dette faktisk håndheves. `vision` lagt til i
    // D-81 - `gemma.ts` sin `toGemmaParts()` har EKTE bilde-mapping
    // (bekreftet mot Gemini API-dokumentasjon at Gemma 4 støtter
    // bildeforståelse), samme personvern-gate gjelder UENDRET for
    // vision-forespørsler til denne provideren.
    provider: "gemma_hosted",
    model: "gemma-4-26b-a4b-it",
    capabilities: ["text", "reasoning", "vision", "tool_calling", "structured_output", "streaming"],
    context_tokens: 128_000,
    locality: "cloud",
    cost_class: 1,
    quality_class: 4,
    latency_class: "fast",
    hosted_free_tier: true
  },
  {
    // D-80 §6: provider-nøytral lokal-inferens (OpenAI-kompatibelt
    // endepunkt). `quality_class` er en konservativ default inntil en ekte
    // lokal modell er konfigurert og evaluert - IKKE en påstand om en
    // spesifikk modells faktiske kvalitet (kalleren styrer selv hvilken
    // modell som faktisk kjører via `LOCAL_LLM_MODEL`).
    provider: "local_llm",
    model: "local-model",
    // D-404: samme adapterklasse som gemma_local - ekte streaming finnes nå.
    capabilities: ["text", "tool_calling", "structured_output", "streaming"],
    context_tokens: 32_000,
    locality: "local",
    cost_class: 1,
    quality_class: 3,
    latency_class: "medium",
    hosted_free_tier: false
  },
  {
    // D-106 (AI Mesh Council/Collaboration/lokal-Gemma-utvidelse): Gemma kjørt
    // LOKALT (Tobias sin RTX 4070-PC, eller en annen dedikert vertsmaskin) via
    // et OpenAI-kompatibelt endepunkt - SAMME `LocalOpenAiCompatibleAdapter`
    // som `local_llm`, kun registrert under en distinkt provider-identitet
    // (`JARVIS_GEMMA_LOCAL_URL`/`JARVIS_GEMMA_LOCAL_MODEL`) for å gi en
    // nøyaktig capability-/kvalitetsprofil ISTEDENFOR den generiske
    // `local_llm`-profilen. `quality_class=4` gjenspeiler SAMME
    // modellfamilie som `gemma_hosted` (Tobias sin egen modellvalg via
    // `JARVIS_GEMMA_LOCAL_MODEL`, IKKE en oppdiktet leverandørpåstand -
    // D-41). `hosted_free_tier: false` (ALDRI sky-gratis-tier - dette er en
    // helt annen personvern-kategori, D-79 §3: lokal inferens). Tool calling
    // EKTE (samme `LocalOpenAiCompatibleAdapter`-mekanisme som `local_llm`).
    // `context_tokens` konservativ (32k, samme som `local_llm`) inntil en
    // faktisk vertskonfigurasjon er verifisert - ALDRI en oppdiktet stor
    // kontekstpåstand.
    provider: "gemma_local",
    model: "gemma-local",
    // D-404: `LocalOpenAiCompatibleAdapter.stream()` finnes nå (ekte SSE) - uten `streaming` kunne gateway.stream() aldri velge denne profilen.
    capabilities: ["text", "reasoning", "tool_calling", "structured_output", "streaming"],
    context_tokens: 32_000,
    locality: "local",
    cost_class: 1,
    quality_class: 4,
    latency_class: "medium",
    hosted_free_tier: false
  },
  {
    // D-106 PR #53 HOST FIX (live-bevis, 2026-08-23): "kimi-latest" fantes ikke
    // i Moonshot sin modellkatalog (verifisert mot Tobias sin ekte konto OG
    // uavhengig mot Moonshot sin dokumentasjon, se kimi.ts). "kimi-k3" er
    // gjeldende flaggskip med 1M-token kontekst (uendret fra 256k-antakelsen).
    provider: "kimi",
    model: "kimi-k3",
    // D-393 (JARVIS-036): registeret påstår ikke mer enn adapteren kan - å påstå `tool_calling` før adapteren sendte `tools` ga verktøykall som ble stille droppet og jobber merket som
    // vellykkede. WP-D4: `KimiAdapter` har nå OpenAI-kompatible `tools`/`tool_calls` (streng parsing, `invalid_tool_call` ved ugyldig kall) OG ekte SSE-streaming, bevist mot fake server
    // (`packages/provider-adapters/test/kimi-tools.test.ts`) og gjennom en ekte `ModelGateway`-løkke (`modules/model-gateway/test/wpd4-kimi-hermes-tools.test.ts`), så `tool_calling` og
    // `streaming` påstås nå. IKKE live-verifisert mot Moonshot (ingen nøkkel/nettverk i bygg-miljøet) - eieren kjører `mesh-live-smoke.ts --tools`. `structured_output` påstås fortsatt IKKE.
    capabilities: ["text", "reasoning", "tool_calling", "streaming"],
    // M3 (gjennomgang av PR #315): påstått, men ikke live-verifisert - AUTO-ruting hopper over Kimi for verktøyløkker og streaming til eieren har erklært `JARVIS_MESH_TOOLS_VERIFIED=kimi` etter `mesh-live-smoke.ts --tools`.
    live_unverified: ["tool_calling", "streaming"],
    context_tokens: 1_000_000,
    locality: "cloud",
    cost_class: 2,
    quality_class: 4,
    latency_class: "medium"
  },
  {
    // D-360 (Tobias direkte i chat: "hermes" - NousResearch-modellfamilien,
    // ikke Hermes Agent-rammeverket): `"Hermes-4-70B"`, 131 072 tokens
    // kontekst, tool-calling/JSON-modus/schema-adherence - alt WebSearch-
    // verifisert mot Nous sin egen `hermes-agent`-repo-dokumentasjon OG
    // uavhengige tredjeparts-prisoversikter (ingen nettverkstilgang til
    // `inference-api.nousresearch.com` selv i denne sandkassen - samme
    // forbehold som D-106s Gemini-prisoppdatering). `quality_class` konservativ
    // (sammenlignbar med Kimi - ingen ekte sammenlignende evaluering kjørt
    // denne økten) inntil faktisk bruk/evaluering foreligger.
    provider: "hermes",
    model: "Hermes-4-70B",
    // D-393 (JARVIS-036): `HermesAdapter` sendte kun tekst (ingen `tools`, ingen `response_format`) - ærlig registry (D-80): modellen KAN verktøy/JSON, men routeren velger på adapterens evne.
    // WP-D4: adapteren har nå verktøykall via Hermes' eget prompt-protokoll (`<tools>`/`<tool_call>`, streng deterministisk parser, ukjent verktøy/ugyldig JSON ⇒ `invalid_tool_call`;
    // `hermes-tools.ts`), bevist mot fake server (`hermes-tools.test.ts`) og gjennom en ekte `ModelGateway`-løkke, så `tool_calling` påstås. IKKE live-verifisert mot Nous' API.
    // `streaming` påstås BEVISST ikke (taggene måtte filtreres ut av en løpende strøm - ikke bygget) og `structured_output` heller ikke (ingen `response_format` i adapteren).
    capabilities: ["text", "reasoning", "tool_calling"],
    // M3 (gjennomgang av PR #315): påstått, men ikke live-verifisert - AUTO-ruting hopper over Hermes for verktøyløkker til eieren har erklært `JARVIS_MESH_TOOLS_VERIFIED=hermes` etter `mesh-live-smoke.ts --tools`.
    live_unverified: ["tool_calling"],
    context_tokens: 131_072,
    locality: "cloud",
    cost_class: 1,
    quality_class: 4,
    latency_class: "medium"
  },
  {
    provider: "ollama",
    model: "llama3.1",
    capabilities: ["text", "structured_output"],
    context_tokens: 128_000,
    locality: "local",
    cost_class: 1,
    quality_class: 2,
    latency_class: "medium"
  },
  {
    // Deterministisk testprovider - generisk tekstprofil så eksisterende
    // oppsett uten registry-endringer fortsetter å fungere. P1A: streamer og
    // skripter tool calls deterministisk (matcher ScriptedAdapter).
    provider: "scripted",
    model: "scripted-1",
    capabilities: ["text", "structured_output", "reasoning", "streaming", "tool_calling"],
    context_tokens: 32_000,
    locality: "local",
    cost_class: 1,
    quality_class: 1,
    latency_class: "fast"
  }
];

/**
 * WP-G3 (D-465): lokal visjonsmodell for kamerabilder (UA-9). SAMME `LocalOpenAiCompatibleAdapter` som `local_llm`, registrert under en egen identitet med `{ vision: true }` - kun når
 * `JARVIS_VISION_ENABLED=on` og `JARVIS_VISION_CLASSIFIER=on` og `JARVIS_VISION_LOCAL_URL` er satt (se apps/api/src/main.ts).
 *
 * Profilen står BEVISST IKKE i `DEFAULT_PROFILES` (review A-L3): den legges til registeret kun når adapteren registreres (`new CapabilityRegistry([...DEFAULT_PROFILES, LOCAL_VISION_PROFILE])`), slik at et
 * system med alle `JARVIS_VISION_*` AV er identisk med main - ingen ny post i begrensningsregisteret (self-model), ingen nytt navn i `knownModelProviders()`. Uten profilen regnes en leverandør
 * som heter `local_vision` som sky (`profileOrGeneric`, fail-closed): et register uten denne profilen kan aldri gi en kamerabilde-kandidat.
 *
 * `capabilities` er BEVISST kun det som er wiret og testet mot en fake server: `text` + `vision`. Ingen `structured_output`/`tool_calling`/`streaming` (uverifisert for visjonsmodeller; klassifisereren
 * ber om JSON i prompten og parser selv, streng). `quality_class`/`context_tokens` er konservative standarder inntil en ekte modell er konfigurert og evaluert (modellen velges av eieren via
 * `JARVIS_VISION_LOCAL_MODEL`, ikke påstått her). `locality: "local"`: kamerabilder forlater aldri maskinen.
 */
export const LOCAL_VISION_PROFILE: ModelProfile = {
  provider: "local_vision",
  model: "local-vision-model",
  capabilities: ["text", "vision"],
  context_tokens: 16_000,
  locality: "local",
  cost_class: 1,
  quality_class: 2,
  latency_class: "slow",
  hosted_free_tier: false,
  dedicated_to: "vision"
};

/** Profilene for et system der den lokale visjonsmodellen ER registrert (eneste sted `LOCAL_VISION_PROFILE` hører hjemme sammen med standardlisten). */
export const PROFILES_WITH_LOCAL_VISION: ModelProfile[] = [...DEFAULT_PROFILES, LOCAL_VISION_PROFILE];

export class CapabilityRegistry {
  private readonly byProvider = new Map<string, ModelProfile>();

  constructor(profiles: ModelProfile[] = DEFAULT_PROFILES) {
    for (const p of profiles) {
      this.byProvider.set(p.provider, p);
    }
  }

  get(provider: string): ModelProfile | undefined {
    return this.byProvider.get(provider);
  }

  list(): ModelProfile[] {
    return [...this.byProvider.values()];
  }

  /** Ukjent provider behandles som generisk tekstmodell (bakoverkompatibelt). */
  profileOrGeneric(provider: string, model: string): ModelProfile {
    return (
      this.byProvider.get(provider) ?? {
        provider,
        model,
        capabilities: ["text"],
        context_tokens: 32_000,
        locality: "cloud",
        cost_class: 3,
        quality_class: 3,
        latency_class: "medium"
      }
    );
  }
}
