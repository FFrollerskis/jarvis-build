/**
 * Fenced, ABA-sikker portlei paa tvers av prosesser og verter (D-141 A).
 *
 * ------------------------------------------------------------------------
 * HVORFOR GENERASJONEN LIGGER I FILNAVNET
 * ------------------------------------------------------------------------
 *
 * D-139 skrev leien til én fast sti per port og tok over en stale leie ved aa
 * `rename`-e den stien vekk. Det ser atomisk ut, men `rename` er UBETINGET: den
 * flytter det som ligger der NAA, ikke det kalleren faktisk inspiserte. Derav
 * ABA-fletningen arkitekt-gjennomgangen fant:
 *
 *     P1 leser leien L      -> vurderer den stale
 *     P2 leser leien L      -> vurderer den stale, tar over, skriver EFTERFOELGER S
 *     P1 rename-r stien     -> river vekk S, en leie P1 aldri saa
 *
 * Det eneste virkelig betingede primitivet et filsystem gir oss er
 * `open(..., "wx")`: opprett-hvis-fraverende, atomisk, noeyaktig én vinner.
 * Saa vi slutter aa slette og begynner aa TELLE. Leien for port P er filen med
 * HOEYEST generasjon blant `P.<gen>.lease`, og aa ta over betyr aa opprette
 * `P.<gen+1>.lease` med "wx". To prosesser som begge leser generasjon 7 vil
 * begge proeve aa opprette generasjon 8; kjernen slipper gjennom én.
 *
 * To egenskaper faller direkte ut av dette, og de er nettopp de D-141 krever:
 *
 *   A.1  Overtakelse er betinget av den EKSAKTE generasjonen vi inspiserte.
 *        En taper oppretter ingenting og river ingenting vekk.
 *   A.3  `release` sletter filnavnet SITT EGET - og en etterfoelger har per
 *        konstruksjon et annet filnavn. Det er strukturelt umulig for en
 *        frigjoering aa fjerne en etterfoelger, ikke bare usannsynlig.
 *
 * ------------------------------------------------------------------------
 * HVEM SOM LEVER, OG HVA VI GJOER NAAR VI IKKE VET
 * ------------------------------------------------------------------------
 *
 * D-139 tok over enhver leie fra en annen vert, med begrunnelsen at pid-en
 * "ikke betyr noe her". Det er en fail-OPEN antakelse: en levende eier paa en
 * annen maskin ble stjaalet fra fordi vi ikke kunne sjekke den. Naa gjelder:
 *
 *   samme vert, eier LEVER          -> aldri, uansett alder
 *   samme vert, eier DOED, fersk    -> aldri (den kan vaere midt i oppstart)
 *   samme vert, eier DOED, gammel   -> kan tas over
 *   ANNEN vert                      -> KUN naar en verifiserbar heartbeat har
 *                                      utloept. Ingen heartbeat = ingen sannhet
 *                                      = ingen overtakelse.
 *   uleselig leie                   -> aldri. Vi vet ikke hvem som eier den.
 *
 * Eieren oppdaterer sin egen heartbeat mens leien holdes, saa "utloept" er en
 * observasjon og ikke et gjett.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { candidateWindow, readEphemeralRange, type CandidateWindow } from "./ephemeral-range.ts";

/** Identiteten som eier en leie. Skrevet i leiefilen, aldri utledet fra disk. */
export interface LeaseOwner {
  readonly pid: number;
  readonly uuid: string;
  readonly host: string;
  readonly acquired_at_ms: number;
}

/** Selve dokumentet paa disk. `generation` gjentas her for aa kunne kryssjekkes. */
export interface LeaseDocument {
  readonly v: 2;
  readonly port: number;
  readonly generation: number;
  readonly owner: LeaseOwner;
  readonly heartbeat_at_ms: number;
  readonly ttl_ms: number;
}

