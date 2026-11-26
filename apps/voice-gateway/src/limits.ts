import type { IncomingMessage } from "node:http";

/**
 * WP-V2 (K2, JARVIS-063 voice-delen): kapasitet og rate limit for Voice Gateway.
 *
 * Alle grenser er KONSTANTER med begrunnelse (docs/runbooks/WPV2_VOICE_ROBUSTNESS.md) - ingen nye miljøflagg. De kan overstyres
 * kun via `VoiceGatewayOptions.limits` (brukt av tester og eventuelt en fremtidig, bevisst konfigurasjon).
 *
 * Prinsipp: en grense som brytes gir en DEFINERT feilkode eller lukking (aldri et krasj), og påvirker aldri andre tilkoblinger.
 */
export interface VoiceLimits {
  /** Maks størrelse på én WebSocket-melding (byte). Nettleserens 64 ms-ramme (2 048 byte PCM16) er ca. 2,8 KB som base64 i JSON. */
  maxPayloadBytes: number;
  /** Maks DEKODET lydramme (byte). 16 KiB = 512 ms @16 kHz PCM16 - godt over nettleserens 64 ms og satellittens 20 ms. */
  maxAudioFrameBytes: number;
  /** Maks samtidige tilkoblinger totalt. */
  maxConnections: number;
  /** Maks samtidige tilkoblinger per peer (se `peerKey`). */
  maxConnectionsPerPeer: number;
  /**
   * FIX-2 (F2): maks UBEVISTE sesjoner (`start` uten enhetsbevis) per peer. Bak en Docker-bridge/proxy uten brukbar `X-Forwarded-For` er «peer» den
   * samme adressen for ALLE klienter (NOT VERIFIED: faktisk topologi med Tailscale Serve er ikke målt), så fire ubeviste klienter kunne før
   * utarme eierens egne enheter (målt: «eier» fikk `voice_busy` mens 4 ubeviste hvilte). Bevist enhet = Core har autorisert den: de telles
   * ikke her og kastes aldri ut. En start over taket gir `voice_busy`; den eksisterende sesjonen røres ikke.
   */
  maxUnprovenPerPeer: number;
  /**
   * FIX-9 (F9): en AVVIST tilkobling (1013) får så lenge (ms) på å svare på close-rammen før socketen termineres. `ws` venter ellers 30 s, og en rå
   * TCP-klient som aldri svarer holdt en fd per avviste forsøk (målt: 326 fd etter 500 forsøk). Close-rammen er allerede sendt; en klient som leser får den.
   */
  refusedCloseGraceMs: number;
  /**
   * FIX-2: en tilkobling som ikke har sendt en velformet `start` innen så lenge (ms) lukkes (1000 `start_timeout`). Frigjør plassen fra
   * tilkoblinger som aldri blir noe (ubevist sti: ellers holdt av enhver melding, opptil 30 min). Nettleseren sender `start` straks etter åpning.
   */
  startTimeoutMs: number;
  /** Token bucket for `audio`: jevn rate (nettleser ca. 16/s, 20 ms-satellitt 50/s) og burst. */
  audioFramesPerSecond: number;
  audioBurst: number;
  /** Token bucket for alle ANDRE meldinger (start, voice_sample, replay_final, voice_settings, ugyldig JSON): billige å sende, men dyre å utføre. */
  controlPerSecond: number;
  controlBurst: number;
  /**
   * FIX-3 (F3): byte-rate-bøtte for DEKODET lyd per tilkobling. Legitim lyd er PCM16 16 kHz mono = 32 000 byte/s i sanntid (nettleser og
   * satellitt); 64 KiB/s er 2x sanntid, og burst 512 KiB (16 s lyd) dekker innhenting etter en nettverksstans. Før var det kun rammegrensen
   * (100/s x 16 KiB = 1,6 MB/s, målt +2,2 MB/s per tilkobling) - 50x legitim rate. Brudd = 1008 `audio_rate_exceeded`.
   */
  audioBytesPerSecond: number;
  audioByteBurst: number;
  /**
   * FIX-3: maks byte lyd i ÉN tur. Legitim maks er VAD `maxTurnMs` 30 s = 960 000 byte; 2 MiB (65 s) er over det med god margin. Over taket
   * avsluttes turen med det som er mottatt (`turn_audio_limit`) og resten forkastes - bufferet (og Buffer.concat/WAV-kopiene) er dermed begrenset.
   */
  maxTurnBytes: number;
  /** FIX-3: maks ventende turer per sesjon (kjørende + køede i den serielle turkjeden). Over = `voice_busy`, turen forkastes. */
  maxPendingTurns: number;
  /** FIX-3: maks køede TTS-chunker per sesjon (en lang LLM-respons kan legitimt gi dusinvis). Over = chunken forkastes (`tts_queue_full`, én gang per overløp). */
  maxQueuedTtsChunks: number;
  /**
   * FIX-1 (F1): token bucket for WebSocket-KONTROLLRAMMER fra klienten - `ping` og UBEDT `pong`. `ws` svarer ellers automatisk på hver ping,
   * uten grense og før applikasjonen ser rammen (målt: 4,6 M pings på 10 s = serverens RSS 105 MB -> 2,1 GB). Legitim bruk er høyst én
   * ping per 20-30 s (satellitt-keepalive); en nettleser kan ikke sende ping i det hele tatt. Et brudd termineres umiddelbart.
   */
  pingPongPerSecond: number;
  pingPongBurst: number;
  /** Ingen melding fra klienten på så lenge (ms) lukker tilkoblingen (frigjør plass fra glemte/stille tilkoblinger). */
  idleTimeoutMs: number;
  /** Maks varighet (ms) for en tilkobling uten bevist enhet (en bevist sesjon har grant-levetiden, 15 min). */
  maxUnprovenSessionMs: number;
  /** Ping-intervall (ms); et uteblitt pong innen neste intervall terminerer tilkoblingen (halvåpne tilkoblinger). */
  pingIntervalMs: number;
  /** `ws.bufferedAmount` over dette (byte) = langsom forbruker: TTS avbrytes og tilkoblingen lukkes med 1013. */
  maxBufferedBytes: number;
  /** Maks antall meldinger som venter på behandling per tilkobling (serialisert kjede) før `overloaded`. */
  maxQueuedMessages: number;
  /** Maks lengde (tegn) for `replay_final.utterance_id` og `.text`. */
  maxUtteranceIdChars: number;
  maxReplayTextChars: number;
  /** Maks samtidige whisper-prosesser (CPU-tunge) og piper-prosesser (lette), og hvor lenge en forespørsel køer før `voice_busy`. */
  maxConcurrentWhisper: number;
  maxConcurrentPiper: number;
  processQueueTimeoutMs: number;
  /**
   * FIX-4 (F4): plasser i whisper-/piper-semaforene som er FORBEHOLDT bevisste sesjoner (`SERVER_VERIFIED`). Semaforene er globale, så en ubevist
   * klient kunne før holde alle plasser og sulte eierens STT (målt: seks klienter ga fire plasser og to `voice_busy`). Ubeviste får høyst
   * `max - reservedProvenSlots` samtidig. Prisen er ledig kapasitet når kun ubeviste kjører (whisper: 1 av 2) - bevisst: eierens tur må alltid komme igjennom.
   */
  reservedProvenSlots: number;
}

