/**
 * Atomisk portlei paa tvers av prosesser (D-139 A.1/A.2).
 *
 * D-137 valgte port med `Math.random()` i et intervall. Et tilfeldig tall er
 * ikke en allokering: to prosesser som trekker samtidig kan faa samme tall, og
 * ingenting hindrer den andre i aa bruke det. Denne modulen erstatter gjettet
 * med en EKSKLUSIV LEIE.
 *
 * Atomisiteten kommer fra kjernen, ikke fra vaar egen logikk: `openSync(file,
 * "wx")` lykkes for NOEYAKTIG EN kaller og feiler med EEXIST for alle andre,
 * paa baade NTFS og POSIX. Vinneren er den som fikk filbeskrivelsen.
 *
 * Egenskaper som kreves av D-139, hver med sin egen test:
 *   - eksplisitt eier-identitet (pid + prosess-unik uuid + host)
 *   - bounded retry, aldri en uendelig jakt paa en ledig port
 *   - crash/stale recovery som er TIDSAVGRENSET og som ALDRI kan stjele en
 *     levende leie: en leie tas bare over naar eieren beviselig er borte
 *   - opprydding som kun frigjoer kallerens EGEN leie
 *   - fail-closed: ingen leie => unntak, aldri en port "paa haap"
 *
 * Merk hva leien IKKE er: den hindrer ikke en helt urelatert prosess i aa binde
 * porten. Derfor etterfoelges allokeringen alltid av en verifikasjon av at
 * Postgres faktisk bandt IPv4 (se `embedded-postgres.ts`). Leien loeser
 * kapploepet MELLOM VAARE EGNE prosesser; verifikasjonen fanger resten.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
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

export interface PortLease {
  readonly port: number;
  readonly owner: LeaseOwner;
  readonly window: CandidateWindow;
  readonly file: string;
  /** Frigjoer KUN hvis leien fortsatt er vaar. Idempotent. */
  release(): void;
  readonly released: boolean;
}

export interface AcquireOptions {
  /** Katalog leiefilene ligger i. Delt mellom prosesser - derav kapploepet. */
  readonly leaseDir?: string;
  /** Maks antall kandidatporter vi proever foer vi feiler lukket. */
  readonly maxAttempts?: number;
  /** Hvor gammel en leie maa vaere foer den i det hele tatt vurderes som stale. */
  readonly staleAfterMs?: number;
  /** Lever denne pid-en? Injiserbar for deterministisk testing. */
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly now?: () => number;
  readonly window?: CandidateWindow;
  /** Kandidatrekkefoelge. Standard er tilfeldig - KUN for aa spre last, aldri som eksklusivitet. */
  readonly pickCandidate?: (window: CandidateWindow, attempt: number) => number;
}

export const DEFAULT_LEASE_DIR = join(tmpdir(), "jarvis-embedded-pg-leases");
export const DEFAULT_MAX_ATTEMPTS = 64;
export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;

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
  constructor(
    readonly port: number,
    readonly owner: LeaseOwner,
    readonly window: CandidateWindow,
    readonly file: string
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    held.delete(this);
    // Frigjoer KUN vaar egen leie. En leie som i mellomtiden er tatt over av en
    // annen eier tilhoerer dem, og aa slette den ville revet vekk deres
    // eksklusivitet - noeyaktig feilen D-139 ber oss unngaa.
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as { owner?: { uuid?: string } };
      if (parsed?.owner?.uuid !== this.owner.uuid) return;
    } catch {
      return; // uleselig eller borte: ikke vaar aa fjerne
    }
    try {
      rmSync(this.file, { force: true });
    } catch {
      // Best effort - en gjenglemt fil plukkes opp som stale senere.
    }
  }
}

