/**
 * Durabel, aldri-nullstilt portleie paa tvers av prosesser og verter (D-142 A).
 *
 * ------------------------------------------------------------------------
 * HVORFOR D-141 SIN GENERASJON IKKE VAR DURABEL
 * ------------------------------------------------------------------------
 *
 * D-141 la generasjonen i filnavnet og gjorde overtakelse betinget av den
 * EKSAKTE generasjonen kalleren inspiserte: `open(P.<gen+1>.lease, "wx")`. Det
 * lukket ABA-fletningen fra D-139 - innenfor ÉN sammenhengende serie.
 *
 * Men generasjonen ble UTLEDET AV FILENE SOM LAA DER. Og `release()` SLETTET
 * filen. Slipper den siste eieren, forsvinner hele navnerommet for porten, og
 * telleren starter paa 1 igjen. Da er ABA tilbake, bare ett hakk lenger ute:
 *
 *     A inspiserer gen 1
 *     B inspiserer gen 1, tar gen 2, RELEASER  -> katalogen er tom igjen
 *     C skaffer seg gen 1                       -> gjenbruk av en gammel epoke
 *     A handler paa sin foreldede lesning       -> tar gen 2, og pruner C vekk
 *
 * D-141 sin egen sluttrapport reproduserte noeyaktig dette. Fencing som kan
 * nullstilles er ikke fencing - den er en teller som tilfeldigvis er hoey.
 *
 * ------------------------------------------------------------------------
 * DET DURABLE HOEYVANNSMERKET
 * ------------------------------------------------------------------------
 *
 * Rettelsen er aa slutte aa slette. En frigjoering SKRIVER OVER sin egen fil med
 * en GRAVSTEIN (`state: "released"`) i stedet for aa fjerne den. Epoken for en
 * port er den hoeyeste `P.<epoch>.lease` som finnes - levende ELLER gravstein -
 * saa hoeyvannsmerket overlever det tomme vinduet. Porten er ledig igjen (det er
 * hva gravsteinen betyr), men epoken gaar bare én vei.
 *
 *   epoke-gjenbruk        umulig: navnerommet toemmes aldri
 *   sti-gjenbruk          umulig: `P.<epoch>.lease` utstedes noeyaktig én gang
 *   overtakelse           `open(P.<epoch+1>.lease, "wx")` - betinget av den
 *                         eksakte epoken kalleren faktisk inspiserte
 *   en taper              oppretter ingenting, sletter ingenting
 *
 * Katalogen vokser ikke: opprydding fjerner STRENGT LAVERE epoker, saa det
 * ligger noeyaktig én fil per port - den som baerer hoeyvannsmerket.
 *
 * Men nettopp den oppryddingen etterlater et hull, og det hullet er lukket
 * separat: at stien var LEDIG er ikke det samme som at epoken er HOEYEST. En
 * forsinket aktoer kan `wx`-e seg inn i en ryddet epoke under en gyldig eier med
 * hoeyere epoke. Derfor verifiserer en overtakelse hoeyvannsmerket ETTER at
 * stien er sikret, og trekker seg - ved aa fjerne KUN sin egen fil - hvis noe
 * hoeyere finnes. Det er hoeyvannsmerket som eier porten, ikke filnavnet.
 *
 * ------------------------------------------------------------------------
 * NAAR KATALOGEN SELV BLIR REINKARNERT
 * ------------------------------------------------------------------------
 *
 * Et hoeyvannsmerke som kan `rm -rf`-es er ikke durabelt. Blir leiekatalogen
 * slettet og gjenskapt, ville en forsinket aktoer med en gammel lesning (epoke 5)
 * kunne opprette epoke 6 i en helt fersk katalog der en gyldig eier akkurat har
 * tatt epoke 1 - og prune den vekk.
 *
 * Derfor baerer katalogen en INKARNASJONS-ID (`.lease-dir-id`), og en overtakelse
 * verifiserer den paa nytt ETTER at stien er sikret. Er iden en annen enn den
 * kalleren inspiserte, fjerner overtakeren KUN sin egen nyopprettede fil og
 * feiler lukket. Det er trygt nettopp fordi ingen andre kan eie den stien: `wx`
 * ga oss den, og den slippes ikke foer vi selv fjerner den.
 *
 * ------------------------------------------------------------------------
 * ZOMBIER: AA VAERE UTLOEPT ER NOE MAN OPPDAGER, IKKE NOE MAN FORHANDLER OM
 * ------------------------------------------------------------------------
 *
 * En prosess som har ligget suspendert forbi sin egen TTL kan ikke bare fornye
 * heartbeaten og vaere autoritativ igjen. `verifyOwnership()` feller derfor en
 * eier over sin EGEN utloepstid, og en eier som er blitt forbigaatt av en hoeyere
 * epoke, og gjoer leien FENCED: den mister autoritet, heartbeaten stopper, og
 * den roerer aldri disk igjen. En fenced leie kan verken skrive gravstein,
 * prune eller frigjoere noe.
 *
 * Det filprotokollen IKKE kan gjoere er aa rive socketen ut av en gammel prosess.
 * Den sannheten ligger i RESSURSprotokollen: `assertPostgresIdentityIPv4`
 * (D-141 B) krever ekte PostgreSQL-autentisering med vaare egne credentials mot
 * 127.0.0.1 paa den leide porten. Staar den gamle postmasteren fortsatt der,
 * BESTAAR IKKE den nye eieren beviset, porten forkastes, og vi gaar bundet
 * videre. Leien gir intensjon; beviset gir sannhet; ingen av dem gjetter.
 *
 * ------------------------------------------------------------------------
 * KRYSSVERT: FAIL CLOSED, FORDI KLOKKER IKKE ER SAMMENLIGNBARE (D-143 A)
 * ------------------------------------------------------------------------
 *
 * D-141 og D-142 tok over en kryssvert-leie naar heartbeaten var "utloept".
 * Den slutningen holder ikke: `heartbeat_at_ms` er skrevet med den FREMMEDE
 * vertens wall clock, og vi maalte den mot VAAR. Uten en bevist kontrakt for
 * bundet klokkeavvik er det ikke en observasjon, det er en antakelse - og den
 * feiler i den farlige retningen: en kontender med en klokke som gaar for fort
 * "observerer" en helt frisk leie som forlatt, og stjeler den.
 *
 * Vi trenger heller ikke den overtakelsen. Leiekatalogen er VERTSLOKAL (en
 * temp-katalog), saa distribuert overtakelse loeser et problem vi ikke har.
 * Derfor: en leie eid av en annen vert er ALDRI reclaimable. Ingen delt
 * lock-tjeneste, ingen klokkeavhengighet, ingen halvveis distribuert protokoll
 * med semantikk vi ikke kan bevise.
 *
 * Alt vi FAKTISK tar over kan vi verifisere med vaar egen klokke og vaart eget
 * prosesstre:
 *
 *   gravstein                       -> ledig. Eieren ga eksplisitt slipp.
 *   samme vert, eier LEVER          -> aldri, uansett alder eller utloep
 *   samme vert, eier DOED, fersk    -> aldri (den kan vaere midt i oppstart)
 *   samme vert, eier DOED, gammel   -> kan tas over
 *   ANNEN vert                      -> ALDRI. Fail closed, uansett heartbeat.
 *   uleselig leie                   -> aldri. Vi vet ikke hvem som eier den.
 *
 * TTL-en beholdes, men den er ikke lenger et overtakelsesgrunnlag for noen. Den
 * brukes KUN av en eier mot sine EGNE tidsstempler i `verifyOwnership()` - samme
 * prosess, samme klokke, og dermed en sammenligning som faktisk betyr noe.
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

/** `held` = eid akkurat naa. `released` = gravstein: ledig, men epoken staar. */
export type LeaseState = "held" | "released";

