import { evaluateSpeechRouting, type SpeechProcessorDeclaration } from "@jarvis/contracts";
import { errorCode, withDeadline } from "./deadline.ts";
import type { VoiceHealth } from "./health.ts";
import type { SpeechCallContext } from "./speech-context.ts";
import type { SttAdapter, SttStream } from "./stt.ts";
import type { TtsAdapter, TtsOptions, TtsPlayback, VoiceCapabilities } from "./tts.ts";

/**
 * WP-V2 (K4, JARVIS-080, masterplan v2.1 §14): failover SKY -> LOKAL for tale.
 *
 * REGLER (alle testet i `test/wpv2-k4-deadlines-failover.test.ts`):
 *  1. Kun SKY -> LOKAL. En reserve som ikke er lokal avvises ved konstruksjon. Det finnes ingen vei fra lokal til sky (ingen stille sky-fallback).
 *  2. TTS: failover KUN før første ramme er levert (aldri «dobbel tale» - en halvspilt setning gjentas ikke fra en annen stemme).
 *  3. Reserven brukes bare når den er `available()` (binær + modell finnes, K1c) OG rutingporten (`evaluateSpeechRouting`) slipper den
 *     gjennom for DENNE sesjonens memory space og tillitsnivå (D-122 - en lokal behandler er alltid tillatt, regel 1, men porten
 *     kjøres likevel; uten sesjonskontekst tillates kun en lokal reserve).
 *  4. Primærens avslag fra rutingporten er IKKE en feil: sesjonen avviser da all tale (D-122), og reserven brukes aldri som omvei.
 *  5. Etter en primærfeil hoppes primæren over i `cooldownMs` (ellers ventet HVER chunk i et svar på primærens frist først).
 *  6. Hendelser logges som korte KODER (aldri leverandørtekst); `health` skiller primær- og reservefeil (`<x>_primary`/`<x>_reserve`).
 * `selectSpeechAdapters` (adapter-selection.ts) er uendret - failover komponeres ETTER utvelgelsen (`main.ts`).
 */
export interface FailoverOptions {
  health?: VoiceHealth;
  /** TTS: maks ventetid på primærens FØRSTE ramme før reserven tar over (ms). */
  primaryFirstFrameTimeoutMs?: number;
  /** STT: maks ventetid på primærens transkript før reserven tar over (ms). */
  primaryEndTimeoutMs?: number;
  /** Hvor lenge primæren hoppes over etter en feil (ms). */
  cooldownMs?: number;
  now?: () => number;
  /** Strukturert hendelseslogg (standard: `console.warn` som JSON). Kun koder. */
  log?: (event: Record<string, unknown>) => void;
}

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 6_000;
const DEFAULT_END_TIMEOUT_MS = 10_000;
const DEFAULT_COOLDOWN_MS = 30_000;

/** Delt tilstand/regler for begge wrappere. */
class FailoverCore {
  failovers = 0;
  lastReason: string | undefined;
  private downUntil = 0;
  readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly log: (event: Record<string, unknown>) => void;

  constructor(
    private readonly kind: "stt" | "tts",
    readonly primaryName: string,
    private readonly reserve: { name: string; processor: SpeechProcessorDeclaration; available(): boolean },
    private readonly options: FailoverOptions
  ) {
    if (reserve.processor.locality !== "local") {
      // Regel 1: en sky-reserve er en stille ekstern sending av tekst/lyd - aldri automatisk.
      throw new Error("failover_reserve_must_be_local");
    }
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((event) => console.warn(JSON.stringify(event)));
  }

  /** Reserven hvis den kan brukes for DENNE sesjonen (regel 3), ellers `undefined`. */
  usableReserve(ctx: SpeechCallContext | undefined): boolean {
    if (!this.reserve.available()) {
      return false;
    }
    if (ctx) {
      return evaluateSpeechRouting(this.reserve.processor, ctx.memorySpace, ctx.authority).allowed;
    }
    return this.reserve.processor.locality === "local";
  }

  primaryDown(): boolean {
    return this.now() < this.downUntil;
  }

  primaryOk(): void {
    this.downUntil = 0;
    this.options.health?.recordSuccess(`${this.kind}_primary`);
  }

  primaryFailed(err: unknown): string {
    const code = errorCode(err);
    this.downUntil = this.now() + this.cooldownMs;
    this.options.health?.recordFailure(`${this.kind}_primary`, code);
    return code;
  }

  reserveOk(): void {
    this.options.health?.recordSuccess(`${this.kind}_reserve`);
  }

  reserveFailed(err: unknown): void {
    this.options.health?.recordFailure(`${this.kind}_reserve`, errorCode(err));
  }

  /** Regel 6: en kode, aldri tekst. */
  failedOver(reason: string): void {
    this.failovers += 1;
    this.lastReason = reason;
    this.log({ msg: `${this.kind}_failover`, from: this.primaryName, to: this.reserve.name, reason });
  }

