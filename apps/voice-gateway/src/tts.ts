import { spawn } from "node:child_process";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";

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
  /**
   * D-122: samme erklæring som `SttAdapter.processor`. TTS er tatt med fordi
   * SVAR-teksten fra en `health`-samtale er like avslørende som spørsmålet -
   * å beskytte kun STT ville lekket halve samtalen.
   */
  readonly processor: SpeechProcessorDeclaration;
  available(): boolean;
  synthesize(text: string): TtsPlayback;
}

/**
 * Deterministisk testadapter: produserer 20 ms-rammer i sanntidstakt slik at
 * barge-in kan MÅLES reelt (kanselleringstidspunkt mot rammestrøm).
 */
export class FakeTts implements TtsAdapter {
  readonly name = "fake-tts";
  /** Ren testadapter i prosessen - ingen tekst/lyd forlater maskinen. */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "fake-tts",
    locality: "local",
    processor_row_declared: true,
    processor_terms_status: "NOT_APPLICABLE_LOCAL"
  };
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
  /**
   * EKSTERN databehandler: svartekst sendes til OpenAI. Navngitt rad, regel
   * 3-feltene nå BEKREFTET (D-226, 2026-09-22) - se `OpenAiStt.processor` for
   * full detalj (samme org-konto/vilkår gjelder begge tjenestene).
   */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "openai-audio-speech",
    locality: "external",
    processor_row_declared: true,
    processor_terms_status: "VERIFIED"
  };
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

/**
 * Task #125 (D-217): lokal TTS via piper-binæren i `JARVIS_PIPER_BIN` +
 * stemmemodellen i `JARVIS_PIPER_MODEL` (`--model`-flagget piper krever).
 * I MOTSETNING til `LocalWhisperStt` (batch) ER piper EKTE strømmende: teksten
 * skrives til prosessens stdin, rå PCM-lydrammer leses FORTLØPENDE fra stdout
 * etter hvert som de produseres - ingen mellomlagret fil, ingen venting på at
 * HELE syntesen fullfører FØR første ramme. `cancel()` DREPER prosessen
 * umiddelbart (`child.kill()`) i stedet for kun å sette et flagg konsumenten
 * selv må polle - session.ts sin `bargeIn()` kaller `cancel()` FRA UTSIDEN
 * mens `for await`-løkken kan stå og vente på neste stdout-chunk (§15/§16:
 * barge-in skal stoppe avspilling UMIDDELBART) - et rent boolsk flagg ville
 * IKKE klart å avbryte et kall som allerede henger på en `await read()`.
 *
 * UNVERIFIED (D-41-disiplin, eksplisitt disclosed): `--model`/`--output_raw`
 * (understrek, ikke bindestrek) er den LANGVARIG DOKUMENTERTE, mest utbredte
 * piper-CLI-konvensjonen, men ALDRI kjørt mot en ekte installert binær i
 * denne økten (Q-32 punkt 3). Utdataens samplerate bestemmes av HVILKEN
 * stemmemodell Tobias installerer (typisk 22050 Hz, noen 16 kHz-varianter
 * finnes) - denne adapteren re-samplerer ALDRI selv (samme, allerede
 * eksisterende gap som `OpenAiTts` sin egen 24 kHz-respons - ingen
 * resampling noe sted i piloten ennå, IKKE noe denne sliceen bevisst løser).
 * Selve subprosess-/strømme-/kanselleringskoden ER testet, mot en faket
 * binær (se `test/local-piper-tts.test.ts`).
 */
export class LocalPiperTts implements TtsAdapter {
  readonly name = "local-piper";
  /** Lokal binær - tekst/lyd forlater aldri maskinen. */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "local-piper",
    locality: "local",
    processor_row_declared: true,
    processor_terms_status: "NOT_APPLICABLE_LOCAL"
  };
  constructor(
    private readonly binPath: string | undefined = process.env["JARVIS_PIPER_BIN"],
    private readonly modelPath: string | undefined = process.env["JARVIS_PIPER_MODEL"]
  ) {}

  /** Stemmemodellen er like påkrevd som binæren - piper kan strukturelt ikke kjøre uten `--model`. */
  available(): boolean {
    return Boolean(this.binPath) && Boolean(this.modelPath);
  }

  synthesize(text: string): TtsPlayback {
    if (!this.binPath || !this.modelPath) {
      throw new Error("local_piper_not_configured");
    }
    const { binPath, modelPath } = this;
    let cancelled = false;
    let child: ReturnType<typeof spawn> | undefined;
    async function* generate(): AsyncIterable<Buffer> {
      if (cancelled) {
        return;
      }
      // `detached: true` (POSIX): piper blir gruppeleder for en NY
      // prosessgruppe - `killProcessGroup()` under kan da drepe HELE
      // undertreet (`-pid`), ikke kun selve piper-PID-en. Nødvendig fordi et
      // reelt binær-kall i praksis kan spawne egne barneprosesser som ARVER
      // stdout-pipen - å drepe KUN toppen ville da latt pipen forbli åpen
      // (Node ser aldri EOF) og cancel() ville hengt til den underliggende
      // prosessen selv ga opp, EKSAKT det §15/§16 (barge-in) forbyr. Bevist
      // av `test/local-piper-tts.test.ts` sin `mock-piper-hang.sh`.
      const proc = spawn(binPath, ["--model", modelPath, "--output_raw"], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true
      });
      child = proc;
      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      proc.stdin.end(text);
      const exitCode = new Promise<number | null>((resolve) => proc.once("close", resolve));
      try {
        for await (const chunk of proc.stdout) {
          if (cancelled) {
            return;
          }
          yield chunk as Buffer;
        }
      } finally {
        killProcessGroup(proc);
      }
      const code = await exitCode;
      if (!cancelled && code !== 0) {
        throw new Error(`local_piper_process_failed:${code ?? "unknown"}:${stderr.slice(0, 200)}`);
      }
    }
    return {
      frames: generate(),
      cancel(): void {
        cancelled = true;
        if (child) {
          killProcessGroup(child);
        }
      }
    };
  }
}

/**
 * Dreper HELE prosessgruppen `proc` leder (se `detached: true`-kommentaren
 * over), ALDRI kun selve PID-en - `ESRCH` (prosessen/gruppen er allerede
 * borte) svelges bevisst, det er den FORVENTEDE, harmløse utfallsformen når
 * prosessen allerede rakk å avslutte selv (f.eks. lykkes-banen der
 * `finally`-blokken kjører etter en NORMAL EOF, ikke en kansellering).
 */
function killProcessGroup(proc: ReturnType<typeof spawn>): void {
  if (proc.killed || proc.exitCode !== null || proc.pid === undefined) {
    return;
  }
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    // ESRCH: allerede avsluttet - se filhode.
  }
}