function writeLeaseExclusive(file: string, owner: LeaseOwner, port: number): boolean {
  let fd: number;
  try {
    fd = openSync(file, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify({ v: 1, port, owner }, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

type ExistingLease = { owner?: Partial<LeaseOwner> } | null;

function readLease(file: string): ExistingLease {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ExistingLease;
  } catch {
    return null;
  }
}

/**
 * Kan denne leiefilen tas over?
 *
 * Bevisbyrden ligger paa OVERTAKELSEN, ikke paa eieren: vi krever BAADE at
 * leien er eldre enn `staleAfterMs` OG at eieren beviselig ikke lever. En
 * uleselig leiefil regnes aldri som stale - vi vet da ikke hvem som eier den,
 * og en fil som akkurat naa blir skrevet skal ikke kunne rives vekk.
 */
export function isReclaimable(
  existing: ExistingLease,
  { now, staleAfterMs, isProcessAlive }: { now: number; staleAfterMs: number; isProcessAlive: (pid: number) => boolean }
): boolean {
  const owner = existing?.owner;
  const acquiredAt = typeof owner?.acquired_at_ms === "number" ? owner.acquired_at_ms : null;
  if (acquiredAt === null) return false;
  if (now - acquiredAt < staleAfterMs) return false;
  if (owner?.host !== hostname()) return true; // annen maskin: pid-en her betyr ingenting
  if (typeof owner?.pid !== "number") return true;
  return !isProcessAlive(owner.pid);
}

/**
 * Ta over en stale leie ATOMISK.
 *
 * `renameSync` lykkes for noeyaktig en kaller; taperen faar ENOENT og gaar
 * videre. Uten dette steget kunne to prosesser begge konkludert "stale" og
 * begge skrevet en ny leie for samme port.
 */
function reclaim(file: string, uuid: string): boolean {
  const grave = file + ".reclaimed-" + String(process.pid) + "-" + uuid.slice(0, 8);
  try {
    renameSync(file, grave);
  } catch {
    return false;
  }
  try {
    rmSync(grave, { force: true });
  } catch {
    // Ufarlig: filen ligger utenfor leienavnerommet.
  }
  return true;
}

/**
 * Skaff en eksklusiv leie paa en testport, eller kast.
 *
 * Kaster hellere enn aa returnere en uverifisert port: en test som starter
 * Postgres paa en port vi ikke eier er noeyaktig feilen D-137 produserte.
 */
export function acquirePortLease(options: AcquireOptions = {}): PortLease {
  const leaseDir = options.leaseDir ?? DEFAULT_LEASE_DIR;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const now = options.now ?? (() => Date.now());
  const window = options.window ?? candidateWindow(readEphemeralRange());
  const span = window.high - window.low + 1;
  if (span < 1) {
    throw new Error("Ugyldig kandidatvindu " + window.low + "-" + window.high + ". Feiler lukket.");
  }

  // Deterministisk SVEIP med tilfeldig startpunkt. Tilfeldigheten sprer bare
  // last mellom samtidige prosesser; den er aldri eksklusivitetsmekanismen
  // (D-139 A.1). Sveipet garanterer at vi faktisk dekker vinduet i stedet for
  // aa trekke det samme opptatte tallet om igjen.
  const sweepStart = Math.floor(Math.random() * span);
  const pick =
    options.pickCandidate ?? ((w: CandidateWindow, attempt: number) => w.low + ((sweepStart + attempt) % (w.high - w.low + 1)));

  mkdirSync(leaseDir, { recursive: true });
  installExitHook();

  const attempts = Math.max(1, Math.min(maxAttempts, span * 2));
  const tried = new Set<number>();
  let reclaimedStale = 0;
  let skippedLive = 0;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = pick(window, attempt);
    if (!Number.isInteger(port) || port < window.low || port > window.high) continue;
    if (tried.has(port)) continue;
    tried.add(port);

    const file = join(leaseDir, port + ".lease");
    const owner: LeaseOwner = { pid: process.pid, uuid: randomUUID(), host: hostname(), acquired_at_ms: now() };

    if (writeLeaseExclusive(file, owner, port)) {
      const lease = new PortLeaseImpl(port, owner, window, file);
      held.add(lease);
      return lease;
    }

    // Opptatt. Er den stale - og klarer VI i saa fall aa ta den over?
    if (!existsSync(file)) {
      tried.delete(port); // forsvant mellom to kall; verdt et nytt forsoek
      continue;
    }
    if (!isReclaimable(readLease(file), { now: now(), staleAfterMs, isProcessAlive })) {
      skippedLive++;
      continue;
    }
    if (!reclaim(file, owner.uuid)) continue; // en annen vant overtakelsen
    reclaimedStale++;
    if (writeLeaseExclusive(file, owner, port)) {
      const lease = new PortLeaseImpl(port, owner, window, file);
      held.add(lease);
      return lease;
    }
  }

  throw new Error(
    "Fikk ingen eksklusiv portleie etter " + attempts + " forsoek i vinduet " + window.low + "-" + window.high +
      " (" + (window.proven ? "bevist disjunkt" : "antatt vindu") + "; " + skippedLive + " levende leier hoppet over, " +
      reclaimedStale + " stale tatt over). Feiler lukket i stedet for aa gjette en port."
  );
}

/** Antall leier denne prosessen holder. Brukes av tester for aa bevise opprydding. */
export function heldLeaseCount(): number {
  return held.size;
}
