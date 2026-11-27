import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { SpeechProcessorDeclaration } from "@jarvis/contracts";
import { deadlineSignal } from "./deadline.ts";
import { AVAILABILITY_CACHE_MS, AvailabilityCache, killProcessGroup, probeLocalBinary, type LocalBinaryProblem } from "./local-binary.ts";
import { DEFAULT_VOICE_LIMITS, ProcessSlots, VoiceBusyError } from "./limits.ts";
import type { SpeechCallContext } from "./speech-context.ts";

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

/**
 * D-405: eierens stemmeinnstillinger (kun AVSPILLING - ingen autoritet/data). Alle verdier valideres og klemmes i `sanitizeVoiceSettings`;
 * standardverdiene gir NØYAKTIG dagens oppførsel (ingen ekstra flagg sendes til motoren).
 */
export interface VoiceSettings {
  /** Talehastighet som multiplikator (1 = normal). */
  speed: number;
  /** Uttrykksfullhet/variasjon som multiplikator (1 = motorens standard). Kun motorer som støtter det (Piper). */
  expressiveness: number;
  /** Pause mellom setninger i millisekunder (200 = Pipers standard). Kun motorer som støtter det (Piper). */
  pause_ms: number;
}

export type TtsOptions = Partial<VoiceSettings>;

/** Hva en motor faktisk kan justere - sendes til klienten slik at UI-et aldri lover noe motoren ikke gjør. */
export interface VoiceCapabilities {
  speed: boolean;
  expressiveness: boolean;
  pause: boolean;
}

export const DEFAULT_VOICE_SETTINGS: Readonly<VoiceSettings> = { speed: 1, expressiveness: 1, pause_ms: 200 };
export const VOICE_SETTING_LIMITS = {
  speed: { min: 0.6, max: 1.6 },
  expressiveness: { min: 0.3, max: 1.5 },
  pause_ms: { min: 0, max: 1500 }
} as const;

