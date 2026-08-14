/**
 * SpeechAdapter (STT): streaming-kontrakt bak adapter - ingen leverandørkode
 * utenfor denne filen. Valg av leverandør skjer i stop/go-porten etter norsk
 * benchmark (D-10); arkitekturen låses ikke til én leverandør.
 */
export interface SttStream {
  pushAudio(frame: Buffer): void;
  /** Kalles ved end-of-turn; resolver med endelig transkript. */
  end(): Promise<string>;
  onPartial(cb: (text: string) => void): void;
}

export interface SttAdapter {
  readonly name: string;
  available(): boolean;
  startStream(): SttStream;
}

/**
 * Deterministisk testadapter: testklienten koder tekst inn i lydrammer med
 * "TXT:"-prefiks. Rammene går gjennom hele den reelle kjeden (WS → filtre →
 * VAD → STT) slik at timing og tilstandsmaskin testes ekte.
 */
export class MarkerStt implements SttAdapter {
  readonly name = "marker-test";
  constructor(private readonly partialDelayMs = 40) {}

  available(): boolean {
    return true;
  }

  startStream(): SttStream {
    let text = "";
    let partialCb: ((t: string) => void) | undefined;
    let partialSent = false;
    const delay = this.partialDelayMs;
    return {
      pushAudio(frame: Buffer): void {
        const idx = frame.indexOf("TXT:");
        if (idx >= 0) {
          const end = frame.indexOf(0, idx);
          text += frame.subarray(idx + 4, end > idx ? end : undefined).toString("utf8");
          if (!partialSent && partialCb) {
            partialSent = true;
            const cb = partialCb;
            const partial = text;
            setTimeout(() => cb(partial), delay);
          }
        }
      },
      async end(): Promise<string> {
        return text.trim();
      },
      onPartial(cb): void {
        partialCb = cb;
      }
    };
  }
}

/**
 * OpenAI STT (batch transcriptions-API; streaming-STT vurderes i benchmark).
 * UVERIFISERT uten reell nøkkel - kandidat for norsk benchmark, ikke et valg.
 */
export class OpenAiStt implements SttAdapter {
  readonly name = "openai-stt";
  constructor(
    private readonly apiKey: string | undefined = process.env["OPENAI_API_KEY"],
    private readonly model: string = "whisper-1",
    /** PCM-samplerate for wav-innpakking (mikrofon 16k; OpenAI TTS-rundtur 24k). */
    private readonly sampleRate: number = 16000
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  startStream(): SttStream {
    if (!this.apiKey) {
      throw new Error("openai_stt_not_configured");
    }
    const chunks: Buffer[] = [];
    const { apiKey, model, sampleRate } = this;
    return {
      pushAudio(frame: Buffer): void {
        chunks.push(frame);
      },
      async end(): Promise<string> {
        const wav = pcm16ToWav(Buffer.concat(chunks), sampleRate);
        const form = new FormData();
        form.set("model", model);
        form.set("language", "no");
        form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
        const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body: form
        });
        if (!response.ok) {
          throw new Error(`openai_stt_error_${response.status}`);
        }
        return ((await response.json()) as { text: string }).text;
      },
      onPartial(): void {
        // Batch-API gir ikke partials; streaming-kandidater vurderes i benchmark.
      }
    };
  }
}

/**
 * Lokal STT via whisper.cpp-binær (JARVIS_WHISPER_BIN + JARVIS_WHISPER_MODEL).
 * Lokal kandidat (D-23/D-10) - UVERIFISERT til binær/modell er installert.
 */
export class LocalWhisperStt implements SttAdapter {
  readonly name = "local-whisper";
  constructor(private readonly binPath: string | undefined = process.env["JARVIS_WHISPER_BIN"]) {}

  available(): boolean {
    return Boolean(this.binPath);
  }

  startStream(): SttStream {
    throw new Error("local_whisper_not_implemented_in_pilot: kjøres via benchmark-harnesset");
  }
}

export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