export interface PortLease {
  readonly port: number;
  readonly generation: number;
  readonly owner: LeaseOwner;
  readonly window: CandidateWindow;
  readonly file: string;
  /** Frigjoer KUN vaar egen generasjon. Kan ikke roere en etterfoelger. Idempotent. */
  release(): void;
  readonly released: boolean;
}

export interface AcquireOptions {
  /** Katalog leiefilene ligger i. Delt mellom prosesser - derav kapploepet. */
  readonly leaseDir?: string;
  /** Maks antall kandidatporter vi proever foer vi feiler lukket. */
  readonly maxAttempts?: number;
  /** Hvor gammel en DOED samme-vert-leie maa vaere foer den kan tas over. */
  readonly staleAfterMs?: number;
  /** Hvor lenge en heartbeat er gyldig. Grunnlaget for kryssvert-utloep. */
  readonly ttlMs?: number;
  /** Hvor ofte eieren fornyer sin egen heartbeat. */
  readonly heartbeatIntervalMs?: number;
  /** Lever denne pid-en? Injiserbar for deterministisk testing. */
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly now?: () => number;
  readonly hostId?: string;
  readonly window?: CandidateWindow;
  /** Kandidatrekkefoelge. Standard er sveip med tilfeldig start - KUN lastspredning. */
  readonly pickCandidate?: (window: CandidateWindow, attempt: number) => number;
  /** Porter kalleren har forkastet, og som aldri skal deles ut igjen. */
  readonly exclude?: Iterable<number>;
  /** Slaa av heartbeat-timeren (tester som styrer klokken selv). */
  readonly heartbeat?: boolean;
}

export const DEFAULT_LEASE_DIR = join(tmpdir(), "jarvis-embedded-pg-leases");
export const DEFAULT_MAX_ATTEMPTS = 64;
export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
export const DEFAULT_TTL_MS = 60 * 1000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 1000;

/** Hvorfor en leie ikke kunne tas over. Eksponert fordi testene asserterer paa den. */
export const RECLAIM_VERDICT = Object.freeze({
  /** Ingen leie finnes - porten er fri. */
  FREE: "free",
  /** Kan tas over: doed samme-vert-eier, eldre enn stale-grensen. */
  RECLAIMABLE_DEAD_OWNER: "reclaimable_dead_local_owner",
  /** Kan tas over: verifiserbar heartbeat har utloept. */
  RECLAIMABLE_EXPIRED: "reclaimable_expired_heartbeat",
  /** Eieren lever her. */
  HELD_LOCAL_OWNER_ALIVE: "held_local_owner_alive",
  /** Doed eier, men leien er for fersk til aa kalles forlatt. */
  HELD_TOO_FRESH: "held_too_fresh",
  /** Annen vert, og heartbeaten er fortsatt gyldig. */
  HELD_REMOTE_HEARTBEAT_VALID: "held_remote_heartbeat_valid",
  /** Annen vert uten verifiserbar heartbeat. Fail-closed. */
  HELD_REMOTE_UNVERIFIABLE: "held_remote_unverifiable",
  /** Uleselig dokument. Vi vet ikke hvem som eier den. Fail-closed. */
  HELD_UNREADABLE: "held_unreadable"
});

const LEASE_NAME = /^(\d+)\.(\d+)\.lease$/;

/** Leier denne prosessen faktisk holder - grunnlaget for opprydding ved exit. */
const held = new Set<PortLeaseImpl>();
let exitHookInstalled = false;

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM betyr at prosessen FINNES, men eies av noen andre. Det er liv.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const lease of [...held]) {
      try {
        lease.release();
      } catch {
        // Under exit finnes ingen fornuftig haandtering.
      }
    }
  });
}