/** Selve dokumentet paa disk. `epoch` gjentas her for aa kunne kryssjekkes. */
export interface LeaseDocument {
  readonly v: 3;
  readonly port: number;
  readonly epoch: number;
  /** Inkarnasjonen av leiekatalogen dokumentet ble skrevet i. */
  readonly dir_id: string;
  readonly state: LeaseState;
  readonly owner: LeaseOwner;
  readonly heartbeat_at_ms: number;
  readonly ttl_ms: number;
  readonly released_at_ms: number | null;
}

/** Hvorfor en leie ikke lenger er vaar. En fenced leie roerer aldri disk igjen. */
export const LEASE_STATUS = Object.freeze({
  HELD: "held",
  /** Vi ga eksplisitt slipp. Gravsteinen staar. */
  RELEASED: "released",
  /** Vi ER ikke lenger eier, uansett hva vi trodde. */
  FENCED: "fenced"
});

export type LeaseStatus = "held" | "released" | "fenced";

export interface OwnershipVerdict {
  readonly ok: boolean;
  /** Dokumentet slik det faktisk staar paa disk naa. Kun satt naar `ok`. */
  readonly document: LeaseDocument | null;
  /** Hvorfor eierskapet falt bort. Kun satt naar `!ok`. */
  readonly reason: string | null;
}