export const DEFAULT_VOICE_LIMITS: Readonly<VoiceLimits> = Object.freeze({
  maxPayloadBytes: 64 * 1024,
  maxAudioFrameBytes: 16 * 1024,
  maxConnections: 16,
  maxConnectionsPerPeer: 4,
  maxUnprovenPerPeer: 2,
  startTimeoutMs: 10_000,
  refusedCloseGraceMs: 2_000,
  audioFramesPerSecond: 100,
  audioBurst: 200,
  controlPerSecond: 5,
  controlBurst: 20,
  audioBytesPerSecond: 64 * 1024,
  audioByteBurst: 512 * 1024,
  maxTurnBytes: 2 * 1024 * 1024,
  maxPendingTurns: 8,
  maxQueuedTtsChunks: 128,
  pingPongPerSecond: 2,
  pingPongBurst: 10,
  idleTimeoutMs: 120_000,
  maxUnprovenSessionMs: 30 * 60_000,
  pingIntervalMs: 30_000,
  maxBufferedBytes: 1024 * 1024,
  maxQueuedMessages: 256,
  maxUtteranceIdChars: 128,
  maxReplayTextChars: 4_000,
  maxConcurrentWhisper: 2,
  maxConcurrentPiper: 4,
  processQueueTimeoutMs: 8_000,
  reservedProvenSlots: 1
});