  status(): Record<string, unknown> {
    const configured = { [`${this.kind}_primary`]: true, [`${this.kind}_reserve`]: this.reserve.available() };
    return {
      failover: {
        reserve: this.reserve.name,
        reserve_available: this.reserve.available(),
        primary_in_cooldown: this.primaryDown(),
        failovers: this.failovers,
        ...(this.lastReason !== undefined ? { last_reason: this.lastReason } : {}),
        ...(this.options.health ? { components: this.options.health.snapshot(configured) } : {})
      }
    };
  }
}

/**
 * Strømmende lineær resampler for PCM16 mono (little-endian). Brukes når en reserve har en annen samplerate enn primæren
 * (piper 22 050 Hz mot OpenAI 24 000 Hz): klienten får ÉN samplerate per sesjon (`started.tts_sample_rate`), så reservens lyd må
 * i primærens rate, ellers spilles den for fort/langsomt. Lineær interpolasjon er tilstrekkelig for tale; tilstand (siste sample,
 * brøkposisjon, en halv byte) bæres mellom `push`-kall, så resultatet er uavhengig av hvordan inndata er delt i biter.
 */
export class Pcm16Resampler {
  private readonly step: number;
  private nextPosition = 0;
  private consumed = 0;
  private previousSample = 0;
  private oddByte: number | null = null;

  constructor(fromRate: number, toRate: number) {
    this.step = fromRate / toRate;
  }

  push(chunk: Buffer): Buffer {
    let input = chunk;
    if (this.oddByte !== null) {
      input = Buffer.concat([Buffer.from([this.oddByte]), chunk]);
      this.oddByte = null;
    }
    if (input.length % 2 === 1) {
      this.oddByte = input[input.length - 1] as number;
      input = input.subarray(0, input.length - 1);
    }
    const n = input.length / 2;
    if (n === 0) {
      return Buffer.alloc(0);
    }
    const sampleAt = (globalIndex: number): number =>
      globalIndex < this.consumed ? this.previousSample : input.readInt16LE((globalIndex - this.consumed) * 2);
    const out: number[] = [];
    while (this.nextPosition < this.consumed + n - 1) {
      const i0 = Math.floor(this.nextPosition);
      const frac = this.nextPosition - i0;
      const a = sampleAt(i0);
      const b = sampleAt(i0 + 1);
      out.push(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * frac))));
      this.nextPosition += this.step;
    }
    this.previousSample = input.readInt16LE((n - 1) * 2);
    this.consumed += n;
    const result = Buffer.alloc(out.length * 2);
    out.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
    return result;
  }
}

export class FailoverTts implements TtsAdapter {
  readonly name: string;
  readonly processor: SpeechProcessorDeclaration;
  readonly sampleRate?: number;
  readonly voiceCapabilities?: VoiceCapabilities;
  private readonly core: FailoverCore;
  private readonly firstFrameTimeoutMs: number;

  constructor(
    private readonly primary: TtsAdapter,
    private readonly reserve: TtsAdapter,
    private readonly options: FailoverOptions = {}
  ) {
    this.core = new FailoverCore("tts", primary.name, reserve, options);
    this.firstFrameTimeoutMs = options.primaryFirstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS;
    this.name = `${primary.name}+failover`;
    // Rutingporten dømmer PRIMÆRENS behandler (regel 4) - reserven dømmes per kall mot sesjonskonteksten.
    this.processor = primary.processor;
    if (primary.sampleRate !== undefined) {
      this.sampleRate = primary.sampleRate;
    }
    if (primary.voiceCapabilities !== undefined) {
      this.voiceCapabilities = primary.voiceCapabilities;
    }
  }

  available(): boolean {
    return this.primary.available() || this.reserve.available();
  }

  status(): Record<string, unknown> {
    return { ...(this.primary.status?.() ?? {}), ...this.core.status() };
  }

  synthesize(text: string, options?: TtsOptions, context?: SpeechCallContext): TtsPlayback {
    const state: { cancelled: boolean; active: TtsPlayback | undefined } = { cancelled: false, active: undefined };
    return {
      frames: this.run(text, options, context, state),
      cancel(): void {
        state.cancelled = true;
        state.active?.cancel();
      }
    };
  }