/** Klemmer innkommende (ubetrodd) input til gyldige verdier; ugyldige/manglende felt faller til standard. */
export function sanitizeVoiceSettings(raw: unknown): VoiceSettings {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (key: keyof VoiceSettings): number => {
    const v = src[key];
    const lim = VOICE_SETTING_LIMITS[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_VOICE_SETTINGS[key];
    return Math.min(lim.max, Math.max(lim.min, v));
  };
  return { speed: num("speed"), expressiveness: num("expressiveness"), pause_ms: Math.round(num("pause_ms")) };
}

/**
 * Piper-flagg for innstillingene. KUN verdier som avviker fra standard gir flagg - standardinnstillinger sender ingenting og gir bit-identisk
 * oppførsel som før. (`--length_scale`: høyere = saktere, derfor 1/speed. Pipers egne CLI-standarder: noise_scale 0.667, noise_w 0.8,
 * sentence_silence 0.2 s.) UVERIFISERT mot akkurat den installerte piper-binæren; feiler et kall med egne flagg, kjøres det på nytt uten.
 */
export function piperArgsFor(options: TtsOptions | undefined): string[] {
  if (!options) return [];
  const s = { ...DEFAULT_VOICE_SETTINGS, ...options };
  const args: string[] = [];
  if (Math.abs(s.speed - 1) > 0.005) args.push("--length_scale", (1 / s.speed).toFixed(3));
  if (Math.abs(s.expressiveness - 1) > 0.005) {
    args.push("--noise_scale", (0.667 * s.expressiveness).toFixed(3), "--noise_w", (0.8 * s.expressiveness).toFixed(3));
  }
  if (Math.abs(s.pause_ms - DEFAULT_VOICE_SETTINGS.pause_ms) >= 1) args.push("--sentence_silence", (s.pause_ms / 1000).toFixed(3));
  return args;
}

export interface TtsAdapter {
  readonly name: string;
  /** D-405: hva som kan justeres per sesjon (udefinert = ingenting). */
  readonly voiceCapabilities?: VoiceCapabilities;
  /**
   * D-122: samme erklæring som `SttAdapter.processor`. TTS er tatt med fordi
   * SVAR-teksten fra en `health`-samtale er like avslørende som spørsmålet -
   * å beskytte kun STT ville lekket halve samtalen.
   */
  readonly processor: SpeechProcessorDeclaration;
  /**
   * D-390: samplerate (Hz) på PCM16-rammene adapteren leverer. Sendes til klienten i `started`-meldingen så avspillingen bruker
   * RIKTIG rate - før dette antok `voice.html` alltid 24 kHz (OpenAI), som spilte piper (22 050 Hz) ~9 % for fort/lyst og
   * ElevenLabs (16 kHz) 50 % for fort. Udefinert = 24 000 (bakoverkompatibelt med testadaptere uten feltet).
   */
  readonly sampleRate?: number;
  available(): boolean;
  /**
   * `context` (WP-V2, K4): sesjonens memory space og tillitsnivå. Enkle adaptere ignorerer den; en failover-adapter bruker den til å
   * dømme sin RESERVE-behandler mot samme rutingport som primæren (D-122).
   */
  synthesize(text: string, options?: TtsOptions, context?: SpeechCallContext): TtsPlayback;
  /** WP-V2: valgfri, hemmelighetsfri driftsstatus til `/status` (samplerate-kilde, ikke-tilgjengelighetsårsak, failover-tilstand). */
  status?(): Record<string, unknown>;
}

export const DEFAULT_TTS_SAMPLE_RATE = 24_000;

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
  /** Rammene under er 20 ms @ 16 kHz. */
  readonly sampleRate = 16_000;
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

/**
 * WP-V2 (K4): felles strømming av rå PCM over HTTP for OpenAI og ElevenLabs. Hver forespørsel har en TOTAL frist (`timeoutMs`),
 * og `cancel()` (barge-in) aborterer selve `fetch` via `controller` - ikke bare et flagg som først leses ved neste `read()` (en
 * `read()` som henger ville ellers aldri sett flagget). Feilkoder er korte koder (aldri leverandørtekst eller URL).
 */
async function* streamHttpPcm(request: {
  url: string;
  init: RequestInit;
  timeoutMs: number;
  codePrefix: string;
  controller: AbortController;
  isCancelled: () => boolean;
}): AsyncIterable<Buffer> {
  const deadline = deadlineSignal(request.timeoutMs, request.controller.signal);
  try {
    let response: Response;
    try {
      response = await fetch(request.url, { ...request.init, signal: deadline.signal });
    } catch {
      if (request.isCancelled()) {
        return;
      }
      throw new Error(deadline.timedOut() ? `${request.codePrefix}_timeout` : `${request.codePrefix}_network_error`);
    }
    if (!response.ok || !response.body) {
      if (typeof response.body?.cancel === "function") {
        void Promise.resolve(response.body.cancel()).catch(() => undefined);
      }
      throw new Error(`${request.codePrefix}_error_${response.status}`);
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        if (request.isCancelled()) {
          return;
        }
        let step: { done: boolean; value?: Uint8Array };
        try {
          step = await reader.read();
        } catch {
          if (request.isCancelled()) {
            return;
          }
          throw new Error(deadline.timedOut() ? `${request.codePrefix}_timeout` : `${request.codePrefix}_stream_error`);
        }
        if (step.done) {
          return;
        }
        yield Buffer.from(step.value ?? new Uint8Array(0));
      }
    } finally {
      void Promise.resolve(reader.cancel()).catch(() => undefined);
    }
  } finally {
    deadline.dispose();
  }
}

