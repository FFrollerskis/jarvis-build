import { evaluateSpeechRouting, type SpeechRoutingDecision } from "@jarvis/contracts";
import { PassthroughAec, PassthroughNoiseSuppressor, type AudioFilter } from "./audio.ts";
import { EnergyVad, type VadAdapter } from "./vad.ts";
import { SentenceChunker } from "./chunker.ts";
import type { VoiceHealth } from "./health.ts";
import type { SttAdapter, SttStream } from "./stt.ts";
import type { TtsAdapter, TtsPlayback } from "./tts.ts";

/**
 * BO-12 §23: eksplisitt tilstandsmaskin. idle = før klienten har aktivert
 * mikrofon (start-melding = eksplisitt aktivering, aldri skjult opptak);
 * interrupted = barge-in registrert; error via egne error-events.
 */
export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "interrupted";

export interface VoiceIdentity {
  person_id: string;
  tenant_id: string;
  device_id: string;
  memory_space: string;
  channel: "voice";
  /** BO-12 §33: valgfri owner-override av LLM-provider - voice-laget er likt uansett. */
  provider?: string;
}

export interface CoreReply {
  reply: string;
  routed: string;
  session_id: string;
  task_id?: string;
  cancelled?: boolean;
  interrupted?: boolean;
}

/** Normaliserte streaming-events fra Core (§12): kun brukerrettet innhold + tool-status. */
export type CoreStreamEvent =
  | { type: "token"; text: string }
  | { type: "tool"; tool_name: string };

