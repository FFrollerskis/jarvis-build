import { PassthroughAec, PassthroughNoiseSuppressor, type AudioFilter } from "./audio.ts";
import { EnergyVad, type VadAdapter } from "./vad.ts";
import type { SttAdapter, SttStream } from "./stt.ts";
import type { TtsAdapter, TtsPlayback } from "./tts.ts";

export type VoiceState = "listening" | "thinking" | "speaking";

export interface VoiceIdentity {
  person_id: string;
  tenant_id: string;
  device_id: string;
  memory_space: string;
  channel: "voice";
}

/** Core-klient: gatewayen snakker KUN med Core - all dialog/policy/minne bor der. */
export interface CoreClient {
  chat(identity: VoiceIdentity, message: string): Promise<{ reply: string; routed: string; session_id: string; task_id?: string }>;
}

/** Per-tur-tidsstempler for latensanalyse (P50/P95 beregnes over turer). */
export interface TurnMetrics {
  utterance_id: string;
  t_speech_start: number;
  t_first_partial?: number;
  t_end_of_turn?: number;
  t_core_reply?: number;
  t_tts_first_frame?: number;
  t_done?: number;
  barge_in_ms?: number;
  routed?: string;
}

export interface SessionEvents {
  onState(state: VoiceState): void;
  onPartial(text: string): void;
  onFinal(text: string): void;
  onReply(reply: { reply: string; routed: string; session_id: string; task_id?: string }): void;
  onTtsFrame(frame: Buffer): void;
  onTtsCancelled(afterMs: number): void;
  onMetrics(metrics: TurnMetrics): void;
  onError(message: string): void;
}

/**
 * Utterance-journal: gjør turer idempotente ved failover/gjenopptak.
 * En allerede fullført utterance_id re-sendes ALDRI til Core (ingen doble
 * verktøyhandlinger). In-memory i piloten; persistent lager når gatewayen
 * får delt tilstand (dokumentert avvik).
 */
export class UtteranceJournal {
  private readonly completed = new Set<string>();
  isCompleted(id: string): boolean {
    return this.completed.has(id);
  }
  markCompleted(id: string): void {
    this.completed.add(id);
  }
}

/**
 * Full-duplex talesesjon (VOICE_ARCHITECTURE §3-§5): VAD → streaming STT →
 * Core → streaming TTS, med ekte barge-in: tale under avspilling kansellerer
 * TTS umiddelbart og starter ny tur. Gatewayen har ingen samtalelogikk.
 */
