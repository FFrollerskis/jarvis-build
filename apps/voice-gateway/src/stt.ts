import { spawn } from "node:child_process";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";

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
  /**
   * D-122: erklæringen rutingsporten (`evaluateSpeechRouting`) dømmer på.
   * PÅKREVD - en ny STT-leverandør kan ikke legges til uten å ta stilling til
   * lokalitet og matriserad (`docs/security/PROCESSOR_REGION_MATRIX.md`).
   */
  readonly processor: SpeechProcessorDeclaration;
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
  /** Ren testadapter i prosessen - ingen lyd forlater maskinen. */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "marker-test",
    locality: "local",
    processor_row_declared: true,
    processor_terms_status: "NOT_APPLICABLE_LOCAL"
  };
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
  /**
   * EKSTERN databehandler: rå lyd (wav) sendes til OpenAI. Raden er NAVNGITT i
   * `PROCESSOR_REGION_MATRIX.md` (regel 1 oppfylt). Region (EU)/
   * databehandleravtale (godkjent)/treningsvilkår (nei, org-nivå-deling
   * deaktivert)/retensjon (inntil 30 dager, deretter slettet, ZDR
   * tilgjengelig for kvalifiserte) er nå faktisk BEKREFTET av Tobias sin egen
   * konto-gjennomgang (D-226, 2026-09-22) - regel 3 er derfor OPPFYLT og
   * `evaluateSpeechRouting()` slipper nå denne behandleren gjennom (fortsatt
   * betinget av `memory_space_authority: "SERVER_VERIFIED"`, se D-123).
   * Verdien endres KUN sammen med matriseraden - se PROCESSOR_REGION_MATRIX.md.
   */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "openai-audio-transcriptions",
    locality: "external",
    processor_row_declared: true,
    processor_terms_status: "VERIFIED"
  };
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
 * Task #125 (D-217): lokal STT via whisper.cpp-binæren i `JARVIS_WHISPER_BIN`
 * (full sti til den installerte kjørbare filen - navnet varierer mellom
 * whisper.cpp-versjoner, f.eks. `main`/`whisper-cli`, derfor ALDRI hardkodet
 * her) + modellfilen i `JARVIS_WHISPER_MODEL` (`-m`-flagget whisper.cpp
 * krever). SAMME "batch, ingen ekte partials"-disiplin som `OpenAiStt` over -
 * whisper.cpp sin vanlige CLI transkriberer HELE lydfilen på én gang, den har
 * INGEN inkrementell strømmemodus for dette buffer-og-transkriber-mønsteret
 * (VAD-en avgjør allerede turgrensene FØR STT-en i det hele tatt kalles) -
 * `onPartial()` er derfor bevisst en no-op, EKSAKT samme, allerede etablerte
 * ærlighetsdisiplin som `OpenAiStt` sin egen kommentar ("Batch-API gir ikke
 * partials").
 *
 * §22-INVARIANT (`test/d30-foundation.test.ts` "Personvern: rå lyd
 * persisteres aldri"): denne filen forbys STATISK å inneholde NOEN
 * disk-skrive-API fra `node:fs` (fil-skriving/vedlegging/skrivestrøm-
 * konstruktøren) - rå lyd skal ALDRI treffe disk, ikke engang midlertidig.
 * whisper.cpp sin vanlige CLI krever normalt en fil via `-f`, men `end()`
 * under sender i stedet WAV-bytene DIREKTE på prosessens STDIN og kaller
 * den med `-f -` (Unix-konvensjonen for "les fra stdin") - lyden forlater
 * derfor prosessminnet KUN via et pipe til den lokale binæren, ALDRI via
 * filsystemet.
 *
 * UNVERIFIED (D-41-disiplin, eksplisitt disclosed, ikke stille antatt): BÅDE
 * de eksakte CLI-flaggene (`-m`/`-f`/`-nt`/`-l`) OG antagelsen om at
 * whisper.cpp faktisk støtter `-f -` for stdin, er whisper.cpp sin
 * LANGVARIG DOKUMENTERTE, mest utbredte konvensjon, men ALDRI kjørt mot en
 * ekte installert binær i denne økten (Q-32 punkt 3 - Tobias har ikke
 * installert whisper.cpp ennå) - dersom den installerte binæren IKKE støtter
 * `-f -`, feiler `end()` synlig (`local_whisper_process_failed`), ALDRI en
 * stille disk-skriving som fallback. Selve subprosess-/stdin-/
 * feilhåndteringskoden ER testet, mot en faket binær (se
 * `test/local-whisper-stt.test.ts`).
 */
export class LocalWhisperStt implements SttAdapter {
  readonly name = "local-whisper";
  /** Lokal binær - rå lyd forlater aldri maskinen (D-23-kandidaten for `health`). */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "local-whisper-cpp",
    locality: "local",
    processor_row_declared: true,
    processor_terms_status: "NOT_APPLICABLE_LOCAL"
  };
  constructor(
    private readonly binPath: string | undefined = process.env["JARVIS_WHISPER_BIN"],
    private readonly modelPath: string | undefined = process.env["JARVIS_WHISPER_MODEL"],
    /** PCM-samplerate for wav-innpakking - SAMME 16 kHz-forventning som resten av piloten (`pcm16ToWav`/`docs/VOICE_BENCHMARK.md`). */
    private readonly sampleRate: number = 16000,
    /** whisper.cpp sitt `-l`-språkflagg - default norsk, SAMME som `OpenAiStt`. */
    private readonly language: string = process.env["JARVIS_WHISPER_LANG"] ?? "no"
  ) {}

  /** Modellen er like påkrevd som binæren - whisper.cpp kan strukturelt ikke kjøre uten `-m`. */
  available(): boolean {
    return Boolean(this.binPath) && Boolean(this.modelPath);
  }

  startStream(): SttStream {
    if (!this.binPath || !this.modelPath) {
      throw new Error("local_whisper_not_configured");
    }
    const { binPath, modelPath, sampleRate, language } = this;
    const chunks: Buffer[] = [];
    return {
      pushAudio(frame: Buffer): void {
        chunks.push(frame);
      },
      async end(): Promise<string> {
        const wav = pcm16ToWav(Buffer.concat(chunks), sampleRate);
        const proc = spawn(binPath, ["-m", modelPath, "-f", "-", "-nt", "-l", language], {
          stdio: ["pipe", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        let stdinError: Error | null = null;
        proc.stdout.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        proc.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
        // D-256: hvis binæren avslutter (eller lukker sin egen stdin) FØR vi er
        // ferdige med å skrive, feiler `.end(wav)` under med EPIPE. `proc`s
        // EGET "error"-event (håndtert i exitCode-løftet under) dekker KUN
        // spawn-feil på selve prosessen, ALDRI en skrivefeil på understrømmen
        // `proc.stdin` - uten en egen lytter her er det en UHÅNDTERT
        // "error"-hendelse, og Node kaster/krasjer HELE prosessen (funnet
        // live på NAS-en: "den bare lukker seg" - containeren restartet på
        // hver eneste taleytring). Lagre feilen i stedet, la `close`-eventet
        // (som fortsatt fyres uansett) avgjøre utfallet som normalt.
        proc.stdin.on("error", (err: Error) => {
          stdinError = err;
        });
        const exitCode = new Promise<number | null>((resolve, reject) => {
          proc.once("error", reject);
          proc.once("close", resolve);
        });
        proc.stdin.end(wav);
        let code: number | null;
        try {
          code = await exitCode;
        } catch (err) {
          throw new Error(`local_whisper_spawn_failed:${(err as Error).message.slice(0, 200)}`);
        }
        if (code !== 0) {
          const detail = stdinError
            ? `${stderr.slice(0, 150)} (stdin write: ${(stdinError as Error).message})`
            : stderr.slice(0, 200);
          throw new Error(`local_whisper_process_failed:${code ?? "unknown"}:${detail}`);
        }
        const text = stdout.trim();
        // D-263 (Tobias direkte i chat, live NAS-test MED D-262 sin nye logging
        // aktiv): HVER eneste tur, inkludert én med 2+ sekunder sammenhengende
        // tale-energi, ga `voice_stt_result` med `text_length: 0` - ALDRI
        // `voice_core_reply_sent`. whisper-cli avsluttet med kode 0 (INGEN
        // `local_whisper_process_failed`) - prosessen kjørte altså "vellykket",
        // den bare fant ingenting å transkribere. `stderr` (whisper.cpp sin
        // EGEN diagnostikk - modell-/decode-/"no speech"-info, ALDRI selve
        // transkripsjonen, som kun skrives til stdout) ble FØR denne fiksen
        // fanget opp, men stille kastet bort på nøyaktig denne (suksess+tomt
        // resultat) stien - samme "en feil/et signal svelges stille"-mønster
        // som D-254/D-261/D-262, nå ett lag dypere inne i selve STT-adapteren.
        // KUN logget når resultatet faktisk er tomt (aldri når en transkripsjon
        // finnes) - unngår enhver risiko for at whisper.cpp sin verbose stderr
        // skulle inneholde delvis gjenkjent tale, samme personvern-disiplin
        // som §22 andre steder i filen.
        if (!text) {
          console.error(
            JSON.stringify({
              msg: "voice_stt_empty_result_diagnostic",
              wav_bytes: wav.length,
              stderr_excerpt: stderr.slice(0, 300)
            })
          );
        }
        return text;
      },
      onPartial(): void {
        // whisper.cpp sin batch-CLI gir ingen inkrementelle partials - se klassekommentaren.
      }
    };
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