/** Core-klient: gatewayen snakker KUN med Core - all dialog/policy/minne bor der. */
export interface CoreClient {
  chat(identity: VoiceIdentity, message: string): Promise<CoreReply>;
  /**
   * BO-12 §12-§13: streaming-variant - tokens driver setningschunking → TTS
   * mens generering pågår. signal aborterer helt inn i provider-upstream
   * (P1A-kjeden). Valgfri: uten denne brukes chat() (fullført svar → TTS).
   */
  chatStream?(
    identity: VoiceIdentity,
    message: string,
    onEvent: (event: CoreStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<CoreReply>;
}

/** Per-tur-tidsstempler for latensanalyse (BO-12 §19; P50/P95 beregnes over turer). */
export interface TurnMetrics {
  utterance_id: string;
  t_speech_start: number;
  t_first_partial?: number;
  t_end_of_turn?: number;
  /** §19: speech_end → endelig transkript. */
  t_final_transcript?: number;
  /** §19: første modell-token mottatt fra Core. */
  t_model_first_token?: number;
  /** §19: første chunk sendt til TTS. */
  t_first_tts_request?: number;
  t_tts_first_frame?: number;
  t_core_reply?: number;
  t_done?: number;
  /** D-30 hardening §6: tidspunkt trusted tool-status ble varslet (tool_call_complete). */
  t_tool_activity?: number;
  barge_in_ms?: number;
  /** §19 hovedmål: end-of-user-speech → første Jarvis-lyd. */
  end_of_speech_to_first_audio_ms?: number;
  /** §20: separat usage-grunnlag for STT-/TTS-kost (aldri blandet med LLM-kost). */
  stt_audio_ms?: number;
  tts_chars?: number;
  cancelled?: boolean;
  routed?: string;
}

export interface SessionEvents {
  onState(state: VoiceState): void;
  onPartial(text: string): void;
  onFinal(text: string): void;
  onReply(reply: CoreReply): void;
  onTtsFrame(frame: Buffer): void;
  onTtsCancelled(afterMs: number): void;
  onMetrics(metrics: TurnMetrics): void;
  onError(message: string): void;
  /** BO-12 §26: kort brukerrettet verktøystatus ("Sjekker kalenderen …") - aldri intern JSON. */
  onToolActivity?(activity: string): void;
}

/** §26: trusted mapping verktøynavn → kort brukerrettet status. Ukjente får generisk tekst. */
const TOOL_ACTIVITY_TEXT: Record<string, string> = {
  read_calendar_today: "Sjekker kalenderen din …",
  read_recent_email: "Ser på e-posten din …",
  read_github_issues: "Sjekker GitHub …"
};

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
 * Full-duplex talesesjon (VOICE_ARCHITECTURE §3-§5 + BO-12): VAD → streaming
 * STT → Core (AI Mesh, streaming) → setningschunket streaming TTS, med ekte
 * barge-in: tale under avspilling stopper lyd, tømmer TTS-køen, forkaster
 * buffret tekst OG aborterer modellgenereringen upstream (P1A-kjeden, §15).
 * Epoch-vern garanterer at gammel tale aldri spilles etter ny tur (§16).
 * Gatewayen har ingen samtalelogikk; tale gir ingen ekstra authority (§43).
 */
export class VoiceSession {
  private state: VoiceState = "listening";
  private stt: SttStream | null = null;
  private playback: TtsPlayback | null = null;
  private metrics: TurnMetrics | null = null;
  private utteranceCounter = 0;
  private turnChain: Promise<void> = Promise.resolve();
  /** §16: epoch bumpes ved barge-in - alt fra gammel epoch droppes deterministisk. */
  private epoch = 0;
  private ttsQueue: string[] = [];
  private ttsWorker: Promise<void> = Promise.resolve();
  private activeTurnAbort: AbortController | null = null;
  /**
   * D-122 (UA-7 kriterium 4): rutingsporten avgjøres ÉN gang per sesjon, ved
   * konstruksjon, fra sesjonens memory space og adapterens egen
   * databehandler-erklæring. Deterministisk og uforanderlig gjennom sesjonen -
   * en kaller kan ikke «forhandle» seg til en ekstern behandler midt i en
   * samtale ved å endre noe underveis.
   */
  private readonly sttRouting: SpeechRoutingDecision;
  private readonly ttsRouting: SpeechRoutingDecision;
  /** Avslaget rapporteres ÉN gang per sesjon per retning - aldri per lydramme. */
  private sttDenialReported = false;
  private ttsDenialReported = false;

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
    private readonly utteranceIdPrefix = `utt-${Date.now().toString(36)}`,
    private readonly health?: VoiceHealth
  ) {
    // Bruker parameterne direkte (ikke `this.*`): parameter-properties og
    // felt-initialisering har subtil rekkefølge, og denne porten skal aldri
    // avhenge av den.
    this.sttRouting = evaluateSpeechRouting(sttAdapter.processor, identity.memory_space);
    this.ttsRouting = evaluateSpeechRouting(ttsAdapter.processor, identity.memory_space);
  }

  currentState(): VoiceState {
    return this.state;
  }

  /** D-122: observerbar for `/status`, tester og revisjon - aldri en skjult beslutning. */
  speechRouting(): { stt: SpeechRoutingDecision; tts: SpeechRoutingDecision } {
    return { stt: this.sttRouting, tts: this.ttsRouting };
  }

  /** Mater én lydramme inn i kjeden. Full duplex: mottas også mens Jarvis snakker. */
  pushAudio(rawFrame: Buffer, atMs: number = Date.now()): void {
    // D-122: FØR filtre, VAD og adapter. Er STT-behandleren ikke kvalifisert
    // for denne sesjonens memory space, skal IKKE ÉN lydramme nå adapteren.
    // Ingen stille fallback til en annen behandler: sesjonen feiler synlig, og
    // det er hele poenget (et fallback ville skjult at porten slo inn).
    if (!this.sttRouting.allowed) {
      if (!this.sttDenialReported) {
        this.sttDenialReported = true;
        this.events.onError(`speech_routing_denied_stt:${this.sttRouting.outcome}`);
      }
      return;
    }
    const frame = this.noise.process(this.aec.process(rawFrame));
    const vadEvent = this.vad.push(frame, atMs);

    if (vadEvent === "speech_start") {
      if (this.state === "speaking" || this.state === "thinking") {
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
    metrics.stt_audio_ms = atMs - metrics.t_speech_start;
    this.turnChain = this.turnChain.then(async () => {
      let text: string;
      try {
        text = await stt.end();
      } catch (err) {
        // §35: STT-feil → normalisert feil, ALDRI modellkjøring på manglende transkript.
        this.health?.recordFailure("stt", (err as Error).message);
        this.events.onError("stt_error");
        this.setState("listening");
        return;
      }
      metrics.t_final_transcript = Date.now();
      if (!text) {
        // §35: tom/ugyldig transkript (støy, ingen tale) → ingen modellkjøring.
        return;
      }
      this.health?.recordSuccess("stt");
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
    const turnEpoch = this.epoch;
    this.setState("thinking");
    const abort = new AbortController();
    this.activeTurnAbort = abort;
    try {
      const reply = this.core.chatStream
        ? await this.streamTurn(text, turnMetrics, turnEpoch, abort.signal)
        : await this.core.chat(this.identity, text);
      turnMetrics.t_core_reply = Date.now();
      turnMetrics.routed = reply.routed;
      // Turen regnes fullført NÅR Core har utført den - replay etter dette er
      // idempotent-nekt. Gjelder også avbrutte turer: voice-avbrudd ruller
      // ALDRI tilbake/re-utfører allerede utførte verktøy (§17).
      this.journal.markCompleted(utteranceId);
      this.events.onReply(reply);
      if (this.epoch === turnEpoch && !reply.cancelled) {
        if (!this.core.chatStream) {
          // Ikke-streaming Core: hele svaret tales som ett stykke via køen.
          this.enqueueTts(reply.reply, turnEpoch, turnMetrics);
        }
        await this.drainTts(turnEpoch);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError" || this.epoch !== turnEpoch) {
        // Barge-in avbrøt turen - rent avbrudd, ingen feil (§15).
        turnMetrics.cancelled = true;
        this.journal.markCompleted(utteranceId);
      } else {
        // §27: normalisert brukerrettet feil - tekniske detaljer kun i logg/audit.
        console.error(JSON.stringify({ msg: "voice_core_error", error: (err as Error).message.slice(0, 200) }));
        this.events.onError("core_error");
      }
    } finally {
      if (this.activeTurnAbort === abort) {
        this.activeTurnAbort = null;
      }
      turnMetrics.t_done = Date.now();
      if (turnMetrics.t_tts_first_frame !== undefined && turnMetrics.t_end_of_turn !== undefined) {
        turnMetrics.end_of_speech_to_first_audio_ms = turnMetrics.t_tts_first_frame - turnMetrics.t_end_of_turn;
      }
      this.events.onMetrics(turnMetrics);
      if (this.epoch === turnEpoch) {
        this.setState("listening");
      }
    }
  }

  /** §13: streamet svar → setningschunker → TTS-kø mens genereringen pågår. */
  private async streamTurn(
    text: string,
    metrics: TurnMetrics,
    turnEpoch: number,
    signal: AbortSignal
  ): Promise<CoreReply> {
    const chunker = new SentenceChunker((chunk) => this.enqueueTts(chunk, turnEpoch, metrics));
    const reply = await (this.core.chatStream as NonNullable<CoreClient["chatStream"]>)(
      this.identity,
      text,
      (event) => {
        if (this.epoch !== turnEpoch) {
          return; // barge-in har skjedd - gamle events forkastes (§16)
        }
        if (event.type === "token") {
          if (metrics.t_model_first_token === undefined) {
            metrics.t_model_first_token = Date.now();
          }
          chunker.push(event.text);
        } else if (event.type === "tool") {
          // §26: kun kort trusted status - aldri tool-payload/intern JSON i tale.
          if (metrics.t_tool_activity === undefined) {
            metrics.t_tool_activity = Date.now();
          }
          this.events.onToolActivity?.(TOOL_ACTIVITY_TEXT[event.tool_name] ?? "Jobber med saken …");
        }
      },
      signal
    );
    if (this.epoch === turnEpoch && !reply.cancelled) {
      chunker.flush();
    } else {
      chunker.discard();
    }
    return reply;
  }

  /**
   * D-122: ett avslag, rapportert ÉN gang per sesjon. `health.recordFailure`
   * kalles bevisst IKKE - se begrunnelsen i `speakNext()`.
   */
  private reportTtsDenial(): void {
    this.ttsQueue = [];
    if (!this.ttsDenialReported) {
      this.ttsDenialReported = true;
      this.events.onError(`speech_routing_denied_tts:${this.ttsRouting.outcome}`);
    }
  }

  /** Sekvensiell TTS-kø med epoch-vern: chunk fra gammel epoch tales aldri (§16). */
  private enqueueTts(chunk: string, turnEpoch: number, metrics?: TurnMetrics): void {
    if (this.epoch !== turnEpoch || chunk.trim().length === 0) {
      return;
    }
    // D-122: køes ikke i det hele tatt når behandleren er avvist - da forblir
    // `tts_chars` ÆRLIG null i stedet for å telle tegn som aldri ble behandlet.
    if (!this.ttsRouting.allowed) {
      this.reportTtsDenial();
      return;
    }
    if (metrics) {
      metrics.tts_chars = (metrics.tts_chars ?? 0) + chunk.length;
      if (metrics.t_first_tts_request === undefined) {
        metrics.t_first_tts_request = Date.now();
      }
    }
    this.ttsQueue.push(chunk);
    this.ttsWorker = this.ttsWorker.then(() => this.speakNext(turnEpoch, metrics));
  }

  private async speakNext(turnEpoch: number, metrics?: TurnMetrics): Promise<void> {
    if (this.epoch !== turnEpoch) {
      this.ttsQueue = [];
      return;
    }
    const chunk = this.ttsQueue.shift();
    if (chunk === undefined) {
      return;
    }
    // D-122: svarteksten fra en sensitiv samtale er like avslørende som
    // spørsmålet. Er TTS-behandleren ikke kvalifisert, syntetiseres INGENTING.
    // `health.recordFailure` kalles bevisst IKKE: dette er et policy-avslag,
    // ikke en leverandørfeil - å merke leverandøren «unhealthy» ville vært
    // direkte usant og kunne utløst feilaktig failover.
    if (!this.ttsRouting.allowed) {
      this.ttsQueue = [];
      this.reportTtsDenial();
      return;
    }
    this.setState("speaking");
    let playback: TtsPlayback;
    try {
      playback = this.ttsAdapter.synthesize(chunk);
    } catch (err) {
      // §36: TTS-feil forkaster ALDRI Jarvis-svaret (teksten er alt levert via onReply).
      this.health?.recordFailure("tts", (err as Error).message);
      this.events.onError("tts_error");
      return;
    }
    this.playback = playback;
    let first = true;
    try {
      for await (const frame of playback.frames) {
        if (this.epoch !== turnEpoch) {
          playback.cancel();
          return; // gammel lyd slippes aldri gjennom etter barge-in (§16)
        }
        if (first) {
          if (metrics && metrics.t_tts_first_frame === undefined) {
            metrics.t_tts_first_frame = Date.now();
          }
          first = false;
        }
        this.events.onTtsFrame(frame);
      }
      this.health?.recordSuccess("tts");
    } catch (err) {
      this.health?.recordFailure("tts", (err as Error).message);
      this.events.onError("tts_error");
    } finally {
      if (this.playback === playback) {
        this.playback = null;
      }
    }
  }

  /** Venter til køen for gjeldende epoch er ferdigspilt (eller barge-in tømmer den). */
  private async drainTts(turnEpoch: number): Promise<void> {
    for (;;) {
      await this.ttsWorker;
      if (this.epoch !== turnEpoch || (this.ttsQueue.length === 0 && this.playback === null)) {
        return;
      }
    }
  }

  /**
   * §15: barge-in - (1) stopp avspilling, (2) tøm TTS-kø, (3) abort aktiv
   * modellgenerering upstream, (4) marker interrupted, (5) klar for ny tur.
   */
  private bargeIn(atMs: number): void {
    this.epoch += 1;
    if (this.health) {
      this.health.bargeInSeen = true;
    }
    this.ttsQueue = [];
    if (this.playback) {
      this.playback.cancel();
      this.playback = null;
      const afterMs = Date.now() - atMs;
      if (this.metrics) {
        this.metrics.barge_in_ms = afterMs;
        this.metrics.cancelled = true;
      }
      this.events.onTtsCancelled(afterMs);
    }
    // Modellgenerering som ikke lenger trengs aborteres helt til provider (P1A).
    this.activeTurnAbort?.abort();
    this.activeTurnAbort = null;
    this.setState("interrupted");
    this.setState("listening");
  }

  /**
   * D-30 hardening §3D: klienten (WebSocket) koblet fra. Uten dette fortsetter
   * en aktiv tur å generere/tale for en tilkobling som ikke lenger lytter -
   * zombie-generering og bortkastet modell-/TTS-kost. Bumper epoch (all
   * gjenværende lyd/eventer fra denne turen forkastes deterministisk, samme
   * vern som barge-in) og aborterer modellgenereringen helt til provider-
   * upstream (P1A-kjeden) - symmetrisk med bargeIn(), men uten ny tur/state.
   */
  disconnect(): void {
    this.epoch += 1;
    this.ttsQueue = [];
    if (this.playback) {
      this.playback.cancel();
      this.playback = null;
    }
    this.activeTurnAbort?.abort();
    this.activeTurnAbort = null;
  }

  private setState(state: VoiceState): void {
    if (this.state !== state) {
      this.state = state;
      this.events.onState(state);
    }
  }
}
