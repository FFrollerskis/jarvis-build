/**
 * Embeddings bak adapter: ingen leverandørlåsing i domenelogikken.
 *
 * D-386 (Minne v2): minnets vektorrom er ÉN modell av gangen, og den MÅ være lokal (`locality: "local"`). Begrunnelse:
 * helse-/finans-/`special`-minne skal aldri til en skytjeneste (D-376/D-378, MEMORY_ARCHITECTURE §4), og vektorer fra
 * ulike modeller kan aldri sammenlignes - en «sky for vanlig, lokal for sensitivt»-splitt ville gitt to usammenlignbare
 * rom og et søk som måtte gjettet hvilket. Derfor: `assertLocalEmbedding()` ved oppstart (fail closed), og
 * `OpenAiEmbedding` er beholdt som adapter men er AVVIST for minne (JARVIS-060 lukkes som REJECTED, ikke «unwired»).
 *
 * `LocalHashEmbedding` er deterministisk tegn-trigram-hashing (64 dim) - den har INGEN semantikk (bevist i D-386 sin
 * gjennomgang: «hva heter hunden min» treffer ikke «Tobias har en hund som heter Rex») og er kun fallback når ingen
 * lokal modell er konfigurert. `OllamaEmbedding` (f.eks. `bge-m3`, 1024 dim, flerspråklig inkl. norsk) er den
 * anbefalte produksjonsproviderens; `memory_vectors` er modellbevisst og `runMemoryReembedSweep` fyller etter.
 */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  /** D-386: `local` = kjører på eierens utstyr/NAS/PC (Ollama o.l.). Minnet godtar KUN `local`. */
  readonly locality: "local" | "cloud";
  /**
   * Laveste cosinus-likhet som regnes som et reelt treff i vektorleggen. Hash-embedding kolliderer tilfeldig (~3 %
   * over 0,6), så den må være streng; en ekte semantisk modell kan gå lavere.
   */
  readonly minSimilarity: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export class EmbeddingLocalityError extends Error {
  constructor(provider: EmbeddingProvider) {
    super(`memory_embedding_must_be_local: ${provider.model} er ${provider.locality}`);
  }
}

/** Fail closed: minnet (writer/retriever/sweep) nekter å starte med en sky-embedding. */
export function assertLocalEmbedding(provider: EmbeddingProvider): void {
  if (provider.locality !== "local") throw new EmbeddingLocalityError(provider);
}

/** Deterministisk feature-hashing med tegn-trigrammer. Ingen nettverk, ingen semantikk - kun fallback. */
export class LocalHashEmbedding implements EmbeddingProvider {
  readonly model = "local-hash-v1";
  readonly locality = "local" as const;
  readonly minSimilarity = 0.6;
  constructor(readonly dim: number = 64) {}

  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dim).fill(0);
    const normalized = text.toLowerCase().replace(/[^a-zæøå0-9 ]/g, " ");
    for (let i = 0; i < normalized.length - 2; i++) {
      const gram = normalized.slice(i, i + 3);
      let h = 2166136261;
      for (let j = 0; j < gram.length; j++) {
        h = Math.imul(h ^ gram.charCodeAt(j), 16777619);
      }
      const idx = Math.abs(h) % this.dim;
      v[idx] = (v[idx] ?? 0) + ((h >>> 1) % 2 === 0 ? 1 : -1);
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/** Kjente Ollama-embeddingmodeller og dimensjonen de leverer (overstyres av `JARVIS_EMBEDDING_DIM`). */
export const KNOWN_EMBEDDING_DIMS: Readonly<Record<string, number>> = {
  "bge-m3": 1024,
  "multilingual-e5-large": 1024,
  "snowflake-arctic-embed2": 1024,
  "qwen3-embedding": 1024,
  "nomic-embed-text": 768,
  "embeddinggemma": 768
};

const DEFAULT_OLLAMA_EMBEDDING_MODEL = "bge-m3";
const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;
const MAX_EMBED_CHARS = 6000;

/** Root-URL uten avsluttende `/` og uten `/v1` (samme konvensjon som `normalizeLocalLlmBaseUrl` i provider-adapters). */
export function normalizeEmbeddingBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export class EmbeddingDimensionMismatchError extends Error {
  constructor(model: string, expected: number, actual: number) {
    super(`memory_embedding_dim_mismatch: ${model} forventet ${expected}, fikk ${actual} - sett JARVIS_EMBEDDING_DIM`);
  }
}

/**
 * Lokal semantisk embedding via Ollamas native `/api/embed` (batch-støtte, `truncate: true`). Ren HTTP-klient -
 * ingen SDK, ingen hardkodet host (URL MÅ settes), ingen antakelse om samme maskin som Jarvis (PC via Tailscale,
 * NAS, dedikert GPU-vert - alle er «lokale» i D-376-forstand: eierens eget utstyr).
 */
export class OllamaEmbedding implements EmbeddingProvider {
  readonly locality = "local" as const;
  readonly minSimilarity: number;
  readonly dim: number;
  private readonly embedUrl: string;

  constructor(
    baseUrl: string,
    readonly model: string = DEFAULT_OLLAMA_EMBEDDING_MODEL,
    options: { dim?: number; timeoutMs?: number; minSimilarity?: number } = {}
  ) {
    const base = model.replace(/:.*$/, "");
    const dim = options.dim ?? KNOWN_EMBEDDING_DIMS[base];
    if (!dim) throw new Error(`memory_embedding_dim_unknown: ${model} - sett JARVIS_EMBEDDING_DIM`);
    this.dim = dim;
    this.embedUrl = `${normalizeEmbeddingBaseUrl(baseUrl)}/api/embed`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
    this.minSimilarity = options.minSimilarity ?? 0.35;
  }
  private readonly timeoutMs: number;

  async embed(text: string): Promise<number[]> {
    const [v] = await this.embedBatch([text]);
    if (!v) throw new Error("memory_embedding_empty_response");
    return v;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const input = texts.map((t) => t.slice(0, MAX_EMBED_CHARS));
    let response: Response;
    try {
      response = await fetch(this.embedUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({ model: this.model, input, truncate: true })
      });
    } catch (err) {
      throw new Error(`memory_embedding_unreachable: ${(err as Error).message}`);
    }
    if (!response.ok) throw new Error(`memory_embedding_http_${response.status}`);
    const body = (await response.json()) as { embeddings?: number[][] };
    const out = body.embeddings;
    if (!Array.isArray(out) || out.length !== input.length) throw new Error("memory_embedding_invalid_response");
    for (const v of out) {
      if (v.length !== this.dim) throw new EmbeddingDimensionMismatchError(this.model, this.dim, v.length);
    }
    return out;
  }
}