export class VoiceSession {
  private state: VoiceState = "listening";
  private stt: SttStream | null = null;
  private playback: TtsPlayback | null = null;
  private speakingStartedAt = 0;
  private metrics: TurnMetrics | null = null;
  private utteranceCounter = 0;
  private turnChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly identity: VoiceIdentity,
    private readonly core: CoreClient,
    private readonly sttAdapter: SttAdapter,
    private readonly ttsAdapter: TtsAdapter,
    private readonly events: SessionEvents,
    private readonly journal: UtteranceJournal = new UtteranceJournal(),
    private readonly vad: VadAdapter = new EnergyVad(),
    private readonly aec: AudioFilter = new PassthroughAec(),
    private readonly noise: AudioFilter = new PassthroughNoiseSuppressor(),
    /** Failover-tilfelle: gjenoppta med kjente utterance-IDer. */
    private readonly utteranceIdPrefix = `utt-${Date.now().toString(36)}`
  ) {}

  currentState(): VoiceState {
    return this.state;
  }

  /** Mater én lydramme inn i kjeden. Full duplex: mottas også mens Jarvis snakker. */
  pushAudio(rawFrame: Buffer, atMs: number = Date.now()): void {
    const frame = this.noise.process(this.aec.process(rawFrame));
    const vadEvent = this.vad.push(frame, atMs);

    if (vadEvent === "speech_start") {
      if (this.state === "speaking") {
        this.bargeIn(atMs);
      }
      if (!this.stt) {
        this.beginTurn(atMs);
      }
    }
    if (this.stt && (vadEvent === "speech" || vadEvent === "speech_start")) {
      this.stt.pushAudio(frame);
    }
    if (vadEvent === "end_of_turn" && this.stt) {
      this.finishTurn(atMs);
    }
  }

  /** Eksplisitt gjenopptak etter failover: samme utterance-id gir NOOP. */
  replayFinal(utteranceId: string, text: string): void {
    if (this.journal.isCompleted(utteranceId)) {
      this.events.onError(`utterance_already_completed:${utteranceId}`);
      return;
    }
    this.turnChain = this.turnChain.then(() => this.runTurn(utteranceId, text, Date.now()));
  }

  private beginTurn(atMs: number): void {
    this.utteranceCounter += 1;
    this.metrics = {
      utterance_id: `${this.utteranceIdPrefix}-${this.utteranceCounter}`,
      t_speech_start: atMs
    };
    this.stt = this.sttAdapter.startStream();
    this.stt.onPartial((text) => {
      if (this.metrics && this.metrics.t_first_partial === undefined) {
        this.metrics.t_first_partial = Date.now();
      }
      this.events.onPartial(text);
    });
  }

  private finishTurn(atMs: number): void {
    const stt = this.stt;
    const metrics = this.metrics;
    this.stt = null;
    if (!stt || !metrics) {
      return;
    }
    metrics.t_end_of_turn = atMs;
    this.turnChain = this.turnChain.then(async () => {
      const text = await stt.end();
      if (!text) {
        return;
      }
      this.events.onFinal(text);
      await this.runTurn(metrics.utterance_id, text, atMs, metrics);
    });
  }

  private async runTurn(utteranceId: string, text: string, _atMs: number, metrics?: TurnMetrics): Promise<void> {
    if (this.journal.isCompleted(utteranceId)) {
      this.events.onError(`utterance_already_completed:${utteranceId}`);
      return;
    }
    const turnMetrics = metrics ?? { utterance_id: utteranceId, t_speech_start: Date.now() };
    this.setState("thinking");
    try {
      const reply = await this.core.chat(this.identity, text);
      turnMetrics.t_core_reply = Date.now();
      turnMetrics.routed = reply.routed;
      // Turen regnes fullført NÅR Core har utført den - replay etter dette er idempotent-nekt.
      this.journal.markCompleted(utteranceId);
      this.events.onReply(reply);
      await this.speak(reply.reply, turnMetrics);
    } catch (err) {
      // Fail-closed og kontrollert: feil åpner ingenting, sesjonen fortsetter å lytte.
      this.events.onError(`core_error:${(err as Error).message}`);
    } finally {
      turnMetrics.t_done = Date.now();
      this.events.onMetrics(turnMetrics);
      this.setState("listening");
    }
  }

  private async speak(text: string, metrics: TurnMetrics): Promise<void> {
    this.setState("speaking");
    this.speakingStartedAt = Date.now();
    const playback = this.ttsAdapter.synthesize(text);
    this.playback = playback;
    let first = true;
    try {
      for await (const frame of playback.frames) {
        if (first) {
          metrics.t_tts_first_frame = Date.now();
          first = false;
        }
        this.events.onTtsFrame(frame);
      }
    } finally {
      if (this.playback === playback) {
        this.playback = null;
      }
    }
  }

  private bargeIn(atMs: number): void {
    if (this.playback) {
      this.playback.cancel();
      this.playback = null;
      const afterMs = Date.now() - atMs;
      if (this.metrics) {
        this.metrics.barge_in_ms = afterMs;
      }
      this.events.onTtsCancelled(afterMs);
    }
    this.setState("listening");
  }

  private setState(state: VoiceState): void {
    if (this.state !== state) {
      this.state = state;
      this.events.onState(state);
    }
  }
}