  private async *run(
    text: string,
    options: TtsOptions | undefined,
    context: SpeechCallContext | undefined,
    state: { cancelled: boolean; active: TtsPlayback | undefined }
  ): AsyncIterable<Buffer> {
    const reserveUsable = this.core.usableReserve(context);
    let completed = false;
    try {
      if (!(reserveUsable && this.core.primaryDown())) {
        let yielded = false;
        let primaryPlayback: TtsPlayback | undefined;
        try {
          primaryPlayback = this.primary.synthesize(text, options, context);
          state.active = primaryPlayback;
          const iterator = primaryPlayback.frames[Symbol.asyncIterator]();
          // Med en brukbar reserve har primærens FØRSTE ramme en kort frist (en hengende primær skal ikke holde hele svaret igjen).
          const pendingFirst = iterator.next();
          let result = reserveUsable
            ? await withDeadline(pendingFirst, this.firstFrameTimeoutMs, "tts_primary_first_frame_timeout")
            : await pendingFirst;
          while (!result.done) {
            yielded = true;
            yield result.value;
            result = await iterator.next();
          }
          this.core.primaryOk();
          completed = true;
          return;
        } catch (err) {
          if (state.cancelled) {
            return;
          }
          primaryPlayback?.cancel();
          const code = this.core.primaryFailed(err);
          if (yielded || !reserveUsable) {
            throw err; // regel 2: aldri failover etter første ramme
          }
          this.core.failedOver(code);
        }
      }
      if (state.cancelled) {
        return;
      }
      let reservePlayback: TtsPlayback;
      try {
        reservePlayback = this.reserve.synthesize(text, options, context);
      } catch (err) {
        this.core.reserveFailed(err);
        throw err;
      }
      state.active = reservePlayback;
      const resampler =
        this.reserve.sampleRate !== undefined && this.primary.sampleRate !== undefined && this.reserve.sampleRate !== this.primary.sampleRate
          ? new Pcm16Resampler(this.reserve.sampleRate, this.primary.sampleRate)
          : null;
      try {
        for await (const frame of reservePlayback.frames) {
          if (state.cancelled) {
            return;
          }
          const out = resampler ? resampler.push(frame) : frame;
          if (out.length > 0) {
            yield out;
          }
        }
        this.core.reserveOk();
        completed = true;
      } catch (err) {
        if (state.cancelled) {
          return;
        }
        reservePlayback.cancel();
        this.core.reserveFailed(err);
        throw err;
      }
    } finally {
      if (!completed) {
        state.active?.cancel();
      }
    }
  }
}

export class FailoverStt implements SttAdapter {
  readonly name: string;
  readonly processor: SpeechProcessorDeclaration;
  private readonly core: FailoverCore;
  private readonly endTimeoutMs: number;

  constructor(
    private readonly primary: SttAdapter,
    private readonly reserve: SttAdapter,
    options: FailoverOptions = {}
  ) {
    this.core = new FailoverCore("stt", primary.name, reserve, options);
    this.endTimeoutMs = options.primaryEndTimeoutMs ?? DEFAULT_END_TIMEOUT_MS;
    this.name = `${primary.name}+failover`;
    this.processor = primary.processor;
  }

  available(): boolean {
    return this.primary.available() || this.reserve.available();
  }

  status(): Record<string, unknown> {
    return { ...(this.primary.status?.() ?? {}), ...this.core.status() };
  }

  startStream(context?: SpeechCallContext): SttStream {
    const reserveUsable = this.core.usableReserve(context);
    // Audio bufres (maks én tur) slik at samme lyd kan kjøres gjennom reserven hvis primæren feiler. Lyden går KUN til primæren så lenge den er i drift.
    const chunks: Buffer[] = [];
    let partialCallback: ((text: string) => void) | undefined;
    let primaryStream: SttStream | undefined;
    if (!(reserveUsable && this.core.primaryDown())) {
      try {
        primaryStream = this.primary.startStream(context);
      } catch (err) {
        const code = this.core.primaryFailed(err);
        if (!reserveUsable) {
          throw err;
        }
        this.core.failedOver(code);
      }
    }
    return {
      pushAudio: (frame: Buffer): void => {
        chunks.push(frame);
        primaryStream?.pushAudio(frame);
      },
      onPartial: (callback: (text: string) => void): void => {
        partialCallback = callback;
        primaryStream?.onPartial(callback);
      },
      end: async (): Promise<string> => {
        if (primaryStream) {
          try {
            const pending = primaryStream.end();
            const text = reserveUsable ? await withDeadline(pending, this.endTimeoutMs, "stt_primary_end_timeout") : await pending;
            this.core.primaryOk();
            return text;
          } catch (err) {
            const code = this.core.primaryFailed(err);
            if (!reserveUsable) {
              throw err;
            }
            this.core.failedOver(code);
          }
        }
        let stream: SttStream;
        try {
          stream = this.reserve.startStream(context);
        } catch (err) {
          this.core.reserveFailed(err);
          throw err;
        }
        if (partialCallback) {
          stream.onPartial(partialCallback);
        }
        for (const frame of chunks) {
          stream.pushAudio(frame);
        }
        try {
          const text = await stream.end();
          this.core.reserveOk();
          return text;
        } catch (err) {
          this.core.reserveFailed(err);
          throw err;
        }
      }
    };
  }
}

/**
 * Komponerer failover ETTER `selectSpeechAdapters` (som er uendret): kun når den valgte adapteren er EKSTERN og en lokal reserve er
 * tilgjengelig. En lokal valgt adapter (eller ingen tilgjengelig reserve) returneres uendret.
 */
export function withLocalTtsReserve(selected: TtsAdapter, local: TtsAdapter, options?: FailoverOptions): TtsAdapter {
  return selected.processor.locality === "external" && local.processor.locality === "local" && local.available()
    ? new FailoverTts(selected, local, options)
    : selected;
}

export function withLocalSttReserve(selected: SttAdapter, local: SttAdapter, options?: FailoverOptions): SttAdapter {
  return selected.processor.locality === "external" && local.processor.locality === "local" && local.available()
    ? new FailoverStt(selected, local, options)
    : selected;
}