/**
 * OpenAI embeddings-adapter. D-386: AVVIST for minne (sky; helse-/finansminne må aldri dit, og ett vektorrom må være
 * lokalt). Beholdt kun som referanseadapter for ikke-minne-formål; `assertLocalEmbedding()` stopper den ved oppstart.
 */
export class OpenAiEmbedding implements EmbeddingProvider {
  readonly model: string;
  readonly dim = 1536;
  readonly locality = "cloud" as const;
  readonly minSimilarity = 0.35;

  constructor(
    private readonly apiKey: string | undefined = process.env["OPENAI_API_KEY"],
    model: string = "text-embedding-3-small"
  ) {
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error("openai_embedding_not_configured");
    }
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: text })
    });
    if (!response.ok) {
      throw new Error(`openai_embedding_error_${response.status}`);
    }
    const body = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return body.data[0]?.embedding ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

export interface EmbeddingEnv {
  JARVIS_EMBEDDING_PROVIDER?: string | undefined;
  JARVIS_EMBEDDING_URL?: string | undefined;
  JARVIS_EMBEDDING_MODEL?: string | undefined;
  JARVIS_EMBEDDING_DIM?: string | undefined;
  JARVIS_OLLAMA_URL?: string | undefined;
  JARVIS_GEMMA_LOCAL_URL?: string | undefined;
}

/**
 * Endepunktet embedding-provideren faktisk snakker med (WP-G3, review A-INFO-4): `null` når valget er `LocalHashEmbedding` (ingen nettverk) eller URL-en mangler. Én kilde for URL-valget:
 * `createEmbeddingProviderFromEnv` bruker denne selv, og UA-9 (vision-runtime) validerer den som privat/lokal når kamerafunksjonen er på.
 */
export function embeddingEndpointFromEnv(env: EmbeddingEnv = process.env as EmbeddingEnv): string | null {
  const provider = (env.JARVIS_EMBEDDING_PROVIDER ?? "").trim().toLowerCase();
  const model = (env.JARVIS_EMBEDDING_MODEL ?? "").trim();
  if (!(provider === "ollama" || (provider === "" && model !== ""))) return null;
  const url = (env.JARVIS_EMBEDDING_URL || env.JARVIS_OLLAMA_URL || env.JARVIS_GEMMA_LOCAL_URL || "").trim();
  return url === "" ? null : url;
}

/**
 * Én faktory for api OG worker (D-386: samme provider-instansvalg begge steder, aldri to uavhengige konstruksjoner).
 * - `JARVIS_EMBEDDING_PROVIDER=ollama` (eller satt `JARVIS_EMBEDDING_MODEL`) => `OllamaEmbedding` mot
 *   `JARVIS_EMBEDDING_URL` → `JARVIS_OLLAMA_URL` → `JARVIS_GEMMA_LOCAL_URL` (root, `/v1` strippes).
 * - ellers `LocalHashEmbedding` (fallback uten semantikk - logges som advarsel av kalleren).
 * Resultatet er ALLTID lokalt; faktoryen kan ikke returnere en sky-provider.
 */
export function createEmbeddingProviderFromEnv(env: EmbeddingEnv = process.env as EmbeddingEnv): EmbeddingProvider {
  const provider = (env.JARVIS_EMBEDDING_PROVIDER ?? "").trim().toLowerCase();
  const model = (env.JARVIS_EMBEDDING_MODEL ?? "").trim();
  const wantsOllama = provider === "ollama" || (provider === "" && model !== "");
  if (!wantsOllama) {
    if (provider !== "" && provider !== "local-hash") {
      throw new Error(`memory_embedding_provider_unknown: ${provider} (gyldig: ollama, local-hash)`);
    }
    return new LocalHashEmbedding();
  }
  const url = embeddingEndpointFromEnv(env) ?? "";
  if (!url) throw new Error("memory_embedding_url_missing: sett JARVIS_EMBEDDING_URL (eller JARVIS_OLLAMA_URL/JARVIS_GEMMA_LOCAL_URL)");
  const dimRaw = (env.JARVIS_EMBEDDING_DIM ?? "").trim();
  const dim = dimRaw === "" ? undefined : Number.parseInt(dimRaw, 10);
  if (dimRaw !== "" && (!Number.isInteger(dim) || (dim as number) <= 0)) throw new Error("memory_embedding_dim_invalid");
  return new OllamaEmbedding(url, model || DEFAULT_OLLAMA_EMBEDDING_MODEL, dim ? { dim } : {});
}