export function resolveLimits(overrides?: Partial<VoiceLimits>): VoiceLimits {
  const out: VoiceLimits = { ...DEFAULT_VOICE_LIMITS };
  if (overrides) {
    for (const key of Object.keys(DEFAULT_VOICE_LIMITS) as Array<keyof VoiceLimits>) {
      const value = overrides[key];
      // Kun endelige, positive tall overstyrer - en ugyldig verdi skal aldri slå en grense AV (0/NaN/Infinity ville gjort det).
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        out[key] = value;
      }
    }
  }
  return out;
}

/** Token bucket: `ratePerSecond` jevnt, opptil `burst` samlet. Klokken er injiserbar for deterministiske tester. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number = () => performance.now()
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** true hvis `cost` token ble tatt; false = grensen er nådd (ingenting trekkes). */
  tryTake(cost = 1): boolean {
    const t = this.now();
    const elapsedSeconds = Math.max(0, (t - this.last) / 1000);
    this.last = t;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSecond);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Peer-nøkkel for per-peer-grensen. SPEILER `clientKey()` i apps/api/src/http-guard.ts (bevisst kopi - Voice Gateway er en egen
 * prosess og importerer aldri fra apps/api, CLAUDE.md regel 5): `X-Forwarded-For` stoles KUN når selve TCP-peeren er loopback
 * (lokal reverse proxy/Tailscale Serve), og da brukes SISTE element - det vår egen, betrodde proxy la til. Ellers kunne enhver
 * klient velge sin egen nøkkel og omgå per-peer-grensen.
 */
export function peerKey(req: Pick<IncomingMessage, "socket" | "headers">): string {
  const peer = req.socket.remoteAddress;
  if (isLoopback(peer)) {
    const fwd = req.headers["x-forwarded-for"];
    const parts = (Array.isArray(fwd) ? fwd.join(",") : fwd)?.split(",").map((p) => p.trim()).filter((p) => p.length > 0) ?? [];
    const last = parts[parts.length - 1];
    if (last) {
      return last;
    }
  }
  return peer ?? "unknown";
}

export type ConnectionRefusal = "global_limit" | "peer_limit";

/**
 * Hvor langt en tilkobling har kommet (FIX-2): `pending` = ingen velformet `start` ennå, `unproven` = startet uten enhetsbevis,
 * `proven` = Core har autorisert enheten. Kun `proven` er vernet mot utkasting.
 */
export type ConnectionState = "pending" | "unproven" | "proven";

/** Opak håndtak for én tilkobling i `ConnectionTracker` (gis til `claimUnproven`/`markProven`/`release`). */
export interface ConnectionTicket {
  readonly peer: string;
  state: ConnectionState;
  readonly evict: () => void;
}

export type AdmitResult = { ok: true; ticket: ConnectionTicket } | { ok: false; reason: ConnectionRefusal };

