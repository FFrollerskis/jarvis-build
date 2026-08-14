import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnMetrics } from "./session.ts";
import type { SttAdapter } from "./stt.ts";

/**
 * BO-12 §19/§38-§39: aggregering av hele latenskjeden over voice-turer.
 * Hovedmålet er end_of_speech_to_first_audio_ms (P50 + P95 når nok samples).
 * Tall rapporteres som målt - aldri som mål vi "tror" vi når.
 */
export interface LatencySummary {
  turns: number;
  end_of_speech_to_first_audio_p50_ms?: number;
  end_of_speech_to_first_audio_p95_ms?: number;
  model_first_token_p50_ms?: number;
  tts_first_frame_p50_ms?: number;
}

export function summarizeLatency(turns: TurnMetrics[]): LatencySummary {
  const pct = (values: number[], q: number): number | undefined => {
    if (values.length === 0) {
      return undefined;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  };
  const e2e = turns
    .map((t) => t.end_of_speech_to_first_audio_ms)
    .filter((v): v is number => v !== undefined);
  const model = turns
    .filter((t) => t.t_model_first_token !== undefined && t.t_end_of_turn !== undefined)
    .map((t) => (t.t_model_first_token as number) - (t.t_end_of_turn as number));
  const tts = turns
    .filter((t) => t.t_tts_first_frame !== undefined && t.t_first_tts_request !== undefined)
    .map((t) => (t.t_tts_first_frame as number) - (t.t_first_tts_request as number));
  const e2eP50 = pct(e2e, 0.5);
  const e2eP95 = pct(e2e, 0.95);
  const modelP50 = pct(model, 0.5);
  const ttsP50 = pct(tts, 0.5);
  return {
    turns: turns.length,
    ...(e2eP50 !== undefined ? { end_of_speech_to_first_audio_p50_ms: e2eP50 } : {}),
    // P95 rapporteres kun med nok samples (≥20) - aldri fake presisjon (§39).
    ...(e2e.length >= 20 && e2eP95 !== undefined ? { end_of_speech_to_first_audio_p95_ms: e2eP95 } : {}),
    ...(modelP50 !== undefined ? { model_first_token_p50_ms: modelP50 } : {}),
    ...(ttsP50 !== undefined ? { tts_first_frame_p50_ms: ttsP50 } : {})
  };
}

/**
 * Norsk STT-benchmark-harness (D-10-porten): kjøres når ≥100 norske lydprøver
 * og provider-nøkler finnes. Manifestformat (JSON):
 *   { "samples": [{ "audio": "sti/til.wav", "reference": "fasit-tekst",
 *                   "category": "tall|navn|adresse|dialekt|generell" }] }
 * Output: WER + latens-P50/P95 per adapter og kategori. Se docs/VOICE_BENCHMARK.md.
 */
export interface BenchmarkSample {
  audio: string;
  reference: string;
  category: string;
}

export interface BenchmarkResult {
  adapter: string;
  samples: number;
  wer: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  per_category: Record<string, { samples: number; wer: number }>;
}

/** Ordfeilrate via Levenshtein på ordnivå (standard WER). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalize(reference);
  const hyp = normalize(hypothesis);
  if (ref.length === 0) {
    return hyp.length === 0 ? 0 : 1;
  }
  const dp: number[][] = Array.from({ length: ref.length + 1 }, (_, i) =>
    Array.from({ length: hyp.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[ref.length]![hyp.length]! / ref.length;
}

function normalize(text: string): string[] {
  return text.toLowerCase().replace(/[^\wæøå0-9 ]/g, "").split(/\s+/).filter(Boolean);
}

export async function runBenchmark(
  adapter: SttAdapter,
  manifestPath: string,
  transcribe: (adapter: SttAdapter, wavPath: string) => Promise<string>
): Promise<BenchmarkResult> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { samples: BenchmarkSample[] };
  if (manifest.samples.length < 100) {
    throw new Error(`benchmark_requires_min_100_samples: fant ${manifest.samples.length}`);
  }
  const latencies: number[] = [];
  const perCategory = new Map<string, { samples: number; werSum: number }>();
  let werSum = 0;
  const baseDir = join(manifestPath, "..");
  for (const sample of manifest.samples) {
    const started = performance.now();
    const hypothesis = await transcribe(adapter, join(baseDir, sample.audio));
    latencies.push(performance.now() - started);
    const wer = wordErrorRate(sample.reference, hypothesis);
    werSum += wer;
    const cat = perCategory.get(sample.category) ?? { samples: 0, werSum: 0 };
    cat.samples += 1;
    cat.werSum += wer;
    perCategory.set(sample.category, cat);
  }
  latencies.sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;
  return {
    adapter: adapter.name,
    samples: manifest.samples.length,
    wer: werSum / manifest.samples.length,
    latency_p50_ms: p(0.5),
    latency_p95_ms: p(0.95),
    per_category: Object.fromEntries(
      [...perCategory].map(([k, v]) => [k, { samples: v.samples, wer: v.werSum / v.samples }])
    )
  };
}
