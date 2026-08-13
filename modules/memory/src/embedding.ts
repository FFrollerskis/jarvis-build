/**
 * Embeddings bak adapter: ingen leverandørlåsing i domenelogikken.
 * LocalHashEmbedding er deterministisk og lokal (dev/test/fallback);
 * eksterne modeller kobles til via samme grensesnitt når nøkler finnes.
 */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

/** Deterministisk feature-hashing med tegn-trigrammer. Ingen nettverk. */
export class LocalHashEmbedding implements EmbeddingProvider {
  readonly model = "local-hash-v1";
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
}

/** OpenAI embeddings-adapter (uverifisert uten reell nøkkel; samme kontrakt). */
export class OpenAiEmbedding implements EmbeddingProvider {
  readonly model: string;
  readonly dim = 1536;

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
}