/**
 * Teller samtidige tilkoblinger totalt og per peer, og skiller BEVISTE fra ubeviste (FIX-2).
 *
 * Er det fullt (globalt eller for peeren), kastes den ELDSTE ikke-beviste tilkoblingen (pending/unproven) ut for å gi plass - en bevist enhet
 * skal alltid kunne koble til når det bare er ubeviste som fyller opp. Finnes ingen å kaste ut (alt er bevist), avvises den nye. Alder =
 * innsettingsrekkefølge. Når to tilkoblinger kan ha samme peer-adresse uten å være samme klient (proxy), er dette det som holder eieren inne.
 */
export class ConnectionTracker {
  private readonly tickets = new Set<ConnectionTicket>();
  constructor(
    private readonly maxTotal: number,
    private readonly maxPerPeer: number,
    private readonly maxUnprovenPerPeer: number = Number.POSITIVE_INFINITY
  ) {}

  /** Tar inn en ny tilkobling (eventuelt ved å kaste ut den eldste ubeviste; `evict` på DEN kalles). Ellers avslagsgrunnen - ingenting regnet med. */
  admit(peer: string, evict: () => void): AdmitResult {
    let victim: ConnectionTicket | undefined;
    if (this.activeFor(peer) >= this.maxPerPeer) {
      victim = this.oldestEvictable((t) => t.peer === peer);
      if (victim === undefined) {
        return { ok: false, reason: "peer_limit" };
      }
    } else if (this.tickets.size >= this.maxTotal) {
      victim = this.oldestEvictable(() => true);
      if (victim === undefined) {
        return { ok: false, reason: "global_limit" };
      }
    }
    if (victim !== undefined) {
      this.tickets.delete(victim);
      try {
        victim.evict();
      } catch {
        // Utkastelsen er best effort: den nye tilkoblingen tas inn uansett (plassen er allerede frigjort).
      }
    }
    const ticket: ConnectionTicket = { peer, state: "pending", evict };
    this.tickets.add(ticket);
    return { ok: true, ticket };
  }

  /** Enheten er bevist (Core har utstedt en grant): vernet mot utkasting, og teller ikke mot ubevist-taket. */
  markProven(ticket: ConnectionTicket): void {
    if (this.tickets.has(ticket)) {
      ticket.state = "proven";
    }
  }

  /** Tilkoblingen starter UBEVIST: `false` = peeren har allerede `maxUnprovenPerPeer` andre ubeviste sesjoner (eller tilkoblingen er kastet ut). */
  claimUnproven(ticket: ConnectionTicket): boolean {
    if (!this.tickets.has(ticket)) {
      return false;
    }
    if (ticket.state === "unproven") {
      return true;
    }
    if (this.unprovenFor(ticket.peer, ticket) >= this.maxUnprovenPerPeer) {
      return false;
    }
    ticket.state = "unproven";
    return true;
  }

  /** Idempotent: en allerede utkastet tilkobling er borte fra før. */
  release(ticket: ConnectionTicket): void {
    this.tickets.delete(ticket);
  }

  get active(): number {
    return this.tickets.size;
  }

  activeFor(peer: string): number {
    let n = 0;
    for (const t of this.tickets) if (t.peer === peer) n += 1;
    return n;
  }

  /** Antall ubeviste sesjoner for `peer` (unntatt `except`). */
  unprovenFor(peer: string, except?: ConnectionTicket): number {
    let n = 0;
    for (const t of this.tickets) if (t !== except && t.peer === peer && t.state === "unproven") n += 1;
    return n;
  }

  private oldestEvictable(match: (t: ConnectionTicket) => boolean): ConnectionTicket | undefined {
    for (const t of this.tickets) {
      if (t.state !== "proven" && match(t)) {
        return t;
      }
    }
    return undefined;
  }
}

/** Gitt av en avvist kø-/prosessplass: gatewayen er overbelastet, ikke ødelagt. Meldingen er den korte koden klienten ser. */
export class VoiceBusyError extends Error {
  constructor() {
    super("voice_busy");
    this.name = "VoiceBusyError";
  }
}