/** Hvorfor en eier ble FENCED. Eksponert fordi bevisene asserterer paa den. */
export const FENCE_REASON = Object.freeze({
  /** Leiefilen vaar finnes ikke lenger. */
  LEASE_FILE_GONE: "lease_file_gone",
  /** Filen finnes, men baerer en annen eier enn oss. */
  OWNER_REPLACED: "owner_replaced",
  /** Filen er markert frigjort - av oss eller en oppryddingsrutine. */
  ALREADY_RELEASED: "already_released",
  /** Dokumentet sier en annen epoke enn den vi holder. */
  EPOCH_MISMATCH: "epoch_mismatch",
  /** En hoeyere epoke finnes: noen har gyldig tatt over. */
  SUPERSEDED_BY_HIGHER_EPOCH: "superseded_by_higher_epoch",
  /** Vi har selv gaatt forbi vaar egen TTL. En zombie fornyer seg ikke tilbake. */
  OWN_LEASE_EXPIRED: "own_lease_expired",
  /** Leiekatalogen er en annen inkarnasjon enn den vi tok leien i. */
  LEASE_DIR_REINCARNATED: "lease_dir_reincarnated"
});

export interface PortLease {
  readonly port: number;
  readonly epoch: number;
  readonly owner: LeaseOwner;
  readonly window: CandidateWindow;
  readonly file: string;
  readonly dirId: string;
  readonly status: LeaseStatus;
  /** Ikke lenger holdt - frigjort ELLER fenced. */
  readonly released: boolean;
  /** Vi tapte eierskapet uten aa gi det fra oss. */
  readonly fenced: boolean;
  /** Hvorfor vi ble fenced, hvis vi ble det. */
  readonly fenceReason: string | null;
  /** Les disk paa nytt og avgjoer om vi FAKTISK fortsatt eier. Kan fence oss. */
  verifyOwnership(): OwnershipVerdict;
  /** Som `verifyOwnership`, men kaster. Brukes foer vi stoler paa porten. */
  assertOwned(): void;
  /** Skriv gravstein paa KUN vaar egen sti. Kan ikke roere en etterfoelger. Idempotent. */
  release(): void;
}

export interface AcquireOptions {
  /** Katalog leiefilene ligger i. Delt mellom prosesser - derav kapploepet. */
  readonly leaseDir?: string;
  /** Maks antall kandidatporter vi proever foer vi feiler lukket. */
  readonly maxAttempts?: number;
  /** Hvor gammel en DOED samme-vert-leie maa vaere foer den kan tas over. */
  readonly staleAfterMs?: number;
  /**
   * Hvor lenge en eier regner sin EGEN heartbeat som gyldig.
   *
   * Etter D-143 A er dette ikke lenger et overtakelsesgrunnlag for noen andre -
   * det brukes kun av eieren selv i `verifyOwnership()`, mot sine egne
   * tidsstempler paa sin egen klokke.
   */
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
  /** Varsles naar leien blir fenced, slik at kalleren kan rive ned ressursen. */
  readonly onFenced?: (reason: string, lease: PortLease) => void;
}

