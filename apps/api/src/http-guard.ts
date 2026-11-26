import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Remediering del 2 (JARVIS-001/063/064): felles HTTP-vern for API-et.
 *
 *  - body-størrelsesgrense FØR parsing (413), og malformed JSON er en klientfeil (400), aldri 500;
 *  - generiske feilsvar med request-ID (intern feiltekst/pg-feil/ID-er lekkes aldri til klienten);
 *  - per-nøkkel rate limit (per IP før autentisering, per device etter at grantet er løst).
 */

/** JSON-kropper på kontrollflatene er små (grant + noen felt). 64 KiB er rikelig. */
export const MAX_JSON_BODY_BYTES = 64 * 1024;
/** Webhook-kropper (Stripe/Vipps/...) kan være større, men grensen gjelder FØR signaturverifisering. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string
  ) {
    super(`${status} ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "HttpError";
  }
}

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

async function readLimited(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Slipp å lese noe som helst - og stopp videre opplasting.
    req.resume();
    throw new HttpError(413, "payload_too_large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      req.destroy();
      throw new HttpError(413, "payload_too_large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Parser en JSON-kropp med størrelsesgrense. Tom kropp = `{}`. Ugyldig JSON = 400 `malformed_json`. */
export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const raw = await readLimited(req, maxBytes);
  if (raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "malformed_json");
  }
}

/** Rå, byte-for-byte kropp for webhook-signaturer - men med størrelsesgrense FØR signaturkontrollen. */
export async function readRawBodyLimited(req: IncomingMessage, maxBytes = MAX_WEBHOOK_BODY_BYTES): Promise<Buffer> {
  return readLimited(req, maxBytes);
}

/**
 * WP-G1c fiks-runde 2 (FIX-2): lesevern for webhook-kropper som kan være store (Meta tillater 4 MiB før signaturen). Å holde en 4 MiB-kropp halvferdig koster 13,6 ganger så mye minne som for 256 KB-leverandørene (probe: 30 samtidige halvferdige kropper
 * holdt +110 MiB), og uten lesefrist kan en treg avsender holde dem i opptil Nodes `requestTimeout` (300 s). Derfor: (i) en lesefrist for HELE kroppen (`deadlineMs`; ved utløp lukkes forbindelsen og det kastes 408 `body_read_timeout`), og (ii) en
 * GLOBAL grense (`maxConcurrentLarge`) for samtidige lesinger som passerer `largeBytes` (256 KB): den som ikke får plass får 503 `webhook_busy` (kaller setter `Retry-After`). Plassen tas FØR lesingen når Content-Length er oppgitt (ellers når kroppen passerer
 * `largeBytes`; for en chunked kropp lukkes forbindelsen i stedet for å svare, som for 413) og frigis ALLTID (suksess, feil, avbrudd, utløp). Verdiene kan injiseres (`ApiDeps.comms.webhooks.bodyRead`) så testene kan bruke korte frister.
 */
export interface WebhookBodyReadConfig {
  readonly deadlineMs: number;
  readonly maxConcurrentLarge: number;
  readonly largeBytes: number;
  readonly retryAfterSeconds: number;
}
export const DEFAULT_WEBHOOK_BODY_READ: WebhookBodyReadConfig = { deadlineMs: 15_000, maxConcurrentLarge: 4, largeBytes: 256 * 1024, retryAfterSeconds: 5 };

export class WebhookBodyGuard {
  readonly config: WebhookBodyReadConfig;
  private active = 0;
  constructor(config: Partial<WebhookBodyReadConfig> = {}) {
    this.config = { ...DEFAULT_WEBHOOK_BODY_READ, ...config };
  }
  /** Antall lesinger som akkurat nå har tatt en plass (skal alltid være 0 når ingen lesing pågår). */
  get activeLargeReads(): number {
    return this.active;
  }
  /** Tar en plass for en stor lesing; `null` = full. Frigivelsen er idempotent. */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.config.maxConcurrentLarge) return null;
    this.active += 1;
    let released = false;
    return () => { if (!released) { released = true; this.active -= 1; } };
  }
}