/** Standard totalfrist for én TTS-chunk over HTTP (ms). En chunk er maks ca. 320 tegn; OpenAI/ElevenLabs bruker typisk et par sekunder. */
export const DEFAULT_TTS_HTTP_TIMEOUT_MS = 30_000;

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
  /** `response_format: "pcm"` er PCM16 mono 24 kHz. */
  readonly sampleRate = 24_000;
  constructor(
    private readonly apiKey: string | undefined = process.env["OPENAI_API_KEY"],
    private readonly model: string = "gpt-4o-mini-tts",
    private readonly voice: string = "alloy",
    private readonly timeoutMs: number = DEFAULT_TTS_HTTP_TIMEOUT_MS
  ) {}

  available(): boolean {
    return Boolean(this.apiKey);
  }

  /** D-405: OpenAI sitt tale-API har `speed` (0.25-4.0); uttrykk/pause finnes ikke der. */
  readonly voiceCapabilities: VoiceCapabilities = { speed: true, expressiveness: false, pause: false };

  synthesize(text: string, options?: TtsOptions): TtsPlayback {
    if (!this.apiKey) {
      throw new Error("openai_tts_not_configured");
    }
    const { apiKey, model, voice, timeoutMs } = this;
    const speed = options?.speed !== undefined && Math.abs(options.speed - 1) > 0.005 ? options.speed : undefined;
    let cancelled = false;
    const controller = new AbortController();
    const frames = streamHttpPcm({
      url: "https://api.openai.com/v1/audio/speech",
      init: {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, voice, input: text, response_format: "pcm", ...(speed !== undefined ? { speed } : {}) })
      },
      timeoutMs,
      codePrefix: "openai_tts",
      controller,
      isCancelled: () => cancelled
    });
    return {
      frames,
      cancel: () => {
        cancelled = true;
        controller.abort();
      }
    };
  }
}

/**
 * D-319 (harder-tier tale-backlog, Tobias direkte i chat: "Bygg videre" - D-64-
 * stil sjekk mot `SpeechAdapter`-arkitekturen gjort FØR bygging, som lovet i
 * PROJECT_STATUS.md): FØRSTE tale-backlog-punkt (`elevenlabs`) løftet ut av
 * `connector-registry.ts` sin backlog og bygget som en NY `TtsAdapter`-
 * implementasjon her - IKKE en `ToolGateway`-connector. `elevenlabs` sto
 * opprinnelig i `connector-registry.ts` under §4.7 "Tale/video/media-AI"
 * sammen med de andre backlog-punktene, men CLAUDE.md regel 3 (alle
 * leverandører bak adaptere, `SpeechAdapter` eksplisitt navngitt) og D-122
 * sin `PROCESSOR_REGION_MATRIX.md`-port gjelder ALLE STT/TTS-leverandører,
 * uansett hvor de opprinnelig ble listet - en `ElevenLabsTransport` i
 * `live-transports.ts` ville vært STRUKTURELT FEIL (samme domenegrense-feil
 * D-64 finnes for å forhindre, bare på tale-siden i stedet for CRM/tickets).
 *
 * `processor.processor_terms_status` er BEVISST `"NOT_VERIFIED"`
 * (fail-closed default, ALDRI utledet av Jarvis selv - se `speech.ts` sin
 * egen doc-kommentar) - IKKE `"VERIFIED"` slik OpenAI (D-226) er, fordi DEN
 * statusen krever en EKTE eier-/juridisk handling (Tobias sin egen gjennomgang
 * av leverandørens Data controls-side, SAMME Q-32-mønster som OpenAI) som
 * ALDRI har skjedd for ElevenLabs. `evaluateSpeechRouting()` avviser derfor
 * denne behandleren for ALLE memory spaces inntil Tobias selv gjør den
 * gjennomgangen og `PROCESSOR_REGION_MATRIX.md` sin nye ElevenLabs-rad
 * oppdateres til `VERIFIED` - EKSAKT samme "kode finnes, gated til eier
 * handler"-disiplin som `PENDING_CREDENTIALS`-mønsteret i
 * `connector-registry.ts`, bare håndhevet av en ANNEN port (`speech.ts`,
 * ikke `ToolGateway`).
 *
 * BEVISST IKKE wiret inn i `main.ts` sin aktive adapter-utvelgelse i denne
 * sliceen: Tobias sin lokale piper-installasjon er ALLEREDE host-verifisert
 * fungerende (D-223) - å legge `ElevenLabsTts` inn i utvelgelseskjeden ville
 * risikert å FORTRENGE en allerede fungerende, ren lokal løsning med en
 * behandler `evaluateSpeechRouting()` uansett avviser (routingen har INGEN
 * stille fallback til neste adapter når en aktiv adapter blir avvist - D-122
 * sin "fail-closed, aldri stille sky-fallback"-disiplin, samme regelform som
 * `isSensitivityEligible()`). Wiring inn i den aktive kjeden er en EGEN,
 * senere beslutning Tobias selv tar når/hvis kontovilkårene er gjennomgått.
 *
 * API-formen (`POST /v1/text-to-speech/{voice_id}`, `xi-api-key`-header,
 * `output_format=pcm_16000`-query-parameter for RÅ PCM S16LE 16kHz - SAMME
 * samplerate som resten av tale-pipelinen bruker internt, IKKE OpenAI sin
 * 24kHz-respons sitt kjente re-samplings-gap) er ElevenLabs sin langvarig
 * dokumenterte, stabile REST-API-konvensjon - SAMME D-297-ærlighetsforbehold
 * som resten av denne økten: trent kunnskap, IKKE denne-økten-verifisert mot
 * live dokumentasjon (nettverksegress til `elevenlabs.io`/doc-domener
 * blokkert denne økten, forsøkt og bekreftet FØR denne sliceen ble valgt).
 */