export const DEFAULT_LEASE_DIR = join(tmpdir(), "jarvis-embedded-pg-leases");
export const DEFAULT_MAX_ATTEMPTS = 64;
export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
export const DEFAULT_TTL_MS = 60 * 1000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 1000;

/** Hvorfor en leie ikke kunne tas over. Eksponert fordi testene asserterer paa den. */
export const RECLAIM_VERDICT = Object.freeze({
  /** Ingen epoke finnes for porten - den har aldri vaert brukt her. */
  FREE: "free",
  /** Forrige eier ga eksplisitt slipp. Epoken staar, porten er ledig. */
  RECLAIMABLE_RELEASED: "reclaimable_released_tombstone",
  /** Kan tas over: doed samme-vert-eier, eldre enn stale-grensen. */
  RECLAIMABLE_DEAD_OWNER: "reclaimable_dead_local_owner",
  /** Eieren lever her. */
  HELD_LOCAL_OWNER_ALIVE: "held_local_owner_alive",
  /** Doed eier, men leien er for fersk til aa kalles forlatt. */
  HELD_TOO_FRESH: "held_too_fresh",
  /**
   * Eid av en ANNEN VERT. Aldri reclaimable - uansett hva heartbeaten sier.
   *
   * D-143 A: vi har ingen kontrakt for bundet klokkeavvik mellom verter, saa en
   * fremmed tidsstempel maalt mot vaar klokke er ikke et bevis for noe som helst.
   */
  HELD_REMOTE_OWNER: "held_remote_owner_fail_closed",
  /** Uleselig dokument. Vi vet ikke hvem som eier den. Fail-closed. */
  HELD_UNREADABLE: "held_unreadable"
});

/** Hvorfor en overtakelse ikke ble til noe. Alle betyr: vi rev ingenting vekk. */
export const TAKEOVER_REJECTED = Object.freeze({
  /** Noen andre opprettet den epoken foerst. */
  LOST_EPOCH_RACE: "lost_epoch_race",
  /** Katalogen er en annen inkarnasjon enn den vi inspiserte. */
  LEASE_DIR_REINCARNATED: "lease_dir_reincarnated",
  /** Vi sikret stien, men en HOEYERE epoke finnes. Vi er ikke hoeyvannsmerket. */
  NOT_HIGHEST_EPOCH: "not_highest_epoch"
});

const LEASE_NAME = /^(\d+)\.(\d+)\.lease$/;

/** Inkarnasjons-iden til leiekatalogen. Skrevet én gang, aldri endret. */
export const LEASE_DIR_ID_FILE = ".lease-dir-id";

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

/**
 * Les inkarnasjons-iden til leiekatalogen, eller `null` hvis den ikke finnes.
 *
 * `null` er ikke det samme som "ny katalog": det betyr at vi ikke KAN si hvilken
 * inkarnasjon dette er, og da tar vi ingen leie.
 */
