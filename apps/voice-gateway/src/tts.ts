/**
 * SpeechAdapter (TTS): streaming-kontrakt med kansellering (barge-in-krav).
 * cancel() SKAL stoppe produksjonen umiddelbart - avbrutt tale logges som
 * ikke levert av sesjonsmotoren.
 */
export interface TtsPlayback {
  /** Async-strøm av lydrammer; avsluttes ved ferdig eller kansellering. */
  frames: AsyncIterable<Buffer>;
  cancel(): void;
}

export interface TtsAdapter {
  readonly name: string;
  available(): boolean;
  synthesize(text: string): TtsPlayback;
}

/**
 * Deterministisk testadapter: produserer 20 ms-rammer i sanntidstakt slik at
 * barge-in kan MÅLES reelt (kanselleringstidspunkt mot rammestrøm).
 */
export class FakeTts implements TtsAdapter {
  readonly name = "fake-tts";
  constructor(private readonly msPerChar = 40) {}

  available(): boolean {
    return true;
  }

  synthesize(text: string): TtsPlayback {
    const totalMs = Math.max(200, text.length * this.msPerChar);
    const frameCount = Math.ceil(totalMs / 20);
    let cancelled = false;
    async function* generate(): AsyncIterable<Buffer> {
      for (let i = 0; i < frameCount; i++) {
        if (cancelled) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (cancelled) {
          return;
        }
        const frame = Buffer.alloc(640); // 20ms @16kHz PCM16
        frame.fill(i % 120);
        yield frame;
      }
    }
    return {
      frames: generate(),
      cancel(): void {
        cancelled = true;
      }
    };
  }
}

/** OpenAI TTS (batch; streaming-kandidater vurderes i benchmark). UVERIFISERT uten nøkkel. */
export class OpenAiTts implements TtsAdapter {
  readonly name = "openai-tts";
  constructor(
    private readonly apiKey: string | undefined = process.env["OPENAI_API_KEY"],
    private readonly model: string = "gpt-4o-mini-tts",
    private readonly voice: string = "alloy"
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  synthesize(text: string): TtsPlayback {
    if (!this.apiKey) {
      throw new Error("openai_tts_not_configured");
    }
    const { apiKey, model, voice } = this;
    let cancelled = false;
    async function* generate(): AsyncIterable<Buffer> {
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, voice, input: text, response_format: "pcm" })
      });
      if (!response.ok || !response.body) {
        throw new Error(`openai_tts_error_${response.status}`);
      }
      const reader = response.body.getReader();
      for (;;) {
        if (cancelled) {
          await reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        yield Buffer.from(value);
      }
    }
    return { frames: generate(), cancel: () => (cancelled = true) };
  }
}

/** Lokal TTS via piper-binær (JARVIS_PIPER_BIN). Lokal kandidat - UVERIFISERT til installert. */
export class LocalPiperTts implements TtsAdapter {
  readonly name = "local-piper";
  constructor(private readonly binPath: string | undefined = process.env["JARVIS_PIPER_BIN"]) {}

  available(): boolean {
    return Boolean(this.binPath);
  }

  synthesize(_text: string): TtsPlayback {
    throw new Error("local_piper_not_implemented_in_pilot: kjøres via benchmark-harnesset");
  }
}
