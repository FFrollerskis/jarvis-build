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
  /** Token bucket for `audio`: jevn rate (nettleser ca. 16/s, 20 ms-satellitt 50/s) og burst. */
  audioFramesPerSecond: number;
  audioBurst: number;
  /** Token bucket for alle ANDRE meldinger (start, voice_sample, replay_final, voice_settings, ugyldig JSON): billige å sende, men dyre å utføre. */
  controlPerSecond: number;
  controlBurst: number;
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
}

export const DEFAULT_VOICE_LIMITS: Readonly<VoiceLimits> = Object.freeze({
  maxPayloadBytes: 64 * 1024,
  maxAudioFrameBytes: 16 * 1024,
  maxConnections: 16,
  maxConnectionsPerPeer: 4,
  audioFramesPerSecond: 100,
  audioBurst: 200,
  controlPerSecond: 5,
  controlBurst: 20,
  idleTimeoutMs: 120_000,
  maxUnprovenSessionMs: 30 * 60_000,
  pingIntervalMs: 30_000,
  maxBufferedBytes: 1024 * 1024,
  maxQueuedMessages: 256,
  maxUtteranceIdChars: 128,
  maxReplayTextChars: 4_000,
  maxConcurrentWhisper: 2,
  maxConcurrentPiper: 4,
  processQueueTimeoutMs: 8_000
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

/** Teller samtidige tilkoblinger totalt og per peer. */
export class ConnectionTracker {
  private total = 0;
  private readonly perPeer = new Map<string, number>();
  constructor(
    private readonly maxTotal: number,
    private readonly maxPerPeer: number
  ) {}

  /** `null` = plass (og tilkoblingen er regnet med; kall `release` ved lukking). Ellers avslagsgrunnen (ingenting regnet med). */
  tryAcquire(peer: string): ConnectionRefusal | null {
    if (this.total >= this.maxTotal) {
      return "global_limit";
    }
    const current = this.perPeer.get(peer) ?? 0;
    if (current >= this.maxPerPeer) {
      return "peer_limit";
    }
    this.total += 1;
    this.perPeer.set(peer, current + 1);
    return null;
  }

  release(peer: string): void {
    const current = this.perPeer.get(peer) ?? 0;
    if (current <= 0) {
      return;
    }
    this.total = Math.max(0, this.total - 1);
    if (current === 1) {
      this.perPeer.delete(peer);
    } else {
      this.perPeer.set(peer, current - 1);
    }
  }

  get active(): number {
    return this.total;
  }

  activeFor(peer: string): number {
    return this.perPeer.get(peer) ?? 0;
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
export class ProcessSlots {
  private active = 0;
  private readonly waiters = new Set<() => void>();
  constructor(
    readonly max: number,
    private readonly queueTimeoutMs: number = DEFAULT_VOICE_LIMITS.processQueueTimeoutMs
  ) {}

  get inUse(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.size;
  }

  /** Resolverer med en `release`-funksjon (idempotent). */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const handle: { timer?: ReturnType<typeof setTimeout> } = {};
      const cleanup = (): void => {
        if (handle.timer !== undefined) clearTimeout(handle.timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(grant);
      };
      const grant = (): void => {
        cleanup();
        this.active += 1;
        resolve(this.releaser());
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
      this.waiters.add(grant);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.max && this.waiters.size > 0) {
      const next = this.waiters.values().next().value as (() => void) | undefined;
      if (next === undefined) {
        return;
      }
      next();
    }
  }
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