class PortLeaseImpl implements PortLease {
  released = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly port: number,
    readonly generation: number,
    readonly owner: LeaseOwner,
    readonly window: CandidateWindow,
    readonly file: string,
    private readonly ttlMs: number,
    private readonly nowFn: () => number
  ) {}

  /**
   * Forny vaar egen heartbeat mens leien holdes.
   *
   * Dette er det som gjoer kryssvert-utloep til en OBSERVASJON i stedet for en
   * antakelse: en leie uten fersk heartbeat er beviselig forlatt, ikke bare
   * uleselig for oss.
   */
  startHeartbeat(intervalMs: number): void {
    this.timer = setInterval(() => {
      if (this.released) return;
      try {
        const doc = readOwnDocument(this.file, this.owner.uuid);
        if (!doc) return; // ikke lenger vaar - rammer ingenting
        writeDocument(this.file, { ...doc, heartbeat_at_ms: this.nowFn() }, { overwrite: true });
      } catch {
        // Best effort. En tapt oppdatering foerer i verste fall til at leien
        // kan tas over etter ttl - aldri til at noen andres leie roeres.
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    held.delete(this);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // A.3: betinget av at filen fortsatt er VAAR. Filnavnet baerer vaar egen
    // generasjon, saa en etterfoelger ligger under et annet navn og kan ikke
    // naas herfra i det hele tatt.
    if (!readOwnDocument(this.file, this.owner.uuid)) return;
    try {
      rmSync(this.file, { force: true });
    } catch {
      // Best effort - en gjenglemt fil plukkes opp som utloept senere.
    }
  }
}

function writeDocument(file: string, doc: LeaseDocument, { overwrite = false } = {}): boolean {
  let fd: number;
  try {
    fd = openSync(file, overwrite ? "w" : "wx");
  } catch (err) {
    if (!overwrite && (err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(doc, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

function readDocument(file: string): LeaseDocument | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LeaseDocument>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.owner || typeof parsed.owner.uuid !== "string") return null;
    if (!Number.isInteger(parsed.generation) || !Number.isInteger(parsed.port)) return null;
    return parsed as LeaseDocument;
  } catch {
    return null;
  }
}

/** Dokumentet paa denne stien, men KUN hvis det fortsatt er vaart. */
function readOwnDocument(file: string, uuid: string): LeaseDocument | null {
  const doc = readDocument(file);
  return doc && doc.owner.uuid === uuid ? doc : null;
}

function leaseFile(leaseDir: string, port: number, generation: number): string {
  return join(leaseDir, `${port}.${generation}.lease`);
}

/**
 * Den hoeyeste generasjonen som finnes for denne porten.
 *
 * Lavere generasjoner kan fortsatt ligge igjen - de er historikk, ikke eierskap.
 */
export function highestGeneration(leaseDir: string, port: number): { generation: number; file: string | null } {
  let best = 0;
  let bestFile: string | null = null;
  let names: string[];
  try {
    names = readdirSync(leaseDir);
  } catch {
    return { generation: 0, file: null };
  }
  for (const name of names) {
    const m = name.match(LEASE_NAME);
    if (!m) continue;
    if (Number.parseInt(m[1] ?? "", 10) !== port) continue;
    const gen = Number.parseInt(m[2] ?? "", 10);
    if (Number.isInteger(gen) && gen > best) {
      best = gen;
      bestFile = join(leaseDir, name);
    }
  }
  return { generation: best, file: bestFile };
}

export interface ReclaimContext {
  readonly now: number;
  readonly staleAfterMs: number;
  readonly hostId: string;
  readonly isProcessAlive: (pid: number) => boolean;
}

/**
 * Kan generasjonen vi nettopp inspiserte tas over?
 *
 * Bevisbyrden ligger paa OVERTAKELSEN. Alt vi ikke kan fastslaa er et NEI.
 */
export function reclaimVerdict(doc: LeaseDocument | null, ctx: ReclaimContext): string {
  if (!doc) return RECLAIM_VERDICT.HELD_UNREADABLE;

  const heartbeat = Number.isFinite(doc.heartbeat_at_ms) ? doc.heartbeat_at_ms : null;
  const ttl = Number.isFinite(doc.ttl_ms) && doc.ttl_ms > 0 ? doc.ttl_ms : null;
  const expired = heartbeat !== null && ttl !== null && ctx.now > heartbeat + ttl;

  if (doc.owner.host !== ctx.hostId) {
    // A.2: en annen vert sin pid betyr ingenting her, men det gir oss ingen rett
    // til aa ta leien. Bare en verifiserbar, utloept heartbeat gjoer det.
    if (heartbeat === null || ttl === null) return RECLAIM_VERDICT.HELD_REMOTE_UNVERIFIABLE;
    return expired ? RECLAIM_VERDICT.RECLAIMABLE_EXPIRED : RECLAIM_VERDICT.HELD_REMOTE_HEARTBEAT_VALID;
  }

  if (typeof doc.owner.pid === "number" && ctx.isProcessAlive(doc.owner.pid)) {
    return RECLAIM_VERDICT.HELD_LOCAL_OWNER_ALIVE;
  }

  // Samme vert, eieren er borte. Fortsatt ikke nok alene: en leie som nettopp
  // ble skrevet kan tilhoere en prosess som saavidt har rukket aa starte.
  const acquiredAt = Number.isFinite(doc.owner.acquired_at_ms) ? doc.owner.acquired_at_ms : null;
  const ageRef = heartbeat ?? acquiredAt;
  if (ageRef === null) return RECLAIM_VERDICT.HELD_UNREADABLE;
  if (ctx.now - ageRef < ctx.staleAfterMs) return RECLAIM_VERDICT.HELD_TOO_FRESH;
  return RECLAIM_VERDICT.RECLAIMABLE_DEAD_OWNER;
}

export interface TakeOverRequest {
  readonly leaseDir: string;
  readonly port: number;
  /**
   * Generasjonen kalleren FAKTISK inspiserte.
   *
   * Dette er hele fencingen. Overtakelsen skriver `inspectedGeneration + 1` med
   * `wx`, saa en kaller som handler paa en foreldet lesning taper mot kjernen i
   * stedet for aa rive vekk noe den aldri saa.
   */
  readonly inspectedGeneration: number;
  readonly owner: LeaseOwner;
  readonly ttlMs: number;
}

export interface TakeOverResult {
  readonly generation: number;
  readonly file: string;
  readonly document: LeaseDocument;
}

/**
 * Ta over leien for `port` - betinget av den generasjonen kalleren inspiserte.
 *
 * Returnerer `null` naar noen andre allerede har opprettet den generasjonen. En
 * taper skriver ingenting og fjerner ingenting: det er noeyaktig ABA-fletningen
 * D-141 A.1 krever lukket, og den er lukket av `open(..., "wx")`, ikke av vaar
 * egen rekkefoelge.
 */
export function takeOverGeneration(request: TakeOverRequest): TakeOverResult | null {
  const generation = request.inspectedGeneration + 1;
  const file = leaseFile(request.leaseDir, request.port, generation);
  const document: LeaseDocument = {
    v: 2,
    port: request.port,
    generation,
    owner: request.owner,
    heartbeat_at_ms: request.owner.acquired_at_ms,
    ttl_ms: request.ttlMs
  };

  if (!writeDocument(file, document)) return null;

  // Ryddig, men aldri farlig: bare STRENGT LAVERE generasjoner fjernes, og en
  // etterfoelger er per definisjon hoeyere enn vaar egen.
  pruneLowerGenerations(request.leaseDir, request.port, generation);
  return { generation, file, document };
}

const RECLAIMABLE = new Set<string>([
  RECLAIM_VERDICT.FREE,
  RECLAIM_VERDICT.RECLAIMABLE_DEAD_OWNER,
  RECLAIM_VERDICT.RECLAIMABLE_EXPIRED
]);

/**
 * Skaff en fenced, eksklusiv leie paa en testport, eller kast.
 *
 * Kaster hellere enn aa returnere en uverifisert port: aa starte Postgres paa en
 * port vi ikke eier er noeyaktig feilen dette laget finnes for aa hindre.
 */
export function acquirePortLease(options: AcquireOptions = {}): PortLease {
  const leaseDir = options.leaseDir ?? DEFAULT_LEASE_DIR;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const now = options.now ?? (() => Date.now());
  const hostId = options.hostId ?? hostname();
  const window = options.window ?? candidateWindow(readEphemeralRange());
  const span = window.high - window.low + 1;
  if (span < 1) {
    throw new Error("Ugyldig kandidatvindu " + window.low + "-" + window.high + ". Feiler lukket.");
  }

  // Deterministisk sveip med tilfeldig startpunkt. Tilfeldigheten sprer last
  // mellom samtidige prosesser; den er aldri eksklusivitetsmekanismen.
  const sweepStart = Math.floor(Math.random() * span);
  const pick = options.pickCandidate ?? ((w: CandidateWindow, attempt: number) => w.low + ((sweepStart + attempt) % (w.high - w.low + 1)));

  mkdirSync(leaseDir, { recursive: true });
  installExitHook();

  const excluded = new Set<number>(options.exclude ?? []);
  const tried = new Set<number>();
  const attempts = Math.max(1, Math.min(maxAttempts, span * 2));
  const verdicts = new Map<string, number>();

  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = pick(window, attempt);
    if (!Number.isInteger(port) || port < window.low || port > window.high) continue;
    if (excluded.has(port) || tried.has(port)) continue;
    tried.add(port);

    const current = highestGeneration(leaseDir, port);
    const doc = current.file ? readDocument(current.file) : null;
    const verdict = current.generation === 0 ? RECLAIM_VERDICT.FREE : reclaimVerdict(doc, { now: now(), staleAfterMs, hostId, isProcessAlive });
    verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
    if (!RECLAIMABLE.has(verdict)) continue;

    const owner: LeaseOwner = { pid: process.pid, uuid: randomUUID(), host: hostId, acquired_at_ms: now() };
    const taken = takeOverGeneration({ leaseDir, port, inspectedGeneration: current.generation, owner, ttlMs });
    if (!taken) continue; // en annen vant generasjonen - vi rev ingenting vekk

    const lease = new PortLeaseImpl(port, taken.generation, owner, window, taken.file, ttlMs, now);
    held.add(lease);
    if (options.heartbeat !== false) lease.startHeartbeat(heartbeatIntervalMs);
    return lease;
  }

  const summary = [...verdicts.entries()].map(([k, n]) => `${k}x${n}`).join(", ") || "ingen kandidater";
  throw new Error(
    "Fikk ingen eksklusiv portleie etter " + attempts + " forsoek i vinduet " + window.low + "-" + window.high +
      " (" + (window.proven ? "bevist disjunkt" : "antatt vindu") + "; " + excluded.size + " utelukket av kalleren; " +
      summary + "). Feiler lukket i stedet for aa gjette en port."
  );
}

/** Fjerner kun generasjoner STRENGT UNDER `below`. Kan aldri roere en etterfoelger. */
function pruneLowerGenerations(leaseDir: string, port: number, below: number): void {
  let names: string[];
  try {
    names = readdirSync(leaseDir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = name.match(LEASE_NAME);
    if (!m) continue;
    if (Number.parseInt(m[1] ?? "", 10) !== port) continue;
    const gen = Number.parseInt(m[2] ?? "", 10);
    if (!Number.isInteger(gen) || gen >= below) continue;
    try {
      rmSync(join(leaseDir, name), { force: true });
    } catch {
      // Historikk. Ufarlig aa la ligge.
    }
  }
}

/** Antall leier denne prosessen holder. Brukes av tester for aa bevise opprydding. */
export function heldLeaseCount(): number {
  return held.size;
}