export class ElevenLabsTts implements TtsAdapter {
  readonly name = "elevenlabs-tts";
  /** EKSTERN databehandler - se klassekommentaren for D-319/Q-32-status. */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "elevenlabs-text-to-speech",
    locality: "external",
    processor_row_declared: true,
    processor_terms_status: "NOT_VERIFIED"
  };
  /** `output_format=pcm_16000`. */
  readonly sampleRate = 16_000;
  constructor(
    private readonly apiKey: string | undefined = process.env["JARVIS_ELEVENLABS_API_KEY"],
    /** Påkrevd i selve URL-stien - ElevenLabs har intet "standard stemme"-endepunkt. */
    private readonly voiceId: string | undefined = process.env["JARVIS_ELEVENLABS_VOICE_ID"],
    private readonly modelId: string = "eleven_multilingual_v2",
    private readonly timeoutMs: number = DEFAULT_TTS_HTTP_TIMEOUT_MS
  ) {}

  /** Stemme-ID-en er like påkrevd som nøkkelen - ElevenLabs kan strukturelt ikke kalles uten den. */
  available(): boolean {
    return Boolean(this.apiKey) && Boolean(this.voiceId);
  }

  synthesize(text: string): TtsPlayback {
    if (!this.apiKey || !this.voiceId) {
      throw new Error("elevenlabs_tts_not_configured");
    }
    const { apiKey, voiceId, modelId, timeoutMs } = this;
    let cancelled = false;
    const controller = new AbortController();
    const frames = streamHttpPcm({
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_16000`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": apiKey },
        body: JSON.stringify({ text, model_id: modelId })
      },
      timeoutMs,
      codePrefix: "elevenlabs_tts",
      controller,
      isCancelled: () => cancelled
    });
    return {
      frames,
      cancel: () => {
        cancelled = true;
        controller.abort();
      }
    };
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
export type PiperSampleRateSource = "env" | "model_config" | "default" | "constructor";

export interface PiperSampleRate {
  rate: number;
  source: PiperSampleRateSource;
  /** Satt når miljøvariabelen og stemmemodellens egen konfig er uenige (env vinner, men avviket logges). */
  mismatch?: { env: number; model_config: number };
}

export const DEFAULT_PIPER_SAMPLE_RATE = 22_050;

function plausibleSampleRate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 8_000 && value <= 96_000 ? value : undefined;
}

/**
 * WP-V2 (K6b, JARVIS-080): samplerate for piper-rammene.
 * Prioritet: (1) `JARVIS_PIPER_SAMPLE_RATE` (eierens eksplisitte overstyring), (2) stemmens egen `<modell>.onnx.json` -
 * `audio.sample_rate` (piper-stemmer leveres med en slik konfigfil ved siden av modellen; FORMATET er UVERIFISERT mot offisiell
 * dokumentasjon inntil eieren har lest en ekte fil, se runbook WPV2 - derfor tolkes kun et heltall i 8 000-96 000 Hz, alt annet
 * ignoreres), (3) 22 050 Hz. Kilden rapporteres i `/status` og i oppstartsloggen; et avvik mellom env og modellfil logges.
 */
export function resolvePiperSampleRate(
  modelPath: string | undefined,
  envValue: string | undefined,
  readConfig: (path: string) => string | undefined = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }
): PiperSampleRate {
  const envRate = envValue !== undefined && envValue.trim() !== "" ? plausibleSampleRate(Number(envValue)) : undefined;
  let modelRate: number | undefined;
  if (modelPath) {
    const raw = readConfig(`${modelPath}.json`);
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as { audio?: { sample_rate?: unknown } };
        modelRate = plausibleSampleRate(parsed?.audio?.sample_rate);
      } catch {
        modelRate = undefined;
      }
    }
  }
  if (envRate !== undefined) {
    return {
      rate: envRate,
      source: "env",
      ...(modelRate !== undefined && modelRate !== envRate ? { mismatch: { env: envRate, model_config: modelRate } } : {})
    };
  }
  if (modelRate !== undefined) {
    return { rate: modelRate, source: "model_config" };
  }
  return { rate: DEFAULT_PIPER_SAMPLE_RATE, source: "default" };
}

/** Standard maksvarighet for ÉN piper-chunk (ms) - en prosess som ikke er ferdig innen dette drepes (hele prosessgruppen). */
export const DEFAULT_PIPER_CHUNK_TIMEOUT_MS = 60_000;

/** Prosess-delt standardsemafor (brukes når ingen injiseres). `main.ts` injiserer et eget med grensen fra `VoiceLimits`. */
const DEFAULT_PIPER_SLOTS = new ProcessSlots(4, DEFAULT_VOICE_LIMITS.processQueueTimeoutMs, DEFAULT_VOICE_LIMITS.reservedProvenSlots);

export class LocalPiperTts implements TtsAdapter {
  readonly name = "local-piper";
  /** Lokal binær - tekst/lyd forlater aldri maskinen. */
  readonly processor: SpeechProcessorDeclaration = {
    processor_id: "local-piper",
    locality: "local",
    processor_row_declared: true,
    processor_terms_status: "NOT_APPLICABLE_LOCAL"
  };
  /**
   * D-390/WP-V2 (K6b): samplerate (Hz) for rammene. Kilden er `sampleRateSource` (env > stemmens `.onnx.json` > 22 050). Adapteren
   * re-samplerer ikke selv; klienten spiller av i denne raten (`started.tts_sample_rate`).
   */
  readonly sampleRate: number;
  readonly sampleRateSource: PiperSampleRateSource;
  private readonly sampleRateMismatch: PiperSampleRate["mismatch"];
  /** FIX-7: `available()` går hit (5 s cache) i stedet for synkron stat/access ved hvert kall (hver TTS-chunk via `usableReserve`, og `/health`). */
  private readonly availability: AvailabilityCache;
  constructor(
    private readonly binPath: string | undefined = process.env["JARVIS_PIPER_BIN"],
    private readonly modelPath: string | undefined = process.env["JARVIS_PIPER_MODEL"],
    /** Eksplisitt rate (tester/kode) - hopper over env/modellkonfig. Udefinert = `resolvePiperSampleRate`. */
    sampleRate?: number,
    /** WP-V2 (K2): samtidige piper-prosesser (delt). */
    private readonly slots: ProcessSlots = DEFAULT_PIPER_SLOTS,
    /** WP-V2 (K4): maks varighet per chunk (ms). */
    private readonly chunkTimeoutMs: number = DEFAULT_PIPER_CHUNK_TIMEOUT_MS,
    /** FIX-7: klokke for tilgjengelighets-cachen (tester). */
    now: () => number = Date.now
  ) {
    this.availability = new AvailabilityCache(() => probeLocalBinary(this.binPath, this.modelPath), AVAILABILITY_CACHE_MS, now);
    if (typeof sampleRate === "number" && Number.isFinite(sampleRate) && sampleRate > 0) {
      this.sampleRate = sampleRate;
      this.sampleRateSource = "constructor";
    } else {
      const resolved = resolvePiperSampleRate(modelPath, process.env["JARVIS_PIPER_SAMPLE_RATE"]);
      this.sampleRate = resolved.rate;
      this.sampleRateSource = resolved.source;
      this.sampleRateMismatch = resolved.mismatch;
      if (resolved.mismatch) {
        console.warn(JSON.stringify({ msg: "piper_sample_rate_mismatch", ...resolved.mismatch, using: resolved.rate }));
      }
    }
  }

  /**
   * WP-V2 (K1c, audit D1): `available()` sjekker nå at binæren FINNES og er kjørbar og at stemmemodellen er lesbar - ikke bare at
   * miljøvariablene er satt. En feil konfigurasjon gir dermed `NOT_CONFIGURED` i `/health` (503) i stedet for et spawn-feil midt i en samtale.
   * Årsaken (`unavailableReason`) er en kort kode uten stier.
   */
  available(): boolean {
    return this.unavailableReason() === undefined;
  }

  unavailableReason(): LocalBinaryProblem | undefined {
    return this.availability.get();
  }

  status(): Record<string, unknown> {
    const reason = this.unavailableReason();
    return {
      sample_rate_source: this.sampleRateSource,
      ...(this.sampleRateMismatch ? { sample_rate_mismatch: this.sampleRateMismatch } : {}),
      ...(reason !== undefined ? { unavailable_reason: reason } : {}),
      process_slots: { max: this.slots.max, in_use: this.slots.inUse, queued: this.slots.queued, reserved_for_proven: this.slots.reservedForProven }
    };
  }

  /** D-405: piper kan justere hastighet (length_scale), uttrykk (noise_scale/noise_w) og setningspause (sentence_silence). */
  readonly voiceCapabilities: VoiceCapabilities = { speed: true, expressiveness: true, pause: true };

  /** `context` (FIX-4): kun `SERVER_VERIFIED` får de reserverte prosessplassene; manglende kontekst regnes som ubevist (fail-closed). */
  synthesize(text: string, options?: TtsOptions, context?: SpeechCallContext): TtsPlayback {
    if (!this.binPath || !this.modelPath) {
      throw new Error("local_piper_not_configured");
    }
    const { binPath, modelPath, slots, chunkTimeoutMs } = this;
    const unproven = context?.authority !== "SERVER_VERIFIED";
    const extraArgs = piperArgsFor(options);
    let cancelled = false;
    let child: ReturnType<typeof spawn> | undefined;
    /** Avbryter en ventende plassforespørsel (barge-in mens chunken står i prosesskøen). */
    const cancelController = new AbortController();
    /**
     * Plassen frigjøres av `cancel()` OGSÅ - ikke bare av generatorens `finally`. En generator som konsumenten forlater uten å
     * kalle `return()` (en forhåndshentet chunk som aldri spilles) står ellers evig parkert ved `yield` og holder plassen.
     */
    let releaseSlot: (() => void) | undefined;
    /**
     * FIX-9: plassen gis tilbake når prosessen er DØD (`exit`), ikke ved SIGTERM - ellers kunne en ny piper starte oppå en som ennå dør, og taket gjaldt
     * generatorer, ikke prosesser. En prosess som ignorerer SIGTERM trappes opp til SIGKILL etter 2 s (selv om generatoren er parkert og aldri når sin egen
     * `finally`), og en sikkerhetstimer (5 s) gir plassen tilbake uansett så den aldri blir hengende. `release` er idempotent.
     */
    const releaseWhenGone = (): void => {
      const release = releaseSlot;
      if (!release) {
        return;
      }
      const proc = child;
      // Ingen prosess (aldri startet) eller en som allerede er død - også en spawn-feil (Node setter da `exitCode` til en negativ errno og sender kun `close`, ikke `exit`): gi plassen tilbake nå.
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
        release();
        return;
      }
      const escalate = setTimeout(() => killProcessGroup(proc, "SIGKILL"), 2_000);
      const safety = setTimeout(release, 5_000);
      escalate.unref();
      safety.unref();
      proc.once("exit", () => {
        clearTimeout(escalate);
        clearTimeout(safety);
        release();
      });
    };
    async function* spawnAndStream(extra: string[]): AsyncIterable<Buffer> {
      // `detached: true` (POSIX): piper blir gruppeleder for en NY
      // prosessgruppe - `killProcessGroup()` under kan da drepe HELE
      // undertreet (`-pid`), ikke kun selve piper-PID-en. Nødvendig fordi et
      // reelt binær-kall i praksis kan spawne egne barneprosesser som ARVER
      // stdout-pipen - å drepe KUN toppen ville da latt pipen forbli åpen
      // (Node ser aldri EOF) og cancel() ville hengt til den underliggende
      // prosessen selv ga opp, EKSAKT det §15/§16 (barge-in) forbyr. Bevist
      // av `test/local-piper-tts.test.ts` sin `mock-piper-hang.sh`.
      const proc = spawn(binPath, ["--model", modelPath, "--output_raw", ...extra], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true
      });
      child = proc;
      let stderr = "";
      let stdinError: Error | null = null;
      let spawnError: NodeJS.ErrnoException | null = null;
      let streamError: NodeJS.ErrnoException | null = null;
      let timedOut = false;
      // WP-V2 (K1b, audit A1): UTEN en `error`-lytter på selve prosessen er en spawn-feil (ENOENT/EACCES - feil `JARVIS_PIPER_BIN`,
      // slettet binær) en uhåndtert `error`-hendelse, og Node kaster den som uncaughtException = HELE voice-gateway-prosessen
      // krasjer. Samme mønster som `LocalWhisperStt` (`proc.once("error", ...)`). Feilen kastes etter strømmen som en kode.
      proc.once("error", (err: Error) => {
        spawnError = err as NodeJS.ErrnoException;
      });
      proc.stderr.on("data", (d: Buffer) => {
        if (stderr.length < 4096) {
          stderr += d.toString("utf8");
        }
      });
      // Samme klasse: en feil på stdout/stderr-strømmene skal aldri bli uhåndtert.
      proc.stderr.on("error", () => undefined);
      proc.stdout.on("error", (err: Error) => {
        streamError = err as NodeJS.ErrnoException;
      });
      // D-256: SAMME bug-klasse som `LocalWhisperStt.end()` (se stt.ts sin
      // kommentar) - avslutter/lukker piper sin egen stdin FØR `.end(text)`
      // er ferdigskrevet, feiler skrivingen med EPIPE. Uten en egen lytter
      // her ville det vært en UHÅNDTERT "error"-hendelse på understrømmen
      // `proc.stdin`, ALDRI fanget av `proc.once("close", ...)` under - Node
      // kaster/krasjer HELE voice-gateway-prosessen på nøyaktig samme måte.
      proc.stdin.on("error", (err: Error) => {
        stdinError = err;
      });
      proc.stdin.end(text);
      const exitCode = new Promise<number | null>((resolve) => proc.once("close", resolve));
      // WP-V2 (K4): en piper-prosess som ikke er ferdig innen `chunkTimeoutMs` drepes (hele gruppen, SIGKILL) - ellers blokkerer en
      // hengende chunk alle senere chunker i sesjonen.
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(proc, "SIGKILL");
      }, chunkTimeoutMs);
      try {
        for await (const chunk of proc.stdout) {
          if (cancelled) {
            return;
          }
          yield chunk as Buffer;
        }
      } catch (err) {
        if (!cancelled) {
          streamError = err as NodeJS.ErrnoException;
        }
      } finally {
        clearTimeout(timer);
        killProcessGroup(proc);
        // Et prosesstre som ignorerer SIGTERM skal aldri få henge `await exitCode` under: opptrapping til SIGKILL.
        const escalation = setTimeout(() => killProcessGroup(proc, "SIGKILL"), 2_000);
        escalation.unref();
        void exitCode.then(() => clearTimeout(escalation));
      }
      const code = await exitCode;
      if (cancelled) {
        return;
      }
      if (spawnError) {
        throw new Error(`local_piper_spawn_failed:${(spawnError as NodeJS.ErrnoException).code ?? "unknown"}`);
      }
      if (timedOut) {
        throw new Error("local_piper_timeout");
      }
      if (streamError) {
        throw new Error(`local_piper_stdout_failed:${(streamError as NodeJS.ErrnoException).code ?? "unknown"}`);
      }
      if (code !== 0) {
        const detail = stdinError
          ? `${stderr.slice(0, 150)} (stdin write: ${(stdinError as Error).message})`
          : stderr.slice(0, 200);
        throw new Error(`local_piper_process_failed:${code ?? "unknown"}:${detail}`);
      }
    }
    async function* runOnce(extra: string[]): AsyncIterable<Buffer> {
      if (cancelled) {
        return;
      }
      // WP-V2 (K2): samtidige piper-prosesser er begrenset (delt semafor). Køen har en frist -> `VoiceBusyError` ("voice_busy").
      let release: () => void;
      try {
        release = await slots.acquire(cancelController.signal, { unproven });
      } catch (err) {
        if (cancelled) {
          return;
        }
        throw err;
      }
      releaseSlot = release;
      // FIX-9: `cancel()` kan ha kommet etter at plassen ble innvilget, men før denne fortsettelsen (mikro-vindu) - da startes ingen prosess, og plassen gis tilbake.
      if (cancelled) {
        release();
        return;
      }
      try {
        yield* spawnAndStream(extra);
      } finally {
        releaseWhenGone();
      }
    }
    /**
     * D-405: egne stemmeflagg er UVERIFISERT mot akkurat den installerte piper-binæren. Feiler kallet FØR noen lyd er levert, kjøres det
     * på nytt med standardflagg (aldri stille - logget) i stedet for at et ugyldig flagg gjør Jarvis stum. Standardinnstillinger = én kjøring, uendret.
     */
    async function* generate(): AsyncIterable<Buffer> {
      const attempts: string[][] = extraArgs.length > 0 ? [extraArgs, []] : [[]];
      for (let i = 0; i < attempts.length; i++) {
        let yielded = false;
        try {
          for await (const chunk of runOnce(attempts[i] ?? [])) {
            yielded = true;
            yield chunk;
          }
          return;
        } catch (err) {
          // En spawn-feil/timeout/opptatt-kø skal ALDRI prøves på nytt med standardflagg - det var ikke flaggene som feilet.
          const retriable = !(err instanceof VoiceBusyError) && !/^local_piper_(spawn_failed|timeout)/.test((err as Error).message);
          if (cancelled || yielded || i === attempts.length - 1 || !retriable) {
            throw err;
          }
          console.warn(JSON.stringify({ msg: "piper_custom_voice_params_failed_retry_default", reason: (err as Error).message.slice(0, 120) }));
        }
      }
    }
    return {
      frames: generate(),
      cancel(): void {
        cancelled = true;
        cancelController.abort();
        if (child) {
          killProcessGroup(child);
        }
        releaseWhenGone();
      }
    };
  }
}