export function readLeaseDirId(leaseDir: string): string | null {
  try {
    const raw = readFileSync(join(leaseDir, LEASE_DIR_ID_FILE), "utf8").trim();
    return /^[0-9a-f]{16,}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Opprett inkarnasjons-iden hvis den mangler. `wx` gjoer at alle enes om én. */
export function ensureLeaseDirId(leaseDir: string): string {
  const existing = readLeaseDirId(leaseDir);
  if (existing) return existing;

  const id = randomUUID().replace(/-/g, "");
  const file = join(leaseDir, LEASE_DIR_ID_FILE);
  let fd: number;
  try {
    fd = openSync(file, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Noen andre rakk det foerst. Deres id er den gjeldende, ikke vaar.
      const raced = readLeaseDirId(leaseDir);
      if (raced) return raced;
    }
    throw err;
  }
  try {
    writeSync(fd, id);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return id;
}

class PortLeaseImpl implements PortLease {
  status: LeaseStatus = LEASE_STATUS.HELD as LeaseStatus;
  fenceReason: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly port: number,
    readonly epoch: number,
    readonly owner: LeaseOwner,
    readonly window: CandidateWindow,
    readonly file: string,
    readonly dirId: string,
    private readonly leaseDir: string,
    private readonly ttlMs: number,
    private readonly nowFn: () => number,
    private readonly onFenced: ((reason: string, lease: PortLease) => void) | undefined
  ) {}

  get released(): boolean {
    return this.status !== LEASE_STATUS.HELD;
  }

  get fenced(): boolean {
    return this.status === LEASE_STATUS.FENCED;
  }

  /**
   * Feller eierskapet vaart mot det som FAKTISK staar paa disk.
   *
   * Dette er anti-zombie-porten. En eier som er forbigaatt av en hoeyere epoke,
   * eller som har sovet forbi sin egen TTL, er ikke autoritativ lenger - og skal
   * ikke kunne skrive seg tilbake til autoritet.
   */
  verifyOwnership(): OwnershipVerdict {
    if (this.status !== LEASE_STATUS.HELD) {
      return { ok: false, document: null, reason: this.fenceReason ?? this.status };
    }

    if (readLeaseDirId(this.leaseDir) !== this.dirId) return this.fence(FENCE_REASON.LEASE_DIR_REINCARNATED);

    const doc = readDocument(this.file);
    if (!doc) return this.fence(FENCE_REASON.LEASE_FILE_GONE);
    if (doc.owner.uuid !== this.owner.uuid) return this.fence(FENCE_REASON.OWNER_REPLACED);
    if (doc.state === "released") return this.fence(FENCE_REASON.ALREADY_RELEASED);
    if (doc.epoch !== this.epoch) return this.fence(FENCE_REASON.EPOCH_MISMATCH);

    const highest = highestEpoch(this.leaseDir, this.port);
    if (highest.epoch > this.epoch) return this.fence(FENCE_REASON.SUPERSEDED_BY_HIGHER_EPOCH);

    const ttl = Number.isFinite(doc.ttl_ms) && doc.ttl_ms > 0 ? doc.ttl_ms : this.ttlMs;
    if (this.nowFn() > doc.heartbeat_at_ms + ttl) return this.fence(FENCE_REASON.OWN_LEASE_EXPIRED);

    return { ok: true, document: doc, reason: null };
  }

  assertOwned(): void {
    const verdict = this.verifyOwnership();
    if (verdict.ok) return;
    throw new Error(
      "Portleien paa " + this.port + " (epoke " + this.epoch + ") er ikke lenger vaar: " + verdict.reason +
        ". Feiler lukket i stedet for aa bruke en port vi ikke eier."
    );
  }

  /**
   * En FENCED leie roerer ALDRI disk igjen.
   *
   * Ingen gravstein, ingen prune, ingen heartbeat. Alt vi kunne skrevet ville
   * vaert basert paa en virkelighet som ikke lenger finnes.
   */
  private fence(reason: string): OwnershipVerdict {
    this.status = LEASE_STATUS.FENCED as LeaseStatus;
    this.fenceReason = reason;
    held.delete(this);
    this.stopTimer();
    try {
      this.onFenced?.(reason, this);
    } catch {
      // En kaller som kaster i sin egen nedrigging endrer ikke verdiktet.
    }
    return { ok: false, document: null, reason };
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Forny vaar egen heartbeat mens leien holdes - men KUN naar vi fortsatt eier.
   *
   * Dette er det som gjoer kryssvert-utloep til en OBSERVASJON i stedet for en
   * antakelse: en leie uten fersk heartbeat er beviselig forlatt. Og fordi
   * fornyelsen gaar gjennom `verifyOwnership()`, kan en suspendert prosess ikke
   * vaake opp forbi sin egen TTL og skrive seg tilbake til autoritet.
   */
  startHeartbeat(intervalMs: number): void {
    this.timer = setInterval(() => {
      if (this.status !== LEASE_STATUS.HELD) return;
      const verdict = this.verifyOwnership();
      if (!verdict.ok || !verdict.document) return;
      try {
        writeDocument(this.file, { ...verdict.document, heartbeat_at_ms: this.nowFn() }, { overwrite: true });
      } catch {
        // Best effort. En tapt oppdatering foerer i verste fall til at leien
        // kan tas over etter ttl - aldri til at noen andres leie roeres.
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  /**
   * Gi slipp - ved aa skrive GRAVSTEIN, ikke ved aa slette.
   *
   * Det er her hoeyvannsmerket blir durabelt: epoken vaar blir staaende etter at
   * vi er ute, saa den kan aldri deles ut paa nytt. Skrivingen treffer KUN vaar
   * egen sti, og en etterfoelger har per konstruksjon en hoeyere epoke og dermed
   * et annet filnavn - det er strukturelt umulig aa naa den herfra.
   */
  release(): void {
    if (this.status !== LEASE_STATUS.HELD) return;
    held.delete(this);
    this.stopTimer();

    // Betinget av at filen fortsatt er VAAR og fortsatt holdt. Er den det ikke,
    // har noen gyldig tatt over, og da skriver vi ingenting i det hele tatt.
    const doc = readDocument(this.file);
    const ours = doc && doc.owner.uuid === this.owner.uuid && doc.epoch === this.epoch && doc.state === "held";
    this.status = LEASE_STATUS.RELEASED as LeaseStatus;
    if (!ours || !doc) return;

    try {
      writeDocument(this.file, { ...doc, state: "released", released_at_ms: this.nowFn() }, { overwrite: true });
    } catch {
      // Best effort. Feiler skrivingen staar leien som holdt og plukkes opp som
      // utloept senere - aldri som en gjenbrukbar epoke.
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

/**
 * Les et leiedokument - normalisert.
 *
 * v2-dokumenter fra D-141 kan fortsatt ligge igjen i en delt leiekatalog. De
 * leses som `held` med `epoch = generation`, slik at en gammel fil blokkerer
 * porten paa normalt vis i stedet for aa bli uleselig og blokkere den for godt.
 */
function readDocument(file: string): LeaseDocument | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;

    const owner = parsed["owner"] as LeaseOwner | undefined;
    if (!owner || typeof owner.uuid !== "string") return null;

    const port = parsed["port"];
    if (!Number.isInteger(port)) return null;

    const rawEpoch = parsed["v"] === 2 ? parsed["generation"] : parsed["epoch"];
    if (!Number.isInteger(rawEpoch)) return null;

    const state = parsed["state"] === "released" ? "released" : "held";
    return {
      v: 3,
      port: port as number,
      epoch: rawEpoch as number,
      dir_id: typeof parsed["dir_id"] === "string" ? (parsed["dir_id"] as string) : "",
      state,
      owner,
      heartbeat_at_ms: Number(parsed["heartbeat_at_ms"]),
      ttl_ms: Number(parsed["ttl_ms"]),
      released_at_ms: Number.isFinite(Number(parsed["released_at_ms"])) ? Number(parsed["released_at_ms"]) : null
    };
  } catch {
    return null;
  }
}

function leaseFile(leaseDir: string, port: number, epoch: number): string {
  return join(leaseDir, `${port}.${epoch}.lease`);
}

export interface PortEpoch {
  /** 0 = porten har aldri hatt en leie i denne katalog-inkarnasjonen. */
  readonly epoch: number;
  readonly file: string | null;
}

/**
 * Det durable hoeyvannsmerket for denne porten.
 *
 * Gravsteiner teller. Det er hele poenget: en frigjort port er LEDIG, men epoken
 * dens er brukt opp for alltid.
 */
export function highestEpoch(leaseDir: string, port: number): PortEpoch {
  let best = 0;
  let bestFile: string | null = null;
  let names: string[];
  try {
    names = readdirSync(leaseDir);
  } catch {
    return { epoch: 0, file: null };
  }
  for (const name of names) {
    const m = name.match(LEASE_NAME);
    if (!m) continue;
    if (Number.parseInt(m[1] ?? "", 10) !== port) continue;
    const epoch = Number.parseInt(m[2] ?? "", 10);
    if (Number.isInteger(epoch) && epoch > best) {
      best = epoch;
      bestFile = join(leaseDir, name);
    }
  }
  return { epoch: best, file: bestFile };
}

export interface ReclaimContext {
  readonly now: number;
  readonly staleAfterMs: number;
  readonly hostId: string;
  readonly isProcessAlive: (pid: number) => boolean;
}

/**
 * Kan epoken vi nettopp inspiserte tas over?
 *
 * Bevisbyrden ligger paa OVERTAKELSEN. Alt vi ikke kan fastslaa er et NEI.
 */
export function reclaimVerdict(doc: LeaseDocument | null, ctx: ReclaimContext): string {
  if (!doc) return RECLAIM_VERDICT.HELD_UNREADABLE;

  // En gravstein er et eksplisitt "jeg er ferdig" fra forrige eier. Den sier
  // ingenting om epoken - den staar, og neste eier faar den neste.
  if (doc.state === "released") return RECLAIM_VERDICT.RECLAIMABLE_RELEASED;

  // D-143 A: en leie eid av en ANNEN VERT tas aldri over. Punktum.
  //
  // `heartbeat_at_ms` er skrevet med den fremmede vertens wall clock. Aa maale
  // den mot VAAR klokke er ikke en observasjon, det er en antakelse om bundet
  // klokkeavvik vi ikke har noen kontrakt for - og en kontender med en klokke som
  // gaar for fort ville "observert" en helt frisk leie som utloept. Vi trenger
  // heller ingen slik overtakelse: leiekatalogen er vertslokal.
  if (doc.owner.host !== ctx.hostId) return RECLAIM_VERDICT.HELD_REMOTE_OWNER;

  const heartbeat = Number.isFinite(doc.heartbeat_at_ms) ? doc.heartbeat_at_ms : null;

  // A.3: en LEVENDE lokal eier tas aldri over - heller ikke naar heartbeaten har
  // utloept. En vridd prosess som fortsatt holder socketen er noeyaktig den
  // situasjonen der en overtakelse ville gitt to eiere av samme ressurs.
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
   * Epoken kalleren FAKTISK inspiserte.
   *
   * Dette er hele fencingen. Overtakelsen skriver `inspectedEpoch + 1` med `wx`,
   * saa en kaller som handler paa en foreldet lesning taper mot kjernen i stedet
   * for aa rive vekk noe den aldri saa.
   */
  readonly inspectedEpoch: number;
  /** Katalog-inkarnasjonen kalleren inspiserte epoken i. */
  readonly inspectedDirId: string;
  readonly owner: LeaseOwner;
  readonly ttlMs: number;
}

export type TakeOverOutcome =
  | { readonly ok: true; readonly epoch: number; readonly file: string; readonly document: LeaseDocument }
  | { readonly ok: false; readonly reason: string };

/**
 * Ta over porten - betinget av den epoken OG den katalog-inkarnasjonen kalleren
 * inspiserte.
 *
 * En taper skriver ingenting og fjerner ingenting. Det er noeyaktig reset-ABA-en
 * D-142 A.1 krever lukket, og den er lukket av `open(..., "wx")` mot et navnerom
 * som aldri toemmes - ikke av vaar egen rekkefoelge.
 */
export function takeOverEpoch(request: TakeOverRequest): TakeOverOutcome {
  const epoch = request.inspectedEpoch + 1;
  const file = leaseFile(request.leaseDir, request.port, epoch);
  const document: LeaseDocument = {
    v: 3,
    port: request.port,
    epoch,
    dir_id: request.inspectedDirId,
    state: "held",
    owner: request.owner,
    heartbeat_at_ms: request.owner.acquired_at_ms,
    ttl_ms: request.ttlMs,
    released_at_ms: null
  };

  if (!writeDocument(file, document)) return { ok: false, reason: TAKEOVER_REJECTED.LOST_EPOCH_RACE };

  // Ble katalogen reinkarnert under oss, gjaldt lesningen vaar en annen verden.
  // Vi fjerner KUN stien `wx` nettopp ga oss - ingen andre kan eie den - og
  // feiler lukket i stedet for aa prune en fersk, gyldig eier vekk.
  if (readLeaseDirId(request.leaseDir) !== request.inspectedDirId) {
    return withdraw(file, TAKEOVER_REJECTED.LEASE_DIR_REINCARNATED);
  }

  // At stien var LEDIG er ikke det samme som at epoken er HOEYEST.
  //
  // Opprydding fjerner strengt lavere epoker, og det etterlater et hull: en
  // forsinket aktoer med en gammel lesning kan `wx`-e seg inn i en epoke som er
  // blitt ryddet vekk, under en gyldig eier med hoeyere epoke. Da ville to
  // prosesser trodd de eide porten - og den forsinkede ville pruna seg nedover.
  //
  // Derfor er hoeyvannsmerket, ikke stien, den endelige betingelsen. Ser vi noe
  // hoeyere, trekker vi oss og fjerner KUN vaar egen fil. Epoker gaar bare én
  // vei, saa den stien kan aldri gjenoppstaa hos noen andre.
  const highest = highestEpoch(request.leaseDir, request.port);
  if (highest.epoch > epoch) return withdraw(file, TAKEOVER_REJECTED.NOT_HIGHEST_EPOCH);

  // Ryddig, og naa trygt: bare STRENGT LAVERE epoker fjernes, og vi har nettopp
  // bevist at ingen hoeyere finnes. En etterfoelger er per definisjon hoeyere.
  pruneLowerEpochs(request.leaseDir, request.port, epoch);
  return { ok: true, epoch, file, document };
}

/** Trekk overtakelsen tilbake ved aa fjerne KUN stien vi selv nettopp sikret. */
function withdraw(file: string, reason: string): TakeOverOutcome {
  try {
    rmSync(file, { force: true });
  } catch {
    // Blir den liggende, er den en blokkering av vaar egen epoke - ikke et tyveri.
  }
  return { ok: false, reason };
}

/**
 * De ENESTE tilstandene som gir rett til aa ta en port.
 *
 * Listen er bevisst kort, og etter D-143 A finnes ingen kryssvert-oppfoering i
 * den: alt vi kan ta over, kan vi ogsaa verifisere med VAAR EGEN klokke og
 * VAART EGET prosesstre.
 */
const RECLAIMABLE = new Set<string>([
  RECLAIM_VERDICT.FREE,
  RECLAIM_VERDICT.RECLAIMABLE_RELEASED,
  RECLAIM_VERDICT.RECLAIMABLE_DEAD_OWNER
]);

/**
 * Skaff en durabelt fenced, eksklusiv leie paa en testport, eller kast.
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
  const dirId = ensureLeaseDirId(leaseDir);
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

    const current = highestEpoch(leaseDir, port);
    const doc = current.file ? readDocument(current.file) : null;
    const verdict = current.epoch === 0 ? RECLAIM_VERDICT.FREE : reclaimVerdict(doc, { now: now(), staleAfterMs, hostId, isProcessAlive });
    verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
    if (!RECLAIMABLE.has(verdict)) continue;

    const owner: LeaseOwner = { pid: process.pid, uuid: randomUUID(), host: hostId, acquired_at_ms: now() };
    const taken = takeOverEpoch({ leaseDir, port, inspectedEpoch: current.epoch, inspectedDirId: dirId, owner, ttlMs });
    if (!taken.ok) {
      // Vi rev ingenting vekk. Regnskapet skal likevel si HVORFOR vi tapte.
      verdicts.set(taken.reason, (verdicts.get(taken.reason) ?? 0) + 1);
      continue;
    }

    const lease = new PortLeaseImpl(port, taken.epoch, owner, window, taken.file, dirId, leaseDir, ttlMs, now, options.onFenced);
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

/**
 * Fjerner kun epoker STRENGT UNDER `below`.
 *
 * Hoeyvannsmerket - vaar egen fil - staar alltid igjen, saa katalogen holder seg
 * paa noeyaktig én fil per port uten at epoken noen gang kan nullstilles.
 */
function pruneLowerEpochs(leaseDir: string, port: number, below: number): void {
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
    const epoch = Number.parseInt(m[2] ?? "", 10);
    if (!Number.isInteger(epoch) || epoch >= below) continue;
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