const bodyGuards = new WeakMap<object, WebhookBodyGuard>();
/** Den ENE vakten per eier (webhook-oppsettet): samtidighetsgrensen er global for alle leverandører, ikke per forespørsel. */
export function webhookBodyGuardFor(owner: object, config?: Partial<WebhookBodyReadConfig>): WebhookBodyGuard {
  let guard = bodyGuards.get(owner);
  if (guard === undefined) { guard = new WebhookBodyGuard(config); bodyGuards.set(owner, guard); }
  return guard;
}

/** Som `readRawBodyLimited`, men med lesefrist og global samtidighetsgrense for store kropper (se `WebhookBodyReadConfig`). Kaster 413 `payload_too_large`, 408 `body_read_timeout` eller 503 `webhook_busy`. */
export async function readRawBodyGuarded(req: IncomingMessage, maxBytes: number, guard: WebhookBodyGuard): Promise<Buffer> {
  const { deadlineMs, largeBytes } = guard.config;
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    throw new HttpError(413, "payload_too_large");
  }
  const state = { release: null as (() => void) | null, timedOut: false };
  const reserve = (): boolean => { state.release ??= guard.tryAcquire(); return state.release !== null; };
  if (Number.isFinite(declared) && declared > largeBytes && !reserve()) {
    req.resume();
    throw new HttpError(503, "webhook_busy");
  }
  const timer = setTimeout(() => { state.timedOut = true; req.destroy(); }, deadlineMs);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) { req.destroy(); throw new HttpError(413, "payload_too_large"); }
      if (total > largeBytes && !reserve()) { req.destroy(); throw new HttpError(503, "webhook_busy"); }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    if (state.timedOut) throw new HttpError(408, "body_read_timeout");
    throw err;
  } finally {
    clearTimeout(timer);
    state.release?.();
  }
}

/** Vinduet-basert teller. Enkel og deterministisk (klokke injiserbar for test). */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    /** Øvre grense for antall nøkler - minnet er aldri ubegrenset (JARVIS-063). */
    private readonly maxKeys = 10_000
  ) {}

  /** `true` = innenfor grensen, `false` = avvis (429). */
  take(key: string): boolean {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      if (this.buckets.size >= this.maxKeys) {
        this.sweep(t);
        if (this.buckets.size >= this.maxKeys) {
          // Fail-closed under et nøkkelflom-angrep: nye nøkler avvises til vinduet utløper.
          return false;
        }
      }
      bucket = { count: 0, resetAt: t + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }

  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    return bucket ? Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000)) : 1;
  }

  private sweep(t: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= t) {
        this.buckets.delete(key);
      }
    }
  }
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Klient-IP for rate limiting. `X-Forwarded-For` stoles KUN på når selve TCP-peeren er loopback (Tailscale Serve/lokal reverse
 * proxy) - ellers kunne enhver klient velge sin egen rate-limit-nøkkel. Arkitekt-review (P3): vi bruker SISTE element (det vår egen,
 * betrodde proxy la til) - aldri det første, som en klient selv kan ha satt når proxyen appender i stedet for å overskrive.
 */
export function clientKey(req: IncomingMessage): string {
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

/**
 * Felter som aldri kan komme fra en klient-kropp på en grant-beskyttet rute:
 * identitet, tenant, person, enhet, sesjon, kanal og autentiseringsstyrke
 * utledes KUN server-side fra det verifiserte grantet.
 */
export const FORBIDDEN_IDENTITY_BODY_KEYS: ReadonlyArray<string> = [
  "identity", "person_id", "tenant_id", "memory_space", "memory_space_id", "session_id",
  "device_id", "channel", "auth_strength", "delegation_id", "owner_person_id", "actor_person_id"
];