/**
 * Semafor for samtidige lokale whisper-/piper-prosesser. Køen har en FRIST (`queueTimeoutMs`): en forespørsel som ikke får plass
 * innen den avvises med `VoiceBusyError` i stedet for å vente uendelig. En vent kan også avbrytes (`signal`: barge-in/frakobling).
 */
/** Valg ved `ProcessSlots.acquire`. */
export interface SlotRequestOptions {
  /**
   * Ubevist forespørsel (sesjonen er ikke `SERVER_VERIFIED`): kan ikke ta de reserverte plassene. Standard `false` = bevist (bakoverkompatibelt for
   * kallere som ikke vet) - adapterne sender selv `true` med mindre konteksten er `SERVER_VERIFIED` (fail-closed).
   */
  unproven?: boolean;
}

interface Waiter {
  readonly unproven: boolean;
  readonly grant: () => void;
}

/**
 * Semafor for samtidige lokale whisper-/piper-prosesser. Køen har en FRIST (`queueTimeoutMs`): en forespørsel som ikke får plass
 * innen den avvises med `VoiceBusyError` i stedet for å vente uendelig. En vent kan også avbrytes (`signal`: barge-in/frakobling).
 *
 * FIX-4: `reservedForProven` plasser er forbeholdt bevisste forespørsler (klemt til `max - 1`, så ubeviste alltid kan bruke minst én plass).
 * Frigjøres en plass, går den til den FØRSTE ventende som faktisk kan få den - en ubevist som har nådd taket hoder ikke køen foran en bevist.
 */
export class ProcessSlots {
  private active = 0;
  private activeUnproven = 0;
  private readonly waiters = new Set<Waiter>();
  readonly reservedForProven: number;
  constructor(
    readonly max: number,
    private readonly queueTimeoutMs: number = DEFAULT_VOICE_LIMITS.processQueueTimeoutMs,
    reservedForProven = 0
  ) {
    const wanted = Number.isFinite(reservedForProven) ? Math.floor(reservedForProven) : 0;
    this.reservedForProven = Math.max(0, Math.min(wanted, max - 1));
  }

  get inUse(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.size;
  }

  /** Resolverer med en `release`-funksjon (idempotent). */
  acquire(signal?: AbortSignal, options: SlotRequestOptions = {}): Promise<() => void> {
    const unproven = options.unproven === true;
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    if (this.canGrant(unproven)) {
      this.take(unproven);
      return Promise.resolve(this.releaser(unproven));
    }
    return new Promise<() => void>((resolve, reject) => {
      const handle: { timer?: ReturnType<typeof setTimeout> } = {};
      const waiter: Waiter = {
        unproven,
        grant: (): void => {
          cleanup();
          this.take(unproven);
          resolve(this.releaser(unproven));
        }
      };
      const cleanup = (): void => {
        if (handle.timer !== undefined) clearTimeout(handle.timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(waiter);
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortError());
      };
      handle.timer = setTimeout(() => {
        cleanup();
        reject(new VoiceBusyError());
      }, this.queueTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  /** Ledig plass finnes, og en ubevist forespørsel kan ikke ta de reserverte. */
  private canGrant(unproven: boolean): boolean {
    if (this.active >= this.max) {
      return false;
    }
    return !unproven || this.activeUnproven < this.max - this.reservedForProven;
  }

  private take(unproven: boolean): void {
    this.active += 1;
    if (unproven) {
      this.activeUnproven += 1;
    }
  }

  private releaser(unproven: boolean): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      if (unproven) {
        this.activeUnproven -= 1;
      }
      this.drain();
    };
  }

  private drain(): void {
    for (const waiter of [...this.waiters]) {
      if (this.active >= this.max) {
        return;
      }
      if (this.canGrant(waiter.unproven)) {
        waiter.grant();
      }
    }
  }
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
